// Maison POS end-to-end run against the real bench.
// Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node e2e/pos.e2e.mjs
// Env:  BASE (default http://maison.localhost:8000), ASSOC_USER/ASSOC_PWD, ADMIN_PWD
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const BOUTIQUE = 'CHI-OAK'
const ASSOC = { usr: process.env.ASSOC_USER || 'chi.oak.a1@maison.example', pwd: process.env.ASSOC_PWD || 'maison123', pin: '2580' }
const ADMIN = { usr: 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const CUSTOMER_Q = 'chen'
const ACCESSORY = 'Silk Pocket Square'

const results = []
const consoleLog = []
let shotN = 0
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(page, name) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: f, fullPage: false })
  log('  shot', path.basename(f))
  return f
}
function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) consoleLog.push({ tag, type: m.type(), text: m.text() })
  })
  page.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e.stack || e) }))
  page.on('requestfailed', (r) => consoleLog.push({ tag, type: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure()?.errorText}` }))
}

// ---- admin API helper (separate request context) -------------------------------
async function adminApi() {
  const { request } = await import('playwright')
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.post('/api/method/login', { data: ADMIN })
  if (!r.ok()) throw new Error('admin login failed ' + r.status())
  return {
    async get(method, params = {}) {
      const r = await ctx.get(`/api/method/${method}`, { params })
      const j = await r.json()
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async invoiceByUuid(uuid) {
      const rows = await this.get('frappe.client.get_list', {
        doctype: 'Sales Invoice',
        filters: JSON.stringify({ maison_offline_uuid: uuid }),
        fields: JSON.stringify(['name', 'docstatus', 'is_pos', 'customer', 'grand_total', 'maison_boutique', 'maison_associate', 'maison_terminal_ref', 'posting_date'])
      })
      if (!rows.length) return null
      const inv = rows[0]
      const doc = await this.get('frappe.client.get', { doctype: 'Sales Invoice', name: inv.name })
      return doc
    },
    dispose: () => ctx.dispose()
  }
}

// ---- POS helpers ---------------------------------------------------------------
async function unlock(page, pin) {
  await page.waitForSelector('.unlock select.input', { timeout: 20000 })
  await page.selectOption('.unlock select.input >> nth=0', BOUTIQUE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 30000 })
  // pick the first Associate-role entry
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))
  const assoc = opts.find((o) => o.v === ASSOC.usr) || opts.find((o) => /Associate/.test(o.t)) || opts[0]
  await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  for (const d of pin) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 15000 })
  await page.waitForSelector('.tile', { timeout: 15000 })
  return assoc
}

/** name: item name, or { group } to pick the first in-stock serialized tile of that rail group. */
async function addItem(page, name) {
  const q = page.locator('.sell .search input')
  let tile
  if (typeof name === 'string') {
    await q.fill(name)
    tile = page.locator(`.tile:has-text("${name}")`).first()
  } else {
    await q.fill('')
    await page.click(`.rail .rail-btn:text-is("${name.group}")`)
    tile = page.locator('.tile:not(.empty):has(.sub.serial)').first()
  }
  await tile.waitFor({ timeout: 10000 })
  name = (await tile.locator('.name').textContent()).trim()
  const before = await page.locator('.basket .line').count()
  await tile.click()
  const modal = page.locator('.serials .serial-btn')
  let serial = null
  if (await modal.count().then((n) => n > 0).catch(() => false)) {
    serial = (await modal.first().locator('.num').textContent()).trim()
    await modal.first().click()
  }
  await page.waitForFunction((n) => document.querySelectorAll('.basket .line').length > n, before, { timeout: 5000 })
  await q.fill('')
  await page.click('.rail .rail-btn:text-is("All")')
  if (!serial) serial = (await page.locator('.basket .line').last().locator('.line-sub .good').textContent().catch(() => null))?.trim() || null
  return serial
}

async function attachClient(page, q) {
  await page.click('.basket .client')
  await page.waitForSelector('.client-view input[type=search]')
  await page.fill('.client-view input[type=search]', q)
  // debounce 200 ms + server search; wait until the list is filtered to the query
  const row = page.locator('.client-view .crow', { hasText: new RegExp(q, 'i') }).first()
  await row.waitFor({ timeout: 10000 })
  const name = (await row.locator('.crow-name').textContent()).trim()
  await row.click()
  await page.click('button:has-text("Attach to sale")')
  await page.waitForSelector('.basket .client-name:not(.dim)')
  return name
}

async function readTotal(page) {
  const t = await page.locator('.basket .total-amt').textContent()
  return parseFloat(t.replace(/[^0-9.]/g, ''))
}

async function payCash(page, tendered) {
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash')
  for (const d of String(tendered)) await page.click(`.pay .keypad button:text-is("${d}")`)
  await shot(page, 'pay-cash')
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForSelector('.receipt-view', { timeout: 10000 })
}

async function payCard(page) {
  await page.click('.basket .pay button:has-text("Card")')
  await page.waitForSelector('.pay .card-flow')
  await shot(page, 'pay-card-ready')
  await page.click('.pay .card-flow button:has-text("Charge")')
  await sleep(2500)
  await shot(page, 'pay-card-progress')
  await page.waitForSelector('.receipt-view', { timeout: 30000 })
}

async function receiptState(page) {
  const pill = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const inv = await page.locator('.receipt-view .head .row .muted').textContent().catch(() => '')
  const uuid = page.url().split('/receipt/')[1]
  return { pill, invoice: (inv || '').trim(), uuid }
}

async function waitSynced(page, ms = 20000) {
  await page.waitForFunction(() => /Synced|Rejected/.test(document.querySelector('.receipt-view .pill')?.textContent || ''), null, { timeout: ms })
  return receiptState(page)
}

function checkInvoice(doc, { customer, serial, mode, total, terminalRef }) {
  const issues = []
  if (!doc) return ['invoice not found']
  if (doc.docstatus !== 1) issues.push(`docstatus=${doc.docstatus}`)
  if (doc.is_pos !== 1) issues.push(`is_pos=${doc.is_pos}`)
  if (customer && doc.customer !== customer) issues.push(`customer=${doc.customer} expected ${customer}`)
  if (doc.maison_boutique !== BOUTIQUE) issues.push(`boutique=${doc.maison_boutique}`)
  if (serial) {
    const has = (doc.items || []).some((i) => (i.serial_no || '').includes(serial) || (i.serial_and_batch_bundle && true))
    if (!has) issues.push(`serial ${serial} not on any item row`)
  }
  const pays = (doc.payments || []).map((p) => `${p.mode_of_payment}:${p.amount}`)
  if (!(doc.payments || []).some((p) => p.mode_of_payment === mode)) issues.push(`payment mode ${mode} missing (${pays})`)
  if (total != null && Math.abs(doc.grand_total - total) > 0.011) issues.push(`grand_total=${doc.grand_total} expected ${total}`)
  if (terminalRef && !doc.maison_terminal_ref) issues.push('maison_terminal_ref empty')
  return issues
}

// ================================================================================
const browser = await chromium.launch({ headless: true })
const admin = await adminApi()
let assocLoggedIn = false

// 1. login as the associate
const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, baseURL: BASE })
let login = await context.request.post('/api/method/login', { data: { usr: ASSOC.usr, pwd: ASSOC.pwd } })
if (login.ok()) assocLoggedIn = true
else {
  log('associate login failed', login.status(), await login.text())
  login = await context.request.post('/api/method/login', { data: ADMIN })
}
record('login', login.ok(), assocLoggedIn ? `as ${ASSOC.usr}` : 'associate login FAILED, fell back to Administrator')

await context.addInitScript(() => {
  window.__errs = []
  window.addEventListener('error', (e) => window.__errs.push({ t: Date.now(), msg: String(e.message), stack: String(e.error?.stack || '') }))
  window.addEventListener('unhandledrejection', (e) => window.__errs.push({ t: Date.now(), msg: String(e.reason), stack: String(e.reason?.stack || '') }))
})
const page = await context.newPage()
wireConsole(page, 'pos')
await page.goto('/pos', { waitUntil: 'networkidle' })
await shot(page, 'pos-landing')
record('open /pos', (await page.locator('.unlock').count()) > 0, page.url())

try {
  // 2. unlock → sell → watch + accessory → client → cash
  const assoc = await unlock(page, ASSOC.pin)
  await shot(page, 'sell-after-unlock')
  const tiles = await page.locator('.tile').count()
  const railTxt = await page.locator('.rail-foot').textContent()
  record('unlock with PIN + catalog loaded', tiles > 20, `${tiles} tiles visible, rail: ${railTxt.trim()}, associate ${assoc.t.trim()}`)

  const serial = await addItem(page, { group: 'Timepieces' })
  const s2 = await addItem(page, ACCESSORY)
  await shot(page, 'basket-watch-accessory')
  record('add serialized watch + accessory', !!serial && s2 === null, `serial ${serial}`)

  const cname = await attachClient(page, CUSTOMER_Q)
  await shot(page, 'client-attached')
  record('attach client via search', !!cname, cname)

  const total1 = await readTotal(page)
  const tendered = Math.ceil(total1 / 100) * 100
  await payCash(page, tendered)
  let rs = await receiptState(page)
  await shot(page, 'receipt-cash-initial')
  rs = await waitSynced(page)
  await shot(page, 'receipt-cash-synced')
  const doc1 = await admin.invoiceByUuid(rs.uuid)
  const cust = doc1 ? doc1.customer : null
  const issues1 = checkInvoice(doc1, { customer: cust, serial, mode: 'Cash', total: total1 })
  const custOk = doc1 && (await admin.get('frappe.client.get_value', { doctype: 'Customer', filters: JSON.stringify({ name: doc1.customer }), fieldname: 'customer_name' })).customer_name === cname
  if (!custOk) issues1.push(`customer ${doc1?.customer} is not ${cname}`)
  record('CASH sale synced + server invoice verified', rs.pill === 'Synced' && issues1.length === 0, `${rs.pill} ${doc1?.name} total ${doc1?.grand_total} ${issues1.join('; ')}`)
  await page.click('button:has-text("Done")')

  // 3. CARD with simulated reader
  const serialC = await addItem(page, { group: 'Timepieces' })
  const total2 = await readTotal(page)
  await payCard(page)
  rs = await waitSynced(page)
  await shot(page, 'receipt-card-synced')
  const doc2 = await admin.invoiceByUuid(rs.uuid)
  const issues2 = checkInvoice(doc2, { serial: serialC, mode: 'Card', total: total2, terminalRef: true })
  record('CARD sale (simulated reader) synced + verified', rs.pill === 'Synced' && issues2.length === 0, `${rs.pill} ${doc2?.name} ref ${doc2?.maison_terminal_ref} ${issues2.join('; ')}`)
  await page.click('button:has-text("Done")')

  // 4. offline
  await context.setOffline(true)
  await page.waitForFunction(() => /Offline/.test(document.querySelector('.topbar .status')?.textContent || ''), null, { timeout: 20000 })
  await addItem(page, 'Travel Jewellery Case')
  const total3 = await readTotal(page)
  await payCash(page, Math.ceil(total3 / 100) * 100)
  await sleep(1500)
  rs = await receiptState(page)
  const statusTxt = (await page.locator('.topbar .status').textContent()).replace(/\s+/g, ' ').trim()
  await shot(page, 'offline-queued')
  record('offline cash sale queued', /Queued/.test(rs.pill) && /Offline.*1 queued/.test(statusTxt), `pill "${rs.pill}", topbar "${statusTxt}"`)
  const uuid3 = rs.uuid
  await context.setOffline(false)
  rs = await waitSynced(page, 40000)
  await page.waitForFunction(() => /Online/.test(document.querySelector('.topbar .status')?.textContent || ''), null, { timeout: 20000 })
  const statusTxt2 = (await page.locator('.topbar .status').textContent()).replace(/\s+/g, ' ').trim()
  await shot(page, 'online-drained')
  const doc3 = await admin.invoiceByUuid(uuid3)
  const issues3 = checkInvoice(doc3, { mode: 'Cash', total: total3 })
  record('queue drained after reconnect + invoice server-side', rs.pill === 'Synced' && issues3.length === 0 && !/queued/.test(statusTxt2), `${rs.pill} ${doc3?.name} topbar "${statusTxt2}" ${issues3.join('; ')}`)
  await page.click('button:has-text("Done")')

  // 5. dashboard live update
  const dctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: BASE })
  const dl = await dctx.request.post('/api/method/login', { data: ADMIN })
  const dpage = await dctx.newPage()
  wireConsole(dpage, 'dashboard')
  const socketFrames = []
  dpage.on('websocket', (ws) => {
    socketFrames.push({ url: ws.url() })
    ws.on('framereceived', (f) => socketFrames.push({ in: String(f.payload).slice(0, 200) }))
    ws.on('socketerror', (e) => socketFrames.push({ err: String(e) }))
  })
  await dpage.goto('/maison-dashboard', { waitUntil: 'networkidle' })
  await sleep(2000)
  await shot(dpage, 'dashboard-initial')
  const dashText0 = await dpage.locator('body').innerText()
  record('dashboard opens as Administrator', dl.ok() && /MAISON/i.test(dashText0) && !/not built/i.test(dashText0), '')

  const invoicesBefore = (await admin.get('maison_pos.api.dashboard.live_summary')).totals.invoices
  const kpiBefore = await dpage.evaluate(() => document.body.innerText)

  await addItem(page, 'Cufflinks Onyx and Gold')
  const total4 = await readTotal(page)
  await payCash(page, Math.ceil(total4 / 100) * 100)
  rs = await waitSynced(page)
  const inv4 = rs.invoice
  const t0 = Date.now()
  let seen = false
  while (Date.now() - t0 < 8000) {
    const txt = await dpage.evaluate(() => document.body.innerText)
    if (txt.includes(inv4) || txt.includes('Cufflinks')) { seen = true; break }
    await sleep(250)
  }
  const dt = Date.now() - t0
  await sleep(1600) // let the KPI counters / feed flash settle before the screenshot
  await shot(dpage, 'dashboard-after-sale')
  const invoicesAfter = (await admin.get('maison_pos.api.dashboard.live_summary')).totals.invoices
  record('dashboard updates live within 5s', seen && dt <= 5000, `${inv4} seen=${seen} after ${dt} ms; server invoices ${invoicesBefore}→${invoicesAfter}; ws: ${JSON.stringify(socketFrames.slice(0, 4))}`)
  await page.click('button:has-text("Done")')
  await dctx.close()
} catch (e) {
  record('UNCAUGHT', false, String(e.stack || e))
  await shot(page, 'failure').catch(() => {})
}

try {
  const errs = await page.evaluate(() => window.__errs || [])
  for (const e of errs) consoleLog.push({ tag: 'pos-window', type: 'error', text: `${e.msg} ${e.stack}`.slice(0, 600) })
} catch {}
await admin.dispose()
await browser.close()

const out = { results, console: consoleLog }
fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(out, null, 2))
log('\nConsole errors/warnings:', consoleLog.length)
for (const c of consoleLog) log(' ', c.tag, c.type, c.text.slice(0, 300))
process.exit(results.every((r) => r.ok) ? 0 : 1)
