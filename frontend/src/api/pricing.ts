/**
 * v1.2 "What each store owes, and what each store charges" — the pricing API
 * (`maison_pos.api.pricing.*`), plus the three price-change endpoints that live under
 * `maison_pos.api.purchasing.*` and are re-exported from there for the screens that already
 * import them by that name.
 *
 * Two prices, and they are not the same thing:
 *
 *   **wholesale** — what a *store* pays AWANZ Houston for a unit it is sent. A chain-wide markup
 *                   on what Houston actually paid, unless somebody typed a price on the item
 *                   (`wholesale_settings` `set_wholesale_markup` `wholesale` `set_wholesale`).
 *   **retail** ---- what a *client* pays in a shop. `store_prices` reads every store's shelf
 *                   price for one item; raising and approving a change is the v0.1 workflow in
 *                   `purchasing.request_price_change` / `.approve_price_change`.
 *
 * And **the statement** (`statement`) — what each store owes for a period.
 *
 * Three things about this API shape the screens on top of it:
 *
 *  - **Everything here is warehouse-admin / head-office only.** A store manager is refused every
 *    endpoint, *including the statement for their own store*. There is no store-facing view of
 *    any of it, by design: it all shows or derives from what Houston paid.
 *  - **`margin_pct` is `null`** when the item has no price at all. Render an em dash. An unpriced
 *    item is not a 0 % margin, and a board that says 0 % is the sort of thing somebody prices
 *    against.
 *  - **`unpriced_shipments > 0`** means consignments that left before v1.2 and carry no stamped
 *    value. Their units are counted and never valued — show them as *not priced*, never as zero.
 *
 * The statement is a **report**. It creates no receivable, ages nothing, tracks no payment, and
 * every payload it produces says so (`is_invoice: false`, `creates_receivable: false`, `notice`).
 *
 * The mock (VITE_MOCK=1 / unit tests) keeps a deterministic pricing desk in memory: the same ten
 * items the buying desk carries, the eleven CloudChaserz stores, a 50 % chain markup with one
 * typed override, two live store price overrides, a queue of price change requests, and two
 * months of shipped consignments — one of which is deliberately *unpriced*, because a screen that
 * has never seen that case is a screen that will render it as zero.
 */
import { ApiError } from './types'
import { humanizeServerMessage } from '@/utils/text'
// The pure maths lives in `warehouse/pricing.ts` and is a literal mirror of
// `maison_pos/pricing/wholesale.py`, so the mock desk and the bench cannot disagree. That module
// imports only *types* from here, so there is no runtime cycle (same shape as api/distribution).
import { applyMarkup, marginAt, wholesaleOf } from '@/warehouse/pricing'

// ---------------------------------------------------------------------------------------------
// types (mirror maison_pos/api/pricing.py + reports/store_statement.py)
// ---------------------------------------------------------------------------------------------

/** Where one item's wholesale price came from. */
export type WholesaleSource = 'override' | 'markup'

/** `pricing.wholesale_settings()` — the chain-wide rule and what it is applied to. */
export interface WholesaleSettings {
  markup_pct: number
  /** what the rule falls back to when the setting has never been filled in (50) */
  default_markup_pct: number
  warehouse: string
  currency: string
  /** in words: "Moving average valuation at the main warehouse" */
  cost_basis: string
  /** always false — one price for every store (client decision 1) */
  per_store_terms: boolean
  internal: boolean
  notice: string
}

/** One resolved item. `margin` here is **AWANZ's** — wholesale less cost, not the store's. */
export interface WholesaleRow {
  item_code: string
  item_name?: string | null
  /** the moving-average valuation at HOU-WH — what Houston actually paid */
  cost: number
  /** the typed per-item price, or `null` when the chain rule applies */
  override: number | null
  wholesale: number
  source: WholesaleSource | string
  markup_pct: number
  margin: number
  margin_pct: number
}

export interface WholesaleResult {
  markup_pct: number
  currency: string
  warehouse: string
  items: WholesaleRow[]
  count: number
}

export interface SetWholesaleResult {
  item: WholesaleRow
  markup_pct: number
  currency: string
}

// ---------------------------------------------------------------------------------------------
// §C — the statement
// ---------------------------------------------------------------------------------------------
/** One item's slice of a store's statement. **CSV only** — the screen renders store rows (decision 5). */
export interface StatementLine {
  item_code: string
  item_name?: string | null
  shipments: number
  units: number
  short_units: number
  damaged_units: number
  billable_units: number
  /** the weighted average over the period — a line can gather consignments stamped on different days */
  wholesale_rate: number
  cost_rate: number
  wholesale_value: number
  cost_value: number
  margin: number
  margin_pct: number
  unpriced_units: number
}

/** One store's row — and, with `boutique: null`, the chain total. */
export interface StatementStore {
  boutique: string | null
  boutique_name: string
  shipments: number
  units: number
  short_units: number
  damaged_units: number
  /** `units − short − damaged` — what the store actually received (client decision 4) */
  billable_units: number
  wholesale_value: number
  /** **internal**: what Houston paid for those units */
  cost_value: number
  margin: number
  margin_pct: number
  /** consignments carrying no stamped value — they shipped before v1.2 */
  unpriced_shipments: number
  unpriced_units: number
  /** the per-item breakdown; absent on the totals row, never rendered on the screen */
  lines?: StatementLine[]
}

