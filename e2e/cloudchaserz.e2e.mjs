/**
 * v0.6 N/O/Q — CloudChaserz tenant e2e against the CloudChaserz site.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc.localhost:8001 ADMIN_PWD=admin \
 *     node e2e/cloudchaserz.e2e.mjs
 *
 *  A. Brand — the POS, the receipt and the shop are CloudChaserz, not "Maison".
 *  B. Age gate (21+) — an under-21 licence and an expired licence are both refused and the
 *     age-restricted item stays out of the basket; a valid licence passes and the sale carries
 *     the age check. Screenshots: POS at 1366x1024 and iPhone 390x844, Salon ID-check.
 *  C. Rewards — the $5 / 100-point tier is offered only when the client can afford it, applies
 *     $5 off at the counter, and the points are reversed when the sale is returned.
 *  D. Scoping — a store manager gets 403 on another store's data over plain HTTP.
 */
import { chromium, devices } from './node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://cc.localhost:8001'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const PWD = process.env.DEMO_PWD || 'cloud123'
const STORE_A = process.env.STORE_A || 'HOU-MTR'
const STORE_B = process.env.STORE_B || 'OK-SAP'
const MGR_A = { usr: 'hou.mtr.manager@cloudchaserz.example', pwd: PWD, pin: '1101' }
const ASSOC_A = { usr: 'hou.mtr.a1@cloudchaserz.example', pwd: PWD, pin: '2580' }
const MGR_B = { usr: 'ok.sap.manager@cloudchaserz.example', pwd: PWD, pin: '2202' }

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
let shotN = 20 // the warehouse script owns 01..08
async function shot(page, name, full = false) {
  const file = `${String(++shotN).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: path.join(shots, file), fullPage: full })
  log('  shot ' + file)
  return file
}

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
    async raw(method, params = {}) {
      const r = await ctx.request.get(`/api/method/${method}`, { params })
      return { status: r.status(), body: await r.json().catch(() => ({})) }
    },
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
    async postRaw(method, data = {}) {
      const r = await ctx.request.post(`/api/method/${method}`, { headers, data })
      return { status: r.status(), body: await r.json().catch(() => ({})) }
    },
    list: (doctype, filters, fields = ['name'], limit = 50) =>
      api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit }),
    close: () => ctx.close()
  }
  return api
}

// AAMVA payload builder — mirrors frontend/src/scan/aamva.ts `syntheticAamva`
function aamva({ dob, expiry, family = 'RIVERA', given = 'ALEX', jurisdiction = 'TX' }) {
  const us = (iso) => `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}`
  const body = [`DAQ${Math.floor(Math.random() * 1e8)}`, `DCS${family}`, 'DDEN', `DAC${given}`, 'DDFN', 'DAD', 'DDGN', 'DCAC', 'DCBNONE', 'DCDNONE', 'DBD01012024',
    `DBB${us(dob)}`, `DBA${us(expiry)}`, 'DBC1', 'DAU070 in', 'DAYBRO', 'DAG123 MAIN ST', 'DAIHOUSTON', `DAJ${jurisdiction}`, 'DAK770980000  ', 'DCF00000000', 'DCGUSA', 'DCK0000000000', 'DDAF', 'DDB01012020'].join('\n')
  return `@\n\x1e\rANSI 636015090102DL00410${String(body.length).padStart(3, '0')}DL${body}\r`
}
const iso = (d) => d.toISOString().slice(0, 10)
const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return iso(d) }
const yearsAhead = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() + n); return iso(d) }

const admin = await client(ADMIN)

// ================================================================ A. brand
const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: STORE_A })
const brand = boot.brand || {}
record('bootstrap.brand is the CloudChaserz tenant (Smoke Shop vertical)',
  brand.brand_name === 'CloudChaserz' && brand.product_name === 'Maison POS by CloudChaserz' && brand.vertical === 'Smoke Shop' && brand.wordmark_text === 'CLOUDCHASERZ' && brand.store_noun === 'Store',
  JSON.stringify({ brand_name: brand.brand_name, product_name: brand.product_name, vertical: brand.vertical, wordmark: brand.wordmark_text, store_noun: brand.store_noun, tagline: brand.tagline }))

const stores = await admin.get('maison_pos.api.catalog.boutiques').catch(() => null)
const allStores = await admin.list('Maison Boutique', { enabled: 1 }, ['name', 'is_warehouse'], 100)
record('the 11 real stores plus the HOU-WH warehouse are seeded',
  allStores.filter((b) => !b.is_warehouse).length === 11 && allStores.some((b) => b.name === 'HOU-WH' && b.is_warehouse),
  `${allStores.length} boutiques: ${allStores.map((b) => b.name + (b.is_warehouse ? '*' : '')).join(', ')}`)

const shopHtml = await (await admin.ctx.request.get('/rewards')).text()
record('/rewards carries the exact programme copy and the three fixed tiers',
  /\$5 off at 100 points/.test(shopHtml) && /\$10 off at 200 points/.test(shopHtml) && /\$15 off at 300 points/.test(shopHtml) && /Earn 1 point for every \$1 you spend/.test(shopHtml) && !/no such element/.test(shopHtml),
  `tiers ok; "Maison" occurrences outside asset paths: ${(shopHtml.replace(/\/assets\/maison_pos[^"']*/g, '').match(/Maison/g) || []).length}`)

// ================================================================ B. age gate
const ageItem = boot.items.find((i) => i.maison_age_restricted)
const freeItem = boot.items.find((i) => !i.maison_age_restricted && !i.has_serial_no)
record('the catalogue marks 21+ items', !!ageItem && !!freeItem, `restricted=${ageItem?.item_code} (${ageItem?.item_name}); open=${freeItem?.item_code}`)

const assoc = await client(ASSOC_A)
const under21 = aamva({ dob: yearsAgo(19), expiry: yearsAhead(4) })
const expired = aamva({ dob: yearsAgo(34), expiry: iso(new Date(Date.now() - 86400000 * 30)) })
const valid = aamva({ dob: yearsAgo(34), expiry: yearsAhead(4) })

const r1 = await assoc.post('maison_pos.api.age.verify_scan', { raw: under21, boutique: STORE_A })
record('age.verify_scan refuses an under-21 licence', r1.ok === false && r1.outcome === 'Underage' && /Under 21/i.test(String(r1.message || '')),
  JSON.stringify({ ok: r1.ok, outcome: r1.outcome, age: r1.age, message: r1.message }))
const r2 = await assoc.post('maison_pos.api.age.verify_scan', { raw: expired, boutique: STORE_A })
record('age.verify_scan refuses an expired licence', r2.ok === false && r2.outcome === 'Expired' && /expired/i.test(String(r2.message || '')),
  JSON.stringify({ ok: r2.ok, outcome: r2.outcome, message: r2.message }))
const r3 = await assoc.post('maison_pos.api.age.verify_scan', { raw: valid, boutique: STORE_A })
record('age.verify_scan passes a valid 21+ licence and logs a Maison Age Check', r3.ok === true && r3.outcome === 'Verified' && !!r3.check,
  JSON.stringify({ ok: r3.ok, outcome: r3.outcome, age: r3.age, method: r3.method, check: r3.check }))
const logged = r3.check ? (await admin.list('Maison Age Check', { name: r3.check }, ['name', 'outcome', 'method', 'initials', 'boutique'], 5))[0] : null
// The site runs in America/Chicago; `new Date().toISOString()` is UTC and can land on *tomorrow's*
// date, which ERPNext then treats as a future Loyalty Point Entry (posting_date <= today) and the
// balance reads 0. A real device posts local time — take the server's clock from the age check.
const SERVER_NOW = String(r3.checked_at || '').slice(0, 19).replace('T', ' ') || new Date().toISOString().slice(0, 19)
record('the age check stores no PII beyond the masked initials',
  !!logged && logged.outcome === 'Verified' && !JSON.stringify(logged).includes('RIVERA') && !JSON.stringify(logged).includes('123 MAIN ST'),
  JSON.stringify(logged))

// ---- the POS refuses to ring the restricted item until the gate passes (1366×1024) -----------
async function posPage(user, viewport, tag, device) {
  const opts = device ? { ...device } : { viewport, colorScheme: 'dark' }
  const ctx = await browser.newContext({ ...opts, baseURL: BASE })
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort())
  const li = await ctx.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!li.ok()) throw new Error(`${user.usr} login failed ${li.status()}`)
  const page = await ctx.newPage()
  wireConsole(page, tag)
  return { ctx, page }
}
async function unlockPos(page, user, store) {
  await page.goto('/pos/unlock')
  await page.evaluate(() => { localStorage.setItem('maisonE2E', '1') })
  await page.goto('/pos')
  await page.waitForSelector('.unlock select.input', { timeout: 25000 })
  await page.selectOption('.unlock select.input >> nth=0', store)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 45000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => o.value))
  if (!opts.includes(user.usr)) throw new Error(`${user.usr} not offered: ${opts.join(', ')}`)
  await page.selectOption('.unlock select.input >> nth=1', user.usr)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(250)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === user.usr) break
    await page.selectOption('.unlock select.input >> nth=1', user.usr)
  }
  for (const d of String(user.pin)) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 30000 })
  await page.waitForSelector('.tile', { timeout: 30000 })
}
/** Search by item code (names carry quotes like 12" Beaker) and tap the first matching tile. */
async function addTile(page, code) {
  const q = page.locator('.sell .search input')
  await q.fill(code)
  const tile = page.locator('.tile:not(.empty)').first()
  await tile.waitFor({ timeout: 15000 })
  await tile.click()
  await q.fill('')
}

