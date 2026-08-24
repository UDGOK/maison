// QA4 · A — "Ask the store" enquiry on an age-restricted product → POS queue; phone cart/checkout.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, overflow, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const S3 = JSON.parse(fs.readFileSync(new URL('./created-s3.json', import.meta.url)))
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const guest = await L.guestApi()
const browser = await L.newBrowser()
const created = { enquiries: [] }

// --- guest enquiry from an age-restricted product page
const { context, page } = await L.ctxFor(browser, null, 'guest')
await go(page, '/disposables/geek-bar-pulse-15k-—-miami-mint-lfs0m')
await page.click('.mw-cta button[data-mw-sheet=mw-enquire]')
await page.waitForSelector('#mw-enquire-form', { state: 'visible', timeout: 15000 })
await page.fill('#mw-enquire-form [name=name]', `QA4 Enquirer ${TAG}`)
await page.fill('#mw-enquire-form [name=email]', `qa4.enquiry.${TAG.toLowerCase()}@example.com`)
await page.fill('#mw-enquire-form [name=message]', 'QA4 test enquiry — please ignore. Do you have this in stock?')
await page.selectOption('#mw-enquire-form [name=boutique]', L.STORE).catch(() => {})
await shot(page, 'shop-enquire-sheet')
await page.click('#mw-enquire-form button[type=submit]')
await page.waitForSelector('#mw-enquire-done', { state: 'visible', timeout: 20000 }).catch(() => {})
await sleep(1500)
const enq = (await admin.list('AWANZ Web Enquiry', { email: `qa4.enquiry.${TAG.toLowerCase()}@example.com` }, ['name', 'boutique', 'item_code', 'status', 'customer_name'], 5))[0]
if (enq) created.enquiries.push(enq.name)
record('A · an enquiry on an age-restricted product reaches the chosen store', !!enq && enq.boutique === L.STORE && enq.status === 'New', JSON.stringify(enq))
const q = await assoc.get('maison_pos.api.webshop.web_orders', { boutique: L.STORE })
record('A · the enquiry shows in the store\'s POS queue', (q.enquiries || []).some((e) => e.name === enq?.name), `${(q.enquiries || []).length} enquiries · counts=${JSON.stringify(q.counts)}`)
const other = await L.userApi({ usr: 'ok.owa.a1@cloudchaserz.example', pwd: L.PWD })
const oq = await other.raw('maison_pos.api.webshop.web_orders', { boutique: 'OK-OWA' })
record('A · the enquiry does not leak into another store\'s queue', !((oq.body?.message?.enquiries) || []).some((e) => e.name === enq?.name), `OK-OWA enquiries=${((oq.body?.message?.enquiries) || []).length}`)
if (enq) {
  await assoc.post('maison_pos.api.webshop.update_enquiry', { name: enq.name, status: 'Contacted', response: `QA4 ${TAG} test response` })
  record('A · an associate can answer the enquiry', (await admin.value('AWANZ Web Enquiry', enq.name, ['status', 'response'])).status === 'Contacted', JSON.stringify(await admin.value('AWANZ Web Enquiry', enq.name, ['status', 'response'])))
}
await context.close()

// --- phone cart + checkout (signed in)
const m = await L.ctxFor(browser, S3.NEW, 'shopper-phone', { viewport: { width: 390, height: 844 } })
const shopper = await L.userApi(S3.NEW, '/shop')
for (const l of (await shopper.get('maison_pos.api.webshop.cart')).items) await shopper.post('maison_pos.api.webshop.update_cart', { item_code: l.item_code, qty: 0 })
await shopper.post('maison_pos.api.webshop.update_cart', { item_code: 'ACC-007', qty: 2 })
const overs = []
for (const [name, url] of [['cart', '/cart'], ['checkout', '/shop/checkout'], ['orders', '/shop/orders']]) {
  await go(m.page, url)
  await m.page.waitForTimeout(800)
  overs.push(`${name}:${await overflow(m.page)}`)
  await shot(m.page, `m-${name}-390`, true)
}
record('A · mobile 390×844: bag, checkout and order history do not scroll sideways', overs.every((o) => Number(o.split(':')[1]) <= 0), overs.join(' '))
// leave the bag empty
for (const l of (await shopper.get('maison_pos.api.webshop.cart')).items) await shopper.post('maison_pos.api.webshop.update_cart', { item_code: l.item_code, qty: 0 })
await m.context.close(); await browser.close()
fs.writeFileSync(new URL('./created-s14.json', import.meta.url), JSON.stringify({ TAG, created }, null, 2))
L.writeResults('results-s14.json', { created })
