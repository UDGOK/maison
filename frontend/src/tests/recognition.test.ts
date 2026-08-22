import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { cosine, euclidean, distanceToScore, isMatch, clampThreshold, effectiveThreshold, normalize, rankMatches, bestMatch, reconcile, mean, DEFAULT_DISTANCE_THRESHOLD } from '@/recognition/math'
import { assessQuality, eyeAspectRatio, eyeTilt, noseOffset, qualityHint, type Point } from '@/recognition/quality'
import { StabilityTracker } from '@/recognition/stability'
import { HoldToAgree, signatureValid, strokeLength } from '@/recognition/consent'
import { EnrolmentQueue } from '@/recognition/enrolments'
import { TemplateCache, matchEmbedding } from '@/recognition/matcher'
import { MaisonDB } from '@/db'
import { ApiError, normalizeSettings, DEFAULT_SETTINGS, type MaisonApi } from '@/api/types'
import { mockApi, __resetMock, __mockRecognition } from '@/api/mock'

// ---------------------------------------------------------------------------------------------
// synthetic helpers
// ---------------------------------------------------------------------------------------------

function lcg(seed: number, dims: number): number[] {
  let x = seed * 9301 + 49297
  const out: number[] = []
  for (let i = 0; i < dims; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    out.push(x / 2147483648 - 0.5)
  }
  return out
}
/** Shared "mean face" component — real face-api descriptors all point roughly the same way. */
const BASE = normalize(lcg(20260822, 512))

/**
 * Deterministic synthetic face-api-like descriptor, 128-d and deliberately NOT a unit vector:
 * ‖v‖ ≈ 1.55, cross-person cosine ≈ 0.85–0.90 (what real descriptors show) while the euclidean
 * distance between two different people is ≈ 0.78 (> 0.6).
 */
function vec(seed: number, dims = 128): number[] {
  const dev = normalize(lcg(seed, dims))
  const base = normalize(BASE.slice(0, dims))
  return base.map((b, i) => 1.45 * b + 0.55 * dev[i])
}
/** Same face, perturbed: `amount` is the euclidean distance of the perturbation (default 0.15). */
function jitter(v: number[], seed: number, amount = 0.15): number[] {
  const n = normalize(lcg(seed + 1000, v.length))
  return v.map((x, i) => x + n[i] * amount)
}

/**
 * 68-point landmark set: eyes centred at (cx ± 30, cy), nose tip at (cx + noseDx, cy + 25).
 * `h` is the half eye height → EAR = h / 10 (3 → 0.3 open, 1 → 0.1 closed).
 */
function landmarks(cx = 320, cy = 220, opts: { h?: number; noseDx?: number; tiltDeg?: number } = {}): Point[] {
  const h = opts.h ?? 3
  const pts: Point[] = Array.from({ length: 68 }, (_, i) => ({ x: cx + ((i % 17) - 8) * 8, y: cy + 60 + Math.floor(i / 17) * 10 }))
  const eye = (ex: number): Point[] => [
    { x: ex - 10, y: cy },
    { x: ex - 4, y: cy - h },
    { x: ex + 4, y: cy - h },
    { x: ex + 10, y: cy },
    { x: ex + 4, y: cy + h },
    { x: ex - 4, y: cy + h }
  ]
  eye(cx - 30).forEach((p, i) => (pts[36 + i] = p))
  eye(cx + 30).forEach((p, i) => (pts[42 + i] = p))
  pts[30] = { x: cx + (opts.noseDx ?? 0), y: cy + 25 }
  if (opts.tiltDeg) {
    const a = (opts.tiltDeg * Math.PI) / 180
    for (let i = 0; i < 68; i++) {
      const dx = pts[i].x - cx
      const dy = pts[i].y - cy
      pts[i] = { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) }
    }
  }
  return pts
}

const frame = { frameWidth: 640, frameHeight: 480 }
const goodBox = { x: 240, y: 140, width: 160, height: 180 }

// ---------------------------------------------------------------------------------------------

