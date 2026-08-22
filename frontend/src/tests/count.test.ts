import { beforeEach, describe, expect, it } from 'vitest'
import { compareCount } from '@/inventory/count'
import { mockApi, __resetMock } from '@/api/mock'

describe('cycle count comparison', () => {
  const expected = { serials: { 'WT-1': ['A1', 'A2'], 'HJ-1': ['B1'] }, qty: { 'AC-1': 5, 'AC-2': 2 } }
  it('flags missing, unexpected and qty differences', () => {
    const p = compareCount(expected, ['A1', 'ZZ', 'A1', ' B1 '], { 'AC-1': 4, 'AC-2': null })
    expect(p.expected_serials).toBe(3)
    expect(p.scanned_known).toBe(2)
    expect(p.missing).toEqual([{ item_code: 'WT-1', serial_no: 'A2' }])
    expect(p.unexpected).toEqual(['ZZ'])
    expect(p.by_item).toEqual([
      { item_code: 'WT-1', expected: 2, scanned: 1 },
      { item_code: 'HJ-1', expected: 1, scanned: 1 }
    ])
    expect(p.qty_differences).toEqual([{ item_code: 'AC-1', expected: 5, counted: 4, diff: -1 }])
    expect(p.clean).toBe(false)
  })
  it('is clean when everything matches', () => {
    expect(compareCount(expected, ['A1', 'A2', 'B1'], { 'AC-1': 5, 'AC-2': 2 }).clean).toBe(true)
  })
})

describe('mock inventory parity', () => {
  beforeEach(() => __resetMock())
  it('alerts / acknowledge / resolve / transfer', async () => {
    const a = await mockApi.inventory.alerts('CHI-OAK')
    expect(a.open).toBeGreaterThan(0)
    expect(a.alerts.every((x) => x.boutique === 'CHI-OAK' && x.qty <= x.reorder_level)).toBe(true)
    const first = a.alerts[0]
    expect((await mockApi.inventory.acknowledge(first.name)).status).toBe('Acknowledged')
    const mr = await mockApi.inventory.request_transfer({
      item: first.item_code,
      to: 'CHI-OAK',
      qty: 3,
      from_warehouse: 'NYC-MAD',
      alert: first.name
    })
    expect(mr.material_request).toMatch(/^MAT-MR-/)
    expect(mr.from_warehouse).toBe('NYC-MAD - MJ')
    expect(
      (await mockApi.inventory.alerts('CHI-OAK')).alerts.find((x) => x.name === first.name)?.material_request
    ).toBe(mr.material_request)
    expect((await mockApi.inventory.resolve(first.name)).status).toBe('Resolved')
    expect((await mockApi.inventory.alerts('CHI-OAK')).open).toBe(a.open - 1)
    await expect(mockApi.inventory.request_transfer({ item: 'X', to: 'CHI-OAK', qty: 0 })).rejects.toThrow()
  })
  it('cycle count round-trip', async () => {
    const exp = await mockApi.inventory.cycle_count_expected('CHI-OAK')
    const all = Object.values(exp.serials).flat()
    expect(all.length).toBeGreaterThan(5)
    const res = await mockApi.inventory.submit_cycle_count({
      boutique: 'CHI-OAK',
      serials: all.slice(1).concat(['NOPE']),
      qty: { [Object.keys(exp.qty)[0]]: exp.qty[Object.keys(exp.qty)[0]] - 1 }
    })
    expect(res.missing.map((m) => m.serial_no)).toEqual([all[0]])
    expect(res.unexpected[0]).toMatchObject({ serial_no: 'NOPE', status: 'not_found' })
    expect(res.qty_differences[0].diff).toBe(-1)
    expect(res.stock_reconciliation).toMatch(/^MAT-RECO-/)
    expect(res.clean).toBe(false)
    const clean = await mockApi.inventory.submit_cycle_count({ boutique: 'CHI-OAK', serials: all, qty: {} })
    expect(clean.clean).toBe(true)
    expect(clean.stock_reconciliation).toBeNull()
  })
})
