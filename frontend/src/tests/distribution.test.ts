/**
 * v1.1 "Onboarding a product" — the three screens that close v1.0's dead ends.
 *
 * The repo has no component-mounting stack (`@vue/test-utils` is not a dependency), so each screen
 * exports the pure part a reviewer would otherwise have to read a template to check, and those are
 * tested here directly, together with the stores behind them (against the deterministic in-memory
 * Houston in `api/distribution.ts`).
 *
 * What is pinned here, and why each one earns its place:
 *
 *  · **the split maths as the sheet renders it** — `warehouse/distribution.ts` is a literal mirror
 *    of `maison_pos/distribution.py`, and the mock desk allocates through it, so a drift between
 *    the two would silently make the mock lie about what the bench will do;
 *  · **the "left at Houston" figure and the red threshold** — `suggest_split` is a calculator, not
 *    a gate: it will happily allocate more than Houston has, and the footer has to go red
 *    *before* the send rather than after a refusal;
 *  · **cover days at zero velocity** — `null`, rendered `—`. Never `Infinity`, never `NaN`;
 *  · **create-product validation, including the duplicate barcode** — two products on one barcode
 *    means the till rings up the wrong one, so that refusal has to land on the barcode field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { __resetMockDistribution, mockDistribution, type PlanItem, type PlanStoreRow } from '@/api/distribution'
import { __resetMockPurchasing, mockPurchasing } from '@/api/purchasing'
import { useDistributionStore, sendNotice } from '@/stores/distribution'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import type { WarehouseMe } from '@/api/warehouse'
import {
  allocationTotals,
  apportion,
  busiestFirst,
  candidateStores,
  coverAfter,
  coverDaysFor,
  coverText,
  coverTone,
  leftTone,
  sameToAll,
  sendBlocked,
  sendLines,
  shortfallMessage,
  splitByVelocity,
  splitEven,
  splitFor,
  splitTopup,
  stocksIt,
  storyFor,
  validateAllocation,
  velocityText
} from '@/warehouse/distribution'
import { pushCopy, sentCopy, splitNote } from '@/warehouse/components/purchasing/SendToStoresSheet.vue'
import { emptyDraft, fieldForError, marginNote, productPayload, validateProduct, type ProductDraft } from '@/warehouse/components/purchasing/NewProductSheet.vue'
import { basketTotals, lineFromCatalogue, packNote, packWarning } from '@/warehouse/components/purchasing/NewOrderSheet.vue'

// the screens talk to the APIs through their stores; point both at the seeded desks
vi.mock('@/api/distribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/distribution')>()
  return { ...actual, distributionApi: actual.mockDistribution }
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

function desk() {
  __resetMockDistribution()
  __resetMockPurchasing()
  setActivePinia(createPinia())
  useWarehouseStore().me = { ...ME }
  return useDistributionStore()
}

/** A row shaped like the plan's, for the pure maths. */
function row(boutique: string, on_hand: number, velocity: number, ever_sold = velocity > 0): PlanStoreRow {
  return {
    boutique,
    boutique_name: `Store ${boutique}`,
    warehouse: `${boutique} - CCZ`,
    on_hand,
    velocity,
    cover_days: velocity > 0 ? Math.round((on_hand / velocity) * 10) / 10 : null,
    ever_sold
  }
}

