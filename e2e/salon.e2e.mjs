// AWANZ Salon (v0.5 K) end-to-end run against the REAL bench, with TWO browser contexts:
//   POS  — the associate's iPad (/pos, logged in as chi.oak.a1)
//   Salon — the client-facing iPad (/salon, a guest: no login, only the pairing code / session token)
//
// Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/salon.e2e.mjs
// Env:  BASE, ADMIN_PWD, ASSOC_USER/PWD, SALON_VIEWPORT=portrait|landscape (default: both, portrait for the walk)
//
// Flow (CHI-OAK):
//   Settings → "Pair a client display" (code + QR) → Salon enters the code → both paired → Salon: ambient (clock, playlist piece)
//   POS adds a piece (no client) → Salon: "Are you a client of the house?" → phone on the keypad → client attached on the POS
//   POS adds two more pieces → Salon basket mirror updates (focus piece, lines, total, points) → "Ask about this piece" → CRM note
//   POS cash pay → Salon: payment → Approved (gold pulse) → thank-you with points, receipt QR → feedback 1–5 → HQ sees it
//   → private-viewing invitation → returns to ambient
//   Sign-up from the Salon: POS starts a new sale → "Join AWANZ" → creates the Customer → attached on the POS; concierge Q&A
//   → Client Profile carries ring size / metal / styles; unpair → Salon back to pairing.
import { chromium, request } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, 'shots-salon')
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const BOUTIQUE = 'CHI-OAK'
const ASSOC = { usr: process.env.ASSOC_USER || 'chi.oak.a1@maison.example', pwd: process.env.ASSOC_PWD || 'maison123', pin: '2580' }
const ADMIN = { usr: 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const CLIENT = { name: 'Mei-Lin Chen', phone: '3125550105' }
const RUN = Date.now().toString(36).slice(-5).toUpperCase()
const NEWCOMER = { name: `Salon Newcomer ${RUN}`, phone: `+1 312 555 ${String(7000 + (Date.now() % 1000)).padStart(4, '0')}` }
const PORTRAIT = { width: 1024, height: 1366 }
const LANDSCAPE = { width: 1366, height: 1024 }

const results = []
const consoleLog = []
let shotN = 0
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(page, name) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.waitForTimeout(1200) // let the slow gold transitions settle
  await page.screenshot({ path: f, fullPage: false })
  log('  shot', path.basename(f))
  return f
}
function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) && !/fonts\.(googleapis|gstatic)|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|WebGL|socket\.io|websocket/i.test(m.text())) consoleLog.push({ tag, type: m.type(), text: m.text().slice(0, 300) })
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
    value: (doctype, name, fields) => api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    list: (doctype, filters, fields = ['name'], limit = 50) => api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit, order_by: 'creation desc' }),
    dispose: () => ctx.dispose()
  }
  return api
}

