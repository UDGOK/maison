// QA4 — clean up everything this agent created on the live site. Reports what could not be removed.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, log, sleep } = L
const TAG = 'QA4A'
const admin = await L.adminApi()
const out = { cancelled: [], failed: [], disabled: [], deleted: [], kept: [] }
const cancel = async (dt, name) => {
  try { await admin.post('frappe.client.cancel', { doctype: dt, name }); out.cancelled.push(`${dt} ${name}`); return true }
  catch (e) { out.failed.push({ doc: `${dt} ${name}`, err: String(e).replace(/\s+/g, ' ').slice(0, 220) }); return false }
}
const del = async (dt, name) => {
  try { await admin.post('frappe.client.delete', { doctype: dt, name }); out.deleted.push(`${dt} ${name}`); return true }
  catch (e) { out.failed.push({ doc: `delete ${dt} ${name}`, err: String(e).replace(/\s+/g, ' ').slice(0, 200) }); return false }
}

// 1. salon sessions
const sessions = await admin.list('AWANZ Salon Session', { boutique: L.STORE, status: 'Paired' }, ['name'], 30)
for (const s of sessions) {
  try { await admin.post('frappe.client.set_value', { doctype: 'AWANZ Salon Session', name: s.name, fieldname: 'status', value: 'Unpaired' }); out.disabled.push(`Salon session ${s.name.slice(0, 10)}… → Unpaired`) }
  catch (e) { out.failed.push({ doc: `session ${s.name}`, err: String(e).slice(0, 120) }) }
}
record('cleanup · Salon sessions unpaired', true, `${sessions.length} paired sessions at ${L.STORE}`)

// 2. invoices — repeated passes (loyalty redemptions and credit notes block their sources)
let invoices = await admin.list('Sales Invoice', { maison_boutique: L.STORE, customer: ['like', 'QA4%'], docstatus: 1 }, ['name', 'is_return', 'return_against'], 40, 'name desc')
const startCount = invoices.length
for (let pass = 0; pass < 4 && invoices.length; pass++) {
  const before = invoices.length
  // credit notes first, then the newest sales
  for (const inv of [...invoices].sort((a, b) => (b.is_return - a.is_return) || b.name.localeCompare(a.name))) await cancel('Sales Invoice', inv.name)
  invoices = await admin.list('Sales Invoice', { maison_boutique: L.STORE, customer: ['like', 'QA4%'], docstatus: 1 }, ['name', 'is_return', 'return_against'], 40, 'name desc')
  log(`  pass ${pass + 1}: ${before} → ${invoices.length} left`)
  if (invoices.length === before) break
}
record('cleanup · POS invoices cancelled', invoices.length === 0, `${startCount - invoices.length}/${startCount} cancelled; still submitted: ${invoices.map((i) => i.name).join(', ') || 'none'}`)

// 3. web orders + their payment entries
for (const so of await admin.list('Sales Order', { maison_web_order: 1, customer: ['like', 'QA4%'], docstatus: 1 }, ['name'], 10)) {
  for (const pe of await admin.list('Payment Entry', { party: (await admin.value('Sales Order', so.name, ['customer'])).customer, docstatus: 1 }, ['name'], 10).catch(() => [])) {
    const refs = await admin.doc('Payment Entry', pe.name)
    if ((refs.references || []).some((r) => r.reference_name === so.name)) await cancel('Payment Entry', pe.name)
  }
  await cancel('Sales Order', so.name)
}
const soLeft = await admin.list('Sales Order', { maison_web_order: 1, customer: ['like', 'QA4%'], docstatus: 1 }, ['name'], 10)
record('cleanup · web orders cancelled', soLeft.length === 0, `still submitted: ${soLeft.map((s) => s.name).join(', ') || 'none'}`)

// 4. giveaway + entries created for the test giveaway
const gv = await admin.list('AWANZ Giveaway', { title: ['like', 'QA4 %'] }, ['name', 'title'], 5)
for (const g of gv) {
  for (const e of await admin.list('AWANZ Giveaway Entry', { giveaway: g.name }, ['name'], 50)) await del('AWANZ Giveaway Entry', e.name)
  await del('AWANZ Giveaway', g.name)
}
record('cleanup · test giveaway removed', (await admin.list('AWANZ Giveaway', { title: ['like', 'QA4 %'] }, ['name'], 5)).length === 0, gv.map((g) => g.name).join(', ') || 'none')

