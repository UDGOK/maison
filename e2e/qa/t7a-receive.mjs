import { apiFor, closeBrowser, record, saveResults, log, STORE, STORE2, MGR, MGR2, WH, TAG } from './lib-wh.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin'), m = await apiFor(MGR), m2 = await apiFor(MGR2), w = await apiFor(WH)
const HQ = 'HOU-WH - CCZ', SWH = `${STORE} - CCZ`, TR = `${STORE} In Transit - CCZ`, DMG = `${STORE} Damaged - CCZ`
const bin = async (i, wh) => Number((await a.list('Bin', { item_code: i, warehouse: wh }, ['actual_qty']))[0]?.actual_qty || 0)
const all = async (i) => ({ hq: await bin(i, HQ), tr: await bin(i, TR), st: await bin(i, SWH), dmg: await bin(i, DMG) })

// ================= 7.1 partial receipt then completion (S2, HKA-004 x11)
const ITEM = 'HKA-004'
const p0 = await all(ITEM)
const part = await m.post('maison_pos.api.inventory.receive_shipment', { shipment: S.S2, final: 0, lines: JSON.stringify([{ item_code: ITEM, received_qty: 5 }]), notes: `${TAG} partial count` })
const p1 = await all(ITEM)
record('a PARTIAL receipt posts only what was counted and keeps the shipment in transit',
  part.status === 'Shipped' && part.final === false && p1.st === p0.st + 5 && p1.tr === p0.tr - 5,
  `status=${part.status} final=${part.final}; ${STORE} ${p0.st}->${p1.st}, transit ${p0.tr}->${p1.tr}; SE=${part.stock_entry_receive}`)
record('a partial receipt raises no Short discrepancy (the rest is still on the road)', (part.discrepancies || []).length === 0, JSON.stringify(part.discrepancies))
const inb = await m.get('maison_pos.api.inventory.inbound', { boutique: STORE })
record('the store still sees the shipment as inbound, with the already-received count',
  inb.shipments.some(s => s.name === S.S2 && s.units_received === 5), JSON.stringify(inb.shipments.map(s => [s.name, s.units, s.units_received])))
const fin = await m.post('maison_pos.api.inventory.receive_shipment', { shipment: S.S2, final: 1, notes: `${TAG} completing the count` })
const p2 = await all(ITEM)
record('completing the receipt posts the remainder and closes the shipment',
  fin.status === 'Received' && p2.st === p0.st + 11 && p2.tr === p0.tr, `status=${fin.status}; ${STORE} ${p0.st}->${p2.st}, transit ${p2.tr}; SE=${fin.stock_entry_receive}`)
record('no discrepancy after a complete two-stage receipt', (fin.discrepancies || []).length === 0, JSON.stringify(fin.discrepancies))
record('OBSERVATION: only the LAST receipt Stock Entry is linked on the shipment', true,
  `stock_entry_receive=${(await a.value('Maison Shipment', S.S2, ['stock_entry_receive'])).stock_entry_receive} (first leg ${part.stock_entry_receive} is not linked; see api/inventory.py receive_shipment)`, 'observation')
record('HKA-004 is back above its reorder level at the store', p2.st === 14, `${STORE} ${ITEM} = ${p2.st} (level 4)`)

