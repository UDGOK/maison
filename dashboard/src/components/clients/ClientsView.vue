<script setup lang="ts">
/**
 * Clients tab — churn-risk list for top tiers (Maison Client Signal), follow-up rates per
 * associate (30 d), upcoming dates, recognition stats; associate performance and campaign
 * performance are shown when the backend provides them (feature-detected).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { assignCall, fetchClientsOverview } from '../../api'
import { fmtInt, fmtMoney, fmtPct } from '../../lib/format'
import type { ClientsOverview } from '../../types'

const data = ref<ClientsOverview | null>(null)
const error = ref<string | null>(null)
const tiers = ref<string[]>([])
const TIERS = ['Patron', 'Collector', 'Connoisseur']
const busy = ref<Record<string, boolean>>({})

async function load() {
  try {
    data.value = await fetchClientsOverview({ tiers: tiers.value, limit: 30 })
    error.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}
onMounted(load)
watch(tiers, load, { deep: true })
function toggleTier(t: string) {
  tiers.value = tiers.value.includes(t) ? tiers.value.filter((x) => x !== t) : [...tiers.value, t]
}
async function assign(name: string) {
  busy.value = { ...busy.value, [name]: true }
  try {
    await assignCall(name)
    if (data.value) data.value = { ...data.value, churn: data.value.churn.filter((c) => c.name !== name) }
  } finally {
    const { [name]: _x, ...rest } = busy.value
    busy.value = rest
  }
}
const recognition = computed(() => data.value?.recognition ?? {})
const campaigns = computed(() => {
  const c = data.value?.campaigns as Record<string, unknown> | null
  if (!c) return null
  const list = Array.isArray(c) ? c : Array.isArray(c.campaigns) ? (c.campaigns as unknown[]) : null
  return list as Record<string, unknown>[] | null
})
const maxFollow = computed(() => Math.max(1, ...(data.value?.follow_ups.map((f) => f.assigned) ?? [1])))
</script>

<template>
  <div class="clients">
    <header class="toolbar">
      <span class="label">Clients</span>
      <div class="seg">
        <button v-for="t in TIERS" :key="t" class="btn ghost" :class="{ on: tiers.includes(t) }" @click="toggleTier(t)">{{ t }}</button>
      </div>
      <span class="label meta">{{ data?.as_of ?? '' }}</span>
    </header>
    <div v-if="error" class="label err">{{ error }}</div>
    <div class="grid">
      <section class="card churn">
        <header class="head"><span class="label">Churn risk · top tiers</span><span class="label">{{ data?.churn.length ?? 0 }} clients</span></header>
        <ol class="list">
          <li v-for="c in data?.churn ?? []" :key="c.name" class="li" :data-signal="c.name">
            <span class="risk"><span class="rfill" :style="{ width: `${Math.round(c.churn_risk * 100)}%` }" /></span>
            <span class="who"><span class="cname">{{ c.customer_name }}</span><span class="tier">{{ c.tier ?? '—' }}</span></span>
            <span class="reason">{{ c.reason }}</span>
            <span class="num ltv">{{ fmtMoney(c.lifetime_spend) }}</span>
            <span class="num dim">{{ c.boutique ?? '' }}</span>
            <button class="btn ghost assign" :disabled="busy[c.name]" @click="assign(c.name)">Assign call</button>
          </li>
          <li v-if="data && !data.churn.length" class="label pad">No churn signals for the selected tiers</li>
        </ol>
      </section>

      <section class="card">
        <header class="head"><span class="label">Follow-up rate · 30 d</span><span class="label">done / assigned</span></header>
        <ol class="list">
          <li v-for="f in data?.follow_ups ?? []" :key="f.associate" class="li fu">
            <span class="who"><span class="cname">{{ f.associate_name ?? f.associate }}</span><span class="tier">{{ f.boutique ?? '' }}</span></span>
            <span class="track"><span class="fill" :style="{ width: `${(f.assigned / maxFollow) * 100}%` }"><span class="done" :style="{ width: `${f.rate * 100}%` }" /></span></span>
            <span class="num">{{ fmtInt(f.completed) }} / {{ fmtInt(f.assigned) }}</span>
            <span class="num pct" :class="f.rate >= 0.7 ? 'up' : f.rate >= 0.4 ? '' : 'down'">{{ fmtPct(f.rate * 100) }}</span>
          </li>
          <li v-if="data && !data.follow_ups.length" class="label pad">No CRM tasks in the last 30 days</li>
        </ol>
      </section>

      <section class="card">
        <header class="head"><span class="label">Upcoming dates</span><span class="label">birthdays · anniversaries · due visits</span></header>
        <ol class="list">
          <li v-for="c in data?.upcoming ?? []" :key="c.name" class="li up3">
            <span class="who"><span class="cname">{{ c.customer_name }}</span><span class="tier">{{ c.tier ?? '—' }}</span></span>
            <span class="reason">{{ c.signal_type }} · {{ c.reason }}</span>
            <span class="num dim">{{ c.expected_next_visit ?? '' }}</span>
          </li>
          <li v-if="data && !data.upcoming.length" class="label pad">Nothing coming up</li>
        </ol>
      </section>

      <section class="card tiles">
        <header class="head"><span class="label">Recognition</span><span class="label">today · consented clients</span></header>
        <div class="tilegrid">
          <div><span class="label">Enrolled</span><span class="display num v">{{ fmtInt(recognition.enrolled_total ?? 0) }}</span></div>
          <div><span class="label">Matched today</span><span class="display num v">{{ fmtInt(recognition.matched_today ?? 0) }}</span></div>
          <div><span class="label">Enrolled today</span><span class="display num v">{{ fmtInt(recognition.enrolled_today ?? 0) }}</span></div>
          <div><span class="label">Declined</span><span class="display num v">{{ fmtInt(recognition.declined_today ?? 0) }}</span></div>
        </div>
      </section>

      <section v-if="data?.performance?.length" class="card perf">
        <header class="head"><span class="label">Associate performance · 30 d</span><span class="label">sales · tickets · avg · conv. · follow-ups</span></header>
        <ol class="list">
          <li v-for="p in data.performance" :key="p.associate" class="li perfrow">
            <span class="who"><span class="cname">{{ p.associate_name ?? p.associate }}</span><span class="tier">{{ p.boutique ?? '' }}</span></span>
            <span class="num">{{ fmtMoney(p.sales) }}</span>
            <span class="num dim">{{ fmtInt(p.tickets) }}</span>
            <span class="num dim">{{ fmtMoney(p.avg_ticket) }}</span>
            <span class="num dim">{{ fmtPct(p.conversion * 100) }}</span>
            <span class="num dim">{{ p.follow_up_rate != null ? fmtPct(p.follow_up_rate * 100) : fmtInt(p.follow_ups_done) }}</span>
          </li>
        </ol>
      </section>

      <section v-if="campaigns" class="card">
        <header class="head"><span class="label">Campaign performance</span><span class="label">attributed revenue</span></header>
        <ol class="list">
          <li v-for="(c, i) in campaigns" :key="String(c.name ?? i)" class="li camp">
            <span class="who"><span class="cname">{{ c.title ?? c.name }}</span><span class="tier">{{ c.channel ?? '' }}</span></span>
            <span class="num dim">{{ fmtInt(Number(c.sends ?? c.touches ?? 0)) }} sent</span>
            <span class="num dim">{{ fmtInt(Number(c.opens ?? c.opened ?? 0)) }} opened</span>
            <span class="num">{{ fmtMoney(Number(c.attributed_revenue ?? c.revenue ?? 0)) }}</span>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>

<style scoped>
.clients { display: grid; grid-template-rows: auto auto 1fr; min-height: 0; height: 100%; }
.toolbar { display: flex; align-items: center; gap: 1rem; padding: 0.8rem var(--pad-x); border-bottom: 1px solid var(--line); }
.meta { margin-left: auto; color: var(--muted); }
.err { color: var(--crit); padding: 0.5rem var(--pad-x); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap); padding: var(--gap) var(--pad-x); overflow-y: auto; min-height: 0; align-items: start; }
.churn, .perf { grid-column: span 2; }
.list { list-style: none; padding: 0.4rem 1.4rem 0.8rem; max-height: 38vh; overflow-y: auto; }
.li { display: grid; grid-template-columns: 4rem minmax(0, 1fr) minmax(0, 2fr) auto 5rem auto; gap: 0.9rem; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--line); font-size: var(--fs-small); }
.li.fu { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto 3.4rem; }
.li.up3 { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto; }
.li.perfrow { grid-template-columns: minmax(0, 1.4fr) repeat(5, auto); }
.li.camp { grid-template-columns: minmax(0, 1.4fr) repeat(3, auto); }
.risk { height: 0.45rem; background: var(--surface-2); }
.rfill { display: block; height: 100%; background: var(--crit); }
.who { display: flex; flex-direction: column; min-width: 0; }
.cname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tier { font-size: var(--fs-label); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); }
.reason { text-align: left; color: var(--muted); font-weight: 300; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ltv { font-weight: 500; }
.dim { color: var(--dim); }
.track { height: 0.6rem; background: var(--surface-2); }
.fill { display: block; height: 100%; background: var(--line-strong); }
.done { display: block; height: 100%; background: var(--accent); }
.pct { text-align: right; }
.tilegrid { display: grid; grid-template-columns: repeat(4, 1fr); }
.tilegrid > div { display: flex; flex-direction: column; gap: 0.5rem; padding: 1rem 1.4rem; border-right: 1px solid var(--line); }
.tilegrid > div:last-child { border-right: 0; }
.v { font-size: var(--fs-kpi); font-weight: 800; }
.pad { padding: 0.8rem 0; }
@media (max-width: 1300px) { .grid { grid-template-columns: 1fr; } .churn, .perf { grid-column: span 1; } }
</style>