// 5. coupons — mine disabled (redemptions link to them); the birthday coupon issued to a seeded
//    customer by my job run is deleted so tomorrow's scheduled run issues it normally
for (const c of await admin.list('AWANZ Coupon', { code: ['like', 'QA4%'] }, ['name'], 20)) {
  try { await admin.post('frappe.client.set_value', { doctype: 'AWANZ Coupon', name: c.name, fieldname: 'enabled', value: 0 }); out.disabled.push(`Coupon ${c.name}`) } catch (e) { out.failed.push({ doc: `coupon ${c.name}`, err: String(e).slice(0, 120) }) }
}
for (const c of await admin.list('AWANZ Coupon', { code: ['like', 'BDAY%'] }, ['name', 'customer'], 20)) {
  if (String(c.customer || '').startsWith('QA4')) { try { await admin.post('frappe.client.set_value', { doctype: 'AWANZ Coupon', name: c.name, fieldname: 'enabled', value: 0 }); out.disabled.push(`Coupon ${c.name}`) } catch {} }
  else await del('AWANZ Coupon', c.name)
}
record('cleanup · coupons disabled / birthday coupons removed', true, JSON.stringify(await admin.list('AWANZ Coupon', {}, ['name', 'enabled', 'customer'], 20)))

// 6. restore the test member's name and birthday, then disable the test customers
const member = 'QA4 Member QA4A'
if ((await admin.list('Customer', { name: member }, ['name'])).length) {
  await admin.post('frappe.client.set_value', { doctype: 'Customer', name: member, fieldname: 'customer_name', value: 'QA4 Member QA4A' }).catch(() => {})
  await admin.post('frappe.client.set_value', { doctype: 'AWANZ Client Profile', name: member, fieldname: 'birthday', value: '1990-04-11' }).catch(() => {})
}
const customers = await admin.list('Customer', { customer_name: ['like', 'QA4%'] }, ['name', 'customer_name'], 30)
const customers2 = await admin.list('Customer', { name: ['like', 'QA4%'] }, ['name', 'customer_name'], 30)
const all = [...new Map([...customers, ...customers2].map((c) => [c.name, c])).values()]
for (const c of all) {
  try { await admin.post('frappe.client.set_value', { doctype: 'Customer', name: c.name, fieldname: 'disabled', value: 1 }); out.disabled.push(`Customer ${c.name}`) }
  catch (e) { out.failed.push({ doc: `customer ${c.name}`, err: String(e).slice(0, 150) }) }
}
record('cleanup · test customers disabled', true, all.map((c) => c.name).join(' | '))

// 7. test website users
for (const u of await admin.list('User', { name: ['like', 'qa4.%'] }, ['name'], 10)) {
  try { await admin.post('frappe.client.set_value', { doctype: 'User', name: u.name, fieldname: 'enabled', value: 0 }); out.disabled.push(`User ${u.name}`) }
  catch (e) { out.failed.push({ doc: `user ${u.name}`, err: String(e).slice(0, 150) }) }
}
record('cleanup · test shopper accounts disabled', true, (await admin.list('User', { name: ['like', 'qa4.%'] }, ['name', 'enabled'], 10)).map((u) => `${u.name}:${u.enabled}`).join(' | '))

// 8. final state
const glob = await admin.value('AWANZ POS Settings', 'AWANZ POS Settings', ['face_recognition_enabled', 'webshop_age_restricted_sales', 'reward_allow_stacking', 'birthday_coupon_enabled'])
const store = await admin.value('AWANZ Store', L.STORE, ['face_recognition_enabled'])
const consented = await admin.list('Customer', { maison_face_consent: 1 }, ['name'], 10)
const paired = await admin.list('AWANZ Salon Session', { status: 'Paired' }, ['name', 'boutique'], 20)
record('cleanup · settings untouched (recognition off, age gate on, stacking off)',
  !Number(glob.face_recognition_enabled) && !Number(glob.webshop_age_restricted_sales) && !Number(glob.reward_allow_stacking) && (store.face_recognition_enabled || 'Inherit') === 'Inherit' && consented.length === 0,
  `${JSON.stringify(glob)} · ${L.STORE}=${store.face_recognition_enabled || 'Inherit'} · consented=${consented.length} · paired sessions left (any store)=${JSON.stringify(paired)}`)
fs.writeFileSync(new URL('./cleanup-s.json', import.meta.url), JSON.stringify(out, null, 2))
L.writeResults('results-cleanup.json', out)
