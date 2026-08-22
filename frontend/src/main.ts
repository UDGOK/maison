import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/base.css'
import { useSessionStore } from './stores/session'
import { useCatalogStore } from './stores/catalog'
import { usePrinterStore } from './stores/printer'
import { useSyncStore } from './stores/sync'

async function boot() {
  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)

  // Restore offline state before the router guards run.
  const session = useSessionStore()
  await session.restore()
  await useCatalogStore().restore()
  await usePrinterStore().restore()

  app.use(router)
  await router.isReady()
  app.mount('#app')
  void useSyncStore().start()

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    const { registerSW } = await import('virtual:pwa-register')
    registerSW({ immediate: true })
  }
}

void boot()
