/**
 * Consent capture helpers (pure; unit-tested).
 *
 * - `HoldToAgree`: the "Agree" button must be held for `holdMs` (600 ms) without releasing.
 *   Progress drives the gold ring; releasing early cancels and the ring rewinds.
 * - `SignatureStroke`: a signature counts as agreement only when it has real ink —
 *   a minimum number of points and a minimum path length (a single tap is not a signature).
 */

export const HOLD_MS = 600

export class HoldToAgree {
  private startedAt: number | null = null
  private completedAt: number | null = null

  constructor(public readonly holdMs: number = HOLD_MS) {}

  get holding(): boolean {
    return this.startedAt !== null && this.completedAt === null
  }
  get done(): boolean {
    return this.completedAt !== null
  }

  /** Pointer down. Ignored once completed. */
  press(now: number) {
    if (this.done) return
    this.startedAt = now
  }

  /** Pointer up / leave / cancel before completion resets progress. */
  release(now: number): boolean {
    if (this.done) return true
    if (this.startedAt !== null && now - this.startedAt >= this.holdMs) {
      this.completedAt = now
      return true
    }
    this.startedAt = null
    return false
  }

  /** 0–1 progress at `now`; marks completion when the hold time elapsed. */
  progress(now: number): number {
    if (this.done) return 1
    if (this.startedAt === null) return 0
    const p = Math.min(1, (now - this.startedAt) / this.holdMs)
    if (p >= 1) this.completedAt = now
    return p
  }

  reset() {
    this.startedAt = null
    this.completedAt = null
  }
}

export interface StrokePoint {
  x: number
  y: number
}

export const SIGNATURE_MIN_POINTS = 12
export const SIGNATURE_MIN_LENGTH = 120

export function strokeLength(points: StrokePoint[][]): number {
  let len = 0
  for (const stroke of points) for (let i = 1; i < stroke.length; i++) len += Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y)
  return len
}

export function signatureValid(points: StrokePoint[][], minPoints = SIGNATURE_MIN_POINTS, minLength = SIGNATURE_MIN_LENGTH): boolean {
  const n = points.reduce((s, st) => s + st.length, 0)
  return n >= minPoints && strokeLength(points) >= minLength
}
