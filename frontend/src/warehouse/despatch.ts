/**
 * v1.2 §G — **build a despatch**: a basket of items for **one** store. Pure and unit-tested (no
 * Vue, no I/O, no clock). The sibling of `warehouse/distribution.ts`, which is the other
 * direction: one item spread across the chain.
 *
 * v1.1 shipped *one item → many stores*, which is right for introducing a new product and wrong
 * for the everyday job. What the warehouse actually does is fill one store's order — three SKUs to
 * Bixby, four to Sapulpa — and this is the maths behind that basket.
 *
 * The rules the sheet has to keep, and why each one is here rather than in a component:
 *
 *  · **One destination per basket.** The store is chosen on the basket, not per line: a per-line
 *    destination invites the mistake of sending half a basket to the wrong shop. {@link sendLines}
 *    stamps the one destination onto every line, so there is no second place it could differ.
 *  · **A scan of something already in the basket increments it.** {@link scanInto} never adds a
 *    second line for the same item — a picker scanning six of the same box must end up with one
 *    line of six, not six lines of one.
 *  · **Never more than Houston has available.** `available` is `on_hand − committed`, and
 *    {@link availabilityProblems} names the shortfall per item *before* the send, in the same
 *    words `distribution.send` refuses with. Nothing is written on failure.
 *  · **The footer is internal.** Client decision 3: this screen shows cost and margin, so
 *    {@link basketTotals} computes both — and its margin is **AWANZ's**, not the store's.
 */
import type { PlanItem, PlanStoreRow } from '@/api/distribution'
import type { Tone } from './pricing'

