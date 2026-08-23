/**
 * v0.6 N — brand composable. The pure tokens/normalizers live in `@/brand/tokens` (no store
 * imports, so the mock API and the catalogue store can use them without an import cycle); this
 * module adds the reactive `useBrand()` composable and re-exports the tokens for convenience.
 */
import { computed, reactive } from 'vue'
import { useCatalogStore } from './catalog'
import { welcomeLine } from '@/brand/tokens'

export { DEFAULT_BRAND, JEWELLERY_BRAND, normalizeBrand, normalizeAge, welcomeLine } from '@/brand/tokens'
export type { AgeGateSettings } from '@/brand/tokens'

/** Composable: reactive brand tokens + the derived copy the screens use. */
export function useBrand() {
  const catalog = useCatalogStore()
  const brand = computed(() => catalog.brand)
  const storeNoun = computed(() => brand.value.store_noun || 'Store')
  return reactive({
    brand,
    storeNoun,
    wordmark: computed(() => brand.value.wordmark_text),
    subMark: computed(() => brand.value.sub_mark),
    name: computed(() => brand.value.brand_name),
    productName: computed(() => brand.value.product_name),
    programName: computed(() => brand.value.rewards_program_name),
    isJewellery: computed(() => brand.value.vertical === 'Jewellery'),
    isSmokeShop: computed(() => brand.value.vertical === 'Smoke Shop'),
    /** "Thank you for visiting CloudChaserz" */
    thanks: computed(() => `Thank you for visiting ${brand.value.brand_name}`),
    /** "Join CloudChaserz Rewards" */
    join: computed(() => `Join ${brand.value.rewards_program_name}`),
    /** "Welcome to CloudChaserz Montrose" — a store already carrying the brand is not doubled */
    welcome: (storeName?: string | null) => welcomeLine(brand.value, storeName)
  })
}
