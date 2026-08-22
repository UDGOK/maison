<script setup lang="ts">
/** "Top products by store" — per-boutique top 10 by net or units with share of boutique sales. */
import { fmtInt, fmtMoney } from '../../lib/format'
import type { TrendRow } from '../../types'

defineProps<{ top: Record<string, TrendRow[]>; boutiques: string[]; by: 'net' | 'units'; boutiqueNet: Record<string, number> }>()
</script>

<template>
  <div class="cols" :style="{ gridTemplateColumns: `repeat(${Math.min(boutiques.length, 4)}, minmax(0, 1fr))` }" data-testid="top-by-store">
    <section v-for="b in boutiques" :key="b" class="card col" :data-boutique="b">
      <header class="head"><span class="display code">{{ b }}</span><span class="label">{{ fmtMoney(boutiqueNet[b] ?? 0) }} net</span></header>
      <ol class="list">
        <li v-for="r in top[b] ?? []" :key="r.item_code" class="li">
          <span class="num idx">{{ String(by === 'units' ? r.rank_units : r.rank).padStart(2, '0') }}</span>
          <span class="name">{{ r.item_name }}</span>
          <span class="num v">{{ by === 'units' ? fmtInt(r.units) : fmtMoney(r.net) }}</span>
          <span class="share"><span class="fill" :style="{ width: `${Math.min(100, r.share_pct)}%` }" /></span>
          <span class="num pct">{{ r.share_pct.toFixed(0) }}%</span>
        </li>
        <li v-if="!(top[b] ?? []).length" class="label pad">No sales in period</li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.cols { display: grid; gap: var(--gap); align-items: start; }
.col .head .code { font-size: var(--fs-num); font-weight: 800; }
.list { list-style: none; padding: 0.4rem 1.4rem 0.8rem; }
.li { display: grid; grid-template-columns: 1.4rem minmax(0, 1fr) auto 3.6rem 2.4rem; gap: 0.6rem; align-items: center; padding: 0.45rem 0; border-bottom: 1px solid var(--line); font-size: var(--fs-small); }
.li:first-child .v { color: var(--accent); }
.idx { color: var(--dim); font-size: var(--fs-label); letter-spacing: 0.1em; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v { font-weight: 500; white-space: nowrap; }
.share { height: 0.4rem; background: var(--surface-2); }
.fill { display: block; height: 100%; background: var(--accent-deep); }
.pct { color: var(--dim); text-align: right; font-size: var(--fs-label); }
.pad { padding: 0.6rem 0; }
</style>
