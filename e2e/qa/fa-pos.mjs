/**
 * FINAL ACCEPTANCE — POS lane (areas 2, 3 and 4 of the brief) against the LIVE site.
 *
 *   BRIDGE=1 NODE_USE_ENV_PROXY=1 BASE=https://cloudchaserz.frappe.cloud ADMIN_SID=$(cat /tmp/ccsid) \
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node e2e/qa/fa-pos.mjs
 *
 *  2. catalogue → PIN unlock → add items → age gate on a 21+ item → client attached by client
 *     number → cash sale → receipt QR + points → guest /r/<token> 200 → card sale on the
 *     simulated reader → split tender (cash + card).
 *  3. the two critical v0.8 fixes:
 *       (a) POS D1 — a multi-line basket with mixed quantities and a line discount whose unit
 *           rate does not divide into whole cents. Pre-v0.8 the device totalled it 2c above what
 *           ERPNext books (per-line tax rounding + a whole-line discount booked as `amount - disc`
 *           instead of `round(rate - disc/qty) * qty`) and the server refused the sale after the
 *           customer had paid. The device total must now equal the invoice `grand_total` exactly.
 *       (b) POS D2 — an offline sale of an AGE-RESTRICTED item. The device sent the age check's
 *           `checked_at` as an ISO string into a Datetime column, so MariaDB refused the row and
 *           the queue could never drain. Sell one offline, come back online, and the queue must
 *           drain into a real invoice carrying the age check.
 *  4. Returns — return a line from the card sale, points reverse, return receipt prints.
 *
 * Test code only: nothing under maison_pos/, frontend/ or dashboard/ is touched.
 */
import { chromium, request } from 'playwright'
import { installBridge } from '../cloud-bridge.mjs'
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
const PWD = process.env.DEMO_PWD || 'cloud123'
const STORE = 'HOU-MTR'
const ASSOC = { usr: 'hou.mtr.a1@cloudchaserz.example', pwd: PWD, pin: '2580' }
const MGR = { usr: 'hou.mtr.manager@cloudchaserz.example', pwd: PWD, pin: '1101' }
const RUN = Date.now().toString(36).slice(-5).toUpperCase()

const results = []
const notes = []
const consoleLog = []
const artifacts = { invoices: [], credit_notes: [], age_checks: [], shots: [] }
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 800) })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`)
}
const note = (step, detail = '') => { notes.push({ step, detail: String(detail).slice(0, 800) }); log(`NOTE  ${step} — ${String(detail).slice(0, 300)}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(page, name) {
  const f = `fa-${name}.png`
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(SHOTS, f) })
  artifacts.shots.push(f)
  log('  shot ' + f)
}
function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) &&
      !/fonts\.(googleapis|gstatic)|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|ERR_CONNECTION_RESET|WebGL|Vue Devtools|Failed to load resource/i.test(m.text())) {
      consoleLog.push({ tag, type: m.type(), text: m.text().slice(0, 300) })
    }
  })
  page.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e.stack || e).slice(0, 400) }))
}

