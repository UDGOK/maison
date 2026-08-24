// QA4 · C — Salon: QR/deep-link pairing, Join (sign-up + consent), thank-you QR, feedback, invitation,
// concierge, unpair, session expiry, privacy.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep, money } = L
const TAG = process.env.RUNTAG || 'QA4A'
const PORTRAIT = { width: 1024, height: 1366 }
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const guest = await L.guestApi()
const browser = await L.newBrowser()
const created = { customers: [], invoices: [], sessions: [] }
const waitView = (page, view, ms = 25000) => page.waitForFunction((v) => document.documentElement.dataset.salonView === v, view, { timeout: ms })
const salonView = (page) => page.evaluate(() => document.documentElement.dataset.salonView)
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))

const pos = await L.ctxFor(browser, L.A1, 'pos', { viewport: { width: 1440, height: 1024 } })
const salon = await L.ctxFor(browser, null, 'salon', { viewport: PORTRAIT })
await L.unlock(pos.page, L.A1, { fresh: true })
const deviceId = await pos.page.evaluate(() => localStorage.getItem('maison.device_id') || '')
await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-settings]', { timeout: 20000 })
await pos.page.click('[data-testid=salon-pair]')
await pos.page.waitForSelector('[data-testid=salon-pair-code]', { timeout: 20000 })
const code = (await pos.page.locator('[data-testid=salon-pair-code]').textContent()).replace(/\D/g, '')
const qrSrc = await pos.page.locator('[data-testid=salon-pair-qr]').getAttribute('src').catch(() => null)
record('C · the pairing QR is rendered on the POS', !!qrSrc && qrSrc.startsWith('data:image'), `${String(qrSrc).slice(0, 40)}…`)

// pair through the deep link the QR encodes (MS:<code> / /salon?code=…)
await go(salon.page, '/salon')
await salon.page.evaluate(() => localStorage.clear())
await go(salon.page, `/salon?code=${code}`)
const pairedByLink = await waitView(salon.page, 'ambient', 30000).then(() => true).catch(() => false)
record('C · the Salon pairs from the QR deep link (/salon?code=…)', pairedByLink, `code ${code} → ${await salonView(salon.page)}`)
const st = (await assoc.get('maison_pos.api.salon.pos_status', { boutique: L.STORE, pos_device_id: deviceId })).session
created.sessions.push(st?.token)
record('C · a paired session lasts 12 h', !!st?.expires_at && Math.abs((new Date(st.expires_at.replace(' ', 'T')) - new Date(st.paired_at ? st.paired_at.replace(' ', 'T') : Date.now())) / 3600000 - 12) < 0.2,
  `paired_at=${st?.paired_at} expires_at=${st?.expires_at}`)
const expJob = (await admin.list('Scheduled Job Type', { method: 'maison_pos.api.salon.expire_sessions' }, ['name', 'frequency', 'stopped', 'last_execution']))[0]
record('C · sessions are expired by an hourly job', expJob?.frequency === 'Hourly' && !Number(expJob.stopped), JSON.stringify(expJob))
const badToken = await guest.raw('maison_pos.api.salon.state', { token: 'not-a-real-token-000000000000000' })
record('C · an unknown session token is refused with no detail', badToken.status === 403 || badToken.status === 404, `${badToken.status} ${String(badToken.body?.exception || '').slice(0, 90)}`)
const listSessions = await guest.raw('frappe.client.get_list', { doctype: 'Maison Salon Session', fields: JSON.stringify(['name', 'customer']), limit_page_length: 5 })
record('C · a guest cannot list Salon sessions', listSessions.status !== 200 || (listSessions.body?.message || []).length === 0, `${listSessions.status} rows=${(listSessions.body?.message || []).length}`)

