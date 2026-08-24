import { apiFor, closeBrowser, record, saveResults, log, STORE, STORE2, MGR, MGR2, TAG } from './lib-wh.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin'), m = await apiFor(MGR), m2 = await apiFor(MGR2)
const SWH = `${STORE} - CCZ`
const created = []

const exp = await m.get('maison_pos.api.inventory.cycle_count_expected', { boutique: STORE })
const qtyItems = Object.entries(exp.qty)
const serialItems = Object.entries(exp.serials)
record('cycle count "expected" returns the store warehouse, serials and quantities', exp.warehouse === SWH && qtyItems.length > 0,
  `warehouse=${exp.warehouse}; ${qtyItems.length} qty items, ${serialItems.length} serialised items (${serialItems.reduce((n, [, l]) => n + l.length, 0)} serials); as_of=${exp.as_of}`)
record('another store\'s manager cannot read my expected counts', !(await m2.tryGet('maison_pos.api.inventory.cycle_count_expected', { boutique: STORE })).ok, 'cross-store expected -> refused')

// ---- a clean count (scan everything exactly as expected)
const clean = await m.post('maison_pos.api.inventory.submit_cycle_count', {
  boutique: STORE, device_id: `${TAG}-dev`, notes: `${TAG} clean count`,
  serials: JSON.stringify(serialItems.flatMap(([, l]) => l)),
  qty: JSON.stringify(Object.fromEntries(qtyItems)),
})
created.push(clean.cycle_count)
record('a count that matches the warehouse is clean and creates NO stock reconciliation',
  clean.clean === true && !clean.stock_reconciliation && clean.qty_differences.length === 0 && clean.missing.length === 0,
  `${clean.cycle_count}: clean=${clean.clean} diffs=${clean.qty_differences.length} missing=${clean.missing.length} unexpected=${clean.unexpected.length} recon=${clean.stock_reconciliation}`)

// ---- a count with variances
const [i1, e1] = qtyItems[0], [i2, e2] = qtyItems[1]
const missSerial = serialItems[0]?.[1]?.[0] || null
const counts = Object.fromEntries(qtyItems)
counts[i1] = e1 - 2      // shrinkage
counts[i2] = e2 + 1      // found extra
const scanned = serialItems.flatMap(([, l]) => l).filter(s => s !== missSerial)
const varc = await m.post('maison_pos.api.inventory.submit_cycle_count', {
  boutique: STORE, device_id: `${TAG}-dev`, notes: `${TAG} variance count`,
  serials: JSON.stringify([...scanned, 'QA2-NOT-A-REAL-SERIAL']),
  qty: JSON.stringify(counts),
})
created.push(varc.cycle_count)
const d1 = varc.qty_differences.find(d => d.item_code === i1), d2 = varc.qty_differences.find(d => d.item_code === i2)
record('the count reports the variance per item (expected vs counted vs diff)',
  d1 && d1.diff === -2 && d2 && d2.diff === 1,
  `${i1}: expected ${d1?.expected} counted ${d1?.counted} diff ${d1?.diff}; ${i2}: expected ${d2?.expected} counted ${d2?.counted} diff ${d2?.diff}`)
record('a serial that was not scanned is reported as missing', missSerial ? varc.missing.some(x => x.serial_no === missSerial) : varc.missing.length === 0,
  `missing=${JSON.stringify(varc.missing.slice(0, 3))} (expected ${missSerial})`)
record('a scanned serial that does not belong here is reported as unexpected',
  varc.unexpected.some(x => x.serial_no === 'QA2-NOT-A-REAL-SERIAL' && x.status === 'not_found'), JSON.stringify(varc.unexpected.slice(0, 3)))
record('the count is stored as a Maison Cycle Count in Draft', true,
  JSON.stringify(await a.value('Maison Cycle Count', varc.cycle_count, ['status', 'boutique', 'warehouse', 'expected_serials', 'scanned_serials', 'device_id', 'stock_reconciliation'])))

// ---- the draft Stock Reconciliation
const sr = varc.stock_reconciliation
record('a DRAFT Stock Reconciliation is raised for the quantity variances', !!sr, `${sr}`)
if (sr) {
  const srDoc = await a.doc('Stock Reconciliation', sr)
  created.push(sr)
  record('the reconciliation is left unsubmitted so a manager has to approve it (docstatus 0)', srDoc.docstatus === 0,
    `${sr} docstatus=${srDoc.docstatus} purpose=${srDoc.purpose} warehouse=${srDoc.set_warehouse} owner=${srDoc.owner}`)
  record('the reconciliation carries exactly the counted quantities of the varying items',
    srDoc.items.length === varc.qty_differences.length && srDoc.items.every(it => varc.qty_differences.some(d => d.item_code === it.item_code && Number(d.counted) === Number(it.qty))),
    JSON.stringify(srDoc.items.map(it => [it.item_code, it.qty, it.warehouse])))
  record('the reconciliation is attributed to the counting user, not to a system account', srDoc.owner === MGR.usr, `owner=${srDoc.owner}`)
  const bin = Number((await a.list('Bin', { item_code: i1, warehouse: SWH }, ['actual_qty']))[0]?.actual_qty || 0)
  record('the draft posts NO stock until it is submitted', bin === e1, `${i1} on hand still ${bin} (counted ${counts[i1]}, expected ${e1})`)
  const cc = await a.value('Maison Cycle Count', varc.cycle_count, ['stock_reconciliation'])
  record('the cycle count links its reconciliation for the desk review', cc.stock_reconciliation === sr, JSON.stringify(cc))
}
// scoping
const cross = await m2.tryPost('maison_pos.api.inventory.submit_cycle_count', { boutique: STORE, qty: JSON.stringify({ [i1]: 1 }) })
record('another store\'s manager cannot submit a count against my store', !cross.ok, `${cross.status} ${String(cross.exc).slice(0, 150)}`)

writeFileSync('/home/claude/maison/e2e/qa/state.json', JSON.stringify({ ...S, cycleCounts: created }, null, 1))
log('CREATED ' + JSON.stringify(created))
await m.dispose(); await m2.dispose()
saveResults('results-w8.json')
await a.dispose(); await closeBrowser()
