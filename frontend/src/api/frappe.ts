/**
 * Typed Frappe client. Every call hits `/api/method/maison_pos.api.<module>.<fn>`
 * with the session cookie (credentials: include) and the CSRF token Frappe injects
 * into the page as `window.csrf_token` (see maison_pos/www/pos.py).
 */
import { stripHtml } from '@/utils/text'
import { ApiError, type MaisonApi } from './types'

declare global {
  interface Window {
    csrf_token?: string
    __maisonOffline?: boolean
  }
}

const BASE = '/api/method/maison_pos.api.'
const VERIFY_PIN = 'maison_pos.maison_pos.doctype.maison_associate.maison_associate.verify_pin'

function csrf(): string {
  return (typeof window !== 'undefined' && window.csrf_token) || ''
}

async function call<T>(method: string, args: Record<string, unknown> = {}, opts: { get?: boolean } = {}): Promise<T> {
  const url = method.includes('.doctype.') ? '/api/method/' + method : BASE + method
  let res: Response
  try {
    if (opts.get) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(args)) if (v !== undefined) qs.set(k, typeof v === 'string' ? v : JSON.stringify(v))
      res = await fetch(`${url}?${qs.toString()}`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-Frappe-CSRF-Token': csrf() }
      })
    } else {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Frappe-CSRF-Token': csrf()
        },
        body: JSON.stringify(args)
      })
    }
  } catch (e) {
    throw new ApiError((e as Error).message || 'Network error', 'NETWORK', 0)
  }

  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body (e.g. HTML error page) */
  }

  if (!res.ok) {
    // Frappe wraps errors as {exc_type, exception, _server_messages}
    let message = `${res.status} ${res.statusText}`
    let code = `HTTP_${res.status}`
    if (body?._server_messages) {
      try {
        const msgs = JSON.parse(body._server_messages) as string[]
        message = stripHtml(msgs.map((m) => JSON.parse(m).message).join('\n'))
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = stripHtml(String(body.exception).split('\n').pop()) || message
    if (body?.exc_type) code = body.exc_type
    if (res.status === 401 || res.status === 403) code = 'AUTH'
    throw new ApiError(message, code, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappeApi: MaisonApi = {
  catalog: {
    bootstrap: (boutique) => call('catalog.bootstrap', { boutique }, { get: true }),
    delta: (boutique, since) => call('catalog.delta', { boutique, since }, { get: true })
  },
  customers: {
    search: (q, limit = 20) => call('customers.search', { q, limit }),
    upsert: (customer) => call('customers.upsert', { customer }),
    history: (customer, limit = 20) => call('customers.history', { customer, limit })
  },
  sales: {
    submit_batch: (invoices) => call('sales.submit_batch', { invoices }),
    list: (boutique, date) => call('sales.list', { boutique, date }),
    void: (invoice, reason) => call('sales.void', { invoice, reason })
  },
  stripe_terminal: {
    connection_token: (boutique) => call('stripe_terminal.connection_token', { boutique }),
    create_payment_intent: (amount, currency, offline_uuid, customer) =>
      call('stripe_terminal.create_payment_intent', { amount, currency, offline_uuid, customer }),
    capture: (payment_intent_id) => call('stripe_terminal.capture', { payment_intent_id })
  },
  dashboard: {
    live_summary: (date) => call('dashboard.live_summary', { date }),
    heartbeat: (boutique, device_id, queued) => call('dashboard.heartbeat', { boutique, device_id, queued })
  },
  verifyPin: (associate, pin) => call(VERIFY_PIN, { associate, pin }),
  // The backend has no catalog.boutiques; the boutiques the user may unlock come from session.me().
  boutiques: async () => {
    const me = await call<{ boutiques: { name: string; boutique_name: string; city: string }[] }>('session.me', {}, { get: true })
    return (me.boutiques || []).map((b) => ({ name: b.name, boutique_name: b.boutique_name, city: b.city }))
  }
}
