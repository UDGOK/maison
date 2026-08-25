/**
 * v1.1 "Onboarding a product" §A — the distribution maths, pure and unit-tested (no Vue, no I/O,
 * no clock).
 *
 * Two jobs, and it is worth being clear which is which:
 *
 *  1. **A literal mirror of `maison_pos/distribution.py`** — {@link splitEven},
 *     {@link splitByVelocity}, {@link splitTopup} and the largest-remainder {@link apportion}
 *     underneath them. The server owns this maths (`suggest_split` is what the sheet calls on a
 *     bench); these exist so the *mock* desk allocates exactly the way the bench does, and so the
 *     rules — remainder to the busiest, a minimum of one each on *velocity*, no store given more
 *     than its gap on *top up* — are pinned by tests rather than read out of Python.
 *     If the server's rules ever change, these change with them.
 *
 *  2. **What the sheet itself has to work out**, which the server has no view of because the
 *     manager is still typing: the running footer ({@link allocationTotals}), the *left at
 *     Houston* figure and **when it turns red** ({@link leftTone}), what is wrong with a row
 *     before anything is sent ({@link validateAllocation}), and the days of cover a store lands on
 *     *after* the push ({@link coverAfter}).
 *
 * The thing that makes eleven quantity boxes a decision rather than a form is the context beside
 * them — what each store already holds and how fast it sells it. That is why every helper here
 * takes the plan row, not just a number.
 */
import { fmtCover } from './inbound'
import type { PlanStoreRow, SplitMode } from '@/api/distribution'

/** Design-system tone token (`styles/tokens.css`): `--crit`, `--warn`, `--good`, `--accent`. */
export type Tone = 'crit' | 'warn' | 'good' | 'accent' | 'muted'

/** The least a plan row needs to carry to be allocated over. */
export interface AllocatableRow {
  boutique: string
  on_hand?: number
  velocity?: number
}

/** `boutique → units`. What every split returns and what the sheet's quantity boxes hold. */
export type Allocation = Record<string, number>

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Frappe's `cint`: truncate towards zero. */
function cint(value: unknown): number {
  return Math.trunc(num(value))
}

function round(value: number, places = 2): number {
  const f = 10 ** places
  return Math.round((value + Number.EPSILON) * f) / f
}

// ---------------------------------------------------------------------------------------------
// the split maths — mirrors maison_pos/distribution.py
// ---------------------------------------------------------------------------------------------
/**
 * Store codes, busiest first: highest velocity, then emptiest, then alphabetical.
 *
 * "Busiest" decides where an odd remainder lands, so it has to be a **total** order — two stores
 * that sell the same amount must not swap places between two calls with the same input.
 */
export function busiestFirst(rows: AllocatableRow[]): string[] {
  return [...(rows || [])]
    .sort((a, b) => num(b.velocity) - num(a.velocity) || num(a.on_hand) - num(b.on_hand) || String(a.boutique).localeCompare(String(b.boutique)))
    .map((r) => r.boutique)
}

/**
 * Share *total* whole units out in proportion to *weights* (largest-remainder method).
 *
 * *order* breaks ties (busiest first); *caps* is an optional per-store ceiling — a store already
 * at its cap is skipped when the remainder is handed out, and when everybody is capped the rest
 * simply stays in Houston.
 */
export function apportion(total: number, weights: Allocation, order: string[], caps?: Allocation | null): Allocation {
  const out: Allocation = {}
  for (const key of Object.keys(weights)) out[key] = 0
  let remaining = Math.max(0, cint(total))
  if (remaining <= 0) return out
  const positive: Allocation = {}
  for (const [key, value] of Object.entries(weights)) positive[key] = Math.max(0, num(value))
  const pool = Object.values(positive).reduce((sum, v) => sum + v, 0)
  if (pool <= 0) return out
  const position = new Map(order.map((key, index) => [key, index]))
  const exact: Allocation = {}
  for (const [key, value] of Object.entries(positive)) {
    exact[key] = (remaining * value) / pool
    const whole = Math.floor(exact[key])
    out[key] = caps ? Math.min(whole, Math.max(0, cint(caps[key]))) : whole
  }
  remaining -= Object.values(out).reduce((sum, v) => sum + v, 0)
  const ranked = Object.keys(positive).sort((a, b) => {
    const fracA = exact[a] - Math.floor(exact[a])
    const fracB = exact[b] - Math.floor(exact[b])
    if (fracB !== fracA) return fracB - fracA
    return (position.get(a) ?? position.size) - (position.get(b) ?? position.size)
  })
  while (remaining > 0) {
    let handedOut = false
    for (const key of ranked) {
      if (remaining <= 0) break
      if (caps && out[key] >= Math.max(0, cint(caps[key]))) continue
      out[key] += 1
      remaining -= 1
      handedOut = true
    }
    if (!handedOut) break // everybody is at their cap — the rest stays in Houston
  }
  return out
}

