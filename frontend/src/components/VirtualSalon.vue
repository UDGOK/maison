<script setup lang="ts">
/**
 * v0.5 K (dev, VITE_MOCK=1) — a floating iPad-mini-shaped pane that runs the real Salon app
 * (`/salon`) next to the POS. State is shared through the mock "server" in localStorage, exactly
 * like a second device would share it through Frappe.
 */
import { computed, ref } from 'vue'
import { useSalonPosStore } from '@/stores/salon'

const salon = useSalonPosStore()
const landscape = ref(false)
const src = computed(() => (salon.pairing ? `/salon?code=${salon.pairing.code}` : '/salon'))
const key = ref(0)
</script>

<template>
  <div v-if="salon.virtualOpen" class="vs" :class="{ landscape }" data-testid="virtual-salon">
    <div class="vs-bar">
      <span class="label">Virtual salon</span>
      <span class="grow"></span>
      <button class="label link" @click="landscape = !landscape">{{ landscape ? 'Portrait' : 'Landscape' }}</button>
      <button class="label link" @click="key++">Reload</button>
      <button class="label link" @click="salon.setVirtual(false)">Close</button>
    </div>
    <iframe :key="key" :src="src" title="AWANZ Salon (virtual)"></iframe>
  </div>
</template>

<style scoped>
.vs {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 60;
  width: 390px;
  height: 560px;
  background: var(--ground);
  border: var(--line-w) solid var(--line-strong);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
}
.vs.landscape {
  width: 640px;
  height: 520px;
}
.vs-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 4px 12px;
  white-space: nowrap;
  border-bottom: var(--line-w) solid var(--line);
  background: var(--surface);
}
.grow {
  flex: 1;
}
.link {
  min-height: 28px;
  padding: 0 6px;
  color: var(--accent);
}
iframe {
  flex: 1;
  border: 0;
  width: 100%;
  background: #0b0b0a;
}
</style>
