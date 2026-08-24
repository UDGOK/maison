// Playwright screenshot run against `VITE_MOCK=1 npm run dev`.
// Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node screenshots/shoot.mjs
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE || 'http://localhost:5173'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = (name) => page.screenshot({ path: path.join(dir, name + '.png') })
const wait = (ms) => page.waitForTimeout(ms)

await page.goto(BASE + '/unlock')
await page.waitForSelector('select.input')
await wait(1200) // fonts + boutique list
// Load boutique if needed
const loadBtn = page.getByRole('button', { name: /^Load/ })
if (await loadBtn.count()) {
  await loadBtn.click()
  await page.waitForSelector('.keypad', { timeout: 10000 })
}
await wait(500)
await shot('01-unlock')

// PIN 1234
for (const d of ['1', '2', '3', '4']) await page.locator('.keypad .key', { hasText: d }).first().click()
await page.waitForURL('**/sell', { timeout: 8000 })
await wait(800)
await shot('02-sell-empty')

// add items: serialized (single serial) + a qty item + a multi-serial one
await page.locator('.tile', { hasText: 'Chronograph 41mm Steel' }).click()
await wait(300)
if (await page.locator('.serial-btn').count()) {
  await page.locator('.serial-btn').first().click()
}
await page.locator('.tile', { hasText: 'Diamond Studs 1ct tw' }).click()
await page.locator('.tile', { hasText: 'Diamond Studs 1ct tw' }).click()
await page.locator('.tile', { hasText: 'Jewelry Cleaning Kit' }).click()
await wait(300)
// attach a client
await page.locator('.client').click()
await page.waitForSelector('.crow')
await page.locator('.crow', { hasText: 'Amara Okonkwo' }).click()
await wait(600)
await shot('03-client')
await page.getByRole('button', { name: 'Attach to sale' }).click()
await page.waitForURL('**/sell')
await wait(400)
// filter to Watches rail for a representative grid
await page.locator('.rail-btn', { hasText: 'Watches' }).click()
await wait(300)
await shot('04-sell-basket')

// Card flow
await page.locator('.pay .btn', { hasText: 'Card' }).click()
await page.waitForURL('**/pay?mode=card')
await wait(400)
await shot('05-pay-card-ready')
await page.getByRole('button', { name: /^Charge/ }).click()
await wait(2600)
await shot('06-pay-card-collecting')
await page.waitForURL('**/receipt/**', { timeout: 20000 })
await wait(1500)
await shot('07-receipt')

// Cash flow for a second sale
await page.getByRole('button', { name: 'Done' }).click()
await page.waitForURL('**/sell')
await page.locator('.rail-btn', { hasText: 'All' }).click()
await page.locator('.tile', { hasText: 'Signet Onyx' }).click()
await page.locator('.pay .btn', { hasText: 'Cash' }).click()
await page.waitForURL('**/pay?mode=cash')
await page.locator('.keypad .key', { hasText: '2' }).first().click()
for (const d of ['1', '0', '0']) await page.locator('.keypad .key', { hasText: d }).first().click()
await wait(300)
await shot('08-pay-cash')
await page.getByRole('button', { name: 'Complete cash sale' }).click()
await page.waitForURL('**/receipt/**')
await wait(1200)

// Offline scenario: flip the mock offline, sell, and show the queued state
await page.getByRole('button', { name: 'Done' }).click()
await page.waitForURL('**/sell')
await page.evaluate(() => { window.__awanzOffline = true })
await wait(5500) // replay tick notices the flag
await page.locator('.tile', { hasText: 'Akoya Pearl Studs' }).click()
await page.locator('.pay .btn', { hasText: 'Cash' }).click()
await page.waitForURL('**/pay?mode=cash')
await page.getByRole('button', { name: 'Complete cash sale' }).click()
await page.waitForURL('**/receipt/**')
await wait(800)
await shot('12-receipt-offline')
await page.getByRole('button', { name: 'Done' }).click()
await page.waitForURL('**/sell')
await wait(300)
await shot('13-sell-offline')
await page.evaluate(() => { window.__awanzOffline = false })
await wait(16000) // probe heartbeat -> replay
await shot('14-sell-recovered')

await page.goto(BASE + '/queue')
await wait(1000)
await shot('09-queue')
await page.goto(BASE + '/shift')
await wait(1000)
await shot('10-shift')
await page.goto(BASE + '/settings')
await wait(800)
await shot('11-settings')

await browser.close()
if (errors.length) {
  console.log('CONSOLE/PAGE ERRORS:\n' + errors.join('\n'))
} else console.log('no page errors')
