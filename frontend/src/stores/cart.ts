import { defineStore } from 'pinia'
import type { Customer, Item } from '@/api'
import { computeTotals, type Totals } from '@/utils/totals'
import { round } from '@/utils/money'
import { useCatalogStore } from './catalog'
import { usePromosStore } from './promos'
import { useWebOrdersStore } from './webOrders' // v0.4 G

export interface CartLine {
  id: string
  item_code: string
  item_name: string
  qty: number
  rate: number
  serial_no?: string
  certificate_no?: string
  discount_amount: number
  taxable: boolean
}

interface CartState {
  lines: CartLine[]
  customer: Customer | null
  loyalty_points_redeemed: number
  notes: string
}

let seq = 0

/** v0.4 I — promo + coupon discount for a line (whole line), folded into the totals math. */
function extraDiscount(id: string): number {
  try {
    return usePromosStore().extraPerLine[id] || 0
  } catch {
    return 0
  }
}

export const useCartStore = defineStore('cart', {
  state: (): CartState => ({ lines: [], customer: null, loyalty_points_redeemed: 0, notes: '' }),
  getters: {
    count: (s) => s.lines.reduce((n, l) => n + l.qty, 0),
    totals(s): Totals {
      const catalog = useCatalogStore()
      return computeTotals(
        s.lines.map((l) => ({ qty: l.qty, rate: l.rate, discount_amount: round(l.discount_amount + extraDiscount(l.id)), taxable: l.taxable })),
        catalog.taxRate,
        s.loyalty_points_redeemed,
        catalog.loyalty?.conversion_factor ?? 0
      )
    },
    /** v0.4 I — promo + coupon discount per line id (whole line) */
    extras(s): Record<string, number> {
      return Object.fromEntries(s.lines.map((l) => [l.id, extraDiscount(l.id)]))
    },
    /** Max points that can be redeemed: customer balance, capped to the bill value. */
    maxRedeemable(s): number {
      const catalog = useCatalogStore()
      if (!s.customer || !catalog.loyalty) return 0
      const billBeforeLoyalty = computeTotals(
        s.lines.map((l) => ({ qty: l.qty, rate: l.rate, discount_amount: round(l.discount_amount + extraDiscount(l.id)), taxable: l.taxable })),
        catalog.taxRate
      ).grand_total
      const cf = catalog.loyalty.conversion_factor || 0
      const byBill = cf > 0 ? Math.floor(billBeforeLoyalty / cf) : 0
      return Math.max(0, Math.min(s.customer.loyalty_points, byBill))
    },
    pointsEarned(s): number {
      const catalog = useCatalogStore()
      if (!s.customer || !catalog.loyalty) return 0
      const t = this.totals as Totals
      return Math.floor(t.net_total * (catalog.loyalty.collection_factor || 0))
    },
    usedSerials: (s) => new Set(s.lines.map((l) => l.serial_no).filter(Boolean) as string[])
  },
  actions: {
    add(item: Item, serial_no?: string) {
      const catalog = useCatalogStore()
      const rate = catalog.rateFor(item.item_code)
      if (item.has_serial_no) {
        if (!serial_no) throw new Error('Serial number required')
        if (this.lines.some((l) => l.serial_no === serial_no)) return
        this.lines.push({
          id: `L${++seq}`,
          item_code: item.item_code,
          item_name: item.item_name,
          qty: 1,
          rate,
          serial_no,
          certificate_no: item.maison_certificate_no,
          discount_amount: 0,
          taxable: item.maison_taxable === 1
        })
        return
      }
      const existing = this.lines.find((l) => l.item_code === item.item_code && !l.serial_no)
      if (existing) {
        existing.qty += 1
        return
      }
      this.lines.push({
        id: `L${++seq}`,
        item_code: item.item_code,
        item_name: item.item_name,
        qty: 1,
        rate,
        discount_amount: 0,
        taxable: item.maison_taxable === 1
      })
    },
    setQty(id: string, qty: number) {
      const l = this.lines.find((x) => x.id === id)
      if (!l || l.serial_no) return
      if (qty <= 0) this.remove(id)
      else l.qty = Math.floor(qty)
    },
    setDiscount(id: string, amount: number) {
      const l = this.lines.find((x) => x.id === id)
      if (!l) return
      l.discount_amount = Math.max(0, Math.min(round(amount), round(l.qty * l.rate)))
      this.clampLoyalty()
    },
    setDiscountPercent(id: string, pct: number) {
      const l = this.lines.find((x) => x.id === id)
      if (!l) return
      this.setDiscount(id, round((l.qty * l.rate * Math.max(0, Math.min(pct, 100))) / 100))
    },
    remove(id: string) {
      this.lines = this.lines.filter((l) => l.id !== id)
      this.clampLoyalty()
    },
    setCustomer(c: Customer | null) {
      this.customer = c
      this.loyalty_points_redeemed = 0
      if (c) {
        // v0.4 I — tier progress for the client card (cached; offline fallback)
        import('./loyalty').then((m) => void m.useLoyaltyStore().load(c)).catch(() => undefined)
      }
    },
    redeem(points: number) {
      this.loyalty_points_redeemed = Math.max(0, Math.min(Math.floor(points), this.maxRedeemable))
    },
    clampLoyalty() {
      if (this.loyalty_points_redeemed > this.maxRedeemable) this.loyalty_points_redeemed = this.maxRedeemable
    },
    clear() {
      this.lines = []
      this.customer = null
      this.loyalty_points_redeemed = 0
      this.notes = ''
      try {
        usePromosStore().reset()
      } catch {
        /* store not active (unit tests) */
      }
      // --- v0.4 G: a web order being collected is bound to this cart ---
      try {
        useWebOrdersStore().clearActive()
      } catch {
        /* store not active (unit tests) */
      }
      // --- end v0.4 G ---
    }
  }
})
