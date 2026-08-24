import type { BoutiqueRow, BoutiqueStatus, HourBucket, SaleEvent, Totals } from '../types'

/** A boutique whose last heartbeat is older than this is considered offline. */
export const OFFLINE_AFTER_MS = 120_000

/** Derive status from the last heartbeat age and pending price approvals. */
export function deriveStatus(
  lastSeen: string | Date | null | undefined,
  now: number | Date = Date.now(),
  pendingApprovals = 0,
  queued = 0,
): BoutiqueStatus {
  const nowMs = typeof now === 'number' ? now : now.getTime()
  if (!lastSeen) return 'offline'
  const seen = typeof lastSeen === 'string' ? Date.parse(lastSeen) : lastSeen.getTime()
  if (Number.isNaN(seen) || nowMs - seen > OFFLINE_AFTER_MS) return 'offline'
  if (queued > 0) return 'queued'
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

export function computeTotals(rows: Pick<BoutiqueRow, 'net' | 'cash' | 'card' | 'invoices' | 'gross' | 'returns_value'>[]): Totals {
  const t: Totals = rows.reduce<Totals>(
    (acc, r) => {
      acc.net += r.net
      acc.cash += r.cash
      acc.card += r.card
      acc.invoices += r.invoices
      acc.gross = (acc.gross ?? 0) + grossOf(r)
      return acc
    },
    { net: 0, cash: 0, card: 0, invoices: 0, avg_ticket: 0, gross: 0 },
  )
  // v0.8 QA D-4 — "avg ticket" is the average *sale*: returns excluded on both sides of the
  // division (dividing net-of-returns by a sales-only count is not an average of anything, and on
  // a returns-heavy day it read $19 where the average sale was $45).
  t.avg_ticket = t.invoices ? (t.gross ?? 0) / t.invoices : 0
  return t
}

/** Sales-only takings for a row: the server sends `gross`; older payloads are reconstructed. */
export function grossOf(r: Pick<BoutiqueRow, 'net' | 'gross' | 'returns_value'>): number {
  return r.gross ?? r.net + Math.abs(r.returns_value ?? 0)
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
        last_sale: { item: sale.top_item ?? null, amount: sale.net, ts: sale.posting_datetime, invoice: sale.invoice, is_return: sale.is_return ? 1 : 0 },
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
    last_sale: { item: sale.top_item ?? null, amount: sale.net, ts: sale.posting_datetime, invoice: sale.invoice, is_return: sale.is_return ? 1 : 0 },
  }
  return rows.map((x, j) => (j === i ? updated : x))
}

export function sortByNet(rows: BoutiqueRow[]): BoutiqueRow[] {
  return [...rows].sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0
}

// ---------------------------------------------------------------------------
// v0.5 L — incremental aggregation state for 40–100 boutiques
//
// The wall keeps one mutable record per boutique (a Map) and folds socket events into it in
// O(1) per event; a `version` counter lets Vue re-render only when a batch has been applied.
// Nothing is refetched on a sale — the full `live_summary` is reconciled every 60 s / on reconnect.
// ---------------------------------------------------------------------------
export interface LastSale {
  invoice?: string
  item: string | null
  amount: number
  ts: string
  is_return?: number
}

export interface BoutiqueAgg {
  boutique: string
  name: string
  region: string
  net: number
  cash: number
  card: number
  invoices: number
  returns: number
  returns_value: number
  /** sales only, returns excluded — the basis of `avg_ticket` (v0.8 QA D-4) */
  gross: number
  /** tender that is neither cash nor card: gift cards, store credit, the web tender (v0.8 QA D-12) */
  other_tender: number
  avg_ticket: number
  last_week_net: number
  vs_last_week_pct: number | null
  last_sale: LastSale | null
  last_seen: string | null
  queued: number
  pending_approvals: number
  low_stock: number
  feedback_open: number
  /** 24 net buckets for the boutique's own hourly bars */
  by_hour: number[]
  /** newest first, capped at FEED_PER_BOUTIQUE */
  feed: SaleEvent[]
  /** ms timestamp of the last sale flash (0 = none) */
  flash: number
}

export interface AggState {
  rows: Map<string, BoutiqueAgg>
  ticker: SaleEvent[]
  /** invoice ids already folded (dedupe on reconnect / double delivery) */
  seen: Set<string>
  hours: HourBucket[]
  version: number
}

export const FEED_PER_BOUTIQUE = 40
export const TICKER_SIZE = 10
const SEEN_CAP = 5000