/** Equal across the chosen stores; the remainder goes to the busiest. */
export function splitEven(qty: number, rows: AllocatableRow[]): Allocation {
  const want = Math.max(0, cint(qty))
  const out: Allocation = {}
  for (const row of rows || []) out[row.boutique] = 0
  if (!rows?.length || want <= 0) return out
  const base = Math.floor(want / rows.length)
  const remainder = want - base * rows.length
  for (const key of Object.keys(out)) out[key] = base
  for (const key of busiestFirst(rows).slice(0, remainder)) out[key] += 1
  return out
}

/**
 * Weighted by 28-day velocity, **minimum one each**.
 *
 * Two honest edge cases the sheet would otherwise have to guess at:
 *
 *  - fewer units than stores — one each is impossible, so the busiest stores get the units that
 *    exist rather than everybody getting a fraction;
 *  - nobody has ever sold it (a brand-new product, every velocity 0) — there is no signal to
 *    weight by, so it falls back to an even split rather than piling the lot on one store.
 */
export function splitByVelocity(qty: number, rows: AllocatableRow[]): Allocation {
  const want = Math.max(0, cint(qty))
  const out: Allocation = {}
  for (const row of rows || []) out[row.boutique] = 0
  if (!rows?.length || want <= 0) return out
  const order = busiestFirst(rows)
  if (want <= rows.length) {
    for (const key of order.slice(0, want)) out[key] = 1
    return out
  }
  const weights: Allocation = {}
  for (const row of rows) weights[row.boutique] = Math.max(0, num(row.velocity))
  if (Object.values(weights).reduce((sum, v) => sum + v, 0) <= 0) return splitEven(want, rows)
  for (const key of Object.keys(out)) out[key] = 1 // the minimum, first
  for (const [key, extra] of Object.entries(apportion(want - rows.length, weights, order))) out[key] += extra
  return out
}

/**
 * Bring every store up to *coverDays* days of cover at its own velocity.
 *
 * A store's gap is `velocity × coverDays − on hand`, rounded up. When the gaps add up to less than
 * *qty* every store gets exactly its gap and the rest stays in Houston (the caller reports it as
 * the remainder); when they add up to more, what there is is shared in proportion to the gaps and
 * no store is given more than it needs.
 *
 * A chain where every store already holds months of cover allocates **nothing**. That is correct
 * and honest — and it is why the sheet must show the remainder rather than leaving the button
 * looking broken.
 */
export function splitTopup(qty: number, rows: AllocatableRow[], coverDays = 21): Allocation {
  const want = Math.max(0, cint(qty))
  const out: Allocation = {}
  for (const row of rows || []) out[row.boutique] = 0
  if (!rows?.length || want <= 0) return out
  const target = Math.max(1, cint(coverDays) || 21)
  const gap: Allocation = {}
  for (const row of rows) {
    const short = num(row.velocity) * target - num(row.on_hand)
    gap[row.boutique] = short > 0 ? Math.ceil(short) : 0
  }
  const totalGap = Object.values(gap).reduce((sum, v) => sum + v, 0)
  if (totalGap <= 0) return out // every store is already covered — allocate nothing rather than guess
  if (totalGap <= want) return { ...gap }
  return apportion(want, { ...gap }, busiestFirst(rows), gap)
}

/** Dispatch by mode name — the sheet's quick actions and the mock desk both come through here. */
export function splitFor(mode: SplitMode | string, qty: number, rows: AllocatableRow[], coverDays = 21): Allocation {
  if (mode === 'velocity') return splitByVelocity(qty, rows)
  if (mode === 'topup') return splitTopup(qty, rows, coverDays)
  return splitEven(qty, rows)
}

