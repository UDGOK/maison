/**
 * v0.6 O/P — store receiving + warehouse & shipping API.
 *
 *   - POS side (store manager / associate): `inventory.replenish`, `inventory.replenishment_requests`,
 *     `inventory.inbound`, `inventory.receive_shipment`, `inventory.receive_po`;
 *   - warehouse admin (`/warehouse`, `/warehouse-wall`): `shipping.*` (wall, approve / reject, pick, pack,
 *     rates, buy, ship, discrepancies, warehouse stock, vendor POs).
 *
 * The mock (VITE_MOCK=1) keeps a small in-memory supply chain so both screens work without a bench.
 */
import { ApiError } from './types'
import { stripHtml } from '@/utils/text'

// ---------------------------------------------------------------------------------------------
// types (mirror maison_pos.api.shipping.{request_dict, shipment_dict, discrepancy_dict})
// ---------------------------------------------------------------------------------------------
export type RequestStatus = 'Pending Approval' | 'Approved' | 'Rejected'
export type ShipmentStatus = 'Pending' | 'Picking' | 'Packed' | 'Shipped' | 'Received' | 'Cancelled'
export type Priority = 'Normal' | 'Low stock' | 'Urgent'

export interface RequestLine {
  item_code: string
  item_name?: string
  qty: number
  approved_qty: number
  on_hand_store?: number
  on_hand_warehouse?: number
  stock_alert?: string | null
  barcode?: string | null
}

export interface ReplenishmentRequest {
  name: string
  boutique: string
  boutique_name?: string
  to_warehouse: string
  from_warehouse: string
  status: RequestStatus
  priority: Priority | string
  reason?: string | null
  rejection_reason?: string | null
  requested_by?: string
  requested_at?: string | null
  approved_by?: string | null
  approved_at?: string | null
  material_request?: string | null
  shipment?: string | null
  units: number
  units_approved: number
  items: number
  lines: RequestLine[]
  /** wall only */
  kind?: 'request'
  age_seconds?: number
}

export interface ShipmentLine {
  item_code: string
  item_name?: string
  barcode?: string | null
  qty: number
  picked_qty: number
  shipped_qty: number
  received_qty: number
  damaged_qty: number
  short_qty: number
  over_qty: number
  bin_location?: string | null
  weight_per_unit?: number
  uom?: string
}

export interface Parcel {
  length: number
  width: number
  height: number
  weight: number
}

export interface Shipment {
  name: string
  boutique: string
  boutique_name?: string
  from_warehouse: string
  transit_warehouse?: string | null
  to_warehouse: string
  status: ShipmentStatus
  priority?: Priority | string
  replenishment_request?: string | null
  material_request?: string | null
  created_by?: string
  items: number
  units: number
  units_picked: number
  units_received: number
  parcels: Parcel[]
  packages: number
  total_weight: number
  est_weight: number
  est_dims: [number, number, number]
  provider?: string | null
  carrier?: string | null
  service?: string | null
  rate_amount?: number
  rate_days?: number | null
  provider_rate_id?: string | null
  label_url?: string | null
  tracking_no?: string | null
  tracking_url?: string | null
  tracking_status?: string | null
  tracking_updated_at?: string | null
  stock_entry_ship?: string | null
  stock_entry_receive?: string | null
  stock_entry_damaged?: string | null
  created_at?: string | null
  approved_at?: string | null
  picking_at?: string | null
  packed_at?: string | null
  label_at?: string | null
  shipped_at?: string | null
  received_at?: string | null
  age_seconds: number
  notes?: string | null
  packing_list_url: string
  lines?: ShipmentLine[]
  /** wall only */
  kind?: 'shipment'
}

export interface Address {
  name: string
  company?: string
  street1: string
  street2?: string
  city: string
  state: string
  zip: string
  country: string
  phone?: string
  email?: string
}

export interface ShipmentDetail extends Shipment {
  lines: ShipmentLine[]
  ship_to: Address
  ship_from: Address
  rate_options: Rate[]
}

export interface Rate {
  carrier: string
  service: string
  amount: number
  days: number | null
  provider_rate_id: string
  provider: string
  currency?: string
  attributes?: string[]
  estimated_delivery?: string | null
}

export interface RatesResult {
  shipment: string
  provider: string
  test_mode: boolean
  prefer: 'cheapest' | 'fastest'
  rates: Rate[]
  selected: Rate | null
  cheapest: string | null
  fastest: string | null
  parcels: Parcel[]
  ship_to: Address
  ship_from: Address
}

export interface Label {
  label_url: string
  tracking_no: string
  tracking_url?: string | null
  provider: string
  carrier: string
  service: string
  amount: number
}

export interface Discrepancy {
  name: string
  shipment: string
  boutique: string
  item_code: string
  item_name?: string
  type: 'Short' | 'Damaged' | 'Over'
  status: 'Open' | 'Resolved'
  shipped_qty: number
  received_qty: number
  damaged_qty: number
  short_qty: number
  over_qty: number
  reported_by?: string
  reported_at?: string | null
  resolution?: string | null
  resolved_by?: string | null
  resolved_at?: string | null
  stock_entry?: string | null
  notes?: string | null
}

export type WallColumn = 'pending_approval' | 'to_pick' | 'packing' | 'ready' | 'shipped_today'
export const WALL_COLUMNS: { key: WallColumn; label: string }[] = [
  { key: 'pending_approval', label: 'Pending approval' },
  { key: 'to_pick', label: 'To pick' },
  { key: 'packing', label: 'Packing' },
  { key: 'ready', label: 'Ready to ship' },
  { key: 'shipped_today', label: 'Shipped today' }
]

export interface WallData {
  columns: Record<WallColumn, (ReplenishmentRequest | Shipment)[]>
  counts: Record<WallColumn, number>
  warn_seconds: number
  crit_seconds: number
  sound_enabled: boolean
  auto_print_packing_list: boolean
  auto_print_label: boolean
  provider: string
  in_transit: number
  received_today: number
  open_discrepancies: number
  server_time: string
}

export interface WallEvent {
  event: string
  shipment?: string | null
  request?: string
  boutique?: string
  priority?: string
  print_packing_list?: boolean
  print_label?: boolean
  label_url?: string
  ts: string
  discrepancies?: string[]
}

export interface WarehouseMe {
  user: string
  full_name?: string
  roles: string[]
  warehouse_admin: boolean
  supply_unrestricted: boolean
  boutique?: string | null
  main_warehouse?: string | null
  warehouse_boutique?: string | null
  brand: { brand_name: string; wordmark_text: string; product_name: string; [k: string]: unknown }
  provider: string
  stores: string[]
}

