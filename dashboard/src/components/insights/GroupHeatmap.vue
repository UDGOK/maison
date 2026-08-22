<script setup lang="ts">
import { computed } from 'vue'
import { fmtCompact } from '../../lib/format'
import type { HeatCell } from '../../insights/types'

const props = defineProps<{ cells: HeatCell[]; boutiques: string[]; groups: string[]; days: number }>()

const lookup = computed(() => {
  const m = new Map<string, HeatCell>()
  for (const c of props.cells) m.set(`${c.item_group}|${c.boutique}`, c)
  return m
})
const max = computed(() => Math.max(1, ...props.cells.map((c) => c.revenue)))
function cell(g: string, b: string): HeatCell | undefined {
  return lookup.value.get(`${g}|${b}`)
}
/** gold fill scaled by revenue share of the largest cell (sqrt so small cells are still visible) */
function fill(c?: HeatCell): string {
  if (!c || !c.revenue) return 'transparent'
  const a = 0.08 + 0.72 * Math.sqrt(c.revenue / max.value)
  return `rgba(201, 169, 110, ${a.toFixed(3)})`
}
function ink(c?: HeatCell): string {
  if (!c || !c.revenue) return 'var(--dim)'
  return c.revenue / max.value > 0.42 ? 'var(--ink-on-accent)' : 'var(--text)'
}
const rowTotals = computed(() => Object.fromEntries(props.groups.map((g) => [g, props.boutiques.reduce((s, b) => s + (cell(g, b)?.revenue ?? 0), 0)])))
const colTotals = computed(() => Object.fromEntries(props.boutiques.map((b) => [b, props.groups.reduce((s, g) => s + (cell(g, b)?.revenue ?? 0), 0)])))
</script>

<template>
  <section class="card">
    <header class="head">
      <span class="label">Revenue · item group × boutique</span>
      <span class="label meta">last {{ days }} days · index vs chain average</span>
    </header>
    <div class="grid" :style="{ gridTemplateColumns: `minmax(150px, 1.2fr) repeat(${boutiques.length}, minmax(0, 1fr)) 90px` }">
      <span class="label corner"></span>
      <span v-for="b in boutiques" :key="b" class="label col display">{{ b }}</span>
      <span class="label col r">Total</span>
      <template v-for="g in groups" :key="g">
        <span class="rowhead">{{ g }}</span>
        <div v-for="b in boutiques" :key="b" class="cell" :style="{ background: fill(cell(g, b)), color: ink(cell(g, b)) }" :title="`${g} · ${b}: ${cell(g, b)?.units ?? 0} units, ${cell(g, b)?.on_hand ?? 0} on hand`">
          <span class="num val">{{ cell(g, b)?.revenue ? fmtCompact(cell(g, b)!.revenue) : '—' }}</span>
          <span v-if="cell(g, b)?.index != null" class="num idx">{{ cell(g, b)!.index!.toFixed(2) }}×</span>
        </div>
        <span class="num total r">{{ fmtCompact(rowTotals[g] ?? 0) }}</span>
      </template>
      <span class="label rowhead foot">Total</span>
      <span v-for="b in boutiques" :key="'t' + b" class="num total foot">{{ fmtCompact(colTotals[b] ?? 0) }}</span>
      <span class="num total foot r accent">{{ fmtCompact(Object.values(colTotals).reduce((s, v) => s + v, 0)) }}</span>
    </div>
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--line); background: var(--surface); min-width: 0; }
.head { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 22px 12px; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); letter-spacing: 0.12em; text-transform: none; }
.grid { display: grid; gap: 4px; padding: 16px 22px 20px; align-items: stretch; }
.col { text-align: center; padding-bottom: 6px; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; color: var(--muted); }
.col.r { text-align: right; font-family: var(--body); font-weight: 500; }
.rowhead { display: flex; align-items: center; font-size: 14px; color: var(--text); padding-right: 8px; font-weight: 300; }
.cell { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 2px; min-height: 54px; border: 1px solid var(--line); }
.val { font-size: 17px; font-weight: 500; }
.idx { font-size: 11px; opacity: 0.8; letter-spacing: 0.06em; }
.total { display: flex; align-items: center; justify-content: flex-end; font-size: 14px; color: var(--muted); }
.foot { border-top: 1px solid var(--line-strong); padding-top: 8px; justify-content: center; }
.foot.r { justify-content: flex-end; }
.accent { color: var(--accent); font-weight: 500; }
.r { text-align: right; }
</style>
