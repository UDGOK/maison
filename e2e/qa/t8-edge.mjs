import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
async function pick(code, times = 1) {
  if (!/\/sell/.test(page.url())) { await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 }) }
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  for (let i = 0; i < times; i++) { await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(200) }
  await page.locator('.sell .search input').fill('')
}

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ---- 8.1 double-tap the charge button
  await pick('ACC-015')
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash', { timeout: 15000 })
  const btn = page.locator('button:has-text("Complete cash sale")')
  await Promise.all([btn.click(), btn.click({ force: true }).catch(() => {}), btn.click({ force: true }).catch(() => {})])
  await page.waitForSelector('.receipt-view', { timeout: 30000 })
  const sy = await L.waitSynced(page)
  await sleep(4000)
  const invs = await L.invoiceForUuid(admin, sy.uuid)
  if (invs[0]) created.push(invs[0].name)
  const near = await admin.list('Sales Invoice', { maison_boutique: L.STORE, grand_total: 7.57, is_return: 0 }, ['name', 'creation'], 5)
  record('8.1 double-tapping CHARGE creates exactly one sale', invs.length === 1,
    `${invs.length} invoice(s) for the uuid: ${JSON.stringify(invs.map((i) => i.name))}; recent $7.57 invoices=${JSON.stringify(near.map((n) => n.name))}`)
  await shot(page, 'edge-double-tap')

  // ---- 8.2 browser back from the receipt must not re-charge
  await page.goBack()
  await sleep(2500)
  const backUrl = page.url()
  const backBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160)
  const after = await L.invoiceForUuid(admin, sy.uuid, 3)
  record('8.2 browser Back from the receipt does not re-charge', after.length === 1 && !/\/pay/.test(backUrl) || /\/sell/.test(backUrl),
    `landed on ${backUrl} ("${backBody}"); invoices for the uuid still ${after.length}`)
  await shot(page, 'edge-back-from-receipt')

  // ---- 8.2b browser back from Pay keeps the basket
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tile', { timeout: 20000 })
  await pick('ACC-009')
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash', { timeout: 15000 })
  await page.goBack()
  await sleep(2000)
  const lines = await page.locator('.basket .line').count()
  record('8.2b browser Back from the Pay screen returns to Sell with the basket intact', /\/sell/.test(page.url()) && lines === 1, `url=${page.url()} lines=${lines}`)

  // ---- 8.5 very large amount
  await page.locator('.basket .clear').click()
  await sleep(400)
  await pick('SVC-003')
  const line = page.locator('.basket .line').first()
  await line.locator('.line-main').click()
  await page.waitForSelector('.modal input', { timeout: 8000 })
  // no direct qty entry — use +; instead check the display with a large qty via repeated taps is slow,
  // so verify formatting with a big discount-free qty through the keypad-free route: 60 taps
  await page.locator('.modal button:has-text("Apply")').click()
  await sleep(300)
  for (let i = 0; i < 120; i++) await line.locator('.qty-btn[aria-label=More]').click()
  await sleep(600)
  const bigQty = (await line.locator('.qty-n').textContent()).trim()
  const bigTotal = (await page.locator('.basket .total-amt').textContent()).trim()
  const expBig = 121 * 100 * 1.0825
  record('8.5 very large amounts render and total correctly', Math.abs(money(bigTotal) - Math.round(expBig * 100) / 100) < 0.02,
    `qty ${bigQty} × $100 → ${bigTotal} (expected ${expBig.toFixed(2)})`)
  await shot(page, 'edge-large-amount')

  // ---- 8.6 zero-value line (100 % discount)
  await page.locator('.basket .clear').click()
  await sleep(400)
  await pick('ACC-002')
  await page.locator('.basket .line').first().locator('.line-main').click()
  await page.waitForSelector('.modal input', { timeout: 8000 })
  await page.locator('.modal input').first().fill('100')
  await page.locator('.modal button:has-text("Apply")').click()
  await sleep(700)
  const zeroTotal = (await page.locator('.basket .total-amt').textContent()).trim()
  await shot(page, 'edge-zero-basket')
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash', { timeout: 15000 })
  const zeroDue = (await page.locator('[data-testid=pay-total]').textContent()).trim()
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForSelector('.receipt-view', { timeout: 30000 })
  const syz = await L.waitSynced(page)
  const zi = (await L.invoiceForUuid(admin, syz.uuid, 8))[0]
  if (zi) created.push(zi.name)
  const zlog = (await admin.list('Maison Sync Log', { offline_uuid: syz.uuid }, ['status', 'error'], 2))[0]
  record('8.6 a fully discounted ($0.00) sale can be completed', !!zi && Number(zi.docstatus) === 1,
    `basket total ${zeroTotal}, amount due ${zeroDue}, pill "${syz.pill}", invoice ${zi?.name} (${zi?.grand_total}); sync log=${JSON.stringify(zlog)}`)
  await shot(page, 'edge-zero-receipt')

  // ---- 8.4 two tabs on the same till
  const tab2 = await context.newPage()
  L.wireConsole(tab2, 'tab2')
  await tab2.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await tab2.waitForSelector('.page-title', { timeout: 30000 })
  const tab2Unlocked = await tab2.locator('.topbar').count()
  const tab2Body = (await tab2.locator('body').innerText()).replace(/\s+/g, ' ')
  record('8.4 a second tab on the same till shares the device session and queue', tab2Unlocked > 0 && /synced/i.test(tab2Body),
    `tab 2 at ${tab2.url()}: "${tab2Body.slice(0, 180)}"`)
  await shot(tab2, 'edge-second-tab')
  // ring up in tab 2 while tab 1 has its own basket
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 })
  await pick('ACC-015')
  await tab2.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await tab2.waitForSelector('.tile', { timeout: 20000 })
  await tab2.locator('.sell .search input').fill('ACC-002'); await tab2.waitForTimeout(600)
  await tab2.locator('.tile:not(.empty)').first().click(); await tab2.waitForTimeout(400)
  const t1lines = await page.locator('.basket .line').count()
  const t2lines = await tab2.locator('.basket .line').count()
  await tab2.click('.basket .pay button:has-text("Cash")')
  await tab2.waitForSelector('.pay .cash', { timeout: 15000 })
  await tab2.click('button:has-text("Complete cash sale")')
  await tab2.waitForSelector('.receipt-view', { timeout: 30000 })
  const sy2 = await L.waitSynced(tab2)
  const i2 = (await L.invoiceForUuid(admin, sy2.uuid))[0]
  if (i2) created.push(i2.name)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.topbar', { timeout: 20000 })
  const t1after = await page.locator('.basket .line').count()
  record('8.4b two tabs keep independent baskets and one shared sync queue',
    t1lines === 1 && t2lines === 1 && !!i2, `tab1 lines=${t1lines}, tab2 lines=${t2lines}, tab2 sale=${i2?.name}; tab1 lines after reload=${t1after}`)
  await shot(page, 'edge-two-tabs-after')
  await tab2.close()

  // ---- 8.3 session expiry
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 })
  await pick('ACC-002')
  await context.clearCookies()
  await pick('ACC-015')
  await L.payCash(page, null)
  const pillExp = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const uuidExp = page.url().split('/receipt/')[1]
  await sleep(9000)
  const pillExp2 = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const rvTxt = (await page.locator('.receipt-view .left').innerText()).replace(/\s+/g, ' ')
  const expLog = (await admin.list('Maison Sync Log', { offline_uuid: uuidExp }, ['status', 'error'], 2))[0]
  const expInv = await admin.list('Sales Invoice', { maison_offline_uuid: uuidExp }, ['name'], 2)
  record('8.3 a sale made after the Frappe session expired is not silently lost',
    expInv.length === 0 ? /Queued|Rejected|Sending/i.test(pillExp2) : true,
    `pill right after=${pillExp} → ${pillExp2}; server invoice=${JSON.stringify(expInv)}; sync log=${JSON.stringify(expLog)}; screen="${rvTxt.slice(0, 260)}"`)
  await shot(page, 'edge-session-expired')
  // recover: log in again and drain
  await context.request.post('/api/method/login', { data: { usr: L.A1.usr, pwd: L.A1.pwd } })
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 25000 })
  if (await page.locator('button:has-text("Sync now")').count()) await page.click('button:has-text("Sync now")')
  await sleep(9000)
  const qAfter = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const expInv2 = await admin.list('Sales Invoice', { maison_offline_uuid: uuidExp }, ['name'], 2)
  if (expInv2[0]) created.push(expInv2[0].name)
  record('8.3b after signing in again the queued sale syncs (nothing lost)', expInv2.length === 1, `${JSON.stringify(expInv2)}; queue="${qAfter.slice(0, 200)}"`)
  await shot(page, 'edge-session-recovered')

  // ---- 8.7 walk every screen: console errors + white-label
  const screens = ['/pos/sell', '/pos/client', '/pos/returns', '/pos/web-orders', '/pos/count', '/pos/receive', '/pos/queue', '/pos/shift', '/pos/settings']
  const scan = []
  for (const s of screens) {
    await page.goto(s, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2600)
    const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    const hits = [...txt.matchAll(/[^ ]{0,26}(frappe|erpnext)[^ ]{0,26}/gi)].map((m) => m[0])
      .filter((h) => !/cloudchaserz\.frappe\.cloud/i.test(h))
    scan.push({ screen: s, chars: txt.length, hits })
    await shot(page, 'screen' + s.replace(/\//g, '-'))
  }
  record('8.7 no screen renders "Frappe" or "ERPNext" in visible text', scan.every((s) => s.hits.length === 0),
    JSON.stringify(scan.map((s) => ({ s: s.screen, hits: s.hits }))))
  note('8.7b screens walked', JSON.stringify(scan.map((s) => s.screen)))
} catch (e) {
  record('t8 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t8').catch(() => {})
} finally {
  L.writeResults('results-t8.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
