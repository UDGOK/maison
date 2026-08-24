/**
 * FINAL ACCEPTANCE — storefront + dashboard lane (areas 6 and 7 of the brief).
 *
 *   BRIDGE=1 NODE_USE_ENV_PROXY=1 BASE=https://cloudchaserz.frappe.cloud ADMIN_SID=$(cat /tmp/ccsid) \
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node e2e/qa/fa-shop.mjs
 *
 *  7. a GUEST registers on the storefront (v0.8 QA A1 — the shop could not take an order from a
 *     new customer at all), puts an item in the bag, checks out click & collect, and the order
 *     lands in the POS web-order queue where the store collects it.
 *     /rewards carries the exact programme copy.
 *  6. the Command dashboard as hq@: 11 store cards and no warehouse row, and the hourly chart's
 *     peak is the real peak of the day (v0.8 QA D-1 — it used to be clamped to 09:00–21:00).
 */
import { chromium, request } from 'playwright'
import { installBridge } from './fa-bridge.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, 'shots-final')
fs.mkdirSync(SHOTS, { recursive: true })
const BASE = process.env.BASE || 'https://cloudchaserz.frappe.cloud'
const HOST = new URL(BASE).hostname
const BRIDGE = process.env.BRIDGE === '1'
const ADMIN_SID = process.env.ADMIN_SID || ''
const PWD = 'cloud123'
const STORE = 'HOU-MTR'
const MGR = { usr: 'hou.mtr.manager@cloudchaserz.example', pwd: PWD, pin: '1101' }
const HQ = { usr: 'hq@cloudchaserz.example', pwd: PWD }
const RUN = Date.now().toString(36).slice(-5).toLowerCase()
const SHOPPER = { email: `fa.shopper.${RUN}@test.example`, name: `Final Acceptance ${RUN.toUpperCase()}`, pwd: 'Cloud123!demo' }

const results = []
const notes = []
const artifacts = { orders: [], invoices: [], users: [], customers: [] }
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 900) })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`)
}
const note = (step, detail = '') => { notes.push({ step, detail: String(detail).slice(0, 900) }); log(`NOTE  ${step} — ${String(detail).slice(0, 300)}`) }

function wrap(ctx, headers) {
  const api = {
    async raw(method, params = {}) { const r = await ctx.get(`/api/method/${method}`, { params }); return { status: r.status(), body: await r.json().catch(() => ({})) } },
    async get(method, params = {}) {
      const r = await ctx.get(`/api/method/${method}`, { params }); const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.post(`/api/method/${method}`, { data, headers }); const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 400)}`)
      return j.message
    },
    list: (doctype, filters, fields = ['name'], limit = 50) =>
      api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit }),
    doc: (doctype, name) => api.get('frappe.client.get', { doctype, name }),
    dispose: () => ctx.dispose()
  }
  return api
}
async function adminApi() {
  const ctx = await request.newContext({
    baseURL: BASE,
    storageState: { cookies: [{ name: 'sid', value: ADMIN_SID, domain: HOST, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }
  })
  const home = await ctx.get('/app/home', { maxRedirects: 5 })
  const csrf = (await home.text()).match(/csrf_token[^"]*"([0-9a-f]{20,})"/)?.[1] || ''
  return wrap(ctx, { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' })
}

const browser = await chromium.launch({ headless: true })
async function newCtx(opts = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, colorScheme: 'dark', ...opts })
  if (BRIDGE) await installBridge(ctx)
  return ctx
}
async function loggedCtx(user, opts = {}) {
  const ctx = await newCtx(opts)
  const r = await ctx.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!r.ok()) throw new Error(`${user.usr} login failed ${r.status()}`)
  return ctx
}
async function unlockPos(page, user, store) {
  await page.goto('/pos', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unlock select.input', { timeout: 60000 })
  await page.selectOption('.unlock select.input >> nth=0', store)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 90000 })
  await page.selectOption('.unlock select.input >> nth=1', user.usr)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(250)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === user.usr) break
    await page.selectOption('.unlock select.input >> nth=1', user.usr)
  }
  for (const d of String(user.pin)) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 60000 })
  await page.waitForSelector('.tile', { timeout: 60000 })
}
const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, `fa-${name}.png`) }); log('  shot fa-' + name + '.png') }

const admin = await adminApi()
const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: STORE })
const stock = boot.stock || {}
const items = Object.fromEntries(boot.items.map((i) => [i.item_code, i]))
// a plain, non-restricted, in-stock item that is published on the web shop
let BUY = null
for (const wi of await admin.list('Website Item', { published: 1 }, ['name', 'item_code', 'route', 'web_item_name'], 200)) {
  const it = items[wi.item_code]
  if (!it || it.maison_age_restricted || it.has_serial_no) continue
  if ((stock[wi.item_code] || 0) < 5) continue
  BUY = wi; break
}
if (!BUY) throw new Error('no publishable non-restricted item with stock at ' + STORE)
log(`shop item ${BUY.item_code} (${BUY.web_item_name}) at /${BUY.route} · stock ${stock[BUY.item_code]}`)

