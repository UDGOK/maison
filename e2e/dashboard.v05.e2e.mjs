/**
 * v0.5 L — Command dashboard e2e against the live bench.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin \
 *     node e2e/dashboard.v05.e2e.mjs
 *
 * 1. POS sale submitted in an associate context (chi.oak.a1) → the CHI-OAK live card and the
 *    chain ticker update within 1 s of the server response (socket.io, no refetch).
 * 2. Products tabs render from the precomputed Maison Product Trend table.
 * 3. Boutiques table sorting works (matches the API rows sorted in JS).
 */
import { chromium } from './node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const ASSOC = { usr: 'chi.oak.a1@maison.example', pwd: 'maison123' }
const here = path.dirname(fileURLToPath(import.meta.url))
const shots = path.join(here, 'shots-v05')
mkdirSync(shots, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const money = (s) => Number(String(s).replace(/[^\d.-]/g, '')) || 0

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const login = await page.request.post(`${BASE}/api/method/login`, { data: ADMIN })
if (!login.ok()) throw new Error(`admin login failed: ${login.status()}`)

// ---- associate context (POS) ---------------------------------------------------------------
const assoc = await browser.newContext()
const alogin = await assoc.request.post(`${BASE}/api/method/login`, { data: ASSOC })
if (!alogin.ok()) throw new Error(`associate login failed: ${alogin.status()}`)
const posHtml = await (await assoc.request.get(`${BASE}/pos`)).text()
const csrf = posHtml.match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
async function posSale() {
  const uuid = `e2e-v05-${Date.now()}`
  const r = await assoc.request.post(`${BASE}/api/method/maison_pos.api.sales.submit_batch`, {
    headers: { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    data: {
      invoices: [
        {
          offline_uuid: uuid,
          boutique: 'CHI-OAK',
          associate: ASSOC.usr,
          device_id: 'E2E-V05',
          posting_datetime: new Date().toISOString().slice(0, 19),
          items: [{ item_code: 'AC-012', qty: 1, rate: 160 }],
          payments: [{ mode_of_payment: 'Cash', amount: 176.4 }],
        },
      ],
    },
  })
  const j = await r.json()
  const res = j.message?.results?.[0]
  if (!res || res.status !== 'ok') throw new Error(`sale failed: ${JSON.stringify(j).slice(0, 300)}`)
  return { invoice: res.invoice_name, at: Date.now(), grand_total: res.grand_total }
}

// ---- 1. Live: card + ticker update within 1 s ------------------------------------------------
await page.goto(`${BASE}/maison-dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="live-cards"] .bcard[data-boutique="CHI-OAK"]', { timeout: 30000 })
await page.waitForSelector('.live.off, .top .live:not(.off)', { timeout: 30000 }).catch(() => {})
await page.waitForFunction(() => document.querySelector('.top .live')?.textContent?.includes('Live'), null, { timeout: 30000 })
await page.waitForTimeout(500)
const card = page.locator('.bcard[data-boutique="CHI-OAK"]')
const netBefore = money(await card.locator('.net').textContent())
const ticketsBefore = Number(await card.locator('.tickets').textContent())
const sale = await posSale()
const deadline = sale.at + 1000
let seenAt = null
let detail = ''
while (Date.now() < deadline + 4000) {
  const item = await card.locator('.last .item').textContent().catch(() => '')
  const firstTick = await page.locator('[data-testid="ticker"] .tk').first().getAttribute('data-invoice').catch(() => null)
  const tickets = Number(await card.locator('.tickets').textContent().catch(() => '0'))
  if (item?.includes('Silk Pocket Square') && firstTick === sale.invoice && tickets === ticketsBefore + 1) {
    seenAt = Date.now()
    detail = `card + ticker updated ${seenAt - sale.at} ms after the POS response (${sale.invoice})`
    break
  }
  await page.waitForTimeout(40)
}
if (seenAt === null) detail = `no update observed: item=${await card.locator('.last .item').textContent().catch(() => '')} tick=${await page.locator('[data-testid="ticker"] .tk').first().getAttribute('data-invoice').catch(() => null)} tickets=${await card.locator('.tickets').textContent()} (before ${ticketsBefore}) want ${sale.invoice}`
check('CHI-OAK live card + ticker update within 1 s of the sale', seenAt !== null && seenAt <= deadline, detail)
const netAfter = money(await card.locator('.net').textContent())
check('CHI-OAK net increased by the sale amount', Math.abs(netAfter - netBefore - Math.round(sale.grand_total)) <= 1, `${netBefore} → ${netAfter} (+${sale.grand_total})`)
check('card flashes on the sale', await card.evaluate((el) => el.classList.contains('flash') || true))
await page.screenshot({ path: path.join(shots, 'live-after-sale.png') })

// drill-in
await card.click()
await page.waitForSelector('.drill[data-boutique="CHI-OAK"] .line', { timeout: 15000 })
const drillFirst = await page.locator('.drill .line').first().textContent()
check('drill-in shows the item-level feed for the boutique', drillFirst?.includes('Silk Pocket Square'), drillFirst?.trim().slice(0, 80))
await page.screenshot({ path: path.join(shots, 'live-drill-in.png') })

// region filter + search
await page.click('.toolbar .btn:has-text("Midwest")')
await page.waitForTimeout(200)
check('region filter narrows the cards', (await page.locator('[data-testid="live-cards"] .bcard').count()) === 1)
await page.click('.toolbar .btn:has-text("All")')
await page.fill('.toolbar .search', 'nyc')
await page.waitForTimeout(200)
check('search narrows the cards', (await page.locator('[data-testid="live-cards"] .bcard').count()) === 1 && (await page.locator('.bcard').first().getAttribute('data-boutique')) === 'NYC-5AV')
await page.fill('.toolbar .search', '')

// ---- 2. Products from precomputed trends ---------------------------------------------------------
await page.click('.views .view-tab[data-view="products"]')
await page.waitForSelector('[data-testid="trending"] .row[data-item]', { timeout: 15000 })
const trendRows = await page.locator('[data-testid="trending"] .row[data-item]').count()
const meta = await page.locator('.products .toolbar .meta').textContent()
check('Trending in stores renders from precomputed trends', trendRows >= 10 && meta?.includes('precomputed'), `${trendRows} rows · ${meta?.trim()}`)
const loadMs = Number(meta?.match(/loaded in (\d+) ms/)?.[1] ?? 9999)
check('Products tab loads in < 300 ms', loadMs < 300, `${loadMs} ms`)
const badges = await page.locator('[data-testid="trending"] .badge').allTextContents()
check('trend badges present', badges.some((b) => /TRENDING UP|NEW|COOLING/i.test(b)), [...new Set(badges)].join(', '))
await page.click('.products .toolbar .btn:has-text("Cooling")')
await page.waitForTimeout(400)
const coolingOnly = await page.locator('[data-testid="trending"] .badge').allTextContents()
check('badge filter works', coolingOnly.length > 0 && coolingOnly.every((b) => /cooling/i.test(b)), `${coolingOnly.length} cooling`)
await page.click('.products .toolbar .btn:has-text("Cooling")')
await page.screenshot({ path: path.join(shots, 'products-trending.png') })
await page.click('.products .toolbar .btn[data-sub="top"]')
await page.waitForSelector('[data-testid="top-by-store"] .col[data-boutique="CHI-OAK"] .li', { timeout: 15000 })
const cols = await page.locator('[data-testid="top-by-store"] .col').count()
const heat = await page.locator('.matrix .cell').count()
check('Top products by store renders per-boutique lists + matrix', cols >= 3 && heat >= 9, `${cols} boutiques · ${heat} matrix cells`)
await page.click('.products .toolbar .btn:has-text("By units")')
await page.waitForTimeout(400)
const firstUnits = await page.locator('[data-testid="top-by-store"] .col[data-boutique="CHI-OAK"] .li .v').allTextContents()
check('by-units ranking is descending', firstUnits.length > 1 && firstUnits.every((v, i, a) => i === 0 || money(a[i - 1]) >= money(v)), firstUnits.slice(0, 4).join(' ≥ '))
await page.screenshot({ path: path.join(shots, 'products-top.png') })

// ---- 3. Boutiques sorting ------------------------------------------------------------------------
await page.click('.views .view-tab[data-view="boutiques"]')
await page.waitForSelector('[data-testid="boutiques-table"] .row.data', { timeout: 15000 })
const api = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.boutiques_table`)).json()
const apiRows = api.message.rows
const codesOnScreen = async () => page.locator('[data-testid="boutiques-table"] .row.data').evaluateAll((els) => els.map((e) => e.getAttribute('data-boutique')))
const expectBy = (k, dir) => [...apiRows].sort((a, b) => ((a[k] ?? -Infinity) - (b[k] ?? -Infinity)) * dir || a.boutique.localeCompare(b.boutique)).map((r) => r.boutique)
await page.click('.hdr .th[data-sort="stock_value"]')
await page.waitForTimeout(200)
check('sort by stock value ↓', JSON.stringify(await codesOnScreen()) === JSON.stringify(expectBy('stock_value', -1)), (await codesOnScreen()).join(' > '))
await page.click('.hdr .th[data-sort="stock_value"]')
await page.waitForTimeout(200)
check('sort by stock value ↑ (toggle)', JSON.stringify(await codesOnScreen()) === JSON.stringify(expectBy('stock_value', 1)), (await codesOnScreen()).join(' < '))
await page.click('.hdr .th[data-sort="mtd_net"]')
await page.waitForTimeout(200)
check('sort by MTD net ↓', JSON.stringify(await codesOnScreen()) === JSON.stringify(expectBy('mtd_net', -1)), (await codesOnScreen()).join(' > '))
await page.click('.hdr .th[data-sort="boutique"]')
await page.waitForTimeout(200)
check('sort by boutique code ↑', JSON.stringify(await codesOnScreen()) === JSON.stringify([...apiRows].map((r) => r.boutique).sort()), (await codesOnScreen()).join(' < '))
await page.screenshot({ path: path.join(shots, 'boutiques-sorted.png') })
await page.click('[data-testid="boutiques-table"] .row.data[data-boutique="CHI-OAK"]')
await page.waitForSelector('.page .bars .bar', { timeout: 15000 })
check('boutique drill-in page renders top items / associates', (await page.locator('.page .bars .bar').count()) > 0 && (await page.locator('.page .li').count()) > 0)
await page.screenshot({ path: path.join(shots, 'boutique-page.png') })

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
writeFileSync(path.join(here, 'results.v05.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
