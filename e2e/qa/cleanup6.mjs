import * as L from './lib-pos.mjs'
const admin = await L.adminApi()
for (const n of ['ACC-SINV-2026-03078']) {
  try { await admin.post('frappe.client.cancel', { doctype: 'Sales Invoice', name: n }); console.log(n, 'cancelled') }
  catch (e) { console.log(n, 'ERR', String(e.message).slice(0, 200)) }
}
const rows = await admin.list('Sales Invoice', { name: ['>=', 'ACC-SINV-2026-03047'], docstatus: 1, maison_boutique: 'HOU-MTR' }, ['name', 'grand_total'], 40, 'name asc')
console.log('remaining submitted:', rows.length, 'net', rows.reduce((s, r) => s + Number(r.grand_total), 0).toFixed(2))
await admin.dispose()
