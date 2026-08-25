/**
 * v1.2 §G — **build a despatch**: a basket of items for one store.
 *
 * v1.1's *Send to stores* spreads one product across the chain; this fills one store's box, and it
 * will be used far more often. The maths behind the basket is `warehouse/despatch.ts`, and what is
 * pinned here is exactly the behaviour §G specifies, because each of these is a way a screen like
 * this quietly goes wrong:
 *
 *  · **a scan of something already in the basket increments it** — six scans of the same box is
 *    one line of six, never six lines of one;
 *  · **availability is `on_hand − committed`**, and the shortfall is named per item *before* the
 *    send, in the words the server refuses with;
 *  · **one destination for the whole basket** — `sendLines` stamps it onto every line, so there is
 *    no second place it could differ;
 *  · **the footer is internal** (client decision 3) and its margin is AWANZ's, with `null` — never
 *    `0 %` — when nothing in the basket carries a price;
 *  · **a line the destination has never sold is flagged quietly**, never blocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { __resetMockDistribution, mockDistribution } from '@/api/distribution'
import { __resetMockPricing, mockPricing } from '@/api/pricing'
import { __resetMockPurchasing } from '@/api/purchasing'
import { useDistributionStore } from '@/stores/distribution'
import { useWarehouseStore } from '@/stores/warehouse'
import type { WarehouseMe } from '@/api/warehouse'
import {
  applyPlan,
  availabilityProblems,
  basketTotals,
  bump,
  indexOf,
  lineFor,
  lineTone,
  matchesCode,
  neverSoldCount,
  neverSoldNote,
  positionCopy,
  refusalMessage,
  removeLine,
  scanInto,
  sendBlocked,
  sendCopy,
  sendLines,
  sentCopy,
  setQty,
  type BasketLine
} from '@/warehouse/despatch'
import { doneHeadline } from '@/warehouse/components/purchasing/NewDespatchSheet.vue'

// the sheet talks to the APIs through the stores; point them at the seeded desks
vi.mock('@/api/distribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/distribution')>()
  return { ...actual, distributionApi: actual.mockDistribution }
})
vi.mock('@/api/pricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/pricing')>()
  return { ...actual, pricingApi: actual.mockPricing }
})
vi.mock('@/api/purchasing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/purchasing')>()
  return { ...actual, purchasingApi: actual.mockPurchasing }
})

const ME: WarehouseMe = {
  user: 'warehouse@cloudchaserz.example',
  full_name: 'Wanda Houston',
  roles: ['AWANZ Warehouse Admin'],
  warehouse_admin: true,
  supply_unrestricted: true,
  boutique: null,
  main_warehouse: 'HOU-WH - CCZ',
  brand: { brand_name: 'CloudChaserz', wordmark_text: 'CLOUDCHASERZ', product_name: 'AWANZ POS by CloudChaserz' },
  provider: 'simulated',
  stores: ['HOU-MTR', 'OK-BIX', 'OK-JENKS']
}

/** A basket line as the sheet builds one, with everything the footer needs. */
function line(over: Partial<BasketLine> & { item_code: string }): BasketLine {
  return lineFor({ on_hand: 100, committed: 0, wholesale: 10, cost: 6, ...over }, over.qty ?? 1)
}

beforeEach(() => {
  __resetMockDistribution()
  __resetMockPricing()
})

