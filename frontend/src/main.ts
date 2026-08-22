import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/base.css'
import { useSessionStore } from './stores/session'
import { useCatalogStore } from './stores/catalog'
import { usePrinterStore } from './stores/printer'
import { useSyncStore } from './stores/sync'
import { useLayoutStore } from './stores/layout'
import { useScanStore } from './stores/scan'
import { useRecognitionStore } from './stores/recognition'

async function boot() {
  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)

  // Restore offline state before the router guards run.
  const session = useSessionStore()
  await session.restore()
  await useCatalogStore().restore()
  await usePrinterStore().restore()
  await useRecognitionStore().restore()

  app.use(router)
  await router.isReady()
  app.mount('#app')
  useLayoutStore().start()
  useScanStore().startWedge()
  void useSyncStore().start()

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
    console.warn('[maison] service worker registration failed', err)
  }
}

void boot()
