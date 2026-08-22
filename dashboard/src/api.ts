import type { LiveSummary, PeriodComparison, ReportLink } from './types'

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

// ---------------------------------------------------------------------------
// v0.4 F — reports catalogue + period comparison (maison_pos.api.reports)
// ---------------------------------------------------------------------------
export async function fetchReports(): Promise<ReportLink[]> {
  if (MOCK) {
    const { mockReports } = await import('./mock')
    return mockReports()
  }
  return (await call<{ reports: ReportLink[] }>('maison_pos.api.reports.list_reports')).reports
}

export async function fetchPeriodComparison(boutique?: string): Promise<PeriodComparison> {
  if (MOCK) {
    const { mockPeriodComparison } = await import('./mock')
    return mockPeriodComparison()
  }
  return call<PeriodComparison>('maison_pos.api.reports.period_comparison', boutique ? { boutique } : {})
}

/** Desk URL of a report (opens the Frappe query-report with the gold filters pre-set). */
export function reportUrl(name: string, filters: Record<string, string> = {}): string {
  const qs = new URLSearchParams(filters).toString()
  return `/app/query-report/${encodeURIComponent(name)}${qs ? '?' + qs : ''}`
}
export function reportCsvUrl(name: string, filters: Record<string, string> = {}): string {
  const qs = new URLSearchParams({ report: name, filters: JSON.stringify(filters) }).toString()
  return `/api/method/maison_pos.api.reports.export?${qs}`
}