// =============================================================================================
// the split maths — a mirror of maison_pos/distribution.py
// =============================================================================================
describe('split maths', () => {
  const three = [row('A', 10, 4), row('B', 2, 1), row('C', 40, 2)]

  it('busiest first is a total order: velocity, then emptiest, then alphabetical', () => {
    expect(busiestFirst(three)).toEqual(['A', 'C', 'B'])
    // two stores selling the same amount are separated by what they hold, then by name — never
    // by the order they happened to arrive in
    expect(busiestFirst([row('Z', 5, 2), row('Y', 1, 2), row('X', 1, 2)])).toEqual(['X', 'Y', 'Z'])
  })

  it('even splits equally and hands the remainder to the busiest', () => {
    expect(splitEven(9, three)).toEqual({ A: 3, B: 3, C: 3 })
    // 11 ÷ 3 = 3 each, 2 over → the two busiest (A then C)
    expect(splitEven(11, three)).toEqual({ A: 4, B: 3, C: 4 })
    expect(splitEven(0, three)).toEqual({ A: 0, B: 0, C: 0 })
    expect(splitEven(-5, three)).toEqual({ A: 0, B: 0, C: 0 })
  })

  it('velocity weights by sales with a minimum of one each', () => {
    // 3 units, 3 stores → one each, nobody gets a fraction
    expect(splitByVelocity(3, three)).toEqual({ A: 1, B: 1, C: 1 })
    // 10 units: one each first, then 7 shared 4:1:2 → 4, 1, 2
    expect(splitByVelocity(10, three)).toEqual({ A: 5, B: 2, C: 3 })
    const total = Object.values(splitByVelocity(10, three)).reduce((s, v) => s + v, 0)
    expect(total).toBe(10)
  })

  it('velocity with fewer units than stores gives them to the busiest, not a fraction each', () => {
    expect(splitByVelocity(2, three)).toEqual({ A: 1, B: 0, C: 1 })
  })

  it('velocity falls back to an even split when nobody has ever sold it', () => {
    // a brand-new product: every velocity is 0, so there is nothing to weight by
    const fresh = [row('A', 0, 0, false), row('B', 0, 0, false), row('C', 0, 0, false)]
    expect(splitByVelocity(9, fresh)).toEqual({ A: 3, B: 3, C: 3 })
    expect(splitByVelocity(11, fresh)).toEqual({ A: 4, B: 4, C: 3 })
  })

  it('top up brings every store to the target and no further', () => {
    // gaps at 21 days: A 4×21−10 = 74, B 1×21−2 = 19, C 2×21−40 = 2
    expect(splitTopup(95, three, 21)).toEqual({ A: 74, B: 19, C: 2 })
    // more than enough: every store gets exactly its gap, the rest stays in Houston
    expect(splitTopup(500, three, 21)).toEqual({ A: 74, B: 19, C: 2 })
  })

  it('top up allocates nothing when every store is already covered — and says so', () => {
    const fat = [row('A', 400, 1), row('B', 900, 2)]
    expect(splitTopup(200, fat, 21)).toEqual({ A: 0, B: 0 })
    // that is the case the backend flagged: honest, and it must not read as a broken button
    const note = splitNote({
      item_code: 'X',
      mode: 'topup',
      qty: 200,
      allocated: 0,
      remainder: 200,
      cover_days: 21,
      velocity_days: 28,
      warehouse: 'HOU-WH - CCZ',
      on_hand: 200,
      committed: 0,
      available: 200,
      left_at_warehouse: 200,
      lines: []
    })
    expect(note).toContain('allocated nothing')
    expect(note).toContain('21 days of cover')
    expect(note).toContain('Raise the target')
  })

  it('does not claim a weighting that never happened — the brand-new product case', () => {
    // `split_by_velocity` falls back to an even split when nothing has sold anywhere. That is the
    // right behaviour, but saying "Weighted by sales" about a product with no sales history is a
    // claim about data that does not exist — and it is exactly the case v1.1 was built for.
    // Caught by `e2e/distribution.e2e.mjs` against a live bench.
    const noSales = (qty: number, n = 11) => ({
      item_code: 'X',
      mode: 'velocity' as const,
      qty,
      allocated: qty,
      remainder: 0,
      cover_days: 21,
      velocity_days: 28,
      warehouse: 'HOU-WH - CCZ',
      on_hand: qty,
      committed: 0,
      available: qty,
      left_at_warehouse: 0,
      lines: Array.from({ length: n }, (_, i) => ({
        boutique: `S${i}`,
        boutique_name: `Store ${i}`,
        warehouse: `S${i} - CCZ`,
        on_hand: 0,
        velocity: 0,
        cover_days: null,
        ever_sold: false,
        qty: Math.floor(qty / n) || 1
      }))
    })
    const note = splitNote(noSales(25))
    expect(note).toContain('No sales anywhere yet')
    expect(note).not.toContain('Weighted by sales —')
    expect(note).toContain('once they have sold some')

    // the milder sibling: fewer units than stores weights nothing either, it just picks the busiest
    const thin = noSales(8, 11)
    thin.lines = thin.lines.map((l, i) => ({ ...l, velocity: i < 3 ? 2 : 0, qty: i < 8 ? 1 : 0 }))
    const thinNote = splitNote(thin)
    expect(thinNote).toContain('one each to the')
    expect(thinNote).toContain('nothing to weight')

    // and a genuine weighting still says so
    const real = noSales(60)
    real.lines = real.lines.map((l, i) => ({ ...l, velocity: i + 1, qty: i + 1 }))
    expect(splitNote(real)).toContain('Weighted by sales —')
  })

  it('top up shares what there is in proportion to the gaps, capped at each gap', () => {
    // gaps 74 / 19 / 2 = 95; only 50 to give
    const out = splitTopup(50, three, 21)
    expect(Object.values(out).reduce((s, v) => s + v, 0)).toBe(50)
    expect(out.C).toBeLessThanOrEqual(2)
    expect(out.B).toBeLessThanOrEqual(19)
    expect(out.A).toBeGreaterThan(out.B)
  })

  it('apportion never exceeds a cap, and stops when everybody is capped', () => {
    const out = apportion(100, { A: 5, B: 5 }, ['A', 'B'], { A: 5, B: 5 })
    expect(out).toEqual({ A: 5, B: 5 }) // 90 units had nowhere to go and stayed in Houston
  })

  it('same to all is n per store, not n shared out', () => {
    expect(sameToAll(6, three)).toEqual({ A: 6, B: 6, C: 6 })
    expect(sameToAll(0, three)).toEqual({ A: 0, B: 0, C: 0 })
  })

  it('splitFor dispatches by name and defaults to even', () => {
    expect(splitFor('even', 9, three)).toEqual(splitEven(9, three))
    expect(splitFor('velocity', 10, three)).toEqual(splitByVelocity(10, three))
    expect(splitFor('topup', 95, three, 21)).toEqual(splitTopup(95, three, 21))
    expect(splitFor('nonsense', 9, three)).toEqual(splitEven(9, three))
  })
})

