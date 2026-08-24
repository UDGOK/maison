/**
 * v1.0 "Procurement" — state for the buying half of the `/warehouse` desk: Buying (suggestions →
 * orders), Vendors, Inbound and Stock.
 *
 * Conventions:
 *
 *  - **Actions never throw.** On failure they set `error` and return `null`, so a screen can put
 *    the message in a banner without wrapping every call in try/catch. `notice` carries the
 *    one-line confirmation after a successful write; call `clearNotice()` once it is shown.
 *  - `loading` covers list/detail reads, `busy` holds the name of the document a write is running
 *    against (so one row can spin without freezing the board), exactly like the warehouse store.
 *  - Writes are gated behind the warehouse store's `allowed` getter (`supply_unrestricted` from
 *    `shipping.me`). The role check itself is **not** duplicated here — `ensureAllowed()` loads
 *    `me` once and asks that getter. The server enforces the same gate regardless.
 */
import { defineStore } from 'pinia'
import {
  purchasingApi,
  type CreateOrderLine,
  type CreateOrdersResult,
  type InboundData,
  type ItemVendorInput,
  type ItemVendorsResult,
  type OrderFilters,
  type OrderLineInput,
  type OrderMethod,
  type PriceChangeRequest,
  type PurchaseOrderDetail,
  type PurchaseOrderRow,
  type ReceiveLineInput,
  type ReceiveResult,
  type StockRow,
  type Suggestion,
  type Vendor,
  type VendorDetail,
  type VendorInput
} from '@/api/purchasing'
import { groupBySupplier, lineFor, orderNet, orderPlan, pickVendor, type BuyLine, type OrderPlan, type SupplierGroup } from '@/warehouse/buying'
import { useWarehouseStore } from '@/stores/warehouse'

/** Per-item overrides the buyer has made on the Buying screen. Presence in the map = selected. */
export interface SelectionOverride {
  /** editable quantity; unset means "whatever the suggestion says" */
  qty?: number
  /** chosen vendor; unset means the preferred one */
  supplier?: string
}

interface PurchasingState {
  vendors: Vendor[]
  vendorDetail: VendorDetail | null
  suggestions: Suggestion[]
  runId: string | null
  asOf: string | null
  orders: PurchaseOrderRow[]
  orderDetail: PurchaseOrderDetail | null
  inbound: InboundData | null
  stock: StockRow[]
  /** the totals that came with the stock rows (warehouse, count, low count, value at moving average) */
  stockSummary: { warehouse: string; total: number; low: number; stock_value: number } | null
  priceRequests: PriceChangeRequest[]
  /** item_code → overrides; the Buying screen's basket */
  selection: Record<string, SelectionOverride>
  loading: boolean
  busy: string | null
  error: string | null
  notice: string | null
}

function message(e: unknown): string {
  return (e as Error)?.message || 'Something went wrong'
}

/** Drop the detail-only keys — the order list holds `order_dict(with_items=False)` rows. */
function toRow(detail: PurchaseOrderDetail): PurchaseOrderRow {
  const row = { ...detail } as Partial<PurchaseOrderDetail>
  delete row.items
  delete row.units
  delete row.supplier_profile
  delete row.receipts
  delete row.discrepancies
  delete row.can_edit
  return row as PurchaseOrderRow
}