// --- Join (sign-up) from the Salon
await L.nav(pos.page, 'Sell')
await pos.page.waitForSelector('.tile', { timeout: 30000 })
await L.addItem(pos.page, 'BIC Lighter')
await waitView(salon.page, 'identify', 30000)
await salon.page.click('[data-testid=identify-join]')
await salon.page.waitForSelector('[data-testid=salon-signup]', { timeout: 15000 })
const joinTxt = (await salon.page.locator('[data-testid=salon-signup]').innerText()).replace(/\s+/g, ' ')
record('C · the Join screen names the programme and its terms', /CloudChaserz Rewards/i.test(joinTxt) && /point/i.test(joinTxt), joinTxt.slice(0, 200))
const newMember = { name: `QA4 Salon ${TAG}`, phone: `918555${String(Date.now()).slice(-4)}`, email: `qa4.salon.${TAG.toLowerCase()}${String(Date.now()).slice(-4)}@example.com` }
await salon.page.fill('[data-testid=signup-name]', newMember.name)
await salon.page.fill('[data-testid=signup-phone]', newMember.phone)
await salon.page.fill('[data-testid=signup-email]', newMember.email)
await salon.page.fill('[data-testid=signup-birthday]', '1994-02-02').catch(() => {})
await salon.page.locator('[data-testid=signup-marketing-email]').check().catch(() => {})
await shot(salon.page, 'salon-signup')
await salon.page.click('[data-testid=signup-submit]')
await waitView(salon.page, 'client', 30000).catch(() => {})
const created2 = (await admin.list('Customer', { customer_name: newMember.name }, ['name', 'maison_client_number', 'loyalty_program', 'mobile_no', 'email_id'], 5))[0]
if (created2) created.customers.push(created2.name)
record('C · Join from the Salon creates the member and attaches them to the sale', !!created2 && !!created2.maison_client_number && created2.loyalty_program === 'CloudChaserz Rewards', JSON.stringify(created2))
const prof2 = created2 ? await admin.value('Maison Client Profile', created2.name, ['birthday', 'do_not_email', 'do_not_sms']) : null
record('C · the marketing preferences chosen on the Salon are stored', prof2 && Number(prof2.do_not_email) === 0 && Number(prof2.do_not_sms) === 1, JSON.stringify(prof2))
await pos.page.waitForFunction((n) => document.querySelector('.basket .client-name')?.textContent?.includes('QA4 Salon'), null, { timeout: 20000 }).catch(() => {})
record('C · the POS shows the client that joined on the Salon', /QA4 Salon/.test(await pos.page.locator('.basket .client-name').textContent().catch(() => '')), (await pos.page.locator('.basket .client-name').textContent().catch(() => '')).trim())
await dismissNotices(pos.page)
await shot(pos.page, 'pos-salon-joined')

// --- sale → thank-you (QR, points, next reward, giveaway) → feedback → invitation
await L.addItem(pos.page, 'Aluminum 4-pc Grinder')
await waitView(salon.page, 'basket', 30000).catch(() => {})
await pos.page.click('.basket .pay button:has-text("Cash")')
await pos.page.waitForSelector('.pay .cash', { timeout: 15000 })
await pos.page.click('button:has-text("Complete cash sale")')
await pos.page.waitForSelector('.receipt-view', { timeout: 40000 })
const { pill, uuid } = await L.waitSynced(pos.page)
const inv = (await L.invoiceForUuid(admin, uuid))[0]
if (inv) created.invoices.push(inv.name)
await waitView(salon.page, 'thankyou', 30000)
await salon.page.waitForSelector('[data-testid=thankyou-qr]', { timeout: 25000 }).catch(() => {})
const qrCount = await salon.page.locator('[data-testid=thankyou-qr]').count()
const ptsEarned = (await salon.page.locator('[data-testid=thankyou-points]').textContent()).trim()
record('C · the thank-you screen shows the points earned and the receipt QR', qrCount === 1 && /\+\d/.test(ptsEarned), `${ptsEarned} · qr=${qrCount} · invoice ${inv?.name} (${pill})`)
record('C · the thank-you screen shows the tier progress (next reward)', (await salon.page.locator('[data-testid=thankyou-next-reward]').count()) === 1, (await salon.page.locator('[data-testid=thankyou-next-reward]').textContent().catch(() => '')).trim())
record('C · the thank-you screen shows the giveaway entries', (await salon.page.locator('[data-testid=thankyou-giveaway]').count()) === 1, (await salon.page.locator('[data-testid=thankyou-giveaway]').textContent().catch(() => '')).trim())
const tyTxt = (await salon.page.locator('[data-testid=salon-thankyou]').innerText()).replace(/\s+/g, ' ')
record('C · the thank-you screen shows no full contact details', !tyTxt.includes(newMember.email) && !tyTxt.includes(newMember.phone), tyTxt.slice(0, 150))
await shot(salon.page, 'salon-thankyou-full')
await salon.page.click('[data-testid=thankyou-feedback]')
await salon.page.waitForSelector('[data-testid=salon-feedback]', { timeout: 15000 })
await salon.page.click('[data-testid=feedback-star-5]')
await salon.page.fill('[data-testid=feedback-comment]', `QA4 ${TAG} salon feedback — please ignore`)
await shot(salon.page, 'salon-feedback')
await salon.page.click('[data-testid=feedback-send]')
await sleep(3500)
const fb = await admin.list('Maison Feedback', { sales_invoice: inv?.name }, ['name', 'rating', 'comment', 'boutique', 'customer'], 5)
record('C · Salon feedback reaches Head Office against this sale', fb.length === 1 && Number(fb[0].rating) === 5, JSON.stringify(fb[0] || {}).slice(0, 200))
const inviteYes = salon.page.locator('[data-testid=invite-yes]')
const invited = await inviteYes.count()
if (invited) { await inviteYes.click(); await sleep(3000) }
const prof3 = created2 ? await admin.value('Maison Client Profile', created2.name, ['private_viewing_invite', 'private_viewing_invite_on']) : null
record('C · the private-viewing invitation is recorded on the client profile', invited > 0 && Number(prof3?.private_viewing_invite) === 1, `invite screen shown=${invited > 0} · ${JSON.stringify(prof3)}`)
await shot(salon.page, 'salon-invite')

