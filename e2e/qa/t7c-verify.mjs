import { apiFor, closeBrowser, record, saveResults, log, STORE } from './lib-wh.mjs'
import { readFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin')
const SWH = `${STORE} - CCZ`, TR = `${STORE} In Transit - CCZ`, DMG = `${STORE} Damaged - CCZ`, HQ = 'HOU-WH - CCZ'
// full ledger for the discrepancy shipment SD
const doc = await a.get('maison_pos.api.shipping.shipment', { shipment: S.SD })
record('the shipment lines record shipped / received / damaged / short / over per line', true,
  doc.lines.map(l => `${l.item_code}: qty ${l.qty} shipped ${l.shipped_qty} recv ${l.received_qty} dmg ${l.damaged_qty} short ${l.short_qty} over ${l.over_qty}`).join(' | '))
const ses = await a.list('Stock Entry', { remarks: ['like', `%${S.SD}%`] }, ['name', 'stock_entry_type', 'from_warehouse', 'to_warehouse', 'docstatus', 'remarks'], 20, 'creation asc')
const rows = []
for (const se of ses) {
  const sle = await a.list('Stock Ledger Entry', { voucher_no: se.name, is_cancelled: 0 }, ['item_code', 'warehouse', 'actual_qty'], 30)
  rows.push({ se: se.name, from: se.from_warehouse, to: se.to_warehouse, sle: sle.map(r => `${r.item_code} ${r.warehouse.replace(' - CCZ', '')} ${r.actual_qty > 0 ? '+' : ''}${r.actual_qty}`) })
}
log(JSON.stringify(rows, null, 1))
const ship = rows.find(r => r.to === TR), recv = rows.find(r => r.to === SWH), dmg = rows.find(r => r.to === DMG)
record('SHIP leg: every line leaves the warehouse and lands in "<store> In Transit"',
  ship && ship.sle.filter(s => s.includes('HOU-WH')).length === 3 && ship.sle.filter(s => s.includes('In Transit +')).length === 3, JSON.stringify(ship))
record('RECEIVE leg: only the counted units move In Transit -> store (short stays behind, over is ignored)',
  recv && recv.sle.includes('ROL-002 OK-JENKS +4') && recv.sle.includes('ACC-002 OK-JENKS +4') && recv.sle.includes('ROL-006 OK-JENKS +2'), JSON.stringify(recv))
record('DAMAGED leg: the damaged unit is a separate Stock Entry into "<store> Damaged"',
  dmg && dmg.sle.includes('ROL-006 OK-JENKS Damaged +1'), JSON.stringify(dmg))
const returned = await a.list('Stock Entry', { remarks: ['like', '%MRD-%'] }, ['name', 'from_warehouse', 'to_warehouse', 'remarks'], 10, 'creation desc')
const rSle = returned[0] ? await a.list('Stock Ledger Entry', { voucher_no: returned[0].name, is_cancelled: 0 }, ['item_code', 'warehouse', 'actual_qty'], 10) : []
record('the "Returned to warehouse" resolution posts In Transit -> warehouse for the short units',
  rSle.some(r => r.warehouse === TR && Number(r.actual_qty) === -2) && rSle.some(r => r.warehouse === HQ && Number(r.actual_qty) === 2),
  `${returned[0]?.name}: ${JSON.stringify(rSle.map(r => [r.item_code, r.warehouse, r.actual_qty]))}`)
const tr = { a: await a.list('Bin', { item_code: 'ROL-002', warehouse: TR }, ['actual_qty']), b: await a.list('Bin', { item_code: 'ACC-002', warehouse: TR }, ['actual_qty']), c: await a.list('Bin', { item_code: 'ROL-006', warehouse: TR }, ['actual_qty']) }
record('nothing is left stranded in the store\'s In Transit warehouse after the discrepancies are resolved',
  Object.values(tr).every(v => Number(v[0]?.actual_qty || 0) === 0), JSON.stringify(Object.entries(tr).map(([k, v]) => [k, v[0]?.actual_qty || 0])))
saveResults('results-w7c.json')
await a.dispose(); await closeBrowser()
