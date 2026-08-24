import { apiFor, closeBrowser, record, saveResults, log, STORE, STORE2, MGR, MGR2, WH, TAG } from './lib-wh.mjs'
const a = await apiFor('admin'), m = await apiFor(MGR), m2 = await apiFor(MGR2), w = await apiFor(WH)
const SWH = `${STORE} - CCZ`, HQ = 'HOU-WH - CCZ'

// --- side-check for the dropped-field finding
const shipFields = await a.list('AWANZ Shipment', {}, ['name','label_at','tracking_updated_at','approved_at'], 2)
record('control: other v0.6 datetime fields ARE returned by get_all (isolates the *_seen drop)',
  shipFields[0] && 'label_at' in shipFields[0], JSON.stringify(shipFields[0]))

// --- 2.1 one-tap request straight off a low-stock alert
const alerts = await m.get('maison_pos.api.inventory.alerts', { boutique: STORE, status: 'open' })
const alert = alerts.alerts.find(x => x.item_code === 'KRT-001')
record('the low-stock alert is on the manager\'s list to request from', !!alert, JSON.stringify(alert).slice(0, 220))
const one = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, item: 'KRT-001', alert: alert.name, reason: `${TAG} one-tap from low-stock alert` })
const R1 = one.name
record('one-tap "Request from warehouse" on a low-stock alert creates a request', !!R1 && one.request.status === 'Pending Approval',
  `${R1} status=${one.request.status} lines=${JSON.stringify(one.request.lines.map(l => [l.item_code, l.qty]))} priority=${one.request.priority}`)
record('the one-tap quantity defaults to the alert\'s reorder_qty', Number(one.request.lines[0].qty) === Number(alert.reorder_qty),
  `qty=${one.request.lines[0].qty}, alert.reorder_qty=${alert.reorder_qty}`)
record('a request raised from an alert is prioritised "Low stock"', one.request.priority === 'Low stock', `priority=${one.request.priority}`)
record('the request carries a draft Material Request (Material Transfer, HQ -> store)', !!one.material_request,
  JSON.stringify(await a.value('Material Request', one.material_request, ['material_request_type', 'set_from_warehouse', 'set_warehouse', 'docstatus', 'status'])))
const alertAfter = await a.value('AWANZ Stock Alert', alert.name, ['status', 'material_request'])
record('the alert is linked to the Material Request and flipped to Acknowledged', alertAfter.material_request === one.material_request && alertAfter.status === 'Acknowledged', JSON.stringify(alertAfter))
record('on_hand snapshots are captured on the request line', one.request.lines[0].on_hand_store === 2 && one.request.lines[0].on_hand_warehouse > 0,
  `store=${one.request.lines[0].on_hand_store} warehouse=${one.request.lines[0].on_hand_warehouse}`)

// --- 2.2 manual multi-line request with explicit quantities
const two = await m.post('maison_pos.api.inventory.replenish', {
  boutique: STORE, reason: `${TAG} manual multi-line`,
  lines: JSON.stringify([{ item_code: 'HKA-004', qty: 11 }, { item_code: 'ROL-001', qty: 5 }]),
})
const R2 = two.name
record('manual multi-line request with editable quantities', two.request.items === 2 && two.request.units === 16,
  `${R2} ${JSON.stringify(two.request.lines.map(l => [l.item_code, l.qty]))} units=${two.request.units}`)
record('a manual request (no alert) is priority Normal', two.request.priority === 'Normal', `priority=${two.request.priority}`)