// =============================================================================================
// the footer — "left at Houston" and when it turns red
// =============================================================================================
describe('left at Houston', () => {
  it('counts the stores chosen and the units leaving', () => {
    const totals = allocationTotals({ A: 12, B: 0, C: 6 }, 36)
    expect(totals.stores).toBe(2)
    expect(totals.units).toBe(18)
    expect(totals.left).toBe(18)
    expect(totals.over).toBe(false)
    expect(totals.tone).toBe('accent')
  })

  it('turns red the moment the push would go past what Houston has', () => {
    const totals = allocationTotals({ A: 30, B: 20 }, 36)
    expect(totals.left).toBe(-14)
    expect(totals.short).toBe(14)
    expect(totals.over).toBe(true)
    expect(totals.tone).toBe('crit')
    expect(leftTone(-1)).toBe('crit')
  })

  it('warns — not refuses — when the push takes the last unit', () => {
    const totals = allocationTotals({ A: 36 }, 36)
    expect(totals.left).toBe(0)
    expect(totals.over).toBe(false)
    expect(totals.tone).toBe('warn')
  })

  it('measures against `available`, not `on hand` — committed units are already spoken for', () => {
    // 120 on hand, 24 promised to open shipments → 96 to give away
    const totals = allocationTotals({ A: 100 }, 96)
    expect(totals.over).toBe(true)
    expect(totals.short).toBe(4)
  })

  it('says the shortfall in the sheet the way the server says it in the refusal', () => {
    const totals = allocationTotals({ A: 30, B: 20 }, 36)
    const message = shortfallMessage('GB-PULSE-15K-BLUE', totals)
    expect(message).toContain('GB-PULSE-15K-BLUE')
    expect(message).toContain('50 allocated')
    expect(message).toContain('36 available')
    expect(message).toContain('short 14')
    expect(shortfallMessage('X', allocationTotals({ A: 1 }, 10))).toBe('')
  })

  it('blocks the Send button on nothing chosen, on a bad box and on over-allocation', () => {
    const rows = [row('A', 1, 1), row('B', 1, 1)]
    expect(sendBlocked(allocationTotals({ A: 0, B: 0 }, 50), [])).toBe(true)
    expect(sendBlocked(allocationTotals({ A: 60 }, 50), [])).toBe(true)
    expect(sendBlocked(allocationTotals({ A: 10 }, 50), validateAllocation({ A: 1.5 }, rows))).toBe(true)
    expect(sendBlocked(allocationTotals({ A: 10 }, 50), [])).toBe(false)
  })

  it('validates each box: whole units, never negative, never an unknown store', () => {
    const rows = [row('A', 1, 1), row('B', 1, 1)]
    expect(validateAllocation({ A: 4, B: 0 }, rows)).toEqual([])
    expect(validateAllocation({ A: 1.5 }, rows)[0].message).toContain('whole units only')
    expect(validateAllocation({ A: -2 }, rows)[0].message).toContain('cannot be negative')
    expect(validateAllocation({ ZZ: 4 }, rows)[0].message).toContain('not a store')
    // a zero against a store that is not on the plan is nothing to complain about
    expect(validateAllocation({ ZZ: 0 }, rows)).toEqual([])
  })

  it('sends only the rows with something in them, in store-code order', () => {
    expect(sendLines('ITEM-1', { 'OK-YALE': 3, 'HOU-MTR': 0, 'OK-BA': 6 })).toEqual([
      { boutique: 'OK-BA', item_code: 'ITEM-1', qty: 6 },
      { boutique: 'OK-YALE', item_code: 'ITEM-1', qty: 3 }
    ])
  })

  it('says on the button what it is about to do', () => {
    expect(pushCopy({ stores: 3, units: 84, over: false })).toBe('Send 84 to 3 stores')
    expect(pushCopy({ stores: 1, units: 12, over: false })).toBe('Send 12 to 1 store')
    expect(pushCopy({ stores: 0, units: 0, over: false })).toBe('Nothing to send')
    expect(pushCopy({ stores: 3, units: 900, over: true })).toBe('More than Houston has')
  })
})