describe('embedding math (euclidean on raw descriptors — same rule as the server)', () => {
  it('synthetic descriptors behave like face-api ones: non-unit, cosine ≈ 0.88 across people, distance > 0.6', () => {
    const a = vec(1)
    const b = vec(2)
    const na = Math.hypot(...a)
    expect(na).toBeGreaterThan(1.3)
    expect(na).toBeLessThan(1.7)
    expect(cosine(a, b)).toBeGreaterThan(0.85)
    expect(cosine(a, b)).toBeLessThan(0.92)
    expect(euclidean(a, b)).toBeGreaterThan(0.6)
    expect(euclidean(a, jitter(a, 3))).toBeCloseTo(0.15, 6)
  })
  it('euclidean / distanceToScore / isMatch', () => {
    const a = vec(1)
    expect(euclidean(a, a)).toBe(0)
    expect(euclidean([1, 0, 0], [1, 0])).toBe(Infinity)
    expect(euclidean([], [])).toBe(Infinity)
    expect(euclidean([0, 0], [3, 4])).toBe(5)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(cosine([0, 0], [0, 0])).toBe(0)
    expect(distanceToScore(0)).toBe(1)
    expect(distanceToScore(0.6)).toBeCloseTo(0.5, 6)
    expect(distanceToScore(1.2)).toBe(0)
    expect(distanceToScore(9)).toBe(0)
    expect(distanceToScore(Infinity)).toBe(0)
    expect(isMatch(0.59)).toBe(true)
    expect(isMatch(0.6)).toBe(false)
    expect(isMatch(Infinity)).toBe(false)
    expect(isMatch(0.45, 0.4)).toBe(false)
    // scaling a descriptor changes the distance (raw rule) but not the cosine — the old bug
    const scaled = a.map((x) => x * 1.5)
    expect(cosine(scaled, a)).toBeCloseTo(1, 9)
    expect(isMatch(euclidean(scaled, a))).toBe(false)
  })
  it('threshold helpers: defaults, clamping, device may only tighten', () => {
    expect(DEFAULT_DISTANCE_THRESHOLD).toBe(0.6)
    expect(clampThreshold('x')).toBe(0.6)
    expect(clampThreshold(0)).toBe(0.6)
    expect(clampThreshold(-1)).toBe(0.6)
    expect(clampThreshold(0.45)).toBe(0.45)
    expect(clampThreshold(5)).toBe(1.5)
    expect(clampThreshold(0.01)).toBe(0.2)
    expect(effectiveThreshold(0.6, null)).toBe(0.6)
    expect(effectiveThreshold(0.6, 0.4)).toBe(0.4)
    expect(effectiveThreshold(0.6, 0.9)).toBe(0.6) // looser device value ignored
    expect(effectiveThreshold(undefined, 0.5)).toBe(0.5)
    expect(effectiveThreshold('bad', 'bad')).toBe(0.6)
  })
  it('cross-person regression: cosine 0.88 but distance > 0.6 must NOT match', () => {
    const me = vec(201)
    const other = vec(202)
    const templates = [0, 1, 2].map((i) => ({ customer: 'ME', embedding: jitter(me, i, 0.1), model: 'm' }))
    const cos = Math.max(...templates.map((t) => cosine(other, t.embedding)))
    const dist = Math.min(...templates.map((t) => euclidean(other, t.embedding)))
    expect(cos).toBeGreaterThan(0.85) // the old cosine rule (0.849) would have matched
    expect(dist).toBeGreaterThan(0.6)
    expect(bestMatch(other, templates, 0.6, 'm')).toBeNull()
    expect(bestMatch(jitter(me, 9, 0.2), templates, 0.6, 'm')?.template.customer).toBe('ME')
  })
  it('rankMatches keeps the closest template per customer under the threshold, sorted by distance', () => {
    const a = vec(10)
    const b = vec(20)
    const templates = [
      { customer: 'A', embedding: jitter(a, 1), model: 'm' },
      { customer: 'A', embedding: jitter(a, 2, 0.05), model: 'm' },
      { customer: 'B', embedding: b, model: 'm' },
      { customer: 'C', embedding: a, model: 'other-model' }
    ]
    const ranked = rankMatches(a, templates, 0.6, 'm')
    expect(ranked.map((r) => r.template.customer)).toEqual(['A'])
    expect(ranked[0].distance).toBeCloseTo(0.05, 6)
    expect(ranked[0].score).toBeCloseTo(distanceToScore(0.05), 6)
    expect(bestMatch(b, templates, 0.6, 'm')?.template.customer).toBe('B')
    expect(bestMatch(vec(99), templates, 0.6, 'm')).toBeNull()
    // threshold semantics: a maximum distance — at/above → dropped
    expect(rankMatches(jitter(a, 3, 0.5), templates, 0.4, 'm')).toHaveLength(0)
    expect(rankMatches(jitter(a, 3, 0.59), templates, 0.6, 'm')).toHaveLength(1)
    expect(rankMatches(jitter(a, 3, 0.61), templates, 0.6, 'm')).toHaveLength(0)
  })
  it('reconcile prefers the smaller distance when local and server disagree (score fallback)', () => {
    const l = { customer: 'A', score: 0.7, distance: 0.36 }
    const s = { customer: 'B', score: 0.8, distance: 0.24 }
    expect(reconcile(l, s)).toBe(s)
    expect(reconcile({ customer: 'A', score: 0.9, distance: 0.12 }, s)?.customer).toBe('A')
    expect(reconcile(null, s)).toBe(s)
    expect(reconcile(l, null)).toBe(l)
    expect(reconcile({ customer: 'A', score: 0.7, distance: 0.3 }, { customer: 'A', score: 0.75, distance: 0.3 })?.score).toBe(0.75)
    // older server rows without distance: derived from the display score
    expect(reconcile({ customer: 'A', score: 0.7 }, { customer: 'B', score: 0.8 })?.customer).toBe('B')
  })
  it('mean averages vectors', () => {
    expect(mean([[1, 2], [3, 4]])).toEqual([2, 3])
  })
})