export function createAggState(): AggState {
  return { rows: new Map(), ticker: [], seen: new Set(), hours: emptyHours(), version: 0 }
}

function blankAgg(code: string, name = code): BoutiqueAgg {
  return {
    boutique: code,
    name,
    region: '—',
    net: 0,
    cash: 0,
    card: 0,
    invoices: 0,
    returns: 0,
    returns_value: 0,
    gross: 0,
    other_tender: 0,
    avg_ticket: 0,
    last_week_net: 0,
    vs_last_week_pct: null,
    last_sale: null,
    last_seen: null,
    queued: 0,
    pending_approvals: 0,
    low_stock: 0,
    feedback_open: 0,
    by_hour: new Array(24).fill(0),
    feed: [],
    flash: 0,
  }
}

/** Replace the aggregates with a server snapshot (keeps per-boutique feeds + flash state). */
export function seedFromSummary(state: AggState, rows: BoutiqueRow[], hours?: HourBucket[]): AggState {
  const next = new Map<string, BoutiqueAgg>()
  for (const r of rows) {
    const prev = state.rows.get(r.boutique)
    next.set(r.boutique, {
      ...(prev ?? blankAgg(r.boutique, r.name)),
      boutique: r.boutique,
      name: r.name ?? r.boutique,
      region: r.region ?? prev?.region ?? '—',
      net: r.net,
      cash: r.cash,
      card: r.card,
      invoices: r.invoices,
      returns: r.returns ?? 0,
      returns_value: r.returns_value ?? 0,
      gross: grossOf(r),
      other_tender: r.other_tender ?? 0,
      avg_ticket: r.invoices ? grossOf(r) / r.invoices : 0,
      last_week_net: r.last_week_net ?? 0,
      vs_last_week_pct: r.vs_last_week_pct ?? ((r.last_week_net ?? 0) > 0 ? ((r.net - (r.last_week_net ?? 0)) / (r.last_week_net ?? 0)) * 100 : null),
      last_sale: r.last_sale ?? prev?.last_sale ?? null,
      last_seen: r.last_seen ?? null,
      queued: r.queued ?? 0,
      pending_approvals: r.pending_approvals ?? 0,
      low_stock: r.low_stock ?? 0,
      feedback_open: r.feedback_open ?? 0,
      by_hour: r.by_hour && r.by_hour.length === 24 ? [...r.by_hour] : (prev?.by_hour ?? new Array(24).fill(0)),
    })
  }
  state.rows = next
  if (hours && hours.length === 24) state.hours = hours.map((h) => ({ ...h }))
  state.version++
  return state
}

function remember(state: AggState, invoice: string): boolean {
  if (state.seen.has(invoice)) return false
  state.seen.add(invoice)
  if (state.seen.size > SEEN_CAP) {
    // drop the oldest half — Set iteration order is insertion order
    let n = 0
    for (const k of state.seen) {
      state.seen.delete(k)
      if (++n >= SEEN_CAP / 2) break
    }
  }
  return true
}

/** Fold one sale into the state. Returns false when the event was a duplicate. */
export function foldSale(state: AggState, s: SaleEvent, now = Date.now()): boolean {
  const key = `${s.invoice}:${s.net < 0 ? 'r' : 's'}`
  if (!s.invoice || !remember(state, key)) return false
  let b = state.rows.get(s.boutique)
  if (!b) {
    b = blankAgg(s.boutique, s.boutique_name ?? s.boutique)
    state.rows.set(s.boutique, b)
  }
  b.net += s.net
  b.cash += s.cash
  b.card += s.card
  if (s.is_return) {
    b.returns += 1
    b.returns_value += Math.abs(s.net)
  } else {
    b.invoices += 1
    b.gross += s.net // v0.8 QA D-4
  }
  b.avg_ticket = b.invoices ? b.gross / b.invoices : 0
  b.vs_last_week_pct = b.last_week_net > 0 ? ((b.net - b.last_week_net) / b.last_week_net) * 100 : null
  b.last_sale = { invoice: s.invoice, item: s.top_item ?? s.items[0] ?? null, amount: s.net, ts: s.posting_datetime, is_return: s.is_return ? 1 : 0 }
  b.last_seen = s.posting_datetime > (b.last_seen ?? '') ? s.posting_datetime : b.last_seen
  b.flash = now
  const h = hourOf(s.posting_datetime)
  if (h >= 0 && h < 24) {
    b.by_hour[h] = (b.by_hour[h] ?? 0) + s.net
    const bucket = state.hours[h]
    if (bucket) {
      bucket.net += s.net
      if (!s.is_return) bucket.invoices += 1
    }
  }
  b.feed.unshift(s)
  if (b.feed.length > FEED_PER_BOUTIQUE) b.feed.length = FEED_PER_BOUTIQUE
  state.ticker.unshift(s)
  if (state.ticker.length > TICKER_SIZE) state.ticker.length = TICKER_SIZE
  return true
}