// =============================================================================================
// cover days — null at zero velocity, never Infinity
// =============================================================================================
describe('cover days', () => {
  it('is null, and renders an em dash, when the store does not move it', () => {
    expect(coverDaysFor(288, 0)).toBeNull()
    expect(coverDaysFor(0, 0)).toBeNull()
    expect(coverText(coverDaysFor(288, 0))).toBe('—')
    expect(coverText(null)).toBe('—')
    expect(Number.isFinite(coverDaysFor(288, 0) as number)).toBe(false)
  })

  it('is on hand ÷ velocity to one decimal when it does move', () => {
    expect(coverDaysFor(36, 4)).toBe(9)
    expect(coverDaysFor(10, 3)).toBe(3.3)
    expect(coverText(coverDaysFor(36, 4))).toBe('9 d')
    expect(coverText(coverDaysFor(10, 3))).toBe('3.3 d')
  })

  it('says where the push lands a store, and stays null when it will never sell', () => {
    expect(coverAfter(row('A', 10, 2), 30)).toBe(20)
    expect(coverAfter(row('A', 10, 0, false), 30)).toBeNull()
  })

  it('prints velocity to two decimals, and an em dash where nothing moves', () => {
    // the server reports three: `0.853/d` in a column a manager scans down is a digit of noise
    expect(velocityText(0.853)).toBe('0.85/d')
    expect(velocityText(0)).toBe('—')
    expect(velocityText(null)).toBe('—')
    expect(velocityText(12.4)).toBe('12/d')
  })

  it('tones a thin store critical and an unknown one merely muted', () => {
    expect(coverTone(3)).toBe('crit')
    expect(coverTone(10)).toBe('warn')
    expect(coverTone(40)).toBe('good')
    expect(coverTone(null)).toBe('muted')
  })

  it('says "never sold here" out loud rather than showing a silent zero', () => {
    const fresh = row('OK-MUS', 0, 0, false)
    expect(storyFor(fresh)).toBe('Never sold here')
    expect(storyFor(fresh, 12)).toBe('Never sold here — 12 would be the first')
    const mover = row('OK-BIX', 10, 2)
    expect(storyFor(mover)).toBe('10 on hand · 5 d of cover')
    expect(storyFor(mover, 30)).toBe('10 on hand · 5 d → 20 d')
    // stock on the shelf but no sales in the window is a *third* case, and reads as one
    expect(storyFor(row('OK-SAP', 8, 0, true))).toBe('8 on hand, no sales in 28 days')
  })

  it('knows which stores stock it — on the shelf now, or sold at some point', () => {
    expect(stocksIt(row('A', 5, 0, false))).toBe(true) // has some, has never rung one up
    expect(stocksIt(row('B', 0, 0, true))).toBe(true) // sold out, but it belongs there
    expect(stocksIt(row('C', 0, 0, false))).toBe(false)
    const rows = [row('A', 5, 0, false), row('B', 0, 0, false), row('C', 3, 1)]
    expect(candidateStores(rows, true).map((r) => r.boutique)).toEqual(['A', 'C'])
    expect(candidateStores(rows, false)).toHaveLength(3)
  })
})

// =============================================================================================
// the distribution API — plan, suggest_split, send
// =============================================================================================
describe('distribution desk', () => {
  beforeEach(() => {
    __resetMockDistribution()
  })

  it('offers the eleven shops and never Houston itself', async () => {
    const out = await mockDistribution.stores()
    expect(out.count).toBe(11)
    expect(out.warehouse).toBe('HOU-WH - CCZ')
    expect(out.stores.map((s) => s.boutique)).not.toContain('HOU-WH')
    // store-code order, so the confirmation and the labels come out the same way every time
    expect(out.stores.map((s) => s.boutique)).toEqual([...out.stores.map((s) => s.boutique)].sort())
  })

  it('plans one row per store, with cover null wherever velocity is zero', async () => {
    const plan = await mockDistribution.plan(['GB-PULSE-15K-BLUE'])
    const item = plan.items[0]
    expect(item.stores).toHaveLength(11)
    expect(item.available).toBe(item.on_hand - item.committed)
    for (const store of item.stores) {
      if (store.velocity > 0) expect(store.cover_days).toBeCloseTo(store.on_hand / store.velocity, 1)
      else expect(store.cover_days).toBeNull()
    }
  })

  it('reports committed units, so `available` is less than `on hand`', async () => {
    const plan = await mockDistribution.plan(['ELFBAR-BC5K-MANGO'])
    const item = plan.items[0]
    expect(item.committed).toBeGreaterThan(0)
    expect(item.available).toBe(item.on_hand - item.committed)
  })

  it('suggest_split answers for every candidate store, allocated or not', async () => {
    const out = await mockDistribution.suggest_split('GB-PULSE-15K-BLUE', 12, 'even')
    expect(out.lines).toHaveLength(11)
    expect(out.allocated).toBe(12)
    expect(out.remainder).toBe(0)
    expect(out.left_at_warehouse).toBe(out.available - out.allocated)
  })

  it('suggest_split is a calculator, not a gate — it will over-allocate so the footer can go red', async () => {
    const out = await mockDistribution.suggest_split('HYDE-EDGE-4K-GRAPE', 500, 'even')
    expect(out.allocated).toBe(500)
    expect(out.left_at_warehouse).toBeLessThan(0)
    expect(leftTone(out.left_at_warehouse)).toBe('crit')
  })

  it('suggest_split honours the chosen stores', async () => {
    const out = await mockDistribution.suggest_split('RAW-KS-SLIM', 10, 'even', ['OK-BIX', 'OK-YALE'])
    expect(out.lines.map((l) => l.boutique)).toEqual(['OK-BIX', 'OK-YALE'])
    expect(out.allocated).toBe(10)
  })

  it('send creates one shipment per store, never a batch', async () => {
    const out = await mockDistribution.send([
      { boutique: 'OK-BIX', item_code: 'RAW-KS-SLIM', qty: 20 },
      { boutique: 'OK-YALE', item_code: 'RAW-KS-SLIM', qty: 10 },
      { boutique: 'OK-BA', item_code: 'RAW-KS-SLIM', qty: 5 }
    ])
    expect(out.stores).toBe(3)
    expect(out.shipments).toHaveLength(3)
    expect(out.requests).toHaveLength(3)
    expect(out.units).toBe(35)
    expect(out.items).toBe(1)
    // every one of them says plainly that Houston initiated it
    expect(out.shipments.every((s) => s.warehouse_push)).toBe(true)
    expect(out.requests.every((r) => r.warehouse_push)).toBe(true)
    expect(out.reason).toBe('Warehouse push from Houston')
    // store-code order
    expect(out.shipments.map((s) => s.boutique)).toEqual(['OK-BA', 'OK-BIX', 'OK-YALE'])
  })

  it('send sums two rows for the same store and item rather than refusing them', async () => {
    const out = await mockDistribution.send([
      { boutique: 'OK-BIX', item_code: 'RAW-KS-SLIM', qty: 20 },
      { boutique: 'OK-BIX', item_code: 'RAW-KS-SLIM', qty: 5 }
    ])
    expect(out.stores).toBe(1)
    expect(out.units).toBe(25)
    expect(out.shipments[0].units).toBe(25)
  })

  it('send refuses over-allocation as a whole, naming the shortfall per item, and writes nothing', async () => {
    const before = await mockDistribution.plan(['HYDE-EDGE-4K-GRAPE'])
    await expect(
      mockDistribution.send([
        { boutique: 'OK-BIX', item_code: 'HYDE-EDGE-4K-GRAPE', qty: 6 },
        { boutique: 'OK-YALE', item_code: 'HYDE-EDGE-4K-GRAPE', qty: 6 }
      ])
    ).rejects.toThrow(/short 4/)
    // the refusal is multi-line with one bullet per item — the sheet renders it verbatim
    const failure = await mockDistribution
      .send([{ boutique: 'OK-BIX', item_code: 'HYDE-EDGE-4K-GRAPE', qty: 99 }])
      .then(() => null)
      .catch((e: Error) => e.message)
    expect(failure).toContain('\n')
    expect(failure).toContain('•')
    expect(failure).toContain('Nothing was sent')
    // nothing moved
    const after = await mockDistribution.plan(['HYDE-EDGE-4K-GRAPE'])
    expect(after.items[0].committed).toBe(before.items[0].committed)
  })

  it('send refuses a store that does not exist, and a quantity of zero', async () => {
    await expect(mockDistribution.send([{ boutique: 'NOPE', item_code: 'RAW-KS-SLIM', qty: 5 }])).rejects.toThrow(/does not exist/)
    await expect(mockDistribution.send([{ boutique: 'OK-BIX', item_code: 'RAW-KS-SLIM', qty: 0 }])).rejects.toThrow(/more than zero/)
    await expect(mockDistribution.send([])).rejects.toThrow(/Nothing to send/)
  })

  it('what was sent is committed, so the next plan offers less', async () => {
    const before = await mockDistribution.plan(['ZIG-ZAG-1-25'])
    await mockDistribution.send([{ boutique: 'OK-BIX', item_code: 'ZIG-ZAG-1-25', qty: 40 }])
    const after = await mockDistribution.plan(['ZIG-ZAG-1-25'])
    expect(after.items[0].on_hand).toBe(before.items[0].on_hand)
    expect(after.items[0].available).toBe(before.items[0].available - 40)
  })

  it('the mock desk and the sheet agree about the maths', async () => {
    const plan = await mockDistribution.plan(['PUFF-XXL-MINT'])
    const rows = plan.items[0].stores
    for (const mode of ['even', 'velocity', 'topup'] as const) {
      const out = await mockDistribution.suggest_split('PUFF-XXL-MINT', 60, mode, null, 21)
      const local = splitFor(mode, 60, rows, 21)
      expect(Object.fromEntries(out.lines.map((l) => [l.boutique, l.qty]))).toEqual(local)
    }
  })
})