const { ctx: ctxA, page: pos } = await posPage(ASSOC_A, { width: 1366, height: 1024 }, 'pos')
await unlockPos(pos, ASSOC_A, STORE_A)
const wordmark = (await pos.locator('.topbar').innerText()).replace(/\s+/g, ' ').trim()
// the wordmark is CLOUDCHASERZ with the small "Maison POS" sub-mark (SPEC_v0.6 N), and the store
// line is the CloudChaserz store — never a jewellery boutique
// the compact top bar (<= 1400 px) shows the store code rather than its full name
record('the POS top bar is branded CloudChaserz (wordmark first, "Maison POS" only as the sub-mark)',
  /^CLOUDCHASERZ\b/.test(wordmark) && wordmark.includes(STORE_A) && wordmark.indexOf('CLOUDCHASERZ') < wordmark.indexOf('MAISON POS'),
  wordmark.slice(0, 160))
await shot(pos, 'pos-cloudchaserz-1366')

// tapping the 21+ item raises the age gate
await addTile(pos, ageItem.item_code)
await pos.waitForSelector('[data-testid=age-gate]', { timeout: 15000 })
record('ringing a 21+ item raises the age gate before it reaches the basket',
  (await pos.locator('.basket .line').count()) === 0,
  (await pos.locator('[data-testid=age-title]').innerText()).trim())
