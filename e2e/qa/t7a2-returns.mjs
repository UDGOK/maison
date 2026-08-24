import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const R = (n) => Math.round(n * 100 + 1e-9) / 100
const CLIENT = { name: 'Andre Baptiste', no: '699911' }
const SALE_A = process.env.SALE_A || 'ACC-SINV-2026-03056'

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
async function pick(code) {
  if (!/\/sell/.test(page.url())) { await page.click('.nav-btn[title=Sell]'); await page.waitForSelector('.tile', { timeout: 20000 }) }
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(300)
  await page.locator('.sell .search input').fill('')
}
async function sell({ codes, mode = 'cash', client = null }) {
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' })
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
  return { inv, total: g, pill: sy.pill }
}
async function findSale(q) {
  await page.goto('/pos/returns', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.find input', { timeout: 25000 })
  await page.fill('.find input', q)
  await page.click('.find button:has-text("Find")')
  await page.waitForTimeout(1500)
}

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ---- 7.3 find by receipt QR link, full return of the remaining line, cash
  const tok = (await admin.value('Sales Invoice', SALE_A, ['maison_receipt_token'])).maison_receipt_token
  await findSale(`${L.BASE}/r/${tok}`)
  await page.waitForSelector('.lines .line', { timeout: 25000 })
  const hdr = (await page.locator('.card.block .section-title').first().textContent()).trim()
  record('7.3 find the sale by scanning the receipt QR link', hdr === SALE_A, `pasted ${L.BASE}/r/${tok} → invoice "${hdr}"`)
  const linesTxt = (await page.locator('.lines').innerText()).replace(/\s+/g, ' ')
  record('7.2b an already-returned line is flagged and cannot be returned again', /returned/i.test(linesTxt), linesTxt.slice(0, 240))
  await shot(page, 'returns-by-qr')
  const tray = page.locator('.lines .line', { hasText: 'Rolling Tray' }).first()
  await tray.locator('.line-head').click()
  await page.waitForTimeout(500)
  await page.locator('.method:has-text("Cash")').click()
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.section-title:has-text("Credit note")', { timeout: 45000 })
  const cn2 = (await page.locator('.section-title:has-text("Credit note")').textContent()).replace('Credit note', '').trim()
  created.push(cn2)
  const cn2Doc = await admin.value('Sales Invoice', cn2, ['grand_total', 'is_return', 'return_against', 'maison_refund_method'])
  record('7.2 full return of the remaining line, refunded in cash', Number(cn2Doc.is_return) === 1 && cn2Doc.return_against === SALE_A && /Cash/i.test(String(cn2Doc.maison_refund_method)),
    `${cn2}: ${JSON.stringify(cn2Doc)}`)
  await shot(page, 'returns-done-cash')
  const aFully = await admin.value('Sales Invoice', SALE_A, ['status', 'outstanding_amount'])
  note('7.2c original invoice after both returns', JSON.stringify(aFully))

  // ---- 7.10 points reversal (ERPNext rewrites the original entry)
  const lpe = await admin.list('Loyalty Point Entry', { customer: CLIENT.name }, ['invoice', 'loyalty_points', 'purchase_amount'], 8)
  const forA = lpe.filter((r) => r.invoice === SALE_A)
  record('7.10 points for a fully-returned sale are removed', forA.length === 0 || forA.every((r) => Number(r.loyalty_points) <= 0),
    `Loyalty Point Entry rows for ${SALE_A} = ${JSON.stringify(forA)}; all rows for ${CLIENT.name} = ${JSON.stringify(lpe.slice(0, 5))}`)

  // ---- 7.7 Damaged + store credit, found by client
  const B = await sell({ codes: ['ACC-010'], mode: 'cash', client: CLIENT.no })
  const dmgWh = 'HOU-MTR Damaged - CCZ'
  const dmgBefore = (await admin.list('Bin', { item_code: 'ACC-010', warehouse: dmgWh }, ['actual_qty'], 1))[0]
  const shopBefore = (await admin.list('Bin', { item_code: 'ACC-010', warehouse: L.WH }, ['actual_qty'], 1))[0]
  await findSale(CLIENT.name)
  const resultsCount = await page.locator('.result').count()
  if (resultsCount > 0) {
    await page.locator('.result', { hasText: B.inv.name }).first().click()
    await page.waitForSelector('.lines .line', { timeout: 20000 })
  } else await page.waitForSelector('.lines .line', { timeout: 20000 })
  const openInv = (await page.locator('.card.block .section-title').first().textContent()).trim()
  record('7.4b find the sale by client name', openInv === B.inv.name, `search "${CLIENT.name}" → ${resultsCount} results, opened "${openInv}"`)
  await shot(page, 'returns-by-client')
  const l1 = page.locator('.lines .line').first()
  await l1.locator('.line-head').click()
  await page.waitForTimeout(400)
  await l1.locator('.seg .chip:has-text("Damaged")').click()
  await page.locator('.method:has-text("Store credit")').click()
  await shot(page, 'returns-damaged-storecredit')
  await page.locator('.summary button.btn-primary').click()
  await page.waitForSelector('.section-title:has-text("Credit note")', { timeout: 45000 })
  const cn3 = (await page.locator('.section-title:has-text("Credit note")').textContent()).replace('Credit note', '').trim()
  created.push(cn3)
  const doneTxt3 = (await page.locator('.page-body').innerText()).replace(/\s+/g, ' ')
  const cn3Doc = await admin.value('Sales Invoice', cn3, ['maison_refund_method', 'outstanding_amount', 'grand_total', 'is_return'])
  record('7.7 refund as store credit is booked on the client account', /Store Credit/i.test(String(cn3Doc.maison_refund_method || '')) && Math.abs(Number(cn3Doc.outstanding_amount)) > 0,
    `${cn3}: ${JSON.stringify(cn3Doc)}; screen="${doneTxt3.slice(0, 200)}"`)
  await sleep(3000)
  const dmgAfter = (await admin.list('Bin', { item_code: 'ACC-010', warehouse: dmgWh }, ['actual_qty'], 1))[0]
  const shopAfter = (await admin.list('Bin', { item_code: 'ACC-010', warehouse: L.WH }, ['actual_qty'], 1))[0]
  record('7.5b a Damaged return lands in the store Damaged warehouse, not on the sales floor',
    Number(dmgAfter?.actual_qty || 0) === Number(dmgBefore?.actual_qty || 0) + 1 && Number(shopAfter?.actual_qty) === Number(shopBefore?.actual_qty) - 1,
    `${dmgWh}: ${dmgBefore?.actual_qty || 0} → ${dmgAfter?.actual_qty || 0}; ${L.WH}: ${shopBefore?.actual_qty} → ${shopAfter?.actual_qty} (1 sold, 1 returned damaged)`)
  await shot(page, 'returns-done-storecredit')
} catch (e) {
  record('t7a2 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t7a2').catch(() => {})
} finally {
  L.writeResults('results-t7a2.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
