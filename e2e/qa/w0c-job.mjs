import { apiFor, closeBrowser, log, sleep } from './lib-wh.mjs'
const a = await apiFor('admin')
const r = await a.tryPost('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify({ name: 'inventory.low_stock_scan' }) })
log('execute_event ->', JSON.stringify(r).slice(0, 500))
const j = await a.list('Scheduled Job Log', { scheduled_job_type: 'inventory.low_stock_scan' }, ['name','status','creation','details'], 5, 'creation desc')
log('job logs', JSON.stringify(j).slice(0,800))
log('scheduler disabled?', JSON.stringify(await a.get('frappe.client.get_value',{doctype:'System Settings',filters:JSON.stringify({name:'System Settings'}),fieldname:JSON.stringify(['name'])})))
await a.dispose(); await closeBrowser()
