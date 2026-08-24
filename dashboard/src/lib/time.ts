/**
 * v0.6 R — the Command dashboard renders every time in the **site timezone**.
 *
 * The head office browser can be anywhere; the shops are not. Before this, the top-bar clock and
 * the reconcile stamp were `new Date()` in the *browser's* zone, so a laptop one zone over showed
 * a different "now" than the till and the warehouse wall — three clocks, one chain.
 *
 * The zone is baked into the page by `maison_pos/www/awanz-dashboard.html`
 * (`window.awanz_site = {"time_zone": "America/Chicago"}`); with no zone on the page (dev / mock)
 * this falls back to the browser's own zone, which is the old behaviour.
 *
 * Frappe also returns *naive* datetimes in the site zone ("2026-08-23 09:36:00"); those are parsed
 * as site-zone wall time rather than as browser-local time (`maison_pos.utils.iso_with_tz` values
 * carry an offset and are converted normally).
 */
const NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/

declare global {
  interface Window {
    awanz_site?: { time_zone?: string }
  }
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function usable(tz: string | null | undefined): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

let zone: string | null = usable(typeof window !== 'undefined' ? window.awanz_site?.time_zone : null) ? (window.awanz_site!.time_zone as string) : null

/** Re-read `window.awanz_site` (tests set it, then call this) or set the zone directly. */
export function setSiteTimeZone(tz?: string | null): string {
  const next = tz === undefined ? (typeof window !== 'undefined' ? window.awanz_site?.time_zone : null) : tz
  zone = usable(next) ? next : null
  return siteTimeZone()
}

export function siteTimeZone(): string {
  return zone || browserZone()
}

const fmts = new Map<string, Intl.DateTimeFormat>()
function offsetFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    fmts.set(tz, f)
  }
  return f
}

function tzOffset(ts: number, tz: string): number {
  const p = offsetFormatter(tz).formatToParts(new Date(ts))
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value)
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUTC - Math.floor(ts / 1000) * 1000
}

function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const first = tzOffset(guess, tz)
  const ts = guess - first
  const second = tzOffset(ts, tz)
  return second === first ? ts : guess - second
}

/** Parse a server timestamp: naive → site-zone wall time, anything else → absolute. */
export function parseServer(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return Number.isNaN(value) ? null : new Date(value)
  const raw = String(value).trim()
  if (NAIVE.test(raw)) {
    const [datePart, timePart] = raw.replace(' ', 'T').split('T')
    const [y, mo, d] = datePart.split('-').map(Number)
    const [h, mi, s] = timePart.split(':').map((n) => Math.trunc(Number(n)))
    return new Date(wallToEpoch(y, mo, d, h || 0, mi || 0, s || 0, siteTimeZone()))
  }
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatInSiteZone(d: Date, opts: Intl.DateTimeFormatOptions, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, { timeZone: siteTimeZone(), ...opts }).format(d)
}

/** "CDT" / "GMT+2" — so two screens side by side can be told apart. */
export function zoneLabel(at: Date = new Date()): string {
  // en-US resolves the familiar abbreviations ("CDT"); en-GB renders them as "GMT-5"
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: siteTimeZone(), timeZoneName: 'short' }).formatToParts(at)
  return parts.find((p) => p.type === 'timeZoneName')?.value || ''
}