// ---- POS helpers ------------------------------------------------------------------
async function posContext(browser, user, tag, viewport = LANDSCAPE) {
  const context = await browser.newContext({ viewport, baseURL: BASE, colorScheme: 'dark' })
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
  const login = await context.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!login.ok()) throw new Error(`${user.usr} login failed ${login.status()}`)
  const page = await context.newPage()
  wireConsole(page, tag)
  return { context, page }
}
async function salonContext(browser, tag, viewport = PORTRAIT) {
  const context = await browser.newContext({ viewport, baseURL: BASE, colorScheme: 'dark', isMobile: false, hasTouch: true })
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
  const page = await context.newPage()
  wireConsole(page, tag)
  return { context, page }
}
async function freshDevice(page) {
  await page.goto('/pos/unlock')
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('awanzE2E', '1')
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
  })
}
async function unlock(page, user) {
  await page.goto('/pos')
  await page.waitForSelector('.unlock select.input', { timeout: 20000 })
  await page.selectOption('.unlock select.input >> nth=0', BOUTIQUE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 30000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => o.value))
  if (!opts.includes(user.usr)) throw new Error(`${user.usr} not in the associate list: ${opts.join(', ')}`)
  await page.selectOption('.unlock select.input >> nth=1', user.usr)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === user.usr) break
    await page.selectOption('.unlock select.input >> nth=1', user.usr)
  }
  for (const d of user.pin) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 20000 })
  await page.waitForSelector('.tile', { timeout: 20000 })
}
// full label lives on title=; the compact bar shortens the visible text
const nav = (page, label) => page.click(`.nav-btn[title="${label}"]`)
async function addItem(page, name) {
  const q = page.locator('.sell .search input')
  await q.fill(name)
  const tile = page.locator(`.tile:not(.empty):has-text("${name}")`).first()
  await tile.waitFor({ timeout: 10000 })
  const before = await page.locator('.basket .line').count()
  await tile.click()
  const modal = page.locator('.serials .serial-btn')
  if (await modal.count().then((n) => n > 0).catch(() => false)) await modal.first().click()
  await page.waitForFunction((n) => document.querySelectorAll('.basket .line').length > n, before, { timeout: 5000 })
  await q.fill('')
}
async function readTotal(page) {
  return parseFloat((await page.locator('.basket .total-amt').textContent()).replace(/[^0-9.]/g, ''))
}
async function waitView(page, view, ms = 12000) {
  await page.waitForFunction((v) => document.documentElement.dataset.salonView === v, view, { timeout: ms })
}
const salonView = (page) => page.evaluate(() => document.documentElement.dataset.salonView)
async function salonKey(page, digits) {
  for (const d of digits) await page.click(`[data-testid=salon-keypad] button:text-is("${d}")`)
}
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))

// ====================================================================================
const admin = await apiFor(ADMIN)
const assocApi = await apiFor(ASSOC)
const mei = (await admin.list('Customer', { customer_name: CLIENT.name }, ['name', 'mobile_no', 'maison_client_number']))[0]
record('demo client exists', !!mei, JSON.stringify(mei))
const feedbackBefore = (await admin.get('maison_pos.api.feedback.summary', { days: 1 })).count
const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: BOUTIQUE })
const inStock = (i) => (i.has_serial_no ? (boot.serials?.[i.item_code] || []).length > 0 : Number(boot.stock?.[i.item_code] || 0) > 0)
const WATCH = boot.items.find((i) => i.item_group === 'Timepieces' && inStock(i)) || boot.items.find((i) => i.has_serial_no && inStock(i))
const ACCESSORIES = boot.items.filter((i) => i.item_group === 'Accessories' && !i.has_serial_no && Number(boot.stock?.[i.item_code] || 0) > 3).slice(0, 3)
log(`pieces: ${WATCH?.item_name} + ${ACCESSORIES.map((a) => a.item_name).join(', ')}`)
// recognition consent from the Salon needs the boutique switch On (restored at the end)
const boutiqueRecognitionBefore = (await admin.value('AWANZ Store', BOUTIQUE, ['face_recognition_enabled']))?.face_recognition_enabled || 'Inherit'
await admin.post('frappe.client.set_value', { doctype: 'AWANZ Store', name: BOUTIQUE, fieldname: 'face_recognition_enabled', value: 'On' })
// a clean slate: no paired session for this associate's devices
for (const s of await admin.list('AWANZ Salon Session', { boutique: BOUTIQUE, status: 'Paired' }, ['name'], 20)) await admin.post('maison_pos.api.salon.unpair_pos', { session: s.name }).catch(() => null)

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] })
const pos = await posContext(browser, ASSOC, 'pos')
const salon = await salonContext(browser, 'salon', PORTRAIT)

