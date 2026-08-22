<script setup lang="ts">
/**
 * Boutiques tab — sortable table: net today / WTD / MTD, vs LW, tickets, avg ticket, conversion,
 * returns %, stock value, low-stock, on shift, status, 14-day sparkline. Click a row → drill-in.
 */
import { computed, onMounted, ref } from 'vue'
import Sparkline from '../Sparkline.vue'
import StatusPill from '../StatusPill.vue'
import VirtualList from '../VirtualList.vue'
import { fetchBoutiquesTable } from '../../api'
import { deriveStatus } from '../../lib/aggregate'
import { fmtCompact, fmtInt, fmtMoney, fmtPct } from '../../lib/format'
import { useDashboard } from '../../stores/dashboard'
import type { BoutiqueTableRow } from '../../types'

defineEmits<{ open: [code: string] }>()
const d = useDashboard()
const rows = ref<BoutiqueTableRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
type Col = { k: keyof BoutiqueTableRow | 'status'; l: string; num?: boolean; fmt?: (r: BoutiqueTableRow) => string; w: string }
const cols: Col[] = [
  { k: 'boutique', l: 'Boutique', w: 'minmax(0, 1.6fr)' },
  { k: 'net', l: 'Net today', num: true, fmt: (r) => fmtMoney(live(r).net), w: '1fr' },
  { k: 'vs_last_week_pct', l: 'vs LW', num: true, fmt: (r) => pctLabel(live(r).vs_last_week_pct), w: '0.6fr' },
  { k: 'wtd_net', l: 'WTD', num: true, fmt: (r) => fmtCompact(r.wtd_net), w: '0.7fr' },
  { k: 'wtd_vs_lw_pct', l: 'WTD vs LW', num: true, fmt: (r) => pctLabel(r.wtd_vs_lw_pct), w: '0.7fr' },
  { k: 'mtd_net', l: 'MTD', num: true, fmt: (r) => fmtCompact(r.mtd_net), w: '0.7fr' },
  { k: 'invoices', l: 'Tickets', num: true, fmt: (r) => fmtInt(live(r).invoices), w: '0.5fr' },
  { k: 'avg_ticket', l: 'Avg ticket', num: true, fmt: (r) => fmtMoney(live(r).avg_ticket), w: '0.7fr' },
  { k: 'mtd_conversion', l: 'Conv.', num: true, fmt: (r) => fmtPct(r.mtd_conversion * 100), w: '0.5fr' },
  { k: 'returns_pct', l: 'Returns', num: true, fmt: (r) => `${r.returns_pct.toFixed(1)}%`, w: '0.5fr' },
  { k: 'stock_value', l: 'Stock', num: true, fmt: (r) => fmtCompact(r.stock_value), w: '0.6fr' },
  { k: 'low_stock', l: 'Low', num: true, fmt: (r) => fmtInt(r.low_stock ?? 0), w: '0.4fr' },
  { k: 'on_shift', l: 'On shift', num: true, fmt: (r) => fmtInt(r.on_shift), w: '0.5fr' },
  { k: 'status', l: 'Status', w: '9rem' },
  { k: 'sparkline', l: '14 d', w: '8rem' },
]
const sortKey = ref<Col['k']>('net')
const sortDir = ref<1 | -1>(-1)
function setSort(k: Col['k']) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 1 ? -1 : 1
  else {
    sortKey.value = k
    sortDir.value = k === 'boutique' ? 1 : -1
  }
}
/** today's columns come from the live aggregates (socket-updated), the rest from the table fetch */
function live(r: BoutiqueTableRow) {
  const a = d.agg.rows.get(r.boutique)
  return a ? { net: a.net, invoices: a.invoices, avg_ticket: a.avg_ticket, vs_last_week_pct: a.vs_last_week_pct, last_seen: a.last_seen, queued: a.queued, pending: a.pending_approvals } : { net: r.net, invoices: r.invoices, avg_ticket: r.avg_ticket ?? 0, vs_last_week_pct: r.vs_last_week_pct ?? null, last_seen: r.last_seen, queued: r.queued ?? 0, pending: r.pending_approvals ?? 0 }
}
function pctLabel(p: number | null | undefined) {
  return p === null || p === undefined ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%`
}
function valueOf(r: BoutiqueTableRow, k: Col['k']): number | string {
  void d.version
  if (k === 'status') return deriveStatus(live(r).last_seen, d.now, live(r).pending, live(r).queued)
  if (k === 'net' || k === 'invoices' || k === 'avg_ticket' || k === 'vs_last_week_pct') return live(r)[k] ?? -Infinity
  if (k === 'sparkline') return r.sparkline.reduce((a, b) => a + b, 0)
  const v = r[k]
  return v === null || v === undefined ? -Infinity : (v as number | string)
}
const sorted = computed(() => {
  void d.version
  const k = sortKey.value
  const dir = sortDir.value
  return [...rows.value].sort((a, b) => {
    const va = valueOf(a, k)
    const vb = valueOf(b, k)
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * dir
    return ((va as number) - (vb as number)) * dir || a.boutique.localeCompare(b.boutique)
  })
})
const template = computed(() => cols.map((c) => c.w).join(' '))
const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 15
const rowHeight = Math.round(3.733 * remPx)

async function load() {
  loading.value = true
  try {
    rows.value = (await fetchBoutiquesTable()).rows
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)
const keyOf = (r: BoutiqueTableRow) => r.boutique
</script>

<template>
  <div class="boutiques">
    <header class="toolbar">
      <span class="label">Boutiques</span>
      <span class="label count">{{ rows.length }} · sorted by {{ cols.find((c) => c.k === sortKey)?.l }} {{ sortDir === -1 ? '↓' : '↑' }}</span>
      <span v-if="error" class="label err">{{ error }}</span>
      <button class="btn" @click="load">Refresh</button>
    </header>
    <div class="hdr row" :style="{ gridTemplateColumns: template }">
      <button v-for="c in cols" :key="c.k" class="th label" :class="{ r: c.num, on: sortKey === c.k }" :data-sort="c.k" @click="setSort(c.k)">
        {{ c.l }}<span v-if="sortKey === c.k" class="arrow">{{ sortDir === -1 ? '↓' : '↑' }}</span>
      </button>
    </div>
    <VirtualList class="body" :items="sorted" :row-height="rowHeight" :key-of="keyOf" data-testid="boutiques-table">
      <template #default="{ item: r }">
        <div class="row data" :style="{ gridTemplateColumns: template }" :data-boutique="r.boutique" @click="$emit('open', r.boutique)">
          <span class="name"><span class="display code">{{ r.boutique }}</span><span class="city">{{ r.name }}</span></span>
          <template v-for="c in cols.slice(1)" :key="c.k">
            <span v-if="c.k === 'status'"><StatusPill :status="deriveStatus(live(r).last_seen, d.now, live(r).pending, live(r).queued)" :queued="live(r).queued" /></span>
            <span v-else-if="c.k === 'sparkline'" class="spark"><Sparkline :values="r.sparkline" :width="110" :height="26" /></span>
            <span v-else class="num r" :class="{ vs: c.k === 'vs_last_week_pct' || c.k === 'wtd_vs_lw_pct', up: (c.k === 'vs_last_week_pct' ? live(r).vs_last_week_pct ?? 0 : c.k === 'wtd_vs_lw_pct' ? r.wtd_vs_lw_pct ?? 0 : 0) > 0, down: (c.k === 'vs_last_week_pct' ? live(r).vs_last_week_pct ?? 0 : c.k === 'wtd_vs_lw_pct' ? r.wtd_vs_lw_pct ?? 0 : 0) < 0, strong: c.k === 'net', warn: (c.k === 'low_stock' && (r.low_stock ?? 0) > 0) || (c.k === 'returns_pct' && r.returns_pct >= 10) }">{{ c.fmt ? c.fmt(r) : String(r[c.k as keyof BoutiqueTableRow] ?? '') }}</span>
          </template>
        </div>
      </template>
    </VirtualList>
    <p v-if="loading" class="label loading">Loading…</p>
  </div>
</template>

<style scoped>
.boutiques { display: grid; grid-template-rows: auto auto 1fr; min-height: 0; height: 100%; }
.toolbar { display: flex; align-items: center; gap: 1rem; padding: 0.8rem var(--pad-x); border-bottom: 1px solid var(--line); }
.count { color: var(--muted); }
.toolbar .btn { margin-left: auto; }
.err { color: var(--crit); }
.row { display: grid; align-items: center; gap: 0.8rem; padding: 0 var(--pad-x); }
.hdr { border-bottom: 1px solid var(--line); height: 2.4rem; }
.th { background: none; border: 0; padding: 0; cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.th.r { text-align: right; }
.th.on { color: var(--accent); }
.arrow { margin-left: 0.3rem; }
.body { min-height: 0; }
.data { height: 100%; border-bottom: 1px solid var(--line); font-size: var(--fs-num); cursor: pointer; }
.data:hover { background: var(--surface); }
.name { display: flex; align-items: baseline; gap: 0.8rem; min-width: 0; }
.code { font-size: var(--fs-small); font-weight: 800; letter-spacing: 0.04em; white-space: nowrap; }
.city { color: var(--muted); font-weight: 300; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.strong { font-family: var(--display); font-weight: 800; font-size: var(--fs-lead); letter-spacing: -0.02em; }
.vs { font-size: var(--fs-small); }
.warn { color: var(--warn); }
.spark { display: flex; justify-content: flex-end; }
.loading { padding: 1rem var(--pad-x); }
</style>
