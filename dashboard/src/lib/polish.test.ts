/**
 * v0.6 R — the three Command-dashboard defects that are pure logic:
 *
 *  1. card / cash printed a *signed share of net*, which on a returns day read "−62% / 157%";
 *  2. store names kept the brand prefix, so eleven rows truncated to the identical "CloudChaser…";
 *  3. clocks used the browser zone while the tills used the site zone.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { fmtClock, fmtStamp, fmtTime, storeShortName } from './format'
import { setSiteTimeZone } from './time'

/** The tile's formula, extracted from `stores/dashboard.ts` (a Pinia store needs an app). */
function tenderMix(card: number, cash: number): { card: number; cash: number } {
  const gross = Math.abs(card) + Math.abs(cash)
  return gross > 0 ? { card: (Math.abs(card) / gross) * 100, cash: (Math.abs(cash) / gross) * 100 } : { card: 0, cash: 0 }
}

describe('card / cash split', () => {
  it('reads as a share of gross on an ordinary selling day', () => {
    const m = tenderMix(750, 250)
    expect(Math.round(m.card)).toBe(75)
    expect(Math.round(m.cash)).toBe(25)
  })

  it('stays inside 0–100 % on the day that produced "−62% / 157%"', () => {
    const m = tenderMix(-317, 804) // net 513, card refunded, cash taken
    expect(m.card).toBeGreaterThanOrEqual(0)
    expect(m.cash).toBeLessThanOrEqual(100)
    expect(Math.round(m.card) + Math.round(m.cash)).toBe(100)
    expect(Math.round(m.card)).toBe(28)
  })

  it('still splits when net is zero or negative (a returns-only day)', () => {
    const zeroNet = tenderMix(-500, 500)
    expect(Math.round(zeroNet.card)).toBe(50)
    expect(Math.round(zeroNet.cash)).toBe(50)
    const allReturns = tenderMix(-300, -100)
    expect(Math.round(allReturns.card)).toBe(75)
    expect(Math.round(allReturns.cash)).toBe(25)
  })

  it('is 0 / 0 only when no money moved at all', () => {
    expect(tenderMix(0, 0)).toEqual({ card: 0, cash: 0 })
  })
})

describe('storeShortName', () => {
  it('keeps the word that identifies the row', () => {
    expect(storeShortName('CloudChaserz Montrose', 'CloudChaserz')).toBe('Montrose')
    expect(storeShortName('CloudChaserz Broken Arrow', 'CloudChaserz')).toBe('Broken Arrow')
    expect(storeShortName('Maison Chicago Oak Street', 'Maison')).toBe('Chicago Oak Street')
  })
  it('leaves anything else alone', () => {
    expect(storeShortName('Montrose', 'CloudChaserz')).toBe('Montrose')
    expect(storeShortName('CloudChaserz', 'CloudChaserz')).toBe('CloudChaserz')
    expect(storeShortName(null, 'CloudChaserz')).toBe('')
  })
})

describe('site-zone clocks', () => {
  afterEach(() => setSiteTimeZone(null))

  it('renders a naive server timestamp as the site\'s own wall time', () => {
    setSiteTimeZone('America/Chicago')
    expect(fmtTime('2026-08-23 09:36:00')).toBe('09:36')
    setSiteTimeZone('Europe/Paris')
    expect(fmtTime('2026-08-23 09:36:00')).toBe('09:36')
  })

  it('converts an absolute timestamp into the site zone', () => {
    setSiteTimeZone('America/Chicago')
    expect(fmtTime('2026-08-23T14:36:00Z')).toBe('09:36')
    expect(fmtClock(new Date('2026-08-23T14:36:41Z'))).toBe('09:36:41')
  })

  it('labels a precompute stamp with the zone it is on', () => {
    setSiteTimeZone('America/Chicago')
    expect(fmtStamp('2026-08-23 15:00:00')).toBe('23 Aug, 15:00 CDT')
    expect(fmtStamp(null)).toBe('—')
  })
})
