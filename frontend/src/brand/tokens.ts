/**
 * v0.6 N — brand tokens, pure (no Pinia store / no `@/api` runtime import).
 *
 * This module is deliberately dependency-free at runtime so it can be imported by the mock API
 * (`@/api/mock`) and by `@/stores/catalog` without creating an import cycle. The earlier version
 * of these tokens lived in `@/stores/brand`, which imports `@/stores/catalog` for the `useBrand()`
 * composable; `@/stores/catalog` imports `@/api`, so `@/api/mock` -> `@/stores/brand` ->
 * `@/stores/catalog` -> `@/api` closed a cycle that deadlocked Vitest whenever a suite called
 * `vi.mock('@/api', async () => await import('@/api/mock'))`. Keep this file free of store imports.
 */
import type { Brand } from '@/api'

export const DEFAULT_BRAND: Brand = {
  brand_name: 'CloudChaserz',
  product_name: 'AWANZ POS by CloudChaserz',
  tagline: 'Elevate Your Smoking Experience',
  wordmark_text: 'CLOUDCHASERZ',
  sub_mark: 'AWANZ',
  legal_name: 'CloudChaserz World LLC',
  support_email: 'support@cloudchaserzworld.com',
  brand_website: 'https://cloudchaserzworld.com',
  brand_logo: null,
  vertical: 'Smoke Shop',
  store_noun: 'Store',
  rewards_program_name: 'CloudChaserz Rewards',
  head_office_boutique: null,
  main_warehouse: null,
  // v0.7 — who built the platform; rendered as "Powered by ..." on the Settings screen.
  developer_name: 'Futonix',
  developer_website: 'https://futonix.com'
}

/** The jewellery world (mock API / legacy sites) keeps its own tokens. */
export const JEWELLERY_BRAND: Brand = {
  ...DEFAULT_BRAND,
  brand_name: 'AWANZ',
  product_name: 'AWANZ POS',
  tagline: 'Fine jewellery & timepieces',
  wordmark_text: 'AWANZ',
  sub_mark: 'POS',
  legal_name: 'AWANZ Jewelers',
  support_email: 'concierge@maison.example',
  brand_website: 'https://maison.example',
  vertical: 'Jewellery',
  store_noun: 'Boutique',
  rewards_program_name: 'AWANZ Collectors'
}

export function normalizeBrand(raw?: Partial<Brand> | null): Brand {
  const r = raw || {}
  const vertical = r.vertical === 'Jewellery' || r.vertical === 'General' || r.vertical === 'Smoke Shop' ? r.vertical : DEFAULT_BRAND.vertical
  const str = (k: keyof Brand, d: string) => {
    const v = r[k]
    return typeof v === 'string' && v.trim() ? v.trim() : d
  }
  return {
    brand_name: str('brand_name', DEFAULT_BRAND.brand_name),
    product_name: str('product_name', DEFAULT_BRAND.product_name),
    tagline: str('tagline', DEFAULT_BRAND.tagline),
    wordmark_text: str('wordmark_text', str('brand_name', DEFAULT_BRAND.brand_name).toUpperCase()),
    sub_mark: str('sub_mark', DEFAULT_BRAND.sub_mark),
    legal_name: str('legal_name', ''),
    support_email: str('support_email', ''),
    brand_website: str('brand_website', ''),
    brand_logo: typeof r.brand_logo === 'string' && r.brand_logo ? r.brand_logo : null,
    vertical,
    store_noun: str('store_noun', vertical === 'Jewellery' ? 'Boutique' : 'Store'),
    rewards_program_name: str('rewards_program_name', `${str('brand_name', DEFAULT_BRAND.brand_name)} Rewards`),
    head_office_boutique: (r.head_office_boutique as string) || null,
    main_warehouse: (r.main_warehouse as string) || null,
    developer_name: str('developer_name', ''),
    developer_website: str('developer_website', '')
  }
}

/** Age-gate switches (`AWANZ POS Settings`, merged into `bootstrap.settings`). */
export interface AgeGateSettings {
  age_verification_required: boolean
  minimum_age: number
  id_scan_enabled: boolean
  /** rewards switch that rides on the same settings blob: more than one tier per transaction */
  reward_allow_stacking: boolean
}

export function normalizeAge(raw?: Partial<Record<keyof AgeGateSettings, unknown>> | null): AgeGateSettings {
  const r = raw || {}
  const flag = (v: unknown, d: boolean) => (v === undefined || v === null || v === '' ? d : typeof v === 'string' ? v === '1' || v.toLowerCase() === 'true' : !!v)
  const min = Number(r.minimum_age)
  return {
    age_verification_required: flag(r.age_verification_required, true),
    minimum_age: Number.isFinite(min) && min >= 18 ? Math.round(min) : 21,
    id_scan_enabled: flag(r.id_scan_enabled, true),
    reward_allow_stacking: flag(r.reward_allow_stacking, false)
  }
}

export function welcomeLine(brand: Pick<Brand, 'brand_name'>, storeName?: string | null): string {
  const s = (storeName || '').trim()
  if (s && s.toLowerCase().startsWith(brand.brand_name.toLowerCase())) return `Welcome to ${s}`
  return `Welcome to ${brand.brand_name}${s ? ' ' + s : ''}`
}
