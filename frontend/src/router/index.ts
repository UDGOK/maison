import { createRouter, createWebHistory } from 'vue-router'
import { useSessionStore } from '@/stores/session'

// Under Frappe the shell is served at /pos; in dev at /.
// --- v0.5 K: the same bundle also serves the client-facing Salon at /salon (www/salon.py) — base '/' there ---
export const IS_SALON = typeof location !== 'undefined' && /^\/salon(\/|$)/.test(location.pathname)
const history = createWebHistory(import.meta.env.DEV || IS_SALON ? '/' : '/pos')
// --- end v0.5 K ---

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
    { path: '/:pathMatch(.*)*', redirect: '/sell' }
  ]
})

router.beforeEach((to) => {
  const session = useSessionStore()
  if (!to.meta.public && !session.unlocked) return { name: 'unlock', query: { next: to.fullPath } }
  return true
})