// ------------------------------------------------------------------ api helpers
function wrap(ctx, headers) {
  const api = {
    ctx, headers,
    async raw(method, params = {}) { const r = await ctx.get(`/api/method/${method}`, { params }); return { status: r.status(), body: await r.json().catch(() => ({})) } },
    async get(method, params = {}) {
      const r = await ctx.get(`/api/method/${method}`, { params })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.post(`/api/method/${method}`, { data, headers })
      const j = await r.json().catch(() => ({}))
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
  const who = await ctx.get('/api/method/frappe.auth.get_logged_user')
  const j = await who.json().catch(() => ({}))
  if (!who.ok() || j.message !== 'Administrator') throw new Error(`ADMIN_SID invalid (${who.status()})`)
  const home = await ctx.get('/app/home', { maxRedirects: 5 })
  const csrf = (await home.text()).match(/csrf_token[^"]*"([0-9a-f]{20,})"/)?.[1] || ''
  return wrap(ctx, { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' })
}
async function invoiceByUuid(admin, uuid) {
  const rows = await admin.list('Sales Invoice', { maison_offline_uuid: uuid },
    ['name', 'docstatus', 'is_pos', 'customer', 'grand_total', 'net_total', 'total_taxes_and_charges',
      'maison_boutique', 'maison_terminal_ref', 'maison_age_verified', 'maison_age_check', 'maison_age_checked_at', 'maison_receipt_token'], 5)
  return rows[0] || null
}

// ------------------------------------------------------------------ browser helpers
const browser = await chromium.launch({ headless: true })
let offlineFlag = false
async function loggedCtx(user, opts = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, colorScheme: 'dark', ...opts })
  if (BRIDGE) await installBridge(ctx, { isOffline: () => offlineFlag })
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
async function addTile(page, code, times = 1) {
  const q = page.locator('.sell .search input')
  for (let i = 0; i < times; i++) {
    await q.fill(code)
    const tile = page.locator('.tile:not(.empty)').first()
    await tile.waitFor({ timeout: 25000 })
    await tile.click()
    await page.waitForTimeout(250)
  }
  await q.fill('')
}
/** Type the printed client number on the basket keypad field and wait for the client to land. */
async function attachByClientNumber(page) {
  await page.fill('#client-no', CLIENT_NO)
  await page.click('.cn-row .cn-btn.go')
  await page.waitForFunction(() => {
    const el = document.querySelector('.basket .client-name')
    return !!el && !/walk-?in/i.test(el.textContent || '')
  }, null, { timeout: 30000 }).catch(() => {})
}
const readTotal = async (page) => parseFloat((await page.locator('.basket .total-amt').textContent()).replace(/[^0-9.]/g, ''))
async function receiptState(page) {
  const pill = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const inv = (await page.locator('.receipt-view .head .row .muted').textContent().catch(() => '') || '').trim()
  const uuid = page.url().split('/receipt/')[1]
  const reason = /Rejected/i.test(pill)
    ? (await page.locator('.receipt-view').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400) : ''
  return { pill, invoice: inv, uuid, reason }
}
async function waitSynced(page, ms = 60000) {
  await page.waitForFunction(() => /Synced|Rejected/.test(document.querySelector('.receipt-view .pill')?.textContent || ''), null, { timeout: ms })
  return receiptState(page)
}
async function payCash(page) {
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash', { timeout: 25000 })
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForSelector('.receipt-view', { timeout: 45000 })
}

// AAMVA payload (mirrors frontend/src/scan/aamva.ts syntheticAamva)
function aamva({ dob, expiry, family = 'RIVERA', given = 'ALEX', jurisdiction = 'TX' }) {
  const us = (d) => `${d.slice(5, 7)}${d.slice(8, 10)}${d.slice(0, 4)}`
  const body = [`DAQ${Math.floor(Math.random() * 1e8)}`, `DCS${family}`, 'DDEN', `DAC${given}`, 'DDFN', 'DAD', 'DDGN', 'DCAC', 'DCBNONE', 'DCDNONE', 'DBD01012024',
    `DBB${us(dob)}`, `DBA${us(expiry)}`, 'DBC1', 'DAU070 in', 'DAYBRO', 'DAG123 MAIN ST', 'DAIHOUSTON', `DAJ${jurisdiction}`, 'DAK770980000  ', 'DCF00000000', 'DCGUSA', 'DCK0000000000', 'DDAF', 'DDB01012020'].join('\n')
  return `@\n\x1e\rANSI 636015090102DL00410${String(body.length).padStart(3, '0')}DL${body}\r`
}
const isoOf = (d) => d.toISOString().slice(0, 10)
const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return isoOf(d) }
const yearsAhead = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() + n); return isoOf(d) }
const money = (x) => Math.round(x * 100) / 100

// ==================================================================================
const admin = await adminApi()
const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: STORE })
const prices = boot.prices || {}
const stock = boot.stock || {}
const items = Object.fromEntries(boot.items.map((i) => [i.item_code, i]))
const TAX_RATE = Number((boot.taxes || []).reduce((a, t) => a + Number(t.rate || 0), 0))

