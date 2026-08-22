<script setup lang="ts">
/** v0.5 K — payment: "Please present your card" (or cash) with the amount. */
import { computed } from 'vue'
import { useSalonStore } from '../store'
import { fmtMoney } from '@/utils/money'

const salon = useSalonStore()
const pay = computed(() => salon.remote.pay)
const total = computed(() => pay.value?.amount ?? salon.remote.totals?.grand_total ?? 0)
</script>

<template>
  <div class="salon-screen" data-testid="salon-pay" :data-mode="pay?.mode">
    <div class="s-eyebrow">{{ salon.client ? salon.client.first_name : 'Your purchase' }}</div>
    <div class="s-num xl" data-testid="pay-amount">{{ fmtMoney(total, salon.currency) }}</div>
    <div class="s-rule"></div>
    <template v-if="pay?.mode === 'card'">
      <div class="s-title soft">{{ pay.step === 'processing' ? 'One moment' : 'Please present your card to the terminal' }}</div>
      <p class="s-lead">{{ pay.step === 'processing' ? 'Your bank is confirming the payment.' : 'Tap, insert or swipe when the reader lights up.' }}</p>
      <div class="reader" :class="{ busy: pay.step === 'processing' }" aria-hidden="true"><span></span><span></span><span></span></div>
    </template>
    <template v-else>
      <div class="s-title soft">Your associate will take your payment</div>
      <p class="s-lead">Thank you for your patience.</p>
    </template>
  </div>
</template>

<style scoped>
.reader {
  display: flex;
  gap: 14px;
  margin-top: 12px;
}
.reader span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--s-gold);
  opacity: 0.25;
  animation: wave 1800ms var(--s-ease) infinite;
}
.reader span:nth-child(2) {
  animation-delay: 300ms;
}
.reader span:nth-child(3) {
  animation-delay: 600ms;
}
@keyframes wave {
  50% {
    opacity: 1;
    transform: translateY(-4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .reader span {
    animation: none;
    opacity: 0.7;
  }
}
</style>