export interface HeartbeatLike {
  boutique: string
  ts: string
  queued?: number
  pending_approvals?: number
}

export function foldHeartbeat(state: AggState, h: HeartbeatLike): boolean {
  const b = state.rows.get(h.boutique)
  if (!b) return false
  b.last_seen = h.ts
  b.queued = h.queued ?? 0
  if (h.pending_approvals !== undefined) b.pending_approvals = h.pending_approvals
  return true
}

export type LiveEvent = { kind: 'sale'; sale: SaleEvent } | { kind: 'heartbeat'; heartbeat: HeartbeatLike }

/**
 * Apply a batch of events (one animation frame's worth). Bumps `version` once per batch
 * so a reactive wrapper re-renders once, not once per event.
 */
export function reduceEvents(state: AggState, events: LiveEvent[], now = Date.now()): { applied: number; sales: number } {
  let applied = 0
  let sales = 0
  for (const e of events) {
    if (e.kind === 'sale') {
      if (foldSale(state, e.sale, now)) {
        applied++
        sales++
      }
    } else if (foldHeartbeat(state, e.heartbeat)) applied++
  }
  if (applied) state.version++
  return { applied, sales }
}

export function chainTotals(state: AggState): Totals & { gross: number; other_tender: number; returns: number; returns_value: number; last_week_net: number; vs_last_week_pct: number | null; low_stock: number; feedback_open: number; pending_approvals: number; online: number } {
  let net = 0
  let gross = 0
  let otherTender = 0
  let cash = 0
  let card = 0
  let invoices = 0
  let returns = 0
  let returns_value = 0
  let last_week_net = 0
  let low_stock = 0
  let feedback_open = 0
  let pending_approvals = 0
  let online = 0
  const now = Date.now()
  for (const b of state.rows.values()) {
    net += b.net
    gross += b.gross
    otherTender += b.other_tender
    cash += b.cash
    card += b.card
    invoices += b.invoices
    returns += b.returns
    returns_value += b.returns_value
    last_week_net += b.last_week_net
    low_stock += b.low_stock
    feedback_open += b.feedback_open
    pending_approvals += b.pending_approvals
    const st = deriveStatus(b.last_seen, now, b.pending_approvals, b.queued)
    if (st === 'online' || st === 'queued') online++
  }
  return {
    net,
    gross,
    other_tender: otherTender,
    cash,
    card,
    invoices,
    returns,
    returns_value,
    avg_ticket: invoices ? gross / invoices : 0, // v0.8 QA D-4 — the average sale
    last_week_net,
    vs_last_week_pct: last_week_net > 0 ? ((net - last_week_net) / last_week_net) * 100 : null,
    low_stock,
    feedback_open,
    pending_approvals,
    online,
  }
}

export type LiveSortKey = 'net' | 'vs_lw' | 'invoices' | 'last_sale' | 'name'

/** Ranked list for the live cards: region / search filter + sort, computed from the Map. */
export function rankedBoutiques(state: AggState, opts: { region?: string | null; q?: string; sort?: LiveSortKey } = {}): BoutiqueAgg[] {
  const q = (opts.q ?? '').trim().toLowerCase()
  const out: BoutiqueAgg[] = []
  for (const b of state.rows.values()) {
    if (opts.region && b.region !== opts.region) continue
    if (q && !b.boutique.toLowerCase().includes(q) && !b.name.toLowerCase().includes(q)) continue
    out.push(b)
  }
  const sort = opts.sort ?? 'net'
  out.sort((a, b) => {
    switch (sort) {
      case 'vs_lw':
        return (b.vs_last_week_pct ?? -Infinity) - (a.vs_last_week_pct ?? -Infinity) || b.net - a.net
      case 'invoices':
        return b.invoices - a.invoices || b.net - a.net
      case 'last_sale':
        return (b.last_sale?.ts ?? '').localeCompare(a.last_sale?.ts ?? '') || b.net - a.net
      case 'name':
        return a.name.localeCompare(b.name)
      default:
        return b.net - a.net || a.name.localeCompare(b.name)
    }
  })
  return out
}
