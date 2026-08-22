/**
 * Stability + liveness-lite state machine (pure; unit-tested with synthetic sequences).
 *
 * A candidate is emitted only when
 *   1. the last `stableFrames` (3) consecutive frames passed the quality gate and their
 *      embeddings agree (pairwise euclidean distance on the raw descriptors < `stableDistance`,
 *      the same rule the matcher uses) — the same person, not a flicker; and
 *   2. at least one *liveness event* happened inside the trailing `livenessWindowMs` (3 s):
 *      a blink (eye aspect ratio open → closed → open) or a small head motion (nose moved by
 *      ≥ `motionFraction` of the face width while the embedding stayed stable).
 *
 * This is NOT certified liveness / presentation-attack detection. It stops the most naive
 * replay (a still photo held up to the camera) and nothing more; the legal basis for
 * recognition remains the stored consent, not this heuristic.
 */
import { euclidean, mean } from './math'
import type { Box } from './quality'

export interface TrackerFrame {
  /** ms timestamp (monotonic is fine) */
  t: number
  /** undefined when no face / failed quality gate */
  embedding?: ArrayLike<number>
  /** passed the quality gate */
  ok: boolean
  quality?: number
  /** eye aspect ratio (see quality.eyeAspectRatio) */
  ear?: number
  /** nose tip position normalised by the face box: x/width, y/height */
  nose?: { x: number; y: number }
  box?: Box
}

export type TrackerState = 'idle' | 'tracking' | 'stable' | 'ready' | 'cooldown'

export interface Candidate {
  embedding: number[]
  quality: number
  bbox: Box
  /** how the liveness requirement was satisfied */
  liveness: 'blink' | 'motion'
  frames: number
  t: number
}

export interface TrackerOptions {
  stableFrames: number
  /** max euclidean distance between raw embeddings of consecutive good frames to count as the same face */
  stableDistance: number
  livenessWindowMs: number
  /** nose displacement as a fraction of face width */
  motionFraction: number
  earOpen: number
  earClosed: number
  /** after a candidate, ignore frames for this long */
  cooldownMs: number
  /** frames older than this are dropped from the window (camera hiccups) */
  maxGapMs: number
}

export const DEFAULT_TRACKER: TrackerOptions = {
  stableFrames: 3,
  stableDistance: 0.5,
  livenessWindowMs: 3000,
  motionFraction: 0.06,
  earOpen: 0.24,
  earClosed: 0.18,
  cooldownMs: 4000,
  maxGapMs: 1500
}

interface Good {
  t: number
  embedding: ArrayLike<number>
  quality: number
  box: Box
  nose?: { x: number; y: number }
}

export class StabilityTracker {
  readonly opts: TrackerOptions
  state: TrackerState = 'idle'
  /** consecutive good frames (embedding-stable) */
  private run: Good[] = []
  private livenessEvents: { t: number; kind: 'blink' | 'motion' }[] = []
  private eyeState: 'open' | 'closed' | 'unknown' = 'unknown'
  private cooldownUntil = 0
  private lastT = 0

  constructor(opts: Partial<TrackerOptions> = {}) {
    this.opts = { ...DEFAULT_TRACKER, ...opts }
  }

  reset() {
    this.state = 'idle'
    this.run = []
    this.livenessEvents = []
    this.eyeState = 'unknown'
  }

  /** Why the tracker is waiting (for the tile hint). */
  get hint(): string {
    if (this.state === 'stable') return 'Blink or nod'
    if (this.state === 'tracking') return 'Hold still'
    return ''
  }

  /** Feed one frame; returns a candidate when all conditions are met. */
  push(f: TrackerFrame): Candidate | null {
    const o = this.opts
    if (f.t < this.cooldownUntil) {
      this.state = 'cooldown'
      return null
    }
    if (this.state === 'cooldown' || this.state === 'ready') this.state = 'idle'

    // camera hiccup → start over
    if (this.lastT && f.t - this.lastT > o.maxGapMs) this.reset()
    this.lastT = f.t

    // Blink detection runs on every frame with landmarks: the closed-eye frame often fails the
    // sharpness / landmark gate, and the blink must still count.
    if (typeof f.ear === 'number') this.trackBlink(f.ear, f.t)

    if (!f.ok || !f.embedding || !f.box) {
      // a bad frame breaks the consecutive run but keeps liveness history
      this.run = []
      this.state = this.livenessEvents.length ? 'tracking' : 'idle'
      this.trimLiveness(f.t)
      return null
    }

    // same person as the run?
    const last = this.run[this.run.length - 1]
    if (last && !(euclidean(last.embedding, f.embedding) < o.stableDistance)) {
      // different face (or a big head turn): restart everything, liveness included
      this.run = []
      this.livenessEvents = []
      this.eyeState = 'unknown'
    }

    const good: Good = { t: f.t, embedding: f.embedding, quality: f.quality ?? 0, box: f.box, nose: f.nose }

    // --- liveness signals (evaluated against the previous good frame of the same person)
    if (f.nose && last?.nose) {
      const dx = f.nose.x - last.nose.x
      const dy = f.nose.y - last.nose.y
      if (Math.hypot(dx, dy) >= o.motionFraction) this.livenessEvents.push({ t: f.t, kind: 'motion' })
    }
    this.trimLiveness(f.t)

    this.run.push(good)
    if (this.run.length > o.stableFrames) this.run.shift()

    if (this.run.length < o.stableFrames) {
      this.state = 'tracking'
      return null
    }
    // pairwise agreement over the whole run (not just neighbours)
    for (let i = 0; i < this.run.length; i++)
      for (let j = i + 1; j < this.run.length; j++)
        if (!(euclidean(this.run[i].embedding, this.run[j].embedding) < o.stableDistance)) {
          this.run = [good]
          this.state = 'tracking'
          return null
        }

    const live = this.livenessEvents[this.livenessEvents.length - 1]
    if (!live) {
      this.state = 'stable'
      return null
    }

    const cand: Candidate = {
      embedding: mean(this.run.map((g) => g.embedding)),
      quality: Math.round((this.run.reduce((s, g) => s + g.quality, 0) / this.run.length) * 1000) / 1000,
      bbox: good.box,
      liveness: live.kind,
      frames: this.run.length,
      t: f.t
    }
    this.state = 'ready'
    this.cooldownUntil = f.t + o.cooldownMs
    this.run = []
    this.livenessEvents = []
    return cand
  }

  /** open → closed → open = one blink (a closed start without a prior open frame does not count). */
  private trackBlink(ear: number, t: number) {
    const o = this.opts
    if (ear < o.earClosed) {
      if (this.eyeState === 'open') this.eyeState = 'closed'
    } else if (ear >= o.earOpen) {
      if (this.eyeState === 'closed') this.livenessEvents.push({ t, kind: 'blink' })
      this.eyeState = 'open'
    }
  }

  private trimLiveness(now: number) {
    const cutoff = now - this.opts.livenessWindowMs
    this.livenessEvents = this.livenessEvents.filter((e) => e.t >= cutoff)
  }
}
