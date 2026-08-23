// Maison v0.4 G — web shop (Frappe Webshop + Monolith Gold theme) end-to-end run against the REAL bench.
//
// Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/webshop.e2e.mjs
// Env:  BASE, ADMIN_PWD, CLIENT_USER/CLIENT_PWD (demo shopper), MANAGER_USER/MANAGER_PWD (Oak Street manager)
//
// Flow: guest home / collection / item pages (one-off → Enquire, timepiece → Reserve, band → Add to bag) →
// guest enquiry → loyalty lookup by client number + e-mail → shopper signs in → add to bag → cart →
// checkout picks Oak Street + pay online (simulated gateway) → Sales Order with maison_boutique + advance
// Payment Entry → reserve a timepiece with a 10 % deposit → POS (manager, Oak Street): Web orders queue →
// pick → ready → collect at the counter (balance by cash) → Sales Invoice with receipt token + SO Collected.
import { chromium, request } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, 'shots-webshop')
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const BOUTIQUE = 'CHI-OAK'
const CLIENT = { usr: process.env.CLIENT_USER || 'client@maison.example', pwd: process.env.CLIENT_PWD || 'maison123', customer: 'Isabella Marchetti' }
const MANAGER = { usr: process.env.MANAGER_USER || 'chi.oak.manager@maison.example', pwd: process.env.MANAGER_PWD || 'maison123', pin: '1234' }
const ADMIN = { usr: 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const RUN = Date.now().toString(36).slice(-5).toUpperCase()
const BUY_ITEM = 'BR-006' // Classic Wedding Band 2mm Platinum — qty item, Buy
const RESERVE_ITEM = 'TP-002' // Meridian Automatic Rose Gold — serialized, Reserve-with-deposit
const ENQUIRE_ITEM = 'HJ-001' // Cascade Diamond Riviere Necklace — one-off, Enquire

const results = []
const consoleLog = []
let shotN = 0
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// the dev bench reloads its web worker whenever a file changes (other work-streams edit concurrently):
// retry navigations that hit the reload window instead of failing the run
async function go(page, url, opts = { waitUntil: 'networkidle' }) {
  let last
  for (let i = 0; i < 5; i++) {
    try { return await page.goto(url, opts) } catch (e) { last = e; await sleep(3000) }
  }
  throw last
}
async function shot(page, name, full = false) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.waitForTimeout(300)
  await page.screenshot({ path: f, fullPage: full })
  log('  shot', path.basename(f))
  return f
}
function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) && !/fonts\.(googleapis|gstatic)|ERR_CONNECTION_RESET|net::ERR_FAILED|socket\.io/.test(m.text())) consoleLog.push({ tag, type: m.type(), text: m.text().slice(0, 300) })
  })
  page.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e.stack || e).slice(0, 400) }))
}

async function apiFor(user) {
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!r.ok()) throw new Error(`${user.usr} login failed ${r.status()}`)
  const pos = await ctx.get('/shop')
  const csrf = (await pos.text()).match(/csrf_token\s*[:=]\s*"([^"]*)"/)?.[1] || ''
  const headers = { 'X-Frappe-CSRF-Token': csrf }
  const api = {
    ctx,
    async get(method, params = {}) {
      const r = await ctx.get(`/api/method/${method}`, { params })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.post(`/api/method/${method}`, { data, headers })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    list: (doctype, filters, fields = ['name'], limit = 50) => api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit, order_by: 'creation desc' }),
    value: (doctype, name, fields) => api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    dispose: () => ctx.dispose()
  }
  return api
}

async function webContext(browser, user, tag, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, baseURL: BASE, colorScheme: 'dark' })
  if (user) {
    const login = await context.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
    if (!login.ok()) throw new Error(`${user.usr} login failed ${login.status()}`)
  }
  const page = await context.newPage()
  wireConsole(page, tag)
  return { context, page }
}

const admin = await apiFor(ADMIN)
const browser = await chromium.launch({ headless: true })

// repeated runs sell BUY_ITEM through at the collection boutique: top the bin up (Material Receipt) when low
try {
  const bin = (await admin.list('Bin', { item_code: BUY_ITEM, warehouse: `${BOUTIQUE} - MSN` }, ['actual_qty']))[0]
  if ((bin?.actual_qty || 0) < 4) {
    const company = (await admin.list('Maison Boutique', { name: BOUTIQUE }, ['company', 'warehouse']))[0]
    await admin.post('frappe.client.insert', { doc: { doctype: 'Stock Entry', stock_entry_type: 'Material Receipt', company: company.company, docstatus: 1, items: [{ item_code: BUY_ITEM, qty: 10, t_warehouse: company.warehouse, basic_rate: 800, allow_zero_valuation_rate: 1 }] } })
    log(`  restocked ${BUY_ITEM} @ ${BOUTIQUE}: ${bin?.actual_qty || 0} → +10`)
  }
} catch (e) { log('  restock skipped:', String(e).slice(0, 200)) }

