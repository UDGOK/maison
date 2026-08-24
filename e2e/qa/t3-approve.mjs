import { apiFor, closeBrowser, record, saveResults, log, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { writeFileSync } from 'node:fs'
const a = await apiFor('admin'), m = await apiFor(MGR), w = await apiFor(WH)
const R1 = process.env.R1, R2 = process.env.R2
const state = {}

// ---- 3.1 approve with EDITED quantities (one line raised, one line zeroed)
const d1 = await w.get('maison_pos.api.shipping.request_detail', { request: R1 })
const ap1 = await w.post('maison_pos.api.shipping.approve', { request: R1, lines: JSON.stringify([{ item_code: 'KRT-001', approved_qty: 10 }]), notes: `${TAG} approved with edited qty` })
state.S1 = ap1.shipment.name
record('warehouse admin approves a request with an edited quantity', ap1.request.status === 'Approved' && ap1.shipment.status === 'Pending',
  `${R1} ${d1.status}->${ap1.request.status}; shipment ${state.S1} ${ap1.shipment.status}`)
record('the shipment carries the EDITED quantity, not the requested one', Number(ap1.shipment.lines[0].qty) === 10,
  `requested ${d1.lines[0].qty} -> approved ${ap1.request.lines[0].approved_qty} -> shipment ${JSON.stringify(ap1.shipment.lines.map(l => [l.item_code, l.qty]))}`)
const mr1 = await a.value('Material Request', ap1.request.material_request, ['docstatus', 'status', 'per_ordered'])
const mrItems1 = await a.get('frappe.client.get_list', { doctype: 'Material Request Item', parent: 'Material Request', filters: JSON.stringify({ parent: ap1.request.material_request }), fields: JSON.stringify(['item_code', 'qty']), limit_page_length: 20 })
record('the linked Material Request is submitted with the approved quantities', mr1.docstatus === 1 && Number(mrItems1[0].qty) === 10,
  `${ap1.request.material_request} docstatus=${mr1.docstatus} status=${mr1.status} items=${JSON.stringify(mrItems1)}`)
record('the shipment is wired to the request / MR / transit warehouse', ap1.shipment.replenishment_request === R1 && !!ap1.shipment.transit_warehouse,
  `req=${ap1.shipment.replenishment_request} mr=${ap1.shipment.material_request} from=${ap1.shipment.from_warehouse} transit=${ap1.shipment.transit_warehouse} to=${ap1.shipment.to_warehouse}`)
record('the request records approved_by / approved_at and links the shipment', !!ap1.request.approved_by && !!ap1.request.approved_at,
  JSON.stringify(await a.value('Maison Replenishment Request', R1, ['status', 'approved_by', 'approved_at', 'shipment'])))
const nl1 = await a.list('Notification Log', { document_type: 'Maison Shipment', document_name: state.S1 }, ['for_user', 'subject'], 10)
record('the store manager is notified that the request was approved', nl1.length > 0, JSON.stringify(nl1).slice(0, 300))

// ---- 3.2 approving twice
const twice = await w.tryPost('maison_pos.api.shipping.approve', { request: R1, lines: JSON.stringify([{ item_code: 'KRT-001', approved_qty: 3 }]) })
const shipCount = (await a.list('Maison Shipment', { replenishment_request: R1 }, ['name'], 10)).length
record('approving an already-approved request is refused and creates no second shipment', !twice.ok && shipCount === 1,
  `${twice.status} ${String(twice.exc).slice(0, 150)}; shipments for ${R1}: ${shipCount}`)
const rejAfter = await w.tryPost('maison_pos.api.shipping.reject', { request: R1, reason: 'too late' })
record('rejecting an already-approved request is refused', !rejAfter.ok, `${rejAfter.status} ${String(rejAfter.exc).slice(0, 150)}`)

// ---- 3.3 approve with a line zeroed out
const ap2 = await w.post('maison_pos.api.shipping.approve', { request: R2, lines: JSON.stringify([{ item_code: 'HKA-004', approved_qty: 11 }, { item_code: 'ROL-001', approved_qty: 0 }]) })
state.S2 = ap2.shipment.name
record('a line approved at 0 is dropped from the shipment', ap2.shipment.lines.length === 1 && ap2.shipment.lines[0].item_code === 'HKA-004',
  `request lines=${JSON.stringify(ap2.request.lines.map(l => [l.item_code, l.qty, l.approved_qty]))} shipment lines=${JSON.stringify(ap2.shipment.lines.map(l => [l.item_code, l.qty]))}`)
const mrItems2 = await a.get('frappe.client.get_list', { doctype: 'Material Request Item', parent: 'Material Request', filters: JSON.stringify({ parent: ap2.request.material_request }), fields: JSON.stringify(['item_code', 'qty']), limit_page_length: 20 })
record('the zeroed line is removed from the submitted Material Request too', mrItems2.length === 1 && mrItems2[0].item_code === 'HKA-004', JSON.stringify(mrItems2))

// ---- 3.4 reject with a reason
const r3 = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} to be rejected`, lines: JSON.stringify([{ item_code: 'ROL-006', qty: 7 }]) })
state.R3 = r3.name
const noReason = await w.tryPost('maison_pos.api.shipping.reject', { request: state.R3, reason: '   ' })
record('rejecting without a reason is refused', !noReason.ok, `${noReason.status} ${String(noReason.exc).slice(0, 150)}`)
const rej = await w.post('maison_pos.api.shipping.reject', { request: state.R3, reason: `${TAG} discontinued — order the 20K instead` })
record('warehouse admin rejects a request with a reason', rej.request.status === 'Rejected' && /discontinued/.test(rej.request.rejection_reason || ''),
  `${state.R3} -> ${rej.request.status}: "${rej.request.rejection_reason}"`)
record('rejecting deletes the draft Material Request (nothing left half-open)', !rej.request.material_request,
  `material_request=${rej.request.material_request}; MR ${r3.material_request} exists=${(await a.list('Material Request', { name: r3.material_request }, ['name'], 2)).length}`)
const nl3 = await a.list('Notification Log', { document_type: 'Maison Replenishment Request', document_name: state.R3 }, ['for_user', 'subject'], 10)
record('the store manager is notified of the rejection, with the reason', nl3.some(n => n.for_user === MGR.usr) && /discontinued/.test(nl3[0]?.subject || ''),
  JSON.stringify(nl3).slice(0, 300))
const noShip = await a.list('Maison Shipment', { replenishment_request: state.R3 }, ['name'], 5)
record('a rejected request creates no shipment', noShip.length === 0, `${noShip.length} shipments`)
const mgrSees = (await m.get('maison_pos.api.inventory.replenishment_requests', { boutique: STORE, status: 'all' })).requests.find(r => r.name === state.R3)
record('the rejected request shows on the store\'s Receive feed with the reason', mgrSees?.status === 'Rejected' && !!mgrSees?.rejection_reason,
  `${mgrSees?.status} "${mgrSees?.rejection_reason}"`)

// ---- 3.5 approve a request the warehouse cannot cover
const stock = await w.get('maison_pos.api.shipping.warehouse_stock', { limit: 5000 })
const scarce = stock.rows.filter(r => r.actual_qty > 0 && r.actual_qty <= 12).sort((x, y) => x.actual_qty - y.actual_qty)[0]
  || stock.rows.sort((x, y) => x.actual_qty - y.actual_qty)[0]
state.scarce = scarce
const over = Math.round(scarce.actual_qty) + 25
const r5 = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} more than HQ holds`, lines: JSON.stringify([{ item_code: scarce.item_code, qty: over }]) })
state.R5 = r5.name
const ap5 = await w.tryPost('maison_pos.api.shipping.approve', { request: state.R5 })
state.S5 = ap5.ok ? ap5.message.shipment.name : null
record('approving MORE than the warehouse holds is accepted (no stock check at approval)', ap5.ok,
  `${scarce.item_code}: HQ has ${scarce.actual_qty}, approved ${over} -> ${state.S5 || String(ap5.exc).slice(0, 160)}`, 'observation')
record('the request line shows the warehouse on-hand so the admin can see the shortfall',
  Number(r5.request.lines[0].on_hand_warehouse) === Number(scarce.actual_qty),
  `line.on_hand_warehouse=${r5.request.lines[0].on_hand_warehouse} vs Bin ${scarce.actual_qty}`)

writeFileSync('/home/claude/maison/e2e/qa/state.json', JSON.stringify({ R1, R2, ...state }, null, 1))
log('\nSTATE ' + JSON.stringify(state))
await Promise.all([m.dispose(), w.dispose()])
saveResults('results-w3.json')
await a.dispose(); await closeBrowser()
