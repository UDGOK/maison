/**
 * v1.0 "Procurement" — the buying maths, pure and unit-tested (no Vue, no I/O, no clock unless
 * you pass one in).
 *
 * Everything the Buying, Orders and Inbound screens need to compute before they call the server:
 * case-pack / MOQ rounding that matches `maison_pos/purchasing/__init__.py::round_up_to_case_pack`
 * exactly, order totals with manual freight, the supplier grouping `create_orders` will perform,
 * swapping a suggestion to an alternative vendor, source badges, cover days, ETAs, receive
 * variance, and the moving-average preview ("cost moves $4.20 → $4.36") the Inbound sheet shows
 * before it posts.
 */
import type { PurchaseOrderLine, Suggestion, SuggestionSource, SuggestionVendor } from '@/api/purchasing'
import { siteTimeZone } from '@/utils/time'
import { todayISO } from '@/utils/device'

/** Design-system tone token (`styles/tokens.css`): `--crit`, `--warn`, `--good`, `--accent`, `--muted`. */
export type BadgeTone = 'crit' | 'warn' | 'good' | 'accent' | 'muted'

/** Most urgent first — mirrors `purchasing/demand.py::SOURCE_ORDER`. */
export const SOURCE_RANK: readonly string[] = ['Low stock', 'Store demand', 'Trending']

/** One chosen buying line. A superset of what `create_orders` reads, so it can be posted as-is. */
export interface BuyLine {
  item_code: string
  item_name?: string | null
  supplier: string
  supplier_name?: string | null
  qty: number
  /** the unit cost — `create_orders` reads this as `rate` */
  rate: number
  case_pack: number
  moq: number
  lead_time_days: number
  vendor_sku?: string | null
  /** `AWANZ Purchase Suggestion` name, so the server can flip it to `Ordered` */
  suggestion?: string | null
  dropship_store?: string | null
}

/** One draft Purchase Order `create_orders` will produce — it groups by (supplier, dropship_store). */
export interface SupplierGroup {
  supplier: string
  supplier_name?: string | null
  dropship_store: string | null
  lines: BuyLine[]
  units: number
  value: number
}

/** What the Buying screen puts on the "Create orders" button before it calls the server. */
export interface OrderPlan {
  groups: SupplierGroup[]
  /** how many draft orders will be created */
  orders: number
  /** how many distinct vendors those orders go to */
  vendors: number
  units: number
  value: number
}

/** A line on the receive sheet: what is still expected against what was counted. */
export interface ReceiveVarianceLine {
  /** what is still outstanding on the order line; falls back to `qty` */
  pending_qty?: number
  qty?: number
  /** what the warehouse counted on this receipt */
  received_qty: number
  damaged_qty?: number
}

export interface ReceiveVariance {
  /** counted less than expected */
  short: number
  /** counted more than expected */
  over: number
  /** nothing short, nothing over, nothing damaged */
  ok: boolean
}

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
// quantities
// ---------------------------------------------------------------------------------------------
/**
 * Round *qty* **up** to a whole case, then lift it to the vendor's MOQ (itself rounded up to a
 * whole case). A literal mirror of `purchasing/__init__.py::round_up_to_case_pack`: case pack
 * first, MOQ second, and a qty already sitting on a case boundary is left alone.
 */
export function roundToCasePack(qty: number, casePack = 1, moq = 0): number {
  let out = Math.max(0, num(qty))
  const pack = Math.max(1, cint(casePack))
  if (out > 0) out = (Math.floor(out / pack) + (out % pack ? 1 : 0)) * pack
  const min = Math.max(0, cint(moq))
  if (min && out && out < min) out = (Math.floor(min / pack) + (min % pack ? 1 : 0)) * pack
  return out
}

/** Extended amount for one line, at currency precision. */
export function lineTotal(qty: number, rate: number): number {
  return round(num(qty) * num(rate))
}

/** Net total of an order — the sum of its lines, before freight. */
export function orderNet(lines: { qty: number; rate: number }[]): number {
  return round((lines || []).reduce((sum, l) => sum + num(l.qty) * num(l.rate), 0))
}

/** Landed total — net plus the manually entered freight, which lands in valuation. */
export function orderLanded(lines: { qty: number; rate: number }[], freight = 0): number {
  return round(orderNet(lines) + num(freight))
}

/**
 * Freight spread evenly over the units you pass in. 0 when there is no freight or no units.
 *
 * Pass the **order's** lines for the order editor's per-unit figure, and the **receipt's**
 * accepted lines for the receive sheet — the server puts the freight on the Purchase Receipt as
 * an Actual + Valuation charge, so ERPNext distributes it across that receipt's lines, not the
 * whole order. On a whole delivery the two agree; on a partial receipt they must not be confused.
 */
export function freightSharePerUnit(lines: { qty: number }[], freight = 0): number {
  const units = (lines || []).reduce((sum, l) => sum + num(l.qty), 0)
  if (units <= 0 || num(freight) === 0) return 0
  return round(num(freight) / units, 4)
}

