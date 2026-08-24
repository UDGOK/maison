// QA4 · A/B — "pay at the store" web order collected with a balance; the $10/200 and $5/100 tiers.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Member QA4A'
const S3 = JSON.parse(fs.readFileSync(new URL('./created-s3.json', import.meta.url)))
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const created = { orders: [], invoices: [] }

// ---------- A: order paid at the counter
const shopper = await L.userApi(S3.NEW, '/shop')
for (const l of (await shopper.get('maison_pos.api.webshop.cart')).items) await shopper.post('maison_pos.api.webshop.update_cart', { item_code: l.item_code, qty: 0 })
await shopper.post('maison_pos.api.webshop.update_cart', { item_code: 'ACC-013', qty: 1 })
const placed = await shopper.post('maison_pos.api.webshop.place_order', { boutique: L.STORE, pay_now: 0 })
created.orders.push(placed.sales_order)
const so = await admin.doc('Sales Order', placed.sales_order)
record('A · "pay at the store" places an unpaid web order', Number(so.maison_web_order) === 1 && Number(so.advance_paid || 0) === 0 && so.maison_web_status === 'New',
  `${so.name} total=${so.grand_total} advance=${so.advance_paid} prepaid=${so.maison_prepaid_amount} payment_url=${placed.payment_url}`)
const q = await assoc.get('maison_pos.api.webshop.web_orders', { boutique: L.STORE })
const row = (q.orders || []).find((o) => o.name === placed.sales_order)
record('A · the unpaid order shows a balance due at collection', row && Number(row.prepaid_amount || 0) === 0 && Number(row.balance_due) > 0, JSON.stringify(row).slice(0, 200))
await assoc.post('maison_pos.api.webshop.set_web_order_status', { name: placed.sales_order, status: 'Picking' })
await assoc.post('maison_pos.api.webshop.set_web_order_status', { name: placed.sales_order, status: 'Ready' })
const detail = await assoc.get('maison_pos.api.webshop.web_order', { name: placed.sales_order })
record('A · the queue walks New → Picking → Ready', detail.status === 'Ready', `status=${detail.status} balance_due=${detail.balance_due}`)
const collect = await assoc.post('maison_pos.api.sales.submit_batch', {
  invoices: [{
    offline_uuid: `qa4-${TAG}-collect-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
    posting_datetime: new Date().toISOString(), customer: so.customer, sales_order: placed.sales_order,
    items: (detail.items || []).map((i) => ({ item_code: i.item_code, qty: i.qty, rate: i.rate })),
    payments: [{ mode_of_payment: 'Cash', amount: Number(detail.balance_due.toFixed(2)) }]
  }]
})
const cres = collect.results[0]
if (cres.status === 'ok') created.invoices.push(cres.invoice_name)
record('A · collecting an unpaid order tenders the full balance', cres.status === 'ok', JSON.stringify(cres).slice(0, 200))
const cInv = cres.status === 'ok' ? await admin.doc('Sales Invoice', cres.invoice_name) : null
record('A · the collection invoice is linked to the order, fully paid, no advance',
  cInv && cInv.maison_sales_order === placed.sales_order && Math.abs(Number(cInv.outstanding_amount)) < 0.02 && (cInv.advances || []).length === 0,
  `${cInv?.name} outstanding=${cInv?.outstanding_amount} advances=${(cInv?.advances || []).length} paid=${JSON.stringify((cInv?.payments || []).map((p) => [p.mode_of_payment, p.amount]))}`)
record('A · the Sales Order is Collected', (await admin.value('Sales Order', placed.sales_order, ['maison_web_status'])).maison_web_status === 'Collected',
  JSON.stringify(await admin.value('Sales Order', placed.sales_order, ['maison_web_status', 'status'])))

// ---------- B: each remaining tier
const tiersDef = (await assoc.get('maison_pos.api.catalog.bootstrap', { boutique: L.STORE })).reward_tiers || []
for (const points of [200, 100]) {
  const tier = tiersDef.find((t) => t.points === points)
  const bal = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
  if (bal.points < points) { note(`B · tier $${tier?.amount}/${points} not exercised`, `balance ${bal.points} < ${points}`); continue }
  const r = await assoc.post('maison_pos.api.sales.submit_batch', {
    invoices: [{
      offline_uuid: `qa4-${TAG}-tier${points}-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
      posting_datetime: new Date().toISOString(), customer: MEMBER, reward_tier: tier.name,
      items: [{ item_code: 'ACC-003', qty: 1, rate: 59.99 }],
      payments: [{ mode_of_payment: 'Cash', amount: 60 }]
    }]
  })
  const res = r.results[0]
  if (res.status === 'ok') created.invoices.push(res.invoice_name)
  const inv = res.status === 'ok' ? await admin.doc('Sales Invoice', res.invoice_name) : null
  const after = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
  record(`B · the $${tier.amount} / ${points} points tier redeems at the POS`,
    res.status === 'ok' && Number(inv.loyalty_amount) === Number(tier.amount) && Number(inv.loyalty_points) === points,
    `${res.invoice_name || res.error}: loyalty_amount=${inv?.loyalty_amount} loyalty_points=${inv?.loyalty_points} tier=${inv?.maison_reward_tier} grand=${inv?.grand_total} (balance ${bal.points} → ${after.points})`)
}
fs.writeFileSync(new URL('./created-s13.json', import.meta.url), JSON.stringify({ TAG, created }, null, 2))
L.writeResults('results-s13.json', { created })
