/**
 * v1.5 — **a store's own inventory** (`maison_pos/api/store_stock.py`), read by the till's Stock
 * screen (the manager's own store) and by the warehouse desk's Stock board with a store selected.
 * The rows never carry a cost — what Houston paid is not shop-floor information.
 */
import { ApiError } from './types'
import { humanizeServerMessage } from '@/utils/text'

export interface StoreStockRow {
  item_code: string
  item_name: string
  item_group: string | null
  uom: string | null
  image: string | null
  brand: string | null
  barcode: string | null
  concentration: string | null
  size: string | null
  on_hand: number
  in_transit: number
  sold_7: number
  sold_28: number
  reorder_level: number
  low: boolean
  out: boolean
  rate: number
  rate_source: 'Store override' | 'Chain default'
  cover_days: number | null
}

export interface StoreStock {
  boutique: string
  boutique_name: string
  warehouse: string
  price_list: string
  items: StoreStockRow[]
  count: number
  units: number
  low_count: number
  out_count: number
  as_of: string
}

export interface StockAdjusted {
  boutique: string
  item_code: string
  item_name?: string
  before: number
  after: number
  changed: boolean
  stock_reconciliation?: string
}

export type StockFilter = 'all' | 'low' | 'out' | 'moving' | 'idle'

/** The board's filter chips, as pure list logic. `moving` sold in 28 days; `idle` has stock that did not. */
export function filterStoreStock(rows: StoreStockRow[], opts: { q?: string; group?: string; filter?: StockFilter }): StoreStockRow[] {
  const needle = (opts.q || '').trim().toLowerCase()
  return rows.filter((r) => {
    if (opts.group && r.item_group !== opts.group) return false
    if (opts.filter === 'low' && !r.low && !(r.out && r.sold_28 > 0)) return false
    if (opts.filter === 'out' && !r.out) return false
    if (opts.filter === 'moving' && !(r.sold_28 > 0)) return false
    if (opts.filter === 'idle' && !(r.on_hand > 0 && r.sold_28 <= 0)) return false
    if (needle && !`${r.item_name} ${r.item_code} ${r.barcode || ''} ${r.brand || ''} ${r.item_group || ''}`.toLowerCase().includes(needle)) return false
    return true
  })
}

export function storeStockGroups(rows: StoreStockRow[]): string[] {
  return [...new Set(rows.map((r) => r.item_group).filter((g): g is string => !!g))].sort()
}

/** Totals for the header: SKUs, units, low, out-and-selling, retail value on the shelf. */
export function storeStockTotals(rows: StoreStockRow[]): { items: number; units: number; low: number; out: number; retail: number } {
  return rows.reduce(
    (t, r) => {
      t.items += 1
      t.units += r.on_hand
      if (r.low) t.low += 1
      if (r.out && r.sold_28 > 0) t.out += 1
      t.retail += r.on_hand * r.rate
      return t
    },
    { items: 0, units: 0, low: 0, out: 0, retail: 0 }
  )
}

/** Sort: what needs attention first (out and selling, then low), then by name. */
export function sortStoreStock(rows: StoreStockRow[]): StoreStockRow[] {
  const rank = (r: StoreStockRow) => (r.out && r.sold_28 > 0 ? 0 : r.low ? 1 : 2)
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.item_name.localeCompare(b.item_name))
}

export interface StoreStockApi {
  stock(boutique?: string, q?: string, limit?: number): Promise<StoreStock>
  adjust(boutique: string, item_code: string, qty: number, reason: string): Promise<StockAdjusted>
}

// ---------------------------------------------------------------------------------------------
// Frappe
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.store_stock.'

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

export const frappeStoreStock: StoreStockApi = {
  stock: (boutique, q, limit = 1000) => call('store_stock', { boutique, q, limit }, true),
  adjust: (boutique, item_code, qty, reason) => call('adjust_store_stock', { boutique, item_code, qty, reason })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests)
// ---------------------------------------------------------------------------------------------
const MOCK_STORES: Record<string, { name: string; warehouse: string }> = {
  'HOU-MTR': { name: 'CloudChaserz Montrose', warehouse: 'HOU-MTR - CC' },
  'OK-BIX': { name: 'CloudChaserz Bixby', warehouse: 'OK-BIX - CC' }
}

