// QA4 · C — thank-you actions (feedback, invitation), concierge, unpair. Acts fast: the thank-you
// screen returns to ambient after 20 s of quiet.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Salon QA4A'
const PORTRAIT = { width: 1024, height: 1366 }
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const guest = await L.guestApi()
const browser = await L.newBrowser()
const created = { invoices: [], sessions: [] }
const waitView = (page, view, ms = 25000) => page.waitForFunction((v) => document.documentElement.dataset.salonView === v, view, { timeout: ms })
const salonView = (page) => page.evaluate(() => document.documentElement.dataset.salonView)
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))
const cust = await admin.value('Customer', MEMBER, ['maison_client_number', 'mobile_no', 'email_id'])

const pos = await L.ctxFor(browser, L.A1, 'pos', { viewport: { width: 1440, height: 1024 } })
const salon = await L.ctxFor(browser, null, 'salon', { viewport: PORTRAIT })
await L.unlock(pos.page, L.A1, { fresh: true })
const deviceId = await pos.page.evaluate(() => localStorage.getItem('maison.device_id') || '')
await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-settings]', { timeout: 20000 })
await pos.page.click('[data-testid=salon-pair]')
await pos.page.waitForSelector('[data-testid=salon-pair-code]', { timeout: 20000 })
const code = (await pos.page.locator('[data-testid=salon-pair-code]').textContent()).replace(/\D/g, '')
await go(salon.page, '/salon')
await salon.page.evaluate(() => localStorage.clear())
await go(salon.page, `/salon?code=${code}`)
await waitView(salon.page, 'ambient', 30000)
const st = (await assoc.get('maison_pos.api.salon.pos_status', { boutique: L.STORE, pos_device_id: deviceId })).session
created.sessions.push(st?.token)

// attach the member from the Salon by e-mail, then ring a $60 basket (≥ 1 giveaway entry)
await L.nav(pos.page, 'Sell')
await pos.page.waitForSelector('.tile', { timeout: 30000 })
await L.addItem(pos.page, 'Blazer Big Shot')
await waitView(salon.page, 'identify', 30000)
await guest.rawPost('maison_pos.api.salon.identify', { token: st.token, code: cust.email_id })
await waitView(salon.page, 'client', 25000)
await L.addItem(pos.page, 'Aluminum 4-pc Grinder')
await waitView(salon.page, 'basket', 30000).catch(() => {})
await dismissNotices(pos.page)
await pos.page.click('.basket .pay button:has-text("Cash")')
await pos.page.waitForSelector('.pay .cash', { timeout: 15000 })
await pos.page.click('button:has-text("Complete cash sale")')
await pos.page.waitForSelector('.receipt-view', { timeout: 40000 })
const { pill, uuid } = await L.waitSynced(pos.page)
const inv = (await L.invoiceForUuid(admin, uuid))[0]
if (inv) created.invoices.push(inv.name)
await waitView(salon.page, 'thankyou', 30000)
await salon.page.waitForSelector('[data-testid=thankyou-qr]', { timeout: 20000 }).catch(() => {})
await shot(salon.page, 'salon-thankyou-full')
// act immediately — the screen clears 20 s after the last interaction
await salon.page.click('[data-testid=thankyou-feedback]')
await salon.page.waitForSelector('[data-testid=salon-feedback]', { timeout: 15000 })
await salon.page.click('[data-testid=feedback-star-5]')
await salon.page.fill('[data-testid=feedback-comment]', `QA4 ${TAG} salon feedback — please ignore`)
await shot(salon.page, 'salon-feedback')
await salon.page.click('[data-testid=feedback-send]')
await sleep(3500)
const fb = await admin.list('Maison Feedback', { sales_invoice: inv?.name }, ['name', 'rating', 'comment', 'boutique', 'customer'], 5)
record('C · Salon feedback reaches Head Office against this sale', fb.length === 1 && Number(fb[0].rating) === 5, JSON.stringify(fb[0] || {}).slice(0, 220))
// the state the salon received (checked server-side so the 20 s auto-dismiss cannot race the assertions)
const state = JSON.parse((await admin.doc('Maison Salon Session', st.token)).state || '{}')
record('C · the thank-you state carries points, receipt QR link and giveaway entries',
  !!state.receipt?.receipt_url && state.receipt?.points_earned > 0 && state.receipt?.giveaway_entries >= 1,
  JSON.stringify(state.receipt || {}).slice(0, 260))
