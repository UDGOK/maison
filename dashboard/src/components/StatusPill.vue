<script setup lang="ts">
import { computed } from 'vue'
import type { BoutiqueStatus } from '../types'

const props = defineProps<{ status: BoutiqueStatus; queued?: number }>()

const label = computed(() => {
  if (props.status === 'online') return 'Online'
  if (props.status === 'pending_approval') return 'Price approval pending'
  return props.queued ? `Offline · ${props.queued} queued` : 'Offline'
})
</script>

<template>
  <span class="pill" :class="status">
    <i class="dot" />
    {{ label }}
  </span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.533rem;
  height: 1.6rem;
  padding: 0 0.667rem;
  border: 1px solid var(--line);
  font-size: 0.733rem;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}
.dot {
  width: 0.4rem;
  height: 0.4rem;
  background: var(--dim);
}
.online .dot { background: var(--good); }
.online { color: var(--accent); border-color: var(--accent); }
.offline .dot { background: var(--crit); }
.offline { color: var(--crit); border-color: rgba(196, 115, 106, 0.4); }
.pending_approval .dot { background: var(--warn); }
.pending_approval { color: var(--warn); border-color: rgba(211, 165, 91, 0.4); }
</style>
