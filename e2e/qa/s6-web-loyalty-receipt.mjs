// QA4 · A/B — loyalty lookup on the web, public receipt: tier progress, private feedback → HQ, low-rating alert.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log } = L
const TAG = process.env.RUNTAG || 'QA4A'
const S5 = JSON.parse(fs.readFileSync(new URL('./created-s5.json', import.meta.url)))
const admin = await L.adminApi()
const guest = await L.guestApi()
const browser = await L.newBrowser()
const MEMBER = 'QA4 Member QA4A'
const cust = await admin.value('Customer', MEMBER, ['maison_client_number', 'email_id', 'customer_name'])
const inv = await admin.doc('Sales Invoice', S5.invoice)

// ---------- loyalty lookup on the web (guest)
const { context, page } = await L.ctxFor(browser, null, 'account')
await go(page, '/shop/account')
await page.fill('#mw-lookup-form [name=client_number]', cust.maison_client_number)
await page.fill('#mw-lookup-form [name=email]', 'wrong@example.com')
await page.click('#mw-lookup-form button[type=submit]')
await page.waitForTimeout(1500)
const err = (await page.locator('#mw-lookup-error').textContent()).trim()
record('A · loyalty lookup refuses a wrong e-mail', err.length > 0 && !/points/i.test(await page.locator('#mw-loyalty').innerText()), `error="${err}"`)
await page.fill('#mw-lookup-form [name=email]', cust.email_id)
await page.click('#mw-lookup-form button[type=submit]')
await page.waitForTimeout(2500)
const card = (await page.locator('#mw-loyalty').innerText()).replace(/\s+/g, ' ')
record('A · loyalty lookup shows points for client number + e-mail', card.includes(cust.maison_client_number) && /39/.test(card), card.slice(0, 180))
await shot(page, 'shop-account-loyalty', true)
const onlyNumber = await guest.rawPost('maison_pos.api.webshop.loyalty_lookup', { client_number: cust.maison_client_number })
record('A · loyalty lookup needs both the client number and the e-mail', onlyNumber.status !== 200, `${onlyNumber.status} ${String(onlyNumber.body?.exception || '').slice(0, 100)}`)
const badNumber = await guest.get('maison_pos.api.webshop.loyalty_lookup', { client_number: 'MC000000', email: cust.email_id })
record('A · unknown client number returns nothing (no enumeration hint)', badNumber === null || badNumber === undefined, JSON.stringify(badNumber ?? null))

// ---------- public receipt page
const token = inv.maison_receipt_token
await go(page, `/r/${token}`)
const rtxt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
record('B · public receipt shows points earned and balance', /Points earned 39/i.test(rtxt) && /Points balance 39/i.test(rtxt), rtxt.match(/Points earned.{0,60}/i)?.[0])
const nextReward = (await page.locator('[data-testid=next-reward]').innerText().catch(() => '')).replace(/\s+/g, ' ')
record('B · public receipt shows tier progress ("next reward … to go")', /off at 100 pts/.test(nextReward) && /to go/.test(nextReward), nextReward)
record('B · public receipt masks the client number and shows no name', /MC[^ ]{0,6}413/.test(rtxt) && !rtxt.includes(cust.customer_name), rtxt.match(/Client №.{0,30}/)?.[0] || 'n/a')
record('B · public receipt shows a giveaway-entry line', /giveaway/i.test(rtxt), rtxt.match(/Giveaway.{0,60}/i)?.[0] || 'none')
await shot(page, 'public-receipt', true)

// ---------- private feedback from the receipt page
const fb = page.locator('[data-testid=feedback-form]')
record('B · the receipt page offers private feedback', (await fb.count()) === 1)
await page.click('[data-testid=feedback-form] .mg-stars button[data-rating="2"]')
await page.fill('#mg-fb-comment', `QA4 ${TAG} — test feedback, please ignore (rating 2)`)
await page.click('#mg-fb-send')
await page.waitForTimeout(3000)
const thanks = (await page.locator('[data-testid=feedback-form]').innerText()).replace(/\s+/g, ' ')
record('B · feedback is accepted from the receipt page', /thank you/i.test(thanks), thanks.slice(0, 120))
await shot(page, 'public-receipt-feedback')
const rows = await admin.list('Maison Feedback', { sales_invoice: inv.name }, ['name', 'rating', 'comment', 'boutique', 'customer', 'status'], 5)
record('B · feedback reaches HQ as a Maison Feedback record', rows.length === 1 && Number(rows[0].rating) === 2, JSON.stringify(rows[0]))
const summary = await admin.get('maison_pos.api.feedback.summary', {}).catch((e) => ({ err: String(e).slice(0, 120) }))
record('B · HQ feedback summary includes the new rating', JSON.stringify(summary).includes(String(rows[0]?.name)) || (summary?.count ?? summary?.total ?? 0) > 0, JSON.stringify(summary).slice(0, 220))
// low rating alert
const notif = await admin.list('Notification Log', { document_name: rows[0]?.name }, ['name', 'subject', 'for_user'], 10).catch(() => [])
const todo = await admin.list('ToDo', { reference_name: rows[0]?.name }, ['name', 'allocated_to', 'description'], 10).catch(() => [])
record('B · a rating ≤ 2 alerts the store manager', notif.length > 0 || todo.length > 0 || Number(rows[0]?.alerted) === 1,
  `alerted=${rows[0]?.alerted} notifications=${notif.length} ${JSON.stringify(notif.slice(0, 2))} todos=${todo.length}`)
// one per invoice
const again = await guest.rawPost('maison_pos.api.feedback.submit', { token, rating: 5, comment: 'QA4 duplicate probe' })
const rows2 = await admin.list('Maison Feedback', { sales_invoice: inv.name }, ['name', 'rating'], 5)
record('B · only one feedback per receipt is stored', rows2.length === 1, `${rows2.length} rows; second submit → ${again.status} ${JSON.stringify(again.body?.message || again.body?.exception).slice(0, 120)}`)
// a bad token must not accept feedback
const badTok = await guest.rawPost('maison_pos.api.feedback.submit', { token: 'nosuchtoken1234', rating: 5 })
record('B · feedback with an unknown receipt token is refused', badTok.status !== 200, `${badTok.status} ${String(badTok.body?.exception || '').slice(0, 100)}`)

await context.close(); await browser.close()
L.writeResults('results-s6.json', { invoice: inv.name, token })
