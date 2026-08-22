import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchLiveSummary, MOCK } from '../api'
import { addSaleToHours, applySale, computeTotals, deriveStatus, emptyHours, pct, sortByNet } from '../lib/aggregate'
import { connectRealtime } from '../realtime'
import type { BoutiqueRow, HeartbeatEvent, HourBucket, SaleEvent } from '../types'

export const FEED_SIZE = 12

/** Frappe returns "YYYY-MM-DD HH:MM:SS.ffffff" (no zone); make it parseable everywhere. */
function isoish(v: unknown): string {
  if (typeof v !== 'string' || !v) return new Date().toISOString()
  return v.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1')
}

/**
 * Adapt the backend realtime payload (`maison_pos.utils.invoice_summary`: grand_total,
 * items as objects, customer_name, cash/card) to the dashboard's SaleEvent.
 * Cancellations arrive as docstatus 2 with the same shape; we negate them.
 */
export function normalizeSale(raw: unknown): SaleEvent {
  const r = (raw || {}) as Record<string, unknown>
  const sign = Number(r.docstatus) === 2 || r.event === 'maison_sale_cancelled' ? -1 : 1
  const num = (k: string) => (Number.isFinite(Number(r[k])) ? Number(r[k]) : 0)
  const net = r.net !== undefined ? num('net') : num('grand_total')
  const items = Array.isArray(r.items)
    ? (r.items as unknown[]).map((i) => (typeof i === 'string' ? i : String((i as Record<string, unknown>)?.item_name ?? (i as Record<string, unknown>)?.item_code ?? '')))
    : []
  return {
    invoice: String(r.invoice ?? ''),
    boutique: String(r.boutique ?? ''),
    boutique_name: r.boutique_name as string | undefined,
    posting_datetime: isoish(r.posting_datetime ?? r.ts),
    customer_name: r.customer_name as string | undefined,
    tier: (r.tier as string | undefined) ?? undefined,
    items,
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

export const useDashboard = defineStore('dashboard', () => {
  const rows = ref<BoutiqueRow[]>([])
  const hours = ref<HourBucket[]>(emptyHours())
  const feed = ref<SaleEvent[]>([])
  const pendingApprovals = ref(0)
  const connected = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)
  const now = ref(Date.now())
  /** boutique code -> timestamp of last sale flash */
  const flash = ref<Record<string, number>>({})

  const totals = computed(() => computeTotals(rows.value))
  const cardPct = computed(() => pct(totals.value.card, totals.value.net))
  const cashPct = computed(() => pct(totals.value.cash, totals.value.net))
  const sorted = computed(() =>
    sortByNet(
      rows.value.map((r) => ({
        ...r,
        status: deriveStatus(r.last_seen, now.value, r.pending_approvals ?? 0),
      })),
    ),
  )

  function onSale(raw: SaleEvent) {
    const s = normalizeSale(raw)
    if (!s.invoice || feed.value.some((f) => f.invoice === s.invoice && f.net === s.net)) return
    rows.value = applySale(rows.value, s)
    hours.value = addSaleToHours(hours.value, s)
    feed.value = [s, ...feed.value].slice(0, FEED_SIZE)
    flash.value = { ...flash.value, [s.boutique]: Date.now() }
    window.setTimeout(() => {
      if (flash.value[s.boutique] && Date.now() - flash.value[s.boutique]! >= 1400) {
        const { [s.boutique]: _drop, ...rest } = flash.value
        flash.value = rest
      }
    }, 1500)
  }

  function onHeartbeat(raw: HeartbeatEvent) {
    const h = normalizeHeartbeat(raw)
    const i = rows.value.findIndex((r) => r.boutique === h.boutique)
    if (i === -1) return
    const r = rows.value[i]!
    rows.value = rows.value.map((x, j) =>
      j === i
        ? {
            ...x,
            last_seen: h.ts ?? new Date().toISOString(),
            queued: h.queued ?? 0,
            pending_approvals: h.pending_approvals ?? r.pending_approvals,
          }
        : x,
    )
  }

  async function load() {
    try {
      const s = await fetchLiveSummary()
      rows.value = s.by_boutique
      hours.value = s.by_hour.length === 24 ? s.by_hour : emptyHours()
      pendingApprovals.value = s.pending_approvals
      const recent = (s as unknown as { recent?: SaleEvent[] }).recent
      if (recent) feed.value = [...recent].reverse().slice(0, FEED_SIZE)
      error.value = null
      loaded.value = true
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  let stop: (() => void) | null = null
  let tick: number | undefined
  let refresh: number | undefined

  async function start() {
    await load()
    tick = window.setInterval(() => (now.value = Date.now()), 1000)
    if (MOCK) {
      const { startMockStream } = await import('../mock')
      stop = startMockStream(onSale, onHeartbeat)
      connected.value = true
    } else {
      stop = connectRealtime({ onSale, onHeartbeat, onConnection: (c) => (connected.value = c) })
      refresh = window.setInterval(load, 5 * 60_000) // reconcile with server periodically
    }
  }

  function dispose() {
    stop?.()
    clearInterval(tick)
    clearInterval(refresh)
  }

  const pendingTotal = computed(() => {
    const fromRows = rows.value.reduce((a, r) => a + (r.pending_approvals ?? 0), 0)
    return Math.max(pendingApprovals.value, fromRows)
  })

  return {
    rows, hours, feed, connected, loaded, error, now, flash,
    totals, cardPct, cashPct, sorted, pendingTotal,
    onSale, onHeartbeat, load, start, dispose,
  }
})
