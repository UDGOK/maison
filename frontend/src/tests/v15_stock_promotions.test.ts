/**
 * v1.5 — a store's own stock (till + desk) and Promotions from the desk: the pure list logic the
 * screens reason with, the drafts' validation in the sheets' words, and the mock APIs' rules
 * (a correction needs a reason; a coupon code never changes; a drawn giveaway is immutable; a sent
 * month can only close).
 */
import { describe, expect, it } from 'vitest'
import { filterStoreStock, mockStoreStock, sortStoreStock, storeStockGroups, storeStockTotals } from '@/api/storeStock'
import {
  couponPayload,
  describePromotion,
  describeScope,
  emptyCouponDraft,
  emptyGiveawayDraft,
  emptyPromotionDraft,
  giveawayPayload,
  mockPromotions,
  normalizeCode,
  promotionPayload,
  splitTargets,
  validateCouponDraft,
  validateGiveawayDraft,
  validatePromotionDraft
} from '@/api/promotions'
import { fmtMonth, sortCoupons, sortGiveaways, sortPromotions } from '@/warehouse/components/promotions/PromotionsBoard.vue'

const money = (n: number) => `$${n.toFixed(2)}`

describe('v1.5 — store stock list logic', () => {
  it('filters by search, group and the attention chips', async () => {
    const { items } = await mockStoreStock.stock('HOU-MTR')
    expect(items).toHaveLength(4)
    expect(filterStoreStock(items, { q: 'oud' }).map((r) => r.item_code)).toEqual(['SOA-0001', 'SOA-0004'])
    expect(filterStoreStock(items, { q: '3348901250412' }).map((r) => r.item_code)).toEqual(['SOA-0002'])
    expect(filterStoreStock(items, { group: 'Gift Sets' }).map((r) => r.item_code)).toEqual(['SOA-0003'])
    expect(filterStoreStock(items, { filter: 'low' }).map((r) => r.item_code).sort()).toEqual(['SOA-0001', 'SOA-0002'])
    expect(filterStoreStock(items, { filter: 'out' }).map((r) => r.item_code)).toEqual(['SOA-0002'])
    expect(filterStoreStock(items, { filter: 'moving' }).map((r) => r.item_code).sort()).toEqual(['SOA-0001', 'SOA-0002', 'SOA-0004'])
    expect(filterStoreStock(items, { filter: 'idle' }).map((r) => r.item_code)).toEqual(['SOA-0003'])
    expect(storeStockGroups(items)).toEqual(['Designer Fragrance', 'Gift Sets', 'Oud & Oils'])
  })

  it('sorts what needs attention first and totals retail at the store’s own prices', async () => {
    const { items } = await mockStoreStock.stock('HOU-MTR')
    const sorted = sortStoreStock(items).map((r) => r.item_code)
    // out-and-selling first, then low, then by name
    expect(sorted[0]).toBe('SOA-0002')
    expect(sorted[1]).toBe('SOA-0001')
    const t = storeStockTotals(items)
    expect(t.items).toBe(4)
    expect(t.units).toBe(38)
    expect(t.low).toBe(2)
    expect(t.out).toBe(1)
    expect(t.retail).toBeCloseTo(2 * 189 + 14 * 79 + 22 * 24)
  })

  it('a correction needs a reason and a non-negative quantity, posts a reconciliation, and is a no-op when nothing changes', async () => {
    await expect(mockStoreStock.adjust('HOU-MTR', 'SOA-0003', 12, '')).rejects.toThrow(/why/)
    await expect(mockStoreStock.adjust('HOU-MTR', 'SOA-0003', -1, 'x')).rejects.toThrow(/negative/)
    const same = await mockStoreStock.adjust('HOU-MTR', 'SOA-0003', 14, 'recount')
    expect(same.changed).toBe(false)
    const out = await mockStoreStock.adjust('HOU-MTR', 'SOA-0003', 12, 'two boxes crushed')
    expect(out.changed).toBe(true)
    expect(out.before).toBe(14)
    expect(out.after).toBe(12)
    expect(out.stock_reconciliation).toMatch(/^MAT-RECO-/)
    const { items } = await mockStoreStock.stock('HOU-MTR')
    expect(items.find((r) => r.item_code === 'SOA-0003')!.on_hand).toBe(12)
    await expect(mockStoreStock.adjust('XX-NOPE', 'SOA-0003', 1, 'x')).rejects.toThrow(/does not exist/)
  })
})

