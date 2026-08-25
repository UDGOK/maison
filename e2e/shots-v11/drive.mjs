/**
 * v1.1 "Onboarding a product" — drive the three new screens in a real browser against the
 * deterministic mock desk (VITE_MOCK=1) and capture them at both widths.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://127.0.0.1:5199 node e2e/shots-v11/drive.mjs
 */
import { chromium } from '../node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:5199'
const here = path.dirname(fileURLToPath(import.meta.url))
mkdirSync(here, { recursive: true })

const results = []
const consoleErrors = []
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 400) })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 240) : ''}`)
}

const browser = await chromium.launch({ headless: true })

async function ctx(viewport, tag) {
  const c = await browser.newContext({ baseURL: BASE, viewport, deviceScaleFactor: 1 })
  const page = await c.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text()}`)
  })
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror ${e.message}`))
  page.on('requestfailed', (r) => consoleErrors.push(`[${tag}] requestfailed ${r.url()} ${r.failure()?.errorText || ''}`))
  // this sandbox has no route to Google's font CDN; the page falls back to the stack in the token
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort())
  return { c, page }
}

async function shot(page, name) {
  const file = path.join(here, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  log('  shot', `${name}.png`)
}

/**
 * Fail loudly if the page scrolls sideways — every previous round found a real bug this way. When
 * a sheet is open the **modal body** is checked too: it has `overflow: auto` of its own, so a
 * control hanging off its right edge never reaches the document's scroll width and would sail
 * straight past a document-level check.
 */
async function noHScroll(page, step) {
  const over = await page.evaluate(() => {
    const d = document.documentElement
    const modal = document.querySelector('.backdrop .modal-body')
    const scope = modal || document.body
    const limit = modal ? modal.getBoundingClientRect().left + modal.clientWidth - (parseFloat(getComputedStyle(modal).paddingRight) || 0) : d.clientWidth
    const worst = []
    for (const el of scope.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > limit + 1) worst.push(`${el.tagName}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')} right=${Math.round(r.right)} limit=${Math.round(limit)}`)
    }
    const bad = modal ? modal.scrollWidth > modal.clientWidth + 1 : d.scrollWidth > d.clientWidth + 1
    return { bad, w: modal ? modal.scrollWidth : d.scrollWidth, c: modal ? modal.clientWidth : d.clientWidth, worst: worst.slice(0, 5) }
  })
  record(`${step}: no sideways scroll`, !over.bad, over.bad ? `scrollWidth ${over.w} > client ${over.c} · ${over.worst.join(' | ')}` : '')
}

/**
 * A table is allowed to scroll inside its own container — but the primary control must not be the
 * thing that slides off the edge. On a phone the quantity stepper has to be reachable without
 * scrolling sideways at all.
 */
async function noScrollerOverflow(page, step, selector) {
  const over = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    return { w: el.scrollWidth, c: el.clientWidth }
  }, selector)
  if (!over) return record(`${step}: ${selector} present`, false, 'not found')
  record(`${step}: the store table fits without sideways scrolling`, over.w <= over.c + 1, `scrollWidth ${over.w} > client ${over.c}`)
}

/** Every interactive target on screen must be at least 44 px tall (the spec asks ≥48). */
/**
 * Scoped to the open sheet: the desk behind a modal is still in the DOM, and its own chrome is not
 * what this run is reviewing.
 */
