/**
 * Pure promotion / coupon / tier math (v0.4 I). Shared by the promos store, the mock server
 * and the unit tests. Money is rounded to cents exactly like `computeTotals`.
 */
import type { Promotion, TierProgress, TierRow } from '@/api/v04'
import { round } from './money'

export interface PromoLine {
  id: string
  item_code: string
  item_group: string
  qty: number
  rate: number
  /** manual line discount already applied by the associate (whole line) */
  discount_amount: number
}

export interface AppliedPromotion {
  name: string
  title: string
  /** total discount this promo gave across the basket */
  discount: number
  lines: string[]
}

export interface PromoResult {
  /** extra discount per line id (whole line, cents) */
  perLine: Record<string, number>
  applied: AppliedPromotion[]
  total: number
}

function lineNet(l: PromoLine): number {
  return round(l.qty * l.rate - (l.discount_amount || 0))
}

function targets(p: Promotion, l: PromoLine): boolean {
  if (p.apply_on === 'Transaction') return true
  if (p.apply_on === 'Item Code') return p.targets.includes(l.item_code)
  if (p.apply_on === 'Item Group') return p.targets.includes(l.item_group)
  return false // Brand: not modelled in the POS catalog
}

export function promoIsLive(p: Promotion, today = new Date()): boolean {
  const d = today.toISOString().slice(0, 10)
  if (p.valid_from && p.valid_from > d) return false
  if (p.valid_upto && p.valid_upto < d) return false
  return p.kind === 'percent' || p.kind === 'amount'
}

/** Promotions the client qualifies for (tier-scoped promos need the matching tier). */
export function eligiblePromotions(promos: Promotion[], tier: string | null | undefined, today = new Date()): Promotion[] {
  return promos.filter((p) => promoIsLive(p, today) && (!p.tier || p.tier === tier)).sort((a, b) => b.priority - a.priority)
}

/**
 * Apply promotions to the basket. Each line gets at most one promo (highest priority that
 * matches and whose qty / amount window the line satisfies). `amount` promos are applied
 * once per matching line, capped at the line net. Returns the per-line extra discount.
 */
export function applyPromotions(lines: PromoLine[], promos: Promotion[], tier: string | null | undefined, today = new Date()): PromoResult {
  const live = eligiblePromotions(promos, tier, today)
  const perLine: Record<string, number> = {}
  const applied = new Map<string, AppliedPromotion>()
  for (const l of lines) {
    const net = lineNet(l)
    if (net <= 0) continue
    for (const p of live) {
      if (!targets(p, l)) continue
      if (p.min_qty && l.qty < p.min_qty) continue
      if (p.max_qty && l.qty > p.max_qty) continue
      if (p.min_amt && net < p.min_amt) continue
      if (p.max_amt && net > p.max_amt) continue
      const disc = p.kind === 'percent' ? round((net * p.discount_percentage) / 100) : Math.min(round(p.discount_amount), net)
      if (disc <= 0) continue
      perLine[l.id] = disc
      const a = applied.get(p.name) || { name: p.name, title: p.title, discount: 0, lines: [] }
      a.discount = round(a.discount + disc)
      a.lines.push(l.id)
      applied.set(p.name, a)
      break
    }
  }
  const list = [...applied.values()]
  return { perLine, applied: list, total: round(list.reduce((s, a) => s + a.discount, 0)) }
}

/** Split `total` proportionally over `nets` (cents; remainder on the last line) — mirrors the backend. */
export function distributeDiscount(total: number, nets: number[]): number[] {
  const base = nets.reduce((a, b) => a + b, 0)
  if (base <= 0 || total <= 0) return nets.map(() => 0)
  const out: number[] = []
  let acc = 0
  nets.forEach((n, i) => {
    if (i === nets.length - 1) out.push(round(total - acc))
    else {
      const share = round((total * n) / base)
      out.push(share)
      acc = round(acc + share)
    }
  })
  return out
}

export interface CouponSpec {
  code: string
  discount_type: 'Percent' | 'Amount'
  value: number
  item_group?: string | null
}

/**
 * Coupon discount for the basket (after manual + promo discounts). Returns the total and the
 * per-line split; the backend recomputes this and rejects a mismatch, so keep in sync with
 * `maison_pos.api.promotions.compute_coupon_discount`.
 */
export function couponDiscount(coupon: CouponSpec, lines: PromoLine[], extraPerLine: Record<string, number> = {}): { total: number; perLine: Record<string, number> } {
  const eligible = lines.filter((l) => !coupon.item_group || l.item_group === coupon.item_group)
  const nets = eligible.map((l) => round(lineNet(l) - (extraPerLine[l.id] || 0)))
  const base = round(nets.reduce((a, b) => a + b, 0))
  if (base <= 0) return { total: 0, perLine: {} }
  const total = coupon.discount_type === 'Percent' ? round((base * coupon.value) / 100) : Math.min(round(coupon.value), base)
  const split = distributeDiscount(total, nets)
  const perLine: Record<string, number> = {}
  eligible.forEach((l, i) => {
    if (split[i]) perLine[l.id] = split[i]
  })
  return { total, perLine }
}

/** Human label for a promo chip / line. */
export function promoLabel(p: Promotion): string {
  if (p.kind === 'percent') return `−${p.discount_percentage}%`
  if (p.kind === 'amount') return `−${p.discount_amount}`
  if (p.kind === 'rate') return `fixed ${p.rate}`
  return 'gift'
}

export function normalizeCouponCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase()
}

// ---------------------------------------------------------------------------------------------
// loyalty tiers
// ---------------------------------------------------------------------------------------------
export interface TierStatus {
  tier: string | null
  next: string | null
  /** 0..1 progress from the current tier floor to the next one */
  progress: number
  toNext: number
}

/** Pure tier ladder math (offline fallback when the server `TierProgress` is not cached). */
export function tierStatus(spent: number, tiers: TierRow[]): TierStatus {
  const sorted = [...tiers].sort((a, b) => a.min_spent - b.min_spent)
  let current: TierRow | null = null
  for (const t of sorted) if (spent >= t.min_spent) current = t
  const next = sorted.find((t) => !current || t.min_spent > current.min_spent) || null
  const base = current?.min_spent || 0
  const progress = next ? Math.max(0, Math.min(1, (spent - base) / (next.min_spent - base))) : 1
  return { tier: current?.tier || null, next: next?.tier || null, progress, toNext: next ? round(next.min_spent - spent) : 0 }
}

/** Progress bar percent (0–100, integer) from a server `TierProgress`. */
export function progressPercent(tp: Pick<TierProgress, 'progress' | 'next_tier'> | null | undefined): number {
  if (!tp) return 0
  if (!tp.next_tier) return 100
  return Math.round(Math.max(0, Math.min(1, tp.progress)) * 100)
}
