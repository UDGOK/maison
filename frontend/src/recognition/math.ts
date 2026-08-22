/**
 * Embedding math shared by the on-device matcher, the mock server and the tests.
 *
 * ONE match rule, identical to the backend (`maison_pos/biometrics.py`): face-api descriptors are
 * NOT unit vectors (‖d‖ ≈ 1.4–1.6), so cosine similarity is compressed towards 1 and different
 * people score 0.85–0.90. The model's published rule is the **euclidean distance between the RAW
 * descriptors**: `distance < threshold` (default 0.6) ⇒ same person. Templates are never
 * normalised. `score = clamp(1 − distance / 1.2, 0, 1)` exists for display only.
 */

/** Default maximum distance (face-api `faceRecognitionNet`). */
export const DEFAULT_DISTANCE_THRESHOLD = 0.6
/** Tightest / loosest distance a device may use (the server value is authoritative; devices only tighten). */
export const MIN_DISTANCE_THRESHOLD = 0.2
export const MAX_DISTANCE_THRESHOLD = 1.5
const SCORE_SPAN = 1.2

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function norm(a: ArrayLike<number>): number {
  return Math.sqrt(dot(a, a))
}

/** Cosine similarity; 0 when either vector is empty / zero-length or the dims differ. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return 0
  const na = norm(a)
  const nb = norm(b)
  if (na === 0 || nb === 0) return 0
  return Math.max(-1, Math.min(1, dot(a, b) / (na * nb)))
}

/** Euclidean distance between two RAW vectors; `Infinity` when empty or the dims differ. */
export function euclidean(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return Infinity
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return Math.sqrt(s)
}

/** Display-only confidence for a distance: clamp(1 − d / 1.2, 0, 1). */
export function distanceToScore(distance: number): number {
  if (!Number.isFinite(distance)) return 0
  return Math.max(0, Math.min(1, 1 - distance / SCORE_SPAN))
}

/** The rule: `distance < threshold`. */
export function isMatch(distance: number, threshold = DEFAULT_DISTANCE_THRESHOLD): boolean {
  return Number.isFinite(distance) && distance < threshold
}

/** Clamp a distance threshold to the range a device may use; invalid → default. */
export function clampThreshold(v: unknown, fallback = DEFAULT_DISTANCE_THRESHOLD): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(MIN_DISTANCE_THRESHOLD, Math.min(MAX_DISTANCE_THRESHOLD, n))
}

/** A device override may only tighten the server's threshold (never loosen it). */
export function effectiveThreshold(server: unknown, device: unknown): number {
  const s = clampThreshold(server)
  const d = Number(device)
  return Number.isFinite(d) && d > 0 ? Math.min(s, clampThreshold(d)) : s
}

export function normalize(a: ArrayLike<number>): number[] {
  const n = norm(a)
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i++) out[i] = n === 0 ? 0 : a[i] / n
  return out
}

/** Element-wise mean of several equal-length vectors. */
export function mean(vectors: ArrayLike<number>[]): number[] {
  if (!vectors.length) return []
  const d = vectors[0].length
  const out = new Array<number>(d).fill(0)
  for (const v of vectors) for (let i = 0; i < d; i++) out[i] += v[i]
  for (let i = 0; i < d; i++) out[i] /= vectors.length
  return out
}

export interface TemplateLike {
  customer: string
  embedding: ArrayLike<number>
  model?: string
}

export interface BestMatch<T extends TemplateLike> {
  template: T
  /** euclidean distance on the raw descriptors (lower is better) */
  distance: number
  /** display-only: clamp(1 − distance / 1.2, 0, 1) */
  score: number
}

/**
 * Closest template per customer with `distance < threshold`, sorted ascending by distance.
 * `model` filters templates tagged with a different model (distances between models are meaningless).
 */
export function rankMatches<T extends TemplateLike>(embedding: ArrayLike<number>, templates: T[], threshold: number, model?: string): BestMatch<T>[] {
  const best = new Map<string, BestMatch<T>>()
  for (const t of templates) {
    if (model && t.model && t.model !== model) continue
    const distance = euclidean(embedding, t.embedding)
    if (!isMatch(distance, threshold)) continue
    const prev = best.get(t.customer)
    if (!prev || distance < prev.distance) best.set(t.customer, { template: t, distance, score: distanceToScore(distance) })
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance)
}

export function bestMatch<T extends TemplateLike>(embedding: ArrayLike<number>, templates: T[], threshold: number, model?: string): BestMatch<T> | null {
  return rankMatches(embedding, templates, threshold, model)[0] ?? null
}

/**
 * Pick the result to show when local and server disagree: the smaller distance wins, server on ties.
 * Rows without a `distance` (older servers) fall back to the display score.
 */
export function reconcile<A extends { customer: string; score: number; distance?: number }>(local: A | null, server: A | null): A | null {
  if (!server) return local
  if (!local) return server
  const dl = local.distance ?? (1 - local.score) * SCORE_SPAN
  const ds = server.distance ?? (1 - server.score) * SCORE_SPAN
  return ds <= dl ? server : local
}

/** Round-trip safe float32 → plain number[] (what the API expects). */
export function toArray(v: ArrayLike<number>): number[] {
  return Array.from(v, (x) => (Number.isFinite(x) ? x : 0))
}
