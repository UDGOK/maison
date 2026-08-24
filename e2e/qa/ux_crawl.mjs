// Area B: white-label crawl + Futonix credit + D1 dashboard + cross-device overflow.
import { chromium } from 'playwright'
import { installBridge } from '../cloud-bridge.mjs'
import fs from 'fs'

const BASE = 'https://cloudchaserz.frappe.cloud'
const HOST = 'cloudchaserz.frappe.cloud'
const SID = fs.readFileSync('/tmp/ccsid', 'utf8').trim()
const SHOTS = '/home/claude/maison/e2e/qa/shots-secux'
const TOKEN = 'NPh8inzLoWWL4fkb'
const FORBIDDEN = [/Frappe/i, /ERPNext/i, /frappe\.io/i, /erpnext\.com/i]

const browser = await chromium.launch({ headless: true })
function adminState() {
  return { cookies: [{ name: 'sid', value: SID, domain: HOST, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }
}
async function ctx(admin = false, opts = {}) {
  const c = await browser.newContext({ baseURL: BASE, ...(admin ? { storageState: adminState() } : {}), ...opts })
  await installBridge(c)
  return c
}
function scan(txt) {
  const hits = []
  for (const re of FORBIDDEN) { const m = txt.match(re); if (m) hits.push(m[0]) }
  return [...new Set(hits)]
}

const routes = [
  ['home', '/', false],
  ['login', '/login', false],
  ['start', '/start', true],
  ['pos-unlock', '/pos', false],
  ['dashboard', '/maison-dashboard', true],
  ['warehouse', '/warehouse', true],
  ['warehouse-wall', '/warehouse-wall', true],
  ['shop', '/shop', false],
  ['rewards', '/rewards', false],
  ['salon', '/salon', false],
  ['receipt', `/r/${TOKEN}`, false],
  ['404', '/this-route-does-not-exist-zzz', false],
  ['app-desk', '/app', true],
]

const results = []
for (const [name, path, admin] of routes) {
  const c = await ctx(admin, { viewport: { width: 1440, height: 900 } })
  const page = await c.newPage()
  try {
    const resp = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(2500) // let SPA render
    const status = resp ? resp.status() : 0
    const html = await page.content()
    const text = await page.evaluate(() => document.body ? document.body.innerText : '')
    const title = await page.title().catch(() => '')
    // visible-text mentions of Maison as a standalone wordmark (D1 signal on dashboard)
    const maisonVisible = /\bMaison\b/.test(text)
    const cloudchaserzVisible = /CLOUDCHASERZ|CloudChaserz/.test(text)
    const futonix = /Futonix/i.test(html)
    const poweredByFutonix = /Powered by\s*<[^>]*>?\s*Futonix|Powered by Futonix/i.test(html) || (/Powered by/i.test(text) && /Futonix/i.test(text))
    const r = {
      name, path, status, title,
      text_hits: scan(text),          // forbidden strings in RENDERED TEXT (bad)
      html_hits: scan(html),          // forbidden strings in SOURCE (allow-listed identifiers)
      maisonVisible, cloudchaserzVisible, futonix, poweredByFutonix,
    }
    results.push(r)
    await page.screenshot({ path: `${SHOTS}/wl-${name}.png`, fullPage: false }).catch(() => {})
    console.log(`[${status}] ${name.padEnd(16)} textForbidden=${JSON.stringify(r.text_hits)} htmlForbidden=${JSON.stringify(r.html_hits)} MaisonVisible=${maisonVisible} Futonix=${futonix}`)
  } catch (e) {
    results.push({ name, path, error: String(e).slice(0, 120) })
    console.log(`[ERR] ${name}: ${String(e).slice(0, 100)}`)
  }
  await c.close()
}

// --- dashboard D1 detail: read the wordmark + scope line text ---
{
  const c = await ctx(true, { viewport: { width: 1920, height: 1080 } })
  const page = await c.newPage()
  try {
    await page.goto('/maison-dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(4000)
    const wm = await page.locator('[data-testid="wordmark"], .wordmark').first().textContent().catch(() => '(none)')
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400))
    const hasBoutiques = /Boutique/i.test(bodyText)
    console.log(`\nDASHBOARD wordmark="${(wm||'').trim()}"  mentions 'Boutique'=${hasBoutiques}`)
    console.log('DASHBOARD top text sample:', JSON.stringify(bodyText.replace(/\n+/g,' | ').slice(0,220)))
    await page.screenshot({ path: `${SHOTS}/wl-dashboard-1920.png` })
    fs.writeFileSync('/tmp/qa_dash.json', JSON.stringify({ wordmark: (wm||'').trim(), hasBoutiques, bodyText }))
  } catch (e) { console.log('dashboard detail err', String(e).slice(0,100)) }
  await c.close()
}

// --- cross-device horizontal overflow across public routes + unlock ---
const viewports = [
  ['1920x1080', 1920, 1080], ['1366x1024', 1366, 1024], ['1024x1366', 1024, 1366],
  ['390x844', 390, 844], ['360x740', 360, 740],
]
const ovRoutes = [['home', '/', false], ['login', '/login', false], ['shop', '/shop', false],
  ['rewards', '/rewards', false], ['salon', '/salon', false], ['pos-unlock', '/pos', false],
  ['start', '/start', true], ['receipt', `/r/${TOKEN}`, false]]
console.log('\n===== HORIZONTAL OVERFLOW (scrollWidth - clientWidth, >0 = overflow) =====')
const overflow = {}
for (const [rn, rp, admin] of ovRoutes) {
  overflow[rn] = {}
  for (const [vn, w, h] of viewports) {
    const c = await ctx(admin, { viewport: { width: w, height: h } })
    const page = await c.newPage()
    try {
      await page.goto(rp, { waitUntil: 'domcontentloaded', timeout: 40000 })
      await page.waitForTimeout(1800)
      const ov = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))
      overflow[rn][vn] = ov
      if (rn === 'pos-unlock' && vn === '1366x1024') await page.screenshot({ path: `${SHOTS}/dev-unlock-1366.png` })
      if (ov > 0 && (vn === '390x844' || vn === '1366x1024')) await page.screenshot({ path: `${SHOTS}/dev-${rn}-${vn}.png` }).catch(()=>{})
    } catch (e) { overflow[rn][vn] = 'ERR' }
    await c.close()
  }
  const row = viewports.map(([vn]) => `${vn}:${overflow[rn][vn]}`).join('  ')
  console.log(`  ${rn.padEnd(12)} ${row}`)
}

fs.writeFileSync('/tmp/qa_wl_results.json', JSON.stringify({ results, overflow }, null, 2))
await browser.close()
console.log('\nsaved /tmp/qa_wl_results.json')
