/**
 * Thin realtime wrapper. Prefers the page-provided `frappe.realtime` (when the
 * app is mounted inside a Frappe www page with the web bundle), otherwise
 * connects directly to Frappe's socket.io server.
 *
 * Frappe's socket.io server only delivers to rooms it manages (site, user,
 * doctype, doc, task); the backend publishes `awanz_sale` / `awanz_heartbeat`
 * to the `doctype:Sales Invoice` room, so the client must `doctype_subscribe`
 * to it (requires read permission on Sales Invoice).
 */
import type { HeartbeatEvent, SaleEvent } from './types'

export interface RealtimeHandlers {
  onSale: (s: SaleEvent) => void
  onHeartbeat: (h: HeartbeatEvent) => void
  onConnection?: (connected: boolean) => void
}

export type Unsubscribe = () => void

const DOCTYPE = 'Sales Invoice'

/** socket.io URL + namespace the way frappe/socketio_client.js builds it. */
function socketTarget(): string {
  let host = window.location.origin
  if (window.dev_server) {
    // `bench serve` does not proxy /socket.io; talk to the socketio process directly.
    const parts = host.split(':')
    host = (parts.length > 2 ? parts[0] + ':' + parts[1] : host) + ':' + (window.socketio_port || 9000)
  }
  // v1.2 — the namespace is the site name; the hostname only matches it on *.frappe.cloud
  const site = window.awanz_site_name || window.frappe?.boot?.sitename || window.location.hostname
  return `${host}/${site}`
}

export function connectRealtime(h: RealtimeHandlers): Unsubscribe {
  const fr = window.frappe?.realtime
  if (fr) {
    // www pages ship the client but never call init() (only the desk does).
    if (!fr.socket && fr.init) fr.init(window.socketio_port || 9000)
    const sale = (d: unknown) => h.onSale(d as SaleEvent)
    const hb = (d: unknown) => h.onHeartbeat(d as HeartbeatEvent)
    const subscribe = () => {
      fr.doctype_subscribe?.(DOCTYPE)
      h.onConnection?.(true)
    }
    fr.on('awanz_sale', sale)
    fr.on('awanz_heartbeat', hb)
    if (fr.socket) {
      fr.socket.on('connect', subscribe)
      fr.socket.on('disconnect', () => h.onConnection?.(false))
      if (fr.socket.connected) subscribe()
    } else {
      h.onConnection?.(false)
    }
    return () => {
      fr.off?.('awanz_sale', sale)
      fr.off?.('awanz_heartbeat', hb)
      fr.socket?.off?.('connect', subscribe)
    }
  }

  let closed = false
  let socket: { disconnect: () => void } | null = null
  import('socket.io-client').then(({ io }) => {
    if (closed) return
    const s = io(socketTarget(), {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 10_000,
    })
    socket = s
    s.on('connect', () => {
      h.onConnection?.(true)
      s.emit('doctype_subscribe', DOCTYPE)
    })
    s.on('disconnect', () => h.onConnection?.(false))
    s.on('awanz_sale', (d: SaleEvent) => h.onSale(d))
    s.on('awanz_heartbeat', (d: HeartbeatEvent) => h.onHeartbeat(d))
  })
  return () => {
    closed = true
    socket?.disconnect()
  }
}
