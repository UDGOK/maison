import { apiFor, closeBrowser, log, STORE } from './lib-wh.mjs'
const a = await apiFor('admin')
log('open shipments (all stores):', JSON.stringify(await a.list('Maison Shipment', {status:['in',['Pending','Picking','Packed','Shipped']]}, ['name','boutique','status'], 50)))
log('pending requests (all stores):', JSON.stringify(await a.list('Maison Replenishment Request', {status:'Pending Approval'}, ['name','boutique'], 50)))
log('open discrepancies:', JSON.stringify(await a.list('Maison Receiving Discrepancy', {status:'Open'}, ['name'], 20)))
log('open alerts:', JSON.stringify(await a.list('Maison Stock Alert', {status:['in',['Open','Acknowledged']]}, ['name','boutique','item_code'], 30)))
log('transit bins non-zero:', JSON.stringify(await a.list('Bin', {warehouse:['like','%In Transit%'], actual_qty:['!=',0]}, ['warehouse','item_code','actual_qty'], 30)))
log('damaged bins non-zero:', JSON.stringify(await a.list('Bin', {warehouse:['like','%Damaged%'], actual_qty:['!=',0]}, ['warehouse','item_code','actual_qty'], 30)))
await a.dispose(); await closeBrowser()
