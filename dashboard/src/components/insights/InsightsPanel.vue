<script setup lang="ts">
/**
 * v0.4 H — "Insights" view of the head-office wall: weekly narrative, item-group × boutique
 * heatmap, top / slow movers, clients to contact, rebalance suggestions with one-click transfer.
 * Data comes from maison_pos.api.insights (computed by the Monday jobs; refreshed every 10 min).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import NarrativeCard from './NarrativeCard.vue'
import GroupHeatmap from './GroupHeatmap.vue'
import MoversTable from './MoversTable.vue'
import ContactList from './ContactList.vue'
import RebalanceList from './RebalanceList.vue'
import { fetchClientSignals, fetchInsightsSummary, fetchNarrative, fetchProductPerformance, fetchRebalanceSuggestions } from '../../insights/api'
import { fmtCompact, fmtInt } from '../../lib/format'
import type { ClientSignalsResult, InsightReport, InsightsSummary, ProductPerformance, RebalanceMove } from '../../insights/types'

const days = ref(90)
const perf = ref<ProductPerformance | null>(null)
const signals = ref<ClientSignalsResult | null>(null)
const moves = ref<RebalanceMove[]>([])
const report = ref<InsightReport | null>(null)
const summary = ref<InsightsSummary | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

async function load() {
  try {
    const [p, s, m, r, sm] = await Promise.all([
      fetchProductPerformance(days.value),
      fetchClientSignals(40),
      fetchRebalanceSuggestions(),
      fetchNarrative(),
      fetchInsightsSummary(),
    ])
    perf.value = p
    signals.value = s
    moves.value = m
    report.value = r
    summary.value = sm
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
async function reloadMoves() {
  moves.value = await fetchRebalanceSuggestions()
  summary.value = await fetchInsightsSummary()
}
function signalDone(name: string) {
  if (!signals.value) return
  const s = signals.value.signals.find((x) => x.name === name)
  signals.value = {
    ...signals.value,
    signals: signals.value.signals.filter((x) => x.name !== name),
    by_type: s ? { ...signals.value.by_type, [s.signal_type]: Math.max(0, (signals.value.by_type[s.signal_type] ?? 1) - 1) } : signals.value.by_type,
  }
  if (summary.value) summary.value = { ...summary.value, open_signals: Math.max(0, summary.value.open_signals - 1) }
}

let refresh: number | undefined
onMounted(() => {
  void load()
  refresh = window.setInterval(load, 10 * 60_000)
})
onBeforeUnmount(() => clearInterval(refresh))

const lastRun = computed(() => summary.value?.last_run?.computed_at?.slice(0, 16) ?? '—')
</script>

<template>
  <div class="insights">
    <section class="tiles">
      <div class="tile">
        <span class="label">Clients to contact</span>
        <span class="display v num">{{ fmtInt(summary?.open_signals ?? 0) }}</span>
      </div>
      <div class="tile">
        <span class="label">Rebalance moves</span>
        <span class="display v num">{{ fmtInt(summary?.open_rebalances ?? 0) }}</span>
      </div>
      <div class="tile">
        <span class="label">Stock-out risks</span>
        <span class="display v num" :class="{ warn: (perf?.totals.stock_out_risks ?? 0) > 0 }">{{ fmtInt(perf?.totals.stock_out_risks ?? 0) }}</span>
      </div>
      <div class="tile">
        <span class="label">Revenue · {{ days }} days</span>
        <span class="display v num">{{ perf ? fmtCompact(perf.totals.revenue) : '—' }}</span>
      </div>
      <div class="tile">
        <span class="label">Clients with offers</span>
        <span class="display v num">{{ fmtInt(summary?.recommended_clients ?? 0) }}</span>
      </div>
      <div class="tile last">
        <span class="label">Last computed</span>
        <span class="v small num">{{ lastRun }}</span>
        <span class="label dim">{{ summary?.llm ? 'Narrative · Claude' : 'Narrative · template' }}</span>
      </div>
    </section>

    <div v-if="error" class="label err">{{ error }}</div>

    <div class="grid">
      <NarrativeCard class="a" :report="report" :loading="loading" />
      <RebalanceList class="b" :moves="moves" :days="days" @changed="reloadMoves" />
      <GroupHeatmap v-if="perf" class="c" :cells="perf.heatmap" :boutiques="perf.boutiques" :groups="perf.item_groups" :days="perf.period.days" />
      <MoversTable v-if="perf" class="d" :boutiques="perf.boutiques" :top="perf.top_movers" :slow="perf.slow_movers" :days="perf.period.days" />
      <ContactList v-if="signals" class="e" :signals="signals.signals" :week="signals.week" :by-type="signals.by_type" @done="signalDone" />
    </div>
  </div>
</template>

<style scoped>
.insights { display: flex; flex-direction: column; gap: 20px; padding: 0 32px 40px; overflow-y: auto; min-height: 0; }
.tiles { display: grid; grid-template-columns: repeat(6, 1fr); border-bottom: 1px solid var(--line); margin: 0 -32px; }
.tile { display: flex; flex-direction: column; justify-content: space-between; gap: 10px; padding: 18px 32px 16px; border-right: 1px solid var(--line); min-width: 0; }
.tile.last { border-right: 0; }
.v { font-size: 32px; font-weight: 800; line-height: 1; color: var(--text); }
.v.small { font-family: var(--body); font-weight: 400; font-size: 16px; color: var(--muted); }
.v.warn { color: var(--warn); }
.dim { color: var(--dim); }
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  grid-template-areas: 'a b' 'c d' 'e e';
  gap: 20px;
  align-items: start;
}
.a { grid-area: a; }
.b { grid-area: b; }
.c { grid-area: c; }
.d { grid-area: d; }
.e { grid-area: e; }
.err { color: var(--crit); }
@media (max-width: 1300px) {
  .tiles { grid-template-columns: repeat(3, 1fr); }
  .grid { grid-template-columns: 1fr; grid-template-areas: 'a' 'b' 'c' 'd' 'e'; }
}
</style>
