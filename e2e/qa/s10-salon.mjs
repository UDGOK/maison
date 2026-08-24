// QA4 · C — Salon: pair (code + QR/deep link), ambient, identify, mirror, pay, approved, thank-you.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep, money } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Member QA4A'
const PORTRAIT = { width: 1024, height: 1366 }
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const cust = await admin.value('Customer', MEMBER, ['maison_client_number', 'mobile_no', 'email_id', 'customer_name'])
const browser = await L.newBrowser()
const created = { sessions: [], invoices: [] }
const waitView = (page, view, ms = 20000) => page.waitForFunction((v) => document.documentElement.dataset.salonView === v, view, { timeout: ms })
const salonView = (page) => page.evaluate(() => document.documentElement.dataset.salonView)
const salonKey = async (page, digits) => { for (const d of String(digits)) await page.click(`[data-testid=salon-keypad] button:text-is("${d}")`) }
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))

const pos = await L.ctxFor(browser, L.A1, 'pos', { viewport: { width: 1440, height: 1024 } })
const salon = await L.ctxFor(browser, null, 'salon', { viewport: PORTRAIT })

// 1. POS Settings → pair
await L.unlock(pos.page, L.A1, { fresh: true })
const deviceId = await pos.page.evaluate(() => localStorage.getItem('maison.device_id') || '')
await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-settings]', { timeout: 20000 })
record('C · POS Settings has a "Client display" card', (await pos.page.locator('[data-testid=salon-status]').textContent()).includes('Not paired'), await pos.page.locator('[data-testid=salon-status]').textContent())
await pos.page.click('[data-testid=salon-pair]')
await pos.page.waitForSelector('[data-testid=salon-pair-code]', { timeout: 20000 })
const code = (await pos.page.locator('[data-testid=salon-pair-code]').textContent()).replace(/\D/g, '')
const qrShown = await pos.page.locator('[data-testid=salon-pair-qr]').count()
const ttl = (await pos.page.locator('[data-testid=salon-pair-ttl]').textContent()).trim()
record('C · the POS shows a 6-digit pairing code, its QR and a 10-minute countdown', /^\d{6}$/.test(code) && qrShown === 1 && /^(9|10):\d\d$/.test(ttl), `${code} · ${ttl} · qr=${qrShown}`)
await shot(pos.page, 'pos-salon-pairing-code')

// 2. Salon pairs with the code
await go(salon.page, '/salon')
await salon.page.evaluate(() => localStorage.clear())
await go(salon.page, '/salon')
await waitView(salon.page, 'pair')
await shot(salon.page, 'salon-pair-1024')
await salonKey(salon.page, code)
await waitView(salon.page, 'ambient', 25000)
record('C · the Salon pairs with the 6-digit code and lands on the ambient screen', true, `code ${code}`)
await pos.page.waitForFunction(() => document.querySelector('[data-testid=salon-status]')?.textContent?.includes('Paired'), null, { timeout: 20000 })
record('C · the POS card flips to "Paired"', true)
const st = await assoc.get('maison_pos.api.salon.pos_status', { boutique: L.STORE, pos_device_id: deviceId })
created.sessions.push(st.session?.token)
record('C · the server holds a Paired Maison Salon Session for this POS device', st.session?.status === 'Paired', `${st.session?.token?.slice(0, 10)}… boutique=${st.session?.boutique}`)
const clock = (await salon.page.locator('[data-testid=salon-clock]').textContent()).trim()
const ambientPiece = await salon.page.locator('[data-testid=ambient-piece]').count()
const wordmark = (await salon.page.locator('[data-testid=salon-wordmark]').textContent()).trim()
record('C · the ambient screen shows the brand, the hour and a curated piece', wordmark.toUpperCase().includes('CLOUDCHASERZ') && /\d/.test(clock) && ambientPiece === 1, `${wordmark} · ${clock} · pieces=${ambientPiece}`)
await shot(salon.page, 'salon-ambient-1024')

// 3. first piece → identify
await L.nav(pos.page, 'Sell')
await pos.page.waitForSelector('.tile', { timeout: 30000 })
await L.addItem(pos.page, 'Blazer Big Shot')
await waitView(salon.page, 'identify', 25000)
const idTxt = (await salon.page.locator('[data-testid=salon-identify]').innerText()).replace(/\s+/g, ' ')
record('C · the first piece with no client switches the Salon to "identify"', /set aside/i.test(idTxt), idTxt.slice(0, 180))
await shot(salon.page, 'salon-identify-1024')