export interface PickListLine {
  item_code: string
  item_name?: string
  barcode?: string | null
  qty: number
  picked_qty: number
  bin_location?: string | null
  on_hand: number
  image?: string | null
}
export interface PickList {
  shipment: string
  boutique: string
  boutique_name?: string
  from_warehouse: string
  status: ShipmentStatus
  lines: PickListLine[]
}

export interface WarehouseStockRow {
  item_code: string
  item_name?: string
  item_group?: string
  barcode?: string | null
  image?: string | null
  actual_qty: number
  reserved_qty: number
  projected_qty: number
  reorder_level: number
  low: boolean
}

export interface PurchaseOrderItem {
  name: string
  item_code: string
  item_name?: string
  qty: number
  received_qty: number
  pending_qty: number
  warehouse?: string
  barcode?: string
}
export interface PurchaseOrder {
  name: string
  supplier: string
  supplier_name?: string
  transaction_date?: string | null
  schedule_date?: string | null
  set_warehouse?: string
  status: string
  per_received: number
  items: PurchaseOrderItem[]
}

export interface Inbound {
  boutique: string
  warehouse: string
  shipments: Shipment[]
  preparing: { name: string; status: ShipmentStatus; priority?: string; creation: string; carrier?: string | null; service?: string | null }[]
  purchase_orders: PurchaseOrder[]
  recent: Shipment[]
  open_requests: number
  as_of: string
}

export interface ReceiveResult extends Shipment {
  stock_entry_receive?: string | null
  stock_entry_damaged?: string | null
  discrepancies: string[]
  final: boolean
}

export interface ReceiveLine {
  item_code: string
  received_qty: number
  damaged_qty?: number
}

