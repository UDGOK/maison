/**
 * v1.1 "Onboarding a product" §A — the distribution API (`maison_pos.api.distribution.*`).
 *
 * Houston pushes stock **out** to the stores. Every shipment before v1.1 began with a store
 * raising a request; for a brand-new product that is backwards, because no store knows it exists.
 * These four endpoints give the warehouse the other direction:
 *
 *   `stores` ......... the enabled shops a push may address (never HOU-WH itself)
 *   `plan` ........... what Houston holds and where every store stands — on hand, 28-day
 *                      velocity, days of cover, and whether it has *ever sold* the item
 *   `suggest_split` .. `even` / `velocity` / `topup`, so the maths is the server's, not the sheet's
 *   `send` ........... one request + one shipment **per store**, all or nothing
 *
 * Everything is gated server-side to **AWANZ Warehouse Admin** / **AWANZ Head Office** (client
 * decision 1 — pushing is Houston's act; a store manager pushing to their own store is refused).
 *
 * Two things about this API shape the screens on top of it:
 *
 *  - **`suggest_split` is a calculator, not a gate.** It will happily allocate more than
 *    `available`, and hands back `left_at_warehouse` so the footer can go red *before* the send.
 *    `send` is what refuses, and it refuses the whole distribution with the shortfall named per
 *    item (client decision 4) — a half-sent push leaves phantom shipments the floor will ship.
 *  - **`cover_days` is `null` when velocity is 0.** Render an em dash, never `Infinity`.
 *
 * The mock (VITE_MOCK=1 / unit tests) keeps a deterministic Houston in memory: the eleven
 * CloudChaserz stores, a per-(item, store) position derived from a stable hash so every item has a
 * full, plausible eleven-store profile, and the same ten items the buying mock carries. Products
 * created through `purchasing.create_product` register here with nothing on hand anywhere — which
 * is exactly the case v1.1 exists for.
 */
import { ApiError } from './types'
import { humanizeServerMessage } from '@/utils/text'
// The mock shares the sheet's pure split maths, which are themselves a literal mirror of
// `maison_pos/distribution.py` — so the mock and the bench cannot disagree. That module imports
// only *types* from here, so there is no runtime cycle.
import { splitFor } from '@/warehouse/distribution'
import type { Priority, ReplenishmentRequest, Shipment } from './warehouse'

// ---------------------------------------------------------------------------------------------
// types (mirror maison_pos/distribution.py + api/distribution.py)
// ---------------------------------------------------------------------------------------------

/** `maison_pos/distribution.py::SPLIT_MODES`. */
export type SplitMode = 'even' | 'velocity' | 'topup'
export const SPLIT_MODES: SplitMode[] = ['even', 'velocity', 'topup']
/** `AWANZ Replenishment Request.priority` — the same three a store's own pull may carry. */
export const PUSH_PRIORITIES: Priority[] = ['Normal', 'Low stock', 'Urgent']
/** The window "28-day velocity" is measured over (`distribution.VELOCITY_DAYS`). */
export const VELOCITY_DAYS = 28
/** Default target for the *top up* mode, in days of cover (`DEFAULT_TARGET_COVER_DAYS`). */
export const DEFAULT_COVER_DAYS = 21

/** One shop a push may address (`distribution.store_rows`). */
export interface DistributionStore {
  boutique: string
  boutique_name: string
  warehouse: string
  company?: string | null
  city?: string | null
  region?: string | null
}

export interface StoresResult {
  stores: DistributionStore[]
  count: number
  /** HOU-WH — the warehouse a push leaves from */
  warehouse: string
}

/**
 * One store's position on one item — what turns an allocation into a decision rather than a guess.
 */
export interface PlanStoreRow extends DistributionStore {
  /** units on that store's own shelf */
  on_hand: number
  /** units per day over the last 28 days of POS sales at that store */
  velocity: number
  /** on hand ÷ velocity — **null** when the store does not move it (never `Infinity`) */
  cover_days: number | null
  /** has this store ever rung the item up? the line between *restock* and *introduce* */
  ever_sold: boolean
}

/** One item on the plan: Houston's position, then a row per store. */
export interface PlanItem {
  item_code: string
  item_name?: string | null
  item_group?: string | null
  uom?: string | null
  barcode?: string | null
  image?: string | null
  disabled: boolean
  is_stock_item: boolean
  /** units in HOU-WH's bin */
  on_hand: number
  /** units already promised to open shipments that have not left yet */
  committed: number
  /** `on_hand − committed` — what a push may actually draw on */
  available: number
  stores: PlanStoreRow[]
}

