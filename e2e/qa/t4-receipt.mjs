import * as L from './lib-pos.mjs'
import fs from 'node:fs'
import { request } from 'playwright'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const CLIENT = { name: 'Andre Baptiste', no: '699911' }

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
async function addCode(code, times = 1) {
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  for (let i = 0; i < times; i++) { await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(250) }
  await page.locator('.sell .search input').fill('')
}

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ---- attach a client so the receipt carries a points line
  await page.fill('#client-no', CLIENT.no)
  await page.click('.cn-btn.go')
  await page.waitForSelector('.basket .client-name', { timeout: 20000 })
  const attached = (await page.locator('.basket .client-name').textContent()).trim()
  const ptsBefore = Number((await admin.get('frappe.client.get_value', { doctype: 'Customer', filters: JSON.stringify({ name: CLIENT.name }), fieldname: JSON.stringify(['name']) })) ? 0 : 0)
  record('4.3a client attaches by client №', attached.includes('Andre'), `client card shows "${attached}"`)

  await addCode('ACC-011') // Rolling Tray 8.99
  const g = money(await page.locator('.basket .total-amt').textContent())
  await L.payCash(page, null)
  const sy = await L.waitSynced(page)
  const inv = (await L.invoiceForUuid(admin, sy.uuid))[0]
  if (inv) created.push(inv.name)
  await shot(page, 'receipt-with-client')

  // ---- 4.1 QR renders
  const qr = page.locator('.receipt-view .r-qr img')
  await qr.waitFor({ timeout: 20000 }).catch(() => {})
  const qrCount = await qr.count()
  const qrBox = qrCount ? await qr.boundingBox() : null
  record('4.1 receipt QR renders on the 80 mm preview', qrCount === 1 && !!qrBox && qrBox.width > 40, `img count=${qrCount} box=${JSON.stringify(qrBox)}`)

  // ---- 4.2 receipt link opens as a guest
  const linkTxt = (await page.locator('.receipt-view .link-url').textContent().catch(() => '')).trim()
  const tok = inv ? (await admin.value('Sales Invoice', inv.name, ['maison_receipt_token'])).maison_receipt_token : ''
  const guest = await request.newContext({ baseURL: L.BASE })
  const gr = await guest.get(`/r/${tok}`)
  const gbody = await gr.text()
  record('4.2 receipt link opens as a guest (no session)', gr.status() === 200 && /CloudChaserz/i.test(gbody) && gbody.includes(inv.name),
    `GET /r/${tok} → ${gr.status()}, ${gbody.length} bytes, contains invoice=${gbody.includes(inv.name)}; link shown in POS = "${linkTxt}"`)
  record('4.2b guest receipt page carries no Frappe/ERPNext wording', !/frappe|erpnext/i.test(gbody.replace(/<script[\s\S]*?<\/script>/g, '')),
    (gbody.match(/frappe|erpnext/gi) || []).slice(0, 6).join(','))
  // render it in a browser for the screenshot
  const gctx = await browser.newContext({ viewport: { width: 900, height: 1200 }, baseURL: L.BASE })
  if (process.env.BRIDGE === '1') await (await import('../cloud-bridge.mjs')).installBridge(gctx, {})
  const gp = await gctx.newPage(); L.wireConsole(gp, 'guest-receipt')
  await gp.goto(`/r/${tok}`, { waitUntil: 'domcontentloaded' })
  await shot(gp, 'guest-receipt', true)
  await gctx.close(); await guest.dispose()

  // ---- 4.3 points line
  const rTxt = (await page.locator('.receipt-view .preview').innerText()).replace(/\s+/g, ' ')
  const uiEarned = await page.locator('[data-testid=receipt-points-earned]').textContent().catch(() => null)
  const uiBal = await page.locator('[data-testid=receipt-points-balance]').textContent().catch(() => null)
  const lpe = await admin.list('Loyalty Point Entry', { invoice: inv.name }, ['loyalty_points', 'purchase_amount', 'customer'], 5)
  const serverPoints = lpe.reduce((a, r) => a + Number(r.loyalty_points || 0), 0)
  record('4.3 receipt points line matches the server ledger', uiEarned !== null && Number(uiEarned) === serverPoints,
    `receipt "Points earned"=${uiEarned}, balance=${uiBal}; Loyalty Point Entry for ${inv.name} = ${JSON.stringify(lpe)}; basket total ${g}`)
  note('4.3 receipt text', rTxt.slice(0, 400))

  // ---- 4.4 print: reader canvas route
  await page.click('.nav-btn[title=Settings]')
  await page.waitForSelector('[data-testid=reader-picker]', { timeout: 20000 })
  const readerOpts = await page.$$eval('[data-testid=reader-picker] option', (o) => o.map((x) => ({ v: x.value, t: x.textContent.trim() })))
  const v660 = readerOpts.find((o) => /V660p|printer/i.test(o.t))
  await page.selectOption('[data-testid=reader-picker]', v660.v)
  await page.waitForTimeout(600)
  const routePill = (await page.locator('[data-testid=reader-settings] .pill').textContent()).trim()
  await shot(page, 'settings-reader')
  await page.goBack()
  await page.waitForSelector('.receipt-view', { timeout: 20000 })
  await page.evaluate(() => { window.__maisonLastReaderPrint = undefined })
  await page.click('.receipt-view button:has-text("Print receipt")')
  await page.waitForTimeout(4000)
  const printedPng = await page.evaluate(() => window.__maisonLastReaderPrint || null)
  const printMsg = (await page.locator('.receipt-view .print-meta').innerText()).replace(/\s+/g, ' ')
  record('4.4 print → reader canvas route (V660p)', !!printedPng && printedPng.startsWith('data:image/png') && /Printed on/i.test(printMsg),
    `route pill="${routePill}"; canvas PNG ${printedPng ? printedPng.length + ' chars' : 'none'}; meta="${printMsg}"`)
  await shot(page, 'receipt-printed-reader')

  // ---- 4.4b browser fallback
  await page.click('.nav-btn[title=Settings]')
  await page.waitForSelector('[data-testid=reader-picker]')
  await page.selectOption('[data-testid=reader-settings] select >> nth=1', 'browser')
  await page.waitForTimeout(600)
  const routePill2 = (await page.locator('[data-testid=reader-settings] .pill').textContent()).trim()
  await page.goBack()
  await page.waitForSelector('.receipt-view', { timeout: 20000 })
  await page.evaluate(() => { window.__printCalled = 0; const p = window.print; window.print = () => { window.__printCalled++ } })
  await page.click('.receipt-view button:has-text("Print")')
  await page.waitForTimeout(3000)
  const printCalls = await page.evaluate(() => window.__printCalled)
  const printMsg2 = (await page.locator('.receipt-view .print-meta').innerText()).replace(/\s+/g, ' ')
  record('4.4b print → browser dialog fallback', printCalls > 0, `route pill="${routePill2}", window.print() calls=${printCalls}, meta="${printMsg2}"`)
  await shot(page, 'receipt-printed-browser')
  // back to auto
  await page.click('.nav-btn[title=Settings]')
  await page.waitForSelector('[data-testid=reader-picker]')
  await page.selectOption('[data-testid=reader-settings] select >> nth=1', 'auto')
  await page.goBack()
  await page.waitForSelector('.receipt-view', { timeout: 20000 })

  // ---- 4.5 email receipt
  await page.click('.receipt-view button:has-text("Email receipt")')
  await page.waitForSelector('.modal input', { timeout: 10000 })
  await page.fill('.modal input', 'qa1.receipt@example.com')
  const sendDisabled = await page.locator('.modal button:has-text("Send on sync")').isDisabled()
  await page.click('.modal button:has-text("Send on sync")')
  await page.waitForTimeout(2500)
  const btnTxt = (await page.locator('.receipt-view .actions button >> nth=1').textContent()).trim()
  await shot(page, 'receipt-email')
  const notesAfter = await admin.value('Sales Invoice', inv.name, ['maison_notes'])
  const eq = await admin.list('Email Queue', { reference_name: inv.name }, ['name', 'status'], 5).catch(() => 'no permission')
  const eq2 = await admin.list('Email Queue', {}, ['name', 'status', 'reference_doctype', 'reference_name'], 5).catch(() => 'no permission')
  record('4.5 "Email receipt" actually sends / queues the receipt', false,
    `UI accepted the address (button now "${btnTxt}", validation on "@" works: disabled-before-@=${sendDisabled}) but nothing reaches the server: Sales Invoice ${inv.name} maison_notes=${JSON.stringify(notesAfter)}, Email Queue for the invoice=${JSON.stringify(eq)}. ReceiptView.sendEmail() only writes notes:"email:<addr>" into the local Dexie queue row, and that row has already been sent (status ok) — nothing re-posts it. A server endpoint exists (maison_pos.api.salon.email_receipt) but the POS never calls it.`,
    'medium')
  note('4.5 email queue sample', JSON.stringify(eq2).slice(0, 300))

  // ---- receipt QR disabled / offline states are covered in t6
  const rvTxt = (await page.locator('.receipt-view').innerText()).replace(/\s+/g, ' ')
  record('4.6 receipt screen carries no Frappe/ERPNext wording', !/frappe|erpnext/i.test(rvTxt), rvTxt.slice(0, 160))
} catch (e) {
  record('t4 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t4').catch(() => {})
} finally {
  L.writeResults('results-t4.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