export interface WarehouseApi {
  store: {
    replenish(args: { boutique: string; lines?: { item_code: string; qty: number; alert?: string | null }[]; item?: string; qty?: number; alert?: string | null; reason?: string; priority?: string }): Promise<{ request: ReplenishmentRequest; material_request: string | null; name: string }>
    requests(boutique: string, status?: string, limit?: number): Promise<{ requests: ReplenishmentRequest[]; count: number }>
    inbound(boutique: string): Promise<Inbound>
    receive_shipment(args: { shipment: string; lines: ReceiveLine[]; final?: 0 | 1; device_id?: string; notes?: string }): Promise<ReceiveResult>
    receive_po(args: { po: string; lines: { item_code?: string; name?: string; qty: number }[]; boutique: string }): Promise<{ purchase_receipt: string; purchase_order: string; lines: { item_code: string; qty: number; warehouse: string }[] }>
    shipment(name: string): Promise<ShipmentDetail>
  }
  admin: {
    me(): Promise<WarehouseMe>
    wall(): Promise<WallData>
    requests(status?: string, boutique?: string): Promise<{ requests: ReplenishmentRequest[]; count: number; scope?: string }>
    request_detail(name: string): Promise<ReplenishmentRequest>
    approve(request: string, lines?: { item_code: string; approved_qty: number }[], notes?: string): Promise<{ request: ReplenishmentRequest; shipment: Shipment }>
    reject(request: string, reason: string): Promise<{ request: ReplenishmentRequest }>
    shipments(status?: string, boutique?: string, with_lines?: 0 | 1): Promise<{ shipments: Shipment[]; count: number }>
    shipment(name: string): Promise<ShipmentDetail>
    pick_list(name: string): Promise<PickList>
    pick(name: string, lines?: { item_code: string; picked_qty: number }[]): Promise<Shipment>
    pack(name: string, lines?: { item_code: string; picked_qty: number }[], parcels?: Parcel[]): Promise<Shipment>
    rates(name: string, prefer?: 'cheapest' | 'fastest'): Promise<RatesResult>
    buy(name: string, rate_id?: string | null, prefer?: 'cheapest' | 'fastest'): Promise<Shipment & { label: Label }>
    ship(name: string): Promise<Shipment>
    mark(name: string, status: ShipmentStatus): Promise<Shipment>
    track(name: string): Promise<{ shipment: string; tracking_no: string | null; status: string | null; events: { status?: string; at?: string; location?: string; description?: string }[]; error?: string }>
    discrepancies(status?: string, boutique?: string): Promise<{ discrepancies: Discrepancy[]; count: number }>
    resolve_discrepancy(name: string, resolution: 'Write off' | 'Returned to warehouse' | 'Re-ship' | 'Accepted', notes?: string): Promise<Discrepancy & { reship_request?: string | null }>
    warehouse_stock(q?: string, limit?: number): Promise<{ warehouse: string; rows: WarehouseStockRow[]; total: number; low: number }>
    vendor_pos(): Promise<{ warehouse: string; purchase_orders: PurchaseOrder[] }>
    receive_vendor_po(po: string, lines: { item_code?: string; name?: string; qty: number }[]): Promise<{ purchase_receipt: string; purchase_order: string; lines: { item_code: string; qty: number; warehouse: string }[] }>
  }
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
        message = stripHtml((JSON.parse(body._server_messages) as string[]).map((m) => JSON.parse(m).message).join('\n'))
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = stripHtml(String(body.exception).split('\n').pop()) || message
    throw new ApiError(message, res.status === 401 || res.status === 403 ? 'AUTH' : body?.exc_type || `HTTP_${res.status}`, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappeWarehouse: WarehouseApi = {
  store: {
    replenish: (args) => call('inventory.replenish', { ...args }),
    requests: (boutique, status = 'all', limit = 50) => call('inventory.replenishment_requests', { boutique, status, limit }, true),
    inbound: (boutique) => call('inventory.inbound', { boutique }, true),
    receive_shipment: (args) => call('inventory.receive_shipment', { final: 1, ...args }),
    receive_po: (args) => call('inventory.receive_po', { ...args }),
    shipment: (name) => call('shipping.shipment', { shipment: name }, true)
  },
  admin: {
    me: () => call('shipping.me', {}, true),
    wall: () => call('shipping.wall', {}, true),
    requests: (status = 'open', boutique) => call('shipping.requests_list', { status, boutique }, true),
    request_detail: (name) => call('shipping.request_detail', { request: name }, true),
    approve: (request, lines, notes) => call('shipping.approve', { request, lines, notes }),
    reject: (request, reason) => call('shipping.reject', { request, reason }),
    shipments: (status = 'open', boutique, with_lines = 0) => call('shipping.shipments', { status, boutique, with_lines }, true),
    shipment: (name) => call('shipping.shipment', { shipment: name }, true),
    pick_list: (name) => call('shipping.pick_list', { shipment: name }, true),
    pick: (name, lines) => call('shipping.pick', { shipment: name, lines }),
    pack: (name, lines, parcels) => call('shipping.pack', { shipment: name, lines, parcels }),
    rates: (name, prefer = 'cheapest') => call('shipping.rates', { shipment: name, prefer }),
    buy: (name, rate_id, prefer = 'cheapest') => call('shipping.buy', { shipment: name, rate_id: rate_id || undefined, prefer }),
    ship: (name) => call('shipping.ship', { shipment: name }),
    mark: (name, status) => call('shipping.mark', { shipment: name, status }),
    track: (name) => call('shipping.track', { shipment: name }),
    discrepancies: (status = 'Open', boutique) => call('shipping.discrepancies', { status, boutique }, true),
    resolve_discrepancy: (name, resolution, notes) => call('shipping.resolve_discrepancy', { discrepancy: name, resolution, notes }),
    warehouse_stock: (q, limit = 300) => call('shipping.warehouse_stock', { q, limit }, true),
    vendor_pos: () => call('shipping.vendor_pos', {}, true),
    receive_vendor_po: (po, lines) => call('shipping.receive_vendor_po', { po, lines })
  }
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests) — deterministic, in memory
// ---------------------------------------------------------------------------------------------
interface MockState {
  seq: number
  requests: ReplenishmentRequest[]
  shipments: ShipmentDetail[]
  discrepancies: Discrepancy[]
  pos: PurchaseOrder[]
  stock: Record<string, number>
  listeners: ((e: WallEvent) => void)[]
}

const MOCK_STORES: Record<string, { name: string; warehouse: string; city: string; state: string; zip: string; street: string }> = {
  'HOU-MTR': { name: 'CloudChaserz Montrose', warehouse: 'HOU-MTR - CCZ', city: 'Houston', state: 'TX', zip: '77098', street: '2037 W Alabama St' },
  'OK-BIX': { name: 'CloudChaserz Bixby', warehouse: 'OK-BIX - CCZ', city: 'Tulsa', state: 'OK', zip: '74133', street: '11063-B S Memorial Dr' },
  'OK-JENKS': { name: 'CloudChaserz Jenks', warehouse: 'OK-JENKS - CCZ', city: 'Jenks', state: 'OK', zip: '74037', street: '541 W Main St' },
  'CHI-OAK': { name: 'Oak Street', warehouse: 'CHI-OAK - MSN', city: 'Chicago', state: 'IL', zip: '60611', street: '110 E Oak St' },
  'NYC-5AV': { name: 'Fifth Avenue', warehouse: 'NYC-5AV - MSN', city: 'New York', state: 'NY', zip: '10022', street: '745 Fifth Ave' },
  'MIA-DD': { name: 'Design District', warehouse: 'MIA-DD - MSN', city: 'Miami', state: 'FL', zip: '33137', street: '140 NE 39th St' }
}
const MOCK_WAREHOUSE = 'HOU-WH - CCZ'
const MOCK_ITEMS: Record<string, { name: string; weight: number }> = {
  'GB-PULSE-15K-BLUE': { name: 'Geek Bar Pulse 15K — Blue Razz Ice', weight: 0.06 },
  'LM-MO20K-WM': { name: 'Lost Mary MO20000 — Watermelon', weight: 0.07 },
  'RAW-KS-SLIM': { name: 'RAW Classic King Size Slim', weight: 0.03 },
  'AF-SHISHA-250-MINT': { name: 'Al Fakher Shisha 250 g — Mint', weight: 0.3 },
  'AC-012': { name: 'Jewellery cloth', weight: 0.05 },
  'AC-001': { name: 'Ring sizer', weight: 0.1 }
}

const FROM: Address = { name: 'CloudChaserz Main Warehouse', company: 'CloudChaserz', street1: '2037 W Alabama St', street2: '', city: 'Houston', state: 'TX', zip: '77098', country: 'US', phone: '(281) 974-3712', email: 'warehouse@cloudchaserz.example' }

function addrFor(code: string): Address {
  const s = MOCK_STORES[code] || { name: code, warehouse: `${code} - CCZ`, city: 'Tulsa', state: 'OK', zip: '74133', street: '1 Main St' }
  return { name: s.name, company: s.name, street1: s.street, street2: '', city: s.city, state: s.state, zip: s.zip, country: 'US', phone: '', email: '' }
}

function fresh(): MockState {
  const now = Date.now()
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
  const mkReq = (i: number, boutique: string, lines: [string, number][], priority: Priority, ageMin: number): ReplenishmentRequest => ({
    name: `MRR-${String(i).padStart(5, '0')}`,
    boutique,
    boutique_name: MOCK_STORES[boutique]?.name || boutique,
    to_warehouse: MOCK_STORES[boutique]?.warehouse || `${boutique} - CCZ`,
    from_warehouse: MOCK_WAREHOUSE,
    status: 'Pending Approval',
    priority,
    reason: null,
    rejection_reason: null,
    requested_by: `${boutique.toLowerCase()}.manager@cloudchaserz.example`,
    requested_at: iso(ageMin * 60_000),
    approved_by: null,
    approved_at: null,
    material_request: `MAT-MR-${String(i).padStart(5, '0')}`,
    shipment: null,
    units: lines.reduce((s, l) => s + l[1], 0),
    units_approved: lines.reduce((s, l) => s + l[1], 0),
    items: lines.length,
    lines: lines.map(([item_code, qty]) => ({ item_code, item_name: MOCK_ITEMS[item_code]?.name || item_code, qty, approved_qty: qty, on_hand_store: 1, on_hand_warehouse: 120, stock_alert: priority === 'Low stock' ? `MSA-${i}` : null, barcode: `0${i}${item_code.length}` }))
  })
  const state: MockState = {
    seq: 10,
    requests: [mkReq(1, 'OK-BIX', [['GB-PULSE-15K-BLUE', 24], ['LM-MO20K-WM', 12]], 'Low stock', 35), mkReq(2, 'OK-JENKS', [['RAW-KS-SLIM', 50]], 'Normal', 5 * 60), mkReq(3, 'HOU-MTR', [['AF-SHISHA-250-MINT', 10]], 'Normal', 26 * 60)],
    shipments: [],
    discrepancies: [],
    pos: [
      {
        name: 'PUR-ORD-2026-00041',
        supplier: 'Geek Bar Distribution',
        supplier_name: 'Geek Bar Distribution',
        transaction_date: new Date(now - 5 * 864e5).toISOString().slice(0, 10),
        schedule_date: new Date().toISOString().slice(0, 10),
        set_warehouse: MOCK_WAREHOUSE,
        status: 'To Receive and Bill',
        per_received: 0,
        items: [
          { name: 'poi-1', item_code: 'GB-PULSE-15K-BLUE', item_name: MOCK_ITEMS['GB-PULSE-15K-BLUE'].name, qty: 200, received_qty: 0, pending_qty: 200, warehouse: MOCK_WAREHOUSE, barcode: '0111' },
          { name: 'poi-2', item_code: 'LM-MO20K-WM', item_name: MOCK_ITEMS['LM-MO20K-WM'].name, qty: 100, received_qty: 0, pending_qty: 100, warehouse: MOCK_WAREHOUSE, barcode: '0222' }
        ]
      }
    ],
    stock: { 'GB-PULSE-15K-BLUE': 140, 'LM-MO20K-WM': 60, 'RAW-KS-SLIM': 400, 'AF-SHISHA-250-MINT': 8, 'AC-012': 30, 'AC-001': 12 },
    listeners: []
  }
  // two shipments already under way for the wall
  const s1 = mockShipment(state, mkReq(4, 'OK-BIX', [['GB-PULSE-15K-BLUE', 40]], 'Low stock', 3 * 60), 3 * 3600_000)
  s1.status = 'Picking'
  s1.picking_at = iso(40 * 60_000)
  s1.lines.forEach((l) => (l.picked_qty = 20))
  const s2 = mockShipment(state, mkReq(5, 'HOU-MTR', [['RAW-KS-SLIM', 100], ['AF-SHISHA-250-MINT', 6]], 'Normal', 8 * 60), 7 * 3600_000)
  s2.status = 'Packed'
  s2.packed_at = iso(60 * 60_000)
  s2.lines.forEach((l) => (l.picked_qty = l.qty))
  const s3 = mockShipment(state, mkReq(6, 'OK-JENKS', [['LM-MO20K-WM', 30]], 'Normal', 30 * 60), 28 * 3600_000)
  s3.status = 'Packed'
  s3.lines.forEach((l) => (l.picked_qty = l.qty))
  s3.carrier = 'USPS'
  s3.service = 'Priority Mail'
  s3.rate_amount = 18.4
  s3.rate_days = 2
  s3.label_url = '/shipping-label/9400MOCK0003'
  s3.tracking_no = '9400MOCK0003'
  s3.label_at = iso(10 * 60_000)
  const s4 = mockShipment(state, mkReq(7, 'OK-BIX', [['RAW-KS-SLIM', 25]], 'Normal', 50 * 60), 48 * 3600_000)
  s4.status = 'Shipped'
  s4.carrier = 'UPS'
  s4.service = 'Ground'
  s4.rate_amount = 22.1
  s4.rate_days = 3
  s4.label_url = '/shipping-label/1ZMOCK0004'
  s4.tracking_no = '1ZMOCK0004'
  s4.tracking_status = 'IN_TRANSIT'
  s4.shipped_at = iso(2 * 3600_000)
  s4.lines.forEach((l) => ((l.picked_qty = l.qty), (l.shipped_qty = l.qty)))
  s4.stock_entry_ship = 'MAT-STE-2026-00410'
  return state
}

function mockShipment(state: MockState, req: ReplenishmentRequest, ageMs: number): ShipmentDetail {
  state.seq += 1
  const name = `MSH-${String(state.seq).padStart(5, '0')}`
  req.status = 'Approved'
  req.shipment = name
  req.approved_at = new Date(Date.now() - ageMs).toISOString()
  const lines: ShipmentLine[] = req.lines
    .filter((l) => l.approved_qty > 0)
    .map((l, i) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      barcode: l.barcode || l.item_code,
      qty: l.approved_qty,
      picked_qty: 0,
      shipped_qty: 0,
      received_qty: 0,
      damaged_qty: 0,
      short_qty: 0,
      over_qty: 0,
      bin_location: `${'ABCDEF'[i % 6]}-${String((i * 7) % 12 + 1).padStart(2, '0')}-${(i % 4) + 1}`,
      weight_per_unit: MOCK_ITEMS[l.item_code]?.weight || 0.15,
      uom: 'Nos'
    }))
  const weight = Math.round((lines.reduce((s, l) => s + (l.weight_per_unit || 0.15) * l.qty, 0) + 0.35) * 1000) / 1000
  const sh: ShipmentDetail = {
    name,
    boutique: req.boutique,
    boutique_name: req.boutique_name,
    from_warehouse: MOCK_WAREHOUSE,
    transit_warehouse: `${req.boutique} In Transit - CCZ`,
    to_warehouse: req.to_warehouse,
    status: 'Pending',
    priority: req.priority,
    replenishment_request: req.name,
    material_request: req.material_request,
    created_by: 'warehouse@cloudchaserz.example',
    items: lines.length,
    units: lines.reduce((s, l) => s + l.qty, 0),
    units_picked: 0,
    units_received: 0,
    parcels: [],
    packages: 0,
    total_weight: 0,
    est_weight: weight,
    est_dims: [40, 30, 25],
    age_seconds: Math.round(ageMs / 1000),
    created_at: req.approved_at,
    approved_at: req.approved_at,
    packing_list_url: `/printview?doctype=Maison%20Shipment&name=${name}&format=Maison%20Packing%20List&no_letterhead=1`,
    lines,
    ship_to: addrFor(req.boutique),
    ship_from: FROM,
    rate_options: []
  }
  state.shipments.push(sh)
  return sh
}

