// QA agent 4 harness — web shop / rewards / salon, CloudChaserz live site. Test-only; touches no app source.
import { chromium, request } from 'playwright'
import { installBridge } from '../cloud-bridge.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SHOTS = path.join(__dirname, 'shots-srs')
fs.mkdirSync(SHOTS, { recursive: true })

export const BASE = process.env.BASE || 'https://cloudchaserz.frappe.cloud'
export const HOST = new URL(BASE).hostname
export const ADMIN_SID = process.env.ADMIN_SID || fs.readFileSync('/tmp/ccsid', 'utf8').trim()
export const PWD = 'cloud123'
export const STORE = process.env.STORE || 'OK-BA'
export const WH = `${STORE} - CCZ`
export const A1 = { usr: `${STORE.toLowerCase().replace(/-/g, '.')}.a1@cloudchaserz.example`, pwd: PWD, pin: '2580' }
export const A2 = { usr: `${STORE.toLowerCase().replace(/-/g, '.')}.a2@cloudchaserz.example`, pwd: PWD, pin: '1357' }
const MGR_PINS = { 'HOU-MTR': '1101', 'OK-SAP': '2202', 'OK-BA': '3303', 'OK-BIX': '4404', 'OK-STUL': '5505', 'OK-OWA': '6606', 'OK-MUS': '7707', 'OK-MINGO': '8808', 'OK-ETUL': '9909', 'OK-YALE': '1212', 'OK-JENKS': '1313' }
export const MGR = { usr: `${STORE.toLowerCase().replace(/-/g, '.')}.manager@cloudchaserz.example`, pwd: PWD, pin: MGR_PINS[STORE] }
export const HQ = { usr: 'hq@cloudchaserz.example', pwd: PWD }
export const TAG = process.env.TAG || 'QA4'