/**
 * Freight allocated **per line, in proportion to line amount** — which is what ERPNext does with
 * an Actual + Valuation charge (`buying_controller.update_valuation_rate` distributes by net
 * amount). Returns one figure per input line, in the same order.
 *
 * This is the allocation valuation actually uses, so it is what the receive sheet's
 * moving-average preview must be built on. {@link freightSharePerUnit} spreads evenly per unit
 * instead: fine as a headline "about $0.33 a unit" figure on an order, and identical to this one
 * when every line carries the same rate — but materially wrong as a per-line cost the moment the
 * rates differ. A cheap line and an expensive one do not carry the same freight.
 *
 * Falls back to a per-unit split when every line amount is zero (nothing to weight by).
 */
export function freightAllocation(lines: { qty: number; rate: number }[], freight = 0): number[] {
  const rows = lines || []
  const total = num(freight)
  if (!rows.length || total === 0) return rows.map(() => 0)
  const amounts = rows.map((l) => num(l.qty) * num(l.rate))
  const net = amounts.reduce((sum, a) => sum + a, 0)
  if (net > 0) return amounts.map((a) => round((total * a) / net, 4))
  const units = rows.reduce((sum, l) => sum + num(l.qty), 0)
  if (units <= 0) return rows.map(() => 0)
  return rows.map((l) => round((total * num(l.qty)) / units, 4))
}

/**
 * The freight carried by **one unit of one line**, allocated by amount — the number to hand
 * {@link movingAverageAfter}. 0 when the line takes no units.
 */
export function freightShareForLine(lines: { qty: number; rate: number }[], freight: number, index: number): number {
  const rows = lines || []
  const line = rows[index]
  if (!line || num(line.qty) <= 0) return 0
  const allocated = freightAllocation(rows, freight)[index] || 0
  return round(allocated / num(line.qty), 4)
}

// ---------------------------------------------------------------------------------------------
// grouping — what `create_orders` will produce
// ---------------------------------------------------------------------------------------------
/**
 * Group chosen lines exactly the way `api/purchasing.py::create_orders` does — by
 * (supplier, dropship_store) — so the screen can say "3 orders, 2 vendors" before it calls.
 * Lines with no supplier or a non-positive qty are dropped, as the server drops them.
 */
export function groupBySupplier(lines: BuyLine[]): SupplierGroup[] {
  const groups = new Map<string, SupplierGroup>()
  for (const line of lines || []) {
    const supplier = (line.supplier || '').trim()
    const itemCode = (line.item_code || '').trim()
    const qty = num(line.qty)
    if (!supplier || !itemCode || qty <= 0) continue
    const store = line.dropship_store || null
    const key = `${supplier}::${store || ''}`
    let group = groups.get(key)
    if (!group) {
      group = { supplier, supplier_name: line.supplier_name ?? null, dropship_store: store, lines: [], units: 0, value: 0 }
      groups.set(key, group)
    }
    group.lines.push(line)
    group.units += qty
    group.value = round(group.value + qty * num(line.rate))
  }
  return [...groups.values()].sort((a, b) => a.supplier.localeCompare(b.supplier) || (a.dropship_store || '').localeCompare(b.dropship_store || ''))
}

/** `groupBySupplier` plus the headline numbers the "Create orders" button shows. */
export function orderPlan(lines: BuyLine[]): OrderPlan {
  const groups = groupBySupplier(lines)
  return {
    groups,
    orders: groups.length,
    vendors: new Set(groups.map((g) => g.supplier)).size,
    units: groups.reduce((sum, g) => sum + g.units, 0),
    value: round(groups.reduce((sum, g) => sum + g.value, 0))
  }
}

// ---------------------------------------------------------------------------------------------
// vendors
// ---------------------------------------------------------------------------------------------
/** The buying line a suggestion produces as it stands (its preferred vendor, its suggested qty). */
export function lineFor(suggestion: Suggestion): BuyLine {
  const preferred = (suggestion.vendors || []).find((v) => v.supplier === suggestion.supplier)
  return {
    item_code: suggestion.item_code,
    item_name: suggestion.item_name ?? null,
    supplier: suggestion.supplier || '',
    supplier_name: suggestion.supplier_name ?? null,
    qty: num(suggestion.qty ?? suggestion.suggested_qty),
    rate: num(suggestion.cost),
    case_pack: Math.max(1, cint(suggestion.case_pack)),
    moq: Math.max(0, cint(suggestion.moq)),
    lead_time_days: cint(suggestion.lead_time_days),
    vendor_sku: preferred?.vendor_sku ?? null,
    suggestion: suggestion.name,
    dropship_store: null
  }
}

/**
 * Swap a suggestion to one of its alternative vendors: cost, case pack, MOQ, lead time and SKU
 * come from that vendor, and the quantity is re-rounded to *their* case pack and MOQ.
 * A supplier that is not on the suggestion's vendor list leaves the line unchanged.
 */