// =============================================================================================
// the store behind the sheet
// =============================================================================================
describe('distribution store', () => {
  it('loads a plan and keeps it per item', async () => {
    const dist = desk()
    const out = await dist.loadPlan(['GB-PULSE-15K-BLUE', 'RAW-KS-SLIM'])
    expect(out?.items).toHaveLength(2)
    expect(dist.planFor('GB-PULSE-15K-BLUE')?.stores).toHaveLength(11)
    expect(dist.planFor('NOT-A-THING')).toBeNull()
    expect(dist.storeCount).toBe(11)
    expect(dist.error).toBeNull()
  })

  it('never throws: a bad item sets the error and answers null', async () => {
    const dist = desk()
    expect(await dist.loadPlan(['NOPE-000'])).toBeNull()
    expect(dist.error).toMatch(/does not exist/)
    expect(await dist.loadPlan([])).toBeNull()
    expect(dist.error).toMatch(/at least one item/)
  })

  it('sends, and keeps the multi-line refusal verbatim when it is refused', async () => {
    const dist = desk()
    await dist.loadPlan(['RAW-KS-SLIM'])
    const out = await dist.send([
      { boutique: 'OK-BIX', item_code: 'RAW-KS-SLIM', qty: 20 },
      { boutique: 'OK-BA', item_code: 'RAW-KS-SLIM', qty: 20 }
    ])
    expect(out?.stores).toBe(2)
    expect(dist.notice).toContain('40 units')
    expect(dist.notice).toContain('2 stores')
    expect(sendNotice(out!)).toContain(out!.shipments[0].name)
    expect(sentCopy(out!)).toBe('2 shipments on the wall · 40 units left Houston')

    const refused = await dist.send([{ boutique: 'OK-BIX', item_code: 'HYDE-EDGE-4K-GRAPE', qty: 999 }])
    expect(refused).toBeNull()
    expect(dist.error).toContain('\n')
    expect(dist.error).toContain('• HYDE-EDGE-4K-GRAPE')
    expect(dist.error).toContain('Nothing was sent')
  })

  it('refuses to send for a user who may not push, without calling the server', async () => {
    const dist = desk()
    useWarehouseStore().me = { ...ME, warehouse_admin: false, supply_unrestricted: false, roles: ['AWANZ Manager'], boutique: 'OK-BIX' }
    const out = await dist.send([{ boutique: 'OK-BIX', item_code: 'RAW-KS-SLIM', qty: 5 }])
    expect(out).toBeNull()
    expect(dist.error).toMatch(/warehouse admin or head office/)
  })

  it('a split through the store fills every box, including the zeros', async () => {
    const dist = desk()
    await dist.loadPlan(['OCB-XPERT-KS'])
    const out = await dist.suggest('OCB-XPERT-KS', 22, 'velocity')
    expect(out?.lines).toHaveLength(11)
    expect(out?.allocated).toBe(22)
    // a velocity split gives every store at least one when there are more units than stores
    expect(out?.lines.every((l) => l.qty >= 1)).toBe(true)
  })
})

