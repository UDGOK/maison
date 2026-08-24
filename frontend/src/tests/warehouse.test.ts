/**
 * v0.6 O/P — wall aggregation + age timers, rate selection, auto-print hook, mock supply chain parity.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { __onMockWall, __resetMockWarehouse, mockRates, mockWarehouse, type Rate, type Shipment, type ReplenishmentRequest } from '@/api/warehouse'
import { ageTier, aggregate, columnFor, diffWall, fmtAge, liveAge, printJobsFor, rateRows, selectRate, sortCards, primaryAction } from '@/warehouse/wall'
import { packingListUrl, printDocument } from '@/warehouse/print'

const H = 3600
function shipment(over: Partial<Shipment>): Shipment {
  return {
    name: 'MSH-1',
    boutique: 'OK-BIX',
    from_warehouse: 'HOU-WH - CCZ',
    to_warehouse: 'OK-BIX - CCZ',
    status: 'Pending',
    items: 1,
    units: 10,
    units_picked: 0,
    units_received: 0,
    parcels: [],
    packages: 0,
    total_weight: 0,
    est_weight: 1,
    est_dims: [40, 30, 25],
    age_seconds: 0,
    packing_list_url: '',
    ...over
  }
}
function request(over: Partial<ReplenishmentRequest>): ReplenishmentRequest {
  return { name: 'MRR-1', boutique: 'OK-BIX', to_warehouse: 'OK-BIX - CCZ', from_warehouse: 'HOU-WH - CCZ', status: 'Pending Approval', priority: 'Normal', units: 5, units_approved: 5, items: 1, lines: [], kind: 'request', age_seconds: 0, ...over }
}

describe('wall aggregation', () => {
  it('routes documents to the five columns like the server', () => {
    const today = new Date()
    expect(columnFor(request({}), today)).toBe('pending_approval')
    expect(columnFor(request({ status: 'Approved' }), today)).toBeNull()
    expect(columnFor(shipment({ status: 'Pending' }), today)).toBe('to_pick')
    expect(columnFor(shipment({ status: 'Picking' }), today)).toBe('to_pick')
    expect(columnFor(shipment({ status: 'Packed' }), today)).toBe('packing')
    expect(columnFor(shipment({ status: 'Packed', label_url: '/l.pdf' }), today)).toBe('ready')
    expect(columnFor(shipment({ status: 'Shipped', shipped_at: today.toISOString() }), today)).toBe('shipped_today')
    expect(columnFor(shipment({ status: 'Shipped', shipped_at: new Date(today.getTime() - 2 * 86400_000).toISOString() }), today)).toBeNull()
    expect(columnFor(shipment({ status: 'Received' }), today)).toBeNull()
  })

  it('sorts priority first, then the oldest on top', () => {
    const cols = aggregate([
      shipment({ name: 'a', age_seconds: 100 }),
      shipment({ name: 'b', age_seconds: 5000, priority: 'Low stock' }),
      shipment({ name: 'c', age_seconds: 9000 }),
      shipment({ name: 'd', age_seconds: 10, priority: 'Urgent' })
    ])
    expect(cols.to_pick.map((c) => c.name)).toEqual(['d', 'b', 'c', 'a'])
    expect(sortCards([{ priority: 'Normal', age_seconds: 1 }, { priority: 'Low stock', age_seconds: 0 }])[0].priority).toBe('Low stock')
  })

  it('age tiers: warn at 4 h, crit at 24 h; timers tick locally from the fetch time', () => {
    expect(ageTier(3 * H)).toBe('ok')
    expect(ageTier(4 * H)).toBe('warn')
    expect(ageTier(23 * H)).toBe('warn')
    expect(ageTier(24 * H)).toBe('crit')
    expect(ageTier(2 * H, 1 * H, 3 * H)).toBe('warn')
    const fetchedAt = 1_000_000
    expect(liveAge({ age_seconds: 100 }, fetchedAt, fetchedAt + 65_000)).toBe(165)
    expect(fmtAge(12 * 60)).toBe('12m')
    expect(fmtAge(3 * H + 5 * 60)).toBe('3h 05m')
    expect(fmtAge(26 * H)).toBe('1d 2h')
  })

  it('diffs two snapshots: newly approved → sound, newly labelled → label print', () => {
    const prev = { pending_approval: [request({ name: 'r1' })], to_pick: [shipment({ name: 's1' })], packing: [], ready: [], shipped_today: [] }
    const next = { pending_approval: [request({ name: 'r2' })], to_pick: [shipment({ name: 's1' }), shipment({ name: 's2' })], packing: [], ready: [shipment({ name: 's3', label_url: 'x' })], shipped_today: [] }
    const d = diffWall(prev, next)
    expect(d.approved).toEqual(['s2'])
    expect(d.labelled).toEqual(['s3'])
    expect(d.requested).toEqual(['r2'])
    expect(diffWall(null, next)).toEqual({ approved: [], labelled: [], requested: [] })
  })

  it('primary action per column', () => {
    expect(primaryAction('pending_approval').action).toBe('approve')
    expect(primaryAction('to_pick').action).toBe('pick')
    expect(primaryAction('packing').action).toBe('buy')
    expect(primaryAction('ready').action).toBe('ship')
    expect(primaryAction('shipped_today').action).toBe('none')
  })
})

describe('rate selection', () => {
  const rates: Rate[] = [
    { carrier: 'UPS', service: 'Ground', amount: 12.5, days: 3, provider_rate_id: 'ups', provider: 'simulated' },
    { carrier: 'USPS', service: 'Priority', amount: 9.9, days: 2, provider_rate_id: 'usps', provider: 'simulated' },
    { carrier: 'UPS', service: 'Next Day', amount: 44, days: 1, provider_rate_id: 'nda', provider: 'simulated' },
    { carrier: 'FedEx', service: 'Home', amount: 9.9, days: 4, provider_rate_id: 'fedex', provider: 'simulated' }
  ]
  it('cheapest is the default (ties broken by speed); fastest toggle picks fewest days', () => {
    expect(selectRate(rates)!.provider_rate_id).toBe('usps')
    expect(selectRate(rates, 'fastest')!.provider_rate_id).toBe('nda')
    expect(selectRate([], 'cheapest')).toBeNull()
  })
  it('rows are ordered by price with Cheapest / Fastest badges', () => {
    const rows = rateRows(rates)
    expect(rows.map((r) => r.provider_rate_id)).toEqual(['usps', 'fedex', 'ups', 'nda'])
    expect(rows[0].badges).toEqual(['Cheapest'])
    expect(rows[3].badges).toEqual(['Fastest'])
  })
  it('simulated mock rates scale with weight and zone', () => {
    const tx = mockRates({ name: '', street1: '', city: 'Houston', state: 'TX', zip: '77098', country: 'US' }, 1)
    const ok = mockRates({ name: '', street1: '', city: 'Tulsa', state: 'OK', zip: '74133', country: 'US' }, 1)
    const okHeavy = mockRates({ name: '', street1: '', city: 'Tulsa', state: 'OK', zip: '74133', country: 'US' }, 8)
    expect(selectRate(ok)!.amount).toBeGreaterThan(selectRate(tx)!.amount)
    expect(selectRate(okHeavy)!.amount).toBeGreaterThan(selectRate(ok)!.amount)
    expect(selectRate(ok)!.carrier).toBe('USPS')
  })
})

describe('auto-print hook', () => {
  it('maps realtime events to print jobs per settings', () => {
    const s = { auto_print_packing_list: true, auto_print_label: true }
    expect(printJobsFor({ event: 'approved', shipment: 'MSH-9', ts: '' }, s, packingListUrl)).toEqual([{ kind: 'packing_list', url: packingListUrl('MSH-9'), shipment: 'MSH-9' }])
    expect(printJobsFor({ event: 'label', shipment: 'MSH-9', label_url: '/shipping-label/1', ts: '' }, s, packingListUrl)[0].kind).toBe('label')
    expect(printJobsFor({ event: 'approved', shipment: 'MSH-9', ts: '' }, { ...s, auto_print_packing_list: false }, packingListUrl)).toEqual([])
    expect(printJobsFor({ event: 'shipped', shipment: 'MSH-9', ts: '' }, s, packingListUrl)).toEqual([])
    expect(packingListUrl('MSH-00012')).toContain('format=AWANZ%20Packing%20List')
  })
  it('records every job on window.__awanzLastWallPrint (dry run in jsdom)', async () => {
    window.__awanzWallPrintDry = true
    const job = await printDocument('packing_list', packingListUrl('MSH-7'), 'MSH-7')
    expect(job.via).toBe('dry')
    expect(window.__awanzLastWallPrint).toMatchObject({ kind: 'packing_list', shipment: 'MSH-7' })
    expect(window.__awanzWallPrints!.length).toBeGreaterThan(0)
  })
})

describe('mock supply chain', () => {
  beforeEach(() => __resetMockWarehouse())

  it('request → approve (edited qty) → pick → pack → rates → buy (cheapest) → ship → receive with a short line', async () => {
    const events: string[] = []
    const off = __onMockWall((e) => events.push(e.event))
    const r = await mockWarehouse.store.replenish({ boutique: 'OK-BIX', item: 'GB-PULSE-15K-BLUE', qty: 10, alert: 'MSA-1' })
    expect(r.request.priority).toBe('Low stock')
    let wall = await mockWarehouse.admin.wall()
    expect(wall.columns.pending_approval.map((c) => c.name)).toContain(r.name)

    const a = await mockWarehouse.admin.approve(r.name, [{ item_code: 'GB-PULSE-15K-BLUE', approved_qty: 8 }], 'only 8')
    expect(a.shipment.units).toBe(8)
    expect(a.request.status).toBe('Approved')
    const sh = a.shipment.name
    wall = await mockWarehouse.admin.wall()
    expect(wall.columns.to_pick.map((c) => c.name)).toContain(sh)

    await mockWarehouse.admin.pick(sh, [{ item_code: 'GB-PULSE-15K-BLUE', picked_qty: 8 }])
    await mockWarehouse.admin.pack(sh, undefined, [{ length: 40, width: 30, height: 25, weight: 1.2 }])
    wall = await mockWarehouse.admin.wall()
    expect(wall.columns.packing.map((c) => c.name)).toContain(sh)

    const q = await mockWarehouse.admin.rates(sh, 'cheapest')
    expect(q.rates.length).toBeGreaterThan(3)
    expect(q.selected!.provider_rate_id).toBe(q.cheapest)
    const b = await mockWarehouse.admin.buy(sh, null, 'cheapest')
    expect(b.label.amount).toBe(q.selected!.amount)
    expect(b.tracking_no).toBeTruthy()
    wall = await mockWarehouse.admin.wall()
    expect(wall.columns.ready.map((c) => c.name)).toContain(sh)

    const s = await mockWarehouse.admin.ship(sh)
    expect(s.status).toBe('Shipped')
    expect(s.stock_entry_ship).toMatch(/^MAT-STE/)
    wall = await mockWarehouse.admin.wall()
    expect(wall.columns.shipped_today.map((c) => c.name)).toContain(sh)

    const inb = await mockWarehouse.store.inbound('OK-BIX')
    expect(inb.shipments.map((x) => x.name)).toContain(sh)
    const rec = await mockWarehouse.store.receive_shipment({ shipment: sh, lines: [{ item_code: 'GB-PULSE-15K-BLUE', received_qty: 7, damaged_qty: 0 }] })
    expect(rec.status).toBe('Received')
    expect(rec.discrepancies.length).toBe(1)
    const d = await mockWarehouse.admin.discrepancies('Open')
    expect(d.discrepancies[0]).toMatchObject({ type: 'Short', short_qty: 1, shipment: sh })
    const res = await mockWarehouse.admin.resolve_discrepancy(d.discrepancies[0].name, 'Re-ship')
    expect(res.reship_request).toMatch(/^MRR-/)
    expect(events).toEqual(expect.arrayContaining(['request', 'approved', 'picking', 'packed', 'label', 'shipped', 'received', 'discrepancy']))
    off()
  })

  it('reject needs a reason; managers see the rejection on their list', async () => {
    const r = await mockWarehouse.store.replenish({ boutique: 'OK-JENKS', lines: [{ item_code: 'RAW-KS-SLIM', qty: 3 }] })
    await expect(mockWarehouse.admin.reject(r.name, '  ')).rejects.toThrow(/reason/)
    await mockWarehouse.admin.reject(r.name, 'discontinued')
    const mine = await mockWarehouse.store.requests('OK-JENKS', 'all')
    expect(mine.requests.find((x) => x.name === r.name)).toMatchObject({ status: 'Rejected', rejection_reason: 'discontinued' })
  })

  it('vendor PO receive at the warehouse moves stock on hand', async () => {
    const before = (await mockWarehouse.admin.warehouse_stock('GB-PULSE')).rows[0].actual_qty
    const pos = await mockWarehouse.admin.vendor_pos()
    const po = pos.purchase_orders[0]
    const out = await mockWarehouse.admin.receive_vendor_po(po.name, [{ name: po.items[0].name, qty: 50 }])
    expect(out.purchase_receipt).toMatch(/^MAT-PRE/)
    const after = (await mockWarehouse.admin.warehouse_stock('GB-PULSE')).rows[0].actual_qty
    expect(after - before).toBe(50)
  })
})
