/**
 * v1.0 "Procurement" — the Inbound, Stock and section-nav logic (`warehouse/inbound.ts`), the
 * wall's Inbound column (`warehouse/wall.ts`), and the two outcomes the receive sheet has to get
 * right: the moving-average preview it shows before posting, and a receipt that posts nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  OUTBOUND_TABS,
  SECTIONS,
  acceptedQty,
  acceptedUnits,
  atNoon,
  daysToEta,
  effectiveRate,
  etaOf,
  etaStatus,
  filterStock,
  fmtCover,
  isOverridden,
  maPreview,
  matchLine,
  matchScan,
  overdueDays,
  postedQty,
  receiptFreightShare,
  receiveOutcome,
  resolveTab,
  stockGroups,
  stockTotals,
  tabKeyFor,
  varianceLabel,
  varianceTone,
  type CountedLine,
  type OutboundTab,
  type Section,
  receiptFreightForLine
} from '@/warehouse/inbound'
import { INBOUND_CRIT_S, INBOUND_WARN_S, ageTier, inboundCards, inboundTier, overdueSeconds, sortCards, sortInboundCards } from '@/warehouse/wall'
import { freightAllocation, freightShareForLine, freightSharePerUnit, movingAverageAfter } from '@/warehouse/buying'
import { __resetMockPurchasing, mockPurchasing, type PurchaseOrderWithItems, type ReceiveResult, type ReceivedLine, type StockRow } from '@/api/purchasing'
import { usePurchasingStore } from '@/stores/purchasing'
import { fmtDate } from '@/utils/device'
import { setSiteTimeZone } from '@/utils/time'
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

function line(over: Partial<CountedLine> = {}): CountedLine {
  return { pending_qty: 10, received_qty: 0, damaged_qty: 0, po_rate: 4.1, rate: null, ...over }
}

function receivedLine(over: Partial<ReceivedLine> = {}): ReceivedLine {
  return { item_code: 'X', received_qty: 0, posted_qty: 0, accepted_qty: 0, damaged_qty: 0, short_qty: 0, over_qty: 0, rate: 1, po_rate: 1, ...over }
}

function stockRow(over: Partial<StockRow> = {}): StockRow {
  return {
    item_code: 'X',
    item_name: 'X',
    item_group: 'Vape',
    barcode: null,
    image: null,
    actual_qty: 0,
    reserved_qty: 0,
    projected_qty: 0,
    reorder_level: 0,
    low: false,
    valuation_rate: 0,
    stock_value: 0,
    valuation_method: 'Moving Average',
    on_order: 0,
    velocity: 0,
    cover_days: null,
    ...over
  }
}

function po(over: Partial<PurchaseOrderWithItems> & { name: string; supplier: string }): PurchaseOrderWithItems {
  return {
    supplier_name: over.supplier,
    status: 'To Receive and Bill',
    docstatus: 1,
    transaction_date: '2026-08-20',
    schedule_date: null,
    set_warehouse: 'HOU-WH - CCZ',
    per_received: 0,
    currency: 'USD',
    net_total: 0,
    grand_total: 0,
    freight: 0,
    landed_total: 0,
    dropship_store: null,
    source_request: null,
    sent_on: null,
    sent_by: null,
    sent_method: null,
    items: [],
    units: 0,
    ...over
  }
}

function poLine(itemCode: string, qty: number, receivedQty = 0, rate = 1) {
  return {
    name: `POI-${itemCode}`,
    item_code: itemCode,
    item_name: itemCode,
    qty,
    rate,
    amount: qty * rate,
    received_qty: receivedQty,
    pending_qty: Math.max(0, qty - receivedQty),
    warehouse: 'HOU-WH - CCZ',
    barcode: `880000${itemCode}`
  }
}

// =============================================================================================
// §F — the /warehouse section nav: every key the flat v0.6 desk answered to still resolves
// =============================================================================================
describe('the /warehouse section nav', () => {
  it('lands every legacy tab key on the right section', () => {
    // the three boards that were top-level tabs are now Outbound's sub-tabs — and the URL is left
    // alone, because there are bookmarks and e2e specs pointing at these keys
    expect(resolveTab('requests')).toEqual({ section: 'outbound', outbound: 'requests', redirect: null })
    expect(resolveTab('shipments')).toEqual({ section: 'outbound', outbound: 'shipments', redirect: null })
    expect(resolveTab('discrepancies')).toEqual({ section: 'outbound', outbound: 'discrepancies', redirect: null })
    // the stock tab keeps its key and becomes its own section
    expect(resolveTab('stock')).toEqual({ section: 'stock', outbound: 'requests', redirect: null })
    // "Vendor POs" is retired: receiving is Inbound (ordering is Buying), and the URL is rewritten
    expect(resolveTab('vendor')).toEqual({ section: 'inbound', outbound: 'requests', redirect: 'inbound' })
  })

  it('never leaves a legacy key unresolved or pointing at a section that does not exist', () => {
    const known = new Set(SECTIONS.map((s) => s.key))
    for (const legacy of ['requests', 'shipments', 'discrepancies', 'stock', 'vendor']) {
      const out = resolveTab(legacy)
      expect(known.has(out.section)).toBe(true)
      expect(OUTBOUND_TABS.some((t) => t.key === out.outbound)).toBe(true)
      // a redirect must itself resolve, and must not redirect again
      if (out.redirect) expect(resolveTab(out.redirect).redirect).toBeNull()
    }
  })

  it('resolves the five new section keys to themselves', () => {
    for (const s of SECTIONS) expect(resolveTab(s.key)).toEqual({ section: s.key, outbound: 'requests', redirect: null })
  })

  it('defaults to Outbound · Requests, and cleans up an unknown key', () => {
    expect(resolveTab(undefined)).toEqual({ section: 'outbound', outbound: 'requests', redirect: null })
    expect(resolveTab('')).toEqual({ section: 'outbound', outbound: 'requests', redirect: null })
    expect(resolveTab(null)).toEqual({ section: 'outbound', outbound: 'requests', redirect: null })
    expect(resolveTab('nonsense')).toEqual({ section: 'outbound', outbound: 'requests', redirect: 'outbound' })
    // a hand-typed URL should not 404 on its casing
    expect(resolveTab('  Shipments ')).toEqual({ section: 'outbound', outbound: 'shipments', redirect: null })
    expect(resolveTab('VENDOR').section).toBe('inbound')
  })

  it('round-trips through the key the desk writes back to the URL', () => {
    const sections: Section[] = SECTIONS.map((s) => s.key)
    for (const section of sections) {
      const outbound: OutboundTab[] = section === 'outbound' ? OUTBOUND_TABS.map((t) => t.key) : ['requests']
      for (const tab of outbound) {
        const key = tabKeyFor(section, tab)
        const back = resolveTab(key)
        expect(back.redirect).toBeNull()
        expect(back.section).toBe(section)
        if (section === 'outbound') expect(back.outbound).toBe(tab)
      }
    }
    // Outbound writes its sub-tab, so `/warehouse/shipments` still means what it meant in v0.6
    expect(tabKeyFor('outbound', 'shipments')).toBe('shipments')
    expect(tabKeyFor('stock')).toBe('stock')
    expect(tabKeyFor('inbound')).toBe('inbound')
  })
})

// =============================================================================================
// §E — what a counted line will actually book
// =============================================================================================
describe('receive line arithmetic', () => {
  it('never books more than is outstanding, and puts damaged units aside', () => {
    expect(postedQty(line({ received_qty: 4 }))).toBe(4)
    expect(postedQty(line({ received_qty: 10 }))).toBe(10)
    expect(postedQty(line({ received_qty: 12 }))).toBe(10) // the extra 2 are an Over, not stock
    expect(postedQty(line({ received_qty: -3 }))).toBe(0)
    expect(acceptedQty(line({ received_qty: 10, damaged_qty: 3 }))).toBe(7)
    expect(acceptedQty(line({ received_qty: 12, damaged_qty: 2 }))).toBe(8) // 10 postable − 2 damaged
    expect(acceptedQty(line({ received_qty: 4, damaged_qty: 9 }))).toBe(0)
  })

  it('defaults the unit cost to the PO rate and flags a real override', () => {
    expect(effectiveRate(line())).toBe(4.1)
    expect(isOverridden(line())).toBe(false)
    expect(effectiveRate(line({ rate: 4.4 }))).toBe(4.4)
    expect(isOverridden(line({ rate: 4.4 }))).toBe(true)
    // typing the PO rate back in is not an override
    expect(isOverridden(line({ rate: 4.1 }))).toBe(false)
    // a cleared or unparsable box falls back to the order, it never books zero
    expect(effectiveRate({ po_rate: 4.1, rate: null })).toBe(4.1)
    expect(effectiveRate({ po_rate: 4.1, rate: Number.NaN })).toBe(4.1)
  })

  it('shares the receipt freight over the units this delivery actually brings in', () => {
    const lines = [line({ pending_qty: 60, received_qty: 60 }), line({ pending_qty: 50, received_qty: 40 })]
    expect(acceptedUnits(lines)).toBe(100)
    expect(receiptFreightShare(lines, 12)).toBe(0.12)
    // damaged units go to the Damaged warehouse, so they carry no share of the freight
    expect(receiptFreightShare([line({ received_qty: 10, damaged_qty: 2 })], 16)).toBe(2)
    expect(receiptFreightShare(lines, 0)).toBe(0)
    expect(receiptFreightShare([], 40)).toBe(0)
  })
})

// =============================================================================================
// the moving-average preview — the reason the client chose Moving Average
// =============================================================================================
describe('the moving-average preview', () => {
  it('computes "cost moves $4.20 → $4.36" exactly as the sheet does', () => {
    // 100 on hand at 4.20; 100 more at an overridden 4.40 with $12 freight (0.12 a unit)
    const counted = line({ pending_qty: 100, received_qty: 100, po_rate: 4.1, rate: 4.4 })
    const share = receiptFreightShare([counted], 12)
    expect(share).toBe(0.12)

    const preview = maPreview(stockRow({ actual_qty: 100, valuation_rate: 4.2 }), counted, share)!
    expect(preview.before).toBe(4.2)
    expect(preview.after).toBe(4.36)
    expect(preview.after_minus_before).toBe(0.16)
    expect(preview.qty).toBe(100)
    expect(preview.landed).toBe(4.52)
    // and it is the foundation's formula, not a second one
    expect(preview.after).toBe(movingAverageAfter(100, 4.2, 100, 4.4, 0.12))
  })

  it('previews only what will land in stock — damaged units move nothing', () => {
    const counted = line({ pending_qty: 100, received_qty: 100, damaged_qty: 20, po_rate: 5, rate: null })
    const preview = maPreview(stockRow({ actual_qty: 100, valuation_rate: 4 }), counted, 0)!
    expect(preview.qty).toBe(80)
    expect(preview.after).toBe(movingAverageAfter(100, 4, 80, 5, 0))
    expect(preview.after).toBeCloseTo(4.4444, 4)
  })

  it('shows the cheaper vendor pulling the average down', () => {
    const counted = line({ pending_qty: 50, received_qty: 50, po_rate: 8.05 })
    const preview = maPreview(stockRow({ actual_qty: 120, valuation_rate: 8.28 }), counted, 0)!
    expect(preview.after).toBeLessThan(preview.before)
    expect(preview.after_minus_before).toBeLessThan(0)
  })

  it('degrades to nothing rather than guessing', () => {
    // no stock row for the item (never stocked, or the Stock payload has not loaded)
    expect(maPreview(null, line({ received_qty: 10 }), 0)).toBeNull()
    expect(maPreview(undefined, line({ received_qty: 10 }), 0)).toBeNull()
    // nothing counted yet
    expect(maPreview(stockRow({ actual_qty: 10, valuation_rate: 1 }), line(), 0)).toBeNull()
    // everything counted was damaged
    expect(maPreview(stockRow({ actual_qty: 10, valuation_rate: 1 }), line({ received_qty: 4, damaged_qty: 4 }), 0)).toBeNull()
  })

  it('lets the landed cost of the receipt stand when there was nothing on hand', () => {
    const preview = maPreview(stockRow({ actual_qty: 0, valuation_rate: 0 }), line({ pending_qty: 20, received_qty: 20, po_rate: 3 }), 0.25)!
    expect(preview.after).toBe(3.25)
    expect(preview.landed).toBe(3.25)
  })
})

// =============================================================================================
// variance colouring — the thresholds the sheet paints a line with
// =============================================================================================
describe('receive variance colouring', () => {
  it('stays quiet until something is counted, unless `final` will short the whole line', () => {
    expect(varianceTone(line())).toBe('muted')
    expect(varianceLabel(line())).toBe('—')
    // "this is the whole delivery" on an uncounted line means every unit is missing
    expect(varianceTone(line(), true)).toBe('crit')
    expect(varianceLabel(line(), true)).toBe('Short 10')
    // a line with nothing left outstanding is done, not short
    expect(varianceTone(line({ pending_qty: 0 }), true)).toBe('muted')
    expect(varianceLabel(line({ pending_qty: 0 }))).toBe('Complete')
  })

  it('goes green only on an exact, undamaged count', () => {
    expect(varianceTone(line({ received_qty: 10 }))).toBe('good')
    expect(varianceTone(line({ received_qty: 10 }), true)).toBe('good')
    expect(varianceLabel(line({ received_qty: 10 }))).toBe('OK')
  })

  it('treats a short as amber while the delivery is partial and red once it is closed', () => {
    // nothing is raised for a partial receipt — the rest stays on order
    expect(varianceTone(line({ received_qty: 4 }))).toBe('warn')
    expect(varianceLabel(line({ received_qty: 4 }))).toBe('Pending 6')
    // `final` closes the order and raises a Short against the vendor
    expect(varianceTone(line({ received_qty: 4 }), true)).toBe('crit')
    expect(varianceLabel(line({ received_qty: 4 }), true)).toBe('Short 6')
    expect(varianceTone(line({ received_qty: 9.5 }), true)).toBe('crit')
  })

  it('flags an over-receipt and damaged units amber either way', () => {
    expect(varianceTone(line({ received_qty: 12 }))).toBe('warn')
    expect(varianceTone(line({ received_qty: 12 }), true)).toBe('warn')
    expect(varianceLabel(line({ received_qty: 12 }))).toBe('Over 2')
    expect(varianceTone(line({ received_qty: 10, damaged_qty: 2 }))).toBe('warn')
    expect(varianceLabel(line({ received_qty: 10, damaged_qty: 2 }))).toBe('2 damaged')
    // an over beats a damage in the chip: it is the bigger surprise
    expect(varianceLabel(line({ received_qty: 12, damaged_qty: 1 }))).toBe('Over 2')
  })
})

// =============================================================================================
// posting — including the receipt that posts nothing
// =============================================================================================
describe('the outcome of posting a receipt', () => {
  const base: ReceiveResult = {
    purchase_receipt: 'MAT-PRE-2026-00044',
    purchase_order: 'MPO-00003',
    supplier: 'SUP-LONE',
    warehouse: 'HOU-WH - CCZ',
    boutique: null,
    freight: 60,
    final: false,
    lines: [],
    discrepancies: []
  }

  it('names the Purchase Receipt and the units it booked', () => {
    const out = receiveOutcome({ ...base, lines: [receivedLine({ accepted_qty: 180 }), receivedLine({ accepted_qty: 60 })] }, 'Lone Star Wholesale')
    expect(out.posted).toBe(true)
    expect(out.message).toBe('Purchase Receipt MAT-PRE-2026-00044 posted · 240 units into HOU-WH - CCZ')
  })

  it('adds up what was raised alongside a real receipt', () => {
    const out = receiveOutcome(
      {
        ...base,
        final: true,
        lines: [receivedLine({ accepted_qty: 180, short_qty: 20 }), receivedLine({ item_code: 'Y', accepted_qty: 0, short_qty: 60 })],
        discrepancies: ['RDC-00008', 'RDC-00009']
      },
      'Lone Star Wholesale'
    )
    expect(out.posted).toBe(true)
    expect(out.message).toBe('Purchase Receipt MAT-PRE-2026-00044 posted · 180 units into HOU-WH - CCZ · 2 discrepancies raised (2 short)')
  })

  it('says plainly when a `final` receipt posted nothing at all', () => {
    // the foundation returns `purchase_receipt: null` here — a success toast naming a receipt that
    // does not exist is how a warehouse stops trusting the screen
    const out = receiveOutcome(
      {
        ...base,
        purchase_receipt: null,
        final: true,
        lines: [receivedLine({ short_qty: 60 }), receivedLine({ item_code: 'Y', short_qty: 200 })],
        discrepancies: ['RDC-00008', 'RDC-00009']
      },
      'Lone Star Wholesale'
    )
    expect(out.posted).toBe(false)
    expect(out.message).toBe('Nothing was posted — 2 short lines were raised against Lone Star Wholesale')
    expect(out.message).not.toMatch(/null|undefined|NaN/)
  })

  it('reads properly for a single short line, and falls back to the vendor code', () => {
    const one = receiveOutcome({ ...base, purchase_receipt: null, final: true, lines: [receivedLine({ short_qty: 12 })], discrepancies: ['RDC-1'] })
    expect(one.message).toBe('Nothing was posted — 1 short line was raised against SUP-LONE')
  })

  it('still says something useful when nothing was countable and nothing was raised', () => {
    const none = receiveOutcome({ ...base, purchase_receipt: null, lines: [], discrepancies: [] }, 'Lone Star Wholesale')
    expect(none.posted).toBe(false)
    expect(none.message).toBe('Nothing was posted — nothing on MPO-00003 could be booked')
  })
})

describe('posting against the buying desk', () => {
  beforeEach(() => {
    __resetMockPurchasing()
    setActivePinia(createPinia())
    useWarehouseStore().me = { ...ME }
  })

  it('turns a whole-delivery receipt that brought nothing into an honest message', async () => {
    const store = usePurchasingStore()
    await store.loadInbound()
    const order = store.inbound!.expected.find((o) => o.name === 'MPO-00003')!
    expect(order.items.length).toBeGreaterThan(0)

    // "this is the whole delivery", nothing counted: every line shorts and no stock is posted
    const out = await store.receive('MPO-00003', [], { final: true })
    expect(out).not.toBeNull()
    expect(out!.purchase_receipt).toBeNull()
    expect(out!.discrepancies.length).toBe(3)

    const outcome = receiveOutcome(out!, order.supplier_name)
    expect(outcome.posted).toBe(false)
    // and, because the manager said this was the whole delivery, the order stops expecting more
    expect(outcome.message).toBe('Nothing was posted — 3 short lines were raised against Lone Star Wholesale · MPO-00003 is closed')
  })

  it('previews the move the receipt then actually makes', async () => {
    const store = usePurchasingStore()
    await store.loadInbound()
    await store.loadStock()
    const order = store.inbound!.expected.find((o) => o.name === 'MPO-00003')!
    const zig = order.items.find((l) => l.item_code === 'ZIG-ZAG-1-25')!
    const before = store.stock.find((r) => r.item_code === 'ZIG-ZAG-1-25')!

    const counted: CountedLine = { pending_qty: zig.pending_qty, received_qty: 180, damaged_qty: 0, po_rate: zig.rate, rate: 0.95 }
    const share = receiptFreightShare([counted], 0)
    const preview = maPreview(before, counted, share)!
    expect(preview.before).toBe(before.valuation_rate)
    expect(preview.landed).toBe(0.95)

    const out = await store.receive('MPO-00003', [{ name: zig.name, item_code: zig.item_code, qty: 180, rate: 0.95 }], { freight: 0 })
    expect(out!.purchase_receipt).toMatch(/^MAT-PRE/)

    await store.loadStock()
    const after = store.stock.find((r) => r.item_code === 'ZIG-ZAG-1-25')!
    // what the sheet promised is what the receipt did: 410 @ 0.90 + 180 @ 0.95
    expect(after.valuation_rate).toBe(preview.after)
    expect(after.valuation_rate).toBeGreaterThan(before.valuation_rate)
    expect(after.actual_qty).toBe(590)
  })

  it('spreads freight over the units on the receipt, the way the Purchase Receipt will', async () => {
    // `receive()` stamps the freight on the Purchase Receipt, where ERPNext distributes an Actual
    // valuation charge over *that receipt's* lines — not over everything the order once promised.
    const store = usePurchasingStore()
    await store.loadInbound()
    const order = store.inbound!.expected.find((o) => o.name === 'MPO-00003')!
    const counted = order.items.map((l) => ({ pending_qty: l.pending_qty, received_qty: l.pending_qty, damaged_qty: 0, po_rate: l.rate, rate: null }))
    expect(acceptedUnits(counted)).toBe(284)
    expect(receiptFreightShare(counted, 60)).toBeCloseTo(60 / 284, 4)
    // a half delivery carries the whole freight bill over half the units
    const half = [counted[1]]
    expect(receiptFreightShare(half, 60)).toBeCloseTo(60 / 200, 4)
  })
})

// =============================================================================================
// scanning
// =============================================================================================
describe('scanning an expected delivery', () => {
  const lonestar = po({
    name: 'MPO-00003',
    supplier: 'SUP-LONE',
    items: [poLine('LM-MO20K-WM', 60), poLine('ZIG-ZAG-1-25', 200)]
  })
  const gulf = po({ name: 'MPO-00009', supplier: 'SUP-GULF', items: [poLine('ZIG-ZAG-1-25', 50), poLine('OCB-XPERT-KS', 100)] })

  it('matches on barcode, item code and a barcode suffix', () => {
    expect(matchLine(lonestar.items, '880000ZIG-ZAG-1-25')).toBe(1)
    expect(matchLine(lonestar.items, 'LM-MO20K-WM')).toBe(0)
    expect(matchLine(lonestar.items, 'lm-mo20k-wm')).toBe(0)
    expect(matchLine(lonestar.items, 'ZIG-ZAG-1-25')).toBe(1)
    expect(matchLine(lonestar.items, 'NOPE-1')).toBe(-1)
    expect(matchLine(lonestar.items, '')).toBe(-1)
  })

  it('opens a delivery only when the scan belongs to exactly one of them', () => {
    expect(matchScan([lonestar, gulf], 'LM-MO20K-WM').map((h) => h.order.name)).toEqual(['MPO-00003'])
    // the same item from two vendors is normal here — the board must ask, not guess
    expect(matchScan([lonestar, gulf], 'ZIG-ZAG-1-25').map((h) => h.order.name)).toEqual(['MPO-00003', 'MPO-00009'])
    expect(matchScan([lonestar, gulf], 'NOT-STOCKED')).toEqual([])
  })
})

// =============================================================================================
// expected dates
// =============================================================================================
describe('expected dates', () => {
  it('uses the promised date, else the vendor lead time', () => {
    expect(etaOf({ schedule_date: '2026-08-27', supplier: 'SUP-LONE' }, { 'SUP-LONE': 3 }, '2026-08-24')).toBe('2026-08-27')
    expect(etaOf({ schedule_date: null, supplier: 'SUP-LONE' }, { 'SUP-LONE': 3 }, '2026-08-24')).toBe('2026-08-27')
    // no lead time on file → the foundation's 7-day fallback
    expect(etaOf({ schedule_date: null, supplier: 'SUP-NEW' }, {}, '2026-08-24')).toBe('2026-08-31')
  })

  it('counts the days to an ETA in both directions', () => {
    expect(daysToEta('2026-08-27', '2026-08-24')).toBe(3)
    expect(daysToEta('2026-08-24', '2026-08-24')).toBe(0)
    expect(daysToEta('2026-08-20', '2026-08-24')).toBe(-4)
    expect(overdueDays('2026-08-20', '2026-08-24')).toBe(4)
    expect(overdueDays('2026-08-27', '2026-08-24')).toBe(0)
    expect(overdueDays('', '2026-08-24')).toBe(0)
  })

  it('renders a bare ETA on the day the vendor promised, in any site zone', () => {
    // v0.6 R / v0.8 W-D2 again: `new Date('2026-08-27')` is UTC midnight, so a Chicago screen
    // renders it as Aug 26. `atNoon` pins the date so `parseServer` reads it as site-zone wall time.
    setSiteTimeZone('America/Chicago')
    expect(fmtDate(atNoon('2026-08-27'))).toBe('Aug 27, 2026')
    setSiteTimeZone('Pacific/Auckland')
    expect(fmtDate(atNoon('2026-08-27'))).toBe('Aug 27, 2026')
    setSiteTimeZone(null)
    expect(atNoon('2026-08-27')).toBe('2026-08-27T12:00:00')
    // anything that is not a date renders as the formatters' em dash
    expect(atNoon(null)).toBeNull()
    expect(atNoon('')).toBeNull()
    expect(atNoon('not a date')).toBeNull()
    expect(fmtDate(atNoon(null))).toBe('—')
  })

  it('labels the chip the way the floor reads it', () => {
    expect(etaStatus('2026-08-24', '2026-08-24')).toMatchObject({ text: 'Due today', tone: 'accent', late: false })
    expect(etaStatus('2026-08-25', '2026-08-24')).toMatchObject({ text: 'Due tomorrow', late: false })
    expect(etaStatus('2026-08-29', '2026-08-24')).toMatchObject({ text: 'In 5 d', tone: 'muted' })
    expect(etaStatus('2026-08-23', '2026-08-24')).toMatchObject({ text: '1 d late', tone: 'warn', late: true })
    expect(etaStatus('2026-08-20', '2026-08-24')).toMatchObject({ text: '4 d late', tone: 'crit', late: true })
  })
})

// =============================================================================================
// §F — the wall's Inbound column
// =============================================================================================
describe("the wall's Inbound column", () => {
  const orders = [
    po({ name: 'MPO-A', supplier: 'SUP-GULF', schedule_date: '2026-08-19', items: [poLine('A', 100, 40)], units: 100, per_received: 40 }),
    po({ name: 'MPO-B', supplier: 'SUP-LONE', schedule_date: '2026-08-23', items: [poLine('B', 60), poLine('C', 20)], units: 80 }),
    po({ name: 'MPO-C', supplier: 'SUP-BAYOU', schedule_date: '2026-08-24', items: [poLine('D', 30)], units: 30 }),
    po({ name: 'MPO-D', supplier: 'SUP-SOONER', schedule_date: '2026-08-28', items: [poLine('E', 12)], units: 12 }),
    po({ name: 'MPO-E', supplier: 'SUP-PANH', schedule_date: null, items: [poLine('F', 5)], units: 5 })
  ]
  const cards = inboundCards(orders, { today: '2026-08-24', leadTimes: { 'SUP-PANH': 2 }, warehouse: 'HOU-WH - CCZ' })

  it('puts the most overdue delivery on top, then the soonest ETA', () => {
    expect(cards.map((c) => c.name)).toEqual(['MPO-A', 'MPO-B', 'MPO-C', 'MPO-E', 'MPO-D'])
    expect(cards[0].overdue_days).toBe(5)
    expect(cards[1].overdue_days).toBe(1)
    expect(cards[2].overdue_days).toBe(0)
    // no promised date → today + the vendor's lead time
    expect(cards.find((c) => c.name === 'MPO-E')!.eta).toBe('2026-08-26')
  })

  it('tiers a delivery on how late it is, through the shared ageTier', () => {
    expect(inboundTier(cards.find((c) => c.name === 'MPO-A')!)).toBe('crit') // 5 days late
    expect(inboundTier(cards.find((c) => c.name === 'MPO-B')!)).toBe('warn') // 1 day late
    expect(inboundTier(cards.find((c) => c.name === 'MPO-C')!)).toBe('ok') // due today
    expect(inboundTier(cards.find((c) => c.name === 'MPO-D')!)).toBe('ok') // not due yet
    // the boundaries, stated against the same helper the other columns use
    expect(ageTier(INBOUND_WARN_S - 1, INBOUND_WARN_S, INBOUND_CRIT_S)).toBe('ok')
    expect(ageTier(INBOUND_WARN_S, INBOUND_WARN_S, INBOUND_CRIT_S)).toBe('warn')
    expect(ageTier(INBOUND_CRIT_S - 1, INBOUND_WARN_S, INBOUND_CRIT_S)).toBe('warn')
    expect(ageTier(INBOUND_CRIT_S, INBOUND_WARN_S, INBOUND_CRIT_S)).toBe('crit')
    expect(overdueSeconds('2026-08-21', '2026-08-24')).toBe(3 * 86400)
    expect(overdueSeconds('2026-08-30', '2026-08-24')).toBe(0)
  })

  it('counts what is still outstanding, not what was ordered', () => {
    const a = cards.find((c) => c.name === 'MPO-A')!
    expect(a.units).toBe(60) // 100 ordered, 40 already in
    expect(a.units_ordered).toBe(100)
    expect(a.per_received).toBe(40)
    expect(cards.find((c) => c.name === 'MPO-B')!.items).toBe(2)
  })

  it('is a card the shared wall helpers understand', () => {
    // `sortCards` reads priority then age, so the union member has to carry both
    expect(sortCards(cards).map((c) => c.name)).toEqual(cards.map((c) => c.name))
    expect(sortInboundCards(cards).map((c) => c.name)).toEqual(cards.map((c) => c.name))
    expect(cards.every((c) => c.kind === 'inbound' && typeof c.name === 'string' && typeof c.boutique === 'string')).toBe(true)
    // a drop-ship order shows the store it is going to, not the warehouse
    const drop = inboundCards([po({ name: 'MPO-F', supplier: 'SUP-BAYOU', dropship_store: 'OK-BIX', schedule_date: '2026-09-03', items: [poLine('G', 24)] })], {
      today: '2026-08-24',
      warehouse: 'HOU-WH - CCZ'
    })
    expect(drop[0].boutique).toBe('OK-BIX')
    expect(drop[0].dropship_store).toBe('OK-BIX')
  })

  it('handles an empty board', () => {
    expect(inboundCards([], { today: '2026-08-24' })).toEqual([])
    expect(sortInboundCards([])).toEqual([])
  })
})

// =============================================================================================
// §F — Stock
// =============================================================================================
describe('the Stock board', () => {
  it('never shows Infinity or NaN days of cover', () => {
    // the server sends `null` for an item that does not move
    expect(fmtCover(null)).toBe('—')
    expect(fmtCover(undefined)).toBe('—')
    expect(fmtCover(Number.POSITIVE_INFINITY)).toBe('—')
    expect(fmtCover(Number.NaN)).toBe('—')
    expect(fmtCover(-3)).toBe('—')
    expect(fmtCover(0)).toBe('0 d')
    expect(fmtCover(8)).toBe('8 d')
    expect(fmtCover(12.44)).toBe('12.4 d')
  })

  it('renders a zero-velocity row as a dash, straight off the stock payload', async () => {
    __resetMockPurchasing()
    const { rows } = await mockPurchasing.stock()
    const still = rows.find((r) => r.velocity === 0)!
    expect(still.item_code).toBe('CLIPPER-LTR-ASST')
    expect(still.cover_days).toBeNull()
    expect(fmtCover(still.cover_days)).toBe('—')
    // and every other row renders a real number
    for (const row of rows) expect(fmtCover(row.cover_days)).not.toMatch(/Infinity|NaN/)
    const moving = rows.find((r) => r.item_code === 'RAW-KS-SLIM')!
    expect(fmtCover(moving.cover_days)).toBe('52.3 d')
  })

  it('sums the strip from the rows in hand, so the table and the summary agree', () => {
    const rows = [
      stockRow({ item_code: 'A', item_group: 'Vape', actual_qty: 36, stock_value: 336.24, on_order: 24, low: true }),
      stockRow({ item_code: 'B', item_group: 'Papers', actual_qty: 340, stock_value: 411.4, on_order: 0 }),
      stockRow({ item_code: 'C', item_group: 'Vape', actual_qty: 8, stock_value: 63.2, on_order: 6, low: true })
    ]
    expect(stockTotals(rows)).toEqual({ items: 3, units: 384, value: 810.84, low: 2, on_order: 30 })
    expect(stockTotals([])).toEqual({ items: 0, units: 0, value: 0, low: 0, on_order: 0 })
    expect(stockGroups(rows)).toEqual(['Papers', 'Vape'])
  })

  it('filters by group and low-stock, low first', () => {
    const rows = [
      stockRow({ item_code: 'B', item_group: 'Papers', low: false }),
      stockRow({ item_code: 'A', item_group: 'Vape', low: true }),
      stockRow({ item_code: 'C', item_group: 'Vape', low: false })
    ]
    expect(filterStock(rows).map((r) => r.item_code)).toEqual(['A', 'B', 'C'])
    expect(filterStock(rows, { lowOnly: true }).map((r) => r.item_code)).toEqual(['A'])
    expect(filterStock(rows, { group: 'Vape' }).map((r) => r.item_code)).toEqual(['A', 'C'])
    expect(filterStock(rows, { group: 'Papers', lowOnly: true })).toEqual([])
    // the source array is left alone
    expect(rows.map((r) => r.item_code)).toEqual(['B', 'A', 'C'])
  })
})

/**
 * v1.0 — the four defects the `e2e/purchasing.e2e.mjs` run exposed, pinned so they cannot come back.
 */
