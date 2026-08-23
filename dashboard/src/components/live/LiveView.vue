<script setup lang="ts">
/**
 * Live tab — KPI strip, ticker, ranked store-level live cards (virtualised), chain hourly chart,
 * and a drill-in pane for the selected boutique. Region filter + search.
 */
import { computed, ref } from 'vue'
import KpiStrip from '../KpiStrip.vue'
import HourlyChart from '../HourlyChart.vue'
import VirtualList from '../VirtualList.vue'
import BoutiqueCard from './BoutiqueCard.vue'
import LiveTicker from './LiveTicker.vue'
import BoutiqueDrillIn from './BoutiqueDrillIn.vue'
import LowStockTile from '../LowStockTile.vue'
import { useDashboard } from '../../stores/dashboard'
import { useBrand } from '../../stores/brand' // v0.6 D1
import type { BoutiqueAgg, LiveSortKey } from '../../lib/aggregate'

defineEmits<{ open: [code: string] }>()
const d = useDashboard()
const brand = useBrand()
const currentHour = computed(() => new Date(d.now).getHours())
const remPx = ref(parseFloat(getComputedStyle(document.documentElement).fontSize) || 15)
const rowHeight = computed(() => Math.round(3.733 * remPx.value))
const keyOf = (b: BoutiqueAgg) => b.boutique
const sorts: { k: LiveSortKey; l: string }[] = [
  { k: 'net', l: 'Net' },
  { k: 'vs_lw', l: 'vs LW' },
  { k: 'invoices', l: 'Tickets' },
  { k: 'last_sale', l: 'Last sale' },
]
</script>

<template>
  <div class="live" :class="{ split: !!d.selectedRow }">
    <KpiStrip class="kpis" :totals="d.totals" :card-pct="d.cardPct" :cash-pct="d.cashPct" :pending="d.pendingTotal" :low-stock="d.totals.low_stock" :feedback-open="d.totals.feedback_open" :online="d.totals.online" :boutiques="d.agg.rows.size" />
    <LiveTicker class="ticker" :items="d.ticker" />
    <section class="boards">
      <div class="list">
        <header class="toolbar">
          <span class="label">Top {{ brand.storesLower }} today</span>
          <span class="label count">{{ d.ranked.length }} / {{ d.agg.rows.size }}</span>
          <div class="seg">
            <button class="btn ghost" :class="{ on: !d.region }" @click="d.region = null">All</button>
            <button v-for="r in d.regions" :key="r" class="btn ghost" :class="{ on: d.region === r }" @click="d.region = d.region === r ? null : r">{{ r }}</button>
          </div>
          <input v-model="d.query" class="input search" type="search" placeholder="Code or name" :aria-label="`Search ${brand.storesLower}`" />
          <div class="seg">
            <button v-for="s in sorts" :key="s.k" class="btn" :class="{ on: d.sort === s.k }" @click="d.sort = s.k">{{ s.l }}</button>
          </div>
        </header>
        <div class="hdr">
          <span class="label">#</span>
          <span class="label">{{ brand.store }}</span>
          <span class="label r">Net</span>
          <span class="label r">vs LW</span>
          <span class="label r">Tickets</span>
          <span class="label">Last sale</span>
          <span class="label r">Status</span>
        </div>
        <VirtualList class="cards" :items="d.ranked" :row-height="rowHeight" :key-of="keyOf" data-testid="live-cards">
          <template #default="{ item, index }">
            <BoutiqueCard :row="item" :index="index" :now="d.now" :flashing="!!d.flash[item.boutique]" :selected="d.selected === item.boutique" @select="d.select" />
          </template>
        </VirtualList>
      </div>
      <BoutiqueDrillIn v-if="d.selectedRow" class="drill" :row="d.selectedRow" :now="d.now" @close="d.select(null)" @open="(c) => $emit('open', c)" />
      <div v-else class="side">
        <HourlyChart class="chart" :hours="d.hours" :current-hour="currentHour" />
        <LowStockTile :data="d.lowStock" :returns="d.returnsToday" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.live { display: grid; grid-template-rows: auto auto 1fr; min-height: 0; height: 100%; }
.boards { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(26rem, 1fr); min-height: 0; }
/* v0.6 R: without `min-width: 0` this grid item could not shrink below the toolbar's min-content
   (~985 px), so at 1366 the whole list — rows, status pills and all — overflowed its own column and
   ran across the hourly chart beside it. The toolbar wraps instead. */
.list { display: grid; grid-template-rows: auto auto 1fr; min-height: 0; min-width: 0; }
.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 0.7rem 1rem; padding: 0.8rem var(--pad-x); border-bottom: 1px solid var(--line); min-width: 0; }
.count { color: var(--muted); }
.search { width: 12rem; min-width: 8rem; margin-left: auto; }
.hdr { display: grid; grid-template-columns: 2rem minmax(0, 2fr) 1fr 0.6fr 0.5fr minmax(0, 2fr) 11rem; gap: 1rem; padding: 0.5rem var(--pad-x); border-bottom: 1px solid var(--line); }
.cards { min-height: 0; }
.side { display: grid; grid-template-rows: minmax(14rem, 1fr) auto; min-height: 0; border-left: 1px solid var(--line); }
.side :deep(.chart) { border-bottom: 1px solid var(--line); }
@media (max-width: 1600px) {
  .boards { grid-template-columns: minmax(0, 1.5fr) minmax(22rem, 1fr); }
  .hdr { grid-template-columns: 1.6rem minmax(0, 1.9fr) 0.9fr 0.5fr 0.4fr minmax(0, 1.7fr) 9rem; gap: 0.7rem; }
}
@media (max-width: 1100px) {
  .boards { grid-template-columns: 1fr; }
  .side { border-left: 0; }
}
</style>
