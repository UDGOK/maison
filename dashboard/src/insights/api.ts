// v0.4 H — insights client (kept out of ../api.ts so concurrent dashboard work does not collide)
import type { ClientSignalsResult, InsightReport, InsightsSummary, ProductPerformance, RebalanceMove } from './types'

const MOCK = import.meta.env.VITE_MOCK === '1'

async function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/method/${method}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(window.frappe?.csrf_token ? { 'X-Frappe-CSRF-Token': window.frappe.csrf_token } : {}),
    },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const j = (await res.json()) as { exception?: string; _server_messages?: string }
      if (j._server_messages) detail = (JSON.parse(j._server_messages) as string[]).map((m) => (JSON.parse(m) as { message: string }).message).join(' ')
      else if (j.exception) detail = String(j.exception).split('\n').pop() || ''
    } catch {
      /* ignore */
    }
    throw new Error(detail.replace(/<[^>]+>/g, '') || `${method}: HTTP ${res.status}`)
  }
  return ((await res.json()) as { message: T }).message
}

export async function fetchProductPerformance(days = 90): Promise<ProductPerformance> {
  if (MOCK) return (await import('./mock')).mockProductPerformance(days)
  return call<ProductPerformance>('maison_pos.api.insights.product_performance', { period: days })
}

export async function fetchClientSignals(limit = 40): Promise<ClientSignalsResult> {
  if (MOCK) return (await import('./mock')).mockClientSignals()
  return call<ClientSignalsResult>('maison_pos.api.insights.client_signals', { limit })
}

export async function fetchRebalanceSuggestions(): Promise<RebalanceMove[]> {
  if (MOCK) return (await import('./mock')).mockRebalance()
  return (await call<{ suggestions: RebalanceMove[] }>('maison_pos.api.insights.rebalance_suggestions', { status: 'Open' })).suggestions
}

export async function fetchNarrative(): Promise<InsightReport | null> {
  if (MOCK) return (await import('./mock')).mockNarrative()
  const r = await call<InsightReport | { report: null }>('maison_pos.api.insights.narrative')
  return 'name' in r ? r : null
}

export async function fetchInsightsSummary(): Promise<InsightsSummary> {
  if (MOCK) return (await import('./mock')).mockSummary()
  return call<InsightsSummary>('maison_pos.api.insights.summary')
}

export async function createTransfer(suggestion: string): Promise<{ ok: boolean; stock_entry: string; qty: number }> {
  if (MOCK) return (await import('./mock')).mockTransfer(suggestion)
  return call('maison_pos.api.insights.create_transfer', { suggestion })
}

export async function dismissSuggestion(suggestion: string): Promise<{ ok: boolean }> {
  if (MOCK) return { ok: true }
  return call('maison_pos.api.insights.dismiss_suggestion', { suggestion })
}

export async function markSignal(signal: string, status: 'Contacted' | 'Dismissed'): Promise<{ ok: boolean }> {
  if (MOCK) return { ok: true }
  return call('maison_pos.api.insights.mark_signal', { signal, status })
}
