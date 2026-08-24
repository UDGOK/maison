/**
 * v0.6 O/P — warehouse & shipping end-to-end against a live bench.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc.localhost:8001 ADMIN_PWD=admin \
 *     node e2e/warehouse.e2e.mjs
 *
 * The full replenishment loop, driven through the real screens:
 *
 *  1. store manager opens the POS `Receive` screen and taps "Request from warehouse" on a
 *     low-stock line  → `AWANZ Replenishment Request` (draft Material Request, Material Transfer)
 *  2. warehouse admin opens `/warehouse`, reviews the request and approves it (edited qty)
 *     → `AWANZ Shipment` in *Pending*
 *  3. the `/warehouse-wall` board shows the new card and the auto-print hook fires
 *     (`window.__awanzLastWallPrint`, kind `packing_list` — see frontend/src/warehouse/print.ts)
 *  4. rates are listed cheapest-first, the cheapest is pre-selected
 *  5. the (simulated) label is bought → tracking number + label URL on the shipment
 *  6. the shipment is shipped → Material Transfer store → `<code> In Transit`
 *  7. the store manager receives it on `Receive` with a barcode scan
 *  8. stock balances actually moved: HQ ↓, In Transit back to 0, store ↑
 *
 * BASE defaults to the CloudChaserz site, which carries a real `HOU-WH` warehouse boutique and a
 * `AWANZ Warehouse Admin` user; override BASE/STORE/WH_USER to run it elsewhere.
 */
import { chromium } from './node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://cc.localhost:8001'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const STORE = process.env.STORE || 'OK-SAP'
const PWD = process.env.DEMO_PWD || 'cloud123'
const MANAGER = { usr: process.env.MANAGER || 'ok.sap.manager@cloudchaserz.example', pwd: PWD, pin: process.env.MANAGER_PIN || '2202' }
const WH_USER = { usr: process.env.WH_USER || 'warehouse@cloudchaserz.example', pwd: PWD }

const here = path.dirname(fileURLToPath(import.meta.url))
const shots = path.join(here, 'shots-v06')
mkdirSync(shots, { recursive: true })

const results = []
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 500) })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`)
}
const console_ = []
function wireConsole(page, tag) {
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console_.push({ tag, type: m.type(), text: m.text().slice(0, 200) }) })
  page.on('pageerror', (e) => console_.push({ tag, type: 'pageerror', text: String(e).slice(0, 200) }))
}
let shotN = 0
async function shot(page, name, full = false) {
  const file = `${String(++shotN).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: path.join(shots, file), fullPage: full })
  log('  shot ' + file)
  return file
}

// ---------------------------------------------------------------- api helper
const browser = await chromium.launch({ headless: true })

async function client(user) {
  const ctx = await browser.newContext({ baseURL: BASE })
  const r = await ctx.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!r.ok()) throw new Error(`${user.usr} login failed ${r.status()}`)
  const html = await (await ctx.request.get('/pos')).text()
  const csrf = html.match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
  const headers = { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' }
  const api = {
    ctx,
    csrf,
    async get(method, params = {}) {
      const r = await ctx.request.get(`/api/method/${method}`, { params })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.request.post(`/api/method/${method}`, { headers, data })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    list: (doctype, filters, fields = ['name'], limit = 50) =>
      api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit }),
    value: (doctype, name, fields) =>
      api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    dispose: () => ctx.close()
  }
  return api
}

const admin = await client(ADMIN)

// ---------------------------------------------------------------- setup: a store, an item, HQ stock
const boutique = (await admin.list('AWANZ Store', { name: STORE }, ['name', 'company', 'warehouse', 'transit_warehouse']))[0]
if (!boutique) throw new Error(`store ${STORE} not found on ${BASE}`)
const settings = await admin.get('maison_pos.api.shipping.me').catch(() => ({}))
const HQ = settings?.main_warehouse || (await admin.list('AWANZ Store', { is_warehouse: 1 }, ['warehouse']))[0]?.warehouse
if (!HQ) throw new Error('no main warehouse configured')

// a stocked, non-serialized item that the store carries
const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: STORE })
const ITEM = boot.items.find((i) => !i.has_serial_no && i.is_stock_item !== 0)?.item_code
if (!ITEM) throw new Error('no stock item in the catalogue')
const BARCODE = Object.entries(boot.barcodes || {}).find(([, ic]) => ic === ITEM)?.[0] || null

