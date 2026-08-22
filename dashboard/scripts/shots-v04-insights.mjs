/**
 * v0.4 H — screenshots of the head-office dashboard "Insights" view (1920×1080) and the POS
 * next-best-offer tiles, against the live bench with the seeded 6-month history.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin \
 *     node dashboard/scripts/shots-v04-insights.mjs
 *
 * Writes dashboard/screenshots/v04/*.png
 */
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const ASSOC = { usr: 'nyc.5av.a1@maison.example', pwd: 'maison123', pin: '2580' }
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots', 'v04')
mkdirSync(out, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const login = await page.request.post(`${BASE}/api/method/login`, { data: ADMIN })
if (!login.ok()) throw new Error(`login failed: ${login.status()}`)

// ---- dashboard: insights view -------------------------------------------------------------
await page.goto(`${BASE}/maison-dashboard?view=insights`, { waitUntil: 'networkidle' })
await page.waitForSelector('text=Weekly narrative', { timeout: 30000 })
await page.waitForSelector('text=Revenue · item group × boutique', { timeout: 30000 })
await page.waitForSelector('text=Clients to contact this week', { timeout: 30000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(out, 'insights-1920x1080.png') })
check('insights view renders', true)
const narrative = await page.locator('.narrative .para').allTextContents()
check('weekly narrative present', narrative.length >= 3, narrative[0]?.slice(0, 120))
const heatCells = await page.locator('.grid .cell').count()
check('heatmap item-group × boutique', heatCells >= 9, `${heatCells} cells`)
const moves = await page.locator('text=Create transfer').count()
check('rebalance suggestions with one-click transfer', moves >= 1, `${moves} open`)
const contacts = await page.locator('.list .row .prio').count()
check('clients to contact list', contacts >= 5, `${contacts} rows`)

const panel = page.locator('.insights')
await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight))
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(out, 'insights-bottom-1920x1080.png') })

// movers: switch boutique tab
await page.click('.tabs .tab:has-text("CHI-OAK")')
await page.waitForTimeout(300)
check('movers tab switch', (await page.locator('.tabs .tab.on').textContent())?.includes('CHI-OAK'))

// live view still works
await page.click('.views .view-tab:has-text("Live")')
await page.waitForSelector('text=Boutiques', { timeout: 15000 })
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(out, 'live-1920x1080.png') })
check('live view intact', (await page.locator('.row.hdr').count()) >= 1)

// ---- POS: "Suggested for this client" + "Pairs well with" -----------------------------------
const pctx = await browser.newContext({ viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1 })
const pos = await pctx.newPage()
pos.on('pageerror', (e) => errors.push('pos: ' + String(e)))
const plogin = await pos.request.post(`${BASE}/api/method/login`, { data: ASSOC })
if (!plogin.ok()) throw new Error(`associate login failed: ${plogin.status()}`)
await pos.goto(`${BASE}/pos`, { waitUntil: 'networkidle' })
await pos.waitForSelector('.unlock select.input', { timeout: 20000 })
await pos.selectOption('.unlock select.input >> nth=0', 'NYC-5AV')
const load = pos.locator('.unlock button:has-text("Load")')
if (await load.count()) await load.click()
await pos.waitForSelector('.keypad', { timeout: 30000 })
const opts = await pos.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))
const assoc = opts.find((o) => o.v === ASSOC.usr) || opts.find((o) => /Associate/.test(o.t)) || opts[0]
await pos.selectOption('.unlock select.input >> nth=1', assoc.v)
for (const d of ASSOC.pin) await pos.click(`.keypad button:text-is("${d}")`)
await pos.waitForSelector('.tile', { timeout: 20000 })

// a client with history (top of the contact list) → attach via client number
const top = await (await page.request.get(`${BASE}/api/method/maison_pos.api.insights.client_signals?limit=5`)).json()
const sig = top.message.signals.find((s) => s.client_number) || top.message.signals[0]
await pos.fill('#client-no', sig.client_number.replace(/^MC/, ''))
await pos.press('#client-no', 'Enter')
await pos.waitForSelector('[data-testid="suggested-for-client"] .stile', { timeout: 20000 })
const recs = await pos.locator('[data-testid="suggested-for-client"] .stile').count()
const recCodes = await pos.$$eval('[data-testid="suggested-for-client"] .stile', (els) => els.map((e) => e.getAttribute('data-item')))
const owned = (await (await page.request.get(`${BASE}/api/method/maison_pos.api.insights.recommend_for_client?customer=${encodeURIComponent(sig.customer)}&n=3`)).json()).message.owned
check('suggested for this client: 3 tiles', recs === 3, `${sig.customer_name}: ${recCodes.join(', ')}`)
check('suggestions exclude owned items', recCodes.every((c) => !owned.includes(c)), `owned: ${owned.join(', ')}`)

// add a watch → "Pairs well with"
await pos.fill('.sell .search input', 'Meridian Automatic 40mm Steel')
const tile = pos.locator('.tile:not(.empty)').first()
await tile.click()
const serial = pos.locator('.serial-btn').first()
if (await serial.count()) await serial.click()
await pos.waitForSelector('[data-testid="pairs-well-with"] .stile', { timeout: 20000 })
const pairs = await pos.$$eval('[data-testid="pairs-well-with"] .stile', (els) => els.map((e) => e.getAttribute('data-item')))
check('pairs well with the basket', pairs.length >= 1 && !pairs.includes('TP-001'), pairs.join(', '))
await pos.fill('.sell .search input', '')
await pos.waitForTimeout(600)
await pos.screenshot({ path: path.join(out, 'pos-suggestions-1366x1024.png') })

// tapping a suggestion adds it to the basket
const first = pos.locator('[data-testid="pairs-well-with"] .stile:not(.off) .stile-main').first()
if (await first.count()) {
  const before = await pos.locator('.basket .line').count()
  await first.click()
  await pos.waitForTimeout(500)
  check('tapping a suggestion adds to the basket', (await pos.locator('.basket .line').count()) > before)
}

await browser.close()
writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 1))
console.log(JSON.stringify({ out, errors, pass: results.filter((r) => r.ok).length, total: results.length }, null, 1))
if (errors.length || results.some((r) => !r.ok)) process.exitCode = 1
