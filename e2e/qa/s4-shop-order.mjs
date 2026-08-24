// QA4 · A — shopper: bag, quantities, remove, click & collect checkout, simulated payment, order pages.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const S = JSON.parse(fs.readFileSync(new URL('./created-s3.json', import.meta.url)))
const WHO = process.env.WHO === 'exist' ? S.EXIST : S.NEW
const admin = await L.adminApi()
const guest = await L.guestApi()
const browser = await L.newBrowser()
const cat = await guest.get('maison_pos.api.webshop.catalogue', { limit: 500 })
const buyable = cat.items.filter((i) => i.web_mode === 'Buy' && !i.in_store_only && i.rate)
const ITEM1 = buyable.find((i) => i.item_code === 'ACC-007') || buyable[0]
const ITEM2 = buyable.find((i) => i.item_code === 'ACC-002') || buyable[1]
const AGE = cat.items.find((i) => i.in_store_only)
log(`shopper=${WHO.usr} item1=${ITEM1.item_code} item2=${ITEM2.item_code}`)

const shopper = await L.userApi(WHO, '/shop')
// start from an empty bag
for (const l of (await shopper.get('maison_pos.api.webshop.cart')).items) await shopper.post('maison_pos.api.webshop.update_cart', { item_code: l.item_code, qty: 0 })

const { context, page } = await L.ctxFor(browser, WHO, 'shopper')
// --- add to bag from the product page
await go(page, ITEM1.route)
await page.click('#mw-add')
await page.waitForTimeout(1500)
const viewBag = await page.locator('#mw-view-bag').isVisible().catch(() => false)
record('A · "Add to bag" adds the line and offers "View bag"', viewBag, `${ITEM1.item_code}`)
await shot(page, 'shop-added-to-bag')
// --- second item
await go(page, ITEM2.route)
await page.click('#mw-add')
await page.waitForTimeout(1500)

// --- cart: quantities and removal
await go(page, '/cart')
await page.waitForSelector('.mw-line', { timeout: 20000 })
let lines = await page.locator('.mw-line').count()
record('A · bag lists both lines', lines === 2, `${lines} lines`)
await shot(page, 'shop-cart', true)
await page.locator(`.mw-line[data-item-code="${ITEM1.item_code}"] [data-d="1"]`).click()
await page.waitForTimeout(2500)
const qty1 = await page.locator(`.mw-line[data-item-code="${ITEM1.item_code}"] .qty span`).textContent()
const cart1 = await shopper.get('maison_pos.api.webshop.cart')
record('A · quantity + updates the line and the totals', qty1.trim() === '2' && cart1.items.find((i) => i.item_code === ITEM1.item_code)?.qty === 2, `qty=${qty1.trim()} server=${JSON.stringify(cart1.items.map((i) => [i.item_code, i.qty]))} total=${cart1.grand_total}`)
await page.locator(`.mw-line[data-item-code="${ITEM1.item_code}"] [data-d="-1"]`).click()
await page.waitForTimeout(2500)
const cart2 = await shopper.get('maison_pos.api.webshop.cart')
record('A · quantity − updates the line', cart2.items.find((i) => i.item_code === ITEM1.item_code)?.qty === 1, JSON.stringify(cart2.items.map((i) => [i.item_code, i.qty])))
await page.locator(`.mw-line[data-item-code="${ITEM2.item_code}"] [data-rm]`).click()
await page.waitForTimeout(2500)
const cart3 = await shopper.get('maison_pos.api.webshop.cart')
record('A · Remove deletes the line', cart3.items.length === 1 && cart3.items[0].item_code === ITEM1.item_code, JSON.stringify(cart3.items.map((i) => i.item_code)))
// removing the last line empties the bag cleanly
await shopper.post('maison_pos.api.webshop.update_cart', { item_code: ITEM1.item_code, qty: 0 })
const empty = await shopper.get('maison_pos.api.webshop.cart')
record('A · removing the last line empties the bag cleanly', (empty.items || []).length === 0, JSON.stringify(empty.items))
await go(page, '/cart')
record('A · empty bag shows the empty state', (await page.locator('.mw-empty').count()) === 1)

// --- age-restricted item may not enter the bag
const addAge = await shopper.rawPost('maison_pos.api.webshop.update_cart', { item_code: AGE.item_code, qty: 1 })
const inBag = (await shopper.get('maison_pos.api.webshop.cart')).items.some((i) => i.item_code === AGE.item_code)
record('A · age-restricted item cannot be added to the bag', addAge.status !== 200 && !inBag,
  `update_cart(${AGE.item_code}) → ${addAge.status}; in bag=${inBag}`, (addAge.status === 200 || inBag) ? 'major' : '')
if (inBag) {
  const co = await shopper.rawPost('maison_pos.api.webshop.place_order', { boutique: L.STORE, pay_now: 0 })
  record('A · …and checkout refuses it', co.status !== 200, `place_order → ${co.status} ${String(co.body?.exception || '').slice(0, 140)}`)
  await go(page, '/cart'); await shot(page, 'shop-cart-age-restricted', true)
  await shopper.post('maison_pos.api.webshop.update_cart', { item_code: AGE.item_code, qty: 0 })
}