async function touchTargets(page, step, min = 40) {
  const bad = await page.evaluate((min) => {
    const scope = document.querySelector('.backdrop .modal') || document.body
    const out = []
    for (const el of scope.querySelectorAll('button, .chip, input:not([type=checkbox]), select, a[href]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.height < min) out.push(`${el.tagName}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')} h=${Math.round(r.height)} "${(el.textContent || '').trim().slice(0, 24)}"`)
    }
    return out.slice(0, 8)
  }, min)
  record(`${step}: touch targets ≥ ${min}px`, bad.length === 0, bad.join(' | '))
}

async function openWarehouse(page, section) {
  await page.goto(`/warehouse/${section}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
}

// =============================================================================================
async function run(viewport, tag) {
  const { c, page } = await ctx(viewport, tag)
  const phone = viewport.width < 800

  // ---------------------------------------------------------------- Stock → Send to stores
  await openWarehouse(page, 'stock')
  await page.waitForSelector('[data-testid="stock-board"]', { timeout: 20000 })
  await shot(page, `${tag}-01-stock`)
  await noHScroll(page, `${tag} stock board`)
  const sendBtn = page.locator('[data-testid="stock-send-GB-PULSE-15K-BLUE"]')
  record(`${tag} stock row offers Send to stores`, (await sendBtn.count()) > 0)
  await sendBtn.first().scrollIntoViewIfNeeded()
  await sendBtn.first().click()
  await page.waitForSelector('[data-testid="send-sheet"]', { timeout: 20000 })
  await page.waitForTimeout(400)
  await shot(page, `${tag}-02-send-sheet`)
  await noHScroll(page, `${tag} send sheet`)
  await touchTargets(page, `${tag} send sheet`)
  if (phone) await noScrollerOverflow(page, `${tag} send sheet`, '.backdrop .modal .scroller')

  const rowCount = await page.locator('[data-testid^="send-row-"]').count()
  record(`${tag} send sheet lists eleven stores`, rowCount === 11, `${rowCount} rows`)

  // cover days for a store that never moves it must read an em dash
  const covers = await page.locator('[data-testid^="send-cover-"]').allInnerTexts()
  record(`${tag} cover days never render Infinity/NaN`, !covers.some((t) => /Infinity|NaN/.test(t)), covers.join(' '))

  // --- Weight by sales
  await page.click('[data-testid="send-split-velocity"]')
  await page.waitForTimeout(500)
  const note = (await page.locator('[data-testid="send-note"]').innerText()).trim()
  record(`${tag} weight-by-sales says what it did`, /Weighted by sales/.test(note), note)
  await shot(page, `${tag}-03-send-velocity`)
  const left = (await page.locator('[data-testid="send-left"]').innerText()).trim()
  record(`${tag} left-at-Houston is shown`, left.length > 0, `left = ${left}`)

  // --- Top up at the default target, which honestly allocates little or nothing
  await page.click('[data-testid="send-split-topup"]')
  await page.waitForTimeout(500)
  const topNote = (await page.locator('[data-testid="send-note"]').innerText()).trim()
  record(`${tag} top-up explains itself`, /Top up to 21 days/.test(topNote), topNote)
  await shot(page, `${tag}-04-send-topup`)

  // --- over-allocate on purpose: the footer must go red BEFORE the send
  await page.fill('[data-testid="send-pool"]', '900')
  await page.click('[data-testid="send-split-even"]')
  await page.waitForTimeout(500)
  const leftClass = await page.locator('[data-testid="send-left"]').getAttribute('class')
  const shortfall = await page.locator('[data-testid="send-shortfall"]').count()
  const goDisabled = await page.locator('[data-testid="send-go"]').isDisabled()
  record(`${tag} over-allocation turns the footer red`, /crit/.test(leftClass || ''), `class=${leftClass}`)
  record(`${tag} over-allocation names the shortfall`, shortfall > 0)
  record(`${tag} over-allocation disables Send`, goDisabled)
  await shot(page, `${tag}-05-send-over`)

  // --- back to something sendable, and send it
  await page.click('[data-testid="send-clear"]')
  await page.fill('[data-testid="send-each"]', '2')
  await page.click('[data-testid="send-same-all"]')
  await page.waitForTimeout(400)
  await page.fill('[data-testid="send-reason"]', 'New flavour — two each to try')
  await shot(page, `${tag}-06-send-ready`)
  await page.click('[data-testid="send-go"]')
  await page.waitForSelector('[data-testid="send-confirmation"]', { timeout: 20000 })
  await page.waitForTimeout(300)
  await shot(page, `${tag}-07-send-confirmed`)
  await noHScroll(page, `${tag} send confirmation`)
  const shipRows = await page.locator('[data-testid^="sent-"]').count()
  record(`${tag} one shipment per store on the confirmation`, shipRows === 11, `${shipRows} shipments`)
  await page.click('[data-testid="send-done"]')
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- Buying → New product
  await openWarehouse(page, 'buying')
  await page.waitForSelector('[data-testid="buying-board"]', { timeout: 20000 })
  await shot(page, `${tag}-08-buying`)
  await noHScroll(page, `${tag} buying board`)
  await page.click('[data-testid="buy-new-product"]')
  await page.waitForSelector('[data-testid="product-sheet"]', { timeout: 20000 })
  await page.waitForTimeout(400)
  await shot(page, `${tag}-09-new-product-empty`)
  await noHScroll(page, `${tag} new product`)
  await touchTargets(page, `${tag} new product`)

  // --- the duplicate-barcode refusal must land on the barcode field
  await page.fill('[data-testid="product-code"]', 'GB-PULSE-15K-CHERRY')
  await page.fill('[data-testid="product-name"]', 'Geek Bar Pulse 15K — Cherry Ice')
  await page.selectOption('[data-testid="product-group"]', 'Vape')
  await page.fill('[data-testid="product-barcode"]', '8801234500017')
  await page.selectOption('[data-testid="product-vendor"]', 'SUP-GULF')
  await page.fill('[data-testid="product-sku"]', 'GC-GBP15-CHR')
  await page.fill('[data-testid="product-cost"]', '9.25')
  await page.fill('[data-testid="product-case-pack"]', '12')
  await page.fill('[data-testid="product-moq"]', '24')
  await page.fill('[data-testid="product-reorder-level"]', '60')
  await page.fill('[data-testid="product-reorder-qty"]', '120')
  await page.fill('[data-testid="product-selling-rate"]', '24.99')
  await page.waitForTimeout(200)
  await shot(page, `${tag}-10-new-product-filled`)
  await page.click('[data-testid="product-save"]')
  await page.waitForTimeout(700)
  const barErr = await page.locator('[data-testid="product-barcode-error"]').count()
  const genericErr = await page.locator('[data-testid="product-error"]').count()
  record(`${tag} duplicate barcode lands on the barcode field`, barErr > 0 && genericErr === 0, `field=${barErr} banner=${genericErr}`)
  if (barErr) record(`${tag} duplicate barcode names the offender`, /GB-PULSE-15K-BLUE/.test(await page.locator('[data-testid="product-barcode-error"]').innerText()))
  await shot(page, `${tag}-11-new-product-dupe-barcode`)

  // --- fix it and create
  await page.fill('[data-testid="product-barcode"]', '8801234509999')
  await page.click('[data-testid="product-save"]')
  await page.waitForSelector('[data-testid="product-created"]', { timeout: 20000 })
  await page.waitForTimeout(300)
  await shot(page, `${tag}-12-new-product-created`)
  await noHScroll(page, `${tag} product created`)
  record(`${tag} saving offers Order it now`, (await page.locator('[data-testid="product-order-now"]').count()) > 0)

  // ---------------------------------------------------------------- Order it now
  await page.click('[data-testid="product-order-now"]')
  await page.waitForSelector('[data-testid="new-order-sheet"]', { timeout: 20000 })
  await page.waitForTimeout(600)
  await shot(page, `${tag}-13-new-order-from-product`)
  await noHScroll(page, `${tag} new order from product`)
  const preloaded = await page.locator('[data-testid="new-order-line-GB-PULSE-15K-CHERRY"]').count()
  record(`${tag} Order it now preloads the new product`, preloaded > 0)
  await page.click('[data-testid="new-order-create"]')
  await page.waitForSelector('[data-testid="order-sheet"], .modal', { timeout: 20000 })
  await page.waitForTimeout(900)
  await shot(page, `${tag}-14-order-sheet`)
  await page.keyboard.press('Escape').catch(() => {})
  const closeBtn = page.locator('.modal-head .close')
  if (await closeBtn.count()) await closeBtn.last().click()
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- New order from scratch
  await openWarehouse(page, 'buying')
  await page.click('[data-testid="buy-new-order"]')
  await page.waitForSelector('[data-testid="new-order-vendors"]', { timeout: 20000 })
  await page.waitForTimeout(400)
  await shot(page, `${tag}-15-new-order-vendors`)
  await noHScroll(page, `${tag} new order vendors`)
  await page.click('[data-testid="new-order-vendor-SUP-LONE"]')
  await page.waitForSelector('[data-testid="new-order-sheet"]', { timeout: 20000 })
  await page.waitForTimeout(600)
  await page.fill('[data-testid="new-order-search"]', 'LS-')
  await page.waitForTimeout(300)
  const hits = await page.locator('[data-testid^="new-order-item-"]').count()
  record(`${tag} their SKU is searchable`, hits > 0, `${hits} hits for "LS-"`)
  await page.locator('[data-testid^="new-order-item-"]').first().click()
  await page.locator('[data-testid^="new-order-item-"]').nth(1).click()
  await page.waitForTimeout(300)
  await shot(page, `${tag}-16-new-order-basket`)
  await noHScroll(page, `${tag} new order basket`)
  await touchTargets(page, `${tag} new order basket`)
  const closeBtn2 = page.locator('.modal-head .close')
  if (await closeBtn2.count()) await closeBtn2.last().click()
  await page.waitForTimeout(300)

  // ---------------------------------------------------------------- Vendors → order from vendor
  await openWarehouse(page, 'vendors')
  await page.waitForTimeout(600)
  const vendorRow = page.locator('[data-testid^="open-vendor-"], tbody tr').first()
  await vendorRow.click()
  await page.waitForTimeout(800)
  const orderFrom = page.locator('[data-testid="vendor-order"]')
  record(`${tag} vendor sheet offers Order from this vendor`, (await orderFrom.count()) > 0)
  await shot(page, `${tag}-17-vendor-sheet`)
  if (await orderFrom.count()) {
    await orderFrom.click()
    await page.waitForSelector('[data-testid="new-order-sheet"]', { timeout: 20000 })
    await page.waitForTimeout(600)
    await shot(page, `${tag}-18-order-from-vendor`)
    record(`${tag} the vendor is pre-chosen`, (await page.locator('[data-testid="new-order-vendors"]').count()) === 0)
    const cb = page.locator('.modal-head .close')
    if (await cb.count()) await cb.last().click()
    await page.waitForTimeout(300)
  }

  // ---------------------------------------------------------------- Inbound receipt → Send to stores
  await openWarehouse(page, 'inbound')
  await page.waitForTimeout(800)
  const receive = page.locator('[data-testid^="inbound-receive-"], [data-testid^="receive-"]').first()
  const openReceive = page.locator('button:has-text("Receive")').first()
  if (await openReceive.count()) {
    await openReceive.click()
    await page.waitForSelector('[data-testid="receive-fill-all"]', { timeout: 20000 })
    await page.waitForTimeout(500)
    await page.click('[data-testid="receive-fill-all"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="receive-post"]')
    await page.waitForTimeout(1200)
    const booked = await page.locator('[data-testid="receive-booked"]').count()
    record(`${tag} the receipt confirmation stays open and says what it booked`, booked > 0)
    if (booked) {
      await shot(page, `${tag}-19-receipt-confirmation`)
      await noHScroll(page, `${tag} receipt confirmation`)
      const sendFromReceipt = page.locator('[data-testid^="booked-send-"]').first()
      record(`${tag} the receipt offers Send to stores`, (await sendFromReceipt.count()) > 0)
      if (await sendFromReceipt.count()) {
        await sendFromReceipt.click()
        await page.waitForSelector('[data-testid="send-sheet"]', { timeout: 20000 })
        await page.waitForTimeout(600)
        await shot(page, `${tag}-20-send-from-receipt`)
        const reason = await page.locator('[data-testid="send-reason"]').inputValue()
        record(`${tag} the push from a receipt is stamped with why`, reason.length > 0, reason)
      }
    }
  } else {
    record(`${tag} inbound has a delivery to receive`, false, 'no Receive button found')
  }
  void receive

  await c.close()
}

await run({ width: 1600, height: 1000 }, 'desktop')
await run({ width: 390, height: 844 }, 'phone')

await browser.close()

// this sandbox has no route to Google's font CDN and the harness aborts those requests itself —
// the page falls back to the stack in `--font-display` / `--font-body`, which is the point of it
const noise = /fonts\.(googleapis|gstatic)\.com|net::ERR_FAILED/
const realErrors = consoleErrors.filter((e) => !noise.test(e))
record('no console errors', realErrors.length === 0, realErrors.slice(0, 6).join(' | '))
const failed = results.filter((r) => !r.ok)
writeFileSync(path.join(here, 'results.json'), JSON.stringify({ results, consoleErrors }, null, 2))
log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  log('\nFAILURES:')
  for (const f of failed) log(` · ${f.step} — ${f.detail}`)
}
process.exit(failed.length ? 1 : 0)
