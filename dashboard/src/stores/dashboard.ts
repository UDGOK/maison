import { defineStore } from 'pinia'
import { computed, ref, shallowRef, triggerRef } from 'vue'
import { fetchLiveSummary, fetchPeriodComparison, fetchReports, fetchTicker, MOCK } from '../api'
import {
  chainTotals,
  createAggState,
  deriveStatus,
  rankedBoutiques,
  reduceEvents,
  seedFromSummary,
  type AggState,
  type BoutiqueAgg,
  type LiveEvent,
  type LiveSortKey,
} from '../lib/aggregate'
import { createBatcher } from '../lib/batch'
import { connectRealtime } from '../realtime'
import type { BoutiqueRow, HeartbeatEvent, HourBucket, LowStockBlock, PeriodComparison, ReportLink, SaleEvent, TickerRow } from '../types'

export const FEED_SIZE = 12
/** Full reconcile with the server (everything else is incremental from socket events). */
export const RECONCILE_MS = 60_000
export const FLASH_MS = 1400

/** Frappe returns "YYYY-MM-DD HH:MM:SS.ffffff" (no zone); make it parseable everywhere. */
function isoish(v: unknown): string {
  if (typeof v !== 'string' || !v) return new Date().toISOString()
  return v.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1')
}

/**
 * Adapt the backend realtime payload (`maison_pos.utils.invoice_summary`: grand_total,
 * items as objects, customer_name, cash/card, top_item, tier) to the dashboard's SaleEvent.
 * Cancellations arrive as docstatus 2 with the same shape; we negate them.
 */
export function normalizeSale(raw: unknown): SaleEvent {
  const r = (raw || {}) as Record<string, unknown>
  const sign = Number(r.docstatus) === 2 || r.event === 'awanz_sale_cancelled' ? -1 : 1
  const num = (k: string) => (Number.isFinite(Number(r[k])) ? Number(r[k]) : 0)
  const net = r.net !== undefined ? num('net') : r.amount !== undefined ? num('amount') : num('grand_total')
  const items = Array.isArray(r.items)
    ? (r.items as unknown[]).map((i) => (typeof i === 'string' ? i : String((i as Record<string, unknown>)?.item_name ?? (i as Record<string, unknown>)?.item_code ?? '')))
    : []
  const isReturn = Boolean(Number(r.is_return)) || sign * net < 0
  return {
    invoice: String(r.invoice ?? ''),
    boutique: String(r.boutique ?? ''),
    boutique_name: r.boutique_name as string | undefined,
    posting_datetime: isoish(r.posting_datetime ?? r.ts),
    customer_name: r.customer_name as string | undefined,
    tier: (r.tier as string | undefined) ?? undefined,
    items,
    top_item: (r.top_item as string | undefined) ?? items[0] ?? null,
    is_return: isReturn,
    net: sign * net,
    cash: sign * num('cash'),
    card: sign * num('card'),
  }
}

function normalizeHeartbeat(raw: unknown): HeartbeatEvent {
  const r = (raw || {}) as Record<string, unknown>
  return {
    boutique: String(r.boutique ?? ''),
    device_id: String(r.device_id ?? ''),
    queued: Number(r.queued) || 0,
    pending_approvals: r.pending_approvals as number | undefined,
    ts: isoish(r.ts ?? r.last_seen),
  }
}

export function tickerToSale(t: TickerRow): SaleEvent {
  return { invoice: t.invoice, boutique: t.boutique, posting_datetime: isoish(t.ts), tier: t.tier ?? undefined, items: t.top_item ? [t.top_item] : [], top_item: t.top_item, is_return: !!t.is_return, net: t.amount, cash: 0, card: t.amount }
}

