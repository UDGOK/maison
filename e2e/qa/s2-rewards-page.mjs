// QA4 · B1 — /rewards copy, sign-up form validation, duplicate phone/email, 21+ consent.
import * as L from './lib-srs.mjs'
const { record, note, shot, go, log } = L
const TAG = process.env.RUNTAG || 'QA4A'
const admin = await L.adminApi()
const guest = await L.guestApi()
const browser = await L.newBrowser()
const created = { customers: [], invoices: [] }

const prog = await guest.get('maison_pos.api.rewards.program')
const { context, page } = await L.ctxFor(browser, null, 'rewards')
await go(page, '/rewards')
const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')

record('B · /rewards states "Earn 1 point for every $1 you spend"', txt.includes('Earn 1 point for every $1 you spend'), prog.copy.earn)
record('B · /rewards states "$5 off at 100 points"', txt.includes('$5 off at 100 points'))
record('B · /rewards states "$10 off at 200 points"', txt.includes('$10 off at 200 points'))
record('B · /rewards states "$15 off at 300 points"', txt.includes('$15 off at 300 points'))
const tiles = await page.$$eval('[data-testid=rewards-tiers] > div', (d) => d.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
record('B · tier tiles read $5/100, $10/200, $15/300', tiles.length === 3 && /\$5 off at 100 points 100 points = 100 dollars spent/.test(tiles[0]) && /\$10 off at 200/.test(tiles[1]) && /\$15 off at 300/.test(tiles[2]), tiles.join(' | '))
record('B · programme name is CloudChaserz Rewards', (await page.locator('[data-testid=rewards-title]').textContent()).trim() === 'CloudChaserz Rewards', prog.program_name)
const perks = await page.$$eval('.rw-perk .t', (d) => d.map((e) => e.textContent.trim()))
record('B · all five member perks listed', perks.length === 5 && perks.includes('Birthday discount') && perks.includes('Product giveaways') && perks.includes('Exclusive event invites'), perks.join(' | '))
record('B · server tiers match the copy (100/5, 200/10, 300/15)', JSON.stringify(prog.tiers.map((t) => [t.points, t.amount])) === '[[100,5],[200,10],[300,15]]', JSON.stringify(prog.tiers.map((t) => [t.points, t.amount])))
record('B · birthday perk copy matches settings', /15% coupon, issued 7 days before your birthday, valid 30 days/.test(txt), JSON.stringify(prog.birthday))
const gv = await page.locator('[data-testid=rewards-giveaways] .row').count()
record('B · live giveaways are listed on /rewards', gv > 0, `${gv} giveaway rows · api=${JSON.stringify(prog.giveaways).slice(0, 200)}`)
await shot(page, 'rewards-1440', true)

// ---- consent required (client side)
await page.locator('#rw-name').fill(`QA4 Rewards ${TAG}`)
await page.locator('#rw-phone').fill(`+1 918 555 7${TAG.slice(-3).replace(/\D/g, '1')}0`)
await page.locator('#rw-submit').click()
await page.waitForTimeout(800)
const okShown = await page.locator('#rw-ok').isVisible()
record('B · join form refuses without the 21+ / terms checkbox (client side)', !okShown, `ok visible=${okShown}; validity=${await page.locator('#rw-consent').evaluate((e) => e.validity.valueMissing)}`)
await shot(page, 'rewards-join-consent-required')

// ---- server-side: consent bypass probe (marketing box only)
const phoneA = `+1 918 555 8001`
const bypass = await guest.rawPost('maison_pos.api.rewards.signup', { name: `QA4 Bypass ${TAG}`, phone: phoneA, consent: 0, consent_email: 1, consent_sms: 0 })
const bypassOk = bypass.status === 200 && bypass.body?.message?.ok
record('B · server enforces the 21+/terms consent (consent=0 must be refused)', !bypassOk,
  `POST signup {consent:0, consent_email:1} → ${bypass.status} ${JSON.stringify(bypass.body).slice(0, 180)}`, bypassOk ? 'major' : '')
if (bypassOk) created.customers.push(bypass.body.message.customer_name)

// ---- server-side: no consent at all
const noConsent = await guest.rawPost('maison_pos.api.rewards.signup', { name: `QA4 NoConsent ${TAG}`, phone: '+1 918 555 8002', consent: 0, consent_email: 0, consent_sms: 0 })
record('B · signup without any consent is refused', noConsent.status !== 200, `${noConsent.status} ${String(noConsent.body?.exception || '').slice(0, 120)}`)
// ---- missing name / contact
const noName = await guest.rawPost('maison_pos.api.rewards.signup', { name: '', phone: '+1 918 555 8003', consent: 1 })
record('B · signup without a name is refused', noName.status !== 200, `${noName.status} ${String(noName.body?.exception || '').slice(0, 90)}`)
const noContact = await guest.rawPost('maison_pos.api.rewards.signup', { name: `QA4 NoContact ${TAG}`, consent: 1 })
record('B · signup without phone or e-mail is refused', noContact.status !== 200, `${noContact.status} ${String(noContact.body?.exception || '').slice(0, 90)}`)

// ---- real sign-up through the page
const member = { name: `QA4 Member ${TAG}`, phone: `+1 918 555 9${TAG.slice(-2).replace(/\D/g, '0')}7`, email: `qa4.member.${TAG.toLowerCase()}@example.com`, birthday: '1990-04-11' }
await go(page, '/rewards')
await page.locator('#rw-name').fill(member.name)
await page.locator('#rw-phone').fill(member.phone)
await page.locator('#rw-email').fill(member.email)
await page.locator('#rw-birthday').fill(member.birthday)
await page.selectOption('#rw-store', L.STORE).catch(() => {})
await page.locator('#rw-consent').check()
await page.locator('#rw-submit').click()
await page.waitForSelector('#rw-ok', { state: 'visible', timeout: 20000 }).catch(() => {})
const okTxt = (await page.locator('#rw-ok').textContent().catch(() => '')).replace(/\s+/g, ' ').trim()
record('B · sign-up through /rewards creates a member with a client number', /MC\d{6}/.test(okTxt), okTxt.slice(0, 160))
await shot(page, 'rewards-join-ok')
const cust = (await admin.list('Customer', { customer_name: member.name }, ['name', 'maison_client_number', 'loyalty_program', 'mobile_no', 'email_id']))[0]
if (cust) created.customers.push(cust.name)
record('B · member is enrolled in CloudChaserz Rewards + profile written', cust?.loyalty_program === 'CloudChaserz Rewards' && !!cust?.maison_client_number, JSON.stringify(cust))
const prof = cust ? await admin.value('AWANZ Client Profile', cust.name, ['birthday', 'preferred_boutique', 'do_not_email', 'do_not_sms']) : null
record('B · birthday, home store and marketing consents stored on the profile', prof?.birthday === member.birthday && prof?.preferred_boutique === L.STORE && Number(prof?.do_not_email) === 0 && Number(prof?.do_not_sms) === 1, JSON.stringify(prof))

// ---- duplicate phone / e-mail
const dupPhone = await guest.rawPost('maison_pos.api.rewards.signup', { name: `QA4 Impostor ${TAG}`, phone: member.phone, consent: 1 })
const after = (await admin.list('Customer', { name: cust?.name }, ['name', 'customer_name', 'mobile_no']))[0]
record('B · duplicate phone does not silently rename the existing member', after?.customer_name === member.name,
  `signup with the same phone → ${dupPhone.status} ${JSON.stringify(dupPhone.body?.message || dupPhone.body?.exception).slice(0, 120)}; customer_name now "${after?.customer_name}"`,
  after?.customer_name === member.name ? '' : 'major')
const dupEmail = await guest.rawPost('maison_pos.api.rewards.signup', { name: `QA4 Impostor2 ${TAG}`, email: member.email, consent: 1 })
const after2 = (await admin.list('Customer', { name: cust?.name }, ['name', 'customer_name', 'email_id']))[0]
record('B · duplicate e-mail does not silently rename the existing member', after2?.customer_name === after?.customer_name,
  `→ ${dupEmail.status}; customer_name now "${after2?.customer_name}"`, after2?.customer_name === after?.customer_name ? '' : 'major')
const dupCount = (await admin.list('Customer', { mobile_no: member.phone }, ['name'], 20)).length
record('B · duplicate phone does not create a second Customer', dupCount === 1, `${dupCount} customers with ${member.phone}`)

await context.close(); await browser.close()
import fs from 'node:fs'
fs.writeFileSync(new URL('./created-s2.json', import.meta.url), JSON.stringify({ TAG, member, created }, null, 2))
L.writeResults('results-s2.json', { member, created })
