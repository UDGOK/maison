/** v0.4 I/J — promotions & coupon display logic, tier progress, scanner affixes, mock parity. */
import { describe, expect, it, beforeEach } from 'vitest'
import { applyPromotions, couponDiscount, distributeDiscount, eligiblePromotions, normalizeCouponCode, progressPercent, promoLabel, tierStatus, type PromoLine } from '@/utils/promos'
import { MOCK_PROMOTIONS, mockV04, mockTierProgress, __resetMockV04 } from '@/api/v04'
import type { Promotion } from '@/api/v04'
import { CUSTOMERS, LOYALTY } from '@/api/seed'
import { stripAffixes, unescapeAffix, isTerminator, normalizeScannerConfig } from '@/scan/affixes'
import { WedgeParser } from '@/scan/wedge'
import { normalizeTs, fmtMinutes } from '@/stores/shift'

const TODAY = new Date('2026-08-22T12:00:00Z')

const line = (id: string, item_code: string, item_group: string, rate: number, qty = 1, discount_amount = 0): PromoLine => ({ id, item_code, item_group, qty, rate, discount_amount })

const ACC15: Promotion = MOCK_PROMOTIONS[0] // Accessories −15 %
const PLAT5: Promotion = MOCK_PROMOTIONS[1] // Rings −5 %, Platinum only
const WATCH200: Promotion = MOCK_PROMOTIONS[2] // −200 on Watches ≥ 5 000

describe('promotions — automatic application', () => {
  it('applies a percent promo to matching item-group lines only', () => {
    const lines = [line('L1', 'AC-012', 'Accessories', 160, 2), line('L2', 'BR-006', 'Rings', 1950)]
    const r = applyPromotions(lines, [ACC15], null, TODAY)
    expect(r.perLine).toEqual({ L1: 48 })
    expect(r.total).toBe(48)
    expect(r.applied).toEqual([{ name: 'PRLE-0001', title: 'Accessories week −15%', discount: 48, lines: ['L1'] }])
  })
  it('computes the promo on the line net after a manual discount', () => {
    const r = applyPromotions([line('L1', 'AC-012', 'Accessories', 100, 1, 20)], [ACC15], null, TODAY)
    expect(r.perLine.L1).toBe(12)
  })
  it('tier-scoped promos only apply to clients of that tier', () => {
    const lines = [line('L1', 'BR-006', 'Rings', 2000)]
    expect(applyPromotions(lines, [PLAT5], null, TODAY).total).toBe(0)
    expect(applyPromotions(lines, [PLAT5], 'Gold', TODAY).total).toBe(0)
    expect(applyPromotions(lines, [PLAT5], 'Platinum', TODAY).total).toBe(100)
    expect(eligiblePromotions([ACC15, PLAT5], 'Silver', TODAY).map((p) => p.name)).toEqual(['PRLE-0001'])
  })
  it('respects min_amt and caps amount promos at the line net', () => {
    expect(applyPromotions([line('L1', 'TP-001', 'Watches', 4800)], [WATCH200], null, TODAY).total).toBe(0)
    expect(applyPromotions([line('L1', 'TP-001', 'Watches', 6900)], [WATCH200], null, TODAY).perLine.L1).toBe(200)
    const small: Promotion = { ...WATCH200, min_amt: 0, discount_amount: 10000 }
    expect(applyPromotions([line('L1', 'TP-001', 'Watches', 6900)], [small], null, TODAY).perLine.L1).toBe(6900)
  })
  it('one promo per line: highest priority wins', () => {
    const alsoAcc: Promotion = { ...WATCH200, name: 'X', title: 'Acc −20', targets: ['Accessories'], min_amt: 0, discount_amount: 20, priority: 5 }
    const r = applyPromotions([line('L1', 'AC-012', 'Accessories', 160)], [ACC15, alsoAcc], null, TODAY)
    expect(r.applied.map((a) => a.name)).toEqual(['X'])
    expect(r.perLine.L1).toBe(20)
  })
  it('ignores promos outside their validity window and non-discount kinds', () => {
    const expired: Promotion = { ...ACC15, valid_upto: '2026-08-01' }
    const future: Promotion = { ...ACC15, valid_from: '2026-09-01' }
    const gift: Promotion = { ...ACC15, kind: 'free_item' }
    expect(applyPromotions([line('L1', 'AC-012', 'Accessories', 160)], [expired, future, gift], null, TODAY).total).toBe(0)
  })
  it('labels promos for the chip', () => {
    expect(promoLabel(ACC15)).toBe('−15%')
    expect(promoLabel(WATCH200)).toBe('−200')
  })
})