let state: MockState = fresh()

function emit(e: Omit<WallEvent, 'ts'>) {
  const ev = { ...e, ts: new Date().toISOString() } as WallEvent
  for (const l of state.listeners) l(ev)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('maison-mock-wall', { detail: ev }))
}

async function guard() {
  if (typeof window !== 'undefined' && window.__maisonOffline) throw new ApiError('Offline', 'NETWORK', 0)
  await new Promise((r) => setTimeout(r, 15))
}

function refreshDerived(sh: ShipmentDetail) {
  sh.units_picked = sh.lines.reduce((s, l) => s + l.picked_qty, 0)
  sh.units_received = sh.lines.reduce((s, l) => s + l.received_qty, 0)
  sh.age_seconds = sh.approved_at ? Math.round((Date.now() - new Date(sh.approved_at).getTime()) / 1000) : 0
  sh.packages = sh.parcels.length
  sh.total_weight = Math.round(sh.parcels.reduce((s, p) => s + p.weight, 0) * 1000) / 1000
}

function strip(sh: ShipmentDetail, withLines = true): Shipment {
  refreshDerived(sh)
  const rest = { ...sh } as Partial<ShipmentDetail>
  delete rest.ship_to
  delete rest.ship_from
  delete rest.rate_options
  delete rest.lines
  return withLines ? ({ ...rest, lines: sh.lines.map((l) => ({ ...l })) } as Shipment) : (rest as Shipment)
}