// --- 2.3 refusals
const cross = await m.tryPost('maison_pos.api.inventory.replenish', { boutique: STORE2, lines: JSON.stringify([{ item_code: 'ROL-001', qty: 2 }]) })
record('a manager requesting stock for ANOTHER store is refused', !cross.ok && /Permission/i.test(cross.exc || ''), `${cross.status} ${String(cross.exc).slice(0, 200)}`)
const zero = await m.tryPost('maison_pos.api.inventory.replenish', { boutique: STORE, lines: JSON.stringify([{ item_code: 'ROL-001', qty: 0 }]) })
record('a request with qty 0 is rejected ("No valid lines")', !zero.ok, `${zero.status} ${String(zero.exc).slice(0, 160)}`)
const neg = await m.tryPost('maison_pos.api.inventory.replenish', { boutique: STORE, lines: JSON.stringify([{ item_code: 'ROL-001', qty: -3 }]) })
record('a request with a negative qty is rejected', !neg.ok, `${neg.status} ${String(neg.exc).slice(0, 160)}`)
const ghost = await m.tryPost('maison_pos.api.inventory.replenish', { boutique: STORE, lines: JSON.stringify([{ item_code: 'NO-SUCH-ITEM', qty: 2 }]) })
record('a request for a non-existent item is rejected', !ghost.ok, `${ghost.status} ${String(ghost.exc).slice(0, 160)}`)
const empty = await m.tryPost('maison_pos.api.inventory.replenish', { boutique: STORE, lines: JSON.stringify([]) })
record('an empty request is rejected', !empty.ok, `${empty.status} ${String(empty.exc).slice(0, 160)}`)

// --- 2.4 who can see it
const wq = await w.get('maison_pos.api.shipping.requests_list', { status: 'open', limit: 200 })
record('the warehouse admin sees the new requests in the approval queue', wq.requests.some(r => r.name === R1) && wq.requests.some(r => r.name === R2),
  `scope=${wq.scope} open=${wq.count}; mine present: ${wq.requests.filter(r => [R1, R2].includes(r.name)).map(r => `${r.name}/${r.boutique}/${r.priority}`).join(', ')}`)
const mq = await m.get('maison_pos.api.inventory.replenishment_requests', { boutique: STORE, status: 'all' })
record('the store manager sees their own requests on the Receive screen feed', mq.requests.some(r => r.name === R1), `${mq.count} for ${STORE}`)
const m2q = await m2.get('maison_pos.api.shipping.requests_list', { status: 'all', limit: 200 })
record('another store\'s manager cannot see my store\'s requests', !m2q.requests.some(r => [R1, R2].includes(r.name)),
  `${STORE2} manager sees ${m2q.count} requests, scope=${m2q.scope}`)
const m2d = await m2.tryGet('maison_pos.api.shipping.request_detail', { request: R1 })
record('another store\'s manager cannot open my request by name', !m2d.ok, `${m2d.status} ${String(m2d.exc).slice(0, 160)}`)
// wall column
const wall = await w.get('maison_pos.api.shipping.wall')
record('the request lands in the wall\'s "pending_approval" column', wall.columns.pending_approval.some(r => r.name === R1),
  `pending_approval=${wall.counts.pending_approval} names=${wall.columns.pending_approval.map(r => r.name).join(',')}`)
record('the wall card for a request carries an age timer', typeof wall.columns.pending_approval.find(r => r.name === R1)?.age_seconds === 'number',
  `age_seconds=${wall.columns.pending_approval.find(r => r.name === R1)?.age_seconds}`)

// --- 2.5 a store manager must not approve
const selfApprove = await m.tryPost('maison_pos.api.shipping.approve', { request: R1 })
record('a store manager may NOT approve their own request', !selfApprove.ok, `${selfApprove.status} ${String(selfApprove.exc).slice(0, 200)}`)
const selfReject = await m.tryPost('maison_pos.api.shipping.reject', { request: R1, reason: 'nope' })
record('a store manager may NOT reject a request', !selfReject.ok, `${selfReject.status} ${String(selfReject.exc).slice(0, 200)}`)

log(`\nCREATED  R1=${R1}  R2=${R2}`)
await Promise.all([m.dispose(), m2.dispose(), w.dispose()])
saveResults('results-w2.json')
await a.dispose(); await closeBrowser()
