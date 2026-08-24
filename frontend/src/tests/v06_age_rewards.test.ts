/** v0.6 N/Q — AAMVA parser, the 21+ age gate (cart ↔ age store), fixed reward tiers, brand tokens. */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ageOn, evaluateAge, looksLikeAamva, parseAamva, parseAamvaDate, syntheticAamva } from '@/scan/aamva'
import { affordableTiers, DEFAULT_TIERS, decideOffline, mockV06, nextReward, tierDiscount, toPayload } from '@/api/v06'
import { useCartStore } from '@/stores/cart'
import { useCatalogStore } from '@/stores/catalog'
import { useAgeStore } from '@/stores/age'
import { useSyncStore } from '@/stores/sync'
import { normalizeAge, normalizeBrand, welcomeLine, JEWELLERY_BRAND } from '@/stores/brand'
import type { Item } from '@/api'

const TODAY = '2026-08-23'

// A real-world-shaped payload (Texas, AAMVA v9): header glued to the first element, CR/LF mix.
const TX_SAMPLE =
  '@\n\x1e\rANSI 636015090102DL00410278ZT03190024DLDAQ12345678\nDCSSAMPLE\nDDEN\nDACALEX\nDDFN\nDADJ\nDDGN\nDCAC\nDCBNONE\nDCDNONE\nDBD01012024\nDBB05151990\nDBA05152030\nDBC1\nDAU070 in\nDAYBRO\nDAG123 MAIN ST\nDAIHOUSTON\nDAJTX\nDAK770980000  \nDCF00000000\nDCGUSA\nDCK0000000000\nDDAF\nDDB01012020\rZTZTA\n'

describe('AAMVA parser', () => {
  it('reads DOB / expiry / initials / jurisdiction from a v9 US payload and never the name', () => {
    const p = parseAamva(TX_SAMPLE)
    expect(p.ok).toBe(true)
    expect(p.dob).toBe('1990-05-15')
    expect(p.expiry).toBe('2030-05-15')
    expect(p.initials).toBe('AS')
    expect(p.jurisdiction).toBe('TX')
    expect(p.country).toBe('USA')
    expect(p.version).toBe(9)
    expect(JSON.stringify(p)).not.toContain('SAMPLE')
    expect(JSON.stringify(p)).not.toContain('MAIN ST')
  })
  it('handles Canadian (CCYYMMDD) and v1 (DAA name) layouts', () => {
    const ca = parseAamva('@\n\x1e\rANSI 636028090102DL00410ZZDLDAQ1\nDCSDOE\nDACJANE\nDBB19880203\nDBA20290203\nDAJON\nDCGCAN\n')
    expect(ca.dob).toBe('1988-02-03')
    expect(ca.expiry).toBe('2029-02-03')
    const v1 = parseAamva('AAMVA6360100101DL00300192DLDAQ1\nDAADOE,JOHN,Q\nDBB19700101\nDBA20270101\nDAJCA\n')
    expect(v1.version).toBe(1)
    expect(v1.dob).toBe('1970-01-01')
    expect(v1.initials).toBe('JD')
  })
  it('rejects non-licence text and payloads without a DOB', () => {
    expect(parseAamva('').reason).toBe('empty')
    expect(parseAamva('2002554634470').ok).toBe(false)
    expect(looksLikeAamva('2002554634470')).toBe(false)
    expect(looksLikeAamva(TX_SAMPLE)).toBe(true)
    const noDob = parseAamva('@\n\x1e\rANSI 636015090102DL00410ZZDLDAQ1\nDCSDOE\nDBA05152030\n')
    expect(noDob.ok).toBe(false)
    expect(noDob.reason).toBe('no_dob')
  })
  it('parses dates in both orders and rejects impossible dates', () => {
    expect(parseAamvaDate('05151990')).toBe('1990-05-15')
    expect(parseAamvaDate('19900515', 'CAN')).toBe('1990-05-15')
    expect(parseAamvaDate('20050101')).toBe('2005-01-01') // month 20 impossible → year first
    expect(parseAamvaDate('02301990')).toBeNull()
    expect(parseAamvaDate('0515199')).toBeNull()
  })
  it('synthetic payloads round-trip through the parser', () => {
    const p = parseAamva(syntheticAamva({ dob: '2001-02-28', expiry: '2031-02-28', family: 'TEST', given: 'MIA', jurisdiction: 'OK' }))
    expect(p).toMatchObject({ ok: true, dob: '2001-02-28', expiry: '2031-02-28', initials: 'MT', jurisdiction: 'OK' })
  })
})