export const useDashboard = defineStore('dashboard', () => {
  /** Incremental aggregates — a shallowRef; `version` bumps trigger re-render once per batch. */
  const agg = shallowRef<AggState>(createAggState())
  const version = ref(0)
  const regions = ref<string[]>([])
  const pendingApprovals = ref(0)
  /** v0.4 D/E/F */
  const lowStock = ref<LowStockBlock>({ open: 0, by_boutique: {}, top: [] })
  const returnsToday = ref<{ count: number; value: number }>({ count: 0, value: 0 })
  const reports = ref<ReportLink[]>([])
  const periods = ref<PeriodComparison | null>(null)
  const connected = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)
  const now = ref(Date.now())
  const lastReconcile = ref<number>(0)
  /** Live tab controls */
  const region = ref<string | null>(null)
  const query = ref('')
  const sort = ref<LiveSortKey>('net')
  const selected = ref<string | null>(null)

  // --- derived -------------------------------------------------------------------------
  const totals = computed(() => {
    void version.value
    return chainTotals(agg.value)
  })
  /**
   * v0.6 R — card / cash as a share of **gross tender volume**, not a signed share of net.
   *
   * The old `card / net` reads correctly only on a day that is all sales. A store whose day so far
   * is returns (card −317, cash 804, net 513) produced "−62% / 157%": two numbers that are each
   * wrong, do not sum to 100, and overflowed their cell. Worse, a net of exactly 0 (sales cancelled
   * out by returns) printed "0% / 0%" while money had plainly moved both ways.
   *
   * Gross volume — |card| + |cash| — is the money that actually crossed the counter in either
   * direction, so the split always reads 0–100 %, always sums to 100, and answers the question the
   * tile is really asking ("how do people pay here?") identically on a selling day and on a
   * returns day. The signed amounts stay in the sub-line underneath, where the direction matters.
   */
  const tenderGross = computed(() => Math.abs(totals.value.card) + Math.abs(totals.value.cash))
  const cardPct = computed(() => (tenderGross.value > 0 ? (Math.abs(totals.value.card) / tenderGross.value) * 100 : 0))
  const cashPct = computed(() => (tenderGross.value > 0 ? (Math.abs(totals.value.cash) / tenderGross.value) * 100 : 0))
  // NB: the reducer mutates arrays in place; computeds must return fresh references, otherwise
  // Vue ≥ 3.4 sees an unchanged value and skips notifying the template.
  const hours = computed<HourBucket[]>(() => {
    void version.value
    return agg.value.hours.slice()
  })
  const ranked = computed<BoutiqueAgg[]>(() => {
    void version.value
    // shallow copies so child components see changed props (the reducer mutates rows in place)
    return rankedBoutiques(agg.value, { region: region.value, q: query.value, sort: sort.value }).map((b) => ({ ...b }))
  })
  const ticker = computed<SaleEvent[]>(() => {
    void version.value
    return agg.value.ticker.slice()
  })
  const feed = computed<SaleEvent[]>(() => ticker.value.slice(0, FEED_SIZE))
  const selectedRow = computed<BoutiqueAgg | null>(() => {
    void version.value
    const b = selected.value ? agg.value.rows.get(selected.value) : null
    return b ? { ...b, feed: b.feed.slice(), by_hour: b.by_hour.slice() } : null
  })
  /** Legacy shape for components that still take BoutiqueRow[] (Boutiques table, tests). */
  const rows = computed<BoutiqueRow[]>(() => ranked.value.map(toRow))
  const sorted = computed<BoutiqueRow[]>(() =>
    rows.value.map((r) => ({ ...r, status: deriveStatus(r.last_seen, now.value, r.pending_approvals ?? 0, r.queued ?? 0) })),
  )
  const flash = computed<Record<string, number>>(() => {
    void version.value
    void now.value
    const out: Record<string, number> = {}
    const t = Date.now()
    for (const b of agg.value.rows.values()) if (b.flash && t - b.flash < FLASH_MS) out[b.boutique] = b.flash
    return out
  })
  const pendingTotal = computed(() => Math.max(pendingApprovals.value, totals.value.pending_approvals))

  function toRow(b: BoutiqueAgg): BoutiqueRow {
    return {
      boutique: b.boutique,
      name: b.name,
      region: b.region,
      net: b.net,
      cash: b.cash,
      card: b.card,
      invoices: b.invoices,
      returns: b.returns,
      status: 'offline',
      last_seen: b.last_seen,
      queued: b.queued,
      pending_approvals: b.pending_approvals,
      last_sale: b.last_sale,
      vs_last_week_pct: b.vs_last_week_pct,
      low_stock: b.low_stock,
      avg_ticket: b.avg_ticket,
    }
  }

  function bump() {
    version.value = agg.value.version
    triggerRef(agg)
  }

  // --- realtime: rAF-batched, folded incrementally ------------------------------------------
  const batcher = createBatcher<LiveEvent>((events) => {
    const res = reduceEvents(agg.value, events)
    if (res.applied) {
      bump()
      if (res.sales) scheduleFlashClear()
    }
  })
  let flashTimer: number | undefined
  function scheduleFlashClear() {
    if (flashTimer) return
    flashTimer = window.setTimeout(() => {
      flashTimer = undefined
      now.value = Date.now()
    }, FLASH_MS + 50)
  }

  function onSale(raw: SaleEvent) {
    const s = normalizeSale(raw)
    if (!s.invoice || !s.boutique) return
    batcher.push({ kind: 'sale', sale: s })
  }

  function onHeartbeat(raw: HeartbeatEvent) {
    const h = normalizeHeartbeat(raw)
    if (!h.boutique) return
    batcher.push({ kind: 'heartbeat', heartbeat: { boutique: h.boutique, ts: h.ts, queued: h.queued, pending_approvals: h.pending_approvals } })
  }

  /** Push a batch synchronously (tests / mock stream). */
  function applyNow(events: LiveEvent[]) {
    const res = reduceEvents(agg.value, events)
    if (res.applied) bump()
    return res
  }

  // --- loading --------------------------------------------------------------------------------
  async function load() {
    try {
      const [s, t] = await Promise.all([fetchLiveSummary(), fetchTicker(10).catch(() => [] as TickerRow[])])
      batcher.flush()
      seedFromSummary(agg.value, s.by_boutique, s.by_hour.length === 24 ? s.by_hour : undefined)
      if (!agg.value.ticker.length) {
        const recent = (s as unknown as { recent?: SaleEvent[] }).recent
        if (t.length) agg.value.ticker = t.map(tickerToSale)
        else if (recent) agg.value.ticker = [...recent].reverse().slice(0, 10)
      }
      regions.value = s.regions ?? [...new Set(s.by_boutique.map((b) => b.region ?? '—'))].sort()
      pendingApprovals.value = s.pending_approvals
      if (s.low_stock) lowStock.value = s.low_stock
      if (s.returns) returnsToday.value = s.returns
      lastReconcile.value = Date.now()
      error.value = null
      loaded.value = true
      bump()
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  let stop: (() => void) | null = null
  let tick: number | undefined
  let refresh: number | undefined

  async function loadInsights() {
    try {
      const [r, p] = await Promise.all([fetchReports(), fetchPeriodComparison()])
      reports.value = r
      periods.value = p
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  async function start() {
    await load()
    void loadInsights()
    tick = window.setInterval(() => (now.value = Date.now()), 1000)
    if (MOCK) {
      const { startMockStream } = await import('../mock')
      stop = startMockStream(onSale, onHeartbeat)
      connected.value = true
    } else {
      let wasConnected = false
      stop = connectRealtime({
        onSale,
        onHeartbeat,
        onConnection: (c) => {
          connected.value = c
          // reconnect → full refetch (events may have been missed while away)
          if (c && wasConnected) void load()
          if (c) wasConnected = true
        },
      })
      refresh = window.setInterval(() => void load(), RECONCILE_MS)
    }
  }

  function dispose() {
    stop?.()
    batcher.dispose()
    clearInterval(tick)
    clearInterval(refresh)
    clearTimeout(flashTimer)
  }

  function select(code: string | null) {
    selected.value = selected.value === code ? null : code
  }

  return {
    agg, version, regions, region, query, sort, selected, selectedRow,
    rows, sorted, ranked, ticker, feed, hours, connected, loaded, error, now, flash, lastReconcile,
    totals, cardPct, cashPct, pendingTotal,
    lowStock, returnsToday, reports, periods,
    onSale, onHeartbeat, applyNow, load, loadInsights, start, dispose, select,
  }
})
