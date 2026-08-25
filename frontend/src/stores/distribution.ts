/**
 * v1.1 "Onboarding a product" §A — state for **Houston pushing stock out to the stores**.
 *
 * Same conventions as `stores/purchasing.ts`, deliberately:
 *
 *  - **Actions never throw.** On failure they set `error` and return `null`, so a sheet can put
 *    the message in a banner without wrapping every call in try/catch. `send`'s refusal is
 *    multi-line with `•` bullets naming the shortfall per item — it is kept **verbatim**, newlines
 *    and all, because reformatting it into one line is what loses the shortfalls.
 *  - `loading` covers the plan read, `busy` holds a marker while a write runs.
 *  - Writes are gated behind the warehouse store's `allowed` getter; the server enforces the same
 *    gate regardless (warehouse admin / head office only — pushing is Houston's act).
 *
 * The plan is held **per item code** rather than as one list: the sheet is opened for one item at
 * a time, from Stock, from Buying and from the Inbound receipt confirmation, and re-opening it for
 * an item already planned should not blank the screen while a request is in flight.
 */
import { defineStore } from 'pinia'
import {
  distributionApi,
  DEFAULT_COVER_DAYS,
  type DistributionLine,
  type DistributionStore,
  type PlanItem,
  type SendResult,
  type SplitMode,
  type SplitResult
} from '@/api/distribution'
import type { Priority } from '@/api/warehouse'
import { useWarehouseStore } from '@/stores/warehouse'

interface DistributionState {
  /** the enabled shops a push may address, in store-code order */
  stores: DistributionStore[]
  /** HOU-WH — where a push leaves from */
  warehouse: string | null
  /** item_code → its plan row (Houston's position plus one row per store) */
  plans: Record<string, PlanItem>
  velocityDays: number
  asOf: string | null
  /** what the last `send` created, for the confirmation */
  lastSend: SendResult | null
  loading: boolean
  busy: string | null
  error: string | null
  notice: string | null
}

function message(e: unknown): string {
  return (e as Error)?.message || 'Something went wrong'
}

export const useDistributionStore = defineStore('distribution', {
  state: (): DistributionState => ({
    stores: [],
    warehouse: null,
    plans: {},
    velocityDays: 28,
    asOf: null,
    lastSend: null,
    loading: false,
    busy: null,
    error: null,
    notice: null
  }),
  getters: {
    /** May this user push stock out of Houston? Delegates to the warehouse store. */
    allowed(): boolean {
      return useWarehouseStore().allowed
    },
    storeCount: (s): number => s.stores.length,
    planFor:
      (s) =>
      (itemCode: string): PlanItem | null =>
        s.plans[itemCode] ?? null
  },
  actions: {
    /** Load `me` once, then ask the warehouse store's `allowed` getter. Sets `error` when refused. */
    async ensureAllowed(): Promise<boolean> {
      const warehouse = useWarehouseStore()
      if (!warehouse.me && !warehouse.meError) await warehouse.loadMe()
      if (!warehouse.allowed) {
        this.error = 'Sending stock to stores is Houston’s — warehouse admin or head office only'
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

    /** The shops a push may address. Cached — the list does not change while a sheet is open. */
    async loadStores(force = false) {
      if (this.stores.length && !force) return { stores: this.stores, count: this.stores.length, warehouse: this.warehouse || '' }
      this.error = null
      try {
        const out = await distributionApi.stores()
        this.stores = out.stores
        this.warehouse = out.warehouse
        return out
      } catch (e) {
        this.error = message(e)
        return null
      }
    },

    /** Houston's position and every store's, for one item or several. */
    async loadPlan(itemCodes: string[], boutiques?: string[] | null) {
      const codes = [...new Set((itemCodes || []).map((c) => (c || '').trim()).filter(Boolean))]
      if (!codes.length) {
        this.error = 'Choose at least one item to distribute'
        return null
      }
      this.loading = true
      this.error = null
      try {
        const out = await distributionApi.plan(codes, boutiques ?? null)
        for (const item of out.items) this.plans[item.item_code] = item
        this.stores = out.stores
        this.warehouse = out.warehouse
        this.velocityDays = out.velocity_days
        this.asOf = out.as_of
        return out
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.loading = false
      }
    },

    /**
     * Ask the server for an allocation. It is a **calculator, not a gate** — it will allocate more
     * than Houston has, so the sheet's footer can turn red before the send. `send` is what refuses.
     */
    async suggest(itemCode: string, qty: number, mode: SplitMode = 'even', coverDays: number | null = null, boutiques?: string[] | null): Promise<SplitResult | null> {
      this.busy = `split:${mode}`
      this.error = null
      try {
        return await distributionApi.suggest_split(itemCode, qty, mode, boutiques ?? null, coverDays ?? (mode === 'topup' ? DEFAULT_COVER_DAYS : null))
      } catch (e) {
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    },

    /**
     * Send it: one request + one shipment per store, created **and** approved in one action
     * (client decision 2 — the warehouse admin is both requester and approver, so a Pending step
     * would be theatre). Refused as a whole or written as a whole; never half-sent.
     */
    async send(lines: DistributionLine[], reason?: string | null, priority: Priority | string = 'Normal'): Promise<SendResult | null> {
      if (!(await this.ensureAllowed())) return null
      if (!lines?.length) {
        this.error = 'Nothing to send — choose at least one store and quantity'
        return null
      }
      this.busy = 'send'
      this.error = null
      try {
        const out = await distributionApi.send(lines, reason ?? null, priority)
        this.lastSend = out
        // the units are spoken for now: they sit in `committed` until the shipment leaves, so the
        // next plan read for this item shows less available. Refresh what we hold rather than
        // leaving a stale "available" on screen behind the confirmation.
        const codes = [...new Set(lines.map((l) => l.item_code))]
        void this.loadPlan(codes)
        this.notice = sendNotice(out)
        return out
      } catch (e) {
        // verbatim: the refusal is multi-line, one `•` per item, and each bullet names a shortfall
        this.error = message(e)
        return null
      } finally {
        this.busy = null
      }
    }
  }
})

/** "3 shipments created · 84 units to 3 stores" — the one line after a successful push. */
export function sendNotice(out: SendResult): string {
  const stores = `${out.stores} store${out.stores === 1 ? '' : 's'}`
  const units = `${out.units} unit${out.units === 1 ? '' : 's'}`
  const names = out.shipments.map((s) => s.name).join(', ')
  return `${units} on their way to ${stores} — ${names}`
}
