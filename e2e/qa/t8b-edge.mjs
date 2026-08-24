import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
async function pick(code, times = 1, p = page) {
  if (!/\/sell/.test(p.url())) { await p.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('.tile', { timeout: 20000 }) }
  await p.locator('.sell .search input').fill(code)
  await p.waitForTimeout(500)
  for (let i = 0; i < times; i++) { await p.locator('.tile:not(.empty)').first().click(); await p.waitForTimeout(200) }
  await p.locator('.sell .search input').fill('')
}

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ---- 8.4 two tabs on the same till
  const tab2 = await context.newPage()
  L.wireConsole(tab2, 'tab2')
  await tab2.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await tab2.waitForTimeout(4000)
  const tab2Url = tab2.url()
  const needsPin = /\/unlock/.test(tab2Url)
  record('8.4 a second tab on the same till asks for the PIN again (till lock is per tab)', needsPin,
    `tab 2 opened /pos/queue → ${tab2Url}`)
  await shot(tab2, 'edge-second-tab-unlock')
  if (needsPin) {
    await tab2.waitForSelector('.keypad', { timeout: 30000 })
    await L.pickAssociate(tab2, L.A1)
    await L.typePin(tab2, L.A1.pin)
    await tab2.waitForSelector('.topbar', { timeout: 25000 })
  }
  // both tabs sell independently; the queue is shared
  await pick('ACC-015', 1, page)
  await tab2.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await tab2.waitForSelector('.tile', { timeout: 20000 })
  await pick('ACC-002', 1, tab2)
  const t1lines = await page.locator('.basket .line').count()
  const t2lines = await tab2.locator('.basket .line').count()
  await tab2.click('.basket .pay button:has-text("Cash")')
  await tab2.waitForSelector('.pay .cash', { timeout: 15000 })
  await tab2.click('button:has-text("Complete cash sale")')
  await tab2.waitForSelector('.receipt-view', { timeout: 30000 })
  const sy2 = await L.waitSynced(tab2)
  const i2 = (await L.invoiceForUuid(admin, sy2.uuid))[0]
  if (i2) created.push(i2.name)
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 25000 })
  await sleep(2500)
  const q1 = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('8.4b two tabs keep independent baskets and share one sync queue',
    t1lines === 1 && t2lines === 1 && !!i2 && q1.includes(i2.name.slice(-5)),
    `tab1 lines=${t1lines}, tab2 lines=${t2lines}; tab2 sale=${i2?.name}; tab1 queue="${q1.slice(0, 200)}"`)
  await shot(page, 'edge-two-tabs-queue')
  await tab2.close()

  // ---- 8.3 session expiry
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 })
  const beforeLines = await page.locator('.basket .line').count()
  await context.clearCookies()
  await pick('ACC-009', 1, page)
  await L.payCash(page, null)
  const pill1 = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const uuidExp = page.url().split('/receipt/')[1]
  await sleep(10000)
  const pill2 = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const rvTxt = (await page.locator('.receipt-view .left').innerText()).replace(/\s+/g, ' ')
  const expLog = (await admin.list('Maison Sync Log', { offline_uuid: uuidExp }, ['status', 'error'], 2))[0]
  const expInv = await admin.list('Sales Invoice', { maison_offline_uuid: uuidExp }, ['name'], 2)
  record('8.3 a sale rung up after the server session expired is kept, not lost',
    expInv.length === 0 && /Queued|Sending|Rejected/i.test(pill2),
    `pill ${pill1} → ${pill2}; invoice=${JSON.stringify(expInv)}; sync log=${JSON.stringify(expLog)}; receipt panel="${rvTxt.slice(0, 300)}"`)
  await shot(page, 'edge-session-expired')
  record('8.3b the associate is told the session expired (not just a generic failure)',
    /sign in|session|log in|expired|401/i.test(rvTxt + JSON.stringify(expLog)), `receipt panel + log: ${rvTxt.slice(0, 200)} | ${JSON.stringify(expLog)}`, 'low')
  // recover
  await context.request.post('/api/method/login', { data: { usr: L.A1.usr, pwd: L.A1.pwd } })
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 25000 })
  if (await page.locator('button:has-text("Sync now")').count()) await page.click('button:has-text("Sync now")')
  await sleep(10000)
  const qAfter = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const expInv2 = await admin.list('Sales Invoice', { maison_offline_uuid: uuidExp }, ['name'], 2)
  if (expInv2[0]) created.push(expInv2[0].name)
  record('8.3c after signing back in the queued sale syncs — nothing is lost', expInv2.length === 1, `${JSON.stringify(expInv2)}; queue="${qAfter.slice(0, 220)}"`)
  await shot(page, 'edge-session-recovered')

  // ---- 8.7 walk every screen: console + white-label
  const screens = ['/pos/sell', '/pos/client', '/pos/returns', '/pos/web-orders', '/pos/count', '/pos/receive', '/pos/queue', '/pos/shift', '/pos/settings']
  const scan = []
  for (const s of screens) {
    await page.goto(s, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2800)
    const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    const hits = [...txt.matchAll(/\S{0,26}(frappe|erpnext)\S{0,26}/gi)].map((m) => m[0]).filter((h) => !/cloudchaserz\.frappe\.cloud/i.test(h))
    scan.push({ screen: s, hits, len: txt.length })
    await shot(page, 'screen' + s.replace(/\//g, '-'))
  }
  record('8.7 no POS screen renders "Frappe" or "ERPNext" in visible text', scan.every((s) => s.hits.length === 0),
    JSON.stringify(scan.map((s) => ({ s: s.screen, hits: s.hits }))))
} catch (e) {
  record('t8b crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t8b').catch(() => {})
} finally {
  L.writeResults('results-t8b.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
