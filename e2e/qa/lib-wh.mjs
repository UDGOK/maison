// QA agent 2 (warehouse/shipping/receiving/inventory) — API + browser helpers.
import { chromium } from '../node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export const BASE = process.env.BASE || 'https://cloudchaserz.frappe.cloud'
export const HOST = new URL(BASE).host
export const SID = process.env.ADMIN_SID || (existsSync('/tmp/qa2-sid') ? readFileSync('/tmp/qa2-sid', 'utf8').trim() : '')
export const PWD = 'cloud123'
export const SHOTS = '/home/claude/maison/e2e/qa/shots-warehouse'
mkdirSync(SHOTS, { recursive: true })

export const STORE = process.env.STORE || 'OK-JENKS'
export const STORE2 = process.env.STORE2 || 'OK-YALE'
export const MGR = { usr: `${STORE.toLowerCase().replace(/-/g, '.')}.manager@cloudchaserz.example`, pwd: PWD, pin: '1313' }
export const MGR2 = { usr: `${STORE2.toLowerCase().replace(/-/g, '.')}.manager@cloudchaserz.example`, pwd: PWD, pin: '1212' }
export const WH = { usr: 'warehouse@cloudchaserz.example', pwd: PWD }
export const TAG = 'QA2'

export const results = []
export const log = (...a) => console.log(...a)
export function record(step, ok, detail = '', severity = '') {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 900), severity })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`)
}
export function saveResults(file) {
  writeFileSync(path.join('/home/claude/maison/e2e/qa', file), JSON.stringify({ base: BASE, store: STORE, results, console: console_ }, null, 1))
  const p = results.filter(r => r.ok).length
  log(`\n${p}/${results.length} passed. console issues: ${console_.length}`)
  for (const c of console_.slice(0, 20)) log(`  ${c.tag} ${c.type} ${c.text}`)
}

export const console_ = []
export function wireConsole(page, tag) {
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console_.push({ tag, type: m.type(), text: m.text().slice(0, 300) }) })
  page.on('pageerror', (e) => console_.push({ tag, type: 'pageerror', text: String(e).slice(0, 300) }))
  page.on('requestfailed', (r) => { const u = r.url(); if (!/fonts\.(googleapis|gstatic)/.test(u)) console_.push({ tag, type: 'requestfailed', text: `${u.slice(0, 150)} ${r.failure()?.errorText || ''}` }) })
}

export let browser = null
export async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true })
  return browser
}
export async function closeBrowser() { if (browser) await browser.close(); browser = null }

let shotN = Number(process.env.SHOT_START || 0)
export async function shot(page, name, full = false) {
  const file = `${String(++shotN).padStart(3, '0')}-${name}.png`
  await page.screenshot({ path: path.join(SHOTS, file), fullPage: full }).catch((e) => log('  shot fail ' + e))
  log('  shot ' + file)
  return file
}

// -------- API clients (no browser needed; go through Node request context)
export async function apiFor(user) {
  const b = await getBrowser()
  const ctx = await b.newContext({ baseURL: BASE })
  if (user === 'admin') {
    await ctx.addCookies([{ name: 'sid', value: SID, domain: HOST, path: '/' }])
  } else {
    const r = await ctx.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
    if (!r.ok()) throw new Error(`${user.usr} login failed ${r.status()} ${await r.text()}`)
  }
  const html = await (await ctx.request.get('/pos')).text()
  const csrf = html.match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
  const headers = { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' }
  const api = {
    ctx, csrf, who: user === 'admin' ? 'Administrator' : user.usr,
    async raw(method, data = {}, verb = 'post') {
      const r = verb === 'post'
        ? await ctx.request.post(`/api/method/${method}`, { headers, data })
        : await ctx.request.get(`/api/method/${method}`, { params: data })
      const txt = await r.text()
      let j = null; try { j = JSON.parse(txt) } catch {}
      return { status: r.status(), ok: r.ok(), json: j, text: txt }
    },
    async get(method, params = {}) {
      const r = await ctx.request.get(`/api/method/${method}`, { params })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 400)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.request.post(`/api/method/${method}`, { headers, data })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 400)}`)
      return j.message
    },
    // returns {err} instead of throwing
    async tryPost(method, data = {}) {
      const r = await api.raw(method, data, 'post')
      if (r.ok) return { ok: true, message: r.json?.message }
      return { ok: false, status: r.status, exc: excOf(r) }
    },
    async tryGet(method, data = {}) {
      const r = await api.raw(method, data, 'get')
      if (r.ok) return { ok: true, message: r.json?.message }
      return { ok: false, status: r.status, exc: excOf(r) }
    },
    list: (doctype, filters, fields = ['name'], limit = 100, order_by = undefined) =>
      api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit, ...(order_by ? { order_by } : {}) }),
    doc: (doctype, name) => api.get('frappe.client.get', { doctype, name }),
    value: (doctype, name, fields) => api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    dispose: () => ctx.close(),
  }
  return api
}

export function excOf(r) {
  const t = r.text || ''
  try {
    const j = JSON.parse(t)
    const e = j.exception || (Array.isArray(j._server_messages) ? JSON.parse(j._server_messages).map(m => { try { return JSON.parse(m).message } catch { return m } }).join(' | ') : '') || j.message
    return String(e || t).slice(0, 400)
  } catch { return String(t).slice(0, 400) }
}

// -------- browser contexts with the bridge
export async function pageAs(user, { viewport = { width: 1600, height: 1000 }, tag = 'page' } = {}) {
  const b = await getBrowser()
  const ctx = await b.newContext({ viewport, baseURL: BASE, colorScheme: 'dark' })
  if (user === 'admin') await ctx.addCookies([{ name: 'sid', value: SID, domain: HOST, path: '/' }])
  else {
    const r = await ctx.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
    if (!r.ok()) throw new Error(`login failed ${user.usr} ${r.status()}`)
  }
  if (process.env.BRIDGE === '1') {
    const { installBridge } = await import('../cloud-bridge.mjs')
    await installBridge(ctx, {})
  }
  const page = await ctx.newPage()
  wireConsole(page, tag)
  return { ctx, page }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))