export interface PlanResult {
  warehouse: string
  velocity_days: number
  as_of: string
  stores: DistributionStore[]
  items: PlanItem[]
}

/** A plan row with the units this split gave it. Every candidate store comes back, allocated or not. */
export interface SplitLine extends PlanStoreRow {
  qty: number
}

export interface SplitResult {
  item_code: string
  item_name?: string | null
  mode: SplitMode | string
  /** what was asked for */
  qty: number
  /** what the split actually handed out */
  allocated: number
  /** `qty − allocated` — what *top up* could not place because every store is already covered */
  remainder: number
  /** the target the *top up* mode used */
  cover_days: number
  velocity_days: number
  warehouse: string
  on_hand: number
  committed: number
  available: number
  /** `available − allocated` — the footer figure, negative when the send would be refused */
  left_at_warehouse: number
  lines: SplitLine[]
}

/** One line of a push: this many of this item, to this store. */
export interface DistributionLine {
  boutique: string
  item_code: string
  qty: number
}

/** A shipment created by a push. A subset of `api/shipping.shipment_dict` — what a confirmation needs. */
export type PushedShipment = Pick<Shipment, 'name' | 'boutique' | 'boutique_name' | 'from_warehouse' | 'to_warehouse' | 'status' | 'items' | 'units'> &
  Partial<Shipment> & {
    /** v1.1: true on anything Houston initiated — a push, not a store's pull */
    warehouse_push?: boolean
  }

/** The request behind one pushed shipment. */
export type PushedRequest = Pick<ReplenishmentRequest, 'name' | 'boutique' | 'status' | 'priority'> &
  Partial<ReplenishmentRequest> & { warehouse_push?: boolean }

export interface SendResult {
  /** one per store — client decision 3, separate parcels and separate labels, never batched */
  shipments: PushedShipment[]
  requests: PushedRequest[]
  /** how many stores were sent to */
  stores: number
  units: number
  items: number
  warehouse: string
  priority: Priority | string
  /** what was stamped on every request, so the desk reads plainly that Houston initiated it */
  reason: string
}

