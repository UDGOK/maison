import { apiFor, closeBrowser, STORE, log } from './lib-wh.mjs'
const a = await apiFor('admin')
const w = await a.get('maison_pos.api.shipping.wall')
log('wall counts', JSON.stringify(w.counts), 'warn', w.warn_seconds, 'crit', w.crit_seconds,
    'sound', w.sound_enabled, 'autoPL', w.auto_print_packing_list, 'autoLabel', w.auto_print_label,
    'provider', w.provider, 'in_transit', w.in_transit, 'received_today', w.received_today, 'open_disc', w.open_discrepancies, 'server_time', w.server_time)
const ir = await a.get('frappe.client.get_list', { doctype: 'Item Reorder', parent: 'Item', fields: JSON.stringify(['parent','warehouse','warehouse_reorder_level','warehouse_reorder_qty']), limit_page_length: 500 })
log('Item Reorder rows:', ir.length)
const byWh = {}
for (const r of ir) byWh[r.warehouse] = (byWh[r.warehouse]||0)+1
log('by warehouse', JSON.stringify(byWh))
log('sample', JSON.stringify(ir.slice(0,8)))
// current on-hand for reorder items at my store + warehouse
const mine = ir.filter(r=>r.warehouse===`${STORE} - CCZ`)
log(`${STORE} reorder rows`, mine.length)
for (const r of mine.slice(0,30)) {
  const b = await a.list('Bin', {item_code:r.parent, warehouse:r.warehouse}, ['actual_qty'])
  log(`  ${r.parent} lvl=${r.warehouse_reorder_level} qty=${r.warehouse_reorder_qty} onhand=${b[0]?.actual_qty ?? 0}`)
}
log('--- alert doctype fields')
const meta = await a.get('frappe.client.get_list',{doctype:'Maison Stock Alert', limit_page_length:5, fields:JSON.stringify(['name','status'])})
log(JSON.stringify(meta))
log('--- ship_to for store')
log(JSON.stringify(await a.doc('Maison Boutique', STORE)).slice(0,1200))
await a.dispose(); await closeBrowser()
