<script setup lang="ts">
/**
 * v0.5 K — one-line Salon control inside the basket's client card: what the client display shows
 * right now, "Ask to identify" when no client is attached, and the Concierge toggle.
 */
import { useSalonPosStore } from '@/stores/salon'
import { useCartStore } from '@/stores/cart'

const salon = useSalonPosStore()
const cart = useCartStore()
const labels: Record<string, string> = { idle: 'Ambient', identify: 'Identify', client: 'Welcome', basket: 'Basket', pay: 'Payment', approved: 'Approved', receipt: 'Thank you', consent: 'Consent', feedback: 'Feedback', concierge: 'Concierge' }
</script>

<template>
  <div v-if="salon.paired" class="salon-bar" data-testid="salon-bar">
    <span class="label dim"><span class="dot" :class="{ on: salon.connected }"></span>Salon · <span class="accent" data-testid="salon-bar-screen">{{ labels[salon.lastScreen] || salon.lastScreen }}</span></span>
    <span class="grow"></span>
    <button v-if="!cart.customer" class="label link" data-testid="salon-ask-identify" @click="salon.requestIdentify()">Ask to identify</button>
    <button v-else class="label link" :class="{ on: salon.concierge }" data-testid="salon-concierge" @click="salon.setConcierge(!salon.concierge)">{{ salon.concierge ? 'End concierge' : 'Concierge' }}</button>
  </div>
</template>

<style scoped>
.salon-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 2px 0;
  border-top: var(--line-w) solid var(--line);
}
.grow {
  flex: 1;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dim);
  margin-right: 8px;
  vertical-align: middle;
}
.dot.on {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.link {
  min-height: 32px;
  padding: 0 8px;
  color: var(--accent);
  border: var(--line-w) solid transparent;
}
.link.on {
  border-color: var(--accent);
}
</style>
