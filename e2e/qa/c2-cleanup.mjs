import { apiFor, closeBrowser, log, sleep, STORE, WH, TAG } from './lib-wh.mjs'
const a = await apiFor('admin'), w = await apiFor(WH)
const HQ = 'HOU-WH - CCZ'
const MY_SE = []
for (let n = 48; n <= 62; n++) MY_SE.push(`MAT-STE-2026-${String(n).padStart(5, '0')}`)

// ---------- 1. cancel + delete the vendor PO chain (its +3 came from outside the company)
try {
  const pr = await a.doc('Purchase Receipt', 'MAT-PRE-2026-00001')
  await a.post('frappe.client.cancel', { doctype: 'Purchase Receipt', name: pr.name })
  log('cancelled PR', pr.name)
  await a.post('frappe.client.delete', { doctype: 'Purchase Receipt', name: pr.name })
  log('deleted PR')
} catch (e) { log('PR cleanup:', String(e).slice(0, 250)) }
try {
  await a.post('frappe.client.cancel', { doctype: 'Purchase Order', name: 'PUR-ORD-2026-00001' })
  await a.post('frappe.client.delete', { doctype: 'Purchase Order', name: 'PUR-ORD-2026-00001' })
  log('cancelled+deleted PO')
} catch (e) { log('PO cleanup:', String(e).slice(0, 250)) }

// ---------- 2. cancel every still-open shipment of mine
const open = await a.list('AWANZ Shipment', { boutique: STORE, status: ['in', ['Pending', 'Picking', 'Packed', 'Shipped']] }, ['name', 'status', 'material_request'], 100)
for (const s of open) {
  try { await w.post('maison_pos.api.shipping.mark', { shipment: s.name, status: 'Cancelled' }); log('cancelled shipment', s.name, s.status) }
  catch (e) { log('shipment', s.name, 'cancel failed', String(e).slice(0, 200)) }
}
// ---------- 3. cancel the submitted Material Requests that belong to cancelled shipments
const cancelled = await a.list('AWANZ Shipment', { boutique: STORE, status: 'Cancelled' }, ['name', 'material_request'], 100)
for (const s of cancelled) {
  if (!s.material_request) continue
  const mr = await a.value('Material Request', s.material_request, ['docstatus', 'status'])
  if (mr && mr.docstatus === 1 && mr.status !== 'Transferred') {
    try { await a.post('frappe.client.cancel', { doctype: 'Material Request', name: s.material_request }); log('cancelled MR', s.material_request) }
    catch (e) { log('MR', s.material_request, 'cancel failed', String(e).slice(0, 200)) }
  }
}
// ---------- 4. reject every request still pending (this also deletes its draft MR)
const pending = await a.list('AWANZ Replenishment Request', { boutique: STORE, status: 'Pending Approval' }, ['name'], 100)
for (const r of pending) {
  try { await w.post('maison_pos.api.shipping.reject', { request: r.name, reason: `${TAG} QA test request — withdrawn during cleanup` }); log('rejected', r.name) }
  catch (e) { log('reject', r.name, 'failed', String(e).slice(0, 200)) }
}
// ---------- 5. drafts from the cycle count
for (const [dt, name] of [['Stock Reconciliation', 'MAT-RECO-2026-00001'], ['AWANZ Cycle Count', 'MCC-2026-00045'], ['AWANZ Cycle Count', 'MCC-2026-00046']]) {
  try { await a.post('frappe.client.delete', { doctype: dt, name }); log('deleted', dt, name) }
  catch (e) { log('delete', dt, name, String(e).slice(0, 200)) }
}
try { await a.post('frappe.client.delete', { doctype: 'Supplier', name: `${TAG} Test Supplier` }); log('deleted supplier') } catch (e) { log('supplier:', String(e).slice(0, 200)) }

// ---------- 6. net stock delta of every Stock Entry I posted
const net = {}   // item -> warehouse -> qty
for (const v of MY_SE) {
  const rows = await a.list('Stock Ledger Entry', { voucher_no: v, is_cancelled: 0 }, ['item_code', 'warehouse', 'actual_qty'], 200)
  for (const r of rows) {
    net[r.item_code] = net[r.item_code] || {}
    net[r.item_code][r.warehouse] = (net[r.item_code][r.warehouse] || 0) + Number(r.actual_qty)
  }
}
const moves = []   // {from, to, item, qty}
for (const [item, whs] of Object.entries(net)) {
  const total = Object.values(whs).reduce((s, v) => s + v, 0)
  const surplus = Object.entries(whs).filter(([, q]) => q > 0.0001)
  const deficit = Object.entries(whs).filter(([, q]) => q < -0.0001)
  if (!surplus.length && !deficit.length) continue
  log(`net ${item}: ${JSON.stringify(whs)} (total ${total})`)
  if (Math.abs(total) > 0.0001) { log(`  !! ${item} does not net to zero across warehouses — skipping automatic reversal`); continue }
  for (const [swh, sq] of surplus) moves.push({ from: swh, to: deficit[0][0], item, qty: sq })
}
log('REVERSAL MOVES ' + JSON.stringify(moves))
const byPair = {}
for (const m of moves) { const k = `${m.from}|${m.to}`; (byPair[k] = byPair[k] || []).push(m) }
for (const [k, list] of Object.entries(byPair)) {
  const [from, to] = k.split('|')
  const doc = {
    doctype: 'Stock Entry', stock_entry_type: 'Material Transfer', purpose: 'Material Transfer', company: 'CloudChaserz',
    from_warehouse: from, to_warehouse: to, docstatus: 1, remarks: `${TAG} QA cleanup — restoring balances`,
    items: list.map(m => ({ item_code: m.item, qty: m.qty, s_warehouse: from, t_warehouse: to })),
  }
  try { const se = await a.post('frappe.client.insert', { doc }); log('reversal', se.name, from, '->', to, JSON.stringify(list.map(m => [m.item, m.qty]))) }
  catch (e) { log('reversal FAILED', from, '->', to, String(e).slice(0, 300)) }
}
await w.dispose(); await a.dispose(); await closeBrowser()
