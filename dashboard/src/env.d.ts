/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
interface FrappeSocket {
  connected?: boolean
  on: (event: string, cb: (...args: unknown[]) => void) => void
  off?: (event: string, cb?: (...args: unknown[]) => void) => void
}
interface Window {
  dev_server?: number | boolean
  socketio_port?: number
  frappe?: {
    boot?: { sitename?: string }
    realtime?: {
      socket?: FrappeSocket
      init?: (port?: number, lazy?: boolean) => void
      doctype_subscribe?: (doctype: string) => void
      on: (event: string, cb: (data: unknown) => void) => void
      off?: (event: string, cb?: (data: unknown) => void) => void
    }
    csrf_token?: string
  }
}