// ================= 7.2 over / short / damaged in one receipt
const r = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} discrepancy matrix`, lines: JSON.stringify([{ item_code: 'ROL-002', qty: 6 }, { item_code: 'ACC-002', qty: 4 }, { item_code: 'ROL-006', qty: 3 }]) })
const ap = await w.post('maison_pos.api.shipping.approve', { request: r.name })
const SD = ap.shipment.name
await w.post('maison_pos.api.shipping.pick', { shipment: SD })
await w.post('maison_pos.api.shipping.pack', { shipment: SD })
await w.post('maison_pos.api.shipping.buy', { shipment: SD, prefer: 'cheapest' })
await w.post('maison_pos.api.shipping.ship', { shipment: SD })
const d0 = { a: await all('ROL-002'), b: await all('ACC-002'), c: await all('ROL-006') }
const neg = await m.tryPost('maison_pos.api.inventory.receive_shipment', { shipment: SD, final: 1, lines: JSON.stringify([{ item_code: 'ROL-002', received_qty: -2 }]) })
record('a negative counted quantity is refused', !neg.ok, `${neg.status} ${String(neg.exc).slice(0, 150)}`)
const cross = await m2.tryPost('maison_pos.api.inventory.receive_shipment', { shipment: SD, final: 1 })
record('another store\'s manager cannot receive my shipment', !cross.ok && /Permission/i.test(cross.exc || ''), `${cross.status} ${String(cross.exc).slice(0, 160)}`)
const rec = await m.post('maison_pos.api.inventory.receive_shipment', {
  shipment: SD, final: 1, notes: `${TAG} 2 short, 1 over, 1 damaged`,
  lines: JSON.stringify([{ item_code: 'ROL-002', received_qty: 4 }, { item_code: 'ACC-002', received_qty: 5 }, { item_code: 'ROL-006', received_qty: 2, damaged_qty: 1 }]),
})
const d1 = { a: await all('ROL-002'), b: await all('ACC-002'), c: await all('ROL-006') }
record('a SHORT line posts only what arrived and leaves the rest in transit', d1.a.st === d0.a.st + 4 && d1.a.tr === d0.a.tr + 2,
  `ROL-002 shipped 6 counted 4: store ${d0.a.st}->${d1.a.st}, transit ${d0.a.tr}->${d1.a.tr}`)
record('an OVER line only moves what was actually in transit (no phantom stock)', d1.b.st === d0.b.st + 4 && d1.b.tr === d0.b.tr,
  `ACC-002 shipped 4 counted 5: store ${d0.b.st}->${d1.b.st}, transit ${d1.b.tr}`)
record('a DAMAGED line is posted into the store\'s Damaged warehouse, not sellable stock', d1.c.st === d0.c.st + 2 && d1.c.dmg === d0.c.dmg + 1,
  `ROL-006 shipped 3 counted 2 + 1 damaged: store ${d0.c.st}->${d1.c.st}, damaged ${d0.c.dmg}->${d1.c.dmg}; SE=${rec.stock_entry_damaged}`)
const discs = await w.get('maison_pos.api.shipping.discrepancies', { status: 'Open', boutique: STORE })
const mineD = discs.discrepancies.filter(d => d.shipment === SD)
record('one Maison Receiving Discrepancy per problem line, visible to the warehouse admin', mineD.length === 3,
  mineD.map(d => `${d.name} ${d.item_code} ${d.type} short=${d.short_qty} over=${d.over_qty} dmg=${d.damaged_qty}`).join(' | '))
record('the discrepancy types are Short / Over / Damaged as counted', ['Short', 'Over', 'Damaged'].every(t => mineD.some(d => d.type === t)),
  JSON.stringify(mineD.map(d => [d.item_code, d.type])))
const nlD = await a.list('Notification Log', { document_type: 'Maison Receiving Discrepancy' }, ['for_user', 'subject'], 5, 'creation desc')
record('the warehouse admin is notified of the discrepancies', nlD.some(n => /discrepanc/i.test(n.subject || '')), JSON.stringify(nlD.slice(0, 2)))
const mDisc = await m.get('maison_pos.api.shipping.discrepancies', { status: 'all' })
record('the store sees only its own discrepancies', mDisc.discrepancies.every(d => d.boutique === STORE), `${mDisc.count} rows, boutiques=${[...new Set(mDisc.discrepancies.map(d => d.boutique))].join(',')}`)
const m2Disc = await m2.get('maison_pos.api.shipping.discrepancies', { status: 'all' })
record('another store sees none of my discrepancies', !m2Disc.discrepancies.some(d => d.shipment === SD), `${STORE2} sees ${m2Disc.count}`)

// ================= 7.3 resolve the discrepancies
const shortD = mineD.find(d => d.type === 'Short')
const badRes = await w.tryPost('maison_pos.api.shipping.resolve_discrepancy', { discrepancy: shortD.name, resolution: 'Shrug' })
record('an unknown resolution is refused', !badRes.ok, `${badRes.status} ${String(badRes.exc).slice(0, 140)}`)
const mgrRes = await m.tryPost('maison_pos.api.shipping.resolve_discrepancy', { discrepancy: shortD.name, resolution: 'Accepted' })
record('a store manager may not resolve a discrepancy', !mgrRes.ok, `${mgrRes.status} ${String(mgrRes.exc).slice(0, 140)}`)
const res1 = await w.post('maison_pos.api.shipping.resolve_discrepancy', { discrepancy: shortD.name, resolution: 'Returned to warehouse', notes: `${TAG} 2 found on the truck` })
const d2 = await all('ROL-002')
record('resolving a Short as "Returned to warehouse" moves the units out of transit back to HQ',
  res1.status === 'Resolved' && d2.tr === d0.a.tr && d2.hq === d0.a.hq - 4,
  `${res1.name} ${res1.resolution} SE=${res1.stock_entry}; transit ${d1.a.tr}->${d2.tr}, HQ ${d1.a.hq}->${d2.hq}`)
const twice = await w.tryPost('maison_pos.api.shipping.resolve_discrepancy', { discrepancy: shortD.name, resolution: 'Accepted' })
record('resolving the same discrepancy twice is refused', !twice.ok, `${twice.status} ${String(twice.exc).slice(0, 140)}`)
const overD = mineD.find(d => d.type === 'Over')
const res2 = await w.post('maison_pos.api.shipping.resolve_discrepancy', { discrepancy: overD.name, resolution: 'Accepted', notes: `${TAG} store keeps it` })
record('an Over can simply be accepted', res2.status === 'Resolved' && !res2.stock_entry, `${res2.name} ${res2.resolution}`)
const dmgD = mineD.find(d => d.type === 'Damaged')
const res3 = await w.post('maison_pos.api.shipping.resolve_discrepancy', { discrepancy: dmgD.name, resolution: 'Re-ship', notes: `${TAG} sending a replacement` })
record('a Damaged line can be resolved with "Re-ship", raising a new Urgent request for the store',
  res3.status === 'Resolved' && !!res3.reship_request, `${res3.name} -> re-ship request ${res3.reship_request}`)
const reshipReq = res3.reship_request ? await a.value('Maison Replenishment Request', res3.reship_request, ['status', 'priority', 'boutique']) : null
record('the re-ship request is Urgent and addressed to the same store', reshipReq?.priority === 'Urgent' && reshipReq?.boutique === STORE, JSON.stringify(reshipReq))
const openLeft = (await w.get('maison_pos.api.shipping.discrepancies', { status: 'Open' })).discrepancies.filter(d => d.shipment === SD)
record('no discrepancy is left open for the shipment', openLeft.length === 0, `${openLeft.length} open`)

// ================= 7.4 vendor PO straight to the store
let po = null, pr = null, supplier = null
try {
  supplier = (await a.post('frappe.client.insert', { doc: { doctype: 'Supplier', supplier_name: `${TAG} Test Supplier`, supplier_group: (await a.list('Supplier Group', { is_group: 0 }, ['name'], 1))[0]?.name } })).name
  const poDoc = await a.post('frappe.client.insert', {
    doc: {
      doctype: 'Purchase Order', supplier, company: 'CloudChaserz', transaction_date: new Date().toISOString().slice(0, 10),
      schedule_date: new Date().toISOString().slice(0, 10), set_warehouse: SWH, currency: 'USD', conversion_rate: 1,
      items: [{ item_code: 'ROL-002', qty: 5, rate: 1.25, warehouse: SWH, schedule_date: new Date().toISOString().slice(0, 10) }],
    }
  })
  po = poDoc.name
  await a.post('frappe.client.submit', { doc: JSON.stringify({ ...poDoc, docstatus: 1 }) })
  const inb2 = await m.get('maison_pos.api.inventory.inbound', { boutique: STORE })
  record('a vendor PO addressed to the store shows on the store\'s Receive screen', inb2.purchase_orders.some(p => p.name === po),
    JSON.stringify(inb2.purchase_orders.map(p => [p.name, p.supplier_name, p.items.length, p.per_received])))
  const v0 = await all('ROL-002')
  const got = await m.post('maison_pos.api.inventory.receive_po', { po, boutique: STORE, lines: JSON.stringify([{ item_code: 'ROL-002', qty: 3 }]) })
  pr = got.purchase_receipt
  const v1 = await all('ROL-002')
  record('the store can receive a vendor PO directly (Purchase Receipt into the store warehouse)',
    !!pr && v1.st === v0.st + 3, `${pr}; ${STORE} ${v0.st}->${v1.st}; lines=${JSON.stringify(got.lines)}`)
  const poAfter = await a.value('Purchase Order', po, ['per_received', 'status'])
  record('the PO records the partial receipt (60 %) and stays open for the rest', Number(poAfter.per_received) === 60, JSON.stringify(poAfter))
  const wrongStore = await m2.tryPost('maison_pos.api.inventory.receive_po', { po, boutique: STORE2, lines: JSON.stringify([{ item_code: 'ROL-002', qty: 1 }]) })
  record('a PO addressed to another store cannot be received here', !wrongStore.ok, `${wrongStore.status} ${String(wrongStore.exc).slice(0, 160)}`)
} catch (e) {
  record('vendor PO flow', false, String(e).slice(0, 400))
}
record('OBSERVATION: the CloudChaserz demo seed ships no Supplier / Purchase Order', true,
  'before this test the site had 0 Suppliers and 0 Purchase Orders, so "Vendor deliveries (POs)" on Receive and the desk\'s "Vendor POs" tab are always empty on the demo', 'observation')

writeFileSync('/home/claude/maison/e2e/qa/state.json', JSON.stringify({ ...S, SD, RD: r.name, MRD: ap.request.material_request, reship: res3.reship_request, po, pr, supplier }, null, 1))
await Promise.all([m.dispose(), m2.dispose(), w.dispose()])
saveResults('results-w7a.json')
await a.dispose(); await closeBrowser()
