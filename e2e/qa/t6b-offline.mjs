import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page, offline } = await L.posContext(browser, L.A1, 'pos')
const created = []
async function pick(code, times = 1) {
  if (!/\/sell/.test(page.url())) { await page.click('.nav-btn[title=Sell]'); await page.waitForSelector('.tile', { timeout: 20000 }) }
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  for (let i = 0; i < times; i++) { await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(250) }
  await page.locator('.sell .search input').fill('')
}
const goOffline = async () => { offline.v = true; await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await sleep(900) }
const goOnline = async () => { offline.v = false; await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(900) }
async function drain() {
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 20000 })
  if (await page.locator('button:has-text("Sync now")').count()) await page.click('button:has-text("Sync now")')
  await sleep(6000)
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}

try {
  await L.unlock(page, L.A1, { fresh: true })
  // warm the SW, then check control after a second reload
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).some((r) => r.active?.state === 'activated'), null, { timeout: 40000 }).catch(() => {})
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2000)
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.topbar', { timeout: 30000 }); await sleep(2000)
  const sw = await page.evaluate(async () => ({
    controller: navigator.serviceWorker.controller?.scriptURL || null,
    regs: (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, state: r.active?.state }))
  }))
  record('6.0 service worker registered and controlling the page after a reload', sw.regs.length === 1 && !!sw.controller, JSON.stringify(sw))

  // ---- 6.6 real stock conflict, non-restricted item
  const code = 'ACC-003' // Blazer Big Shot Torch, 9 in stock, not age-restricted
  const binBefore = (await admin.list('Bin', { item_code: code, warehouse: L.WH }, ['actual_qty'], 1))[0]
  await goOffline()
  await pick(code)
  const more = page.locator('.basket .line').first().locator('.qty-btn[aria-label=More]')
  for (let i = 0; i < 40; i++) await more.click()
  await sleep(400)
  const qty = (await page.locator('.basket .line').first().locator('.qty-n').textContent()).trim()
  await L.payCash(page, 9999)
  const uuidC = page.url().split('/receipt/')[1]
  await goOnline()
  const qTxt = await drain()
  const log = (await admin.list('AWANZ Sync Log', { offline_uuid: uuidC }, ['status', 'error'], 2))[0]
  const inv = await admin.list('Sales Invoice', { maison_offline_uuid: uuidC }, ['name'], 3)
  const binAfter = (await admin.list('Bin', { item_code: code, warehouse: L.WH }, ['actual_qty'], 1))[0]
  const clean = !/Traceback|<[a-z]+ |File \"|frappe\.exceptions/i.test(String(log?.error || ''))
  record('6.6 offline oversell is refused server-side with a readable stock error',
    inv.length === 0 && /Error/i.test(log?.status || '') && clean,
    `qty ${qty} of ${code} (bin ${binBefore?.actual_qty}); log=${JSON.stringify(log)}; invoices=${JSON.stringify(inv)}`)
  record('6.6b the refused sale moved no stock', Number(binAfter?.actual_qty) === Number(binBefore?.actual_qty), `bin ${binBefore?.actual_qty} → ${binAfter?.actual_qty}`)
  const rejPanel = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  record('6.6c the rejection is shown to the associate in plain language (no HTML / traceback)',
    /rejected/i.test(rejPanel) && !/<\w+|Traceback/i.test(rejPanel), rejPanel.slice(0, 400))
  await shot(page, 'offline-oversell-rejected', true)

  // ---- 6.7 offline sale of an AGE-RESTRICTED item
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tile', { timeout: 20000 })
  await goOffline()
  await pick('DSP-007')
  const gateSeen = await page.locator('[data-testid=age-gate]').count()
  await page.click('[data-testid=age-tab-manual]')
  await page.fill('[data-testid=age-dob]', '1990-05-15')
  await page.click('[data-testid=age-manual-submit]')
  await page.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 20000 }).catch(() => {})
  await sleep(600)
  const linesA = await page.locator('.basket .line').count()
  record('6.7 the 21+ gate still works offline (rules run on the device)', gateSeen === 1 && linesA === 1, `gate=${gateSeen} lines=${linesA}`)
  await shot(page, 'offline-age-gate')
  await L.payCash(page, 40)
  const uuidA = page.url().split('/receipt/')[1]
  await goOnline()
  const qTxt2 = await drain()
  const logA = (await admin.list('AWANZ Sync Log', { offline_uuid: uuidA }, ['status', 'error'], 2))[0]
  const invA = await admin.list('Sales Invoice', { maison_offline_uuid: uuidA }, ['name', 'docstatus'], 3)
  if (invA[0]) created.push(invA[0].name)
  record('6.7b an offline sale of an age-restricted item syncs', invA.length === 1 && /Success/i.test(logA?.status || ''),
    `sync log=${JSON.stringify(logA)}; invoices=${JSON.stringify(invA)}`, 'critical')
  await shot(page, 'offline-age-sync', true)
  const rej = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  note('6.7c what the associate sees', rej.slice(0, 500))
} catch (e) {
  record('t6b crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t6b').catch(() => {})
} finally {
  L.writeResults('results-t6b.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