// =============================================================================================
// the basket
// =============================================================================================
describe('the despatch basket', () => {
  it('adds a line at a whole quantity, and finds it again by code or barcode', () => {
    const basket = [line({ item_code: 'GB-PULSE-15K-BLUE', barcode: '8801234500017', qty: 6 })]
    expect(basket[0]).toMatchObject({ qty: 6, available: 100 })
    expect(indexOf(basket, 'GB-PULSE-15K-BLUE')).toBe(0)
    expect(indexOf(basket, 'NOT-HERE')).toBe(-1)
    expect(indexOf(basket, '')).toBe(-1)
    // the same ladder every scanner on this site climbs: barcode, code, then a barcode suffix
    expect(matchesCode(basket[0], '8801234500017')).toBe(true)
    expect(matchesCode(basket[0], 'gb-pulse-15k-blue')).toBe(true)
    expect(matchesCode(basket[0], '4500017')).toBe(true)
    expect(matchesCode(basket[0], '17')).toBe(false)
    expect(matchesCode(basket[0], '')).toBe(false)
  })

  it('increments the line a scan already matches rather than adding a second one', () => {
    let basket = [line({ item_code: 'GB-PULSE-15K-BLUE', barcode: '8801234500017', qty: 1 })]
    for (let i = 0; i < 5; i += 1) {
      const hit = scanInto(basket, '8801234500017')
      expect(hit.outcome).toBe('incremented')
      basket = hit.lines
    }
    expect(basket).toHaveLength(1)
    expect(basket[0].qty).toBe(6)
    // and the same for the item code, and for a whole case at a time
    const byCode = scanInto(basket, 'GB-PULSE-15K-BLUE', null, 12)
    expect(byCode.outcome).toBe('incremented')
    expect(byCode.lines[0].qty).toBe(18)
    expect(byCode.lines).toHaveLength(1)
  })

  it('adds a known item the basket has not seen, and leaves the basket alone for an unknown code', () => {
    const basket = [line({ item_code: 'GB-PULSE-15K-BLUE', barcode: '8801234500017', qty: 6 })]
    const added = scanInto(basket, '8801234500062', { item_code: 'RAW-KS-SLIM', barcode: '8801234500062', on_hand: 340, committed: 50 })
    expect(added.outcome).toBe('added')
    expect(added.lines).toHaveLength(2)
    expect(added.lines[1]).toMatchObject({ item_code: 'RAW-KS-SLIM', qty: 1, on_hand: 340, committed: 50, available: 290 })

    const miss = scanInto(basket, '0000000000000')
    expect(miss.outcome).toBe('unknown')
    expect(miss.line).toBeNull()
    expect(miss.lines).toBe(basket)
  })

  it('takes whole units only, never negative, and drops a line on request', () => {
    let basket = [line({ item_code: 'RAW-KS-SLIM', qty: 10 }), line({ item_code: 'OCB-XPERT-KS', qty: 4 })]
    basket = setQty(basket, 'RAW-KS-SLIM', '12.7')
    expect(basket[0].qty).toBe(12)
    basket = setQty(basket, 'RAW-KS-SLIM', '-5')
    expect(basket[0].qty).toBe(0)
    basket = setQty(basket, 'RAW-KS-SLIM', 'abc')
    expect(basket[0].qty).toBe(0)
    basket = bump(basket, 'OCB-XPERT-KS', -10)
    expect(basket[1].qty).toBe(0)
    basket = bump(basket, 'OCB-XPERT-KS', 3)
    expect(basket[1].qty).toBe(3)
    basket = removeLine(basket, 'RAW-KS-SLIM')
    expect(basket.map((l) => l.item_code)).toEqual(['OCB-XPERT-KS'])
  })
})

