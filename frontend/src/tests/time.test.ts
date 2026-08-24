import { describe, it, expect, afterEach } from 'vitest'
import { clockHM, formatInSiteZone, parseServer, setSiteTimeZone, siteTimeZone, zoneLabel } from '@/utils/time'
import { fmtDate, fmtDateTime, todayISO } from '@/utils/device'

/**
 * v0.6 R — one clock per chain. The suite runs with TZ unset (the container is UTC), which is
 * exactly the case that used to be wrong: a naive Frappe timestamp is site wall-clock time, so it
 * must come back out of the formatter unchanged, whatever the machine's own zone is.
 */
afterEach(() => setSiteTimeZone(null))

describe('site timezone', () => {
  it('falls back to the browser zone until a site zone is set', () => {
    setSiteTimeZone(null)
    expect(siteTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    setSiteTimeZone('Mars/Olympus_Mons') // unknown zone: keep the fallback rather than throwing
    expect(siteTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('reads a naive Frappe timestamp as site wall time and renders it back unchanged', () => {
    setSiteTimeZone('America/Chicago')
    expect(fmtDateTime('2026-08-23 09:36:00')).toBe('Aug 23, 2026, 09:36')
    expect(fmtDateTime('2026-08-23T09:36:00.123456')).toBe('Aug 23, 2026, 09:36')
    // the same instant is 09:36 in Chicago and 16:36 in Paris
    setSiteTimeZone('Europe/Paris')
    expect(fmtDateTime(parseServer('2026-08-23 09:36:00')!)).toBe('Aug 23, 2026, 09:36')
  })

  it('converts an absolute timestamp into the site zone', () => {
    setSiteTimeZone('America/Chicago')
    // 14:36Z in August is 09:36 CDT
    expect(fmtDateTime('2026-08-23T14:36:00Z')).toBe('Aug 23, 2026, 09:36')
    expect(clockHM(new Date('2026-08-23T14:36:00Z'))).toBe('09:36')
    setSiteTimeZone('Asia/Tokyo')
    expect(fmtDateTime('2026-08-23T14:36:00Z')).toBe('Aug 23, 2026, 23:36')
  })

  it('is DST-correct on both sides of the change', () => {
    setSiteTimeZone('America/Chicago')
    expect(formatInSiteZone(parseServer('2026-01-15 09:00:00')!, { hour: '2-digit', minute: '2-digit', hour12: false })).toBe('09:00')
    expect(zoneLabel(parseServer('2026-01-15 09:00:00')!)).toBe('CST')
    expect(zoneLabel(parseServer('2026-07-15 09:00:00')!)).toBe('CDT')
  })

  it('still refuses to throw on junk (a bad timestamp used to blank a whole view)', () => {
    setSiteTimeZone('America/Chicago')
    expect(fmtDateTime(null)).toBe('—')
    expect(fmtDateTime('')).toBe('—')
    expect(fmtDateTime('not a date')).toBe('—')
    expect(parseServer(new Date('nope'))).toBeNull()
  })

  it('reads a bare date as a site-zone calendar day, not UTC midnight (v1.0)', () => {
    // Frappe Date columns (`schedule_date`, `transaction_date`, `posting_date`, `valid_from`,
    // `last_purchase_date`) have no time part. `new Date('2026-08-27')` is UTC midnight, which
    // renders as Aug 26 anywhere west of UTC — a purchase order's ETA off by a day.
    setSiteTimeZone('America/Chicago')
    expect(fmtDate('2026-08-27')).toBe('Aug 27, 2026')
    expect(fmtDate('2026-01-01')).toBe('Jan 01, 2026')
    setSiteTimeZone('Pacific/Niue') // UTC−11, the worst case
    expect(fmtDate('2026-08-27')).toBe('Aug 27, 2026')
    setSiteTimeZone('Pacific/Kiritimati') // UTC+14, the other side
    expect(fmtDate('2026-08-27')).toBe('Aug 27, 2026')
    // and a datetime still means site-zone wall time
    setSiteTimeZone('America/Chicago')
    expect(fmtDate('2026-08-27 23:30:00')).toBe('Aug 27, 2026')
  })

  it('answers "today" on the store clock, not the device clock', () => {
    setSiteTimeZone('Pacific/Kiritimati') // UTC+14: ahead of a UTC container's date for 10 h a day
    const ahead = todayISO()
    setSiteTimeZone('Pacific/Niue') // UTC−11
    const behind = todayISO()
    expect(ahead >= behind).toBe(true)
    expect(ahead).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