// =============================================================================================
// v1.1 §B — a new product
// =============================================================================================
describe('new product', () => {
  function draftOf(over: Partial<ProductDraft> = {}): ProductDraft {
    return {
      ...emptyDraft(),
      item_code: 'GB-PULSE-15K-CHERRY',
      item_name: 'Geek Bar Pulse 15K — Cherry Ice',
      item_group: 'Vape',
      barcode: '8801234509999',
      supplier: 'SUP-GULF',
      vendor_sku: 'GC-GBP15-CHR',
      cost: '9.25',
      case_pack: '12',
      moq: '24',
      lead_time_days: '5',
      reorder_level: '60',
      reorder_qty: '120',
      selling_rate: '24.99',
      ...over
    }
  }

  it('accepts a complete product', () => {
    expect(validateProduct(draftOf())).toEqual([])
  })

  it('will not create a product with no code, no name or no group', () => {
    expect(validateProduct(draftOf({ item_code: '  ' }))[0]).toMatchObject({ field: 'item_code' })
    expect(validateProduct(draftOf({ item_name: '' }))[0]).toMatchObject({ field: 'item_name' })
    expect(validateProduct(draftOf({ item_group: '' }))[0]).toMatchObject({ field: 'item_group' })
  })

  it('refuses whitespace in a code or a barcode — a scanner never types a space', () => {
    expect(validateProduct(draftOf({ item_code: 'GB PULSE' }))[0].message).toContain('no spaces')
    const bad = validateProduct(draftOf({ barcode: '8801234 509999' }))
    expect(bad[0]).toMatchObject({ field: 'barcode' })
    expect(bad[0].message).toContain('scan it rather than typing it')
  })

  it('asks who the vendor terms belong to before it lets them be typed', () => {
    const problems = validateProduct(draftOf({ supplier: '', cost: '9.25' }))
    expect(problems[0]).toMatchObject({ field: 'supplier' })
    // no vendor and no terms is fine — a product may exist before anybody sells it to us
    expect(validateProduct(draftOf({ supplier: '', vendor_sku: '', cost: '', moq: '', lead_time_days: '' }))).toEqual([])
  })

  it('refuses negative money and a case that holds nothing', () => {
    expect(validateProduct(draftOf({ cost: '-1' }))[0]).toMatchObject({ field: 'cost' })
    expect(validateProduct(draftOf({ selling_rate: '-2' }))[0]).toMatchObject({ field: 'selling_rate' })
    expect(validateProduct(draftOf({ reorder_level: '-5' }))[0]).toMatchObject({ field: 'reorder_level' })
    expect(validateProduct(draftOf({ case_pack: '0' }))[0]).toMatchObject({ field: 'case_pack' })
  })

  it('builds the payload the server takes, dropping the halves that were left empty', () => {
    const full = productPayload(draftOf())
    expect(full).toMatchObject({
      item_code: 'GB-PULSE-15K-CHERRY',
      item_group: 'Vape',
      barcode: '8801234509999',
      selling_rate: 24.99
    })
    expect(full.vendor).toMatchObject({ supplier: 'SUP-GULF', cost: 9.25, case_pack: 12, moq: 24, lead_time_days: 5 })
    expect(full.reorder).toEqual({ level: 60, qty: 120 })

    const bare = productPayload(draftOf({ supplier: '', vendor_sku: '', cost: '', moq: '', lead_time_days: '', reorder_level: '', reorder_qty: '', selling_rate: '', barcode: '' }))
    expect(bare.vendor).toBeUndefined()
    expect(bare.reorder).toBeUndefined()
    expect(bare.selling_rate).toBeUndefined()
    expect(bare.barcode).toBeNull()
    // a reorder level with no quantity reorders by the level
    expect(productPayload(draftOf({ reorder_qty: '' })).reorder).toEqual({ level: 60, qty: 60 })
  })

  it('shows the margin, and says so when the price is under the cost', () => {
    expect(marginNote(9.25, 24.99)).toBe('15.74 a unit · 63% margin')
    expect(marginNote(9.25, 8)).toContain('under')
    expect(marginNote(0, 24.99)).toBe('')
    expect(marginNote(9.25, 0)).toBe('')
  })

  it('creates the item, its vendor row, its price and its reorder level in one call', async () => {
    desk()
    const out = await mockPurchasing.create_product(productPayload(draftOf()))
    expect(out.created).toBe(true)
    expect(out.item.item_code).toBe('GB-PULSE-15K-CHERRY')
    expect(out.item.preferred).toBe('SUP-GULF') // its first vendor is the preferred one
    expect(out.item.selling_rate).toBe(24.99)
    expect(out.item.reorder).toEqual({ warehouse: 'HOU-WH - CCZ', level: 60, qty: 120 })
    expect(out.catalogue_row).toMatchObject({ vendor_sku: 'GC-GBP15-CHR', cost: 9.25, case_pack: 12, default_qty: 12 })
    // and it is on the distribution desk with nothing anywhere — the whole point of v1.1
    const plan = await mockDistribution.plan(['GB-PULSE-15K-CHERRY'])
    expect(plan.items[0].on_hand).toBe(0)
    expect(plan.items[0].stores).toHaveLength(11)
    expect(plan.items[0].stores.every((s) => s.on_hand === 0 && !s.ever_sold)).toBe(true)
  })

  it('refuses a duplicate item code, naming it', async () => {
    desk()
    await expect(mockPurchasing.create_product(productPayload(draftOf({ item_code: 'RAW-KS-SLIM', barcode: '' })))).rejects.toThrow(/RAW-KS-SLIM already exists/)
  })

  it('refuses a barcode already on another item, and the message belongs on the barcode field', async () => {
    desk()
    // 8801234500017 is the Geek Bar's barcode: two products on one barcode rings up the wrong one
    const failure = await mockPurchasing
      .create_product(productPayload(draftOf({ barcode: '8801234500017' })))
      .then(() => null)
      .catch((e: Error) => e.message)
    expect(failure).toContain('8801234500017')
    expect(failure).toContain('GB-PULSE-15K-BLUE')
    expect(failure).toContain('rings up the wrong one')
    // ...which is the whole point of `fieldForError`: it lands beside the box just scanned into
    expect(fieldForError(failure!)).toBe('barcode')
    // and nothing was created
    await expect(mockDistribution.plan(['GB-PULSE-15K-CHERRY'])).rejects.toThrow(/does not exist/)
  })

  it('routes every other server refusal to the field it belongs to', () => {
    expect(fieldForError('Item RAW-KS-SLIM already exists — open it instead of creating it again')).toBe('item_code')
    expect(fieldForError('Item group Widgets does not exist')).toBe('item_group')
    expect(fieldForError('Vendor SUP-NOPE does not exist')).toBe('supplier')
    expect(fieldForError('A selling price cannot be negative')).toBe('selling_rate')
    expect(fieldForError('A vendor cost cannot be negative')).toBe('cost')
    expect(fieldForError('Something exploded in the database')).toBeNull()
    expect(fieldForError('')).toBeNull()
  })

  it('offers the groups a product can be filed under, busiest first as the default', async () => {
    desk()
    const out = await mockPurchasing.item_groups()
    expect(out.count).toBeGreaterThan(0)
    expect(out.groups.every((g) => typeof g.items === 'number')).toBe(true)
    expect(out.default).toBe('Vape') // five of the ten seeded items live there
  })
})

