<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import TopBar from './components/TopBar.vue'
import KpiStrip from './components/KpiStrip.vue'
import HourlyChart from './components/HourlyChart.vue'
import BoutiqueTable from './components/BoutiqueTable.vue'
import LiveFeed from './components/LiveFeed.vue'
import { useDashboard } from './stores/dashboard'

const d = useDashboard()
onMounted(() => d.start())
onBeforeUnmount(() => d.dispose())
const currentHour = computed(() => new Date(d.now).getHours())
</script>

<template>
  <div class="app">
    <TopBar :live="d.connected" />
    <KpiStrip :totals="d.totals" :card-pct="d.cardPct" :cash-pct="d.cashPct" :pending="d.pendingTotal" />
    <main class="main">
      <div class="left">
        <HourlyChart :hours="d.hours" :current-hour="currentHour" />
        <BoutiqueTable :rows="d.sorted" :flash="d.flash" />
      </div>
      <LiveFeed :feed="d.feed" />
    </main>
    <div v-if="d.error" class="err label">{{ d.error }}</div>
  </div>
</template>

<style scoped>
.app { display: grid; grid-template-rows: auto auto 1fr; height: 100vh; background: var(--ground); }
.main { display: grid; grid-template-columns: 1fr 460px; min-height: 0; }
.left { display: grid; grid-template-rows: minmax(240px, 34%) 1fr; min-height: 0; }
.err { position: fixed; left: 32px; bottom: 16px; color: var(--crit); }
@media (max-width: 1400px) {
  .main { grid-template-columns: 1fr 380px; }
}
@media (max-width: 1100px) {
  body { overflow: auto; }
  .app { height: auto; }
  .main { grid-template-columns: 1fr; }
  .left { grid-template-rows: 280px auto; }
}
</style>
