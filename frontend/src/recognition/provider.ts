/**
 * Client recognition (camera) — v0.3.
 *
 * `FaceApiProvider` runs `@vladmandic/face-api` ON DEVICE against a `<video>` element and emits
 * 128-d embeddings. No frame ever leaves the device: the only things that travel are float
 * vectors (to `recognition.match` / `recognition.enroll`) and those only for consented clients.
 *
 * Pipeline per tick (~4 fps, idle-scheduled so the POS stays responsive):
 *   tinyFaceDetector → faceLandmark68Tiny → quality gate (quality.ts) → faceRecognitionNet
 *   → StabilityTracker (stability.ts: 3 stable frames + blink / head motion within 3 s)
 *   → 'candidate' event. Every frame that passes the gate is also emitted as a 'sample'
 *   (used by enrolment to take its 3 captures over ~2 s).
 *
 * Web Worker: face-api's input pipeline is DOM-bound (HTMLVideoElement → canvas → tensor via
 * `env.monkeyPatch`), and WebGL inside workers is still uneven on iPad Safari, so detection
 * stays on the main thread with `requestIdleCallback` throttling. The hook is isolated in
 * `detectOnce()` so a worker can replace it later without touching the state machine.
 *
 * Liveness-lite is a heuristic, NOT certified presentation-attack detection. The legal basis
 * for recognising anyone is the stored consent (README "Facial recognition: legal notice").
 */
import { RECOGNITION_MODEL } from '@/api/types'
import { loadFaceApi, sharpnessOf, type Backend, type FaceApi } from './faceapi'
import { toArray } from './math'
import { assessQuality, eyeAspectRatio, qualityHint, NOSE_TIP, type Box, type DetectionSample, type QualityOptions, type QualityResult } from './quality'
import { StabilityTracker, type Candidate, type TrackerOptions, type TrackerState } from './stability'

export interface RecognitionCandidate {
  embedding: number[]
  quality: number
  bbox: Box
  model: string
  liveness: 'blink' | 'motion' | 'injected'
  t: number
}

export interface RecognitionSample {
  embedding: number[]
  quality: number
  bbox: Box
  model: string
  t: number
}

export type ProviderPhase = 'idle' | 'loading' | 'running' | 'paused' | 'error'

export interface ProviderStatus {
  phase: ProviderPhase
  backend?: Backend
  /** measured detections per second */
  fps: number
  /** a face is in frame right now */
  face: boolean
  /** last detection box (video coordinates) */
  bbox?: Box
  /** why we are waiting: "Move closer", "Blink or nod", … */
  hint: string
  tracker: TrackerState
  quality?: QualityResult
  error?: string
  /** ms spent in the last detection */
  lastMs: number
}

export interface ProviderEvents {
  candidate: RecognitionCandidate
  sample: RecognitionSample
  status: ProviderStatus
}

export interface RecognitionProvider {
  readonly id: string
  readonly available: boolean
  readonly model: string
  readonly status: ProviderStatus
  start(video: HTMLVideoElement): Promise<void>
  stop(): void
  pause(paused: boolean): void
  on<K extends keyof ProviderEvents>(event: K, cb: (payload: ProviderEvents[K]) => void): () => void
}

/** Kept for callers that only need the seam (`available === false` → tile hidden). */
export class NullProvider implements RecognitionProvider {
  readonly id = 'null'
  readonly available = false
  readonly model = RECOGNITION_MODEL
  readonly status: ProviderStatus = { phase: 'idle', fps: 0, face: false, hint: '', tracker: 'idle', lastMs: 0 }
  async start() {}
  stop() {}
  pause() {}
  on() {
    return () => {}
  }
}

export interface FaceApiProviderOptions {
  /** target detection interval (ms); 250 = 4 fps */
  intervalMs: number
  inputSize: number
  detectorThreshold: number
  quality: Partial<QualityOptions>
  tracker: Partial<TrackerOptions>
  backends?: Backend[]
}

export const DEFAULT_PROVIDER_OPTIONS: FaceApiProviderOptions = {
  intervalMs: 250,
  inputSize: 320,
  detectorThreshold: 0.5,
  quality: {},
  tracker: {}
}

