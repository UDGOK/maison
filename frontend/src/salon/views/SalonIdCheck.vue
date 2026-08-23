<script setup lang="ts">
/** v0.6 N — "Please present your ID": the POS is waiting for a 21+ check before an age-restricted item is rung up. */
import { computed } from 'vue'
import { useSalonStore } from '../store'

const salon = useSalonStore()
const age = computed(() => salon.remote.age || null)
const blocked = computed(() => age.value?.status === 'blocked')
</script>

<template>
  <div class="salon-screen" data-testid="salon-idcheck" :data-status="age?.status || 'ask'">
    <div class="s-eyebrow">{{ salon.minimumAge }}+ only</div>
    <div class="s-title soft" data-testid="idcheck-title">{{ blocked ? 'We cannot sell this item today' : 'Please present your ID' }}</div>
    <p class="s-lead">
      <template v-if="blocked">{{ age?.outcome === 'Expired' ? 'The ID presented has expired.' : 'A valid government ID showing you are ' + salon.minimumAge + ' or older is required.' }} The rest of your purchase can continue.</template>
      <template v-else>One or more items in this basket are for adults {{ salon.minimumAge }} and over. Hand your driver’s licence or state ID to the associate — we check the date of birth and keep nothing else.</template>
    </p>
    <div class="id-card" aria-hidden="true">
      <div class="id-photo"></div>
      <div class="id-lines"><span></span><span></span><span class="short"></span></div>
      <div class="id-barcode"></div>
    </div>
    <div class="s-small s-dim">{{ salon.brandName }} sells age-restricted products only to adults {{ salon.minimumAge }}+.</div>
  </div>
</template>

<style scoped>
.id-card {
  width: 260px;
  height: 160px;
  margin: 28px auto 16px;
  border: 1px solid rgba(201, 162, 77, 0.55);
  border-radius: 10px;
  padding: 18px;
  display: grid;
  grid-template-columns: 70px 1fr;
  grid-template-rows: 1fr 26px;
  gap: 14px;
  opacity: 0.85;
}
.id-photo {
  background: rgba(201, 162, 77, 0.18);
  border-radius: 6px;
}
.id-lines {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
}
.id-lines span {
  height: 8px;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 4px;
}
.id-lines .short {
  width: 55%;
}
.id-barcode {
  grid-column: 1 / span 2;
  background: repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.35) 0 3px, transparent 3px 5px, rgba(255, 255, 255, 0.2) 5px 7px, transparent 7px 11px);
  border-radius: 3px;
}
[data-status='blocked'] .id-card {
  border-color: rgba(214, 90, 70, 0.7);
}
</style>
