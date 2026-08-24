import { apiFor, closeBrowser, record, saveResults, log, sleep, STORE, WH } from './lib-wh.mjs'
const a = await apiFor('admin'), w = await apiFor(WH)
const MY = []
for (let n = 48; n <= 64; n++) MY.push(`MAT-STE-2026-${String(n).padStart(5, '0')}`)
const net = {}
for (const v of [...MY, 'MAT-PRE-2026-00001']) {
  const rows = await a.list('Stock Ledger Entry', { voucher_no: v, is_cancelled: 0 }, ['item_code', 'warehouse', 'actual_qty'], 300)
  for (const r of rows) { net[r.item_code] = net[r.item_code] || {}; net[r.item_code][r.warehouse] = (net[r.item_code][r.warehouse] || 0) + Number(r.actual_qty) }
}
const drift = Object.entries(net).flatMap(([i, whs]) => Object.entries(whs).filter(([, q]) => Math.abs(q) > 0.0001).map(([wh, q]) => `${i}@${wh.replace(' - CCZ', '')}=${q > 0 ? '+' : ''}${q}`))
record('every stock movement this QA run posted nets back to zero in every warehouse', drift.length === 0,
  drift.length ? drift.join(', ') : `${MY.length} Stock Entries + 1 cancelled Purchase Receipt, all net 0 per item/warehouse: ${Object.keys(net).join(', ')}`)
const transit = await a.list('Bin', { warehouse: `${STORE} In Transit - CCZ`, actual_qty: ['!=', 0] }, ['item_code', 'actual_qty'], 50)
record('nothing is left stranded in the store\'s In Transit warehouse', transit.length === 0, JSON.stringify(transit))
const dmg = await a.list('Bin', { warehouse: `${STORE} Damaged - CCZ`, actual_qty: ['!=', 0] }, ['item_code', 'actual_qty'], 50)
record('nothing is left in the store\'s Damaged warehouse', dmg.length === 0, JSON.stringify(dmg))
const openSh = await a.list('AWANZ Shipment', { boutique: STORE, status: ['in', ['Pending', 'Picking', 'Packed', 'Shipped']] }, ['name', 'status'], 50)
record('no open shipment is left for the store', openSh.length === 0, JSON.stringify(openSh))
const openReq = await a.list('AWANZ Replenishment Request', { boutique: STORE, status: 'Pending Approval' }, ['name'], 50)
record('no request is left pending approval for the store', openReq.length === 0, JSON.stringify(openReq))
const openD = await a.list('AWANZ Receiving Discrepancy', { status: 'Open' }, ['name', 'boutique'], 50)
record('no discrepancy is left open', openD.length === 0, JSON.stringify(openD))
const openMR = await a.list('Material Request', { set_warehouse: `${STORE} - CCZ`, docstatus: 1, status: ['not in', ['Transferred', 'Stopped', 'Cancelled']] }, ['name', 'status'], 50)
record('no Material Request of mine is left hanging half-open', openMR.length === 0, JSON.stringify(openMR))
// low stock scan one last time
const before = (await a.list('Scheduled Job Log', { scheduled_job_type: 'inventory.low_stock_scan' }, ['name'], 1, 'creation desc'))[0]?.name
await a.post('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify({ name: 'inventory.low_stock_scan' }) })
for (let i = 0; i < 30; i++) { await sleep(1500); const n = (await a.list('Scheduled Job Log', { scheduled_job_type: 'inventory.low_stock_scan' }, ['name'], 1, 'creation desc'))[0]; if (n && n.name !== before) break }
const alerts = await a.list('AWANZ Stock Alert', { status: ['in', ['Open', 'Acknowledged']] }, ['name', 'boutique', 'item_code'], 50)
record('no low-stock alert left open at my store after the final scan', !alerts.some(x => x.boutique === STORE),
  `site-wide open alerts: ${alerts.length} ${JSON.stringify(alerts.map(x => [x.boutique, x.item_code]))}`)
const wall = await w.get('maison_pos.api.shipping.wall')
record('the warehouse wall is back to an empty board', Object.values(wall.counts).every(v => v === 0),
  `counts=${JSON.stringify(wall.counts)} in_transit=${wall.in_transit} open_discrepancies=${wall.open_discrepancies} received_today=${wall.received_today}`)
saveResults('results-c4.json')
await w.dispose(); await a.dispose(); await closeBrowser()
