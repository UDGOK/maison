<script setup lang="ts">
/** v0.5 K — "Approved" with a gold pulse. */
import { computed } from 'vue'
import { useSalonStore } from '../store'
import { fmtMoney } from '@/utils/money'

const salon = useSalonStore()
const pay = computed(() => salon.remote.pay)
</script>

<template>
  <div class="salon-screen" data-testid="salon-approved">
    <div class="s-pulse">✓</div>
    <div class="s-title">Approved</div>
    <div class="s-num lg">{{ fmtMoney(pay?.amount ?? salon.remote.totals?.grand_total ?? 0, salon.currency) }}</div>
    <div v-if="pay?.last4" class="s-small s-dim">{{ pay.card_brand }} ···· {{ pay.last4 }}</div>
  </div>
</template>