/** One line of the basket. Everything a row renders, and everything the send needs. */
export interface BasketLine {
  item_code: string
  item_name?: string | null
  barcode?: string | null
  uom?: string | null
  /** units to send */
  qty: number
  /** HOU-WH's bin */
  on_hand: number
  /** already promised to open shipments that have not left yet */
  committed: number
  /** `on_hand − committed` — what this despatch may actually draw on */
  available: number
  /** what the store will be charged per unit (`pricing.wholesale`) — 0 until it has loaded */
  wholesale: number
  /** what Houston paid per unit — **internal** */
  cost: number
  /** has the chosen store ever rung this item up? `null` while the plan is still loading */
  ever_sold: boolean | null
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function whole(value: unknown): number {
  return Math.trunc(num(value))
}

function round(value: number, places = 2): number {
  const f = 10 ** places
  return Math.round((value + Number.EPSILON) * f) / f
}

/** Whole numbers print whole — "short 12" reads better than "short 12.0" (`distribution._n`). */
function plain(value: number): string {
  const n = num(value)
  return Math.abs(n - Math.trunc(n)) < 1e-9 ? String(Math.trunc(n)) : String(round(n, 3))
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${plain(n)} ${Math.abs(n) === 1 ? one : many}`
}

// ---------------------------------------------------------------------------------------------
// the basket
// ---------------------------------------------------------------------------------------------
/** The index of the item in the basket, or `-1`. Item code only — a basket holds one line per item. */
export function indexOf(lines: BasketLine[], itemCode: string): number {
  const code = (itemCode || '').trim()
  return code ? (lines || []).findIndex((l) => l.item_code === code) : -1
}

/**
 * Barcode first, then item code, then a barcode suffix — the same ladder `inbound.ts::matchesCode`
 * and the count sheet climb, so a scanner behaves identically on every screen in the building.
 */
export function matchesCode(line: Pick<BasketLine, 'item_code' | 'barcode'>, code: string): boolean {
  const c = (code || '').trim().toLowerCase()
  if (!c) return false
  const bar = (line.barcode || '').toLowerCase()
  if (bar && bar === c) return true
  if (line.item_code.toLowerCase() === c) return true
  return c.length >= 6 && !!bar && bar.endsWith(c)
}

/** A fresh line for an item, at *qty*. `available` is what a push may draw on, never `on_hand`. */
export function lineFor(
  item: Pick<BasketLine, 'item_code'> & Partial<BasketLine>,
  qty = 1
): BasketLine {
  const onHand = num(item.on_hand)
  const committed = num(item.committed)
  return {
    item_code: item.item_code,
    item_name: item.item_name ?? null,
    barcode: item.barcode ?? null,
    uom: item.uom ?? null,
    qty: Math.max(0, whole(qty)),
    on_hand: onHand,
    committed,
    available: item.available === undefined ? Math.max(0, onHand - committed) : num(item.available),
    wholesale: num(item.wholesale),
    cost: num(item.cost),
    ever_sold: item.ever_sold ?? null
  }
}

export type ScanOutcome = 'added' | 'incremented' | 'unknown'

export interface ScanResult {
  lines: BasketLine[]
  outcome: ScanOutcome
  /** the line the scan landed on, or `null` when nothing matched */
  line: BasketLine | null
}

/**
 * Put a scan into the basket.
 *
 * A code already in the basket **increments** the line it matches rather than adding a second one
 * (§G) — six scans of the same box is one line of six. A code that is not in the basket but is a
 * known item is added at *qty*; anything else comes back `unknown` and the basket is untouched.
 */
export function scanInto(lines: BasketLine[], code: string, known?: Partial<BasketLine> | null, qty = 1): ScanResult {
  const rows = lines || []
  const step = Math.max(1, whole(qty) || 1)
  const hit = rows.findIndex((l) => matchesCode(l, code))
  if (hit >= 0) {
    const next = rows.map((l, i) => (i === hit ? { ...l, qty: l.qty + step } : l))
    return { lines: next, outcome: 'incremented', line: next[hit] }
  }
  if (known?.item_code) {
    const line = lineFor(known as BasketLine, step)
    return { lines: [...rows, line], outcome: 'added', line }
  }
  return { lines: rows, outcome: 'unknown', line: null }
}

/** Set one line's quantity. Whole units only — a shipment line is a count of things. */
export function setQty(lines: BasketLine[], itemCode: string, qty: unknown): BasketLine[] {
  return (lines || []).map((l) => (l.item_code === itemCode ? { ...l, qty: Math.max(0, whole(qty)) } : l))
}

/** Move one line by *by* units, never below zero. */
export function bump(lines: BasketLine[], itemCode: string, by: number): BasketLine[] {
  return (lines || []).map((l) => (l.item_code === itemCode ? { ...l, qty: Math.max(0, l.qty + whole(by)) } : l))
}

export function removeLine(lines: BasketLine[], itemCode: string): BasketLine[] {
  return (lines || []).filter((l) => l.item_code !== itemCode)
}

/**
 * Merge Houston's position and the destination store's history onto the basket, keeping the
 * quantities the manager has typed. Called whenever the plan is re-read — after an add, and after
 * the destination changes, because *never sold here* is a fact about the chosen shop.
 */
export function applyPlan(lines: BasketLine[], plan: PlanItem[], boutique?: string | null, prices: Record<string, { wholesale?: number; cost?: number }> = {}): BasketLine[] {
  const byCode = new Map((plan || []).map((p) => [p.item_code, p]))
  return (lines || []).map((line) => {
    const item = byCode.get(line.item_code)
    const price = prices[line.item_code]
    const store: PlanStoreRow | undefined = boutique ? item?.stores?.find((s) => s.boutique === boutique) : undefined
    return {
      ...line,
      item_name: item?.item_name ?? line.item_name,
      barcode: item?.barcode ?? line.barcode,
      uom: item?.uom ?? line.uom,
      on_hand: item ? num(item.on_hand) : line.on_hand,
      committed: item ? num(item.committed) : line.committed,
      available: item ? num(item.available) : line.available,
      wholesale: price?.wholesale === undefined ? line.wholesale : num(price.wholesale),
      cost: price?.cost === undefined ? line.cost : num(price.cost),
      ever_sold: boutique ? (store ? !!store.ever_sold : false) : null
    }
  })
}

// ---------------------------------------------------------------------------------------------
// the running footer — internal, per client decision 3
// ---------------------------------------------------------------------------------------------
export interface BasketTotals {
  /** lines carrying a quantity (a line typed down to 0 is not a line yet) */
  lines: number
  units: number
  /** what the store will be charged */
  wholesale_value: number
  /** **internal** — what those units cost Houston */
  cost_value: number
  /** AWANZ's margin on the despatch */
  margin: number
  /** **null** when nothing is priced — never 0, for the same reason the price board never says 0 % */
  margin_pct: number | null
  /** true when any line carries no wholesale figure at all */
  unpriced: boolean
}

export function basketTotals(lines: BasketLine[]): BasketTotals {
  const rows = (lines || []).filter((l) => l.qty > 0)
  let units = 0
  let wholesale = 0
  let cost = 0
  let unpriced = false
  for (const l of rows) {
    units += l.qty
    wholesale += l.qty * num(l.wholesale)
    cost += l.qty * num(l.cost)
    if (!num(l.wholesale)) unpriced = true
  }
  const wholesaleValue = round(wholesale)
  const costValue = round(cost)
  const margin = round(wholesaleValue - costValue)
  return {
    lines: rows.length,
    units,
    wholesale_value: wholesaleValue,
    cost_value: costValue,
    margin,
    margin_pct: wholesaleValue ? round((100 * margin) / wholesaleValue, 1) : null,
    unpriced
  }
}

// ---------------------------------------------------------------------------------------------
// the refusal — said here, before the send, in the server's own words
// ---------------------------------------------------------------------------------------------
export interface AvailabilityProblem {
  item_code: string
  wanted: number
  available: number
  short: number
}

/**
 * What Houston cannot cover, per item. `available` is `on_hand − committed`: units already
 * promised to a shipment that has not left the building are not available to promise again.
 */
export function availabilityProblems(lines: BasketLine[]): AvailabilityProblem[] {
  const out: AvailabilityProblem[] = []
  for (const line of (lines || []).filter((l) => l.qty > 0)) {
    const available = num(line.available)
    if (line.qty > available + 1e-9) {
      out.push({ item_code: line.item_code, wanted: line.qty, available, short: round(line.qty - available, 3) })
    }
  }
  return out.sort((a, b) => a.item_code.localeCompare(b.item_code))
}

/**
 * The refusal `distribution.send` would give, said in the sheet's own words before the send is
 * attempted. Multi-line with one bullet per item, exactly as the server writes it — the sheet
 * renders it verbatim (`white-space: pre-line`), because flattening it loses the shortfalls.
 */
export function refusalMessage(problems: AvailabilityProblem[]): string {
  if (!problems.length) return ''
  return [
    'Houston does not hold enough stock to send this despatch:',
    ...problems.map((p) => `• ${p.item_code} — ${plain(p.wanted)} requested, ${plain(p.available)} available, short ${plain(p.short)}`),
    'Nothing was sent — lower the quantities or buy more first.'
  ].join('\n')
}

/** The tone of one line's quantity box: red past what Houston has, amber on the last unit. */
export function lineTone(line: BasketLine): Tone {
  const left = num(line.available) - line.qty
  if (left < 0) return 'crit'
  if (line.qty > 0 && left === 0) return 'warn'
  return 'muted'
}

/** "42 available · 6 committed" — the position under a basket row. */
export function positionCopy(line: BasketLine): string {
  const parts = [`${plain(num(line.available))} available at Houston`]
  if (num(line.committed) > 0) parts.push(`${plain(num(line.committed))} already committed`)
  const left = num(line.available) - line.qty
  if (line.qty > 0) parts.push(left < 0 ? `${plain(-left)} short` : `${plain(left)} left after`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------------------------
/** True while the Send button must stay down. */
export function sendBlocked(boutique: string | null | undefined, lines: BasketLine[], problems: AvailabilityProblem[]): boolean {
  if (!(boutique || '').trim()) return true
  if (!(lines || []).some((l) => l.qty > 0)) return true
  return problems.length > 0
}

/** The copy on the Send button — it names what it is about to do. */
export function sendCopy(boutique: string | null | undefined, totals: BasketTotals, problems: AvailabilityProblem[]): string {
  if (problems.length) return 'More than Houston has'
  if (!(boutique || '').trim()) return 'Choose a store'
  if (!totals.units) return 'Nothing in the basket'
  return `Send ${plural(totals.units, 'unit')} to ${boutique}`
}

/**
 * The lines `distribution.send` takes: **one destination for the whole basket**, in item-code
 * order, with the zeros dropped.
 */
export function sendLines(boutique: string, lines: BasketLine[]): { boutique: string; item_code: string; qty: number }[] {
  const store = (boutique || '').trim()
  if (!store) return []
  return (lines || [])
    .filter((l) => l.qty > 0)
    .slice()
    .sort((a, b) => a.item_code.localeCompare(b.item_code))
    .map((l) => ({ boutique: store, item_code: l.item_code, qty: l.qty }))
}

/** "4 lines · 96 units on their way to OK-BIX — MSH-00007" — the line after a successful send. */
export function sentCopy(out: { shipments: { name: string; boutique: string }[]; units: number; items: number }): string {
  const names = out.shipments.map((s) => s.name).join(', ')
  const where = out.shipments[0]?.boutique || 'the store'
  return `${plural(out.items, 'line')} · ${plural(out.units, 'unit')} on their way to ${where} — ${names}`
}

/**
 * The quiet flag on a line for something the destination has never sold. It is usually deliberate
 * — that is how a product is introduced to a shop — so it is a note, not a warning, and never a
 * block. `null` (the plan has not loaded, or no store is chosen yet) says nothing at all.
 */
export function neverSoldNote(line: BasketLine, boutique?: string | null): string {
  if (!boutique || line.ever_sold === null || line.ever_sold) return ''
  return `${boutique} has never sold this`
}

/** How many lines the destination has never sold — the one-line note above the footer. */
export function neverSoldCount(lines: BasketLine[]): number {
  return (lines || []).filter((l) => l.qty > 0 && l.ever_sold === false).length
}
