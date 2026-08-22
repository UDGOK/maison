// Offline-reload check against the cloud site: register the SW on /pos, reload online so the page is
// controlled, then go offline and reload /pos/sell — the shell must render (not a browser error page).
// Run: BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 BASE=... SHOTS_DIR=cloud-shots-2 node pos.cloud.offline-reload.mjs
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installBridge } from './cloud-bridge.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, process.env.SHOTS_DIR || 'cloud-shots-2')
const BASE = process.env.BASE || 'https://maison-demo.frappe.cloud'
const ASSOC = { usr: process.env.ASSOC_USER || 'chi.oak.a1@maison.example', pwd: process.env.ASSOC_PWD || 'maison123' }
const BRIDGE = process.env.BRIDGE === '1'
let offlineFlag = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (step, ok, detail = '') => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`) }
const consoleLog = []

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, baseURL: BASE })
if (BRIDGE) await installBridge(context, { isOffline: () => offlineFlag })
const login = await context.request.post('/api/method/login', { data: ASSOC })
record('login', login.ok(), ASSOC.usr)
const page = await context.newPage()
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleLog.push(m.text()) })
page.on('pageerror', (e) => consoleLog.push('pageerror ' + e))

await page.goto('/pos/sell', { waitUntil: 'networkidle' })
// wait for the SW to be activated, then reload online so that this client becomes controlled + precache is warm
await page.waitForFunction(async () => {
  const regs = await navigator.serviceWorker.getRegistrations()
  return regs.some((r) => r.active && r.active.state === 'activated')
}, null, { timeout: 30000 })
await page.reload({ waitUntil: 'networkidle' })
await sleep(1500)
const swOnline = await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations()
  const keys = await caches.keys()
  const counts = {}
  for (const k of keys) counts[k] = (await (await caches.open(k)).keys()).length
  return { regs: regs.map((r) => ({ scope: r.scope, state: r.active?.state, script: r.active?.scriptURL })), controller: navigator.serviceWorker.controller?.scriptURL || null, caches: counts }
})
record('SW registered + controlling page after reload (online)', swOnline.regs.length === 1 && swOnline.regs[0].scope === BASE + '/pos/' && !!swOnline.controller, JSON.stringify(swOnline))
await page.screenshot({ path: path.join(SHOTS, '17-online-before-offline-reload.png') })

// now offline → reload /pos/sell
offlineFlag = true
await context.setOffline(true)
let navErr = null
try { await page.goto('/pos/sell', { waitUntil: 'load', timeout: 30000 }) } catch (e) { navErr = String(e.message).split('\n')[0] }
await sleep(3000)
const state = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  hasApp: !!document.querySelector('#app, .unlock, .topbar, .sell'),
  unlock: !!document.querySelector('.unlock'),
  topbar: !!document.querySelector('.topbar'),
  status: document.querySelector('.topbar .status')?.textContent?.replace(/\s+/g, ' ').trim() || null,
  bodyStart: document.body.innerText.slice(0, 200).replace(/\s+/g, ' '),
  isChromeError: /chrome-error|ERR_/.test(location.href) || /This site can.t be reached|No internet/i.test(document.body.innerText)
}))
await page.screenshot({ path: path.join(SHOTS, '18-offline-reload-sell.png') })
record('offline reload of /pos/sell renders the shell (served by SW)', !navErr && state.hasApp && !state.isChromeError, `navErr=${navErr} ${JSON.stringify(state)}`)

offlineFlag = false
await context.setOffline(false)
await sleep(1000)
fs.writeFileSync(path.join(__dirname, 'results.cloud-2.offline-reload.json'), JSON.stringify({ results, console: consoleLog }, null, 2))
console.log('\nConsole errors/warnings:', consoleLog.length); for (const c of consoleLog) console.log(' ', c.slice(0, 300))
await browser.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
