import { formatInSiteZone, parseServer, zoneLabel } from './time'

const money0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const money2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const int = new Intl.NumberFormat('en-US')

export const fmtMoney = (n: number) => money0.format(Math.round(n))
export const fmtMoney2 = (n: number) => money2.format(n)
export const fmtInt = (n: number) => int.format(Math.round(n))
export const fmtPct = (n: number) => `${Math.round(n)}%`

// v0.6 R — every clock below renders in the site zone (see ./time)
export function fmtTime(iso: string | null | undefined): string {
  const d = parseServer(iso)
  if (!d) return '—'
  return formatInSiteZone(d, { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function fmtClock(d: Date): string {
  return formatInSiteZone(d, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function fmtDate(d: Date): string {
  return formatInSiteZone(d, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
}

/** `2026-08-23 15:00 CDT` — a precompute / reconcile stamp that says which clock it is on. */
export function fmtStamp(value: string | number | Date | null | undefined): string {
  const d = parseServer(value)
  if (!d) return '—'
  return `${formatInSiteZone(d, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} ${zoneLabel(d)}`.trim()
}

/** `09:42:41 CDT` */
export function fmtClockZoned(d: Date): string {
  return `${fmtClock(d)} ${zoneLabel(d)}`.trim()
}

export function fmtHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}

/**
 * v0.6 R — a store's display name without the brand prefix every store repeats.
 *
 * Eleven stores named "CloudChaserz Montrose", "CloudChaserz Broken Arrow", … all truncated to the
 * identical "CloudChaser…" in the live table: the column spent its width on the one word that is
 * the same on every row and cut the word that identifies it. Falls back to the full name when the
 * prefix is all there is.
 */
export function storeShortName(storeName: string | null | undefined, brandName: string | null | undefined): string {
  const name = (storeName || '').trim()
  const brand = (brandName || '').trim()
  if (!name || !brand || !name.toLowerCase().startsWith(brand.toLowerCase())) return name
  const rest = name.slice(brand.length).replace(/^[\s—–-]+/, '').trim()
  return rest || name
}

/** Compact money for axis labels: 12.5k, 1.2M */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}
