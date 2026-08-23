import { v4 as uuidv4 } from 'uuid'

const KEY = 'maison.device_id'

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
 */
const NO_DATE = '—'

function toDate(iso: string | Date | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null
}

export function fmtDateTime(iso: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = toDate(iso)
  if (!d) return NO_DATE
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...opts
  }).format(d)
}

export function fmtDate(iso: string | Date | null | undefined): string {
  const d = toDate(iso)
  if (!d) return NO_DATE
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: '2-digit' }).format(d)
}

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