// ==================================================================================
// 7. Storefront — guest registers, checks out click & collect, the store collects it
// ==================================================================================
log('\n=== 7. Shop — guest registration + click & collect ==================')
const shopCtx = await newCtx({ viewport: { width: 1440, height: 1000 } })
const shop = await shopCtx.newPage()
shop.on('pageerror', (e) => note('storefront page error', String(e).slice(0, 200)))

// the sign-in wall a guest meets on the bag (v0.8 QA A1) must be the storefront's own page
await shop.goto('/shop/cart', { waitUntil: 'domcontentloaded' })
await shop.waitForTimeout(1200)
const wall = new URL(shop.url())
record('a guest who opens the bag lands on the storefront sign-up page, not a dead end',
  wall.pathname === '/shop/register' && (await shop.locator('#rg-form').count()) === 1,
  `/shop/cart → ${wall.pathname}${wall.search}`)
await shot(shop, 'shop-register')

await shop.fill('#rg-name', SHOPPER.name)
await shop.fill('#rg-email', SHOPPER.email)
await shop.fill('#rg-password', SHOPPER.pwd)
await shop.fill('#rg-password2', SHOPPER.pwd)
await shop.click('[data-testid=register-submit]')
await shop.waitForTimeout(4000)
const afterReg = new URL(shop.url()).pathname
const signedIn = await shop.evaluate(() => document.body.getAttribute('frappe-session-status'))
const newUser = (await admin.list('User', { name: SHOPPER.email }, ['name', 'enabled', 'user_type', 'full_name'], 5))[0]
if (newUser) artifacts.users.push(newUser.name)
record('the guest can create a storefront account and is signed straight in',
  !!newUser && newUser.user_type === 'Website User' && signedIn === 'logged-in',
  `${newUser?.name} (${newUser?.user_type}) → ${afterReg}, session ${signedIn}`)