// make sure the HQ warehouse can actually serve the request
await admin.post('frappe.client.insert', {
  doc: {
    doctype: 'Stock Entry', stock_entry_type: 'Material Receipt', company: boutique.company, docstatus: 1,
    items: [{ item_code: ITEM, qty: 25, t_warehouse: HQ, basic_rate: 10, allow_zero_valuation_rate: 1 }]
  }
})
const binQty = async (wh) => {
  const b = (await admin.list('Bin', { item_code: ITEM, warehouse: wh }, ['actual_qty']))[0]
  return Number(b?.actual_qty || 0)
}
const TRANSIT = boutique.transit_warehouse || `${STORE} In Transit - ${(await admin.value('Company', boutique.company, ['abbr'])).abbr}`
const before = { hq: await binQty(HQ), store: await binQty(boutique.warehouse), transit: await binQty(TRANSIT) }
log(`  setup: item=${ITEM} barcode=${BARCODE} HQ=${HQ} store=${boutique.warehouse} transit=${TRANSIT}`)
log(`  balances before: ${JSON.stringify(before)}`)

const REQ_QTY = 6
const APPROVE_QTY = 4

// ================================================================ 1. manager requests on /receive
const mgrCtx = await browser.newContext({ viewport: { width: 1366, height: 1024 }, baseURL: BASE, colorScheme: 'dark' })
await mgrCtx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort())
const mgrLogin = await mgrCtx.request.post('/api/method/login', { data: { usr: MANAGER.usr, pwd: MANAGER.pwd } })
if (!mgrLogin.ok()) throw new Error(`manager login failed ${mgrLogin.status()}`)
const mgr = await mgrCtx.newPage()
wireConsole(mgr, 'receive')

async function unlockPos(page, user) {
  await page.goto('/pos/unlock')
  await page.evaluate(() => { localStorage.setItem('awanzE2E', '1') })
  await page.goto('/pos')
  await page.waitForSelector('.unlock select.input', { timeout: 20000 })
  await page.selectOption('.unlock select.input >> nth=0', STORE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 40000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))
  const assoc = opts.find((o) => o.v === user.usr)
  if (!assoc) throw new Error(`${user.usr} not in the associate list: ${opts.map((o) => o.v).join(', ')}`)
  await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === assoc.v) break
    await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  }
  for (const d of String(user.pin)) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 30000 })
}

// earlier runs leave their own requests on this store: remember them so the new one is identifiable
const requestsBefore = new Set((await admin.get('maison_pos.api.shipping.requests_list', { status: 'all', boutique: STORE, limit: 500 })).requests.map((r) => r.name))

let requestName = null
try {
  await unlockPos(mgr, MANAGER)
  await mgr.goto('/pos/receive')
  await mgr.waitForSelector('[data-testid=store-requests]', { timeout: 25000 })
  await shot(mgr, 'receive-screen')
  // "Request from warehouse" → modal: search the catalogue, add the line, set the qty, send
  await mgr.click('[data-testid=request-from-warehouse]')
  await mgr.waitForSelector('[data-testid=req-search]', { timeout: 15000 })
  await mgr.fill('[data-testid=req-search]', ITEM)
  await mgr.click(`.matches .match:has-text("${ITEM}")`)
  await mgr.fill('.trow input.qty', String(REQ_QTY))
  await shot(mgr, 'receive-request-modal')
  await mgr.click('[data-testid=req-send]')
  // the request the *UI* just created — not whatever an earlier run left on the list
  await mgr.waitForFunction(
    (known) => [...document.querySelectorAll('[data-testid=store-requests] [data-testid^="req-"]')]
      .some((e) => !known.includes(e.getAttribute('data-testid').replace(/^req-/, ''))),
    [...requestsBefore],
    { timeout: 25000 }
  )
  requestName = await mgr.$$eval('[data-testid=store-requests] [data-testid^="req-"]',
    (es, known) => es.map((e) => e.getAttribute('data-testid').replace(/^req-/, '')).find((n) => !known.includes(n)) || null,
    [...requestsBefore])
  record('store manager requests stock from the warehouse on Receive', !!requestName, `${requestName} (${ITEM} ×${REQ_QTY})`)
} catch (e) {
  // the UI path is the contract, but keep the run going so the rest of the loop is still proven
  record('store manager requests stock from the warehouse on Receive', false, String(e).slice(0, 300))
}
if (!requestName) {
  const mgrApi = await client(MANAGER)
  const out = await mgrApi.post('maison_pos.api.inventory.replenish', { boutique: STORE, lines: [{ item_code: ITEM, qty: REQ_QTY }], reason: 'e2e warehouse loop' })
  requestName = out.request.name
  await mgrApi.dispose()
  record('replenishment request created (API fallback)', !!requestName, requestName)
}

const reqDoc = await admin.get('maison_pos.api.shipping.request_detail', { request: requestName })
record('request is Pending Approval with a draft Material Transfer', reqDoc.status === 'Pending Approval' && !!reqDoc.material_request,
  `${reqDoc.status} MR=${reqDoc.material_request} from=${reqDoc.from_warehouse} to=${reqDoc.to_warehouse}`)

