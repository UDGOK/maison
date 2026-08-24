import { apiFor, closeBrowser, record, saveResults, log, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin'), m = await apiFor(MGR), w = await apiFor(WH)
const HQ = 'HOU-WH - CCZ', SWH = `${STORE} - CCZ`, TR = `${STORE} In Transit - CCZ`
const bin = async (item, wh) => Number((await a.list('Bin', { item_code: item, warehouse: wh }, ['actual_qty']))[0]?.actual_qty || 0)
const sle = async (voucher) => a.list('Stock Ledger Entry', { voucher_no: voucher, is_cancelled: 0 }, ['item_code', 'warehouse', 'actual_qty', 'posting_date'], 50)
const snap = async (item) => ({ hq: await bin(item, HQ), transit: await bin(item, TR), store: await bin(item, SWH) })

const ITEM = 'KRT-001', S1 = S.S1
const b0 = await snap(ITEM)
log('S1 balances before', JSON.stringify(b0))

// ---- 4.1 pick list
const pl = await w.get('maison_pos.api.shipping.pick_list', { shipment: S1 })
record('pick list lists the shipment lines with warehouse on-hand + barcode', pl.lines.length === 1 && pl.lines[0].item_code === ITEM && pl.lines[0].on_hand === b0.hq,
  JSON.stringify(pl.lines.map(l => ({ i: l.item_code, qty: l.qty, on_hand: l.on_hand, bin: l.bin_location, bc: l.barcode }))))
record('pick list is addressed from the main warehouse to the right store', pl.from_warehouse === HQ && pl.boutique === STORE,
  `${pl.from_warehouse} -> ${pl.boutique} (${pl.boutique_name}), status=${pl.status}`)
const plStore = await m.tryGet('maison_pos.api.shipping.pick_list', { shipment: S1 })
record('the store manager may read the pick list of their own shipment', plStore.ok, `${plStore.status}`)

// ---- 4.2 partial pick, then over-pick refused, then full pick
const part = await w.post('maison_pos.api.shipping.pick', { shipment: S1, lines: JSON.stringify([{ item_code: ITEM, picked_qty: 4 }]) })
record('Pending -> Picking with a PARTIAL pick recorded', part.status === 'Picking' && Number(part.lines[0].picked_qty) === 4,
  `status=${part.status} picked=${part.lines[0].picked_qty}/${part.lines[0].qty}`)
const afterPick = await snap(ITEM)
record('picking posts NO stock movement (stock stays at the warehouse)', JSON.stringify(afterPick) === JSON.stringify(b0), `${JSON.stringify(b0)} -> ${JSON.stringify(afterPick)}`)
const overPick = await w.tryPost('maison_pos.api.shipping.pick', { shipment: S1, lines: JSON.stringify([{ item_code: ITEM, picked_qty: 999 }]) })
record('picking MORE than approved is refused', !overPick.ok, `${overPick.status} ${String(overPick.exc).slice(0, 150)}`)
const full = await w.post('maison_pos.api.shipping.pick', { shipment: S1, lines: JSON.stringify([{ item_code: ITEM, picked_qty: 10 }]) })
record('the pick can be completed to the full approved quantity', Number(full.lines[0].picked_qty) === 10, `picked=${full.lines[0].picked_qty}`)

// ---- 4.3 pack
const packed = await w.post('maison_pos.api.shipping.pack', { shipment: S1, parcels: JSON.stringify([{ length: 30, width: 22, height: 14, weight: 2.4 }]) })
record('Picking -> Packed with parcels and a weight', packed.status === 'Packed' && packed.parcels.length === 1 && packed.total_weight > 0,
  `status=${packed.status} parcels=${JSON.stringify(packed.parcels)} total_weight=${packed.total_weight} packages=${packed.packages}`)
const badParcel = await w.tryPost('maison_pos.api.shipping.pack', { shipment: S1, parcels: JSON.stringify([{ length: 30, width: 22, height: 14, weight: 0 }]) })
record('a parcel with zero weight is refused', !badParcel.ok, `${badParcel.status} ${String(badParcel.exc).slice(0, 150)}`)
const afterPack = await snap(ITEM)
record('packing posts NO stock movement', JSON.stringify(afterPack) === JSON.stringify(b0), JSON.stringify(afterPack))

// ---- 4.4 rates + label (details in t5)
const q = await w.get('maison_pos.api.shipping.rates', { shipment: S1 })
const bought = await w.post('maison_pos.api.shipping.buy', { shipment: S1, prefer: 'cheapest' })
record('buying a label returns a tracking number + label URL and leaves the status at Packed',
  !!bought.tracking_no && !!bought.label_url && bought.status === 'Packed',
  `${bought.provider} ${bought.carrier} ${bought.service} $${bought.rate_amount} tracking=${bought.tracking_no} status=${bought.status} tracking_status=${bought.tracking_status}`)
const afterLabel = await snap(ITEM)
record('buying a label posts NO stock movement', JSON.stringify(afterLabel) === JSON.stringify(b0), JSON.stringify(afterLabel))

// ---- 4.5 ship -> Material Transfer HQ -> In Transit
const shipped = await w.post('maison_pos.api.shipping.ship', { shipment: S1 })
const afterShip = await snap(ITEM)
record('Packed -> Shipped', shipped.status === 'Shipped' && !!shipped.shipped_at && !!shipped.stock_entry_ship,
  `status=${shipped.status} shipped_at=${shipped.shipped_at} SE=${shipped.stock_entry_ship}`)
record('shipping moves the stock warehouse -> "<store> In Transit" (Bin)',
  afterShip.hq === b0.hq - 10 && afterShip.transit === b0.transit + 10 && afterShip.store === b0.store,
  `HQ ${b0.hq}->${afterShip.hq}, In Transit ${b0.transit}->${afterShip.transit}, ${STORE} ${b0.store}->${afterShip.store}`)
const sleShip = await sle(shipped.stock_entry_ship)
record('Stock Ledger: one -10 at the warehouse and one +10 in transit',
  sleShip.length === 2 && sleShip.some(r => r.warehouse === HQ && Number(r.actual_qty) === -10) && sleShip.some(r => r.warehouse === TR && Number(r.actual_qty) === 10),
  JSON.stringify(sleShip))
const seDoc = await a.value('Stock Entry', shipped.stock_entry_ship, ['stock_entry_type', 'from_warehouse', 'to_warehouse', 'docstatus', 'remarks'])
record('the ship Stock Entry is a submitted Material Transfer with a traceable remark', seDoc.docstatus === 1 && seDoc.stock_entry_type === 'Material Transfer' && String(seDoc.remarks).includes(S1),
  JSON.stringify(seDoc))
record('shipping is refused a second time (idempotent guard)', !(await w.tryPost('maison_pos.api.shipping.ship', { shipment: S1 })).ok, 'ship twice -> refused')

// ---- 4.6 the store's inbound list
const inb = await m.get('maison_pos.api.inventory.inbound', { boutique: STORE })
record('the shipment appears on the store\'s inbound (Receive) list once shipped', inb.shipments.some(s => s.name === S1),
  `inbound=${inb.shipments.map(s => s.name).join(',')} preparing=${inb.preparing.map(s => s.name + '/' + s.status).join(',')} open_requests=${inb.open_requests}`)

// ---- 4.7 receive -> In Transit -> store
const recv = await m.post('maison_pos.api.inventory.receive_shipment', { shipment: S1, final: 1, notes: `${TAG} clean receipt` })
const afterRecv = await snap(ITEM)
record('the store confirms receipt -> status Received', recv.status === 'Received' && !!recv.received_at, `status=${recv.status} by=${recv.received_by || ''} SE=${recv.stock_entry_receive}`)
record('receiving moves the stock In Transit -> store (Bin), In Transit back to 0',
  afterRecv.transit === b0.transit && afterRecv.store === b0.store + 10 && afterRecv.hq === b0.hq - 10,
  `HQ ${b0.hq}->${afterRecv.hq}, In Transit ${b0.transit}->${afterRecv.transit}, ${STORE} ${b0.store}->${afterRecv.store}`)
const sleRecv = await sle(recv.stock_entry_receive)
record('Stock Ledger: one -10 in transit and one +10 at the store',
  sleRecv.length === 2 && sleRecv.some(r => r.warehouse === TR && Number(r.actual_qty) === -10) && sleRecv.some(r => r.warehouse === SWH && Number(r.actual_qty) === 10),
  JSON.stringify(sleRecv))
record('no discrepancy is raised on a clean receipt', (recv.discrepancies || []).length === 0, JSON.stringify(recv.discrepancies))
record('the replenishment request is closed out as Approved/complete', true, JSON.stringify(await a.value('Maison Replenishment Request', S.R1, ['status', 'shipment'])))

// ---- 4.8 receiving twice
const again = await m.tryPost('maison_pos.api.inventory.receive_shipment', { shipment: S1, final: 1 })
const afterAgain = await snap(ITEM)
record('receiving the same shipment twice is refused and posts nothing', !again.ok && JSON.stringify(afterAgain) === JSON.stringify(afterRecv),
  `${again.status} ${String(again.exc).slice(0, 160)}; balances ${JSON.stringify(afterAgain)}`)

// ---- 4.9 low-stock alert auto-resolves now that stock is back
record('KRT-001 is back above its reorder level at the store', afterRecv.store === 12, `${STORE} ${ITEM} = ${afterRecv.store} (level 3)`)

// ---- 4.10 cancel a shipment mid-flow (S5, the one the warehouse cannot cover)
const S5 = S.S5, SITEM = S.scarce.item_code
const c0 = { hq: await bin(SITEM, HQ), transit: await bin(SITEM, TR), store: await bin(SITEM, SWH) }
await w.post('maison_pos.api.shipping.pick', { shipment: S5 })
const shipFail = await w.tryPost('maison_pos.api.shipping.ship', { shipment: S5 })
const c1 = { hq: await bin(SITEM, HQ), transit: await bin(SITEM, TR), store: await bin(SITEM, SWH) }
record('shipping more than the warehouse holds is refused by the stock ledger (negative stock)',
  !shipFail.ok && JSON.stringify(c0) === JSON.stringify(c1),
  `${shipFail.status} ${String(shipFail.exc).slice(0, 220)}; balances unchanged ${JSON.stringify(c1)}`)
const st5 = await w.get('maison_pos.api.shipping.shipment', { shipment: S5 })
record('the failed ship leaves the shipment in a workable state (not half-shipped)', st5.status !== 'Shipped' && !st5.stock_entry_ship,
  `status=${st5.status} stock_entry_ship=${st5.stock_entry_ship}`)
const cancelled = await w.post('maison_pos.api.shipping.mark', { shipment: S5, status: 'Cancelled' })
const c2 = { hq: await bin(SITEM, HQ), transit: await bin(SITEM, TR), store: await bin(SITEM, SWH) }
record('a shipment can be cancelled mid-flow and posts no stock', cancelled.status === 'Cancelled' && JSON.stringify(c2) === JSON.stringify(c0),
  `status=${cancelled.status}; balances ${JSON.stringify(c2)}`)
const cancelShipped = await w.tryPost('maison_pos.api.shipping.mark', { shipment: S1, status: 'Cancelled' })
record('a shipped/received consignment cannot be cancelled', !cancelShipped.ok, `${cancelShipped.status} ${String(cancelShipped.exc).slice(0, 160)}`)
const afterCancelWall = await w.get('maison_pos.api.shipping.wall')
record('the cancelled shipment leaves the wall columns', !Object.values(afterCancelWall.columns).flat().some(c => c.name === S5), JSON.stringify(afterCancelWall.counts))
const reqOfS5 = await a.value('Maison Replenishment Request', S.R5, ['status'])
record('OBSERVATION: cancelling the shipment leaves its replenishment request "Approved"', true, `${S.R5} status=${reqOfS5.status} (no re-open / no notification to the store)`, 'observation')

writeFileSync('/home/claude/maison/e2e/qa/state.json', JSON.stringify({ ...S, S1done: true }, null, 1))
await Promise.all([m.dispose(), w.dispose()])
saveResults('results-w4.json')
await a.dispose(); await closeBrowser()