function findShipment(name: string): ShipmentDetail {
  const sh = state.shipments.find((s) => s.name === name)
  if (!sh) throw new ApiError(`Maison Shipment ${name} not found`, 'DoesNotExistError', 404)
  return sh
}
function findRequest(name: string): ReplenishmentRequest {
  const r = state.requests.find((s) => s.name === name)
  if (!r) throw new ApiError(`Maison Replenishment Request ${name} not found`, 'DoesNotExistError', 404)
  return r
}

/** Realistic simulated tiers (same shape as the Simulated provider on the server). */
export function mockRates(to: Address, weightKg: number): Rate[] {
  const lb = Math.max(1, Math.ceil(weightKg * 2.20462))
  const zone = to.state === 'TX' ? 2 : to.state === 'OK' ? 3 : to.state === 'IL' ? 5 : 7
  const f = (base: number, perLb: number, z: number) => Math.round((base + perLb * lb + z * zone) * 100) / 100
  return [
    { carrier: 'USPS', service: 'Ground Advantage', amount: f(6.9, 0.55, 0.45), days: 3 + Math.ceil(zone / 3), provider_rate_id: `sim_usps_ga_${lb}`, provider: 'simulated', attributes: ['CHEAPEST'] },
    { carrier: 'USPS', service: 'Priority Mail', amount: f(9.35, 0.85, 0.7), days: zone <= 3 ? 1 : 2, provider_rate_id: `sim_usps_pm_${lb}`, provider: 'simulated', attributes: [] },
    { carrier: 'UPS', service: 'Ground', amount: f(9.9, 0.7, 0.9), days: zone <= 3 ? 2 : zone <= 5 ? 3 : 4, provider_rate_id: `sim_ups_gr_${lb}`, provider: 'simulated', attributes: [] },
    { carrier: 'FedEx', service: 'Home Delivery', amount: f(10.4, 0.72, 0.95), days: zone <= 3 ? 2 : zone <= 5 ? 3 : 4, provider_rate_id: `sim_fedex_hd_${lb}`, provider: 'simulated', attributes: [] },
    { carrier: 'UPS', service: 'Next Day Air Saver', amount: f(38, 2.1, 2.2), days: 1, provider_rate_id: `sim_ups_nda_${lb}`, provider: 'simulated', attributes: ['FASTEST'] }
  ]
}

export function pickRate(rates: Rate[], prefer: 'cheapest' | 'fastest' = 'cheapest'): Rate | null {
  if (!rates.length) return null
  const by = prefer === 'fastest' ? (a: Rate, b: Rate) => (a.days ?? 99) - (b.days ?? 99) || a.amount - b.amount : (a: Rate, b: Rate) => a.amount - b.amount || (a.days ?? 99) - (b.days ?? 99)
  return [...rates].sort(by)[0]
}

