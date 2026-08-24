import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, sleep } = L
const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
const EXPIRED = { status: 403, contentType: 'application/json',
  body: JSON.stringify({ session_expired: 1, exc_type: 'PermissionError', exception: 'frappe.exceptions.PermissionError: You are not permitted to access this resource. Login to access' }) }
try {
  await L.unlock(page, L.A1, { fresh: true })
  await page.locator('.sell .search input').fill('ACC-002'); await page.waitForTimeout(600)
  await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(300)
  await context.route('**/api/method/maison_pos.api.sales.submit_batch**', (r) => r.fulfill(EXPIRED))
  await L.payCash(page, null)
  const uuid = page.url().split('/receipt/')[1]
  await sleep(9000)
  await context.unroute('**/api/method/maison_pos.api.sales.submit_batch**')
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 25000 })
  await sleep(1500)
  const before = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  await page.click('button:has-text("Sync now")')
  await sleep(8000)
  const mid = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const invMid = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  record('8.3c "Sync now" does not re-send a sale that was rejected by a transient 403', invMid.length === 0,
    `queue before="${before.slice(0, 120)}" after Sync now="${mid.slice(0, 140)}"; invoice=${JSON.stringify(invMid)}`)
  await page.click('button:has-text("Retry")')
  await sleep(9000)
  const after = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const inv = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  if (inv[0]) created.push(inv[0].name)
  record('8.3d the per-row Retry recovers a sale rejected by an expired session', inv.length === 1,
    `after Retry: queue="${after.slice(0, 160)}"; invoice=${JSON.stringify(inv)}`)
  await shot(page, 'queue-retry-recovered')
} catch (e) {
  record('t11 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t11').catch(() => {})
} finally {
  L.writeResults('results-t11.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
