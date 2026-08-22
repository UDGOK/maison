/**
 * Quality gate for a single detection (pure; unit-tested with synthetic landmarks).
 *
 * A frame passes when the detector is confident, the face is large enough, roughly frontal
 * (eye line tilt, nose centred between the eyes), fully inside the frame and reasonably sharp.
 * The returned `quality` (0–1) is stored with the template so the server can weight samples.
 */

export interface Point {
  x: number
  y: number
}
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface DetectionSample {
  /** detector confidence 0–1 */
  score: number
  box: Box
  /** 68-point landmarks (dlib order): eyes 36–47, nose tip 30 */
  landmarks: Point[]
  frameWidth: number
  frameHeight: number
  /** variance of the Laplacian on a 64 px grayscale crop; undefined = not measured */
  sharpness?: number
}

export interface QualityOptions {
  minScore: number
  minFaceWidth: number
  maxTiltDeg: number
  /** |nose offset| / inter-ocular distance */
  maxNoseOffset: number
  minSharpness: number
}

export const DEFAULT_QUALITY: QualityOptions = {
  minScore: 0.8,
  minFaceWidth: 120,
  maxTiltDeg: 15,
  maxNoseOffset: 0.35,
  minSharpness: 12
}

export type QualityReason = 'score' | 'small' | 'tilt' | 'turned' | 'clipped' | 'blur' | 'landmarks'

export interface QualityResult {
  ok: boolean
  reasons: QualityReason[]
  /** 0–1 aggregate, meaningful only when ok */
  quality: number
  tiltDeg: number
  noseOffset: number
  faceWidth: number
}

export function centroid(pts: Point[]): Point {
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p.x
    y += p.y
  }
  return { x: x / pts.length, y: y / pts.length }
}

export const LEFT_EYE = [36, 37, 38, 39, 40, 41]
export const RIGHT_EYE = [42, 43, 44, 45, 46, 47]
export const NOSE_TIP = 30

function pick(pts: Point[], idx: number[]): Point[] {
  return idx.map((i) => pts[i])
}

/** Eye-line tilt in degrees (0 = level). */
export function eyeTilt(landmarks: Point[]): number {
  const l = centroid(pick(landmarks, LEFT_EYE))
  const r = centroid(pick(landmarks, RIGHT_EYE))
  return Math.abs((Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI)
}

/** Nose tip offset from the eye midpoint, normalised by inter-ocular distance (0 = centred). */
export function noseOffset(landmarks: Point[]): number {
  const l = centroid(pick(landmarks, LEFT_EYE))
  const r = centroid(pick(landmarks, RIGHT_EYE))
  const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 }
  const iod = Math.hypot(r.x - l.x, r.y - l.y) || 1
  const nose = landmarks[NOSE_TIP]
  // project the nose onto the eye line so head roll does not read as yaw
  const ux = (r.x - l.x) / iod
  const uy = (r.y - l.y) / iod
  const along = (nose.x - mid.x) * ux + (nose.y - mid.y) * uy
  return along / iod
}

/**
 * Eye aspect ratio (Soukupová & Čech): ~0.3 open, < 0.18 closed. Used by the stability tracker
 * for the blink half of liveness-lite.
 */
export function eyeAspectRatio(landmarks: Point[]): number {
  const ear = (idx: number[]) => {
    const [p1, p2, p3, p4, p5, p6] = pick(landmarks, idx)
    const v = Math.hypot(p2.x - p6.x, p2.y - p6.y) + Math.hypot(p3.x - p5.x, p3.y - p5.y)
    const h = Math.hypot(p1.x - p4.x, p1.y - p4.y) || 1
    return v / (2 * h)
  }
  return (ear(LEFT_EYE) + ear(RIGHT_EYE)) / 2
}

export function assessQuality(s: DetectionSample, opts: Partial<QualityOptions> = {}): QualityResult {
  const o = { ...DEFAULT_QUALITY, ...opts }
  const reasons: QualityReason[] = []
  const faceWidth = s.box.width
  if (!s.landmarks || s.landmarks.length < 48) {
    return { ok: false, reasons: ['landmarks'], quality: 0, tiltDeg: 0, noseOffset: 0, faceWidth }
  }
  const tiltDeg = eyeTilt(s.landmarks)
  const nose = noseOffset(s.landmarks)
  if (s.score < o.minScore) reasons.push('score')
  if (faceWidth < o.minFaceWidth) reasons.push('small')
  if (tiltDeg > o.maxTiltDeg) reasons.push('tilt')
  if (Math.abs(nose) > o.maxNoseOffset) reasons.push('turned')
  const margin = 2
  if (s.box.x < -margin || s.box.y < -margin || s.box.x + s.box.width > s.frameWidth + margin || s.box.y + s.box.height > s.frameHeight + margin) reasons.push('clipped')
  if (s.sharpness !== undefined && s.sharpness < o.minSharpness) reasons.push('blur')

  // aggregate: confidence × size × frontal-ness
  const sizeQ = Math.min(1, faceWidth / (o.minFaceWidth * 2))
  const frontalQ = Math.max(0, 1 - tiltDeg / (o.maxTiltDeg * 2)) * Math.max(0, 1 - Math.abs(nose) / (o.maxNoseOffset * 2))
  const sharpQ = s.sharpness === undefined ? 1 : Math.min(1, s.sharpness / (o.minSharpness * 3))
  const quality = Math.round(s.score * sizeQ * frontalQ * sharpQ * 1000) / 1000

  return { ok: reasons.length === 0, reasons, quality, tiltDeg, noseOffset: nose, faceWidth }
}

/** Human hint for the tile ("Move closer", …). */
export function qualityHint(r: QualityResult): string {
  const first = r.reasons[0]
  switch (first) {
    case 'small':
      return 'Move closer'
    case 'tilt':
      return 'Keep your head level'
    case 'turned':
      return 'Look at the camera'
    case 'clipped':
      return 'Centre your face'
    case 'blur':
      return 'Hold still'
    case 'score':
    case 'landmarks':
      return 'Looking'
    default:
      return ''
  }
}
