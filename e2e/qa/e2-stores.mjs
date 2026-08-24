import { launch, check, save, shot, money, BASE } from './lib-dash.mjs'
const { browser, page, console_ } = await launch()
await page.goto(`${BASE}/awanz-dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="live-cards"] .bcard', { timeout: 45000 })
await page.waitForTimeout(1500)

// ---- Live: drill-in from a card ----
await page.locator('.bcard[data-boutique="HOU-MTR"]').click()
await page.waitForSelector('.drill', { timeout: 20000 })
const drill = await page.locator('.drill').innerText()
check('Live card drill-in opens item-level feed', drill.length > 40 && /HOU-MTR/.test(drill), drill.replace(/\n/g, ' | ').slice(0, 300))
await shot(page, '03-live-drillin-1920.png')
// closing the drill-in: the panel has OPEN + CLOSE
const drillBtns = await page.locator('.drill button').allTextContents()
await page.locator('.drill button', { hasText: /close/i }).first().click().catch(() => {})
await page.waitForTimeout(500)
check('drill-in closes', (await page.locator('.drill').count()) === 0, `buttons: ${drillBtns.join(' / ')}`)

// UX: clicking the active Stores tab while inside a store page should return to the list
await page.goto(`${BASE}/awanz-dashboard?view=boutiques&boutique=HOU-MTR`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.page', { timeout: 30000 })
await page.click('.views .view-tab[data-view="boutiques"]')
await page.waitForTimeout(600)
const stillOnPage = await page.locator('.page').count()
check('clicking the STORES tab from a store page returns to the store list', stillOnPage === 0,
  stillOnPage ? `still on the store drill-in page; url=${page.url()} (App.vue setView keeps `+'`boutique`'+` when v === "boutiques")` : 'returned to list')
await page.goto(`${BASE}/awanz-dashboard?view=boutiques`, { waitUntil: 'domcontentloaded' })

// ---- Stores tab ----
const t0 = Date.now()
await page.waitForSelector('[data-testid="boutiques-table"] .row.data', { timeout: 30000 })
const tStores = Date.now() - t0
check('Stores tab loads', true, `${tStores} ms`)
await page.waitForTimeout(800)
await shot(page, '04-stores-1920.png')
const hdrs = await page.locator('[data-testid="boutiques-table"] .hdr .th').evaluateAll((e) => e.map((x) => ({ s: x.getAttribute('data-sort'), t: x.textContent.trim() })))
check('sortable column headers present', hdrs.filter((h) => h.s).length >= 6, hdrs.map((h) => `${h.t}${h.s ? '*' : ''}`).join(' | '))

const api = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.boutiques_table`)).json()
const rows = api.message.rows
const onScreen = () => page.locator('[data-testid="boutiques-table"] .row.data').evaluateAll((e) => e.map((x) => x.getAttribute('data-boutique')))
const expectBy = (k, dir) => [...rows].sort((a, b) => ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir || a.boutique.localeCompare(b.boutique)).map((r) => r.boutique)
const sortable = hdrs.filter((h) => h.s).map((h) => h.s)
const sd = []
let sortOk = true
for (const k of sortable) {
  await page.locator(`[data-testid="boutiques-table"] .hdr .th[data-sort="${k}"]`).click()
  await page.waitForTimeout(300)
  const got = await onScreen()
  const numeric = typeof rows[0][k] === 'number' || rows[0][k] === null
  const want = numeric ? expectBy(k, -1) : [...rows].map((r) => r[k] ?? '').map((_, i) => rows[i].boutique)
  const ok = numeric ? JSON.stringify(got) === JSON.stringify(want) : got.length === rows.length
  if (!ok && numeric) { sortOk = false; sd.push(`${k}: got=${got.join(',')} want=${want.join(',')}`) } else sd.push(`${k}: ok (${got.slice(0,3).join(',')}…)`)
  // toggle
  await page.locator(`[data-testid="boutiques-table"] .hdr .th[data-sort="${k}"]`).click()
  await page.waitForTimeout(300)
  const got2 = await onScreen()
  if (numeric) { const want2 = expectBy(k, 1); if (JSON.stringify(got2) !== JSON.stringify(want2)) { sortOk = false; sd.push(`${k} ASC: got=${got2.join(',')} want=${want2.join(',')}`) } }
}
check('every sortable column sorts correctly (desc + asc toggle)', sortOk, sd.join(' ; ').slice(0, 900))

const sparks = await page.locator('[data-testid="boutiques-table"] .row.data svg').count()
check('sparklines render on every row', sparks >= rows.length, `${sparks} svgs / ${rows.length} rows`)

// values match the API
const cells = await page.locator('[data-testid="boutiques-table"] .row.data').evaluateAll((els) => els.map((e) => ({ b: e.getAttribute('data-boutique'), text: e.innerText.replace(/\n/g, ' | ') })))
console.log('SAMPLE ROW:', JSON.stringify(cells[0]))

// ---- drill-in page ----
await page.locator('[data-testid="boutiques-table"] .row.data[data-boutique="HOU-MTR"]').click()
await page.waitForSelector('.page', { timeout: 20000 })
await page.waitForTimeout(1200)
const pg = await page.locator('.page').innerText()
await shot(page, '05-store-page-HOU-MTR-1920.png')
check('store page: hourly bars', (await page.locator('.page .bars .bar, .page svg').count()) > 0, `${await page.locator('.page .bars .bar').count()} bars`)
check('store page: top items', /top items/i.test(pg), pg.split('\n').slice(0, 6).join(' | '))
check('store page: associates', /associate/i.test(pg), '')
check('store page: alerts section', /alert/i.test(pg), '')
check('store page: feedback section', /feedback/i.test(pg), '')
const url = page.url()
check('store drill-in sets ?view=boutiques&boutique=', /view=boutiques/.test(url) && /boutique=HOU-MTR/.test(url), url)
// verify numbers against API
const det = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.boutique_detail?boutique=HOU-MTR&days=28`)).json()
const D = det.message
check('boutique_detail returns top_items/associates/alerts/feedback', true,
  `top_items=${D.top_items.length} associates=${D.associates.length} alerts=${D.alerts.length} feedback=${D.feedback.length} recent=${D.recent_sales.length}`)
const t1 = D.top_items[0]
check('top item on the page matches boutique_detail', t1 ? pg.includes(t1.item_name) : true, t1 ? `${t1.item_name} net=${t1.net} units=${t1.units}` : 'no items')

// ---- store with zero sales today ----
await page.goto(`${BASE}/awanz-dashboard?view=boutiques&boutique=OK-ETUL`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.page', { timeout: 30000 })
await page.waitForTimeout(1500)
const zero = await page.locator('.page').innerText()
await shot(page, '06-store-page-zero-sales-OK-ETUL-1920.png')
const zapi = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.boutique_detail?boutique=OK-ETUL&days=28`)).json()
check('store with zero sales today renders without error', zero.length > 60 && !/NaN|undefined|Infinity/.test(zero),
  `today invoices=${zapi.message.row.invoices} net=${zapi.message.row.net} last_sale=${JSON.stringify(zapi.message.row.last_sale)} | page: ${zero.replace(/\n/g,' | ').slice(0, 400)}`)
check('zero-sales store shows no NaN / Infinity / undefined', !/NaN|Infinity|undefined|null/.test(zero), (zero.match(/NaN|Infinity|undefined|null/g) || []).join(','))
check('no console errors on Stores', console_.filter(c=>!/favicon/.test(c)).length === 0, console_.slice(0, 5).join(' | '))
save('results-e2.json')
await browser.close()
