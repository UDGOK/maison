/**
 * v1.2 "What each store owes, and what each store charges" — state for the **Prices** half of the
 * `/warehouse` desk: the chain-wide wholesale rule, one item's price board, the approvals queue
 * and the month-end statement.
 *
 * Same conventions as `stores/purchasing.ts` and `stores/distribution.ts`, deliberately:
 *
 *  - **Actions never throw.** On failure they set `error` and return `null`, so a screen can put
 *    the message in a banner without wrapping every call in try/catch.
 *  - `loading` covers reads, `busy` holds a marker while a write runs, so one row can spin
 *    without freezing the board.
 *  - Writes are gated behind the warehouse store's `allowed` getter; the server enforces the same
 *    gate regardless — **everything here is warehouse admin / head office**, including the
 *    statement for a single store.
 *
 * The three price-change endpoints live under `purchasing.*` (they have since v1.0, and v1.2 adds
 * no second mechanism) but they are driven from here, because the queue this store holds is the
 * one the Approvals screen renders and the margin figures on it are pricing's.
 */
import { defineStore } from 'pinia'
import {
  pricingApi,
  type Statement,
  type StorePrices,
  type WholesaleResult,
  type WholesaleRow,
  type WholesaleSettings
} from '@/api/pricing'
import { purchasingApi, type PriceChangeRequest } from '@/api/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'

interface PricingState {
  settings: WholesaleSettings | null
  /** the open item's price board, keyed so re-opening the same item does not blank the screen */
  board: StorePrices | null
  /** the wholesale rows the Prices → Wholesale list is showing */
  wholesale: WholesaleRow[]
  statement: Statement | null
  /** the pending (or filtered) approvals queue */
  requests: PriceChangeRequest[]
  loading: boolean
  busy: string | null
  error: string | null
  notice: string | null
}

function message(e: unknown): string {
  return (e as Error)?.message || 'Something went wrong'
}