// =============================================================================================
// availability — the refusal, said before the send
// =============================================================================================
describe('what Houston can actually cover', () => {
  it('measures against on hand less what open shipments already promised', () => {
    const basket = [line({ item_code: 'ELFBAR-BC5K-MANGO', qty: 100, on_hand: 120, committed: 24 })]
    // 120 on the shelf, 24 of them already spoken for: 96 is the honest figure
    expect(basket[0].available).toBe(96)
    const problems = availabilityProblems(basket)
    expect(problems).toEqual([{ item_code: 'ELFBAR-BC5K-MANGO', wanted: 100, available: 96, short: 4 }])
    expect(availabilityProblems(setQty(basket, 'ELFBAR-BC5K-MANGO', 96))).toEqual([])
  })

  it('names the shortfall per item, in the words the server refuses with', () => {
    const basket = [
      line({ item_code: 'RAW-KS-SLIM', qty: 400, on_hand: 340, committed: 50 }),
      line({ item_code: 'GB-PULSE-15K-BLUE', qty: 40, on_hand: 36, committed: 0 }),
      line({ item_code: 'ZIG-ZAG-1-25', qty: 10, on_hand: 410, committed: 0 })
    ]
    const problems = availabilityProblems(basket)
    expect(problems.map((p) => p.item_code)).toEqual(['GB-PULSE-15K-BLUE', 'RAW-KS-SLIM'])
    expect(refusalMessage(problems)).toBe(
      [
        'Houston does not hold enough stock to send this despatch:',
        '• GB-PULSE-15K-BLUE — 40 requested, 36 available, short 4',
        '• RAW-KS-SLIM — 400 requested, 290 available, short 110',
        'Nothing was sent — lower the quantities or buy more first.'
      ].join('\n')
    )
    expect(refusalMessage([])).toBe('')
  })

  it('colours a line red past what Houston has and amber on the last unit', () => {
    expect(lineTone(line({ item_code: 'A', qty: 5, on_hand: 100 }))).toBe('muted')
    expect(lineTone(line({ item_code: 'A', qty: 100, on_hand: 100 }))).toBe('warn')
    expect(lineTone(line({ item_code: 'A', qty: 101, on_hand: 100 }))).toBe('crit')
  })

  it('says the position under a row in plain words', () => {
    expect(positionCopy(line({ item_code: 'A', qty: 0, on_hand: 120, committed: 24 }))).toBe('96 available at Houston · 24 already committed')
    expect(positionCopy(line({ item_code: 'A', qty: 40, on_hand: 120, committed: 24 }))).toBe('96 available at Houston · 24 already committed · 56 left after')
    expect(positionCopy(line({ item_code: 'A', qty: 100, on_hand: 120, committed: 24 }))).toBe('96 available at Houston · 24 already committed · 4 short')
    expect(positionCopy(line({ item_code: 'A', qty: 6, on_hand: 40, committed: 0 }))).toBe('40 available at Houston · 34 left after')
  })
})

// =============================================================================================
// the running footer — internal (client decision 3)
// =============================================================================================
describe('the despatch footer', () => {
  it('counts lines, units, what the store is charged and what it cost Houston', () => {
    const basket = [
      line({ item_code: 'GB-PULSE-15K-BLUE', qty: 12, wholesale: 14.01, cost: 9.34 }),
      line({ item_code: 'RAW-KS-SLIM', qty: 50, wholesale: 1.82, cost: 1.21 }),
      // a line typed down to nothing is not a line yet
      line({ item_code: 'ZIG-ZAG-1-25', qty: 0, wholesale: 1.75, cost: 0.9 })
    ]
    const totals = basketTotals(basket)
    expect(totals).toMatchObject({ lines: 2, units: 62, wholesale_value: 259.12, cost_value: 172.58 })
    expect(totals.margin).toBe(86.54)
    expect(totals.margin_pct).toBe(33.4)
    expect(totals.unpriced).toBe(false)
  })

  it('answers null — never 0 % — when nothing in the basket carries a price', () => {
    const totals = basketTotals([line({ item_code: 'CLIPPER-LTR-ASST', qty: 24, wholesale: 0, cost: 0 })])
    expect(totals.wholesale_value).toBe(0)
    expect(totals.margin_pct).toBeNull()
    expect(totals.unpriced).toBe(true)
    expect(basketTotals([]).margin_pct).toBeNull()
  })

  it('flags a line the destination has never sold, and never blocks it', () => {
    const basket = [
      line({ item_code: 'GB-PULSE-15K-BLUE', qty: 12, ever_sold: true }),
      line({ item_code: 'OPMS-GOLD-3CT', qty: 6, ever_sold: false }),
      line({ item_code: 'RAW-KS-SLIM', qty: 4, ever_sold: null })
    ]
    expect(neverSoldNote(basket[1], 'OK-BIX')).toBe('OK-BIX has never sold this')
    expect(neverSoldNote(basket[0], 'OK-BIX')).toBe('')
    // no destination chosen, or the plan has not loaded, says nothing at all rather than guessing
    expect(neverSoldNote(basket[2], 'OK-BIX')).toBe('')
    expect(neverSoldNote(basket[1], null)).toBe('')
    expect(neverSoldCount(basket)).toBe(1)
    expect(sendBlocked('OK-BIX', basket, availabilityProblems(basket))).toBe(false)
  })
})

