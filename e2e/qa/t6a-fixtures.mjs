import { apiFor, closeBrowser, log, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin'), m = await apiFor(MGR), w = await apiFor(WH)
const set = (dt, name, fieldname, value) => a.post('frappe.client.set_value', { doctype: dt, name, fieldname, value })
const hoursAgo = (h) => { const d = new Date(Date.now() - h * 3600e3 - 5 * 3600e3); return d.toISOString().slice(0, 19).replace('T', ' ') }
const out = { ...S }

// pending_approval: one warn-aged (5h) normal, one crit-aged (30h) urgent
const rW = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} wall warn-age`, lines: JSON.stringify([{ item_code: 'ROL-002', qty: 3 }]) })
await set('Maison Replenishment Request', rW.name, 'requested_at', hoursAgo(5))
const rC = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} wall crit-age urgent`, priority: 'Urgent', lines: JSON.stringify([{ item_code: 'ACC-001', qty: 4 }]) })
await set('Maison Replenishment Request', rC.name, 'requested_at', hoursAgo(30))
out.RW = rW.name; out.RC = rC.name

// to_pick (Pending, warn-aged), packing (Packed no label), ready (Packed + label)
const mk = async (item, qty, reason) => {
  const r = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} ${reason}`, lines: JSON.stringify([{ item_code: item, qty }]) })
  const ap = await w.post('maison_pos.api.shipping.approve', { request: r.name })
  return { req: r.name, mr: ap.request.material_request, ship: ap.shipment.name }
}
const toPick = await mk('ROL-006', 2, 'wall to_pick')
await set('Maison Shipment', toPick.ship, 'approved_at', hoursAgo(6))
const packing = await mk('ACC-002', 2, 'wall packing')
await w.post('maison_pos.api.shipping.pick', { shipment: packing.ship })
await w.post('maison_pos.api.shipping.pack', { shipment: packing.ship })
const ready = await mk('ROL-001', 2, 'wall ready')
await w.post('maison_pos.api.shipping.pick', { shipment: ready.ship })
await w.post('maison_pos.api.shipping.pack', { shipment: ready.ship })
await w.post('maison_pos.api.shipping.buy', { shipment: ready.ship, prefer: 'cheapest' })
out.toPick = toPick; out.packing = packing; out.ready = ready

// a request left Pending Approval for the UI approval test (drives realtime + auto-print)
const rUI = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} approve via the desk UI`, lines: JSON.stringify([{ item_code: 'ROL-002', qty: 6 }]) })
out.RUI = rUI.name
log('fixtures ' + JSON.stringify(out, null, 1))
const wall = await w.get('maison_pos.api.shipping.wall')
log('wall counts now ' + JSON.stringify(wall.counts))
for (const [k, v] of Object.entries(wall.columns)) log(`  ${k}: ` + v.map(c => `${c.name}/${c.priority}/${Math.round(c.age_seconds / 3600)}h`).join(' '))
writeFileSync('/home/claude/maison/e2e/qa/state.json', JSON.stringify(out, null, 1))
await Promise.all([m.dispose(), w.dispose()]); await a.dispose(); await closeBrowser()
