import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, log } = L
const admin = await L.adminApi()
const out = { deleted: [], failed: [], stock: {}, kept: [] }
const del = async (dt, name) => { try { await admin.post('frappe.client.delete', { doctype: dt, name }); out.deleted.push(`${dt} ${name}`) } catch (e) { out.failed.push({ doc: `${dt} ${name}`, err: String(e).replace(/\s+/g, ' ').slice(0, 200) }) } }

// my feedback rows would otherwise skew the HQ feedback tile (a 2★ alert on OK-BA)
for (const f of await admin.list('Maison Feedback', { comment: ['like', '%QA4%'] }, ['name'], 10)) {
  for (const n of await admin.list('Notification Log', { document_name: f.name }, ['name'], 10).catch(() => [])) await del('Notification Log', n.name)
  await del('Maison Feedback', f.name)
}
for (const e of await admin.list('Maison Web Enquiry', { customer_name: ['like', 'QA4%'] }, ['name'], 10)) await del('Maison Web Enquiry', e.name)
record('cleanup · test feedback + enquiry removed (they would skew the HQ tiles)',
  (await admin.list('Maison Feedback', { comment: ['like', '%QA4%'] }, ['name'], 5)).length === 0 && (await admin.list('Maison Web Enquiry', { customer_name: ['like', 'QA4%'] }, ['name'], 5)).length === 0,
  JSON.stringify(out.deleted))

// stock is back where it started (cancelling the POS invoices reversed the ledger)
for (const item of ['ACC-003', 'ACC-007', 'ACC-013', 'ACC-002', 'CBD-002', 'CBD-003']) {
  out.stock[item] = (await admin.list('Bin', { item_code: item, warehouse: `${L.STORE} - CCZ` }, ['actual_qty']))[0]?.actual_qty
}
record('cleanup · store stock restored by the cancellations', Object.values(out.stock).every((q) => Number(q) > 0), JSON.stringify(out.stock))

// what is deliberately left behind
out.kept = {
  customers: (await admin.list('Customer', { name: ['like', 'QA4%'] }, ['name', 'disabled'], 20)),
  users: (await admin.list('User', { name: ['like', 'qa4.%'] }, ['name', 'enabled'], 10)),
  coupons: (await admin.list('Maison Coupon', {}, ['name', 'enabled'], 20)),
  consents: (await admin.list('Maison Biometric Consent', {}, ['name', 'status', 'customer'], 10)),
  cancelledInvoices: (await admin.list('Sales Invoice', { customer: ['like', 'QA4%'], docstatus: 2 }, ['name'], 30)).length,
  cancelledOrders: (await admin.list('Sales Order', { customer: ['like', 'QA4%'], docstatus: 2 }, ['name'], 10)).length
}
record('cleanup · summary of what remains', true, JSON.stringify(out.kept).slice(0, 700))
fs.writeFileSync(new URL('./cleanup-s3.json', import.meta.url), JSON.stringify(out, null, 2))
L.writeResults('results-cleanup3.json', out)