try {
  // 1. POS: unlock + Settings → pair
  await freshDevice(pos.page)
  await unlock(pos.page, ASSOC)
  await nav(pos.page, 'Settings')
  await pos.page.waitForSelector('[data-testid=salon-settings]')
  record('Settings has a "Client display" card (not paired)', (await pos.page.locator('[data-testid=salon-status]').textContent()).includes('Not paired'))
  await pos.page.click('[data-testid=salon-pair]')
  await pos.page.waitForSelector('[data-testid=salon-pair-code]', { timeout: 10000 })
  const code = (await pos.page.locator('[data-testid=salon-pair-code]').textContent()).replace(/\D/g, '')
  const qrShown = await pos.page.locator('[data-testid=salon-pair-qr]').count()
  const ttl = (await pos.page.locator('[data-testid=salon-pair-ttl]').textContent()).trim()
  record('pairing code (6 digits) + QR + 10 min countdown on the POS', /^\d{6}$/.test(code) && qrShown === 1 && /^(9|10):\d\d$/.test(ttl), `${code} · ${ttl}`)
  await shot(pos.page, 'pos-settings-pairing-code')

  // 2. Salon: pairing screen → enter the code
  await salon.page.goto('/salon')
  await salon.page.evaluate(() => localStorage.clear())
  await salon.page.goto('/salon')
  await waitView(salon.page, 'pair')
  await shot(salon.page, 'salon-pair')
  await salonKey(salon.page, code)
  await waitView(salon.page, 'ambient', 15000)
  record('Salon pairs with the code → ambient screen', true)
  await pos.page.waitForFunction(() => document.querySelector('[data-testid=salon-status]')?.textContent?.includes('Paired'), null, { timeout: 15000 })
  record('POS Settings card flips to Paired (poll / realtime)', true)
  await shot(pos.page, 'pos-settings-paired')
  const session = (await assocApi.get('maison_pos.api.salon.pos_status', { boutique: BOUTIQUE, pos_device_id: await pos.page.evaluate(() => localStorage.getItem('awanz.device_id') || '') })).session
  record('server: AWANZ Salon Session Paired for this POS device', session?.status === 'Paired', session?.token?.slice(0, 8))
  await salon.page.waitForSelector('[data-testid=ambient-piece]', { timeout: 10000 })
  const clock = (await salon.page.locator('[data-testid=salon-clock]').textContent()).trim()
  record('ambient shows the hour and a playlist piece', /\d/.test(clock) && (await salon.page.locator('[data-testid=ambient-piece]').count()) === 1, clock)
  await shot(salon.page, 'salon-ambient')

  // 3. POS starts a sale with no client → Salon: identify
  await nav(pos.page, 'Sell')
  await pos.page.waitForSelector('.tile')
  await addItem(pos.page, WATCH.item_name)
  await waitView(salon.page, 'identify')
  record('first piece without a client → Salon asks "Are you a client of the house?"', true)
  await shot(salon.page, 'salon-identify-menu')
  await salon.page.click('[data-testid=identify-phone]')
  await salon.page.waitForSelector('[data-testid=identify-display]')
  await salonKey(salon.page, CLIENT.phone)
  const masked = (await salon.page.locator('[data-testid=identify-display]').textContent()).trim()
  record('keypad masks the typed number (last 4 visible)', masked.includes('0105') && masked.includes('•'), masked)
  await shot(salon.page, 'salon-identify-keypad')
  await salon.page.click('[data-testid=identify-go]')
  await waitView(salon.page, 'client')
  const firstName = (await salon.page.locator('[data-testid=client-first-name]').textContent()).trim()
  const maskedLine = (await salon.page.locator('[data-testid=client-masked]').textContent()).trim()
  record('Salon: "Welcome back, Mei-Lin" with masked contact', firstName === 'Mei-Lin' && !maskedLine.includes('3125550105') && /•••• 0105/.test(maskedLine), maskedLine)
  await shot(salon.page, 'salon-client-welcome')
  await pos.page.waitForFunction((n) => document.querySelector('.basket .client-name')?.textContent?.includes(n), CLIENT.name, { timeout: 15000 })
  record('POS basket shows the client attached from the Salon', true)
  await dismissNotices(pos.page)
  await shot(pos.page, 'pos-client-attached')

  // 4. basket mirror updates as pieces are added
  await waitView(salon.page, 'basket', 15000)
  await addItem(pos.page, ACCESSORIES[0].item_name)
  await salon.page.waitForFunction(() => document.querySelectorAll('[data-testid=basket-lines] li').length >= 2, null, { timeout: 10000 })
  await addItem(pos.page, ACCESSORIES[1].item_name)
  await salon.page.waitForFunction(() => document.querySelectorAll('[data-testid=basket-lines] li').length >= 3, null, { timeout: 10000 })
  const focusName = (await salon.page.locator('[data-testid=basket-focus-name]').textContent()).trim()
  const posTotal = await readTotal(pos.page)
  await salon.page.waitForFunction((t) => Math.abs(parseFloat((document.querySelector('[data-testid=basket-total]')?.textContent || '0').replace(/[^0-9.]/g, '')) - t) < 0.01, posTotal, { timeout: 10000 })
  const salonTotal = parseFloat((await salon.page.locator('[data-testid=basket-total]').textContent()).replace(/[^0-9.]/g, ''))
  record('basket mirror: 3 lines, newest piece large, total matches the POS', focusName.includes(ACCESSORIES[1].item_name) && Math.abs(salonTotal - posTotal) < 0.01, `${focusName} · ${salonTotal}`)
  record('basket mirror shows points to be earned', (await salon.page.locator('[data-testid=basket-points]').count()) === 1)
  await shot(salon.page, 'salon-basket')
  await salon.page.setViewportSize(LANDSCAPE)
  await shot(salon.page, 'salon-basket-landscape')
  await salon.page.setViewportSize(PORTRAIT)
  // ask about this piece → CRM note + POS notice
  await salon.page.click('[data-testid=basket-ask]')
  await salon.page.fill('[data-testid=basket-question]', `Is this one available in rose gold? (${RUN})`)
  await salon.page.click('[data-testid=basket-send]')
  await salon.page.waitForSelector('[data-testid=basket-asked]', { timeout: 8000 })
  await pos.page.waitForFunction(() => /Client asks/.test(document.body.textContent || ''), null, { timeout: 10000 })
  const note = (await admin.list('AWANZ Client Interaction', { customer: mei.name, type: 'Note' }, ['note'], 1))[0]
  record('"Ask about this piece" → CRM interaction + POS notice', !!note && note.note.includes(RUN) && note.note.includes(ACCESSORIES[1].item_name), note?.note)
  await shot(pos.page, 'pos-question-notice')
  await dismissNotices(pos.page)

  // 5. cash pay → Salon pay → approved → thank-you
  await pos.page.click('.basket .pay button:has-text("Cash")')
  await pos.page.waitForSelector('.pay .cash')
  await waitView(salon.page, 'pay')
  const payAmt = parseFloat((await salon.page.locator('[data-testid=pay-amount]').textContent()).replace(/[^0-9.]/g, ''))
  record('Salon payment screen shows the amount', Math.abs(payAmt - posTotal) < 0.01, String(payAmt))
  await shot(salon.page, 'salon-pay')
  const tendered = Math.ceil(posTotal / 100) * 100
  for (const d of String(tendered)) await pos.page.click(`.pay .keypad button:text-is("${d}")`)
  const approvedSeen = (async () => {
    try {
      await waitView(salon.page, 'approved', 12000)
      await shot(salon.page, 'salon-approved')
      return true
    } catch {
      return false
    }
  })()
  await pos.page.click('button:has-text("Complete cash sale")')
  record('Salon shows "Approved" with the gold pulse', await approvedSeen)
  await pos.page.waitForSelector('.receipt-view', { timeout: 20000 })
  await waitView(salon.page, 'thankyou', 15000)
  await pos.page.waitForFunction(() => /Synced|Rejected/.test(document.querySelector('.receipt-view .pill')?.textContent || ''), null, { timeout: 30000 })
  const uuid = pos.page.url().split('/receipt/')[1]
  let invoice = null
  for (let i = 0; i < 15 && !invoice; i++) {
    invoice = (await admin.list('Sales Invoice', { maison_offline_uuid: uuid, docstatus: 1 }, ['name', 'maison_receipt_token', 'customer', 'grand_total']))[0] || null
    if (!invoice) await sleep(1000)
  }
  record('sale submitted with the Salon-identified client', invoice?.customer === mei.name, invoice?.name)
  await salon.page.waitForSelector('[data-testid=thankyou-qr]', { timeout: 15000 })
  const pts = (await salon.page.locator('[data-testid=thankyou-points]').textContent()).trim()
  record('thank-you: name, points earned and receipt QR', /^\+\d/.test(pts) && (await salon.page.locator('[data-testid=salon-thankyou]').textContent()).includes('Mei-Lin'), pts)
  await shot(salon.page, 'salon-thankyou')
  await salon.page.setViewportSize(LANDSCAPE)
  await shot(salon.page, 'salon-thankyou-landscape')
  await salon.page.setViewportSize(PORTRAIT)

  // 6. feedback → HQ; invitation → profile flag
  await salon.page.click('[data-testid=thankyou-feedback]')
  await waitView(salon.page, 'feedback')
  await salon.page.click('[data-testid=feedback-star-5]')
  await salon.page.fill('[data-testid=feedback-comment]', `Exquisite service (${RUN})`)
  await shot(salon.page, 'salon-feedback')
  await salon.page.click('[data-testid=feedback-send]')
  await waitView(salon.page, 'invite')
  const fb = (await admin.list('AWANZ Feedback', { sales_invoice: invoice.name }, ['rating', 'comment', 'boutique', 'status']))[0]
  record('feedback reaches HQ (AWANZ Feedback, status New)', fb?.rating === 5 && fb.comment.includes(RUN) && fb.boutique === BOUTIQUE, JSON.stringify(fb))
  const summary = await admin.get('maison_pos.api.feedback.summary', { days: 1 })
  record('HQ feedback summary counts it', summary.count >= feedbackBefore + 1, `${feedbackBefore} → ${summary.count}`)
  await shot(salon.page, 'salon-invite')
  await salon.page.click('[data-testid=invite-yes]')
  await salon.page.waitForSelector('[data-testid=invite-done]', { timeout: 20000 })
  const inviteFlag = await admin.value('AWANZ Client Profile', mei.name, ['private_viewing_invite'])
  record('private-viewing invitation sets the Client Profile flag', inviteFlag?.private_viewing_invite === 1, JSON.stringify(inviteFlag))
  await salon.page.click('[data-testid=invite-done]')
  await waitView(salon.page, 'ambient')
  record('Salon returns to ambient after the thank-you flow', true)
  await pos.page.click('.receipt-view button:has-text("Done"), button:has-text("New sale")').catch(() => pos.page.goto('/pos/sell'))
  await pos.page.waitForSelector('.tile', { timeout: 15000 })

  // 7. sign-up from the Salon attaches a NEW client on the POS
  await addItem(pos.page, ACCESSORIES[2].item_name)
  await waitView(salon.page, 'identify')
  await salon.page.click('[data-testid=identify-join]')
  await waitView(salon.page, 'signup')
  await salon.page.fill('[data-testid=signup-name]', NEWCOMER.name)
  await salon.page.fill('[data-testid=signup-phone]', NEWCOMER.phone)
  await salon.page.fill('[data-testid=signup-birthday]', '1990-05-04')
  await shot(salon.page, 'salon-signup')
  await salon.page.click('[data-testid=signup-submit]')
  await pos.page.waitForFunction((n) => document.querySelector('.basket .client-name')?.textContent?.includes(n), NEWCOMER.name, { timeout: 20000 })
  const created = (await admin.list('Customer', { customer_name: NEWCOMER.name }, ['name', 'mobile_no', 'maison_client_number']))[0]
  record('sign-up creates the Customer (client № assigned) and attaches it on the POS', !!created?.maison_client_number && created.mobile_no === NEWCOMER.phone, JSON.stringify(created))
  const prof = await admin.value('AWANZ Client Profile', created.name, ['do_not_email', 'do_not_sms', 'birthday'])
  record('sign-up stores marketing preferences + birthday on the Client Profile', prof?.do_not_email === 0 && prof?.do_not_sms === 1 && String(prof.birthday) === '1990-05-04', JSON.stringify(prof))
  await salon.page.waitForFunction(() => document.documentElement.dataset.salonView === 'signup' && !!document.querySelector('[data-testid=signup-offer-recognition]'), null, { timeout: 10000 })
  record('Salon offers the optional recognition consent after joining (boutique On)', true)
  await shot(salon.page, 'salon-signup-recognition-offer')
  await salon.page.click('[data-testid=signup-offer-recognition]')
  await salon.page.waitForSelector('[data-testid=consent-screen]', { timeout: 8000 })
  await shot(salon.page, 'salon-consent')
  // hold-to-agree: a 200 ms tap is rejected, a 700 ms hold agrees (v0.3 rule, reused on the Salon)
  const agree = await salon.page.locator('[data-testid=consent-agree]').boundingBox()
  await salon.page.mouse.move(agree.x + agree.width / 2, agree.y + agree.height / 2)
  await salon.page.mouse.down()
  await sleep(200)
  await salon.page.mouse.up()
  await sleep(400)
  const stillConsent = (await salon.page.locator('[data-testid=consent-screen]').count()) === 1 && (await salonView(salon.page)) === 'signup'
  await salon.page.mouse.down()
  await sleep(800)
  await salon.page.mouse.up()
  await waitView(salon.page, 'consent', 15000)
  record('hold-to-agree on the Salon (short press rejected) hands the consent to the POS', stillConsent)
  const inbox = (await assocApi.get('maison_pos.api.salon.pos_poll', { session: session.token, since: 0 })).messages
  const agreed = inbox.find((m) => m.type === 'consent_agreed' && m.customer === created.name)
  record('server: consent_agreed message carries the method + version, no biometrics stored by the Salon', !!agreed && agreed.consent.method === 'Hold-to-agree' && (await admin.value('Customer', created.name, ['maison_face_consent']))?.maison_face_consent === 0, JSON.stringify(agreed?.consent))
  // this POS has no camera: the Salon explains the enrolment will be finished at the counter
  await salon.page.waitForFunction(() => /finish this at the counter|will recognise you/.test(document.body.textContent || ''), null, { timeout: 40000 })
  record('POS without a camera → Salon: "We will finish this at the counter"', true)
  await shot(salon.page, 'salon-consent-handoff')
  await waitView(salon.page, 'basket', 15000)
  await dismissNotices(pos.page)
  await shot(pos.page, 'pos-newcomer-attached')

  // 8. concierge mode → Client Profile
  await pos.page.click('[data-testid=salon-concierge]')
  await waitView(salon.page, 'concierge', 12000)
  await shot(salon.page, 'salon-concierge-ring')
  await salon.page.click('[data-testid=ring-sizer] button[aria-label=Larger]')
  await salon.page.click('[data-testid=concierge-next]')
  await salon.page.click('.s-chip:has-text("16 cm")')
  await salon.page.click('[data-testid=concierge-next]')
  await salon.page.click('[data-testid=metal-rose-gold]')
  await shot(salon.page, 'salon-concierge-metal')
  await salon.page.click('[data-testid=concierge-next]')
  await salon.page.click('[data-testid=style-minimal]')
  await salon.page.click('[data-testid=style-heritage]')
  await shot(salon.page, 'salon-concierge-style')
  await salon.page.click('[data-testid=concierge-next]')
  await salon.page.click('[data-testid=occasion-anniversary]')
  await salon.page.fill('[data-testid=occasion-date]', '2020-09-12')
  await salon.page.click('[data-testid=concierge-finish]')
  await salon.page.waitForSelector('[data-testid=concierge-saved]', { timeout: 10000 })
  const prefs = await admin.value('AWANZ Client Profile', created.name, ['ring_size', 'wrist_size', 'metal_preference', 'style_notes', 'anniversary'])
  record('concierge answers land in the Client Profile', prefs?.ring_size === '7' && prefs.wrist_size === '16 cm' && prefs.metal_preference === 'Rose Gold' && /Minimal, Heritage/.test(prefs.style_notes) && String(prefs.anniversary) === '2020-09-12', JSON.stringify(prefs))
  await shot(salon.page, 'salon-concierge-done')
  await pos.page.click('[data-testid=salon-concierge]') // end concierge
  await waitView(salon.page, 'basket', 12000)

  // 9. unpair from the POS → Salon back to pairing
  await pos.page.locator('.basket .line .qty-btn.rm').first().click().catch(() => null)
  await nav(pos.page, 'Settings')
  await pos.page.waitForSelector('[data-testid=salon-unpair]')
  await pos.page.click('[data-testid=salon-unpair]')
  await waitView(salon.page, 'pair', 15000)
  record('unpair from the POS → Salon returns to the pairing screen', true)
  const ended = await admin.value('AWANZ Salon Session', session.token, ['status'])
  record('server session Unpaired', ended?.status === 'Unpaired', JSON.stringify(ended))
  // guest cannot list sessions
  const guest = await request.newContext({ baseURL: BASE })
  const listed = await (await guest.get('/api/resource/AWANZ Salon Session')).json()
  record('guest cannot list salon sessions', Array.isArray(listed.data) && listed.data.length === 0, JSON.stringify(listed).slice(0, 80))
  await guest.dispose()
} catch (e) {
  record('run completed without exception', false, String(e.stack || e).slice(0, 600))
  await shot(pos.page, 'pos-failure').catch(() => null)
  await shot(salon.page, 'salon-failure').catch(() => null)
} finally {
  await admin.post('frappe.client.set_value', { doctype: 'AWANZ Store', name: BOUTIQUE, fieldname: 'face_recognition_enabled', value: boutiqueRecognitionBefore }).catch(() => null)
  // clean up the test client
  if (NEWCOMER.name) {
    const created = (await admin.list('Customer', { customer_name: NEWCOMER.name }, ['name']).catch(() => []))[0]
    if (created) {
      for (const dt of ['AWANZ Client Interaction', 'AWANZ Recognition Event']) for (const r of await admin.list(dt, { customer: created.name }, ['name']).catch(() => [])) await admin.post('frappe.client.delete', { doctype: dt, name: r.name }).catch(() => null)
      await admin.post('frappe.client.delete', { doctype: 'AWANZ Client Profile', name: created.name }).catch(() => null)
      await admin.post('frappe.client.delete', { doctype: 'Customer', name: created.name }).catch(() => null)
    }
  }
  await browser.close()
  await admin.dispose()
  await assocApi.dispose()
}

const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed`)
if (consoleLog.length) {
  log(`console (${consoleLog.length}):`)
  for (const c of consoleLog.slice(0, 12)) log(`  [${c.tag}] ${c.type}: ${c.text}`)
}
fs.writeFileSync(path.join(__dirname, 'results.salon.json'), JSON.stringify({ base: BASE, run: RUN, passed, total: results.length, results, console: consoleLog }, null, 2))
process.exit(passed === results.length ? 0 : 1)
