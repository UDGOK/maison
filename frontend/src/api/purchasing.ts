/**
 * v1.0 "Procurement" — the buying API (`maison_pos.api.purchasing.*`).
 *
 * Buying is centralised in Houston: every endpoint here is gated server-side to
 * **AWANZ Warehouse Admin** / **AWANZ Head Office** (`scoping.assert_purchasing_admin`), except
 * `order(name)`, which a store manager may read for an order addressed to their own store, and
 * the three price-change wrappers, which are open to store managers for their own store.
 *
 * Sections mirror SPEC_v1.0:
 *
 *   §A vendors ......... `vendors` `vendor` `save_vendor` `set_vendor_active`
 *   §B catalogue ....... `item_vendors` `save_item_vendor` `remove_item_vendor` `set_preferred_vendor`
 *   §C what to buy ..... `suggestions` `dismiss_suggestion` `create_orders`
 *   §D orders .......... `orders` `order` `create_order` `update_order` `submit_order`
 *                        `send_order` `close_order`
 *   §E receiving ....... `inbound` `receive`
 *   store price ........ `price_change_requests` `request_price_change` `approve_price_change`
 *   stock tab .......... `stock`
 *
 * The mock (VITE_MOCK=1 / unit tests) keeps a small deterministic buying desk in memory — four
 * active vendors and one deactivated, ten items with two vendors each at different costs, a
 * suggestion run covering all three demand sources, two drafts, one submitted order on its way in,
 * and valued stock — so every v1.0 screen is usable without a bench.
 */
import { ApiError } from './types'
import { humanizeServerMessage } from '@/utils/text'
// v1.1 §B — a product created here has to exist on the distribution desk too, with nothing on
// hand at Houston and no history at any store. Only the mock uses these.
import { __mockRegisterItem, __mockSetWarehouseStock } from './distribution'
import type { Discrepancy, PurchaseOrder, PurchaseOrderItem, WarehouseStockRow } from './warehouse'

// ---------------------------------------------------------------------------------------------
// types (mirror maison_pos.api.purchasing + purchasing/{receiving,demand,vendors}.py)
// ---------------------------------------------------------------------------------------------

/** `AWANZ Purchase Suggestion.source` — `purchasing/demand.py::SOURCE_*`, most urgent first. */
export type SuggestionSource = 'Low stock' | 'Store demand' | 'Trending'
export type SuggestionStatus = 'Open' | 'Ordered' | 'Dismissed'
/** `Supplier.maison_order_method` — `purchasing/__init__.py::ORDER_METHODS`. */
export type OrderMethod = 'Email' | 'Portal' | 'Phone' | 'EDI'
/** ERPNext submit state: 0 draft, 1 submitted, 2 cancelled. */
export type DocStatus = 0 | 1 | 2

/** Most urgent first — `purchasing/demand.py::SOURCE_ORDER`. */
export const SOURCE_ORDER: SuggestionSource[] = ['Low stock', 'Store demand', 'Trending']
export const ORDER_METHODS: OrderMethod[] = ['Email', 'Portal', 'Phone', 'EDI']

/**
 * 12-month vendor performance (`api/purchasing.py::vendor_performance`). Every field is optional:
 * a vendor with no submitted orders and no receipts in the window comes back with none of them.
 */
export interface VendorStats {
  /** submitted purchase orders in the window */
  orders?: number
  /** net value ordered (not necessarily received) */
  ordered_value?: number
  /** freight on those orders */
  freight?: number
  /** submitted purchase receipts in the window */
  receipts?: number
  /** units actually received */
  units?: number
  /** what actually arrived, at receipt cost — this is "spend" on the Vendors screen */
  spend?: number
  /** ordered → received, averaged over deliveries (null until something has been received) */
  avg_lead_time_days?: number | null
  /** received on or before the promised `schedule_date`, as a percentage */
  on_time_pct?: number | null
  /** deliveries the lead time / on-time figures were measured over */
  deliveries?: number
}

/** A vendor — ERPNext `Supplier` + the `maison_*` custom fields (`vendor_dict`). */
export interface Vendor extends VendorStats {
  name: string
  supplier_name: string
  supplier_group?: string | null
  /** ERPNext's own flag; kept in step with `active` */
  disabled: 0 | 1 | number
  /** `<Supplier> Buying` — the vendor's own buying price list */
  price_list: string
  lead_time_days: number
  min_order_value: number
  dropship_capable: boolean
  order_method: OrderMethod | string
  portal_url?: string | null
  /** the account number *they* know us by */
  account_number?: string | null
  rep_name?: string | null
  rep_phone?: string | null
  rep_email?: string | null
  notes?: string | null
  active: boolean
}

/** What `save_vendor` accepts. Omit `name` to create; the buying price list follows automatically. */
export interface VendorInput {
  name?: string
  supplier_name?: string
  supplier_group?: string
  supplier_type?: string
  lead_time_days?: number
  min_order_value?: number
  dropship_capable?: boolean | 0 | 1
  order_method?: OrderMethod | string
  portal_url?: string | null
  account_number?: string | null
  rep_name?: string | null
  rep_phone?: string | null
  rep_email?: string | null
  notes?: string | null
  active?: boolean | 0 | 1
}

/** One row of the `AWANZ Item Vendor` child table on an Item (`_vendor_row_dict`). */
export interface ItemVendorRow {
  name: string
  supplier: string
  supplier_name?: string | null
  vendor_sku?: string | null
  /** the negotiated unit cost; writes through to the vendor's price list */
  cost: number
  case_pack: number
  moq: number
  lead_time_days: number
  is_preferred: boolean
  /** stamped on Purchase Receipt submit */
  last_purchase_date?: string | null
  last_purchase_rate: number
  notes?: string | null
}

/** What `save_item_vendor` accepts; `name` targets an existing row, otherwise `supplier` does. */
export interface ItemVendorInput {
  name?: string
  supplier: string
  vendor_sku?: string | null
  cost?: number
  case_pack?: number
  moq?: number
  lead_time_days?: number
  is_preferred?: boolean | 0 | 1
  notes?: string | null
}

export interface ItemVendorsResult {
  item_code: string
  item_name?: string | null
  vendors: ItemVendorRow[]
  /** supplier of the one `is_preferred` row, if any */
  preferred: string | null
}

/** A vendor's catalogue row as seen from the vendor side (`vendor(name).catalogue`). */
export interface VendorCatalogueRow {
  /**
   * The `AWANZ Item Vendor` row name — hand it straight to `remove_item_vendor(item_code, name)`
   * instead of looking it up with an `item_vendors()` call per row. **Always** present on a row
   * that came from the server; optional only because `stores/purchasing.ts` re-synthesises a
   * catalogue row from an `ItemVendorRow` after an edit and does not carry the name across.
   */
  name?: string
  item_code: string
  item_name?: string | null
  item_group?: string | null
  vendor_sku?: string | null
  cost: number
  case_pack: number
  moq: number
  lead_time_days: number
  is_preferred: boolean
  last_purchase_date?: string | null
  last_purchase_rate: number
}

export interface VendorReceipt {
  name: string
  posting_date: string
  warehouse?: string | null
  net_total: number
  grand_total: number
  units: number
}

export interface VendorDetail {
  vendor: Vendor
  catalogue: VendorCatalogueRow[]
  /** `order_dict(with_items=False)` — no lines */
  open_orders: PurchaseOrderRow[]
  /** last 10 submitted receipts */
  receipts: VendorReceipt[]
  spend: VendorStats & { since: string }
}

export interface VendorListResult {
  vendors: Vendor[]
  count: number
  /** the start of the 12-month performance window (YYYY-MM-DD) */
  since: string
}

/** An alternative vendor on a suggestion row (`demand.build`/`demand.cached` → `vendors[]`). */
export interface SuggestionVendor {
  supplier: string
  supplier_name?: string | null
  cost: number
  case_pack: number
  moq: number
  lead_time_days: number
  vendor_sku?: string | null
  is_preferred: boolean
  last_purchase_rate: number
}

/**
 * One row of the buying list. A cached run (`demand.cached`) carries slightly less than a fresh
 * one (`demand.run`): `image`, `velocity`, `need` and `requests` are only on a fresh run.
 */
export interface Suggestion {
  /** `AWANZ Purchase Suggestion` docname */
  name: string
  item_code: string
  /** the contract calls this field "item"; same value as `item_code` */
  item: string
  item_name?: string | null
  item_group?: string | null
  image?: string | null
  barcode?: string | null
  /** the most urgent source — the badge */
  source: SuggestionSource | string
  /** every source that asked for this item, most urgent first */
  sources: (SuggestionSource | string)[]
  on_hand: number
  /** units on submitted, not yet received orders for HOU-WH */
  on_order: number
  /** open store replenishment demand for this item */
  store_demand: number
  reorder_level: number
  /** chain-wide units/day (fresh run only) */
  velocity?: number
  /** on hand ÷ velocity (0 when velocity is 0) */
  cover_days: number
  /** the raw demand before case-pack rounding (fresh run only) */
  need?: number
  suggested_qty: number
  /** same as `suggested_qty`; the editable quantity the buyer works with */
  qty: number
  case_pack: number
  moq: number
  lead_time_days: number
  supplier: string | null
  supplier_name?: string | null
  cost: number
  /** `AWANZ Replenishment Request` names behind the store demand (fresh run only) */
  requests?: string[]
  vendors: SuggestionVendor[]
  status: SuggestionStatus | string
  run_id: string
}

export interface SuggestionRun {
  run_id: string | null
  suggestions: Suggestion[]
  count: number
  /** only a fresh run stamps this */
  as_of?: string
}

/** One chosen buying line handed to `create_orders`; grouped by (supplier, dropship_store). */
export interface CreateOrderLine {
  item_code: string
  qty: number
  supplier: string
  /** manual unit-cost override; omitted, the vendor's negotiated rate is used */
  rate?: number
  /** `AWANZ Purchase Suggestion` name — flipped to `Ordered` when the order is created */
  suggestion?: string | null
  dropship_store?: string | null
}

export interface CreatedOrder {
  name: string
  supplier: string
  units: number
  dropship_store: string | null
}

export interface CreateOrdersResult {
  orders: string[]
  created: CreatedOrder[]
  count: number
}

/** One Purchase Order line (`receiving.order_dict` → `items[]`). */
export interface PurchaseOrderLine extends PurchaseOrderItem {
  /** the unit cost — editable on a draft, defaults from the vendor's price list */
  rate: number
  amount: number
  uom?: string | null
  schedule_date?: string | null
}

/** A Purchase Order without its lines (`order_dict(with_items=False)`). */
export interface PurchaseOrderRow extends Omit<PurchaseOrder, 'items'> {
  docstatus: DocStatus
  currency?: string | null
  net_total: number
  grand_total: number
  /** `maison_freight_amount` — manual, lands in valuation */
  freight: number
  /** ordered units: the list leaves the lines off, but it still counts them */
  units: number
  /** `net_total + freight` */
  landed_total: number
  /** `maison_dropship_store` — the whole order ships direct to this store */
  dropship_store?: string | null
  /** `maison_source_request` — the store ask that caused this buy */
  source_request?: string | null
  sent_on?: string | null
  sent_by?: string | null
  sent_method?: OrderMethod | string | null
}

export interface PurchaseOrderWithItems extends PurchaseOrderRow {
  items: PurchaseOrderLine[]
}

/** What a submitted receipt booked against this order (`order(name).receipts`). */
export interface OrderReceiptLine {
  purchase_receipt: string
  item_code: string
  qty: number
  rejected_qty: number
  rate: number
  warehouse?: string | null
}

/**
 * An `AWANZ Receiving Discrepancy` raised against a **vendor**. The purchasing endpoints return
 * projections of the doctype rather than the whole row, so this narrows the shared
 * {@link Discrepancy} type (which is shipment-shaped) instead of re-declaring it.
 */
