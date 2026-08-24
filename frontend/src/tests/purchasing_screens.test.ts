/**
 * v1.0 "Procurement" — the **Buying** and **Vendors** screens.
 *
 * The repo has no component-mounting stack (`@vue/test-utils` is not a dependency), so each screen
 * exports the pure part a reviewer would otherwise have to read the template to check: the line a
 * suggestion row renders, the cost delta beside an alternative vendor, the copy on the "Create
 * orders" button, the freight/landed figures the order sheet prints, and the read-only gate. Those
 * are tested here directly, together with the store interaction behind them (against the
 * deterministic in-memory buying desk).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { __resetMockPurchasing, mockPurchasing, type PurchaseOrderDetail, type PurchaseOrderRow, type Suggestion, type Vendor, type VendorCatalogueRow } from '@/api/purchasing'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import type { WarehouseMe } from '@/api/warehouse'
import { setSiteTimeZone } from '@/utils/time'
import { fmtDate } from '@/utils/device'
import { costDelta, coverTone, deltaLabel, displayLine, packNote } from '@/warehouse/components/purchasing/BuySuggestRow.vue'
import { ORDER_STATUSES, coverRank, createdNotice, dayStamp, matchesSuggestion, planCopy, unitsOf } from '@/warehouse/components/purchasing/BuyingBoard.vue'
import { freightView, readOnlyReason } from '@/warehouse/components/purchasing/OrderSheet.vue'
import { money, onTimeTone, pct, sortVendors, stat } from '@/warehouse/components/purchasing/VendorsBoard.vue'
import { draftOf, rowDirty } from '@/warehouse/components/purchasing/VendorSheet.vue'
import BuyingBoard from '@/warehouse/components/purchasing/BuyingBoard.vue'
import OrderSheet from '@/warehouse/components/purchasing/OrderSheet.vue'
import VendorsBoard from '@/warehouse/components/purchasing/VendorsBoard.vue'
import VendorSheet from '@/warehouse/components/purchasing/VendorSheet.vue'

// the screens talk to `purchasingApi` through the store; point it at the seeded buying desk
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
  __resetMockPurchasing()
  setActivePinia(createPinia())
  useWarehouseStore().me = { ...ME }
  return usePurchasingStore()
}

// =============================================================================================
// BuySuggestRow — what the row shows, and what a vendor swap does to it
// =============================================================================================
describe('suggestion row', () => {
  let rows: Suggestion[]
  beforeEach(async () => {
    __resetMockPurchasing()
    rows = (await mockPurchasing.suggestions(true)).suggestions
  })
  const bySku = (code: string) => rows.find((s) => s.item_code === code)!

  it('renders the preferred vendor and the suggested quantity when nothing has been touched', () => {
    expect(displayLine(bySku('GB-PULSE-15K-BLUE'), null)).toMatchObject({
      supplier: 'SUP-GULF',
      qty: 60,
      rate: 9.25,
      case_pack: 12,
      moq: 24,
      vendor_sku: 'GC-GBP15-BRI'
    })
  })

  it('shows the quantity the buyer typed over the suggested one', () => {
    expect(displayLine(bySku('HYDE-EDGE-4K-GRAPE'), { qty: 30 }).qty).toBe(30)
    expect(displayLine(bySku('HYDE-EDGE-4K-GRAPE'), { qty: 0 }).qty).toBe(0)
  })

  it('re-rounds to the new vendor case pack when the row is swapped, dropping the typed quantity', () => {
    const store = desk()
    store.suggestions = rows
    const code = 'HYDE-EDGE-4K-GRAPE'
    // the buyer types 30 against Lone Star's sixes
    store.setQty(code, 30)
    expect(displayLine(bySku(code), store.selection[code]).qty).toBe(30)

    // …then switches to Sooner, who sell in fives with no minimum: the 30 was entered against the
    // old case pack, so the store drops it and the row falls back to 16 → 4 × 5
    store.setSupplier(code, 'SUP-SOONER')
    expect(store.selection[code]).toEqual({ supplier: 'SUP-SOONER' })
    const after = displayLine(bySku(code), store.selection[code])
    expect(after).toMatchObject({ supplier: 'SUP-SOONER', qty: 20, rate: 8.2, case_pack: 5, moq: 0, lead_time_days: 7 })
    // and the row agrees with what the store will actually order
    expect(store.selectedLines.find((l) => l.item_code === code)).toMatchObject({ supplier: 'SUP-SOONER', qty: 20 })
  })

  it("honours the alternative vendor's MOQ on a swap", () => {
    const store = desk()
    store.suggestions = rows
    // Bayou is cheaper (0.98 vs 1.05) but sells hundreds with a 200 minimum
    store.setSupplier('OCB-XPERT-KS', 'SUP-BAYOU')
    expect(displayLine(bySku('OCB-XPERT-KS'), store.selection['OCB-XPERT-KS'])).toMatchObject({ supplier: 'SUP-BAYOU', qty: 200, rate: 0.98 })
  })

  it('prices an alternative against the preferred vendor', () => {
    const gb = bySku('GB-PULSE-15K-BLUE')
    const preferred = gb.vendors.find((v) => v.is_preferred)!.cost
    const lone = gb.vendors.find((v) => v.supplier === 'SUP-LONE')!.cost
    expect(costDelta(lone, preferred)).toBe(0.35)
    expect(deltaLabel(costDelta(lone, preferred))).toBe('+$0.35 / unit')

    const ocb = bySku('OCB-XPERT-KS')
    const cheaper = costDelta(ocb.vendors.find((v) => v.supplier === 'SUP-BAYOU')!.cost, ocb.vendors.find((v) => v.is_preferred)!.cost)
    expect(cheaper).toBe(-0.07)
    expect(deltaLabel(cheaper)).toBe('−$0.07 / unit')
    expect(deltaLabel(costDelta(9.25, 9.25))).toBe('same cost')
  })

  it('says which case pack and minimum the quantity obeys', () => {
    expect(packNote(12, 24)).toBe('12 per case · MOQ 24')
    expect(packNote(10, 0)).toBe('10 per case')
    expect(packNote(1, 0)).toBe('single units')
    expect(packNote(0, 0)).toBe('single units')
  })

  it('tones cover days by urgency, and never dresses up an empty shelf', () => {
    expect(coverTone(4.4, 8)).toBe('crit')
    expect(coverTone(13.9, 64)).toBe('warn')
    expect(coverTone(40.9, 90)).toBe('muted')
    expect(coverTone(0, 0)).toBe('crit')
    expect(coverTone(0, 288)).toBe('muted')
  })
})

// =============================================================================================
// BuyingBoard — the plan footer, the filters, the sort and the order list
// =============================================================================================
describe('buying board', () => {
  it('counts orders and vendors on the create button, not lines', () => {
    expect(planCopy({ orders: 3, vendors: 2 })).toBe('Create 3 orders across 2 vendors')
    expect(planCopy({ orders: 1, vendors: 1 })).toBe('Create 1 order across 1 vendor')
    expect(planCopy({ orders: 0, vendors: 0 })).toBe('Nothing selected')
  })

  it('names what was created', () => {
    expect(createdNotice(['MPO-00004'])).toBe('Draft order MPO-00004 created')
    expect(createdNotice(['MPO-00004', 'MPO-00005'])).toBe('2 draft orders created — MPO-00004, MPO-00005')
    expect(createdNotice([])).toBe('No orders were created')
  })

  it('puts the lowest cover first, an empty shelf above everything and a non-mover last', async () => {
    __resetMockPurchasing()
    const rows = (await mockPurchasing.suggestions(true)).suggestions
    const order = [...rows].sort((a, b) => coverRank(a) - coverRank(b)).map((s) => s.item_code)
    expect(order).toEqual(['HYDE-EDGE-4K-GRAPE', 'GB-PULSE-15K-BLUE', 'PUFF-XXL-MINT', 'AF-SHISHA-250-MINT', 'OCB-XPERT-KS'])
    expect(coverRank({ cover_days: 0, on_hand: 0 })).toBe(0)
    expect(coverRank({ cover_days: 0, on_hand: 288 })).toBe(Number.POSITIVE_INFINITY)
  })

  it('filters by source, group and search', async () => {
    __resetMockPurchasing()
    const rows = (await mockPurchasing.suggestions(true)).suggestions
    const keep = (f: Parameters<typeof matchesSuggestion>[1]) => rows.filter((s) => matchesSuggestion(s, f)).map((s) => s.item_code)

    expect(keep({ source: 'all' })).toHaveLength(5)
    // the badge shows the most urgent source, but a row asked for by a store still answers that chip
    expect(keep({ source: 'Store demand' })).toEqual(['HYDE-EDGE-4K-GRAPE', 'AF-SHISHA-250-MINT'])
    expect(keep({ source: 'Trending' })).toEqual(['PUFF-XXL-MINT'])
    expect(keep({ group: 'Papers' })).toEqual(['OCB-XPERT-KS'])
    expect(keep({ q: 'geek' })).toEqual(['GB-PULSE-15K-BLUE'])
    expect(keep({ q: 'gulf coast' })).toEqual(['GB-PULSE-15K-BLUE', 'OCB-XPERT-KS'])
    expect(keep({ q: 'nothing here' })).toEqual([])
  })

  it('offers every status a buyer works, "all" included', () => {
    expect([...ORDER_STATUSES]).toEqual(['Draft', 'Open', 'To Receive', 'Completed', 'Closed', 'all'])
  })

  it('prints the units the order list carries, and an em dash for a row without them', async () => {
    __resetMockPurchasing()
    const row = (await mockPurchasing.orders({ status: 'all' })).orders[0]
    // the list is still the cheap serialisation — no lines — but it does count them now
    expect(row).not.toHaveProperty('items')
    expect(unitsOf(row)).toBe(124)
    // a row that arrives without the count still renders, as an em dash rather than a wrong number
    const older: Partial<PurchaseOrderRow> = { ...row }
    delete older.units
    expect(unitsOf(older as PurchaseOrderRow)).toBeNull()
  })

  it('reads a date as site-zone wall time — never the browser zone (the v0.8 bug)', () => {
    setSiteTimeZone('America/Chicago')
    expect(dayStamp('2026-08-24')).toBe('2026-08-24')
    expect(dayStamp('2026-08-20 14:05:00')).toBe('2026-08-20 14:05:00')
    expect(dayStamp(null)).toBe('')
    // an order dated the 24th must never render as the 23rd west of UTC
    expect(fmtDate(dayStamp('2026-08-24'))).toBe('Aug 24, 2026')
    setSiteTimeZone(null)
  })
})

// =============================================================================================
// OrderSheet — freight, the landed total and the read-only gate
// =============================================================================================
describe('order sheet', () => {
  it('spreads manual freight over every unit and lands it on the total', async () => {
    __resetMockPurchasing()
    const po = await mockPurchasing.order('MPO-00003')
    const view = freightView(po.items, po.freight)
    // 60 × 11.40 + 200 × 0.89 + 24 × 9.60
    expect(view).toEqual({ units: 284, net: 1092.4, freight: 60, perUnit: 0.2113, landed: 1152.4 })
  })

  it('drops the freight share when the charge is removed', async () => {
    __resetMockPurchasing()
    const po = await mockPurchasing.order('MPO-00003')
    expect(freightView(po.items, 0)).toMatchObject({ perUnit: 0, landed: 1092.4 })
    expect(freightView([], 40)).toMatchObject({ units: 0, net: 0, perUnit: 0, landed: 40 })
  })

  it('shows the same landed total the server saved', async () => {
    const store = desk()
    const saved = await store.updateOrder('MPO-00001', [{ item_code: 'GB-PULSE-15K-BLUE', qty: 84, rate: 9.25 }, { item_code: 'OCB-XPERT-KS', qty: 100, rate: 1.05 }], 40)
    expect(saved).not.toBeNull()
    const view = freightView(saved!.items, saved!.freight)
    expect(view.net).toBe(saved!.net_total)
    expect(view.landed).toBe(saved!.landed_total)
    expect(view.landed).toBe(922)
  })

  it('locks every input once the order is no longer editable, and says why', async () => {
    const store = desk()
    const draft = await store.loadOrder('MPO-00001')
    expect(draft!.can_edit).toBe(true)
    expect(readOnlyReason(draft!)).toBe('')

    const submitted = await store.submitOrder('MPO-00001')
    expect(submitted!.can_edit).toBe(false)
    expect(readOnlyReason(submitted!)).toMatch(/submitted/)

    const closed = await store.closeOrder('MPO-00001', 'vendor cannot supply')
    expect(readOnlyReason(closed!)).toMatch(/closed/)
  })

  it('separates "the document is finished" from "you may not buy"', () => {
    const shell = (over: Partial<PurchaseOrderDetail>) => ({ can_edit: false, docstatus: 0, status: 'Draft', ...over } as PurchaseOrderDetail)
    expect(readOnlyReason(shell({}))).toMatch(/centralised in Houston/)
    expect(readOnlyReason(shell({ docstatus: 2, status: 'Cancelled' }))).toMatch(/cancelled/)
    expect(readOnlyReason(shell({ can_edit: true }))).toBe('')
    expect(readOnlyReason(null)).toBe('')
  })
})

// =============================================================================================
// Vendors — optional statistics, ordering, and the catalogue drafts
// =============================================================================================
describe('vendors board', () => {
  it('renders a missing statistic as an em dash, never a zero and never NaN', () => {
    expect(stat(undefined)).toBe('—')
    expect(stat(null)).toBe('—')
    expect(stat(Number.NaN)).toBe('—')
    expect(stat(0)).toBe('0')
    expect(stat(87.5, pct)).toBe('87.5%')
    expect(stat(39860.75, money)).toBe('$39,860.75')
    expect(stat(undefined, money)).toBe('—')
  })

  it('flags a vendor that does not deliver on time', () => {
    expect(onTimeTone(95.8)).toBe('good')
    expect(onTimeTone(80)).toBe('warn')
    expect(onTimeTone(66.7)).toBe('crit')
    expect(onTimeTone(null)).toBe('dim')
    expect(onTimeTone(undefined)).toBe('dim')
  })

  it('sorts by twelve-month spend, and does not float a vendor with no history to the top', async () => {
    __resetMockPurchasing()
    const { vendors } = await mockPurchasing.vendors(undefined, false)
    expect(sortVendors(vendors).map((v) => v.name)).toEqual(['SUP-LONE', 'SUP-GULF', 'SUP-BAYOU', 'SUP-SOONER', 'SUP-PANH'])
    const fresh = { name: 'SUP-NEW', supplier_name: 'Red River Imports' } as Vendor
    expect(sortVendors([fresh, ...vendors]).map((v) => v.name).pop()).toBe('SUP-NEW')
  })

  it('tracks an edited catalogue row so only a changed one offers to save', async () => {
    __resetMockPurchasing()
    const row: VendorCatalogueRow = (await mockPurchasing.vendor('SUP-GULF')).catalogue[0]
    const draft = draftOf(row)
    expect(rowDirty(row, draft)).toBe(false)
    expect(rowDirty(row, { ...draft, cost: draft.cost + 0.1 })).toBe(true)
    expect(rowDirty(row, { ...draft, vendor_sku: 'CHANGED' })).toBe(true)
    expect(rowDirty(row, null)).toBe(false)
  })
})

// =============================================================================================
// The screens against the desk — selection → orders
// =============================================================================================
describe('buying a list', () => {
  it('groups the selection into one draft order per vendor and names them', async () => {
    const store = desk()
    await store.loadSuggestions()
    store.select('GB-PULSE-15K-BLUE') // Gulf Coast
    store.select('OCB-XPERT-KS') // Gulf Coast too — one order, not two
    expect(planCopy(store.plan)).toBe('Create 1 order across 1 vendor')

    store.select('AF-SHISHA-250-MINT') // Bayou
    expect(planCopy(store.plan)).toBe('Create 2 orders across 2 vendors')
    expect(store.plan.units).toBe(184)

    const out = await store.createOrders()
    expect(out!.count).toBe(2)
    expect(createdNotice(out!.orders)).toMatch(/^2 draft orders created — MPO-/)
    // the ordered rows leave the buying list and the basket empties
    expect(store.openSuggestions.map((s) => s.item_code)).toEqual(['HYDE-EDGE-4K-GRAPE', 'PUFF-XXL-MINT'])
    expect(store.selectedCount).toBe(0)
  })

  it('sends a whole order to a store when the buyer chooses a drop-ship destination', async () => {
    const store = desk()
    await store.loadSuggestions()
    store.select('AF-SHISHA-250-MINT')
    const lines = store.selectedLines.map((l) => ({ item_code: l.item_code, qty: l.qty, supplier: l.supplier, rate: l.rate, suggestion: l.suggestion ?? null, dropship_store: 'OK-BIX' }))
    const out = await store.createOrders(lines)
    expect(out!.created[0]).toMatchObject({ supplier: 'SUP-BAYOU', dropship_store: 'OK-BIX', units: 24 })
    const po = await store.loadOrder(out!.orders[0])
    expect(po!.dropship_store).toBe('OK-BIX')
    expect(po!.items.every((l) => l.warehouse === 'OK-BIX - CCZ')).toBe(true)
  })

  it('takes a dismissed row off the list without touching anything else', async () => {
    const store = desk()
    await store.loadSuggestions()
    store.select('PUFF-XXL-MINT')
    const out = await store.dismissSuggestion('PSG-00005', 'discontinued flavour')
    expect(out!.status).toBe('Dismissed')
    expect(store.openSuggestions.map((s) => s.item_code)).not.toContain('PUFF-XXL-MINT')
    expect(store.selectedCount).toBe(0)
    expect(store.notice).toBe('PUFF-XXL-MINT dismissed')
  })

  it('refuses a write when the signed-in user may not buy, and says so without throwing', async () => {
    const store = desk()
    useWarehouseStore().me = { ...ME, supply_unrestricted: false, warehouse_admin: false }
    await store.loadSuggestions()
    store.select('GB-PULSE-15K-BLUE')
    expect(await store.createOrders()).toBeNull()
    expect(store.error).toMatch(/warehouse admin or head office/)
  })
})

// =============================================================================================
// The screens actually render — a mount smoke test.
//
// No component stack is added for this: `createApp` is Vue's own, and vitest already runs in
// jsdom. It is deliberately shallow — it proves each template compiles, mounts against the seeded
// desk and prints the things a buyer looks for, which the helper tests above cannot.
// =============================================================================================
describe('screens render', () => {
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 8))
  }

  async function render(component: Component, props: Record<string, unknown> = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(component, props)
    app.config.warnHandler = () => {}
    app.use(createPinia())
    useWarehouseStore().me = { ...ME }
    app.mount(host)
    await settle()
    const html = host.innerHTML + document.body.innerHTML
    app.unmount()
    host.remove()
    return html
  }

  beforeEach(() => {
    __resetMockPurchasing()
    document.body.innerHTML = ''
  })

  it('paints the buying list with its badge, quantity, vendors and the create-orders footer', async () => {
    const html = await render(BuyingBoard)
    expect(html).toContain('data-testid="buying-board"')
    expect(html).toContain('Geek Bar Pulse 15K')
    expect(html).toContain('Low stock')
    expect(html).toContain('Lone Star Wholesale') // the alternative vendor is on the row, not in a menu
    expect(html).toContain('+$0.35 / unit')
    expect(html).toContain('12 per case · MOQ 24')
    expect(html).toContain('Nothing selected') // the footer before anything is chosen
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/)
  })

  it('paints an order with an editable rate, the freight field and the landed total', async () => {
    const html = await render(OrderSheet, { order: 'MPO-00003' })
    expect(html).toContain('data-testid="order-sheet"')
    expect(html).toContain('Lone Star Wholesale')
    expect(html).toContain('data-testid="order-freight-input"')
    expect(html).toContain('$1,152.40') // landed total = 1,092.40 net + 60 freight
    expect(html).toContain('$0.21') // freight per unit
    expect(html).toContain('moving-average cost')
    expect(html).toContain('data-testid="order-readonly"') // submitted, so every input is locked
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/)
  })

  it('paints the vendor list with an em dash where a statistic is missing', async () => {
    const html = await render(VendorsBoard)
    expect(html).toContain('data-testid="vendors-board"')
    expect(html).toContain('Lone Star Wholesale')
    expect(html).toContain('$57,420.10')
    expect(html).toContain('95.8%')
    expect(html).not.toMatch(/NaN|\[object Object\]/)
  })

  it('paints a vendor profile, and says where a catalogue cost is written', async () => {
    const html = await render(VendorSheet, { vendor: 'SUP-GULF' })
    expect(html).toContain('data-testid="vendor-sheet"')
    expect(html).toContain('Gulf Coast Distributing')
    expect(html).toContain('CCZ-4471') // the account number they know us by
    expect(html).toContain('data-testid="vendor-deactivate"')
    expect(html).not.toMatch(/NaN|\[object Object\]/)
  })

  it('never says Maison, Frappe or ERPNext', async () => {
    const html = [await render(BuyingBoard), await render(VendorsBoard), await render(OrderSheet, { order: 'MPO-00001' }), await render(VendorSheet, { vendor: 'SUP-BAYOU' })].join(' ')
    expect(html).not.toMatch(/Maison|Frappe|ERPNext/i)
  })
})