describe('age decision (same rules as maison_pos/api/age.py)', () => {
  it('counts full years only', () => {
    expect(ageOn('2005-08-23', TODAY)).toBe(21)
    expect(ageOn('2005-08-24', TODAY)).toBe(20)
    expect(ageOn('2005-02-28', TODAY)).toBe(21)
  })
  it('accepts 21+ with a valid ID, blocks under 21, blocks expired', () => {
    expect(evaluateAge('1990-05-15', '2030-05-15', 21, TODAY)).toMatchObject({ outcome: 'Verified', ok: true, age: 36, dob_year_ok: 1, expired: 0 })
    expect(evaluateAge('2005-08-24', '2030-01-01', 21, TODAY)).toMatchObject({ outcome: 'Underage', ok: false, age: 20 })
    expect(evaluateAge('1990-05-15', '2026-08-22', 21, TODAY)).toMatchObject({ outcome: 'Expired', ok: false, expired: 1 })
    expect(evaluateAge('1990-05-15', '2026-08-23', 21, TODAY).outcome).toBe('Verified') // expires today = still valid
    expect(evaluateAge(null, null, 21, TODAY).outcome).toBe('Unreadable')
  })
  it('under-age wins over expired, and the payload carries no PII', () => {
    expect(evaluateAge('2010-01-01', '2020-01-01', 21, TODAY).outcome).toBe('Underage')
    const r = decideOffline('Scan', '1990-05-15', '2030-05-15', 21, 'AS', 'TX')
    const payload = toPayload(r, true)
    expect(payload).toMatchObject({ verified: 1, method: 'Scan', offline: 1, dob_year_ok: 1, initials: 'AS', jurisdiction: 'TX' })
    expect(Object.keys(payload)).not.toContain('dob')
  })
  it('mock API mirrors the decision', async () => {
    const ok = await mockV06.age.verify_scan(syntheticAamva({ dob: '1990-05-15', expiry: '2030-05-15' }))
    expect(ok.outcome).toBe('Verified')
    const young = await mockV06.age.verify_scan(syntheticAamva({ dob: '2008-05-15', expiry: '2030-05-15' }))
    expect(young.outcome).toBe('Underage')
    const manual = await mockV06.age.verify_manual('1980-01-01')
    expect(manual).toMatchObject({ ok: true, method: 'Manual' })
  })
})

const VAPE: Item = { item_code: 'DSP-001', item_name: 'Geek Bar Pulse 15K — Miami Mint', item_group: 'Disposables', has_serial_no: 0, is_stock_item: 1, stock_uom: 'Nos', maison_department: 'Vape', maison_taxable: 1, maison_age_restricted: 1 }
const LIGHTER: Item = { item_code: 'ACC-001', item_name: 'Clipper lighter', item_group: 'Accessories', has_serial_no: 0, is_stock_item: 1, stock_uom: 'Nos', maison_department: 'Accessories', maison_taxable: 1, maison_age_restricted: 0 }

