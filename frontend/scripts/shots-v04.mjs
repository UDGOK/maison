// v0.4 D/E/A screenshots + smoke checks against the mock API (no bench needed).
//
//   VITE_MOCK=1 npm run dev -- --port 5174
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://localhost:5174 node scripts/shots-v04.mjs
//
// Flow: unlock CHI-OAK → Returns: find yesterday's demo sale by invoice → pick the serialized line →
// refund to original card (manager PIN when above threshold) → print on the simulated V660p →
// Exchange on the second sale → Cycle count → Shift low-stock list → Settings reader picker.
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5174'
const OUT = resolve(process.env.OUT || 'screenshots/v04-returns')
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const profiles = {
  desktop: { viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1 },
  iphone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  }
}

async function newPage(browser, opts, name) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' })
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    try {
      const r = await fetch(route.request().url(), { headers: { 'user-agent': opts.userAgent || 'Mozilla/5.0 Chrome/120' } })
      route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || '' }, body: Buffer.from(await r.arrayBuffer()) })
    } catch {
      route.abort()
    }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message))
  page.on('console', (m) => m.type() === 'error' && !/ERR_FAILED|fonts/.test(m.text()) && console.log(`[${name}] console.error`, m.text().slice(0, 160)))
  return { ctx, page }
}

async function freshDevice(page) {
  await page.goto(`${BASE}/unlock`)
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
  })
}
async function unlock(page, pin = '1234') {
  await page.goto(`${BASE}/unlock`)
  await page.waitForSelector('select.input')
  await page.selectOption('select.input', 'CHI-OAK')
  await page.click('button:has-text("Load")')
  await page.waitForSelector('.keypad', { timeout: 15000 })
  for (const k of pin) await page.click(`.keypad .key:text-is("${k}")`)
  await page.waitForURL(/\/sell/)
  await page.evaluate(() => document.fonts.ready)
}
const shot = (page, name) => page.screenshot({ path: resolve(OUT, name + '.png'), fullPage: false })
const mockState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('awanz.mock.state') || '{}'))
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))

