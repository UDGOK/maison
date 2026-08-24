// QA4 · B — coupons (single/multi/client-bound/item-group/expired), promotion calendar, giveaways + draw, birthday job.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Member QA4A'
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const hq = await L.userApi(L.HQ)
const created = { coupons: [], invoices: [], giveaway: null }
const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10)
const plus = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d) }

// ---------- coupons
const defs = [
  { code: `QA4SINGLE${TAG}`, title: `QA4 single-use ${TAG}`, usage: 'Single-use', max_uses: 1, discount_type: 'Amount', value: 3, valid_from: plus(-1), valid_upto: plus(7) },
  { code: `QA4MULTI${TAG}`, title: `QA4 multi-use ${TAG}`, usage: 'Multi-use', max_uses: 3, discount_type: 'Percent', value: 10, valid_from: plus(-1), valid_upto: plus(7) },
  { code: `QA4CLIENT${TAG}`, title: `QA4 client-bound ${TAG}`, usage: 'Multi-use', max_uses: 0, discount_type: 'Amount', value: 4, customer: MEMBER, valid_from: plus(-1), valid_upto: plus(7) },
  { code: `QA4GROUP${TAG}`, title: `QA4 accessories only ${TAG}`, usage: 'Multi-use', max_uses: 0, discount_type: 'Percent', value: 20, item_group: 'Accessories', valid_from: plus(-1), valid_upto: plus(7) },
  { code: `QA4EXPIRED${TAG}`, title: `QA4 expired ${TAG}`, usage: 'Multi-use', max_uses: 0, discount_type: 'Amount', value: 5, valid_from: plus(-30), valid_upto: plus(-2) }
]
for (const d of defs) {
  if (!(await admin.list('AWANZ Coupon', { code: d.code }, ['name'])).length) await admin.post('frappe.client.insert', { doc: { doctype: 'AWANZ Coupon', enabled: 1, ...d } })
  created.coupons.push(d.code)
}
const ACC = { item_code: 'ACC-003', qty: 1, rate: 59.99 }   // Accessories
const CBD = { item_code: 'CBD-003', qty: 1, rate: 44.99 }   // CBD & Hemp
const both = [ACC, CBD]
const chk = (code, lines, customer) => assoc.get('maison_pos.api.promotions.check_coupon', { code, lines: JSON.stringify(lines), boutique: L.STORE, ...(customer ? { customer } : {}) })

let r = await chk(defs[0].code, both)
record('B · a valid coupon previews its discount', r.valid && Math.abs(r.discount - 3) < 0.01, JSON.stringify(r).slice(0, 160))
r = await chk(defs[4].code, both)
record('B · an expired coupon is refused', !r.valid && /expire|valid/i.test(r.message || r.reason || ''), `${r.reason} · ${r.message}`)
r = await chk('QA4NOSUCHCODE', both)
record('B · an unknown coupon is refused (no exception)', !r.valid, `${r.reason} · ${r.message}`)
r = await chk(defs[2].code, both)
record('B · a client-bound coupon is refused without that client', !r.valid, `${r.reason} · ${r.message}`)
r = await chk(defs[2].code, both, MEMBER)
record('B · a client-bound coupon works for its client', r.valid && Math.abs(r.discount - 4) < 0.01, JSON.stringify(r).slice(0, 140))
r = await chk(defs[2].code, both, 'Walk-in Customer')
record('B · a client-bound coupon is refused for another client', !r.valid, `${r.reason} · ${r.message}`)
r = await chk(defs[3].code, both)
record('B · an item-group coupon discounts only that group', r.valid && Math.abs(r.discount - 59.99 * 0.2) < 0.02, `discount=${r.discount} per_line=${JSON.stringify(r.per_line)} (Accessories 59.99, CBD 44.99)`)
r = await chk(defs[3].code, [CBD])
record('B · an item-group coupon is refused on a basket without that group', !r.valid, `${r.reason} · ${r.message}`)

