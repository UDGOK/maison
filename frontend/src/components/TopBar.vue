<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { useCartStore } from '@/stores/cart'

const session = useSessionStore()
const sync = useSyncStore()
const cart = useCartStore()
const route = useRoute()
const router = useRouter()

const nav = [
  { name: 'sell', label: 'Sell' },
  { name: 'client', label: 'Client' },
  { name: 'queue', label: 'Queue' },
  { name: 'shift', label: 'Shift' },
  { name: 'settings', label: 'Settings' }
]

const statusClass = computed(() => (sync.online ? 'pill-good' : sync.queued ? 'pill-warn' : 'pill-crit'))
const statusText = computed(() => (sync.online ? 'Online' : 'Offline'))

function lock() {
  session.lock()
  cart.clear()
  router.push({ name: 'unlock' })
}
</script>

<template>
  <header class="topbar">
    <div class="wordmark display-900">MAISON</div>
    <div class="vline"></div>
    <div class="boutique">
      <div class="boutique-name ellipsis">{{ session.boutique?.boutique_name }}</div>
      <div class="label label-dim">{{ session.boutique?.name }}</div>
    </div>
    <nav class="nav">
      <button
        v-for="n in nav"
        :key="n.name"
        class="nav-btn"
        :class="{ active: route.name === n.name || (n.name === 'sell' && ['pay', 'receipt'].includes(String(route.name))) }"
        @click="router.push({ name: n.name })"
      >
        {{ n.label }}
        <span v-if="n.name === 'queue' && sync.errored" class="badge crit">{{ sync.errored }}</span>
      </button>
    </nav>
    <div class="spacer"></div>
    <div class="associate">
      <div class="assoc-name ellipsis">{{ session.associate?.full_name }}</div>
      <div class="label label-dim">{{ session.associate?.role }}</div>
    </div>
    <div class="pill status" :class="statusClass">
      <span class="dot"></span>
      {{ statusText }}
      <span v-if="sync.queued" class="queued">&middot; {{ sync.queued }} queued</span>
    </div>
    <button class="lock-btn label" @click="lock">Lock</button>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-h);
  flex: 0 0 var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 0 0 24px;
  border-bottom: var(--line-w) solid var(--line);
  background: var(--ground);
}
.wordmark {
  font-size: 17px;
  letter-spacing: 0.3em;
  margin-right: -0.3em;
  white-space: nowrap;
}
.vline {
  width: var(--line-w);
  height: 28px;
  background: var(--line-strong);
}
.boutique {
  min-width: 0;
  max-width: 220px;
}
.boutique-name {
  font-size: 14px;
  font-weight: 500;
}
.nav {
  display: flex;
  align-items: stretch;
  height: 100%;
  margin-left: 8px;
}
.nav-btn {
  position: relative;
  padding: 0 18px;
  height: var(--topbar-h);
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  border-bottom: 2px solid transparent;
}
.nav-btn:hover {
  color: var(--text);
}
.nav-btn.active {
  color: var(--text);
  border-bottom-color: var(--platinum);
}
.badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  border: 1px solid currentColor;
  font-size: 10px;
  letter-spacing: 0;
}
.spacer {
  flex: 1;
}
.associate {
  text-align: right;
  min-width: 0;
  max-width: 200px;
}
.assoc-name {
  font-size: 14px;
  font-weight: 500;
}
.status {
  height: 28px;
}
.queued {
  color: var(--text);
}
.lock-btn {
  height: var(--topbar-h);
  padding: 0 24px;
  border-left: var(--line-w) solid var(--line);
  color: var(--muted);
}
.lock-btn:hover {
  color: var(--text);
  background: var(--surface);
}
</style>
