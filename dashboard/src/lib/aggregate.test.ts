import { describe, expect, it } from 'vitest'
import { addSaleToHours, applySale, bucketByHour, computeTotals, deriveStatus, pct, sortByNet } from './aggregate'
import type { BoutiqueRow } from '../types'

const T0 = Date.parse('2026-08-22T14:00:00')

describe('deriveStatus', () => {
  it('is offline with no heartbeat', () => {
    expect(deriveStatus(null, T0)).toBe('offline')
    expect(deriveStatus(undefined, T0)).toBe('offline')
  })
  it('is online within 120s', () => {
    expect(deriveStatus(new Date(T0 - 60_000).toISOString(), T0)).toBe('online')
    expect(deriveStatus(new Date(T0 - 120_000).toISOString(), T0)).toBe('online')
  })
  it('is offline after 120s', () => {
    expect(deriveStatus(new Date(T0 - 120_001).toISOString(), T0)).toBe('offline')
    expect(deriveStatus(new Date(T0 - 3_600_000), T0)).toBe('offline')
  })
  it('pending approval wins when online', () => {
    expect(deriveStatus(new Date(T0 - 10_000), T0, 2)).toBe('pending_approval')
    expect(deriveStatus(new Date(T0 - 500_000), T0, 2)).toBe('offline')
  })
  it('treats garbage dates as offline', () => {
    expect(deriveStatus('not a date', T0)).toBe('offline')
  })
})

describe('bucketByHour', () => {
  it('always returns 24 buckets', () => {
    const b = bucketByHour([])
    expect(b).toHaveLength(24)
    expect(b.every((x) => x.net === 0 && x.invoices === 0)).toBe(true)
    expect(b.map((x) => x.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i))
  })
  it('sums net and counts invoices per local hour', () => {
    const d = (h: number, m: number) => new Date(2026, 7, 22, h, m).toISOString()
    const b = bucketByHour([
      { posting_datetime: d(10, 5), net: 100 },
      { posting_datetime: d(10, 59), net: 50 },
      { posting_datetime: d(17, 0), net: 1000 },
    ])
    expect(b[10]).toEqual({ hour: 10, net: 150, invoices: 2 })
    expect(b[17]).toEqual({ hour: 17, net: 1000, invoices: 1 })
    expect(b[11]!.net).toBe(0)
  })
  it('addSaleToHours is immutable and repairs malformed input', () => {
    const base = bucketByHour([])
    const next = addSaleToHours(base, { posting_datetime: new Date(2026, 7, 22, 9, 0).toISOString(), net: 42 })
    expect(base[9]!.net).toBe(0)
    expect(next[9]!.net).toBe(42)
    expect(addSaleToHours([], { posting_datetime: new Date(2026, 7, 22, 9, 0).toISOString(), net: 1 })).toHaveLength(24)
  })
})

describe('totals and rows', () => {
  const rows: BoutiqueRow[] = [
    { boutique: 'A', name: 'Alpha', net: 100, cash: 40, card: 60, invoices: 2, status: 'online', last_seen: null },
    { boutique: 'B', name: 'Beta', net: 300, cash: 0, card: 300, invoices: 1, status: 'online', last_seen: null },
  ]
  it('computes totals and avg ticket', () => {
    expect(computeTotals(rows)).toEqual({ net: 400, cash: 40, card: 360, invoices: 3, avg_ticket: 400 / 3 })
    expect(computeTotals([]).avg_ticket).toBe(0)
  })
  it('applies a sale to an existing row or creates one', () => {
    const s = { invoice: 'X', boutique: 'A', posting_datetime: new Date().toISOString(), items: [], net: 50, cash: 50, card: 0 }
    const r = applySale(rows, s)
    expect(r[0]).toMatchObject({ net: 150, cash: 90, invoices: 3 })
    expect(rows[0]!.net).toBe(100)
    const r2 = applySale(rows, { ...s, boutique: 'C', boutique_name: 'Gamma' })
    expect(r2).toHaveLength(3)
    expect(r2[2]).toMatchObject({ boutique: 'C', name: 'Gamma', net: 50, invoices: 1 })
  })
  it('sorts by net desc', () => {
    expect(sortByNet(rows).map((r) => r.boutique)).toEqual(['B', 'A'])
  })
  it('pct guards divide by zero', () => {
    expect(pct(1, 0)).toBe(0)
    expect(pct(25, 100)).toBe(25)
  })
})