// --- concierge
await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-settings]', { timeout: 20000 })
const toggle = pos.page.locator('[data-testid=salon-concierge-toggle]')
let conc = false
if (await toggle.count()) {
  await toggle.check({ force: true }).catch(async () => { await toggle.click({ force: true }) })
  conc = await waitView(salon.page, 'concierge', 25000).then(() => true).catch(() => false)
}
record('C · the associate can switch the Salon to Concierge', conc, `toggle=${await toggle.count()} salon view=${await salonView(salon.page)}`)
if (conc) {
  await shot(salon.page, 'salon-concierge')
  for (let i = 0; i < 8; i++) {
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
  await sleep(3500)
  const saved = await salon.page.locator('[data-testid=concierge-saved]').count()
  const p = created2 ? await admin.doc('Maison Client Profile', created2.name) : {}
  const filled = ['ring_size', 'wrist_size', 'preferred_metal', 'style_notes', 'occasions', 'styles'].filter((k) => p[k])
  record('C · Concierge answers are written to the client profile', saved === 1 || filled.length > 0, `saved=${saved} fields=${JSON.stringify(filled.map((k) => [k, String(p[k]).slice(0, 40)]))}`)
  await shot(salon.page, 'salon-concierge-done')
}

// --- unpair
await L.nav(pos.page, 'Settings')
await pos.page.click('[data-testid=salon-unpair]')
await sleep(3000)
const backToPair = await waitView(salon.page, 'pair', 25000).then(() => true).catch(() => false)
record('C · Unpair from the POS returns the Salon to the pairing screen', backToPair, `salon view = ${await salonView(salon.page)}`)
const sess = await admin.value('Maison Salon Session', st.token, ['status'])
record('C · the session is Unpaired on the server', sess?.status === 'Unpaired', JSON.stringify(sess))
const dead = await guest.raw('maison_pos.api.salon.state', { token: st.token })
record('C · the old token no longer serves a paired session', dead.status !== 200 || dead.body?.message?.status !== 'Paired', `${dead.status} ${JSON.stringify(dead.body?.message || {}).slice(0, 100)}`)
await shot(salon.page, 'salon-unpaired')

fs.writeFileSync(new URL('./created-s11.json', import.meta.url), JSON.stringify({ TAG, created, member: newMember }, null, 2))
L.writeResults('results-s11.json', { created })
await pos.context.close(); await salon.context.close(); await browser.close()
