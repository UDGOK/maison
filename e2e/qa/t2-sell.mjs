import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, log, sleep, money } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const R = (n, p = 2) => { const f = 10 ** p; const s = n < 0 ? -1 : 1; return (s * Math.round(Math.abs(n) * f + 1e-9)) / f }
const rate = (c) => boot.prices[c]
const item = (c) => boot.items.find((i) => i.item_code === c)
const TAX = boot.taxes[0].rate

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []

const lineCount = () => page.locator('.basket .line').count()
const grand = async () => money(await page.locator('.basket .total-amt').textContent())
async function totalsRows() {
  return (await page.$$eval('.basket .totals .trow, .basket .totals .total', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim())))
}

try {
  await L.unlock(page, L.A1, { fresh: true })
  await page.waitForSelector('.tile', { timeout: 30000 })

  // ---------- 2.1 add by tap ----------
  const tapItem = 'ACC-015' // USB-C Cable 3ft 6.99
  await page.locator(`.tile:not(.empty):has-text("${item(tapItem).item_name}")`).first().click()
  await page.waitForTimeout(500)
  let n = await lineCount()
  let g = await grand()
  const exp1 = R(rate(tapItem) + R(rate(tapItem) * TAX / 100))
  record('2.1 add item by tapping the tile', n === 1 && Math.abs(g - exp1) < 0.005, `lines=${n} total=${g} expected=${exp1}`)
  await shot(page, 'sell-tap-add')

  // ---------- 2.2 add by search ----------
  const searchItem = 'HKA-017' // Hookah Mouth Tips 6.99
  await page.locator('.sell .search input').fill('Mouth Tips')
  await page.waitForTimeout(600)
  const shown = await page.locator('.tile:not(.empty)').count()
  await page.locator('.tile:not(.empty)').first().click()
  await page.waitForTimeout(500)
  n = await lineCount()
  record('2.2 add item by searching', n === 2 && shown >= 1, `search "Mouth Tips" → ${shown} tiles, lines=${n}`)
  await page.locator('.sell .search input').fill('')
  await page.waitForTimeout(300)
  // search by item code
  await page.locator('.sell .search input').fill('ACC-005')
  await page.waitForTimeout(600)
  const codeHits = await page.locator('.tile:not(.empty)').count()
  const codeName = await page.locator('.tile:not(.empty)').first().locator('.name').textContent().catch(() => '')
  record('2.2b search by item code works', codeHits >= 1 && /Butane/i.test(codeName), `"ACC-005" → ${codeHits} tiles, first="${codeName}"`)
  await page.locator('.sell .search input').fill('')
  await page.waitForTimeout(300)

  // ---------- 2.3 barcode wedge ----------
  const bcItem = 'ACC-009' // Boveda 6.99
  const ean = item(bcItem).maison_barcode
  await page.locator('.rail-btn:has-text("All")').first().click() // move focus out of the search field
  await page.waitForTimeout(300)
  const before = await lineCount()
  await page.keyboard.type(ean, { delay: 8 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const afterWedge = await lineCount()
  const names = await page.$$eval('.basket .line .line-name', (e) => e.map((x) => x.textContent.trim()))
  record('2.3 barcode wedge (type an EAN + Enter) adds the item', afterWedge === before + 1 && names.some((x) => x.includes('Boveda')),
    `EAN ${ean} → lines ${before}→${afterWedge}; basket=${JSON.stringify(names)}`)
  await shot(page, 'sell-wedge')

  // unknown barcode
  const before2 = await lineCount()
  await page.keyboard.type('2000000000001', { delay: 8 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const noticeTxt = (await page.locator('.notice, .notice-stack').innerText().catch(() => '')).replace(/\s+/g, ' ')
  record('2.3b unknown barcode is refused with a notice, nothing added', (await lineCount()) === before2 && /not|unknown|no match/i.test(noticeTxt || 'x'),
    `lines unchanged=${(await lineCount()) === before2}; notice="${noticeTxt.slice(0, 160)}"`)
  await shot(page, 'sell-wedge-unknown')
  await page.evaluate(() => document.querySelectorAll('.notice .notice-btn').forEach((b) => b.click()))

  // ---------- 2.4 qty +/- ----------
  const line0 = page.locator('.basket .line').first()
  await line0.locator('.qty-btn[aria-label=More]').click()
  await line0.locator('.qty-btn[aria-label=More]').click()
  await page.waitForTimeout(400)
  let qtyTxt = await line0.locator('.qty-n').textContent()
  const up3 = qtyTxt.trim() === '3'
  await line0.locator('.qty-btn[aria-label=Less]').click()
  await page.waitForTimeout(400)
  qtyTxt = await line0.locator('.qty-n').textContent()
  record('2.4 quantity + / - adjusts the line', up3 && qtyTxt.trim() === '2', `after ++ = 3? ${up3}; after - = ${qtyTxt.trim()}`)

  // qty down to zero removes the line
  const beforeZero = await lineCount()
  await line0.locator('.qty-btn[aria-label=Less]').click()
  await page.waitForTimeout(300)
  await page.locator('.basket .line').first().locator('.qty-btn[aria-label=Less]').click()
  await page.waitForTimeout(500)
  record('2.4b decrementing past 1 removes the line', (await lineCount()) === beforeZero - 1, `lines ${beforeZero} → ${await lineCount()}`)

  // ---------- 2.5 line discount ----------
  await page.locator('.basket .line').first().locator('.line-main').click()
  await page.waitForSelector('.modal, [role=dialog]', { timeout: 8000 }).catch(() => {})
  const dTitle = await page.locator('.modal .modal-head, .modal h2, .modal .title').first().textContent().catch(() => '')
  await page.locator('.modal input').first().fill('10')   // 10 %
  await page.locator('.modal button:has-text("Apply")').click()
  await page.waitForTimeout(600)
  const l0txt = (await page.locator('.basket .line').first().innerText()).replace(/\s+/g, ' ')
  const rows = await totalsRows()
  record('2.5 line discount (10 %) applies and shows on the line + totals', /−|-/.test(l0txt) && rows.some((r) => /Discount/i.test(r)),
    `line="${l0txt}" totals=${JSON.stringify(rows)}`)
  await shot(page, 'sell-line-discount')

  // discount by amount
  await page.locator('.basket .line').first().locator('.line-main').click()
  await page.waitForTimeout(400)
  await page.locator('.modal input').nth(1).fill('1.50')
  await page.locator('.modal button:has-text("Apply")').click()
  await page.waitForTimeout(600)
  const l0txt2 = (await page.locator('.basket .line').first().innerText()).replace(/\s+/g, ' ')
  record('2.5b line discount by amount ($1.50) applies', /1\.50/.test(l0txt2), `line="${l0txt2}"`)

  // ---------- 2.6 remove line ----------
  const beforeRm = await lineCount()
  await page.locator('.basket .line').first().locator('.line-main').click()
  await page.waitForTimeout(400)
  await page.locator('.modal button:has-text("Remove line")').click()
  await page.waitForTimeout(600)
  record('2.6 remove line from the line sheet', (await lineCount()) === beforeRm - 1, `lines ${beforeRm} → ${await lineCount()}`)

  // ---------- 2.7 clear basket ----------
  await page.locator('.basket .clear').click()
  await page.waitForTimeout(600)
  const emptyTxt = (await page.locator('.basket .lines').innerText()).replace(/\s+/g, ' ')
  record('2.7 clear basket empties it', (await lineCount()) === 0 && /empty/i.test(emptyTxt), `lines=${await lineCount()} "${emptyTxt}"`)

  // ---------- 2.9 tax to the cent, crafted 2-line basket ----------
  // HKA-012 x1 (12.99) + HKA-013 x2 (16.99) — per-line rounding (client) and On-Net-Total (ERPNext) differ by a cent
  await page.locator('.sell .search input').fill('HKA-012')
  await page.waitForTimeout(600)
  await page.locator('.tile:not(.empty)').first().click()
  await page.locator('.sell .search input').fill('HKA-013')
  await page.waitForTimeout(600)
  await page.locator('.tile:not(.empty)').first().click()
  await page.waitForTimeout(300)
  await page.locator('.sell .search input').fill('')
  const l13 = page.locator('.basket .line', { hasText: 'Titanium' }).first()
  await l13.locator('.qty-btn[aria-label=More]').click()
  await page.waitForTimeout(600)
  const net = R(rate('HKA-012') * 1 + rate('HKA-013') * 2)
  const taxPerLine = R(R(rate('HKA-012') * 1 * TAX / 100) + R(rate('HKA-013') * 2 * TAX / 100))
  const taxOnNet = R(net * TAX / 100)
  const uiRows = await totalsRows()
  const uiTax = money((uiRows.find((r) => /^Tax/i.test(r)) || '').split(' ').pop())
  const uiGrand = await grand()
  record('2.9 basket tax matches the store template rate (8.25 % of net), per-line rounding',
    Math.abs(uiTax - taxPerLine) < 0.005,
    `net=${net} UI tax=${uiTax} per-line=${taxPerLine} on-net-total=${taxOnNet} UI grand=${uiGrand}`)
  note('2.9 rounding models differ', `per-line sum = ${taxPerLine}, single On-Net-Total = ${taxOnNet} (Δ ${R(taxOnNet - taxPerLine)})`)
  await shot(page, 'sell-tax-basket')

  // pay it and compare with the server invoice
  await L.payCash(page, null)
  const sy = await L.waitSynced(page)
  const invs = await L.invoiceForUuid(admin, sy.uuid)
  const inv = invs[0]
  if (inv) created.push(inv.name)
  const srvTax = Number(inv?.total_taxes_and_charges || 0)
  const srvGrand = Number(inv?.grand_total || 0)
  record('2.9b server invoice tax equals what the POS charged the client',
    !!inv && Math.abs(srvTax - uiTax) < 0.005 && Math.abs(srvGrand - uiGrand) < 0.005,
    `POS tax ${uiTax} / total ${uiGrand} vs invoice ${inv?.name} tax ${srvTax} / total ${srvGrand} (docstatus ${inv?.docstatus}); sync pill "${sy.pill}"`,
    'high')
  record('2.9c the sale is accepted by the server (not rejected at sync)', /Synced/i.test(sy.pill), `pill="${sy.pill}"; invoice=${inv?.name || 'none'}`, 'high')
  await shot(page, 'receipt-tax-case')

  // ---------- 2.8 40+ line basket ----------
  await page.click('.nav-btn[title=Sell]')
  await page.waitForSelector('.tile', { timeout: 20000 })
  // pass the age gate once so restricted items can be added too
  const nonRestricted = boot.items.filter((i) => !i.maison_age_restricted && (i.is_stock_item === 0 || (boot.stock[i.item_code] || 0) > 3))
  const restricted = boot.items.filter((i) => i.maison_age_restricted && (boot.stock[i.item_code] || 0) > 3)
  const pickList = [...nonRestricted, ...restricted].slice(0, 44)
  let added = 0
  for (const it of pickList) {
    await page.locator('.sell .search input').fill(it.item_code)
    await page.waitForTimeout(280)
    const t = page.locator('.tile:not(.empty)').first()
    if (!(await t.count())) continue
    await t.click()
    // age gate on the first restricted item
    if (await page.locator('[data-testid=age-gate]').count()) {
      await page.click('[data-testid=age-tab-manual]')
      await page.fill('[data-testid=age-dob]', '1990-05-15')
      await page.click('[data-testid=age-manual-submit]')
      await page.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(400)
    }
    added++
    if ((await lineCount()) >= 42) break
  }
  await page.locator('.sell .search input').fill('')
  const bigN = await lineCount()
  // read every line back and compute the expected totals
  const uiLines = await page.$$eval('.basket .line', (els) => els.map((e) => ({
    name: e.querySelector('.line-name')?.textContent.trim(),
    sub: e.querySelector('.line-sub')?.textContent.replace(/\s+/g, ' ').trim(),
    amt: e.querySelector('.line-amt')?.textContent.trim()
  })))
  let expNet = 0, expTax = 0
  for (const l of uiLines) {
    const a = money(l.amt)
    expNet = R(expNet + a)
    expTax = R(expTax + R(a * TAX / 100))
  }
  const bigRows = await totalsRows()
  const bigTax = money((bigRows.find((r) => /^Tax/i.test(r)) || '').split(' ').pop())
  const bigGrand = await grand()
  record('2.8 40+ line basket renders and totals to the cent', bigN >= 40 && Math.abs(bigTax - expTax) < 0.005 && Math.abs(bigGrand - R(expNet + expTax)) < 0.005,
    `${bigN} lines; net=${expNet} tax UI=${bigTax} expected=${expTax}; grand UI=${bigGrand} expected=${R(expNet + expTax)}`)
  note('2.8 totals rows', JSON.stringify(bigRows))
  await shot(page, 'sell-40-lines', true)
  // clear again (do not sell 40 units of live stock)
  await page.locator('.basket .clear').click()
  await page.waitForTimeout(500)
  record('2.7b clear basket works on a 40+ line basket', (await lineCount()) === 0, `lines=${await lineCount()}`)

  // ---------- 2.10 service (non-stock) item ----------
  await page.locator('.sell .search input').fill('SVC-004')
  await page.waitForTimeout(600)
  const svcTile = page.locator('.tile').first()
  const svcSub = await svcTile.locator('.sub').textContent()
  const svcDisabled = await svcTile.isDisabled()
  await svcTile.click()
  await page.waitForTimeout(500)
  record('8.6 a service (non-stock) item can be sold', (await lineCount()) === 1 && !svcDisabled, `tile sub="${svcSub?.trim()}" disabled=${svcDisabled} lines=${await lineCount()}`)
  await L.payCash(page, 20)
  const sy2 = await L.waitSynced(page)
  const inv2 = (await L.invoiceForUuid(admin, sy2.uuid))[0]
  if (inv2) created.push(inv2.name)
  record('8.6b service sale posts server-side', !!inv2 && Number(inv2.docstatus) === 1, `${inv2?.name} total ${inv2?.grand_total} pill "${sy2.pill}"`)
  await shot(page, 'service-sale-receipt')
} catch (e) {
  record('t2 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t2').catch(() => {})
} finally {
  L.writeResults('results-t2.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
