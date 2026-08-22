<script setup lang="ts">
import AnimatedNumber from './AnimatedNumber.vue'
import { fmtInt, fmtMoney, fmtPct } from '../lib/format'
import type { Totals } from '../types'

defineProps<{ totals: Totals; cardPct: number; cashPct: number; pending: number }>()
</script>

<template>
  <section class="kpis">
    <div class="kpi hero">
      <span class="label">Net sales</span>
      <span class="display value big"><AnimatedNumber :value="totals.net" :format="fmtMoney" /></span>
    </div>
    <div class="kpi">
      <span class="label">Invoices</span>
      <span class="display value"><AnimatedNumber :value="totals.invoices" :format="fmtInt" /></span>
    </div>
    <div class="kpi">
      <span class="label">Card / Cash</span>
      <span class="display value split">
        <AnimatedNumber :value="cardPct" :format="fmtPct" />
        <span class="slash">/</span>
        <AnimatedNumber class="dimmed" :value="cashPct" :format="fmtPct" />
      </span>
    </div>
    <div class="kpi">
      <span class="label">Avg ticket</span>
      <span class="display value"><AnimatedNumber :value="totals.avg_ticket" :format="fmtMoney" /></span>
    </div>
    <div class="kpi" :class="{ warn: pending > 0 }">
      <span class="label">Pending approvals</span>
      <span class="display value"><AnimatedNumber :value="pending" :format="fmtInt" /></span>
    </div>
  </section>
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
  border-bottom: 1px solid var(--line);
}
.kpi {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 14px;
  padding: 22px clamp(20px, 1.7vw, 32px) 20px;
  border-right: 1px solid var(--line);
  min-width: 0;
}
.kpi:last-child { border-right: 0; }
.value {
  font-size: clamp(28px, 2.1vw, 40px);
  font-weight: 800;
  line-height: 1;
  color: var(--text);
  white-space: nowrap;
}
.big { font-size: clamp(48px, 3.75vw, 72px); font-weight: 900; color: var(--platinum); letter-spacing: -0.04em; }
.split { display: inline-flex; align-items: baseline; gap: 10px; }
.slash { color: var(--dim); font-weight: 800; }
.dimmed { color: var(--muted); }
.warn .value { color: var(--warn); }
</style>