export interface Statement {
  from_date: string
  to_date: string
  /** client decision 3 — this must never be mistakable for a bill */
  internal: boolean
  shows_cost: boolean
  is_invoice: boolean
  creates_receivable: boolean
  notice: string
  markup_pct: number
  currency: string
  stores: StatementStore[]
  totals: StatementStore
  /** consignments in the period, chain-wide */
  shipments: number
  generated_at: string
}

// ---------------------------------------------------------------------------------------------
// §D — retail, per store
// ---------------------------------------------------------------------------------------------
/** A change already waiting for head office on this (store, item). */
export interface PendingPriceChange {
  name: string
  current_rate: number
  proposed_rate: number
  reason?: string | null
  requested_by?: string | null
  valid_from?: string | null
  valid_upto?: string | null
}

/** One store's row on the price board. `margin` here is the **store's** — shelf less wholesale. */
export interface StorePriceRow {
  boutique: string
  boutique_name: string
  warehouse?: string | null
  rate: number
  /** `"Store override"` (a live Pricing Rule) or `"Chain default"` (the Item Price) */
  source: 'Store override' | 'Chain default' | string
  is_override: boolean
  pricing_rule?: string | null
  valid_from?: string | null
  valid_upto?: string | null
  /** the same figure for every store (client decision 1) */
  wholesale: number
  margin: number
  /** **null** when the item has no price at all — never 0 */
  margin_pct: number | null
  has_price: boolean
  pending: PendingPriceChange | null
}

export interface StorePrices {
  item_code: string
  item_name: string
  item_group?: string | null
  uom?: string | null
  barcode?: string | null
  image?: string | null
  price_list: string
  /** the chain-wide `Item Price` on the selling list */
  default_rate: number
  currency: string
  wholesale: number
  wholesale_source: WholesaleSource | string
  /** **internal** — the moving-average cost the wholesale price was derived from */
  cost: number
  markup_pct: number
  stores: StorePriceRow[]
  count: number
  internal: boolean
  notice: string
}

// ---------------------------------------------------------------------------------------------
// the existing AWANZ Price Change Request (v0.1 doctype, v1.0 endpoints, v1.2 screen)
// ---------------------------------------------------------------------------------------------
/** ERPNext submit state: 0 draft, 1 submitted, 2 cancelled. */
export type PriceDocStatus = 0 | 1 | 2

/** `api/pricing.py::margin_at` — what a store makes at a price. `margin_pct` is null with no price. */
export interface MarginView {
  margin: number
  margin_pct: number | null
  has_price: boolean
}

export interface PriceChangeRequest {
  name: string
  boutique: string
  item_code: string
  item_name?: string | null
  current_rate: number
  proposed_rate: number
  reason?: string | null
  workflow_state: string
  docstatus: PriceDocStatus
  requested_by?: string | null
  valid_from?: string | null
  valid_upto?: string | null
  pricing_rule?: string | null
  approved_by?: string | null
  approved_on?: string | null
  /**
   * v1.2 §D — what the store pays us, and the margin now against the margin proposed. Attached
   * **only for a purchasing admin**: a store manager reading their own queue gets exactly the
   * payload v1.0 gave them, because what we pay for the stock is not shop-floor information.
   */
  wholesale?: number
  margin_now?: MarginView
  margin_proposed?: MarginView
}

export interface PriceChangeCreated {
  name: string
  workflow_state: string
  boutique: string
  item_code: string
  proposed_rate: number
}

export interface PriceChangeDecision {
  name: string
  workflow_state: string
  pricing_rule?: string | null
}

export interface PriceChangeList {
  requests: PriceChangeRequest[]
  count: number
}

export interface PricingApi {
  /** The chain-wide rule. Warehouse admin / head office only, like everything else here. */
  wholesale_settings(): Promise<WholesaleSettings>
  /** Set the chain-wide markup. Refuses < 0 and > 1000; **0 is legal** — ship at cost. */
  set_wholesale_markup(pct: number): Promise<WholesaleSettings>
  /** Resolve many items at once — the price board asks for 160 at a time. */
  wholesale(item_codes: string[]): Promise<WholesaleResult>
  /** Type a wholesale price on one item; `null` clears it and returns it to the rule. */
  set_wholesale(item_code: string, rate: number | null): Promise<SetWholesaleResult>
  /** What each store owes for a period — **a report, not an invoice**. */
  statement(from_date: string, to_date: string, boutique?: string | null): Promise<Statement>
  /** Every enabled store's current shelf price for one item, and the margin it makes. */
  store_prices(item_code: string, price_list?: string): Promise<StorePrices>
}

// ---------------------------------------------------------------------------------------------
// Frappe
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.'

function csrf(): string {
  return (typeof window !== 'undefined' && window.csrf_token) || ''
}

