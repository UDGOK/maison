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
    // v0.8 QA D-4: `avg_ticket` is the average *sale* — `gross` (returns excluded), not `net`
    expect(computeTotals(rows)).toEqual({ net: 400, gross: 400, cash: 40, card: 360, invoices: 3, avg_ticket: 400 / 3 })
    expect(computeTotals([]).avg_ticket).toBe(0)
    const withReturns = [{ ...rows[0]!, net: 60, returns_value: 40 }]
    expect(computeTotals(withReturns).avg_ticket).toBe(50) // (60 + 40) / 2 sales, not 60 / 2
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

// ---------------------------------------------------------------------------
// v0.5 L — incremental aggregation reducer (100 boutiques × 1,000 events)
// ---------------------------------------------------------------------------
import { chainTotals, createAggState, foldHeartbeat, rankedBoutiques, reduceEvents, seedFromSummary, FEED_PER_BOUTIQUE, TICKER_SIZE, type LiveEvent } from './aggregate'
import type { SaleEvent } from '../types'

function lcg(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
}

describe('incremental reducer', () => {
  const N_B = 100
  const N_E = 1000
  const codes = Array.from({ length: N_B }, (_, i) => `B${String(i).padStart(3, '0')}`)
  const rows = codes.map((c, i) => ({ boutique: c, name: `Boutique ${i}`, region: i % 2 ? 'East' : 'West', net: 1000 * i, cash: 0, card: 1000 * i, invoices: i ? 2 : 0, status: 'online' as const, last_seen: null, last_week_net: 900 * i }))

  function synth(): { events: LiveEvent[]; expected: Map<string, { net: number; inv: number; ret: number }> } {
    const rnd = lcg(42)
    const events: LiveEvent[] = []
    const expected = new Map<string, { net: number; inv: number; ret: number }>()
    for (let i = 0; i < N_E; i++) {
      const code = codes[Math.floor(rnd() * N_B)]!
      const isReturn = rnd() < 0.1
      const amt = Math.round(rnd() * 20000 + 100) * (isReturn ? -1 : 1)
      const s: SaleEvent = { invoice: `INV-${i}`, boutique: code, posting_datetime: new Date(2026, 7, 22, 9 + (i % 10), i % 60).toISOString(), items: ['Piece'], top_item: `Piece ${i}`, is_return: isReturn, net: amt, cash: 0, card: amt }
      events.push({ kind: 'sale', sale: s })
      const e = expected.get(code) ?? { net: 0, inv: 0, ret: 0 }
      e.net += amt
      if (isReturn) e.ret++
      else e.inv++
      expected.set(code, e)
      if (i % 7 === 0) events.push({ kind: 'heartbeat', heartbeat: { boutique: code, ts: new Date().toISOString(), queued: i % 3 } })
    }
    return { events, expected }
  }

  it('folds 1,000 events across 100 boutiques exactly, in one version bump per batch', () => {
    const state = seedFromSummary(createAggState(), rows)
    const v0 = state.version
    const { events, expected } = synth()
    const t0 = performance.now()
    const res = reduceEvents(state, events)
    const ms = performance.now() - t0
    expect(res.sales).toBe(N_E)
    expect(state.version).toBe(v0 + 1)
    for (const [code, e] of expected) {
      const b = state.rows.get(code)!
      expect(b.net).toBeCloseTo(1000 * codes.indexOf(code) + e.net, 6)
      expect(b.invoices).toBe((codes.indexOf(code) ? 2 : 0) + e.inv)
      expect(b.returns).toBe(e.ret)
      expect(b.feed.length).toBeLessThanOrEqual(FEED_PER_BOUTIQUE)
      expect(b.last_sale?.invoice).toBe(b.feed[0]!.invoice)
    }
    expect(state.ticker).toHaveLength(TICKER_SIZE)
    expect(state.ticker[0]!.invoice).toBe(`INV-${N_E - 1}`)
    const totals = chainTotals(state)
    let net = 0
    for (const b of state.rows.values()) net += b.net
    expect(totals.net).toBeCloseTo(net, 6)
    expect(totals.invoices).toBe([...state.rows.values()].reduce((a, b) => a + b.invoices, 0))
    // hourly buckets agree with the per-boutique buckets
    const hourSum = state.hours.reduce((a, h) => a + h.net, 0)
    const boutiqueHourSum = [...state.rows.values()].reduce((a, b) => a + b.by_hour.reduce((x, y) => x + y, 0), 0)
    expect(hourSum).toBeCloseTo(boutiqueHourSum, 6)
    // performance: well under a frame for a burst this size
    expect(ms).toBeLessThan(100)
    // eslint-disable-next-line no-console
    console.log(`[bench] reduceEvents 100 boutiques × ${N_E} events: ${ms.toFixed(2)} ms`)
  })

  it('dedupes re-delivered events and keeps per-boutique feeds bounded', () => {
    const state = seedFromSummary(createAggState(), rows)
    const { events } = synth()
    reduceEvents(state, events)
    const v = state.version
    const again = reduceEvents(state, events)
    expect(again.applied).toBe(events.filter((e) => e.kind === 'heartbeat').length) // heartbeats always apply, sales never twice
    expect(state.version).toBe(v + 1)
    for (const b of state.rows.values()) expect(b.feed.length).toBeLessThanOrEqual(FEED_PER_BOUTIQUE)
  })

  it('vs-last-week and avg ticket update incrementally', () => {
    const state = seedFromSummary(createAggState(), rows)
    const b = state.rows.get('B010')!
    expect(b.vs_last_week_pct).toBeCloseTo(((10000 - 9000) / 9000) * 100, 6)
    reduceEvents(state, [{ kind: 'sale', sale: { invoice: 'X', boutique: 'B010', posting_datetime: new Date().toISOString(), items: [], net: 8000, cash: 0, card: 8000 } }])
    expect(b.net).toBe(18000)
    expect(b.invoices).toBe(3)
    expect(b.avg_ticket).toBe(6000)
    expect(b.vs_last_week_pct).toBeCloseTo(100, 6)
    expect(b.flash).toBeGreaterThan(0)
  })

  it('heartbeats update last_seen / queued without touching sales', () => {
    const state = seedFromSummary(createAggState(), rows)
    const ts = new Date().toISOString()
    expect(foldHeartbeat(state, { boutique: 'B001', ts, queued: 3 })).toBe(true)
    expect(foldHeartbeat(state, { boutique: 'NOPE', ts })).toBe(false)
    expect(state.rows.get('B001')!.queued).toBe(3)
    expect(state.rows.get('B001')!.net).toBe(1000)
  })

  it('seedFromSummary reconciles totals but keeps the live feed', () => {
    const state = seedFromSummary(createAggState(), rows)
    reduceEvents(state, synth().events)
    const feedLen = state.rows.get('B005')!.feed.length
    seedFromSummary(state, rows.map((r) => ({ ...r, net: r.net + 1 })))
    expect(state.rows.get('B005')!.net).toBe(5001)
    expect(state.rows.get('B005')!.feed.length).toBe(feedLen)
  })

  it('rankedBoutiques filters by region / search and sorts', () => {
    const state = seedFromSummary(createAggState(), rows)
    const east = rankedBoutiques(state, { region: 'East' })
    expect(east.every((b) => b.region === 'East')).toBe(true)
    expect(east[0]!.boutique).toBe('B099')
    expect(rankedBoutiques(state, { q: 'b00' }).map((b) => b.boutique)).toHaveLength(10)
    expect(rankedBoutiques(state, { sort: 'name' })[0]!.name).toBe('Boutique 0')
    expect(rankedBoutiques(state, { sort: 'invoices' })[0]!.invoices).toBe(2)
  })
})
