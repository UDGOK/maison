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

  // ---- 2.3b unknown barcode (correct selector this time)
  await page.locator('.rail-btn:has-text("All")').first().click()
  await page.waitForTimeout(300)
  const before = await page.locator('.basket .line').count()
  await page.keyboard.type('2000000000001', { delay: 8 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const notices = (await page.locator('.notices').innerText().catch(() => '')).replace(/\s+/g, ' ')
  record('2.3b an unknown barcode is refused with a clear notice and adds nothing',
    (await page.locator('.basket .line').count()) === before && /Not in catalogue/i.test(notices),
    `lines unchanged; notice="${notices.slice(0, 160)}"`)
  await shot(page, 'wedge-unknown-notice')
  await page.locator('.notices .notice .notice-btn:has-text("Close")').first().click().catch(() => {})

  // ---- 4.3a client attach by client number (re-check with a proper wait)
  await page.fill('#client-no', '699911')
  await page.click('.cn-btn.go')
  await page.waitForFunction(() => !/Walk-in/.test(document.querySelector('.basket .client-name')?.textContent || 'Walk-in'), null, { timeout: 25000 }).catch(() => {})
  const cname = (await page.locator('.basket .client-name').textContent()).trim()
  const cblock = (await page.locator('.basket .client').innerText()).replace(/\s+/g, ' ')
  record('4.3a a client attaches to the basket by client №', /Andre/i.test(cname), `client card = "${cname}"; ${cblock.slice(0, 140)}`)
  await page.locator('.basket .detach').click().catch(() => {})
  await page.waitForTimeout(500)

  // ---- 3.4b card brand / last4 on the invoice
  await pick('ACC-015')
  await L.payCard(page)
  const syc = await L.waitSynced(page)
  const ic = (await L.invoiceForUuid(admin, syc.uuid))[0]
  if (ic) created.push(ic.name)
  const cardFields = await admin.value('Sales Invoice', ic.name, ['maison_terminal_ref', 'maison_card_brand', 'maison_card_last4', 'maison_approval_code'])
  const rcpt = (await page.locator('.receipt-view .preview').innerText()).replace(/\s+/g, ' ')
  record('3.4b the card brand / last-4 shown on the receipt are also stored on the invoice',
    !!cardFields.maison_card_brand && !!cardFields.maison_card_last4,
    `invoice ${ic.name}: ${JSON.stringify(cardFields)}; printed receipt line = "${(rcpt.match(/CARD[^A-Z]{0,40}/i) || [''])[0]}"`, 'low')
  note('3.4b receipt text', rcpt.slice(0, 300))
  // and what the Returns screen offers for that card sale
  await page.goto('/pos/returns', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.find input', { timeout: 25000 })
  await page.fill('.find input', ic.name)
  await page.click('.find button:has-text("Find")')
  await page.waitForSelector('.lines .line', { timeout: 25000 })
  const cardMethod = (await page.locator('.method:has-text("Original card")').innerText()).replace(/\s+/g, ' ')
  record('3.4c the Returns screen can name the card it will refund', /\d{4}/.test(cardMethod), `refund button reads "${cardMethod}"`, 'low')
  await shot(page, 'returns-card-method')

  // ---- ReceiptView rejection panel with an HTML server error
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 })
  await pick('ACC-003')
  const line = page.locator('.basket .line').first()
  for (let i = 0; i < 40; i++) await line.locator('.qty-btn[aria-label=More]').click()
  await sleep(400)
  await L.payCash(page, 99999)
  const syr = await L.waitSynced(page)
  await sleep(2500)
  const errPanel = (await page.locator('.receipt-view .err').innerText().catch(() => '')).replace(/\s+/g, ' ')
  const errHtml = await page.locator('.receipt-view .err').innerHTML().catch(() => '')
  record('6.6d the receipt screen shows the rejection in plain language (no raw HTML markup)',
    /rejected/i.test(errPanel) && !/&lt;|<strong>|<a href/i.test(errPanel),
    `panel text="${errPanel.slice(0, 300)}"`)
  note('6.6d panel html', errHtml.slice(0, 400))
  await shot(page, 'receipt-rejected-html')

  // ---- 8.3 session expiry, simulated with an invalid sid
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 20000 })
  await context.clearCookies()
  await context.addCookies([{ name: 'sid', value: 'qa1-expired-session', domain: L.HOST, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }])
  await pick('ACC-002')
  await L.payCash(page, null)
  const uuidExp = page.url().split('/receipt/')[1]
  await sleep(12000)
  const pillExp = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const rvTxt = (await page.locator('.receipt-view .left').innerText()).replace(/\s+/g, ' ')
  const expLog = (await admin.list('AWANZ Sync Log', { offline_uuid: uuidExp }, ['status', 'error'], 2))[0]
  const expInv = await admin.list('Sales Invoice', { maison_offline_uuid: uuidExp }, ['name'], 2)
  record('8.3 a sale rung up after the server session expired is kept, not lost',
    expInv.length === 0 && !/Synced/i.test(pillExp),
    `pill="${pillExp}"; server invoice=${JSON.stringify(expInv)}; sync log=${JSON.stringify(expLog)}; receipt panel="${rvTxt.slice(0, 260)}"`)
  await shot(page, 'edge-session-expired-real')
  record('8.3b the associate is told the session expired rather than just "failed"',
    /sign in|session|log ?in|expired|403|401|permission/i.test(rvTxt), `receipt panel="${rvTxt.slice(0, 260)}"`, 'low')
  // recover
  await context.clearCookies()
  await context.request.post('/api/method/login', { data: { usr: L.A1.usr, pwd: L.A1.pwd } })
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 25000 })
  if (await page.locator('button:has-text("Sync now")').count()) await page.click('button:has-text("Sync now")')
  await sleep(10000)
  const expInv2 = await admin.list('Sales Invoice', { maison_offline_uuid: uuidExp }, ['name'], 2)
  if (expInv2[0]) created.push(expInv2[0].name)
  const qAfter = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('8.3c signing back in drains the sale that was stuck behind the expired session', expInv2.length === 1,
    `${JSON.stringify(expInv2)}; queue="${qAfter.slice(0, 220)}"`)
  await shot(page, 'edge-session-recovered-real')
} catch (e) {
  record('t9 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t9').catch(() => {})
} finally {
  L.writeResults('results-t9.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