// make sure the demo catalogue is in place (idempotent) and note the routes
let routes = {}
try {
  const rows = await admin.list('Website Item', { item_code: ['in', [BUY_ITEM, RESERVE_ITEM, ENQUIRE_ITEM]] }, ['item_code', 'route'])
  for (const r of rows) routes[r.item_code] = '/' + r.route
  record('demo website items published', Object.keys(routes).length === 3, JSON.stringify(routes))
} catch (e) {
  record('demo website items published', false, String(e))
}

// ---------------------------------------------------------------------------------
// 1. Guest: home, collection, item pages
{
  const { context, page } = await webContext(browser, null, 'guest')
  await go(page, '/shop')
  record('home renders in the gold theme', (await page.locator('.mw-hero h1').textContent())?.includes('atelier') && (await page.locator('.mw-card').count()) >= 8, `${await page.locator('.mw-card').count()} cards`)
  await shot(page, 'home', true)

  await go(page, '/shop/collection?item_group=Timepieces')
  const cards = await page.locator('.mw-card').count()
  const modes = await page.$$eval('.mw-card .mode', (els) => els.map((e) => e.textContent.trim()))
  record('collection lists timepieces with Reserve mode', cards >= 6 && modes.some((m) => /reserve/i.test(m)), `${cards} cards · ${[...new Set(modes)].join(' | ')}`)
  await shot(page, 'collection-timepieces', true)
  await go(page, '/all-products')
  record('/all-products is served by the Maison listing', (await page.locator('.mw-grid .mw-card').count()) > 10)

  // one-off → Enquire
  await go(page, routes[ENQUIRE_ITEM])
  const enquireBtn = page.locator('button[data-mw-sheet=mw-enquire]:has-text("Enquire about this piece")')
  record('serialized one-off shows Enquire (no add to cart)', (await enquireBtn.count()) === 1 && (await page.locator('#mw-add').count()) === 0)
  record('item page shows availability per boutique', (await page.locator('#mw-avail li').count()) === 3 && /Available at/.test(await page.locator('#mw-avail .mw-pill').textContent()), await page.locator('#mw-avail .mw-pill').textContent())
  await shot(page, 'item-enquire')
  await enquireBtn.click()
  await page.fill('#mw-enquire-form [name=name]', `Guest Enquirer ${RUN}`)
  await page.fill('#mw-enquire-form [name=email]', `guest.${RUN.toLowerCase()}@example.com`)
  await page.fill('#mw-enquire-form [name=message]', 'Could I see this piece in Chicago?')
  await page.selectOption('#mw-enquire-form [name=boutique]', BOUTIQUE)
  await shot(page, 'item-enquire-sheet')
  await page.click('#mw-enquire-form button[type=submit]')
  await page.waitForSelector('#mw-enquire-done', { state: 'visible', timeout: 15000 })
  const enq = (await admin.list('Maison Web Enquiry', { email: `guest.${RUN.toLowerCase()}@example.com` }, ['name', 'boutique', 'item_code', 'status']))[0]
  record('guest enquiry creates Maison Web Enquiry for the boutique', enq && enq.boutique === BOUTIQUE && enq.item_code === ENQUIRE_ITEM && enq.status === 'New', JSON.stringify(enq))

  // timepiece → Reserve
  await go(page, routes[RESERVE_ITEM])
  const reserveBtn = page.locator('button[data-mw-sheet=mw-reserve]')
  record('timepiece shows Reserve with deposit', (await reserveBtn.count()) === 1 && /deposit/i.test(await reserveBtn.textContent()), (await reserveBtn.textContent())?.trim())
  await shot(page, 'item-reserve')
  // band → Buy
  await go(page, routes[BUY_ITEM])
  record('accessory shows Add to bag', (await page.locator('#mw-add').count()) === 1)
  await shot(page, 'item-buy')

  // loyalty lookup as guest
  const cust = await admin.value('Customer', CLIENT.customer, ['maison_client_number', 'email_id'])
  await go(page, '/shop/account')
  await page.fill('#mw-lookup-form [name=client_number]', cust.maison_client_number)
  await page.fill('#mw-lookup-form [name=email]', 'wrong@example.com')
  await page.click('#mw-lookup-form button[type=submit]')
  await page.waitForTimeout(1200)
  record('loyalty lookup refuses a wrong e-mail', /could not match/i.test(await page.locator('#mw-lookup-error').textContent()))
  await page.fill('#mw-lookup-form [name=email]', cust.email_id)
  await page.click('#mw-lookup-form button[type=submit]')
  await page.waitForSelector('#mw-loyalty .mw-points', { timeout: 15000 })
  const pointsTxt = await page.locator('#mw-loyalty').textContent()
  record('loyalty lookup shows points for client number + e-mail', pointsTxt.includes(cust.maison_client_number) && /Points/.test(pointsTxt))
  await shot(page, 'account-loyalty-guest')

  // phone layout
  await page.setViewportSize({ width: 390, height: 844 })
  await go(page, '/shop')
  await shot(page, 'home-phone', true)
  await go(page, routes[RESERVE_ITEM])
  await shot(page, 'item-phone', true)
  await context.close()
}

