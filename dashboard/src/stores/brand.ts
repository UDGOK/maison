/**
 * v0.6 D1 — brand tokens for the Command dashboard.
 *
 * Mirrors the POS composable (`frontend/src/stores/brand.ts` + `frontend/src/brand/tokens.ts`).
 * The Jinja shell already puts the tenant's tokens on the page —
 * `maison_pos/www/maison-dashboard.html` renders
 * `window.maison_brand = {"wordmark_text": "CLOUDCHASERZ", "store_noun": "Store", …}` — but the
 * SPA used to hard-code "Maison" and "Boutique(s)", so a CloudChaserz tenant read
 * `Maison · Today · All Boutiques` on a page whose tab title was already `CLOUDCHASERZ · Command`.
 *
 * Nothing here is reactive to the server: the tokens are baked into the page at render time, so
 * they are read once and frozen. `setBrand()` exists for tests.
 */
import { computed, reactive, ref } from 'vue'

export interface Brand {
  brand_name: string
  product_name: string
  wordmark_text: string
  sub_mark: string
  vertical: string
  /** "Store" / "Boutique" — the tenant's word for one shop */
  store_noun: string
  rewards_program_name: string
}

export const DEFAULT_BRAND: Brand = {
  brand_name: 'Maison',
  product_name: 'Maison POS',
  wordmark_text: 'Maison',
  sub_mark: 'POS',
  vertical: 'Jewellery',
  store_noun: 'Boutique',
  rewards_program_name: 'Maison Collectors',
}

function str(raw: Record<string, unknown>, key: keyof Brand, fallback: string): string {
  const v = raw[key]
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

export function normalizeBrand(raw?: Partial<Record<keyof Brand, unknown>> | null): Brand {
  const r = (raw || {}) as Record<string, unknown>
  const name = str(r, 'brand_name', DEFAULT_BRAND.brand_name)
  return {
    brand_name: name,
    product_name: str(r, 'product_name', DEFAULT_BRAND.product_name),
    wordmark_text: str(r, 'wordmark_text', name),
    sub_mark: str(r, 'sub_mark', DEFAULT_BRAND.sub_mark),
    vertical: str(r, 'vertical', DEFAULT_BRAND.vertical),
    store_noun: str(r, 'store_noun', DEFAULT_BRAND.store_noun),
    rewards_program_name: str(r, 'rewards_program_name', `${name} Rewards`),
  }
}

/** "Store" -> "Stores", "Boutique" -> "Boutiques", "Pharmacy" -> "Pharmacies". */
export function pluralize(noun: string): string {
  if (!noun) return noun
  if (/[^aeiou]y$/i.test(noun)) return noun.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/i.test(noun)) return noun + 'es'
  return noun + 's'
}

export const lower = (s: string) => s.toLocaleLowerCase()

const state = ref<Brand>(normalizeBrand(typeof window !== 'undefined' ? (window.maison_brand as never) : null))

/** Re-read `window.maison_brand` (tests set it, then call this). */
export function refreshBrand(): Brand {
  state.value = normalizeBrand(typeof window !== 'undefined' ? (window.maison_brand as never) : null)
  return state.value
}

/** Override the tokens directly (tests / storybook). */
export function setBrand(raw?: Partial<Record<keyof Brand, unknown>> | null): Brand {
  state.value = normalizeBrand(raw)
  return state.value
}

/**
 * Reactive brand tokens + the derived copy the dashboard renders.
 *
 * `store` / `stores` are the singular / plural nouns capitalised as the tenant writes them
 * ("Store" / "Stores"); `storeLower` / `storesLower` are for mid-sentence use.
 */
export function useBrand() {
  const brand = computed(() => state.value)
  const store = computed(() => brand.value.store_noun)
  const stores = computed(() => pluralize(brand.value.store_noun))
  return reactive({
    brand,
    store,
    stores,
    storeLower: computed(() => lower(store.value)),
    storesLower: computed(() => lower(stores.value)),
    wordmark: computed(() => brand.value.wordmark_text),
    name: computed(() => brand.value.brand_name),
    productName: computed(() => brand.value.product_name),
    /** "Today · All Stores" — the scope line of the top bar */
    scope: computed(() => `Today · All ${pluralize(brand.value.store_noun)}`),
  })
}
