/**
 * v1.0 "Procurement" — the Inbound / Stock / section-nav logic, pure and unit-tested (no Vue, no
 * I/O, no clock unless you pass one in). The sibling of `warehouse/buying.ts`: everything the
 * Inbound board, the receive sheet and the Stock board need to work out before they render or post.
 *
 *  §F nav ........... `resolveTab` `tabKeyFor` — every legacy `/warehouse/:tab` key still resolves
 *  §E receiving ..... `postedQty` `acceptedQty` `varianceTone` `maPreview` `receiptFreightShare`
 *                     `receiveOutcome` `matchScan`
 *  §F stock ......... `fmtCover` `stockTotals` `stockGroups` `filterStock`
 *
 * Kept out of the components on purpose: a receive sheet that quietly gets the moving-average
 * preview wrong is worse than one that does not show it at all, so the maths is testable on its own.
 */
import type { PurchaseOrderLine, PurchaseOrderWithItems, ReceiveResult, StockRow } from '@/api/purchasing'
import { etaFrom, freightShareForLine, freightSharePerUnit, movingAverageAfter, receiveVariance, type BadgeTone, type ReceiveVarianceLine } from './buying'

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function round(value: number, places = 2): number {
  const f = 10 ** places
  return Math.round((value + Number.EPSILON) * f) / f
}

// ---------------------------------------------------------------------------------------------
// §F — the /warehouse section nav
// ---------------------------------------------------------------------------------------------
/** The five sections of the warehouse desk. */
export type Section = 'outbound' | 'inbound' | 'buying' | 'vendors' | 'stock'
/** The three boards that used to be top-level tabs and now live inside Outbound. */
export type OutboundTab = 'requests' | 'shipments' | 'discrepancies'

export const SECTIONS: { key: Section; label: string }[] = [
  { key: 'outbound', label: 'Outbound' },
  { key: 'inbound', label: 'Inbound' },
  { key: 'buying', label: 'Buying' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'stock', label: 'Stock' }
]

export const OUTBOUND_TABS: { key: OutboundTab; label: string }[] = [
  { key: 'requests', label: 'Requests' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'discrepancies', label: 'Discrepancies' }
]

export interface SectionRoute {
  section: Section
  /** which board Outbound shows; meaningless for the other sections, but always populated */
  outbound: OutboundTab
  /** the key the URL should be rewritten to, or `null` to leave the address bar alone */
  redirect: string | null
}

const LEGACY_OUTBOUND: Record<string, OutboundTab> = {
  requests: 'requests',
  shipments: 'shipments',
  discrepancies: 'discrepancies'
}

/**
 * Resolve a `/warehouse/:tab?` key to a section.
 *
 * Every key the flat v0.6 desk answered to still works, because there are bookmarks and e2e specs
 * pointing at them:
 *
 *   `requests` / `shipments` / `discrepancies` → Outbound with that board selected (URL untouched)
 *   `stock`                                    → Stock
 *   `vendor`                                   → Inbound (the vendor-PO tab's receiving half), and
 *                                                the URL is rewritten, since that key is retired
 *   the five new section keys                  → themselves
 *   anything else / nothing                    → Outbound · Requests
 */
export function resolveTab(tab?: string | null): SectionRoute {
  const key = String(tab ?? '')
    .trim()
    .toLowerCase()
  if (!key) return { section: 'outbound', outbound: 'requests', redirect: null }
  const legacy = LEGACY_OUTBOUND[key]
  if (legacy) return { section: 'outbound', outbound: legacy, redirect: null }
  // the v0.6 "Vendor POs" tab is retired: receiving is Inbound, ordering is Buying
  if (key === 'vendor') return { section: 'inbound', outbound: 'requests', redirect: 'inbound' }
  if (SECTIONS.some((s) => s.key === key)) return { section: key as Section, outbound: 'requests', redirect: null }
  return { section: 'outbound', outbound: 'requests', redirect: 'outbound' }
}

/**
 * The URL key for a section. Outbound writes its *sub-tab* key, so `/warehouse/shipments` keeps
 * meaning what it meant in v0.6 and a deep link to one Outbound board still works.
 */
export function tabKeyFor(section: Section, outbound: OutboundTab = 'requests'): string {
  return section === 'outbound' ? outbound : section
}

// ---------------------------------------------------------------------------------------------
// §E — receiving: what one counted line will actually book
// ---------------------------------------------------------------------------------------------
/** One line of the receive sheet as the manager has counted it. */
export interface CountedLine extends ReceiveVarianceLine {
  /** what is still outstanding on the order line */
  pending_qty: number
  /** what was counted */
  received_qty: number
  damaged_qty?: number
  /** the rate on the order */
  po_rate: number
  /** the manual override (decision 4); `null` / omitted means the PO rate stands */
  rate?: number | null
}

