import * as L from './lib-pos.mjs'
const { record, note, shot, log, sleep } = L

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page } = await L.posContext(browser, L.A1, 'pos')

try {
  // baseline: nobody else has locked our associates out
  const assocRows = await admin.list('AWANZ Associate', { boutique: L.STORE }, ['name', 'user', 'full_name', 'role', 'failed_pin_attempts', 'enabled'], 20)
  note('baseline associates @ ' + L.STORE, JSON.stringify(assocRows))

  // ---- 1.1 load catalogue
  await L.freshDevice(page)
  const t0 = Date.now()
  await L.loadCatalogue(page)
  const ms = Date.now() - t0
  const itemsTxt = await page.locator('.unlock').textContent()
  record('1.1 unlock screen loads the catalogue', true, `keypad shown after ${ms}ms`)
  await shot(page, 'unlock-loaded')

  // white-label check on the unlock screen
  const bodyTxt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('1.1b no Frappe/ERPNext wording on Unlock', !/frappe|erpnext/i.test(bodyTxt), bodyTxt.slice(0, 200))

  // ---- 1.2 wrong PIN names the selected associate
  const a1label = await L.pickAssociate(page, L.A1)
  await L.typePin(page, '9999')
  await page.waitForTimeout(1500)
  let err = (await page.locator('[data-testid=clock-msg]').textContent()).trim()
  record('1.3 wrong PIN rejected and names the associate', /Incorrect PIN for/i.test(err) && err.includes('Dante'), `msg="${err}" (associate option "${a1label}")`)
  await shot(page, 'unlock-wrong-pin')

  // ---- 1.4 another associate's PIN while A1 selected
  await L.typePin(page, L.A2.pin)
  await page.waitForTimeout(1500)
  err = (await page.locator('[data-testid=clock-msg]').textContent()).trim()
  record("1.4 other associate's PIN refused, message names the selected associate", /Incorrect PIN for Dante/i.test(err), `msg="${err}" (typed Keisha's PIN ${L.A2.pin} with Dante selected)`)

  // ---- 1.2 correct PIN
  await L.typePin(page, L.A1.pin)
  await page.waitForSelector('.topbar', { timeout: 30000 })
  await page.waitForSelector('.tile', { timeout: 30000 })
  record('1.2 correct PIN unlocks to Sell', true, page.url())
  await shot(page, 'sell-unlocked')

  const sellTxt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('1.2b no Frappe/ERPNext wording on Sell', !/frappe|erpnext/i.test(sellTxt), sellTxt.slice(0, 160))

  // ---- 1.7 Lock
  await page.click('.topbar .lock-btn')
  await page.waitForSelector('.unlock', { timeout: 15000 })
  record('1.7 Lock returns to the unlock screen', /\/unlock/.test(page.url()), page.url())
  await shot(page, 'locked')

  // ---- 1.5 clock in
  await L.pickAssociate(page, L.A1)
  const status0 = (await page.locator('[data-testid=shift-status]').textContent()).replace(/\s+/g, ' ').trim()
  const wasOn = /On shift|On break/i.test(status0)
  note('1.5 shift status before', status0)
  if (!wasOn) {
    await page.click('[data-testid=action-clock-in]')
    await L.typePin(page, L.A1.pin)
    await page.waitForSelector('.tile', { timeout: 30000 })
    await page.click('.topbar .lock-btn')
    await page.waitForSelector('.unlock', { timeout: 15000 })
    await L.pickAssociate(page, L.A1)
    await page.waitForTimeout(1200)
  }
  const status1 = (await page.locator('[data-testid=shift-status]').textContent()).replace(/\s+/g, ' ').trim()
  record('1.5 clock in puts the associate on shift', /On shift|On break/i.test(status1), `before="${status0}" after="${status1}"`)
  await shot(page, 'clocked-in')
  const shifts = await admin.list('AWANZ Shift', { associate: L.A1.usr }, ['name', 'status', 'clock_in', 'clock_out', 'boutique'], 3)
  record('1.5b clock-in recorded server-side', shifts.length > 0, JSON.stringify(shifts[0] || {}))

  // ---- 1.6 clock out
  await page.click('[data-testid=action-clock-out]')
  await L.typePin(page, L.A1.pin)
  await page.waitForTimeout(2500)
  const msg = (await page.locator('[data-testid=clock-msg]').textContent()).trim()
  const status2 = (await page.locator('[data-testid=shift-status]').textContent()).replace(/\s+/g, ' ').trim()
  record('1.6 clock out works and never opens the till', /Clocked out/i.test(msg) && /\/unlock/.test(page.url()), `msg="${msg}" status="${status2}" url=${page.url()}`)
  await shot(page, 'clocked-out')

  // ---- 1.8 PIN lockout: 5 wrong PINs for A2 (reset afterwards)
  const a2 = assocRows.find((r) => r.user === L.A2.usr)
  await L.pickAssociate(page, L.A2)
  const msgs = []
  for (let i = 0; i < 6; i++) {
    await L.typePin(page, '9876')
    await page.waitForTimeout(1400)
    msgs.push((await page.locator('[data-testid=clock-msg]').textContent()).trim())
  }
  const after = await admin.value('AWANZ Associate', a2.name, ['failed_pin_attempts'])
  const locked = Number(after.failed_pin_attempts || 0) >= 5
  record('1.8 PIN lockout counter increments and locks after 5 failures', locked, `failed_pin_attempts=${after.failed_pin_attempts}; messages=${JSON.stringify(msgs)}`)
  // does the UI say "locked"?
  const lockedMsgOk = /lock/i.test(msgs[msgs.length - 1])
  record('1.8b UI tells the associate the PIN is locked (not just "Incorrect PIN")', lockedMsgOk, `last message = "${msgs[msgs.length - 1]}"`, lockedMsgOk ? '' : 'medium')
  await shot(page, 'pin-lockout')
  // correct PIN must now be refused
  await L.typePin(page, L.A2.pin)
  await page.waitForTimeout(1800)
  const stillLocked = !/\/sell/.test(page.url())
  record('1.8c correct PIN refused while locked', stillLocked, `url=${page.url()} msg="${(await page.locator('[data-testid=clock-msg]').textContent()).trim()}"`)
  // CLEAN UP: reset the counter
  await admin.post('frappe.client.set_value', { doctype: 'AWANZ Associate', name: a2.name, fieldname: 'failed_pin_attempts', value: 0 })
  const reset = await admin.value('AWANZ Associate', a2.name, ['failed_pin_attempts'])
  note('cleanup: A2 failed_pin_attempts reset', JSON.stringify(reset))
  // and A1 too, in case the wrong-PIN tests bumped it
  const a1 = assocRows.find((r) => r.user === L.A1.usr)
  await admin.post('frappe.client.set_value', { doctype: 'AWANZ Associate', name: a1.name, fieldname: 'failed_pin_attempts', value: 0 })
} catch (e) {
  record('t1 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t1').catch(() => {})
} finally {
  L.writeResults('results-t1.json')
  await context.close(); await browser.close(); await admin.dispose()
}