export const usePricingStore = defineStore('pricing', {
  state: (): PricingState => ({
    settings: null,
    board: null,
    wholesale: [],
    statement: null,
    requests: [],
    loading: false,
    busy: null,
    error: null,
    notice: null
  }),
  getters: {
    /** May this user see any of it? Delegates to the warehouse store — the role check lives there. */
    allowed(): boolean {
      return useWarehouseStore().allowed
    },
    markupPct: (s): number => s.settings?.markup_pct ?? 50,
    currency: (s): string => s.settings?.currency || s.board?.currency || s.statement?.currency || 'USD',
    pendingRequests: (s): PriceChangeRequest[] => s.requests.filter((r) => r.workflow_state === 'Pending Approval'),
    pendingCount(): number {
      return this.pendingRequests.length
    }
  },
  actions: {
    /** Load `me` once, then ask the warehouse store's `allowed` getter. Sets `error` when refused. */
    async ensureAllowed(): Promise<boolean> {
      const warehouse = useWarehouseStore()
      if (!warehouse.me && !warehouse.meError) await warehouse.loadMe()
      if (!warehouse.allowed) {
        this.error = 'Pricing is head office’s — warehouse admin or head office only'
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

    // ---------------------------------------------------------------- §A the chain-wide rule
    async loadSettings(force = false) {
      if (this.settings && !force) return this.settings
      this.error = null
      try {
        this.settings = await pricingApi.wholesale_settings()
        return this.settings
      } catch (e) {
        this.error = message(e)
        return null
      }
    },
    /** Set the chain markup. **0 is legal** — ship at cost; the server refuses < 0 and > 1000. */
    async setMarkup(pct: number) {
      if (!(await this.ensureAllowed())) return null
      this.busy = 'markup'
      this.error = null
      try {
        this.settings = await pricingApi.set_wholesale_markup(pct)
        this.notice = `Wholesale markup is now ${this.settings.markup_pct}% on what Houston paid`
        // every wholesale figure on screen was derived from the old rule
        if (this.wholesale.length) await this.loadWholesale(this.wholesale.map((r) => r.item_code))
        if (this.board) await this.loadBoard(this.board.item_code, this.board.price_list)
        return this.settings
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },
    async loadWholesale(itemCodes: string[]): Promise<WholesaleResult | null> {
      const codes = [...new Set((itemCodes || []).map((c) => (c || '').trim()).filter(Boolean))]
      if (!codes.length) {
        this.wholesale = []
        return null
      }
      this.loading = true
      this.error = null
      try {
        const out = await pricingApi.wholesale(codes)
        this.wholesale = out.items
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    /** Type a wholesale price on one item; `null` clears it and returns the item to the rule. */
    async setWholesale(itemCode: string, rate: number | null) {
      if (!(await this.ensureAllowed())) return null
      this.busy = itemCode
      this.error = null
      try {
        const out = await pricingApi.set_wholesale(itemCode, rate)
        const i = this.wholesale.findIndex((r) => r.item_code === itemCode)
        if (i >= 0) this.wholesale[i] = out.item
        else this.wholesale.unshift(out.item)
        this.notice =
          out.item.source === 'override'
            ? `${itemCode} is priced by hand at ${out.item.wholesale}`
            : `${itemCode} is back on the ${out.markup_pct}% chain rule`
        if (this.board?.item_code === itemCode) await this.loadBoard(itemCode, this.board.price_list)
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },

    // ---------------------------------------------------------------- §D the price board
    async loadBoard(itemCode: string, priceList = 'Standard Selling') {
      const code = (itemCode || '').trim()
      if (!code) {
        this.error = 'Choose an item to price'
        return null
      }
      this.loading = true
      this.error = null
      try {
        this.board = await pricingApi.store_prices(code, priceList)
        return this.board
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    /**
     * Raise one price change. A **reason is required** — the server throws without one, so the
     * board collects it rather than letting a manager meet that after typing eleven prices.
     */
    async raisePriceChange(itemCode: string, boutique: string, proposedRate: number, opts: { reason: string; valid_from?: string; valid_upto?: string }) {
      this.busy = `${itemCode}|${boutique}`
      this.error = null
      try {
        return await purchasingApi.request_price_change(itemCode, boutique, proposedRate, opts.reason, opts.valid_from, opts.valid_upto)
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },

    // ---------------------------------------------------------------- §D the approvals queue
    async loadRequests(filters: { boutique?: string; status?: string; item_code?: string; limit?: number } = {}) {
      this.loading = true
      this.error = null
      try {
        const out = await purchasingApi.price_change_requests(filters.boutique, filters.status ?? 'Pending Approval', filters.item_code, filters.limit ?? 100)
        this.requests = out.requests
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },
    /**
     * Approve or reject. **Approving is what creates the store-scoped pricing rule** — that is
     * v0.1 behaviour and nothing here reimplements it; the board is simply re-read afterwards so
     * it shows the new price rather than the one it was approved away from.
     */
    async decide(name: string, action: 'Approve' | 'Reject' = 'Approve', reason?: string) {
      if (!(await this.ensureAllowed())) return null
      this.busy = name
      this.error = null
      try {
        const out = await purchasingApi.approve_price_change(name, action, reason)
        const i = this.requests.findIndex((r) => r.name === name)
        const row = i >= 0 ? this.requests[i] : null
        if (i >= 0 && row) this.requests[i] = { ...row, workflow_state: out.workflow_state, pricing_rule: out.pricing_rule ?? null }
        this.notice =
          out.workflow_state === 'Approved'
            ? `${name} approved — ${row ? `${row.boutique} now sells ${row.item_code} at the new price` : 'the store pricing rule is live'}`
            : `${name} rejected — the store keeps its current price`
        if (this.board && row && this.board.item_code === row.item_code) await this.loadBoard(this.board.item_code, this.board.price_list)
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },

    // ---------------------------------------------------------------- §C the statement
    async loadStatement(from: string, to: string, boutique?: string | null) {
      this.loading = true
      this.error = null
      try {
        this.statement = await pricingApi.statement(from, to, boutique || null)
        return this.statement
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    }
  }
})