/** The unit cost this line will post at — the override when there is one, else the PO rate. */
export function effectiveRate(line: Pick<CountedLine, 'po_rate' | 'rate'>): number {
  return line.rate == null || !Number.isFinite(Number(line.rate)) ? num(line.po_rate) : num(line.rate)
}

/** True when the manager has typed a cost that differs from the order's. */
export function isOverridden(line: Pick<CountedLine, 'po_rate' | 'rate'>): boolean {
  return line.rate != null && round(num(line.rate), 4) !== round(num(line.po_rate), 4)
}

/** What the receipt can book against the order line — never more than is outstanding. */
export function postedQty(line: Pick<CountedLine, 'pending_qty' | 'received_qty'>): number {
  return Math.max(0, Math.min(num(line.received_qty), num(line.pending_qty)))
}

/** What lands in the receiving warehouse: posted minus damaged (damaged goes to Damaged). */
export function acceptedQty(line: CountedLine): number {
  return Math.max(0, postedQty(line) - Math.min(num(line.damaged_qty), postedQty(line)))
}

/** Nothing counted on this line yet. */
export function untouched(line: CountedLine): boolean {
  return num(line.received_qty) === 0 && num(line.damaged_qty) === 0
}

// ---------------------------------------------------------------------------------------------
// variance colouring
// ---------------------------------------------------------------------------------------------
/**
 * The tone for one line's variance chip. `final` matters: with the "whole delivery" switch off a
 * short line is just a partial receipt (amber, nothing is raised), with it on the same line closes
 * the order and raises a Short against the vendor (red).
 *
 *   nothing outstanding, nothing counted → muted   (line already complete)
 *   nothing counted yet                  → muted, or crit when `final` will short the whole line
 *   over-received                        → warn    (an Over discrepancy is raised either way)
 *   damaged units                        → warn    (a Damaged discrepancy is raised either way)
 *   short                                → warn partial · crit final
 *   exact                                → good
 */
export function varianceTone(line: CountedLine, final = false): BadgeTone {
  const v = receiveVariance(line)
  const damaged = num(line.damaged_qty)
  if (untouched(line)) {
    if (num(line.pending_qty) <= 0) return 'muted'
    return final ? 'crit' : 'muted'
  }
  if (v.over > 0) return 'warn'
  if (v.short > 0) return final ? 'crit' : 'warn'
  if (damaged > 0) return 'warn'
  return 'good'
}

/** "Short 4" · "Over 2" · "2 damaged" · "OK" · "—" — the chip next to the tone. */
export function varianceLabel(line: CountedLine, final = false): string {
  const v = receiveVariance(line)
  const damaged = num(line.damaged_qty)
  if (untouched(line)) {
    if (num(line.pending_qty) <= 0) return 'Complete'
    return final ? `Short ${num(line.pending_qty)}` : '—'
  }
  if (v.over > 0) return `Over ${v.over}`
  if (v.short > 0) return `${final ? 'Short' : 'Pending'} ${v.short}`
  if (damaged > 0) return `${damaged} damaged`
  return 'OK'
}

// ---------------------------------------------------------------------------------------------
// freight + the moving-average preview
// ---------------------------------------------------------------------------------------------
/**
 * Freight on *this receipt*, averaged per unit accepted into stock — the **headline** figure the
 * sheet shows next to the freight box ("about $0.33 a unit"). The manager enters a figure for the
 * delivery in front of them, so it is shared over what that delivery brought in, not over the
 * whole order, which may still have another shipment to come.
 *
 * Do **not** value a line with this: see {@link receiptFreightForLine}.
 */
export function receiptFreightShare(lines: CountedLine[], freight = 0): number {
  return freightSharePerUnit(
    (lines || []).map((l) => ({ qty: acceptedQty(l) })),
    freight
  )
}

/**
 * The freight one unit of **one** line carries, allocated by line amount.
 *
 * The server writes the manager's freight onto the Purchase Receipt as an Actual + Valuation
 * charge, and ERPNext distributes those **by net amount**, not evenly per unit. Previewing a
 * per-unit average instead put the moving-average preview ~7% out on a receipt whose lines had
 * different rates — a receive sheet that quietly gets this wrong is worse than one that shows
 * nothing, so the preview is built on the same allocation the posting will use.
 */
export function receiptFreightForLine(lines: CountedLine[], freight: number, index: number): number {
  return freightShareForLine(
    (lines || []).map((l) => ({ qty: acceptedQty(l), rate: effectiveRate(l) })),
    freight,
    index
  )
}

