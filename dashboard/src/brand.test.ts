/**
 * v0.6 D1 — the Command dashboard must render the tenant's brand tokens, never a hard-coded
 * "Maison" / "Boutique(s)".
 *
 * The Jinja shell already injects `window.maison_brand` (maison_pos/www/maison-dashboard.html),
 * but the SPA ignored it: the top bar read `Maison · Today · All Boutiques` on a CloudChaserz
 * tenant whose `store_noun` is "Store".
 *
 * Two complementary checks, both with the tokens set to a *third* vocabulary ("Cloudchaserz",
 * store noun "Depot") so neither the old jewellery words nor the new smoke-shop ones can pass by
 * accident:
 *
 *  1. every component that renders standalone is server-rendered and its output is searched;
 *  2. every `<template>` in `src/**` is scanned for literal brand text outside tags and
 *     interpolations — that covers the views whose setup needs a real browser.
 */
import { beforeAll, describe, expect, it } from 'vitest'

const BRANDED = /maison|boutique/i

const TOKENS = {
  brand_name: 'Cloudchaserz',
  product_name: 'Cloudchaserz POS',
  wordmark_text: 'CLOUDCHASERZ',
  sub_mark: 'POS',
  vertical: 'Smoke Shop',
  store_noun: 'Depot',
  rewards_program_name: 'Cloudchaserz Rewards',
}

// A minimal browser surface: the views read `window.location` / `getComputedStyle` in `setup()`.
// Everything that needs a real DOM (`onMounted`, fetches) never runs under `renderToString`.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.window = {
    location: { search: '', href: 'http://dashboard.test/' },
    history: { replaceState: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    maison_brand: TOKENS,
  }
  // `@vue/runtime-dom` touches `document.createElement` at import time even though nothing is
  // mounted; `renderToString` itself never uses the DOM.
  const el = () => ({ innerHTML: '', content: {}, setAttribute: () => {}, appendChild: () => {}, style: {} })
  g.document = { documentElement: {}, createElement: el, createElementNS: el, createTextNode: el, querySelector: () => null, addEventListener: () => {} }
  g.getComputedStyle = () => ({ fontSize: '15px' })
})

// ---------------------------------------------------------------------------
// 1. server-rendered components
// ---------------------------------------------------------------------------
const EMPTY_TOTALS = {
  net: 0,
  invoices: 0,
  cash: 0,
  card: 0,
  avg_ticket: 0,
  returns: 0,
  returns_value: 0,
  low_stock: 0,
  feedback_open: 0,
  online: 0,
  pending_approvals: 0,
  vs_last_week_pct: null,
}

/**
 * Strip the hooks that are code, not copy: `data-*` test hooks, CSS classes and inline styles.
 * `aria-label`, `title` and `placeholder` deliberately stay — they are read out to a human.
 */
function userFacing(html: string): string {
  return html
    .replace(/\sdata-[\w-]+="[^"]*"/g, ' ')
    .replace(/\sclass="[^"]*"/g, ' ')
    .replace(/\sstyle="[^"]*"/g, ' ')
    .replace(/\sid="[^"]*"/g, ' ')
}

const CASES: { name: string; load: () => Promise<{ default: unknown }>; props: Record<string, unknown> }[] = [
  { name: 'TopBar', load: () => import('./components/TopBar.vue'), props: { live: true } },
  {
    name: 'KpiStrip',
    load: () => import('./components/KpiStrip.vue'),
    props: { totals: EMPTY_TOTALS, cardPct: 0, cashPct: 0, pending: 0, lowStock: 0, feedbackOpen: 0, online: 0, boutiques: 11 },
  },
  { name: 'TrendingTable', load: () => import('./components/products/TrendingTable.vue'), props: { rows: [], period: '7d' } },
  {
    name: 'TopByStore',
    load: () => import('./components/products/TopByStore.vue'),
    props: { top: {}, boutiques: ['HOU-MTR'], by: 'net', boutiqueNet: { 'HOU-MTR': 0 } },
  },
  {
    name: 'GroupHeatmap',
    load: () => import('./components/insights/GroupHeatmap.vue'),
    props: { cells: [], boutiques: ['HOU-MTR'], groups: ['Glass'], days: 7 },
  },
  { name: 'RebalanceList', load: () => import('./components/insights/RebalanceList.vue'), props: { moves: [], days: 7 } },
]

describe('dashboard brand tokens', () => {
  it('normalises and pluralises the store noun', async () => {
    const { normalizeBrand, pluralize, setBrand, useBrand } = await import('./stores/brand')
    expect(normalizeBrand(TOKENS).store_noun).toBe('Depot')
    expect(normalizeBrand(null).store_noun).toBe('Boutique') // the jewellery default survives
    expect(pluralize('Store')).toBe('Stores')
    expect(pluralize('Boutique')).toBe('Boutiques')
    expect(pluralize('Pharmacy')).toBe('Pharmacies')
    setBrand(TOKENS)
    const brand = useBrand()
    expect(brand.scope).toBe('Today · All Depots')
    expect(brand.storesLower).toBe('depots')
  })

  for (const c of CASES) {
    it(`${c.name} renders no hard-coded brand string`, async () => {
      const { createSSRApp } = await import('vue')
      const { createPinia } = await import('pinia')
      const { renderToString } = await import('vue/server-renderer')
      const { setBrand } = await import('./stores/brand')
      setBrand(TOKENS)
      const app = createSSRApp((await c.load()).default as never, c.props)
      app.use(createPinia())
      const html = userFacing(await renderToString(app))
      const offenders = (html.match(new RegExp(BRANDED.source, 'gi')) || []).filter((m) => m)
      expect(offenders, `${c.name} rendered ${offenders.join(', ')}`).toEqual([])
    })
  }

  it('the top bar renders the tenant wordmark and scope line', async () => {
    const { createSSRApp } = await import('vue')
    const { createPinia } = await import('pinia')
    const { renderToString } = await import('vue/server-renderer')
    const { setBrand } = await import('./stores/brand')
    setBrand(TOKENS)
    const app = createSSRApp((await import('./components/TopBar.vue')).default as never, { live: true })
    app.use(createPinia())
    const html = await renderToString(app)
    expect(html).toContain('CLOUDCHASERZ')
    expect(html).toContain('Today · All Depots')
  })
})

// ---------------------------------------------------------------------------
// 2. static template scan (covers the views that need a real browser)
// ---------------------------------------------------------------------------
/** Every SFC in the dashboard, as raw source (Vite resolves this at transform time). */
const SOURCES = import.meta.glob('./**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Visible text of a SFC template: tags (and therefore attributes) and `{{ … }}` removed. */
function visibleText(source: string): string {
  const start = source.indexOf('<template>')
  if (start < 0) return ''
  const end = source.lastIndexOf('</template>')
  return source
    .slice(start + '<template>'.length, end < 0 ? undefined : end)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
}

describe('dashboard templates carry no literal brand words', () => {
  it('finds every SFC', () => expect(Object.keys(SOURCES).length).toBeGreaterThan(20))
  for (const [file, source] of Object.entries(SOURCES)) {
    it(file, () => {
      const hits = visibleText(source).match(new RegExp(`[^\\s]*${BRANDED.source}[^\\s]*`, 'gi')) || []
      expect(hits, `${file} renders ${hits.join(', ')}`).toEqual([])
    })
  }
})