type Listener<K extends keyof ProviderEvents> = (payload: ProviderEvents[K]) => void

export class FaceApiProvider implements RecognitionProvider {
  readonly id = 'face-api'
  readonly available = true
  readonly model = RECOGNITION_MODEL
  status: ProviderStatus = { phase: 'idle', fps: 0, face: false, hint: '', tracker: 'idle', lastMs: 0 }

  private opts: FaceApiProviderOptions
  private listeners: { [K in keyof ProviderEvents]: Set<Listener<K>> } = { candidate: new Set(), sample: new Set(), status: new Set() }
  private video: HTMLVideoElement | null = null
  private api: FaceApi | null = null
  private tracker: StabilityTracker
  private running = false
  private paused = false
  private timer: number | null = null
  private idle: number | null = null
  private busy = false
  private sharpCanvas: HTMLCanvasElement | null = null
  private fpsWindow: number[] = []
  private generation = 0

  constructor(opts: Partial<FaceApiProviderOptions> = {}) {
    this.opts = { ...DEFAULT_PROVIDER_OPTIONS, ...opts }
    this.tracker = new StabilityTracker(this.opts.tracker)
  }

  on<K extends keyof ProviderEvents>(event: K, cb: Listener<K>): () => void {
    const set = this.listeners[event] as Set<Listener<K>>
    set.add(cb)
    return () => set.delete(cb)
  }

  private emit<K extends keyof ProviderEvents>(event: K, payload: ProviderEvents[K]) {
    for (const cb of this.listeners[event] as Set<Listener<K>>) {
      try {
        cb(payload)
      } catch (e) {
        console.warn('[recognition] listener failed', e)
      }
    }
  }