/** Units this receipt will accept into stock — the divisor the freight share is shown against. */
export function acceptedUnits(lines: CountedLine[]): number {
  return (lines || []).reduce((sum, l) => sum + acceptedQty(l), 0)
}

/** "cost moves $9.34 → $9.31" — the whole point of choosing Moving Average. */
export interface MovingAveragePreview {
  /** valuation rate before the receipt */
  before: number
  /** valuation rate after it */
  after: number
  after_minus_before: number
  /** units on hand before */
  on_hand: number
  /** units this receipt adds */
  qty: number
  /** unit cost booked, freight included */
  landed: number
}

/**
 * The moving-average move this line will cause, or `null` when there is nothing to show — no
 * stock row for the item (the Stock payload has not loaded, or the item has never been stocked)
 * or nothing accepted on the line. Degrading to `null` is deliberate: a preview built on a guessed
 * on-hand would be a lie.
 */
export function maPreview(
  stock: Pick<StockRow, 'actual_qty' | 'valuation_rate'> | null | undefined,
  line: CountedLine,
  freightShare = 0
): MovingAveragePreview | null {
  if (!stock) return null
  const qty = acceptedQty(line)
  if (qty <= 0) return null
  const rate = effectiveRate(line)
  const before = num(stock.valuation_rate)
  const after = movingAverageAfter(num(stock.actual_qty), before, qty, rate, freightShare)
  return {
    before,
    after,
    after_minus_before: round(after - before, 4),
    on_hand: num(stock.actual_qty),
    qty,
    landed: round(rate + num(freightShare), 4)
  }
}