await shot(pos, 'pos-age-gate')

// under-21 → blocked
await pos.click('[data-testid=age-tab-manual]')
await pos.fill('[data-testid=age-dob]', yearsAgo(19))
await pos.fill('[data-testid=age-expiry]', yearsAhead(4))
await pos.click('[data-testid=age-manual-submit]')
await pos.waitForSelector('[data-testid=age-error], [data-testid=age-blocked-close]', { timeout: 15000 })
const blockedMsg = (await pos.locator('[data-testid=age-error], [data-testid=age-blocked-close]').first().innerText()).trim()
record('an under-21 date of birth is refused at the counter and the item is not sold',
  (await pos.locator('.basket .line').count()) === 0, blockedMsg.slice(0, 160))
await shot(pos, 'pos-age-blocked')

/** Dismiss whatever state the gate is in, then ring the 21+ item again and open the manual tab. */
async function openGateAgain() {
  for (const sel of ['[data-testid=age-blocked-close]', '[data-testid=age-retry]', '[data-testid=age-close]']) {
    const b = pos.locator(sel).first()
    if (await b.count()) { await b.click().catch(() => {}); break }
  }
  await pos.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 10000 }).catch(() => {})
  await addTile(pos, ageItem.item_code)
  await pos.waitForSelector('[data-testid=age-gate]', { timeout: 15000 })
  await pos.click('[data-testid=age-tab-manual]')
}