// 4. identify — client number on the keypad, then phone
await salon.page.click('[data-testid=identify-phone]')
await salon.page.waitForSelector('[data-testid=identify-display]')
await salonKey(salon.page, cust.maison_client_number.replace(/\D/g, ''))
const maskedTyped = (await salon.page.locator('[data-testid=identify-display]').textContent()).trim()
record('C · the keypad masks what the client types', /•/.test(maskedTyped), maskedTyped)
await shot(salon.page, 'salon-identify-keypad')
await salon.page.click('[data-testid=identify-go]')
const foundByNumber = await waitView(salon.page, 'client', 12000).then(() => true).catch(() => false)
record('C · a client number typed on the Salon keypad identifies the client', foundByNumber,
  `typed ${cust.maison_client_number.replace(/\D/g, '')} (the keypad has no letters, so the MC prefix cannot be entered) → ${foundByNumber ? 'client' : 'error: ' + (await salon.page.locator('[data-testid=identify-error]').textContent().catch(() => '')).trim()}`,
  foundByNumber ? '' : 'moderate')
const g = await L.guestApi()
const byBare = await g.rawPost('maison_pos.api.salon.identify', { token: st.session.token, code: cust.maison_client_number.replace(/\D/g, '') })
const byPrefixed = await g.rawPost('maison_pos.api.salon.identify', { token: st.session.token, code: cust.maison_client_number })
record('C · the identify API accepts the printed client number (MC######)', byPrefixed.body?.message?.found === true,
  `bare digits → found=${byBare.body?.message?.found}; "${cust.maison_client_number}" → found=${byPrefixed.body?.message?.found}`)
if (!foundByNumber) {
  await salon.page.click('[data-testid=salon-keypad] button:text-is("Clear")').catch(() => {})
  await waitView(salon.page, 'client', 20000).catch(async () => {
    await salon.page.click('[data-testid=identify-phone]').catch(() => {})
    await salonKey(salon.page, String(cust.mobile_no).replace(/\D/g, '').slice(-10))
    await salon.page.click('[data-testid=identify-go]')
    await waitView(salon.page, 'client', 20000)
  })
}
const byEmail = await g.rawPost('maison_pos.api.salon.identify', { token: st.session.token, code: cust.email_id })
record('C · identify by e-mail finds the client', byEmail.body?.message?.found === true, `${cust.email_id} → ${JSON.stringify(byEmail.body?.message?.client || byEmail.body?.message).slice(0, 140)}`)
const byUnknown = await g.rawPost('maison_pos.api.salon.identify', { token: st.session.token, code: '+1 918 555 0000' })
record('C · an unknown number answers "not found" with no hint', byUnknown.body?.message?.found === false && Object.keys(byUnknown.body?.message || {}).length === 1, JSON.stringify(byUnknown.body?.message))
const firstName = (await salon.page.locator('[data-testid=client-first-name]').textContent()).trim()
const maskedLine = (await salon.page.locator('[data-testid=client-masked]').textContent()).trim()
const points = (await salon.page.locator('[data-testid=client-points]').textContent()).trim()
record('C · the client screen welcomes the client with masked contact details', firstName.length > 0 && /•/.test(maskedLine) && !maskedLine.includes(String(cust.mobile_no || '').replace(/\D/g, '')) && !maskedLine.includes(cust.email_id),
  `"${firstName}" · "${maskedLine}" · points=${points}`)
const stateJson = JSON.stringify(await g.get('maison_pos.api.salon.state', { token: st.session.token }))
record('C · the Salon state carries no full phone, e-mail or other client\'s data', !stateJson.includes(cust.email_id) && !stateJson.includes(String(cust.mobile_no).replace(/\D/g, '')),
  `state payload checked for ${cust.email_id} / ${cust.mobile_no}`)
await shot(salon.page, 'salon-client-welcome')
await pos.page.waitForFunction(() => !!document.querySelector('.basket .client-name'), null, { timeout: 20000 })
record('C · the POS basket picks up the client the Salon identified', true, (await pos.page.locator('.basket .client-name').textContent()).trim())
await dismissNotices(pos.page)