describe('age gate store ↔ cart', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const catalog = useCatalogStore()
    catalog.items = [VAPE, LIGHTER]
    catalog.prices = { 'DSP-001': 24.99, 'ACC-001': 2.49 }
    catalog.taxes = [{ description: 'TX', rate: 8.25 }] as any
    catalog.age = normalizeAge({ age_verification_required: 1, minimum_age: 21, id_scan_enabled: 1 })
    useSyncStore().$patch({ browserOnline: false, serverReachable: false } as any) // decisions run on the device
  })

  it('parks a restricted item behind the sheet; non-restricted items add straight away', () => {
    const cart = useCartStore()
    const age = useAgeStore()
    cart.add(LIGHTER)
    expect(cart.lines.map((l) => l.item_code)).toEqual(['ACC-001'])
    expect(age.open).toBe(false)
    cart.add(VAPE)
    expect(cart.lines.map((l) => l.item_code)).toEqual(['ACC-001'])
    expect(age.open).toBe(true)
    expect(age.pending.length).toBe(1)
    expect(age.trigger).toBe(VAPE.item_name)
    expect(age.salonState).toMatchObject({ minimum_age: 21, status: 'ask' })
  })

  it('a 21+ scan replays the parked add and covers the rest of the transaction', async () => {
    const cart = useCartStore()
    const age = useAgeStore()
    cart.add(VAPE)
    const res = await age.scan(syntheticAamva({ dob: '1990-05-15', expiry: '2030-05-15', family: 'SAMPLE', given: 'ALEX' }))
    expect(res?.outcome).toBe('Verified')
    expect(age.open).toBe(false)
    expect(age.isVerified).toBe(true)
    expect(cart.lines.map((l) => l.item_code)).toEqual(['DSP-001'])
    cart.add(VAPE) // second restricted add: no new prompt
    expect(age.open).toBe(false)
    expect(cart.lines[0].qty).toBe(2)
    expect(age.payload).toMatchObject({ verified: 1, method: 'Scan', offline: 1, initials: 'AS' })
    cart.clear()
    expect(age.isVerified).toBe(false) // next transaction asks again
    cart.add(VAPE)
    expect(age.open).toBe(true)
  })

  it('under 21 and expired IDs block: parked items are dropped, sheet shows the reason', async () => {
    const cart = useCartStore()
    const age = useAgeStore()
    cart.add(VAPE)
    const young = await age.scan(syntheticAamva({ dob: '2008-01-01', expiry: '2030-01-01' }))
    expect(young?.outcome).toBe('Underage')
    expect(cart.lines.length).toBe(0)
    expect(age.pending.length).toBe(0)
    expect(age.open).toBe(true)
    expect(age.salonState?.status).toBe('blocked')
    expect(age.error).toMatch(/Under 21/)
    age.reset()
    cart.add(VAPE)
    const expired = await age.manual('1990-05-15', '2020-01-01')
    expect(expired?.outcome).toBe('Expired')
    expect(cart.lines.length).toBe(0)
  })

  it('a product barcode is not an ID; a missing DOB asks for manual entry; the gate is off when disabled', async () => {
    const cart = useCartStore()
    const age = useAgeStore()
    cart.add(VAPE)
    expect(await age.scan('2002554634470')).toBeNull()
    expect(age.error).toMatch(/not a driver/)
    expect(age.pending.length).toBe(1)
    expect(await age.manual('')).toBeNull()
    await age.decline()
    expect(age.open).toBe(false)
    expect(age.pending.length).toBe(0)
    useCatalogStore().age = normalizeAge({ age_verification_required: 0 })
    cart.add(VAPE)
    expect(cart.lines.map((l) => l.item_code)).toEqual(['DSP-001'])
  })
})