// --- checkout: click & collect
await shopper.post('maison_pos.api.webshop.update_cart', { item_code: ITEM1.item_code, qty: 2 })
await go(page, '/shop/checkout')
await page.waitForSelector('.mw-boutique', { timeout: 20000 })
const stores = await page.$$eval('#mw-boutiques .mw-boutique', (b) => b.map((e) => ({ code: e.dataset.boutique, txt: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 70) })))
record('A · checkout offers every store as a collection point (with stock status)', stores.length >= 10 && stores.every((s) => s.code), `${stores.length}: ${stores.slice(0, 2).map((s) => s.txt).join(' | ')}`)
record('A · the warehouse (HOU-WH) is not offered as a collection point', !stores.some((s) => s.code === 'HOU-WH'), stores.map((s) => s.code).join(','))
await page.click(`#mw-boutiques .mw-boutique[data-boutique="${L.STORE}"]`)
await page.click('#mw-pay .mw-boutique[data-pay="1"]')
await shot(page, 'shop-checkout', true)
await page.click('#mw-place')
await page.waitForURL(/\/shop\/(pay|order)/, { timeout: 40000 })
record('A · placing the order goes to the payment page', /\/shop\/pay/.test(page.url()), page.url())
await shot(page, 'shop-pay-simulated', true)
if (/\/shop\/pay/.test(page.url())) {
  await page.click('#mw-pay-go')
  await page.waitForURL(/\/shop\/order/, { timeout: 40000 })
}
await page.waitForTimeout(1500)
const orderName = new URL(page.url()).searchParams.get('name')
record('A · simulated payment returns to the order page', !!orderName && /paid=1/.test(page.url()), page.url())
await shot(page, 'shop-order-placed', true)

// --- backend verification
const so = await admin.doc('Sales Order', orderName)
record('A · Sales Order carries the web-order fields and the chosen store', Number(so.maison_web_order) === 1 && so.maison_boutique === L.STORE && so.maison_web_status === 'New' && so.docstatus === 1,
  `${so.name} boutique=${so.maison_boutique} status=${so.maison_web_status} order_type=${so.order_type} total=${so.grand_total} taxes=${so.taxes_and_charges}`)
const pe = await admin.list('Payment Entry', { reference_no: ['like', `%${orderName}%`] }, ['name', 'paid_amount', 'docstatus'], 5)
const peRef = await admin.list('Payment Entry Reference', { reference_name: orderName }, ['parent', 'allocated_amount'], 5).catch(() => [])
record('A · online payment is recorded as an advance on the order', Number(so.advance_paid) > 0 || Number(so.maison_prepaid_amount) > 0,
  `advance_paid=${so.advance_paid} maison_prepaid_amount=${so.maison_prepaid_amount} payment_entries=${JSON.stringify(peRef)}`)
const taxOk = Number(so.total_taxes_and_charges) > 0
record('A · the order is taxed with the collecting store template', taxOk, `${so.taxes_and_charges} → ${so.total_taxes_and_charges}`)

// --- order pages
await go(page, '/shop/orders')
const rows = await page.locator('.mw-orders a, .mw-orders .row, .mw-orders > *').count()
const ordersTxt = await page.locator('body').innerText()
record('A · order history lists the order', ordersTxt.includes(orderName), `${rows} rows`)
await shot(page, 'shop-orders-history', true)
await go(page, `/shop/order?name=${orderName}`)
const otxt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
record('A · order page shows the collection timeline and store', /preparing your order|Ready|Collected/i.test(otxt) && /Broken Arrow|CloudChaserz/i.test(otxt), otxt.slice(0, 140))
record('A · fully prepaid order shows no "payment due"', !/Payment due/i.test(otxt), /Payment due/i.test(otxt) ? otxt.match(/Payment due[^A-Z]{0,40}/)?.[0] : 'none')

// another shopper cannot see this order
const other = await L.userApi(process.env.WHO === 'exist' ? S.NEW : S.EXIST, '/shop')
const mine = await other.get('maison_pos.api.webshop.my_orders')
record('A · another shopper cannot see this order in my_orders', !mine.some((o) => o.name === orderName), `${mine.length} orders for the other shopper`)
const foreign = await other.rawPost('maison_pos.api.webshop.order', { name: orderName })
const foreignGet = await other.raw('maison_pos.api.webshop.order', { name: orderName })
record('A · another shopper cannot open this order by name', foreignGet.status !== 200, `${foreignGet.status} ${String(foreignGet.body?.exception || JSON.stringify(foreignGet.body)).slice(0, 120)}`)

await context.close(); await browser.close()
fs.writeFileSync(new URL(`./created-s4-${process.env.WHO || 'new'}.json`, import.meta.url), JSON.stringify({ TAG, shopper: WHO.usr, orderName, item: ITEM1.item_code, qty: 2 }, null, 2))
L.writeResults(`results-s4-${process.env.WHO || 'new'}.json`, { orderName, shopper: WHO.usr })