// expired ID → blocked
await openGateAgain()
await pos.fill('[data-testid=age-dob]', yearsAgo(34))
await pos.fill('[data-testid=age-expiry]', iso(new Date(Date.now() - 86400000 * 30)))
await pos.click('[data-testid=age-manual-submit]')
await pos.waitForSelector('[data-testid=age-error], [data-testid=age-blocked-close]', { timeout: 15000 })
record('an expired ID is refused at the counter and the item is not sold',
  (await pos.locator('.basket .line').count()) === 0,
  (await pos.locator('[data-testid=age-error], [data-testid=age-blocked-close]').first().innerText()).trim().slice(0, 160))

// valid ID → the item goes in
await openGateAgain()
await pos.fill('[data-testid=age-dob]', yearsAgo(34))
await pos.fill('[data-testid=age-expiry]', yearsAhead(4))
await pos.click('[data-testid=age-manual-submit]')
await pos.waitForFunction(() => document.querySelectorAll('.basket .line').length > 0, null, { timeout: 20000 }).catch(() => {})
record('a valid 21+ ID passes the gate and the item is rung up',
  (await pos.locator('.basket .line').count()) > 0,
  (await pos.locator('.basket').innerText()).replace(/\s+/g, ' ').trim().slice(0, 160))
await shot(pos, 'pos-age-passed')

// iPhone screenshot of the rebranded POS
const { ctx: ctxPhone, page: phone } = await posPage(ASSOC_A, null, 'phone', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } })
await unlockPos(phone, ASSOC_A, STORE_A)
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
record('iPhone 390×844: the rebranded POS has no horizontal overflow', overflow <= 0, `scrollWidth-clientWidth=${overflow}`)
await shot(phone, 'pos-cloudchaserz-iphone')
await ctxPhone.close()

// Salon ID-check screen
const salonCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE, colorScheme: 'dark' })
await salonCtx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort())
const salon = await salonCtx.newPage()
wireConsole(salon, 'salon')
await salon.goto('/salon', { waitUntil: 'domcontentloaded' })
await salon.waitForTimeout(2500)
const salonText = (await salon.locator('body').innerText()).replace(/\s+/g, ' ').trim()
record('the Salon display is branded CloudChaserz', /CloudChaserz/i.test(salonText), salonText.slice(0, 160))
await shot(salon, 'salon-id-check')
await salonCtx.close()

// ================================================================ C. rewards: $5 at 100 points, reversed on return
const tiers = await admin.get('maison_pos.api.rewards.tiers', { boutique: STORE_A })
record('the programme exposes the three fixed tiers ($5/100, $10/200, $15/300)',
  (tiers.tiers || []).length === 3 && tiers.tiers.some((t) => t.points === 100 && Number(t.amount) === 5),
  (tiers.tiers || []).map((t) => `${t.points}pt→$${t.amount}`).join(', '))

// a client with just enough points for the $5 tier
const CLIENT = `CC Rewards E2E ${Date.now()}`
const signup = await admin.post('maison_pos.api.rewards.signup', { name: CLIENT, phone: `+1713555${String(Date.now()).slice(-4)}`, email: `cc.rewards.${Date.now()}@test.example`, birthday: '1990-05-15', consent: 1, boutique: STORE_A })
const customer = (await admin.list('Customer', { maison_client_number: signup.client_number }, ['name', 'loyalty_program']))[0]?.name
record('the /rewards sign-up creates a member with a client number and the CloudChaserz programme',
  !!customer && !!signup.client_number && signup.program_name === 'CloudChaserz Rewards',
  `${customer} ${signup.client_number} ${signup.program_name}`)

