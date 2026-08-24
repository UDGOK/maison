/**
 * v0.8 — the dashboard half of the QA defects, rendered.
 *
 * D-1  the hourly chart drew 09:00–21:00 and named the peak of that slice: on the QA day it hid
 *      86 % of the chain's takings and labelled the wrong hour.
 * D-4  "Avg ticket" divided net-of-returns by a sales-only count; it is the average *sale* now,
 *      and the tile says so.
 * D-8  the Reports tab printed "FRAPPE DESK" — the last framework word in the product.
 * D-12 gift cards / store credit / the web tender were reported to head office as "card".
 */
import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.window = { location: { search: '', href: 'http://dashboard.test/' }, history: { replaceState: () => {} }, setInterval: () => 0, clearInterval: () => {} }
  const el = () => ({ innerHTML: '', content: {}, setAttribute: () => {}, appendChild: () => {}, style: {} })
  g.document = { documentElement: {}, createElement: el, createElementNS: el, createTextNode: el, querySelector: () => null, addEventListener: () => {} }
  g.getComputedStyle = () => ({ fontSize: '15px' })
})

async function render(load: () => Promise<{ default: unknown }>, props: Record<string, unknown>): Promise<string> {
  const { createSSRApp } = await import('vue')
  const { createPinia } = await import('pinia')
  const { renderToString } = await import('vue/server-renderer')
  const app = createSSRApp((await load()).default as never, props)
  app.use(createPinia())
  return renderToString(app)
}

const LIVE_DAY = [
  { hour: 4, net: 512.73, invoices: 33 },
  { hour: 12, net: 47.88, invoices: 4 },
  { hour: 14, net: 28.99, invoices: 6 },
  { hour: 15, net: 7.78, invoices: 3 },
]

const TOTALS = {
  net: 597.38,
  gross: 1382.53,
  invoices: 31,
  cash: 892.78,
  card: -320.4,
  other_tender: -3.88,
  avg_ticket: 1382.53 / 31,
  returns: 22,
  returns_value: 785.15,
  vs_last_week_pct: -46.8,
}

describe('D-1 hourly chart', () => {
  it('names the real peak hour, outside the old 09:00–21:00 window', async () => {
    const html = await render(() => import('./components/HourlyChart.vue'), { hours: LIVE_DAY, currentHour: 16 })
    expect(html).toContain('04:00') // the peak label and the axis both reach it
    expect(html).not.toContain('12:00 ·') // the peak of the truncated window
  })

  it('shows no peak at all on a day with no sales', async () => {
    const html = await render(() => import('./components/HourlyChart.vue'), {
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, net: 0, invoices: 0 })),
      currentHour: 9,
    })
    expect(html).toMatch(/hourly-peak[^>]*>—</)
  })
})

describe('D-4 / D-12 KPI strip', () => {
  it('labels the average sale and reports non-card tender separately', async () => {
    const html = await render(() => import('./components/KpiStrip.vue'), {
      totals: TOTALS,
      cardPct: 26,
      cashPct: 74,
      pending: 0,
      lowStock: 0,
      feedbackOpen: 0,
      online: 0,
      boutiques: 11,
    })
    expect(html).toContain('Avg sale')
    expect(html).not.toContain('Avg ticket')
    expect(html).toContain('other') // the "other tender" sub-line
  })
})

describe('D-8 reports tab', () => {
  it('no longer prints the framework name', async () => {
    const html = await render(() => import('./components/ReportsSection.vue'), {
      reports: [{ name: 'Maison Daily Sales', group: 'Sales', description: 'x', route: '/app/query-report/Maison Daily Sales' }],
    })
    const rendered = html.replace(/<!--[\s\S]*?-->/g, '').toLowerCase()
    expect(rendered).not.toContain('frappe')
    expect(rendered).not.toContain('erpnext')
  })
})
