<script setup lang="ts">
import { computed, ref } from 'vue'
import { fmtCompact, fmtInt } from '../../lib/format'
import type { PerfItemRow } from '../../insights/types'

const props = defineProps<{ boutiques: string[]; top: Record<string, PerfItemRow[]>; slow: Record<string, PerfItemRow[]>; days: number }>()
const selected = ref<string | null>(null)
const active = computed(() => selected.value && props.boutiques.includes(selected.value) ? selected.value : props.boutiques[0] ?? '')
const topRows = computed(() => props.top[active.value] ?? [])
const slowRows = computed(() => props.slow[active.value] ?? [])

function doh(r: PerfItemRow): string {
  if (r.days_on_hand === null) return 'no sales'
  return r.days_on_hand >= 999 ? '999+ d' : `${Math.round(r.days_on_hand)} d`
}
</script>

<template>
  <section class="card">
    <header class="head">
      <span class="label">Top / slow movers</span>
      <nav class="tabs">
        <button v-for="b in boutiques" :key="b" class="tab display" :class="{ on: b === active }" @click="selected = b">{{ b }}</button>
      </nav>
    </header>
    <div class="cols">
      <div class="col">
        <div class="sub"><span class="label">Top by revenue</span><span class="label dim">{{ days }} days</span></div>
        <div v-for="(r, i) in topRows" :key="r.item_code" class="row">
          <span class="num idx">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="name">
            <span class="nm ellipsis">{{ r.item_name }}</span>
            <span class="code label">{{ r.item_code }} · {{ r.item_group }}</span>
          </span>
          <span class="num r units">{{ fmtInt(r.units) }}<span class="u"> u</span></span>
          <span class="num r rev accent">{{ fmtCompact(r.revenue) }}</span>
          <span class="num r idx2" :class="{ good: (r.index ?? 1) >= 1.2, warn: (r.index ?? 1) < 0.8 }">{{ r.index != null ? r.index.toFixed(1) + '×' : '—' }}</span>
        </div>
        <div v-if="!topRows.length" class="label empty">Nothing sold</div>
      </div>
      <div class="col">
        <div class="sub"><span class="label">Slow · days on hand</span><span class="label dim">stock that is not moving</span></div>
        <div v-for="(r, i) in slowRows" :key="r.item_code" class="row">
          <span class="num idx">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="name">
            <span class="nm ellipsis">{{ r.item_name }}</span>
            <span class="code label">{{ r.item_code }} · {{ fmtInt(r.on_hand) }} on hand · {{ fmtCompact(r.on_hand * r.rate) }} at retail</span>
          </span>
          <span class="num r doh" :class="{ crit: r.days_on_hand === null || r.days_on_hand > 180 }">{{ doh(r) }}</span>
        </div>
        <div v-if="!slowRows.length" class="label empty">No idle stock</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--line); background: var(--surface); min-width: 0; display: flex; flex-direction: column; }
.head { display: flex; justify-content: space-between; align-items: center; padding: 12px 22px; border-bottom: 1px solid var(--line); }
.tabs { display: flex; gap: 4px; }
.tab { height: 30px; padding: 0 12px; font-size: 11px; letter-spacing: 0.06em; color: var(--muted); border: 1px solid var(--line); background: transparent; cursor: pointer; }
.tab.on { color: var(--ink-on-accent); background: var(--accent); border-color: var(--accent); }
.cols { display: grid; grid-template-columns: 1fr 1fr; min-height: 0; }
.col { padding: 12px 22px 16px; border-right: 1px solid var(--line); min-width: 0; }
.col:last-child { border-right: 0; }
.sub { display: flex; justify-content: space-between; margin-bottom: 8px; }
.dim { color: var(--dim); text-transform: none; letter-spacing: 0.08em; }
.row { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto auto 52px; gap: 12px; align-items: center; height: 50px; border-bottom: 1px solid var(--line); }
.col:last-child .row { grid-template-columns: 26px minmax(0, 1fr) auto; }
.idx { color: var(--dim); font-size: 12px; letter-spacing: 0.1em; }
.name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.nm { font-size: 14px; }
.code { letter-spacing: 0.1em; font-size: 10px; color: var(--dim); text-transform: none; }
.r { text-align: right; }
.units { font-size: 13px; color: var(--muted); }
.u { color: var(--dim); }
.rev { font-size: 15px; font-weight: 500; }
.accent { color: var(--accent); }
.idx2 { font-size: 12px; color: var(--dim); }
.good { color: var(--good); }
.warn { color: var(--warn); }
.doh { font-size: 14px; color: var(--warn); }
.crit { color: var(--crit); }
.empty { padding: 20px 0; color: var(--dim); }
</style>
