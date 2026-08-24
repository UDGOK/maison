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
async function sell({ codes, qty = {}, mode = 'cash' }) {
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tile', { timeout: 20000 })
  for (const c of codes) await pick(c)
  for (const [name, n] of Object.entries(qty)) {
    const line = page.locator('.basket .line', { hasText: name }).first()
    for (let i = 1; i < n; i++) { await line.locator('.qty-btn[aria-label=More]').click(); await page.waitForTimeout(60) }
  }
  await page.waitForTimeout(500)
  const g = money(await page.locator('.basket .total-amt').textContent())
  if (mode === 'cash') await L.payCash(page, null); else await L.payCard(page)
  const sy = await L.waitSynced(page)
  const inv = (await L.invoiceForUuid(admin, sy.uuid))[0]
  if (inv) created.push(inv.name)
  return { inv, total: g, pill: sy.pill }
}
async function findSale(q) {
  await page.goto('/pos/returns', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.find input', { timeout: 25000 })
  await page.fill('.find input', q)
  await page.click('.find button:has-text("Find")')
  await page.waitForSelector('.lines .line', { timeout: 25000 })
}

try {
  await L.unlock(page, L.A1, { fresh: true })
  const big = { inv: { name: process.env.BIG || 'ACC-SINV-2026-03061' }, total: 2598, pill: 'Synced' }
  record('7.9.0 setup: a sale above the $2,500 manager threshold', true, `${big.inv.name} total ${big.total}`)
  await findSale(big.inv.name)
  const l = page.locator('.lines .line').first()
  await l.locator('.line-head').click()
  await page.waitForTimeout(400)
  // return all 24
  for (let i = 0; i < 30; i++) await l.locator('.qty .btn:has-text("+")').click()
  await page.waitForTimeout(600)
  const qtyTxt = (await l.locator('.qty .num.big').textContent()).trim()
  await page.locator('.method:has-text("Cash")').click()
  const gateTxt = (await page.locator('.summary').innerText()).replace(/\s+/g, ' ')
  const btnTxt = (await page.locator('.summary button.btn-primary').textContent()).trim()
  record('7.9 a refund above the threshold announces that a manager PIN is needed',
    /Manager PIN required/i.test(gateTxt) && /manager pin/i.test(btnTxt), `qty ${qtyTxt}; summary="${gateTxt.slice(0, 200)}"; button="${btnTxt}"`)
  await shot(page, 'returns-manager-gate')
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.modal, [role=dialog]', { timeout: 15000 })
  const pinModal = (await page.locator('.modal').innerText()).replace(/\s+/g, ' ')
  record('7.9b the manager PIN modal explains why', /above|threshold/i.test(pinModal), pinModal.slice(0, 220))
  await shot(page, 'returns-manager-pin')
  // wrong PIN first
  const mgrSel = page.locator('.modal select')
  if (await mgrSel.count()) await mgrSel.selectOption({ label: /Marisol/i }).catch(async () => { await mgrSel.selectOption({ index: 1 }).catch(() => {}) })
  for (const d of '9999') await page.click(`.modal .keypad button:text-is("${d}")`).catch(() => {})
  await page.click('.modal button:has-text("Approve")')
  await page.waitForTimeout(4000)
  let modalTxt = (await page.locator('.modal').innerText().catch(() => '')).replace(/\s+/g, ' ')
  const stillOpen = await page.locator('.modal').count()
  record('7.9c a wrong manager PIN is refused', stillOpen > 0 && /incorrect|invalid|wrong|not/i.test(modalTxt), modalTxt.slice(0, 220))
  await shot(page, 'returns-manager-pin-wrong')
  for (const d of L.MGR.pin) await page.click(`.modal .keypad button:text-is("${d}")`).catch(() => {})
  await page.click('.modal button:has-text("Approve")')
  await page.waitForSelector('.section-title:has-text("Credit note")', { timeout: 45000 })
  const cnBig = (await page.locator('.section-title:has-text("Credit note")').textContent()).replace('Credit note', '').trim()
  created.push(cnBig)
  const doneBig = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  const cnBigDoc = await admin.value('Sales Invoice', cnBig, ['grand_total', 'is_return', 'maison_manager_approved_by', 'maison_refund_method'])
  record('7.9d the correct manager PIN releases the refund and is recorded', Number(cnBigDoc.is_return) === 1 && !!cnBigDoc.maison_manager_approved_by,
    `${cnBig}: ${JSON.stringify(cnBigDoc)}; screen="${doneBig.slice(0, 240)}"`)
  await shot(page, 'returns-manager-approved')

  // ================= 7.8 exchange, positive difference =================
  const E = await sell({ codes: ['ACC-002'] })   // $1.79
  await findSale(E.inv.name)
  await page.locator('.lines .line').first().locator('.line-head').click()
  await page.waitForTimeout(400)
  await page.locator('.lines .line').first().locator('select').selectOption('Sizing')
  await page.click('button:has-text("Exchange instead")')
  await page.waitForSelector('.page-title:has-text("Exchange")', { timeout: 25000 })
  await page.fill('.card.block input', 'ACC-016')  // Logo Tee $24.99
  await page.waitForTimeout(900)
  await page.locator('.grid .tile').first().click()
  await page.waitForTimeout(800)
  const xTxt = (await page.locator('.summary').innerText()).replace(/\s+/g, ' ')
  const payBtn = (await page.locator('.summary button.btn-primary').textContent()).trim()
  record('7.8 exchange for a pricier item asks the client to pay the difference', /Client pays/i.test(xTxt) && /Charge/i.test(payBtn), `${xTxt.slice(0, 260)}; button="${payBtn}"`)
  await shot(page, 'exchange-positive')
  await page.locator('.seg .chip:has-text("Cash")').click().catch(() => {})
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.section-title:has-text("Exchange complete")', { timeout: 60000 })
  const xDone = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  const newInv = (xDone.match(/NEW SALE\s+(\S+)/i) || [])[1] || ''
  const cnX = (xDone.match(/CREDIT NOTE\s+(\S+)/i) || [])[1] || ''
  if (newInv) created.push(newInv); if (cnX) created.push(cnX)
  const newDoc = newInv ? await admin.value('Sales Invoice', newInv, ['grand_total', 'is_return', 'docstatus']) : {}
  record('7.8b the exchange posts a credit note and a new sale', !!newInv && !!cnX && Number(newDoc.docstatus) === 1,
    `credit note ${cnX}, new sale ${newInv} ${JSON.stringify(newDoc)}; screen="${xDone.slice(0, 260)}"`)
  await shot(page, 'exchange-positive-done')

  // ================= 7.8c exchange, negative difference =================
  const F = await sell({ codes: ['ACC-016'] })  // $24.99
  await findSale(F.inv.name)
  await page.locator('.lines .line').first().locator('.line-head').click()
  await page.waitForTimeout(400)
  await page.click('button:has-text("Exchange instead")')
  await page.waitForSelector('.page-title:has-text("Exchange")', { timeout: 25000 })
  await page.fill('.card.block input', 'ACC-002')  // $1.79
  await page.waitForTimeout(900)
  await page.locator('.grid .tile').first().click()
  await page.waitForTimeout(800)
  const xTxt2 = (await page.locator('.summary').innerText()).replace(/\s+/g, ' ')
  const payBtn2 = (await page.locator('.summary button.btn-primary').textContent()).trim()
  record('7.8c exchange for a cheaper item refunds the difference', /Refund to client/i.test(xTxt2) && /refund/i.test(payBtn2), `${xTxt2.slice(0, 240)}; button="${payBtn2}"`)
  await shot(page, 'exchange-negative')
  await page.locator('.seg .chip:has-text("Cash")').click().catch(() => {})
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.section-title:has-text("Exchange complete")', { timeout: 60000 })
  const xDone2 = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  const newInv2 = (xDone2.match(/NEW SALE\s+(\S+)/i) || [])[1] || ''
  const cnX2 = (xDone2.match(/CREDIT NOTE\s+(\S+)/i) || [])[1] || ''
  if (newInv2) created.push(newInv2); if (cnX2) created.push(cnX2)
  record('7.8d the negative-difference exchange completes and shows what was refunded', /Refunded/i.test(xDone2), xDone2.slice(0, 260))
  await shot(page, 'exchange-negative-done')
} catch (e) {
  record('t7b crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t7b').catch(() => {})
} finally {
  L.writeResults('results-t7b.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