export interface DistributionApi {
  /** The enabled shops a push may address, in store-code order. */
  stores(): Promise<StoresResult>
  /** Houston's position and every store's, for one item or several. */
  plan(item_codes: string[], boutiques?: string[] | null, days?: number): Promise<PlanResult>
  /** Server-side allocation helper — the sheet never re-implements the maths. */
  suggest_split(item_code: string, qty: number, mode?: SplitMode, boutiques?: string[] | null, cover_days?: number | null): Promise<SplitResult>
  /** Create **and approve** one shipment per store. Refuses the whole push, or writes all of it. */
  send(lines: DistributionLine[], reason?: string | null, priority?: Priority | string): Promise<SendResult>
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
        // `send`'s refusal is deliberately multi-line with `•` bullets — keep the newlines, the
        // sheet renders it verbatim (`white-space: pre-line`). Flattening it loses the shortfalls.
        message = humanizeServerMessage((JSON.parse(body._server_messages) as string[]).map((m) => JSON.parse(m).message).join('\n')) || message
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = humanizeServerMessage(String(body.exception).split('\n').pop()) || message
    throw new ApiError(message, res.status === 401 || res.status === 403 ? 'AUTH' : body?.exc_type || `HTTP_${res.status}`, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappeDistribution: DistributionApi = {
  stores: () => call('distribution.stores', {}, true),
  plan: (item_codes, boutiques, days = VELOCITY_DAYS) => call('distribution.plan', { item_codes, boutiques, days }, true),
  suggest_split: (item_code, qty, mode = 'even', boutiques, cover_days) => call('distribution.suggest_split', { item_code, qty, mode, boutiques, cover_days }, true),
  // POST only on the server: it creates and approves shipments (`@frappe.whitelist(methods=["POST"])`).
  send: (lines, reason, priority = 'Normal') => call('distribution.send', { lines, reason, priority })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests) — deterministic, in memory, no clock reads in the seed
// ---------------------------------------------------------------------------------------------
const MOCK_WAREHOUSE = 'HOU-WH - CCZ'
const MOCK_COMPANY = 'CloudChaserz'
const MOCK_NOW = '2026-08-24T09:00:00'
const MOCK_USER = 'warehouse@cloudchaserz.example'

/**
 * The eleven CloudChaserz stores (`docs/cloudchaserz.md` §2), in store-code order — HOU-WH itself
 * is never one of them. `size` is that store's share of chain-wide sales; it is what makes the
 * mock's velocities differ store by store the way real ones do.
 * `[code, name, city, region, size]`
 */
const MOCK_STORES: [string, string, string, string, number][] = [
  ['HOU-MTR', 'CloudChaserz Montrose', 'Houston', 'Houston', 1.9],
  ['OK-BA', 'CloudChaserz Broken Arrow', 'Broken Arrow', 'Tulsa Metro', 1.15],
  ['OK-BIX', 'CloudChaserz Bixby', 'Tulsa', 'Tulsa Metro', 1.3],
  ['OK-ETUL', 'CloudChaserz East Tulsa', 'Tulsa', 'Tulsa Metro', 0.95],
  ['OK-JENKS', 'CloudChaserz Jenks', 'Jenks', 'Tulsa Metro', 1.05],
  ['OK-MINGO', 'CloudChaserz Mingo', 'Tulsa', 'Tulsa Metro', 1.2],
  ['OK-MUS', 'CloudChaserz Muskogee', 'Muskogee', 'Oklahoma', 0.7],
  ['OK-OWA', 'CloudChaserz Owasso', 'Owasso', 'Tulsa Metro', 0.9],
  ['OK-SAP', 'CloudChaserz Sapulpa', 'Sapulpa', 'Oklahoma', 0.6],
  ['OK-STUL', 'CloudChaserz South Tulsa', 'Tulsa', 'Tulsa Metro', 1.1],
  ['OK-YALE', 'CloudChaserz Yale', 'Tulsa', 'Tulsa Metro', 0.85]
]

interface MockDistItem {
  item_code: string
  item_name: string
  item_group: string
  uom: string
  barcode: string | null
  image: string | null
  disabled: boolean
  is_stock_item: boolean
  /** HOU-WH's bin */
  on_hand: number
  /** promised to open shipments that have not left the building */
  committed: number
  /** chain-wide units/day; 0 for a product nobody has sold yet */
  velocity: number
  /** false for a brand-new product: no store has it, no store has ever sold it */
  has_history: boolean
}

/** The same ten items the buying mock carries, so the two desks agree about Houston. */
const MOCK_ITEMS: [string, string, string, string, number, number, number][] = [
  ['GB-PULSE-15K-BLUE', 'Geek Bar Pulse 15K — Blue Razz Ice', 'Vape', '8801234500017', 36, 0, 4.2],
  ['LM-MO20K-WM', 'Lost Mary MO20000 — Watermelon', 'Vape', '8801234500024', 18, 0, 3.1],
  ['ELFBAR-BC5K-MANGO', 'Elf Bar BC5000 — Mango', 'Vape', '8801234500031', 120, 24, 2.4],
  ['HYDE-EDGE-4K-GRAPE', 'Hyde Edge Rave 4K — Grape', 'Vape', '8801234500048', 8, 0, 1.8],
  ['PUFF-XXL-MINT', 'Puff Bar XXL — Cool Mint', 'Vape', '8801234500055', 64, 0, 4.6],
  ['RAW-KS-SLIM', 'RAW Classic King Size Slim', 'Papers', '8801234500062', 340, 50, 6.5],
  ['OCB-XPERT-KS', 'OCB X-Pert King Size', 'Papers', '8801234500079', 90, 0, 2.2],
  ['ZIG-ZAG-1-25', 'Zig-Zag 1¼ Rolling Papers', 'Papers', '8801234500086', 410, 0, 3.4],
  ['AF-SHISHA-250-MINT', 'Al Fakher Shisha 250 g — Mint', 'Shisha', '8801234500093', 26, 0, 1.2],
  ['CLIPPER-LTR-ASST', 'Clipper Lighter — Assorted', 'Accessories', '8801234500109', 288, 0, 0]
]

interface MockDistState {
  seq: number
  items: Record<string, MockDistItem>
  /** `${item_code}|${boutique}` → what that store holds. Filled lazily from the stable profile. */
  positions: Record<string, { on_hand: number; velocity: number; ever_sold: boolean }>
  shipments: PushedShipment[]
  requests: PushedRequest[]
}

/** FNV-1a. Stable across runs and platforms — the mock's positions must never move under a test. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function round(value: number, places = 2): number {
  const f = 10 ** places
  return Math.round((value + Number.EPSILON) * f) / f
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshItems(): Record<string, MockDistItem> {
  const out: Record<string, MockDistItem> = {}
  for (const [code, name, group, barcode, onHand, committed, velocity] of MOCK_ITEMS) {
    out[code] = {
      item_code: code,
      item_name: name,
      item_group: group,
      uom: 'Nos',
      barcode,
      image: null,
      disabled: false,
      is_stock_item: true,
      on_hand: onHand,
      committed,
      velocity,
      has_history: true
    }
  }
  return out
}

function fresh(): MockDistState {
  return { seq: 0, items: freshItems(), positions: {}, shipments: [], requests: [] }
}

let state: MockDistState = fresh()

/**
 * One store's position on one item, derived from a stable hash so it is the same on every run and
 * every platform, and so a fresh product's eleven rows are honest zeros rather than invented data.
 *
 * The shape is deliberate: velocity follows the store's size, days of cover vary from thin (a
 * store that needs stock) to fat (one that does not), and roughly one store in seven has never
 * sold the item at all — which is what the *Only stores that stock it* filter is for.
 */
function positionOf(itemCode: string, boutique: string): { on_hand: number; velocity: number; ever_sold: boolean } {
  const key = `${itemCode}|${boutique}`
  const cached = state.positions[key]
  if (cached) return cached
  const item = state.items[itemCode]
  const store = MOCK_STORES.find((s) => s[0] === boutique)
  let position = { on_hand: 0, velocity: 0, ever_sold: false }
  if (item && store && item.has_history) {
    const h = hash(key)
    const sizes = MOCK_STORES.reduce((sum, s) => sum + s[4], 0)
    if (h % 7 === 0) {
      // this store has never carried it — the line between "restock" and "introduce"
      position = { on_hand: 0, velocity: 0, ever_sold: false }
    } else {
      const jitter = 0.65 + ((h >>> 3) % 70) / 100 // 0.65 … 1.34
      const velocity = round((item.velocity * store[4] * jitter) / sizes, 3)
      // days of cover between 3 and 34 — thin stores are what `top up` is for, fat ones are why
      // it can honestly allocate nothing
      const cover = 3 + ((h >>> 11) % 32)
      position = { on_hand: Math.round(velocity * cover), velocity, ever_sold: velocity > 0 }
    }
  }
  state.positions[key] = position
  return position
}

function storeRows(boutiques?: string[] | null): DistributionStore[] {
  const wanted = (boutiques || []).map((b) => (b || '').trim()).filter(Boolean)
  return MOCK_STORES.filter(([code]) => !wanted.length || wanted.includes(code)).map(([boutique, boutique_name, city, region]) => ({
    boutique,
    boutique_name,
    warehouse: `${boutique} - CCZ`,
    company: MOCK_COMPANY,
    city,
    region
  }))
}

function planRows(itemCode: string, stores: DistributionStore[]): PlanStoreRow[] {
  return stores.map((store) => {
    const pos = positionOf(itemCode, store.boutique)
    return {
      ...store,
      on_hand: pos.on_hand,
      velocity: pos.velocity,
      // null, never Infinity — `distribution.store_context` does the same
      cover_days: pos.velocity > 0 ? round(pos.on_hand / pos.velocity, 1) : null,
      ever_sold: pos.ever_sold
    }
  })
}

function findItem(itemCode: string): MockDistItem {
  const item = state.items[(itemCode || '').trim()]
  if (!item) throw new ApiError(`Item ${itemCode || '?'} does not exist`, 'DoesNotExistError', 404)
  return item
}

function nextName(prefix: string): string {
  state.seq += 1
  return `${prefix}-${String(state.seq).padStart(5, '0')}`
}

async function pause(): Promise<void> {
  if (typeof window !== 'undefined' && window.__awanzOffline) throw new ApiError('Offline', 'NETWORK', 0)
  await new Promise((r) => setTimeout(r, 5))
}

function whole(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Whole numbers print whole — a shortfall of 15 reads better than 15.0 (`distribution._n`). */
function n(value: number): string {
  return Math.abs(value - Math.trunc(value)) < 1e-9 ? String(Math.trunc(value)) : String(round(value, 3))
}

export const mockDistribution: DistributionApi = {
  async stores() {
    await pause()
    const rows = storeRows()
    return { stores: rows, count: rows.length, warehouse: MOCK_WAREHOUSE }
  },

  async plan(item_codes, boutiques, days = VELOCITY_DAYS) {
    await pause()
    const codes = [...new Set((item_codes || []).map((c) => (c || '').trim()).filter(Boolean))]
    if (!codes.length) throw new ApiError('Choose at least one item to distribute', 'ValidationError', 417)
    const stores = storeRows(boutiques)
    return {
      warehouse: MOCK_WAREHOUSE,
      velocity_days: Math.max(1, whole(days) || VELOCITY_DAYS),
      as_of: MOCK_NOW,
      stores,
      items: codes.map((code) => {
        const item = findItem(code)
        return {
          item_code: item.item_code,
          item_name: item.item_name,
          item_group: item.item_group,
          uom: item.uom,
          barcode: item.barcode,
          image: item.image,
          disabled: item.disabled,
          is_stock_item: item.is_stock_item,
          on_hand: item.on_hand,
          committed: item.committed,
          available: item.on_hand - item.committed,
          stores: planRows(item.item_code, stores)
        }
      })
    }
  },

  async suggest_split(item_code, qty, mode = 'even', boutiques, cover_days) {
    await pause()
    const item = findItem(item_code)
    if (!SPLIT_MODES.includes(mode as SplitMode)) throw new ApiError(`Unknown split mode ${mode} — choose ${SPLIT_MODES.join(', ')}`, 'ValidationError', 417)
    const rows = planRows(item.item_code, storeRows(boutiques))
    const target = Math.max(1, whole(cover_days) || DEFAULT_COVER_DAYS)
    const allocation = splitFor(mode as SplitMode, qty, rows, target)
    const lines: SplitLine[] = rows.map((row) => ({ ...row, qty: allocation[row.boutique] || 0 }))
    const allocated = lines.reduce((sum, l) => sum + l.qty, 0)
    const available = item.on_hand - item.committed
    return {
      item_code: item.item_code,
      item_name: item.item_name,
      mode,
      qty: Math.max(0, whole(qty)),
      allocated,
      remainder: Math.max(0, whole(qty)) - allocated,
      cover_days: target,
      velocity_days: VELOCITY_DAYS,
      warehouse: MOCK_WAREHOUSE,
      on_hand: item.on_hand,
      committed: item.committed,
      available,
      left_at_warehouse: available - allocated,
      lines
    }
  },

  async send(lines, reason, priority = 'Normal') {
    await pause()
    // merge duplicate (store, item) rows exactly as `_normalise_lines` does
    const merged = new Map<string, DistributionLine>()
    for (const raw of lines || []) {
      const boutique = (raw?.boutique || '').trim()
      const itemCode = (raw?.item_code || '').trim()
      const key = `${boutique}|${itemCode}`
      const seen = merged.get(key)
      if (seen) seen.qty += Number(raw?.qty) || 0
      else merged.set(key, { boutique, item_code: itemCode, qty: Number(raw?.qty) || 0 })
    }
    const rows = [...merged.values()]
    if (!rows.length) throw new ApiError('Nothing to send — choose at least one store and quantity', 'ValidationError', 417)
    if (!PUSH_PRIORITIES.includes(priority as Priority)) {
      throw new ApiError(`Unknown priority ${priority} — choose ${PUSH_PRIORITIES.join(', ')}`, 'ValidationError', 417)
    }

    // ---- validate everything before writing anything (client decision 4) ----
    const shops = new Set(MOCK_STORES.map(([code]) => code))
    const problems: string[] = []
    const seenStores: string[] = []
    const itemCodes: string[] = []
    for (const row of rows) {
      if (!row.boutique) problems.push('A line has no store')
      else if (!shops.has(row.boutique)) problems.push(`Store ${row.boutique} does not exist`)
      else if (!seenStores.includes(row.boutique)) seenStores.push(row.boutique)
      if (!row.item_code) problems.push(`A line for ${row.boutique || '?'} has no item`)
      else if (!state.items[row.item_code]) problems.push(`Item ${row.item_code} does not exist`)
      else if (!state.items[row.item_code].is_stock_item) problems.push(`${row.item_code} is not a stock item and cannot be shipped`)
      else if (state.items[row.item_code].disabled) problems.push(`Item ${row.item_code} is disabled`)
      else if (!itemCodes.includes(row.item_code)) itemCodes.push(row.item_code)
      if (row.qty <= 0) problems.push(`Quantity for ${row.item_code || '?'} at ${row.boutique || '?'} must be more than zero`)
    }
    if (problems.length) {
      throw new ApiError(['This distribution was not sent:', ...[...new Set(problems)].map((p) => `• ${p}`)].join('\n'), 'ValidationError', 417)
    }
    const wanted: Record<string, number> = {}
    for (const row of rows) wanted[row.item_code] = (wanted[row.item_code] || 0) + row.qty
    const shortfalls: string[] = []
    for (const code of Object.keys(wanted).sort()) {
      const item = state.items[code]
      const available = item.on_hand - item.committed
      if (wanted[code] > available + 1e-9) {
        shortfalls.push(`${code} — ${n(wanted[code])} requested, ${n(available)} available, short ${n(wanted[code] - available)}`)
      }
    }
    if (shortfalls.length) {
      throw new ApiError(
        [
          'Houston does not hold enough stock to send this distribution:',
          ...shortfalls.map((s) => `• ${s}`),
          'Nothing was sent — lower the quantities or buy more first.'
        ].join('\n'),
        'ValidationError',
        417
      )
    }

    // ---- write: one request + one shipment per store, in store-code order ----
    const stamped = (reason || '').trim() || 'Warehouse push from Houston'
    const shipments: PushedShipment[] = []
    const requests: PushedRequest[] = []
    for (const boutique of [...seenStores].sort()) {
      const mine = rows.filter((r) => r.boutique === boutique)
      const units = mine.reduce((sum, r) => sum + r.qty, 0)
      const store = MOCK_STORES.find(([code]) => code === boutique)!
      const request = nextName('MRR')
      const shipment = nextName('MSH')
      requests.push({
        name: request,
        boutique,
        boutique_name: store[1],
        status: 'Approved',
        priority,
        warehouse_push: true,
        reason: stamped,
        requested_by: MOCK_USER,
        approved_by: MOCK_USER,
        shipment,
        units,
        items: mine.length
      } as PushedRequest)
      shipments.push({
        name: shipment,
        boutique,
        boutique_name: store[1],
        from_warehouse: MOCK_WAREHOUSE,
        to_warehouse: `${boutique} - CCZ`,
        status: 'Pending',
        priority,
        replenishment_request: request,
        warehouse_push: true,
        items: mine.length,
        units
      } as PushedShipment)
    }
    // the units are now promised to an open shipment — the Bin still counts them, so they move to
    // `committed`, exactly as `committed_qty` reports them on the bench
    for (const [code, qty] of Object.entries(wanted)) state.items[code].committed += qty
    state.shipments.unshift(...shipments)
    state.requests.unshift(...requests)
    return {
      shipments: clone(shipments),
      requests: clone(requests),
      stores: shipments.length,
      units: rows.reduce((sum, r) => sum + r.qty, 0),
      items: itemCodes.length,
      warehouse: MOCK_WAREHOUSE,
      priority,
      reason: stamped
    }
  }
}

/**
 * Register a product with the mock warehouse — what `purchasing.create_product` does on a bench.
 * A brand-new product has nothing on hand at Houston and no history at any store, which is
 * precisely the case v1.1 exists for: no store knows it exists, so none of them will ask for it.
 */
export function __mockRegisterItem(item: {
  item_code: string
  item_name?: string | null
  item_group?: string | null
  uom?: string | null
  barcode?: string | null
  image?: string | null
  on_hand?: number
}): void {
  const code = (item.item_code || '').trim()
  if (!code) return
  state.items[code] = {
    item_code: code,
    item_name: item.item_name || code,
    item_group: item.item_group || 'Products',
    uom: item.uom || 'Nos',
    barcode: item.barcode ?? null,
    image: item.image ?? null,
    disabled: false,
    is_stock_item: true,
    on_hand: Number(item.on_hand) || 0,
    committed: 0,
    velocity: 0,
    has_history: false
  }
}

/** Move HOU-WH's bin — what a Purchase Receipt does. Unknown items are ignored. */
export function __mockSetWarehouseStock(itemCode: string, onHand: number): void {
  const item = state.items[(itemCode || '').trim()]
  if (item) item.on_hand = Math.max(0, Number(onHand) || 0)
}

/** Tests: restore the seeded Houston. */
export function __resetMockDistribution(): void {
  state = fresh()
}

const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const distributionApi: DistributionApi = IS_MOCK ? mockDistribution : frappeDistribution