describe('quality gate', () => {
  it('passes a large, frontal, confident, sharp face', () => {
    const r = assessQuality({ score: 0.95, box: goodBox, landmarks: landmarks(), sharpness: 40, ...frame })
    expect(r.ok).toBe(true)
    expect(r.reasons).toEqual([])
    expect(r.quality).toBeGreaterThan(0.5)
    expect(r.tiltDeg).toBeCloseTo(0, 5)
    expect(r.noseOffset).toBeCloseTo(0, 5)
  })
  it('rejects low score, small faces, tilt, turned heads, clipping and blur with hints', () => {
    expect(assessQuality({ score: 0.5, box: goodBox, landmarks: landmarks(), ...frame }).reasons).toContain('score')
    const small = assessQuality({ score: 0.9, box: { ...goodBox, width: 80 }, landmarks: landmarks(), ...frame })
    expect(small.reasons).toContain('small')
    expect(qualityHint(small)).toBe('Move closer')
    const tilted = assessQuality({ score: 0.9, box: goodBox, landmarks: landmarks(320, 220, { tiltDeg: 25 }), ...frame })
    expect(tilted.reasons).toContain('tilt')
    expect(tilted.tiltDeg).toBeCloseTo(25, 0)
    expect(qualityHint(tilted)).toBe('Keep your head level')
    const turned = assessQuality({ score: 0.9, box: goodBox, landmarks: landmarks(320, 220, { noseDx: 30 }), ...frame })
    expect(turned.reasons).toContain('turned')
    expect(qualityHint(turned)).toBe('Look at the camera')
    const clipped = assessQuality({ score: 0.9, box: { ...goodBox, x: 560 }, landmarks: landmarks(), ...frame })
    expect(clipped.reasons).toContain('clipped')
    const blur = assessQuality({ score: 0.9, box: goodBox, landmarks: landmarks(), sharpness: 2, ...frame })
    expect(blur.reasons).toContain('blur')
    expect(qualityHint(blur)).toBe('Hold still')
    expect(assessQuality({ score: 0.9, box: goodBox, landmarks: [], ...frame }).reasons).toEqual(['landmarks'])
  })
  it('allows a small tilt (< 15°) and a slightly off-centre nose', () => {
    expect(assessQuality({ score: 0.9, box: goodBox, landmarks: landmarks(320, 220, { tiltDeg: 10, noseDx: 10 }), ...frame }).ok).toBe(true)
  })
  it('landmark helpers: tilt, nose offset, EAR', () => {
    expect(eyeTilt(landmarks())).toBeCloseTo(0, 5)
    expect(noseOffset(landmarks(320, 220, { noseDx: 30 }))).toBeCloseTo(0.5, 5)
    expect(eyeAspectRatio(landmarks(320, 220, { h: 3 }))).toBeCloseTo(0.3, 5)
    expect(eyeAspectRatio(landmarks(320, 220, { h: 1 }))).toBeCloseTo(0.1, 5)
  })
})

