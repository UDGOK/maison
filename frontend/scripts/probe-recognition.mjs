// Probe: does on-device detection work against the fake camera video?
// PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/probe-recognition.mjs [video.mjpeg]
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { resolve } from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5173'
const VIDEO = resolve(process.argv[2] || 'e2e-assets/face_a.mjpeg')

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
})
const ctx = await browser.newContext({ viewport: { width: 1366, height: 1024 }, permissions: ['camera'] })
await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
const page = await ctx.newPage()
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('console', m.type(), m.text().slice(0, 200)))
page.on('pageerror', (e) => console.log('pageerror', e.message))

await page.goto(`${BASE}/unlock`)
await page.evaluate(async () => {
  localStorage.clear()
  localStorage.setItem('awanzE2E', '1')
  const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
  await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
})
await page.goto(`${BASE}/unlock`)
await page.waitForSelector('select.input')
await page.selectOption('select.input', 'CHI-OAK')
await page.click('button:has-text("Load")')
await page.waitForSelector('.keypad', { timeout: 15000 })
for (const k of ['1', '2', '3', '4']) await page.click(`.keypad .key:text-is("${k}")`)
await page.waitForURL(/\/sell/)
await page.waitForSelector('[data-testid=recognition-tile]')

// go to settings test mode for the debug readout
await page.goto(`${BASE}/settings`)
await page.click('[data-testid=recognition-test]')
await page.waitForSelector('[data-testid=recognition-test-panel]')
const t0 = Date.now()
let lastLine = ''
while (Date.now() - t0 < 40000) {
  await page.waitForTimeout(1000)
  const s = await page.evaluate(() => {
    const st = window.__awanzRecognitionTest?.state()
    const panel = document.querySelector('[data-testid=recognition-test-panel]')
    const kv = [...(panel?.querySelectorAll('.test-status .kv') || [])].map((e) => e.textContent.replace(/\s+/g, ' ').trim())
    const log = [...(panel?.querySelectorAll('.test-log .small') || [])].map((e) => e.textContent.trim())
    const chip = document.querySelector('[data-testid=recognition-state]')?.textContent.trim()
    return { tile: st?.tile, chip, kv, log: log.slice(0, 3) }
  })
  const line = JSON.stringify(s)
  if (line !== lastLine) console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', line)
  lastLine = line
  if (s.log.length && !s.log[0].startsWith('Waiting')) break
}
await browser.close()