// =============================================================================================
// v1.1 §C — an order from scratch
// =============================================================================================
describe('new order from a vendor catalogue', () => {
  it('reads a vendor catalogue searchable by our code, our name and their SKU', async () => {
    desk()
    const all = await mockPurchasing.vendor_catalogue('SUP-GULF')
    expect(all.items.length).toBeGreaterThan(0)
    expect(all.price_list).toBe('SUP-GULF Buying')
    expect(all.total).toBe(all.items.length)
    // their SKU is the number printed on the rep's sheet — searching by it has to work
    const bySku = await mockPurchasing.vendor_catalogue('SUP-GULF', 'GC-OCB-XKS')
    expect(bySku.items.map((i) => i.item_code)).toEqual(['OCB-XPERT-KS'])
    expect(bySku.count).toBe(1)
    expect(bySku.total).toBe(all.total)
    const byName = await mockPurchasing.vendor_catalogue('SUP-GULF', 'clipper')
    expect(byName.items.map((i) => i.item_code)).toEqual(['CLIPPER-LTR-ASST'])
    const byBarcode = await mockPurchasing.vendor_catalogue('SUP-GULF', '8801234500017')
    expect(byBarcode.items.map((i) => i.item_code)).toEqual(['GB-PULSE-15K-BLUE'])
  })

  it('refuses a vendor that does not exist', async () => {
    desk()
    await expect(mockPurchasing.vendor_catalogue('SUP-NOPE')).rejects.toThrow(/does not exist/)
  })

  it('starts every line at a whole case, at the vendor rate, both editable', async () => {
    desk()
    const catalogue = await mockPurchasing.vendor_catalogue('SUP-GULF', 'GB-PULSE-15K-BLUE')
    const line = lineFromCatalogue(catalogue.items[0])
    expect(line.qty).toBe(12) // Gulf Coast pack it in 12s
    expect(Number(line.rate)).toBe(9.25)
    expect(line.case_pack).toBe(12)
    expect(line.moq).toBe(24)
  })

  it('totals the basket at the rates as typed', () => {
    const lines = [
      { item_code: 'A', item_name: 'A', vendor_sku: null, qty: 12, rate: '9.25', case_pack: 12, moq: 24, on_hand: 0 },
      { item_code: 'B', item_name: 'B', vendor_sku: null, qty: 50, rate: '1.05', case_pack: 50, moq: 50, on_hand: 90 },
      { item_code: 'C', item_name: 'C', vendor_sku: null, qty: 0, rate: '4.00', case_pack: 1, moq: 0, on_hand: 0 }
    ]
    expect(basketTotals(lines)).toEqual({ lines: 2, units: 62, value: 163.5 })
    expect(basketTotals([])).toEqual({ lines: 0, units: 0, value: 0 })
  })

  it('warns about a broken case or an order under the vendor minimum — but never blocks it', () => {
    expect(packWarning({ qty: 12, case_pack: 12, moq: 12 })).toBe('')
    expect(packWarning({ qty: 7, case_pack: 12, moq: 0 })).toBe('Not a whole case of 12')
    expect(packWarning({ qty: 12, case_pack: 12, moq: 24 })).toBe('Under their minimum of 24')
    expect(packWarning({ qty: 0, case_pack: 12, moq: 24 })).toBe('')
  })

  it('says how it is packed and what Houston already has, so nobody re-buys 300', () => {
    expect(packNote({ case_pack: 12, moq: 24, on_hand: 36, lead_time_days: 5 })).toBe('12 to a case · min 24 · 5 d lead · 36 at Houston')
    expect(packNote({ case_pack: 1, moq: 0, on_hand: 0, lead_time_days: 0 })).toBe('sold singly · none at Houston')
  })

  it('creates the draft order the existing order sheet then finishes', async () => {
    desk()
    const purchasing = usePurchasingStore()
    const catalogue = await mockPurchasing.vendor_catalogue('SUP-GULF', 'OCB-XPERT-KS')
    const line = lineFromCatalogue(catalogue.items[0])
    const out = await purchasing.createOrder('SUP-GULF', [{ item_code: line.item_code, qty: line.qty, rate: Number(line.rate) }])
    expect(out?.docstatus).toBe(0) // a draft: nothing has been sent to anybody
    expect(out?.supplier).toBe('SUP-GULF')
    expect(out?.items[0]).toMatchObject({ item_code: 'OCB-XPERT-KS', qty: 50, rate: 1.05 })
  })
})