describe('stability / liveness-lite state machine', () => {
  const base = vec(7)
  const good = (t: number, i: number, extra: Partial<Parameters<StabilityTracker['push']>[0]> = {}) => ({
    t,
    ok: true,
    embedding: jitter(base, i, 0.05),
    quality: 0.8,
    ear: 0.3,
    nose: { x: 0.5, y: 0.55 },
    box: goodBox,
    ...extra
  })

  it('emits nothing without liveness: a photo held still is never a candidate', () => {
    const tr = new StabilityTracker()
    for (let i = 0; i < 20; i++) expect(tr.push(good(i * 250, i))).toBeNull()
    expect(tr.state).toBe('stable')
    expect(tr.hint).toBe('Blink or nod')
  })

  it('emits after 3 stable frames + a blink, then cools down', () => {
    const tr = new StabilityTracker()
    expect(tr.push(good(0, 1))).toBeNull()
    expect(tr.state).toBe('tracking')
    expect(tr.push(good(250, 2))).toBeNull()
    // blink: closed frame (fails the gate — still counts), then open
    expect(tr.push({ t: 500, ok: false, ear: 0.1 })).toBeNull()
    expect(tr.push(good(750, 3))).toBeNull() // run restarted by the bad frame
    expect(tr.push(good(1000, 4))).toBeNull()
    const cand = tr.push(good(1250, 5))
    expect(cand).not.toBeNull()
    expect(cand!.liveness).toBe('blink')
    expect(cand!.frames).toBe(3)
    expect(cand!.embedding).toHaveLength(128)
    expect(cosine(cand!.embedding, base)).toBeGreaterThan(0.99)
    expect(cand!.quality).toBeCloseTo(0.8, 5)
    expect(tr.state).toBe('ready')
    // cooldown: frames inside 4 s are ignored
    expect(tr.push(good(1500, 6))).toBeNull()
    expect(tr.state).toBe('cooldown')
  })

  it('counts a small head motion as liveness', () => {
    const tr = new StabilityTracker()
    tr.push(good(0, 1))
    tr.push(good(250, 2, { nose: { x: 0.58, y: 0.55 } })) // moved 0.08 of the face width
    const cand = tr.push(good(500, 3, { nose: { x: 0.58, y: 0.55 } }))
    expect(cand?.liveness).toBe('motion')
  })

  it('requires the blink inside the 3 s window', () => {
    const tr = new StabilityTracker()
    tr.push({ t: 0, ok: false, ear: 0.3 })
    tr.push({ t: 100, ok: false, ear: 0.1 })
    tr.push({ t: 200, ok: false, ear: 0.3 }) // blink at t=200
    tr.push(good(3500, 1))
    tr.push(good(3750, 2))
    expect(tr.push(good(4000, 3))).toBeNull() // 3.8 s later: expired
    expect(tr.state).toBe('stable')
  })

  it('a different face resets the run and the liveness history', () => {
    const tr = new StabilityTracker()
    tr.push({ t: 0, ok: false, ear: 0.3 })
    tr.push({ t: 100, ok: false, ear: 0.1 })
    tr.push(good(200, 1)) // blink completes here (open)
    tr.push(good(450, 2))
    const other = vec(99)
    expect(tr.push({ ...good(700, 3), embedding: other })).toBeNull()
    expect(tr.push({ ...good(950, 4), embedding: jitter(other, 4, 0.05) })).toBeNull()
    expect(tr.push({ ...good(1200, 5), embedding: jitter(other, 5, 0.05) })).toBeNull() // stable but liveness was cleared
    expect(tr.state).toBe('stable')
  })

  it('a camera gap (> 1.5 s) restarts tracking', () => {
    const tr = new StabilityTracker()
    tr.push({ t: 0, ok: false, ear: 0.3 })
    tr.push({ t: 100, ok: false, ear: 0.1 })
    tr.push(good(200, 1))
    tr.push(good(450, 2))
    expect(tr.push(good(2500, 3))).toBeNull()
    expect(tr.state).toBe('tracking')
  })
})

