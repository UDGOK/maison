import { launch, check, save, shot, BASE } from './lib-dash.mjs'
const VIEWS = ['live', 'boutiques', 'products', 'clients', 'insights', 'reports']
const SEL = { live: '[data-testid="live-cards"] .bcard', boutiques: '[data-testid="boutiques-table"] .row.data',
  products: '[data-testid="trending"] .row[data-item]', clients: '.clients .card .li', insights: '.insights .tiles .tile', reports: 'section.reports .group' }

for (const vp of [{ width: 1920, height: 1080, tag: '1920x1080' }, { width: 1440, height: 900, tag: '1440x900' }]) {
  const { browser, page, console_ } = await launch({ viewport: vp })
  const timings = []
  const brandHits = []
  for (const v of VIEWS) {
    const t0 = Date.now()
    await page.goto(`${BASE}/maison-dashboard?view=${v}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(SEL[v], { timeout: 60000 })
    const ms = Date.now() - t0
    await page.waitForTimeout(1800)
    timings.push(`${v}=${ms}ms`)
    const txt = (await page.locator('body').innerText())
    const hits = ['frappe', 'erpnext'].filter((w) => txt.toLowerCase().includes(w))
    if (hits.length) {
      for (const h of hits) {
        const line = txt.split('\n').find((l) => l.toLowerCase().includes(h))
        brandHits.push(`${v}: "${line?.trim().slice(0, 90)}"`)
      }
    }
    // horizontal overflow
    const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (of > 0) timings.push(`${v} OVERFLOW ${of}px`)
    await shot(page, `${vp.tag === '1440x900' ? '2' : '1'}${VIEWS.indexOf(v)}-${v}-${vp.tag}.png`)
  }
  check(`${vp.tag}: every tab loads`, true, timings.join(' · '))
  check(`${vp.tag}: no "Frappe"/"ERPNext" visible on any tab (case-insensitive)`, brandHits.length === 0, brandHits.join(' ; ') || 'none')
  const overflow = timings.filter((t) => /OVERFLOW/.test(t))
  check(`${vp.tag}: no horizontal overflow on any tab`, overflow.length === 0, overflow.join(', ') || 'none')
  check(`${vp.tag}: no console errors`, console_.filter((c) => !/favicon/.test(c)).length === 0, console_.slice(0, 6).join(' | '))
  await browser.close()
}

// ---- API response times ----
const { browser, page } = await launch()
await page.goto(`${BASE}/maison-dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="live-cards"] .bcard', { timeout: 45000 })
const timeIt = async (label, url, n = 5) => {
  const ts = []
  for (let i = 0; i < n; i++) { const t = Date.now(); const r = await page.request.get(url); await r.text(); ts.push(Date.now() - t) }
  return `${label}: ${ts.join('/')} ms (median ${ts.sort((a, b) => a - b)[Math.floor(n / 2)]})`
}
const a = await timeIt('live_summary (cached)', `${BASE}/api/method/maison_pos.api.dashboard.live_summary`)
const b = await timeIt('live_summary (nocache)', `${BASE}/api/method/maison_pos.api.dashboard.live_summary?nocache=1`)
const c = await timeIt('product_trends 7d', `${BASE}/api/method/maison_pos.api.dashboard.product_trends?period=7d&limit=60`)
const d = await timeIt('top_products all', `${BASE}/api/method/maison_pos.api.dashboard.top_products?boutique=all&by=net&period=7d&n=10`)
const e = await timeIt('boutiques_table', `${BASE}/api/method/maison_pos.api.dashboard.boutiques_table`)
const f = await timeIt('clients_overview', `${BASE}/api/method/maison_pos.api.dashboard.clients_overview?limit=30`)
check('live_summary / product_trends response times measured', true, [a, b, c, d, e, f].join(' | '))
save('results-e7.json')
await browser.close()