// =============================================================================================
// one destination, and the send
// =============================================================================================
describe('sending the basket', () => {
  it('keeps the Send button down until there is a store, a quantity and enough stock', () => {
    const basket = [line({ item_code: 'RAW-KS-SLIM', qty: 10, on_hand: 340 })]
    expect(sendBlocked('', basket, [])).toBe(true)
    expect(sendBlocked('  ', basket, [])).toBe(true)
    expect(sendBlocked('OK-BIX', [], [])).toBe(true)
    expect(sendBlocked('OK-BIX', setQty(basket, 'RAW-KS-SLIM', 0), [])).toBe(true)
    expect(sendBlocked('OK-BIX', basket, [])).toBe(false)
    const over = setQty(basket, 'RAW-KS-SLIM', 999)
    expect(sendBlocked('OK-BIX', over, availabilityProblems(over))).toBe(true)
  })

  it('says what the button is about to do', () => {
    const basket = [line({ item_code: 'RAW-KS-SLIM', qty: 50, on_hand: 340 })]
    expect(sendCopy('', basketTotals(basket), [])).toBe('Choose a store')
    expect(sendCopy('OK-BIX', basketTotals([]), [])).toBe('Nothing in the basket')
    expect(sendCopy('OK-BIX', basketTotals(basket), [])).toBe('Send 50 units to OK-BIX')
    expect(sendCopy('OK-BIX', basketTotals([line({ item_code: 'A', qty: 1 })]), [])).toBe('Send 1 unit to OK-BIX')
    const over = setQty(basket, 'RAW-KS-SLIM', 999)
    expect(sendCopy('OK-BIX', basketTotals(over), availabilityProblems(over))).toBe('More than Houston has')
  })

  it('stamps the one destination onto every line, in item-code order, zeros dropped', () => {
    const basket = [
      line({ item_code: 'ZIG-ZAG-1-25', qty: 20 }),
      line({ item_code: 'GB-PULSE-15K-BLUE', qty: 12 }),
      line({ item_code: 'RAW-KS-SLIM', qty: 0 })
    ]
    expect(sendLines('OK-BIX', basket)).toEqual([
      { boutique: 'OK-BIX', item_code: 'GB-PULSE-15K-BLUE', qty: 12 },
      { boutique: 'OK-BIX', item_code: 'ZIG-ZAG-1-25', qty: 20 }
    ])
    // no destination, no lines — there is nowhere for them to go
    expect(sendLines('', basket)).toEqual([])
    expect(sendLines('   ', basket)).toEqual([])
  })

  it('says what it did, once', () => {
    const out = { shipments: [{ name: 'MSH-00007', boutique: 'OK-BIX' }], units: 32, items: 3 }
    expect(sentCopy(out)).toBe('3 lines · 32 units on their way to OK-BIX — MSH-00007')
    expect(sentCopy({ shipments: [{ name: 'MSH-00008', boutique: 'OK-SAP' }], units: 1, items: 1 })).toBe(
      '1 line · 1 unit on their way to OK-SAP — MSH-00008'
    )
    expect(doneHeadline({ shipments: [{ boutique: 'OK-BIX', boutique_name: 'CloudChaserz Bixby' }] } as never)).toBe(
      'CloudChaserz Bixby’s consignment is on the wall'
    )
  })
})

