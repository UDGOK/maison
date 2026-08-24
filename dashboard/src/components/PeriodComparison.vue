<script setup lang="ts">
import { computed } from 'vue'
import { fmtInt, fmtMoney } from '../lib/format'
import type { PeriodBlock, PeriodComparison, PeriodKind } from '../types'

/** v0.4 F — today vs same weekday last week · WTD · MTD vs last month · YTD vs LY. */
const props = defineProps<{ data: PeriodComparison | null }>()
const ORDER: { kind: PeriodKind; short: string }[] = [
  { kind: 'today_vs_same_weekday', short: 'Today' },
  { kind: 'wtd', short: 'WTD' },
  { kind: 'mtd', short: 'MTD' },
  { kind: 'ytd', short: 'YTD' },
]
const blocks = computed(() => ORDER.map((o) => ({ ...o, block: props.data?.periods[o.kind] ?? null })))
const sign = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`)
const tone = (v: number | null | undefined) => (v === null || v === undefined ? 'dim' : v > 0 ? 'good' : v < 0 ? 'crit' : 'dim')
const sub = (b: PeriodBlock) => b.label.replace(/^.*? vs /, 'vs ')
</script>

<template>
  <section class="periods">
    <header class="head">
      <span class="label">Period comparison</span>
      <!-- v0.8 QA D-7: the same definition as the Live and Stores tabs, said out loud -->
      <span class="label">net sales · incl. tax · returns netted</span>
    </header>
    <div class="grid">
      <div v-for="b in blocks" :key="b.kind" class="cell">
        <div class="top">
          <span class="display short">{{ b.short }}</span>
          <span v-if="b.block" class="label">{{ sub(b.block) }}</span>
        </div>
        <template v-if="b.block">
          <span class="display value num">{{ fmtMoney(b.block.current.net) }}</span>
          <div class="deltas">
            <span class="delta num" :class="tone(b.block.pct.net)">{{ sign(b.block.pct.net) }}</span>
            <span class="label prev">prev {{ fmtMoney(b.block.previous.net) }}</span>
          </div>
          <div class="row2 label">
            <span>{{ fmtInt(b.block.current.tickets) }} tickets <span class="num" :class="tone(b.block.pct.tickets)">{{ sign(b.block.pct.tickets) }}</span></span>
            <span>avg sale {{ fmtMoney(b.block.current.avg_ticket) }} <span class="num" :class="tone(b.block.pct.avg_ticket)">{{ sign(b.block.pct.avg_ticket) }}</span></span>
            <span v-if="b.block.current.returns">{{ b.block.current.returns }} returns · {{ fmtMoney(b.block.current.returns_value) }}</span>
          </div>
          <div class="bar">
            <span class="cur" :style="{ width: `${Math.min(100, (100 * b.block.current.net) / Math.max(b.block.current.net, b.block.previous.net, 1))}%` }"></span>
            <span class="prevbar" :style="{ width: `${Math.min(100, (100 * b.block.previous.net) / Math.max(b.block.current.net, b.block.previous.net, 1))}%` }"></span>
          </div>
        </template>
        <span v-else class="label dim">Loading…</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.periods { padding: 1.2rem 2.133rem 1.067rem; border-bottom: 1px solid var(--line); }
.head { display: flex; justify-content: space-between; margin-bottom: 0.8rem; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.cell { background: var(--surface); padding: 0.933rem 1.2rem 0.8rem; display: flex; flex-direction: column; gap: 0.533rem; min-width: 0; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 0.533rem; }
.short { font-size: 0.8rem; font-weight: 800; letter-spacing: 0.06em; color: var(--accent); }
.value { font-size: clamp(1.333rem, 1.5vw, 1.867rem); font-weight: 800; line-height: 1; }
.deltas { display: flex; align-items: baseline; gap: 0.8rem; }
.delta { font-family: var(--display); font-weight: 800; font-size: 0.933rem; }
.good { color: var(--good); }
.crit { color: var(--crit); }
.dim { color: var(--dim); }
.prev { color: var(--dim); }
.row2 { display: flex; flex-wrap: wrap; gap: 0.667rem 0.933rem; text-transform: none; letter-spacing: 0.02em; font-size: 0.733rem; color: var(--muted); }
.bar { position: relative; height: 0.267rem; background: var(--ground); margin-top: 2px; }
.bar span { position: absolute; left: 0; top: 0; height: 100%; }
.cur { background: var(--accent); z-index: 1; }
.prevbar { background: var(--line-strong); height: 2px !important; top: 1px !important; }
@media (max-width: 73.333rem) { .grid { grid-template-columns: repeat(2, 1fr); } }
</style>
