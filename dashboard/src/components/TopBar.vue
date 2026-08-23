<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fmtClock, fmtDate } from '../lib/format'
import { useBrand } from '../stores/brand' // v0.6 D1 — the wordmark and the scope line are tenant tokens

const brand = useBrand()

defineProps<{ live: boolean }>()

const now = ref(new Date())
let t: number
onMounted(() => (t = window.setInterval(() => (now.value = new Date()), 1000)))
onBeforeUnmount(() => clearInterval(t))
const clock = computed(() => fmtClock(now.value))
const date = computed(() => fmtDate(now.value))
</script>

<template>
  <header class="top">
    <div class="brand">
      <span class="display wordmark" data-testid="wordmark">{{ brand.wordmark }}</span>
      <span class="sep" />
      <span class="scope" data-testid="scope">{{ brand.scope }}</span>
    </div>
    <div class="right">
      <span class="label date">{{ date }}</span>
      <span class="display clock num">{{ clock }}</span>
      <span class="live" :class="{ off: !live }">
        <i class="pulse" :class="{ off: !live }" />
        {{ live ? 'Live' : 'Reconnecting' }}
      </span>
    </div>
  </header>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 4.8rem;
  padding: 0 var(--pad-x);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 20px; }
.wordmark { font-size: 1.733rem; letter-spacing: 0.02em; line-height: 1; }
.sep { width: 1px; height: 24px; background: var(--line); }
.scope { font-size: var(--fs-body); font-weight: 300; color: var(--muted); letter-spacing: 0.04em; }
.right { display: flex; align-items: center; gap: 28px; }
.date { color: var(--muted); }
.clock { font-size: 1.333rem; font-weight: 800; letter-spacing: 0; }
.live {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 1.867rem;
  padding: 0 0.8rem;
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: var(--fs-label);
  font-weight: 500;
  letter-spacing: 0.25em;
  text-transform: uppercase;
}
.live.off { color: var(--crit); border-color: rgba(196, 115, 106, 0.45); }
</style>
