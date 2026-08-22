import { defineStore } from 'pinia'
import { api, type Bootstrap, type Item, type LoyaltyProgram, type PricingRule, type TaxRow } from '@/api'
import { db, getSetting, setSetting } from '@/db'
import { useSessionStore } from './session'

interface CatalogState {
  items: Item[]
  prices: Record<string, number>
  pricing_rules: PricingRule[]
  serials: Record<string, string[]>
  stock: Record<string, number>
  item_groups: string[]
  departments: string[]
  taxes: TaxRow[]
  loyalty: LoyaltyProgram | null
  version: string | null
  loading: boolean
  error: string | null
}

export const useCatalogStore = defineStore('catalog', {
  state: (): CatalogState => ({
    items: [],
    prices: {},
    pricing_rules: [],
    serials: {},
    stock: {},
    item_groups: [],
    departments: [],
    taxes: [],
    loyalty: null,
    version: null,
    loading: false,
    error: null
  }),
  getters: {
    taxRate: (s) => s.taxes.reduce((sum, t) => sum + (t.rate || 0), 0),
    byCode: (s) => Object.fromEntries(s.items.map((i) => [i.item_code, i])) as Record<string, Item>,
    /** Effective rate: boutique pricing rule (if valid today) overrides the price list. */
    rateFor(s) {
      const today = new Date().toISOString().slice(0, 10)
      const rules = new Map<string, PricingRule>()
      for (const r of s.pricing_rules) {
        if (r.valid_from && r.valid_from > today) continue
        if (r.valid_upto && r.valid_upto < today) continue
        rules.set(r.item_code, r)
      }
      return (code: string): number => rules.get(code)?.rate ?? s.prices[code] ?? 0
    },
    loaded: (s) => s.items.length > 0
  },
  actions: {
    /** Hydrate from Dexie (instant, offline). */
    async restore() {
      const [items, prices, rules, serials, stock] = await Promise.all([
        db.catalog.toArray(),
        db.prices.toArray(),
        db.pricing_rules.toArray(),
        db.serials.toArray(),
        db.stock.toArray()
      ])
      this.items = items
      this.prices = Object.fromEntries(prices.map((p) => [p.item_code, p.rate]))
      this.pricing_rules = rules
      this.serials = Object.fromEntries(serials.map((s) => [s.item_code, s.serials]))
      this.stock = Object.fromEntries(stock.map((s) => [s.item_code, s.qty]))
      const meta = await getSetting<Partial<CatalogState>>('catalog_meta', {})
      this.item_groups = meta.item_groups || []
      this.departments = meta.departments || []
      this.taxes = meta.taxes || []
      this.loyalty = meta.loyalty || null
      this.version = meta.version || null
    },
    async persist() {
      await db.transaction('rw', [db.catalog, db.prices, db.pricing_rules, db.serials, db.stock, db.settings], async () => {
        await db.catalog.clear()
        await db.catalog.bulkPut(JSON.parse(JSON.stringify(this.items)))
        await db.prices.clear()
        await db.prices.bulkPut(Object.entries(this.prices).map(([item_code, rate]) => ({ item_code, rate })))
        await db.pricing_rules.clear()
        await db.pricing_rules.bulkPut(JSON.parse(JSON.stringify(this.pricing_rules)))
        await db.serials.clear()
        await db.serials.bulkPut(Object.entries(this.serials).map(([item_code, serials]) => ({ item_code, serials: [...serials] })))
        await db.stock.clear()
        await db.stock.bulkPut(Object.entries(this.stock).map(([item_code, qty]) => ({ item_code, qty })))
        // JSON round-trip strips Vue reactive proxies, which IndexedDB cannot structured-clone
        // (this surfaced as "DataCloneError" on every persist while item_groups held objects).
        await setSetting('catalog_meta', {
          item_groups: JSON.parse(JSON.stringify(this.item_groups)),
          departments: JSON.parse(JSON.stringify(this.departments)),
          taxes: JSON.parse(JSON.stringify(this.taxes)),
          loyalty: this.loyalty ? JSON.parse(JSON.stringify(this.loyalty)) : null,
          version: this.version
        })
      })
    },
    applyBootstrap(b: Bootstrap) {
      this.items = b.items.filter((i) => !i.disabled)
      this.prices = b.prices
      this.pricing_rules = b.pricing_rules
      this.serials = b.serials
      this.stock = b.stock
      this.item_groups = b.item_groups
      this.departments = b.departments
      this.taxes = b.taxes
      this.loyalty = b.loyalty_program
      this.version = b.version
    },
    /** Full bootstrap for a boutique; also primes the session (boutique + associates). */
    async bootstrap(boutique: string) {
      this.loading = true
      this.error = null
      try {
        const b = await api.catalog.bootstrap(boutique)
        this.applyBootstrap(b)
        await useSessionStore().setBoutique(b.boutique, b.associates)
        await this.persist()
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.loading = false
      }
    },
    /** Delta refresh: merge changed rows, drop deleted. */
    async refresh() {
      const session = useSessionStore()
      if (!session.boutique) return false
      if (!this.version) return this.bootstrap(session.boutique.name)
      try {
        const d = await api.catalog.delta(session.boutique.name, this.version)
        const map = new Map(this.items.map((i) => [i.item_code, i]))
        for (const it of d.items || []) {
          if (it.disabled) map.delete(it.item_code)
          else map.set(it.item_code, it)
        }
        for (const code of d.deleted || []) map.delete(code)
        this.items = [...map.values()]
        Object.assign(this.prices, d.prices || {})
        if (d.pricing_rules?.length) {
          const rm = new Map(this.pricing_rules.map((r) => [r.name, r]))
          for (const r of d.pricing_rules) rm.set(r.name, r)
          this.pricing_rules = [...rm.values()]
        }
        if (d.serials) this.serials = { ...this.serials, ...d.serials }
        if (d.stock) this.stock = { ...this.stock, ...d.stock }
        if (d.item_groups?.length) this.item_groups = d.item_groups
        if (d.departments?.length) this.departments = d.departments
        if (d.taxes?.length) this.taxes = d.taxes
        if (d.loyalty_program) this.loyalty = d.loyalty_program
        this.version = d.version
        await this.persist()
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      }
    },
    /** Optimistically remove a sold serial / decrement stock so the grid stays accurate offline. */
    consume(item_code: string, qty: number, serial_no?: string) {
      if (serial_no && this.serials[item_code]) this.serials[item_code] = this.serials[item_code].filter((s) => s !== serial_no)
      this.stock[item_code] = Math.max(0, (this.stock[item_code] ?? 0) - qty)
      void this.persist()
    },
    search(q: string, group: string | null, department: string | null): Item[] {
      const s = q.trim().toLowerCase()
      return this.items.filter((i) => {
        if (group && i.item_group !== group) return false
        if (department && i.maison_department !== department) return false
        if (!s) return true
        return (
          i.item_name.toLowerCase().includes(s) ||
          i.item_code.toLowerCase().includes(s) ||
          (i.maison_stones || '').toLowerCase().includes(s) ||
          (i.maison_metal || '').toLowerCase().includes(s) ||
          (this.serials[i.item_code] || []).some((sn) => sn.toLowerCase().includes(s))
        )
      })
    }
  }
})
