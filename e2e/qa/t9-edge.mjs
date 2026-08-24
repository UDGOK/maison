import { apiFor, closeBrowser, record, saveResults, log, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/awanz/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin'), m = await apiFor(MGR), w = await apiFor(WH)
const assoc = await apiFor({ usr: `${STORE.toLowerCase().replace(/-/g, '.')}.a1@cloudchaserz.example`, pwd: 'cloud123' })
const w2 = await apiFor(WH)   // a second warehouse-admin session
const made = { requests: [], shipments: [] }

// ---- 9.1 two people at the store requesting at the same moment
const t0 = Date.now()
const par = await Promise.allSettled([
  m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} concurrent A`, lines: JSON.stringify([{ item_code: 'DSP-001', qty: 2 }]) }),
  assoc.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} concurrent B`, lines: JSON.stringify([{ item_code: 'DSP-002', qty: 2 }]) }),
  m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} concurrent C`, lines: JSON.stringify([{ item_code: 'DSP-003', qty: 2 }]) }),
  assoc.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} concurrent D`, lines: JSON.stringify([{ item_code: 'DSP-008', qty: 2 }]) }),
])
const okPar = par.filter(p => p.status === 'fulfilled').map(p => p.value)
made.requests.push(...okPar.map(r => r.name))
const names = new Set(okPar.map(r => r.name)), mrs = new Set(okPar.map(r => r.material_request))
record('four concurrent replenishment requests from two users all succeed with unique names',
  okPar.length === 4 && names.size === 4 && mrs.size === 4,
  `${okPar.length}/4 ok in ${Date.now() - t0} ms; requests=${[...names].join(',')}; MRs=${[...mrs].join(',')}; failures=${par.filter(p => p.status === 'rejected').map(p => String(p.reason).slice(0, 120)).join(' | ')}`)
const stored = await a.list('AWANZ Replenishment Request', { name: ['in', [...names]] }, ['name', 'status', 'boutique'], 10)
record('all four are persisted and Pending Approval (nothing lost to a race)', stored.length === 4 && stored.every(r => r.status === 'Pending Approval'),
  JSON.stringify(stored.map(r => [r.name, r.status])))

// ---- 9.2 two warehouse sessions approving the same request at the same moment
const target = okPar[0].name
const both = await Promise.allSettled([
  w.post('maison_pos.api.shipping.approve', { request: target }),
  w2.post('maison_pos.api.shipping.approve', { request: target }),
])
const wins = both.filter(b => b.status === 'fulfilled')
const shipsFor = await a.list('AWANZ Shipment', { replenishment_request: target }, ['name', 'status'], 10)
made.shipments.push(...shipsFor.map(s => s.name))
record('two admins approving the same request at once produce exactly ONE shipment',
  shipsFor.length === 1, `${wins.length}/2 calls succeeded; shipments for ${target}: ${JSON.stringify(shipsFor.map(s => s.name))}; loser said "${both.filter(b => b.status === 'rejected').map(b => String(b.reason).slice(0, 140)).join('')}"`)

// ---- 9.3 acting on an already-shipped request / shipment
const shippedReq = S.RU   // its shipment MSH-…42 is Received
const apShipped = await w.tryPost('maison_pos.api.shipping.approve', { request: shippedReq })
record('approving a request whose shipment has already gone out is refused', !apShipped.ok, `${apShipped.status} ${String(apShipped.exc).slice(0, 160)}`)
const reShipped = await w.tryPost('maison_pos.api.shipping.reject', { request: shippedReq, reason: 'changed my mind' })
record('rejecting a request whose shipment has already gone out is refused', !reShipped.ok, `${reShipped.status} ${String(reShipped.exc).slice(0, 160)}`)
for (const [label, method, args] of [
  ['pick', 'maison_pos.api.shipping.pick', { shipment: S.SU }],
  ['pack', 'maison_pos.api.shipping.pack', { shipment: S.SU }],
  ['buy a label for', 'maison_pos.api.shipping.buy', { shipment: S.SU, prefer: 'cheapest' }],
  ['ship', 'maison_pos.api.shipping.ship', { shipment: S.SU }],
]) {
  const r = await w.tryPost(method, args)
  record(`you cannot ${label} a shipment that is already Received`, !r.ok, `${r.status} ${String(r.exc).slice(0, 120)}`)
}
const recvTwice = await m.tryPost('maison_pos.api.inventory.receive_shipment', { shipment: S.SU, final: 1 })
record('receiving an already-received shipment a second time is refused (no double stock)', !recvTwice.ok, `${recvTwice.status} ${String(recvTwice.exc).slice(0, 150)}`)
const markBack = await w.tryPost('maison_pos.api.shipping.mark', { shipment: S.SU, status: 'Picking' })
record('a Received shipment cannot be marked back to Picking', !markBack.ok, `${markBack.status} ${String(markBack.exc).slice(0, 150)}`)
const badStatus = await w.tryPost('maison_pos.api.shipping.mark', { shipment: S.toPick.ship, status: 'Teleported' })
record('an unsupported status transition is refused', !badStatus.ok, `${badStatus.status} ${String(badStatus.exc).slice(0, 140)}`)

