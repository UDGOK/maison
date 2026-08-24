/**
 * FINAL ACCEPTANCE — launcher, branding audit and security spot-checks (areas 1, 9, 10).
 *
 *   BRIDGE=1 NODE_USE_ENV_PROXY=1 BASE=https://cloudchaserz.frappe.cloud ADMIN_SID=$(cat /tmp/ccsid) \
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node e2e/qa/fa-launch.mjs
 *
 *  1. every demo login lands on /start and the launcher lists exactly the screens that user's
 *     AWANZ roles allow (the expectation is derived from the roles the site actually holds).
 *  9. branding audit: no "Maison", "Frappe" or "ERPNext" in the RENDERED TEXT of any route,
 *     and "Powered by Futonix" on /start and in the website footer.
 * 10. security: a store manager cannot read another store's invoices, cannot set their own
 *     AWANZ Associate.role, and cannot read pin_hash.
 *
 * Read-only apart from the two write probes in area 10, which must both be refused.
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
const PWD = 'cloud123'

const USERS = [
  { key: 'hq', usr: 'hq@cloudchaserz.example' },
  { key: 'warehouse', usr: 'warehouse@cloudchaserz.example' },
  { key: 'manager', usr: 'hou.mtr.manager@cloudchaserz.example' },
  { key: 'associate', usr: 'hou.mtr.a1@cloudchaserz.example' },
  { key: 'regional', usr: 'regional.ok@cloudchaserz.example' }
]
// maison_pos/www/start.py::SCREENS — (route, title, roles that may see it; empty = anyone signed in)
const SCREENS = [
  ['/pos', 'Point of sale', ['AWANZ Associate', 'AWANZ Manager', 'AWANZ Regional', 'AWANZ Head Office', 'System Manager']],
  ['/awanz-dashboard', 'Command dashboard', ['AWANZ Regional', 'AWANZ Head Office', 'System Manager']],
  ['/warehouse', 'Warehouse desk', ['AWANZ Warehouse Admin', 'AWANZ Head Office', 'System Manager']],
  ['/warehouse-wall', 'Shipping wall', ['AWANZ Warehouse Admin', 'AWANZ Head Office', 'System Manager']],
  ['/salon', 'Client display', []],
  ['/shop', 'Online store', []],
  ['/rewards', 'Rewards', []],
  ['/app', 'Admin desk', ['AWANZ Head Office', 'System Manager']]
]

const results = []
const notes = []
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
    async rawPost(method, data = {}) {
      const r = await ctx.post(`/api/method/${method}`, { data, headers }); return { status: r.status(), body: await r.json().catch(() => ({})) }
    },
    list: (doctype, filters, fields = ['name'], limit = 50) =>
      api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit }),
    rawList: (doctype, filters, fields = ['name'], limit = 50) =>
      api.raw('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit }),
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
async function userApi(usr) {
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.post('/api/method/login', { data: { usr, pwd: PWD } })
  if (!r.ok()) throw new Error(`${usr} login failed ${r.status()}`)
  const pos = await ctx.get('/pos', { maxRedirects: 5 })
  const csrf = (await pos.text()).match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
  return wrap(ctx, { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' })
}

const browser = await chromium.launch({ headless: true })
async function newCtx(opts = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, colorScheme: 'dark', ...opts })
  if (BRIDGE) await installBridge(ctx)
  return ctx
}
const admin = await adminApi()

// ==================================================================================
// 1. logins → /start, and the launcher lists the right screens per role
// ==================================================================================
log('\n=== 1. Logins + launcher ===========================================')
const rolesOf = async (usr) =>
  (await admin.get('frappe.client.get_list', {
    doctype: 'Has Role', parent: 'User', limit_page_length: 100,
    filters: JSON.stringify([['parent', '=', usr], ['parenttype', '=', 'User']]), fields: JSON.stringify(['role'])
  })).map((r) => r.role)

for (const u of USERS) {
  const roles = await rolesOf(u.usr)
  const expected = SCREENS.filter(([, , allowed]) => !allowed.length || allowed.some((r) => roles.includes(r))).map(([route]) => route)
  const ctx = await newCtx({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  // the real sign-in form, so the landing page is whatever the framework redirects to
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.fill('#login_email', u.usr)
  await page.fill('#login_password', PWD)
  await Promise.all([page.waitForNavigation({ timeout: 60000 }).catch(() => {}), page.click('.btn-login')])
  await page.waitForTimeout(2500)
  const landed = new URL(page.url()).pathname
  await page.waitForSelector('.ms-grid', { timeout: 30000 }).catch(() => {})
  const shown = await page.$$eval('.ms-card', (els) => els.map((e) => ({ route: e.querySelector('.ms-route')?.textContent.trim(), title: e.querySelector('h2')?.textContent.trim() })))
  const shownRoutes = shown.map((s) => s.route)
  const who = (await page.locator('.ms-who').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const same = JSON.stringify(shownRoutes) === JSON.stringify(expected)
  record(`${u.key} (${u.usr}) lands on /start`, landed === '/start', `landed ${landed} · "${who}"`)
  record(`${u.key}: the launcher lists exactly the screens the role allows`, same,
    `roles [${roles.filter((r) => r.startsWith('AWANZ')).join(', ')}] → shown ${shownRoutes.join(' ')} · expected ${expected.join(' ')}`)
  if (u.key === 'associate') {
    const credit = (await page.locator('.ms-credit').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
    record('/start carries the "Powered by Futonix" credit', /powered by\s+futonix/i.test(credit), `"${credit}"`)
    await page.screenshot({ path: path.join(SHOTS, 'fa-start.png') })
    log('  shot fa-start.png')
    const foot = (await page.locator('.ms-foot').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
    if (/admin desk/i.test(foot)) note('the /start footer offers "Admin desk" (/app) to every signed-in user',
      `the role-gated card list correctly hides it from an associate, but the footer link row is unconditional (maison_pos/www/start.html) — an associate taps it and lands on the desk. Footer: "${foot}"`)
  }
  await ctx.close()
}

// ==================================================================================
// 9. Branding audit — rendered text of every route
// ==================================================================================
log('\n=== 9. Branding audit ==============================================')
const NEEDLES = ['Maison', 'Frappe', 'ERPNext']
const token = (await admin.list('Sales Invoice', [['is_pos', '=', 1], ['docstatus', '=', 1], ['maison_receipt_token', 'is', 'set']], ['maison_receipt_token'], 1))[0]?.maison_receipt_token
const guestCtx = await newCtx({ viewport: { width: 1440, height: 1000 } })
const assocCtx = await newCtx({ viewport: { width: 1366, height: 1024 } })
await assocCtx.request.post('/api/method/login', { data: { usr: 'hou.mtr.a1@cloudchaserz.example', pwd: PWD } })
const hqCtx = await newCtx({ viewport: { width: 1920, height: 1080 } })
await hqCtx.request.post('/api/method/login', { data: { usr: 'hq@cloudchaserz.example', pwd: PWD } })
const whCtx = await newCtx({ viewport: { width: 1600, height: 1000 } })
await whCtx.request.post('/api/method/login', { data: { usr: 'warehouse@cloudchaserz.example', pwd: PWD } })

const ROUTES = [
  ['/', guestCtx, null],
  ['/login', guestCtx, null],
  ['/start', assocCtx, '.ms-grid'],
  ['/shop', guestCtx, null],
  ['/shop/collection', guestCtx, null],
  ['/shop/register', guestCtx, '[data-testid=register-title]'],
  ['/shop/boutiques', guestCtx, null],
  ['/rewards', guestCtx, '[data-testid=rewards-tiers]'],
  ['/salon', guestCtx, null],
  [token ? `/r/${token}` : null, guestCtx, null],
  ['/pos', assocCtx, '.unlock'],
  ['/awanz-dashboard', hqCtx, '[data-testid="live-cards"] .bcard'],
  ['/warehouse', whCtx, '[data-testid=warehouse-desk]'],
  ['/warehouse-wall', whCtx, '[data-testid=warehouse-wall]'],
  ['/no-such-page-at-all', guestCtx, null]
]
const brandRows = []
for (const [route, ctx, settle] of ROUTES) {
  if (!route) continue
  const page = await ctx.newPage()
  let status = 0
  try {
    const resp = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60000 })
    status = resp ? resp.status() : 0
    if (settle) await page.waitForSelector(settle, { timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(1800)
  } catch (e) { status = -1 }
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
  const title = await page.title().catch(() => '')
  const hits = []
  for (const n of NEEDLES) {
    const re = new RegExp(n, 'gi'); let m
    while ((m = re.exec(text))) hits.push({ needle: n, ctx: text.slice(Math.max(0, m.index - 60), m.index + n.length + 60).replace(/\s+/g, ' ') })
  }
  const footerCredit = /powered by\s+futonix/i.test(text)
  brandRows.push({ route, status, title, hits: hits.slice(0, 6), textLen: text.length, footerCredit })
  log(`  ${route.padEnd(24)} ${String(status).padEnd(4)} "${title.slice(0, 48)}" text=${text.length} hits=${hits.length}${footerCredit ? ' · Futonix credit' : ''}`)
  for (const h of hits.slice(0, 3)) log(`      ${h.needle}: …${h.ctx}…`)
  await page.close()
}
const dirty = brandRows.filter((r) => r.hits.length)
record('no route renders "Maison", "Frappe" or "ERPNext" in its visible text',
  dirty.length === 0,
  dirty.length ? dirty.map((d) => `${d.route}: ${d.hits.map((h) => h.needle + ' (' + h.ctx.slice(0, 70) + ')').join('; ')}`).join(' | ')
    : `${brandRows.length} routes audited: ${brandRows.map((r) => r.route).join(' ')}`)
const creditRoutes = brandRows.filter((r) => r.footerCredit).map((r) => r.route)
record('"Powered by Futonix" is present in the website footer and on /start',
  creditRoutes.includes('/start') && creditRoutes.some((r) => ['/shop', '/rewards', '/shop/collection', '/'].includes(r)),
  `rendered on: ${creditRoutes.join(', ') || '(nowhere)'}`)
const storedFooter = await admin.get('frappe.client.get_value', { doctype: 'Website Settings', filters: JSON.stringify({ name: 'Website Settings' }), fieldname: JSON.stringify(['footer_powered']) })
record('Website Settings.footer_powered carries the tenant credit (what /login and standard web pages print)',
  /futonix/i.test(String(storedFooter?.footer_powered || '')) && !/erpnext|frappe/i.test(String(storedFooter?.footer_powered || '')),
  String(storedFooter?.footer_powered || '(empty)').replace(/\s+/g, ' ').slice(0, 200))

// ==================================================================================
// 10. Security spot-checks
// ==================================================================================
log('\n=== 10. Security ===================================================')
const MGR = 'hou.mtr.manager@cloudchaserz.example'
const mgrApi = await userApi(MGR)
const otherInv = await mgrApi.rawList('Sales Invoice', [['maison_boutique', '!=', 'HOU-MTR']], ['name', 'maison_boutique', 'is_return', 'grand_total'], 100)
const otherRows = Array.isArray(otherInv.body?.message) ? otherInv.body.message : []
record('a store manager cannot list another store\'s invoices',
  otherRows.length === 0,
  otherRows.length ? `${otherRows.length} rows leaked: ${[...new Set(otherRows.map((r) => r.maison_boutique))].join(', ')}` : `frappe.client.get_list(Sales Invoice, boutique != HOU-MTR) → ${otherInv.status}, 0 rows`)
const ownInv = await mgrApi.list('Sales Invoice', [['maison_boutique', '=', 'HOU-MTR']], ['name'], 5)
record('…while their own store\'s invoices are still readable', ownInv.length > 0, `${ownInv.length} own-store rows`)

const myAssoc = (await admin.list('AWANZ Associate', { user: MGR }, ['name', 'boutique', 'role'], 5))[0]
const esc = await mgrApi.rawPost('frappe.client.set_value', { doctype: 'AWANZ Associate', name: myAssoc.name, fieldname: 'role', value: 'HeadOffice' })
const stillRole = (await admin.list('AWANZ Associate', { name: myAssoc.name }, ['role'], 5))[0]?.role
const rolesAfter = await rolesOf(MGR)
record('a store manager cannot promote themselves through AWANZ Associate.role',
  esc.status >= 400 && stillRole === myAssoc.role && !rolesAfter.includes('AWANZ Head Office'),
  `set_value(role=HeadOffice) → ${esc.status} ${String(JSON.stringify(esc.body?.exception || esc.body?._server_messages || '')).slice(0, 140)}; record still role=${stillRole}; frappe roles [${rolesAfter.filter((r) => r.startsWith('AWANZ')).join(', ')}]`)

const pinList = await mgrApi.rawList('AWANZ Associate', {}, ['name', 'user', 'pin_hash'], 50)
const pinRows = Array.isArray(pinList.body?.message) ? pinList.body.message : []
const exposed = pinRows.filter((r) => r.pin_hash && !/^\*+$/.test(String(r.pin_hash)))
record('a store manager cannot read pin_hash',
  pinList.status >= 400 || exposed.length === 0,
  pinList.status >= 400
    ? `get_list(fields=[pin_hash]) → ${pinList.status} ${String(JSON.stringify(esc.body?.exc_type || '')).slice(0, 60)}`
    : `${pinRows.length} rows readable, pin_hash values: ${[...new Set(pinRows.map((r) => String(r.pin_hash)))].join(', ') || '(none)'}`)
const scopeRows = await mgrApi.rawList('AWANZ Associate', {}, ['name', 'user', 'boutique'], 100)
const scoped = Array.isArray(scopeRows.body?.message) ? scopeRows.body.message : []
record('the associate list a manager can read is scoped to their own store',
  scoped.length > 0 && scoped.every((r) => r.boutique === 'HOU-MTR'),
  `${scoped.length} rows, stores ${[...new Set(scoped.map((r) => r.boutique))].join(', ')}`)

const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed; ${notes.length} notes`)
fs.writeFileSync(path.join(__dirname, 'results.fa-launch.json'),
  JSON.stringify({ base: BASE, results, notes, brand: brandRows }, null, 1))
for (const c of [guestCtx, assocCtx, hqCtx, whCtx]) await c.close()
await browser.close()
await admin.dispose()
process.exit(passed === results.length ? 0 : 1)
