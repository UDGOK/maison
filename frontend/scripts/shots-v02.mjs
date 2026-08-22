// Playwright screenshots of the v0.2 POS in mock mode (VITE_MOCK=1 npm run dev on :5173).
// PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/shots-v02.mjs
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5173'
const OUT = resolve(process.env.OUT || 'screenshots/v02')
mkdirSync(OUT, { recursive: true })

const profiles = {
  desktop: { viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1 },
  iphone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  }
}

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
})

for (const [name, opts] of Object.entries(profiles)) {
  const ctx = await browser.newContext({ ...opts, permissions: ['camera'], colorScheme: 'dark' })
  // Sandbox: Chromium's own TLS is reset by the egress proxy; fetch Google Fonts from Node instead.
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    try {
      const r = await fetch(route.request().url(), { headers: { 'user-agent': opts.userAgent || 'Mozilla/5.0 Chrome/120' } })
      route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || '' }, body: Buffer.from(await r.arrayBuffer()) })
    } catch (e) {
      route.abort()
    }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message))
  page.on('console', (m) => m.type() === 'error' && console.log(`[${name}] console.error`, m.text()))
  const shot = async (file) => {
    await page.waitForTimeout(350)
    await page.screenshot({ path: resolve(OUT, `${name}-${file}.png`) })
    console.log(name, file)
  }

  // fresh device: clear IndexedDB / storage from any previous run
  await page.goto(`${BASE}/unlock`)
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
  })
  await page.goto(`${BASE}/unlock`)
  await page.waitForSelector('select.input')
  await page.selectOption('select.input', 'CHI-OAK')
  await page.click('button:has-text("Load")')
  await page.waitForSelector('.keypad', { timeout: 15000 })
  await page.evaluate(() => document.fonts.ready)
  await shot('01-unlock')

  // PIN 1234 (manager)
  for (const k of ['1', '2', '3', '4']) await page.click(`.keypad .key:text-is("${k}")`)
  await page.waitForURL(/\/sell/)
  await page.waitForSelector('.tile')
  await page.waitForTimeout(600)
  await shot('02-sell-images-on')

  await page.click('button[aria-label="Toggle product photos"]')
  await page.waitForTimeout(300)
  await shot('03-sell-images-off')
  await page.click('button[aria-label="Toggle product photos"]')

  // add two items
  await page.click('.tile:has-text("Signet Onyx")')
  await page.click('.tile:has-text("Hinged Bangle")')
  await page.waitForTimeout(200)

  // scanner sheet (fake camera)
  await page.click('button[aria-label="Scan barcode or QR"]')
  await page.waitForSelector('.scanner')
  await page.waitForTimeout(1800)
  await shot('04-scanner')
  // type a barcode in the manual entry → adds "Solitaire Round 1.02ct" serial (first serial of RG-SOL-001)
  await page.fill('.scanner .manual .input', 'CHI00101')
  await page.click('.scanner .manual button[type=submit]')
  await page.waitForTimeout(500)
  if (await page.$('.scanner')) await page.click('.scanner .close')

  // client card with keypad
  if (name === 'iphone') {
    await page.click('.summary-bar')
    await page.waitForTimeout(300)
  }
  await page.click('#client-no')
  await page.waitForSelector('.cn-pad')
  await shot('05-client-card-keypad')
  for (const k of ['4', '8', '9', '7', '7', '5']) await page.click(`.cn-pad .key:text-is("${k}")`)
  await page.click('.cn-btn.go')
  await page.waitForSelector('.client-no', { timeout: 8000 })
  // dismiss lingering notices, then redeem toggle
  await page.evaluate(() => document.querySelectorAll('.notice-btn:last-child').forEach((b) => b.click()))
  const redeem = await page.$('.redeem:not([disabled])')
  if (redeem) await redeem.click()
  await page.waitForTimeout(200)
  await shot('06-client-attached')

  // manager tile edit sheet
  if (name === 'desktop') {
    await page.click('.tile-wrap:has-text("Signet Onyx") .edit')
    await page.waitForSelector('.modal')
    await shot('07-image-sheet')
    await page.click('.modal .close')
  }

  // pay (cash)
  await page.click('.pay .btn:has-text("Cash")')
  await page.waitForURL(/\/pay/)
  await page.waitForTimeout(300)
  await shot('08-pay')
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForURL(/\/receipt\//)
  await page.waitForSelector('.pill:has-text("Synced")', { timeout: 15000 })
  await page.waitForSelector('.r-qr img', { timeout: 8000 })
  await page.evaluate(() => document.querySelectorAll('.notice-btn:last-child').forEach((b) => b.click()))
  await page.waitForTimeout(400)
  await shot('09-receipt-qr')
  if (name === 'iphone') {
    await page.evaluate(() => document.querySelector('.preview')?.scrollIntoView())
    await page.waitForTimeout(300)
    await shot('09b-receipt-qr-preview')
  }

  // client screen
  await page.goto(`${BASE}/client`)
  await page.waitForSelector('.cn-input')
  await page.waitForTimeout(500)
  await shot('10-client')

  // settings
  await page.goto(`${BASE}/settings`)
  await page.waitForSelector('.check.soon')
  await page.waitForTimeout(300)
  await shot('11-settings')

  if (name === 'iphone') {
    await page.goto(`${BASE}/sell`)
    await page.waitForSelector('.tile')
    await page.click('button[aria-label="Menu"]')
    await page.waitForSelector('.drawer')
    await shot('12-nav-drawer')
  }
  await ctx.close()
}
await browser.close()
