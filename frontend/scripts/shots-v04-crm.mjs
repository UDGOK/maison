// v0.4 B/C/I/J screenshots + smoke checks against the mock API:
//   VITE_MOCK=1 npm run dev -- --port 5179
//   BASE=http://localhost:5179 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/shots-v04-crm.mjs
// Unlock (clock-in/out), Sell basket (Promotions chip + coupon sheet + tier progress), Client
// (profile / wishlist / owned pieces / follow-ups), Settings (scanner prefix/suffix + test field).
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5179'
const OUT = resolve(process.env.OUT || 'screenshots/v04')
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
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` })

async function fresh(page) {
  await page.goto(`${BASE}/unlock`)
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
  })
}
async function loadBoutique(page) {
  await page.goto(`${BASE}/unlock`)
  await page.waitForSelector('select.input')
  await page.selectOption('select.input', 'CHI-OAK')
  await page.click('button:has-text("Load")')
  await page.waitForSelector('.keypad', { timeout: 20000 })
  await page.evaluate(() => document.fonts.ready)
}
async function pin(page, digits = '1234') {
  for (const k of digits) await page.click(`.keypad .key:text-is("${k}")`)
}

const browser = await chromium.launch()
for (const [pname, profile] of Object.entries(profiles)) {
  const ctx = await browser.newContext(profile)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('PAGEERROR', pname, e.message))
  await fresh(page)

  // ---- Unlock: clock in
  await loadBoutique(page)
  await page.waitForSelector('[data-testid=shift-status]')
  check(`${pname}: unlock shows shift status`, (await page.textContent('[data-testid=shift-status]')).includes('Not clocked in'))
  await page.click('[data-testid=action-clock-in]')
  await shot(page, `unlock-clock-in-${pname}`)
  await pin(page)
  await page.waitForURL(/\/sell/, { timeout: 20000 })
  await page.goto(`${BASE}/unlock`)
  await page.waitForSelector('[data-testid=shift-status]')
  await page.waitForFunction(() => document.querySelector('[data-testid=shift-status]')?.textContent.includes('On shift'), null, { timeout: 10000 })
  check(`${pname}: clocked in → On shift`, true)
  await shot(page, `unlock-on-shift-${pname}`)

  // ---- Sell: promotions chip + coupon
  await pin(page)
  await page.waitForURL(/\/sell/)
  await page.waitForSelector('[data-testid=promotions-chip], .summary-bar')
  // add an Accessories item (promo −15 %) and a ring
  const addTile = async (code) => {
    await page.fill('input[type=search]', code)
    await page.waitForSelector('.tile', { timeout: 10000 })
    await page.click('.tile')
    const serial = await page.$('.serial-btn')
    if (serial) await serial.click()
    await page.fill('input[type=search]', '')
  }
  await addTile('AC-GFT-039')
  await addTile('RG-SIG-005')
  if (pname === 'iphone') await page.click('.summary-bar')
  await page.waitForSelector('[data-testid=promotions-chip]')
  await page.waitForSelector('[data-testid=promo-total]', { timeout: 10000 })
  check(`${pname}: promo line in totals`, true, await page.textContent('[data-testid=promo-total]'))
  await page.click('[data-testid=promotions-chip]')
  await page.waitForSelector('[data-testid=coupon-input]')
  await page.fill('[data-testid=coupon-input]', 'nope')
  await page.click('[data-testid=coupon-apply]')
  await page.waitForSelector('[data-testid=coupon-error]')
  check(`${pname}: bad coupon shows error`, (await page.textContent('[data-testid=coupon-error]')).includes('Unknown coupon'))
  await page.fill('[data-testid=coupon-input]', 'welcome10')
  await page.click('[data-testid=coupon-apply]')
  await page.waitForSelector('[data-testid=coupon-ok]')
  await shot(page, `sell-promotions-sheet-${pname}`)
  await page.click('.modal .close')
  await page.waitForSelector('[data-testid=coupon-total]')
  check(`${pname}: coupon line in totals`, true, await page.textContent('[data-testid=coupon-total]'))
  await shot(page, `sell-basket-promos-${pname}`)

  // ---- Client: profile / wishlist / owned / follow-ups + tier progress
  await page.goto(`${BASE}/client`)
  await page.waitForSelector('.crow')
  await page.click('.crow:has-text("Eleanor")')
  await page.waitForSelector('[data-testid=client-profile]')
  await page.waitForSelector('[data-testid=tier-progress]', { timeout: 10000 })
  await page.waitForSelector('[data-testid=cp-edit]')
  check(`${pname}: profile shows ring size`, (await page.textContent('[data-testid=client-profile]')).includes('6.5'))
  await shot(page, `client-profile-${pname}`)
  await page.click('[data-testid=cp-tab-wishlist]')
  await page.waitForSelector('[data-testid=wish-HJ-PAR-032]')
  await page.click('[data-testid=wish-add]')
  await page.fill('[data-testid=wish-search]', 'cuff')
  await page.waitForSelector('[data-testid^=wish-cand-]')
  await page.click('[data-testid^=wish-cand-]')
  await page.waitForSelector('[data-testid=wish-BR-CUF-017]', { timeout: 10000 })
  check(`${pname}: wishlist add`, true)
  await shot(page, `client-wishlist-${pname}`)
  await page.click('[data-testid=cp-tab-owned]')
  await page.waitForSelector('[data-testid^=owned-]')
  await shot(page, `client-owned-${pname}`)
  await page.click('[data-testid=cp-tab-followups]')
  await page.click('button:has-text("New follow-up")')
  await page.fill('[data-testid=log-note]', 'Show the parure when it arrives')
  await page.fill('input[type=date]', '2026-09-05')
  await page.click('[data-testid=log-save]')
  await page.waitForSelector('[data-testid^=task-]', { timeout: 10000 })
  check(`${pname}: follow-up created`, true)
  await shot(page, `client-followups-${pname}`)
  // tier progress in the basket client card
  await page.click('button:has-text("Attach to sale")')
  await page.waitForURL(/\/sell/)
  if (pname === 'iphone') await page.click('.summary-bar')
  await page.waitForSelector('[data-testid=tier-progress]', { timeout: 10000 })
  check(`${pname}: tier progress in basket`, true)
  await shot(page, `sell-client-tier-${pname}`)

  // ---- Settings: scanner
  await page.goto(`${BASE}/settings`)
  await page.waitForSelector('[data-testid=scanner-settings]')
  await page.fill('[data-testid=scanner-prefix]', '~')
  await page.click('[data-testid=scanner-save]')
  await page.click('[data-testid=scanner-test]')
  await page.keyboard.type('~2000733100019', { delay: 5 })
  await page.keyboard.press('Tab')
  await page.waitForSelector('[data-testid=scanner-test-result]')
  const res = await page.textContent('[data-testid=scanner-test-result]')
  check(`${pname}: scanner test strips prefix`, res.includes('2000733100019') && res.includes('Tab'), res.replace(/\s+/g, ' ').slice(0, 120))
  await page.evaluate(() => document.querySelector('[data-testid=scanner-settings]').scrollIntoView())
  await shot(page, `settings-scanner-${pname}`)

  // ---- Unlock: clock out
  await page.goto(`${BASE}/unlock`)
  await page.waitForSelector('[data-testid=action-clock-out]:not([disabled])', { timeout: 10000 })
  await page.click('[data-testid=action-clock-out]')
  await pin(page)
  await page.waitForFunction(() => document.querySelector('[data-testid=clock-msg]')?.textContent.includes('Clocked out'), null, { timeout: 10000 })
  check(`${pname}: clocked out`, true, await page.textContent('[data-testid=clock-msg]'))
  await shot(page, `unlock-clock-out-${pname}`)
  await ctx.close()
}
await browser.close()
writeFileSync(`${OUT}/results-crm.json`, JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
