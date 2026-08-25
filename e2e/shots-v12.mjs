/**
 * v1.2 "What each store owes, and what each store charges" — the screens, driven in a real
 * browser against the mock desk (`VITE_MOCK=1`), at desk width and on a phone.
 *
 *   cd frontend && VITE_MOCK=1 npx vite --port 5178
 *   BASE=http://localhost:5178 node e2e/shots-v12.mjs
 *
 * Every round of this project has found real layout bugs this way — the last one found five — so
 * this is not a screenshot run, it is a check that happens to take screenshots. Each step asserts
 * something the spec asks for, and every viewport is checked for a body that scrolls sideways and
 * for a control that has slid off the right-hand edge.
 *
 *  §G  Outbound → New despatch: scan into a basket, one destination, the availability refusal,
 *      the internal footer, and *Send another*.
 *  §D  Stock → an item → Prices: every store's shelf price, its margin, a pending request that is
 *      not invited to ask twice, the reason the server requires, and the Approvals queue.
 *  §C  Prices → Statement: month end, marked internal, with the *not priced* consignments.
 *  §E  Buying: the row that cannot be ordered, what *Select all* says about it, **Add a vendor**
 *      on the row, and Vendors → Catalogue → **Add items**.
 */
import { chromium } from './node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5178'
const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(here, process.env.SHOTS_DIR || 'shots-v12')
mkdirSync(SHOTS, { recursive: true })

const results = []
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 400) })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 240) : ''}`)
}
const consoleNoise = []
const ENVIRONMENTAL = [/fonts\.(googleapis|gstatic)/i, /ERR_FAILED/i, /socket\.io/i]

const PROFILES = {
  desk: { key: 'desk', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 },
  phone: {
    key: 'phone',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  }
}

let shotN = 0
async function shot(page, tag, name) {
  const file = `${String(++shotN).padStart(2, '0')}-${tag}-${name}.png`
  await page.screenshot({ path: path.join(SHOTS, file) })
  log('  shot ' + file)
  return file
}

/** A page that scrolls sideways is a layout bug; so is a control hanging off the right edge. */
async function layout(page, tag, where, selectors = []) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }))
  record(`${tag}: ${where} does not scroll sideways`, overflow.scroll <= overflow.client + 1, `${overflow.scroll} vs ${overflow.client}`)
  for (const sel of selectors) {
    const bad = await page.evaluate((s) => {
      const w = window.innerWidth
      const out = []
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        // a control inside its own horizontal scroller is allowed to be off screen
        let scroller = el.parentElement
        let inScroller = false
        while (scroller && scroller !== document.body) {
          const st = getComputedStyle(scroller)
          if (st.overflowX === 'auto' || st.overflowX === 'scroll') {
            inScroller = true
            break
          }
          scroller = scroller.parentElement
        }
        if (inScroller) continue
        if (r.right > w + 1 || r.left < -1) out.push(`${el.getAttribute('data-testid') || el.className} right=${Math.round(r.right)} left=${Math.round(r.left)} w=${w}`)
      }
      return out
    }, sel)
    record(`${tag}: ${where} — ${sel} is on screen`, bad.length === 0, bad.join(' | '))
  }
}

/** ≥48 px touch targets, one-handed on a phone (the design system's `--touch`). */
async function touchTargets(page, tag, where, selector) {
  const small = await page.evaluate((s) => {
    const out = []
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.height < 40) out.push(`${el.getAttribute('data-testid') || el.textContent?.trim().slice(0, 24)} h=${Math.round(r.height)}`)
    }
    return out
  }, selector)
  record(`${tag}: ${where} — ${selector} targets are big enough`, small.length === 0, small.join(' | '))
}

const text = (page, sel) => page.locator(sel).first().innerText()
const seen = async (page, sel) => (await page.locator(sel).count()) > 0
/**
 * Monolith Gold renders most of its copy through `text-transform: uppercase`, and `innerText`
 * gives you what is *rendered*. Every copy check here is therefore case-insensitive — asserting
 * on the transformed text would be asserting on the stylesheet.
 */
const says = async (page, sel, re) => re.test(await text(page, sel))

async function open(page, tab) {
  await page.goto(`${BASE}/warehouse/${tab}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="warehouse-desk"]', { timeout: 20000 })
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(350)
}