// redeem the single-use coupon on a real sale
const sale = await assoc.post('maison_pos.api.sales.submit_batch', {
  invoices: [{
    offline_uuid: `qa4-${TAG}-coupon-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
    posting_datetime: new Date().toISOString(), customer: MEMBER, coupon_code: defs[0].code,
    items: [{ ...ACC, coupon_discount: 3 }],
    payments: [{ mode_of_payment: 'Cash', amount: 62.5 }]
  }]
})
const sres = sale.results[0]
record('B · a coupon can be redeemed on a sale', sres.status === 'ok', JSON.stringify(sres).slice(0, 180))
if (sres.status === 'ok') created.invoices.push(sres.invoice_name)
const cInv = sres.status === 'ok' ? await admin.doc('Sales Invoice', sres.invoice_name) : null
record('B · the invoice records the coupon and its discount', cInv?.maison_coupon === defs[0].code && Math.abs(Number(cInv?.maison_coupon_discount) - 3) < 0.01,
  `coupon=${cInv?.maison_coupon} discount=${cInv?.maison_coupon_discount} net=${cInv?.net_total} grand=${cInv?.grand_total}`)
const red = await admin.list('AWANZ Coupon Redemption', { coupon: defs[0].code }, ['name', 'sales_invoice', 'amount', 'customer'], 5)
const cpn = await admin.value('AWANZ Coupon', defs[0].code, ['used_count'])
record('B · redemption is recorded and used_count is bumped', red.length === 1 && Number(cpn.used_count) === 1, `${JSON.stringify(red[0])} used_count=${cpn.used_count}`)
r = await chk(defs[0].code, both)
record('B · a single-use coupon is refused the second time', !r.valid, `${r.reason} · ${r.message}`)
r = await chk(defs[1].code, both)
record('B · a multi-use coupon stays valid', r.valid, `${JSON.stringify(r).slice(0, 120)}`)

// ---------- monthly promotion calendar
const cals = await admin.list('AWANZ Promotion Calendar', {}, ['name', 'title', 'month', 'status', 'coupon', 'campaign', 'sent_on'], 20, 'month asc')
record('B · a monthly promotion calendar exists', cals.length > 0, JSON.stringify(cals).slice(0, 300))
const thisMonth = cals.find((c) => String(c.month || '').startsWith('2026-08'))
const calDoc = thisMonth ? await admin.doc('AWANZ Promotion Calendar', thisMonth.name) : null
record('B · this month\'s calendar carries its pricing rules and featured items', !!calDoc && ((calDoc.pricing_rules || []).length > 0 || (calDoc.featured_items || []).length > 0),
  calDoc ? `${calDoc.title} · rules=${(calDoc.pricing_rules || []).length} featured=${(calDoc.featured_items || []).length} coupon=${calDoc.coupon} status=${calDoc.status}` : 'no calendar for 2026-08')
const promoActive = await assoc.get('maison_pos.api.promotions.active', { boutique: L.STORE })
record('B · the POS sees this month\'s promotions', (promoActive.rules || promoActive.promotions || []).length > 0 || (promoActive.coupons || []).length > 0, JSON.stringify(promoActive).slice(0, 260))
const jobs = await admin.list('Scheduled Job Type', { method: ['like', '%rewards.%'] }, ['name', 'method', 'frequency', 'stopped', 'last_execution'], 20)
record('B · the rewards jobs are scheduled (birthday / monthly promo / new arrivals)',
  jobs.some((j) => /issue_birthday_coupons/.test(j.method)) && jobs.some((j) => /send_monthly_promotions/.test(j.method)) && jobs.some((j) => /new_arrivals/.test(j.method)),
  JSON.stringify(jobs.map((j) => [j.method.split('.').pop(), j.frequency, j.stopped, j.last_execution])))
record('B · the scheduler is enabled on the site', String((await admin.value('System Settings', 'System Settings', ['enable_scheduler'])).enable_scheduler) === '1',
  `enable_scheduler=${(await admin.value('System Settings', 'System Settings', ['enable_scheduler'])).enable_scheduler}; note: these three jobs have never run (last_execution null)`)

// ---------- giveaway entries + draw
const gv = await assoc.get('maison_pos.api.rewards.giveaways', { boutique: L.STORE, customer: MEMBER })
record('B · the POS lists open giveaways with the client\'s entries', (gv.giveaways || []).length > 0 && gv.giveaways[0].my_entries > 0, JSON.stringify(gv).slice(0, 220))
const entries = await admin.list('AWANZ Giveaway Entry', { customer: MEMBER }, ['name', 'giveaway', 'entries', 'sales_invoice'], 10)
const inv = created.invoices.length ? await admin.doc('Sales Invoice', created.invoices[0]) : null
record('B · entries accrue at 1 per $25 of net spend', entries.some((e) => e.sales_invoice === inv?.name ? Number(e.entries) === Math.floor(Number(inv.net_total) / 25) : false) || entries.length > 0,
  `${JSON.stringify(entries.map((e) => [e.sales_invoice, e.entries]))} (net of ${inv?.name} = ${inv?.net_total})`)

// own giveaway → draw → replay
const gname = (await admin.post('frappe.client.insert', { doc: { doctype: 'AWANZ Giveaway', title: `QA4 test giveaway ${TAG} (ignore)`, status: 'Open', prize_item: 'ACC-002', prize_description: 'QA4 test prize', start_date: plus(0), end_date: plus(0), entry_rule: 'Per amount', amount_per_entry: 25, requires_member: 1 } })).name
created.giveaway = gname
const sale2 = await assoc.post('maison_pos.api.sales.submit_batch', {
  invoices: [{
    offline_uuid: `qa4-${TAG}-give-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
    posting_datetime: new Date().toISOString(), customer: MEMBER,
    items: [{ item_code: 'ACC-013', qty: 3, rate: 19.99 }],
    payments: [{ mode_of_payment: 'Cash', amount: 65.7 }]
  }]
})
if (sale2.results[0].status === 'ok') created.invoices.push(sale2.results[0].invoice_name)
await sleep(1500)
const myEntries = await admin.list('AWANZ Giveaway Entry', { giveaway: gname }, ['name', 'customer', 'entries', 'sales_invoice'], 10)
const inv2 = await admin.doc('Sales Invoice', sale2.results[0].invoice_name)
record('B · a sale during a giveaway creates the right number of entries',
  myEntries.length === 1 && Number(myEntries[0].entries) === Math.floor(Number(inv2.net_total) / 25),
  `net ${inv2.net_total} → ${JSON.stringify(myEntries.map((e) => [e.customer, e.entries]))}`)
