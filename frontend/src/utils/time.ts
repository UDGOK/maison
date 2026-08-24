/**
 * v0.6 R — one clock for every screen: the **site timezone** (the boutique's zone where the
 * bootstrap carries one, else the site's `System Settings.time_zone`).
 *
 * Why this module exists: three screens showed three different times on the same till.
 *  - Frappe stores and returns *naive* datetimes in the site zone ("2026-08-23 09:36:00").
 *    `new Date(naive)` parses them as **browser**-local, so a till (or a screenshot runner) in
 *    another zone silently re-labelled site wall-clock time as its own.
 *  - Anything built from `new Date()` (the dashboard top bar, the warehouse wall clock) showed
 *    the *browser's* zone, which on a head-office laptop abroad is not the shop's clock.
 *
 * The rule here: a naive server timestamp is interpreted as site-zone wall time; an absolute one
 * (`…+01:00` / `…Z`, e.g. `maison_pos.utils.iso_with_tz`) is converted; everything renders with
 * `timeZone` pinned to the site zone, and user-facing clocks carry the zone abbreviation so two
 * screens side by side can be told apart at a glance.
 */

const NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/

let zone: string | null = null

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function usable(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Set once from the bootstrap (boutique / site) — an unknown zone falls back to the browser's. */
export function setSiteTimeZone(tz: string | null | undefined): void {
  zone = usable(tz) ? tz : null
}

/** The zone every user-facing clock renders in. */
export function siteTimeZone(): string {
  return zone || browserZone()
}

/** True when the site zone was set explicitly (tests / labels). */
export function hasSiteTimeZone(): boolean {
  return zone !== null
}

const partsFmt = new Map<string, Intl.DateTimeFormat>()
function offsetFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    partsFmt.set(tz, f)
  }
  return f
}

/** Offset of `tz` at the instant `ts` (ms east of UTC). */
function tzOffset(ts: number, tz: string): number {
  const p = offsetFormatter(tz).formatToParts(new Date(ts))
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value)
  // `hour: '2-digit'` with hour12:false renders midnight as 24 in some engines
  const hour = get('hour') % 24
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return asUTC - Math.floor(ts / 1000) * 1000
}

/** Wall-clock fields in `tz` → epoch ms (DST-safe: re-checks the offset at the candidate instant). */
function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const first = tzOffset(guess, tz)
  const ts = guess - first
  const second = tzOffset(ts, tz)
  return second === first ? ts : guess - second
}

/**
 * Parse a server timestamp. Naive strings are site-zone wall time; strings carrying a zone
 * (and `Date` objects) are absolute. Returns `null` for anything unparsable.
 */
export function parseServer(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (NAIVE.test(raw)) {
    const [datePart, timePart] = raw.replace(' ', 'T').split('T')
    const [y, mo, d] = datePart.split('-').map(Number)
    const [h, mi, s] = timePart.split(':').map((n) => Math.trunc(Number(n)))
    const ts = wallToEpoch(y, mo, d, h || 0, mi || 0, s || 0, siteTimeZone())
    return Number.isNaN(ts) ? null : new Date(ts)
  }
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Format an instant in the site zone. `Intl` throws on an invalid date — callers get `null` first. */
export function formatInSiteZone(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: siteTimeZone(), ...opts }).format(d)
}

/** "CDT" / "GMT+2" — the zone abbreviation, for labelling a clock. */
export function zoneLabel(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: siteTimeZone(), timeZoneName: 'short' }).formatToParts(at)
  return parts.find((p) => p.type === 'timeZoneName')?.value || ''
}

/** `09:42` (24h) in the site zone. */
export function clockHM(at: Date = new Date()): string {
  return formatInSiteZone(at, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** `09:42:41` (24h) in the site zone. */
export function clockHMS(at: Date = new Date()): string {
  return formatInSiteZone(at, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/**
 * --- v0.8 POS D2 — a timestamp a Frappe Datetime column will actually take ---
 *
 * Frappe stores naive site-zone datetimes (`2026-08-23 14:39:08`). `Date.toISOString()` produces
 * `2026-08-23T19:39:08.269Z`, which MariaDB refuses outright (*Incorrect datetime value*) — that
 * is what made every offline sale of an age-restricted item unsyncable. Send the site's wall
 * clock in the server's own format instead; the server normalises whatever it receives too
 * (`maison_pos.api.age._checked_at`), so a till on an old bundle still syncs.
 * --- end v0.8 POS D2 ---
 */
export function serverDateTime(at: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: siteTimeZone(),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(at)
  const get = (t: string) => p.find((x) => x.type === t)?.value || '00'
  // `hour: '2-digit'` with hour12:false renders midnight as 24 in some engines
  const hour = String(Number(get('hour')) % 24).padStart(2, '0')
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`
}
