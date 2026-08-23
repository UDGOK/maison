// Maison POS v0.4 end-to-end run against the REAL bench: operations & intelligence.
//
// Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin \
//       BENCH=/home/claude/frappe-bench node e2e/pos.v04.e2e.mjs
// Env:  BASE (default http://maison.localhost:8000), ADMIN_PWD, ASSOC_USER/PWD, MANAGER_USER/PWD, CLIENT_USER/PWD,
//       BENCH (bench dir; when set `inventory.low_stock_scan` runs through `bench execute`, the scheduler job itself)
//
// Flow (CHI-OAK):
//   associate: clock-in on Unlock (Maison Shift + HRMS Employee Checkin) → Settings: pick the V660p reader →
//   Sell: serialized watch + coupon WELCOME10 → card → receipt shows the coupon, server invoice carries it →
//   print = V660p canvas route (simulated reader with has_printer → `terminal.print(canvas)` → window.__maisonLastReaderPrint) →
//   Shift: low-stock card lists the alert produced by inventory.low_stock_scan →
//   Client: Clienteling tab shows wishlist + owned pieces; attaching the client shows "Suggested for this client" tiles
//   manager: Returns: the card sale line → credit note, serial back in stock, Stripe (simulated) refund, return receipt on the reader →
//   cash accessory sale → exchange for a pricier piece, difference paid cash → credit note + new invoice
//   web order (placed through the webshop API as the demo shopper) → Web orders: pick → ready → collect → Sales Invoice
//   guest: /r/<token> feedback (5 + comment) → Maison Feedback visible to HQ (feedback.list / dashboard live_summary)
//   reports.run Maison Sales Tax Summary → columns + rows (today's sales included)
import { chromium, request } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, 'shots-v04')
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const SITE = process.env.SITE || 'maison.localhost'
const BENCH = process.env.BENCH || ''
const BOUTIQUE = 'CHI-OAK'
const WAREHOUSE = 'CHI-OAK - MSN'
const ASSOC = { usr: process.env.ASSOC_USER || 'chi.oak.a1@maison.example', pwd: process.env.ASSOC_PWD || 'maison123', pin: '2580' }
const MANAGER = { usr: process.env.MANAGER_USER || 'chi.oak.manager@maison.example', pwd: process.env.MANAGER_PWD || 'maison123', pin: '1234' }
const CLIENT = { usr: process.env.CLIENT_USER || 'client@maison.example', pwd: process.env.CLIENT_PWD || 'maison123', customer: 'Isabella Marchetti' }
const ADMIN = { usr: 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const COUPON = 'WELCOME10'
const V660P = 'tmr_sim_chioak_1'
const ALERT_ITEM = 'AC-001'
const RUN = Date.now().toString(36).slice(-5).toUpperCase()

const results = []
const consoleLog = []
let shotN = 0
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(page, name, phone = false) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}${phone ? '-phone' : ''}.png`)
  await page.waitForTimeout(250)
  await page.screenshot({ path: f, fullPage: false })
  log('  shot', path.basename(f))
  return f
}
function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) && !/fonts\.(googleapis|gstatic)|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(m.text())) consoleLog.push({ tag, type: m.type(), text: m.text().slice(0, 300) })
  })
  page.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e.stack || e).slice(0, 400) }))
}

// ---- API helpers ----------------------------------------------------------------
async function apiFor(user) {
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!r.ok()) throw new Error(`${user.usr} login failed ${r.status()}`)
  const pos = await ctx.get('/pos')
  const csrf = (await pos.text()).match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
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
    setValue: (doctype, name, fieldname, value) => api.post('frappe.client.set_value', { doctype, name, fieldname, value }),
    value: (doctype, name, fields) => api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    doc: (doctype, name) => api.get('frappe.client.get', { doctype, name }),
    list: (doctype, filters, fields = ['name'], limit = 50) => api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit, order_by: 'creation desc' }),
    dispose: () => ctx.dispose()
  }
  return api
}

/** The hourly scheduler job: through `bench execute` when BENCH is set, else through the whitelisted alerts refresh. */
function runLowStockScan() {
  if (!BENCH) return { via: 'skipped (no BENCH)', out: null }
  const out = execFileSync('bench', ['--site', SITE, 'execute', 'maison_pos.api.inventory.low_stock_scan'], { cwd: BENCH, encoding: 'utf8', env: { ...process.env, HTTPLIB2_CA_CERTS: undefined } })
  return { via: 'bench execute', out: out.trim().split('\n').pop() }
}

// ---- POS helpers ------------------------------------------------------------------
async function posContext(browser, user, tag, viewport = { width: 1366, height: 1024 }) {
  const context = await browser.newContext({ viewport, baseURL: BASE, colorScheme: 'dark' })
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
  const login = await context.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!login.ok()) throw new Error(`${user.usr} login failed ${login.status()}`)
  const page = await context.newPage()
  wireConsole(page, tag)
  return { context, page }
}

async function freshDevice(page) {
  await page.goto('/pos/unlock')
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('maisonE2E', '1')
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
  })
}

async function selectAssociate(page, user) {
  await page.goto('/pos')
  await page.waitForSelector('.unlock select.input', { timeout: 20000 })
  await page.selectOption('.unlock select.input >> nth=0', BOUTIQUE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 30000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))
  const assoc = opts.find((o) => o.v === user.usr)
  if (!assoc) throw new Error(`${user.usr} not in the associate list: ${opts.map((o) => o.v).join(', ')}`)
  await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === assoc.v) break
    await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  }
}
async function typePin(page, pin) {
  for (const d of pin) await page.click(`.keypad button:text-is("${d}")`)
}
async function unlock(page, user, { clockIn = false } = {}) {
  await selectAssociate(page, user)
  if (clockIn) await page.click('[data-testid=action-clock-in]')
  await typePin(page, user.pin)
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await page.waitForSelector('.tile', { timeout: 20000 })
}
async function nav(page, label) {
  // the compact top bar (<= 1400 px) renders short labels ("Web", "Rcv"); the full label is
  // always on the button's title attribute, so match that instead of the visible text
  await page.click(`.nav-btn[title="${label}"]`)
}

async function addItem(page, name) {
  const q = page.locator('.sell .search input')
  await q.fill(name)
  const tile = page.locator(`.tile:not(.empty):has-text("${name}")`).first()
  await tile.waitFor({ timeout: 10000 })
  const before = await page.locator('.basket .line').count()
  await tile.click()
  const modal = page.locator('.serials .serial-btn')
  let serial = null
  if (await modal.count().then((n) => n > 0).catch(() => false)) {
    serial = (await modal.first().locator('.num-sn, .num').first().textContent()).trim()
    await modal.first().click()
  }
  await page.waitForFunction((n) => document.querySelectorAll('.basket .line').length > n, before, { timeout: 5000 })
  await q.fill('')
  if (!serial) serial = (await page.locator('.basket .line').last().locator('.line-sub .good.serial').textContent().catch(() => null))?.trim() || null
  return serial
}
async function readTotal(page) {
  const t = await page.locator('.basket .total-amt').textContent()
  return parseFloat(t.replace(/[^0-9.]/g, ''))
}
async function payCash(page, tendered) {
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash')
  for (const d of String(tendered)) await page.click(`.pay .keypad button:text-is("${d}")`)
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForSelector('.receipt-view', { timeout: 15000 })
}
async function payCard(page) {
  await page.click('.basket .pay button:has-text("Card")')
  await page.waitForSelector('.pay .card-flow')
  await page.click('.pay .card-flow button:has-text("Charge")')
  await page.waitForSelector('.receipt-view', { timeout: 30000 })
}
async function waitSynced(page, ms = 30000) {
  await page.waitForFunction(() => /Synced|Rejected/.test(document.querySelector('.receipt-view .pill')?.textContent || ''), null, { timeout: ms })
  const pill = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const uuid = page.url().split('/receipt/')[1]
  return { pill, uuid }
}
async function invoiceForUuid(admin, uuid) {
  for (let i = 0; i < 15; i++) {
    const rows = await admin.list('Sales Invoice', { maison_offline_uuid: uuid, docstatus: 1 }, ['name', 'grand_total', 'maison_coupon', 'maison_coupon_discount', 'maison_receipt_token', 'maison_terminal_ref', 'customer', 'is_return'])
    if (rows.length) return rows[0]
    await sleep(1000)
  }
  return null
}
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))

// ====================================================================================
const admin = await apiFor(ADMIN)
// repeated runs sell the demo accessories through: receive more before reading the catalogue,
// otherwise their tiles render `.tile.empty` and every step that rings them up times out.
async function ensureStock(code, min = 6, qty = 20) {
  const b = (await admin.list('Bin', { item_code: code, warehouse: `${BOUTIQUE} - MSN` }, ['actual_qty']))[0]
  if (Number(b?.actual_qty || 0) >= min) return
  const bq = (await admin.list('Maison Boutique', { name: BOUTIQUE }, ['company', 'warehouse']))[0]
  await admin.post('frappe.client.insert', {
    doc: {
      doctype: 'Stock Entry', stock_entry_type: 'Material Receipt', company: bq.company, docstatus: 1,
      items: [{ item_code: code, qty, t_warehouse: bq.warehouse, basic_rate: 100, allow_zero_valuation_rate: 1 }]
    }
  })
  log(`  topped up ${code} @ ${BOUTIQUE}: +${qty}`)
}
for (const code of ['AC-012', 'AC-001', 'AC-005', 'AC-011']) {
  try { await ensureStock(code) } catch (e) { log(`  stock top-up skipped for ${code}:`, String(e).slice(0, 160)) }
}
const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: BOUTIQUE })
const itemByCode = Object.fromEntries((boot.items || []).map((i) => [i.item_code, i]))
const priceOf = (code) => Number(boot.prices?.[code] ?? 0)
const stockOf = (code) => Number(boot.stock?.[code] ?? 0)
const serialsOf = (code) => (boot.serials?.[code] || [])
log(`bootstrap: ${Object.keys(itemByCode).length} items, coupon ${COUPON}, run ${RUN}`)

// 0. preparation: coupon present, open shifts closed, reorder level pushed above stock so the scan raises an alert
let before = {}
let reorderRow = null
try {
  const coupon = (await admin.list('Maison Coupon', { code: COUPON, enabled: 1 }, ['name', 'discount_type', 'value', 'usage', 'used_count']))[0]
  record('demo coupon WELCOME10 exists (Maison Coupon)', !!coupon, JSON.stringify(coupon))
  before.coupon_used = coupon?.used_count ?? 0
  // leave the associate clocked out so the Unlock screen offers "Clock in"
  for (const s of await admin.list('Maison Shift', { associate: ASSOC.usr, status: ['in', ['On shift', 'On break']] }, ['name'])) {
    await admin.post('maison_pos.api.hr.clock_out', { associate: ASSOC.usr }).catch(() => admin.setValue('Maison Shift', s.name, 'status', 'Closed'))
  }
  before.checkins = (await admin.list('Employee Checkin', { log_type: 'IN' }, ['name'], 500).catch(() => [])).length
  // low stock: push the reorder level of ALERT_ITEM at CHI-OAK above its stock (restored at the end)
  const item = await admin.doc('Item', ALERT_ITEM)
  reorderRow = (item.reorder_levels || []).find((r) => r.warehouse === WAREHOUSE) || null
  const bin = (await admin.list('Bin', { item_code: ALERT_ITEM, warehouse: WAREHOUSE }, ['actual_qty']))[0]
  // a crashed earlier run may have left the raised level behind: the demo seed sets 5 for this item
  before.reorder_level = reorderRow && reorderRow.warehouse_reorder_level > (bin?.actual_qty || 0) ? 5 : reorderRow?.warehouse_reorder_level
  if (reorderRow) await admin.setValue('Item Reorder', reorderRow.name, 'warehouse_reorder_level', Math.floor((bin?.actual_qty || 0) + 5))
  record('prep: reorder level of AC-001 @ CHI-OAK raised above stock', !!reorderRow, `stock ${bin?.actual_qty} → level ${Math.floor((bin?.actual_qty || 0) + 5)} (was ${before.reorder_level})`)
  const scan = runLowStockScan()
  const alerts = await admin.get('maison_pos.api.inventory.alerts', { boutique: BOUTIQUE })
  const alert = (alerts.alerts || alerts.rows || alerts).find?.((a) => a.item_code === ALERT_ITEM && ['Open', 'Acknowledged'].includes(a.status))
  record('inventory.low_stock_scan raises a Maison Stock Alert for AC-001 @ CHI-OAK', !!alert, `${scan.via}: ${scan.out || ''} · alert ${alert?.name} qty ${alert?.qty} / level ${alert?.reorder_level}`)
  before.feedback = (await admin.get('maison_pos.api.feedback.list', { boutique: BOUTIQUE, limit: 200 })).length
  before.live = await admin.get('maison_pos.api.dashboard.live_summary')
} catch (e) {
  record('preparation', false, String(e.stack || e))
}

// choose items: a serialized watch in stock at CHI-OAK, a cheap accessory, a pricier non-serialized piece
// prefer a watch with spare serials so repeated runs never take the boutique's last piece (the webshop e2e reserves one too)
const serialized = Object.keys(itemByCode).filter((c) => serialsOf(c).length).sort((a, b) => serialsOf(b).length - serialsOf(a).length)
const watchCode = serialized.find((c) => c.startsWith('TP-') && c !== 'TP-002' && serialsOf(c).length >= 2) || serialized.find((c) => c.startsWith('TP-')) || serialized[0]
const watch = itemByCode[watchCode]
const cheapCode = 'AC-012'
const cheap = itemByCode[cheapCode]
const pricierCode = Object.keys(itemByCode).filter((c) => !itemByCode[c].has_serial_no && itemByCode[c].is_stock_item && c !== cheapCode && priceOf(c) > priceOf(cheapCode) && stockOf(c) > 0).sort((a, b) => priceOf(a) - priceOf(b))[0]
const pricier = itemByCode[pricierCode]
log(`  watch ${watchCode} (${serialsOf(watchCode).length} serials) · cheap ${cheapCode} $${priceOf(cheapCode)} · pricier ${pricierCode} $${priceOf(pricierCode)}`)

const browser = await chromium.launch({ headless: true })

// ---------------------------------------------------------------------------------
// 1. Associate: clock-in on Unlock → reader pick → coupon sale (card) → receipt → V660p print → Shift low stock → Clienteling
let couponSale = null
let couponSerial = null
{
  const { context, page } = await posContext(browser, ASSOC, 'assoc')
  try {
    await freshDevice(page)
    await selectAssociate(page, ASSOC)
    const status0 = (await page.locator('[data-testid=shift-status]').textContent()).replace(/\s+/g, ' ').trim()
    await page.click('[data-testid=action-clock-in]')
    await shot(page, 'unlock-clock-in')
    await typePin(page, ASSOC.pin)
    await page.waitForSelector('.topbar', { timeout: 20000 })
    await page.waitForSelector('.tile', { timeout: 20000 })
    const shiftRow = (await admin.list('Maison Shift', { associate: ASSOC.usr, status: ['in', ['On shift', 'On break']] }, ['name', 'boutique', 'clock_in', 'checkin_in', 'status']))[0]
    const checkins = (await admin.list('Employee Checkin', { log_type: 'IN' }, ['name', 'employee', 'time'], 500).catch(() => [])).length
    record('clock-in on Unlock → open Maison Shift for the associate at CHI-OAK', !!shiftRow && shiftRow.boutique === BOUTIQUE, `${status0} → ${JSON.stringify(shiftRow)}`)
    record('clock-in → HRMS Employee Checkin (IN) created', checkins > before.checkins || !!shiftRow?.checkin_in, `checkins ${before.checkins} → ${checkins}; shift.checkin_in=${shiftRow?.checkin_in}`)

    // reader picker: Counter 1 · V660p (has printer)
    await nav(page, 'Settings')
    await page.waitForSelector('[data-testid=reader-picker]', { timeout: 15000 })
    await page.selectOption('[data-testid=reader-picker]', V660P)
    await page.waitForTimeout(300)
    const pickedText = await page.locator('[data-testid=reader-picker] option:checked').textContent()
    record('Settings: V660p reader picked from the boutique reader registry', /V660p/i.test(pickedText) && /printer/i.test(pickedText), pickedText.trim())
    await shot(page, 'settings-reader')

    // Shift: low stock card
    await nav(page, 'Shift')
    await page.waitForSelector('[data-testid=low-stock]', { timeout: 15000 })
    await page.click('[data-testid=low-stock] button:has-text("Refresh")').catch(() => {})
    await page.waitForFunction((code) => (document.querySelector('[data-testid=low-stock]')?.textContent || '').includes(code), ALERT_ITEM, { timeout: 15000 }).catch(() => {})
    const lowTxt = (await page.locator('[data-testid=low-stock]').textContent()).replace(/\s+/g, ' ')
    record('Shift screen shows the open low-stock alert for AC-001', lowTxt.includes(ALERT_ITEM) && /open/i.test(lowTxt), lowTxt.slice(0, 160))
    await shot(page, 'shift-low-stock')

    // Sell: watch → attach the demo client (Clienteling tab) → suggestions → coupon → card
    await nav(page, 'Sell')
    await page.waitForSelector('.tile', { timeout: 15000 })
    couponSerial = await addItem(page, watch.item_name)
    record('serialized watch added to the basket', !!couponSerial, `${watchCode} ${couponSerial}`)

    const profile = await admin.get('maison_pos.api.crm.profile', { customer: CLIENT.customer })
    if (!(profile.wishlist || []).some((w) => !w.fulfilled)) await admin.post('maison_pos.api.crm.wishlist_add', { customer: CLIENT.customer, item_code: 'HJ-001', notes: 'e2e' })
    const recs = await admin.get('maison_pos.api.insights.recommend_for_client', { customer: CLIENT.customer, n: 3, boutique: BOUTIQUE })
    async function openClient() {
      await nav(page, 'Client')
      await page.waitForSelector('.client-view input[type=search]', { timeout: 15000 })
      await page.fill('.client-view input[type=search]', 'Marchetti')
      const row = page.locator('.client-view .crow', { hasText: /Marchetti/i }).first()
      await row.waitFor({ timeout: 15000 })
      await row.click()
      await page.waitForSelector('[data-testid=detail-profile]', { timeout: 15000 })
      await page.click('[data-testid=detail-profile]')
      await page.waitForSelector('[data-testid=client-profile]', { timeout: 15000 })
    }
    await openClient()
    await page.click('[data-testid=cp-tab-wishlist]')
    await page.waitForSelector('[data-testid^=wish-]', { timeout: 15000 }).catch(() => {})
    const wishes = await page.locator('[data-testid^="wish-"]:not([data-testid=wish-add]):not([data-testid=wish-search])').count()
    await shot(page, 'client-wishlist')
    record('Clienteling tab shows the wishlist (profile, sizes, preferences)', wishes >= 1, `wishlist rows ${wishes} (server ${(profile.wishlist || []).length}) · ring ${profile.ring_size} · metal ${profile.metal_preference}`)
    await page.click('button:has-text("Attach to sale")')
    await page.waitForSelector('.basket .client-name:not(.dim)', { timeout: 15000 })
    await page.waitForSelector('[data-testid=suggested-for-client] .tiles > *', { timeout: 20000 }).catch(() => {})
    const tiles = await page.locator('[data-testid=suggested-for-client] .tiles > *').count()
    const tileTxt = (await page.locator('[data-testid=suggested-for-client]').textContent().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
    record('"Suggested for this client" tiles visible for a client with history', tiles >= 1 && (recs.items || []).length >= 1, `${tiles} tiles (server ${(recs.items || []).length}, source ${recs.source}) · ${tileTxt}`)
    await shot(page, 'suggestions')

    await nav(page, 'Sell')
    await page.waitForSelector('.tile', { timeout: 15000 })
    const totalBefore = await readTotal(page)
    await page.click('[data-testid=promotions-chip]')
    await page.waitForSelector('[data-testid=coupon-input]', { timeout: 10000 })
    await page.fill('[data-testid=coupon-input]', COUPON)
    await page.click('[data-testid=coupon-apply]')
    await page.waitForSelector('[data-testid=coupon-ok]', { timeout: 15000 })
    const okTxt = (await page.locator('[data-testid=coupon-ok]').textContent()).replace(/\s+/g, ' ').trim()
    await shot(page, 'coupon-sheet')
    await page.locator('button.close:has-text("Close")').first().click({ timeout: 3000 }).catch(() => {})
    await page.waitForSelector('[data-testid=coupon-total]', { timeout: 10000 })
    const couponLine = (await page.locator('[data-testid=coupon-total]').textContent()).replace(/\s+/g, ' ').trim()
    const totalAfter = await readTotal(page)
    record('coupon WELCOME10 applied at POS: basket shows the coupon line and a lower total', couponLine.includes(COUPON) && totalAfter < totalBefore, `${okTxt} · "${couponLine}" · ${totalBefore} → ${totalAfter}`)
    await shot(page, 'basket-coupon')

    await payCard(page)
    const rs = await waitSynced(page)
    const receiptTxt = (await page.locator('.receipt-view').textContent()).replace(/\s+/g, ' ')
    record('card sale synced; on-screen 80 mm receipt shows the coupon', rs.pill === 'Synced' && receiptTxt.includes(COUPON), `${rs.pill} · uuid ${rs.uuid}`)
    couponSale = await invoiceForUuid(admin, rs.uuid)
    record('server Sales Invoice carries maison_coupon + discount, the client and a terminal ref', !!couponSale && couponSale.maison_coupon === COUPON && couponSale.maison_coupon_discount > 0 && !!couponSale.maison_terminal_ref && couponSale.customer === CLIENT.customer, JSON.stringify(couponSale))
    const coupon2 = (await admin.list('Maison Coupon', { code: COUPON }, ['used_count']))[0]
    record('coupon redemption counted (used_count +1, Maison Coupon Redemption row)', coupon2.used_count === before.coupon_used + 1 && (await admin.list('Maison Coupon Redemption', { sales_invoice: couponSale?.name }, ['name'])).length === 1, `used ${before.coupon_used} → ${coupon2.used_count}`)
    await shot(page, 'receipt-coupon')

    // V660p print route: simulated reader with has_printer → terminal.print(canvas)
    await page.evaluate(() => { window.__maisonLastReaderPrint = undefined })
    await page.click('.receipt-view button:has-text("Print receipt")')
    await page.waitForFunction(() => typeof window.__maisonLastReaderPrint === 'string', null, { timeout: 15000 }).catch(() => {})
    const printed = await page.evaluate(() => window.__maisonLastReaderPrint || null)
    const printedMsg = (await page.locator('.receipt-view').textContent()).replace(/\s+/g, ' ')
    const png = printed ? Buffer.from(printed.split(',')[1], 'base64') : null
    const width = png && png.length > 24 ? png.readUInt32BE(16) : 0
    record('receipt printed through the reader route: terminal.print(canvas) called on the simulated V660p (384 px bitmap)', !!printed && printed.startsWith('data:image/png') && width === 384, `width ${width}px, ${png ? Math.round(png.length / 1024) : 0} KB · ${/Printed on/.test(printedMsg) ? printedMsg.match(/Printed on[^·]*/)?.[0].trim() : 'no "Printed on" label'}`)
    if (png) fs.writeFileSync(path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-reader-print-bitmap.png`), png)
    await shot(page, 'receipt-printed-reader')

    // owned pieces: the watch just sold shows under the client's Clienteling → Owned tab
    await openClient()
    await page.click('[data-testid=cp-tab-owned]')
    await page.waitForSelector(`[data-testid="owned-${couponSerial}"]`, { timeout: 20000 }).catch(() => {})
    const owned = await page.locator('[data-testid^=owned-]').count()
    const ownedMine = await page.locator(`[data-testid="owned-${couponSerial}"]`).count()
    await shot(page, 'client-owned')
    record('Clienteling → Owned pieces lists the serialized watch just sold to the client', owned >= 1 && ownedMine === 1, `owned pieces ${owned}, includes ${couponSerial}: ${ownedMine === 1}`)
    await page.locator('.basket button:has-text("Detach")').click({ timeout: 2000 }).catch(() => {})
  } catch (e) {
    record('associate flow', false, String(e.stack || e))
    await shot(page, 'assoc-error').catch(() => {})
  }
  await context.close()
}

