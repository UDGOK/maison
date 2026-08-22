<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { useCartStore } from '@/stores/cart'
import { useLayoutStore } from '@/stores/layout'
import { useWebOrdersStore } from '@/stores/webOrders' // v0.4 G

const session = useSessionStore()
const sync = useSyncStore()
const cart = useCartStore()
const layout = useLayoutStore()
const webOrders = useWebOrdersStore() // v0.4 G
const route = useRoute()
const router = useRouter()

const nav = [
  { name: 'sell', label: 'Sell' },
  { name: 'client', label: 'Client' },
  { name: 'returns', label: 'Returns' }, // v0.4 E
  { name: 'web-orders', label: 'Web orders', short: 'Web' }, // v0.4 G
  { name: 'count', label: 'Count' }, // v0.4 D — cycle count
  { name: 'queue', label: 'Queue' },
  { name: 'shift', label: 'Shift' },
  { name: 'settings', label: 'Settings' }
]

/** iPad (≤ 1100 px): 8 entries share one row — short labels + the boutique code only. */
const compact = computed(() => !layout.phone && layout.width <= 1100)
const labelFor = (n: { label: string; short?: string }) => (compact.value && n.short ? n.short : n.label)

const statusClass = computed(() => (sync.online ? 'pill-accent' : sync.queued ? 'pill-warn' : 'pill-crit'))
const statusText = computed(() => (sync.online ? 'Online' : 'Offline'))
const isActive = (n: string) => route.name === n || (n === 'sell' && ['pay', 'receipt'].includes(String(route.name))) || (n === 'returns' && route.name === 'exchange')

function go(name: string) {
  layout.navOpen = false
  router.push({ name })
}
function lock() {
  layout.navOpen = false
  session.lock()
  cart.clear()
  router.push({ name: 'unlock' })
}
</script>

<template>
  <header class="topbar" :class="{ phone: layout.phone }">
    <div class="wordmark display-900">MAISON</div>
    <template v-if="!layout.phone">
      <div class="vline"></div>
      <div class="boutique">
        <div v-if="!compact" class="boutique-name ellipsis">{{ session.boutique?.boutique_name }}</div>
        <div class="label label-dim">{{ session.boutique?.name }}</div>
      </div>
      <nav class="nav">
        <button v-for="n in nav" :key="n.name" class="nav-btn" :class="{ active: isActive(n.name) }" :title="n.label" @click="go(n.name)">
          {{ labelFor(n) }}
          <span v-if="n.name === 'queue' && sync.errored" class="badge crit">{{ sync.errored }}</span>
          <span v-if="n.name === 'web-orders' && webOrders.badge" class="badge" data-testid="web-orders-badge">{{ webOrders.badge }}</span>
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
    </template>

    <template v-else>
      <div class="ph-boutique label label-dim ellipsis">{{ session.boutique?.name }}</div>
      <div class="spacer"></div>
      <div class="pill status" :class="statusClass">
        <span class="dot"></span>
        {{ statusText }}<span v-if="sync.queued" class="queued"> &middot; {{ sync.queued }}</span>
      </div>
      <button class="menu-btn" :class="{ open: layout.navOpen }" aria-label="Menu" @click="layout.navOpen = !layout.navOpen">
        <span></span><span></span><span></span>
        <span v-if="sync.errored && !layout.navOpen" class="menu-badge"></span>
      </button>
    </template>

    <Teleport to="body">
      <div v-if="layout.phone && layout.navOpen" class="drawer-backdrop" @click.self="layout.navOpen = false">
        <nav class="drawer">
          <div class="drawer-head">
            <div class="assoc-name ellipsis">{{ session.associate?.full_name }}</div>
            <div class="label label-dim">{{ session.associate?.role }} &middot; {{ session.boutique?.boutique_name }}</div>
          </div>
          <button v-for="n in nav" :key="n.name" class="drawer-btn" :class="{ active: isActive(n.name) }" @click="go(n.name)">
            {{ n.label }}
            <span v-if="n.name === 'queue' && sync.errored" class="badge crit">{{ sync.errored }}</span>
            <span v-if="n.name === 'web-orders' && webOrders.badge" class="badge">{{ webOrders.badge }}</span>
          </button>
          <button class="drawer-btn lock" @click="lock">Lock</button>
        </nav>
      </div>
    </Teleport>
  </header>
</template>

<style scoped>
.topbar {
  height: calc(var(--topbar-h) + var(--safe-top));
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: var(--safe-top) 0 0 24px;
  border-bottom: var(--line-w) solid var(--line);
  background: var(--ground);
}
.wordmark {
  font-size: 17px;
  letter-spacing: 0.3em;
  margin-right: -0.3em;
  white-space: nowrap;
  color: var(--accent);
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
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.nav::-webkit-scrollbar {
  display: none;
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
  color: var(--accent);
  border-bottom-color: var(--accent);
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

/* ---------- compact tablet (iPad 1024–1180 px): 8 entries must still fit on one row ---------- */
@media (max-width: 1180px) {
  .topbar {
    gap: 14px;
  }
  .boutique {
    max-width: 150px;
  }
  .nav-btn {
    padding: 0 10px;
    letter-spacing: 0.14em;
    white-space: nowrap;
  }
  .associate {
    max-width: 140px;
  }
  .lock-btn {
    padding: 0 16px;
  }
}
@media (max-width: 1100px) {
  .nav-btn {
    padding: 0 9px;
    letter-spacing: 0.12em;
  }
  .associate .label {
    display: none;
  }
  .status .queued {
    display: none;
  }
}

/* ---------- phone ---------- */
.topbar.phone {
  gap: 12px;
  padding-left: 16px;
}
.topbar.phone .wordmark {
  font-size: 15px;
}
.ph-boutique {
  min-width: 0;
}
.menu-btn {
  position: relative;
  width: 56px;
  height: var(--topbar-h);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-left: var(--line-w) solid var(--line);
}
.menu-btn span:not(.menu-badge) {
  width: 20px;
  height: 1.5px;
  background: var(--muted);
  transition: transform var(--t-fast), opacity var(--t-fast);
}
.menu-btn.open span:nth-child(1) {
  transform: translateY(6.5px) rotate(45deg);
}
.menu-btn.open span:nth-child(2) {
  opacity: 0;
}
.menu-btn.open span:nth-child(3) {
  transform: translateY(-6.5px) rotate(-45deg);
}
.menu-badge {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 7px;
  height: 7px;
  background: var(--crit);
}
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(11, 11, 10, 0.7);
}
.drawer {
  position: absolute;
  top: calc(var(--topbar-h) + var(--safe-top));
  right: 0;
  width: min(300px, 86vw);
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: var(--line-w) solid var(--line-strong);
  padding-bottom: var(--safe-bottom);
}
.drawer-head {
  padding: 16px;
  border-bottom: var(--line-w) solid var(--line);
}
.drawer-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 0 16px;
  text-align: left;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  border-bottom: var(--line-w) solid var(--line);
  border-left: 3px solid transparent;
}
.drawer-btn.active {
  color: var(--accent);
  border-left-color: var(--accent);
}
.drawer-btn.lock {
  margin-top: auto;
  border-top: var(--line-w) solid var(--line);
  color: var(--crit);
}
</style>