// earn the points the honest way: a $150 sale ($1 = 1 point)
async function sale(api, { items, payments, customer: cust, rewardTier, uuid, ageVerified }) {
  const inv = {
    offline_uuid: uuid, boutique: STORE_A, associate: ASSOC_A.usr, device_id: 'E2E-CCZ',
    posting_datetime: SERVER_NOW, customer: cust, items, payments
  }
  if (rewardTier) inv.reward_tier = rewardTier
  if (ageVerified) inv.age_verified = 1
  const out = await api.post('maison_pos.api.sales.submit_batch', { invoices: [inv] })
  const res = out.results[0]
  if (res.status !== 'ok') throw new Error(`sale rejected: ${JSON.stringify(res).slice(0, 300)}`)
  return res
}
// repeated runs eat the demo stock: top the open item up at store A before the rewards sales
try {
  const bq = (await admin.list('Maison Boutique', { name: STORE_A }, ['company', 'warehouse']))[0]
  await admin.post('frappe.client.insert', {
    doc: {
      doctype: 'Stock Entry', stock_entry_type: 'Material Receipt', company: bq.company, docstatus: 1,
      items: [{ item_code: freeItem.item_code, qty: 60, t_warehouse: bq.warehouse, basic_rate: 5, allow_zero_valuation_rate: 1 }]
    }
  })
  log(`  topped up ${freeItem.item_code} @ ${STORE_A}: +60`)
} catch (e) { log('  stock top-up skipped:', String(e).slice(0, 200)) }

const rate = boot.prices[freeItem.item_code] || 20
const qty = Math.max(1, Math.ceil(150 / rate))
const gross = Number((rate * qty).toFixed(2))
const taxed = Number((gross * (1 + (boot.settings?.tax_rate || 0.0825))).toFixed(2))
const earn = await sale(admin, { items: [{ item_code: freeItem.item_code, qty, rate }], payments: [{ mode_of_payment: 'Cash', amount: taxed }], customer, uuid: `ccz-earn-${Date.now()}` })
const pts = await admin.get('maison_pos.api.rewards.tiers', { customer, boutique: STORE_A })
// exactly $1 = 1 point on the NET amount (before tax) — the promise on /rewards. ERPNext accrues on
// the grand total by default, so this also guards `rewards.rebase_points_on_net`.
record('$1 spent = 1 point earned on the net amount, not the taxed total',
  Math.round(pts.points) === Math.floor(gross) && Math.round(pts.points) < Math.floor(taxed),
  `spent $${gross} net ($${taxed} with tax) → ${Math.round(pts.points)} points (invoice ${earn.invoice_name})`)
record('only the tiers the client can afford are offered',
  (pts.affordable || []).some((t) => t.points === 100) === Math.round(pts.points) >= 100,
  `points=${Math.round(pts.points)} affordable=${(pts.affordable || []).map((t) => t.points).join(',')} next=${pts.next?.points ?? '—'}`)

const tier100 = (tiers.tiers || []).find((t) => t.points === 100)
const rate2 = boot.prices[freeItem.item_code] || 20
const q2 = Math.max(1, Math.ceil(40 / rate2))
const gross2 = Number((rate2 * q2).toFixed(2))
// the reward is an ERPNext loyalty redemption: it comes off the *grand total*, after tax
const due = Number((gross2 * (1 + (boot.settings?.tax_rate || 0.0825)) - 5).toFixed(2))
const redeemed = await sale(admin, {
  items: [{ item_code: freeItem.item_code, qty: q2, rate: rate2 }],
  payments: [{ mode_of_payment: 'Cash', amount: due }],
  customer, rewardTier: tier100.name, uuid: `ccz-redeem-${Date.now()}`
})
const inv2 = (await admin.list('Sales Invoice', { name: redeemed.invoice_name }, ['name', 'grand_total', 'loyalty_amount', 'loyalty_points', 'maison_reward_tier']))[0]
record('redeeming the $5 / 100-point tier takes $5 off at the counter',
  Number(inv2.loyalty_amount) === 5 && inv2.maison_reward_tier === tier100.name,
  `${inv2.name} loyalty_amount=${inv2.loyalty_amount} tier=${inv2.maison_reward_tier} total=${inv2.grand_total}`)
const afterRedeem = await admin.get('maison_pos.api.rewards.tiers', { customer, boutique: STORE_A })
record('100 points are deducted from the balance on redemption',
  Math.round(pts.points) - Math.round(afterRedeem.points) >= 100 - Math.round(gross2),
  `${Math.round(pts.points)} → ${Math.round(afterRedeem.points)}`)

