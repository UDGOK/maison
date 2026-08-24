/**
 * Promotions & coupons (v0.4 I).
 *
 * - `promotions`: active ERPNext Pricing Rules for the boutique (`promotions.active`), cached
 *   in Dexie so the chip and the automatic discounts work offline.
 * - `coupon`: one coupon per basket. Validated online with `promotions.check_coupon`; the
 *   discount is recomputed locally with the same rules so the receipt matches the server.
 * - `extraPerLine`: promo + coupon discount per cart line, consumed by the cart totals.
 */
import { defineStore } from 'pinia'
import { v04, type ActivePromotions, type CouponResult, type Promotion } from '@/api/v04'
import { getSetting, setSetting } from '@/db'
import { applyPromotions, couponDiscount, normalizeCouponCode, type AppliedPromotion, type PromoLine } from '@/utils/promos'
import { useCartStore } from './cart'
import { useCatalogStore } from './catalog'

export interface CouponState {
  code: string
  title: string
  discount_type: 'Percent' | 'Amount'
  value: number
  item_group: string | null
  uses_left: number | null
  /** validated by the server (false = accepted offline from the cached list) */
  verified: boolean
}

interface PromosState {
  boutique: string | null
  promotions: Promotion[]
  enabled: boolean
  coupons_available: boolean
  version: string | null
  loading: boolean
  coupon: CouponState | null
  couponError: string
  couponBusy: boolean
  sheetOpen: boolean
}

export const usePromosStore = defineStore('promos', {
  state: (): PromosState => ({
    boutique: null,
    promotions: [],
    enabled: true,
    coupons_available: true,
    version: null,
    loading: false,
    coupon: null,
    couponError: '',
    couponBusy: false,
    sheetOpen: false
  }),
  getters: {
    /** cart lines with item group (promos target groups) */
    promoLines(): PromoLine[] {
      const cart = useCartStore()
      const catalog = useCatalogStore()
      return cart.lines.map((l) => ({
        id: l.id,
        item_code: l.item_code,
        item_group: catalog.byCode[l.item_code]?.item_group || '',
        qty: l.qty,
        rate: l.rate,
        discount_amount: l.discount_amount
      }))
    },
    tier(): string | null {
      return useCartStore().customer?.tier || null
    },
    promoResult(): { perLine: Record<string, number>; applied: AppliedPromotion[]; total: number } {
      if (!this.enabled) return { perLine: {}, applied: [], total: 0 }
      return applyPromotions(this.promoLines, this.promotions, this.tier)
    },
    couponResult(): { total: number; perLine: Record<string, number> } {
      if (!this.coupon) return { total: 0, perLine: {} }
      return couponDiscount(this.coupon, this.promoLines, this.promoResult.perLine)
    },
    /** promo + coupon discount per line id */
    extraPerLine(): Record<string, number> {
      const out: Record<string, number> = { ...this.promoResult.perLine }
      for (const [id, v] of Object.entries(this.couponResult.perLine)) out[id] = Math.round(((out[id] || 0) + v) * 100) / 100
      return out
    },
    applied(): AppliedPromotion[] {
      return this.promoResult.applied
    },
    promoTotal(): number {
      return this.promoResult.total
    },
    couponTotal(): number {
      return this.couponResult.total
    },
    /** promos the current client qualifies for (chip count) */
    liveCount(): number {
      const tier = this.tier
      const today = new Date().toISOString().slice(0, 10)
      return this.promotions.filter((p) => (!p.tier || p.tier === tier) && (!p.valid_from || p.valid_from <= today) && (!p.valid_upto || p.valid_upto >= today)).length
    }
  },
  actions: {
    async restore() {
      const cached = await getSetting<ActivePromotions | null>('promotions', null)
      if (cached) this.apply(cached)
    },
    apply(res: ActivePromotions) {
      this.boutique = res.boutique
      this.promotions = res.promotions || []
      this.enabled = res.enabled !== false
      this.coupons_available = !!res.coupons_available
      this.version = res.version
    },
    /** Fetch active promotions for the boutique (falls back to the cache when offline). */
    async load(boutique: string, force = false) {
      if (this.loading) return
      if (!force && this.boutique === boutique && this.version) return
      this.loading = true
      try {
        if (typeof window !== 'undefined' && window.__awanzOffline) throw new Error('offline')
        const res = await v04.promotions.active(boutique)
        this.apply(res)
        await setSetting('promotions', JSON.parse(JSON.stringify(res)))
      } catch {
        if (this.boutique !== boutique) await this.restore()
      } finally {
        this.loading = false
      }
    },
    /** Validate and attach a coupon to the basket. Returns true when accepted. */
    async applyCoupon(raw: string): Promise<boolean> {
      const code = normalizeCouponCode(raw)
      this.couponError = ''
      if (!code) return false
      const cart = useCartStore()
      if (!cart.lines.length) {
        this.couponError = 'Add items to the basket first'
        return false
      }
      this.couponBusy = true
      try {
        const lines = this.promoLines.map((l) => ({ item_code: l.item_code, qty: l.qty, rate: l.rate, discount_amount: Math.round(((l.discount_amount || 0) + (this.promoResult.perLine[l.id] || 0)) * 100) / 100, item_group: l.item_group }))
        let res: CouponResult
        try {
          res = await v04.promotions.check_coupon(code, lines, this.boutique || undefined, cart.customer?.name)
        } catch (e) {
          const err = e as { code?: string; message?: string }
          if (err.code === 'NETWORK') {
            this.couponError = 'Coupons need a connection to be verified'
            return false
          }
          this.couponError = err.message || 'Could not verify coupon'
          return false
        }
        if (!res.valid) {
          this.couponError = res.message || `Coupon ${code} is not valid`
          return false
        }
        this.coupon = {
          code: res.code,
          title: res.title || res.code,
          discount_type: res.discount_type || 'Percent',
          value: res.value || 0,
          item_group: res.item_group || null,
          uses_left: res.uses_left ?? null,
          verified: true
        }
        cart.clampLoyalty()
        return true
      } finally {
        this.couponBusy = false
      }
    },
    removeCoupon() {
      this.coupon = null
      this.couponError = ''
      useCartStore().clampLoyalty()
    },
    /** Called by the cart when the basket is cleared / paid. */
    reset() {
      this.coupon = null
      this.couponError = ''
      this.sheetOpen = false
    }
  }
})
