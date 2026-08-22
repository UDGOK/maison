import type { BoutiqueRow, BoutiqueStatus, HourBucket, SaleEvent, Totals } from '../types'

/** A boutique whose last heartbeat is older than this is considered offline. */
export const OFFLINE_AFTER_MS = 120_000

/** Derive status from the last heartbeat age and pending price approvals. */
export function deriveStatus(
  lastSeen: string | Date | null | undefined,
  now: number | Date = Date.now(),
  pendingApprovals = 0,
): BoutiqueStatus {
  const nowMs = typeof now === 'number' ? now : now.getTime()
  if (!lastSeen) return 'offline'
  const seen = typeof lastSeen === 'string' ? Date.parse(lastSeen) : lastSeen.getTime()
  if (Number.isNaN(seen) || nowMs - seen > OFFLINE_AFTER_MS) return 'offline'
  return pendingApprovals > 0 ? 'pending_approval' : 'online'
}

/** 24 empty buckets. */
export function emptyHours(): HourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, net: 0, invoices: 0 }))
}

/** Local hour of an ISO datetime. */
export function hourOf(iso: string): number {
  return new Date(iso).getHours()
}

/** Bucket sales by local hour of posting_datetime. Always returns 24 buckets. */
export function bucketByHour(sales: Pick<SaleEvent, 'posting_datetime' | 'net'>[]): HourBucket[] {
  const buckets = emptyHours()
  for (const s of sales) {
    const b = buckets[hourOf(s.posting_datetime)]
    if (!b) continue
    b.net += s.net
    b.invoices += 1
  }
  return buckets
}

/** Add one sale to a 24-bucket array in place (immutable copy returned). */
export function addSaleToHours(hours: HourBucket[], sale: Pick<SaleEvent, 'posting_datetime' | 'net'>): HourBucket[] {
  const next = hours.length === 24 ? hours.map((h) => ({ ...h })) : emptyHours()
  const b = next[hourOf(sale.posting_datetime)]
  if (b) {
    b.net += sale.net
    b.invoices += 1
  }
  return next
}

export function computeTotals(rows: Pick<BoutiqueRow, 'net' | 'cash' | 'card' | 'invoices'>[]): Totals {
  const t: Totals = rows.reduce<Totals>(
    (acc, r) => {
      acc.net += r.net
      acc.cash += r.cash
      acc.card += r.card
      acc.invoices += r.invoices
      return acc
    },
    { net: 0, cash: 0, card: 0, invoices: 0, avg_ticket: 0 },
  )
  t.avg_ticket = t.invoices ? t.net / t.invoices : 0
  return t
}

export function applySale(rows: BoutiqueRow[], sale: SaleEvent): BoutiqueRow[] {
  const i = rows.findIndex((r) => r.boutique === sale.boutique)
  if (i === -1) {
    return [
      ...rows,
      {
        boutique: sale.boutique,
        name: sale.boutique_name ?? sale.boutique,
        net: sale.net,
        cash: sale.cash,
        card: sale.card,
        invoices: 1,
        status: 'online',
        last_seen: sale.posting_datetime,
        last_sale: sale.posting_datetime,
      },
    ]
  }
  const r = rows[i]!
  const updated: BoutiqueRow = {
    ...r,
    net: r.net + sale.net,
    cash: r.cash + sale.cash,
    card: r.card + sale.card,
    invoices: r.invoices + 1,
    last_sale: sale.posting_datetime,
  }
  return rows.map((x, j) => (j === i ? updated : x))
}

export function sortByNet(rows: BoutiqueRow[]): BoutiqueRow[] {
  return [...rows].sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0
}
