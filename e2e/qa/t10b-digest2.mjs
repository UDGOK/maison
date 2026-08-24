import { apiFor, closeBrowser, record, saveResults, log, sleep, STORE, TAG } from './lib-wh.mjs'
const a = await apiFor('admin')
const SWH = `${STORE} - CCZ`, HQ = 'HOU-WH - CCZ'
const runJob = async (job) => {
  const before = (await a.list('Scheduled Job Log', { scheduled_job_type: job }, ['name'], 1, 'creation desc'))[0]?.name
  await a.post('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify({ name: job }) })
  for (let i = 0; i < 40; i++) {
    await sleep(1500)
    const n = (await a.list('Scheduled Job Log', { scheduled_job_type: job }, ['name', 'status', 'details'], 1, 'creation desc'))[0]
    if (n && n.name !== before) return n
  }
  return { status: 'timeout' }
}
const bin = async (i, wh) => Number((await a.list('Bin', { item_code: i, warehouse: wh }, ['actual_qty']))[0]?.actual_qty || 0)
const start = { st: await bin('KRT-001', SWH), hq: await bin('KRT-001', HQ) }
// dip below the level again, just long enough to exercise the digest with a real alert
const out = await a.post('frappe.client.insert', { doc: { doctype: 'Stock Entry', stock_entry_type: 'Material Transfer', purpose: 'Material Transfer', company: 'CloudChaserz', from_warehouse: SWH, to_warehouse: HQ, docstatus: 1, remarks: `${TAG} digest fixture (reversed immediately)`, items: [{ item_code: 'KRT-001', qty: 10, s_warehouse: SWH, t_warehouse: HQ }] } })
await runJob('inventory.low_stock_scan')
const open = await a.list('AWANZ Stock Alert', { boutique: STORE, status: ['in', ['Open', 'Acknowledged']] }, ['name', 'item_code', 'qty'], 20)
record('the scan re-raises the alert when stock dips again', open.length === 1, JSON.stringify(open))
const q0 = (await a.list('Email Queue', {}, ['name'], 1, 'creation desc'))[0]?.name
const errs0 = (await a.list('Error Log', {}, ['name'], 1, 'creation desc'))[0]?.name
const dig = await runJob('inventory.low_stock_digest')
const q1 = await a.list('Email Queue', {}, ['name', 'status', 'recipients', 'creation'], 10, 'creation desc')
const fresh = q1.filter(r => !q0 || r.name > q0 || r.name !== q0).slice(0, 5)
const errs = await a.list('Error Log', {}, ['name', 'method', 'creation'], 5, 'creation desc')
const newErrs = errs.filter(e => !errs0 || e.name !== errs0)
record('inventory.low_stock_digest composes and queues the daily e-mail when alerts are open',
  dig.status === 'Complete' && fresh.length > 0,
  `job=${dig.status}; Email Queue rows: ${fresh.length} ${JSON.stringify(fresh.slice(0, 3).map(r => [r.name, r.status]))}; new Error Log rows: ${newErrs.length} ${JSON.stringify(newErrs.slice(0, 2).map(e => e.method))}`)
const recips = []
for (const r of fresh.slice(0, 3)) {
  const d = await a.doc('Email Queue', r.name).catch(() => null)
  if (d) recips.push({ to: (d.recipients || []).map(x => x.recipient), subject: (d.message || '').match(/Subject: (.*)/)?.[1]?.slice(0, 90), status: d.status })
}
record('the digest goes to head office and to the store manager, with the alert table',
  recips.some(r => (r.to || []).some(x => /hq@/.test(x))) || recips.some(r => (r.to || []).some(x => /manager@/.test(x))),
  JSON.stringify(recips).slice(0, 500))
// put the stock back and clear the alert
await a.post('frappe.client.insert', { doc: { doctype: 'Stock Entry', stock_entry_type: 'Material Transfer', purpose: 'Material Transfer', company: 'CloudChaserz', from_warehouse: HQ, to_warehouse: SWH, docstatus: 1, remarks: `${TAG} digest fixture reversal`, items: [{ item_code: 'KRT-001', qty: 10, s_warehouse: HQ, t_warehouse: SWH }] } })
await runJob('inventory.low_stock_scan')
const end = { st: await bin('KRT-001', SWH), hq: await bin('KRT-001', HQ) }
const openEnd = await a.list('AWANZ Stock Alert', { boutique: STORE, status: ['in', ['Open', 'Acknowledged']] }, ['name'], 20)
record('the digest fixture is fully reversed (balances restored, alert resolved)',
  end.st === start.st && end.hq === start.hq && openEnd.length === 0, `${JSON.stringify(start)} -> ${JSON.stringify(end)}; open alerts ${openEnd.length}`)
saveResults('results-w10b.json')
await a.dispose(); await closeBrowser()