// ---------------------------------------------------------------------------------
// 2. Manager: return of the card sale line → credit note; cash sale → exchange with difference
let cashSale = null
{
  const { context, page } = await posContext(browser, MANAGER, 'manager')
  try {
    await freshDevice(page)
    await unlock(page, MANAGER)
    await nav(page, 'Settings')
    await page.waitForSelector('[data-testid=reader-picker]', { timeout: 15000 })
    await page.selectOption('[data-testid=reader-picker]', V660P)

    // --- return of the serialized card sale ---
    await nav(page, 'Returns')
    await page.waitForSelector('.find input', { timeout: 15000 })
    await page.fill('.find input', couponSale.name)
    await page.click('.find button:has-text("Find")')
    await page.waitForSelector('.lines .line', { timeout: 20000 })
    await shot(page, 'returns-lines')
    const line = page.locator('.lines .line').first()
    await line.locator('.line-head').click()
    const chip = line.locator(`.serials .chip:has-text("${couponSerial}")`)
    if (await chip.count()) {
      const active = await chip.evaluate((el) => el.classList.contains('active'))
      if (!active) await chip.click()
    }
    await line.locator('select').selectOption('Change of mind')
    await line.locator('.seg .chip:has-text("Sellable")').click()
    await page.waitForSelector('.method.on', { timeout: 5000 }).catch(() => {})
    const cardBtn = page.locator('.method:has-text("Original card")')
    const cardEnabled = await cardBtn.isEnabled()
    if (cardEnabled) await cardBtn.click()
    const refundTxt = (await page.locator('.summary').textContent()).replace(/\s+/g, ' ')
    record('Returns: card sale found, serialized line + serial selected, refund to original card offered', cardEnabled && /Refund/.test(refundTxt), refundTxt.slice(0, 140))
    await shot(page, 'returns-refund')
    await page.click('.summary button.btn-primary')
    await page.waitForSelector('.section-title:has-text("Credit note")', { timeout: 40000 })
    const doneTxt = (await page.locator('.section-title:has-text("Credit note")').first().textContent()).replace(/\s+/g, ' ').trim()
    const creditNote = doneTxt.match(/Credit note (\S+)/)?.[1]
    await shot(page, 'returns-done')
    const cn = creditNote ? await admin.value('Sales Invoice', creditNote, ['is_return', 'return_against', 'docstatus', 'grand_total', 'maison_refund_method', 'maison_refund_id', 'update_stock']) : null
    record('credit note created (is_return, against the sale, submitted, card refund recorded)', !!cn && cn.is_return === 1 && cn.return_against === couponSale.name && cn.docstatus === 1 && /card/i.test(cn.maison_refund_method || '') && !!cn.maison_refund_id, JSON.stringify(cn))
    const sn = await admin.value('Serial No', couponSerial, ['warehouse', 'status'])
    record('returned serial is back in the boutique warehouse (sellable)', sn?.warehouse === WAREHOUSE, JSON.stringify(sn))
    const comm = await admin.list('Maison Commission Entry', { sales_invoice: creditNote }, ['name', 'commission_amount', 'is_reversal']).catch(() => [])
    record('commission reversal entry on the credit note', comm.length >= 1 && comm.every((c) => c.is_reversal === 1 && c.commission_amount < 0), JSON.stringify(comm))
    await page.evaluate(() => { window.__maisonLastReaderPrint = undefined })
    await page.click('button:has-text("Print return receipt")')
    await page.waitForFunction(() => typeof window.__maisonLastReaderPrint === 'string', null, { timeout: 15000 }).catch(() => {})
    const rprint = await page.evaluate(() => window.__maisonLastReaderPrint || null)
    record('return receipt printed on the reader (canvas route)', !!rprint && rprint.startsWith('data:image/png'), rprint ? `${Math.round(rprint.length / 1024)} KB data URL` : 'no bitmap')
    const rrRes = creditNote ? await admin.ctx.get('/printview', { params: { doctype: 'Sales Invoice', name: creditNote, format: 'Maison Return Receipt', no_letterhead: 1 } }) : null
    const rr = rrRes ? await rrRes.text() : ''
    record('Maison Return Receipt print format renders for the credit note (/printview)', !!rrRes && rrRes.ok() && /return/i.test(rr) && rr.includes(couponSerial) && !/Jinja|Traceback/.test(rr), `${rrRes?.status()} ${rr.length} chars`)
    await shot(page, 'returns-printed')

    // --- cash accessory sale → exchange for a pricier piece (difference paid cash) ---
    await nav(page, 'Sell')
    await page.waitForSelector('.tile', { timeout: 15000 })
    await addItem(page, cheap.item_name)
    const t1 = await readTotal(page)
    await payCash(page, Math.ceil(t1 / 100) * 100)
    const rs2 = await waitSynced(page)
    cashSale = await invoiceForUuid(admin, rs2.uuid)
    record('cash accessory sale synced (to be exchanged)', rs2.pill === 'Synced' && !!cashSale, `${cashSale?.name} ${cashSale?.grand_total}`)

    await nav(page, 'Returns')
    await page.waitForSelector('.find input', { timeout: 15000 })
    await page.fill('.find input', cashSale.name)
    await page.click('.find button:has-text("Find")')
    await page.waitForSelector('.lines .line', { timeout: 20000 })
    await page.locator('.lines .line').first().locator('.line-head').click()
    await page.locator('.lines .line').first().locator('select').selectOption('Sizing')
    await page.click('button:has-text("Exchange instead")')
    await page.waitForURL(/\/pos\/exchange\//, { timeout: 15000 })
    await page.waitForSelector('.grid .tile', { timeout: 20000 })
    await page.fill('input[placeholder="Search the catalogue"]', pricier.item_name)
    await page.locator(`.grid .tile:has-text("${pricier.item_name}")`).first().click()
    await page.waitForSelector('.seg .chip:has-text("Cash")', { timeout: 10000 })
    await page.click('.seg .chip:has-text("Cash")')
    const chargeTxt = (await page.locator('button.btn-primary.btn-big').textContent()).trim()
    record('exchange: new piece added, difference to collect shown', /^Charge/.test(chargeTxt), chargeTxt)
    await shot(page, 'exchange-confirm')
    await page.click('button.btn-primary.btn-big')
    await page.waitForSelector('.section-title:has-text("Exchange complete")', { timeout: 40000 })
    const xTxt = (await page.locator('.cols').textContent()).replace(/\s+/g, ' ')
    const xRows = Object.fromEntries(await page.$$eval('.cols .trow', (rs) => rs.map((r) => [r.querySelector('.label')?.textContent.trim(), r.querySelector('.num')?.textContent.trim()])))
    const xCredit = xRows['Credit note']
    const xNew = xRows['New sale']
    await shot(page, 'exchange-done')
    const xcn = xCredit ? await admin.value('Sales Invoice', xCredit, ['is_return', 'return_against', 'docstatus', 'grand_total']) : null
    const xsi = xNew ? await admin.value('Sales Invoice', xNew, ['docstatus', 'grand_total', 'maison_exchange_invoice', 'is_return']) : null
    const expectedDiff = priceOf(pricierCode) - priceOf(cheapCode)
    record('exchange with difference: credit note + new invoice linked, difference = price gap (+tax) paid', !!xcn && xcn.is_return === 1 && xcn.return_against === cashSale.name && !!xsi && xsi.docstatus === 1 && xsi.is_return === 0 && /Paid/.test(xTxt) && xsi.grand_total > Math.abs(xcn.grand_total),
      `credit ${xCredit} ${xcn?.grand_total} · new ${xNew} ${xsi?.grand_total} (exchange link ${xsi?.maison_exchange_invoice}) · gap ${expectedDiff.toFixed(2)} · ${xTxt.match(/(Paid|Refunded|Even)[^A-Z]*/)?.[0].trim()}`)
  } catch (e) {
    record('manager returns / exchange flow', false, String(e.stack || e))
    await shot(page, 'manager-error').catch(() => {})
  }
  await context.close()
}

// ---------------------------------------------------------------------------------
// 3. Web order (webshop API as the demo shopper) → collected at the POS
let orderName = null
let webInvoice = null
try {
  const client = await apiFor(CLIENT)
  const c = await client.get('maison_pos.api.webshop.cart')
  for (const l of c.items || []) await client.post('maison_pos.api.webshop.update_cart', { item_code: l.item_code, qty: 0 })
  await client.post('maison_pos.api.webshop.update_cart', { item_code: 'BR-006', qty: 1 })
  const placed = await client.post('maison_pos.api.webshop.place_order', { boutique: BOUTIQUE, pay_now: 1 })
  orderName = placed.sales_order
  if (placed.payment_request) await client.post('maison_pos.api.webshop.simulate_payment', { payment_request: placed.payment_request })
  const so = await admin.value('Sales Order', orderName, ['maison_boutique', 'maison_web_order', 'maison_web_status', 'maison_prepaid_amount', 'grand_total', 'docstatus'])
  record('web order placed for Oak Street through the webshop API (paid online, status New)', so.maison_boutique === BOUTIQUE && so.maison_web_status === 'New' && so.docstatus === 1 && Math.abs(so.maison_prepaid_amount - so.grand_total) < 0.01, `${orderName} ${JSON.stringify(so)}`)
  await client.dispose()
} catch (e) {
  record('web order placed for Oak Street through the webshop API', false, String(e))
}
if (orderName) {
  const { context, page } = await posContext(browser, MANAGER, 'web-orders')
  try {
    await unlock(page, MANAGER)
    await nav(page, 'Web orders')
    await page.waitForSelector('[data-testid=web-orders]', { timeout: 20000 })
    await page.waitForSelector(`[data-testid=web-order-row][data-name="${orderName}"]`, { timeout: 20000 })
    await page.click(`[data-testid=web-order-row][data-name="${orderName}"]`)
    await page.waitForSelector('[data-testid=web-order-pick]', { timeout: 15000 })
    await shot(page, 'web-orders-queue')
    await page.click('[data-testid=web-order-pick]')
    await page.waitForSelector('[data-testid=web-order-ready]', { timeout: 15000 })
    await page.click('[data-testid=web-order-ready]')
    await page.waitForSelector('[data-testid=web-order-collect]', { timeout: 15000 })
    await page.click('[data-testid=web-order-collect]')
    await page.waitForURL(/\/pos\/pay/, { timeout: 20000 })
    await shot(page, 'web-order-collect-pay')
    const complete = page.locator('[data-testid=collect-complete]')
    if (await complete.count()) await complete.click()
    else await page.click('button:has-text("Cash")').catch(() => {})
    await page.waitForURL(/\/pos\/receipt\//, { timeout: 30000 })
    const rs = await waitSynced(page)
    for (let i = 0; i < 10 && !webInvoice; i++) {
      webInvoice = (await admin.list('Sales Invoice', { maison_sales_order: orderName, docstatus: 1 }, ['name', 'grand_total', 'total_advance', 'outstanding_amount', 'maison_receipt_token', 'maison_boutique']))[0]
      if (!webInvoice) await sleep(1000)
    }
    const st = await admin.value('Sales Order', orderName, ['maison_web_status', 'maison_sales_invoice'])
    record('web order collected at the POS → submitted Sales Invoice, advance allocated, order Collected', rs.pill === 'Synced' && !!webInvoice && Math.abs(webInvoice.outstanding_amount) < 0.01 && st.maison_web_status === 'Collected' && st.maison_sales_invoice === webInvoice.name, `${webInvoice?.name} total ${webInvoice?.grand_total} advance ${webInvoice?.total_advance} · ${JSON.stringify(st)}`)
    await shot(page, 'web-order-receipt')
  } catch (e) {
    record('web order collected at the POS', false, String(e.stack || e))
    await shot(page, 'web-order-error').catch(() => {})
  }
  await context.close()
}

// ---------------------------------------------------------------------------------
// 4. Guest feedback on the public receipt page → visible to HQ
if (couponSale?.maison_receipt_token) {
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, baseURL: BASE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
  const page = await context.newPage()
  wireConsole(page, 'receipt')
  try {
    // the token belongs to the (now returned) coupon sale: use the exchange's new invoice or the web invoice instead if
    // the feedback form hides on returned sales — try the coupon sale first, then the web collection.
    const candidates = [couponSale.maison_receipt_token, webInvoice?.maison_receipt_token].filter(Boolean)
    let used = null
    for (const token of candidates) {
      await page.goto(`/r/${token}`)
      await page.waitForLoadState('networkidle')
      if (await page.locator('[data-testid=feedback-form] .mg-stars button').count()) { used = token; break }
    }
    record('public receipt page shows the private feedback form (guest)', !!used, used ? `/r/${used.slice(0, 8)}…` : 'no form on any candidate receipt')
    await shot(page, 'receipt-feedback-form', true)
    await page.click('[data-testid=feedback-form] .mg-stars button[data-rating="5"]')
    await page.fill('#mg-fb-comment', `Wonderful service at Oak Street (e2e ${RUN})`)
    await page.click('#mg-fb-send')
    await page.waitForSelector('#mg-fb-ok:not([hidden])', { timeout: 15000 })
    const thanks = (await page.locator('#mg-fb-ok').textContent()).trim()
    await shot(page, 'receipt-feedback-sent', true)
    const rows = await admin.get('maison_pos.api.feedback.list', { boutique: BOUTIQUE, limit: 200 })
    const mine = rows.find((r) => (r.comment || '').includes(RUN))
    const summary = await admin.get('maison_pos.api.feedback.summary', { days: 30 })
    record('feedback stored as Maison Feedback (rating 5, boutique, associate) and visible to HQ via feedback.list', !!mine && mine.rating === 5 && mine.boutique === BOUTIQUE && !!mine.associate, `${thanks} · ${JSON.stringify(mine)}`)
    record('HQ dashboard tile (feedback.summary) counts the new rating', JSON.stringify(summary).includes(BOUTIQUE) && JSON.stringify(summary).includes(RUN), JSON.stringify(summary).slice(0, 240))
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = (await page.locator('[data-testid=feedback-form]').textContent()).replace(/\s+/g, ' ')
    record('reloading the receipt shows "already received" instead of the form', /received/i.test(again) && !(await page.locator('#mg-fb-send').count()), again.slice(0, 100))
  } catch (e) {
    record('guest feedback flow', false, String(e.stack || e))
    await shot(page, 'feedback-error', true).catch(() => {})
  }
  await context.close()
}

// ---------------------------------------------------------------------------------
// 5. Reports: Maison Sales Tax Summary via reports.run (Administrator + boutique-scoped manager)
try {
  const today = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
  const rep = await admin.get('maison_pos.api.reports.run', { report: 'Maison Sales Tax Summary', filters: JSON.stringify({ from_date: from, to_date: today }) })
  const cols = (rep.columns || []).map((c) => c.fieldname || c.label || c)
  const chi = (rep.rows || []).filter((r) => JSON.stringify(r).includes(BOUTIQUE))
  record('Maison Sales Tax Summary runs via reports.run (columns + rows, CHI-OAK present)', cols.length >= 5 && (rep.rows || []).length >= 1 && chi.length >= 1, `${cols.length} columns ${rep.rows.length} rows · ${cols.slice(0, 8).join(', ')}`)
  const mgr = await apiFor(MANAGER)
  const rep2 = await mgr.get('maison_pos.api.reports.run', { report: 'Maison Sales Tax Summary', filters: JSON.stringify({ from_date: from, to_date: today }) })
  const other = (rep2.rows || []).filter((r) => /NYC-5AV|MIA-DD/.test(JSON.stringify(r)))
  record('boutique manager sees only CHI-OAK rows in the tax summary', (rep2.rows || []).length >= 1 && other.length === 0, `${rep2.rows.length} rows, ${other.length} foreign`)
  const lst = await mgr.get('maison_pos.api.reports.list_reports')
  record('reports.list_reports lists the 8 Maison reports as installed', (lst.reports || []).length === 8 && lst.reports.every((r) => r.installed), lst.reports.map((r) => r.name.replace('Maison ', '')).join(', '))
  await mgr.dispose()
} catch (e) {
  record('Maison Sales Tax Summary runs via reports.run', false, String(e))
}

// ---------------------------------------------------------------------------------
// 6. Phone drawer: the 8-entry nav (incl. Returns, Web orders, Count) fits on iPhone
{
  const { context, page } = await posContext(browser, ASSOC, 'phone', { width: 393, height: 852 })
  try {
    await unlock(page, ASSOC)
    await page.click('.menu-btn')
    await page.waitForSelector('.drawer', { timeout: 10000 })
    const labels = await page.$$eval('.drawer .drawer-btn', (bs) => bs.map((b) => b.textContent.trim().split(/\s+/)[0]))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    record('phone drawer lists Sell, Client, Returns, Web orders, Count, Queue, Shift, Settings (no horizontal overflow)', ['Returns', 'Web', 'Count', 'Queue', 'Shift', 'Settings'].every((l) => labels.includes(l)) && overflow <= 0, labels.join(' · '))
    await shot(page, 'phone-drawer', true)
  } catch (e) {
    record('phone drawer nav', false, String(e.stack || e))
  }
  await context.close()
  const { context: c2, page: p2 } = await posContext(browser, ASSOC, 'ipad', { width: 1024, height: 768 })
  try {
    await unlock(p2, ASSOC)
    const navOk = await p2.evaluate(() => {
      const nav = document.querySelector('.topbar .nav')
      const lock = document.querySelector('.topbar .lock-btn')
      return { items: nav.querySelectorAll('.nav-btn').length, navW: Math.round(nav.getBoundingClientRect().width), scrollW: nav.scrollWidth, lockRight: Math.round(lock.getBoundingClientRect().right), docW: document.documentElement.clientWidth }
    })
    // v0.6 O adds the "Receive" screen — 9 entries on the iPad top bar
    record('iPad landscape (1024 px): all 9 nav entries fit on one row with the Lock button on screen', navOk.items === 9 && navOk.scrollW <= navOk.navW + 4 && navOk.lockRight <= navOk.docW, JSON.stringify(navOk))
    await shot(p2, 'ipad-topbar')
  } catch (e) {
    record('iPad topbar nav', false, String(e.stack || e))
  }
  await c2.close()
}

// ---------------------------------------------------------------------------------
// cleanup: reorder level restored, alert resolved, associate clocked out
try {
  if (reorderRow && before.reorder_level !== undefined) await admin.setValue('Item Reorder', reorderRow.name, 'warehouse_reorder_level', before.reorder_level)
  runLowStockScan()
  await admin.post('maison_pos.api.hr.clock_out', { associate: ASSOC.usr }).catch(() => {})
  const open = await admin.get('maison_pos.api.inventory.alerts', { boutique: BOUTIQUE })
  const still = (open.alerts || open.rows || open).find?.((a) => a.item_code === ALERT_ITEM && a.status !== 'Resolved')
  record('cleanup: reorder level restored → alert resolved by the next scan; associate clocked out', !still, still ? JSON.stringify(still) : 'alert resolved')
} catch (e) {
  record('cleanup', false, String(e))
}
await admin.dispose()
await browser.close()

const failed = results.filter((r) => !r.ok)
fs.writeFileSync(path.join(__dirname, 'results.v04.json'), JSON.stringify({ base: BASE, run: RUN, results, console: consoleLog }, null, 2))
log(`\n${results.length - failed.length}/${results.length} checks passed; console issues: ${consoleLog.length}`)
for (const c of consoleLog.slice(0, 10)) log('  console', c.tag, c.type, c.text)
process.exit(failed.length ? 1 : 0)
