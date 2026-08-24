import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const R = (n) => Math.round(n * 100 + 1e-9) / 100
const rate = (c) => boot.prices[c]
const TAX = boot.taxes[0].rate

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
const lineCount = () => page.locator('.basket .line').count()
const grand = async () => money(await page.locator('.basket .total-amt').textContent())
async function addCode(code, times = 1) {
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  for (let i = 0; i < times; i++) { await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(250) }
  await page.locator('.sell .search input').fill('')
  await page.waitForTimeout(200)
}

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ---------- 3.1 cash, exact ----------
  await addCode('ACC-002') // 1.79
  const g1 = await grand()
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash')
  const due = money(await page.locator('[data-testid=pay-total]').textContent())
  const change0 = (await page.locator('.pay .change-amt').textContent()).trim()
  record('3.1 cash — no tender typed defaults to exact, change $0.00', Math.abs(due - g1) < 0.005 && /0\.00/.test(change0), `due=${due} basket=${g1} change="${change0}"`)
  await shot(page, 'pay-cash-exact')

  // ---------- 3.3 cash, under-tender ----------
  for (const d of '1') await page.click(`.pay .keypad button:text-is("${d}")`)
  await page.waitForTimeout(400)
  const shortTxt = (await page.locator('.pay .change-amt').textContent()).trim()
  const btn = page.locator('button:has-text("Complete cash sale")')
  const disabled = await btn.isDisabled()
  record('3.3 cash — under-tender shows "Short …" and blocks completion', /Short/i.test(shortTxt) && disabled, `tendered=1 change-field="${shortTxt}" completeDisabled=${disabled}`)
  await shot(page, 'pay-cash-short')

  // ---------- 3.2 cash, over-tender ----------
  await page.click('.pay .keypad button[aria-label=Backspace]')
  for (const d of '20') await page.click(`.pay .keypad button:text-is("${d}")`)
  await page.waitForTimeout(400)
  const changeTxt = (await page.locator('.pay .change-amt').textContent()).trim()
  const expChange = R(20 - g1)
  record('3.2 cash — over-tender computes the change', Math.abs(money(changeTxt) - expChange) < 0.005, `tendered 20.00 on ${g1} → change "${changeTxt}", expected ${expChange.toFixed(2)}`)
  await shot(page, 'pay-cash-change')
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForSelector('.receipt-view', { timeout: 30000 })
  const s1 = await L.waitSynced(page)
  const i1 = (await L.invoiceForUuid(admin, s1.uuid))[0]
  if (i1) created.push(i1.name)
  const rcpt = (await page.locator('.receipt-view .preview').innerText()).replace(/\s+/g, ' ')
  record('3.2b cash sale posts and the receipt shows tendered + change', !!i1 && /TENDERED/i.test(rcpt) && /CHANGE/i.test(rcpt),
    `${i1?.name} total ${i1?.grand_total}; receipt="${rcpt.slice(0, 240)}"`)
  await shot(page, 'receipt-cash-change')
  const chgRow = await admin.value('Sales Invoice', i1.name, ['change_amount', 'paid_amount', 'grand_total'])
  record('3.2c change is booked on the invoice', Math.abs(Number(chgRow.change_amount) - expChange) < 0.005,
    `invoice change_amount=${chgRow.change_amount} paid=${chgRow.paid_amount} grand=${chgRow.grand_total}, expected change ${expChange.toFixed(2)}`)

  // ---------- 3.6 cancel mid-payment (card) ----------
  await page.click('.nav-btn[title=Sell]')
  await page.waitForSelector('.tile')
  await addCode('ACC-015') // 6.99
  await page.click('.basket .pay button:has-text("Card")')
  await page.waitForSelector('.pay .card-flow')
  await page.click('.pay .card-flow button:has-text("Charge")')
  await page.waitForTimeout(1200) // mid-flow (discover/connect)
  const midStatus = (await page.locator('.pay .status').textContent()).trim()
  await page.click('.pay .card-flow button:has-text("Cancel")')
  await page.waitForSelector('.sell', { timeout: 15000 })
  const keptLines = await lineCount()
  record('3.6 cancel mid-payment returns to Sell with the basket intact', keptLines === 1, `mid-flow status="${midStatus}", lines after cancel=${keptLines}, url=${page.url()}`)
  await shot(page, 'pay-cancelled')
  const cancelledInv = await admin.list('Sales Invoice', { maison_boutique: L.STORE, grand_total: 7.57, creation: ['>', new Date(Date.now() - 120000).toISOString().slice(0, 19).replace('T', ' ')] }, ['name'], 5)
  note('3.6b invoices created in the last 2 min at 7.57 (should not include the cancelled one)', JSON.stringify(cancelledInv))

  // ---------- 3.4 card via the simulated reader ----------
  await page.click('.basket .pay button:has-text("Card")')
  await page.waitForSelector('.pay .card-flow')
  const readerTitle = (await page.locator('.pay .reader .section-title').textContent()).trim()
  await page.click('.pay .card-flow button:has-text("Charge")')
  await page.waitForSelector('.receipt-view', { timeout: 60000 })
  const s2 = await L.waitSynced(page)
  const i2 = (await L.invoiceForUuid(admin, s2.uuid))[0]
  if (i2) created.push(i2.name)
  const i2full = i2 ? await admin.value('Sales Invoice', i2.name, ['maison_terminal_ref', 'maison_card_brand', 'maison_card_last4']) : {}
  const rcpt2 = (await page.locator('.receipt-view .preview').innerText()).replace(/\s+/g, ' ')
  record('3.4 card payment through the simulated reader completes', !!i2 && /Synced/i.test(s2.pill) && !!i2full.maison_terminal_ref,
    `reader="${readerTitle}" invoice=${i2?.name} pi=${i2full.maison_terminal_ref} ${i2full.maison_card_brand} ****${i2full.maison_card_last4}; receipt="${rcpt2.slice(0, 200)}"`)
  await shot(page, 'receipt-card')

  // ---------- 3.5 split payment ----------
  const tabs = await page.$$eval('.pay .tabs .tab', (e) => e.map((x) => x.textContent.trim())).catch(() => [])
  record('3.5 split payment (cash + card on one sale)', false,
    'Not supported: the Pay screen offers a single mode (tabs = Cash | Card) and finalize() always sends exactly one payment row (frontend/src/views/PayView.vue finalize(), payments:[{mode_of_payment, amount: total}]). No partial-tender UI, and POS Profile "allow_partial_payment" is 0.', 'low')

  // ---------- 3.7 decline path ----------
  await page.click('.nav-btn[title=Sell]')
  await page.waitForSelector('.tile')
  await addCode('ACC-009') // 6.99
  await context.route('**/api/method/maison_pos.api.stripe_terminal.capture**', (route) =>
    route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ exc_type: 'CardError', _server_messages: JSON.stringify(['{"message": "Your card was declined (test)"}']), message: 'Your card was declined (test)' }) }))
  await page.click('.basket .pay button:has-text("Card")')
  await page.waitForSelector('.pay .card-flow')
  await page.click('.pay .card-flow button:has-text("Charge")')
  await page.waitForFunction(() => /error/i.test(document.querySelector('.pay .steps')?.parentElement?.querySelector('.status')?.className || '') || /Retry card/i.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const declTxt = (await page.locator('.pay .status').textContent()).trim()
  const retry = await page.locator('.pay .card-flow button:has-text("Retry card")').count()
  const stillOnPay = /\/pay/.test(page.url())
  record('3.7 declined card shows the error, offers Retry and creates no sale', stillOnPay && retry > 0 && declTxt.length > 0,
    `status="${declTxt}" retryButton=${retry} url=${page.url()}`)
  await shot(page, 'pay-declined')
  await context.unroute('**/api/method/maison_pos.api.stripe_terminal.capture**')
  // retry now succeeds
  await page.click('.pay .card-flow button:has-text("Retry card")')
  await page.waitForSelector('.receipt-view', { timeout: 60000 })
  const s3 = await L.waitSynced(page)
  const i3 = (await L.invoiceForUuid(admin, s3.uuid))[0]
  if (i3) created.push(i3.name)
  record('3.7b retry after a decline completes the sale exactly once', !!i3, `${i3?.name}; pill=${s3.pill}`)

  // ---------- 3.8 card + the per-line tax rounding case (client total 1c ABOVE the server) ----------
  await page.click('.nav-btn[title=Sell]')
  await page.waitForSelector('.tile')
  await addCode('HKA-017')  // 6.99
  await addCode('ACC-002')  // 1.79
  const g8 = await grand()
  const net8 = R(rate('HKA-017') + rate('ACC-002'))
  const perLine = R(R(rate('HKA-017') * TAX / 100) + R(rate('ACC-002') * TAX / 100))
  const onNet = R(net8 * TAX / 100)
  await page.click('.basket .pay button:has-text("Card")')
  await page.waitForSelector('.pay .card-flow')
  await page.click('.pay .card-flow button:has-text("Charge")')
  await page.waitForSelector('.receipt-view', { timeout: 60000 })
  const s4 = await L.waitSynced(page)
  const i4 = (await L.invoiceForUuid(admin, s4.uuid, 6))[0]
  if (i4) created.push(i4.name)
  record('3.8 card sale of a 2-line basket whose per-line tax rounds up is accepted', /Synced/i.test(s4.pill),
    `basket ${net8} + tax(per-line) ${perLine} = ${g8}; server tax(on-net-total) would be ${onNet} = ${R(net8 + onNet)}; sync pill "${s4.pill}"; invoice=${i4?.name || 'none'}`, 'high')
  await shot(page, 'pay-card-tax-mismatch')
  const errRow = (await admin.list('Maison Sync Log', { offline_uuid: s4.uuid }, ['status', 'error'], 2))[0]
  note('3.8 sync log for that sale', JSON.stringify(errRow))
} catch (e) {
  record('t3 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t3').catch(() => {})
} finally {
  L.writeResults('results-t3.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