// =============================================================================================
// against the deterministic Houston — the plan, the prices and a real send
// =============================================================================================
describe('a despatch end to end', () => {
  it('merges Houston’s position and the destination’s history onto the basket, keeping the quantities', async () => {
    const plan = await mockDistribution.plan(['GB-PULSE-15K-BLUE', 'ELFBAR-BC5K-MANGO'], ['OK-BIX'])
    const prices = await mockPricing.wholesale(['GB-PULSE-15K-BLUE', 'ELFBAR-BC5K-MANGO'])
    const priced = Object.fromEntries(prices.items.map((r) => [r.item_code, { wholesale: r.wholesale, cost: r.cost }]))

    let basket = [line({ item_code: 'GB-PULSE-15K-BLUE', qty: 12, on_hand: 0, wholesale: 0, cost: 0 }), line({ item_code: 'ELFBAR-BC5K-MANGO', qty: 24, on_hand: 0, wholesale: 0, cost: 0 })]
    basket = applyPlan(basket, plan.items, 'OK-BIX', priced)
    // the typed quantities survive; everything else comes from the server
    expect(basket.map((l) => l.qty)).toEqual([12, 24])
    expect(basket[0]).toMatchObject({ item_name: 'Geek Bar Pulse 15K — Blue Razz Ice', on_hand: 36, committed: 0, available: 36, wholesale: 14.01, cost: 9.34 })
    expect(basket[1]).toMatchObject({ on_hand: 120, committed: 24, available: 96 })
    expect(typeof basket[0].ever_sold).toBe('boolean')
    // with no destination chosen the "never sold here" flag says nothing rather than guessing
    expect(applyPlan(basket, plan.items, null, priced).every((l) => l.ever_sold === null)).toBe(true)
  })

  it('creates one consignment for the one store, and the units become committed', async () => {
    __resetMockPurchasing()
    setActivePinia(createPinia())
    useWarehouseStore().me = { ...ME }
    const dist = useDistributionStore()

    const before = (await mockDistribution.plan(['GB-PULSE-15K-BLUE'])).items[0]
    expect(before).toMatchObject({ on_hand: 36, committed: 0, available: 36 })

    const basket = [line({ item_code: 'GB-PULSE-15K-BLUE', qty: 12 }), line({ item_code: 'RAW-KS-SLIM', qty: 50 }), line({ item_code: 'ZIG-ZAG-1-25', qty: 20 })]
    const out = await dist.send(sendLines('OK-BIX', basket), 'Bixby’s Tuesday order', 'Normal')
    expect(out).not.toBeNull()
    // one store, one consignment — never batched, and never split
    expect(out!.stores).toBe(1)
    expect(out!.shipments).toHaveLength(1)
    expect(out!.shipments[0]).toMatchObject({ boutique: 'OK-BIX', items: 3, units: 82, status: 'Pending', warehouse_push: true })
    expect(out!.items).toBe(3)
    expect(sentCopy({ shipments: out!.shipments.map((s) => ({ name: s.name, boutique: s.boutique })), units: out!.units, items: out!.items })).toMatch(
      /^3 lines · 82 units on their way to OK-BIX — MSH-/
    )

    const after = (await mockDistribution.plan(['GB-PULSE-15K-BLUE'])).items[0]
    expect(after).toMatchObject({ on_hand: 36, committed: 12, available: 24 })
  })

  it('refuses the whole basket when Houston cannot cover one line, and writes nothing', async () => {
    setActivePinia(createPinia())
    useWarehouseStore().me = { ...ME }
    const dist = useDistributionStore()

    const basket = [line({ item_code: 'GB-PULSE-15K-BLUE', qty: 12 }), line({ item_code: 'HYDE-EDGE-4K-GRAPE', qty: 40 })]
    expect(await dist.send(sendLines('OK-SAP', basket), 'too much', 'Normal')).toBeNull()
    // the refusal is multi-line, one bullet per item, and names the shortfall — rendered verbatim
    expect(dist.error).toMatch(/Houston does not hold enough stock/)
    expect(dist.error).toMatch(/HYDE-EDGE-4K-GRAPE — 40 requested, 8 available, short 32/)
    expect(dist.error).toMatch(/Nothing was sent/)
    // and nothing at all was written: the Geek Bars are still free
    expect((await mockDistribution.plan(['GB-PULSE-15K-BLUE'])).items[0].committed).toBe(0)
  })
})