/**
 * *Same to all* — every chosen store gets the same number. Not a split: it is `n × stores` units
 * leaving Houston, which is exactly why the footer has to be read before the send.
 */
export function sameToAll(qty: number, rows: AllocatableRow[]): Allocation {
  const each = Math.max(0, cint(qty))
  const out: Allocation = {}
  for (const row of rows || []) out[row.boutique] = each
  return out
}

/** Every store back to zero. */
export function clearAllocation(rows: AllocatableRow[]): Allocation {
  const out: Allocation = {}
  for (const row of rows || []) out[row.boutique] = 0
  return out
}

// ---------------------------------------------------------------------------------------------
// which stores are candidates
// ---------------------------------------------------------------------------------------------
/**
 * Does this store stock the item? On the shelf now, or sold at some point — a store that ran out
 * yesterday still stocks it, and the sheet must not treat it as a store that has never seen it.
 */
export function stocksIt(row: Pick<PlanStoreRow, 'on_hand' | 'ever_sold'>): boolean {
  return num(row.on_hand) > 0 || !!row.ever_sold
}

/**
 * The stores a quick action may hand units to. `stockingOnly` narrows to the stores that already
 * stock it — which for a **brand-new product is nobody**, so the caller must say so rather than
 * silently allocating nothing.
 */
export function candidateStores<T extends Pick<PlanStoreRow, 'on_hand' | 'ever_sold'>>(rows: T[], stockingOnly = false): T[] {
  const all = rows || []
  return stockingOnly ? all.filter(stocksIt) : [...all]
}

// ---------------------------------------------------------------------------------------------
// the running footer
// ---------------------------------------------------------------------------------------------
export interface AllocationTotals {
  /** stores with a quantity above zero */
  stores: number
  /** units leaving Houston */
  units: number
  /** what a push may draw on: HOU-WH on hand less what open shipments already promised */
  available: number
  /** `available − units` — **the** figure on the footer */
  left: number
  /** how many units short the push is; 0 when it fits */
  short: number
  /** true when `send` will refuse this (client decision 4 — never allocate what Houston lacks) */
  over: boolean
  tone: Tone
}

/**
 * How red is the footer? `crit` the moment the push would go past what Houston has — **before**
 * the send, because `suggest_split` is a calculator and will happily over-allocate. `warn` when it
 * takes the last unit (legal, but the warehouse is now empty of it); otherwise `accent`.
 */
export function leftTone(left: number): Tone {
  const n = num(left)
  if (n < 0) return 'crit'
  if (n === 0) return 'warn'
  return 'accent'
}

/** The footer: stores chosen, units, and what is left at Houston after. */
export function allocationTotals(allocation: Allocation, available: number): AllocationTotals {
  const values = Object.values(allocation || {}).map(num)
  const units = values.reduce((sum, v) => sum + v, 0)
  const have = num(available)
  const left = round(have - units, 3)
  return {
    stores: values.filter((v) => v > 0).length,
    units,
    available: have,
    left,
    short: left < 0 ? round(-left, 3) : 0,
    over: left < 0,
    tone: leftTone(left)
  }
}

/**
 * The refusal the server would give, said in the sheet's own words before the send is attempted.
 * Empty when the push fits. Mirrors `distribution._validate`'s shortfall line for one item.
 */
export function shortfallMessage(itemCode: string, totals: Pick<AllocationTotals, 'units' | 'available' | 'short' | 'over'>): string {
  if (!totals.over) return ''
  return `${itemCode} — ${plain(totals.units)} allocated, ${plain(totals.available)} available at Houston, short ${plain(totals.short)}. Lower the quantities or buy more first.`
}

/** Whole numbers print whole — "short 12" reads better than "short 12.0" (`distribution._n`). */
function plain(value: number): string {
  const n = num(value)
  return Math.abs(n - Math.trunc(n)) < 1e-9 ? String(Math.trunc(n)) : String(round(n, 3))
}

// ---------------------------------------------------------------------------------------------
// per-store validation
// ---------------------------------------------------------------------------------------------
export interface AllocationProblem {
  boutique: string
  message: string
}

/**
 * What is wrong with the quantity boxes, before anything is sent. Whole units only (a shipment
 * line is a count of things), never negative, and never addressed to a store that is not on the
 * plan. The server refuses all three too — this is so the manager is told at the box, not after a
 * round trip that writes nothing.
 */
