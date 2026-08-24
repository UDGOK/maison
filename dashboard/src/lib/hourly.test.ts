/**
 * v0.8 QA D-1 / D-22 — the hourly chart's window and peak.
 *
 * The chart hard-coded `09:00–21:00` and reduced `peak` over that slice: on the day QA looked at,
 * $512.73 of the chain's $597.38 sat in the 04:00 bucket, so 86 % of the money the KPI beside it
 * announced was never drawn and the label read "PEAK 12:00 · 48" while the real peak was 04:00.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FROM, DEFAULT_TO, MIN_SPAN, hourWindow, peakHour, visibleHours } from './hourly'

/** The chain's real buckets from the QA run (`results-d1.json`). */
const LIVE_DAY = [
  { hour: 4, net: 512.73, invoices: 33 },
  { hour: 12, net: 47.88, invoices: 4 },
  { hour: 14, net: 28.99, invoices: 6 },
  { hour: 15, net: 7.78, invoices: 3 },
]

const emptyDay = Array.from({ length: 24 }, (_, hour) => ({ hour, net: 0, invoices: 0 }))

describe('hourWindow', () => {
  it('covers the hours that actually traded, not a fixed shop day', () => {
    const w = hourWindow(LIVE_DAY, 16)
    expect(w.from).toBeLessThanOrEqual(4)
    expect(w.to).toBeGreaterThanOrEqual(16)
  })

  it('draws every bucket of the window, including the ones with no sales', () => {
    const w = hourWindow(LIVE_DAY, 16)
    const bars = visibleHours(LIVE_DAY, w)
    expect(bars).toHaveLength(w.to - w.from + 1)
    expect(bars.map((b) => b.hour)).toEqual(Array.from({ length: bars.length }, (_, i) => w.from + i))
    // the money in the 04:00 bucket is on the chart — this is the 86 % that used to vanish
    const total = bars.reduce((s, b) => s + b.net, 0)
    expect(total).toBeCloseTo(597.38, 2)
  })

  it('keeps late trade (a store that closes at 23:00)', () => {
    const w = hourWindow([{ hour: 22, net: 120, invoices: 2 }, { hour: 23, net: 90, invoices: 1 }], 23)
    expect(w.to).toBe(23)
    expect(visibleHours([{ hour: 23, net: 90, invoices: 1 }], w).some((b) => b.hour === 23 && b.net === 90)).toBe(true)
  })

  it('falls back to shop hours on a day with no sales, and never draws a stub', () => {
    const w = hourWindow(emptyDay, 12)
    expect(w.from).toBeLessThanOrEqual(DEFAULT_FROM)
    expect(w.to).toBeGreaterThanOrEqual(DEFAULT_TO)
    const single = hourWindow([{ hour: 11, net: 10, invoices: 1 }], 11)
    expect(single.to - single.from + 1).toBeGreaterThanOrEqual(MIN_SPAN)
    expect(single.from).toBeGreaterThanOrEqual(0)
    expect(single.to).toBeLessThanOrEqual(23)
  })

  it('honours an explicit override', () => {
    expect(hourWindow(LIVE_DAY, 16, 6, 20)).toEqual({ from: 6, to: 20 })
  })
})

describe('peakHour', () => {
  it('is the busiest hour of the whole day, not of the drawn slice', () => {
    expect(peakHour(LIVE_DAY)?.hour).toBe(4)
    expect(peakHour(LIVE_DAY)?.net).toBeCloseTo(512.73, 2)
  })

  it('is nothing at all on a day with no sales', () => {
    // a store with no sales used to report "PEAK 09:00 · 0"
    expect(peakHour(emptyDay)).toBeNull()
    expect(peakHour([])).toBeNull()
  })

  it('ignores an hour that only took returns', () => {
    expect(peakHour([{ hour: 10, net: -40, invoices: 0 }, { hour: 11, net: 5, invoices: 1 }])?.hour).toBe(11)
  })
})
