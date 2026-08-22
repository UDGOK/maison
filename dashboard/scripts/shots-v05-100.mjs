/** v0.5 L — 100-boutique mock wall (VITE_MOCK=1 VITE_MOCK_BOUTIQUES=100 npx vite --port 5199 --strictPort): proves virtualisation. */
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const BASE = process.env.BASE || 'http://127.0.0.1:5199/assets/maison_pos/dashboard/'
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots', 'v05')
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage()
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-testid="live-cards"] .bcard', { timeout: 30000 })
await page.waitForTimeout(1500)
const dom = await page.locator('[data-testid="live-cards"] .bcard').count()
const total = await page.locator('.toolbar .count').textContent()
console.log(`${dom < 40 ? 'PASS' : 'FAIL'}  virtualised: ${dom} DOM rows for ${total?.trim()} boutiques`)
await page.screenshot({ path: path.join(out, 'live-100-boutiques-1920x1080.png') })
await page.locator('.vlist').first().evaluate((el) => el.scrollTo(0, el.scrollHeight))
await page.waitForTimeout(300)
const first = await page.locator('[data-testid="live-cards"] .bcard .idx').first().textContent()
console.log(`${Number(first) > 60 ? 'PASS' : 'FAIL'}  scrolled window starts at row ${first}`)
await page.screenshot({ path: path.join(out, 'live-100-boutiques-scrolled-1920x1080.png') })
await browser.close()