describe('consent: hold-to-agree timing and signature', () => {
  it('completes only after an uninterrupted 600 ms hold', () => {
    const h = new HoldToAgree(600)
    expect(h.progress(0)).toBe(0)
    h.press(1000)
    expect(h.progress(1300)).toBeCloseTo(0.5, 5)
    expect(h.release(1400)).toBe(false) // released early → reset
    expect(h.progress(1500)).toBe(0)
    h.press(2000)
    expect(h.progress(2599)).toBeLessThan(1)
    expect(h.done).toBe(false)
    expect(h.progress(2600)).toBe(1)
    expect(h.done).toBe(true)
    expect(h.release(2700)).toBe(true)
    h.reset()
    expect(h.done).toBe(false)
  })
  it('release at exactly the hold time completes', () => {
    const h = new HoldToAgree()
    h.press(0)
    expect(h.release(600)).toBe(true)
  })
  it('a signature needs real ink, a tap does not count', () => {
    expect(signatureValid([[{ x: 1, y: 1 }]])).toBe(false)
    const stroke = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: (i % 2) * 8 }))
    expect(strokeLength([stroke])).toBeGreaterThan(120)
    expect(signatureValid([stroke])).toBe(true)
    const tiny = Array.from({ length: 20 }, (_, i) => ({ x: i * 0.5, y: 0 }))
    expect(signatureValid([tiny])).toBe(false)
  })
})

describe('settings normalisation (v0.3 fields)', () => {
  it('coerces recognition flags/numbers and falls back to defaults', () => {
    const s = normalizeSettings({ face_recognition_enabled: 1, match_threshold: '0.7', biometric_retention_months: '24', recognition_offline_cache: 0 } as any)
    expect(s.face_recognition_enabled).toBe(true)
    expect(s.match_threshold).toBe(0.7)
    expect(s.biometric_retention_months).toBe(24)
    expect(s.recognition_offline_cache).toBe(false)
    expect(s.recognition_model).toBe(DEFAULT_SETTINGS.recognition_model)
    expect(s.consent_text.length).toBeGreaterThan(100)
    expect(normalizeSettings({}).face_recognition_enabled).toBe(false)
    expect(normalizeSettings({ match_threshold: 'x' } as any).match_threshold).toBe(0.6)
    expect(normalizeSettings({ match_threshold: 0 } as any).match_threshold).toBe(0.6)
    expect(normalizeSettings({ match_threshold: '0.45' } as any).match_threshold).toBe(0.45)
    expect(normalizeSettings({ match_threshold: 7 } as any).match_threshold).toBe(1.5)
    expect(DEFAULT_SETTINGS.match_threshold).toBe(0.6)
  })
})

// ---------------------------------------------------------------------------------------------