export type VendorDiscrepancy = Pick<Discrepancy, 'name' | 'item_code' | 'type' | 'short_qty' | 'over_qty' | 'damaged_qty'> &
  Partial<Pick<Discrepancy, 'item_name' | 'status' | 'boutique' | 'shipped_qty' | 'received_qty' | 'reported_by' | 'reported_at' | 'notes'>> & {
    supplier?: string | null
    purchase_order?: string | null
  }

/** One order in full — `order()`, `create_order()`, `update_order()`, `submit_order()`, `close_order()`. */
export interface PurchaseOrderDetail extends PurchaseOrderWithItems {
  supplier_profile: Vendor
  receipts: OrderReceiptLine[]
  discrepancies: VendorDiscrepancy[]
  /** draft **and** the caller may buy — the screens' edit gate */
  can_edit: boolean
}

/** A line handed to `create_order` / `update_order`. Every rate stays editable. */
export interface OrderLineInput {
  item_code: string
  qty: number
  rate?: number
  schedule_date?: string
}

export interface OrderFilters {
  /** `Draft` · `Open` · any ERPNext PO status · `all` */
  status?: string
  supplier?: string
  /** drop-ship store */
  store?: string
  /** order date ≥ (the HTTP parameter is literally `from`) */
  from?: string
  /** order date ≤ (the HTTP parameter is literally `to`) */
  to?: string
  limit?: number
}

export interface OrderListResult {
  orders: PurchaseOrderRow[]
  count: number
}

/** What `delete_order` answers: the order is gone, these suggestions are back on the buying list. */
export interface DeletedOrder {
  deleted: string
  /** `AWANZ Purchase Suggestion` names put back to *Open* with the order cleared off them */
  suggestions_reopened: string[]
}

export interface SendOrderResult {
  purchase_order: string
  method: OrderMethod | string
  sent_on: string
  sent_by: string
  recipient: string | null
  /** false when the site has no outgoing mail — the order is still stamped as sent */
  emailed: boolean
  /** why the e-mail did not go out, if it did not */
  warning?: string | null
  /** the order after the stamp, without `supplier_profile` / `receipts` / `discrepancies` / `can_edit` */
  order: PurchaseOrderWithItems
}

/** The `/warehouse` **Inbound** area (`inbound()`). `purchase_orders` and `expected` are the same list. */
export interface InboundData {
  warehouse: string
  purchase_orders: PurchaseOrderWithItems[]
  expected: PurchaseOrderWithItems[]
  units: number
  discrepancies: VendorDiscrepancy[]
  as_of: string
}

/** One counted line on the receive sheet. `rate` is the manual unit-cost override. */
export interface ReceiveLineInput {
  /** the Purchase Order Item row name — preferred, since an item can appear twice */
  name?: string
  item_code?: string
  qty: number
  damaged_qty?: number
  /** manual unit-cost override; omitted, the PO rate stands */
  rate?: number
}

/** What one line did on the receipt (`receiving.receive_purchase_order` → `lines[]`). */
export interface ReceivedLine {
  item_code: string
  item_name?: string | null
  /** what the warehouse counted */
  received_qty: number
  /** what ERPNext would let us book against the order line */
  posted_qty: number
  /** posted minus damaged — what went into the receiving warehouse */
  accepted_qty: number
  damaged_qty: number
  short_qty: number
  over_qty: number
  /** the unit cost actually booked */
  rate: number
  /** the rate on the order, for the "cost moved" comparison */
  po_rate: number
  warehouse?: string | null
}

/**
 * The result of posting a receipt.
 *
 * NOTE: `@/api/warehouse` exports a *different* `ReceiveResult` (a store shipment receipt).
 * Alias on import when a screen needs both.
 */
export interface ReceiveResult {
  /** null when nothing was postable (e.g. a `final` receipt that only raised shorts) */
  purchase_receipt: string | null
  purchase_order: string
  supplier: string
  warehouse?: string | null
  boutique?: string | null
  freight: number
  final: boolean
  /** true when `final` actually closed the order, so it stops expecting more from the vendor */
  closed?: boolean
  lines: ReceivedLine[]
  /** names of the `AWANZ Receiving Discrepancy` rows this receipt raised */
  discrepancies: string[]
}

/** One HOU-WH stock row, valued at moving average (`stock()`). */
export interface StockRow extends WarehouseStockRow {
  valuation_rate: number
  stock_value: number
  valuation_method: string
  /** units on submitted, not yet received orders for this warehouse */
  on_order: number
  /** chain-wide units/day over 28 days (0 when trends have never run) */
  velocity: number
  /** on hand ÷ velocity — null when the item does not move */
  cover_days: number | null
}

export interface StockResult {
  warehouse: string
  rows: StockRow[]
  total: number
  low: number
  stock_value: number
}