describe('coupons — discount split (mirrors maison_pos.api.promotions)', () => {
  it('distributes proportionally with the remainder on the last line', () => {
    expect(distributeDiscount(10, [100, 100, 100])).toEqual([3.33, 3.33, 3.34])
    expect(distributeDiscount(0, [100])).toEqual([0])
    expect(distributeDiscount(10, [0, 0])).toEqual([0, 0])
  })
  it('percent coupon over the whole basket, after promo discounts', () => {
    const lines = [line('L1', 'AC-012', 'Accessories', 160, 2), line('L2', 'BR-006', 'Rings', 1950)]
    const promo = applyPromotions(lines, [ACC15], null, TODAY)
    const c = couponDiscount({ code: 'WELCOME10', discount_type: 'Percent', value: 10 }, lines, promo.perLine)
    // (320 − 48) + 1950 = 2222 → 222.20
    expect(c.total).toBe(222.2)
    expect(c.perLine.L1 + c.perLine.L2).toBeCloseTo(222.2, 2)
    expect(c.perLine.L1).toBe(27.2)
  })
  it('amount coupon scoped to an item group touches only those lines and is capped', () => {
    const lines = [line('L1', 'BR-009', 'Rings', 11200), line('L2', 'AC-012', 'Accessories', 160)]
    const c = couponDiscount({ code: 'BRIDAL500', discount_type: 'Amount', value: 500, item_group: 'Rings' }, lines)
    expect(c).toEqual({ total: 500, perLine: { L1: 500 } })
    const capped = couponDiscount({ code: 'BIG', discount_type: 'Amount', value: 99999, item_group: 'Accessories' }, lines)
    expect(capped.total).toBe(160)
  })
  it('no eligible lines → nothing', () => {
    expect(couponDiscount({ code: 'X', discount_type: 'Percent', value: 10, item_group: 'Watches' }, [line('L1', 'AC-012', 'Accessories', 160)])).toEqual({ total: 0, perLine: {} })
  })
  it('normalises codes', () => {
    expect(normalizeCouponCode(' welcome 10 ')).toBe('WELCOME10')
  })
})

describe('loyalty tier progress', () => {
  const tiers = LOYALTY.tiers.map((t) => ({ tier: t.tier, min_spent: t.min_spent }))
  it('finds the current tier, next tier and progress', () => {
    expect(tierStatus(0, tiers)).toEqual({ tier: 'Member', next: 'Silver', progress: 0, toNext: 10000 })
    const s = tierStatus(30000, tiers)
    expect(s.tier).toBe('Silver')
    expect(s.next).toBe('Gold')
    expect(s.progress).toBeCloseTo(0.5, 5)
    expect(s.toNext).toBe(20000)
    expect(tierStatus(200000, tiers)).toEqual({ tier: 'Platinum', next: null, progress: 1, toNext: 0 })
  })
  it('progressPercent clamps and treats the top tier as 100', () => {
    expect(progressPercent(null)).toBe(0)
    expect(progressPercent({ progress: 0.256, next_tier: 'Gold' })).toBe(26)
    expect(progressPercent({ progress: 7, next_tier: 'Gold' })).toBe(100)
    expect(progressPercent({ progress: 0.1, next_tier: null })).toBe(100)
  })
  it('mock tier progress honours the manager override', () => {
    const c = CUSTOMERS[1] // spent 1200 → Member
    expect(mockTierProgress(c).tier).toBe('Member')
    expect(mockTierProgress(c).next_tier).toBe('Silver')
    expect(mockTierProgress(c, 'Gold').tier).toBe('Gold')
    expect(mockTierProgress(c, 'Gold').tier_override).toBe('Gold')
  })
})