  private setStatus(patch: Partial<ProviderStatus>) {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  async start(video: HTMLVideoElement): Promise<void> {
    const gen = ++this.generation
    this.video = video
    this.running = true
    this.tracker.reset()
    this.setStatus({ phase: 'loading', error: undefined, hint: 'Loading model' })
    try {
      const loaded = await loadFaceApi(this.opts.backends)
      if (gen !== this.generation || !this.running) return
      this.api = loaded.api
      this.setStatus({ phase: this.paused ? 'paused' : 'running', backend: loaded.backend, hint: '' })
      this.schedule(0)
    } catch (e) {
      if (gen !== this.generation) return
      this.running = false
      this.setStatus({ phase: 'error', error: (e as Error).message || 'Model failed to load', hint: '' })
      throw e
    }
  }

  stop() {
    this.generation++
    this.running = false
    this.clearTimers()
    this.video = null
    this.tracker.reset()
    this.setStatus({ phase: 'idle', face: false, hint: '', tracker: 'idle', fps: 0 })
  }

  pause(paused: boolean) {
    this.paused = paused
    if (this.status.phase === 'running' || this.status.phase === 'paused') this.setStatus({ phase: paused ? 'paused' : 'running' })
    if (!paused && this.running) this.schedule(0)
  }

  private clearTimers() {
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.idle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(this.idle)
    this.timer = null
    this.idle = null
  }

  private schedule(delay: number) {
    if (!this.running || this.paused) return
    this.clearTimers()
    this.timer = window.setTimeout(() => {
      this.timer = null
      // run the (expensive) detection when the main thread is idle, but never later than one interval
      if (typeof requestIdleCallback === 'function') {
        this.idle = requestIdleCallback(() => void this.tick(), { timeout: this.opts.intervalMs })
      } else void this.tick()
    }, delay)
  }

  /** Injected by the test hook: bypasses the camera but still goes through listeners. */
  inject(c: Omit<RecognitionCandidate, 'model' | 'liveness' | 't'> & Partial<RecognitionCandidate>) {
    this.emit('candidate', { model: this.model, liveness: 'injected', t: performance.now(), ...c })
  }

  private async tick() {
    this.idle = null
    if (!this.running || this.paused || this.busy) return
    const video = this.video
    if (!video || !this.api || video.readyState < 2 || !video.videoWidth) {
      this.schedule(this.opts.intervalMs)
      return
    }
    this.busy = true
    const t0 = performance.now()
    try {
      await this.detectOnce(video, t0)
    } catch (e) {
      console.warn('[recognition] detect failed', e)
      this.setStatus({ error: (e as Error).message })
    } finally {
      this.busy = false
      const spent = performance.now() - t0
      this.fpsWindow.push(t0)
      this.fpsWindow = this.fpsWindow.filter((t) => t > t0 - 2000)
      this.status.fps = Math.round((this.fpsWindow.length / 2) * 10) / 10
      this.status.lastMs = Math.round(spent)
      // keep the cadence, but never pile detections on top of each other
      this.schedule(Math.max(40, this.opts.intervalMs - spent))
    }
  }

  private async detectOnce(video: HTMLVideoElement, t: number) {
    const api = this.api!
    const options = new api.TinyFaceDetectorOptions({ inputSize: this.opts.inputSize, scoreThreshold: this.opts.detectorThreshold })
    const det = await api.detectSingleFace(video, options).withFaceLandmarks(true)
    if (!det) {
      this.tracker.push({ t, ok: false })
      this.setStatus({ face: false, bbox: undefined, hint: '', tracker: this.tracker.state, quality: undefined })
      return
    }
    const box: Box = { x: det.detection.box.x, y: det.detection.box.y, width: det.detection.box.width, height: det.detection.box.height }
    const landmarks = det.landmarks.positions.map((p) => ({ x: p.x, y: p.y }))
    const sample: DetectionSample = {
      score: det.detection.score,
      box,
      landmarks,
      frameWidth: video.videoWidth,
      frameHeight: video.videoHeight,
      sharpness: this.measureSharpness(video, box)
    }
    const q = assessQuality(sample, this.opts.quality)
    const ear = eyeAspectRatio(landmarks)
    const noseTip = landmarks[NOSE_TIP]
    const nose = { x: (noseTip.x - box.x) / (box.width || 1), y: (noseTip.y - box.y) / (box.height || 1) }

    if (!q.ok) {
      this.tracker.push({ t, ok: false, ear, nose, box })
      this.setStatus({ face: true, bbox: box, hint: qualityHint(q), tracker: this.tracker.state, quality: q })
      return
    }

    // aligned crop → 128-d descriptor (only for frames worth it)
    const faces = await api.extractFaces(video, [det.alignedRect])
    const descriptor = faces.length ? await api.computeFaceDescriptor(faces[0]) : null
    for (const c of faces) c.width = 0 // release canvas memory eagerly
    if (!descriptor || Array.isArray(descriptor)) {
      this.tracker.push({ t, ok: false, ear, nose, box })
      return
    }
    const embedding = toArray(descriptor as Float32Array)
    this.emit('sample', { embedding, quality: q.quality, bbox: box, model: this.model, t })
    const cand: Candidate | null = this.tracker.push({ t, ok: true, embedding, quality: q.quality, ear, nose, box })
    this.setStatus({ face: true, bbox: box, hint: this.tracker.hint, tracker: this.tracker.state, quality: q })
    if (cand) this.emit('candidate', { embedding: cand.embedding, quality: cand.quality, bbox: cand.bbox, model: this.model, liveness: cand.liveness, t })
  }

  private measureSharpness(video: HTMLVideoElement, box: Box): number | undefined {
    try {
      if (!this.sharpCanvas) {
        this.sharpCanvas = document.createElement('canvas')
        this.sharpCanvas.width = 64
        this.sharpCanvas.height = 64
      }
      const ctx = this.sharpCanvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return undefined
      const sx = Math.max(0, box.x)
      const sy = Math.max(0, box.y)
      const sw = Math.min(video.videoWidth - sx, box.width)
      const sh = Math.min(video.videoHeight - sy, box.height)
      if (sw <= 0 || sh <= 0) return undefined
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 64, 64)
      return sharpnessOf(ctx, 64)
    } catch {
      return undefined
    }
  }
}

let current: RecognitionProvider = new NullProvider()

export function recognitionProvider(): RecognitionProvider {
  return current
}

export function setRecognitionProvider(p: RecognitionProvider) {
  current = p
}