let dbi = 0
describe('enrolment queue replay', () => {
  let db: MaisonDB
  beforeEach(() => {
    db = new MaisonDB(`rec_${dbi++}`)
  })
  const pending = (kind: 'enroll' | 'decline', phone: string) => ({
    kind,
    boutique: 'CHI-OAK',
    device_id: 'd1',
    associate: 'MA-0001',
    phone,
    model: 'm',
    embeddings: kind === 'enroll' ? [vec(1), vec(1), vec(1)] : [],
    quality: kind === 'enroll' ? [0.9, 0.8, 0.85] : [],
    consent: kind === 'enroll' ? { method: 'Hold-to-agree' as const, text_version: '2026-08-1' } : undefined
  })

  it('stays queued while offline, then replays FIFO and clears', async () => {
    let online = false
    const calls: string[] = []
    const api = {
      recognition: {
        enroll: async (r: any) => {
          if (!online) throw new ApiError('Failed to fetch', 'NETWORK', 0)
          calls.push(`enroll:${r.phone}`)
          return { customer: `C-${r.phone}`, consent: 'MBC-1', template_count: r.embeddings.length }
        },
        decline: async (r: any) => {
          if (!online) throw new ApiError('Failed to fetch', 'NETWORK', 0)
          calls.push(`decline:${r.phone}`)
          return { customer: `C-${r.phone}` }
        }
      }
    } as unknown as MaisonApi
    const q = new EnrolmentQueue(db, api)
    // the store hands over reactive proxies + Float32Array descriptors; the queue must store plain data
    const reactiveish = reactive(pending('enroll', '111'))
    reactiveish.embeddings[1] = Float32Array.from(reactiveish.embeddings[1]) as unknown as number[]
    await q.enqueue(reactiveish)
    await q.enqueue(pending('decline', '222'))
    const stored = (await q.pending())[0]
    expect(stored.embeddings.every((e) => Array.isArray(e) && e.length === 128)).toBe(true)
    expect(stored.embeddings[1][0]).toBeCloseTo(reactiveish.embeddings[1][0], 5)
    let out = await q.replay()
    expect(out).toMatchObject({ offline: true, pending: 2 })
    expect((await q.pending())[0].attempts).toBe(1)
    online = true
    out = await q.replay()
    expect(out.offline).toBe(false)
    expect(out.pending).toBe(0)
    expect(calls).toEqual(['enroll:111', 'decline:222'])
    expect(out.done.map((d) => d.result.customer)).toEqual(['C-111', 'C-222'])
  })

  it('sends a stable offline_uuid, shares one run between concurrent callers and retries on 409', async () => {
    const seen: string[] = []
    let dup = true
    const api = {
      recognition: {
        enroll: async (r: any) => {
          seen.push(r.offline_uuid)
          await new Promise((res) => setTimeout(res, 20))
          if (dup) throw new ApiError('Duplicate entry', 'DuplicateEntryError', 409)
          return { customer: 'C-1', consent: 'MBC-1', template_count: 3 }
        },
        decline: async () => ({ customer: 'X' })
      }
    } as unknown as MaisonApi
    const q = new EnrolmentQueue(db, api)
    const row = await q.enqueue(pending('enroll', '333'))
    expect(row.offline_uuid).toMatch(/^[0-9a-f-]{36}$/)
    // the `online` event and the heartbeat both call replay() on reconnect: one request, not two
    const [a, b] = await Promise.all([q.replay(), q.replay()])
    expect(a).toBe(b)
    expect(seen).toEqual([row.offline_uuid])
    expect(a.pending).toBe(1) // 409 is transient: kept for the next tick
    dup = false
    const out = await q.replay()
    expect(seen).toEqual([row.offline_uuid, row.offline_uuid])
    expect(out.pending).toBe(0)
    expect(out.done[0].result.customer).toBe('C-1')
  })

  it('drops rows the server rejects outright and continues', async () => {
    const api = {
      recognition: {
        enroll: async (r: any) => {
          if (r.phone === 'bad') throw new ApiError('Phone or email is required', 'ValidationError', 417)
          return { customer: 'ok', consent: 'x', templates: 3 }
        },
        decline: async () => ({ customer: 'ok' })
      }
    } as unknown as MaisonApi
    const q = new EnrolmentQueue(db, api)
    await q.enqueue(pending('enroll', 'bad'))
    await q.enqueue(pending('enroll', 'good'))
    const out = await q.replay()
    expect(out.failed).toHaveLength(1)
    expect(out.done).toHaveLength(1)
    expect(out.pending).toBe(0)
  })
})