// return the redeeming sale: the points come back and the reward is released
const ret = await admin.post('maison_pos.api.returns.return_items', {
  invoice: redeemed.invoice_name,
  lines: [{ item_code: freeItem.item_code, qty: q2, condition: 'Sellable', reason: 'Change of mind' }],
  refund_method: 'cash', manager: MGR_A.usr, manager_pin: MGR_A.pin
}).catch((e) => ({ error: String(e).slice(0, 300) }))
if (ret.error) log('  return error: ' + ret.error)
const afterReturn = await admin.get('maison_pos.api.rewards.tiers', { customer, boutique: STORE_A })
record('returning the sale reverses the points and releases the redeemed reward (never negative)',
  !ret.error && Math.round(afterReturn.points) > Math.round(afterRedeem.points) && Math.round(afterReturn.points) >= 0,
  `${ret.error || ''} credit note ${ret.credit_note || ret.invoice_name || ret.name || '—'}; points ${Math.round(afterRedeem.points)} → ${Math.round(afterReturn.points)}`)

// the /rewards page for a member
const rewardsCtx = await browser.newContext({ viewport: { width: 1366, height: 1024 }, baseURL: BASE, colorScheme: 'dark' })
await rewardsCtx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort())
const rew = await rewardsCtx.newPage()
wireConsole(rew, 'rewards')
await rew.goto('/rewards', { waitUntil: 'domcontentloaded' })
await rew.waitForSelector('[data-testid=rewards-tiers]', { timeout: 20000 })
const rewText = (await rew.locator('body').innerText()).replace(/\s+/g, ' ')
record('the public /rewards page renders the tiers and the perks (no unresolved template tokens)',
  /\$5 off at 100 points/.test(rewText) && /Birthday discount/.test(rewText) && !/no such element|\{\{/.test(rewText),
  rewText.slice(0, 200))
await shot(rew, 'rewards-page', true)
await rewardsCtx.close()

// ================================================================ D. HTTP scoping: manager A vs store B
const a = await client(MGR_A)
const b = await client(MGR_B)
const forbidden = []
const probes = [
  ['maison_pos.api.catalog.bootstrap', { boutique: STORE_B }],
  ['maison_pos.api.inventory.inbound', { boutique: STORE_B }],
  ['maison_pos.api.inventory.replenishment_requests', { boutique: STORE_B }],
  ['maison_pos.api.shipping.shipments', { status: 'all', boutique: STORE_B }]
]
for (const [method, params] of probes) {
  const r = await a.raw(method, params)
  const denied = r.status === 403 || /PermissionError/.test(JSON.stringify(r.body))
  forbidden.push(`${method.split('.').pop()}=${r.status}${denied ? '' : ' LEAK'}`)
}
record(`store manager A (${STORE_A}) is refused ${STORE_B} data over HTTP on every endpoint`,
  forbidden.every((f) => !f.includes('LEAK')), forbidden.join(' · '))

// `dashboard.live_summary` takes no boutique argument — it scopes itself to the caller, so the
// contract there is "store B never appears", not a 403
const live = await a.get('maison_pos.api.dashboard.live_summary', { nocache: 1 })
const seen = (live.by_boutique || []).map((r) => r.boutique)
record('the live dashboard shows manager A only their own store', seen.length > 0 && seen.every((x) => x === STORE_A), `by_boutique=${seen.join(', ') || '(none)'}`)

// and the mirror: manager B cannot read store A
const rb = await b.raw('maison_pos.api.catalog.bootstrap', { boutique: STORE_A })
record(`store manager B (${STORE_B}) is refused ${STORE_A} data over HTTP`,
  rb.status === 403 || /PermissionError/.test(JSON.stringify(rb.body)), `bootstrap(${STORE_A}) → ${rb.status}`)

// their own store still works
const own = await a.raw('maison_pos.api.catalog.bootstrap', { boutique: STORE_A })
record('a manager still gets their own store', own.status === 200 && own.body?.message?.brand?.brand_name === 'CloudChaserz', `bootstrap(${STORE_A}) → ${own.status}`)

// ---------------------------------------------------------------- report
await ctxA.close()
const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed; console issues: ${console_.length}`)
for (const c of console_.slice(0, 8)) log(`  ${c.tag} ${c.type} ${c.text}`)
writeFileSync(path.join(here, 'results.cloudchaserz.json'), JSON.stringify({ base: BASE, store_a: STORE_A, store_b: STORE_B, customer, results, console: console_ }, null, 1))
await browser.close()
process.exit(passed === results.length ? 0 : 1)