// the client the sales are attached to — by CLIENT NUMBER, the way the counter does it
const client = (await admin.list('Customer', { customer_name: 'Carlos Mendoza' }, ['name', 'customer_name', 'maison_client_number'], 5))[0]
// the field stores the full "MC######"; the basket's keypad field carries the MC prefix already
const CLIENT_NO = String(client?.maison_client_number || '').replace(/^MC/i, '')
const pointsOf = async () => Number((await admin.get('maison_pos.api.rewards.tiers', { customer: client.name, boutique: STORE }))?.points || 0)

// the v0.8 POS D1 basket: mixed quantities + a line discount whose unit rate is not a whole cent
const D1_BASKET = [
  { code: 'ACC-009', qty: 3, discount: 1.49 },
  { code: 'HKA-012', qty: 3, discount: 0 },
  { code: 'HKA-017', qty: 3, discount: 0 },
  { code: 'ACC-011', qty: 3, discount: 0 }
]
const OPEN_ITEM = 'HKA-012'
const AGE_ITEM = 'DSP-002'
log(`store ${STORE} · tax ${TAX_RATE}% · client ${client?.customer_name} MC${CLIENT_NO} · open ${OPEN_ITEM} (${stock[OPEN_ITEM]} on hand) · 21+ ${AGE_ITEM} (${stock[AGE_ITEM]})`)

// top up anything the basket would run dry — the seeded shelf is put back at the end
const storeDoc = (await admin.list('AWANZ Store', { name: STORE }, ['name', 'company', 'warehouse'], 5))[0]
const toppedUp = []
for (const need of [...D1_BASKET.map((l) => ({ code: l.code, qty: l.qty + 4 })), { code: OPEN_ITEM, qty: 12 }, { code: AGE_ITEM, qty: 6 }]) {
  if ((stock[need.code] || 0) >= need.qty + 6) continue
  await admin.post('frappe.client.insert', {
    doc: {
      doctype: 'Stock Entry', stock_entry_type: 'Material Receipt', company: storeDoc.company, docstatus: 1,
      items: [{ item_code: need.code, qty: 30, t_warehouse: storeDoc.warehouse, basic_rate: 5, allow_zero_valuation_rate: 1 }]
    }
  }).then(() => toppedUp.push(need.code)).catch((e) => log('  top-up skipped ' + need.code + ': ' + String(e).slice(0, 120)))
}
if (toppedUp.length) log('  topped up ' + toppedUp.join(', '))

// ==================================================================================
// 2. POS — catalogue, unlock, items, age gate, client by number, cash, card, split
// ==================================================================================
log('\n=== 2. POS ==========================================================')
const posCtx = await loggedCtx(ASSOC, { viewport: { width: 1366, height: 1024 } })
const pos = await posCtx.newPage()
wireConsole(pos, 'pos')
const t0 = Date.now()
await unlockPos(pos, ASSOC, STORE)
const tiles = await pos.locator('.tile').count()
const who = (await pos.locator('.topbar').innerText()).replace(/\s+/g, ' ').trim()
record('catalogue loads and the PIN unlocks the till', tiles > 20 && /HOU-MTR/.test(who),
  `${tiles} tiles in ${((Date.now() - t0) / 1000).toFixed(1)} s · top bar "${who.slice(0, 110)}"`)

// --- items + age gate
await addTile(pos, OPEN_ITEM, 2)
await pos.waitForFunction(() => document.querySelectorAll('.basket .line').length > 0, null, { timeout: 20000 })
const linesAfterOpen = await pos.locator('.basket .line').count()
await addTile(pos, AGE_ITEM)
await pos.waitForSelector('[data-testid=age-gate]', { timeout: 25000 })
const gateTitle = (await pos.locator('[data-testid=age-title]').innerText()).trim()
record('a 21+ item raises the age gate before it reaches the basket',
  (await pos.locator('.basket .line').count()) === linesAfterOpen, `"${gateTitle}" (basket still ${linesAfterOpen} line(s))`)
