/**
 * v0.5 K — realtime transport shared by the Salon and the POS "Client display" card.
 *
 * Frappe's socket.io server only delivers to rooms it manages; `maison_pos.api.salon` publishes
 * `salon_state` / `salon_message` to the session *document* room, so each side joins it with
 * `doc_subscribe("AWANZ Salon Session", <token>)` (Guest may read exactly that one document).
 * When the socket is unavailable (dev server, proxies, LAN quirks) the caller keeps polling every
 * `POLL_MS`; the socket only makes it instant.
 */
import type { SalonMessage, SalonState } from '@/api/salon'

export const POLL_MS = 2000
const DOCTYPE = 'AWANZ Salon Session'

export interface SalonRealtimeHandlers {
  onState?: (s: SalonState) => void
  onMessage?: (m: SalonMessage) => void
  onConnection?: (connected: boolean) => void
  /** POS side only: `salon_paired` lands in the associate's user room */
  onPaired?: (info: { token: string; pos_device_id: string; boutique: string }) => void
}

export type Unsubscribe = () => void

declare global {
  interface Window {
    dev_server?: number | boolean
    socketio_port?: number
    awanz_salon?: boolean
    /** v1.2 — the real site name, injected by the www page. See `socketTarget`. */
    awanz_site_name?: string
    frappe?: { boot?: { sitename?: string } }
  }
}

/**
 * socket.io URL + namespace the way frappe/socketio_client.js builds it.
 *
 * The namespace is the **site name** — the directory under `sites/` — and not the host the
 * browser happens to be on. Those are the same string on `<site>.frappe.cloud`, which is why
 * falling back to `location.hostname` worked for months and then silently stopped the day the
 * client pointed `www.cc-ok.com` at the site: socket.io was asked for a namespace that does not
 * exist, every connection failed, and the wall dropped to polling with no error a user could see.
 *
 * `window.awanz_site_name` is injected by the www page (`www/pos.py`, `salon.py`, `warehouse.py`)
 * and is the only source that is right on every domain. The rest are fallbacks for a page that
 * predates the fix.
 */
export function socketTarget(loc: { origin: string; hostname: string; port: string; protocol: string } = window.location): string {
  let host = loc.origin
  const port = window.socketio_port || 9000
  // `bench serve` (port 8000) does not proxy /socket.io: talk to the socketio process directly
  if (window.dev_server || loc.port === '8000') host = `${loc.protocol}//${loc.hostname}:${port}`
  const site = window.awanz_site_name || window.frappe?.boot?.sitename || loc.hostname
  return `${host}/${site}`
}

export function connectSalonRealtime(token: string | null, h: SalonRealtimeHandlers): Unsubscribe {
  if (import.meta.env.VITE_MOCK === '1') return connectMock(token, h)
  let closed = false
  let socket: { disconnect: () => void; emit: (ev: string, ...a: unknown[]) => void } | null = null
  import('socket.io-client')
    .then(({ io }) => {
      if (closed) return
      const s = io(socketTarget(), { withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000, timeout: 8000 })
      socket = s
      s.on('connect', () => {
        if (token) s.emit('doc_subscribe', DOCTYPE, token)
        h.onConnection?.(true)
      })
      s.on('disconnect', () => h.onConnection?.(false))
      s.on('connect_error', () => h.onConnection?.(false))
      s.on('salon_state', (d: { token: string; state: SalonState }) => {
        if (!token || d?.token === token) h.onState?.(d.state)
      })
      s.on('salon_message', (d: { token: string; message: SalonMessage }) => {
        if (!token || d?.token === token) h.onMessage?.(d.message)
      })
      s.on('salon_paired', (d: { token: string; pos_device_id: string; boutique: string }) => h.onPaired?.(d))
    })
    .catch(() => h.onConnection?.(false))
  return () => {
    closed = true
    socket?.disconnect()
  }
}

/** Mock: `storage` events (other windows / the virtual salon iframe) + a same-window CustomEvent. */
function connectMock(token: string | null, h: SalonRealtimeHandlers): Unsubscribe {
  let lastSeq = -1
  let lastInbox = -1
  const read = () => {
    try {
      const raw = localStorage.getItem('awanz.mock.salon')
      if (!raw) return
      const srv = JSON.parse(raw)
      const sess = token ? srv.sessions?.[token] : null
      if (!sess) return
      if (sess.status !== 'Paired' && lastSeq >= 0) {
        h.onState?.({ screen: 'unpaired' as never, seq: sess.seq })
        lastSeq = sess.seq
        return
      }
      if (sess.seq !== lastSeq) {
        lastSeq = sess.seq
        if (sess.state) h.onState?.(sess.state)
      }
      if (sess.inbox_seq !== lastInbox) {
        const from = lastInbox
        lastInbox = sess.inbox_seq
        for (const m of sess.inbox || []) if (m.seq > from) h.onMessage?.(m)
      }
    } catch {
      /* ignore */
    }
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === 'awanz.mock.salon') read()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('awanz:salon-mock', read)
  // prime the cursors without replaying history
  try {
    const sess = token ? JSON.parse(localStorage.getItem('awanz.mock.salon') || '{}').sessions?.[token] : null
    if (sess) {
      lastSeq = sess.seq
      lastInbox = sess.inbox_seq
    }
  } catch {
    /* ignore */
  }
  h.onConnection?.(true)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('awanz:salon-mock', read)
  }
}
