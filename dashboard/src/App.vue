<script setup lang="ts">
/**
 * v0.5 L "Command" — head-office wall for 40–100 boutiques.
 * Tabs: Live (default) · Boutiques · Products · Clients · Insights · Reports.
 * The Live store starts once for the whole app (socket events keep flowing on every tab).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TopBar from './components/TopBar.vue'
import LiveView from './components/live/LiveView.vue'
import BoutiquesView from './components/boutiques/BoutiquesView.vue'
import BoutiquePage from './components/boutiques/BoutiquePage.vue'
import ProductsView from './components/products/ProductsView.vue'
import ClientsView from './components/clients/ClientsView.vue'
import InsightsPanel from './components/insights/InsightsPanel.vue'
import ReportsSection from './components/ReportsSection.vue'
import PeriodComparison from './components/PeriodComparison.vue'
import { useDashboard } from './stores/dashboard'
import { useBrand } from './stores/brand' // v0.6 D1

const d = useDashboard()
onMounted(() => d.start())
onBeforeUnmount(() => d.dispose())

type View = 'live' | 'boutiques' | 'products' | 'clients' | 'insights' | 'reports'
const brand = useBrand()
// the "Boutiques" tab is the tenant's plural store noun ("Stores" on CloudChaserz)
const VIEWS = computed<{ v: View; l: string }[]>(() => [
  { v: 'live', l: 'Live' },
  { v: 'boutiques', l: brand.stores },
  { v: 'products', l: 'Products' },
  { v: 'clients', l: 'Clients' },
  { v: 'insights', l: 'Insights' },
  { v: 'reports', l: 'Reports' },
])
const VIEW_KEYS: View[] = ['live', 'boutiques', 'products', 'clients', 'insights', 'reports']
const params = new URLSearchParams(window.location.search)
const view = ref<View>((VIEW_KEYS.find((v) => v === params.get('view')) as View) || 'live')
const boutique = ref<string | null>(params.get('boutique'))
function sync() {
  const url = new URL(window.location.href)
  if (view.value === 'live') url.searchParams.delete('view')
  else url.searchParams.set('view', view.value)
  if (boutique.value) url.searchParams.set('boutique', boutique.value)
  else url.searchParams.delete('boutique')
  window.history.replaceState(null, '', url.toString())
}
function setView(v: View) {
  view.value = v
  if (v !== 'boutiques') boutique.value = null
  sync()
}
function openBoutique(code: string) {
  view.value = 'boutiques'
  boutique.value = code
  sync()
}
function back() {
  boutique.value = null
  sync()
}
</script>

<template>
  <div class="app">
    <TopBar :live="d.connected" />
    <nav class="views" aria-label="Dashboard view">
      <button v-for="x in VIEWS" :key="x.v" class="view-tab label" :class="{ on: view === x.v }" :data-view="x.v" @click="setView(x.v)">{{ x.l }}</button>
      <span class="label stamp" :title="'last reconcile'">{{ d.agg.rows.size }} {{ brand.storesLower }} · reconciled {{ d.lastReconcile ? new Date(d.lastReconcile).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—' }}</span>
    </nav>
    <main class="main">
      <LiveView v-if="view === 'live'" @open="openBoutique" />
      <template v-else-if="view === 'boutiques'">
        <BoutiquePage v-if="boutique" :boutique="boutique" @back="back" />
        <BoutiquesView v-else @open="openBoutique" />
      </template>
      <ProductsView v-else-if="view === 'products'" />
      <ClientsView v-else-if="view === 'clients'" />
      <InsightsPanel v-else-if="view === 'insights'" class="insights-view" />
      <div v-else class="reports">
        <PeriodComparison :data="d.periods" />
        <ReportsSection :reports="d.reports" />
      </div>
    </main>
    <div v-if="d.error" class="err label">{{ d.error }}</div>
  </div>
</template>

<style scoped>
.app { display: grid; grid-template-rows: auto auto 1fr; height: 100vh; background: var(--ground); }
.views { display: flex; align-items: center; gap: 2px; padding: 0 var(--pad-x); border-bottom: 1px solid var(--line); }
.view-tab { height: 2.667rem; padding: 0 1.2rem; color: var(--dim); background: transparent; border: 0; border-bottom: 2px solid transparent; cursor: pointer; margin-bottom: -1px; }
.view-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.stamp { margin-left: auto; color: var(--dim); letter-spacing: 0.12em; text-transform: none; }
.main { min-height: 0; overflow: hidden; }
.insights-view { height: 100%; }
.reports { overflow-y: auto; height: 100%; }
.err { position: fixed; left: var(--pad-x); bottom: 1rem; color: var(--crit); }
@media (max-width: 1100px) {
  body { overflow: auto; }
  .app { height: auto; }
  .main { overflow: visible; }
}
</style>
