import { createRouter, createWebHistory } from 'vue-router'
import { useSessionStore } from '@/stores/session'

// Under Frappe the shell is served at /pos; in dev at /.
// --- v0.5 K: the same bundle also serves the client-facing Salon at /salon (www/salon.py) — base '/' there ---
export const IS_SALON = typeof location !== 'undefined' && /^\/salon(\/|$)/.test(location.pathname)
// --- v0.6 P: warehouse admin desk (/warehouse) and the 55" wall (/warehouse-wall) — same bundle, base '/' ---
export const IS_WAREHOUSE = typeof location !== 'undefined' && /^\/warehouse(-wall)?(\/|$)/.test(location.pathname)
const history = createWebHistory(import.meta.env.DEV || IS_SALON || IS_WAREHOUSE ? '/' : '/pos')
// --- end v0.5 K / v0.6 P ---

export const router = createRouter({
  history,
  routes: [
    { path: '/', redirect: '/sell' },
    { path: '/unlock', name: 'unlock', component: () => import('@/views/UnlockView.vue'), meta: { public: true } },
    { path: '/sell', name: 'sell', component: () => import('@/views/SellView.vue') },
    { path: '/client', name: 'client', component: () => import('@/views/ClientView.vue') },
    { path: '/pay', name: 'pay', component: () => import('@/views/PayView.vue') },
    { path: '/receipt/:uuid', name: 'receipt', component: () => import('@/views/ReceiptView.vue'), props: true },
    { path: '/queue', name: 'queue', component: () => import('@/views/QueueView.vue') },
    { path: '/shift', name: 'shift', component: () => import('@/views/ShiftView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    // v0.4 D/E — returns & exchanges, cycle count
    { path: '/returns', name: 'returns', component: () => import('@/views/ReturnsView.vue') },
    // v0.4 G — web orders (click & collect queue)
    { path: '/web-orders', name: 'web-orders', component: () => import('@/views/WebOrdersView.vue') },
    { path: '/exchange/:invoice', name: 'exchange', component: () => import('@/views/ExchangeView.vue'), props: true },
    { path: '/count', name: 'count', component: () => import('@/views/CycleCountView.vue') },
    // v0.5 K — client-facing Salon (guest device; own layout, no POS chrome)
    { path: '/salon/:screen?', name: 'salon', component: () => import('@/salon/views/SalonApp.vue'), meta: { public: true, salon: true } },
    // --- v0.6 O/P — store receiving (POS), warehouse admin desk + wall (Frappe-session users, role-gated in-app) ---
    { path: '/receive', name: 'receive', component: () => import('@/views/ReceiveView.vue') },
    { path: '/warehouse/:tab?', name: 'warehouse', component: () => import('@/warehouse/views/WarehouseDesk.vue'), meta: { public: true, warehouse: true } },
    { path: '/warehouse-wall', name: 'warehouse-wall', component: () => import('@/warehouse/views/WarehouseWall.vue'), meta: { public: true, warehouse: true } },
    // --- end v0.6 O/P ---
    { path: '/:pathMatch(.*)*', redirect: '/sell' }
  ]
})

router.beforeEach((to) => {
  const session = useSessionStore()
  if (!to.meta.public && !session.unlocked) return { name: 'unlock', query: { next: to.fullPath } }
  return true
})