/** The **existing** `AWANZ Price Change Request` (v0.2) — v1.0 adds no second mechanism. */
export interface PriceChangeRequest {
  name: string
  boutique: string
  item_code: string
  item_name?: string | null
  current_rate: number
  proposed_rate: number
  reason?: string | null
  workflow_state: string
  docstatus: DocStatus
  requested_by?: string | null
  valid_from?: string | null
  valid_upto?: string | null
  pricing_rule?: string | null
  approved_by?: string | null
  approved_on?: string | null
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

// ---------------------------------------------------------------------------------------------
// v1.1 §B/§C — a new product, and a purchase order from scratch
// ---------------------------------------------------------------------------------------------

/** One group a new product can be filed under (`item_groups()`). Leaf groups only. */
export interface ItemGroupRow {
  name: string
  label: string
  parent?: string | null
  /** how many enabled items the chain already files here — the busiest one is the default */
  items: number
}

export interface ItemGroupsResult {
  groups: ItemGroupRow[]
  count: number
  /** the group the chain files most of its catalogue under, or null on an empty catalogue */
  default: string | null
}

/** What we pay for a new product, on the sheet that creates it. Its first vendor is the preferred one. */
export interface NewProductVendor {
  supplier: string
  vendor_sku?: string | null
  cost?: number
  case_pack?: number
  moq?: number
  lead_time_days?: number
  notes?: string | null
}

/** When to reorder it at HOU-WH. `qty` falls back to `level` when it is left empty. */
export interface NewProductReorder {
  level: number
  qty?: number
}

/** The whole of `create_product(payload)` — one call, one sheet, all or nothing. */
export interface NewProductInput {
  item_code: string
  item_name?: string
  item_group: string
  uom?: string
  barcode?: string | null
  image?: string | null
  description?: string | null
  /** the standard selling price, written to the selling price list */
  selling_rate?: number
  vendor?: NewProductVendor | null
  reorder?: NewProductReorder | null
}

/** The full payload of a product (`product_dict`) — what it is, what we pay, when to reorder. */
export interface ProductDetail {
  item_code: string
  item_name: string
  item_group: string
  uom: string
  barcode?: string | null
  barcodes?: string[]
  image?: string | null
  description?: string | null
  is_stock_item: boolean
  disabled: boolean
  valuation_method?: string | null
  company?: string | null
  warehouse: string
  price_list: string
  selling_rate: number
  reorder: { warehouse: string; level: number; qty: number } | null
  vendors: ItemVendorRow[]
  preferred: string | null
}

export interface CreateProductResult {
  item_code: string
  created: boolean
  item: ProductDetail
  /** the vendor's catalogue row for it, ready to drop onto an order — null when no vendor was given */
  catalogue_row: VendorCatalogueItem | null
}

/**
 * One line of a vendor's catalogue as the **order** screen needs it: what we call it, what *they*
 * call it, what it costs, and a quantity that already sits on a whole case.
 */
export interface VendorCatalogueItem extends VendorCatalogueRow {
  barcode?: string | null
  image?: string | null
  uom?: string | null
  /** units of ours in HOU-WH's bin, so the buyer can see they are about to re-buy 300 */
  on_hand: number
  /** a whole case — what a new order line starts at */
  default_qty: number
  /** the vendor's price-list rate, falling back to the negotiated cost then the last purchase */
  rate: number
}

export interface VendorCatalogueResult {
  supplier: string
  supplier_name?: string | null
  price_list: string
  currency?: string | null
  lead_time_days: number
  search: string | null
  /** rows matching the search */
  count: number
  /** rows on the vendor's whole catalogue */
  total: number
  items: VendorCatalogueItem[]
}

export interface PurchasingApi {
  // §A vendors
  vendors(search?: string, active_only?: boolean): Promise<VendorListResult>
  vendor(name: string): Promise<VendorDetail>
  save_vendor(payload: VendorInput): Promise<{ vendor: Vendor; price_list: string }>
  set_vendor_active(name: string, active: boolean): Promise<{ vendor: Vendor; active: boolean }>
  // §B item ↔ vendor catalogue
  item_vendors(item_code: string): Promise<ItemVendorsResult>
  save_item_vendor(item_code: string, row: ItemVendorInput): Promise<ItemVendorsResult>
  remove_item_vendor(item_code: string, row_name: string): Promise<ItemVendorsResult>
  set_preferred_vendor(item_code: string, supplier: string): Promise<ItemVendorsResult>
  // §C what to buy
  suggestions(refresh?: boolean): Promise<SuggestionRun>
  dismiss_suggestion(name: string, reason?: string): Promise<{ name: string; status: SuggestionStatus | string; item_code: string }>
  create_orders(lines: CreateOrderLine[]): Promise<CreateOrdersResult>
  // §D purchase orders
  orders(filters?: OrderFilters): Promise<OrderListResult>
  order(name: string): Promise<PurchaseOrderDetail>
  create_order(supplier: string, lines: OrderLineInput[], dropship_store?: string | null, freight?: number, source_request?: string | null): Promise<PurchaseOrderDetail>
  /**
   * Edit a draft. `dropship_store` left `undefined` leaves the destination alone; `null` / `''`
   * clears the drop-ship and puts the whole order back on the main Houston warehouse. Draft only.
   */
  update_order(name: string, lines?: OrderLineInput[] | null, freight?: number | null, dropship_store?: string | null): Promise<PurchaseOrderDetail>
  submit_order(name: string): Promise<PurchaseOrderDetail>
  send_order(name: string, method: OrderMethod | string, recipient?: string): Promise<SendOrderResult>
  close_order(name: string, reason?: string): Promise<PurchaseOrderDetail>
  /** Bin a **draft** (Close needs a submitted order); its suggestions go back on the buying list. */
  delete_order(name: string, reason?: string): Promise<DeletedOrder>
  // §E receiving at the warehouse
  inbound(warehouse?: string): Promise<InboundData>
  receive(po: string, lines: ReceiveLineInput[], freight?: number | null, final?: boolean, notes?: string): Promise<ReceiveResult>
  // stock tab
  stock(q?: string, limit?: number): Promise<StockResult>
  // v1.1 §B — a new product, created from the warehouse screens
  /** The leaf groups a new product can be filed under, so the create sheet does not have to guess. */
  item_groups(): Promise<ItemGroupsResult>
  /**
   * Create a product — item, vendor row, buying price, selling price and reorder level — in one
   * call, **all or nothing**. Refuses a duplicate item code, and a barcode already on another
   * item (that one is a real hazard: two products on one barcode means the till rings up the
   * wrong one, so the sheet must land that message on the barcode field).
   */
  create_product(payload: NewProductInput): Promise<CreateProductResult>
  // v1.1 §C — a purchase order from scratch
  /** A vendor's items with cost, case pack, MOQ and last purchase rate — searchable by **their** SKU. */
  vendor_catalogue(supplier: string, search?: string, limit?: number): Promise<VendorCatalogueResult>
  // store selling price — the existing AWANZ Price Change Request workflow
  price_change_requests(boutique?: string, status?: string, item_code?: string, limit?: number): Promise<{ requests: PriceChangeRequest[]; count: number }>
  request_price_change(item_code: string, boutique: string, proposed_rate: number, reason?: string, valid_from?: string, valid_upto?: string): Promise<PriceChangeCreated>
  approve_price_change(name: string, action: 'Approve' | 'Reject', reason?: string): Promise<PriceChangeDecision>
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

export const frappePurchasing: PurchasingApi = {
  // §A — reads are GET, writes are POST
  vendors: (search, active_only = true) => call('purchasing.vendors', { search, active_only: active_only ? 1 : 0 }, true),
  vendor: (name) => call('purchasing.vendor', { name }, true),
  save_vendor: (payload) => call('purchasing.save_vendor', { payload }),
  set_vendor_active: (name, active) => call('purchasing.set_vendor_active', { name, active: active ? 1 : 0 }),
  // §B
  item_vendors: (item_code) => call('purchasing.item_vendors', { item_code }, true),
  save_item_vendor: (item_code, row) => call('purchasing.save_item_vendor', { item_code, row }),
  remove_item_vendor: (item_code, row_name) => call('purchasing.remove_item_vendor', { item_code, row_name }),
  set_preferred_vendor: (item_code, supplier) => call('purchasing.set_preferred_vendor', { item_code, supplier }),
  // §C — `suggestions` is a POST even though it reads: it caches a run in `AWANZ Purchase
  // Suggestion` (always on `refresh=1`, and on the first call of a session when nothing is
  // cached), and Frappe rolls back the transaction of a GET request.
  suggestions: (refresh = false) => call('purchasing.suggestions', { refresh: refresh ? 1 : 0 }),
  dismiss_suggestion: (name, reason) => call('purchasing.dismiss_suggestion', { name, reason }),
  create_orders: (lines) => call('purchasing.create_orders', { lines }),
  // §D — note the HTTP parameters are literally `from` / `to` (`from` is a Python keyword, so the
  // server reads both out of **kwargs).
  orders: (filters = {}) =>
    call('purchasing.orders', { status: filters.status, supplier: filters.supplier, store: filters.store, from: filters.from, to: filters.to, limit: filters.limit ?? 200 }, true),
  order: (name) => call('purchasing.order', { name }, true),
  create_order: (supplier, lines, dropship_store, freight = 0, source_request) =>
    call('purchasing.create_order', { supplier, lines, dropship_store, freight, source_request }),
  // `dropship_store` is omitted from the body when it is `undefined` (JSON.stringify drops it), so
  // "leave the destination alone" and "clear it" (`null`) stay two different requests.
  update_order: (name, lines, freight, dropship_store) => call('purchasing.update_order', { name, lines, freight, dropship_store }),
  submit_order: (name) => call('purchasing.submit_order', { name }),
  send_order: (name, method, recipient) => call('purchasing.send_order', { name, method, recipient }),
  close_order: (name, reason) => call('purchasing.close_order', { name, reason }),
  delete_order: (name, reason) => call('purchasing.delete_order', { name, reason }),
  // §E
  inbound: (warehouse) => call('purchasing.inbound', { warehouse }, true),
  receive: (po, lines, freight, final = false, notes) => call('purchasing.receive', { po, lines, freight, final: final ? 1 : 0, notes }),
  // stock
  stock: (q, limit = 500) => call('purchasing.stock', { q, limit }, true),
  // v1.1 §B / §C — `create_product` is POST only on the server (it creates an Item, a vendor row,
  // two prices and a reorder level); the other two are ordinary reads.
  item_groups: () => call('purchasing.item_groups', {}, true),
  create_product: (payload) => call('purchasing.create_product', { payload }),
  vendor_catalogue: (supplier, search, limit = 200) => call('purchasing.vendor_catalogue', { supplier, search, limit }, true),
  // store selling price
  price_change_requests: (boutique, status = 'Pending Approval', item_code, limit = 100) =>
    call('purchasing.price_change_requests', { boutique, status, item_code, limit }, true),
  request_price_change: (item_code, boutique, proposed_rate, reason, valid_from, valid_upto) =>
    call('purchasing.request_price_change', { item_code, boutique, proposed_rate, reason, valid_from, valid_upto }),
  approve_price_change: (name, action = 'Approve', reason) => call('purchasing.approve_price_change', { name, action, reason })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests) — deterministic, in memory, no clock reads in the seed
// ---------------------------------------------------------------------------------------------
const MOCK_WAREHOUSE = 'HOU-WH - CCZ'
const MOCK_TODAY = '2026-08-24'
const MOCK_NOW = '2026-08-24T09:00:00'
const MOCK_SINCE = '2025-08-24'
const MOCK_USER = 'warehouse@cloudchaserz.example'
/** stores a drop-ship order can be addressed to (same codes as the warehouse mock) */
const MOCK_STORE_WAREHOUSE: Record<string, string> = {
  'HOU-MTR': 'HOU-MTR - CCZ',
  'OK-BIX': 'OK-BIX - CCZ',
  'OK-JENKS': 'OK-JENKS - CCZ'
}

interface MockItem {
  item_code: string
  item_name: string
  item_group: string
  barcode: string
  actual_qty: number
  valuation_rate: number
  reorder_level: number
  velocity: number
  // v1.1 §B — what `create_product` fills in on a product the sheet made
  uom?: string
  image?: string | null
  disabled?: boolean
  reorder_qty?: number
  selling_rate?: number
}

interface MockState {
  seq: number
  vendors: Vendor[]
  /** item_code → catalogue rows */
  catalogue: Record<string, ItemVendorRow[]>
  items: MockItem[]
  suggestions: Suggestion[]
  runId: string
  orders: PurchaseOrderDetail[]
  /** order name → the `AWANZ Purchase Suggestion` names it consumed (the server keeps this on the
   *  suggestion row itself; the payload never carries it, so the mock keeps it beside the state) */
  orderSuggestions: Record<string, string[]>
  discrepancies: VendorDiscrepancy[]
  receipts: Record<string, VendorReceipt[]>
  priceRequests: PriceChangeRequest[]
}

const MOCK_ITEMS: MockItem[] = [
  { item_code: 'GB-PULSE-15K-BLUE', item_name: 'Geek Bar Pulse 15K — Blue Razz Ice', item_group: 'Vape', barcode: '8801234500017', actual_qty: 36, valuation_rate: 9.34, reorder_level: 60, velocity: 4.2 },
  { item_code: 'LM-MO20K-WM', item_name: 'Lost Mary MO20000 — Watermelon', item_group: 'Vape', barcode: '8801234500024', actual_qty: 18, valuation_rate: 11.52, reorder_level: 40, velocity: 3.1 },
  { item_code: 'ELFBAR-BC5K-MANGO', item_name: 'Elf Bar BC5000 — Mango', item_group: 'Vape', barcode: '8801234500031', actual_qty: 120, valuation_rate: 8.28, reorder_level: 50, velocity: 2.4 },
  { item_code: 'HYDE-EDGE-4K-GRAPE', item_name: 'Hyde Edge Rave 4K — Grape', item_group: 'Vape', barcode: '8801234500048', actual_qty: 8, valuation_rate: 7.9, reorder_level: 24, velocity: 1.8 },
  { item_code: 'PUFF-XXL-MINT', item_name: 'Puff Bar XXL — Cool Mint', item_group: 'Vape', barcode: '8801234500055', actual_qty: 64, valuation_rate: 7.02, reorder_level: 30, velocity: 4.6 },
  { item_code: 'RAW-KS-SLIM', item_name: 'RAW Classic King Size Slim', item_group: 'Papers', barcode: '8801234500062', actual_qty: 340, valuation_rate: 1.21, reorder_level: 200, velocity: 6.5 },
  { item_code: 'OCB-XPERT-KS', item_name: 'OCB X-Pert King Size', item_group: 'Papers', barcode: '8801234500079', actual_qty: 90, valuation_rate: 1.02, reorder_level: 150, velocity: 2.2 },
  { item_code: 'ZIG-ZAG-1-25', item_name: 'Zig-Zag 1¼ Rolling Papers', item_group: 'Papers', barcode: '8801234500086', actual_qty: 410, valuation_rate: 0.9, reorder_level: 150, velocity: 3.4 },
  { item_code: 'AF-SHISHA-250-MINT', item_name: 'Al Fakher Shisha 250 g — Mint', item_group: 'Shisha', barcode: '8801234500093', actual_qty: 26, valuation_rate: 5.71, reorder_level: 24, velocity: 1.2 },
  { item_code: 'CLIPPER-LTR-ASST', item_name: 'Clipper Lighter — Assorted', item_group: 'Accessories', barcode: '8801234500109', actual_qty: 288, valuation_rate: 0.74, reorder_level: 96, velocity: 0 }
]

/**
 * v1.1 §B — the leaf groups a new product can be filed under. `[name, parent]`; the sheet's
 * default is whichever already holds the most items (Vape, on this catalogue).
 */
const MOCK_ITEM_GROUPS: [string, string][] = [
  ['Vape', 'Products'],
  ['Papers', 'Products'],
  ['Shisha', 'Products'],
  ['Accessories', 'Products'],
  ['Glass', 'Products'],
  ['CBD', 'Products'],
  ['Kratom', 'Products'],
  ['Detox', 'Products'],
  ['Apparel', 'Products']
]
const MOCK_SELLING_PRICE_LIST = 'Standard Selling'
/**
 * v1.1 §B — products created through `create_product` in this session. `mockOrderLine` runs while
 * the mock state is still being built (`fresh()` seeds four orders), so it cannot read `state`;
 * this list is what lets a just-created product be ordered without that circularity.
 */
const MOCK_NEW_ITEMS: MockItem[] = []

/** [item, supplier, cost, case_pack, moq, lead_time, preferred, vendor_sku] */
const MOCK_CATALOGUE: [string, string, number, number, number, number, boolean, string][] = [
  ['GB-PULSE-15K-BLUE', 'SUP-GULF', 9.25, 12, 24, 5, true, 'GC-GBP15-BRI'],
  ['GB-PULSE-15K-BLUE', 'SUP-LONE', 9.6, 10, 0, 3, false, 'LS-1188'],
  ['LM-MO20K-WM', 'SUP-LONE', 11.4, 10, 20, 3, true, 'LS-2044'],
  ['LM-MO20K-WM', 'SUP-GULF', 11.95, 12, 24, 5, false, 'GC-LMMO-WM'],
  ['ELFBAR-BC5K-MANGO', 'SUP-GULF', 8.4, 10, 0, 5, true, 'GC-EB5K-MG'],
  ['ELFBAR-BC5K-MANGO', 'SUP-BAYOU', 8.05, 24, 48, 10, false, 'BB-EB-MANGO'],
  ['HYDE-EDGE-4K-GRAPE', 'SUP-LONE', 7.85, 6, 12, 3, true, 'LS-3310'],
  ['HYDE-EDGE-4K-GRAPE', 'SUP-SOONER', 8.2, 5, 0, 7, false, 'SS-HYD-GR'],
  ['PUFF-XXL-MINT', 'SUP-SOONER', 6.95, 8, 16, 7, true, 'SS-PXXL-MT'],
  ['PUFF-XXL-MINT', 'SUP-GULF', 7.25, 12, 0, 5, false, 'GC-PUFF-XXL'],
  ['RAW-KS-SLIM', 'SUP-BAYOU', 1.15, 50, 100, 10, true, 'BB-RAW-KSS'],
  ['RAW-KS-SLIM', 'SUP-GULF', 1.32, 25, 0, 5, false, 'GC-RAW-KS'],
  ['OCB-XPERT-KS', 'SUP-GULF', 1.05, 50, 50, 5, true, 'GC-OCB-XKS'],
  ['OCB-XPERT-KS', 'SUP-BAYOU', 0.98, 100, 200, 10, false, 'BB-OCB-X'],
  ['ZIG-ZAG-1-25', 'SUP-LONE', 0.89, 50, 0, 3, true, 'LS-4001'],
  ['ZIG-ZAG-1-25', 'SUP-GULF', 0.94, 24, 48, 5, false, 'GC-ZZ-125'],
  ['AF-SHISHA-250-MINT', 'SUP-BAYOU', 5.6, 12, 24, 10, true, 'BB-AF250-MT'],
  ['AF-SHISHA-250-MINT', 'SUP-LONE', 5.95, 6, 0, 3, false, 'LS-5522'],
  ['CLIPPER-LTR-ASST', 'SUP-GULF', 0.72, 48, 96, 5, true, 'GC-CLIP-AST'],
  ['CLIPPER-LTR-ASST', 'SUP-SOONER', 0.79, 50, 0, 7, false, 'SS-CLIP']
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function mockVendors(): Vendor[] {
  return [
    {
      name: 'SUP-GULF', supplier_name: 'Gulf Coast Distributing', supplier_group: 'Distributor', disabled: 0, price_list: 'SUP-GULF Buying',
      lead_time_days: 5, min_order_value: 500, dropship_capable: true, order_method: 'Email', portal_url: null, account_number: 'CCZ-4471',
      rep_name: 'Marisol Vega', rep_phone: '(713) 555-0142', rep_email: 'marisol@gulfcoastdist.example', notes: 'Cut-off 2 pm CT for next-day pick.', active: true,
      orders: 14, ordered_value: 41220.5, freight: 620, receipts: 16, units: 4820, spend: 39860.75, avg_lead_time_days: 5.4, on_time_pct: 87.5, deliveries: 16
    },
    {
      name: 'SUP-LONE', supplier_name: 'Lone Star Wholesale', supplier_group: 'Distributor', disabled: 0, price_list: 'SUP-LONE Buying',
      lead_time_days: 3, min_order_value: 250, dropship_capable: false, order_method: 'Portal', portal_url: 'https://portal.lonestarwholesale.example',
      account_number: '88213', rep_name: 'Dee Okafor', rep_phone: '(214) 555-0199', rep_email: 'dee@lonestarwholesale.example', notes: null, active: true,
      orders: 22, ordered_value: 58940.25, freight: 1180, receipts: 24, units: 6110, spend: 57420.1, avg_lead_time_days: 3.2, on_time_pct: 95.8, deliveries: 24
    },
    {
      name: 'SUP-BAYOU', supplier_name: 'Bayou Brands Direct', supplier_group: 'Brand Direct', disabled: 0, price_list: 'SUP-BAYOU Buying',
      lead_time_days: 10, min_order_value: 1200, dropship_capable: true, order_method: 'Phone', portal_url: null, account_number: 'CLOUD-9',
      rep_name: 'Theo Brannon', rep_phone: '(504) 555-0170', rep_email: 'theo@bayoubrands.example', notes: 'Drop-ships to any store; 10 day lead.', active: true,
      orders: 6, ordered_value: 18740, freight: 940, receipts: 6, units: 2410, spend: 17980.4, avg_lead_time_days: 11.5, on_time_pct: 66.7, deliveries: 6
    },
    {
      name: 'SUP-SOONER', supplier_name: 'Sooner Supply Co', supplier_group: 'Distributor', disabled: 0, price_list: 'SUP-SOONER Buying',
      lead_time_days: 7, min_order_value: 0, dropship_capable: false, order_method: 'EDI', portal_url: null, account_number: '5521-A',
      rep_name: 'Ruth Cardenas', rep_phone: '(918) 555-0128', rep_email: 'ruth@soonersupply.example', notes: null, active: true,
      orders: 4, ordered_value: 6280.75, freight: 210, receipts: 4, units: 1180, spend: 6110.2, avg_lead_time_days: 7.8, on_time_pct: 75, deliveries: 4
    },
    {
      // deactivated rather than deleted — keeps its history, drops off the buying lists
      name: 'SUP-PANH', supplier_name: 'Panhandle Trading Co', supplier_group: 'Distributor', disabled: 1, price_list: 'SUP-PANH Buying',
      lead_time_days: 14, min_order_value: 0, dropship_capable: false, order_method: 'Email', portal_url: null, account_number: null,
      rep_name: 'Glen Ivory', rep_phone: null, rep_email: 'glen@panhandletrading.example', notes: 'Deactivated — repeated short shipments.', active: false,
      orders: 1, ordered_value: 940, freight: 0, receipts: 1, units: 210, spend: 812.5, avg_lead_time_days: 19, on_time_pct: 0, deliveries: 1
    }
  ]
}

function mockCatalogue(): Record<string, ItemVendorRow[]> {
  const names: Record<string, string> = {}
  for (const v of mockVendors()) names[v.name] = v.supplier_name
  const out: Record<string, ItemVendorRow[]> = {}
  let i = 0
  for (const [item, supplier, cost, casePack, moq, lead, preferred, sku] of MOCK_CATALOGUE) {
    i += 1
    ;(out[item] ||= []).push({
      name: `IV-${String(i).padStart(5, '0')}`,
      supplier,
      supplier_name: names[supplier] || supplier,
      vendor_sku: sku,
      cost,
      case_pack: casePack,
      moq,
      lead_time_days: lead,
      is_preferred: preferred,
      last_purchase_date: preferred ? '2026-07-18' : null,
      last_purchase_rate: preferred ? round2(cost * 0.99) : 0,
      notes: null
    })
  }
  for (const rows of Object.values(out)) rows.sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred))
  return out
}

function mockSuggestion(
  seq: number,
  itemCode: string,
  source: SuggestionSource,
  sources: SuggestionSource[],
  over: Partial<Suggestion>,
  catalogue: Record<string, ItemVendorRow[]>
): Suggestion {
  const item = MOCK_ITEMS.find((i) => i.item_code === itemCode)!
  const rows = catalogue[itemCode] || []
  const preferred = rows.find((r) => r.is_preferred) || rows[0]
  return {
    name: `PSG-${String(seq).padStart(5, '0')}`,
    item_code: itemCode,
    item: itemCode,
    item_name: item.item_name,
    item_group: item.item_group,
    image: null,
    barcode: item.barcode,
    source,
    sources,
    on_hand: item.actual_qty,
    on_order: 0,
    store_demand: 0,
    reorder_level: item.reorder_level,
    velocity: item.velocity,
    cover_days: item.velocity ? Math.round((item.actual_qty / item.velocity) * 10) / 10 : 0,
    need: 0,
    suggested_qty: 0,
    qty: 0,
    case_pack: preferred?.case_pack ?? 1,
    moq: preferred?.moq ?? 0,
    lead_time_days: preferred?.lead_time_days ?? 0,
    supplier: preferred?.supplier ?? null,
    supplier_name: preferred?.supplier_name ?? null,
    cost: preferred?.cost ?? 0,
    requests: [],
    vendors: rows.map((r) => ({
      supplier: r.supplier,
      supplier_name: r.supplier_name,
      cost: r.cost,
      case_pack: r.case_pack,
      moq: r.moq,
      lead_time_days: r.lead_time_days,
      vendor_sku: r.vendor_sku,
      is_preferred: r.is_preferred,
      last_purchase_rate: r.last_purchase_rate
    })),
    status: 'Open',
    run_id: 'run-mock-0001',
    ...over
  }
}

function mockOrderLine(seq: number, itemCode: string, qty: number, rate: number, warehouse: string, receivedQty = 0, scheduleDate?: string): PurchaseOrderLine {
  // The seed first, then anything created in this session: a product made on the New product
  // sheet is not in `MOCK_ITEMS`, and ordering it straight afterwards is the whole of v1.1 §B→§C.
  const item = MOCK_ITEMS.find((i) => i.item_code === itemCode) || MOCK_NEW_ITEMS.find((i) => i.item_code === itemCode)
  if (!item) throw new ApiError(`Item ${itemCode} does not exist`, 'DoesNotExistError', 404)
  return {
    name: `POI-${String(seq).padStart(5, '0')}`,
    item_code: itemCode,
    item_name: item.item_name,
    qty,
    rate,
    amount: round2(qty * rate),
    received_qty: receivedQty,
    pending_qty: Math.max(0, qty - receivedQty),
    warehouse,
    uom: 'Nos',
    schedule_date: scheduleDate ?? null,
    barcode: item.barcode
  }
}

function totalsOf(order: PurchaseOrderDetail): void {
  for (const line of order.items) {
    line.amount = round2(line.qty * line.rate)
    line.pending_qty = Math.max(0, line.qty - line.received_qty)
  }
  order.units = order.items.reduce((s, l) => s + l.qty, 0)
  order.net_total = round2(order.items.reduce((s, l) => s + l.amount, 0))
  order.grand_total = round2(order.net_total + order.freight)
  order.landed_total = round2(order.net_total + order.freight)
  const ordered = order.items.reduce((s, l) => s + l.qty, 0)
  const received = order.items.reduce((s, l) => s + Math.min(l.qty, l.received_qty), 0)
  order.per_received = ordered > 0 ? Math.round((received / ordered) * 100) : 0
  order.can_edit = order.docstatus === 0
}

function freshOrders(catalogue: Record<string, ItemVendorRow[]>): PurchaseOrderDetail[] {
  const vendors = mockVendors()
  const profile = (name: string): Vendor => clone(vendors.find((v) => v.name === name)!)
  const shell = (over: Partial<PurchaseOrderDetail> & { name: string; supplier: string }): PurchaseOrderDetail => {
    const v = profile(over.supplier)
    const order: PurchaseOrderDetail = {
      supplier_name: v.supplier_name,
      status: 'Draft',
      docstatus: 0,
      transaction_date: MOCK_TODAY,
      schedule_date: MOCK_TODAY,
      set_warehouse: MOCK_WAREHOUSE,
      per_received: 0,
      currency: 'USD',
      net_total: 0,
      grand_total: 0,
      freight: 0,
      landed_total: 0,
      dropship_store: null,
      source_request: null,
      sent_on: null,
      sent_by: null,
      sent_method: null,
      items: [],
      units: 0,
      supplier_profile: v,
      receipts: [],
      discrepancies: [],
      can_edit: true,
      ...over
    }
    totalsOf(order)
    return order
  }
  const cost = (item: string, supplier: string): number => (catalogue[item] || []).find((r) => r.supplier === supplier)?.cost ?? 0
  const orders: PurchaseOrderDetail[] = [
    // a fully received order, so the vendor screen and the reports have history
    shell({
      name: 'MPO-00000',
      supplier: 'SUP-GULF',
      status: 'Completed',
      docstatus: 1,
      transaction_date: '2026-07-11',
      schedule_date: '2026-07-16',
      freight: 38.5,
      items: [mockOrderLine(1, 'GB-PULSE-15K-BLUE', 120, 9.25, MOCK_WAREHOUSE, 118, '2026-07-16')],
      receipts: [{ purchase_receipt: 'MAT-PRE-2026-00031', item_code: 'GB-PULSE-15K-BLUE', qty: 118, rejected_qty: 0, rate: 9.25, warehouse: MOCK_WAREHOUSE }]
    }),
    // draft #1 — the ordinary warehouse buy
    shell({
      name: 'MPO-00001',
      supplier: 'SUP-GULF',
      schedule_date: '2026-08-29',
      items: [
        mockOrderLine(2, 'GB-PULSE-15K-BLUE', 84, cost('GB-PULSE-15K-BLUE', 'SUP-GULF'), MOCK_WAREHOUSE, 0, '2026-08-29'),
        mockOrderLine(3, 'OCB-XPERT-KS', 100, cost('OCB-XPERT-KS', 'SUP-GULF'), MOCK_WAREHOUSE, 0, '2026-08-29')
      ]
    }),
    // draft #2 — drop-ship straight to a store
    shell({
      name: 'MPO-00002',
      supplier: 'SUP-BAYOU',
      schedule_date: '2026-09-03',
      set_warehouse: MOCK_STORE_WAREHOUSE['OK-BIX'],
      dropship_store: 'OK-BIX',
      freight: 45,
      items: [
        mockOrderLine(4, 'AF-SHISHA-250-MINT', 24, cost('AF-SHISHA-250-MINT', 'SUP-BAYOU'), MOCK_STORE_WAREHOUSE['OK-BIX'], 0, '2026-09-03'),
        mockOrderLine(5, 'RAW-KS-SLIM', 100, cost('RAW-KS-SLIM', 'SUP-BAYOU'), MOCK_STORE_WAREHOUSE['OK-BIX'], 0, '2026-09-03')
      ]
    }),
    // submitted, on its way to HOU-WH — this is what Inbound expects, and what puts 24 Geek Bars
    // "already on order" against the low-stock suggestion for the same item
    shell({
      name: 'MPO-00003',
      supplier: 'SUP-LONE',
      status: 'To Receive and Bill',
      docstatus: 1,
      transaction_date: '2026-08-20',
      schedule_date: '2026-08-27',
      freight: 60,
      sent_on: '2026-08-20T14:05:00',
      sent_by: MOCK_USER,
      sent_method: 'Portal',
      items: [
        mockOrderLine(6, 'LM-MO20K-WM', 60, cost('LM-MO20K-WM', 'SUP-LONE'), MOCK_WAREHOUSE, 0, '2026-08-27'),
        mockOrderLine(7, 'ZIG-ZAG-1-25', 200, cost('ZIG-ZAG-1-25', 'SUP-LONE'), MOCK_WAREHOUSE, 0, '2026-08-27'),
        mockOrderLine(8, 'GB-PULSE-15K-BLUE', 24, cost('GB-PULSE-15K-BLUE', 'SUP-LONE'), MOCK_WAREHOUSE, 0, '2026-08-27')
      ]
    })
  ]
  return orders
}

function fresh(): MockState {
  const catalogue = mockCatalogue()
  // every quantity below is what `demand.suggest_qty(need, on_order, case_pack, moq)` produces for
  // the preferred vendor of that item — the seed and the maths agree.
  const suggestions: Suggestion[] = [
    // low stock, with 24 already on order from MPO-00003: 84 − 24 = 60, a whole case of 12
    mockSuggestion(1, 'GB-PULSE-15K-BLUE', 'Low stock', ['Low stock'], { need: 84, on_order: 24, suggested_qty: 60, qty: 60 }, catalogue),
    // low stock, lifted to two cases of 50 by the vendor's MOQ
    mockSuggestion(2, 'OCB-XPERT-KS', 'Low stock', ['Low stock'], { need: 60, suggested_qty: 100, qty: 100 }, catalogue),
    // two sources at once — the badge shows the most urgent one and a +1
    mockSuggestion(
      3,
      'HYDE-EDGE-4K-GRAPE',
      'Low stock',
      ['Low stock', 'Store demand'],
      { need: 16, suggested_qty: 18, qty: 18, store_demand: 20, requests: ['MRR-00021'] },
      catalogue
    ),
    mockSuggestion(
      4,
      'AF-SHISHA-250-MINT',
      'Store demand',
      ['Store demand'],
      { need: 22, suggested_qty: 24, qty: 24, store_demand: 48, requests: ['MRR-00022'] },
      catalogue
    ),
    mockSuggestion(5, 'PUFF-XXL-MINT', 'Trending', ['Trending'], { need: 32.6, suggested_qty: 40, qty: 40, cover_days: 13.9 }, catalogue)
  ]
  return {
    seq: 3,
    vendors: mockVendors(),
    catalogue,
    items: clone(MOCK_ITEMS),
    suggestions,
    runId: 'run-mock-0001',
    orders: freshOrders(catalogue),
    orderSuggestions: {},
    discrepancies: [
      {
        name: 'RDC-00007',
        supplier: 'SUP-GULF',
        purchase_order: 'MPO-00000',
        boutique: 'HOU-WH',
        item_code: 'GB-PULSE-15K-BLUE',
        item_name: 'Geek Bar Pulse 15K — Blue Razz Ice',
        type: 'Short',
        status: 'Open',
        shipped_qty: 120,
        received_qty: 118,
        short_qty: 2,
        over_qty: 0,
        damaged_qty: 0,
        reported_by: MOCK_USER,
        reported_at: '2026-07-17T10:12:00'
      }
    ],
    receipts: {
      'SUP-GULF': [{ name: 'MAT-PRE-2026-00031', posting_date: '2026-07-17', warehouse: MOCK_WAREHOUSE, net_total: 1091.5, grand_total: 1130, units: 118 }],
      'SUP-LONE': [{ name: 'MAT-PRE-2026-00028', posting_date: '2026-07-02', warehouse: MOCK_WAREHOUSE, net_total: 2280, grand_total: 2340, units: 200 }],
      'SUP-BAYOU': [{ name: 'MAT-PRE-2026-00019', posting_date: '2026-06-14', warehouse: MOCK_WAREHOUSE, net_total: 1344, grand_total: 1404, units: 240 }],
      'SUP-SOONER': [{ name: 'MAT-PRE-2026-00012', posting_date: '2026-05-30', warehouse: MOCK_WAREHOUSE, net_total: 556, grand_total: 596, units: 80 }],
      'SUP-PANH': []
    },
    priceRequests: [
      {
        name: 'PCR-00003', boutique: 'OK-BIX', item_code: 'GB-PULSE-15K-BLUE', item_name: 'Geek Bar Pulse 15K — Blue Razz Ice',
        current_rate: 24.99, proposed_rate: 22.99, reason: 'Matching the shop two doors down.', workflow_state: 'Pending Approval', docstatus: 1,
        requested_by: 'bixby.manager@cloudchaserz.example', valid_from: '2026-08-25', valid_upto: '2026-09-30', pricing_rule: null, approved_by: null, approved_on: null
      },
      {
        name: 'PCR-00002', boutique: 'HOU-MTR', item_code: 'RAW-KS-SLIM', item_name: 'RAW Classic King Size Slim',
        current_rate: 3.49, proposed_rate: 2.99, reason: 'Clearing the old print run.', workflow_state: 'Approved', docstatus: 1,
        requested_by: 'montrose.manager@cloudchaserz.example', valid_from: '2026-08-01', valid_upto: null, pricing_rule: 'PRLE-0031', approved_by: MOCK_USER, approved_on: '2026-08-02T08:40:00'
      }
    ]
  }
}

let state: MockState = fresh()

async function pause(): Promise<void> {
  if (typeof window !== 'undefined' && window.__awanzOffline) throw new ApiError('Offline', 'NETWORK', 0)
  await new Promise((r) => setTimeout(r, 5))
}

function nextName(prefix: string): string {
  state.seq += 1
  return `${prefix}-${String(state.seq).padStart(5, '0')}`
}

function findVendor(name: string): Vendor {
  const v = state.vendors.find((x) => x.name === name)
  if (!v) throw new ApiError(`Vendor ${name} does not exist`, 'DoesNotExistError', 404)
  return v
}

function findItem(itemCode: string): MockItem {
  const item = state.items.find((i) => i.item_code === itemCode)
  if (!item) throw new ApiError(`Item ${itemCode} does not exist`, 'DoesNotExistError', 404)
  return item
}

/** Where an order ships — the store's warehouse for a drop-ship, else HOU-WH (`destination_warehouse`). */
function destinationWarehouse(dropshipStore?: string | null): string {
  if (!dropshipStore) return MOCK_WAREHOUSE
  return MOCK_STORE_WAREHOUSE[dropshipStore] || `${dropshipStore} - CCZ`
}

function findOrder(name: string): PurchaseOrderDetail {
  const po = state.orders.find((o) => o.name === name)
  if (!po) throw new ApiError(`Purchase Order ${name} does not exist`, 'DoesNotExistError', 404)
  return po
}

/** Units on submitted, not yet received orders for HOU-WH (mirrors `demand.on_order_qty`). */
function onOrderQty(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const po of state.orders) {
    if (po.docstatus !== 1) continue
    if (['Closed', 'Completed', 'Cancelled'].includes(po.status)) continue
    for (const line of po.items) {
      if (line.warehouse !== MOCK_WAREHOUSE) continue
      const pending = line.qty - line.received_qty
      if (pending > 0) out[line.item_code] = (out[line.item_code] || 0) + pending
    }
  }
  return out
}

