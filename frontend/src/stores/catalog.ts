import { defineStore } from 'pinia'
import { api, DEFAULT_SETTINGS, normalizeSettings, type Bootstrap, type Item, type LoyaltyProgram, type PosSettings, type PricingRule, type TaxRow } from '@/api'
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
  /** v0.2 — scannable code → item_code */
  barcodes: Record<string, string>
  /** v0.2 — merged POS settings from bootstrap */
  settings: PosSettings
  /** v0.2 — device-level override of settings.show_product_images (null = follow boutique) */
  imagesOverride: boolean | null
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
    barcodes: {},
    settings: { ...DEFAULT_SETTINGS },
    imagesOverride: null,
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
    loaded: (s) => s.items.length > 0,
    /** Effective "show product images": device override, else boutique/global setting. */
    showImages: (s) => (s.imagesOverride === null ? !!s.settings.show_product_images : s.imagesOverride),
    /** Receipt QR base: settings, else the current origin (dev / mock). */
    receiptQrBase: (s) => s.settings.receipt_qr_base_url || (typeof location !== 'undefined' ? location.origin : '')
  },
  actions: {
    /** Hydrate from Dexie (instant, offline). */
    async restore() {
      const [items, prices, rules, serials, stock, barcodes] = await Promise.all([
        db.catalog.toArray(),
        db.prices.toArray(),
        db.pricing_rules.toArray(),
        db.serials.toArray(),
        db.stock.toArray(),
        db.barcodes.toArray()
      ])
      this.items = items
      this.barcodes = Object.fromEntries(barcodes.map((b) => [b.code, b.item_code]))
      this.prices = Object.fromEntries(prices.map((p) => [p.item_code, p.rate]))
      this.pricing_rules = rules
      this.serials = Object.fromEntries(serials.map((s) => [s.item_code, s.serials]))
      this.stock = Object.fromEntries(stock.map((s) => [s.item_code, s.qty]))
      const meta = await getSetting<Partial<CatalogState>>('catalog_meta', {})
      this.item_groups = meta.item_groups || []
      this.departments = meta.departments || []
      this.taxes = meta.taxes || []
      this.loyalty = meta.loyalty || null
      this.settings = normalizeSettings(meta.settings)
      this.version = meta.version || null
      this.imagesOverride = await getSetting<boolean | null>('show_images_override', null)
    },
    async persist() {
      await db.transaction('rw', [db.catalog, db.prices, db.pricing_rules, db.serials, db.stock, db.settings, db.barcodes], async () => {
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
        await db.barcodes.clear()
        await db.barcodes.bulkPut(Object.entries(this.barcodes).map(([code, item_code]) => ({ code, item_code })))
        // JSON round-trip strips Vue reactive proxies, which IndexedDB cannot structured-clone
        // (this surfaced as "DataCloneError" on every persist while item_groups held objects).
        await setSetting('catalog_meta', {
          item_groups: JSON.parse(JSON.stringify(this.item_groups)),
          departments: JSON.parse(JSON.stringify(this.departments)),
          taxes: JSON.parse(JSON.stringify(this.taxes)),
          loyalty: this.loyalty ? JSON.parse(JSON.stringify(this.loyalty)) : null,
          settings: JSON.parse(JSON.stringify(this.settings)),
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
      this.barcodes = b.barcodes || {}
      this.settings = normalizeSettings(b.settings)
      this.version = b.version
    },
    /** Device-level image toggle (Settings); null follows the boutique setting. */
    async setImagesOverride(v: boolean | null) {
      this.imagesOverride = v
      await setSetting('show_images_override', v)
    },
    /** After an upload succeeds (or optimistically): update the tile image. */
    setItemImage(item_code: string, url: string | null) {
      const it = this.items.find((i) => i.item_code === item_code)
      if (it) it.image = url
      void this.persist()
    },
    /**
     * Resolve a scanned product code locally (Dexie-backed map): EAN/Code-128 barcode → item,
     * serial label → item + serial. Also accepts a bare item_code.
     */
    resolveCode(code: string): { item: Item; serial_no?: string } | null {
      const c = code.trim()
      if (!c) return null
      const byBarcode = this.barcodes[c] ?? this.barcodes[c.toUpperCase()]
      const item_code = byBarcode ?? (this.byCode[c] ? c : this.byCode[c.toUpperCase()] ? c.toUpperCase() : null)
      if (!item_code) return null
      const item = this.byCode[item_code]
      if (!item) return null
      const serialPool = this.serials[item_code] || []
      const serial = serialPool.find((s) => s === c || s === c.toUpperCase())
      return serial ? { item, serial_no: serial } : { item }
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
        if (d.barcodes && Object.keys(d.barcodes).length) this.barcodes = { ...this.barcodes, ...d.barcodes }
        if (d.settings) this.settings = normalizeSettings(d.settings)
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
