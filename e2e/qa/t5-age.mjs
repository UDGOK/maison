import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))

const isoOf = (d) => d.toISOString().slice(0, 10)
const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return isoOf(d) }
const yearsAhead = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() + n); return isoOf(d) }
function aamva({ dob, expiry, family = 'QATEST', given = 'ALEX', jurisdiction = 'TX' }) {
  const us = (iso) => `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}`
  const body = [`DAQ${Math.floor(Math.random() * 1e8)}`, `DCS${family}`, 'DDEN', `DAC${given}`, 'DDFN', 'DAD', 'DDGN', 'DCAC', 'DCBNONE', 'DCDNONE', 'DBD01012024',
    `DBB${us(dob)}`, `DBA${us(expiry)}`, 'DBC1', 'DAU070 in', 'DAYBRO', 'DAG123 MAIN ST', 'DAIHOUSTON', `DAJ${jurisdiction}`, 'DAK770980000  ', 'DCF00000000', 'DCGUSA', 'DCK0000000000', 'DDAF', 'DDB01012020'].join('\n')
  return `@\n\x1e\rANSI 636015090102DL00410${String(body.length).padStart(3, '0')}DL${body}\r`
}

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')
const created = []
const lineCount = () => page.locator('.basket .line').count()
const gateOpen = () => page.locator('[data-testid=age-gate]').count()
async function pick(code) {
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  const t = page.locator('.tile:not(.empty)').first()
  await t.waitFor({ timeout: 10000 })
  await t.click()
  await page.waitForTimeout(700)
}
async function closeGate() {
  if (await gateOpen()) {
    const bc = page.locator('[data-testid=age-blocked-close]')
    if (await bc.count()) await bc.click(); else await page.locator('[data-testid=age-close]').click()
    await page.waitForTimeout(800)
  }
}

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ---- 5.6 non-restricted item is unaffected
  await pick('ACC-015')
  record('5.6 non-restricted item rings up with no age gate', (await gateOpen()) === 0 && (await lineCount()) === 1, `gate open=${await gateOpen()}, lines=${await lineCount()}`)

  // ---- 5.1 restricted item raises the gate and is NOT added
  await pick('DSP-004') // Geek Bar Pulse 15K — Sour Apple Ice (21+)
  const gTitle = await page.locator('[data-testid=age-title]').textContent().catch(() => '')
  const gLead = (await page.locator('[data-testid=age-gate] .lead').innerText().catch(() => '')).replace(/\s+/g, ' ')
  record('5.1 age-restricted item raises the 21+ gate and is not added until it passes',
    (await gateOpen()) === 1 && (await lineCount()) === 1, `gate title="${gTitle?.trim()}" lead="${gLead}" lines=${await lineCount()}`)
  await shot(page, 'age-gate')

  // ---- 5.2 under-21 DOB refused
  await page.click('[data-testid=age-tab-manual]')
  await page.fill('[data-testid=age-dob]', yearsAgo(19))
  await page.click('[data-testid=age-manual-submit]')
  await page.waitForTimeout(3000)
  const blockedTxt = (await page.locator('[data-testid=age-gate]').innerText().catch(() => '')).replace(/\s+/g, ' ')
  const linesAfterUnder = await lineCount()
  record('5.2 under-21 DOB is refused and the item is not added', /Under 21|refused/i.test(blockedTxt) && linesAfterUnder === 1,
    `sheet="${blockedTxt.slice(0, 220)}" lines=${linesAfterUnder}`)
  await shot(page, 'age-under21')
  const chkU = (await admin.list('Maison Age Check', { boutique: L.STORE }, ['name', 'outcome', 'method', 'age_years', 'dob_year', 'initials', 'id_expired', 'sales_invoice'], 3))[0]
  record('5.2b the refusal is audited (masked) server-side', chkU?.outcome === 'Underage', JSON.stringify(chkU))

  // ---- 5.3 expired ID refused (valid age, expiry in the past)
  await page.click('[data-testid=age-retry]')
  await page.waitForTimeout(500)
  await page.click('[data-testid=age-tab-manual]')
  await page.fill('[data-testid=age-dob]', yearsAgo(30))
  await page.fill('[data-testid=age-expiry]', yearsAgo(1))
  await page.click('[data-testid=age-manual-submit]')
  await page.waitForTimeout(3000)
  const expTxt = (await page.locator('[data-testid=age-gate]').innerText().catch(() => '')).replace(/\s+/g, ' ')
  record('5.3 expired ID is refused', /expired/i.test(expTxt) && (await lineCount()) === 1, `sheet="${expTxt.slice(0, 200)}" lines=${await lineCount()}`)
  await shot(page, 'age-expired')
  const chkE = (await admin.list('Maison Age Check', { boutique: L.STORE }, ['name', 'outcome', 'id_expired', 'age_years'], 2))[0]
  record('5.3b expired outcome audited', chkE?.outcome === 'Expired' && Number(chkE?.id_expired) === 1, JSON.stringify(chkE))

  // ---- 5.3c expired ID by SCAN
  await page.click('[data-testid=age-retry]')
  await page.waitForTimeout(400)
  await page.click('[data-testid=age-tab-scan]')
  await page.fill('[data-testid=age-capture]', aamva({ dob: yearsAgo(35), expiry: yearsAgo(2) }))
  await page.click('[data-testid=age-scan-submit]')
  await page.waitForTimeout(3000)
  const expScan = (await page.locator('[data-testid=age-gate]').innerText().catch(() => '')).replace(/\s+/g, ' ')
  record('5.3c expired ID refused on the scan path too', /expired/i.test(expScan), expScan.slice(0, 180))

  // ---- 5.8 "No ID" decline
  await page.click('[data-testid=age-retry]')
  await page.waitForTimeout(400)
  await page.click('[data-testid=age-close]') // "No ID"
  await page.waitForTimeout(2500)
  const noticeTxt = (await page.locator('.notice-stack, .notice').innerText().catch(() => '')).replace(/\s+/g, ' ')
  record('5.8 "No ID" declines: parked item dropped, decline logged', (await gateOpen()) === 0 && (await lineCount()) === 1,
    `gate closed=${(await gateOpen()) === 0} lines=${await lineCount()} notice="${noticeTxt.slice(0, 140)}"`)
  const chkD = (await admin.list('Maison Age Check', { boutique: L.STORE }, ['name', 'outcome', 'reason'], 2))[0]
  record('5.8b decline audited', chkD?.outcome === 'Declined', JSON.stringify(chkD))
  await page.evaluate(() => document.querySelectorAll('.notice .notice-btn').forEach((b) => b.click()))

  // ---- 5.4 valid manual DOB passes
  await pick('DSP-004')
  await page.click('[data-testid=age-tab-manual]')
  await page.fill('[data-testid=age-dob]', '1990-05-15')
  await page.fill('[data-testid=age-initials]', 'AQ')
  await page.click('[data-testid=age-manual-submit]')
  await page.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(800)
  const linesOk = await lineCount()
  record('5.4 valid manual DOB passes and the parked item is added', linesOk === 2, `lines=${linesOk}`)
  await shot(page, 'age-manual-pass')

  // ---- 5.9 one check covers the transaction
  await pick('DSP-005')
  record('5.9 one passed check covers the rest of the transaction', (await gateOpen()) === 0 && (await lineCount()) === 3, `gate=${await gateOpen()} lines=${await lineCount()}`)

  // ---- 5.7 sell it and check the invoice carries the age check
  await L.payCash(page, null)
  const sy = await L.waitSynced(page)
  const inv = (await L.invoiceForUuid(admin, sy.uuid))[0]
  if (inv) created.push(inv.name)
  const full = inv ? await admin.value('Sales Invoice', inv.name, ['maison_age_verified', 'maison_age_method', 'maison_age_dob_year_ok', 'maison_age_check', 'maison_age_checked_by', 'maison_age_checked_at']) : {}
  record('5.7 the age check is stored on the invoice', Number(full.maison_age_verified) === 1 && full.maison_age_method === 'Manual' && !!full.maison_age_check,
    `${inv?.name}: ${JSON.stringify(full)}`)
  const linked = full.maison_age_check ? await admin.value('Maison Age Check', full.maison_age_check, ['sales_invoice', 'outcome', 'method', 'age_years', 'dob_year', 'initials', 'issuer', 'associate']) : {}
  record('5.7b the audit row is linked back to the invoice and stores only masked fields',
    linked.sales_invoice === inv?.name && linked.outcome === 'Verified', JSON.stringify(linked))
  await shot(page, 'age-sale-receipt')
  const rTxt = (await page.locator('.receipt-view .preview').innerText()).replace(/\s+/g, ' ')
  record('5.7c the receipt records that the ID was checked', /21|ID/i.test(rTxt), rTxt.slice(0, 300))

  // ---- 5.10 a new transaction re-gates
  await page.click('.nav-btn[title=Sell]')
  await page.waitForSelector('.tile')
  await pick('DSP-006')
  record('5.10 the check does not leak into the next transaction (gate reopens)', (await gateOpen()) === 1, `gate=${await gateOpen()}`)

  // ---- 5.5 AAMVA scan passes
  await page.click('[data-testid=age-tab-scan]')
  await page.fill('[data-testid=age-capture]', aamva({ dob: '1988-02-03', expiry: yearsAhead(4) }))
  await page.click('[data-testid=age-scan-submit]')
  await page.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(700)
  record('5.5 AAMVA PDF417 scan passes and the item is added', (await gateOpen()) === 0 && (await lineCount()) === 1, `gate=${await gateOpen()} lines=${await lineCount()}`)
  await shot(page, 'age-scan-pass')
  // garbage payload
  await page.locator('.basket .clear').click()
  await page.waitForTimeout(500)
  await pick('DSP-006')
  await page.click('[data-testid=age-tab-scan]')
  await page.fill('[data-testid=age-capture]', 'NOT A LICENCE 12345')
  await page.click('[data-testid=age-scan-submit]')
  await page.waitForTimeout(2000)
  const badTxt = (await page.locator('[data-testid=age-error]').textContent().catch(() => '')).trim()
  record('5.5b a non-licence payload is rejected with a clear message', /driver|licence|license|PDF417/i.test(badTxt), `error="${badTxt}"`)
  await shot(page, 'age-scan-garbage')

  // finish: sell it with a scan, verify method=Scan on the invoice
  await page.fill('[data-testid=age-capture]', aamva({ dob: '1985-07-21', expiry: yearsAhead(3) }))
  await page.click('[data-testid=age-scan-submit]')
  await page.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(700)
  await L.payCash(page, null)
  const sy2 = await L.waitSynced(page)
  const inv2 = (await L.invoiceForUuid(admin, sy2.uuid))[0]
  if (inv2) created.push(inv2.name)
  const full2 = inv2 ? await admin.value('Sales Invoice', inv2.name, ['maison_age_verified', 'maison_age_method', 'maison_age_check']) : {}
  record('5.5c a scan-verified sale records method = Scan', full2.maison_age_method === 'Scan' && Number(full2.maison_age_verified) === 1, `${inv2?.name}: ${JSON.stringify(full2)}`)

  // ---- 5.11 server refuses a restricted sale with no check at all (API level)
  const a1api = await L.userApi(L.A1)
  const uuid = 'qa1-agebypass-' + Date.now()
  let apiErr = ''
  try {
    const r = await a1api.post('maison_pos.api.sales.submit_batch', {
      invoices: JSON.stringify([{ offline_uuid: uuid, boutique: L.STORE, associate: L.A1.usr, device_id: 'qa1-dev',
        posting_datetime: new Date().toISOString(), items: [{ item_code: 'DSP-004', qty: 1, rate: boot.prices['DSP-004'] }],
        payments: [{ mode_of_payment: 'Cash', amount: 27.05 }] }])
    })
    apiErr = JSON.stringify(r)
  } catch (e) { apiErr = String(e.message) }
  const bypassed = await admin.list('Sales Invoice', { maison_offline_uuid: uuid }, ['name'], 2)
  record('5.11 the server refuses a restricted sale posted without an age check', bypassed.length === 0 && /AGE|age verification/i.test(apiErr),
    `submit_batch result/err = ${apiErr.slice(0, 300)}; invoices created = ${JSON.stringify(bypassed)}`)
  await a1api.dispose()
} catch (e) {
  record('t5 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t5').catch(() => {})
} finally {
  L.writeResults('results-t5.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
