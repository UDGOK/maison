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

// ---------------------------------------------------------------------------
// v0.5 L — Command endpoints (maison_pos.api.dashboard v2)
// ---------------------------------------------------------------------------
import type { BoutiqueDetail, BoutiqueFeed, BoutiqueTableRow, ClientsOverview, ProductTrends, TickerRow, TopProducts, TrendPeriod } from './types'

export async function fetchTicker(limit = 10): Promise<TickerRow[]> {
  if (MOCK) return (await import('./mock')).mockTicker(limit)
  return call<TickerRow[]>('maison_pos.api.dashboard.ticker', { limit })
}

export async function fetchBoutiqueFeed(boutique: string, limit = 30): Promise<BoutiqueFeed> {
  if (MOCK) return (await import('./mock')).mockBoutiqueFeed(boutique, limit)
  return call<BoutiqueFeed>('maison_pos.api.dashboard.boutique_feed', { boutique, limit })
}

export async function fetchBoutiquesTable(): Promise<{ date: string; rows: BoutiqueTableRow[] }> {
  if (MOCK) return (await import('./mock')).mockBoutiquesTable()
  return call('maison_pos.api.dashboard.boutiques_table')
}

export async function fetchBoutiqueDetail(boutique: string, days = 28): Promise<BoutiqueDetail> {
  if (MOCK) return (await import('./mock')).mockBoutiqueDetail(boutique, days)
  return call<BoutiqueDetail>('maison_pos.api.dashboard.boutique_detail', { boutique, days })
}

export async function fetchProductTrends(args: { scope?: 'chain' | 'boutique'; boutique?: string | null; group?: string | null; period?: TrendPeriod; limit?: number; badge?: string | null }): Promise<ProductTrends> {
  if (MOCK) return (await import('./mock')).mockProductTrends(args)
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== '') clean[k] = v
  return call<ProductTrends>('maison_pos.api.dashboard.product_trends', clean)
}

export async function fetchTopProducts(args: { boutique?: string; by?: 'net' | 'units'; period?: TrendPeriod; n?: number }): Promise<TopProducts> {
  if (MOCK) return (await import('./mock')).mockTopProducts(args)
  return call<TopProducts>('maison_pos.api.dashboard.top_products', { boutique: args.boutique ?? 'all', by: args.by ?? 'net', period: args.period ?? '7d', n: args.n ?? 10 })
}

export async function fetchClientsOverview(args: { boutique?: string | null; tiers?: string[]; limit?: number } = {}): Promise<ClientsOverview> {
  if (MOCK) return (await import('./mock')).mockClientsOverview(args)
  const clean: Record<string, unknown> = { limit: args.limit ?? 40 }
  if (args.boutique) clean.boutique = args.boutique
  if (args.tiers?.length) clean.tiers = args.tiers.join(',')
  return call<ClientsOverview>('maison_pos.api.dashboard.clients_overview', clean)
}

export async function assignCall(signal: string): Promise<{ ok: boolean }> {
  if (MOCK) return { ok: true }
  // section M adds `insights.assign_call`; fall back to marking the signal as contacted
  try {
    return await call('maison_pos.api.insights.assign_call', { signal })
  } catch {
    return call('maison_pos.api.insights.mark_signal', { signal, status: 'Contacted' })
  }
}