await shop.goto('/' + BUY.route.replace(/^\//, ''), { waitUntil: 'domcontentloaded' })
await shop.waitForSelector('#mw-add', { timeout: 40000 })
await shop.click('#mw-add')
await shop.waitForTimeout(3500)
await shop.goto('/shop/cart', { waitUntil: 'domcontentloaded' })
await shop.waitForTimeout(2500)
const cartText = (await shop.locator('body').innerText()).replace(/\s+/g, ' ')
record('the new shopper can put an item in the bag', new RegExp(BUY.web_item_name.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(cartText),
  cartText.slice(0, 160))

await shop.goto('/shop/checkout', { waitUntil: 'domcontentloaded' })
await shop.waitForSelector('#mw-boutiques .mw-boutique', { timeout: 40000 })
const storeBtn = shop.locator(`#mw-boutiques .mw-boutique[data-boutique="${STORE}"]`)
await storeBtn.click()
await shop.click('#mw-pay .mw-boutique[data-pay="1"]')
await shot(shop, 'shop-checkout')
await shop.click('#mw-place')
await shop.waitForTimeout(6000)
let orderUrl = new URL(shop.url())
// pay online routes through the simulated gateway → follow it to the end
for (let i = 0; i < 6 && !/\/shop\/order/.test(orderUrl.pathname); i++) {
  const payBtn = shop.locator('button:has-text("Pay"), .mw-btn:has-text("Pay"), button[type=submit]').first()
  if (await payBtn.count()) { await payBtn.click().catch(() => {}); await shop.waitForTimeout(4000) }
  else await shop.waitForTimeout(2000)
  orderUrl = new URL(shop.url())
}
const orderName = orderUrl.searchParams.get('name') || ''
if (orderName) artifacts.orders.push(orderName)
const so = orderName ? (await admin.list('Sales Order', { name: orderName },
  ['name', 'docstatus', 'status', 'customer', 'grand_total', 'advance_paid', 'maison_boutique', 'maison_fulfilment', 'maison_web_status'], 5))[0] : null
if (so?.customer) artifacts.customers.push(so.customer)
record('the shopper places a click & collect order paid online',
  !!so && so.docstatus === 1 && so.maison_boutique === STORE && Number(so.advance_paid) > 0,
  `${orderName} ${so?.status}/${so?.maison_web_status} ${so?.maison_fulfilment} at ${so?.maison_boutique} · $${so?.grand_total} paid $${so?.advance_paid} · ${so?.customer}`)
await shot(shop, 'shop-order-placed')

// --- /rewards copy
const rewards = await shopCtx.newPage()
await rewards.goto('/rewards', { waitUntil: 'domcontentloaded' })
await rewards.waitForSelector('[data-testid=rewards-tiers]', { timeout: 40000 })
const rewText = (await rewards.locator('body').innerText()).replace(/\s+/g, ' ')
const COPY = [/Earn 1 point for every \$1 you spend/i, /\$5 off at 100 points/i, /\$10 off at 200 points/i, /\$15 off at 300 points/i]
const missing = COPY.filter((re) => !re.test(rewText))
record('/rewards carries the exact programme copy', missing.length === 0 && /CLOUDCHASERZ/i.test(rewText),
  missing.length ? `missing ${missing.map(String).join(' ')}` : rewText.slice(rewText.search(/Earn 1 point/i), rewText.search(/Earn 1 point/i) + 180))
await rewards.close()

// --- the POS collects the order
log('\n--- POS web-order queue ---')
const posCtx = await loggedCtx(MGR, { viewport: { width: 1366, height: 1024 } })
const pos = await posCtx.newPage()
pos.on('pageerror', (e) => note('pos page error', String(e).slice(0, 200)))
await unlockPos(pos, MGR, STORE)
await pos.click('.topbar .nav-btn[title="Web orders"]')
await pos.waitForSelector('[data-testid=web-orders]', { timeout: 40000 })
const row = pos.locator(`[data-testid=web-order-row][data-name="${orderName}"]`)
let queued = false
try { await row.waitFor({ timeout: 30000 }); queued = true } catch { queued = false }
record('the web order appears in the POS web-order queue', queued,
  queued ? (await row.innerText()).replace(/\s+/g, ' ').trim().slice(0, 140) : `no row for ${orderName}`)
await shot(pos, 'pos-web-orders')
if (queued) {
  await row.click()
  await pos.waitForSelector('[data-testid=web-order-detail]', { timeout: 25000 })
  await pos.click('[data-testid=web-order-pick]')
  await pos.waitForSelector('[data-testid=web-order-ready]', { timeout: 30000 })
  await pos.click('[data-testid=web-order-ready]')
  await pos.waitForSelector('[data-testid=web-order-collect]', { timeout: 30000 })
  await pos.click('[data-testid=web-order-collect]')
  await pos.waitForSelector('[data-testid=collect-complete], .pay .cash', { timeout: 40000 })
  const due = (await pos.locator('[data-testid=pay-total]').innerText().catch(() => '')).trim()
  await pos.click('[data-testid=collect-complete]')
  await pos.waitForSelector('.receipt-view', { timeout: 60000 })
  await pos.waitForFunction(() => /Synced|Rejected/.test(document.querySelector('.receipt-view .pill')?.textContent || ''), null, { timeout: 60000 })
  const pill = (await pos.locator('.receipt-view .pill').first().innerText()).trim()
  const invName = (await pos.locator('.receipt-view .head .row .muted').innerText().catch(() => '')).trim()
  if (invName) artifacts.invoices.push(invName)
  const soAfter = (await admin.list('Sales Order', { name: orderName }, ['maison_web_status', 'status', 'per_billed'], 5))[0]
  record('the store collects the order at the counter and it becomes a Sales Invoice',
    /^synced$/i.test(pill) && !!invName && /collect/i.test(String(soAfter?.maison_web_status || '')),
    `amount due at the counter ${due} (paid online) → ${pill} ${invName}; order now ${soAfter?.maison_web_status} (${soAfter?.status}, billed ${soAfter?.per_billed}%)`)
  await shot(pos, 'pos-web-order-collected')
}

// ==================================================================================
// 6. Dashboard — 11 store cards, no warehouse row, and the real hourly peak
// ==================================================================================
log('\n=== 6. Dashboard ===================================================')
// a head-office browser in the chain's own timezone (the site runs America/Chicago)
const dashCtx = await loggedCtx(HQ, { viewport: { width: 1920, height: 1080 }, timezoneId: 'America/Chicago' })
const dash = await dashCtx.newPage()
dash.on('pageerror', (e) => note('dashboard page error', String(e).slice(0, 200)))
await dash.goto('/awanz-dashboard', { waitUntil: 'domcontentloaded' })
await dash.waitForSelector('[data-testid="live-cards"] .bcard', { timeout: 60000 })
await dash.waitForTimeout(2500)
const cards = await dash.$$eval('[data-testid="live-cards"] .bcard', (els) => els.map((e) => e.getAttribute('data-boutique')))
record('the Live tab shows 11 store cards and no warehouse row',
  cards.length === 11 && !cards.includes('HOU-WH'), `${cards.length} cards: ${cards.join(', ')}`)

const live = await admin.get('maison_pos.api.dashboard.live_summary', { nocache: 1 })
const hours = (live.by_hour || []).map((h) => ({ hour: Number(h.hour), net: Number(h.net || 0), invoices: Number(h.invoices || 0) }))
const traded = hours.filter((h) => h.net > 0)
const truePeak = traded.slice().sort((a, b) => b.net - a.net)[0] || null
const shownPeak = (await dash.locator('[data-testid=hourly-peak]').innerText().catch(() => '')).trim()
const shownHour = (shownPeak.match(/^(\d{1,2})/) || [])[1]
const shownAmt = parseFloat((shownPeak.split('·')[1] || '').replace(/[^0-9.]/g, ''))
const xLabels = await dash.$$eval('.chart .xlabels .num', (els) => els.map((e) => e.textContent.trim()))
const outsideOldWindow = traded.filter((h) => h.hour < 9 || h.hour > 21)
record('the hourly chart names the real peak of the day (v0.8 QA D-1)',
  !!truePeak && Number(shownHour) === truePeak.hour && Math.abs(shownAmt - truePeak.net) <= Math.max(1, truePeak.net * 0.01),
  `chart "PEAK ${shownPeak}" vs data peak ${String(truePeak?.hour).padStart(2, '0')}:00 $${truePeak?.net.toFixed(2)}; traded hours ${traded.map((h) => h.hour).join(',')}`)
// the fixed window (dashboard/src/lib/hourly.ts): every hour that traded, plus the current hour,
// widened to at least 8 columns — never the old hard-coded 09:00-21:00
const siteHour = Number(String(live.generated_at || '').slice(11, 13))
let lo = Math.min(...traded.map((h) => h.hour), siteHour)
let hi = Math.max(...traded.map((h) => h.hour), siteHour)
while (hi - lo + 1 < 8 && (lo > 0 || hi < 23)) { if (lo > 0) lo -= 1; if (hi - lo + 1 < 8 && hi < 23) hi += 1 }
const expectedLabels = []
for (let h = lo; h <= hi; h++) expectedLabels.push(String(h).padStart(2, '0') + ':00')
record('the chart window follows the data (and the current hour), not the old hard-coded 09:00–21:00',
  JSON.stringify(xLabels) === JSON.stringify(expectedLabels) && JSON.stringify(xLabels) !== JSON.stringify(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00']),
  `x labels [${xLabels.join(' ')}] = window derived from hours that traded (${traded.map((h) => h.hour).join(',')}) + site hour ${siteHour}; old code would have drawn 09:00–21:00. Hours trading outside 09–21 today: ${outsideOldWindow.map((h) => `${h.hour}:00 $${h.net.toFixed(2)}`).join(', ') || 'none'}`)
await shot(dash, 'dashboard-live')

// --- the same board from a browser in another timezone (the head office laptop travels)
const utcCtx = await loggedCtx(HQ, { viewport: { width: 1920, height: 1080 }, timezoneId: 'UTC' })
const utcDash = await utcCtx.newPage()
await utcDash.goto('/awanz-dashboard', { waitUntil: 'domcontentloaded' })
await utcDash.waitForSelector('[data-testid="live-cards"] .bcard', { timeout: 60000 })
await utcDash.waitForTimeout(2000)
const utcLabels = await utcDash.$$eval('.chart .xlabels .num', (els) => els.map((e) => e.textContent.trim()))
const utcClock = (await utcDash.locator('[data-testid=clock]').first().innerText().catch(() => '')).trim()
const cdtClock = (await dash.locator('[data-testid=clock]').first().innerText().catch(() => '')).trim()
if (JSON.stringify(utcLabels) !== JSON.stringify(xLabels)) {
  note('the hourly chart\'s "current hour" comes from the browser clock, not the site clock',
    `same board, same data: a browser in America/Chicago draws [${xLabels.join(' ')}] and one in UTC draws [${utcLabels.join(' ')}] — LiveView.vue computes \`new Date(d.now).getHours()\` (d.now is Date.now()), so the window is padded to the viewer's hour and the "current" column is highlighted in the viewer's zone, while the header clock beside it is rendered in the site zone by dashboard/src/lib/time.ts (header shows "${cdtClock}" / "${utcClock}"). Cosmetic, but the two disagree on one screen and the chart draws empty future hours.`)
}
await utcCtx.close()

const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed; ${notes.length} notes`)
fs.writeFileSync(path.join(__dirname, 'results.fa-shop.json'),
  JSON.stringify({ base: BASE, run: RUN, shopper: SHOPPER.email, artifacts, results, notes, hours }, null, 1))
await shopCtx.close(); await posCtx.close(); await dashCtx.close()
await browser.close(); await admin.dispose()
process.exit(passed === results.length ? 0 : 1)