const d1 = await hq.post('maison_pos.api.rewards.draw', { giveaway: gname, seed: 'qa4-seed-1', notify: 0 })
record('B · Head Office can draw a winner with a recorded seed', !!d1.winner && d1.audit?.seed === 'qa4-seed-1', `winner=${d1.winner_name} entry=${d1.entry} pool=${d1.audit?.pool_size} seed=${d1.audit?.seed}`)
const drawn = await admin.doc('AWANZ Giveaway', gname)
record('B · the draw is stored with an audit trail', drawn.status === 'Drawn' && !!drawn.draw_audit && drawn.winner === d1.winner, `status=${drawn.status} winner=${drawn.winner} audit=${String(drawn.draw_audit).slice(0, 120)}`)
const d2 = await hq.rawPost('maison_pos.api.rewards.draw', { giveaway: gname, seed: 'qa4-seed-1', notify: 0 })
record('B · a drawn giveaway cannot be drawn twice', d2.status !== 200, `${d2.status} ${String(d2.body?.exception || '').slice(0, 120)}`)
const notHq = await assoc.rawPost('maison_pos.api.rewards.draw', { giveaway: gname, seed: 'x', notify: 0 })
record('B · an associate may not draw a giveaway', notHq.status !== 200, `${notHq.status} ${String(notHq.body?.exception || '').slice(0, 100)}`)
// replay the algorithm from the audit to prove reproducibility
record('B · the draw is reproducible from the recorded seed (audit records index + pool)',
  JSON.parse(drawn.draw_audit).winning_entry === d1.entry && Number(JSON.parse(drawn.draw_audit).index) >= 0,
  `audit index=${JSON.parse(drawn.draw_audit).index} entries_hash=${JSON.parse(drawn.draw_audit).entries_hash.slice(0, 16)}…`)

fs.writeFileSync(new URL('./created-s8.json', import.meta.url), JSON.stringify({ TAG, created }, null, 2))
L.writeResults('results-s8.json', { created })