// =============================================================================================
async function run(browser, profile) {
  const tag = profile.key
  const ctx = await browser.newContext({ ...profile, colorScheme: 'dark' })
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
  const page = await ctx.newPage()
  page.on('console', (m) => {
    const t = m.text().slice(0, 200)
    if (['error', 'warning'].includes(m.type()) && !ENVIRONMENTAL.some((re) => re.test(t))) consoleNoise.push({ tag, type: m.type(), text: t })
  })
  page.on('pageerror', (e) => consoleNoise.push({ tag, type: 'pageerror', text: String(e).slice(0, 200) }))

  // -------------------------------------------------------------------------------- §G despatch
  await open(page, 'requests')
  record(`${tag}: the desk carries a Prices section`, await seen(page, '[data-testid="tab-prices"]'))
  record(`${tag}: Outbound offers New despatch`, await seen(page, '[data-testid="new-despatch"]'))
  await shot(page, tag, 'outbound-new-despatch')
  await layout(page, tag, 'Outbound', ['[data-testid="new-despatch"]', '.nav-btn'])

  await page.click('[data-testid="new-despatch"]')
  await page.waitForSelector('[data-testid="despatch-sheet"]')
  await page.waitForTimeout(400)
  record(`${tag}: an empty basket says what to do`, await says(page, '[data-testid="despatch-empty"]', /nothing in the basket/i))
  record(`${tag}: the Send button asks for a store first`, await says(page, '[data-testid="despatch-send"]', /^choose a store$/i))
  await shot(page, tag, 'despatch-empty')
  await layout(page, tag, 'despatch (empty)', ['[data-testid="despatch-store"]', '[data-testid="despatch-scan"]', '[data-testid="despatch-send"]'])

  // one destination for the whole basket
  await page.selectOption('[data-testid="despatch-store"]', 'OK-BIX')
  // scan three SKUs in, one of them twice — the second scan must increment, not add a line
  for (const code of ['8801234500017', '8801234500017', 'RAW-KS-SLIM', 'ZIG-ZAG-1-25']) {
    await page.fill('[data-testid="despatch-scan"]', code)
    await page.press('[data-testid="despatch-scan"]', 'Enter')
    await page.waitForTimeout(450)
  }
  const lineCount = await page.locator('[data-testid^="despatch-line-"]').count()
  record(`${tag}: a repeat scan increments rather than adding a second line`, lineCount === 3, `${lineCount} lines`)
  record(`${tag}: the repeated line carries 2`, (await page.inputValue('[data-testid="despatch-qty-GB-PULSE-15K-BLUE"]')) === '2')
  await page.fill('[data-testid="despatch-qty-RAW-KS-SLIM"]', '50')
  await page.fill('[data-testid="despatch-qty-ZIG-ZAG-1-25"]', '20')
  await page.fill('[data-testid="despatch-reason"]', 'Bixby’s Tuesday order')
  await page.waitForTimeout(300)
  const footerValue = await text(page, '[data-testid="despatch-value"]')
  const footerMargin = await text(page, '[data-testid="despatch-margin"]')
  record(`${tag}: the footer prices the basket`, /\$/.test(footerValue), footerValue)
  record(`${tag}: the footer shows cost and margin, marked internal`, /%/.test(footerMargin), footerMargin)
  record(`${tag}: the Send button names the destination`, await says(page, '[data-testid="despatch-send"]', /OK-BIX/i))
  await shot(page, tag, 'despatch-basket')
  await layout(page, tag, 'despatch (basket)', [
    '[data-testid="despatch-qty-RAW-KS-SLIM"]',
    '[data-testid="despatch-plus-RAW-KS-SLIM"]',
    '[data-testid="despatch-send"]'
  ])
  await touchTargets(page, tag, 'despatch (basket)', '.stepper .step')

  // the refusal, before the send
  await page.fill('[data-testid="despatch-qty-GB-PULSE-15K-BLUE"]', '400')
  await page.waitForTimeout(250)
  const refusal = await text(page, '[data-testid="despatch-refusal"]')
  record(`${tag}: over-allocation is refused with the shortfall named`, /short 364/.test(refusal), refusal.replace(/\n/g, ' | '))
  record(`${tag}: the Send button goes down`, await page.locator('[data-testid="despatch-send"]').isDisabled())
  await shot(page, tag, 'despatch-refused')
  await page.fill('[data-testid="despatch-qty-GB-PULSE-15K-BLUE"]', '12')
  await page.waitForTimeout(250)

  await page.click('[data-testid="despatch-send"]')
  await page.waitForSelector('[data-testid="despatch-confirmation"]', { timeout: 15000 })
  const done = await text(page, '[data-testid="despatch-confirmation"]')
  record(`${tag}: one consignment for the one store`, (await page.locator('[data-testid^="despatch-sent-"]').count()) === 1)
  record(`${tag}: the confirmation names the shipment`, /MSH-/.test(done), done.split('\n')[0])
  record(`${tag}: Send another is offered`, await seen(page, '[data-testid="despatch-another"]'))
  await shot(page, tag, 'despatch-sent')
  await layout(page, tag, 'despatch (sent)', ['[data-testid="despatch-another"]'])

  await page.click('[data-testid="despatch-another"]')
  await page.waitForSelector('[data-testid="despatch-sheet"]')
  await page.waitForTimeout(300)
  const clearedStore = await page.inputValue('[data-testid="despatch-store"]')
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  record(`${tag}: Send another clears the destination`, clearedStore === '', `store="${clearedStore}"`)
  record(`${tag}: Send another focuses the item search`, focused === 'despatch-scan', `focus=${focused}`)
  await page.keyboard.press('Escape')
  await page.click('.modal-head .close')
  await page.waitForTimeout(250)

  // -------------------------------------------------------------------------------- §D price board
  await open(page, 'stock')
  await page.waitForSelector('[data-testid="stock-board"]')
  await page.waitForTimeout(500)
  record(`${tag}: a stock row offers Prices`, await seen(page, '[data-testid="stock-prices-GB-PULSE-15K-BLUE"]'))
  await shot(page, tag, 'stock-prices-button')
  await layout(page, tag, 'Stock', ['[data-testid="stock-prices-GB-PULSE-15K-BLUE"]'])

  await page.click('[data-testid="stock-prices-GB-PULSE-15K-BLUE"]')
  await page.waitForSelector('[data-testid="price-board"]')
  await page.waitForTimeout(600)
  const rows = await page.locator('[data-testid^="price-row-"]').count()
  record(`${tag}: every store is a row on the price board`, rows === 11, `${rows} rows`)
  record(`${tag}: the board says on screen that it is internal`, await says(page, '[data-testid="price-internal-note"]', /internal/i))
  record(`${tag}: a store already waiting is not invited to ask twice`, await seen(page, '[data-testid="price-pending-OK-BIX"]'))
  record(`${tag}: a store override says where the price comes from`, await says(page, '[data-testid="price-row-OK-SAP"]', /store override/i))
  await shot(page, tag, 'price-board')
  await layout(page, tag, 'price board', ['[data-testid="price-input-HOU-MTR"]', '[data-testid="price-raise"]'])
  await touchTargets(page, tag, 'price board', '.rate')

  // type two prices with no reason — the server would throw, so the board refuses first
  await page.fill('[data-testid="price-input-HOU-MTR"]', '22.99')
  await page.fill('[data-testid="price-input-OK-JENKS"]', '23.49')
  await page.waitForTimeout(250)
  record(`${tag}: a blank reason is refused before the server sees it`, await seen(page, '[data-testid="price-reason-error"]'))
  record(`${tag}: the Raise button stays down`, await page.locator('[data-testid="price-raise"]').isDisabled())
  await shot(page, tag, 'price-board-reason-required')

  await page.fill('[data-testid="price-reason"]', 'Matching the shop two doors down')
  await page.waitForTimeout(250)
  record(`${tag}: two rows will raise two requests`, (await text(page, '[data-testid="price-will-raise"]')) === '2')
  record(`${tag}: the button says what it will do`, await says(page, '[data-testid="price-raise"]', /2 price changes/i))
  await shot(page, tag, 'price-board-typed')
  await page.click('[data-testid="price-raise"]')
  await page.waitForSelector('[data-testid="price-raised"]', { timeout: 15000 })
  const raised = await text(page, '[data-testid="price-raised"]')
  record(`${tag}: both requests were raised`, /2 price changes raised/.test(raised), raised)
  await shot(page, tag, 'price-board-raised')
  await page.click('.modal-head .close')
  await page.waitForTimeout(300)

  // -------------------------------------------------------------------------------- §D approvals
  await open(page, 'prices')
  await page.waitForSelector('[data-testid="approvals-board"]')
  await page.waitForTimeout(600)
  const queued = await page.locator('[data-testid^="appr-PCR-"]').count()
  record(`${tag}: the approvals queue lists what is waiting`, queued >= 3, `${queued} waiting`)
  record(`${tag}: a queued request shows the margin it implies`, await seen(page, '[data-testid="appr-margin-PCR-00003"]'))
  record(`${tag}: and the reason the store gave`, (await text(page, '[data-testid="appr-reason-PCR-00003"]')).length > 8)
  await shot(page, tag, 'approvals')
  await layout(page, tag, 'approvals', ['[data-testid="appr-approve-PCR-00003"]', '[data-testid="appr-reject-PCR-00003"]'])
  await touchTargets(page, tag, 'approvals', '.ract .btn')

  await page.click('[data-testid="appr-reject-PCR-00004"]')
  await page.waitForSelector('[data-testid="reject-reason"]')
  await page.waitForTimeout(250)
  record(`${tag}: a reject insists on a reason`, await page.locator('[data-testid="reject-confirm"]').isDisabled())
  await shot(page, tag, 'approvals-reject')
  await page.fill('[data-testid="reject-reason"]', 'Margin is too thin — hold at 27.99 until the next buy')
  await page.waitForTimeout(200)
  record(`${tag}: with a reason it can be rejected`, !(await page.locator('[data-testid="reject-confirm"]').isDisabled()))
  await page.click('[data-testid="reject-confirm"]')
  await page.waitForTimeout(700)
  record(`${tag}: the desk says what happened`, await says(page, '[data-testid="desk-notice"]', /rejected/i))

  await page.click('[data-testid="appr-approve-PCR-00003"]')
  await page.waitForTimeout(900)
  const approved = await text(page, '[data-testid="desk-notice"]')
  record(`${tag}: approving says the store now sells at the new price`, /approved/.test(approved), approved)
  await shot(page, tag, 'approvals-decided')

  // -------------------------------------------------------------------------------- §C statement
  await page.click('[data-testid="prices-tab-statement"]')
  await page.waitForSelector('[data-testid="statement-board"]')
  await page.waitForTimeout(900)
  const notice = await text(page, '[data-testid="statement-internal"]')
  record(`${tag}: the statement says on screen that it is internal`, /Internal/.test(notice) && /cost/i.test(notice))
  record(`${tag}: and that it is not an invoice`, /not an invoice/i.test(notice) && /receivable/i.test(notice))
  const unpricedBanner = await seen(page, '[data-testid="stmt-unpriced"]')
  record(`${tag}: last month's unstamped consignments are shown as not priced`, unpricedBanner)
  record(`${tag}: with the store row saying so`, await seen(page, '[data-testid="stmt-unpriced-OK-SAP"]'))
  const storeRows = await page.locator('[data-testid^="stmt-OK-"], [data-testid^="stmt-HOU-"]').count()
  record(`${tag}: every enabled store has a row, including the quiet ones`, storeRows === 11, `${storeRows} rows`)
  record(`${tag}: there is a chain total`, await seen(page, '[data-testid="stmt-chain-total"]'))
  const owes = await text(page, '[data-testid="stmt-wholesale"]')
  record(`${tag}: the chain figure is money`, /\$/.test(owes), owes)
  await shot(page, tag, 'statement-last-month')
  await layout(page, tag, 'statement (last month)', ['[data-testid="stmt-run"]', '.kpi'])

  await page.click('[data-testid="stmt-preset-this"]')
  await page.waitForTimeout(900)
  record(`${tag}: this month reads without the unpriced banner`, !(await seen(page, '[data-testid="stmt-unpriced"]')))
  await shot(page, tag, 'statement-this-month')

  // -------------------------------------------------------------------------------- §A wholesale
  await page.click('[data-testid="prices-tab-wholesale"]')
  await page.waitForSelector('[data-testid="wholesale-board"]')
  await page.waitForTimeout(900)
  record(`${tag}: the chain markup is settable`, await seen(page, '[data-testid="wholesale-markup"]'))
  record(`${tag}: a hand-priced item says so`, await says(page, '[data-testid="wh-ZIG-ZAG-1-25"]', /typed on the item/i))
  await shot(page, tag, 'wholesale')
  await layout(page, tag, 'wholesale', ['[data-testid="wholesale-markup-save"]'])

  // -------------------------------------------------------------------------------- §E buying
  await open(page, 'buying')
  await page.waitForSelector('[data-testid="buying-board"]')
  await page.waitForTimeout(900)
  const skipped = await text(page, '[data-testid="buy-skipped"]')
  record(`${tag}: Select all says how many rows it skipped and why`, /1 row skipped/.test(skipped) && /no vendor on file/i.test(skipped), skipped)
  record(`${tag}: the unorderable row says it cannot be ordered`, await seen(page, '[data-testid="sug-blocked-OPMS-GOLD-3CT"]'))
  const disabled = await page.locator('[data-testid="sug-pick-OPMS-GOLD-3CT"]').isDisabled()
  record(`${tag}: and its checkbox is disabled`, disabled)
  record(`${tag}: and it offers Add a vendor on the row`, await seen(page, '[data-testid="sug-add-vendor-OPMS-GOLD-3CT"]'))
  await page.locator('[data-testid="sug-OPMS-GOLD-3CT"]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  await shot(page, tag, 'buying-unorderable')
  await layout(page, tag, 'buying (unorderable)', ['[data-testid="sug-add-vendor-OPMS-GOLD-3CT"]'])

  await page.click('[data-testid="sug-add-vendor-OPMS-GOLD-3CT"]')
  await page.waitForSelector('[data-testid="sug-attach-OPMS-GOLD-3CT"]')
  await page.waitForTimeout(400)
  await shot(page, tag, 'buying-add-vendor')
  await layout(page, tag, 'buying (add a vendor)', ['[data-testid="sug-attach-save-OPMS-GOLD-3CT"]', '[data-testid="sug-attach-supplier-OPMS-GOLD-3CT"]'])
  await page.selectOption('[data-testid="sug-attach-supplier-OPMS-GOLD-3CT"]', 'SUP-GULF')
  await page.fill('[data-testid="sug-attach-cost-OPMS-GOLD-3CT"]', '4.40')
  await page.waitForTimeout(200)
  await page.click('[data-testid="sug-attach-save-OPMS-GOLD-3CT"]')
  await page.waitForTimeout(900)
  const stillBlocked = await seen(page, '[data-testid="sug-blocked-OPMS-GOLD-3CT"]')
  record(`${tag}: attaching a vendor unblocks the row in front of the buyer`, !stillBlocked)
  record(`${tag}: and the skipped-rows note goes away`, !(await seen(page, '[data-testid="buy-skipped"]')))
  const notice2 = await text(page, '[data-testid="desk-notice"]')
  record(`${tag}: the desk says the row can be ordered now`, /can be ordered now/.test(notice2), notice2)
  await shot(page, tag, 'buying-unblocked')

  // -------------------------------------------------------------------------------- §E add items
  await open(page, 'vendors')
  await page.waitForSelector('[data-testid="vendors-board"]')
  await page.waitForTimeout(900)
  await page.click('[data-testid="open-vendor-SUP-LONE"]')
  await page.waitForSelector('[data-testid="vendor-sheet"]')
  await page.waitForTimeout(600)
  await page.click('[data-testid="vendor-tab-catalogue"]')
  await page.waitForTimeout(400)
  record(`${tag}: the catalogue offers Add items`, await seen(page, '[data-testid="vendor-add-items"]'))
  await shot(page, tag, 'vendor-catalogue')
  await layout(page, tag, 'vendor catalogue', ['[data-testid="vendor-add-items"]'])

  await page.click('[data-testid="vendor-add-items"]')
  await page.waitForSelector('[data-testid="add-items-sheet"]')
  await page.waitForTimeout(700)
  record(`${tag}: an item nobody sells us leads the list`, await seen(page, '[data-testid="cand-orphan-OPMS-GOLD-3CT"]'))
  record(`${tag}: and it is called out above the table`, await seen(page, '[data-testid="add-items-orphan-note"]'))
  await page.click('[data-testid="cand-pick-PUFF-XXL-MINT"]')
  await page.fill('[data-testid="cand-cost-PUFF-XXL-MINT"]', '6.85')
  await page.waitForTimeout(250)
  record(`${tag}: the button names what it will add`, await says(page, '[data-testid="add-items-save"]', /add 1 item/i))
  await shot(page, tag, 'vendor-add-items')
  await layout(page, tag, 'add items', ['[data-testid="add-items-save"]'])
  await page.click('[data-testid="add-items-save"]')
  await page.waitForTimeout(900)
  const added = await text(page, '[data-testid="desk-notice"]')
  record(`${tag}: the vendor gains the item`, /added to/.test(added), added)
  await shot(page, tag, 'vendor-items-added')

  await ctx.close()
}

// =============================================================================================
const browser = await chromium.launch({ args: ['--no-sandbox'] })
try {
  for (const profile of [PROFILES.desk, PROFILES.phone]) await run(browser, profile)
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
record('no unexpected console errors', consoleNoise.length === 0, consoleNoise.map((c) => `${c.tag}/${c.type}: ${c.text}`).join(' | '))
writeFileSync(path.join(here, 'results.v12.json'), JSON.stringify({ base: BASE, results, console: consoleNoise }, null, 2))
log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed · ${shotN} screenshots in ${SHOTS}`)
if (failed.length) {
  log('\nFAILURES:')
  for (const f of failed) log(`  ${f.step} — ${f.detail}`)
  process.exitCode = 1
}