describe('v1.5 — promotion drafts', () => {
  it('validates a coupon in the sheet’s words and upper-cases its code', () => {
    const d = emptyCouponDraft()
    expect(validateCouponDraft(d, true)).toMatch(/coupon code/)
    d.code = 'oud 20'
    expect(normalizeCode(d.code)).toBe('OUD20')
    expect(validateCouponDraft(d, true)).toMatch(/title/)
    d.title = '$20 off oud'
    expect(validateCouponDraft(d, true)).toMatch(/above zero/)
    d.value = 120
    expect(validateCouponDraft(d, true)).toMatch(/at most 100/)
    d.discount_type = 'Amount'
    expect(validateCouponDraft(d, true)).toBeNull()
    d.valid_from = '2026-10-01'
    d.valid_upto = '2026-09-01'
    expect(validateCouponDraft(d, true)).toMatch(/end before it starts/)
    d.valid_upto = ''
    d.usage = 'Single-use'
    const p = couponPayload(d)
    expect(p.code).toBe('OUD20')
    expect(p.max_uses).toBe(1)
    expect(p.min_basket).toBe(0)
    expect(p.boutique).toBeNull()
    // editing never re-checks the code
    d.code = ''
    expect(validateCouponDraft(d, false)).toBeNull()
  })

  it('validates a giveaway and a sale', () => {
    const g = emptyGiveawayDraft(25)
    expect(validateGiveawayDraft(g)).toMatch(/title/)
    g.title = 'Win a Royal Oud'
    expect(validateGiveawayDraft(g)).toMatch(/prize/)
    g.prize_description = '100 ml Royal Oud'
    expect(validateGiveawayDraft(g)).toMatch(/two dates/)
    g.start_date = '2026-10-01'
    g.end_date = '2026-09-01'
    expect(validateGiveawayDraft(g)).toMatch(/end before/)
    g.end_date = '2026-10-31'
    g.amount_per_entry = 0
    expect(validateGiveawayDraft(g)).toMatch(/per entry/)
    g.entry_rule = 'Per visit'
    expect(validateGiveawayDraft(g)).toBeNull()
    expect(giveawayPayload(g).requires_member).toBe(1)

    const s = emptyPromotionDraft('2026-09-22')
    expect(validatePromotionDraft(s)).toMatch(/name/)
    s.title = 'AWANZ OK-BIX SOA-0001'
    expect(validatePromotionDraft(s)).toMatch(/reserved/)
    s.title = 'Gift sets 15% off'
    expect(validatePromotionDraft(s)).toMatch(/at least one item group/)
    s.targets = 'Gift Sets, Body Sprays'
    expect(splitTargets(s.targets)).toEqual(['Gift Sets', 'Body Sprays'])
    expect(validatePromotionDraft(s)).toMatch(/above zero/)
    s.value = 15
    expect(validatePromotionDraft(s)).toBeNull()
    s.apply_on = 'Transaction'
    s.kind = 'rate'
    expect(validatePromotionDraft(s)).toMatch(/whole basket/)
    s.kind = 'amount'
    const p = promotionPayload(s)
    expect(p.targets).toEqual([])
    expect(p.valid_from).toBe('2026-09-22')
    expect(p.valid_upto).toBeNull()
  })

  it('describes a sale in three words', () => {
    expect(describePromotion({ kind: 'percent', value: 15 }, money)).toBe('15% off')
    expect(describePromotion({ kind: 'percent', value: 12.5 }, money)).toBe('12.5% off')
    expect(describePromotion({ kind: 'amount', value: 5 }, money)).toBe('$5.00 off')
    expect(describePromotion({ kind: 'rate', value: 49 }, money)).toBe('$49.00 each')
    expect(describeScope({ apply_on: 'Transaction', targets: [] })).toBe('Whole basket')
    expect(describeScope({ apply_on: 'Item Group', targets: ['Oud & Oils', 'Gift Sets'] })).toBe('Item group · Oud & Oils, Gift Sets')
    expect(describeScope({ apply_on: 'Item Code', targets: ['SOA-0001'] })).toBe('Items · SOA-0001')
  })
})

