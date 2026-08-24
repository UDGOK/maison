/**
 * v0.6 P — wall realtime: `awanz_wall` events are published to the `doctype:AWANZ Shipment` room
 * (`doctype_subscribe`, read permission on the doctype). Polling every `POLL_MS` stays on as the
 * fallback; the socket only makes it instant. In mock mode the in-memory API emits a DOM event.
 */
import type { WallEvent } from '@/api/warehouse'
import { socketTarget } from '@/salon/transport'

export const POLL_MS = 10_000
const DOCTYPE = 'AWANZ Shipment'

export interface WallRealtimeHandlers {
  onEvent: (e: WallEvent) => void
  onConnection?: (connected: boolean) => void
}

export function connectWallRealtime(h: WallRealtimeHandlers): () => void {
  if (import.meta.env.VITE_MOCK === '1') {
    const fn = (e: Event) => h.onEvent((e as CustomEvent<WallEvent>).detail)
    window.addEventListener('awanz-mock-wall', fn)
    h.onConnection?.(true)
    return () => window.removeEventListener('awanz-mock-wall', fn)
  }
  let closed = false
  let socket: { disconnect: () => void } | null = null
  import('socket.io-client')
    .then(({ io }) => {
      if (closed) return
      const s = io(socketTarget(), { withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000, timeout: 8000 })
      socket = s
      s.on('connect', () => {
        s.emit('doctype_subscribe', DOCTYPE)
        h.onConnection?.(true)
      })
      s.on('disconnect', () => h.onConnection?.(false))
      s.on('connect_error', () => h.onConnection?.(false))
      s.on('awanz_wall', (d: WallEvent) => {
        if (d && typeof d === 'object' && d.event) h.onEvent(d)
      })
    })
    .catch(() => h.onConnection?.(false))
  return () => {
    closed = true
    socket?.disconnect()
  }
}