// ---------------------------------------------------------------------------------------------
// the outcome of posting
// ---------------------------------------------------------------------------------------------
export interface ReceiveOutcome {
  /** false when the server posted no Purchase Receipt at all */
  posted: boolean
  message: string
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The one line the desk toasts after a receipt.
 *
 * `purchase_receipt` comes back **null** when nothing was postable — a `final` receipt on an order
 * where every outstanding unit is missing raises the shorts and posts no stock. Saying
 * "Purchase Receipt null posted" there is how a warehouse loses trust in a screen, so it gets its
 * own sentence.
 */
export function receiveOutcome(out: ReceiveResult, vendor?: string | null): ReceiveOutcome {
  const who = (vendor || out.supplier || 'the vendor').trim()
  const lines = out.lines || []
  const short = lines.filter((l) => l.short_qty > 0).length
  const over = lines.filter((l) => l.over_qty > 0).length
  const damaged = lines.filter((l) => l.damaged_qty > 0).length
  const units = lines.reduce((sum, l) => sum + (l.accepted_qty || 0), 0)
  if (!out.purchase_receipt) {
    const why = short ? `${plural(short, 'short line')} ${short === 1 ? 'was' : 'were'} raised against ${who}` : `nothing on ${out.purchase_order} could be booked`
    const shut = out.closed ? ` · ${out.purchase_order} is closed` : ''
    return { posted: false, message: `Nothing was posted — ${why}${shut}` }
  }
  const raised: string[] = []
  if (short) raised.push(`${short} short`)
  if (over) raised.push(`${over} over`)
  if (damaged) raised.push(`${damaged} damaged`)
  const tail = out.discrepancies?.length ? ` · ${plural(out.discrepancies.length, 'discrepancy', 'discrepancies')} raised (${raised.join(', ')})` : ''
  // Only say the order is closed when the server says it closed it. The screen used to promise
  // this unconditionally while the order stayed *To Receive* on the Inbound list.
  const shut = out.closed ? ` · ${out.purchase_order} is closed` : ''
  return { posted: true, message: `Purchase Receipt ${out.purchase_receipt} posted · ${plural(units, 'unit')} into ${out.warehouse || 'the warehouse'}${tail}${shut}` }
}

// ---------------------------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------------------------
/** Barcode first, then item code, then a barcode suffix — the same ladder `CountSheet` climbs. */
export function matchesCode(line: { item_code: string; barcode?: string | null }, code: string): boolean {
  const c = (code || '').trim().toLowerCase()
  if (!c) return false
  const bar = (line.barcode || '').toLowerCase()
  if (bar && bar === c) return true
  if (line.item_code.toLowerCase() === c) return true
  return c.length >= 6 && !!bar && bar.endsWith(c)
}

/** The index of the first line a scan hits, or `-1`. */
export function matchLine(lines: { item_code: string; barcode?: string | null }[], code: string): number {
  return (lines || []).findIndex((l) => matchesCode(l, code))
}

export interface ScanHit {
  order: PurchaseOrderWithItems
  line: PurchaseOrderLine
}

/**
 * Every expected order carrying a line for this barcode. The board opens the receive sheet only
 * when exactly one **order** matches — two vendors shipping the same item is normal here, and
 * guessing which delivery is on the bench would post to the wrong purchase order.
 */
export function matchScan(orders: PurchaseOrderWithItems[], code: string): ScanHit[] {
  const hits: ScanHit[] = []
  for (const order of orders || []) {
    const line = (order.items || []).find((l) => matchesCode(l, code))
    if (line) hits.push({ order, line })
  }
  return hits
}

// ---------------------------------------------------------------------------------------------
// expected orders
// ---------------------------------------------------------------------------------------------
/** When an order is expected: its promised date, else today + the vendor's lead time. */
export function etaOf(order: Pick<PurchaseOrderWithItems, 'schedule_date' | 'supplier'>, leadTimes: Record<string, number> = {}, today: string | Date = new Date()): string {
  return etaFrom(order.schedule_date, leadTimes[order.supplier] || 0, today)
}

/**
 * A date-only value (`YYYY-MM-DD` — a Frappe Date column, an ETA) as a timestamp the site-zone
 * formatters render back as *the same day*.
 *
 * v0.6 R / v0.8 QA W-D2 again, in a new place: `new Date('2026-08-27')` is UTC midnight, so
 * `fmtDate` in `America/Chicago` renders it as Aug 26. Pinning the bare date to midday and letting
 * `parseServer` read it as site-zone wall time keeps an ETA on the day the vendor promised.
 * Returns `null` for anything that is not a date, which every formatter renders as an em dash.
 */
export function atNoon(date: string | null | undefined): string | null {
  const d = String(date || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : null
}

/** Signed whole days from *today* to *eta* — negative once the delivery is late. */
export function daysToEta(eta: string, today: string): number {
  if (!eta || !today) return 0
  const a = Date.parse(`${String(eta).slice(0, 10)}T00:00:00Z`)
  const b = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((a - b) / 86400000)
}

/** Whole days late (0 when it is not yet due). */
export function overdueDays(eta: string, today: string): number {
  return Math.max(0, -daysToEta(eta, today))
}

export interface EtaStatus {
  /** signed days to the ETA */
  days: number
  late: boolean
  /** "3 d late" · "Due today" · "Due tomorrow" · "In 5 d" */
  text: string
  tone: BadgeTone
}

/** The ETA chip: how a delivery is doing against its promised date. */
export function etaStatus(eta: string, today: string): EtaStatus {
  const days = daysToEta(eta, today)
  if (days < 0) {
    const late = -days
    return { days, late: true, text: `${late} d late`, tone: late >= 3 ? 'crit' : 'warn' }
  }
  if (days === 0) return { days, late: false, text: 'Due today', tone: 'accent' }
  if (days === 1) return { days, late: false, text: 'Due tomorrow', tone: 'accent' }
  return { days, late: false, text: `In ${days} d`, tone: 'muted' }
}

// ---------------------------------------------------------------------------------------------
// §F — stock
// ---------------------------------------------------------------------------------------------
/**
 * Cover days for the table. `null` (the server's answer for an item that does not move) and any
 * non-finite figure render as an em dash — `Infinity` days of cover is not a number a warehouse
 * manager should ever be shown.
 */
export function fmtCover(days: number | null | undefined): string {
  if (days == null) return '—'
  const n = Number(days)
  if (!Number.isFinite(n) || n < 0) return '—'
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)} d`
}

export interface StockTotals {
  items: number
  units: number
  value: number
  low: number
  on_order: number
}

/** The summary strip. Computed from the rows in hand, so it always agrees with the table. */
export function stockTotals(rows: StockRow[]): StockTotals {
  const list = rows || []
  return {
    items: list.length,
    units: list.reduce((s, r) => s + num(r.actual_qty), 0),
    value: round(list.reduce((s, r) => s + num(r.stock_value), 0)),
    low: list.filter((r) => r.low).length,
    on_order: list.reduce((s, r) => s + num(r.on_order), 0)
  }
}

/** The item groups present, alphabetically — the group filter's options. */
export function stockGroups(rows: StockRow[]): string[] {
  return [...new Set((rows || []).map((r) => (r.item_group || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

/**
 * Group filter, low-only toggle, low-stock first. The server already sorts low first / group /
 * code; re-sorting here keeps the order honest after a client-side filter.
 */
export function filterStock(rows: StockRow[], opts: { group?: string | null; lowOnly?: boolean } = {}): StockRow[] {
  const group = (opts.group || '').trim()
  return (rows || [])
    .filter((r) => (!group || r.item_group === group) && (!opts.lowOnly || r.low))
    .slice()
    .sort((a, b) => Number(b.low) - Number(a.low) || (a.item_group || '').localeCompare(b.item_group || '') || a.item_code.localeCompare(b.item_code))
}
