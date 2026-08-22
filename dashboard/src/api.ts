import type { LiveSummary } from './types'

export const MOCK = import.meta.env.VITE_MOCK === '1'

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
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  const json = (await res.json()) as { message: T }
  return json.message
}

export async function fetchLiveSummary(date?: string): Promise<LiveSummary> {
  if (MOCK) {
    const { mockLiveSummary } = await import('./mock')
    return mockLiveSummary()
  }
  return call<LiveSummary>('maison_pos.api.dashboard.live_summary', date ? { date } : {})
}
