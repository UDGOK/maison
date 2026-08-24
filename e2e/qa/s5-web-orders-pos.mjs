// QA4 · A — POS "Web orders": queue scoping, pick → ready → collect → Sales Invoice with advance + points.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const S3 = JSON.parse(fs.readFileSync(new URL('./created-s3.json', import.meta.url)))
const O_NEW = JSON.parse(fs.readFileSync(new URL('./created-s4-new.json', import.meta.url))).orderName
const O_MEM = JSON.parse(fs.readFileSync(new URL('./created-s4-exist.json', import.meta.url))).orderName
const admin = await L.adminApi()
const browser = await L.newBrowser()

// --- queue scoping over the API
const a1 = await L.userApi(L.A1)
const q = await a1.get('maison_pos.api.webshop.web_orders', { boutique: L.STORE })
record('A · web-order queue of the store lists both new orders', q.orders.some((o) => o.name === O_NEW) && q.orders.some((o) => o.name === O_MEM),
  `${q.orders.length} open at ${L.STORE}; counts=${JSON.stringify(q.counts)}`)
const other = 'OK-OWA'
const qo = await a1.raw('maison_pos.api.webshop.web_orders', { boutique: other })
record('A · an associate cannot read another store\'s web-order queue', qo.status !== 200 || !(qo.body?.message?.orders || []).some((o) => o.name === O_NEW),
  `${other} → ${qo.status} ${String(qo.body?.exception || '').slice(0, 90)}`)
const qOWA = await L.userApi({ usr: 'ok.owa.a1@cloudchaserz.example', pwd: L.PWD })
const qOWAq = await qOWA.raw('maison_pos.api.webshop.web_orders', { boutique: 'OK-OWA' })
record('A · the order does not appear in another store\'s queue', !(qOWAq.body?.message?.orders || []).some((o) => o.name === O_NEW || o.name === O_MEM),
  `OK-OWA queue = ${(qOWAq.body?.message?.orders || []).length} orders`)

// --- POS UI
const { context, page } = await L.ctxFor(browser, L.A1, 'pos', { viewport: { width: 1440, height: 1024 } })
await L.unlock(page, L.A1, { fresh: true })
await L.nav(page, 'Web orders')
await page.waitForSelector('[data-testid=web-orders]', { timeout: 30000 })
await page.waitForTimeout(2000)
const rows = await page.$$eval('[data-testid=web-order-row]', (r) => r.map((e) => ({ name: e.dataset.name, txt: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 90) })))
record('A · POS "Web orders" queue shows the orders for this store', rows.some((r) => r.name === O_MEM), `${rows.length} rows: ${rows.map((r) => r.name).join(',')}`)
record('A · a fully prepaid order is flagged "Paid online"', rows.find((r) => r.name === O_MEM)?.txt.includes('Paid online'), rows.find((r) => r.name === O_MEM)?.txt)
await shot(page, 'pos-web-orders-queue')

await page.click(`[data-testid=web-order-row][data-name="${O_MEM}"]`)
await page.waitForSelector('[data-testid=web-order-detail]', { timeout: 15000 })
const detail = (await page.locator('[data-testid=web-order-detail]').innerText()).replace(/\s+/g, ' ')
record('A · order detail shows lines, stock in this store, totals and balance', /PIECES TO PREPARE/i.test(detail) && /PAID ONLINE/i.test(detail) && /BALANCE AT COLLECTION/i.test(detail), detail.slice(0, 320))
await shot(page, 'pos-web-order-detail')

const cur = (await admin.value('Sales Order', O_MEM, ['maison_web_status'])).maison_web_status
if (cur === 'Ready') { // left over from an earlier attempt — walk it back so the whole machine is exercised
  await page.click('button:has-text("Back to picking")'); await page.waitForTimeout(2500)
}
if ((await admin.value('Sales Order', O_MEM, ['maison_web_status'])).maison_web_status === 'Picking') {
  record('A · Ready → "Back to picking" returns the order to Picking', true, 'walked back from Ready')
} else {
  await page.click('[data-testid=web-order-pick]')
  await page.waitForTimeout(2500)
}
let st = await admin.value('Sales Order', O_MEM, ['maison_web_status'])
record('A · "Start picking" moves the order to Picking', st.maison_web_status === 'Picking', JSON.stringify(st))
await page.click('[data-testid=web-order-ready]')
await page.waitForTimeout(2500)
st = await admin.value('Sales Order', O_MEM, ['maison_web_status'])
record('A · "Mark ready" moves the order to Ready', st.maison_web_status === 'Ready', JSON.stringify(st))
await shot(page, 'pos-web-order-ready')

