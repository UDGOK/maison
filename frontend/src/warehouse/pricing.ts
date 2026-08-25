/**
 * v1.2 "What each store owes, and what each store charges" — the pricing maths, pure and
 * unit-tested (no Vue, no I/O, no clock unless you pass one in). The sibling of
 * `warehouse/buying.ts`, `inbound.ts` and `distribution.ts`.
 *
 *  §A wholesale ..... {@link applyMarkup} {@link wholesaleOf} — a literal mirror of
 *                     `maison_pos/pricing/wholesale.py`, so the mock desk and the bench agree
 *  §D price board ... {@link marginAt} {@link marginPctText} {@link marginTone}
 *                     {@link validateProposal} {@link changeCopy} {@link proposalsFrom}
 *  §C statement ..... {@link statementTotals} {@link netNote} {@link unpricedNote}
 *                     {@link monthBounds} {@link previousMonth}
 *
 * Two rules this module exists to keep, because both of them are the sort of thing a screen gets
 * quietly wrong:
 *
 *  · **`margin_pct` is `null` when there is no price.** An item the chain has never priced is not
 *    a 0 % margin, and a board that prints `0 %` is the sort of thing somebody prices against.
 *    {@link marginPctText} renders `—`; nothing here ever coerces a `null` to a zero.
 *  · **The totals on the screen are computed from the rows on the screen.** The statement payload
 *    carries its own `totals`, but a screen that prints a total it did not add up cannot be
 *    checked against itself — and eleven stores' margin percentages must never be summed.
 *    {@link statementTotals} is the same arithmetic `reports/store_statement.py::_finish` does.
 */
import type { StatementStore, StorePriceRow, StorePrices } from '@/api/pricing'

/** Design-system tone token (`styles/tokens.css`). Same vocabulary as the other three modules. */
export type Tone = 'crit' | 'warn' | 'good' | 'accent' | 'muted'

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function round(value: number, places = 2): number {
  const f = 10 ** places
  return Math.round((value + Number.EPSILON) * f) / f
}