export const usePurchasingStore = defineStore('purchasing', {
  state: (): PurchasingState => ({
    vendors: [],
    vendorDetail: null,
    suggestions: [],
    runId: null,
    asOf: null,
    orders: [],
    orderDetail: null,
    inbound: null,
    stock: [],
    stockSummary: null,
    priceRequests: [],
    selection: {},
    loading: false,
    busy: null,
    error: null,
    notice: null
  }),
  getters: {
    /** May this user buy? Delegates to the warehouse store — the role check lives there. */
    allowed(): boolean {
      return useWarehouseStore().allowed
    },
    /** Open suggestions only — an Ordered or Dismissed row leaves the buying list. */
    openSuggestions: (s): Suggestion[] => s.suggestions.filter((row) => row.status === 'Open'),
    /**
     * The chosen buying lines, with the buyer's vendor and quantity overrides applied and the
     * quantity re-rounded to the chosen vendor's case pack. Rows edited down to 0 drop out.
     */
    selectedLines: (s): BuyLine[] => {
      const out: BuyLine[] = []
      for (const suggestion of s.suggestions) {
        const override = s.selection[suggestion.item_code]
        if (!override) continue
        const supplier = override.supplier || suggestion.supplier || ''
        let line = supplier && supplier !== suggestion.supplier ? pickVendor(suggestion, supplier) : lineFor(suggestion)
        if (override.qty != null) line = { ...line, qty: Number(override.qty) || 0 }
        if (line.qty > 0 && line.supplier) out.push(line)
      }
      return out
    },
    /** How many lines will actually be ordered (a row edited to 0 does not count). */
    selectedCount(): number {
      return this.selectedLines.length
    },
    /** Net value of the selection, before freight. */
    selectedValue(): number {
      return orderNet(this.selectedLines)
    },
    /** The draft orders `create_orders` will produce — grouped by (vendor, drop-ship store). */
    ordersToCreate(): SupplierGroup[] {
      return groupBySupplier(this.selectedLines)
    },
    /** "3 orders, 2 vendors, 412 units, $4,180.20" for the Create orders button. */
    plan(): OrderPlan {
      return orderPlan(this.selectedLines)
    },
    /** Draft orders only. */
    draftOrders: (s): PurchaseOrderRow[] => s.orders.filter((o) => o.docstatus === 0),
    /** Submitted, not finished. */
    openOrders: (s): PurchaseOrderRow[] => s.orders.filter((o) => o.docstatus === 1 && !['Closed', 'Completed', 'Cancelled'].includes(o.status)),
    lowStockCount: (s): number => s.stock.filter((r) => r.low).length
  },
  actions: {
    // ---------------------------------------------------------------- gate + housekeeping
    /** Load `me` once, then ask the warehouse store's `allowed` getter. Sets `error` when refused. */
    async ensureAllowed(): Promise<boolean> {
      const warehouse = useWarehouseStore()
      if (!warehouse.me && !warehouse.meError) await warehouse.loadMe()
      if (!warehouse.allowed) {
        this.error = 'Buying is centralised in Houston — warehouse admin or head office only'
        return false
      }
      return true
    },
    clearNotice() {
      this.notice = null
    },
    clearError() {
      this.error = null
    },

    // ---------------------------------------------------------------- §A vendors
    async loadVendors(search?: string, activeOnly = true) {
      this.loading = true
      this.error = null
      try {
        const out = await purchasingApi.vendors(search, activeOnly)
        this.vendors = out.vendors
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async loadVendor(name: string) {
      this.loading = true
      this.error = null
      try {
        this.vendorDetail = await purchasingApi.vendor(name)
        return this.vendorDetail
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async saveVendor(payload: VendorInput) {
      if (!(await this.ensureAllowed())) return null
      this.busy = payload.name || 'new-vendor'
      this.error = null
      try {
        const out = await purchasingApi.save_vendor(payload)
        this.mergeVendor(out.vendor)
        this.notice = `${out.vendor.supplier_name} saved`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    async setVendorActive(name: string, active: boolean) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.set_vendor_active(name, active)
        this.mergeVendor(out.vendor)
        this.notice = `${out.vendor.supplier_name} ${out.active ? 'reactivated' : 'deactivated'}`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    /** Keep the list row and the open profile in step after a vendor write. */
    mergeVendor(vendor: Vendor) {
      const i = this.vendors.findIndex((v) => v.name === vendor.name)
      // a list row carries 12-month stats the write endpoints do not return — keep them
      if (i >= 0) this.vendors[i] = { ...this.vendors[i], ...vendor }
      else this.vendors.unshift(vendor)
      if (this.vendorDetail?.vendor.name === vendor.name) {
        this.vendorDetail = { ...this.vendorDetail, vendor: { ...this.vendorDetail.vendor, ...vendor } }
      }
    },

    // ---------------------------------------------------------------- §B item ↔ vendor catalogue
    async loadItemVendors(itemCode: string) {
      this.loading = true
      this.error = null
      try {
        return await purchasingApi.item_vendors(itemCode)
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async saveItemVendor(itemCode: string, row: ItemVendorInput) {
      return this.itemVendorWrite(itemCode, () => purchasingApi.save_item_vendor(itemCode, row), 'Catalogue updated')
    },
    async removeItemVendor(itemCode: string, rowName: string) {
      return this.itemVendorWrite(itemCode, () => purchasingApi.remove_item_vendor(itemCode, rowName), 'Vendor removed')
    },
    async setPreferredVendor(itemCode: string, supplier: string) {
      return this.itemVendorWrite(itemCode, () => purchasingApi.set_preferred_vendor(itemCode, supplier), 'Preferred vendor set')
    },
    async itemVendorWrite(itemCode: string, run: () => Promise<ItemVendorsResult>, notice: string) {
      if (!(await this.ensureAllowed())) return null
      this.busy = itemCode
      this.error = null
      try {
        const out = await run()
        this.applyItemVendors(out)
        this.notice = notice
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    /** Reflect a catalogue change on the open vendor profile and on any suggestion for that item. */
    applyItemVendors(payload: ItemVendorsResult) {
      const detail = this.vendorDetail
      if (detail) {
        const row = payload.vendors.find((v) => v.supplier === detail.vendor.name)
        const catalogue = detail.catalogue.filter((c) => c.item_code !== payload.item_code)
        if (row) {
          catalogue.push({
            name: row.name,
            item_code: payload.item_code,
            item_name: payload.item_name ?? payload.item_code,
            item_group: detail.catalogue.find((c) => c.item_code === payload.item_code)?.item_group ?? null,
            vendor_sku: row.vendor_sku,
            cost: row.cost,
            case_pack: row.case_pack,
            moq: row.moq,
            lead_time_days: row.lead_time_days,
            is_preferred: row.is_preferred,
            last_purchase_date: row.last_purchase_date,
            last_purchase_rate: row.last_purchase_rate
          })
          catalogue.sort((a, b) => a.item_code.localeCompare(b.item_code))
        }
        this.vendorDetail = { ...detail, catalogue }
      }
      const suggestion = this.suggestions.find((s) => s.item_code === payload.item_code)
      if (suggestion) {
        suggestion.vendors = payload.vendors.map((v) => ({
          supplier: v.supplier,
          supplier_name: v.supplier_name,
          cost: v.cost,
          case_pack: v.case_pack,
          moq: v.moq,
          lead_time_days: v.lead_time_days,
          vendor_sku: v.vendor_sku,
          is_preferred: v.is_preferred,
          last_purchase_rate: v.last_purchase_rate
        }))
      }
    },

    // ---------------------------------------------------------------- §C what to buy
    async loadSuggestions(refresh = false) {
      this.loading = true
      this.error = null
      try {
        const out = await purchasingApi.suggestions(refresh)
        this.suggestions = out.suggestions
        this.runId = out.run_id
        this.asOf = out.as_of ?? this.asOf
        // drop selections for rows that are no longer on the list
        const live = new Set(out.suggestions.map((s) => s.item_code))
        for (const code of Object.keys(this.selection)) if (!live.has(code)) delete this.selection[code]
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async dismissSuggestion(name: string, reason?: string) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.dismiss_suggestion(name, reason)
        this.suggestions = this.suggestions.filter((s) => s.name !== name)
        delete this.selection[out.item_code]
        this.notice = `${out.item_code} dismissed`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    /** Create one draft order per (vendor, drop-ship store) from the selection (or from *lines*). */
    async createOrders(lines?: CreateOrderLine[]): Promise<CreateOrdersResult | null> {
      if (!(await this.ensureAllowed())) return null
      const rows: CreateOrderLine[] = lines ?? this.selectedLines.map(toCreateLine)
      if (!rows.length) {
        this.error = 'Nothing to order — choose at least one line'
        return null
      }
      this.busy = 'create-orders'
      this.error = null
      try {
        const out = await purchasingApi.create_orders(rows)
        // the server flips each sourced suggestion to `Ordered`; it leaves the buying list
        const ordered = new Set(rows.map((r) => r.item_code))
        this.suggestions = this.suggestions.filter((s) => !ordered.has(s.item_code))
        this.selection = {}
        this.notice = out.count === 1 ? `1 order created (${out.orders[0]})` : `${out.count} orders created`
        await this.loadOrders({ status: 'all' })
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },

    // ---------------------------------------------------------------- selection (Buying screen)
    isSelected(itemCode: string): boolean {
      // A tracked read on the Pinia proxy. `hasOwnProperty` is *not* tracked, so a computed
      // built on it never re-evaluated and the Buying row checkboxes never ticked.
      return this.selection[itemCode] !== undefined
    },
    select(itemCode: string, override: SelectionOverride = {}) {
      this.selection[itemCode] = { ...this.selection[itemCode], ...override }
    },
    deselect(itemCode: string) {
      delete this.selection[itemCode]
    },
    toggle(itemCode: string, override: SelectionOverride = {}) {
      if (this.isSelected(itemCode)) this.deselect(itemCode)
      else this.select(itemCode, override)
    },
    /** Override the quantity on a row (selecting it if it was not selected). */
    setQty(itemCode: string, qty: number) {
      this.select(itemCode, { qty: Math.max(0, Number(qty) || 0) })
    },
    /** Switch a row to an alternative vendor; the quantity re-rounds to their case pack. */
    setSupplier(itemCode: string, supplier: string) {
      const current = this.selection[itemCode] ?? {}
      // a vendor swap invalidates a quantity the buyer typed against the previous case pack
      this.selection[itemCode] = { supplier, ...(current.qty != null ? { qty: undefined } : {}) }
      if (this.selection[itemCode].qty === undefined) delete this.selection[itemCode].qty
    },
    selectAll() {
      for (const s of this.suggestions) if (s.status === 'Open') this.select(s.item_code)
    },
    clearSelection() {
      this.selection = {}
    },

    // ---------------------------------------------------------------- §D purchase orders
    async loadOrders(filters: OrderFilters = {}) {
      this.loading = true
      this.error = null
      try {
        const out = await purchasingApi.orders(filters)
        this.orders = out.orders
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async loadOrder(name: string) {
      this.loading = true
      this.error = null
      try {
        this.orderDetail = await purchasingApi.order(name)
        return this.orderDetail
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async createOrder(supplier: string, lines: OrderLineInput[], opts: { dropship_store?: string | null; freight?: number; source_request?: string | null } = {}) {
      if (!(await this.ensureAllowed())) return null
      this.busy = 'create-order'
      this.error = null
      try {
        const out = await purchasingApi.create_order(supplier, lines, opts.dropship_store ?? null, opts.freight ?? 0, opts.source_request ?? null)
        this.mergeOrder(out)
        this.notice = `Draft ${out.name} created`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    async updateOrder(name: string, lines?: OrderLineInput[] | null, freight?: number | null) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.update_order(name, lines, freight)
        this.mergeOrder(out)
        this.notice = `${out.name} saved`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    async submitOrder(name: string) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.submit_order(name)
        this.mergeOrder(out)
        this.notice = `${out.name} submitted — send it to ${out.supplier_name || out.supplier}`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    async sendOrder(name: string, method: OrderMethod | string, recipient?: string) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.send_order(name, method, recipient)
        // `send_order` returns the order without the detail-only keys — patch what we already hold
        const patch = { sent_on: out.sent_on, sent_by: out.sent_by, sent_method: out.method }
        const i = this.orders.findIndex((o) => o.name === name)
        if (i >= 0) this.orders[i] = { ...this.orders[i], ...patch }
        if (this.orderDetail?.name === name) this.orderDetail = { ...this.orderDetail, ...out.order, ...patch }
        this.notice = out.warning || (out.recipient ? `${name} sent to ${out.recipient}` : `${name} marked sent by ${out.method}`)
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    async closeOrder(name: string, reason?: string) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.close_order(name, reason)
        this.mergeOrder(out)
        this.notice = `${out.name} closed`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    /** Replace the row in `orders` **and** the open detail, so a list and a sheet never disagree. */
    mergeOrder(detail: PurchaseOrderDetail) {
      const row = toRow(detail)
      const i = this.orders.findIndex((o) => o.name === detail.name)
      if (i >= 0) this.orders[i] = row
      else this.orders.unshift(row)
      if (!this.orderDetail || this.orderDetail.name === detail.name) this.orderDetail = detail
    },

    // ---------------------------------------------------------------- §E receiving
    async loadInbound(warehouse?: string) {
      this.loading = true
      this.error = null
      try {
        this.inbound = await purchasingApi.inbound(warehouse)
        return this.inbound
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async receive(po: string, lines: ReceiveLineInput[], opts: { freight?: number | null; final?: boolean; notes?: string } = {}): Promise<ReceiveResult | null> {
      if (!(await this.ensureAllowed())) return null
      this.busy = po
      this.error = null
      try {
        const out = await purchasingApi.receive(po, lines, opts.freight ?? null, opts.final ?? false, opts.notes)
        const short = out.lines.reduce((s, l) => s + l.short_qty, 0)
        const over = out.lines.reduce((s, l) => s + l.over_qty, 0)
        this.notice = out.discrepancies.length
          ? `${po} received — ${out.discrepancies.length} discrepancy(ies) raised${short ? `, ${short} short` : ''}${over ? `, ${over} over` : ''}`
          : `${po} received`
        await this.loadInbound(out.warehouse ?? undefined)
        if (this.orderDetail?.name === po) await this.loadOrder(po)
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },

    // ---------------------------------------------------------------- stock
    async loadStock(q?: string, limit = 500) {
      this.loading = true
      this.error = null
      try {
        const out = await purchasingApi.stock(q, limit)
        this.stock = out.rows
        this.stockSummary = { warehouse: out.warehouse, total: out.total, low: out.low, stock_value: out.stock_value }
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },

    // ---------------------------------------------------------------- store selling price
    async loadPriceRequests(filters: { boutique?: string; status?: string; item_code?: string; limit?: number } = {}) {
      this.loading = true
      this.error = null
      try {
        const out = await purchasingApi.price_change_requests(filters.boutique, filters.status ?? 'Pending Approval', filters.item_code, filters.limit ?? 100)
        this.priceRequests = out.requests
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    async requestPriceChange(itemCode: string, boutique: string, proposedRate: number, opts: { reason?: string; valid_from?: string; valid_upto?: string } = {}) {
      this.busy = itemCode
      this.error = null
      try {
        const out = await purchasingApi.request_price_change(itemCode, boutique, proposedRate, opts.reason, opts.valid_from, opts.valid_upto)
        this.notice = `${out.name} raised for approval`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    async approvePriceChange(name: string, action: 'Approve' | 'Reject' = 'Approve', reason?: string) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.approve_price_change(name, action, reason)
        const i = this.priceRequests.findIndex((r) => r.name === name)
        if (i >= 0) this.priceRequests[i] = { ...this.priceRequests[i], workflow_state: out.workflow_state, pricing_rule: out.pricing_rule ?? null }
        this.notice = `${name} ${out.workflow_state.toLowerCase()}`
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    }
  }
})

/** A chosen buying line as `create_orders` wants it. */
function toCreateLine(line: BuyLine): CreateOrderLine {
  return {
    item_code: line.item_code,
    qty: line.qty,
    supplier: line.supplier,
    rate: line.rate,
    suggestion: line.suggestion ?? null,
    dropship_store: line.dropship_store ?? null
  }
}
