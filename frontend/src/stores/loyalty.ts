/**
 * v0.4 I — loyalty tier progress per client (`promotions.loyalty`), cached in memory + Dexie so
 * the client card can show "X to next tier" offline. Falls back to the pure ladder math from the
 * bootstrap loyalty program when nothing is cached.
 */
import { defineStore } from 'pinia'
import { v04, type TierProgress } from '@/api/v04'
import type { Customer } from '@/api'
import { getSetting, setSetting } from '@/db'
import { tierStatus } from '@/utils/promos'
import { useCatalogStore } from './catalog'

interface LoyaltyState {
  byCustomer: Record<string, TierProgress>
  loading: Record<string, boolean>
}

export const useLoyaltyStore = defineStore('loyalty', {
  state: (): LoyaltyState => ({ byCustomer: {}, loading: {} }),
  getters: {
    forCustomer: (s) => (name: string | undefined | null): TierProgress | null => (name ? s.byCustomer[name] || null : null)
  },
  actions: {
    async restore() {
      this.byCustomer = await getSetting<Record<string, TierProgress>>('loyalty_progress', {})
    },
    /** Fetch (online) or derive (offline) the tier progress for a client. */
    async load(customer: Customer, force = false): Promise<TierProgress | null> {
      if (!customer?.name) return null
      if (!force && this.byCustomer[customer.name]) {
        void this.refresh(customer)
        return this.byCustomer[customer.name]
      }
      const fromServer = await this.refresh(customer)
      if (fromServer) return fromServer
      return this.fallback(customer)
    },
    async refresh(customer: Customer): Promise<TierProgress | null> {
      if (this.loading[customer.name]) return null
      if (typeof window !== 'undefined' && window.__maisonOffline) return null
      this.loading[customer.name] = true
      try {
        const tp = await v04.promotions.loyalty(customer.name)
        this.byCustomer[customer.name] = tp
        await setSetting('loyalty_progress', JSON.parse(JSON.stringify(this.byCustomer)))
        return tp
      } catch {
        return null
      } finally {
        this.loading[customer.name] = false
      }
    },
    /** Offline: derive the ladder from the bootstrap program and the points balance (points ≈ spend × factor). */
    fallback(customer: Customer): TierProgress | null {
      const lp = useCatalogStore().loyalty
      if (!lp) return null
      const tiers = lp.tiers.map((t) => ({ tier: t.tier, min_spent: t.min_spent }))
      const spent = lp.collection_factor ? customer.loyalty_points / lp.collection_factor : 0
      const st = tierStatus(spent, tiers)
      const tp: TierProgress = {
        program: lp.name,
        tier: customer.tier || st.tier,
        points: customer.loyalty_points,
        points_value: customer.points_value,
        spent,
        tiers,
        next_tier: st.next,
        to_next_tier: st.toNext,
        progress: st.progress
      }
      this.byCustomer[customer.name] = tp
      return tp
    }
  }
})