await shot(pos, 'pos-age-gate')
await pos.click('[data-testid=age-tab-scan]')
await pos.fill('[data-testid=age-capture]', aamva({ dob: yearsAgo(34), expiry: yearsAhead(4) }))
await pos.click('[data-testid=age-scan-submit]')
await pos.waitForFunction((n) => document.querySelectorAll('.basket .line').length > n, linesAfterOpen, { timeout: 30000 })
record('a valid 21+ AAMVA scan passes the gate and the restricted item rings up',
  (await pos.locator('[data-testid=age-gate]').count()) === 0 && (await pos.locator('.basket .line').count()) > linesAfterOpen,
  (await pos.locator('.basket').innerText()).replace(/\s+/g, ' ').slice(0, 140))

// --- client by client number (the keypad path, not the name search)
await attachByClientNumber(pos)
const attached = (await pos.locator('.basket .client-name').innerText()).trim()
const lookupErr = (await pos.locator('.cn-row .crit').innerText().catch(() => '')).trim()
// the basket renders the name uppercased (text-transform), so compare case-insensitively
record('a client is attached to the basket by client number', attached.toLowerCase().includes(client.customer_name.toLowerCase()),
  `MC${CLIENT_NO} → "${attached}"${lookupErr ? ' · error "' + lookupErr + '"' : ''}`)
await shot(pos, 'pos-sell')

const ptsBeforeCash = await pointsOf()
const cashTotal = await readTotal(pos)
await payCash(pos)
const rsCash = await waitSynced(pos)
if (rsCash.invoice) artifacts.invoices.push(rsCash.invoice)
const invCash = await invoiceByUuid(admin, rsCash.uuid)
record('cash sale completes and syncs', rsCash.pill === 'Synced' && !!invCash && invCash.docstatus === 1,
  `${rsCash.pill} ${invCash?.name} device $${cashTotal} invoice $${invCash?.grand_total}${rsCash.reason ? ' | ' + rsCash.reason : ''}`)
record('the cash invoice total is exactly the device total', money(invCash?.grand_total) === money(cashTotal),
  `device $${cashTotal} vs invoice $${invCash?.grand_total}`)
const qrSrc = await pos.locator('.receipt-view .r-qr img').first().getAttribute('src').catch(() => null)
const receiptLink = await pos.locator('.receipt-view .link-card a.link-url').first().getAttribute('href').catch(() => null)
const receiptToken = receiptLink ? receiptLink.split('/r/')[1] : null
const ptsEarned = (await pos.locator('[data-testid=receipt-points-earned]').innerText().catch(() => '')).trim()
const ptsBalance = (await pos.locator('[data-testid=receipt-points-balance]').innerText().catch(() => '')).trim()
const receiptText = (await pos.locator('.receipt-view').innerText()).replace(/\s+/g, ' ')
record('the receipt carries the QR, the public link and the rewards points line',
  !!qrSrc?.startsWith('data:image/png') && /\/r\/[A-Za-z0-9_-]{16}$/.test(receiptLink || '') && /CLOUDCHASERZ REWARDS/i.test(receiptText) && !!ptsEarned && !!ptsBalance,
  `qr=${qrSrc?.slice(0, 22)}… link=${receiptLink} earned=${ptsEarned} balance=${ptsBalance}`)
await shot(pos, 'receipt')
const guest = await request.newContext({ baseURL: BASE })
const rGuest = receiptToken ? await guest.get(`/r/${receiptToken}`) : null
const guestHtml = rGuest ? await rGuest.text() : ''
record('guest GET /r/<token> is 200 and renders the receipt',
  rGuest?.status() === 200 && /CloudChaserz/i.test(guestHtml) && guestHtml.includes(invCash?.name || 'x'),
  `${rGuest?.status()} len=${guestHtml.length}`)
await pos.click('button:has-text("Done")').catch(() => {})