function itemVendorsPayload(itemCode: string): ItemVendorsResult {
  const item = findItem(itemCode)
  const rows = clone(state.catalogue[itemCode] || [])
  return { item_code: itemCode, item_name: item.item_name, vendors: rows, preferred: rows.find((r) => r.is_preferred)?.supplier ?? null }
}

function vendorRate(itemCode: string, supplier: string): number {
  return (state.catalogue[itemCode] || []).find((r) => r.supplier === supplier)?.cost ?? 0
}

/** Strip the detail-only keys — the list endpoints return `order_dict(with_items=False)`, which
 *  drops the lines but still counts them. */
function orderRow(po: PurchaseOrderDetail): PurchaseOrderRow {
  const rest = orderWithItems(po) as Partial<PurchaseOrderWithItems>
  delete rest.items
  return rest as PurchaseOrderRow
}

/** `order_dict(with_items=True)` — the lines, without `supplier_profile` / `receipts` / `can_edit`. */
function orderWithItems(po: PurchaseOrderDetail): PurchaseOrderWithItems {
  const rest = clone(po) as Partial<PurchaseOrderDetail>
  delete rest.supplier_profile
  delete rest.receipts
  delete rest.discrepancies
  delete rest.can_edit
  return rest as PurchaseOrderWithItems
}