export const mockWarehouse: WarehouseApi = {
  store: {
    async replenish(args) {
      await guard()
      const lines = [...(args.lines || [])]
      if (args.item) lines.push({ item_code: args.item, qty: args.qty || 1, alert: args.alert })
      if (!lines.length) throw new ApiError('No valid lines', 'ValidationError', 417)
      state.seq += 1
      const priority = (args.priority as Priority) || (lines.some((l) => l.alert) ? 'Low stock' : 'Normal')
      const req: ReplenishmentRequest = {
        name: `MRR-${String(state.seq).padStart(5, '0')}`,
        boutique: args.boutique,
        boutique_name: MOCK_STORES[args.boutique]?.name || args.boutique,
        to_warehouse: MOCK_STORES[args.boutique]?.warehouse || `${args.boutique} - CCZ`,
        from_warehouse: MOCK_WAREHOUSE,
        status: 'Pending Approval',
        priority,
        reason: args.reason || null,
        rejection_reason: null,
        requested_by: 'manager@cloudchaserz.example',
        requested_at: new Date().toISOString(),
        approved_by: null,
        approved_at: null,
        material_request: `MAT-MR-${String(state.seq).padStart(5, '0')}`,
        shipment: null,
        units: lines.reduce((s, l) => s + l.qty, 0),
        units_approved: lines.reduce((s, l) => s + l.qty, 0),
        items: lines.length,
        lines: lines.map((l) => ({ item_code: l.item_code, item_name: MOCK_ITEMS[l.item_code]?.name || l.item_code, qty: l.qty, approved_qty: l.qty, on_hand_store: 0, on_hand_warehouse: state.stock[l.item_code] || 0, stock_alert: l.alert || null, barcode: l.item_code }))
      }
      state.requests.unshift(req)
      emit({ event: 'request', request: req.name, boutique: req.boutique, priority })
      return { request: { ...req }, material_request: req.material_request ?? null, name: req.name }
    },
    async requests(boutique, status = 'all', limit = 50) {
      await guard()
      const rows = state.requests.filter((r) => r.boutique === boutique && (status === 'all' || (status === 'open' ? r.status === 'Pending Approval' : r.status === status))).slice(0, limit)
      return { requests: rows.map((r) => ({ ...r })), count: rows.length }
    },
    async inbound(boutique) {
      await guard()
      const mine = state.shipments.filter((s) => s.boutique === boutique)
      return {
        boutique,
        warehouse: MOCK_STORES[boutique]?.warehouse || `${boutique} - CCZ`,
        shipments: mine.filter((s) => s.status === 'Shipped').map((s) => strip(s)),
        preparing: mine.filter((s) => ['Pending', 'Picking', 'Packed'].includes(s.status)).map((s) => ({ name: s.name, status: s.status, priority: s.priority, creation: s.created_at || '', carrier: s.carrier, service: s.service })),
        purchase_orders: [],
        recent: mine.filter((s) => s.status === 'Received').map((s) => strip(s, false)),
        open_requests: state.requests.filter((r) => r.boutique === boutique && r.status === 'Pending Approval').length,
        as_of: new Date().toISOString()
      }
    },
    async receive_shipment(args) {
      await guard()
      const sh = findShipment(args.shipment)
      if (sh.status !== 'Shipped') throw new ApiError(`Shipment ${sh.name} is ${sh.status}, not in transit`, 'ValidationError', 417)
      const final = args.final === undefined ? 1 : args.final
      const counted = new Map(args.lines.map((l) => [l.item_code, l]))
      const discrepancies: string[] = []
      for (const line of sh.lines) {
        const shipped = line.shipped_qty || line.qty
        const c = counted.get(line.item_code)
        let got: number
        let dmg = 0
        if (c) {
          got = c.received_qty
          dmg = c.damaged_qty || 0
        } else if (final) got = Math.max(0, shipped - line.received_qty - line.damaged_qty)
        else continue
        line.received_qty += got
        line.damaged_qty += dmg
        const total = line.received_qty + line.damaged_qty
        line.over_qty = Math.max(0, total - shipped)
        line.short_qty = final ? Math.max(0, shipped - total) : 0
        for (const [type, qty] of [['Short', line.short_qty], ['Damaged', dmg], ['Over', line.over_qty]] as const) {
          if (qty > 0) {
            state.seq += 1
            const d: Discrepancy = { name: `MRD-${String(state.seq).padStart(5, '0')}`, shipment: sh.name, boutique: sh.boutique, item_code: line.item_code, item_name: line.item_name, type, status: 'Open', shipped_qty: shipped, received_qty: line.received_qty, damaged_qty: line.damaged_qty, short_qty: line.short_qty, over_qty: line.over_qty, reported_by: 'manager', reported_at: new Date().toISOString(), notes: args.notes || null }
            state.discrepancies.unshift(d)
            discrepancies.push(d.name)
          }
        }
      }
      state.seq += 1
      const se = `MAT-STE-2026-${String(state.seq).padStart(5, '0')}`
      sh.stock_entry_receive = se
      if (final) {
        sh.status = 'Received'
        sh.received_at = new Date().toISOString()
      }
      emit({ event: final ? 'received' : 'partial', shipment: sh.name, boutique: sh.boutique, discrepancies })
      return { ...strip(sh), stock_entry_receive: se, stock_entry_damaged: null, discrepancies, final: !!final }
    },
    async receive_po(args) {
      await guard()
      state.seq += 1
      return { purchase_receipt: `MAT-PRE-2026-${String(state.seq).padStart(5, '0')}`, purchase_order: args.po, lines: args.lines.map((l) => ({ item_code: l.item_code || l.name || '', qty: l.qty, warehouse: MOCK_STORES[args.boutique]?.warehouse || '' })) }
    },
    async shipment(name) {
      await guard()
      const sh = findShipment(name)
      return { ...strip(sh), ship_to: sh.ship_to, ship_from: sh.ship_from, rate_options: sh.rate_options } as ShipmentDetail
    }
  },
  admin: {
    async me() {
      await guard()
      return { user: 'warehouse@cloudchaserz.example', full_name: 'Wanda Houston', roles: ['Maison Warehouse Admin'], warehouse_admin: true, supply_unrestricted: true, boutique: null, main_warehouse: MOCK_WAREHOUSE, warehouse_boutique: 'HOU-WH', brand: { brand_name: 'CloudChaserz', wordmark_text: 'CLOUDCHASERZ', product_name: 'Maison POS by CloudChaserz' }, provider: 'simulated', stores: Object.keys(MOCK_STORES) }
    },
    async wall() {
      await guard()
      const today = new Date().toISOString().slice(0, 10)
      const cols: WallData['columns'] = { pending_approval: [], to_pick: [], packing: [], ready: [], shipped_today: [] }
      for (const r of state.requests.filter((x) => x.status === 'Pending Approval')) cols.pending_approval.push({ ...r, kind: 'request', age_seconds: r.requested_at ? Math.round((Date.now() - new Date(r.requested_at).getTime()) / 1000) : 0 })
      cols.pending_approval.sort((a, b) => (b.age_seconds || 0) - (a.age_seconds || 0))
      for (const s of state.shipments) {
        const c = { ...strip(s, false), kind: 'shipment' as const }
        if (s.status === 'Pending' || s.status === 'Picking') cols.to_pick.push(c)
        else if (s.status === 'Packed' && !s.label_url) cols.packing.push(c)
        else if (s.status === 'Packed') cols.ready.push(c)
        else if (s.status === 'Shipped' && (s.shipped_at || '').slice(0, 10) === today) cols.shipped_today.push(c)
      }
      return {
        columns: cols,
        counts: { pending_approval: cols.pending_approval.length, to_pick: cols.to_pick.length, packing: cols.packing.length, ready: cols.ready.length, shipped_today: cols.shipped_today.length },
        warn_seconds: 4 * 3600,
        crit_seconds: 24 * 3600,
        sound_enabled: true,
        auto_print_packing_list: true,
        auto_print_label: true,
        provider: 'simulated',
        in_transit: state.shipments.filter((s) => s.status === 'Shipped').length,
        received_today: state.shipments.filter((s) => s.status === 'Received' && (s.received_at || '').slice(0, 10) === today).length,
        open_discrepancies: state.discrepancies.filter((d) => d.status === 'Open').length,
        server_time: new Date().toISOString()
      }
    },
    async requests(status = 'open', boutique) {
      await guard()
      const rows = state.requests.filter((r) => (!boutique || r.boutique === boutique) && (status === 'all' || (status === 'open' ? r.status === 'Pending Approval' : r.status === status)))
      return { requests: rows.map((r) => ({ ...r })), count: rows.length, scope: 'all' }
    },
    async request_detail(name) {
      await guard()
      return { ...findRequest(name) }
    },
    async approve(request, lines, notes) {
      await guard()
      const req = findRequest(request)
      if (req.status !== 'Pending Approval') throw new ApiError(`Request ${request} is ${req.status}`, 'ValidationError', 417)
      const edits = new Map((lines || []).map((l) => [l.item_code, l.approved_qty]))
      for (const l of req.lines) l.approved_qty = edits.has(l.item_code) ? edits.get(l.item_code)! : l.approved_qty
      if (!req.lines.some((l) => l.approved_qty > 0)) throw new ApiError('Approve at least one unit, or reject the request', 'ValidationError', 417)
      req.units_approved = req.lines.reduce((s, l) => s + l.approved_qty, 0)
      req.approved_by = 'warehouse@cloudchaserz.example'
      if (notes) req.reason = `${req.reason || ''}\n[warehouse] ${notes}`.trim()
      const sh = mockShipment(state, req, 0)
      emit({ event: 'approved', shipment: sh.name, boutique: req.boutique, request: req.name, priority: req.priority, print_packing_list: true })
      return { request: { ...req }, shipment: strip(sh) }
    },
    async reject(request, reason) {
      await guard()
      if (!reason?.trim()) throw new ApiError('A rejection reason is required', 'ValidationError', 417)
      const req = findRequest(request)
      if (req.status !== 'Pending Approval') throw new ApiError(`Request ${request} is ${req.status}`, 'ValidationError', 417)
      req.status = 'Rejected'
      req.rejection_reason = reason.trim()
      req.approved_at = new Date().toISOString()
      req.material_request = null
      emit({ event: 'rejected', request: req.name, boutique: req.boutique })
      return { request: { ...req } }
    },
    async shipments(status = 'open', boutique, with_lines = 0) {
      await guard()
      const open = ['Pending', 'Picking', 'Packed', 'Shipped']
      const rows = state.shipments.filter((s) => (!boutique || s.boutique === boutique) && (status === 'all' || (status === 'open' ? open.includes(s.status) : status === 'inbound' ? s.status === 'Shipped' : s.status === status)))
      return { shipments: rows.map((s) => strip(s, !!with_lines)), count: rows.length }
    },
    async shipment(name) {
      return mockWarehouse.store.shipment(name)
    },
    async pick_list(name) {
      await guard()
      const sh = findShipment(name)
      return { shipment: sh.name, boutique: sh.boutique, boutique_name: sh.boutique_name, from_warehouse: sh.from_warehouse, status: sh.status, lines: [...sh.lines].sort((a, b) => (a.bin_location || '').localeCompare(b.bin_location || '')).map((l) => ({ item_code: l.item_code, item_name: l.item_name, barcode: l.barcode, qty: l.qty, picked_qty: l.picked_qty, bin_location: l.bin_location, on_hand: state.stock[l.item_code] || 0, image: null })) }
    },
    async pick(name, lines) {
      await guard()
      const sh = findShipment(name)
      if (!['Pending', 'Picking'].includes(sh.status)) throw new ApiError(`Shipment ${name} is ${sh.status}`, 'ValidationError', 417)
      const picked = new Map((lines || []).map((l) => [l.item_code, l.picked_qty]))
      for (const l of sh.lines) {
        const q = picked.has(l.item_code) ? picked.get(l.item_code)! : l.picked_qty || l.qty
        if (q > l.qty) throw new ApiError(`Picked more than approved for ${l.item_code}`, 'ValidationError', 417)
        l.picked_qty = q
      }
      sh.status = 'Picking'
      sh.picking_at = sh.picking_at || new Date().toISOString()
      emit({ event: 'picking', shipment: sh.name, boutique: sh.boutique })
      return strip(sh)
    },
    async pack(name, lines, parcels) {
      await guard()
      const sh = findShipment(name)
      if (!['Pending', 'Picking', 'Packed'].includes(sh.status)) throw new ApiError(`Shipment ${name} is ${sh.status}`, 'ValidationError', 417)
      const picked = new Map((lines || []).map((l) => [l.item_code, l.picked_qty]))
      for (const l of sh.lines) l.picked_qty = picked.has(l.item_code) ? picked.get(l.item_code)! : l.picked_qty || l.qty
      if (parcels?.length) {
        if (parcels.some((p) => !(p.weight > 0))) throw new ApiError('Parcel weight must be positive', 'ValidationError', 417)
        sh.parcels = parcels.map((p) => ({ ...p }))
      } else if (!sh.parcels.length) sh.parcels = [{ length: 40, width: 30, height: 25, weight: sh.est_weight }]
      sh.status = 'Packed'
      sh.picking_at = sh.picking_at || new Date().toISOString()
      sh.packed_at = sh.packed_at || new Date().toISOString()
      emit({ event: 'packed', shipment: sh.name, boutique: sh.boutique })
      return strip(sh)
    },
    async rates(name, prefer = 'cheapest') {
      await guard()
      const sh = findShipment(name)
      if (['Shipped', 'Received', 'Cancelled'].includes(sh.status)) throw new ApiError(`Shipment ${name} is already ${sh.status}`, 'ValidationError', 417)
      const parcels = sh.parcels.length ? sh.parcels : [{ length: 40, width: 30, height: 25, weight: sh.est_weight }]
      const rates = mockRates(sh.ship_to, parcels.reduce((s, p) => s + p.weight, 0))
      sh.rate_options = rates
      return { shipment: sh.name, provider: 'simulated', test_mode: false, prefer, rates, selected: pickRate(rates, prefer), cheapest: pickRate(rates, 'cheapest')?.provider_rate_id || null, fastest: pickRate(rates, 'fastest')?.provider_rate_id || null, parcels, ship_to: sh.ship_to, ship_from: sh.ship_from }
    },
    async buy(name, rate_id, prefer = 'cheapest') {
      await guard()
      const sh = findShipment(name)
      if (['Shipped', 'Received', 'Cancelled'].includes(sh.status)) throw new ApiError(`Shipment ${name} is already ${sh.status}`, 'ValidationError', 417)
      if (!sh.rate_options.length) await mockWarehouse.admin.rates(name, prefer)
      const chosen = rate_id ? sh.rate_options.find((r) => r.provider_rate_id === rate_id) : pickRate(sh.rate_options, prefer)
      if (!chosen) throw new ApiError(`Rate ${rate_id} is not in the last quote — fetch rates again`, 'ValidationError', 417)
      if (sh.status !== 'Packed') {
        for (const l of sh.lines) l.picked_qty = l.picked_qty || l.qty
        if (!sh.parcels.length) sh.parcels = [{ length: 40, width: 30, height: 25, weight: sh.est_weight }]
        sh.status = 'Packed'
      }
      const tracking = `${chosen.carrier === 'USPS' ? '9400' : chosen.carrier === 'UPS' ? '1Z' : '7489'}${String(Date.now()).slice(-9)}`
      sh.provider = 'simulated'
      sh.carrier = chosen.carrier
      sh.service = chosen.service
      sh.rate_amount = chosen.amount
      sh.rate_days = chosen.days
      sh.provider_rate_id = chosen.provider_rate_id
      sh.label_url = `/shipping-label/${tracking}`
      sh.tracking_no = tracking
      sh.tracking_url = `/shipping-label/${tracking}`
      sh.tracking_status = 'PRE_TRANSIT'
      sh.label_at = new Date().toISOString()
      emit({ event: 'label', shipment: sh.name, boutique: sh.boutique, label_url: sh.label_url, print_label: true })
      return { ...strip(sh), label: { label_url: sh.label_url, tracking_no: tracking, tracking_url: sh.tracking_url, provider: 'simulated', carrier: chosen.carrier, service: chosen.service, amount: chosen.amount } }
    },
    async ship(name) {
      await guard()
      const sh = findShipment(name)
      if (['Shipped', 'Received', 'Cancelled'].includes(sh.status)) throw new ApiError(`Shipment ${name} is already ${sh.status}`, 'ValidationError', 417)
      for (const l of sh.lines) {
        l.shipped_qty = l.picked_qty || l.qty
        state.stock[l.item_code] = (state.stock[l.item_code] || 0) - l.shipped_qty
      }
      if (!sh.parcels.length) sh.parcels = [{ length: 40, width: 30, height: 25, weight: sh.est_weight }]
      state.seq += 1
      sh.stock_entry_ship = `MAT-STE-2026-${String(state.seq).padStart(5, '0')}`
      sh.status = 'Shipped'
      sh.shipped_at = new Date().toISOString()
      sh.tracking_status = sh.tracking_status || 'PRE_TRANSIT'
      emit({ event: 'shipped', shipment: sh.name, boutique: sh.boutique })
      return strip(sh)
    },
    async mark(name, status) {
      if (status === 'Picking') return mockWarehouse.admin.pick(name)
      if (status === 'Packed') return mockWarehouse.admin.pack(name)
      if (status === 'Shipped') return mockWarehouse.admin.ship(name)
      await guard()
      const sh = findShipment(name)
      if (status === 'Cancelled') {
        if (['Shipped', 'Received'].includes(sh.status)) throw new ApiError('A shipped consignment cannot be cancelled — receive it at the store', 'ValidationError', 417)
        sh.status = 'Cancelled'
        emit({ event: 'cancelled', shipment: sh.name, boutique: sh.boutique })
        return strip(sh)
      }
      throw new ApiError(`Unsupported status ${status}`, 'ValidationError', 417)
    },
    async track(name) {
      await guard()
      const sh = findShipment(name)
      return { shipment: sh.name, tracking_no: sh.tracking_no || null, status: sh.tracking_status || null, events: sh.tracking_no ? [{ status: 'PRE_TRANSIT', at: sh.label_at || '', location: 'Houston, TX', description: 'Shipping label created' }] : [] }
    },
    async discrepancies(status = 'Open', boutique) {
      await guard()
      const rows = state.discrepancies.filter((d) => (!boutique || d.boutique === boutique) && (status === 'all' || d.status === status))
      return { discrepancies: rows.map((d) => ({ ...d })), count: rows.length }
    },
    async resolve_discrepancy(name, resolution, notes) {
      await guard()
      const d = state.discrepancies.find((x) => x.name === name)
      if (!d) throw new ApiError('not found', 'DoesNotExistError', 404)
      if (d.status === 'Resolved') throw new ApiError('Already resolved', 'ValidationError', 417)
      d.status = 'Resolved'
      d.resolution = resolution
      d.resolved_at = new Date().toISOString()
      if (notes) d.notes = `${d.notes || ''}\n${notes}`.trim()
      let reship: string | null = null
      if (resolution === 'Re-ship') {
        const qty = d.type === 'Short' ? d.short_qty : d.damaged_qty
        const r = await mockWarehouse.store.replenish({ boutique: d.boutique, lines: [{ item_code: d.item_code, qty }], priority: 'Urgent', reason: `Re-ship for discrepancy ${d.name}` })
        reship = r.name
      }
      emit({ event: 'discrepancy', shipment: d.shipment, boutique: d.boutique })
      return { ...d, reship_request: reship }
    },
    async warehouse_stock(q, limit = 300) {
      await guard()
      const needle = (q || '').toLowerCase()
      const rows: WarehouseStockRow[] = Object.entries(state.stock)
        .map(([item_code, actual_qty]) => ({ item_code, item_name: MOCK_ITEMS[item_code]?.name || item_code, item_group: 'Disposables', barcode: item_code, image: null, actual_qty, reserved_qty: 0, projected_qty: actual_qty, reorder_level: 20, low: actual_qty <= 20 }))
        .filter((r) => !needle || `${r.item_code} ${r.item_name}`.toLowerCase().includes(needle))
      rows.sort((a, b) => Number(b.low) - Number(a.low) || a.item_code.localeCompare(b.item_code))
      return { warehouse: MOCK_WAREHOUSE, rows: rows.slice(0, limit), total: rows.length, low: rows.filter((r) => r.low).length }
    },
    async vendor_pos() {
      await guard()
      return { warehouse: MOCK_WAREHOUSE, purchase_orders: state.pos.filter((p) => p.per_received < 100).map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) })) }
    },
    async receive_vendor_po(po, lines) {
      await guard()
      const p = state.pos.find((x) => x.name === po)
      if (!p) throw new ApiError('not found', 'DoesNotExistError', 404)
      const out: { item_code: string; qty: number; warehouse: string }[] = []
      for (const l of lines) {
        const row = p.items.find((i) => i.name === l.name || i.item_code === l.item_code)
        if (!row || l.qty <= 0) continue
        row.received_qty += l.qty
        row.pending_qty = Math.max(0, row.qty - row.received_qty)
        state.stock[row.item_code] = (state.stock[row.item_code] || 0) + l.qty
        out.push({ item_code: row.item_code, qty: l.qty, warehouse: MOCK_WAREHOUSE })
      }
      const total = p.items.reduce((s, i) => s + i.qty, 0)
      p.per_received = Math.round((p.items.reduce((s, i) => s + Math.min(i.qty, i.received_qty), 0) / total) * 100)
      state.seq += 1
      return { purchase_receipt: `MAT-PRE-2026-${String(state.seq).padStart(5, '0')}`, purchase_order: po, lines: out }
    }
  }
}

/** Tests / virtual wall: subscribe to mock wall events. */
export function __onMockWall(fn: (e: WallEvent) => void): () => void {
  state.listeners.push(fn)
  return () => {
    state.listeners = state.listeners.filter((l) => l !== fn)
  }
}
export function __resetMockWarehouse() {
  state = fresh()
}

export const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const warehouseApi: WarehouseApi = IS_MOCK ? mockWarehouse : frappeWarehouse
