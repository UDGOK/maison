<script setup lang="ts">
/** "Trending in stores" — chain-wide items ranked by velocity change, from precomputed trends. */
import { fmtCompact, fmtInt, fmtMoney, fmtPct } from '../../lib/format'
import type { TrendRow } from '../../types'

defineProps<{ rows: TrendRow[]; period: '7d' | '28d' }>()
const badgeClass = (b: string) => ({ 'Trending up': 'up', New: 'new', Cooling: 'cooling' })[b] ?? ''
const d = (p: number | null) => (p === null ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%`)
</script>

<template>
  <div class="trend" data-testid="trending">
    <div class="row hdr">
      <span class="label">#</span>
      <span class="label">Item</span>
      <span class="label">Group</span>
      <span class="label r">Units</span>
      <span class="label r">Prev</span>
      <span class="label r">Δ prev</span>
      <span class="label r">Δ 28 d</span>
      <span class="label r">Net</span>
      <span class="label r">Stores</span>
      <span class="label r">Sell-thr.</span>
      <span class="label r">DoH</span>
      <span class="label">Badge</span>
      <span class="label">Velocity</span>
    </div>
    <div v-for="(r, i) in rows" :key="r.item_code" class="row" :class="{ cooling: r.badge === 'Cooling' }" :data-item="r.item_code">
      <span class="num idx">{{ String(i + 1).padStart(2, '0') }}</span>
      <span class="name"><span class="display code">{{ r.item_code }}</span><span class="iname">{{ r.item_name }}</span></span>
      <span class="grp">{{ r.item_group ?? '—' }}</span>
      <span class="num r strong">{{ fmtInt(r.units) }}</span>
      <span class="num r dim">{{ fmtInt(r.units_prev) }}</span>
      <span class="num r" :class="r.delta_pct === null ? 'flat' : r.delta_pct >= 0 ? 'up' : 'down'">{{ d(r.delta_pct) }}</span>
      <span class="num r" :class="r.baseline_delta_pct === null ? 'flat' : r.baseline_delta_pct >= 0 ? 'up' : 'down'">{{ d(r.baseline_delta_pct) }}</span>
      <span class="num r">{{ fmtMoney(r.net) }}</span>
      <span class="num r dim">{{ r.store_count }}</span>
      <span class="num r dim">{{ fmtPct(r.sell_through * 100) }}</span>
      <span class="num r dim">{{ r.days_on_hand === null ? '∞' : fmtCompact(r.days_on_hand) }}</span>
      <span><span class="badge" :class="badgeClass(r.badge)">{{ r.badge || 'Steady' }}</span></span>
      <span class="vel" :title="`${r.velocity} units / week`"><span class="vbar" :style="{ width: `${Math.min(100, (r.units / Math.max(1, rows[0]?.units ?? 1, ...rows.map((x) => x.units))) * 100)}%` }" /></span>
    </div>
    <p v-if="!rows.length" class="label empty">No trend rows yet — run compute_trends.</p>
  </div>
</template>

<style scoped>
.trend { overflow-y: auto; min-height: 0; }
.row { display: grid; grid-template-columns: 1.6rem minmax(0, 2.2fr) minmax(0, 1fr) 0.6fr 0.5fr 0.7fr 0.7fr 1fr 0.5fr 0.6fr 0.5fr 7rem 5rem; gap: 0.8rem; align-items: center; height: 2.93rem; padding: 0 1.4rem; border-bottom: 1px solid var(--line); font-size: var(--fs-small); }
.row.hdr { height: 2.2rem; position: sticky; top: 0; background: var(--surface); z-index: 1; }
.row.cooling .strong { color: var(--muted); }
.idx { color: var(--dim); font-size: var(--fs-label); letter-spacing: 0.1em; }
.name { display: flex; align-items: baseline; gap: 0.6rem; min-width: 0; }
.code { font-size: var(--fs-label); font-weight: 800; letter-spacing: 0.04em; color: var(--muted); }
.iname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
.grp { color: var(--muted); font-weight: 300; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.strong { font-weight: 500; font-size: var(--fs-num); color: var(--text); }
.dim { color: var(--dim); }
.vel { display: block; height: 0.5rem; background: var(--surface-2); }
.vbar { display: block; height: 100%; background: var(--accent-deep); }
.empty { padding: 1rem 1.4rem; }
</style>