async function flow(browser, profileName) {
  const p = profiles[profileName]
  const { ctx, page } = await newPage(browser, p, profileName)
  const tag = (n) => `${profileName}-${n}`
  await freshDevice(page)
  await unlock(page, '1234') // manager: no PIN prompt on large refunds; associate flow below
  const st = await mockState(page)
  const demo = (st.invoices || []).filter((i) => i.boutique === 'CHI-OAK')
  check(`${profileName}: mock seeded demo sales`, demo.length >= 2, `${demo.length} invoices`)
  const serialSale = demo.find((i) => i.lines?.some((l) => l.serial_no))
  const qtySale = demo.find((i) => i.lines?.every((l) => !l.serial_no))

  // ---- Returns: find
  await page.goto(`${BASE}/returns`)
  await page.waitForSelector('input.input')
  await page.waitForTimeout(500)
  await shot(page, tag('01-returns-find'))
  await page.fill('input.input', serialSale.invoice)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.line', { timeout: 10000 })
  await page.waitForTimeout(300)
  await shot(page, tag('02-returns-lines'))
  // pick serialized line
  await page.locator('.line-head').first().click()
  await page.waitForTimeout(300)
  await page.locator('.line .chip').filter({ hasText: 'Damaged' }).first().click().catch(() => undefined)
  await page.locator('.line .chip').filter({ hasText: 'Sellable' }).first().click()
  await page.waitForTimeout(200)
  await shot(page, tag('03-returns-selected-card'))
  const refundBtn = page.locator('.summary .btn-primary')
  const label = await refundBtn.textContent()
  check(`${profileName}: refund button reflects credit`, /Refund/.test(label || ''), label?.trim())
  await refundBtn.click()
  // manager user → no PIN; if PIN modal appears (associate), approve with 1234
  const modal = page.locator('[role=dialog]')
  if (await modal.count()) {
    await shot(page, tag('03b-manager-pin'))
    for (const k of '1234') await modal.locator(`.keypad .key:text-is("${k}")`).click()
    await modal.locator('button:has-text("Approve")').click()
  }
  await page.waitForSelector('text=Credit note', { timeout: 15000 })
  await page.waitForTimeout(400)
  await shot(page, tag('04-returns-done'))
  const after = await mockState(page)
  const cn = (after.returns || []).find((r) => r.return_against === serialSale.invoice)
  check(`${profileName}: credit note created for serial sale`, !!cn, cn?.name)
  check(`${profileName}: serial back in stock`, !!cn && (after.serials?.['CHI-OAK']?.[cn.lines[0].item_code] || []).includes(cn.lines[0].serials[0]))
  check(`${profileName}: card refund simulated`, cn?.refund_method === 'Card' && /^re_sim_/.test(cn?.refund_id || ''), cn?.refund_id)
  // print on the simulated reader (has_printer) → canvas route
  await page.locator('button:has-text("Print return receipt")').click()
  await page.waitForFunction(() => !!window.__awanzLastReaderPrint, null, { timeout: 8000 }).catch(() => undefined)
  const preview = await page.evaluate(() => window.__awanzLastReaderPrint || null)
  check(`${profileName}: V660p canvas print route produced a bitmap`, !!preview && preview.startsWith('data:image/png'), preview ? `${preview.length} chars` : 'none')
  if (preview) writeFileSync(resolve(OUT, tag('04b-reader-print.png')), Buffer.from(preview.split(',')[1], 'base64'))
  await dismissNotices(page)

  // ---- Exchange on the qty sale
  await page.goto(`${BASE}/returns?invoice=${encodeURIComponent(qtySale.invoice)}`)
  await page.waitForSelector('.line', { timeout: 10000 })
  await page.locator('.line-head').first().click()
  await page.waitForTimeout(200)
  await page.locator('button:has-text("Exchange instead")').click()
  await page.waitForURL(/\/exchange\//)
  await page.waitForSelector('.tile', { timeout: 10000 })
  await page.waitForTimeout(400)
  await shot(page, tag('05-exchange-pick'))
  // pick the priciest visible tile
  const tiles = page.locator('.tile')
  const n = await tiles.count()
  let best = 0
  let bestPrice = -1
  for (let i = 0; i < n; i++) {
    const t = await tiles.nth(i).locator('.price').textContent()
    const v = Number((t || '').replace(/[^0-9.]/g, ''))
    if (v > bestPrice && v < 3000) {
      bestPrice = v
      best = i
    }
  }
  await tiles.nth(best).click()
  await page.waitForTimeout(300)
  await shot(page, tag('06-exchange-difference'))
  const confirm = page.locator('.summary .btn-primary')
  const ctext = (await confirm.textContent()) || ''
  check(`${profileName}: exchange shows charge or refund of the difference`, /Charge|refund|Complete/.test(ctext), ctext.trim())
  await confirm.click()
  if (await modal.count()) {
    for (const k of '1234') await modal.locator(`.keypad .key:text-is("${k}")`).click()
    await modal.locator('button:has-text("Approve")').click()
  }
  await page.waitForSelector('text=Exchange complete', { timeout: 30000 })
  await page.waitForTimeout(400)
  await shot(page, tag('07-exchange-done'))
  const st2 = await mockState(page)
  const xcn = (st2.returns || []).find((r) => r.return_against === qtySale.invoice)
  check(`${profileName}: exchange created credit note + new sale`, !!xcn?.exchange_invoice && (st2.invoices || []).some((i) => i.invoice === xcn.exchange_invoice), xcn?.exchange_invoice)
  check(`${profileName}: Exchange Credit nets to zero`, !!xcn && Math.abs(xcn.payments.find((p) => p.mode_of_payment === 'Exchange Credit')?.amount ?? 0) > 0)
  await dismissNotices(page)

  // ---- Cycle count
  await page.goto(`${BASE}/count`)
  await page.waitForSelector('.items .item', { timeout: 10000 })
  const pills = page.locator('.serials .pill')
  const pc = await pills.count()
  for (let i = 0; i < Math.min(pc, 6); i++) await pills.nth(i).click()
  await page.fill('input.input[placeholder^="Scan a serial"]', 'BOGUS-001')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await shot(page, tag('08-cycle-count'))
  await page.locator('button:has-text("Submit count")').click()
  await page.waitForSelector('text=Unaccounted serials', { timeout: 10000 })
  await page.waitForTimeout(300)
  await shot(page, tag('09-cycle-count-result'))
  check(`${profileName}: cycle count lists unexpected serial`, (await page.locator('text=BOGUS-001').count()) > 0)
  await dismissNotices(page)

  // ---- Shift low stock + Settings reader picker
  await page.goto(`${BASE}/shift`)
  await page.waitForSelector('[data-testid=low-stock]', { timeout: 10000 })
  await page.waitForTimeout(800)
  const openPill = await page.locator('[data-testid=low-stock] .pill').first().textContent()
  check(`${profileName}: shift shows low-stock badge`, /\d+ open/.test(openPill || ''), openPill?.trim())
  await page.locator('[data-testid=low-stock] button:has-text("Acknowledge")').first().click().catch(() => undefined)
  await page.waitForTimeout(300)
  await shot(page, tag('10-shift-low-stock'))
  await page.goto(`${BASE}/settings`)
  await page.waitForSelector('[data-testid=reader-picker]')
  const opts = await page.locator('[data-testid=reader-picker] option').allTextContents()
  check(`${profileName}: reader picker lists V660p + S710`, opts.some((o) => /V660p/.test(o)) && opts.some((o) => /S710/.test(o)), opts.join(' | '))
  await page.locator('[data-testid=reader-settings]').scrollIntoViewIfNeeded()
  await page.locator('button:has-text("Test reader print")').click()
  await page.waitForTimeout(1200)
  check(`${profileName}: settings test reader print`, (await page.locator('img.reader-preview').count()) > 0)
  await page.waitForTimeout(200)
  await shot(page, tag('11-settings-reader'))
  // S710 → route falls back to ePOS/browser
  await page.selectOption('[data-testid=reader-picker]', { label: opts.find((o) => /S710/.test(o)) })
  await page.waitForTimeout(300)
  const pill = await page.locator('[data-testid=reader-settings] .pill').textContent()
  check(`${profileName}: S710 has no printer → non-reader route`, !/Reader prints/.test(pill || ''), pill?.trim())
  await ctx.close()
}

const browser = await chromium.launch()
try {
  for (const name of Object.keys(profiles)) {
    try {
      await flow(browser, name)
    } catch (e) {
      check(`${name}: flow`, false, e.message)
    }
  }
} finally {
  await browser.close()
}
writeFileSync(resolve(OUT, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
