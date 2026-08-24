import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, sleep } = L
const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
// byte-for-byte the body the live site returns for a stale sid on this endpoint
const REAL_403 = { status: 403, contentType: 'application/json', body: JSON.stringify({
  session_expired: 1,
  exception: 'frappe.exceptions.PermissionError: <details><summary>You are not permitted to access this resource. Login to access</summary>Function <strong>maison_pos.api.sales.submit_batch</strong> is not whitelisted.</details>',
  exc_type: 'PermissionError',
  _server_messages: JSON.stringify(['{"message": "<details><summary>You are not permitted to access this resource. Login to access</summary>Function <strong>maison_pos.api.sales.submit_batch</strong> is not whitelisted.</details>", "title": "Method Not Allowed", "indicator": "red", "raise_exception": 1}'])
}) }
try {
  await L.unlock(page, L.A1, { fresh: true })
  await page.locator('.sell .search input').fill('ACC-002'); await page.waitForTimeout(600)
  await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(300)
  await context.route('**/api/method/maison_pos.api.sales.submit_batch**', (r) => r.fulfill(REAL_403))
  await L.payCash(page, null)
  const uuid = page.url().split('/receipt/')[1]
  await sleep(11000)
  const pill = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const rv = (await page.locator('.receipt-view .left').innerText()).replace(/\s+/g, ' ')
  const inv = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  record('8.3 a sale rung up after the session expired is kept, not lost', inv.length === 0 && !/Synced/i.test(pill),
    `pill="${pill}"; server invoice=${JSON.stringify(inv)}; receipt panel="${rv.slice(0, 320)}"`)
  await shot(page, 'session-expired-real-body')
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.page-title', { timeout: 25000 }); await sleep(1500)
  const q = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  record('8.3b the associate is told they are signed out, in their own words', /sign in|signed out|session|log ?in|expired/i.test(rv + q),
    `receipt="${rv.slice(0, 240)}" | queue="${q.slice(0, 280)}"`, 'medium')
  await shot(page, 'session-expired-real-queue')
  await context.unroute('**/api/method/maison_pos.api.sales.submit_batch**')
  await page.click('button:has-text("Sync now")'); await sleep(7000)
  const inv1 = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  record('8.3c "Sync now" recovers it automatically', inv1.length === 1, `after Sync now: ${JSON.stringify(inv1)}`)
  if (!inv1.length) { await page.click('button:has-text("Retry")'); await sleep(9000) }
  const inv2 = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  if (inv2[0]) created.push(inv2[0].name)
  record('8.3d the per-row Retry recovers it', inv2.length === 1, JSON.stringify(inv2))
} catch (e) { record('t12 crashed', false, String(e.stack || e), 'high'); await shot(page, 'crash-t12').catch(() => {}) }
finally { L.writeResults('results-t12.json', { created }); await context.close(); await browser.close(); await admin.dispose() }
