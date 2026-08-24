import * as L from './lib-pos.mjs'
const admin = await L.adminApi()
const names = []
for (let i = 3075; i >= 3047; i--) names.push(`ACC-SINV-2026-0${i}`)
const out = []
for (const n of names) {
  try {
    const v = await admin.value('Sales Invoice', n, ['docstatus', 'maison_boutique', 'maison_associate'])
    if (!v || v.docstatus === undefined) { out.push([n, 'missing']); continue }
    if (v.maison_boutique !== 'HOU-MTR' || !String(v.maison_associate || '').startsWith('hou.mtr.a1')) { out.push([n, 'NOT MINE - skipped', JSON.stringify(v)]); continue }
    if (Number(v.docstatus) !== 1) { out.push([n, 'docstatus ' + v.docstatus + ' - skipped']); continue }
    await admin.post('frappe.client.cancel', { doctype: 'Sales Invoice', name: n })
    out.push([n, 'cancelled'])
  } catch (e) { out.push([n, 'ERROR ' + String(e.message).slice(0, 160)]) }
}
for (const r of out) console.log(r.join(' | '))
await admin.dispose()
