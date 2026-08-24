import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const R = (n) => Math.round(n * 100 + 1e-9) / 100
const TAX = boot.taxes[0].rate
const CLIENT = { name: 'Andre Baptiste', no: '699911' }

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
async function pick(code, times = 1) {
  if (!/\/sell/.test(page.url())) { await page.click('.nav-btn[title=Sell]'); await page.waitForSelector('.tile', { timeout: 20000 }) }
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  for (let i = 0; i < times; i++) { await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(250) }
  await page.locator('.sell .search input').fill('')
}
async function sell({ codes, mode = 'cash', client = null }) {
  await page.click('.nav-btn[title=Sell]')
  await page.waitForSelector('.tile', { timeout: 20000 })
  if (client) {
    await page.fill('#client-no', client)
    await page.click('.cn-btn.go')
    await page.waitForFunction(() => !/Walk-in/.test(document.querySelector('.basket .client-name')?.textContent || 'Walk-in'), null, { timeout: 20000 })
  }
  for (const c of codes) await pick(c)
  const g = money(await page.locator('.basket .total-amt').textContent())
  if (mode === 'cash') await L.payCash(page, null); else await L.payCard(page)
  const sy = await L.waitSynced(page)
  const inv = (await L.invoiceForUuid(admin, sy.uuid))[0]
  if (inv) created.push(inv.name)
  return { inv, total: g, pill: sy.pill, uuid: sy.uuid }
}
const findSale = async (q) => {
  await page.click('.nav-btn[title=Returns]')
  await page.waitForSelector('.find input', { timeout: 20000 })
  await page.fill('.find input', q)
  await page.click('.find button:has-text("Find")')
  await page.waitForSelector('.lines .line', { timeout: 25000 })
}

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ================= Sale A: card + client, two lines whose rounding agrees =================
  const A = await sell({ codes: ['ACC-011', 'ACC-015'], mode: 'card', client: CLIENT.no })
  record('7.0 setup: card sale with a client for the return tests', !!A.inv, `${A.inv?.name} ${A.total} (${A.pill})`)
  const lpBefore = await admin.list('Loyalty Point Entry', { invoice: A.inv.name }, ['loyalty_points'], 5)
  const balBefore = (await admin.get('frappe.client.get_list', { doctype: 'Loyalty Point Entry', filters: JSON.stringify({ customer: CLIENT.name }), fields: JSON.stringify(['sum(loyalty_points) as p']), limit_page_length: 1 }))[0]

  // ---- 7.1 find by invoice number, partial line return, refund to original card
  await findSale(A.inv.name)
  const lineNames = await page.$$eval('.lines .line .name', (e) => e.map((x) => x.textContent.trim()))
  record('7.4 find the sale by invoice number', lineNames.length === 2, `${A.inv.name} → lines ${JSON.stringify(lineNames)}`)
  await shot(page, 'returns-found')
  const usbLine = page.locator('.lines .line', { hasText: 'USB-C' }).first()
  await usbLine.locator('.line-head').click()
  await page.waitForTimeout(500)
  const reasons = await usbLine.locator('select option').allTextContents()
  const conditions = await usbLine.locator('.seg .chip').allTextContents()
  record('7.5 reasons and conditions are offered per line', reasons.length >= 3 && conditions.length >= 2, `reasons=${JSON.stringify(reasons)} conditions=${JSON.stringify(conditions)}`)
  await usbLine.locator('select').selectOption(reasons.find((r) => /Faulty|Defect|Damaged/i.test(r)) || reasons[1])
  const methods = await page.$$eval('.methods .method', (e) => e.map((x) => ({ t: x.textContent.replace(/\s+/g, ' ').trim(), disabled: x.disabled })))
  await page.locator('.method:has-text("Original card")').click()
  const refundTxt = (await page.locator('.summary').innerText()).replace(/\s+/g, ' ')
  const expCredit = R(boot.prices['ACC-015'] * (1 + TAX / 100))
  await shot(page, 'returns-partial')
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.section-title:has-text("Credit note")', { timeout: 40000 })
  const doneTxt = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  const cn = (await page.locator('.section-title:has-text("Credit note")').textContent()).replace('Credit note', '').trim()
  created.push(cn)
  const cnDoc = await admin.value('Sales Invoice', cn, ['grand_total', 'is_return', 'return_against', 'docstatus', 'maison_refund_method'])
  record('7.1 partial line return creates a credit note for that line only',
    Number(cnDoc.is_return) === 1 && cnDoc.return_against === A.inv.name && Math.abs(Math.abs(Number(cnDoc.grand_total)) - expCredit) < 0.02,
    `credit note ${cn}: ${JSON.stringify(cnDoc)}; expected ${expCredit}; refund methods offered=${JSON.stringify(methods)}`)
  record('7.6 refund to the original card', /card/i.test(doneTxt) && /refund/i.test(doneTxt), doneTxt.slice(0, 300))
  await shot(page, 'returns-done-card')

  // ---- 7.11 return receipt prints
  await page.evaluate(() => { window.__awanzLastReaderPrint = undefined })
  await page.click('button:has-text("Print return receipt")')
  await page.waitForTimeout(4000)
  const png = await page.evaluate(() => window.__awanzLastReaderPrint || null)
  const printedMsg = (await page.locator('.summary').innerText()).replace(/\s+/g, ' ')
  record('7.11 the return receipt prints', !!png || /Printed|print dialog/i.test(printedMsg), `reader PNG=${png ? png.length : 0}; "${printedMsg.slice(0, 160)}"`)
  await shot(page, 'returns-printed')

  // ---- 7.10 points reversal
  await sleep(2000)
  const lpAfter = await admin.list('Loyalty Point Entry', { customer: CLIENT.name }, ['loyalty_points', 'invoice', 'invoice_type'], 8)
  const reversal = lpAfter.find((r) => r.invoice === cn)
  record('7.10 the points earned on the returned line are reversed', !!reversal && Number(reversal.loyalty_points) < 0,
    `entries for ${CLIENT.name}: ${JSON.stringify(lpAfter.slice(0, 5))}; earned on sale=${JSON.stringify(lpBefore)}`)

  // ---- 7.2 full return of the rest, found by RECEIPT QR
  const tok = (await admin.value('Sales Invoice', A.inv.name, ['maison_receipt_token'])).maison_receipt_token
  await findSale(`${L.BASE}/r/${tok}`)
  const hdr = (await page.locator('.card.block .section-title').first().textContent()).trim()
  record('7.3 find the sale by scanning the receipt QR link', hdr === A.inv.name, `pasted ${L.BASE}/r/${tok} → invoice "${hdr}"`)
  const returnedPill = (await page.locator('.lines').innerText()).replace(/\s+/g, ' ')
  record('7.2b the already-returned line is shown as returned and cannot be returned twice', /returned/i.test(returnedPill), returnedPill.slice(0, 220))
  const trayLine = page.locator('.lines .line', { hasText: 'Rolling Tray' }).first()
  await trayLine.locator('.line-head').click()
  await page.waitForTimeout(400)
  await page.locator('.method:has-text("Cash")').click()
  await shot(page, 'returns-by-qr')
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.section-title:has-text("Credit note")', { timeout: 40000 })
  const cn2 = (await page.locator('.section-title:has-text("Credit note")').textContent()).replace('Credit note', '').trim()
  created.push(cn2)
  const cn2Doc = await admin.value('Sales Invoice', cn2, ['grand_total', 'is_return', 'return_against', 'maison_refund_method'])
  record('7.2 full return of the remaining line (cash refund)', Number(cn2Doc.is_return) === 1 && cn2Doc.return_against === A.inv.name, `${cn2}: ${JSON.stringify(cn2Doc)}`)

  // ---- 7.7 Damaged condition + store credit, found by CLIENT
  const B = await sell({ codes: ['ACC-010'], mode: 'cash', client: CLIENT.no })
  const dmgWh = 'HOU-MTR Damaged - CCZ'
  const dmgBefore = (await admin.list('Bin', { item_code: 'ACC-010', warehouse: dmgWh }, ['actual_qty'], 1))[0]
  await findSale(CLIENT.name)
  const resultsCount = await page.locator('.result').count()
  const openInv = (await page.locator('.card.block .section-title').first().textContent().catch(() => '')).trim()
  record('7.4b find the sale by client name', openInv === B.inv.name || resultsCount > 0, `search "${CLIENT.name}" → ${resultsCount} results, opened "${openInv}"`)
  if (resultsCount > 0) { await page.locator('.result', { hasText: B.inv.name }).first().click(); await page.waitForSelector('.lines .line', { timeout: 20000 }) }
  const l1 = page.locator('.lines .line').first()
  await l1.locator('.line-head').click()
  await page.waitForTimeout(400)
  await l1.locator('.seg .chip:has-text("Damaged")').click()
  await page.locator('.method:has-text("Store credit")').click()
  await shot(page, 'returns-damaged-storecredit')
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.section-title:has-text("Credit note")', { timeout: 40000 })
  const cn3 = (await page.locator('.section-title:has-text("Credit note")').textContent()).replace('Credit note', '').trim()
  created.push(cn3)
  const doneTxt3 = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  const cn3Doc = await admin.value('Sales Invoice', cn3, ['maison_refund_method', 'outstanding_amount', 'grand_total', 'is_return'])
  record('7.7 refund to store credit stays on the client account', /store credit/i.test(doneTxt3) && /Store Credit/i.test(String(cn3Doc.maison_refund_method || '')),
    `${cn3}: ${JSON.stringify(cn3Doc)}; screen="${doneTxt3.slice(0, 220)}"`)
  await sleep(2500)
  const dmgAfter = (await admin.list('Bin', { item_code: 'ACC-010', warehouse: dmgWh }, ['actual_qty'], 1))[0]
  record('7.5b a Damaged return goes to the store\'s Damaged warehouse, not the sales floor',
    Number(dmgAfter?.actual_qty || 0) === Number(dmgBefore?.actual_qty || 0) + 1,
    `${dmgWh} ${dmgBefore?.actual_qty || 0} → ${dmgAfter?.actual_qty || 0}`)
  await shot(page, 'returns-done-storecredit')
} catch (e) {
  record('t7a crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t7a').catch(() => {})
} finally {
  L.writeResults('results-t7a.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
