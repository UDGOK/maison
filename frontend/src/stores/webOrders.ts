/**
 * v0.4 G — the boutique's web-order queue and the web order currently being collected.
 *
 * Collection reuses the normal sale: `loadForCollection` fills the cart with the order's lines
 * (serials picked from the boutique stock), attaches the client and remembers the order so Pay
 * sends `sales_order` + only the balance (the amount paid online is an advance on the order).
 */
import { defineStore } from 'pinia'
import { webshopApi, type WebEnquiry, type WebOrder, type WebOrderStatus, type WebshopApi } from '@/api/webshop'
import type { Item } from '@/api'
import { round } from '@/utils/money'
import { useCartStore } from './cart'
import { useCatalogStore } from './catalog'

interface State {
  orders: WebOrder[]
  enquiries: WebEnquiry[]
  counts: { New: number; Picking: number; Ready: number; Collected: number }
  loading: boolean
  error: string
  loadedAt: number | null
  /** server clock (site timezone) at `loadedAt`, to age rows without guessing the device timezone */
  serverTime: number | null
  /** order being collected at the counter (set by `loadForCollection`, cleared with the cart) */
  active: { name: string; prepaid: number; customer: string; grand_total: number } | null
}

export const useWebOrdersStore = defineStore('webOrders', {
  state: (): State => ({ orders: [], enquiries: [], counts: { New: 0, Picking: 0, Ready: 0, Collected: 0 }, loading: false, error: '', loadedAt: null, serverTime: null, active: null }),
  getters: {
    open: (s) => s.orders.filter((o) => ['New', 'Picking', 'Ready'].includes(o.status)),
    badge: (s) => s.counts.New + s.counts.Picking + s.counts.Ready + s.enquiries.filter((e) => e.status === 'New').length,
    prepaid: (s) => (s.active ? s.active.prepaid : 0),
    /** "now" on the server clock, in the same naive-local frame as the rows' timestamps */
    serverNow: (s) => (s.serverTime && s.loadedAt ? s.serverTime + (Date.now() - s.loadedAt) : Date.now())
  },
  actions: {
    async load(boutique: string, includeDone = false) {
      this.loading = true
      this.error = ''
      try {
        const r = await webshopApi.web_orders(boutique, includeDone)
        this.orders = r.orders
        this.enquiries = r.enquiries
        this.counts = r.counts
        this.loadedAt = Date.now()
        this.serverTime = new Date(r.server_time.replace(' ', 'T')).getTime()
      } catch (e) {
        this.error = (e as Error).message || 'Could not load web orders'
      } finally {
        this.loading = false
      }
    },
    async setStatus(name: string, status: WebOrderStatus, note?: string) {
      await webshopApi.set_web_order_status(name, status, note)
      const o = this.orders.find((x) => x.name === name)
      if (o) {
        o.status = status
        if (note !== undefined) o.note = note
      }
    },
    async updateEnquiry(name: string, status: WebEnquiry['status'], response?: string) {
      await webshopApi.update_enquiry(name, status, response)
      const e = this.enquiries.find((x) => x.name === name)
      if (e) {
        e.status = status
        if (response !== undefined) e.response = response
      }
    },
    /**
     * Put the order into the cart for collection. Returns the lines that could not be loaded
     * (item missing from the device catalogue) so the associate can act.
     */
    async loadForCollection(order: WebOrder, api: WebshopApi = webshopApi): Promise<string[]> {
      const cart = useCartStore()
      const catalog = useCatalogStore()
      const full = order.customer_doc !== undefined ? order : await api.web_order(order.name)
      cart.clear()
      const missing: string[] = []
      for (const line of full.items) {
        const item: Item | undefined = catalog.byCode[line.item_code]
        if (!item) {
          missing.push(line.item_code)
          continue
        }
        if (item.has_serial_no) {
          const used = cart.usedSerials
          const serials = (line.serials_here.length ? line.serials_here : catalog.serials[line.item_code] || []).filter((s) => !used.has(s))
          for (let i = 0; i < line.qty; i++) {
            const serial = serials[i]
            if (!serial) {
              missing.push(`${line.item_code} (serial)`)
              break
            }
            cart.add(item, serial)
          }
        } else {
          for (let i = 0; i < line.qty; i++) cart.add(item)
        }
        // keep the price the client saw online
        const added = cart.lines.filter((l) => l.item_code === line.item_code)
        for (const l of added) l.rate = line.rate
      }
      if (full.customer_doc) cart.setCustomer(full.customer_doc)
      cart.notes = `Web order ${full.name}`
      this.active = { name: full.name, prepaid: round(full.prepaid_amount), customer: full.customer, grand_total: full.grand_total }
      return missing
    },
    clearActive() {
      this.active = null
    }
  }
})
