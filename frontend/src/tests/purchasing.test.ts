/**
 * v1.0 "Procurement" — the buying maths (`warehouse/buying.ts`), the mock buying desk's state
 * transitions (`api/purchasing.ts`) and the Buying screen's selection getters
 * (`stores/purchasing.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  coverDays,
  etaFrom,
  freightSharePerUnit,
  groupBySupplier,
  lineFor,
  lineTotal,
  movingAverageAfter,
  orderLanded,
  orderNet,
  orderPlan,
  pendingOf,
  pickVendor,
  receiveVariance,
  roundToCasePack,
  sourceBadge,
  type BuyLine
} from '@/warehouse/buying'
import { __resetMockPurchasing, mockPurchasing, type Suggestion } from '@/api/purchasing'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import type { WarehouseMe } from '@/api/warehouse'

// the store talks to `purchasingApi`; point it at the deterministic in-memory desk
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

function buyLine(over: Partial<BuyLine> = {}): BuyLine {
  return { item_code: 'GB-PULSE-15K-BLUE', supplier: 'SUP-GULF', qty: 12, rate: 9.25, case_pack: 12, moq: 24, lead_time_days: 5, ...over }
}

// =============================================================================================
// buying.ts — case pack, MOQ, money
// =============================================================================================
describe('case-pack and MOQ rounding', () => {
  it('rounds up to a whole case and leaves a quantity already on a boundary alone', () => {
    expect(roundToCasePack(24, 12)).toBe(24)
    expect(roundToCasePack(12, 12)).toBe(12)
    expect(roundToCasePack(25, 12)).toBe(36)
    expect(roundToCasePack(1, 12)).toBe(12)
    expect(roundToCasePack(2.5, 1)).toBe(3)
    expect(roundToCasePack(60, 12)).toBe(60)
  })

  it('never conjures an order out of nothing', () => {
    expect(roundToCasePack(0, 12, 24)).toBe(0)
    expect(roundToCasePack(-5, 12, 24)).toBe(0)
  })

  it('lifts to the MOQ — rounding the MOQ itself up to a whole case', () => {
    // one case (12) is below the 24 minimum → two whole cases
    expect(roundToCasePack(6, 12, 24)).toBe(24)
    // a MOQ that is not a multiple of the case pack rounds up too: 25 → 3 × 10
    expect(roundToCasePack(3, 10, 25)).toBe(30)
    // already past the minimum → the MOQ never pulls a quantity down
    expect(roundToCasePack(40, 10, 25)).toBe(40)
    expect(roundToCasePack(100, 100, 200)).toBe(200)
  })

  it('treats a missing or fractional case pack the way frappe cint does', () => {
    expect(roundToCasePack(7, 0)).toBe(7)
    expect(roundToCasePack(7, 1)).toBe(7)
    expect(roundToCasePack(7, 2.9)).toBe(8) // cint(2.9) === 2
    expect(roundToCasePack(7, undefined as unknown as number)).toBe(7)
  })
})

describe('order money', () => {
  const lines = [
    { qty: 84, rate: 9.25 },
    { qty: 100, rate: 1.05 }
  ]

  it('extends a line and nets an order at currency precision', () => {
    expect(lineTotal(84, 9.25)).toBe(777)
    expect(lineTotal(3, 0.1)).toBe(0.3)
    expect(orderNet(lines)).toBe(882)
    expect(orderNet([])).toBe(0)
  })

  it('adds the manual freight for the landed total', () => {
    expect(orderLanded(lines, 60)).toBe(942)
    expect(orderLanded(lines)).toBe(882)
    expect(orderLanded(lines, 0)).toBe(882)
  })

  it('spreads freight over the units, and is 0 with no freight or no units', () => {
    expect(freightSharePerUnit(lines, 92)).toBe(0.5) // 184 units
    expect(freightSharePerUnit(lines, 0)).toBe(0)
    expect(freightSharePerUnit(lines)).toBe(0)
    expect(freightSharePerUnit([], 100)).toBe(0)
    expect(freightSharePerUnit([{ qty: 0 }], 100)).toBe(0)
    expect(freightSharePerUnit([{ qty: 3 }], 1)).toBe(0.3333)
  })
})

// =============================================================================================
// buying.ts — grouping, vendor swap, badges, dates, receiving
// =============================================================================================
describe('grouping lines the way create_orders does', () => {
  it('groups by vendor, and splits a drop-ship out of the same vendor', () => {
    const lines = [
      buyLine({ item_code: 'GB-PULSE-15K-BLUE', supplier: 'SUP-GULF', qty: 60, rate: 9.25 }),
      buyLine({ item_code: 'OCB-XPERT-KS', supplier: 'SUP-GULF', qty: 100, rate: 1.05 }),
      buyLine({ item_code: 'AF-SHISHA-250-MINT', supplier: 'SUP-BAYOU', qty: 24, rate: 5.6 }),
      buyLine({ item_code: 'RAW-KS-SLIM', supplier: 'SUP-GULF', qty: 50, rate: 1.32, dropship_store: 'OK-BIX' })
    ]
    const groups = groupBySupplier(lines)
    expect(groups.map((g) => [g.supplier, g.dropship_store])).toEqual([
      ['SUP-BAYOU', null],
      ['SUP-GULF', null],
      ['SUP-GULF', 'OK-BIX']
    ])
    expect(groups[1].lines.map((l) => l.item_code)).toEqual(['GB-PULSE-15K-BLUE', 'OCB-XPERT-KS'])
    expect(groups[1].units).toBe(160)
    expect(groups[1].value).toBe(660)

    const plan = orderPlan(lines)
    expect(plan.orders).toBe(3)
    expect(plan.vendors).toBe(2) // "3 orders, 2 vendors"
    expect(plan.units).toBe(234)
    expect(plan.value).toBe(860.4)
  })

  it('drops lines the server would drop: no vendor, no item, nothing to buy', () => {
    const groups = groupBySupplier([
      buyLine({ supplier: '' }),
      buyLine({ item_code: '' }),
      buyLine({ qty: 0 }),
      buyLine({ qty: -3 }),
      buyLine({ item_code: 'ZIG-ZAG-1-25', qty: 50, rate: 0.89 })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].lines).toHaveLength(1)
    expect(orderPlan([]).orders).toBe(0)
  })
})

describe('swapping a suggestion to another vendor', () => {
  let suggestions: Suggestion[]
  beforeEach(async () => {
    __resetMockPurchasing()
    suggestions = (await mockPurchasing.suggestions(true)).suggestions
  })

  it('takes the alternative vendor cost, case pack, MOQ, lead time and SKU, and re-rounds the qty', () => {
    const hyde = suggestions.find((s) => s.item_code === 'HYDE-EDGE-4K-GRAPE')!
    expect(lineFor(hyde)).toMatchObject({ supplier: 'SUP-LONE', qty: 18, rate: 7.85, case_pack: 6, moq: 12, lead_time_days: 3 })
    // Sooner sells in fives with no minimum: need 16 → 4 × 5
    const swapped = pickVendor(hyde, 'SUP-SOONER')
    expect(swapped).toMatchObject({ supplier: 'SUP-SOONER', rate: 8.2, case_pack: 5, moq: 0, lead_time_days: 7, qty: 20, vendor_sku: 'SS-HYD-GR' })
    expect(swapped.suggestion).toBe(hyde.name)
  })

  it("honours the alternative's MOQ", () => {
    const ocb = suggestions.find((s) => s.item_code === 'OCB-XPERT-KS')!
    expect(ocb.suggested_qty).toBe(100)
    // Bayou is cheaper (0.98 vs 1.05) but sells 100s with a 200 minimum
    expect(pickVendor(ocb, 'SUP-BAYOU')).toMatchObject({ supplier: 'SUP-BAYOU', rate: 0.98, qty: 200 })
  })

  it('nets what is already on order off the re-rounded quantity', () => {
    const gb = suggestions.find((s) => s.item_code === 'GB-PULSE-15K-BLUE')!
    expect(gb).toMatchObject({ need: 84, on_order: 24, suggested_qty: 60 })
    // Lone Star sells in tens: (84 − 24) → 60
    expect(pickVendor(gb, 'SUP-LONE')).toMatchObject({ supplier: 'SUP-LONE', rate: 9.6, case_pack: 10, qty: 60 })
  })

  it('leaves the line alone for a vendor that does not sell the item', () => {
    const gb = suggestions.find((s) => s.item_code === 'GB-PULSE-15K-BLUE')!
    expect(pickVendor(gb, 'SUP-PANH')).toEqual(lineFor(gb))
  })
})

describe('source badges', () => {
  it('labels and tones the three sources', () => {
    expect(sourceBadge('Low stock')).toEqual({ label: 'Low stock', tone: 'crit', title: 'Low stock' })
    expect(sourceBadge('Store demand')).toMatchObject({ label: 'Store demand', tone: 'warn' })
    expect(sourceBadge('Trending')).toMatchObject({ label: 'Trending', tone: 'accent' })
  })

  it('shows the most urgent source with a +N when an item came from more than one', () => {
    expect(sourceBadge(['Store demand', 'Low stock'])).toEqual({ label: 'Low stock +1', tone: 'crit', title: 'Low stock · Store demand' })
    expect(sourceBadge(['Trending', 'Store demand', 'Low stock'])).toMatchObject({ label: 'Low stock +2', tone: 'crit' })
    expect(sourceBadge(['Trending', 'Store demand'])).toMatchObject({ label: 'Store demand +1', tone: 'warn' })
    // one source repeated is still one source
    expect(sourceBadge(['Trending', 'Trending'])).toMatchObject({ label: 'Trending', tone: 'accent' })
  })

  it('degrades quietly on an empty or unknown source', () => {
    expect(sourceBadge([])).toEqual({ label: '—', tone: 'muted', title: '' })
    expect(sourceBadge('')).toEqual({ label: '—', tone: 'muted', title: '' })
    expect(sourceBadge('Manual')).toMatchObject({ label: 'Manual', tone: 'muted' })
  })
})

describe('cover days and ETAs', () => {
  it('is null for an item that does not move', () => {
    expect(coverDays(288, 0)).toBeNull()
    expect(coverDays(288, -1)).toBeNull()
    expect(coverDays(36, 4.2)).toBe(8.6)
    expect(coverDays(0, 4.2)).toBe(0)
  })

  it('prefers the promised date, otherwise today plus the lead time', () => {
    expect(etaFrom('2026-08-27', 10, '2026-08-24')).toBe('2026-08-27')
    expect(etaFrom('2026-08-27T00:00:00', 10, '2026-08-24')).toBe('2026-08-27')
    expect(etaFrom(null, 5, '2026-08-24')).toBe('2026-08-29')
    expect(etaFrom(null, 10, '2026-08-24')).toBe('2026-09-03')
    // no lead time on the vendor → the server's 7-day default; never same-day
    expect(etaFrom(null, 0, '2026-08-24')).toBe('2026-08-31')
    expect(etaFrom(undefined, 0.4, '2026-08-24')).toBe('2026-08-31')
    // crosses a month and a year end without drifting
    expect(etaFrom(null, 10, '2026-12-27')).toBe('2027-01-06')
    expect(etaFrom(null, 3, new Date(2026, 7, 24))).toBe('2026-08-27')
  })
})

describe('receive variance', () => {
  it('reports short, over and clean lines', () => {
    expect(receiveVariance({ qty: 60, received_qty: 60 })).toEqual({ short: 0, over: 0, ok: true })
    expect(receiveVariance({ qty: 60, received_qty: 58 })).toEqual({ short: 2, over: 0, ok: false })
    expect(receiveVariance({ qty: 60, received_qty: 64 })).toEqual({ short: 0, over: 4, ok: false })
    // damaged units raise a discrepancy too, so the line is not "ok"
    expect(receiveVariance({ qty: 60, received_qty: 60, damaged_qty: 3 })).toEqual({ short: 0, over: 0, ok: false })
  })

  it('measures against what is still outstanding, not the whole order line', () => {
    expect(receiveVariance({ qty: 100, pending_qty: 40, received_qty: 40 })).toEqual({ short: 0, over: 0, ok: true })
    expect(receiveVariance({ qty: 100, pending_qty: 40, received_qty: 25 })).toEqual({ short: 15, over: 0, ok: false })
    expect(pendingOf({ qty: 100, received_qty: 60 })).toBe(40)
    expect(pendingOf({ qty: 100, received_qty: 120 })).toBe(0)
  })
})

describe('moving average preview', () => {
  it('is the plain weighted average of what is held and what arrived', () => {
    // 100 @ 4.20 + 100 @ 4.50 → 4.35; the 2 ¢/unit freight share pushes it to 4.36
    expect(movingAverageAfter(100, 4.2, 100, 4.5, 0.02)).toBe(4.36)
    expect(movingAverageAfter(100, 4.2, 100, 4.5)).toBe(4.35)
    // a receipt at the same cost never moves the average
    expect(movingAverageAfter(36, 9.34, 60, 9.34, 0)).toBe(9.34)
    // buying cheaper from the second vendor pulls the average down
    expect(movingAverageAfter(90, 1.02, 200, 0.98, 0)).toBeCloseTo(0.9924, 4)
  })

  it('takes the landed cost of the receipt when there was nothing on hand', () => {
    expect(movingAverageAfter(0, 0, 120, 9.25, 0.32)).toBe(9.57)
    expect(movingAverageAfter(0, 5, 0, 9.25, 0)).toBe(9.25)
    // a negative bin (received against a backorder) nets out to the landed cost too
    expect(movingAverageAfter(-10, 4, 10, 6, 0)).toBe(6)
  })
})

// =============================================================================================
// api/purchasing.ts — the mock buying desk keeps the server's state transitions
// =============================================================================================
describe('mock buying desk', () => {
  beforeEach(() => __resetMockPurchasing())

  it('seeds vendors, a catalogue with two costs per item, and valued stock', async () => {
    const all = await mockPurchasing.vendors(undefined, false)
    expect(all.count).toBe(5)
    const active = await mockPurchasing.vendors()
    expect(active.count).toBe(4)
    expect(active.vendors.every((v) => v.active)).toBe(true)
    expect(active.vendors[0].spend).toBeGreaterThan(active.vendors[1].spend!)

    const gb = await mockPurchasing.item_vendors('GB-PULSE-15K-BLUE')
    expect(gb.vendors).toHaveLength(2)
    expect(new Set(gb.vendors.map((v) => v.cost)).size).toBe(2)
    expect(gb.preferred).toBe('SUP-GULF')
    expect(gb.vendors.filter((v) => v.is_preferred)).toHaveLength(1)

    const stock = await mockPurchasing.stock()
    expect(stock.rows).toHaveLength(10)
    expect(stock.warehouse).toBe('HOU-WH - CCZ')
    expect(stock.low).toBe(4)
    expect(stock.rows[0].low).toBe(true) // low stock sorts first
    expect(stock.stock_value).toBeGreaterThan(0)
    const gbRow = stock.rows.find((r) => r.item_code === 'GB-PULSE-15K-BLUE')!
    expect(gbRow).toMatchObject({ valuation_rate: 9.34, valuation_method: 'Moving Average', on_order: 24 })
    expect(gbRow.stock_value).toBe(336.24)
    expect(stock.rows.find((r) => r.item_code === 'CLIPPER-LTR-ASST')!.cover_days).toBeNull()
  })

  it('serves a run covering all three demand sources', async () => {
    const run = await mockPurchasing.suggestions(true)
    expect(run.run_id).toBeTruthy()
    expect(run.as_of).toBeTruthy()
    expect(run.count).toBe(5)
    const sources = new Set(run.suggestions.flatMap((s) => s.sources))
    expect(sources).toEqual(new Set(['Low stock', 'Store demand', 'Trending']))
    expect(run.suggestions.every((s) => s.vendors.length === 2 && s.status === 'Open')).toBe(true)
    // a cached read carries no `as_of`
    expect((await mockPurchasing.suggestions()).as_of).toBeUndefined()
  })

  it('creates one draft per vendor and takes those suggestions off the list', async () => {
    const run = await mockPurchasing.suggestions()
    const lines = run.suggestions.map((s) => ({ item_code: s.item_code, qty: s.qty, supplier: s.supplier!, suggestion: s.name }))
    const out = await mockPurchasing.create_orders(lines)
    expect(out.count).toBe(4) // Gulf ×2 lines, Lone, Bayou, Sooner
    expect(out.orders).toHaveLength(4)
    expect(out.created.every((c) => c.dropship_store === null)).toBe(true)

    const after = await mockPurchasing.suggestions()
    expect(after.count).toBe(0)

    const gulf = await mockPurchasing.order(out.created.find((c) => c.supplier === 'SUP-GULF')!.name)
    expect(gulf.docstatus).toBe(0)
    expect(gulf.can_edit).toBe(true)
    expect(gulf.items).toHaveLength(2)
    expect(gulf.net_total).toBe(660) // 60 × 9.25 + 100 × 1.05
    await expect(mockPurchasing.create_orders([])).rejects.toThrow(/Nothing to order/)
  })

  it('dismisses a suggestion off the list', async () => {
    const run = await mockPurchasing.suggestions()
    const target = run.suggestions[0]
    const out = await mockPurchasing.dismiss_suggestion(target.name, 'discontinued')
    expect(out.status).toBe('Dismissed')
    expect((await mockPurchasing.suggestions()).suggestions.map((s) => s.name)).not.toContain(target.name)
  })

  it('edits a draft, submits it (docstatus 0 → 1, can_edit true → false) and sends it', async () => {
    const before = await mockPurchasing.order('MPO-00001')
    expect(before).toMatchObject({ docstatus: 0, can_edit: true, status: 'Draft', freight: 0 })

    const edited = await mockPurchasing.update_order('MPO-00001', [{ item_code: 'GB-PULSE-15K-BLUE', qty: 96, rate: 9.1 }], 40)
    expect(edited.items).toHaveLength(1)
    expect(edited.items[0]).toMatchObject({ qty: 96, rate: 9.1, amount: 873.6 })
    expect(edited.freight).toBe(40)
    expect(edited.landed_total).toBe(913.6)

    const submitted = await mockPurchasing.submit_order('MPO-00001')
    expect(submitted.docstatus).toBe(1)
    expect(submitted.can_edit).toBe(false)
    expect(submitted.status).toBe('To Receive and Bill')
    await expect(mockPurchasing.submit_order('MPO-00001')).rejects.toThrow(/already submitted/)
    await expect(mockPurchasing.update_order('MPO-00001', [{ item_code: 'GB-PULSE-15K-BLUE', qty: 5 }])).rejects.toThrow(/not a draft/)

    const sent = await mockPurchasing.send_order('MPO-00001', 'Email')
    expect(sent).toMatchObject({ method: 'Email', emailed: true, recipient: 'marisol@gulfcoastdist.example' })
    expect(sent.order.sent_method).toBe('Email')
    await expect(mockPurchasing.send_order('MPO-00001', 'Carrier pigeon')).rejects.toThrow(/Unknown order method/)
    await expect(mockPurchasing.send_order('MPO-00002', 'Email')).rejects.toThrow(/Submit the order/)
  })

  it('re-addresses a draft to a store and back to Houston, but never a submitted one', async () => {
    const before = await mockPurchasing.order('MPO-00001')
    expect(before.dropship_store).toBeNull()
    expect(before.set_warehouse).toBe('HOU-WH - CCZ')

    const dropped = await mockPurchasing.update_order('MPO-00001', null, null, 'OK-BIX')
    expect(dropped.dropship_store).toBe('OK-BIX')
    expect(dropped.set_warehouse).toBe('OK-BIX - CCZ')
    expect(dropped.items.every((l) => l.warehouse === 'OK-BIX - CCZ')).toBe(true)
    expect((await mockPurchasing.orders({ store: 'OK-BIX' })).orders.map((o) => o.name)).toContain('MPO-00001')

    // moved on to another store, then cleared — the header and every line follow both times
    const moved = await mockPurchasing.update_order('MPO-00001', null, null, 'OK-JENKS')
    expect(moved.set_warehouse).toBe('OK-JENKS - CCZ')
    expect(moved.items.every((l) => l.warehouse === 'OK-JENKS - CCZ')).toBe(true)
    const cleared = await mockPurchasing.update_order('MPO-00001', null, null, null)
    expect(cleared.dropship_store).toBeNull()
    expect(cleared.set_warehouse).toBe('HOU-WH - CCZ')
    expect(cleared.items.every((l) => l.warehouse === 'HOU-WH - CCZ')).toBe(true)

    // leaving the argument out leaves the destination alone
    await mockPurchasing.update_order('MPO-00001', null, null, 'OK-BIX')
    expect((await mockPurchasing.update_order('MPO-00001', null, 15)).dropship_store).toBe('OK-BIX')
    await expect(mockPurchasing.update_order('MPO-00001', null, null, 'NOWHERE')).rejects.toThrow(/does not exist/)
    // …and a submitted order's destination is fixed
    await expect(mockPurchasing.update_order('MPO-00003', null, null, 'OK-BIX')).rejects.toThrow(/submitted/)
  })

  it('deletes a draft, puts its suggestions back on the list, and refuses a submitted order', async () => {
    const run = await mockPurchasing.suggestions()
    const target = run.suggestions.find((s) => s.item_code === 'OCB-XPERT-KS')!
    const created = await mockPurchasing.create_orders([
      { item_code: target.item_code, qty: target.qty, supplier: target.supplier!, suggestion: target.name }
    ])
    const draft = created.orders[0]
    expect((await mockPurchasing.suggestions()).suggestions.map((s) => s.name)).not.toContain(target.name)

    const out = await mockPurchasing.delete_order(draft, 'ordered by phone instead')
    expect(out).toEqual({ deleted: draft, suggestions_reopened: [target.name] })
    await expect(mockPurchasing.order(draft)).rejects.toThrow(/does not exist/)
    expect((await mockPurchasing.orders({ status: 'all' })).orders.map((o) => o.name)).not.toContain(draft)
    // the item is back on the buying list
    expect((await mockPurchasing.suggestions()).suggestions.map((s) => s.name)).toContain(target.name)

    await expect(mockPurchasing.delete_order('MPO-00003')).rejects.toThrow(/close it instead/)
  })

  it('lists the submitted order as expected inbound and files it by filter', async () => {
    const inbound = await mockPurchasing.inbound()
    expect(inbound.warehouse).toBe('HOU-WH - CCZ')
    expect(inbound.purchase_orders.map((p) => p.name)).toEqual(['MPO-00003'])
    expect(inbound.expected).toEqual(inbound.purchase_orders)
    expect(inbound.units).toBe(284)
    expect(inbound.discrepancies).toHaveLength(1)
    expect(inbound.discrepancies[0]).toMatchObject({ type: 'Short', supplier: 'SUP-GULF' })

    expect((await mockPurchasing.orders({ status: 'Draft' })).orders.map((o) => o.name)).toEqual(['MPO-00002', 'MPO-00001'])
    expect((await mockPurchasing.orders({ status: 'Open' })).orders.map((o) => o.name)).toEqual(['MPO-00003'])
    expect((await mockPurchasing.orders({ store: 'OK-BIX' })).orders.map((o) => o.name)).toEqual(['MPO-00002'])
    expect((await mockPurchasing.orders({ supplier: 'SUP-LONE' })).count).toBe(1)
    expect((await mockPurchasing.orders({ from: '2026-08-22', status: 'all' })).orders.every((o) => (o.transaction_date || '') >= '2026-08-22')).toBe(true)
    // the order list holds `order_dict(with_items=False)` rows — no lines
    expect((await mockPurchasing.orders({ status: 'all' })).orders[0]).not.toHaveProperty('items')
  })

  it('receives a short line: received_qty and per_received rise, a discrepancy is raised, cost moves', async () => {
    const before = await mockPurchasing.order('MPO-00003')
    const zig = before.items.find((l) => l.item_code === 'ZIG-ZAG-1-25')!
    const stockBefore = (await mockPurchasing.stock('ZIG-ZAG')).rows[0]
    expect(stockBefore).toMatchObject({ actual_qty: 410, valuation_rate: 0.9 })

    const out = await mockPurchasing.receive('MPO-00003', [{ name: zig.name, qty: 180, rate: 0.95 }], 60, true)
    expect(out.purchase_receipt).toMatch(/^MAT-PRE/)
    expect(out.supplier).toBe('SUP-LONE')
    expect(out.final).toBe(true)
    const zigLine = out.lines.find((l) => l.item_code === 'ZIG-ZAG-1-25')!
    expect(zigLine).toMatchObject({ received_qty: 180, posted_qty: 180, accepted_qty: 180, short_qty: 20, over_qty: 0, rate: 0.95, po_rate: 0.89 })
    // `final` turns everything untouched into a Short too
    expect(out.lines.find((l) => l.item_code === 'LM-MO20K-WM')!.short_qty).toBe(60)
    expect(out.discrepancies.length).toBeGreaterThanOrEqual(2)

    const after = await mockPurchasing.order('MPO-00003')
    expect(after.items.find((l) => l.item_code === 'ZIG-ZAG-1-25')!.received_qty).toBe(180)
    expect(after.items.find((l) => l.item_code === 'ZIG-ZAG-1-25')!.pending_qty).toBe(20)
    expect(after.per_received).toBe(Math.round((180 / 284) * 100))
    expect(after.discrepancies.length).toBeGreaterThanOrEqual(2)

    const stockAfter = (await mockPurchasing.stock('ZIG-ZAG')).rows[0]
    expect(stockAfter.actual_qty).toBe(590)
    // 410 @ 0.90 + 180 @ (0.95 + 60/180) → moving average, freight in valuation.
    // The $60 freight is spread over the 180 units **this receipt** accepted, not the order's
    // 284 ordered units: the server puts it on the Purchase Receipt as an Actual + Valuation
    // charge, so ERPNext distributes it across that receipt's lines. Dividing by the order made
    // a partial receipt post a lower cost than the receive sheet's preview promised.
    expect(stockAfter.valuation_rate).toBe(movingAverageAfter(410, 0.9, 180, 0.95, 60 / 180))
    expect(stockAfter.valuation_rate).toBeGreaterThan(0.9)
    // the receipt stamped what we actually paid on the item-vendor row
    const catalogue = await mockPurchasing.item_vendors('ZIG-ZAG-1-25')
    expect(catalogue.vendors.find((v) => v.supplier === 'SUP-LONE')).toMatchObject({ last_purchase_rate: 0.95, last_purchase_date: '2026-08-24' })
  })

  it('books damaged units aside and flags an over-receipt', async () => {
    const po = await mockPurchasing.order('MPO-00003')
    const lm = po.items.find((l) => l.item_code === 'LM-MO20K-WM')!
    const out = await mockPurchasing.receive('MPO-00003', [{ name: lm.name, qty: 65, damaged_qty: 5 }])
    const line = out.lines[0]
    expect(line).toMatchObject({ received_qty: 65, posted_qty: 60, accepted_qty: 55, damaged_qty: 5, over_qty: 5, short_qty: 0 })
    expect(out.discrepancies).toHaveLength(2) // Damaged + Over
    await expect(mockPurchasing.receive('MPO-00001', [{ item_code: 'GB-PULSE-15K-BLUE', qty: 1 }])).rejects.toThrow(/not submitted/)
  })

  it('keeps exactly one preferred vendor per item and lets a vendor be deactivated, not deleted', async () => {
    const flipped = await mockPurchasing.set_preferred_vendor('GB-PULSE-15K-BLUE', 'SUP-LONE')
    expect(flipped.preferred).toBe('SUP-LONE')
    expect(flipped.vendors.filter((v) => v.is_preferred)).toHaveLength(1)
    await expect(mockPurchasing.set_preferred_vendor('GB-PULSE-15K-BLUE', 'SUP-PANH')).rejects.toThrow(/not a vendor of/)

    const saved = await mockPurchasing.save_item_vendor('GB-PULSE-15K-BLUE', { supplier: 'SUP-BAYOU', cost: 9.05, case_pack: 24, moq: 48, is_preferred: true })
    expect(saved.vendors).toHaveLength(3)
    expect(saved.preferred).toBe('SUP-BAYOU')
    const removed = await mockPurchasing.remove_item_vendor('GB-PULSE-15K-BLUE', saved.vendors.find((v) => v.supplier === 'SUP-BAYOU')!.name)
    expect(removed.vendors).toHaveLength(2)

    const off = await mockPurchasing.set_vendor_active('SUP-SOONER', false)
    expect(off.active).toBe(false)
    expect((await mockPurchasing.vendors()).vendors.map((v) => v.name)).not.toContain('SUP-SOONER')
    expect((await mockPurchasing.vendor('SUP-SOONER')).vendor.disabled).toBe(1)
  })

  it('opens a vendor profile with catalogue, open orders, receipts and 12-month spend', async () => {
    const detail = await mockPurchasing.vendor('SUP-GULF')
    expect(detail.vendor.price_list).toBe('SUP-GULF Buying')
    expect(detail.catalogue.length).toBeGreaterThan(3)
    expect(detail.catalogue.every((c) => c.cost > 0)).toBe(true)
    // every row carries the AWANZ Item Vendor row name `remove_item_vendor` takes
    expect(detail.catalogue.every((c) => !!c.name)).toBe(true)
    const row = detail.catalogue[0]
    const onTheItem = (await mockPurchasing.item_vendors(row.item_code)).vendors.find((v) => v.supplier === 'SUP-GULF')!
    expect(row.name).toBe(onTheItem.name)
    expect(detail.open_orders.map((o) => o.name)).toEqual(['MPO-00001']) // MPO-00000 is Completed
    expect(detail.receipts[0].name).toMatch(/^MAT-PRE/)
    expect(detail.spend.since).toBe('2025-08-24')
    expect(detail.spend.on_time_pct).toBe(87.5)
    await expect(mockPurchasing.vendor('SUP-NOPE')).rejects.toThrow(/does not exist/)
  })

  it('creates a vendor with its buying price list and wires the price-change workflow', async () => {
    const created = await mockPurchasing.save_vendor({ supplier_name: 'Red River Imports', lead_time_days: 6, order_method: 'Email', rep_email: 'sales@redriver.example' })
    expect(created.price_list).toBe(`${created.vendor.name} Buying`)
    expect(created.vendor).toMatchObject({ active: true, disabled: 0, lead_time_days: 6 })
    await expect(mockPurchasing.save_vendor({})).rejects.toThrow(/needs a name/)

    const pending = await mockPurchasing.price_change_requests('OK-BIX')
    expect(pending.requests.map((r) => r.name)).toEqual(['PCR-00003'])
    const raised = await mockPurchasing.request_price_change('RAW-KS-SLIM', 'OK-BIX', 2.79, 'Match the shop down the block')
    expect(raised.workflow_state).toBe('Pending Approval')
    const decided = await mockPurchasing.approve_price_change(raised.name, 'Approve')
    expect(decided.workflow_state).toBe('Approved')
    expect(decided.pricing_rule).toMatch(/^PRLE/)
    await expect(mockPurchasing.approve_price_change(raised.name, 'Shrug' as 'Approve')).rejects.toThrow(/Unknown action/)
  })

  it('resets to the seeded desk between tests', async () => {
    await mockPurchasing.dismiss_suggestion('PSG-00001')
    expect((await mockPurchasing.suggestions()).count).toBe(4)
    __resetMockPurchasing()
    expect((await mockPurchasing.suggestions()).count).toBe(5)
  })
})

// =============================================================================================
// stores/purchasing.ts — the Buying screen's basket
// =============================================================================================
describe('purchasing store', () => {
  beforeEach(() => {
    __resetMockPurchasing()
    setActivePinia(createPinia())
    useWarehouseStore().me = { ...ME }
  })

  it('delegates the role gate to the warehouse store and refuses a write without it', async () => {
    const store = usePurchasingStore()
    expect(store.allowed).toBe(true)
    const warehouse = useWarehouseStore()
    warehouse.me = { ...ME, supply_unrestricted: false }
    expect(store.allowed).toBe(false)
    expect(await store.submitOrder('MPO-00001')).toBeNull()
    expect(store.error).toMatch(/warehouse admin or head office/)
    // a read is left to the server's own gate
    expect(await store.loadSuggestions()).not.toBeNull()
  })

  it('builds selected lines, count, value and the orders it will create', async () => {
    const store = usePurchasingStore()
    await store.loadSuggestions()
    expect(store.suggestions).toHaveLength(5)
    expect(store.selectedCount).toBe(0)
    expect(store.ordersToCreate).toEqual([])

    store.select('GB-PULSE-15K-BLUE')
    store.select('OCB-XPERT-KS')
    store.select('HYDE-EDGE-4K-GRAPE')
    expect(store.selectedCount).toBe(3)
    // 60 × 9.25 + 100 × 1.05 + 18 × 7.85
    expect(store.selectedValue).toBe(801.3)
    expect(store.ordersToCreate.map((g) => g.supplier)).toEqual(['SUP-GULF', 'SUP-LONE'])
    expect(store.plan).toMatchObject({ orders: 2, vendors: 2, units: 178 })

    store.deselect('HYDE-EDGE-4K-GRAPE')
    expect(store.selectedCount).toBe(2)
    store.toggle('HYDE-EDGE-4K-GRAPE')
    expect(store.isSelected('HYDE-EDGE-4K-GRAPE')).toBe(true)
    store.toggle('HYDE-EDGE-4K-GRAPE')
    expect(store.isSelected('HYDE-EDGE-4K-GRAPE')).toBe(false)

    store.selectAll()
    expect(store.selectedCount).toBe(5)
    expect(store.plan.orders).toBe(4)
    store.clearSelection()
    expect(store.selectedCount).toBe(0)
  })

  it('applies quantity and vendor overrides, and drops a row edited down to nothing', async () => {
    const store = usePurchasingStore()
    await store.loadSuggestions()

    store.setQty('GB-PULSE-15K-BLUE', 120)
    expect(store.selectedLines[0]).toMatchObject({ qty: 120, supplier: 'SUP-GULF', rate: 9.25 })
    expect(store.selectedValue).toBe(1110)

    // a vendor swap re-rounds to the new case pack and forgets the typed quantity
    store.setSupplier('HYDE-EDGE-4K-GRAPE', 'SUP-SOONER')
    const hyde = store.selectedLines.find((l) => l.item_code === 'HYDE-EDGE-4K-GRAPE')!
    expect(hyde).toMatchObject({ supplier: 'SUP-SOONER', rate: 8.2, case_pack: 5, qty: 20 })
    expect(store.ordersToCreate.map((g) => g.supplier)).toEqual(['SUP-GULF', 'SUP-SOONER'])

    store.setQty('GB-PULSE-15K-BLUE', 0)
    expect(store.selectedCount).toBe(1)
    expect(store.selectedLines.map((l) => l.item_code)).toEqual(['HYDE-EDGE-4K-GRAPE'])
  })

  it('creates the orders, empties the basket and takes the ordered rows off the list', async () => {
    const store = usePurchasingStore()
    await store.loadSuggestions()
    store.select('GB-PULSE-15K-BLUE')
    store.select('OCB-XPERT-KS')
    store.select('AF-SHISHA-250-MINT')

    const out = await store.createOrders()
    expect(out).not.toBeNull()
    expect(out!.count).toBe(2) // one Gulf order with two lines, one Bayou order
    expect(store.notice).toBe('2 orders created')
    expect(store.selection).toEqual({})
    expect(store.suggestions.map((s) => s.item_code)).toEqual(['HYDE-EDGE-4K-GRAPE', 'PUFF-XXL-MINT'])
    expect(store.orders.map((o) => o.name)).toEqual(expect.arrayContaining(out!.orders))

    store.clearSelection()
    expect(await store.createOrders()).toBeNull()
    expect(store.error).toMatch(/Nothing to order/)
  })

  it('keeps the list row and the open sheet in step through submit and send', async () => {
    const store = usePurchasingStore()
    await store.loadOrders({ status: 'all' })
    await store.loadOrder('MPO-00001')
    expect(store.orderDetail!.can_edit).toBe(true)
    expect(store.draftOrders.map((o) => o.name)).toEqual(['MPO-00002', 'MPO-00001'])

    await store.updateOrder('MPO-00001', [{ item_code: 'GB-PULSE-15K-BLUE', qty: 96, rate: 9.1 }], 40)
    expect(store.orders.find((o) => o.name === 'MPO-00001')!.freight).toBe(40)

    const submitted = await store.submitOrder('MPO-00001')
    expect(submitted!.docstatus).toBe(1)
    expect(store.orderDetail!.can_edit).toBe(false)
    expect(store.orders.find((o) => o.name === 'MPO-00001')).toMatchObject({ docstatus: 1, status: 'To Receive and Bill' })
    expect(store.draftOrders.map((o) => o.name)).toEqual(['MPO-00002'])
    expect(store.openOrders.map((o) => o.name)).toEqual(expect.arrayContaining(['MPO-00001', 'MPO-00003']))
    expect(store.notice).toMatch(/submitted/)

    await store.sendOrder('MPO-00001', 'Phone')
    expect(store.orders.find((o) => o.name === 'MPO-00001')!.sent_method).toBe('Phone')
    expect(store.orderDetail!.sent_method).toBe('Phone')

    await store.closeOrder('MPO-00001', 'vendor cannot supply')
    expect(store.orders.find((o) => o.name === 'MPO-00001')!.status).toBe('Closed')
  })

  it('reloads inbound after a receipt and reports the discrepancies it raised', async () => {
    const store = usePurchasingStore()
    await store.loadInbound()
    expect(store.inbound!.purchase_orders.map((p) => p.name)).toEqual(['MPO-00003'])
    const line = store.inbound!.purchase_orders[0].items.find((l) => l.item_code === 'ZIG-ZAG-1-25')!

    const out = await store.receive('MPO-00003', [{ name: line.name, qty: 190 }], { final: true })
    expect(out!.discrepancies.length).toBeGreaterThan(0)
    expect(store.notice).toMatch(/discrepancy/)
    expect(store.inbound!.discrepancies.length).toBeGreaterThan(1)
    expect(store.error).toBeNull()
  })

  it('loads stock and price requests with their summaries', async () => {
    const store = usePurchasingStore()
    await store.loadStock()
    expect(store.stock).toHaveLength(10)
    expect(store.lowStockCount).toBe(4)
    expect(store.stockSummary).toMatchObject({ warehouse: 'HOU-WH - CCZ', total: 10, low: 4 })

    await store.loadPriceRequests({ status: 'all' })
    expect(store.priceRequests).toHaveLength(2)
    await store.approvePriceChange('PCR-00003', 'Approve')
    expect(store.priceRequests.find((r) => r.name === 'PCR-00003')!.workflow_state).toBe('Approved')
    expect(store.notice).toBe('PCR-00003 approved')
  })

  it('surfaces a server error without throwing, and clears it on demand', async () => {
    const store = usePurchasingStore()
    expect(await store.loadOrder('MPO-99999')).toBeNull()
    expect(store.error).toMatch(/does not exist/)
    expect(store.loading).toBe(false)
    store.clearError()
    expect(store.error).toBeNull()
    store.notice = 'x'
    store.clearNotice()
    expect(store.notice).toBeNull()
  })
})