describe('v1.5 — promotions mock rules and board helpers', () => {
  it('creates and updates a coupon by its code, never renaming it, and switches it off rather than deleting', async () => {
    const out = await mockPromotions.saveCoupon({ code: 'fall 10', title: 'Fall 10%', discount_type: 'Percent', value: 10 })
    expect(out.created).toBe(true)
    expect(out.coupon.code).toBe('FALL10')
    expect(out.coupon.state).toBe('live')
    const again = await mockPromotions.saveCoupon({ code: 'FALL10', title: 'Fall 10% off', discount_type: 'Percent', value: 10, valid_upto: '2020-01-01' })
    expect(again.created).toBe(false)
    expect(again.coupon.title).toBe('Fall 10% off')
    expect(again.coupon.state).toBe('expired')
    const off = await mockPromotions.setCouponEnabled('FALL10', false)
    expect(off.coupon.state).toBe('off')
    await expect(mockPromotions.saveCoupon({ code: 'x', title: 'bad' })).rejects.toThrow(/coupon code/)
    const list = await mockPromotions.overview()
    expect(list.coupons.some((c) => c.code === 'FALL10')).toBe(true)
  })

  it('a giveaway is drawn once and is then immutable; a month that was sent can only close', async () => {
    const g = await mockPromotions.saveGiveaway({ title: 'Win a gift set', prize_description: 'Amber Nights', start_date: '2026-10-01', end_date: '2026-10-31', status: 'Open' })
    expect(g.created).toBe(true)
    await expect(mockPromotions.drawGiveaway(g.giveaway.name)).rejects.toThrow(/No entries/)
    const drawn = await mockPromotions.drawGiveaway('GIVE-2026-00001')
    expect(drawn.giveaway.status).toBe('Drawn')
    expect(drawn.draw.winner_name).toBeTruthy()
    await expect(mockPromotions.drawGiveaway('GIVE-2026-00001')).rejects.toThrow(/already been drawn/)
    await expect(mockPromotions.saveGiveaway({ name: 'GIVE-2026-00001', title: 'renamed', start_date: '2026-09-01', end_date: '2026-09-30' })).rejects.toThrow(/no longer change/)

    await expect(mockPromotions.saveCalendar({ month: '2026-09-01', status: 'Planned' })).rejects.toThrow(/only be closed/)
    const closed = await mockPromotions.saveCalendar({ month: '2026-09-01', status: 'Closed' })
    expect(closed.calendar.status).toBe('Closed')
    const planned = await mockPromotions.saveCalendar({ month: '2026-11-01', headline: 'Black Friday', pricing_rules: ['PRLE-0001'] })
    expect(planned.created).toBe(true)
    expect(planned.calendar.name).toBe('PROMO-2026-11')
    expect(planned.calendar.title).toBe('November 2026 promotions')
    expect(planned.calendar.pricing_rules[0].title).toBe('Gift sets 15% off')
    const sent = await mockPromotions.sendCalendar('PROMO-2026-11')
    expect(sent.calendar.status).toBe('Sent')
    await expect(mockPromotions.sendCalendar('PROMO-2026-11')).rejects.toThrow(/already been sent/)
  })

  it('saves the programme settings and reports only what changed', async () => {
    const out = await mockPromotions.saveRewardsSettings({ rewards_program_name: 'CloudChaserz Rewards', birthday_coupon_value: 20, points_per_dollar: 2 })
    expect(out.changed.sort()).toEqual(['birthday_coupon_value', 'points_per_dollar'])
    expect(out.program?.points_per_dollar).toBe(2)
    await expect(mockPromotions.saveRewardsSettings({ rewards_program_name: '  ' })).rejects.toThrow(/needs a name/)
    await expect(mockPromotions.saveRewardsSettings({ points_per_dollar: 0 })).rejects.toThrow(/between/)
    const tier = await mockPromotions.saveTier({ points: 500, amount: 30 })
    expect(tier.tier.title).toBe('$30 off at 500 points')
    await expect(mockPromotions.saveTier({ points: 500, amount: 25 })).rejects.toThrow(/already a tier/)
  })

  it('sorts live things first and prints a month', async () => {
    const o = await mockPromotions.overview()
    const coupons = sortCoupons(o.coupons)
    expect(coupons[0].state).toBe('live')
    expect(coupons[coupons.length - 1].state).toBe('off')
    const giveaways = sortGiveaways(o.giveaways)
    expect(giveaways[0].status).toBe('Open')
    expect(giveaways[giveaways.length - 1].status).toBe('Drawn')
    const sales = sortPromotions([
      { ...o.promotions[0], name: 'a', state: 'off', enabled: 0 },
      { ...o.promotions[0], name: 'b', state: 'live' },
      { ...o.promotions[0], name: 'c', state: 'scheduled' }
    ])
    expect(sales.map((s) => s.name)).toEqual(['b', 'c', 'a'])
    expect(fmtMonth('2026-11-01')).toBe('Nov 2026')
  })
})
