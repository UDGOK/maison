import * as L from './lib-pos.mjs'
const mgr = await L.userApi(L.MGR)
for (const n of ['ACC-SINV-2026-03065', 'ACC-SINV-2026-03068']) {
  try {
    const r = await mgr.post('maison_pos.api.sales.void', { invoice: n, reason: 'QA1 POS test cleanup' })
    console.log(n, 'voided ->', JSON.stringify(r))
  } catch (e) { console.log(n, 'ERR', String(e.message).slice(0, 250)) }
}
await mgr.dispose()
const admin = await L.adminApi()
const rows = await admin.list('Sales Invoice', { name: ['>=', 'ACC-SINV-2026-03047'] }, ['name', 'docstatus', 'grand_total', 'maison_boutique', 'is_return'], 60, 'name asc')
let net = 0
for (const r of rows) if (r.maison_boutique === 'HOU-MTR' && Number(r.docstatus) === 1) net += Number(r.grand_total)
console.log('remaining submitted HOU-MTR invoices from my run:')
for (const r of rows) if (r.maison_boutique === 'HOU-MTR' && Number(r.docstatus) === 1) console.log(' ', r.name, r.grand_total, r.is_return ? '(credit note)' : '')
console.log('net residual $', net.toFixed(2))
await admin.dispose()
