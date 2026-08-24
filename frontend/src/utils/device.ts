import { v4 as uuidv4 } from 'uuid'
import { formatInSiteZone, parseServer, siteTimeZone, zoneLabel } from './time'

const KEY = 'awanz.device_id'

/** Stable per-device id (persisted in localStorage). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = 'dev-' + uuidv4().slice(0, 8)
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return 'dev-unknown'
  }
}

/**
 * `Intl.DateTimeFormat.format()` throws `RangeError: Invalid time value` on an Invalid Date, and a
 * throw inside a template blanks the whole screen (a null / empty / unparsable timestamp on one row
 * of a returns lookup took out the entire Returns view). Missing or unreadable dates render as an
 * em dash instead.
 *
 * v0.6 R — every timestamp renders in the **site timezone** (see `@/utils/time`): naive Frappe
 * datetimes are site-local wall time and used to be re-labelled as the browser's zone.
 */
const NO_DATE = '—'

function toDate(iso: string | Date | null | undefined): Date | null {
  return parseServer(iso)
}

export function fmtDateTime(iso: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = toDate(iso)
  if (!d) return NO_DATE
  return formatInSiteZone(d, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...opts
  })
}

export function fmtDate(iso: string | Date | null | undefined): string {
  const d = toDate(iso)
  if (!d) return NO_DATE
  return formatInSiteZone(d, { year: 'numeric', month: 'short', day: '2-digit' })
}

/** `Aug 23, 2026, 09:42 CDT` — a timestamp that has to be unambiguous next to another screen. */
export function fmtDateTimeZoned(iso: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = toDate(iso)
  if (!d) return NO_DATE
  return `${fmtDateTime(d, opts)} ${zoneLabel(d)}`.trim()
}

/** Today's date in the **site** zone (`YYYY-MM-DD`) — a till just past midnight in another zone
 *  used to ask the server for yesterday's shift. */
export function todayISO(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: siteTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const get = (t: string) => p.find((x) => x.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
