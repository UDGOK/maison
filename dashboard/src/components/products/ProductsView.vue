<script setup lang="ts">
/**
 * Products tab — two sub-tabs exactly as asked: "Trending in stores" and "Top products by store"
 * (+ item-group × boutique matrix). Everything reads the precomputed Maison Product Trend table.
 */
import { computed, onMounted, ref, watch } from 'vue'
import TrendingTable from './TrendingTable.vue'
import TopByStore from './TopByStore.vue'
import GroupHeatmap from '../insights/GroupHeatmap.vue'
import { fetchProductTrends, fetchTopProducts } from '../../api'
import { fmtInt } from '../../lib/format'
import { useDashboard } from '../../stores/dashboard'
import type { ProductTrends, TopProducts, TrendPeriod } from '../../types'

const d = useDashboard()
import { useBrand } from '../../stores/brand' // v0.6 D1
const brand = useBrand()
type Sub = 'trending' | 'top'
const sub = ref<Sub>((new URLSearchParams(window.location.search).get('sub') as Sub) || 'trending')
const period = ref<TrendPeriod>('7d')
const group = ref<string | null>(null)
const badge = ref<string | null>(null)
const boutique = ref<string>('all')
const by = ref<'net' | 'units'>('net')
const trends = ref<ProductTrends | null>(null)
const top = ref<TopProducts | null>(null)
const error = ref<string | null>(null)
const loadMs = ref<number | null>(null)

async function loadTrending() {
  const t0 = performance.now()
  try {
    trends.value = await fetchProductTrends({ scope: 'chain', period: period.value, group: group.value, badge: badge.value, limit: 60 })
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loadMs.value = Math.round(performance.now() - t0)
  }
}
async function loadTop() {
  const t0 = performance.now()
  try {
    top.value = await fetchTopProducts({ boutique: boutique.value, by: by.value, period: period.value, n: 10 })
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loadMs.value = Math.round(performance.now() - t0)
  }
}
function load() {
  return sub.value === 'trending' ? loadTrending() : loadTop()
}
onMounted(load)
watch([sub, period, group, badge, boutique, by], load)
const boutiqueCodes = computed(() => [...d.agg.rows.keys()].sort())
const computedAt = computed(() => (trends.value?.last_run?.computed_at ?? top.value?.last_run?.computed_at ?? '').slice(0, 16))
const heatCells = computed(() => top.value?.matrix ?? [])
</script>

<template>
  <div class="products">
    <header class="toolbar">
      <div class="seg subs">
        <button class="btn" :class="{ on: sub === 'trending' }" data-sub="trending" @click="sub = 'trending'">Trending in {{ brand.storesLower }}</button>
        <button class="btn" :class="{ on: sub === 'top' }" data-sub="top" @click="sub = 'top'">Top products by {{ brand.storeLower }}</button>
      </div>
      <div class="seg">
        <button v-for="p in ['7d', '28d'] as TrendPeriod[]" :key="p" class="btn ghost" :class="{ on: period === p }" @click="period = p">{{ p }}</button>
      </div>
      <template v-if="sub === 'trending'">
        <select v-model="group" class="input" aria-label="Item group">
          <option :value="null">All groups</option>
          <option v-for="g in trends?.groups ?? []" :key="g" :value="g">{{ g }}</option>
        </select>
        <div class="seg">
          <button v-for="b in ['Trending up', 'New', 'Cooling']" :key="b" class="btn ghost" :class="{ on: badge === b }" @click="badge = badge === b ? null : b">{{ b }} · {{ fmtInt(trends?.badges[b] ?? 0) }}</button>
        </div>
      </template>
      <template v-else>
        <select v-model="boutique" class="input" :aria-label="brand.store">
          <option value="all">All {{ brand.storesLower }}</option>
          <option v-for="b in boutiqueCodes" :key="b" :value="b">{{ b }}</option>
        </select>
        <div class="seg">
          <button class="btn ghost" :class="{ on: by === 'net' }" @click="by = 'net'">By net</button>
          <button class="btn ghost" :class="{ on: by === 'units' }" @click="by = 'units'">By units</button>
        </div>
      </template>
      <span class="label meta">precomputed · {{ computedAt || '—' }}<template v-if="loadMs !== null"> · loaded in {{ loadMs }} ms</template></span>
    </header>
    <div v-if="error" class="label err">{{ error }}</div>
    <div class="body">
      <template v-if="sub === 'trending'">
        <section class="card fill">
          <header class="head">
            <span class="label">Chain-wide · units this {{ period }} vs previous {{ period }} · vs 28 d baseline</span>
            <span class="label">{{ trends?.rows.length ?? 0 }} of {{ trends?.total ?? 0 }} items</span>
          </header>
          <TrendingTable :rows="trends?.rows ?? []" :period="period" />
        </section>
      </template>
      <template v-else>
        <TopByStore v-if="top" :top="top.top" :boutiques="top.boutiques" :by="by" :boutique-net="top.boutique_net" />
        <GroupHeatmap v-if="top && heatCells.length" class="matrix" :cells="heatCells" :boutiques="top.boutiques" :groups="top.groups" :days="period === '7d' ? 7 : 28" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.products { display: grid; grid-template-rows: auto auto 1fr; min-height: 0; height: 100%; }
.toolbar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding: 0.8rem var(--pad-x); border-bottom: 1px solid var(--line); }
.meta { margin-left: auto; color: var(--muted); letter-spacing: 0.12em; text-transform: none; }
.err { color: var(--crit); padding: 0.5rem var(--pad-x); }
.body { display: flex; flex-direction: column; gap: var(--gap); padding: var(--gap) var(--pad-x); overflow-y: auto; min-height: 0; }
.fill { display: grid; grid-template-rows: auto 1fr; min-height: 0; flex: 1; }
</style>
