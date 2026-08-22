/** Round half away from zero to `places` decimals, tolerant of float noise (1.005 -> 1.01). */
export function round(n: number, places = 2): number {
  const f = Math.pow(10, places)
  const sign = n < 0 ? -1 : 1
  return (sign * Math.round(Math.abs(n) * f + 1e-9)) / f
}

export function fmtMoney(n: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 }).format(n || 0)
}

/** Plain number, e.g. 12,400.00 — used on the receipt where the currency symbol is in the header. */
export function fmtAmount(n: number): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n || 0))
}
