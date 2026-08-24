// QA4 · A — probe the real sign-up path, then create the two prefixed test shoppers.
import * as L from './lib-srs.mjs'
const { record, note, shot, go, log } = L
const TAG = process.env.RUNTAG || 'QA4A'
const admin = await L.adminApi()
const browser = await L.newBrowser()

// --- 1. the real signup path
const ws = await admin.value('Website Settings', 'Website Settings', ['disable_signup', 'home_page'])
const portal = await admin.value('Portal Settings', 'Portal Settings', ['default_role'])
const shoppers = await admin.list('User', { user_type: 'Website User' }, ['name'], 50)
record('A · a new shopper can sign up on the web shop', String(ws.disable_signup) !== '1',
  `Website Settings.disable_signup=${ws.disable_signup}; Portal Settings.default_role=${portal.default_role}; Website Users on the site=${shoppers.length}`,
  String(ws.disable_signup) === '1' ? 'critical' : '')
const { context, page } = await L.ctxFor(browser, null, 'login')
await go(page, '/login', { waitUntil: 'load' }).catch((e) => log('login nav', String(e).slice(0, 80)))
const loginTxt = await page.locator('body').innerText().catch(() => '')
record('A · /login offers a "Sign up" route for new shoppers', /sign\s*up/i.test(loginTxt), `signup link visible=${/sign\s*up/i.test(loginTxt)}`)
await shot(page, 'shop-login', true)
await context.close()

// --- 2. create the test shoppers (prefixed; disabled at cleanup)
const SPWD = 'Qa4!Shopper#2026'
const NEW = { usr: `qa4.newshopper.${TAG.toLowerCase()}@cloudchaserz.example`, pwd: SPWD, first: 'QA4 New', last: `Shopper ${TAG}` }
const EXIST = { usr: `qa4.client.${TAG.toLowerCase()}@cloudchaserz.example`, pwd: SPWD, first: 'QA4 Member', last: `Shopper ${TAG}` }
for (const u of [NEW, EXIST]) {
  if (!(await admin.list('User', { name: u.usr }, ['name'])).length) {
    await admin.post('frappe.client.insert', { doc: { doctype: 'User', email: u.usr, first_name: u.first, last_name: u.last, send_welcome_email: 0, user_type: 'Website User', new_password: u.pwd, roles: [{ role: 'Customer' }] } })
  }
  const doc = await admin.doc('User', u.usr)
  const roles = (doc.roles || []).map((r) => r.role)
  record(`A · test shopper ${u.usr} exists with the Customer role`, roles.includes('Customer'), `${doc.user_type} · roles=${roles.join(',')}`)
}
// link the "existing shopper" to the rewards member created in s2
const member = (await admin.list('Customer', { customer_name: ['like', `QA4 %${TAG}`] }, ['name', 'maison_client_number', 'email_id', 'mobile_no'], 10)).find((c) => c.maison_client_number)
let contact = null
if (member) {
  const existing = await admin.list('Contact', { user: EXIST.usr }, ['name'])
  if (!existing.length) {
    const res = await admin.post('frappe.client.insert', { doc: { doctype: 'Contact', first_name: 'QA4 Member', last_name: `Shopper ${TAG}`, user: EXIST.usr, email_ids: [{ email_id: EXIST.usr, is_primary: 1 }], links: [{ link_doctype: 'Customer', link_name: member.name }] } })
    contact = res.name
  } else contact = existing[0].name
}
record('A · existing shopper is linked to a rewards member (Contact → Customer)', !!contact && !!member, `${EXIST.usr} → ${member?.name} (${member?.maison_client_number}) contact=${contact}`)

// --- 3. login works for both
import { request as pwrequest } from 'playwright'
for (const u of [NEW, EXIST]) {
  const c = await pwrequest.newContext({ baseURL: L.BASE })
  const r = await c.post('/api/method/login', { data: { usr: u.usr, pwd: u.pwd } })
  record(`A · ${u.usr.split('@')[0]} can sign in`, r.status() === 200, `${r.status()}`)
  await c.dispose()
}
await browser.close()
import fs from 'node:fs'
fs.writeFileSync(new URL('./created-s3.json', import.meta.url), JSON.stringify({ TAG, NEW, EXIST, member, contact }, null, 2))
L.writeResults('results-s3.json', { NEW, EXIST, member })
