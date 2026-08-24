<script setup lang="ts">
/** Drill-in page per boutique: hourly, top items, associates, recent sales, alerts, feedback. */
import { computed, onMounted, ref, watch } from 'vue'
import HourlyChart from '../HourlyChart.vue'
import Sparkline from '../Sparkline.vue'
import StatusPill from '../StatusPill.vue'
import { fetchBoutiqueDetail } from '../../api'
import { deriveStatus } from '../../lib/aggregate'
import { fmtInt, fmtMoney, fmtPct, fmtTime } from '../../lib/format'
import { useDashboard } from '../../stores/dashboard'
import type { BoutiqueDetail } from '../../types'

const props = defineProps<{ boutique: string }>()
import { useBrand } from '../../stores/brand' // v0.6 D1
const brand = useBrand()
defineEmits<{ back: [] }>()
const d = useDashboard()
const detail = ref<BoutiqueDetail | null>(null)
const error = ref<string | null>(null)
const days = ref(28)
async function load() {
  try {
    detail.value = await fetchBoutiqueDetail(props.boutique, days.value)
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}
onMounted(load)
watch(() => [props.boutique, days.value], load)
const live = computed(() => {
  void d.version
  return d.agg.rows.get(props.boutique) ?? null
})
const hours = computed(() => {
  const b = live.value
  if (b) return b.by_hour.map((net, hour) => ({ hour, net, invoices: detail.value?.by_hour[hour]?.invoices ?? 0 }))
  return detail.value?.by_hour ?? []
})
const currentHour = computed(() => new Date(d.now).getHours())
const maxItem = computed(() => Math.max(1, ...(detail.value?.top_items.map((t) => t.net) ?? [1])))
</script>

<template>
  <div class="page">
    <header class="head">
      <button class="btn" @click="$emit('back')">← {{ brand.stores }}</button>
      <span class="display code">{{ boutique }}</span>
      <span class="city">{{ live?.name ?? detail?.row?.name ?? '' }}</span>
      <StatusPill v-if="live" :status="deriveStatus(live.last_seen, d.now, live.pending_approvals, live.queued)" :queued="live.queued" />
      <div class="seg right">
        <button v-for="n in [7, 28, 90]" :key="n" class="btn" :class="{ on: days === n }" @click="days = n">{{ n }} d</button>
      </div>
    </header>
    <div v-if="error" class="label err">{{ error }}</div>
    <div class="grid">
      <section class="card stats">
        <div><span class="label">Net today</span><span class="display num v accent">{{ fmtMoney(live?.net ?? detail?.row?.net ?? 0) }}</span></div>
        <div><span class="label">vs same day LW</span><span class="display num v" :class="(live?.vs_last_week_pct ?? 0) >= 0 ? 'up' : 'down'">{{ live?.vs_last_week_pct == null ? '—' : `${live.vs_last_week_pct >= 0 ? '+' : '−'}${Math.abs(live.vs_last_week_pct).toFixed(0)}%` }}</span></div>
        <div><span class="label">Tickets</span><span class="display num v">{{ fmtInt(live?.invoices ?? 0) }}</span></div>
        <div><span class="label">Avg sale</span><span class="display num v">{{ fmtMoney(live?.avg_ticket ?? 0) }}</span></div>
        <div><span class="label">Returns</span><span class="display num v">{{ fmtInt(live?.returns ?? 0) }}</span></div>
        <div><span class="label">14 days</span><Sparkline :values="detail?.sparkline ?? []" :width="160" :height="36" /></div>
      </section>
      <HourlyChart class="card chart" :hours="hours" :current-hour="currentHour" />
      <section class="card">
        <header class="head"><span class="label">Top items · {{ days }} d</span><span class="label">net</span></header>
        <ol class="bars">
          <li v-for="t in detail?.top_items ?? []" :key="t.item_code" class="bar">
            <span class="bname">{{ t.item_name }}</span>
            <span class="track"><span class="fill" :style="{ width: `${(t.net / maxItem) * 100}%` }" /></span>
            <span class="num bval">{{ fmtMoney(t.net) }} · {{ fmtInt(t.units) }}</span>
          </li>
        </ol>
      </section>
      <section class="card">
        <header class="head"><span class="label">Associates · {{ days }} d</span><span class="label">net · tickets · avg · conv.</span></header>
        <ol class="list">
          <li v-for="a in detail?.associates ?? []" :key="a.associate" class="li">
            <span class="lname">{{ a.associate_name ?? a.associate }}</span>
            <span class="num">{{ fmtMoney(a.net) }}</span>
            <span class="num dim">{{ fmtInt(a.tickets) }}</span>
            <span class="num dim">{{ fmtMoney(a.avg_ticket) }}</span>
            <span class="num dim">{{ fmtPct(a.conversion * 100) }}</span>
          </li>
        </ol>
      </section>
      <section class="card">
        <header class="head"><span class="label">Recent sales</span><span class="label">today</span></header>
        <ol class="list">
          <li v-for="s in detail?.recent_sales ?? []" :key="s.invoice" class="li sale" :class="{ ret: s.is_return }">
            <span class="num dim">{{ fmtTime(s.posting_datetime) }}</span>
            <span class="lname">{{ s.items.map((i) => i.item_name).join(' · ') || '—' }}</span>
            <span class="display num amt">{{ fmtMoney(s.amount) }}</span>
          </li>
          <li v-if="detail && !detail.recent_sales.length" class="label pad">No sales yet today</li>
        </ol>
      </section>
      <section class="card">
        <header class="head"><span class="label">Alerts</span><span class="label">{{ detail?.alerts.length ?? 0 }} low stock</span></header>
        <ol class="list">
          <li v-for="a in detail?.alerts ?? []" :key="a.name" class="li">
            <span class="lname">{{ a.item_name ?? a.item_code }}</span>
            <span class="num warn">{{ fmtInt(a.qty) }} / {{ fmtInt(a.reorder_level) }}</span>
            <span class="label">{{ a.status }}</span>
          </li>
          <li v-if="detail && !detail.alerts.length" class="label pad">No open alerts</li>
        </ol>
      </section>
      <section class="card">
        <header class="head"><span class="label">Feedback</span><span class="label">private · latest</span></header>
        <ol class="list">
          <li v-for="f in detail?.feedback ?? []" :key="f.name" class="li fb">
            <span class="stars" :class="{ low: f.rating <= 2 }">{{ '★'.repeat(f.rating) }}<span class="off">{{ '★'.repeat(5 - f.rating) }}</span></span>
            <span class="lname quiet">{{ f.comment || '—' }}</span>
            <span class="label">{{ f.status }}</span>
          </li>
          <li v-if="detail && !detail.feedback.length" class="label pad">No feedback yet</li>
        </ol>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { display: grid; grid-template-rows: auto auto 1fr; min-height: 0; height: 100%; }
.head { display: flex; align-items: center; gap: 1rem; padding: 0.8rem var(--pad-x); border-bottom: 1px solid var(--line); }
.page > .head .code { font-size: var(--fs-lead); font-weight: 900; }
.city { color: var(--muted); font-weight: 300; }
.right { margin-left: auto; }
.err { color: var(--crit); padding: 0.5rem var(--pad-x); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: minmax(12rem, auto); gap: var(--gap); padding: var(--gap) var(--pad-x); overflow-y: auto; min-height: 0; }
.stats { grid-column: span 2; display: grid; grid-template-columns: repeat(6, 1fr); }
.stats > div { display: flex; flex-direction: column; justify-content: space-between; gap: 0.5rem; padding: 1rem 1.2rem; border-right: 1px solid var(--line); }
.stats > div:last-child { border-right: 0; }
.v { font-size: var(--fs-kpi); font-weight: 800; }
.accent { color: var(--accent); }
.chart { padding: 1rem 1.4rem 1.6rem; }
.bars, .list { list-style: none; padding: 0.6rem 1.4rem 1rem; overflow-y: auto; }
.bar { display: grid; grid-template-columns: minmax(0, 1.2fr) 1fr auto; gap: 0.8rem; align-items: center; padding: 0.35rem 0; font-size: var(--fs-small); }
.bname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.track { height: 0.6rem; background: var(--surface-2); }
.fill { display: block; height: 100%; background: var(--accent-deep); }
.bar:first-child .fill { background: var(--accent); }
.bval { color: var(--muted); white-space: nowrap; }
.li { display: grid; grid-template-columns: minmax(0, 1.4fr) repeat(4, auto); gap: 0.8rem; padding: 0.45rem 0; border-bottom: 1px solid var(--line); font-size: var(--fs-small); align-items: baseline; }
.li.sale { grid-template-columns: auto minmax(0, 1fr) auto; }
.li.fb { grid-template-columns: auto minmax(0, 1fr) auto; }
.lname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.quiet { color: var(--muted); font-weight: 300; white-space: normal; }
.dim { color: var(--muted); }
.warn { color: var(--warn); }
.amt { font-weight: 800; font-size: var(--fs-num); }
.sale.ret .amt { color: var(--crit); }
.stars { color: var(--accent); letter-spacing: 0.1em; }
.stars.low { color: var(--crit); }
.off { color: var(--line-strong); }
.pad { padding: 0.8rem 0; }
@media (max-width: 1300px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stats { grid-template-columns: repeat(3, 1fr); }
}
</style>