/** Whole numbers print whole — "12 short" reads better than "12.0 short" (`distribution._n`). */
export function plain(value: number): string {
  const n = num(value)
  return Math.abs(n - Math.trunc(n)) < 1e-9 ? String(Math.trunc(n)) : String(round(n, 3))
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${plain(n)} ${Math.abs(n) === 1 ? one : many}`
}

// ---------------------------------------------------------------------------------------------
// §A — the wholesale price (mirrors maison_pos/pricing/wholesale.py)
// ---------------------------------------------------------------------------------------------
/** `cost × (1 + pct/100)`, rounded to 2. The chain-wide rule. */
export function applyMarkup(cost: number, pct: number): number {
  return round(num(cost) * (1 + num(pct) / 100))
}

/**
 * What a store pays for one unit: the typed override when there is one, else the rule.
 * A blank / zero override means "use the rule" — that is how a Frappe Currency column spells blank.
 */
export function wholesaleOf(cost: number, pct: number, override?: number | null): number {
  const typed = num(override)
  return typed > 0 ? round(typed) : applyMarkup(cost, pct)
}

/** Is a markup percentage one the server will take? Refuses < 0 and > 1000; **0 is legal**. */
export function markupProblem(pct: unknown): string {
  const n = Number(pct)
  if (!Number.isFinite(n)) return 'That is not a percentage.'
  if (n < 0) return 'The wholesale markup cannot be negative — that is a discount, not a markup.'
  if (n > 1000) return 'A wholesale markup above 1000% is almost certainly a typing slip.'
  return ''
}

/** "50% on cost" · "typed on the item" — where one item's wholesale price came from. */
export function wholesaleSourceCopy(source: string, markupPct: number): string {
  return source === 'override' ? 'Typed on the item — the chain rule does not apply to it' : `The chain rule — ${plain(markupPct)}% on what Houston paid`
}

// ---------------------------------------------------------------------------------------------
// §D — the price board
// ---------------------------------------------------------------------------------------------
/** What a store makes at a price, having paid us *wholesale*. Mirrors `api/pricing.py::margin_at`. */
export interface MarginView {
  margin: number
  /** **null** when there is no price to take a percentage of — never 0 */
  margin_pct: number | null
  has_price: boolean
}

export function marginAt(rate: unknown, wholesale: unknown): MarginView {
  const price = num(rate)
  const cost = num(wholesale)
  const margin = round(price - cost)
  return { margin, margin_pct: price ? round((100 * margin) / price, 1) : null, has_price: !!price }
}

/**
 * `"38.4 %"` — or **`—`** when the item has no price at all. The one place this is rendered, so
 * an unpriced row cannot leak out as `0 %` (docs/pricing.md §5).
 */
export function marginPctText(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '—'
  const n = Number(pct)
  if (!Number.isFinite(n)) return '—'
  return `${round(n, 1)} %`
}

/**
 * The tone of a margin. A store selling **at or below** what it paid us is critical — that is a
 * shop losing money on every unit and nobody has noticed. Under 20 % is thin. Unknown is muted:
 * an unpriced item is not a bad margin, it is *no* margin.
 */
export function marginTone(pct: number | null | undefined): Tone {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return 'muted'
  const n = Number(pct)
  if (n <= 0) return 'crit'
  if (n < 20) return 'warn'
  return 'good'
}

/** "Store override" rows lead the eye — they are the exceptions somebody typed. */
export function sourceTone(row: Pick<StorePriceRow, 'is_override'>): Tone {
  return row.is_override ? 'accent' : 'muted'
}

/** One row of the board as the manager has edited it. */
export interface PriceDraft {
  /** the typed price, as typed (a string, because it comes out of an input) */
  rate: string
  /** why — the server **requires** it and throws when it is blank */
  reason: string
  valid_from?: string
  valid_upto?: string
}

export interface ProposalProblem {
  field: 'rate' | 'reason'
  message: string
}

/**
 * What is wrong with one typed price, before anything is posted.
 *
 * `reason` is mandatory server-side (v1.2 §D — *"Say why the price is changing — head office
 * reads it when they approve"*), so it is collected here rather than letting the manager meet
 * that as a server error after typing eleven prices.
 */
export function validateProposal(draft: Pick<PriceDraft, 'rate' | 'reason'>, current: number): ProposalProblem[] {
  const problems: ProposalProblem[] = []
  const raw = String(draft.rate ?? '').trim()
  const rate = Number(raw)
  if (!raw) problems.push({ field: 'rate', message: 'Type the new shelf price.' })
  else if (!Number.isFinite(rate)) problems.push({ field: 'rate', message: 'That is not a price.' })
  else if (rate <= 0) problems.push({ field: 'rate', message: 'A shelf price has to be more than nothing.' })
  else if (round(rate) === round(num(current))) problems.push({ field: 'rate', message: 'That is the price it is already selling at.' })
  if (!String(draft.reason ?? '').trim()) {
    problems.push({ field: 'reason', message: 'Say why the price is changing — head office reads it when they approve.' })
  }
  return problems
}

/** True when this row has been typed into at all (an untouched row raises nothing). */
export function isTouched(draft: PriceDraft | null | undefined): boolean {
  return !!draft && (String(draft.rate ?? '').trim() !== '' || String(draft.reason ?? '').trim() !== '')
}

/** "$24.99 → $22.99 · −$2.00" — the change one row is asking for, in the shape a reader scans. */
export function changeCopy(current: number, proposed: number, fmt: (n: number) => string): string {
  const from = num(current)
  const to = num(proposed)
  const delta = round(to - from)
  const arrow = `${from ? fmt(from) : 'no price'} → ${fmt(to)}`
  if (!delta) return arrow
  return `${arrow} · ${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}`
}

/** One request the board is about to raise. */
export interface Proposal {
  boutique: string
  boutique_name: string
  item_code: string
  current_rate: number
  proposed_rate: number
  reason: string
  valid_from?: string
  valid_upto?: string
  /** what the store's margin becomes at the proposed price */
  margin: MarginView
}

/**
 * Every touched, valid row turned into a request — several rows at once raises several requests
 * (§D). A row with a pending request is skipped: the board must not invite a second one for the
 * same store and item while head office still has the first.
 */
export function proposalsFrom(payload: StorePrices | null, drafts: Record<string, PriceDraft>): Proposal[] {
  if (!payload) return []
  const out: Proposal[] = []
  for (const row of payload.stores || []) {
    const draft = drafts[row.boutique]
    if (!isTouched(draft) || row.pending) continue
    if (validateProposal(draft, row.rate).length) continue
    const proposed = round(Number(draft.rate))
    out.push({
      boutique: row.boutique,
      boutique_name: row.boutique_name,
      item_code: payload.item_code,
      current_rate: num(row.rate),
      proposed_rate: proposed,
      reason: String(draft.reason).trim(),
      valid_from: draft.valid_from || undefined,
      valid_upto: draft.valid_upto || undefined,
      margin: marginAt(proposed, row.wholesale)
    })
  }
  return out
}

/** Everything wrong across the board, keyed by store — what the footer refuses on. */
export function boardProblems(payload: StorePrices | null, drafts: Record<string, PriceDraft>): { boutique: string; problems: ProposalProblem[] }[] {
  if (!payload) return []
  const out: { boutique: string; problems: ProposalProblem[] }[] = []
  for (const row of payload.stores || []) {
    const draft = drafts[row.boutique]
    if (!isTouched(draft) || row.pending) continue
    const problems = validateProposal(draft, row.rate)
    if (problems.length) out.push({ boutique: row.boutique, problems })
  }
  return out
}

/** The copy on the board's primary button. */
export function raiseCopy(proposals: Proposal[], problems: { boutique: string }[]): string {
  if (problems.length) return `${plural(problems.length, 'row')} to fix`
  if (!proposals.length) return 'Nothing to raise'
  return `Raise ${plural(proposals.length, 'price change')}`
}

/** "3 raised · 1 already waiting" — the line after posting. */
export function raisedCopy(raised: string[], failed = 0): string {
  if (!raised.length) return failed ? `Nothing was raised — ${plural(failed, 'row')} refused` : 'Nothing was raised'
  const head = `${plural(raised.length, 'price change')} raised for approval — ${raised.join(', ')}`
  return failed ? `${head} · ${plural(failed, 'row')} refused` : head
}

/** How many stores are already waiting on head office for this item. */
export function pendingCount(payload: StorePrices | null): number {
  return (payload?.stores || []).filter((r) => !!r.pending).length
}

/** How many stores carry a price of their own rather than the chain default. */
export function overrideCount(payload: StorePrices | null): number {
  return (payload?.stores || []).filter((r) => r.is_override).length
}

/** How many stores have no price at all — the rows whose margin is honestly unknown. */
export function unpricedCount(payload: StorePrices | null): number {
  return (payload?.stores || []).filter((r) => !r.has_price).length
}

/** The one line under the board's heading: what the eleven rows add up to as a state of play. */
export function boardSummary(payload: StorePrices | null): string {
  if (!payload) return ''
  const rows = payload.stores || []
  if (!rows.length) return 'No enabled store to price this for.'
  const parts = [`${plural(rows.length, 'store')}`]
  const overrides = overrideCount(payload)
  parts.push(overrides ? `${plain(overrides)} with a price of their own` : 'all on the chain default')
  const unpriced = unpricedCount(payload)
  if (unpriced) parts.push(`${plain(unpriced)} with no price at all`)
  const pending = pendingCount(payload)
  if (pending) parts.push(`${plural(pending, 'change')} waiting for approval`)
  return `${parts.join(' · ')}.`
}

// ---------------------------------------------------------------------------------------------
// §D — the approvals queue
// ---------------------------------------------------------------------------------------------
/** A reject must say why; an approve need not. */
export function decisionProblem(action: 'Approve' | 'Reject', reason: string): string {
  if (action === 'Reject' && !String(reason ?? '').trim()) return 'Say why it is being rejected — the store manager reads this.'
  return ''
}

/** "Bixby wants $22.99 for GB-PULSE-15K-BLUE" — the headline on one queued request. */
export function queueHeadline(row: { boutique: string; item_code: string; proposed_rate: number }, fmt: (n: number) => string): string {
  return `${row.boutique} wants ${fmt(num(row.proposed_rate))} for ${row.item_code}`
}

// ---------------------------------------------------------------------------------------------
// §C — the month-end statement
// ---------------------------------------------------------------------------------------------
const MONEY_KEYS = ['wholesale_value', 'cost_value'] as const
const UNIT_KEYS = ['shipments', 'units', 'short_units', 'damaged_units', 'billable_units', 'unpriced_shipments', 'unpriced_units'] as const

/**
 * The chain total, added up from the rows the screen is showing.
 *
 * The same arithmetic as `reports/store_statement.py::_finish`, deliberately: margin is
 * `wholesale − cost` and margin % is that over **wholesale**, computed once at the bottom — never
 * by adding eleven stores' percentages together, which is what `add_total_row` would have done.
 */
export function statementTotals(stores: StatementStore[], boutiqueName = 'Chain total'): StatementStore {
  const out = {
    boutique: null as string | null,
    boutique_name: boutiqueName,
    shipments: 0,
    units: 0,
    short_units: 0,
    damaged_units: 0,
    billable_units: 0,
    wholesale_value: 0,
    cost_value: 0,
    margin: 0,
    margin_pct: 0,
    unpriced_shipments: 0,
    unpriced_units: 0
  } as StatementStore
  for (const store of stores || []) {
    for (const key of UNIT_KEYS) (out[key] as number) += num(store[key])
    for (const key of MONEY_KEYS) (out[key] as number) += num(store[key])
  }
  for (const key of UNIT_KEYS) (out[key] as number) = round(out[key] as number)
  for (const key of MONEY_KEYS) (out[key] as number) = round(out[key] as number)
  out.margin = round(out.wholesale_value - out.cost_value)
  out.margin_pct = out.wholesale_value ? round((100 * out.margin) / out.wholesale_value, 1) : 0
  return out
}

/** True when the store received exactly what was sent — nothing short, nothing damaged. */
export function receivedInFull(row: Pick<StatementStore, 'short_units' | 'damaged_units'>): boolean {
  return num(row.short_units) === 0 && num(row.damaged_units) === 0
}

/**
 * "12 short · 3 damaged came off" — what a store is **not** being billed for, or an empty string
 * when it received everything. Client decision 4: bill for what a store actually received.
 */
export function netNote(row: Pick<StatementStore, 'short_units' | 'damaged_units'>): string {
  const short = num(row.short_units)
  const damaged = num(row.damaged_units)
  if (!short && !damaged) return ''
  const parts: string[] = []
  if (short) parts.push(`${plain(short)} short`)
  if (damaged) parts.push(`${plain(damaged)} damaged`)
  return `${parts.join(' · ')} came off`
}

/**
 * The *not priced* line. Consignments that shipped before v1.2 carry no stamped value: their
 * units are counted and never valued, and the screen must say so rather than let a reader take
 * the silence for a zero.
 */
export function unpricedNote(row: Pick<StatementStore, 'unpriced_shipments' | 'unpriced_units'>): string {
  const shipments = num(row.unpriced_shipments)
  if (shipments <= 0) return ''
  const units = num(row.unpriced_units)
  return `${plural(shipments, 'consignment')} not priced${units ? ` (${plural(units, 'unit')})` : ''} — sent before wholesale pricing existed, so they are counted but never valued.`
}

/** Does any row on this statement carry unpriced consignments? The banner above the table. */
export function hasUnpriced(stores: StatementStore[]): boolean {
  return (stores || []).some((s) => num(s.unpriced_shipments) > 0)
}

/** A store with nothing shipped still appears — an absent row reads as an oversight. */
export function isQuiet(row: Pick<StatementStore, 'shipments' | 'units'>): boolean {
  return num(row.shipments) === 0 && num(row.units) === 0
}

/** "Aug 1 – Aug 25, 2026" is the caption; this is the period as the server wants it. */
export interface Period {
  from: string
  to: string
}

/** The first and last day of the month a `YYYY-MM-DD` falls in. Pure — no clock, no zone. */
export function monthBounds(day: string): Period {
  const [y, m] = String(day || '').slice(0, 10).split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return { from: '', to: '' }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` }
}

