import { defineStore } from 'pinia'
import type { Customer, Item } from '@/api'
import { computeTotals, type Totals } from '@/utils/totals'
import { round } from '@/utils/money'
import { useCatalogStore } from './catalog'
import { usePromosStore } from './promos'
import { useWebOrdersStore } from './webOrders' // v0.4 G
import { useAgeStore } from './age' // v0.6 N
import type { RewardTier } from '@/api' // v0.6 Q
import { tierDiscount } from '@/api/v06' // v0.6 Q

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
  /** v0.6 Q — fixed reward tier(s) redeemed this transaction (one unless stacking is enabled) */
  reward_tiers: RewardTier[]
}

let seq = 0

/** v0.5 K — points per currency unit: program-level factor, else the client's tier row, else the base tier. */
export function collectionFactor(lp: { collection_factor?: number; tiers?: { tier?: string; tier_name?: string; min_spent?: number; collection_factor?: number }[] } | null, tier: string | null | undefined): number {
  if (!lp) return 0
  if (lp.collection_factor) return lp.collection_factor
  const rows = lp.tiers || []
  const mine = rows.find((r) => (r.tier || r.tier_name) === tier)
  if (mine?.collection_factor) return mine.collection_factor
  const base = [...rows].sort((a, b) => (a.min_spent || 0) - (b.min_spent || 0))[0]
  return base?.collection_factor || 0
}

/** v0.4 I — promo + coupon discount for a line (whole line), folded into the totals math. */
function extraDiscount(id: string): number {
  try {
    return usePromosStore().extraPerLine[id] || 0
  } catch {
    return 0
  }
}

export const useCartStore = defineStore('cart', {
  state: (): CartState => ({ lines: [], customer: null, loyalty_points_redeemed: 0, notes: '', reward_tiers: [] }),
  getters: {
    count: (s) => s.lines.reduce((n, l) => n + l.qty, 0),
    totals(s): Totals {
      const catalog = useCatalogStore()
      const lines = s.lines.map((l) => ({ qty: l.qty, rate: l.rate, discount_amount: round(l.discount_amount + extraDiscount(l.id)), taxable: l.taxable }))
      // --- v0.6 Q: a fixed reward tier is a fixed amount off the bill (conversion factor 1 → amount = "points") ---
      if (s.reward_tiers.length) {
        const before = computeTotals(lines, catalog.taxRate)
        const amount = tierDiscount(s.reward_tiers, before.grand_total)
        return computeTotals(lines, catalog.taxRate, amount, 1)
      }
      // --- end v0.6 Q ---
      return computeTotals(lines, catalog.taxRate, s.loyalty_points_redeemed, catalog.loyalty?.conversion_factor ?? 0)
    },
    /** v0.6 Q — points the redeemed tier(s) cost */
    rewardPoints: (s) => s.reward_tiers.reduce((n, t) => n + t.points, 0),
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
      // --- v0.5 K: the bench returns the factor per tier (`tiers[].collection_factor`), not at the top level ---
      return Math.floor(t.net_total * collectionFactor(catalog.loyalty, s.customer.tier))
      // --- end v0.5 K ---
    },
    usedSerials: (s) => new Set(s.lines.map((l) => l.serial_no).filter(Boolean) as string[])
  },
  actions: {
    add(item: Item, serial_no?: string) {
      const catalog = useCatalogStore()
      // --- v0.6 N: age-restricted items wait behind the ID check (the add is replayed when it passes) ---
      try {
        if (!useAgeStore().gate(item, serial_no)) return
      } catch {
        /* store not active (unit tests without the age store) */
      }
      // --- end v0.6 N ---
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
      this.reward_tiers = [] // v0.6 Q
      if (c) {
        // v0.4 I — tier progress for the client card (cached; offline fallback)
        import('./loyalty').then((m) => void m.useLoyaltyStore().load(c)).catch(() => undefined)
      }
    },
    redeem(points: number) {
      this.loyalty_points_redeemed = Math.max(0, Math.min(Math.floor(points), this.maxRedeemable))
    },
    // --- v0.6 Q: fixed reward tiers (one per transaction unless stacking is on) ---
    redeemTier(tier: RewardTier | null, allowStacking = false) {
      if (!tier) {
        this.reward_tiers = []
        return
      }
      if (!this.customer || this.customer.loyalty_points < tier.points) return
      this.loyalty_points_redeemed = 0
      if (allowStacking) {
        if (this.reward_tiers.some((t) => t.name === tier.name)) return
        if (this.rewardPoints + tier.points > this.customer.loyalty_points) return
        this.reward_tiers = [...this.reward_tiers, tier]
      } else this.reward_tiers = [tier]
    },
    removeTier(name: string) {
      this.reward_tiers = this.reward_tiers.filter((t) => t.name !== name)
    },
    // --- end v0.6 Q ---
    clampLoyalty() {
      if (this.loyalty_points_redeemed > this.maxRedeemable) this.loyalty_points_redeemed = this.maxRedeemable
    },
    clear() {
      this.lines = []
      this.customer = null
      this.loyalty_points_redeemed = 0
      this.notes = ''
      this.reward_tiers = [] // v0.6 Q
      // --- v0.6 N: the age check covers one transaction ---
      try {
        useAgeStore().reset()
      } catch {
        /* store not active (unit tests) */
      }
      // --- end v0.6 N ---
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
