const money0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const money2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const int = new Intl.NumberFormat('en-US')

export const fmtMoney = (n: number) => money0.format(Math.round(n))
export const fmtMoney2 = (n: number) => money2.format(n)
export const fmtInt = (n: number) => int.format(Math.round(n))
export const fmtPct = (n: number) => `${Math.round(n)}%`

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function fmtClock(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}

/** Compact money for axis labels: 12.5k, 1.2M */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}