// ---------------------------------------------------------------------------------
// 2. Shopper: bag → checkout (Oak Street, pay online) → order; reserve with deposit
let orderName = null
let reserveName = null
let reserveBoutique = BOUTIQUE
{
  const { context, page } = await webContext(browser, CLIENT, 'shopper')
  // start from an empty bag
  const client = await apiFor(CLIENT)
  try {
    const c = await client.get('maison_pos.api.webshop.cart')
    for (const l of c.items || []) await client.post('maison_pos.api.webshop.update_cart', { item_code: l.item_code, qty: 0 })
  } catch (e) { log('  cart reset:', String(e).slice(0, 120)) }

  await go(page, routes[BUY_ITEM])
  await page.click('#mw-add')
  await page.waitForSelector('#mw-view-bag', { state: 'visible', timeout: 15000 })
  record('add to bag (signed in)', (await page.locator('#mw-cart-count').textContent()).trim() === '1')
  await go(page, '/cart')
  record('/cart shows the Maison bag with the line', (await page.locator('.mw-line').count()) === 1 && /Choose a boutique/.test(await page.locator('.mw-summary').textContent()))
  await shot(page, 'cart')
  await page.click('.mw-line [data-d="1"]')
  const stepped = await page.waitForFunction(() => document.querySelector('.mw-line .qty span')?.textContent.trim() === '2', null, { timeout: 20000 }).then(() => true).catch(() => false)
  record('quantity stepper updates the cart', stepped)

  await go(page, '/shop/checkout')
  record('checkout offers every boutique with stock status', (await page.locator('#mw-boutiques .mw-boutique').count()) === 3)
  await page.click(`#mw-boutiques .mw-boutique[data-boutique="${BOUTIQUE}"]`)
  await page.click('#mw-pay .mw-boutique[data-pay="1"]')
  await shot(page, 'checkout')
  await page.click('#mw-place')
  await page.waitForURL(/\/shop\/pay\?pr=/, { timeout: 30000 })
  record('place order redirects to the (simulated) payment page', true, page.url())
  await shot(page, 'pay-simulated')
  await page.click('#mw-pay-go')
  await page.waitForURL(/\/shop\/order\?name=/, { timeout: 30000 })
  orderName = new URL(page.url()).searchParams.get('name')
  await page.waitForLoadState('networkidle')
  const so = await admin.value('Sales Order', orderName, ['maison_boutique', 'maison_web_order', 'maison_web_status', 'maison_prepaid_amount', 'grand_total', 'customer', 'docstatus'])
  record('Sales Order carries maison_boutique = CHI-OAK, web order, status New', so.maison_boutique === BOUTIQUE && so.maison_web_order === 1 && so.maison_web_status === 'New' && so.docstatus === 1 && so.customer === CLIENT.customer, JSON.stringify(so))
  record('online payment recorded as advance on the order', Math.abs(so.maison_prepaid_amount - so.grand_total) < 0.01, `prepaid ${so.maison_prepaid_amount} / total ${so.grand_total}`)
  record('order page shows timeline + boutique', /Received/.test(await page.locator('.mw-timeline').textContent()) && /Oak Street/.test(await page.locator('.mw-kv').textContent()))
  await shot(page, 'order-confirmation', true)

  // reserve with deposit
  await go(page, routes[RESERVE_ITEM])
  await page.click('button[data-mw-sheet=mw-reserve]')
  // every run reserves one serial; once Oak Street is out of this piece, reserve it at the next boutique that has one
  const preferred = page.locator(`#mw-reserve-boutiques .mw-boutique[data-boutique="${BOUTIQUE}"]:not([disabled])`)
  reserveBoutique = (await preferred.count()) ? BOUTIQUE : await page.locator('#mw-reserve-boutiques .mw-boutique:not([disabled])').first().getAttribute('data-boutique')
  await page.click(`#mw-reserve-boutiques .mw-boutique[data-boutique="${reserveBoutique}"]`)
  await shot(page, 'reserve-sheet')
  await page.click('#mw-reserve-go')
  await page.waitForURL(/\/shop\/pay\?pr=/, { timeout: 30000 })
  await page.click('#mw-pay-go')
  await page.waitForURL(/\/shop\/order\?name=/, { timeout: 30000 })
  reserveName = new URL(page.url()).searchParams.get('name')
  const rso = await admin.value('Sales Order', reserveName, ['maison_boutique', 'maison_web_mode', 'maison_deposit_amount', 'maison_prepaid_amount', 'grand_total'])
  record('reservation = Sales Order with 10 % deposit paid online', rso.maison_web_mode === 'Reserve-with-deposit' && rso.maison_boutique === reserveBoutique && Math.abs(rso.maison_prepaid_amount - rso.maison_deposit_amount) < 0.01 && rso.maison_deposit_amount > 0 && rso.maison_deposit_amount < rso.grand_total, JSON.stringify(rso))
  await shot(page, 'reservation-confirmation')

  await go(page, '/shop/account')
  record('account page shows loyalty + recent web orders for the signed-in client', (await page.locator('#mw-loyalty .mw-points').count()) === 1 && (await page.locator('.mw-orders a').count()) >= 2)
  await shot(page, 'account-signed-in', true)
  await client.dispose()
  await context.close()
}

