<script setup lang="ts">
/** v0.5 K — "Welcome back, Mei-Lin": tier, points, and a discreet line about what is on file (masked). */
import { computed } from 'vue'
import { useSalonStore } from '../store'
import { fmtInt } from '@/utils/money'

const salon = useSalonStore()
const c = computed(() => salon.client)
const pct = computed(() => Math.round(((c.value?.tier_progress as number) || 0) * 100))
</script>

<template>
  <div class="salon-screen" data-testid="salon-client">
    <div class="s-eyebrow">{{ c?.tier ? `${c.tier} of the house` : 'Client of the house' }}</div>
    <div class="s-title soft">Welcome back, <span class="name" data-testid="client-first-name">{{ c?.first_name }}</span></div>
    <div class="s-rule"></div>
    <div class="facts">
      <div class="fact">
        <div class="s-num lg" data-testid="client-points">{{ fmtInt(c?.loyalty_points || 0) }}</div>
        <div class="s-eyebrow s-dim">Points</div>
      </div>
      <div v-if="c?.next_tier" class="fact">
        <div class="bar"><span :style="{ width: pct + '%' }"></span></div>
        <div class="s-eyebrow s-dim">{{ pct }}% of the way to {{ c.next_tier }}</div>
      </div>
    </div>
    <div class="s-small s-dim" data-testid="client-masked">
      <span v-if="c?.client_number_masked">Client № {{ c.client_number_masked }}</span>
      <span v-if="c?.phone_masked"> · {{ c.phone_masked }}</span>
      <span v-if="c?.email_masked"> · {{ c.email_masked }}</span>
    </div>
    <p class="s-lead" style="margin-top: 1em">Your associate is preparing your pieces.</p>
  </div>
</template>

<style scoped>
.name {
  color: var(--s-gold-2);
}
.facts {
  display: flex;
  gap: calc(var(--s-unit) * 3);
  align-items: flex-end;
  justify-content: center;
  flex-wrap: wrap;
}
.fact {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  min-width: 200px;
}
.bar {
  width: 260px;
  height: 2px;
  background: var(--s-line-soft);
  position: relative;
  overflow: hidden;
  margin-bottom: 18px;
}
.bar span {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, var(--s-gold-deep), var(--s-gold-2));
  transition: width 1600ms var(--s-ease);
}
</style>
