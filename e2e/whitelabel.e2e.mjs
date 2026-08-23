/**
 * v0.7 white-label — crawl the customer-facing surface and prove it never says
 * "Frappe" or "ERPNext".
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc.localhost:8001 ADMIN_PWD=admin \
 *     node e2e/whitelabel.e2e.mjs
 *
 * For every page it captures both layers and greps each for the four strings:
 *
 *   * **rendered text** (`document.body.innerText`) — what a customer actually reads. Any hit
 *     here is a hard failure.
 *   * **rendered HTML** (`document.documentElement.outerHTML`) — what a curious customer sees in
 *     view-source. Hits are classified: framework *asset paths* and the framework's own JS
 *     globals cannot be renamed without patching upstream and are reported as `ALLOWED`; anything
 *     else fails.
 *
 * Screenshots land in `e2e/shots-whitelabel/`. Nothing is written to the site.
 */
import { chromium } from './node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://cc.localhost:8001'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }

// The desk builds `new Intl.Locale(navigator.language)`; a container whose LANG is the POSIX
// locale gives Chromium `en-US@posix`, which is not a valid BCP-47 tag and throws before the
// workspace renders. Pin the context locale so the crawl sees the desk a real browser sees.
const LOCALE = process.env.E2E_LOCALE || 'en-US'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(here, 'shots-whitelabel')
mkdirSync(SHOTS, { recursive: true })

const NEEDLES = ['Frappe', 'ERPNext', 'frappe.io', 'erpnext.com']

/**
 * Hits we cannot remove without forking Frappe itself. Each is a *path or identifier*, never a
 * word a customer reads: the bundle URLs Frappe generates for its own assets, the framework's
 * JS namespace (`window.frappe`, `frappe.boot`, …) and the two DOM hooks base.html hard-codes.
 * Documented in docs/white-label.md.
 */
const ALLOWED = [
  // --- asset URLs and bundle file names Frappe generates for its own code ---
  /\/assets\/(frappe|erpnext|webshop|payments|hrms|crm)\//i,
  /(frappe|erpnext)[\w-]*\.bundle\./i,
  // --- the framework's JavaScript namespace and dotted Python method paths ---
  // property access on the framework's JS global — but never `frappe.io`, which is a link
  /(window\.)?frappe\.(?!io\b|com\b|cloud\b|school\b)[A-Za-z_$][\w$]*/,
  /window\.frappe\b/,
  /"(frappe|erpnext|hrms|crm|payments|webshop)\.[\w.]+"/i,
  // --- DOM identifiers hard-coded by frappe/templates/base.html and its components:
  //     frappe-session-status, frappe-symbols, frappe-checkbox, frappe-timestamp, … ---
  /frappe-[a-z][\w-]*/i,
  // --- identifiers inside JSON payloads (frappe.boot, the bundle map): app names as keys,
  //     values or array elements, and Workspace / Navbar Item *labels*, which are document
  //     names and desk routes (/app/frappe-crm). White-labelling rewrites the sidebar `title`
  //     and hides the framework Help items; the underlying identifiers stay. ---
  /"(frappe|erpnext|hrms|crm|payments|webshop)"\s*:/i,
  /[:[,]\s*"(frappe|erpnext|hrms|crm|payments|webshop|maison_pos)"/i,
  /"(Frappe|ERPNext)[\w &.'-]*"\s*[:,\]]/,
  /item-name="[^"]*(frappe|erpnext)/i,
  /"item_label":\s*"(Frappe|ERPNext)/,
  /is_fc_site/i,
  // --- module paths baked into the compiled bundles, and the Vue SFC style blocks those
  //     bundles inject at runtime (a CSS comment carrying the build machine's source path).
  //     Live DOM only — never in view-source — and inside upstream's compiled output. ---
  /sfc-style:/i,
  /apps\/(frappe|erpnext|hrms|crm|webshop|payments)\//i,
  /\b(frappe|erpnext|hrms|crm)\/(public|templates|www)\//i,
]