describe('template cache + matcher', () => {
  let db: MaisonDB
  beforeEach(() => {
    db = new MaisonDB(`rec_${dbi++}`)
  })

  it('applies snapshots (full + delta with deletions) and matches locally when offline', async () => {
    const cache = new TemplateCache(db)
    await cache.apply({ templates: [{ customer: 'A', customer_name: 'Ann', embedding: vec(1), model: 'm' }, { customer: 'A', customer_name: 'Ann', embedding: jitter(vec(1), 2), model: 'm' }, { customer: 'B', customer_name: 'Bo', embedding: vec(2), model: 'm' }], deleted: [] }, true)
    expect(await cache.count()).toBe(3)
    await cache.apply({ templates: [], deleted: ['B'] }, false)
    expect(await cache.count()).toBe(2)
    const api = { recognition: { match: async () => { throw new Error('should not be called offline') } } } as unknown as MaisonApi
    const out = await matchEmbedding({ db, api, online: () => false }, jitter(vec(1), 5), 'm', 'CHI-OAK', 0.6)
    expect(out.match?.customer).toBe('A')
    expect(out.source).toBe('local')
    expect(out.online).toBe(false)
    const none = await matchEmbedding({ db, api, online: () => false }, vec(50), 'm', 'CHI-OAK', 0.6)
    expect(none.match).toBeNull()
  })

  it('prefers the server when it disagrees with a higher score, local otherwise', async () => {
    const cache = new TemplateCache(db)
    await cache.apply({ templates: [{ customer: 'A', customer_name: 'Ann', embedding: vec(1), model: 'm' }], deleted: [] }, true)
    let serverDistance = 0.05
    let serverThreshold = 0.6
    const api = {
      recognition: {
        match: async () => ({
          matches: [{ customer: 'Z', customer_name: 'Zed', distance: serverDistance, score: distanceToScore(serverDistance) }],
          threshold_distance: serverThreshold,
          threshold: serverThreshold
        })
      }
    } as unknown as MaisonApi
    let out = await matchEmbedding({ db, api, online: () => true }, jitter(vec(1), 1, 0.3), 'm', 'CHI-OAK', 0.6)
    expect(out.match?.customer).toBe('Z')
    expect(out.source).toBe('server')
    expect(out.serverDistance).toBe(0.05)
    expect(out.localDistance).toBeCloseTo(0.3, 6)
    serverDistance = 0.55
    out = await matchEmbedding({ db, api, online: () => true }, vec(1), 'm', 'CHI-OAK', 0.6)
    expect(out.match?.customer).toBe('A')
    expect(out.source).toBe('local')
    // the server's threshold applies to server rows
    serverDistance = 0.7
    out = await matchEmbedding({ db, api, online: () => true }, vec(77), 'm', 'CHI-OAK', 0.6)
    expect(out.match).toBeNull()
    // a stricter (lower) device threshold tightens the server verdict …
    serverDistance = 0.5
    out = await matchEmbedding({ db, api, online: () => true }, vec(77), 'm', 'CHI-OAK', 0.4)
    expect(out.match).toBeNull()
    expect(out.threshold).toBe(0.4)
    // … but a looser device value never loosens it
    serverThreshold = 0.4
    out = await matchEmbedding({ db, api, online: () => true }, vec(77), 'm', 'CHI-OAK', 0.9)
    expect(out.match).toBeNull()
    expect(out.threshold).toBe(0.4)
    // server rows without a distance are ignored (never trust a bare score)
    const legacy = { recognition: { match: async () => ({ matches: [{ customer: 'Z', customer_name: 'Zed', score: 0.99 }], threshold: 0.6 }) } } as unknown as MaisonApi
    out = await matchEmbedding({ db, api: legacy, online: () => true }, vec(77), 'm', 'CHI-OAK', 0.6)
    expect(out.match).toBeNull()
  })
})