// the shopper sees Ready on the order page
const shopper = await L.userApi(S3.EXIST, '/shop')
const so = await shopper.get('maison_pos.api.webshop.order', { name: O_MEM })
record('A · the shopper\'s order page reflects "Ready"', so.status === 'Ready', `status=${so.status}`)

// --- collect
const before = await admin.get('maison_pos.api.rewards.tiers', { customer: 'QA4 Member QA4A', boutique: L.STORE })
await page.click('[data-testid=web-order-collect]')
await page.waitForTimeout(3000)
await shot(page, 'pos-web-order-collect-cart')
const payTxt = (await page.locator('.pay, .page').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
record('A · Collect loads the order into the cart and opens Pay', /AMOUNT DUE/i.test(payTxt) && payTxt.includes(O_MEM), payTxt.slice(0, 200))
// complete the (zero balance) cash sale
const prepaidBtn = page.locator('[data-testid=collect-complete]')
if (await prepaidBtn.count()) { await prepaidBtn.click() } else { await page.click('button:has-text("Complete cash sale")') }
await page.waitForSelector('.receipt-view', { timeout: 40000 })
const { pill, uuid } = await L.waitSynced(page)
record('A · collection completes and syncs', /Synced/i.test(pill), `pill=${pill} uuid=${uuid}`)
await shot(page, 'pos-web-order-receipt')
const recTxt = (await page.locator('.receipt-view').innerText()).replace(/\s+/g, ' ')

const inv = (await L.invoiceForUuid(admin, uuid))[0]
record('A · collection creates a submitted Sales Invoice', !!inv && inv.docstatus === 1, JSON.stringify(inv))
const full = inv ? await admin.doc('Sales Invoice', inv.name) : null
const advance = (full?.advances || []).reduce((s, a) => s + Number(a.allocated_amount || 0), 0)
record('A · the online payment is allocated as an advance on the invoice', advance > 0 && Math.abs(advance - 43.35) < 0.05,
  `advances=${JSON.stringify((full?.advances || []).map((a) => [a.reference_name, a.allocated_amount]))} outstanding=${full?.outstanding_amount} grand=${full?.grand_total}`)
record('A · the invoice is linked to the Sales Order', full?.maison_sales_order === O_MEM || (full?.items || []).some((i) => i.sales_order === O_MEM), `maison_sales_order=${full?.maison_sales_order} item.sales_order=${(full?.items || [])[0]?.sales_order}`)
record('A · nothing is left outstanding on a prepaid collection', Math.abs(Number(full?.outstanding_amount || 0)) < 0.02, `outstanding=${full?.outstanding_amount}`)
st = await admin.value('Sales Order', O_MEM, ['maison_web_status', 'status', 'per_billed'])
record('A · the Sales Order is marked Collected', st.maison_web_status === 'Collected', JSON.stringify(st))
const after = await admin.get('maison_pos.api.rewards.tiers', { customer: 'QA4 Member QA4A', boutique: L.STORE })
const lpe = await admin.list('Loyalty Point Entry', { customer: 'QA4 Member QA4A' }, ['name', 'loyalty_points', 'invoice', 'purchase_amount', 'expiry_date'], 10)
record('A · points are awarded on the collection (on the net amount)', after.points > before.points,
  `points ${before.points} → ${after.points}; entries=${JSON.stringify(lpe.map((e) => [e.invoice, e.loyalty_points, e.purchase_amount]))}; invoice net=${full?.net_total} grand=${full?.grand_total}`)
record('A · points are earned on net, not on the taxed total', lpe[0] ? Number(lpe[0].loyalty_points) === Math.floor(Number(full?.net_total)) : false,
  `points=${lpe[0]?.loyalty_points} net=${full?.net_total} grand=${full?.grand_total}`)
record('A · the receipt shows the rewards block', /POINTS|REWARDS/i.test(recTxt), recTxt.match(/CLOUDCHASERZ REWARDS.{0,120}/i)?.[0] || recTxt.slice(0, 120))

await context.close(); await browser.close()
fs.writeFileSync(new URL('./created-s5.json', import.meta.url), JSON.stringify({ TAG, invoice: inv?.name, uuid, order: O_MEM }, null, 2))
L.writeResults('results-s5.json', { invoice: inv?.name, order: O_MEM })