export function validateAllocation(allocation: Allocation, rows: AllocatableRow[]): AllocationProblem[] {
  const known = new Set((rows || []).map((r) => r.boutique))
  const problems: AllocationProblem[] = []
  for (const [boutique, raw] of Object.entries(allocation || {})) {
    const qty = Number(raw)
    if (!known.has(boutique)) {
      if (qty > 0) problems.push({ boutique, message: `${boutique} is not a store this push can address` })
      continue
    }
    if (!Number.isFinite(qty)) {
      problems.push({ boutique, message: `${boutique} — that is not a number` })
      continue
    }
    if (qty < 0) problems.push({ boutique, message: `${boutique} — a quantity cannot be negative` })
    else if (qty !== Math.trunc(qty)) problems.push({ boutique, message: `${boutique} — whole units only` })
  }
  return problems
}

/** True when the Send button must stay down: nothing chosen, a bad box, or more than Houston has. */
export function sendBlocked(totals: AllocationTotals, problems: AllocationProblem[]): boolean {
  return totals.units <= 0 || totals.over || problems.length > 0
}

/** The lines `send` takes, in store-code order, with the zeros dropped. */
export function sendLines(itemCode: string, allocation: Allocation): { boutique: string; item_code: string; qty: number }[] {
  return Object.entries(allocation || {})
    .filter(([, qty]) => num(qty) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([boutique, qty]) => ({ boutique, item_code: itemCode, qty: num(qty) }))
}

// ---------------------------------------------------------------------------------------------
// cover
// ---------------------------------------------------------------------------------------------
/**
 * Days of cover: on hand ÷ velocity, to one decimal. **`null` when the store does not move it** —
 * the same contract `distribution.store_context` and `purchasing.stock` use. Never `Infinity`,
 * never `NaN`; the screens print an em dash.
 */
export function coverDaysFor(onHand: number, velocity: number): number | null {
  const v = num(velocity)
  if (v <= 0) return null
  return round(num(onHand) / v, 1)
}

/** Where a store's cover lands **after** this push — the number that makes the box a decision. */
export function coverAfter(row: Pick<PlanStoreRow, 'on_hand' | 'velocity'>, added: number): number | null {
  return coverDaysFor(num(row.on_hand) + num(added), num(row.velocity))
}

/**
 * `"0.85/d"`, or `—` where nothing moves. Two decimals on purpose: the server reports velocity to
 * three, and `0.853/d` in a column a manager scans down is three digits of noise for a figure that
 * really means "about six a week".
 */
export function velocityText(velocity: number | null | undefined): string {
  const v = num(velocity)
  if (v <= 0) return '—'
  return `${v >= 10 ? Math.round(v) : Math.round(v * 100) / 100}/d`
}

/** `"12.4 d"`, or `—` for a store that does not move it. Same rendering as the Stock board. */
export function coverText(days: number | null | undefined): string {
  return fmtCover(days)
}

/**
 * The tone for a store's cover: thin stores are the reason for the push, so they lead the eye.
 * Under a week is critical, under a fortnight is a warning, a store that does not move it is
 * merely muted — it is not urgent, it is *unknown*.
 */
export function coverTone(days: number | null | undefined): Tone {
  if (days == null) return 'muted'
  const n = num(days)
  if (n < 7) return 'crit'
  if (n < 14) return 'warn'
  return 'good'
}

/**
 * One line of plain English under a store's quantity box: what it holds, how fast it sells it, and
 * — once a quantity is typed — where that lands it. This is the sentence that turns a form into a
 * decision, so it says "never sold here" out loud rather than showing a silent zero.
 */
export function storyFor(row: PlanStoreRow, qty = 0): string {
  const added = Math.max(0, num(qty))
  if (!row.ever_sold && num(row.on_hand) <= 0) {
    return added > 0 ? `Never sold here — ${plain(added)} would be the first` : 'Never sold here'
  }
  const holds = `${plain(num(row.on_hand))} on hand`
  if (num(row.velocity) <= 0) return added > 0 ? `${holds}, no sales in 28 days → ${plain(num(row.on_hand) + added)}` : `${holds}, no sales in 28 days`
  const now = coverText(coverDaysFor(row.on_hand, row.velocity))
  if (added <= 0) return `${holds} · ${now} of cover`
  return `${holds} · ${now} → ${coverText(coverAfter(row, added))}`
}