// ---- 9.4 a 50-line shipment
const stock = await w.get('maison_pos.api.shipping.warehouse_stock', { limit: 5000 })
const items = stock.rows.filter(r => r.actual_qty >= 2).slice(0, 50).map(r => r.item_code)
const tBig = Date.now()
const big = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} 50-line consignment`, lines: JSON.stringify(items.map(i => ({ item_code: i, qty: 1 }))) })
const tReq = Date.now() - tBig
made.requests.push(big.name)
record('a 50-line replenishment request is accepted', big.request.items === 50 && big.request.units === 50, `${big.name}: ${big.request.items} lines / ${big.request.units} units in ${tReq} ms`)
const tAp = Date.now()
const apBig = await w.post('maison_pos.api.shipping.approve', { request: big.name })
const BIG = apBig.shipment.name
made.shipments.push(BIG)
record('approving 50 lines creates a 50-line shipment (and a 50-line Material Request)', apBig.shipment.lines.length === 50,
  `${BIG}: ${apBig.shipment.lines.length} lines in ${Date.now() - tAp} ms; MR=${apBig.request.material_request}`)
record('the shipment estimates parcels/weight for 50 lines', apBig.shipment.est_weight > 0,
  `est_weight=${apBig.shipment.est_weight} kg, est_dims=${JSON.stringify(apBig.shipment.est_dims)}, parcels=${JSON.stringify(apBig.shipment.parcels)}`)
const tPl = Date.now()
const plBig = await w.get('maison_pos.api.shipping.pick_list', { shipment: BIG })
record('the pick list renders all 50 lines sorted by bin location', plBig.lines.length === 50 &&
  JSON.stringify(plBig.lines.map(l => l.bin_location || '')) === JSON.stringify([...plBig.lines.map(l => l.bin_location || '')].sort()),
  `${plBig.lines.length} lines in ${Date.now() - tPl} ms; first bins ${plBig.lines.slice(0, 5).map(l => l.bin_location).join(',')}`)
const tR = Date.now()
const rBig = await w.post('maison_pos.api.shipping.rates', { shipment: BIG })
record('rates still quote for a 50-line / multi-carton consignment', rBig.rates.length > 0,
  `${rBig.rates.length} rates, cheapest ${rBig.selected.carrier} ${rBig.selected.service} $${rBig.selected.amount} in ${Date.now() - tR} ms; parcels=${JSON.stringify(rBig.parcels)}`)
const cachedBig = (await a.doc('AWANZ Shipment', BIG)).rate_options
record('the quote is cached on the shipment (rate_options) when rates is called as the UI does (POST)',
  String(cachedBig || '').includes('provider_rate_id'), `rate_options length=${String(cachedBig || '').length}`)
const tW = Date.now()
const wallBig = await w.get('maison_pos.api.shipping.wall')
record('the wall payload still builds with the big consignment on it', wallBig.columns.to_pick.some(c => c.name === BIG),
  `wall built in ${Date.now() - tW} ms; counts=${JSON.stringify(wallBig.counts)}`)
const pl2 = await a.ctx.request.get(`/printview?doctype=AWANZ%20Shipment&name=${BIG}&format=AWANZ%20Packing%20List&no_letterhead=1`)
const plTxt = await pl2.text()
record('the packing list print format renders 50 lines with barcodes', pl2.ok() && (plTxt.match(/data:image\/svg\+xml/g) || []).length >= 50,
  `${pl2.status()} len=${plTxt.length}, ${(plTxt.match(/data:image\/svg\+xml/g) || []).length} inline barcode/QR SVGs`)

writeFileSync('/home/claude/awanz/e2e/qa/state.json', JSON.stringify({ ...S, edge: made, BIG }, null, 1))
log('EDGE ' + JSON.stringify({ ...made, BIG }))
await Promise.all([m.dispose(), w.dispose(), w2.dispose(), assoc.dispose()])
saveResults('results-w9.json')
await a.dispose(); await closeBrowser()
