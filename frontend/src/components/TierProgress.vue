<script setup lang="ts">
/** v0.4 I — loyalty tier ladder with progress to the next tier (+ expiring points). */
import { computed } from 'vue'
import type { TierProgress } from '@/api/v04'
import { progressPercent } from '@/utils/promos'
import { fmtInt, fmtMoney } from '@/utils/money'

const props = defineProps<{ loyalty: TierProgress | null; currency: string; compact?: boolean }>()
const pct = computed(() => progressPercent(props.loyalty))
const tiers = computed(() => props.loyalty?.tiers || [])
const currentIdx = computed(() => tiers.value.findIndex((t) => t.tier === props.loyalty?.tier))
</script>

<template>
  <div v-if="loyalty && loyalty.program" class="tier" :class="{ compact }" data-testid="tier-progress">
    <div class="between">
      <span class="label">
        <span class="accent">{{ loyalty.tier || 'Member' }}</span>
        <span v-if="loyalty.tier_override" class="dim"> · set by manager</span>
      </span>
      <span v-if="loyalty.next_tier" class="small dim">{{ fmtMoney(loyalty.to_next_tier || 0, currency) }} to {{ loyalty.next_tier }}</span>
      <span v-else class="small dim">Highest tier</span>
    </div>
    <div class="bar" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100">
      <i :style="{ width: pct + '%' }"></i>
    </div>
    <div v-if="!compact" class="ladder">
      <span v-for="(t, i) in tiers" :key="t.tier" class="step" :class="{ done: i <= currentIdx, next: i === currentIdx + 1 }">
        <span class="dot"></span>
        <span class="step-name">{{ t.tier }}</span>
        <span class="step-min num">{{ t.min_spent ? fmtMoney(t.min_spent, currency) : '—' }}</span>
      </span>
    </div>
    <div v-if="!compact && (loyalty.points_expiring_90d || loyalty.expiry_duration_days)" class="small dim exp">
      <span v-if="loyalty.points_expiring_90d" class="warn">{{ fmtInt(loyalty.points_expiring_90d) }} pts expire within 90 days</span>
      <span v-else-if="loyalty.expiry_duration_days">Points expire {{ loyalty.expiry_duration_days }} days after they are earned</span>
    </div>
  </div>
</template>

<style scoped>
.tier {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bar {
  height: 4px;
  background: var(--line-strong);
}
.bar > i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--t-fast);
}
.ladder {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
}
.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--dim);
  flex: 1;
}
.step:first-child {
  align-items: flex-start;
}
.step:last-child {
  align-items: flex-end;
}
.dot {
  width: 8px;
  height: 8px;
  border: var(--line-w) solid var(--line-strong);
}
.step.done .dot {
  background: var(--accent);
  border-color: var(--accent);
}
.step.next .dot {
  border-color: var(--accent);
}
.step.done .step-name {
  color: var(--text);
}
.step-name {
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.step-min {
  font-size: 11px;
}
.exp {
  margin-top: 2px;
}
.small {
  font-size: 12px;
}
</style>