const log = (...a) => console.log(...a)
const results = []
let failures = 0

function classify(haystack, label) {
  const hits = []
  for (const needle of NEEDLES) {
    const re = new RegExp(needle.replace('.', '\\.'), 'gi')
    let m
    while ((m = re.exec(haystack))) {
      const from = Math.max(0, m.index - 90)
      const to = Math.min(haystack.length, m.index + needle.length + 90)
      const context = haystack.slice(from, to).replace(/\s+/g, ' ')
      hits.push({ needle, context, layer: label, allowed: ALLOWED.some((r) => r.test(context)) })
      if (hits.length > 400) return hits
    }
  }
  return hits
}

const browser = await chromium.launch({ headless: true })

async function check(ctx, name, route, { expectStatus = 200, settle = null, wait = 500 } = {}) {
  const page = await ctx.newPage()
  const response = await page.goto(route, { waitUntil: 'networkidle', timeout: 60000 })
  const status = response ? response.status() : 0
  if (settle) await page.waitForSelector(settle, { timeout: 60000, state: 'attached' })
  await page.waitForTimeout(wait)

  const text = await page.evaluate(() => document.body?.innerText || '')
  const html = await page.evaluate(() => document.documentElement.outerHTML)
  const title = await page.title()

  const textHits = classify(text, 'text')
  const htmlHits = classify(html, 'html')
  const blockingText = textHits
  const blockingHtml = htmlHits.filter((h) => !h.allowed)

  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })

  const ok = blockingText.length === 0 && blockingHtml.length === 0 && status === expectStatus
  if (!ok) failures++
  results.push({
    name,
    route,
    status,
    title,
    textHits: blockingText.length,
    htmlHitsAllowed: htmlHits.length - blockingHtml.length,
    htmlHitsBlocking: blockingHtml.length,
    blocking: [...blockingText, ...blockingHtml].slice(0, 12),
    ok,
  })

  log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ${String(status).padEnd(4)} "${title}"  ` +
      `text:${blockingText.length}  html:${blockingHtml.length} blocking / ${
        htmlHits.length - blockingHtml.length
      } allowed`
  )
  for (const h of [...blockingText, ...blockingHtml].slice(0, 6)) {
    log(`        [${h.layer}] ${h.needle}: …${h.context}…`)
  }
  await page.close()
  return ok
}

// -------------------------------------------------------------------- guest surface
const guest = await browser.newContext({ baseURL: BASE, viewport: { width: 1366, height: 900 }, locale: LOCALE })
log('\n— guest —')
await check(guest, 'shop-root', '/')
await check(guest, 'login', '/login')
await check(guest, 'shop', '/shop')
await check(guest, 'rewards', '/rewards')
await check(guest, '404', '/no-such-page-at-all', { expectStatus: 404 })

// a real receipt token, taken from the site itself
let token = process.env.RECEIPT_TOKEN || ''
if (!token) {
  const admin = await browser.newContext({ baseURL: BASE, locale: LOCALE })
  const login = await admin.request.post('/api/method/login', { data: ADMIN })
  if (!login.ok()) throw new Error(`admin login failed ${login.status()}`)
  const r = await admin.request.get(
    '/api/method/frappe.client.get_list?doctype=Sales+Invoice&filters=' +
      encodeURIComponent(
        JSON.stringify([
          ['is_pos', '=', 1],
          ['docstatus', '=', 1],
          ['maison_receipt_token', 'is', 'set'],
        ])
      ) +
      '&fields=' +
      encodeURIComponent(JSON.stringify(['maison_receipt_token'])) +
      '&limit_page_length=1'
  )
  const body = await r.json()
  token = body?.message?.[0]?.maison_receipt_token || ''
  await admin.close()
}
if (token) {
  await check(guest, 'receipt', `/r/${token}`)
} else {
  log('SKIP  receipt          no POS invoice with a receipt token on this site')
}
await guest.close()

// -------------------------------------------------------------------- staff surface
log('\n— signed in (System Manager) —')
const staff = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, locale: LOCALE })
const login = await staff.request.post('/api/method/login', { data: ADMIN })
if (!login.ok()) throw new Error(`admin login failed ${login.status()}`)
await check(staff, 'start', '/start')
await check(staff, 'desk', '/app', { settle: '.navbar .app-logo', wait: 5000 })

// `/apps`, the framework's "Select an app to continue" picker, must not be reachable
const appsPage = await staff.newPage()
await appsPage.goto('/apps', { waitUntil: 'networkidle', timeout: 60000 })
const appsUrl = appsPage.url()
const appsText = await appsPage.evaluate(() => document.body?.innerText || '')
const appsOk = classify(appsText, 'text').length === 0
if (!appsOk) failures++
log(`${appsOk ? 'PASS' : 'FAIL'}  apps-picker      —    landed on ${appsUrl}`)
results.push({ name: 'apps-picker', route: '/apps', landed: appsUrl, ok: appsOk })
await appsPage.screenshot({ path: path.join(SHOTS, 'apps-picker.png') })
await appsPage.close()

// the desk About dialog is the one piece of chrome that lives in JavaScript
const deskPage = await staff.newPage()
await deskPage.goto('/app', { waitUntil: 'networkidle', timeout: 90000 })
await deskPage.waitForFunction(() => window.frappe?.ui?.misc?.about, null, { timeout: 60000 })
const about = await deskPage.evaluate(() => {
  frappe.ui.misc.about()
  return new Promise((resolve) =>
    setTimeout(() => {
      const dialog = document.querySelector('.modal.show')
      resolve({
        title: dialog?.querySelector('.modal-title')?.innerText || '',
        body: dialog?.querySelector('.modal-body')?.innerText || '',
      })
    }, 1200)
  )
})
await deskPage.screenshot({ path: path.join(SHOTS, 'desk-about.png') })
const aboutBlob = `${about.title}\n${about.body}`
const aboutHits = classify(aboutBlob, 'text')
const aboutOk = aboutHits.length === 0 && about.title.length > 0
if (!aboutOk) failures++
results.push({ name: 'desk-about', route: '/app (About dialog)', title: about.title, ok: aboutOk, blocking: aboutHits })
log(`${aboutOk ? 'PASS' : 'FAIL'}  desk-about       —    "${about.title}"  text:${aboutHits.length}`)
if (!aboutOk) log(`        ${JSON.stringify(aboutHits.slice(0, 4))}`)
await deskPage.close()
await staff.close()

// -------------------------------------------------------------------- headers + probes
log('\n— HTTP surface —')
const probe = await browser.newContext({ baseURL: BASE, locale: LOCALE })
const head = await probe.request.get('/')
const headers = head.headers()
const headerHits = Object.entries(headers)
  .filter(([k, v]) => NEEDLES.some((n) => k.toLowerCase().includes(n.toLowerCase()) || String(v).toLowerCase().includes(n.toLowerCase())))
  .filter(([k]) => k.toLowerCase() !== 'link') // asset preload list — the same allowed asset paths
const headersOk = headerHits.length === 0
if (!headersOk) failures++
log(`${headersOk ? 'PASS' : 'FAIL'}  headers          server="${headers.server}"  hits:${JSON.stringify(headerHits)}`)
results.push({ name: 'headers', server: headers.server, ok: headersOk, blocking: headerHits })

const ping = await probe.request.get('/api/method/frappe.ping')
log(`NOTE  /api/method/frappe.ping -> ${ping.status()} ${(await ping.text()).trim()} (framework method path — upstream, see docs/white-label.md)`)
await probe.close()

await browser.close()

writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify(results, null, 1))
log(`\n${results.length} checks, ${failures} failing. Screenshots + report.json in e2e/shots-whitelabel/`)
process.exit(failures ? 1 : 0)
