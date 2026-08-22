<script setup lang="ts">
/**
 * v0.5 L — Live KPI strip: net (+ vs same weekday last week), invoices, card/cash, avg ticket,
 * returns, pending approvals, low-stock, open feedback ≤ 2. One accent (gold) for the hero number.
 */
import AnimatedNumber from './AnimatedNumber.vue'
import { fmtInt, fmtMoney, fmtPct } from '../lib/format'
import type { LiveTotals } from '../types'

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
      <span class="sub num">{{ online ?? 0 }} / {{ boutiques ?? 0 }} boutiques online</span>
    </div>
    <div class="kpi">
      <span class="label">Card / Cash</span>
      <span class="display value split">
        <AnimatedNumber :value="cardPct" :format="fmtPct" />
        <span class="slash">/</span>
        <AnimatedNumber class="dimmed" :value="cashPct" :format="fmtPct" />
      </span>
      <span class="sub num">{{ fmtMoney(totals.card) }} · {{ fmtMoney(totals.cash) }}</span>
    </div>
    <div class="kpi">
      <span class="label">Avg ticket</span>
      <span class="display value"><AnimatedNumber :value="totals.avg_ticket" :format="fmtMoney" /></span>
    </div>
    <div class="kpi" :class="{ warn: (totals.returns ?? 0) > 0 }">
      <span class="label">Returns</span>
      <span class="display value"><AnimatedNumber :value="totals.returns ?? 0" :format="fmtInt" /></span>
      <span class="sub num">{{ fmtMoney(totals.returns_value ?? 0) }}</span>
    </div>
    <div class="kpi" :class="{ warn: pending > 0 }">
      <span class="label">Pending approvals</span>
      <span class="display value"><AnimatedNumber :value="pending" :format="fmtInt" /></span>
    </div>
    <div class="kpi" :class="{ warn: lowStock > 0 }">
      <span class="label">Low stock</span>
      <span class="display value"><AnimatedNumber :value="lowStock" :format="fmtInt" /></span>
    </div>
    <div class="kpi" :class="{ crit: feedbackOpen > 0 }">
      <span class="label">Feedback ≤ 2</span>
      <span class="display value"><AnimatedNumber :value="feedbackOpen" :format="fmtInt" /></span>
    </div>
  </section>
</template>

<style scoped>
.kpis { display: grid; grid-template-columns: 2.2fr repeat(7, 1fr); border-bottom: 1px solid var(--line); }
.kpi { display: flex; flex-direction: column; justify-content: space-between; gap: 0.6rem; padding: 1.2rem 1.4rem 1rem; border-right: 1px solid var(--line); min-width: 0; }
.kpi:last-child { border-right: 0; }
.value { font-size: var(--fs-kpi); font-weight: 800; line-height: 1; color: var(--text); white-space: nowrap; }
.big { font-size: var(--fs-hero); font-weight: 900; color: var(--accent); letter-spacing: -0.04em; }
.split { display: inline-flex; align-items: baseline; gap: 0.5rem; }
.slash { color: var(--dim); font-weight: 800; }
.dimmed { color: var(--muted); }
.sub { font-size: var(--fs-small); color: var(--dim); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.2em; }
.warn .value { color: var(--warn); }
.crit .value { color: var(--crit); }
@media (max-width: 1600px) {
  .kpis { grid-template-columns: 2fr repeat(7, 1fr); }
  .kpi { padding: 0.9rem 1rem 0.8rem; }
}
@media (max-width: 1100px) {
  .kpis { grid-template-columns: repeat(4, 1fr); }
  .hero { grid-column: span 4; }
}
</style>
