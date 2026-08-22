<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import TopBar from './components/TopBar.vue'
import KpiStrip from './components/KpiStrip.vue'
import HourlyChart from './components/HourlyChart.vue'
import BoutiqueTable from './components/BoutiqueTable.vue'
import LiveFeed from './components/LiveFeed.vue'
// v0.4 D/F — period comparison, reports, low stock
import PeriodComparison from './components/PeriodComparison.vue'
import ReportsSection from './components/ReportsSection.vue'
import LowStockTile from './components/LowStockTile.vue'
import { useDashboard } from './stores/dashboard'
// --- v0.4 H insights view ---
import { ref } from 'vue'
import InsightsPanel from './components/insights/InsightsPanel.vue'
// --- end v0.4 H ---

const d = useDashboard()
onMounted(() => d.start())
onBeforeUnmount(() => d.dispose())
const currentHour = computed(() => new Date(d.now).getHours())

// --- v0.4 H insights view: ?view=insights (or the tab) switches the wall to the weekly insights ---
type View = 'live' | 'insights'
const view = ref<View>(new URLSearchParams(window.location.search).get('view') === 'insights' ? 'insights' : 'live')
function setView(v: View) {
  view.value = v
  const url = new URL(window.location.href)
  if (v === 'live') url.searchParams.delete('view')
  else url.searchParams.set('view', v)
  window.history.replaceState(null, '', url.toString())
}
// --- end v0.4 H ---
</script>

<template>
  <div class="app">
    <TopBar :live="d.connected" />
    <!-- v0.4 H: view switch -->
    <nav class="views" aria-label="Dashboard view">
      <button class="view-tab label" :class="{ on: view === 'live' }" @click="setView('live')">Live</button>
      <button class="view-tab label" :class="{ on: view === 'insights' }" @click="setView('insights')">Insights</button>
    </nav>
    <InsightsPanel v-if="view === 'insights'" class="insights-view" />
    <template v-else>
    <KpiStrip :totals="d.totals" :card-pct="d.cardPct" :cash-pct="d.cashPct" :pending="d.pendingTotal" />
    <main class="main">
      <div class="left">
        <PeriodComparison :data="d.periods" />
        <HourlyChart :hours="d.hours" :current-hour="currentHour" />
        <BoutiqueTable :rows="d.sorted" :flash="d.flash" />
        <ReportsSection :reports="d.reports" />
      </div>
      <div class="right">
        <LiveFeed :feed="d.feed" />
        <LowStockTile :data="d.lowStock" :returns="d.returnsToday" />
      </div>
    </main>
    </template>
    <!-- end v0.4 H -->
    <div v-if="d.error" class="err label">{{ d.error }}</div>
  </div>
</template>

<style scoped>
.app { display: grid; grid-template-rows: auto auto auto 1fr; height: 100vh; background: var(--ground); }
/* v0.4 H — view switch + insights view */
.views { display: flex; gap: 2px; padding: 0 32px; border-bottom: 1px solid var(--line); }
.view-tab { height: 40px; padding: 0 18px; color: var(--dim); background: transparent; border: 0; border-bottom: 2px solid transparent; cursor: pointer; margin-bottom: -1px; }
.view-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.insights-view { grid-row: span 2; min-height: 0; }
.main { display: grid; grid-template-columns: 1fr 460px; min-height: 0; }
.left { display: grid; grid-template-rows: auto minmax(200px, 28%) 1fr auto; min-height: 0; overflow: auto; }
.right { display: grid; grid-template-rows: 1fr auto; min-height: 0; border-left: 1px solid var(--line); }
.right :deep(.feed) { border-left: 0; }
.err { position: fixed; left: 32px; bottom: 16px; color: var(--crit); }
@media (max-width: 1400px) {
  .main { grid-template-columns: 1fr 380px; }
}
@media (max-width: 1100px) {
  body { overflow: auto; }
  .app { height: auto; }
  .main { grid-template-columns: 1fr; }
  .left { grid-template-rows: auto 280px auto auto; }
}
</style>
