<script setup lang="ts">
/**
 * v0.5 L — Live KPI strip: net (+ vs same weekday last week), invoices, card/cash, avg ticket,
 * returns, pending approvals, low-stock, open feedback ≤ 2. One accent (gold) for the hero number.
 *
 * v0.6 R — one baseline grid for the whole strip and values that stay inside their cell:
 *  - every tile is the same three-row grid (label / value / sub) and the value row is a fixed
 *    height with the number bottom-aligned, so all eight numbers sit on one line however tall the
 *    hero is and whether or not a tile has a sub-line (Avg ticket had none and floated to the
 *    bottom of its cell);
 *  - values are clamped to their column (`min-width: 0` + hidden overflow) and the two-number
 *    card/cash tile shrinks a step, so a long value can never spill into the neighbour;
 *  - `cardPct` / `cashPct` are now a share of gross tender volume (see `stores/dashboard.ts`),
 *    which is always 0–100 % — the old signed share of net produced "−62% / 157%" on a returns day.
 */
import AnimatedNumber from './AnimatedNumber.vue'
import { fmtInt, fmtMoney, fmtPct } from '../lib/format'
import type { LiveTotals } from '../types'
import { useBrand } from '../stores/brand' // v0.6 D1

const brand = useBrand()

defineProps<{ totals: LiveTotals; cardPct: number; cashPct: number; pending: number; lowStock: number; feedbackOpen: number; online?: number; boutiques?: number }>()

function delta(p: number | null | undefined): string {
  if (p === null || p === undefined) return '— vs LW'
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}% vs same day LW`
}
</script>

<template>
  <section class="kpis">
    <div class="kpi hero">
      <span class="label">Net sales · today</span>
      <span class="display value big"><AnimatedNumber :value="totals.net" :format="fmtMoney" /></span>
      <span class="sub num" :class="(totals.vs_last_week_pct ?? 0) >= 0 ? 'up' : 'down'">{{ delta(totals.vs_last_week_pct) }}</span>
    </div>
    <div class="kpi">
      <span class="label">Invoices</span>
      <span class="display value"><AnimatedNumber :value="totals.invoices" :format="fmtInt" /></span>
      <span class="sub num">{{ online ?? 0 }} / {{ boutiques ?? 0 }} {{ brand.storesLower }} online</span>
    </div>
    <div class="kpi">
      <span class="label">Card / Cash</span>
      <span class="display value split" data-testid="card-cash">
        <AnimatedNumber :value="cardPct" :format="fmtPct" />
        <span class="slash">/</span>
        <AnimatedNumber class="dimmed" :value="cashPct" :format="fmtPct" />
      </span>
      <span class="sub num" title="share of gross tender taken today">of gross · {{ fmtMoney(totals.card) }} · {{ fmtMoney(totals.cash) }}</span>
    </div>
    <div class="kpi">
      <span class="label">Avg ticket</span>
      <span class="display value"><AnimatedNumber :value="totals.avg_ticket" :format="fmtMoney" /></span>
      <span class="sub num" aria-hidden="true"></span>
    </div>
    <div class="kpi" :class="{ warn: (totals.returns ?? 0) > 0 }">
      <span class="label">Returns</span>
      <span class="display value"><AnimatedNumber :value="totals.returns ?? 0" :format="fmtInt" /></span>
      <span class="sub num">{{ fmtMoney(totals.returns_value ?? 0) }}</span>
    </div>
    <div class="kpi" :class="{ warn: pending > 0 }">
      <span class="label">Pending approvals</span>
      <span class="display value"><AnimatedNumber :value="pending" :format="fmtInt" /></span>
      <span class="sub num" aria-hidden="true"></span>
    </div>
    <div class="kpi" :class="{ warn: lowStock > 0 }">
      <span class="label">Low stock</span>
      <span class="display value"><AnimatedNumber :value="lowStock" :format="fmtInt" /></span>
      <span class="sub num" aria-hidden="true"></span>
    </div>
    <div class="kpi" :class="{ crit: feedbackOpen > 0 }">
      <span class="label">Feedback ≤ 2</span>
      <span class="display value"><AnimatedNumber :value="feedbackOpen" :format="fmtInt" /></span>
      <span class="sub num" aria-hidden="true"></span>
    </div>
  </section>
</template>

<style scoped>
.kpis { display: grid; grid-template-columns: 2.2fr repeat(7, 1fr); border-bottom: 1px solid var(--line); }
/* one shared grid: label row, a fixed value row (numbers bottom-aligned onto one baseline), sub row */
.kpi {
  display: grid;
  grid-template-rows: auto var(--kpi-value-row, 3.9rem) auto;
  gap: 0.5rem;
  padding: 1.2rem 1.4rem 1rem;
  border-right: 1px solid var(--line);
  min-width: 0;
}
.kpi:last-child { border-right: 0; }
/* labels wrap rather than ellipsise — "Pending approvals" is not a label you can cut in half, and
   with the shared row every tile's value still starts on the same line */
.kpi .label { min-width: 0; overflow-wrap: anywhere; }
.value {
  align-self: end;
  font-size: var(--fs-kpi);
  font-weight: 800;
  line-height: 1;
  color: var(--text);
  white-space: nowrap;
  /* the tile is the boundary: a long value shrinks and, past that, clips — it never crosses the rule */
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: clip;
}
.big { font-size: var(--fs-hero); font-weight: 900; color: var(--accent); letter-spacing: -0.04em; }
/* two numbers in one cell: a step down from the single-number tiles so "100% / 100%" still fits
   between the rules at 1366 — the widest case the strip has to survive */
.split { display: inline-flex; align-items: baseline; gap: 0.25rem; font-size: clamp(1.05rem, 1.35vw, 1.7rem); }
.slash { color: var(--dim); font-weight: 800; }
.dimmed { color: var(--muted); }
.sub { align-self: end; font-size: var(--fs-small); color: var(--dim); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.2em; min-width: 0; }
.warn .value { color: var(--warn); }
.crit .value { color: var(--crit); }
/* where subgrid is available the eight tiles share the strip's rows outright, so the numbers align
   on a true baseline instead of on the bottom of a fixed row */
@supports (grid-template-rows: subgrid) {
  .kpis { grid-template-rows: auto var(--kpi-value-row, 3.9rem) auto; }
  .kpi { grid-row: span 3; grid-template-rows: subgrid; }
  .value { align-self: baseline; }
}
@media (max-width: 1600px) {
  .kpis { grid-template-columns: 2fr repeat(7, 1fr); --kpi-value-row: 3.4rem; }
  .kpi { padding: 0.9rem 1rem 0.8rem; }
  .big { font-size: 3rem; }
}
@media (max-width: 1100px) {
  .kpis { grid-template-columns: repeat(4, 1fr); }
  .hero { grid-column: span 4; }
}
</style>