describe('mock API parity (v04)', () => {
  beforeEach(() => __resetMockV04())
  it('check_coupon mirrors the server rules', async () => {
    const lines = [{ item_code: 'AC-GFT-039', qty: 2, rate: 160 }]
    const ok = await mockV04.promotions.check_coupon('welcome10', lines)
    expect(ok.valid).toBe(true)
    expect(ok.code).toBe('WELCOME10')
    expect(ok.discount).toBe(32)
    expect(ok.per_line).toEqual([32])
    expect((await mockV04.promotions.check_coupon('NOPE', lines)).reason).toBe('unknown')
    expect((await mockV04.promotions.check_coupon('BRIDAL500', lines)).reason).toBe('min_basket')
    expect((await mockV04.promotions.check_coupon('VIP-ELEANOR', lines, undefined, 'CUST-0002')).reason).toBe('wrong_customer')
    expect((await mockV04.promotions.check_coupon('VIP-ELEANOR', lines, undefined, 'CUST-0001')).valid).toBe(true)
  })
  it('profile / wishlist / follow-up round trip', async () => {
    const p = await mockV04.crm.profile('CUST-0001')
    expect(p.profile.ring_size).toBe('6.5')
    expect(p.wishlist.map((w) => w.item_code)).toEqual(['HJ-PAR-032', 'RG-HAL-003'])
    expect(p.owned_pieces.length).toBe(2)
    const added = await mockV04.crm.wishlist_add('CUST-0001', 'AC-GFT-039', 'gift')
    expect(added.wishlist.some((w) => w.item_code === 'AC-GFT-039')).toBe(true)
    const removed = await mockV04.crm.wishlist_remove('CUST-0001', 'HJ-PAR-032')
    expect(removed.wishlist.some((w) => w.item_code === 'HJ-PAR-032')).toBe(false)
    const task = await mockV04.crm.log_interaction({ customer: 'CUST-0001', type: 'Follow-up', note: 'call', follow_up_date: '2026-09-01' })
    expect(task.status).toBe('Open')
    expect((await mockV04.crm.tasks({ customer: 'CUST-0001' })).map((t) => t.name)).toContain(task.name)
    await mockV04.crm.complete_task(task.name)
    expect(await mockV04.crm.tasks({ customer: 'CUST-0001' })).toEqual([])
    await expect(mockV04.crm.profile('NOPE')).rejects.toThrow()
  })
  it('clock in / break / clock out', async () => {
    const a = 'chi.oak.a1@maison.example'
    expect((await mockV04.hr.shift_status(a)).on_shift).toBe(false)
    const r = await mockV04.hr.clock_in(a, 'CHI-OAK')
    expect(r.created).toBe(true)
    expect((await mockV04.hr.clock_in(a, 'CHI-OAK')).created).toBe(false)
    expect((await mockV04.hr.toggle_break(a)).shift?.status).toBe('On break')
    expect((await mockV04.hr.toggle_break(a)).shift?.status).toBe('On shift')
    expect((await mockV04.hr.on_shift('CHI-OAK')).map((s) => s.associate)).toEqual([a])
    expect((await mockV04.hr.clock_out(a)).closed).toBe(true)
    expect((await mockV04.hr.shift_status(a)).on_shift).toBe(false)
  })
})

describe('scanner prefix / suffix / terminator (v0.4 J)', () => {
  it('strips configured affixes and stray CR/LF', () => {
    expect(stripAffixes('~2000733100019\r', { prefix: '~', suffix: '' })).toBe('2000733100019')
    expect(stripAffixes('STX2000733100019ETX', { prefix: 'STX', suffix: 'ETX' })).toBe('2000733100019')
    expect(stripAffixes('2000733100019\r\n', { suffix: '\\r\\n' })).toBe('2000733100019')
    expect(stripAffixes('2000733100019\r\n', {})).toBe('2000733100019')
    expect(stripAffixes('2000733100019', { prefix: '~' })).toBe('2000733100019')
    expect(stripAffixes('  MC:CUST-0001 ', {})).toBe('MC:CUST-0001')
  })
  it('unescapes manual spellings', () => {
    expect(unescapeAffix('<CR><LF>')).toBe('\r\n')
    expect(unescapeAffix('\\t')).toBe('\t')
  })
  it('terminator config', () => {
    expect(isTerminator('Enter', { terminator: 'tab' })).toBe(false)
    expect(isTerminator('Tab', { terminator: 'tab' })).toBe(true)
    expect(isTerminator('Enter', {})).toBe(true)
    expect(normalizeScannerConfig({ terminator: 'bogus' as never, prefix: undefined })).toEqual({ prefix: '', suffix: '', terminator: 'both' })
  })
  it('wedge parser honours the terminator option (Tab-only scanners)', () => {
    let base = 1000
    const feed = (p: WedgeParser, text: string, end: string) => {
      let t = (base += 10000) // a new burst well after the previous one (the parser resets on a long gap)
      for (const ch of text) {
        p.feed({ key: ch, time: t })
        t += 8
      }
      return p.feed({ key: end, time: t })
    }
    const tabOnly = new WedgeParser({ terminator: 'tab' })
    expect(feed(tabOnly, '2000733100019', 'Tab')).toBe('2000733100019')
    expect(feed(tabOnly, '2000733100019', 'Enter')).toBeNull()
    const enterOnly = new WedgeParser({ terminator: 'enter' })
    expect(feed(enterOnly, '2000733100019', 'Tab')).toBeNull()
    expect(feed(enterOnly, '2000733100019', 'Enter')).toBe('2000733100019')
  })
})

describe('shift helpers', () => {
  it('normalises Frappe datetimes for Safari and formats minutes', () => {
    expect(normalizeTs('2026-08-22 09:12:33.123456')).toBe('2026-08-22T09:12:33')
    expect(normalizeTs('2026-08-22T09:12:33Z')).toBe('2026-08-22T09:12:33Z')
    expect(fmtMinutes(0)).toBe('0m')
    expect(fmtMinutes(65)).toBe('1h 05m')
  })
})