function orderDetail(po: PurchaseOrderDetail): PurchaseOrderDetail {
  totalsOf(po)
  po.supplier_profile = clone(findVendor(po.supplier))
  po.discrepancies = clone(state.discrepancies.filter((d) => d.purchase_order === po.name))
  return clone(po)
}

function stockRow(item: MockItem, onOrder: Record<string, number>): StockRow {
  return {
    item_code: item.item_code,
    item_name: item.item_name,
    item_group: item.item_group,
    barcode: item.barcode,
    image: null,
    actual_qty: item.actual_qty,
    reserved_qty: 0,
    projected_qty: item.actual_qty + (onOrder[item.item_code] || 0),
    valuation_rate: item.valuation_rate,
    stock_value: round2(item.actual_qty * item.valuation_rate),
    valuation_method: 'Moving Average',
    reorder_level: item.reorder_level,
    on_order: onOrder[item.item_code] || 0,
    velocity: item.velocity,
    cover_days: item.velocity ? Math.round((item.actual_qty / item.velocity) * 10) / 10 : null,
    low: item.reorder_level > 0 && item.actual_qty <= item.reorder_level
  }
}

/** One line of a vendor's catalogue as the order screen wants it (`_catalogue_row`). */
function catalogueItem(row: ItemVendorRow, item: MockItem, rate = 0): VendorCatalogueItem {
  const casePack = Math.max(1, Math.trunc(row.case_pack) || 1)
  return {
    name: row.name,
    item_code: item.item_code,
    item_name: item.item_name,
    item_group: item.item_group,
    barcode: item.barcode || null,
    image: item.image ?? null,
    uom: item.uom || 'Nos',
    vendor_sku: row.vendor_sku ?? null,
    cost: row.cost,
    case_pack: casePack,
    moq: row.moq,
    lead_time_days: row.lead_time_days,
    is_preferred: row.is_preferred,
    last_purchase_date: row.last_purchase_date ?? null,
    last_purchase_rate: row.last_purchase_rate,
    on_hand: item.actual_qty,
    // what an order line starts at: a whole case at the negotiated rate, both editable
    default_qty: casePack,
    rate: rate || row.cost || row.last_purchase_rate
  }
}