// =============================================================================================
// the whole v1.1 story, end to end on the mock desk
// =============================================================================================
describe('a brand-new product reaches the shops', () => {
  it('create → order → receive → send to three stores', async () => {
    const dist = desk()
    const purchasing = usePurchasingStore()

    // 1. a rep shows the warehouse manager a new disposable
    const created = await mockPurchasing.create_product({
      item_code: 'LM-BM6K-BLUE',
      item_name: 'Lost Mary BM6000 — Blueberry',
      item_group: 'Vape',
      barcode: '8801234511111',
      selling_rate: 19.99,
      vendor: { supplier: 'SUP-LONE', vendor_sku: 'LS-6001', cost: 8.4, case_pack: 10, moq: 20, lead_time_days: 3 },
      reorder: { level: 40, qty: 80 }
    })
    expect(created.created).toBe(true)

    // 2. nobody can ask for it: no store has ever seen it
    const fresh = await dist.loadPlan(['LM-BM6K-BLUE'])
    expect(fresh?.items[0].available).toBe(0)
    expect(fresh?.items[0].stores.every((s) => !s.ever_sold)).toBe(true)
    // ...so a push is refused, honestly, before anything is written
    expect(await dist.send([{ boutique: 'OK-BIX', item_code: 'LM-BM6K-BLUE', qty: 10 }])).toBeNull()
    expect(dist.error).toContain('0 available')

    // 3. order it from scratch and receive it at Houston
    const order = await purchasing.createOrder('SUP-LONE', [{ item_code: 'LM-BM6K-BLUE', qty: 60, rate: 8.4 }])
    expect(order).not.toBeNull()
    await purchasing.submitOrder(order!.name)
    const receipt = await purchasing.receive(order!.name, [{ name: order!.items[0].name, item_code: 'LM-BM6K-BLUE', qty: 60 }], { final: true })
    expect(receipt?.purchase_receipt).toBeTruthy()
    expect(receipt?.lines[0].accepted_qty).toBe(60)

    // 4. now Houston holds it — and the sheet can share it out
    const stocked = await dist.loadPlan(['LM-BM6K-BLUE'])
    expect(stocked?.items[0].available).toBe(60)
    const split = await dist.suggest('LM-BM6K-BLUE', 30, 'even', null, ['OK-BIX', 'OK-YALE', 'HOU-MTR'])
    expect(split?.allocated).toBe(30)
    expect(split?.left_at_warehouse).toBe(30)

    // 5. send it — one shipment per store
    const sent = await dist.send(
      split!.lines.map((l) => ({ boutique: l.boutique, item_code: 'LM-BM6K-BLUE', qty: l.qty })),
      'New product — a case each to try'
    )
    expect(sent?.stores).toBe(3)
    expect(sent?.units).toBe(30)
    expect(sent?.reason).toBe('New product — a case each to try')
    expect(sent?.shipments.every((s) => s.warehouse_push)).toBe(true)

    // 6. what left is spoken for; what is left over is still Houston's
    const after = await mockDistribution.plan(['LM-BM6K-BLUE'])
    const item: PlanItem = after.items[0]
    expect(item.on_hand).toBe(60)
    expect(item.committed).toBe(30)
    expect(item.available).toBe(30)
  })
})
