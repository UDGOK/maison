/**
 * v0.4 H — next-best-offer tiles for the Sell screen.
 *
 * "Suggested for this client" (3 tiles) loads when a client is attached; "Pairs well with" refreshes
 * (debounced) as the basket changes. Both are best-effort: offline or on any API error the tiles
 * simply hide — the POS never blocks on insights.
 */
import { defineStore } from 'pinia'
import { api, type Recommendation } from '@/api'

interface InsightsState {
  clientFor: string | null
  clientItems: Recommendation[]
  clientLoading: boolean
  basketKey: string
  basketItems: Recommendation[]
  basketLoading: boolean
  /** item codes the associate dismissed this session */
  dismissed: string[]
}

let basketTimer: number | undefined
let basketSeq = 0
let clientSeq = 0

export const useInsightsStore = defineStore('insights', {
  state: (): InsightsState => ({
    clientFor: null,
    clientItems: [],
    clientLoading: false,
    basketKey: '',
    basketItems: [],
    basketLoading: false,
    dismissed: []
  }),
  getters: {
    visibleClientItems: (s) => s.clientItems.filter((r) => !s.dismissed.includes(r.item_code)),
    visibleBasketItems: (s) => s.basketItems.filter((r) => !s.dismissed.includes(r.item_code))
  },
  actions: {
    async loadClient(customer: string | null, boutique?: string) {
      if (!customer) {
        this.clientFor = null
        this.clientItems = []
        return
      }
      if (this.clientFor === customer && this.clientItems.length) return
      const seq = ++clientSeq
      this.clientFor = customer
      this.clientLoading = true
      try {
        const res = await api.insights.recommend_for_client(customer, 3, boutique)
        if (seq !== clientSeq) return
        // belt and braces: never show something the client already owns
        this.clientItems = res.items.filter((r) => !res.owned.includes(r.item_code)).slice(0, 3)
      } catch {
        if (seq === clientSeq) this.clientItems = []
      } finally {
        if (seq === clientSeq) this.clientLoading = false
      }
    },
    /** Debounced (350 ms) so typing quantities does not spam the API. */
    scheduleBasket(items: string[], boutique?: string, customer?: string | null) {
      const key = [...new Set(items)].sort().join('|') + '::' + (customer || '')
      if (key === this.basketKey) return
      window.clearTimeout(basketTimer)
      if (!items.length) {
        this.basketKey = key
        this.basketItems = []
        return
      }
      basketTimer = window.setTimeout(() => void this.loadBasket(items, boutique, customer, key), 350)
    },
    async loadBasket(items: string[], boutique?: string, customer?: string | null, key?: string) {
      const seq = ++basketSeq
      this.basketLoading = true
      try {
        const res = await api.insights.recommend_for_basket([...new Set(items)], 3, boutique, customer || undefined)
        if (seq !== basketSeq) return
        this.basketKey = key ?? this.basketKey
        this.basketItems = res.items.filter((r) => !items.includes(r.item_code)).slice(0, 3)
      } catch {
        if (seq === basketSeq) this.basketItems = []
      } finally {
        if (seq === basketSeq) this.basketLoading = false
      }
    },
    dismiss(code: string) {
      if (!this.dismissed.includes(code)) this.dismissed.push(code)
    },
    reset() {
      window.clearTimeout(basketTimer)
      this.$reset()
    }
  }
})