describe('reward tiers', () => {
  it('affordable / next reward math ($5 / 100 · $10 / 200 · $15 / 300)', () => {
    expect(affordableTiers(0, DEFAULT_TIERS)).toEqual([])
    expect(affordableTiers(99, DEFAULT_TIERS)).toEqual([])
    expect(affordableTiers(100, DEFAULT_TIERS).map((t) => t.amount)).toEqual([5])
    expect(affordableTiers(250, DEFAULT_TIERS).map((t) => t.amount)).toEqual([5, 10])
    expect(affordableTiers(1000, DEFAULT_TIERS).map((t) => t.amount)).toEqual([5, 10, 15])
    expect(nextReward(0, DEFAULT_TIERS)).toMatchObject({ points: 100, amount: 5, points_needed: 100 })
    expect(nextReward(250, DEFAULT_TIERS)).toMatchObject({ points: 300, points_needed: 50 })
    expect(nextReward(300, DEFAULT_TIERS)).toBeNull()
    expect(tierDiscount([DEFAULT_TIERS[1]], 100)).toBe(10)
    expect(tierDiscount([DEFAULT_TIERS[2]], 7.5)).toBe(7.5) // never more than the bill
  })

  it('cart: one tier per transaction by default, stacking when enabled, never more than the balance', () => {
    setActivePinia(createPinia())
    const catalog = useCatalogStore()
    catalog.items = [LIGHTER]
    catalog.prices = { 'ACC-001': 20 }
    catalog.taxes = [{ description: 'TX', rate: 10 }] as any
    catalog.age = normalizeAge({ age_verification_required: 0 })
    catalog.loyalty = { name: 'CloudChaserz Rewards', collection_factor: 1, conversion_factor: 1, tiers: [] }
    catalog.reward_tiers = DEFAULT_TIERS
    const cart = useCartStore()
    cart.add(LIGHTER)
    cart.add(LIGHTER) // $40 + 10 % = $44
    cart.setCustomer({ name: 'C1', customer_name: 'Jake', loyalty_points: 250, tier: null })
    expect(cart.totals.grand_total).toBe(44)
    cart.redeemTier(DEFAULT_TIERS[2]) // cannot afford $15 / 300
    expect(cart.reward_tiers).toEqual([])
    cart.redeemTier(DEFAULT_TIERS[0])
    expect(cart.totals.loyalty_amount).toBe(5)
    expect(cart.totals.grand_total).toBe(39)
    cart.redeemTier(DEFAULT_TIERS[1]) // replaces (no stacking)
    expect(cart.reward_tiers.map((t) => t.points)).toEqual([200])
    expect(cart.totals.grand_total).toBe(34)
    expect(cart.rewardPoints).toBe(200)
    cart.redeemTier(DEFAULT_TIERS[0], true) // stacking: 200 + 100 = 300 > 250 → refused
    expect(cart.reward_tiers.map((t) => t.points)).toEqual([200])
    cart.redeemTier(null)
    cart.redeemTier(DEFAULT_TIERS[0], true)
    cart.redeemTier(DEFAULT_TIERS[0], true) // same tier twice → ignored
    expect(cart.reward_tiers.length).toBe(1)
    expect(cart.pointsEarned).toBe(40) // points on the net (before the reward), $1 = 1 pt
    cart.setCustomer(null)
    expect(cart.reward_tiers).toEqual([])
  })
})

describe('brand tokens', () => {
  it('normalises with CloudChaserz defaults and keeps the jewellery wording', () => {
    const b = normalizeBrand(null)
    expect(b.wordmark_text).toBe('CLOUDCHASERZ')
    expect(b.sub_mark).toBe('AWANZ')
    expect(b.store_noun).toBe('Store')
    expect(normalizeBrand({ brand_name: 'Acme', vertical: 'General' })).toMatchObject({ wordmark_text: 'ACME', store_noun: 'Store', rewards_program_name: 'Acme Rewards' })
    expect(normalizeBrand(JEWELLERY_BRAND)).toMatchObject({ wordmark_text: 'AWANZ', store_noun: 'Boutique' })
  })
  it('welcome line does not double the brand', () => {
    expect(welcomeLine({ brand_name: 'CloudChaserz' }, 'CloudChaserz Montrose')).toBe('Welcome to CloudChaserz Montrose')
    expect(welcomeLine({ brand_name: 'CloudChaserz' }, 'Montrose')).toBe('Welcome to CloudChaserz Montrose')
    expect(welcomeLine({ brand_name: 'AWANZ' }, null)).toBe('Welcome to AWANZ')
  })
  it('age settings normalise safely', () => {
    expect(normalizeAge({ minimum_age: '21', age_verification_required: '1', id_scan_enabled: 0 })).toEqual({ age_verification_required: true, minimum_age: 21, id_scan_enabled: false, reward_allow_stacking: false })
    expect(normalizeAge({ minimum_age: 5 }).minimum_age).toBe(21)
  })
})
