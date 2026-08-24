import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, log } = L
const admin = await L.adminApi()
const out = { cancelled: [], deleted: [], failed: [] }
const cancel = async (dt, name) => { try { await admin.post('frappe.client.cancel', { doctype: dt, name }); out.cancelled.push(`${dt} ${name}`); return true } catch (e) { out.failed.push({ doc: `${dt} ${name}`, err: String(e).replace(/\s+/g, ' ').slice(0, 260) }); return false } }
const del = async (dt, name) => { try { await admin.post('frappe.client.delete', { doctype: dt, name }); out.deleted.push(`${dt} ${name}`); return true } catch (e) { out.failed.push({ doc: `delete ${dt} ${name}`, err: String(e).replace(/\s+/g, ' ').slice(0, 260) }); return false } }

// payment requests block the sales orders
for (const so of ['SAL-ORD-2026-00002', 'SAL-ORD-2026-00003', 'SAL-ORD-2026-00004']) {
  for (const pr of await admin.list('Payment Request', { reference_name: so }, ['name', 'docstatus'], 5)) {
    if (pr.docstatus === 1) await cancel('Payment Request', pr.name)
  }
  const doc = await admin.value('Sales Order', so, ['docstatus'])
  if (Number(doc.docstatus) === 1) await cancel('Sales Order', so)
}
const soLeft = await admin.list('Sales Order', { maison_web_order: 1, customer: ['like', 'QA4%'], docstatus: 1 }, ['name'], 10)
record('cleanup · web orders cancelled', soLeft.length === 0, `left: ${soLeft.map((s) => s.name).join(', ') || 'none'}`)

// giveaway: clear the winner links, then delete entries + the giveaway
for (const g of await admin.list('AWANZ Giveaway', { title: ['like', 'QA4 %'] }, ['name'], 5)) {
  for (const f of ['winner_entry', 'winner', 'draw_audit', 'draw_seed']) await admin.post('frappe.client.set_value', { doctype: 'AWANZ Giveaway', name: g.name, fieldname: f, value: '' }).catch(() => {})
  for (const e of await admin.list('AWANZ Giveaway Entry', { giveaway: g.name }, ['name'], 50)) await del('AWANZ Giveaway Entry', e.name)
  await del('AWANZ Giveaway', g.name)
}
record('cleanup · test giveaway removed', (await admin.list('AWANZ Giveaway', { title: ['like', 'QA4 %'] }, ['name'], 5)).length === 0, JSON.stringify(out.failed.slice(-2)))

// leftover giveaway entries pointing at cancelled invoices of the seeded giveaway are left as-is
const state = {
  invoices: await admin.list('Sales Invoice', { customer: ['like', 'QA4%'], docstatus: 1 }, ['name'], 20),
  orders: await admin.list('Sales Order', { customer: ['like', 'QA4%'], docstatus: 1 }, ['name'], 20),
  enquiries: await admin.list('AWANZ Web Enquiry', { customer_name: ['like', 'QA4%'] }, ['name', 'status'], 10),
  feedback: await admin.list('AWANZ Feedback', { comment: ['like', '%QA4%'] }, ['name', 'rating'], 10),
  sessions: await admin.list('AWANZ Salon Session', { status: 'Paired' }, ['name', 'boutique'], 20),
  customers: await admin.list('Customer', { name: ['like', 'QA4%'] }, ['name', 'disabled'], 20)
}
record('cleanup · nothing of mine is left submitted', state.invoices.length === 0 && state.orders.length === 0, JSON.stringify({ invoices: state.invoices.length, orders: state.orders.length }))
record('cleanup · records deliberately kept (audit trail)', true, `enquiry ${JSON.stringify(state.enquiries)} · feedback ${JSON.stringify(state.feedback)} · customers ${JSON.stringify(state.customers)}`)
record('cleanup · no Salon session left paired anywhere', state.sessions.length === 0, JSON.stringify(state.sessions))
fs.writeFileSync(new URL('./cleanup-s2.json', import.meta.url), JSON.stringify({ out, state }, null, 2))
L.writeResults('results-cleanup2.json', out)
