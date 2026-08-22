/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_MOCK?: string
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string
  /** v0.3 — expose window.__maisonRecognitionTest for e2e */
  readonly VITE_E2E?: string
}