describe('v1.0 e2e defects', () => {
  it('allocates freight by line amount, the way ERPNext distributes an Actual + Valuation charge', () => {
    // The receipt the e2e drove: 12 @ $6.05 and 4 @ $73.50, $45 freight.
    const lines = [
      { qty: 12, rate: 6.05 },
      { qty: 4, rate: 73.5 }
    ]
    const alloc = freightAllocation(lines, 45)
    // 45 × 72.60/366.60 and 45 × 294.00/366.60 — by amount, not evenly per unit
    expect(alloc[0]).toBeCloseTo(8.9116, 3)
    expect(alloc[1]).toBeCloseTo(36.0884, 3)
    expect(alloc[0] + alloc[1]).toBeCloseTo(45, 6)
    // per unit of each line
    expect(freightShareForLine(lines, 45, 0)).toBeCloseTo(0.7426, 3)
    expect(freightShareForLine(lines, 45, 1)).toBeCloseTo(9.0221, 3)
    // the flat per-unit headline is a different, blunter number — 45/16
    expect(freightSharePerUnit(lines, 45)).toBeCloseTo(2.8125, 4)
  })

  it('previews the moving average the server will actually post', () => {
    // 50 on hand @ $5.50; receive 12 @ an overridden $6.05 alongside 4 @ $73.50, freight $45.
    const counted = [
      { name: 'a', item_code: 'HKA-015', qty: 12, received_qty: 12, pending_qty: 12, damaged_qty: 0, rate: 6.05, po_rate: 5.5 },
      { name: 'b', item_code: 'HKA-003', qty: 4, received_qty: 4, pending_qty: 4, damaged_qty: 0, rate: 73.5, po_rate: 70 }
    ]
    const share = receiptFreightForLine(counted, 45, 0)
    const preview = maPreview({ actual_qty: 50, valuation_rate: 5.5 }, counted[0], share)!
    expect(preview.after).toBeCloseTo(5.7502, 3) // what the bench booked
    // the old evenly-per-unit share was ~7% out — that is the bug this pins
    const evenly = maPreview({ actual_qty: 50, valuation_rate: 5.5 }, counted[0], receiptFreightShare(counted, 45))!
    expect(Math.abs(evenly.after - 5.7502)).toBeGreaterThan(0.2)
  })

  it('splits freight per unit when every line amount is zero', () => {
    expect(freightAllocation([{ qty: 2, rate: 0 }, { qty: 6, rate: 0 }], 40)).toEqual([10, 30])
    expect(freightAllocation([], 40)).toEqual([])
    expect(freightAllocation([{ qty: 5, rate: 1 }], 0)).toEqual([0])
  })
})