export const results = []
export const consoleLog = []
let shotN = Number(process.env.SHOT_START || 0)
export const log = (...a) => console.log(...a)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export function record(step, ok, detail = '', sev = '') {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 900), sev })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`)
}
export function note(step, detail = '') {
  results.push({ step, ok: null, detail: String(detail).slice(0, 900) })
  log(`NOTE  ${step}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`)
}
export async function shot(page, name, full = false) {
  const f = `${String(++shotN).padStart(3, '0')}-${name}.png`
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(SHOTS, f), fullPage: full }).catch((e) => log('  shot fail', e.message))
  log('  shot ' + f)
  return f
}
export function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) &&
      !/fonts\.(googleapis|gstatic)|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|ERR_CONNECTION_RESET|WebGL|Vue Devtools|Failed to load resource: net/i.test(m.text())) {
      consoleLog.push({ tag, type: m.type(), text: m.text().slice(0, 300) })
    }
  })
  page.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e.stack || e).slice(0, 400) }))
}

const adminStorageState = () => ({
  cookies: [{ name: 'sid', value: ADMIN_SID, domain: HOST, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: []
})
function wrap(ctx, headers = {}) {
  const api = {
    ctx, headers,
    async raw(method, params = {}) { const r = await ctx.get(`/api/method/${method}`, { params }); return { status: r.status(), body: await r.json().catch(() => ({})) } },
    async rawPost(method, data = {}) { const r = await ctx.post(`/api/method/${method}`, { data, headers }); return { status: r.status(), body: await r.json().catch(() => ({})) } },
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
    list: (doctype, filters, fields = ['name'], limit = 50, order = 'creation desc') =>
      api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit, order_by: order }),
    doc: (doctype, name) => api.get('frappe.client.get', { doctype, name }),
    value: (doctype, name, fields) => api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    setValue: (doctype, name, fieldname, value) => api.post('frappe.client.set_value', { doctype, name, fieldname, value }),
    dispose: () => ctx.dispose()
  }
  return api
}
export async function adminApi() {
  const ctx = await request.newContext({ baseURL: BASE, storageState: adminStorageState() })
  const who = await ctx.get('/api/method/frappe.auth.get_logged_user')
  const j = await who.json().catch(() => ({}))
  if (j.message !== 'Administrator') throw new Error('admin sid invalid: ' + JSON.stringify(j).slice(0, 200))
  const posr = await ctx.get('/app')
  const csrf = (await posr.text()).match(/csrf_token["'\s:=]+["']([a-f0-9]+)["']/)?.[1] || ''
  return wrap(ctx, csrf ? { 'X-Frappe-CSRF-Token': csrf } : {})
}
export async function userApi(user, page = '/pos') {
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!r.ok()) throw new Error(`${user.usr} login ${r.status()}`)
  const pos = await ctx.get(page)
  const t = await pos.text()
  const csrf = t.match(/window\.csrf_token = "([^"]*)"/)?.[1] || t.match(/csrf_token["'\s:=]+["']([a-f0-9]+)["']/)?.[1] || ''
  return wrap(ctx, { 'X-Frappe-CSRF-Token': csrf })
}
export async function guestApi() {
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.get('/shop')
  const csrf = (await r.text()).match(/csrf_token["'\s:=]+["']([a-f0-9]+)["']/)?.[1] || ''
  return wrap(ctx, csrf ? { 'X-Frappe-CSRF-Token': csrf } : {})
}

export async function newBrowser() {
  return chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}
export async function ctxFor(browser, user, tag, opts = {}) {
  const offline = { v: false }
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    baseURL: BASE, colorScheme: 'dark', locale: 'en-US', timezoneId: opts.tz || 'America/Chicago',
    ...(opts.ctx || {})
  })
  if (process.env.BRIDGE !== '0') await installBridge(context, { isOffline: () => offline.v, onWsFrame: opts.onWsFrame || (() => {}) })
  if (user) {
    const login = await context.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
    if (!login.ok()) throw new Error(`${user.usr} login ${login.status()}`)
  }
  const page = await context.newPage()
  wireConsole(page, tag)
  return { context, page, offline }
}
export async function go(page, url, opts = { waitUntil: 'domcontentloaded' }) {
  let last
  for (let i = 0; i < 4; i++) {
    try { const r = await page.goto(url, opts); await page.waitForTimeout(400); return r } catch (e) { last = e; await sleep(2000) }
  }
  throw last
}
export async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}
// ---------------- POS helpers (mirror of lib-pos, own shots dir) ----------------
export async function freshDevice(page) {
  await go(page, '/pos/unlock')
  await page.evaluate(async () => {
    localStorage.clear(); sessionStorage.clear()
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => r() })))
  })
}
export async function loadCatalogue(page, store = STORE) {
  await go(page, '/pos/unlock')
  await page.waitForSelector('.unlock select.input', { timeout: 60000 })
  await page.selectOption('.unlock select.input >> nth=0', store)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 90000 })
}
export async function pickAssociate(page, user) {
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: (o.textContent || '').trim() })))
  const a = opts.find((o) => o.v === user.usr)
  if (!a) throw new Error(`${user.usr} not offered: ${opts.map((o) => o.v).join(',')}`)
  for (let i = 0; i < 8; i++) {
    await page.selectOption('.unlock select.input >> nth=1', a.v)
    await page.waitForTimeout(200)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === a.v) break
  }
  return a.t
}
export async function typePin(page, pin) {
  for (const d of String(pin)) await page.click(`.keypad button:text-is("${d}")`)
}
export async function unlock(page, user, { store = STORE, fresh = false } = {}) {
  if (fresh) await freshDevice(page)
  await loadCatalogue(page, store)
  await pickAssociate(page, user)
  await typePin(page, user.pin)
  await page.waitForSelector('.topbar', { timeout: 40000 })
  await page.waitForSelector('.tile', { timeout: 40000 })
}
export const nav = (page, label) => page.click(`.nav-btn[title="${label}"]`)
export const money = (s) => parseFloat(String(s).replace(/[^0-9.\-]/g, '')) || 0
export async function addItem(page, term) {
  const q = page.locator('.sell .search input')
  await q.fill(term)
  await page.waitForTimeout(500)
  const tile = page.locator('.tile:not(.empty)').first()
  await tile.waitFor({ timeout: 15000 })
  const before = await page.locator('.basket .line').count()
  await tile.click()
  const modal = page.locator('.serials .serial-btn')
  if (await modal.count().then((n) => n > 0).catch(() => false)) await modal.first().click()
  await page.waitForFunction((n) => document.querySelectorAll('.basket .line').length > n, before, { timeout: 8000 }).catch(() => {})
  await q.fill('')
}
export async function payCash(page, tendered) {
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash', { timeout: 15000 })
  if (tendered != null) for (const d of String(tendered)) await page.click(`.pay .keypad button:text-is("${d}")`)
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForSelector('.receipt-view', { timeout: 40000 })
}
export async function waitSynced(page, ms = 60000) {
  await page.waitForFunction(() => /Synced|Rejected/.test(document.querySelector('.receipt-view .pill')?.textContent || ''), null, { timeout: ms }).catch(() => {})
  const pill = (await page.locator('.receipt-view .pill').first().textContent().catch(() => '')).trim()
  const uuid = page.url().split('/receipt/')[1]
  return { pill, uuid }
}
export async function invoiceForUuid(admin, uuid, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const rows = await admin.list('Sales Invoice', { maison_offline_uuid: uuid },
      ['name', 'grand_total', 'net_total', 'total_taxes_and_charges', 'docstatus', 'is_return', 'customer',
       'maison_receipt_token', 'maison_boutique', 'rounded_total', 'loyalty_points', 'loyalty_amount', 'maison_sales_order'])
    if (rows.length) return rows
    await sleep(1500)
  }
  return []
}
export function writeResults(file, extra = {}) {
  const out = { when: new Date().toISOString(), base: BASE, results, consoleLog, ...extra }
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(out, null, 2))
  const p = results.filter((r) => r.ok === true).length, f = results.filter((r) => r.ok === false).length
  log(`\n== ${file}: ${p} passed, ${f} failed, ${consoleLog.length} console issues ==`)
  if (f) for (const r of results.filter((x) => x.ok === false)) log('  FAIL ' + r.step + ' — ' + r.detail.slice(0, 200))
}