describe('mock API recognition (contract)', () => {
  beforeEach(() => __resetMock())

  it('bootstrap exposes the recognition settings per boutique', async () => {
    const chi = await mockApi.catalog.bootstrap('CHI-OAK')
    expect(chi.settings.face_recognition_enabled).toBe(true)
    expect(chi.settings.match_threshold).toBe(0.6)
    expect(chi.settings.consent_text_version).toBe('2026-08-1')
    expect((await mockApi.catalog.bootstrap('LA-RODEO')).settings.face_recognition_enabled).toBe(false)
  })

  it('enroll by phone creates the customer, consent + templates; match finds it; decline links without biometrics', async () => {
    const e = vec(3)
    const res = await mockApi.recognition.enroll({
      embeddings: [e, jitter(e, 1), jitter(e, 2)],
      quality: [0.9, 0.8, 0.85],
      model: 'face-api/faceRecognitionNet@1',
      boutique: 'CHI-OAK',
      device_id: 'd1',
      consent: { method: 'Hold-to-agree', text_version: '2026-08-1' },
      phone: '+1 312 555 0199',
      name: 'Nadia Okafor'
    })
    expect(res.customer).toMatch(/^CUST-/)
    expect(res.template_count).toBe(3)
    expect(res.created).toBe(true)
    expect(res.client_number).toMatch(/^MC\d{6}$/)
    const c = (await mockApi.customers.lookup(`MC:${res.customer}`))!
    expect(c.maison_face_consent).toBe(1)
    expect(c.maison_face_consent_at).toBeTruthy()
    expect(c.customer_name).toBe('Nadia Okafor')

    const m = await mockApi.recognition.match(jitter(e, 9, 0.05), 'face-api/faceRecognitionNet@1', 'CHI-OAK')
    expect(m.threshold).toBe(0.6)
    expect(m.threshold_distance).toBe(0.6)
    expect(m.matches[0]).toMatchObject({ customer: res.customer, customer_name: 'Nadia Okafor' })
    expect(m.matches[0].distance).toBeLessThan(0.1)
    expect(m.matches[0].score).toBeGreaterThan(0.9)
    expect(m.best_distance).toBe(m.matches[0].distance)
    expect((await mockApi.recognition.match(vec(40), 'face-api/faceRecognitionNet@1', 'CHI-OAK')).matches).toHaveLength(0)
    // wrong model → no match
    expect((await mockApi.recognition.match(e, 'other@2', 'CHI-OAK')).matches).toHaveLength(0)

    // re-enrolling with the same phone links to the same customer
    const again = await mockApi.recognition.enroll({ embeddings: [e], quality: [1], model: 'face-api/faceRecognitionNet@1', boutique: 'CHI-OAK', device_id: 'd1', consent: { method: 'Signature', text_version: '2026-08-1', signature_data_url: 'data:image/png;base64,AAAA' }, phone: '3125550199' })
    expect(again.customer).toBe(res.customer)
    expect(__mockRecognition.consents().filter((x) => x.customer === res.customer && x.status === 'Active')).toHaveLength(1)

    const d = await mockApi.recognition.decline({ boutique: 'CHI-OAK', device_id: 'd1', email: 'new@example.com', name: 'New Person' })
    const dc = (await mockApi.customers.lookup(`MC:${d.customer}`))!
    expect(dc.maison_face_consent).toBe(0)
    expect(__mockRecognition.events().map((x) => x.outcome)).toEqual(expect.arrayContaining(['Enrolled', 'Matched', 'NoMatch', 'Declined']))
  })

  it('rejects enrolment without consent or with malformed embeddings', async () => {
    await expect(mockApi.recognition.enroll({ embeddings: [vec(1)], quality: [1], model: 'm', boutique: 'CHI-OAK', device_id: 'd', consent: undefined as any, phone: '3125550100' })).rejects.toMatchObject({ code: 'ValidationError' })
    await expect(mockApi.recognition.enroll({ embeddings: [[1, 2], [1]], quality: [1, 1], model: 'm', boutique: 'CHI-OAK', device_id: 'd', consent: { method: 'Hold-to-agree', text_version: '1' }, phone: '3125550100' })).rejects.toMatchObject({ code: 'ValidationError' })
    await expect(mockApi.recognition.enroll({ embeddings: [vec(1)], quality: [1], model: 'm', boutique: 'CHI-OAK', device_id: 'd', consent: { method: 'Hold-to-agree', text_version: '1' } })).rejects.toMatchObject({ code: 'ValidationError' })
    await expect(mockApi.recognition.match(vec(1), 'm', 'LA-RODEO')).rejects.toMatchObject({ code: 'PermissionError' })
  })

  it('templates returns only consented clients; revoke purges and marks deleted', async () => {
    const all = await mockApi.customers.search('', 50)
    const target = all[0]
    __mockRecognition.setTemplates([{ customer: target.name, embedding: vec(5) }])
    let t = await mockApi.recognition.templates('CHI-OAK')
    expect(t.templates.map((x) => x.customer)).toEqual([target.name])
    expect(t.templates[0].customer_name).toBe(target.customer_name)
    await expect(mockApi.recognition.revoke(target.name, '')).rejects.toMatchObject({ code: 'ValidationError' })
    await mockApi.recognition.revoke(target.name, 'Client request')
    t = await mockApi.recognition.templates('CHI-OAK')
    expect(t.templates).toHaveLength(0)
    expect(t.deleted).toContain(target.name)
    expect(__mockRecognition.templates()).toHaveLength(0)
    expect((await mockApi.customers.lookup(`MC:${target.name}`))!.maison_face_consent).toBe(0)
    expect((await mockApi.recognition.match(vec(5), 'face-api/faceRecognitionNet@1', 'CHI-OAK')).matches).toHaveLength(0)
  })
})