// 5. basket mirror
await L.addItem(pos.page, 'Aluminum 4-pc Grinder')
await waitView(salon.page, 'basket', 30000)
await salon.page.waitForFunction(() => document.querySelectorAll('[data-testid=basket-lines] li').length >= 2, null, { timeout: 20000 })
await L.addItem(pos.page, 'BIC Lighter')
await salon.page.waitForFunction(() => document.querySelectorAll('[data-testid=basket-lines] li').length >= 3, null, { timeout: 20000 })
const focusName = (await salon.page.locator('[data-testid=basket-focus-name]').textContent()).trim()
const posTotal = money(await pos.page.locator('.basket .total-amt').textContent())
await salon.page.waitForFunction((t) => Math.abs(parseFloat((document.querySelector('[data-testid=basket-total]')?.textContent || '0').replace(/[^0-9.]/g, '')) - t) < 0.01, posTotal, { timeout: 20000 }).catch(() => {})
const salonTotal = money(await salon.page.locator('[data-testid=basket-total]').textContent())
record('C · the basket mirror follows the POS (lines, focus piece, total)', Math.abs(salonTotal - posTotal) < 0.01 && /lighter/i.test(focusName), `focus="${focusName}" salon $${salonTotal} vs POS $${posTotal}`)
record('C · the mirror shows the points this visit will earn', (await salon.page.locator('[data-testid=basket-points]').count()) === 1, (await salon.page.locator('[data-testid=basket-points]').textContent().catch(() => '')).trim())
await shot(salon.page, 'salon-basket-mirror')
await salon.page.setViewportSize({ width: 1366, height: 1024 })
await shot(salon.page, 'salon-basket-landscape')
await salon.page.setViewportSize(PORTRAIT)

// 6. ask about this piece
await salon.page.click('[data-testid=basket-ask]')
await salon.page.fill('[data-testid=basket-question]', `QA4 ${TAG}: does this come in a bigger size?`)
await salon.page.click('[data-testid=basket-send]')
await salon.page.waitForSelector('[data-testid=basket-asked]', { timeout: 15000 })
const posNoticed = await pos.page.waitForFunction(() => /asks|question/i.test(document.body.textContent || ''), null, { timeout: 20000 }).then(() => true).catch(() => false)
const inter = (await admin.list('Maison Client Interaction', { customer: MEMBER }, ['name', 'type', 'note'], 5)).find((i) => /bigger size/.test(i.note || ''))
record('C · "Ask about this piece" reaches the POS and the client profile', posNoticed && !!inter, `POS notice=${posNoticed} · interaction=${JSON.stringify(inter || {}).slice(0, 120)}`)
await shot(pos.page, 'pos-salon-question')
await dismissNotices(pos.page)

// 7. pay → approved → thank-you
await pos.page.click('.basket .pay button:has-text("Cash")')
await waitView(salon.page, 'pay', 25000)
const payAmt = money(await salon.page.locator('[data-testid=pay-amount]').textContent())
record('C · the Salon shows the payment screen with the amount due', Math.abs(payAmt - posTotal) < 0.01, `salon $${payAmt} vs POS $${posTotal}`)
await shot(salon.page, 'salon-pay')
await pos.page.waitForSelector('.pay .cash', { timeout: 15000 })
await pos.page.click('button:has-text("Complete cash sale")')
const approved = await salon.page.waitForFunction(() => document.documentElement.dataset.salonView === 'approved', null, { timeout: 12000 }).then(() => true).catch(() => false)
if (approved) await shot(salon.page, 'salon-approved')
await pos.page.waitForSelector('.receipt-view', { timeout: 40000 })
const { pill, uuid } = await L.waitSynced(pos.page)
const inv = (await L.invoiceForUuid(admin, uuid))[0]
if (inv) created.invoices.push(inv.name)
record('C · the Salon shows the "approved" state before the receipt', approved, `salon view now = ${await salonView(salon.page)}`)
await waitView(salon.page, 'thankyou', 30000)
const ty = (await salon.page.locator('[data-testid=salon-thankyou]').innerText()).replace(/\s+/g, ' ')
const ptsEarned = (await salon.page.locator('[data-testid=thankyou-points]').textContent()).trim()
const qr = await salon.page.locator('[data-testid=thankyou-qr]').count()
record('C · the thank-you screen shows the points earned and the receipt QR', /\+\d/.test(ptsEarned) && qr === 1, `${ptsEarned} · qr=${qr} · ${ty.slice(0, 140)}`)
record('C · the thank-you screen shows the tier progress', (await salon.page.locator('[data-testid=thankyou-next-reward]').count()) === 1, (await salon.page.locator('[data-testid=thankyou-next-reward]').textContent().catch(() => '')).trim())
record('C · the thank-you screen shows giveaway entries', (await salon.page.locator('[data-testid=thankyou-giveaway]').count()) === 1, (await salon.page.locator('[data-testid=thankyou-giveaway]').textContent().catch(() => '')).trim())
record('C · the thank-you screen shows no full name, phone or e-mail', !ty.includes(cust.email_id) && !ty.includes(String(cust.mobile_no || '')), ty.slice(0, 120))
await shot(salon.page, 'salon-thankyou')

