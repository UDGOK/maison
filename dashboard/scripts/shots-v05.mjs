/**
 * v0.5 L — screenshots of every Command tab at 1920×1080 and 3840×2160 (deviceScaleFactor 1)
 * against the live bench with the seeded history.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin \
 *     node dashboard/scripts/shots-v05.mjs
 */
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots', 'v05')
mkdirSync(out, { recursive: true })
const SIZES = [
  { tag: '1920x1080', width: 1920, height: 1080 },
  { tag: '3840x2160', width: 3840, height: 2160 },
]
const TABS = [
  { view: 'live', wait: '[data-testid="live-cards"] .bcard' },
  { view: 'boutiques', wait: '[data-testid="boutiques-table"] .row.data' },
  { view: 'products', wait: '[data-testid="trending"] .row[data-item]' },
  { view: 'products', sub: 'top', wait: '[data-testid="top-by-store"] .li' },
  { view: 'clients', wait: '.clients .churn .li' },
  { view: 'insights', wait: 'text=Revenue · item group × boutique' },
  { view: 'reports', wait: '.reports' },
]
const results = []
const browser = await chromium.launch()
for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const login = await page.request.post(`${BASE}/api/method/login`, { data: ADMIN })
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`)
  for (const t of TABS) {
    const url = `${BASE}/maison-dashboard?view=${t.view}${t.sub ? '&sub=' + t.sub : ''}`
    const t0 = Date.now()
    await page.goto(url, { waitUntil: 'networkidle' })
    let ok = true
    try {
      await page.waitForSelector(t.wait, { timeout: 30000 })
    } catch {
      ok = false
    }
    await page.waitForTimeout(900)
    const file = `${t.view}${t.sub ? '-' + t.sub : ''}-${size.tag}.png`
    await page.screenshot({ path: path.join(out, file) })
    results.push({ tab: t.view + (t.sub ? '/' + t.sub : ''), size: size.tag, ok, ms: Date.now() - t0, file })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${file} (${Date.now() - t0} ms)`)
  }
  if (errors.length) console.log('page errors:', errors.slice(0, 5))
  results.push({ size: size.tag, pageErrors: errors.length })
  await ctx.close()
}
await browser.close()
writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