export function pickVendor(suggestion: Suggestion, supplier: string): BuyLine {
  const line = lineFor(suggestion)
  const alt: SuggestionVendor | undefined = (suggestion.vendors || []).find((v) => v.supplier === supplier)
  if (!alt) return line
  const casePack = Math.max(1, cint(alt.case_pack))
  const moq = Math.max(0, cint(alt.moq))
  // re-round the underlying demand where the server gave it to us, otherwise the current quantity
  const base = suggestion.need != null ? Math.max(0, num(suggestion.need) - num(suggestion.on_order)) : num(suggestion.qty ?? suggestion.suggested_qty)
  return {
    ...line,
    supplier: alt.supplier,
    supplier_name: alt.supplier_name ?? null,
    rate: num(alt.cost),
    case_pack: casePack,
    moq,
    lead_time_days: cint(alt.lead_time_days),
    vendor_sku: alt.vendor_sku ?? null,
    qty: roundToCasePack(base, casePack, moq)
  }
}

// ---------------------------------------------------------------------------------------------
// badges
// ---------------------------------------------------------------------------------------------
const TONES: Record<string, BadgeTone> = {
  'Low stock': 'crit',
  'Store demand': 'warn',
  Trending: 'accent'
}

/**
 * The source badge for a suggestion row. Pass one source or the whole `sources` array; the most
 * urgent source wins the label and the tone (Low stock → Store demand → Trending), and a row that
 * came from more than one source carries a `+N`.
 */
export function sourceBadge(source: SuggestionSource | string | (SuggestionSource | string)[]): { label: string; tone: BadgeTone; title: string } {
  const all = (Array.isArray(source) ? source : [source]).map((s) => (s || '').trim()).filter(Boolean)
  if (!all.length) return { label: '—', tone: 'muted', title: '' }
  const ranked = [...new Set(all)].sort((a, b) => rankOf(a) - rankOf(b))
  const primary = ranked[0]
  const extra = ranked.length - 1
  return {
    label: extra > 0 ? `${primary} +${extra}` : primary,
    tone: TONES[primary] || 'muted',
    title: ranked.join(' · ')
  }
}

function rankOf(source: string): number {
  const i = SOURCE_RANK.indexOf(source)
  return i === -1 ? 99 : i
}

// ---------------------------------------------------------------------------------------------
// cover and dates
// ---------------------------------------------------------------------------------------------
/**
 * How many days the stock on hand covers at the current velocity, to one decimal.
 * `null` when the item does not move — same as `api/purchasing.py::stock`.
 */
export function coverDays(onHand: number, velocity: number): number | null {
  const v = num(velocity)
  if (v <= 0) return null
  return round(num(onHand) / v, 1)
}

/**
 * When an order is expected: the promised `schedule_date` if the order has one, otherwise today
 * plus the lead time (never less than a day; 7 days when the vendor has no lead time), mirroring
 * `purchasing/orders.py::schedule_date_for`. Returns `YYYY-MM-DD`.
 */
export function etaFrom(scheduleDate?: string | null, leadTimeDays = 0, today: Date | string = todayISO()): string {
  if (scheduleDate) return String(scheduleDate).slice(0, 10)
  const base = typeof today === 'string' ? today.slice(0, 10) : toIsoDate(today)
  const days = Math.max(1, cint(leadTimeDays) || 7)
  const d = new Date(`${base}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The calendar day of an instant **in the site zone** — never the browser's (the v0.8 bug). */
function toIsoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: siteTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

// ---------------------------------------------------------------------------------------------
// receiving
// ---------------------------------------------------------------------------------------------
/**
 * Short / over / ok for one line of the receive sheet, measured against what is still outstanding
 * (`pending_qty`, falling back to `qty`). A line with damaged units is never `ok` — it raises a
 * Damaged discrepancy just as a short or an over does.
 */
export function receiveVariance(line: ReceiveVarianceLine): ReceiveVariance {
  const expected = num(line.pending_qty ?? line.qty)
  const received = num(line.received_qty)
  const damaged = num(line.damaged_qty)
  const short = round(Math.max(0, expected - received), 4)
  const over = round(Math.max(0, received - expected), 4)
  return { short, over, ok: short === 0 && over === 0 && damaged === 0 }
}

/** The outstanding quantity on an order line — what the receive sheet pre-fills. */
export function pendingOf(line: Pick<PurchaseOrderLine, 'qty' | 'received_qty'>): number {
  return Math.max(0, num(line.qty) - num(line.received_qty))
}

/**
 * The moving-average valuation rate after a receipt — the plain formula ERPNext uses, so the
 * Inbound sheet can preview "cost moves $4.20 → $4.36" before it posts.
 *
 * `(onHand × currentRate + receivedQty × (receivedRate + freightShare)) ÷ (onHand + receivedQty)`,
 * where *freightShare* is the freight allocated to one unit ({@link freightSharePerUnit}).
 * With nothing left on hand afterwards the landed unit cost of the receipt stands.
 */
export function movingAverageAfter(onHand: number, currentValuationRate: number, receivedQty: number, receivedRate: number, freightShare = 0): number {
  const qtyBefore = num(onHand)
  const qtyIn = num(receivedQty)
  const landed = num(receivedRate) + num(freightShare)
  const qtyAfter = qtyBefore + qtyIn
  if (qtyAfter <= 0) return round(landed, 4)
  const value = qtyBefore * num(currentValuationRate) + qtyIn * landed
  return round(value / qtyAfter, 4)
}