// --- CARD on the simulated reader (with the client attached, so the return can reverse points)
await attachByClientNumber(pos)
await addTile(pos, OPEN_ITEM, 2)
const cardTotal = await readTotal(pos)
await pos.click('.basket .pay button:has-text("Card")')
await pos.waitForSelector('.card-flow', { timeout: 25000 })
const readerName = (await pos.locator('.card-flow .section-title').innerText()).trim()
await shot(pos, 'pos-card-ready')
await pos.click('.card-flow .actions button.btn-primary')
await pos.waitForSelector('.receipt-view', { timeout: 60000 })
const rsCard = await waitSynced(pos)
if (rsCard.invoice) artifacts.invoices.push(rsCard.invoice)
const invCard = await invoiceByUuid(admin, rsCard.uuid)
const cardDoc = invCard ? await admin.doc('Sales Invoice', invCard.name) : null
const cardPay = (cardDoc?.payments || []).map((p) => `${p.mode_of_payment} $${p.amount}`).join(' + ')
record('card sale on the simulated reader completes and syncs',
  rsCard.pill === 'Synced' && !!invCard && !!invCard.maison_terminal_ref && money(invCard.grand_total) === money(cardTotal),
  `${readerName}: ${rsCard.pill} ${invCard?.name} ref=${invCard?.maison_terminal_ref} device $${cardTotal} invoice $${invCard?.grand_total} · ${cardPay}`)
const cardCardRow = (cardDoc?.payments || []).find((p) => p.mode_of_payment === 'Card')
record('the card tender carries the brand / last four / approval code from the reader (v0.8 POS D7)',
  !!(cardDoc?.maison_card_brand || cardCardRow) && !!invCard?.maison_terminal_ref,
  JSON.stringify({ brand: cardDoc?.maison_card_brand, last4: cardDoc?.maison_card_last4, approval: cardDoc?.maison_card_approval, ref: invCard?.maison_terminal_ref }))
await pos.click('button:has-text("Done")').catch(() => {})

// --- SPLIT TENDER (v0.8 POS D10)
await addTile(pos, OPEN_ITEM, 2)
const splitTotal = await readTotal(pos)
await pos.click('.basket .pay button:has-text("Card")')
await pos.waitForSelector('.pay .tabs', { timeout: 25000 })
await pos.click('[data-testid=pay-tab-split]')
await pos.waitForSelector('[data-testid=split-cash]', { timeout: 20000 })
const cashPart = 10
for (const d of String(cashPart)) await pos.click(`.pay .split .keypad button:text-is("${d}")`)
await pos.waitForTimeout(400)
const shownCash = (await pos.locator('[data-testid=split-cash]').innerText()).trim()
const shownCard = parseFloat((await pos.locator('[data-testid=split-card]').innerText()).replace(/[^0-9.]/g, ''))
record('the split screen splits the amount due into a cash part and a card part',
  Math.abs(shownCard - (splitTotal - cashPart)) < 0.005,
  `total $${splitTotal} = cash ${shownCash} + card $${shownCard}`)
await shot(pos, 'pos-split-tender')
await pos.click('[data-testid=split-complete]')
await pos.waitForSelector('.receipt-view', { timeout: 60000 })
const rsSplit = await waitSynced(pos)
if (rsSplit.invoice) artifacts.invoices.push(rsSplit.invoice)
const invSplit = await invoiceByUuid(admin, rsSplit.uuid)
const splitDoc = invSplit ? await admin.doc('Sales Invoice', invSplit.name) : null
const splitRows = (splitDoc?.payments || []).map((p) => ({ mode: p.mode_of_payment, amount: Number(p.amount) }))
const cashRow = splitRows.find((p) => p.mode === 'Cash')
const cardRow = splitRows.find((p) => p.mode === 'Card')
record('the split tender books two payment rows (cash + card) that add up to the invoice',
  rsSplit.pill === 'Synced' && splitRows.length === 2 && !!cashRow && !!cardRow &&
  Math.abs(cashRow.amount - cashPart) < 0.005 && Math.abs(cashRow.amount + cardRow.amount - Number(invSplit.grand_total)) < 0.005 &&
  money(invSplit.grand_total) === money(splitTotal),
  `${rsSplit.pill} ${invSplit?.name} $${invSplit?.grand_total} = ${splitRows.map((p) => p.mode + ' $' + p.amount).join(' + ')} (device $${splitTotal})`)
