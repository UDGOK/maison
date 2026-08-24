import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
async function pick(code) {
  if (!/\/sell/.test(page.url())) { await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 }) }
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(250)
  await page.locator('.sell .search input').fill('')
}
const EXPIRED = {
  status: 403, contentType: 'application/json',
  body: JSON.stringify({ session_expired: 1, exc_type: 'PermissionError',
    exception: 'frappe.exceptions.PermissionError: You are not permitted to access this resource. Login to access' })
}

try {
  await L.unlock(page, L.A1, { fresh: true })
  // why the cookie swap did not expire the session in the earlier run
  await context.clearCookies()
  await context.addCookies([{ name: 'sid', value: 'qa1-expired-session', domain: L.HOST, path: '/', secure: true, sameSite: 'Lax' }])
  const probe = await page.evaluate(async () => {
    const r = await fetch('/api/method/frappe.auth.get_logged_user', { credentials: 'include' })
    return { status: r.status, cookie: document.cookie.slice(0, 120), body: (await r.text()).slice(0, 120) }
  })
  note('cookie-swap probe', JSON.stringify(probe))
  await context.clearCookies()
  await context.request.post('/api/method/login', { data: { usr: L.A1.usr, pwd: L.A1.pwd } })
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.topbar', { timeout: 25000 })

  // ---- 8.3 the Frappe session expires while the till is open
  await pick('ACC-002')
  await context.route('**/api/method/maison_pos.api.sales.submit_batch**', (r) => r.fulfill(EXPIRED))
  await L.payCash(page, null)
  const uuid = page.url().split('/receipt/')[1]
  await sleep(12000)
  const pill = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const rvTxt = (await page.locator('.receipt-view .left').innerText()).replace(/\s+/g, ' ')
  const inv = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  record('8.3 a sale rung up after the Frappe session expired is kept, not lost',
    inv.length === 0 && !/Synced/i.test(pill), `pill="${pill}"; server invoice=${JSON.stringify(inv)}; receipt panel="${rvTxt.slice(0, 300)}"`)
  await shot(page, 'session-expired-receipt')
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 25000 })
  await sleep(2000)
  const qTxt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('8.3b the associate is told the session expired rather than just "failed"',
    /sign in|session|log ?in|expired|permission/i.test(rvTxt + qTxt), `receipt="${rvTxt.slice(0, 200)}"; queue="${qTxt.slice(0, 260)}"`, 'medium')
  await shot(page, 'session-expired-queue')
  // recover
  await context.unroute('**/api/method/maison_pos.api.sales.submit_batch**')
  if (await page.locator('button:has-text("Sync now")').count()) await page.click('button:has-text("Sync now")')
  await sleep(10000)
  const inv2 = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  if (inv2[0]) created.push(inv2[0].name)
  const qTxt2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('8.3c once the session is valid again the sale syncs — nothing lost', inv2.length === 1, `${JSON.stringify(inv2)}; queue="${qTxt2.slice(0, 200)}"`)
  await shot(page, 'session-recovered-queue')

  // ---- receipt "ID checked" line, verified
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 })
  await pick('DSP-009')
  await page.click('[data-testid=age-tab-manual]')
  await page.fill('[data-testid=age-dob]', '1990-05-15')
  await page.click('[data-testid=age-manual-submit]')
  await page.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 25000 }).catch(() => {})
  await sleep(600)
  await L.payCash(page, null)
  const sy = await L.waitSynced(page)
  const ai = (await L.invoiceForUuid(admin, sy.uuid))[0]
  if (ai) created.push(ai.name)
  const rcpt = (await page.locator('.receipt-view .preview').innerText()).replace(/\s+/g, ' ')
  record('5.7c the printed receipt records that the ID was checked', /ID CHECKED/i.test(rcpt), rcpt.slice(0, 400))
  await shot(page, 'receipt-age-line')
} catch (e) {
  record('t10 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t10').catch(() => {})
} finally {
  L.writeResults('results-t10.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