const invited = await salon.page.locator('[data-testid=invite-yes]').count()
if (invited) { await salon.page.click('[data-testid=invite-yes]'); await sleep(3000) }
const prof = await admin.value('Maison Client Profile', MEMBER, ['private_viewing_invite', 'private_viewing_invite_on'])
record('C · the private-viewing invitation is recorded on the client profile', invited > 0 && Number(prof?.private_viewing_invite) === 1, `invite offered=${invited > 0} · ${JSON.stringify(prof)}`)
await shot(salon.page, 'salon-invite')
note('C · the thank-you screen (receipt QR, feedback, invitation) self-clears 20 s after the last touch', 'observed while testing: the QR and the "How was your visit?" / invitation buttons disappear on the countdown')

// --- concierge
await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-settings]', { timeout: 20000 })
const toggle = pos.page.locator('[data-testid=salon-concierge-toggle]')
let conc = false
if (await toggle.count()) {
  await toggle.check({ force: true }).catch(async () => { await toggle.click({ force: true }) })
  conc = await waitView(salon.page, 'concierge', 25000).then(() => true).catch(() => false)
}
record('C · the associate can switch the Salon to Concierge', conc, `toggle present=${await toggle.count()} · salon view=${await salonView(salon.page)}`)
if (conc) {
  await shot(salon.page, 'salon-concierge')
  const steps = []
  for (let i = 0; i < 8; i++) {
    steps.push(await salon.page.locator('[data-testid=salon-concierge]').getAttribute('data-step'))
    if (await salon.page.locator('[data-testid=concierge-finish]').count()) {
      await salon.page.locator('[data-testid^=style-]').first().click().catch(() => {})
      await salon.page.locator('[data-testid^=occasion-]').first().click().catch(() => {})
      await salon.page.click('[data-testid=concierge-finish]')
      break
    }
    await salon.page.locator('[data-testid^=metal-]').first().click().catch(() => {})
    const next = salon.page.locator('[data-testid=concierge-next]').first()
    if (!(await next.count())) break
    await next.click(); await sleep(700)
  }
  await sleep(4000)
  const saved = await salon.page.locator('[data-testid=concierge-saved]').count()
  const p = await admin.doc('Maison Client Profile', MEMBER)
  const filled = ['ring_size', 'wrist_size', 'preferred_metal', 'style_notes', 'occasions', 'styles', 'style_preferences'].filter((k) => p[k])
  record('C · Concierge answers are written to the client profile', saved === 1 || filled.length > 0, `steps=${steps.join('→')} saved=${saved} fields=${JSON.stringify(filled.map((k) => [k, String(p[k]).slice(0, 40)]))}`)
  await shot(salon.page, 'salon-concierge-done')
}

// --- privacy: a second Salon must not see this client
const salon2 = await L.ctxFor(browser, null, 'salon2', { viewport: PORTRAIT })
await go(salon2.page, '/salon')
await salon2.page.evaluate(() => localStorage.clear())
await go(salon2.page, '/salon')
const pairScreen = await waitView(salon2.page, 'pair', 20000).then(() => true).catch(() => false)
const body2 = await salon2.page.locator('body').innerText()
record('C · an unpaired Salon shows only the pairing screen (no client data)', pairScreen && !body2.includes('QA4 Salon') && !body2.includes(cust.email_id), `view=${await salonView(salon2.page)}`)
await shot(salon2.page, 'salon-second-display')
await salon2.context.close()

// --- unpair
await L.nav(pos.page, 'Settings')
await pos.page.click('[data-testid=salon-unpair]')
await sleep(3000)
const backToPair = await waitView(salon.page, 'pair', 25000).then(() => true).catch(() => false)
record('C · Unpair from the POS returns the Salon to the pairing screen', backToPair, `salon view = ${await salonView(salon.page)}`)
const sess = await admin.value('Maison Salon Session', st.token, ['status'])
record('C · the session is Unpaired on the server', sess?.status === 'Unpaired', JSON.stringify(sess))
const dead = await guest.raw('maison_pos.api.salon.state', { token: st.token })
record('C · the old token no longer serves a paired session', dead.status !== 200 || dead.body?.message?.status !== 'Paired', `${dead.status} ${JSON.stringify(dead.body?.message || {}).slice(0, 120)}`)
await shot(salon.page, 'salon-unpaired')

fs.writeFileSync(new URL('./created-s11b.json', import.meta.url), JSON.stringify({ TAG, created }, null, 2))
L.writeResults('results-s11b.json', { created })
await pos.context.close(); await salon.context.close(); await browser.close()
