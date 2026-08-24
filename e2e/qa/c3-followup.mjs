import { apiFor, closeBrowser, record, saveResults, log, STORE, WH, TAG } from './lib-wh.mjs'
const a = await apiFor('admin'), w = await apiFor(WH)

// ---- reproduce + document the reject-from-alert failure
const req = 'MRR-2026-00043'
const before = await a.value('Maison Replenishment Request', req, ['status', 'material_request'])
const alert = (await a.list('Maison Stock Alert', { material_request: before.material_request }, ['name', 'item_code', 'status', 'material_request'], 5))[0]
const r = await w.tryPost('maison_pos.api.shipping.reject', { request: req, reason: `${TAG} reproducing the reject bug` })
const after = await a.value('Maison Replenishment Request', req, ['status', 'material_request', 'rejection_reason'])
record('BUG: a request raised by one-tap from a low-stock alert CANNOT be rejected', !r.ok,
  `${req} (from alert ${alert?.name}, ${alert?.item_code}) -> reject returns ${r.status} ${String(r.exc).slice(0, 240)}; request stays ${JSON.stringify(after)} (was ${JSON.stringify(before)}); the alert still points at ${alert?.material_request}. shipping.py reject() deletes the draft Material Request BEFORE clearing Maison Stock Alert.material_request, so the delete hits LinkExistsError.`,
  'high')
// the workaround a human would have to apply
await a.post('frappe.client.set_value', { doctype: 'Maison Stock Alert', name: alert.name, fieldname: 'material_request', value: '' })
const r2 = await w.tryPost('maison_pos.api.shipping.reject', { request: req, reason: `${TAG} QA test request — withdrawn during cleanup` })
record('...and it can only be rejected after the alert link is cleared by hand (proves the cause)', r2.ok,
  `after clearing Maison Stock Alert.material_request on ${alert.name}: reject -> ${r2.ok ? 'Rejected' : String(r2.exc).slice(0, 200)}`, 'high')

// ---- remaining cleanup
for (const [dt, name] of [['Stock Reconciliation', 'MAT-RECO-2026-00001']]) {
  try { await a.post('frappe.client.delete', { doctype: dt, name }); log('deleted', dt, name) } catch (e) { log('delete', dt, name, String(e).slice(0, 200)) }
}
const po = await a.value('Purchase Order', 'PUR-ORD-2026-00001', ['docstatus', 'status', 'per_received'])
log('PO now', JSON.stringify(po))
if (po.docstatus === 1) {
  try { await a.post('frappe.client.cancel', { doctype: 'Purchase Order', name: 'PUR-ORD-2026-00001' }); log('cancelled PO') }
  catch (e) {
    log('PO cancel failed:', String(e).slice(0, 300))
    try { await a.post('erpnext.buying.doctype.purchase_order.purchase_order.update_status', { status: 'Closed', name: 'PUR-ORD-2026-00001' }); log('closed PO instead') }
    catch (e2) { log('PO close failed:', String(e2).slice(0, 200)) }
  }
}
try { await a.post('frappe.client.set_value', { doctype: 'Supplier', name: `${TAG} Test Supplier`, fieldname: 'disabled', value: 1 }); log('disabled supplier') } catch (e) { log('supplier disable:', String(e).slice(0, 200)) }
saveResults('results-c3.json')
await w.dispose(); await a.dispose(); await closeBrowser()
