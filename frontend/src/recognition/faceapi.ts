/**
 * Lazy loader for `@vladmandic/face-api` (TF.js bundled). Nothing here is imported until the
 * boutique has recognition switched on and the device enables it, so the ~1.3 MB library and
 * the ~6.5 MB of weights never touch a POS that does not use the feature.
 *
 * Backend order: WebGL (iPad Safari, Chrome) → WASM (SIMD/threads when available; binaries are
 * shipped under models/wasm/) → CPU as a last resort. The weights live under
 * `<base>/models/` and are precached by the service worker (vite.config.ts).
 */
import type * as FaceApiNs from '@vladmandic/face-api'

export type FaceApi = typeof FaceApiNs

export type Backend = 'webgl' | 'wasm' | 'cpu'

export interface LoadedFaceApi {
  api: FaceApi
  backend: Backend
  modelsUrl: string
}

let loading: Promise<LoadedFaceApi> | null = null

export function modelsBaseUrl(): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')
  return `${base}models/`
}

/** Paths the service worker must precache (kept in sync with public/models/). */
export const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_landmark_68_tiny_model-weights_manifest.json',
  'face_landmark_68_tiny_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin'
]

async function pickBackend(api: FaceApi, prefer: Backend[] = ['webgl', 'wasm', 'cpu']): Promise<Backend> {
  const tf = api.tf as unknown as {
    setBackend(name: string): Promise<boolean>
    ready(): Promise<void>
    getBackend(): string
    setWasmPaths?(prefix: string): void
    env(): { set(flag: string, v: unknown): void }
  }
  for (const b of prefer) {
    try {
      if (b === 'wasm') tf.setWasmPaths?.(`${modelsBaseUrl()}wasm/`)
      if (b === 'webgl') {
        // iPad Safari: half floats are flaky on some GPUs; force 32-bit textures.
        try {
          tf.env().set('WEBGL_FORCE_F16_TEXTURES', false)
        } catch {
          /* flag unknown */
        }
      }
      const ok = await tf.setBackend(b)
      if (!ok) continue
      await tf.ready()
      if (tf.getBackend() === b) return b
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No TensorFlow.js backend available')
}

export function loadFaceApi(prefer?: Backend[]): Promise<LoadedFaceApi> {
  if (!loading) {
    loading = (async () => {
      const api = (await import('@vladmandic/face-api')) as unknown as FaceApi
      const backend = await pickBackend(api, prefer)
      const modelsUrl = modelsBaseUrl()
      await Promise.all([
        api.nets.tinyFaceDetector.loadFromUri(modelsUrl),
        api.nets.faceLandmark68TinyNet.loadFromUri(modelsUrl),
        api.nets.faceRecognitionNet.loadFromUri(modelsUrl)
      ])
      return { api, backend, modelsUrl }
    })().catch((e) => {
      loading = null
      throw e
    })
  }
  return loading
}

export function faceApiLoaded(): boolean {
  return loading !== null
}

/** Variance of the Laplacian on a small grayscale crop — cheap blur measure for the quality gate. */
export function sharpnessOf(ctx: CanvasRenderingContext2D, size = 64): number {
  const { data } = ctx.getImageData(0, 0, size, size)
  const g = new Float32Array(size * size)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  let sum = 0
  let sq = 0
  let n = 0
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x
      const l = -4 * g[i] + g[i - 1] + g[i + 1] + g[i - size] + g[i + size]
      sum += l
      sq += l * l
      n++
    }
  const m = sum / n
  return sq / n - m * m
}