/** The whole of the month before the one *day* falls in — what the 1st-of-the-month run wants. */
export function previousMonth(day: string): Period {
  const [y, m] = String(day || '').slice(0, 10).split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return { from: '', to: '' }
  const prevYear = m === 1 ? y - 1 : y
  const prevMonth = m === 1 ? 12 : m - 1
  return monthBounds(`${prevYear}-${String(prevMonth).padStart(2, '0')}-01`)
}

/** This month to date: the 1st through *day* itself. */
export function monthToDate(day: string): Period {
  const bounds = monthBounds(day)
  return bounds.from ? { from: bounds.from, to: String(day).slice(0, 10) } : bounds
}

/** True when from/to are the wrong way round — the server throws, so the screen says it first. */
export function periodProblem(period: Period): string {
  const from = String(period.from || '').slice(0, 10)
  const to = String(period.to || '').slice(0, 10)
  if (!from || !to) return 'Choose a period.'
  if (from > to) return 'The first date has to be on or before the last.'
  return ''
}

/**
 * The sentence that must be on the screen, in words, because somebody will eventually e-mail this
 * to a store owner (client decision 3). Not a flag, not a tooltip — the screen says it.
 */
export const INTERNAL_HEADLINE = 'Internal AWANZ document — it shows Houston’s own cost and margin'
export const NOT_AN_INVOICE =
  'This is a report, not an invoice. It creates no receivable, nothing ages, no payment is tracked against it and nothing lands in a partner’s books. Bill from it by hand.'
export const DO_NOT_SEND = 'Do not send it to a store.'