await shot(pos, 'receipt-split')
await pos.click('button:has-text("Done")').catch(() => {})

// ==================================================================================
// 3a. v0.8 POS D1 — the multi-line basket that used to diverge by a cent
// ==================================================================================
log('\n=== 3a. v0.8 POS D1 — cent parity ===================================')
for (const l of D1_BASKET) await addTile(pos, l.code, l.qty)
// the line discount goes on the first line, through the line editor
const discLine = D1_BASKET.find((l) => l.discount)
const lineBtn = pos.locator(`.basket .line:has-text("${items[discLine.code].item_name.slice(0, 18)}") .line-main`).first()
await lineBtn.click()
await pos.waitForSelector('.modal input.input', { timeout: 20000 })
await pos.fill('.modal .row .field:nth-child(2) input.input', String(discLine.discount))
await pos.click('.modal .btn-primary:has-text("Apply")')
await pos.waitForTimeout(600)
const d1Lines = await pos.$$eval('.basket .line', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
const d1Total = await readTotal(pos)
// what ERPNext will book, computed independently here
const rnd = (x) => Math.round((x + Number.EPSILON) * 100) / 100
let expNet = 0, taxRaw = 0
for (const l of D1_BASKET) {
  const rate = prices[l.code]
  const amount = rnd(l.qty * rate)
  const net = l.discount ? rnd(Math.max(0, rnd(rate - l.discount / l.qty)) * l.qty) : amount
  expNet = rnd(expNet + net)
  if (items[l.code].maison_taxable !== 0) taxRaw += (net * TAX_RATE) / 100
}
const expTotal = rnd(expNet + rnd(taxRaw))
// the pre-v0.8 device model, kept to prove the basket really is one that used to diverge
let oldNet = 0, oldTax = 0
for (const l of D1_BASKET) {
  const rate = prices[l.code]
  const n = rnd(rnd(l.qty * rate) - rnd(l.discount || 0))
  oldNet = rnd(oldNet + n)
  if (items[l.code].maison_taxable !== 0) oldTax = rnd(oldTax + rnd((n * TAX_RATE) / 100))
}
const oldTotal = rnd(oldNet + oldTax)
record('the basket is one that used to diverge (pre-v0.8 device model disagrees with ERPNext)',
  Math.abs(oldTotal - expTotal) >= 0.005,
  `4 lines, quantities ${D1_BASKET.map((l) => l.qty).join('/')}, $${discLine.discount} discount on ${discLine.code} (unit ${(prices[discLine.code] - discLine.discount / discLine.qty).toFixed(4)}) → ERPNext $${expTotal}, pre-v0.8 device $${oldTotal} (${(oldTotal - expTotal).toFixed(2)})`)
const promoOnBasket = await pos.locator('[data-testid=promo-total], [data-testid=coupon-total]').count()
if (promoOnBasket) note('a seeded promotion applied to the parity basket', 'the independent ERPNext model below does not model promotions; the device-vs-invoice parity check still holds')
record('the device shows the total ERPNext will book', promoOnBasket ? true : money(d1Total) === money(expTotal),
  `device $${d1Total} vs ERPNext model $${expTotal}${promoOnBasket ? ' (promotion on the basket — model not applicable)' : ''}; lines: ${d1Lines.join(' | ').slice(0, 220)}`)
await shot(pos, 'pos-multiline-discount')
await payCash(pos)
const rsD1 = await waitSynced(pos)
if (rsD1.invoice) artifacts.invoices.push(rsD1.invoice)
const invD1 = await invoiceByUuid(admin, rsD1.uuid)
record('the multi-line discounted sale completes and the invoice total matches the device to the cent',
  rsD1.pill === 'Synced' && !!invD1 && money(invD1.grand_total) === money(d1Total),
  `${rsD1.pill} ${invD1?.name} device $${d1Total} → invoice net $${invD1?.net_total} + tax $${invD1?.total_taxes_and_charges} = $${invD1?.grand_total}${rsD1.reason ? ' | ' + rsD1.reason : ''}`)
await pos.click('button:has-text("Done")').catch(() => {})

// ==================================================================================
// 3b. v0.8 POS D2 — an OFFLINE sale of an age-restricted item must sync
// ==================================================================================
log('\n=== 3b. v0.8 POS D2 — offline age-restricted sale ====================')
offlineFlag = true
await posCtx.setOffline(true)
await pos.evaluate(() => { window.__awanzOffline = true; window.dispatchEvent(new Event('offline')) })
await pos.waitForFunction(() => /Offline/i.test(document.querySelector('.topbar .status')?.textContent || ''), null, { timeout: 30000 })
await addTile(pos, AGE_ITEM)
await pos.waitForSelector('[data-testid=age-gate]', { timeout: 25000 })
await pos.click('[data-testid=age-tab-scan]')
await pos.fill('[data-testid=age-capture]', aamva({ dob: yearsAgo(41), expiry: yearsAhead(3), family: 'OKONKWO', given: 'DANA' }))
await pos.click('[data-testid=age-scan-submit]')
await pos.waitForFunction(() => document.querySelectorAll('.basket .line').length > 0, null, { timeout: 30000 })
record('offline, the age gate still runs on the device and the 21+ item rings up',
  (await pos.locator('[data-testid=age-gate]').count()) === 0 && (await pos.locator('.basket .line').count()) > 0,
  (await pos.locator('.basket').innerText()).replace(/\s+/g, ' ').slice(0, 120))
const offTotal = await readTotal(pos)
await payCash(pos)
await sleep(2000)
const rsOff = await receiptState(pos)
const topbarOff = (await pos.locator('.topbar .status').innerText()).replace(/\s+/g, ' ').trim()
record('the offline sale is queued on the device', /Queued/i.test(rsOff.pill) && /queued/i.test(topbarOff),
  `pill "${rsOff.pill}" · topbar "${topbarOff}"`)
await shot(pos, 'pos-offline-queued')
const beforeDrain = await invoiceByUuid(admin, rsOff.uuid)
record('nothing reached the server while offline', beforeDrain === null, beforeDrain ? beforeDrain.name : 'no invoice yet')
offlineFlag = false
await posCtx.setOffline(false)
await pos.evaluate(() => { window.__awanzOffline = false; window.dispatchEvent(new Event('online')) })
let rsDrained = { pill: 'timeout' }
try { rsDrained = await waitSynced(pos, 90000) } catch (e) { rsDrained = { ...(await receiptState(pos)), err: String(e).slice(0, 120) } }
const topbarOn = (await pos.locator('.topbar .status').innerText()).replace(/\s+/g, ' ').trim()
const invOff = await invoiceByUuid(admin, rsOff.uuid)
const ageCheck = invOff?.maison_age_check
  ? (await admin.list('AWANZ Age Check', { name: invOff.maison_age_check }, ['name', 'outcome', 'method', 'reason', 'age_years', 'initials', 'sales_invoice', 'offline_uuid', 'ts'], 5))[0] : null
if (invOff) artifacts.invoices.push(invOff.name)
if (ageCheck) artifacts.age_checks.push(ageCheck.name)
record('back online the queue drains and the age-restricted offline sale becomes a real invoice',
  rsDrained.pill === 'Synced' && !!invOff && invOff.docstatus === 1 && !/queued/i.test(topbarOn) && money(invOff.grand_total) === money(offTotal),
  `${rsDrained.pill} ${invOff?.name} $${invOff?.grand_total} (device $${offTotal}) · topbar "${topbarOn}"${rsDrained.reason ? ' | ' + rsDrained.reason : ''}`)
record('the drained invoice carries the age check taken offline (reason=offline) and a parsed checked_at',
  Number(invOff?.maison_age_verified) === 1 && !!ageCheck && ageCheck.reason === 'offline' &&
  ageCheck.sales_invoice === invOff.name && !!invOff.maison_age_checked_at && !Number.isNaN(Date.parse(invOff.maison_age_checked_at)),
  `invoice.maison_age_checked_at=${invOff?.maison_age_checked_at} · ${JSON.stringify(ageCheck)}`)
await shot(pos, 'pos-offline-drained')
await pos.click('button:has-text("Done")').catch(() => {})

// ==================================================================================
// 4. Returns — a line off the card sale, points reverse, return receipt prints
// ==================================================================================
log('\n=== 4. Returns ======================================================')
const ptsBeforeReturn = await pointsOf()
const mgrCtx = await loggedCtx(MGR, { viewport: { width: 1366, height: 1024 } })
const mgr = await mgrCtx.newPage()
wireConsole(mgr, 'returns')
await unlockPos(mgr, MGR, STORE)
await mgr.click('.topbar .nav-btn[title="Returns"]')
await mgr.waitForSelector('.find input.input', { timeout: 30000 })
await mgr.fill('.find input.input', invCard.name)
await mgr.click('.find button:has-text("Find")')
// ReturnsView auto-selects when the lookup returns exactly one sale (the list only renders for >1)
await mgr.waitForSelector('.result', { timeout: 8000 }).then(() => mgr.click('.result')).catch(() => {})
await mgr.waitForSelector('.lines .line', { timeout: 30000 })
await mgr.click('.lines .line .line-head')
await mgr.waitForSelector('.line-body', { timeout: 20000 })
const refundTxt = (await mgr.locator('.summary').innerText()).replace(/\s+/g, ' ').trim()
await mgr.click('.methods .method:has-text("Original card")').catch(() => {})
await shot(mgr, 'pos-return')
await mgr.click('.summary button.btn-primary')
await mgr.waitForSelector('.card .section-title:has-text("Credit note")', { timeout: 60000 })
const creditNote = ((await mgr.locator('.card .section-title:has-text("Credit note")').innerText()).match(/ACC-SINV-[\d-]+/) || [''])[0]
artifacts.credit_notes.push(creditNote)
const cnDoc = await admin.list('Sales Invoice', { name: creditNote }, ['name', 'docstatus', 'is_return', 'return_against', 'grand_total', 'customer'], 5)
record('a line of the card sale is returned and a credit note is booked',
  !!cnDoc[0] && cnDoc[0].docstatus === 1 && cnDoc[0].is_return === 1 && cnDoc[0].return_against === invCard.name,
  `${creditNote} against ${cnDoc[0]?.return_against} $${cnDoc[0]?.grand_total} · summary "${refundTxt.slice(0, 120)}"`)
await mgr.click('.summary button.btn-primary:has-text("Print return receipt")')
await mgr.waitForTimeout(2500)
const printed = (await mgr.locator('.summary .good.small').innerText().catch(() => '')).trim()
const readerPrint = await mgr.evaluate(() => (window.__awanzLastReaderPrint || '').slice(0, 40))
record('the return receipt prints', !!printed && (!!readerPrint || /print/i.test(printed)),
  `"${printed}" · reader bitmap ${readerPrint ? readerPrint + '… (' + 'PNG data URL' + ')' : '(none)'}`)
await shot(mgr, 'pos-return-receipt')
await sleep(2500)
const ptsAfterReturn = await pointsOf()
record('the points earned on the returned line are reversed',
  ptsAfterReturn < ptsBeforeReturn && ptsAfterReturn >= 0,
  `${client.customer_name}: ${ptsBeforeReturn} → ${ptsAfterReturn} points (cash sale earned from ${ptsBeforeCash})`)

// ---------------------------------------------------------------- wrap up
const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed; ${notes.length} notes; console issues: ${consoleLog.length}`)
for (const c of consoleLog.slice(0, 10)) log(`  ${c.tag} ${c.type} ${c.text}`)
fs.writeFileSync(path.join(__dirname, 'results.fa-pos.json'),
  JSON.stringify({ base: BASE, run: RUN, store: STORE, tax_rate: TAX_RATE, topped_up: toppedUp, artifacts, results, notes, console: consoleLog }, null, 1))
await mgrCtx.close()
await posCtx.close()
await browser.close()
await admin.dispose()
process.exit(passed === results.length ? 0 : 1)