/** The full payload of a product (`product_dict`). */
function productDetail(item: MockItem): ProductDetail {
  const vendors = clone(state.catalogue[item.item_code] || [])
  return {
    item_code: item.item_code,
    item_name: item.item_name,
    item_group: item.item_group,
    uom: item.uom || 'Nos',
    barcode: item.barcode || null,
    barcodes: item.barcode ? [item.barcode] : [],
    image: item.image ?? null,
    description: item.item_name,
    is_stock_item: true,
    disabled: !!item.disabled,
    valuation_method: 'Moving Average',
    company: 'CloudChaserz',
    warehouse: MOCK_WAREHOUSE,
    price_list: MOCK_SELLING_PRICE_LIST,
    selling_rate: item.selling_rate ?? 0,
    reorder: item.reorder_level > 0 || (item.reorder_qty ?? 0) > 0 ? { warehouse: MOCK_WAREHOUSE, level: item.reorder_level, qty: item.reorder_qty ?? item.reorder_level } : null,
    vendors,
    preferred: vendors.find((v) => v.is_preferred)?.supplier ?? null
  }
}

export const mockPurchasing: PurchasingApi = {
  // ------------------------------------------------------------------ §A vendors
  async vendors(search, active_only = true) {
    await pause()
    const needle = (search || '').trim().toLowerCase()
    const rows = state.vendors
      .filter((v) => (active_only ? v.active : true))
      .filter((v) => !needle || `${v.name} ${v.supplier_name} ${v.account_number || ''} ${v.rep_name || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0))
    return { vendors: clone(rows), count: rows.length, since: MOCK_SINCE }
  },
  async vendor(name) {
    await pause()
    const v = findVendor(name)
    const catalogue: VendorCatalogueRow[] = []
    for (const [itemCode, rows] of Object.entries(state.catalogue)) {
      const row = rows.find((r) => r.supplier === name)
      if (!row) continue
      const item = state.items.find((i) => i.item_code === itemCode)
      catalogue.push({
        name: row.name,
        item_code: itemCode,
        item_name: item?.item_name ?? itemCode,
        item_group: item?.item_group ?? null,
        vendor_sku: row.vendor_sku,
        cost: row.cost,
        case_pack: row.case_pack,
        moq: row.moq,
        lead_time_days: row.lead_time_days,
        is_preferred: row.is_preferred,
        last_purchase_date: row.last_purchase_date,
        last_purchase_rate: row.last_purchase_rate
      })
    }
    catalogue.sort((a, b) => a.item_code.localeCompare(b.item_code))
    const open = state.orders.filter((o) => o.supplier === name && o.docstatus < 2 && !['Closed', 'Completed', 'Cancelled'].includes(o.status))
    const { orders, ordered_value, freight, receipts, units, spend, avg_lead_time_days, on_time_pct, deliveries } = v
    return {
      vendor: clone(v),
      catalogue,
      open_orders: open.map(orderRow),
      receipts: clone(state.receipts[name] || []),
      spend: { since: MOCK_SINCE, orders, ordered_value, freight, receipts, units, spend, avg_lead_time_days, on_time_pct, deliveries }
    }
  },
  async save_vendor(payload) {
    await pause()
    const supplierName = (payload.supplier_name || payload.name || '').trim()
    if (!supplierName) throw new ApiError('A vendor needs a name', 'ValidationError', 417)
    let v = payload.name ? state.vendors.find((x) => x.name === payload.name) : undefined
    if (!v) {
      const name = payload.name?.trim() || `SUP-${supplierName.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()}`
      v = {
        name, supplier_name: supplierName, supplier_group: payload.supplier_group || 'Distributor', disabled: 0, price_list: `${name} Buying`,
        lead_time_days: 0, min_order_value: 0, dropship_capable: false, order_method: 'Email', portal_url: null, account_number: null,
        rep_name: null, rep_phone: null, rep_email: null, notes: null, active: true
      }
      state.vendors.push(v)
      state.receipts[name] = []
    }
    v.supplier_name = supplierName
    if (payload.supplier_group !== undefined) v.supplier_group = payload.supplier_group
    if (payload.lead_time_days !== undefined) v.lead_time_days = Number(payload.lead_time_days) || 0
    if (payload.min_order_value !== undefined) v.min_order_value = Number(payload.min_order_value) || 0
    if (payload.dropship_capable !== undefined) v.dropship_capable = !!payload.dropship_capable
    if (payload.order_method !== undefined) v.order_method = payload.order_method
    if (payload.portal_url !== undefined) v.portal_url = payload.portal_url
    if (payload.account_number !== undefined) v.account_number = payload.account_number
    if (payload.rep_name !== undefined) v.rep_name = payload.rep_name
    if (payload.rep_phone !== undefined) v.rep_phone = payload.rep_phone
    if (payload.rep_email !== undefined) v.rep_email = payload.rep_email
    if (payload.notes !== undefined) v.notes = payload.notes
    if (payload.active !== undefined) v.active = !!payload.active
    v.disabled = v.active ? 0 : 1
    return { vendor: clone(v), price_list: v.price_list }
  },
  async set_vendor_active(name, active) {
    await pause()
    const v = findVendor(name)
    v.active = !!active
    v.disabled = v.active ? 0 : 1
    return { vendor: clone(v), active: v.active }
  },
  // ------------------------------------------------------------------ §B catalogue
  async item_vendors(item_code) {
    await pause()
    return itemVendorsPayload(item_code)
  },
  async save_item_vendor(item_code, row) {
    await pause()
    findItem(item_code)
    const supplier = (row.supplier || '').trim()
    findVendor(supplier)
    const rows = (state.catalogue[item_code] ||= [])
    let target = rows.find((r) => r.name === row.name || r.supplier === supplier)
    if (!target) {
      target = {
        name: nextName('IV'), supplier, supplier_name: findVendor(supplier).supplier_name, vendor_sku: null, cost: 0, case_pack: 1, moq: 0,
        lead_time_days: 0, is_preferred: false, last_purchase_date: null, last_purchase_rate: 0, notes: null
      }
      rows.push(target)
    }
    target.supplier = supplier
    target.supplier_name = findVendor(supplier).supplier_name
    if (row.vendor_sku !== undefined) target.vendor_sku = row.vendor_sku
    if (row.cost !== undefined) target.cost = Number(row.cost) || 0
    if (row.case_pack !== undefined) target.case_pack = Math.max(1, Math.trunc(Number(row.case_pack) || 0))
    if (row.moq !== undefined) target.moq = Math.max(0, Math.trunc(Number(row.moq) || 0))
    if (row.lead_time_days !== undefined) target.lead_time_days = Math.max(0, Math.trunc(Number(row.lead_time_days) || 0))
    if (row.notes !== undefined) target.notes = row.notes
    // exactly one preferred vendor per item
    if (row.is_preferred) for (const r of rows) r.is_preferred = r === target
    rows.sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred))
    return itemVendorsPayload(item_code)
  },
  async remove_item_vendor(item_code, row_name) {
    await pause()
    findItem(item_code)
    const rows = state.catalogue[item_code] || []
    const keep = rows.filter((r) => r.name !== row_name)
    if (keep.length === rows.length) throw new ApiError(`Vendor row ${row_name} is not on ${item_code}`, 'DoesNotExistError', 404)
    state.catalogue[item_code] = keep
    return itemVendorsPayload(item_code)
  },
  async set_preferred_vendor(item_code, supplier) {
    await pause()
    findItem(item_code)
    const rows = state.catalogue[item_code] || []
    if (!rows.some((r) => r.supplier === supplier)) throw new ApiError(`${supplier} is not a vendor of ${item_code}`, 'ValidationError', 417)
    for (const r of rows) r.is_preferred = r.supplier === supplier
    rows.sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred))
    return itemVendorsPayload(item_code)
  },
  // ------------------------------------------------------------------ §C what to buy
  async suggestions(refresh = false) {
    await pause()
    const onOrder = onOrderQty()
    const open = state.suggestions.filter((s) => s.status === 'Open')
    for (const s of open) s.on_order = onOrder[s.item_code] || 0
    return { run_id: state.runId, suggestions: clone(open), count: open.length, ...(refresh ? { as_of: MOCK_NOW } : {}) }
  },
  async dismiss_suggestion(name, reason) {
    await pause()
    const s = state.suggestions.find((x) => x.name === name)
    if (!s) throw new ApiError(`AWANZ Purchase Suggestion ${name} does not exist`, 'DoesNotExistError', 404)
    s.status = 'Dismissed'
    void reason
    return { name: s.name, status: s.status, item_code: s.item_code }
  },
  async create_orders(lines) {
    await pause()
    const grouped = new Map<string, { supplier: string; dropship_store: string | null; rows: CreateOrderLine[] }>()
    for (const raw of lines || []) {
      const supplier = (raw.supplier || '').trim()
      const itemCode = (raw.item_code || '').trim()
      const qty = Number(raw.qty) || 0
      if (!supplier || !itemCode || qty <= 0) continue
      const store = raw.dropship_store || null
      const key = `${supplier}::${store || ''}`
      const bucket = grouped.get(key) || { supplier, dropship_store: store, rows: [] }
      bucket.rows.push({ ...raw, qty })
      grouped.set(key, bucket)
    }
    if (!grouped.size) throw new ApiError('Nothing to order', 'ValidationError', 417)
    const created: CreatedOrder[] = []
    for (const bucket of grouped.values()) {
      const v = findVendor(bucket.supplier)
      const warehouse = destinationWarehouse(bucket.dropship_store)
      const scheduleDate = addDays(MOCK_TODAY, Math.max(1, v.lead_time_days || 7))
      const po: PurchaseOrderDetail = {
        name: nextName('MPO'),
        supplier: v.name,
        supplier_name: v.supplier_name,
        status: 'Draft',
        docstatus: 0,
        transaction_date: MOCK_TODAY,
        schedule_date: scheduleDate,
        set_warehouse: warehouse,
        per_received: 0,
        currency: 'USD',
        net_total: 0,
        grand_total: 0,
        freight: 0,
        landed_total: 0,
        dropship_store: bucket.dropship_store,
        source_request: null,
        sent_on: null,
        sent_by: null,
        sent_method: null,
        items: bucket.rows.map((row, i) =>
          mockOrderLine(state.seq * 100 + i, row.item_code, row.qty, row.rate ?? vendorRate(row.item_code, v.name), warehouse, 0, scheduleDate)
        ),
        units: 0,
        supplier_profile: clone(v),
        receipts: [],
        discrepancies: [],
        can_edit: true
      }
      totalsOf(po)
      state.orders.push(po)
      for (const row of bucket.rows) {
        const s = state.suggestions.find((x) => x.name === row.suggestion || (row.suggestion == null && x.item_code === row.item_code && x.status === 'Open'))
        if (s && s.status === 'Open') {
          s.status = 'Ordered'
          s.supplier = v.name
          s.suggested_qty = row.qty
          s.qty = row.qty
          ;(state.orderSuggestions[po.name] ||= []).push(s.name)
        }
      }
      created.push({ name: po.name, supplier: v.name, units: bucket.rows.reduce((sum, r) => sum + r.qty, 0), dropship_store: bucket.dropship_store })
    }
    return { orders: created.map((c) => c.name), created, count: created.length }
  },
  // ------------------------------------------------------------------ §D purchase orders
  async orders(filters = {}) {
    await pause()
    let rows = state.orders.filter((o) => o.docstatus < 2)
    const status = filters.status
    if (status && status !== 'all' && status !== 'any') {
      if (status === 'Draft') rows = rows.filter((o) => o.docstatus === 0)
      else if (status === 'Open') rows = rows.filter((o) => ['To Receive and Bill', 'To Receive', 'To Bill'].includes(o.status))
      else rows = rows.filter((o) => o.status === status)
    }
    if (filters.supplier) rows = rows.filter((o) => o.supplier === filters.supplier)
    if (filters.store) rows = rows.filter((o) => o.dropship_store === filters.store)
    if (filters.from) rows = rows.filter((o) => (o.transaction_date || '') >= filters.from!)
    if (filters.to) rows = rows.filter((o) => (o.transaction_date || '') <= filters.to!)
    rows = [...rows].sort((a, b) => (b.transaction_date || '').localeCompare(a.transaction_date || '') || b.name.localeCompare(a.name))
    rows = rows.slice(0, filters.limit ?? 200)
    return { orders: rows.map(orderRow), count: rows.length }
  },
  async order(name) {
    await pause()
    return orderDetail(findOrder(name))
  },
  async create_order(supplier, lines, dropship_store, freight = 0, source_request) {
    await pause()
    const v = findVendor(supplier)
    const rows = (lines || []).filter((l) => l.item_code && Number(l.qty) > 0)
    if (!rows.length) throw new ApiError('A purchase order needs at least one line', 'ValidationError', 417)
    const warehouse = destinationWarehouse(dropship_store)
    const scheduleDate = addDays(MOCK_TODAY, Math.max(1, v.lead_time_days || 7))
    const po: PurchaseOrderDetail = {
      name: nextName('MPO'),
      supplier: v.name,
      supplier_name: v.supplier_name,
      status: 'Draft',
      docstatus: 0,
      transaction_date: MOCK_TODAY,
      schedule_date: scheduleDate,
      set_warehouse: warehouse,
      per_received: 0,
      currency: 'USD',
      net_total: 0,
      grand_total: 0,
      freight: Number(freight) || 0,
      landed_total: 0,
      dropship_store: dropship_store || null,
      source_request: source_request || null,
      sent_on: null,
      sent_by: null,
      sent_method: null,
      items: rows.map((l, i) => mockOrderLine(state.seq * 100 + i, l.item_code, Number(l.qty), l.rate ?? vendorRate(l.item_code, v.name), warehouse, 0, l.schedule_date ?? scheduleDate)),
      units: 0,
      supplier_profile: clone(v),
      receipts: [],
      discrepancies: [],
      can_edit: true
    }
    totalsOf(po)
    state.orders.push(po)
    return orderDetail(po)
  },
  async update_order(name, lines, freight, dropship_store) {
    await pause()
    const po = findOrder(name)
    if (dropship_store !== undefined) {
      // before the generic draft check, so a submitted order gets the message that says why
      if (po.docstatus !== 0) {
        throw new ApiError(
          `Purchase Order ${name} is submitted — its drop-ship destination can no longer be changed. Close it and raise a new order.`,
          'ValidationError',
          417
        )
      }
      const store = (dropship_store || '').trim() || null
      if (store && !MOCK_STORE_WAREHOUSE[store]) throw new ApiError(`Store ${store} does not exist`, 'DoesNotExistError', 404)
      const warehouse = destinationWarehouse(store)
      po.dropship_store = store
      po.set_warehouse = warehouse
      for (const line of po.items) line.warehouse = warehouse
    }
    if (po.docstatus !== 0) throw new ApiError(`Purchase Order ${name} is not a draft`, 'ValidationError', 417)
    if (lines != null) {
      const wanted = lines.filter((l) => l.item_code && Number(l.qty) > 0)
      if (!wanted.length) throw new ApiError('A purchase order needs at least one line', 'ValidationError', 417)
      const existing = new Map(po.items.map((r) => [r.item_code, r]))
      const rows: PurchaseOrderLine[] = []
      for (const line of wanted) {
        let row = existing.get(line.item_code)
        if (!row) row = mockOrderLine(state.seq * 100 + rows.length, line.item_code, 0, 0, po.set_warehouse || MOCK_WAREHOUSE, 0, po.schedule_date ?? undefined)
        row.qty = Number(line.qty)
        if (line.rate !== undefined && line.rate !== null) row.rate = Number(line.rate)
        if (line.schedule_date) row.schedule_date = line.schedule_date
        rows.push(row)
      }
      po.items = rows
    }
    if (freight != null) po.freight = Number(freight) || 0
    totalsOf(po)
    return orderDetail(po)
  },
  async submit_order(name) {
    await pause()
    const po = findOrder(name)
    if (po.docstatus !== 0) throw new ApiError(`Purchase Order ${name} is already submitted`, 'ValidationError', 417)
    if (po.dropship_store) {
      const warehouse = MOCK_STORE_WAREHOUSE[po.dropship_store]
      const wrong = po.items.filter((l) => l.warehouse !== warehouse).map((l) => l.warehouse || '?')
      if (wrong.length) throw new ApiError(`Every line of a drop-ship order for ${po.dropship_store} must ship to ${warehouse}`, 'ValidationError', 417)
    }
    po.docstatus = 1
    po.status = 'To Receive and Bill'
    totalsOf(po)
    return orderDetail(po)
  },
  async send_order(name, method, recipient) {
    await pause()
    const po = findOrder(name)
    if (po.docstatus !== 1) throw new ApiError('Submit the order before sending it', 'ValidationError', 417)
    const m = String(method || 'Email').trim()
    if (!ORDER_METHODS.includes(m as OrderMethod)) throw new ApiError(`Unknown order method ${m}`, 'ValidationError', 417)
    const to = m === 'Email' ? recipient || po.supplier_profile.rep_email || findVendor(po.supplier).rep_email || null : null
    if (m === 'Email' && !to) throw new ApiError(`Vendor ${po.supplier} has no rep e-mail — add one or send by phone/portal`, 'ValidationError', 417)
    po.sent_on = MOCK_NOW
    po.sent_by = MOCK_USER
    po.sent_method = m
    totalsOf(po)
    return { purchase_order: po.name, method: m, sent_on: MOCK_NOW, sent_by: MOCK_USER, recipient: to, emailed: m === 'Email', warning: null, order: orderWithItems(po) }
  },
  async close_order(name, reason) {
    await pause()
    const po = findOrder(name)
    if (po.docstatus !== 1) throw new ApiError('Only a submitted order can be closed', 'ValidationError', 417)
    po.status = 'Closed'
    void reason
    return orderDetail(po)
  },
  async delete_order(name, reason) {
    await pause()
    const po = findOrder(name)
    if (po.docstatus !== 0) throw new ApiError(`Purchase Order ${name} is submitted — close it instead of deleting it.`, 'ValidationError', 417)
    const reopened = state.orderSuggestions[name] || []
    for (const row of reopened) {
      const suggestion = state.suggestions.find((x) => x.name === row)
      if (suggestion) suggestion.status = 'Open'
    }
    delete state.orderSuggestions[name]
    state.orders = state.orders.filter((o) => o.name !== name)
    void reason
    return { deleted: name, suggestions_reopened: reopened }
  },
  // ------------------------------------------------------------------ §E receiving
  async inbound(warehouse) {
    await pause()
    const wh = warehouse || MOCK_WAREHOUSE
    const expected = state.orders
      .filter((o) => o.docstatus === 1 && o.set_warehouse === wh && o.per_received < 100 && !['Closed', 'Completed', 'Cancelled'].includes(o.status))
      .sort((a, b) => (a.schedule_date || '').localeCompare(b.schedule_date || ''))
      .map(orderWithItems)
    return {
      warehouse: wh,
      purchase_orders: expected,
      expected,
      units: expected.reduce((s, p) => s + p.units, 0),
      discrepancies: clone(state.discrepancies.filter((d) => d.status === 'Open' && !!d.supplier)),
      as_of: MOCK_NOW
    }
  },
  async receive(po, lines, freight, final = false, notes) {
    await pause()
    const order = findOrder(po)
    if (order.docstatus !== 1) throw new ApiError(`Purchase Order ${po} is not submitted`, 'ValidationError', 417)
    const wanted = new Map<string, { received: number; damaged: number; rate?: number }>()
    for (const raw of lines || []) {
      const key = raw.name || raw.item_code
      if (!key) continue
      wanted.set(key, { received: Number(raw.qty) || 0, damaged: Number(raw.damaged_qty) || 0, rate: raw.rate })
    }
    if (!wanted.size && !final) throw new ApiError('Nothing to receive', 'ValidationError', 417)
    const warehouse = order.set_warehouse || MOCK_WAREHOUSE
    const out: ReceivedLine[] = []
    const valuing: { item_code: string; accepted: number; rate: number }[] = []
    for (const row of order.items) {
      const ask = wanted.get(row.name) ?? wanted.get(row.item_code)
      const pending = Math.max(0, row.qty - row.received_qty)
      if (!ask && (!final || pending <= 0)) continue
      const received = ask ? ask.received : 0
      const damaged = Math.min(ask ? ask.damaged : 0, received)
      if (received < 0 || damaged < 0) throw new ApiError(`Negative quantity for ${row.item_code}`, 'ValidationError', 417)
      // no over-receipt allowance in the mock: anything past the ordered qty is an Over discrepancy
      const postable = Math.max(0, Math.min(received, row.qty - row.received_qty))
      const over = Math.max(0, received - postable)
      const short = final ? Math.max(0, pending - received) : 0
      const postedDamaged = Math.min(damaged, postable)
      const accepted = Math.max(0, postable - postedDamaged)
      const rate = ask?.rate != null ? Number(ask.rate) : row.rate
      row.received_qty += postable
      row.pending_qty = Math.max(0, row.qty - row.received_qty)
      valuing.push({ item_code: row.item_code, accepted, rate })
      out.push({
        item_code: row.item_code,
        item_name: row.item_name,
        received_qty: received,
        posted_qty: postable,
        accepted_qty: accepted,
        damaged_qty: damaged,
        short_qty: short,
        over_qty: over,
        rate,
        po_rate: row.rate,
        warehouse
      })
    }
    if (!out.length) throw new ApiError('No matching Purchase Order lines', 'ValidationError', 417)
    // Moving average, with the freight on **this receipt** allocated across **this receipt's**
    // lines by line amount — which is what the server does: it puts the freight on the Purchase
    // Receipt as an Actual + Valuation charge and ERPNext distributes those by net amount. Two
    // earlier shapes of this were wrong: dividing by the *order's* units (a partial receipt then
    // posted less than the sheet promised), and dividing evenly per unit (a cheap line and an
    // expensive one do not carry the same freight).
    if (warehouse === MOCK_WAREHOUSE) {
      const freightAmount = freight != null ? Number(freight) : order.freight
      const net = valuing.reduce((sum, v) => sum + v.accepted * v.rate, 0)
      const units = valuing.reduce((sum, v) => sum + v.accepted, 0)
      for (const v of valuing) {
        if (v.accepted <= 0) continue
        const item = state.items.find((i) => i.item_code === v.item_code)
        if (!item) continue
        // freight allocated by line amount, then per unit of this line
        const allocated = net > 0 ? (freightAmount * (v.accepted * v.rate)) / net : units > 0 ? (freightAmount * v.accepted) / units : 0
        const share = allocated / v.accepted
        const value = item.actual_qty * item.valuation_rate + v.accepted * (v.rate + share)
        const qty = item.actual_qty + v.accepted
        item.valuation_rate = qty > 0 ? Math.round((value / qty) * 10000) / 10000 : round2(v.rate + share)
        item.actual_qty = qty
        // v1.1 §A — Houston's bin moved, so the distribution desk's "available" moves with it
        __mockSetWarehouseStock(item.item_code, item.actual_qty)
      }
    }
    totalsOf(order)
    if (order.per_received >= 100) order.status = 'Completed'
    const raised: string[] = []
    for (const line of out) {
      for (const [kind, qty] of [['Short', line.short_qty], ['Damaged', line.damaged_qty], ['Over', line.over_qty]] as const) {
        if (qty <= 0) continue
        if (state.discrepancies.some((d) => d.purchase_order === order.name && d.item_code === line.item_code && d.type === kind && d.status === 'Open')) continue
        const name = nextName('RDC')
        state.discrepancies.push({
          name,
          supplier: order.supplier,
          purchase_order: order.name,
          boutique: order.dropship_store || 'HOU-WH',
          item_code: line.item_code,
          item_name: line.item_name ?? undefined,
          type: kind,
          status: 'Open',
          shipped_qty: order.items.find((l) => l.item_code === line.item_code)?.qty ?? 0,
          received_qty: line.received_qty,
          damaged_qty: line.damaged_qty,
          short_qty: line.short_qty,
          over_qty: line.over_qty,
          reported_by: MOCK_USER,
          reported_at: MOCK_NOW,
          notes: notes ?? null
        })
        raised.push(name)
      }
    }
    const posted = out.some((l) => l.posted_qty > 0)
    const receiptName = posted ? nextName('MAT-PRE') : null
    if (receiptName) {
      const netTotal = round2(out.reduce((s, l) => s + l.posted_qty * l.rate, 0))
      ;(state.receipts[order.supplier] ||= []).unshift({
        name: receiptName,
        posting_date: MOCK_TODAY,
        warehouse,
        net_total: netTotal,
        grand_total: round2(netTotal + (freight != null ? Number(freight) : order.freight)),
        units: out.reduce((s, l) => s + l.posted_qty, 0)
      })
      for (const line of out) {
        if (line.posted_qty <= 0) continue
        order.receipts.push({ purchase_receipt: receiptName, item_code: line.item_code, qty: line.accepted_qty, rejected_qty: line.damaged_qty, rate: line.rate, warehouse })
        // stamp the item-vendor row, like Purchase Receipt.on_submit does
        const row = (state.catalogue[line.item_code] || []).find((r) => r.supplier === order.supplier)
        if (row) {
          row.last_purchase_date = MOCK_TODAY
          row.last_purchase_rate = line.rate
        }
      }
    }
    // `final` says "that was the whole delivery", so the order stops expecting more — otherwise
    // it sits on Inbound forever with units already settled with the vendor.
    let closed = false
    if (final && order.docstatus === 1 && order.status !== 'Completed' && order.status !== 'Closed') {
      order.status = 'Closed'
      closed = true
    }
    return {
      purchase_receipt: receiptName,
      purchase_order: order.name,
      supplier: order.supplier,
      warehouse,
      boutique: order.dropship_store || null,
      freight: freight != null ? Number(freight) : order.freight,
      final: !!final,
      closed,
      lines: out,
      discrepancies: raised
    }
  },
  // ------------------------------------------------------------------ stock
  async stock(q, limit = 500) {
    await pause()
    const onOrder = onOrderQty()
    const needle = (q || '').trim().toLowerCase()
    const rows = state.items
      .filter((i) => !needle || `${i.item_code} ${i.item_name} ${i.item_group} ${i.barcode}`.toLowerCase().includes(needle))
      .map((i) => stockRow(i, onOrder))
      // low stock first, then by group, then by code — `api/purchasing.py::stock` sorts the same way
      .sort((a, b) => Number(b.low) - Number(a.low) || (a.item_group || '').localeCompare(b.item_group || '') || a.item_code.localeCompare(b.item_code))
    return {
      warehouse: MOCK_WAREHOUSE,
      rows: rows.slice(0, limit),
      total: rows.length,
      low: rows.filter((r) => r.low).length,
      stock_value: round2(rows.reduce((s, r) => s + r.stock_value, 0))
    }
  },
  // ------------------------------------------------------------------ v1.1 §B new product
  async item_groups() {
    await pause()
    const counts: Record<string, number> = {}
    for (const item of state.items) if (!item.disabled) counts[item.item_group] = (counts[item.item_group] || 0) + 1
    const groups = MOCK_ITEM_GROUPS.map(([name, parent]) => ({ name, label: name, parent, items: counts[name] || 0 })).sort((a, b) => a.name.localeCompare(b.name))
    const busiest = groups.reduce<{ name: string; items: number } | null>((best, g) => (best && best.items >= g.items ? best : g), null)
    return { groups, count: groups.length, default: busiest && busiest.items ? busiest.name : null }
  },
  async create_product(payload) {
    await pause()
    const data = payload || ({} as NewProductInput)
    const vendorRow = data.vendor || null
    const reorderRow = data.reorder || null

    // ---- validate first, write nothing (the server does the same, inside a savepoint) ----
    const itemCode = (data.item_code || '').trim()
    if (!itemCode) throw new ApiError('A product needs an item code', 'ValidationError', 417)
    if (state.items.some((i) => i.item_code === itemCode)) {
      throw new ApiError(`Item ${itemCode} already exists — open it instead of creating it again`, 'ValidationError', 417)
    }
    const itemName = (data.item_name || '').trim() || itemCode
    const itemGroup = (data.item_group || '').trim()
    if (!itemGroup) throw new ApiError('A product needs an item group', 'ValidationError', 417)
    if (!MOCK_ITEM_GROUPS.some(([name]) => name === itemGroup)) throw new ApiError(`Item group ${itemGroup} does not exist`, 'DoesNotExistError', 404)
    const uom = (data.uom || '').trim() || 'Nos'
    const barcode = (data.barcode || '').trim()
    if (barcode) {
      // the real-money one: two products on one barcode means the till rings up the wrong item
      const owner = state.items.find((i) => i.barcode === barcode)
      if (owner) {
        throw new ApiError(`Barcode ${barcode} is already on item ${owner.item_code} — two products on one barcode rings up the wrong one`, 'ValidationError', 417)
      }
    }
    const supplier = (vendorRow?.supplier || '').trim()
    if (supplier) findVendor(supplier)
    const sellingRate = Number(data.selling_rate) || 0
    if (sellingRate < 0) throw new ApiError('A selling price cannot be negative', 'ValidationError', 417)
    const cost = Number(vendorRow?.cost) || 0
    if (cost < 0) throw new ApiError('A vendor cost cannot be negative', 'ValidationError', 417)
    const reorderLevel = Number(reorderRow?.level) || 0
    const reorderQty = Number(reorderRow?.qty) || 0
    if (reorderLevel < 0 || reorderQty < 0) throw new ApiError('A reorder level cannot be negative', 'ValidationError', 417)

    // ---- write ----
    const item: MockItem = {
      item_code: itemCode,
      item_name: itemName,
      item_group: itemGroup,
      barcode,
      actual_qty: 0,
      valuation_rate: cost,
      reorder_level: reorderLevel,
      velocity: 0,
      uom,
      image: (data.image || '').trim() || null,
      disabled: false,
      reorder_qty: reorderQty || reorderLevel,
      selling_rate: sellingRate
    }
    state.items.push(item)
    MOCK_NEW_ITEMS.push(item)
    let catalogueRow: VendorCatalogueItem | null = null
    if (supplier) {
      const row: ItemVendorRow = {
        name: nextName('IV'),
        supplier,
        supplier_name: findVendor(supplier).supplier_name,
        vendor_sku: (vendorRow?.vendor_sku || '').trim() || null,
        cost,
        case_pack: Math.max(1, Math.trunc(Number(vendorRow?.case_pack) || 0) || 1),
        moq: Math.max(0, Math.trunc(Number(vendorRow?.moq) || 0)),
        lead_time_days: Math.trunc(Number(vendorRow?.lead_time_days) || 0) || findVendor(supplier).lead_time_days,
        // its first vendor, so it is the preferred one — the demand engine is never ambiguous
        is_preferred: true,
        last_purchase_date: null,
        last_purchase_rate: 0,
        notes: (vendorRow?.notes || '').trim() || null
      }
      state.catalogue[itemCode] = [row]
      catalogueRow = catalogueItem(row, item, row.cost)
    }
    // the distribution desk needs to know it exists: nothing on hand at Houston, no history at any
    // store — which is exactly the case v1.1 exists for
    __mockRegisterItem({ item_code: itemCode, item_name: itemName, item_group: itemGroup, uom, barcode: barcode || null, on_hand: 0 })
    return { item_code: itemCode, created: true, item: productDetail(item), catalogue_row: catalogueRow }
  },
  // ------------------------------------------------------------------ v1.1 §C vendor catalogue
  async vendor_catalogue(supplier, search, limit = 200) {
    await pause()
    const vendor = findVendor(supplier)
    const needle = (search || '').trim().toLowerCase()
    const rows: VendorCatalogueItem[] = []
    let total = 0
    for (const item of state.items) {
      const row = (state.catalogue[item.item_code] || []).find((r) => r.supplier === vendor.name)
      if (!row || item.disabled) continue
      total += 1
      if (needle && !`${item.item_code} ${item.item_name} ${row.vendor_sku || ''} ${item.barcode || ''}`.toLowerCase().includes(needle)) continue
      rows.push(catalogueItem(row, item, row.cost))
    }
    rows.sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred) || (a.item_name || a.item_code).localeCompare(b.item_name || b.item_code))
    return {
      supplier: vendor.name,
      supplier_name: vendor.supplier_name,
      price_list: vendor.price_list,
      currency: 'USD',
      lead_time_days: vendor.lead_time_days,
      search: search || null,
      items: rows.slice(0, limit),
      count: rows.length,
      total
    }
  },
  // ------------------------------------------------------------------ store selling price
  async price_change_requests(boutique, status = 'Pending Approval', item_code, limit = 100) {
    await pause()
    let rows = state.priceRequests
    if (boutique) rows = rows.filter((r) => r.boutique === boutique)
    if (status && status !== 'all' && status !== 'any') rows = rows.filter((r) => r.workflow_state === status)
    if (item_code) rows = rows.filter((r) => r.item_code === item_code)
    rows = rows.slice(0, limit)
    return { requests: clone(rows), count: rows.length }
  },
  async request_price_change(item_code, boutique, proposed_rate, reason, valid_from, valid_upto) {
    await pause()
    const item = findItem(item_code)
    const doc: PriceChangeRequest = {
      name: nextName('PCR'),
      boutique,
      item_code,
      item_name: item.item_name,
      current_rate: round2(item.valuation_rate * 2.6),
      proposed_rate: Number(proposed_rate) || 0,
      reason: reason ?? null,
      workflow_state: 'Pending Approval',
      docstatus: 1,
      requested_by: MOCK_USER,
      valid_from: valid_from || MOCK_TODAY,
      valid_upto: valid_upto ?? null,
      pricing_rule: null,
      approved_by: null,
      approved_on: null
    }
    state.priceRequests.unshift(doc)
    return { name: doc.name, workflow_state: doc.workflow_state, boutique: doc.boutique, item_code: doc.item_code, proposed_rate: doc.proposed_rate }
  },
  async approve_price_change(name, action = 'Approve', reason) {
    await pause()
    const doc = state.priceRequests.find((r) => r.name === name)
    if (!doc) throw new ApiError(`AWANZ Price Change Request ${name} does not exist`, 'DoesNotExistError', 404)
    if (action !== 'Approve' && action !== 'Reject') throw new ApiError(`Unknown action ${action}`, 'ValidationError', 417)
    if (reason) doc.reason = `${doc.reason || ''}\n${reason}`.trim()
    doc.workflow_state = action === 'Approve' ? 'Approved' : 'Rejected'
    doc.approved_by = MOCK_USER
    doc.approved_on = MOCK_NOW
    doc.pricing_rule = action === 'Approve' ? nextName('PRLE') : null
    return { name: doc.name, workflow_state: doc.workflow_state, pricing_rule: doc.pricing_rule }
  }
}

/** `YYYY-MM-DD` + *days*, in UTC so it never drifts with the test runner's zone. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Tests: restore the seeded buying desk. */
export function __resetMockPurchasing(): void {
  MOCK_NEW_ITEMS.length = 0
  state = fresh()
}

const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const purchasingApi: PurchasingApi = IS_MOCK ? mockPurchasing : frappePurchasing