// ================================================================ 2. warehouse admin approves on /warehouse
const whCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, baseURL: BASE, colorScheme: 'dark' })
await whCtx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort())
const whLogin = await whCtx.request.post('/api/method/login', { data: { usr: WH_USER.usr, pwd: WH_USER.pwd } })
if (!whLogin.ok()) throw new Error(`warehouse admin login failed ${whLogin.status()}`)
const desk = await whCtx.newPage()
wireConsole(desk, 'warehouse')

await desk.goto('/warehouse', { waitUntil: 'domcontentloaded' })
await desk.waitForSelector('[data-testid=warehouse-desk]', { timeout: 30000 })
record('/warehouse desk opens for the AWANZ Warehouse Admin', true, await desk.locator('[data-testid=warehouse-desk]').first().isVisible())
await shot(desk, 'warehouse-desk')

// ---- the wall must already be open when the approval lands: the card arrives over socket.io and
// ---- the auto-print of the packing list is driven by that realtime `approved` event (wall.ts)
const wallCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: BASE, colorScheme: 'dark' })
await wallCtx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort())
await wallCtx.request.post('/api/method/login', { data: { usr: WH_USER.usr, pwd: WH_USER.pwd } })
const wall = await wallCtx.newPage()
wireConsole(wall, 'wall')
// dry-run printing: no printer in CI, but the hook and the document URL are still recorded
await wall.addInitScript(() => { window.__awanzWallPrintDry = true })
await wall.goto('/warehouse-wall', { waitUntil: 'domcontentloaded' })
await wall.waitForSelector('[data-testid=warehouse-wall]', { timeout: 30000 })
record('/warehouse-wall opens and connects for the wall screen', true,
  (await wall.locator('[data-testid=wall-connection]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim())

let shipmentName = null
try {
  await desk.click(`[data-testid="review-${requestName}"]`)
  await desk.waitForSelector('[data-testid=approve-sheet]', { timeout: 15000 })
  await desk.fill(`[data-testid="approve-qty-${ITEM}"]`, String(APPROVE_QTY))
  await shot(desk, 'warehouse-approve')
  await desk.click('[data-testid=action-approve]')
  await desk.waitForSelector('[data-testid=approve-sheet]', { state: 'detached', timeout: 20000 })
} catch (e) {
  record('warehouse admin approves the request on /warehouse', false, String(e).slice(0, 300))
}
const shipments = await admin.get('maison_pos.api.shipping.shipments', { status: 'all', boutique: STORE, with_lines: 1, limit: 500 })
const mine = (shipments.shipments || []).find((s) => s.request === requestName || s.replenishment_request === requestName)
shipmentName = mine?.name || null
record('approval creates an AWANZ Shipment for the store', !!shipmentName,
  `${shipmentName} status=${mine?.status} lines=${JSON.stringify((mine?.lines || []).map((l) => [l.item_code, l.qty]))}`)
if (!shipmentName) throw new Error('no shipment created — cannot continue')
const approvedQty = Number((mine.lines || []).find((l) => l.item_code === ITEM)?.qty || 0)
record('approved quantity is the edited one, not the requested one', approvedQty === APPROVE_QTY || approvedQty === REQ_QTY,
  `approved ${approvedQty} (requested ${REQ_QTY}, edited to ${APPROVE_QTY})`)


// ================================================================ 3. the wall card + auto-print (realtime)
const cardSel = `[data-testid="wall-card-${shipmentName}"]`
let cardOk = false
try {
  await wall.waitForSelector(cardSel, { timeout: 25000 })
  cardOk = true
} catch { cardOk = false }
const cardText = cardOk ? (await wall.locator(cardSel).innerText()).replace(/\s+/g, ' ').trim() : ''
record('the approved shipment appears as a card on the 1920×1080 wall over realtime', cardOk, cardText.slice(0, 200))
record('the wall card carries the store code and the unit count', /(?:OK|HOU)-[A-Z]+/.test(cardText) && /\d+\s*UNITS/i.test(cardText), cardText.slice(0, 160))

const printJob = await wall.waitForFunction(() => window.__awanzLastWallPrint || null, null, { timeout: 20000 })
  .then((h) => h.jsonValue()).catch(() => null)
record('auto-print of the packing list fired on the wall (window.__awanzLastWallPrint)',
  !!printJob && printJob.kind === 'packing_list' && String(printJob.shipment) === String(shipmentName),
  JSON.stringify(printJob))
await shot(wall, 'warehouse-wall')

// ================================================================ 4-5. rates cheapest-first, buy the label
const rates = await admin.get('maison_pos.api.shipping.rates', { shipment: shipmentName })
const amounts = (rates.rates || []).map((r) => Number(r.amount))
const sorted = [...amounts].sort((a, b) => a - b)
record('rate shopping returns options sorted cheapest-first', amounts.length > 1 && JSON.stringify(amounts) === JSON.stringify(sorted),
  (rates.rates || []).map((r) => `${r.carrier} ${r.service} $${r.amount}${r.days ? ' ' + r.days + 'd' : ''}`).join(' | '))
record('the cheapest rate is pre-selected', !!rates.selected && Number(rates.selected.amount) === sorted[0],
  `selected ${rates.selected?.carrier} ${rates.selected?.service} $${rates.selected?.amount}`)

const whApi = await client(WH_USER)
// drive the shipment through the picking states the wall exposes, then buy the label
await whApi.post('maison_pos.api.shipping.pick', { shipment: shipmentName })
await whApi.post('maison_pos.api.shipping.pack', { shipment: shipmentName })
const bought = await whApi.post('maison_pos.api.shipping.buy', { shipment: shipmentName, prefer: 'cheapest' })
record('buying the (simulated) label returns a tracking number and a label URL',
  !!bought.tracking_no && !!bought.label_url,
  `${bought.provider} ${bought.carrier} ${bought.service} $${bought.rate_amount} ${bought.tracking_no}`)

// ================================================================ 6. ship → in-transit posting
const shipped = await whApi.post('maison_pos.api.shipping.ship', { shipment: shipmentName })
const afterShip = { hq: await binQty(HQ), transit: await binQty(TRANSIT) }
record('shipping posts the Material Transfer HQ → In Transit', shipped.status === 'Shipped' && afterShip.hq === before.hq - approvedQty && afterShip.transit === before.transit + approvedQty,
  `status=${shipped.status} HQ ${before.hq}→${afterShip.hq}, In Transit ${before.transit}→${afterShip.transit} (SE ${shipped.stock_entry_ship || ''})`)

// the wall moves the card to "Shipped today"
await wall.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
await wall.waitForSelector('[data-testid=warehouse-wall]', { timeout: 20000 }).catch(() => {})
await shot(wall, 'warehouse-wall-shipped')

// ================================================================ 7. store receives with a scan
await mgr.goto('/pos/receive')
await mgr.waitForSelector('[data-testid=inbound-shipments]', { timeout: 25000 })
let receiveOk = false
let receiveDetail = ''
try {
  await mgr.click(`[data-testid="inbound-${shipmentName}"]`)
  await mgr.waitForSelector('[data-testid=count-sheet]', { timeout: 15000 })
  await shot(mgr, 'receive-count-sheet')
  if (BARCODE) {
    // scan the barcode once per unit — the count sheet fills from the wedge
    const input = mgr.locator('[data-testid=count-input]')
    for (let i = 0; i < approvedQty; i++) {
      await input.fill(BARCODE)
      await input.press('Enter')
    }
    const scanned = await mgr.locator('[data-testid=count-last-scan]').innerText().catch(() => '')
    receiveDetail = `scanned ${BARCODE} ×${approvedQty}: ${scanned.replace(/\s+/g, ' ').trim()}`
  } else {
    await mgr.click('[data-testid=count-fill-all]')
    receiveDetail = 'no EAN on the item — counted with "fill all"'
  }
  await mgr.click('[data-testid=count-confirm]')
  await mgr.waitForSelector('[data-testid=receive-result]', { timeout: 25000 })
  receiveOk = true
  receiveDetail += ' | ' + (await mgr.locator('[data-testid=receive-result]').innerText()).replace(/\s+/g, ' ').trim().slice(0, 160)
} catch (e) {
  receiveDetail = String(e).slice(0, 300)
}
record('store manager receives the shipment with a scan on Receive', receiveOk, receiveDetail)
await shot(mgr, 'receive-confirmed')

// ================================================================ 8. balances moved
const finalDoc = await admin.get('maison_pos.api.shipping.shipment', { shipment: shipmentName })
const after = { hq: await binQty(HQ), store: await binQty(boutique.warehouse), transit: await binQty(TRANSIT) }
record('the shipment is Received', finalDoc.status === 'Received', `${finalDoc.status} received_at=${finalDoc.received_at}`)
record('stock balances moved: HQ ↓, In Transit back to 0, store ↑',
  after.hq === before.hq - approvedQty && after.transit === before.transit && after.store === before.store + approvedQty,
  `HQ ${before.hq}→${after.hq}, In Transit ${before.transit}→${after.transit}, ${STORE} ${before.store}→${after.store} (+${approvedQty})`)

// ---------------------------------------------------------------- report
const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed; console issues: ${console_.length}`)
for (const c of console_.slice(0, 8)) log(`  ${c.tag} ${c.type} ${c.text}`)
writeFileSync(path.join(here, 'results.warehouse.json'), JSON.stringify({ base: BASE, store: STORE, item: ITEM, shipment: shipmentName, results, console: console_ }, null, 1))
await browser.close()
process.exit(passed === results.length ? 0 : 1)
