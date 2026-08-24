/**
 * v0.8 QA D-1 — the hourly chart's window, derived from the data instead of hard-coded.
 *
 * `HourlyChart.vue` used to filter the 24 buckets to `09:00–21:00` and then reduce `peak` over
 * that slice only. On the day QA looked at, $512.73 of the chain's $597.38 was rung in the 04:00
 * bucket: 86 % of the money the KPI beside it announced was never drawn, the bars no longer
 * summed to the headline, and the chart labelled the day "PEAK 12:00 · 48" when the real peak was
 * 04:00 with $512.73. Over the seeded history 106 invoices ($3.0 k) fall outside that window —
 * a store that opens at 06:00 or closes at 23:00 had no hourly picture at all.
 *
 * The window now covers every hour that traded (plus the current hour, so "now" is always on the
 * chart), padded to a readable minimum, and `peak` is computed over the *whole* series so the
 * label can never disagree with the bars.
 */
export interface HourBucketLike {
  hour: number
  net: number
  invoices?: number
}

/** Hours are only ever 0–23. */
const clampHour = (h: number) => Math.min(23, Math.max(0, Math.round(h)))

/** A day with no sales still needs a shape: the hours a shop is usually open. */
export const DEFAULT_FROM = 9
export const DEFAULT_TO = 21
/** Fewer columns than this reads as a broken chart rather than a quiet day. */
export const MIN_SPAN = 8

export function hourWindow(
  hours: HourBucketLike[],
  currentHour?: number,
  from?: number,
  to?: number,
): { from: number; to: number } {
  const active = (hours || []).filter((h) => (h.net || 0) !== 0 || (h.invoices || 0) > 0).map((h) => clampHour(h.hour))
  let lo = from ?? (active.length ? Math.min(...active) : DEFAULT_FROM)
  let hi = to ?? (active.length ? Math.max(...active) : DEFAULT_TO)
  if (from === undefined && currentHour !== undefined && currentHour >= 0 && currentHour <= 23) {
    lo = Math.min(lo, clampHour(currentHour))
    hi = Math.max(hi, clampHour(currentHour))
  }
  lo = clampHour(lo)
  hi = clampHour(Math.max(hi, lo))
  // widen symmetrically until the chart has enough columns to read, without leaving the day
  while (hi - lo + 1 < MIN_SPAN && (lo > 0 || hi < 23)) {
    if (lo > 0) lo -= 1
    if (hi - lo + 1 < MIN_SPAN && hi < 23) hi += 1
  }
  return { from: lo, to: hi }
}

/** The buckets the chart draws, in hour order, every hour of the window present. */
export function visibleHours<T extends HourBucketLike>(hours: T[], window: { from: number; to: number }): T[] {
  const byHour = new Map<number, T>()
  for (const h of hours || []) byHour.set(clampHour(h.hour), h)
  const out: T[] = []
  for (let h = window.from; h <= window.to; h++) {
    out.push(byHour.get(h) ?? ({ hour: h, net: 0, invoices: 0 } as unknown as T))
  }
  return out
}

/**
 * The busiest hour of the *whole* series, or `null` when nothing was sold — a store with no sales
 * used to report "PEAK 09:00 · 0" (D-22).
 */
export function peakHour<T extends HourBucketLike>(hours: T[]): T | null {
  let best: T | null = null
  for (const h of hours || []) {
    if ((h.net || 0) <= 0) continue
    if (!best || h.net > best.net) best = h
  }
  return best
}