const mockRows: Record<string, StoreStockRow[]> = {
  'HOU-MTR': [
    { item_code: 'SOA-0001', item_name: 'Royal Oud EDP 100 ml', item_group: 'Oud & Oils', uom: 'Nos', image: null, brand: 'Arabian Oud', barcode: '6291100000010', concentration: 'EDP', size: '100 ml', on_hand: 2, in_transit: 6, sold_7: 3, sold_28: 11, reorder_level: 4, low: true, out: false, rate: 189, rate_source: 'Chain default', cover_days: 5.1 },
    { item_code: 'SOA-0002', item_name: 'Sauvage EDT 100 ml', item_group: 'Designer Fragrance', uom: 'Nos', image: null, brand: 'Dior', barcode: '3348901250412', concentration: 'EDT', size: '100 ml', on_hand: 0, in_transit: 0, sold_7: 2, sold_28: 9, reorder_level: 3, low: true, out: true, rate: 129, rate_source: 'Store override', cover_days: 0 },
    { item_code: 'SOA-0003', item_name: 'Amber Nights gift set', item_group: 'Gift Sets', uom: 'Nos', image: null, brand: null, barcode: null, concentration: 'Gift Set', size: null, on_hand: 14, in_transit: 0, sold_7: 0, sold_28: 0, reorder_level: 0, low: false, out: false, rate: 79, rate_source: 'Chain default', cover_days: null },
    { item_code: 'SOA-0004', item_name: 'Musk Tahara oil 12 ml', item_group: 'Oud & Oils', uom: 'Nos', image: null, brand: null, barcode: null, concentration: 'Perfume Oil', size: '12 ml', on_hand: 22, in_transit: 0, sold_7: 5, sold_28: 18, reorder_level: 6, low: false, out: false, rate: 24, rate_source: 'Chain default', cover_days: 34.2 }
  ],
  'OK-BIX': [{ item_code: 'SOA-0001', item_name: 'Royal Oud EDP 100 ml', item_group: 'Oud & Oils', uom: 'Nos', image: null, brand: 'Arabian Oud', barcode: '6291100000010', concentration: 'EDP', size: '100 ml', on_hand: 7, in_transit: 0, sold_7: 1, sold_28: 4, reorder_level: 4, low: false, out: false, rate: 199, rate_source: 'Store override', cover_days: 49 }]
}

function summary(boutique: string, items: StoreStockRow[]): StoreStock {
  const s = MOCK_STORES[boutique]
  return { boutique, boutique_name: s.name, warehouse: s.warehouse, price_list: 'Standard Selling', items: JSON.parse(JSON.stringify(items)), count: items.length, units: items.reduce((n, r) => n + r.on_hand, 0), low_count: items.filter((r) => r.low).length, out_count: items.filter((r) => r.out && r.sold_28 > 0).length, as_of: new Date().toISOString() }
}

export const mockStoreStock: StoreStockApi = {
  async stock(boutique = 'HOU-MTR', q) {
    if (!MOCK_STORES[boutique]) throw new ApiError(`Store ${boutique} does not exist`, 'DoesNotExistError', 404)
    const rows = mockRows[boutique] || []
    return summary(boutique, q ? filterStoreStock(rows, { q }) : rows)
  },
  async adjust(boutique, item_code, qty, reason) {
    if (!MOCK_STORES[boutique]) throw new ApiError(`Store ${boutique} does not exist`, 'DoesNotExistError', 404)
    if (!(reason || '').trim()) throw new ApiError('Say why the quantity is being corrected — it goes on the stock ledger', 'MandatoryError', 417)
    if (qty < 0) throw new ApiError('Quantity cannot be negative', 'ValidationError', 417)
    const row = (mockRows[boutique] || []).find((r) => r.item_code === item_code)
    if (!row) throw new ApiError(`Item ${item_code} does not exist`, 'DoesNotExistError', 404)
    const before = row.on_hand
    if (before === qty) return { boutique, item_code, before, after: before, changed: false }
    row.on_hand = qty
    row.out = qty <= 0
    row.low = !!row.reorder_level && qty <= row.reorder_level
    row.cover_days = row.sold_28 > 0 ? Math.round((qty / (row.sold_28 / 28)) * 10) / 10 : null
    return { boutique, item_code, item_name: row.item_name, before, after: qty, changed: true, stock_reconciliation: `MAT-RECO-${String(Date.now()).slice(-5)}` }
  }
}

const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const storeStockApi: StoreStockApi = IS_MOCK ? mockStoreStock : frappeStoreStock