// 8. feedback + invitation from the Salon
await salon.page.click('[data-testid=thankyou-feedback]')
await salon.page.waitForSelector('[data-testid=salon-feedback]', { timeout: 15000 })
await salon.page.click('[data-testid=feedback-star-5]')
await salon.page.fill('[data-testid=feedback-comment]', `QA4 ${TAG} salon feedback — please ignore`)
await salon.page.click('[data-testid=feedback-send]')
await sleep(3000)
const fb = (await admin.list('Maison Feedback', { sales_invoice: inv?.name }, ['name', 'rating', 'comment', 'boutique', 'source'], 5).catch(() => []))
const fb2 = fb.length ? fb : await admin.list('Maison Feedback', { boutique: L.STORE }, ['name', 'rating', 'comment', 'sales_invoice'], 5)
record('C · Salon feedback reaches Head Office', fb2.some((f) => /QA4/.test(f.comment || '') && String(f.sales_invoice || inv?.name) === inv?.name), JSON.stringify(fb2[0] || {}).slice(0, 200))
await shot(salon.page, 'salon-feedback')
// invitation
const inviteBtn = salon.page.locator('[data-testid=invite-yes]')
if (await inviteBtn.count()) {
  await inviteBtn.click(); await sleep(2500)
} else {
  await salon.page.click('[data-testid=thankyou-done]').catch(() => {})
}
const prof = await admin.value('Maison Client Profile', MEMBER, ['private_viewing_invite', 'private_viewing_invite_on'])
record('C · the private-viewing invitation is stored on the client profile', Number(prof?.private_viewing_invite) === 1 || !!prof?.private_viewing_invite_on, JSON.stringify(prof))
await shot(salon.page, 'salon-invite')

// 9. concierge
await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-settings]', { timeout: 20000 })
const toggle = pos.page.locator('[data-testid=salon-concierge-toggle]')
if (await toggle.count()) {
  await toggle.check().catch(async () => { await toggle.click() })
  const conc = await waitView(salon.page, 'concierge', 20000).then(() => true).catch(() => false)
  record('C · the associate can switch the Salon to Concierge', conc, `salon view = ${await salonView(salon.page)}`)
  if (conc) {
    await shot(salon.page, 'salon-concierge')
    for (let i = 0; i < 6; i++) {
      const next = salon.page.locator('[data-testid=concierge-next], [data-testid=concierge-finish]').first()
      if (!(await next.count())) break
      const isFinish = (await salon.page.locator('[data-testid=concierge-finish]').count()) > 0
      if (isFinish) {
        await salon.page.locator('[data-testid^=style-]').first().click().catch(() => {})
        await salon.page.locator('[data-testid^=occasion-]').first().click().catch(() => {})
        await salon.page.click('[data-testid=concierge-finish]')
        break
      }
      await salon.page.locator('[data-testid^=metal-]').first().click().catch(() => {})
      await next.click()
      await sleep(600)
    }
    await sleep(3000)
    const saved = await salon.page.locator('[data-testid=concierge-saved]').count()
    const p2 = await admin.doc('Maison Client Profile', MEMBER)
    record('C · Concierge answers are written to the client profile', saved === 1 || !!p2.preferred_metal || !!p2.style_notes || !!p2.ring_size,
      `saved=${saved} metal=${p2.preferred_metal} styles=${p2.style_preferences || p2.styles} occasions=${p2.occasions} notes=${String(p2.style_notes || '').slice(0, 80)}`)
    await shot(salon.page, 'salon-concierge-done')
  }
} else {
  note('C · concierge toggle not offered on the POS settings card')
}

// 10. unpair
await L.nav(pos.page, 'Settings')
await pos.page.click('[data-testid=salon-unpair]')
await sleep(2500)
const backToPair = await waitView(salon.page, 'pair', 20000).then(() => true).catch(() => false)
record('C · Unpair from the POS returns the Salon to the pairing screen', backToPair, `salon view = ${await salonView(salon.page)}`)
const sess = await admin.value('Maison Salon Session', st.session.token, ['status'])
record('C · the session is marked Unpaired on the server', sess?.status === 'Unpaired', JSON.stringify(sess))
await shot(salon.page, 'salon-unpaired')
const deadToken = await (await L.guestApi()).raw('maison_pos.api.salon.state', { token: st.session.token })
record('C · an unpaired session token stops serving state', deadToken.status !== 200 || deadToken.body?.message?.status !== 'Paired', `${deadToken.status} ${JSON.stringify(deadToken.body?.message || {}).slice(0, 120)}`)

fs.writeFileSync(new URL('./created-s10.json', import.meta.url), JSON.stringify({ TAG, token: st.session?.token, deviceId, invoice: inv?.name, created }, null, 2))
L.writeResults('results-s10.json', { token: st.session?.token, invoice: inv?.name })
await pos.context.close(); await salon.context.close(); await browser.close()