async function call<T>(method: string, args: Record<string, unknown> = {}, get = false): Promise<T> {
  const url = BASE + method
  let res: Response
  try {
    if (get) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) qs.set(k, typeof v === 'string' ? v : JSON.stringify(v))
      res = await fetch(`${url}?${qs.toString()}`, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json', 'X-Frappe-CSRF-Token': csrf() } })
    } else {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': csrf() },
        body: JSON.stringify(args)
      })
    }
  } catch (e) {
    throw new ApiError((e as Error).message || 'Network error', 'NETWORK', 0)
  }
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    if (body?._server_messages) {
      try {
        message = humanizeServerMessage((JSON.parse(body._server_messages) as string[]).map((m) => JSON.parse(m).message).join('\n')) || message
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = humanizeServerMessage(String(body.exception).split('\n').pop()) || message
    throw new ApiError(message, res.status === 401 || res.status === 403 ? 'AUTH' : body?.exc_type || `HTTP_${res.status}`, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappePricing: PricingApi = {
  wholesale_settings: () => call('pricing.wholesale_settings', {}, true),
  // writes: POST. `rate: null` is meaningful (it clears the override), so it is sent explicitly.
  set_wholesale_markup: (pct) => call('pricing.set_wholesale_markup', { pct }),
  wholesale: (item_codes) => call('pricing.wholesale', { item_codes }, true),
  set_wholesale: (item_code, rate) => call('pricing.set_wholesale', { item_code, rate }),
  statement: (from_date, to_date, boutique) => call('pricing.statement', { from_date, to_date, boutique }, true),
  store_prices: (item_code, price_list = 'Standard Selling') => call('pricing.store_prices', { item_code, price_list }, true)
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests) — deterministic, in memory, no clock reads in the seed
// ---------------------------------------------------------------------------------------------
const MOCK_WAREHOUSE = 'HOU-WH - CCZ'
const MOCK_CURRENCY = 'USD'
const MOCK_TODAY = '2026-08-24'
const MOCK_NOW = '2026-08-24T09:00:00'
const MOCK_USER = 'warehouse@cloudchaserz.example'
const MOCK_PRICE_LIST = 'Standard Selling'
const DEFAULT_MARKUP_PCT = 50

const INTERNAL_NOTICE =
  'Internal AWANZ document — it shows the AWANZ warehouse’s own cost and margin. It is not an invoice: no receivable is created, nothing ages, no payment is tracked and no partner’s books are touched. Do not send it to a store.'
const BOARD_NOTICE = 'Cost and wholesale are internal AWANZ figures — do not put them in front of a store.'

/** `[code, name, city]` — the eleven CloudChaserz shops, in store-code order (never HOU-WH). */
const MOCK_STORES: [string, string, string][] = [
  ['HOU-MTR', 'CloudChaserz Montrose', 'Houston'],
  ['OK-BA', 'CloudChaserz Broken Arrow', 'Broken Arrow'],
  ['OK-BIX', 'CloudChaserz Bixby', 'Tulsa'],
  ['OK-ETUL', 'CloudChaserz East Tulsa', 'Tulsa'],
  ['OK-JENKS', 'CloudChaserz Jenks', 'Jenks'],
  ['OK-MINGO', 'CloudChaserz Mingo', 'Tulsa'],
  ['OK-MUS', 'CloudChaserz Muskogee', 'Muskogee'],
  ['OK-OWA', 'CloudChaserz Owasso', 'Owasso'],
  ['OK-SAP', 'CloudChaserz Sapulpa', 'Sapulpa'],
  ['OK-STUL', 'CloudChaserz South Tulsa', 'Tulsa'],
  ['OK-YALE', 'CloudChaserz Yale', 'Tulsa']
]

interface MockPriceItem {
  item_code: string
  item_name: string
  item_group: string
  uom: string
  barcode: string
  /** moving-average valuation at HOU-WH — what Houston paid */
  cost: number
  /** the chain-wide selling price (the `Item Price` on Standard Selling) */
  selling: number
}

/** `[code, name, group, barcode, cost, selling]` — the same ten items the other two desks carry. */
const MOCK_ITEMS: [string, string, string, string, number, number][] = [
  ['GB-PULSE-15K-BLUE', 'Geek Bar Pulse 15K — Blue Razz Ice', 'Vape', '8801234500017', 9.34, 24.99],
  ['LM-MO20K-WM', 'Lost Mary MO20000 — Watermelon', 'Vape', '8801234500024', 11.52, 27.99],
  ['ELFBAR-BC5K-MANGO', 'Elf Bar BC5000 — Mango', 'Vape', '8801234500031', 8.28, 19.99],
  ['HYDE-EDGE-4K-GRAPE', 'Hyde Edge Rave 4K — Grape', 'Vape', '8801234500048', 7.9, 18.99],
  ['PUFF-XXL-MINT', 'Puff Bar XXL — Cool Mint', 'Vape', '8801234500055', 7.02, 16.99],
  ['RAW-KS-SLIM', 'RAW Classic King Size Slim', 'Papers', '8801234500062', 1.21, 3.49],
  ['OCB-XPERT-KS', 'OCB X-Pert King Size', 'Papers', '8801234500079', 1.02, 2.99],
  ['ZIG-ZAG-1-25', 'Zig-Zag 1¼ Rolling Papers', 'Papers', '8801234500086', 0.9, 2.49],
  ['AF-SHISHA-250-MINT', 'Al Fakher Shisha 250 g — Mint', 'Shisha', '8801234500093', 5.71, 14.99],
  // never priced on the selling list: the honest "—" case the board has to render (never 0 %)
  ['CLIPPER-LTR-ASST', 'Clipper Lighter — Assorted', 'Accessories', '8801234500109', 0.74, 0],
  ['OPMS-GOLD-3CT', 'OPMS Gold Kratom Capsules — 3 ct', 'Kratom', '8801234500116', 4.65, 12.99]
]

/** One consignment line on the mock statement. `unpriced` shipped before v1.2 — counted, never valued. */
interface MockStatementLine {
  boutique: string
  item_code: string
  shipments: number
  units: number
  short?: number
  damaged?: number
  unpriced?: boolean
}

/**
 * Two months of consignments. July carries the pre-v1.2 consignments that were never stamped —
 * the case that makes the difference between "not priced" and "worth nothing", which is the
 * whole reason `unpriced_shipments` is on the payload.
 */
const MOCK_SHIPPED: Record<string, MockStatementLine[]> = {
  '2026-07': [
    { boutique: 'HOU-MTR', item_code: 'GB-PULSE-15K-BLUE', shipments: 2, units: 96, short: 4 },
    { boutique: 'HOU-MTR', item_code: 'RAW-KS-SLIM', shipments: 1, units: 200 },
    { boutique: 'OK-BIX', item_code: 'GB-PULSE-15K-BLUE', shipments: 1, units: 48 },
    { boutique: 'OK-BIX', item_code: 'ELFBAR-BC5K-MANGO', shipments: 1, units: 60, damaged: 2 },
    // shipped before wholesale pricing existed — no stamp on the consignment at all
    { boutique: 'OK-SAP', item_code: 'PUFF-XXL-MINT', shipments: 1, units: 32, unpriced: true },
    { boutique: 'OK-SAP', item_code: 'ZIG-ZAG-1-25', shipments: 1, units: 150, unpriced: true },
    { boutique: 'OK-STUL', item_code: 'LM-MO20K-WM', shipments: 1, units: 40 },
    { boutique: 'OK-MINGO', item_code: 'OCB-XPERT-KS', shipments: 1, units: 250 },
    { boutique: 'OK-JENKS', item_code: 'AF-SHISHA-250-MINT', shipments: 1, units: 36 }
  ],
  '2026-08': [
    { boutique: 'HOU-MTR', item_code: 'GB-PULSE-15K-BLUE', shipments: 2, units: 120, short: 6 },
    { boutique: 'HOU-MTR', item_code: 'PUFF-XXL-MINT', shipments: 1, units: 64 },
    { boutique: 'HOU-MTR', item_code: 'CLIPPER-LTR-ASST', shipments: 1, units: 144 },
    { boutique: 'OK-BA', item_code: 'RAW-KS-SLIM', shipments: 1, units: 300, damaged: 12 },
    { boutique: 'OK-BIX', item_code: 'GB-PULSE-15K-BLUE', shipments: 2, units: 72 },
    { boutique: 'OK-BIX', item_code: 'ZIG-ZAG-1-25', shipments: 1, units: 200 },
    { boutique: 'OK-ETUL', item_code: 'ELFBAR-BC5K-MANGO', shipments: 1, units: 48 },
    { boutique: 'OK-JENKS', item_code: 'HYDE-EDGE-4K-GRAPE', shipments: 1, units: 24, short: 2, damaged: 1 },
    { boutique: 'OK-MINGO', item_code: 'OCB-XPERT-KS', shipments: 1, units: 150 },
    { boutique: 'OK-MINGO', item_code: 'LM-MO20K-WM', shipments: 1, units: 30 },
    { boutique: 'OK-SAP', item_code: 'AF-SHISHA-250-MINT', shipments: 1, units: 24 },
    { boutique: 'OK-STUL', item_code: 'PUFF-XXL-MINT', shipments: 1, units: 56 },
    { boutique: 'OK-YALE', item_code: 'RAW-KS-SLIM', shipments: 1, units: 100 }
    // OK-MUS and OK-OWA received nothing — they still appear, with zeros (client decision 5)
  ]
}

interface MockPricingState {
  seq: number
  markupPct: number
  /** every item this desk can price — the seed, plus anything `create_product` made in-session */
  items: Record<string, MockPriceItem>
  /** item_code → the typed wholesale price; absent means "use the rule" */
  overrides: Record<string, number>
  /** item_code → the chain-wide selling price */
  selling: Record<string, number>
  /** `${item_code}|${boutique}` → the live store-scoped Pricing Rule */
  rules: Record<string, { pricing_rule: string; rate: number; valid_from: string | null; valid_upto: string | null }>
  requests: PriceChangeRequest[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function seedItems(): Record<string, MockPriceItem> {
  const out: Record<string, MockPriceItem> = {}
  for (const [item_code, item_name, item_group, barcode, cost, selling] of MOCK_ITEMS) {
    out[item_code] = { item_code, item_name, item_group, uom: 'Nos', barcode, cost, selling }
  }
  return out
}

function fresh(): MockPricingState {
  return {
    seq: 5,
    markupPct: DEFAULT_MARKUP_PCT,
    items: seedItems(),
    // Zig-Zag is bought by the box and priced by hand — the "typed on the item" case
    overrides: { 'ZIG-ZAG-1-25': 1.75 },
    selling: Object.fromEntries(MOCK_ITEMS.map(([code, , , , , selling]) => [code, selling])),
    rules: {
      // the approved PCR-00002 below is what created this one
      'RAW-KS-SLIM|HOU-MTR': { pricing_rule: 'PRLE-0031', rate: 2.99, valid_from: '2026-08-01', valid_upto: null },
      'GB-PULSE-15K-BLUE|OK-SAP': { pricing_rule: 'PRLE-0028', rate: 26.99, valid_from: '2026-06-14', valid_upto: null }
    },
    requests: [
      {
        name: 'PCR-00005', boutique: 'OK-MINGO', item_code: 'ELFBAR-BC5K-MANGO', item_name: 'Elf Bar BC5000 — Mango',
        current_rate: 19.99, proposed_rate: 17.99, reason: 'Slow movers — clearing the mango before the new flavours land.',
        workflow_state: 'Pending Approval', docstatus: 1, requested_by: 'mingo.manager@cloudchaserz.example',
        valid_from: '2026-08-26', valid_upto: '2026-09-15', pricing_rule: null, approved_by: null, approved_on: null
      },
      {
        name: 'PCR-00004', boutique: 'OK-SAP', item_code: 'LM-MO20K-WM', item_name: 'Lost Mary MO20000 — Watermelon',
        current_rate: 27.99, proposed_rate: 24.49, reason: 'The smoke shop on Dewey dropped to 24.99 last week.',
        workflow_state: 'Pending Approval', docstatus: 1, requested_by: 'sapulpa.manager@cloudchaserz.example',
        valid_from: '2026-08-25', valid_upto: null, pricing_rule: null, approved_by: null, approved_on: null
      },
      {
        name: 'PCR-00003', boutique: 'OK-BIX', item_code: 'GB-PULSE-15K-BLUE', item_name: 'Geek Bar Pulse 15K — Blue Razz Ice',
        current_rate: 24.99, proposed_rate: 22.99, reason: 'Matching the shop two doors down.',
        workflow_state: 'Pending Approval', docstatus: 1, requested_by: 'bixby.manager@cloudchaserz.example',
        valid_from: '2026-08-25', valid_upto: '2026-09-30', pricing_rule: null, approved_by: null, approved_on: null
      },
      {
        name: 'PCR-00002', boutique: 'HOU-MTR', item_code: 'RAW-KS-SLIM', item_name: 'RAW Classic King Size Slim',
        current_rate: 3.49, proposed_rate: 2.99, reason: 'Clearing the old print run.',
        workflow_state: 'Approved', docstatus: 1, requested_by: 'montrose.manager@cloudchaserz.example',
        valid_from: '2026-08-01', valid_upto: null, pricing_rule: 'PRLE-0031', approved_by: MOCK_USER, approved_on: '2026-08-02T08:40:00'
      }
    ]
  }
}

let state: MockPricingState = fresh()

async function pause(): Promise<void> {
  if (typeof window !== 'undefined' && window.__awanzOffline) throw new ApiError('Offline', 'NETWORK', 0)
  await new Promise((r) => setTimeout(r, 5))
}

function nextName(prefix: string): string {
  state.seq += 1
  return `${prefix}-${String(state.seq).padStart(5, '0')}`
}

function itemOf(itemCode: string): MockPriceItem {
  const row = state.items[(itemCode || '').trim()]
  if (!row) throw new ApiError(`Item ${itemCode || '?'} does not exist`, 'DoesNotExistError', 404)
  return { ...row, selling: state.selling[row.item_code] ?? 0 }
}

/** One resolved row — the same shape `wholesale_for` returns, computed with the shared maths. */
function wholesaleRow(itemCode: string): WholesaleRow {
  const item = itemOf(itemCode)
  const override = state.overrides[itemCode] || 0
  const rate = wholesaleOf(item.cost, state.markupPct, override)
  return {
    item_code: item.item_code,
    item_name: item.item_name,
    cost: round2(item.cost),
    override: override || null,
    wholesale: rate,
    source: override ? 'override' : 'markup',
    markup_pct: state.markupPct,
    margin: round2(rate - item.cost),
    margin_pct: rate ? Math.round(((100 * (rate - item.cost)) / rate) * 10) / 10 : 0
  }
}

/** The months a `YYYY-MM-DD` range touches, as `YYYY-MM` keys. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  const [fy, fm] = from.slice(0, 7).split('-').map(Number)
  const [ty, tm] = to.slice(0, 7).split('-').map(Number)
  if (!Number.isFinite(fy) || !Number.isFinite(ty)) return out
  let y = fy
  let m = fm
  // a 10-year range is 120 iterations; the guard is there so a nonsense range cannot spin
  for (let i = 0; i < 240 && (y < ty || (y === ty && m <= tm)); i += 1) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

const ZERO_STORE = (boutique: string | null, boutique_name: string): StatementStore => ({
  boutique,
  boutique_name,
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
  unpriced_units: 0,
  lines: []
})

/** `wholesale − cost`, and the percentage of wholesale — the one place margin is defined. */
function finish<T extends StatementStore | StatementLine>(row: T): T {
  row.wholesale_value = round2(row.wholesale_value)
  row.cost_value = round2(row.cost_value)
  row.margin = round2(row.wholesale_value - row.cost_value)
  row.margin_pct = row.wholesale_value ? Math.round(((100 * row.margin) / row.wholesale_value) * 10) / 10 : 0
  return row
}

export const mockPricing: PricingApi = {
  async wholesale_settings() {
    await pause()
    return {
      markup_pct: state.markupPct,
      default_markup_pct: DEFAULT_MARKUP_PCT,
      warehouse: MOCK_WAREHOUSE,
      currency: MOCK_CURRENCY,
      cost_basis: 'Moving average valuation at the main warehouse',
      per_store_terms: false,
      internal: true,
      notice: INTERNAL_NOTICE
    }
  },

  async set_wholesale_markup(pct) {
    await pause()
    const value = Number(pct)
    if (!Number.isFinite(value)) throw new ApiError('That is not a percentage', 'ValidationError', 417)
    if (value < 0) throw new ApiError('The wholesale markup cannot be negative', 'ValidationError', 417)
    if (value > 1000) throw new ApiError('A wholesale markup above 1000% is almost certainly a typing slip', 'ValidationError', 417)
    state.markupPct = round2(value)
    return mockPricing.wholesale_settings()
  },

  async wholesale(item_codes) {
    await pause()
    const codes = [...new Set((item_codes || []).map((c) => (c || '').trim()).filter(Boolean))]
    const items = codes.filter((c) => !!state.items[c]).map(wholesaleRow)
    return { markup_pct: state.markupPct, currency: MOCK_CURRENCY, warehouse: MOCK_WAREHOUSE, items, count: items.length }
  },

  async set_wholesale(item_code, rate) {
    await pause()
    itemOf(item_code)
    if (rate === null || rate === undefined || String(rate) === '') delete state.overrides[item_code]
    else {
      const value = Number(rate)
      if (!Number.isFinite(value)) throw new ApiError('That is not a price', 'ValidationError', 417)
      if (value < 0) throw new ApiError('A wholesale price cannot be negative', 'ValidationError', 417)
      // zero is how a Currency column spells blank — it returns the item to the rule
      if (value <= 0) delete state.overrides[item_code]
      else state.overrides[item_code] = round2(value)
    }
    return { item: wholesaleRow(item_code), markup_pct: state.markupPct, currency: MOCK_CURRENCY }
  },

  async statement(from_date, to_date, boutique) {
    await pause()
    const from = String(from_date || '').slice(0, 10)
    const to = String(to_date || '').slice(0, 10)
    if (!from || !to) throw new ApiError('Choose a period', 'ValidationError', 417)
    if (from > to) throw new ApiError('From Date must be on or before To Date', 'ValidationError', 417)
    const wanted = (boutique || '').trim()
    if (wanted && !MOCK_STORES.some(([code]) => code === wanted)) {
      throw new ApiError(`${wanted} is not an enabled store`, 'ValidationError', 417)
    }
    const codes = MOCK_STORES.filter(([code]) => !wanted || code === wanted)
    const stores: Record<string, StatementStore> = {}
    for (const [code, name] of codes) stores[code] = ZERO_STORE(code, name)
    const lines: Record<string, StatementLine> = {}

    let shipments = 0
    for (const month of monthsBetween(from, to)) {
      for (const row of MOCK_SHIPPED[month] || []) {
        const store = stores[row.boutique]
        if (!store) continue
        const item = itemOf(row.item_code)
        const resolved = wholesaleRow(row.item_code)
        const short = Math.min(row.short || 0, row.units)
        const damaged = Math.min(row.damaged || 0, Math.max(0, row.units - short))
        const billable = Math.max(0, row.units - short - damaged)
        const wholesaleValue = row.unpriced ? 0 : billable * resolved.wholesale
        const costValue = row.unpriced ? 0 : billable * item.cost
        shipments += row.shipments

        const key = `${row.boutique}|${row.item_code}`
        const line =
          lines[key] ||
          (lines[key] = {
            item_code: row.item_code,
            item_name: item.item_name,
            shipments: 0,
            units: 0,
            short_units: 0,
            damaged_units: 0,
            billable_units: 0,
            wholesale_rate: 0,
            cost_rate: 0,
            wholesale_value: 0,
            cost_value: 0,
            margin: 0,
            margin_pct: 0,
            unpriced_units: 0
          })
        for (const target of [line, store] as (StatementLine | StatementStore)[]) {
          target.shipments += row.shipments
          target.units += row.units
          target.short_units += short
          target.damaged_units += damaged
          target.billable_units += billable
          target.wholesale_value += wholesaleValue
          target.cost_value += costValue
          if (row.unpriced) target.unpriced_units += row.units
        }
        if (row.unpriced) store.unpriced_shipments += row.shipments
        if (!store.lines!.includes(line)) store.lines!.push(line)
      }
    }

    for (const line of Object.values(lines)) {
      finish(line)
      line.wholesale_rate = line.billable_units ? round2(line.wholesale_value / line.billable_units) : 0
      line.cost_rate = line.billable_units ? round2(line.cost_value / line.billable_units) : 0
    }
    const out: StatementStore[] = []
    const totals = ZERO_STORE(null, 'Chain total')
    delete totals.lines
    for (const [code] of codes) {
      const store = finish(stores[code])
      store.lines!.sort((a, b) => b.wholesale_value - a.wholesale_value || a.item_code.localeCompare(b.item_code))
      out.push(store)
      for (const key of ['shipments', 'units', 'short_units', 'damaged_units', 'billable_units', 'unpriced_shipments', 'unpriced_units'] as const) {
        totals[key] += store[key]
      }
      totals.wholesale_value += store.wholesale_value
      totals.cost_value += store.cost_value
    }
    finish(totals)

    return {
      from_date: from,
      to_date: to,
      internal: true,
      shows_cost: true,
      is_invoice: false,
      creates_receivable: false,
      notice: INTERNAL_NOTICE,
      markup_pct: state.markupPct,
      currency: MOCK_CURRENCY,
      stores: clone(out),
      totals: clone(totals),
      shipments,
      generated_at: MOCK_NOW
    }
  },

  async store_prices(item_code, price_list = MOCK_PRICE_LIST) {
    await pause()
    const item = itemOf(item_code)
    const resolved = wholesaleRow(item.item_code)
    const pending = pendingByStore(item.item_code)
    const stores: StorePriceRow[] = MOCK_STORES.map(([code, name]) => {
      const rule = state.rules[`${item.item_code}|${code}`]
      const rate = rule ? rule.rate : item.selling
      const margin = marginAt(rate, resolved.wholesale)
      return {
        boutique: code,
        boutique_name: name,
        warehouse: `${code} - CCZ`,
        rate: round2(rate),
        source: rule ? 'Store override' : 'Chain default',
        is_override: !!rule,
        pricing_rule: rule?.pricing_rule ?? null,
        valid_from: rule?.valid_from ?? null,
        valid_upto: rule?.valid_upto ?? null,
        wholesale: resolved.wholesale,
        margin: margin.margin,
        margin_pct: margin.margin_pct,
        has_price: margin.has_price,
        pending: pending[code] ?? null
      }
    })
    return {
      item_code: item.item_code,
      item_name: item.item_name,
      item_group: item.item_group,
      uom: item.uom,
      barcode: item.barcode,
      image: null,
      price_list,
      default_rate: round2(item.selling),
      currency: MOCK_CURRENCY,
      wholesale: resolved.wholesale,
      wholesale_source: resolved.source,
      cost: resolved.cost,
      markup_pct: state.markupPct,
      stores,
      count: stores.length,
      internal: true,
      notice: BOARD_NOTICE
    }
  }
}

function pendingByStore(itemCode: string): Record<string, PendingPriceChange> {
  const out: Record<string, PendingPriceChange> = {}
  for (const r of state.requests) {
    if (r.item_code !== itemCode || r.workflow_state !== 'Pending Approval') continue
    if (out[r.boutique]) continue
    out[r.boutique] = {
      name: r.name,
      current_rate: r.current_rate,
      proposed_rate: r.proposed_rate,
      reason: r.reason ?? null,
      requested_by: r.requested_by ?? null,
      valid_from: r.valid_from ?? null,
      valid_upto: r.valid_upto ?? null
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// the price-change endpoints — they live under `purchasing.*` and are driven from here
// ---------------------------------------------------------------------------------------------
/**
 * The mock behind `purchasing.price_change_requests`. The margin keys are attached only when the
 * caller may see them (`withMargins`): a store manager reading their own queue gets exactly the
 * payload v1.0 gave them, because what we pay for the stock is not shop-floor information.
 */
export async function __mockPriceChangeRequests(
  boutique?: string,
  status: string = 'Pending Approval',
  itemCode?: string,
  limit = 100,
  withMargins = true
): Promise<PriceChangeList> {
  await pause()
  let rows = state.requests
  if (boutique) rows = rows.filter((r) => r.boutique === boutique)
  if (status && status !== 'all' && status !== 'any') rows = rows.filter((r) => r.workflow_state === status)
  if (itemCode) rows = rows.filter((r) => r.item_code === itemCode)
  const out = clone(rows.slice(0, limit))
  if (withMargins) {
    for (const r of out) {
      const rate = wholesaleRow(r.item_code).wholesale
      r.wholesale = rate
      r.margin_now = marginAt(r.current_rate, rate)
      r.margin_proposed = marginAt(r.proposed_rate, rate)
    }
  }
  return { requests: out, count: out.length }
}

/** The mock behind `purchasing.request_price_change`. A blank reason is refused, as it is on the bench. */
export async function __mockRequestPriceChange(
  itemCode: string,
  boutique: string,
  proposedRate: number,
  reason?: string,
  validFrom?: string,
  validUpto?: string
): Promise<PriceChangeCreated> {
  await pause()
  const item = itemOf(itemCode)
  if (!MOCK_STORES.some(([code]) => code === boutique)) throw new ApiError(`${boutique} is not an enabled store`, 'ValidationError', 417)
  // v1.2 §D — the doctype has always required this; the endpoint now says so in words, because
  // head office reads it when they approve
  if (!String(reason ?? '').trim()) {
    throw new ApiError('Say why the price is changing — head office reads it when they approve', 'MandatoryError', 417)
  }
  const rule = state.rules[`${itemCode}|${boutique}`]
  const doc: PriceChangeRequest = {
    name: nextName('PCR'),
    boutique,
    item_code: itemCode,
    item_name: item.item_name,
    current_rate: round2(rule ? rule.rate : item.selling),
    proposed_rate: round2(Number(proposedRate) || 0),
    reason: String(reason).trim(),
    workflow_state: 'Pending Approval',
    docstatus: 1,
    requested_by: MOCK_USER,
    valid_from: validFrom || MOCK_TODAY,
    valid_upto: validUpto ?? null,
    pricing_rule: null,
    approved_by: null,
    approved_on: null
  }
  state.requests.unshift(doc)
  return { name: doc.name, workflow_state: doc.workflow_state, boutique: doc.boutique, item_code: doc.item_code, proposed_rate: doc.proposed_rate }
}

/**
 * The mock behind `purchasing.approve_price_change`. **Approving is what creates the store-scoped
 * pricing rule** — that is v0.1 behaviour and the screen does not reimplement it, so the mock has
 * to do it here or the price board would go on showing the chain default after an approval.
 */
export async function __mockApprovePriceChange(name: string, action: 'Approve' | 'Reject' = 'Approve', reason?: string): Promise<PriceChangeDecision> {
  await pause()
  const doc = state.requests.find((r) => r.name === name)
  if (!doc) throw new ApiError(`AWANZ Price Change Request ${name} does not exist`, 'DoesNotExistError', 404)
  if (action !== 'Approve' && action !== 'Reject') throw new ApiError(`Unknown action ${action}`, 'ValidationError', 417)
  if (doc.workflow_state !== 'Pending Approval') throw new ApiError(`${name} is already ${doc.workflow_state.toLowerCase()}`, 'ValidationError', 417)
  if (reason) doc.reason = `${doc.reason || ''}\n${reason}`.trim()
  doc.workflow_state = action === 'Approve' ? 'Approved' : 'Rejected'
  doc.approved_by = MOCK_USER
  doc.approved_on = MOCK_NOW
  if (action === 'Approve') {
    doc.pricing_rule = nextName('PRLE')
    state.rules[`${doc.item_code}|${doc.boutique}`] = {
      pricing_rule: doc.pricing_rule,
      rate: doc.proposed_rate,
      valid_from: doc.valid_from ?? null,
      valid_upto: doc.valid_upto ?? null
    }
  } else doc.pricing_rule = null
  return { name: doc.name, workflow_state: doc.workflow_state, pricing_rule: doc.pricing_rule ?? null }
}

/** What a store pays us for one item — the figure the buying mock needs for its margin columns. */
export function __mockWholesaleRate(itemCode: string): number {
  try {
    return wholesaleRow(itemCode).wholesale
  } catch {
    return 0
  }
}

/** The chain-wide markup, for a mock that needs to price an item the pricing desk does not carry. */
export function __mockMarkupPct(): number {
  return state.markupPct
}

/**
 * Register a product with the pricing desk — what `purchasing.create_product` does on a bench,
 * where the Item, its valuation and its selling price all exist the moment it is created. Without
 * this a product made on the New product sheet would 404 on its own price board.
 */
export function __mockRegisterPricedItem(item: {
  item_code: string
  item_name?: string | null
  item_group?: string | null
  uom?: string | null
  barcode?: string | null
  cost?: number
  selling?: number
}): void {
  const code = (item.item_code || '').trim()
  if (!code) return
  state.items[code] = {
    item_code: code,
    item_name: item.item_name || code,
    item_group: item.item_group || 'Products',
    uom: item.uom || 'Nos',
    barcode: item.barcode || '',
    cost: round2(Number(item.cost) || 0),
    selling: round2(Number(item.selling) || 0)
  }
  state.selling[code] = round2(Number(item.selling) || 0)
}

/** Tests: restore the seeded pricing desk. */
export function __resetMockPricing(): void {
  state = fresh()
}

/** Re-exported so a caller that only imports this module can still do the chain-rule arithmetic. */
export { applyMarkup, marginAt, wholesaleOf }

const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const pricingApi: PricingApi = IS_MOCK ? mockPricing : frappePricing
