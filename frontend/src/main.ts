import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/base.css'
import { useSessionStore } from './stores/session'
import { useCatalogStore } from './stores/catalog'
import { usePrinterStore } from './stores/printer'
import { useInventoryStore } from './stores/inventory'
import { useSyncStore } from './stores/sync'
import { useLayoutStore } from './stores/layout'
import { useScanStore } from './stores/scan'
import { useRecognitionStore } from './stores/recognition'
import { usePromosStore } from './stores/promos'
import { useLoyaltyStore } from './stores/loyalty'
import { useSalonPosStore } from './stores/salon' // v0.5 K

async function boot() {
  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)

  // --- v0.5 K: the Salon is a guest device — no session, catalog, scanner or sync; just the router ---
  if (/^\/salon(\/|$)/.test(location.pathname)) {
    app.use(router)
    await router.isReady()
    app.mount('#app')
    return
  }
  // --- end v0.5 K ---
  // --- v0.6 P: /warehouse and /warehouse-wall run on the Frappe session (no PIN, no catalog / sync) ---
  if (/^\/warehouse(-wall)?(\/|$)/.test(location.pathname)) {
    app.use(router)
    await router.isReady()
    app.mount('#app')
    return
  }
  // --- end v0.6 P ---

  // Restore offline state before the router guards run.
  const session = useSessionStore()
  await session.restore()
  await useCatalogStore().restore()
  await usePrinterStore().restore()
  await useInventoryStore().restore() // v0.4 D
  await useRecognitionStore().restore()
  await usePromosStore().restore() // v0.4 I — cached promotions
  await useLoyaltyStore().restore()

  app.use(router)
  await router.isReady()
  app.mount('#app')
  useLayoutStore().start()
  const scan = useScanStore()
  await scan.loadScannerConfig() // v0.4 J — prefix / suffix / terminator
  scan.startWedge()
  void useSyncStore().start()
  void useSalonPosStore().restore() // v0.5 K — client display pairing + mirror

  if (import.meta.env.PROD && 'serviceWorker' in navigator) void registerServiceWorker()
}

/**
 * Register the service worker with scope `/pos/`.
 *
 * The built `sw.js` lives under `/assets/maison_pos/pos/`; browsers only let a worker
 * control `/pos/` if its script response carries `Service-Worker-Allowed`, which managed
 * hosts (Frappe Cloud) do not add for `/assets`. `maison_pos.api.pwa.service_worker`
 * returns the same file with that header, so we register it from there.
 * The worker uses `skipWaiting` + `clientsClaim` (vite-plugin-pwa `autoUpdate`), so an
 * `update()` on every focus is all that is needed to roll out a new build.
 */
export const SW_URL = '/api/method/maison_pos.api.pwa.service_worker'
export const SW_SCOPE = '/pos/'

async function registerServiceWorker() {
  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE, updateViaCache: 'none' })
    const update = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void reg.update().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('online', update)
    setInterval(update, 60 * 60 * 1000)
  } catch (err) {
    console.warn('[awanz] service worker registration failed', err)
  }
}

void boot()