// ---------------------------------------------------------------------------------
// 3. POS: Web orders queue for Oak Street → pick → ready → collect → Sales Invoice
async function unlock(page, user) {
  await page.goto('/pos/unlock')
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('maisonE2E', '1') })
  await page.goto('/pos')
  await page.waitForSelector('.unlock select.input', { timeout: 20000 })
  await page.selectOption('.unlock select.input >> nth=0', BOUTIQUE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 30000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))
  const assoc = opts.find((o) => o.v === user.usr) || opts.find((o) => /manager/i.test(o.t))
  if (!assoc) throw new Error(`${user.usr} not in the associate list: ${opts.map((o) => o.v).join(', ')}`)
  await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  // the associate list re-renders once the HR / clock-in status lands: make sure the choice stuck
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(400)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === assoc.v) break
    await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  }
  for (const d of user.pin) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await page.waitForSelector('.tile', { timeout: 20000 })
}
if (orderName) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, baseURL: BASE, colorScheme: 'dark' })
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
  const login = await context.request.post('/api/method/login', { data: { usr: MANAGER.usr, pwd: MANAGER.pwd } })
  if (!login.ok()) throw new Error('manager login failed')
  const page = await context.newPage()
  wireConsole(page, 'pos')
  try {
    await unlock(page, MANAGER)
    await page.click('.nav-btn[title="Web orders"]')
    await page.waitForSelector('[data-testid=web-orders]', { timeout: 20000 })
    await page.waitForSelector(`[data-testid=web-order-row][data-name="${orderName}"]`, { timeout: 20000 })
    record('POS Web orders queue lists the new order for Oak Street', true)
    await shot(page, 'pos-web-orders')
    await page.click(`[data-testid=web-order-row][data-name="${orderName}"]`)
    await page.waitForSelector('[data-testid=web-order-detail]', { timeout: 15000 })
    await shot(page, 'pos-web-order-detail')
    await page.click('[data-testid=web-order-pick]')
    await page.waitForSelector('[data-testid=web-order-ready]', { timeout: 15000 })
    let st = await admin.value('Sales Order', orderName, ['maison_web_status'])
    record('Pick → Sales Order status Picking', st.maison_web_status === 'Picking', st.maison_web_status)
    await page.click('[data-testid=web-order-ready]')
    await page.waitForSelector('[data-testid=web-order-collect]', { timeout: 15000 })
    st = await admin.value('Sales Order', orderName, ['maison_web_status'])
    record('Ready → Sales Order status Ready', st.maison_web_status === 'Ready', st.maison_web_status)
    await shot(page, 'pos-web-order-ready')
    await page.click('[data-testid=web-order-collect]')
    await page.waitForURL(/\/pos\/pay/, { timeout: 20000 })
    const due = await page.locator('[data-testid=pay-total]').first().textContent().catch(() => '')
    await shot(page, 'pos-collect-pay')
    // fully prepaid → complete without tender
    const complete = page.locator('[data-testid=collect-complete]')
    if (await complete.count()) await complete.click()
    else await page.click('button:has-text("Cash")').catch(() => {})
    await page.waitForURL(/\/pos\/receipt\//, { timeout: 30000 })
    await page.waitForTimeout(2500)
    await shot(page, 'pos-collect-receipt')
    let si = null
    for (let i = 0; i < 10 && !si; i++) {
      si = (await admin.list('Sales Invoice', { maison_sales_order: orderName, docstatus: 1 }, ['name', 'grand_total', 'total_advance', 'outstanding_amount', 'maison_receipt_token', 'maison_boutique', 'customer']))[0]
      if (!si) await sleep(1000)
    }
    record('collection creates a submitted Sales Invoice linked to the web order', !!si && si.maison_boutique === BOUTIQUE && si.customer === CLIENT.customer, JSON.stringify(si))
    record('online payment allocated as advance; nothing outstanding; receipt token issued', !!si && Math.abs(si.total_advance - si.grand_total) < 0.01 && Math.abs(si.outstanding_amount) < 0.01 && !!si.maison_receipt_token, si ? `advance ${si.total_advance} / total ${si.grand_total} / outstanding ${si.outstanding_amount}` : 'no invoice')
    st = await admin.value('Sales Order', orderName, ['maison_web_status', 'maison_sales_invoice', 'per_delivered', 'per_billed', 'status'])
    record('Sales Order marked Collected with the invoice', st.maison_web_status === 'Collected' && st.maison_sales_invoice === (si && si.name), JSON.stringify(st))
    if (si?.maison_receipt_token) {
      const rp = await context.newPage()
      await go(rp, `/r/${si.maison_receipt_token}`)
      await shot(rp, 'public-receipt')
      await rp.close()
    }
    // the reservation shows in the queue with its deposit
    await page.goto('/pos/web-orders')
    if (reserveBoutique === BOUTIQUE) {
      await page.waitForSelector(`[data-testid=web-order-row][data-name="${reserveName}"]`, { timeout: 20000 })
      const rowTxt = await page.locator(`[data-testid=web-order-row][data-name="${reserveName}"]`).textContent()
      record('reservation with deposit appears in the queue', /Reserve/i.test(rowTxt), rowTxt.replace(/\s+/g, ' ').trim().slice(0, 120))
    } else {
      const q = await admin.get('maison_pos.api.webshop.web_orders', { boutique: reserveBoutique })
      const row = (q.orders || []).find((o) => o.name === reserveName)
      record('reservation with deposit appears in the queue', !!row && /Reserve/i.test(row.web_mode || row.maison_web_mode || ''), `${reserveBoutique}: ${JSON.stringify(row).slice(0, 120)}`)
      await page.waitForSelector('[data-testid=web-orders]', { timeout: 20000 })
    }
    await page.click('.tab:has-text("Enquiries")')
    await page.waitForSelector('[data-testid=web-enquiry-row]', { timeout: 15000 }).catch(() => {})
    record('enquiries are listed in the queue', (await page.locator('[data-testid=web-enquiry-row]').count()) >= 1)
    await page.click('[data-testid=web-enquiry-row] >> nth=0')
    await shot(page, 'pos-web-enquiry')
    await page.click('.tab:has-text("Orders")')
    await shot(page, 'pos-web-orders-after')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/pos/web-orders')
    await page.waitForSelector('[data-testid=web-orders]', { timeout: 20000 })
    await shot(page, 'pos-web-orders-phone')
  } catch (e) {
    record('POS web orders flow', false, String(e).slice(0, 300))
    await shot(page, 'pos-failure').catch(() => {})
  }
  await context.close()
}

await browser.close()
await admin.dispose()

const failed = results.filter((r) => !r.ok)
fs.writeFileSync(path.join(__dirname, 'results.webshop.json'), JSON.stringify({ base: BASE, run: RUN, results, console: consoleLog }, null, 2))
log(`\n${results.length - failed.length}/${results.length} checks passed; console issues: ${consoleLog.length}`)
for (const c of consoleLog.slice(0, 10)) log('  console', c.tag, c.type, c.text)
process.exit(failed.length ? 1 : 0)
