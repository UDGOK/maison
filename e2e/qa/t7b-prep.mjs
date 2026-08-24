import { apiFor, closeBrowser, log, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/awanz/e2e/qa/state.json', 'utf8'))
const m = await apiFor(MGR), w = await apiFor(WH)
const r = await m.post('maison_pos.api.inventory.replenish', { boutique: STORE, reason: `${TAG} UI receive with a scanner`, lines: JSON.stringify([{ item_code: 'ROL-002', qty: 5 }]) })
const ap = await w.post('maison_pos.api.shipping.approve', { request: r.name })
const SU = ap.shipment.name
await w.post('maison_pos.api.shipping.pick', { shipment: SU })
await w.post('maison_pos.api.shipping.pack', { shipment: SU })
await w.post('maison_pos.api.shipping.buy', { shipment: SU, prefer: 'cheapest' })
await w.post('maison_pos.api.shipping.ship', { shipment: SU })
log('UI receive shipment', SU, 'request', r.name, 'mr', ap.request.material_request)
writeFileSync('/home/claude/awanz/e2e/qa/state.json', JSON.stringify({ ...S, SU, RU: r.name }, null, 1))
await m.dispose(); await w.dispose(); await closeBrowser()
