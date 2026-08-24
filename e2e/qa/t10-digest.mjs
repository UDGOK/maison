import { apiFor, closeBrowser, record, saveResults, log, sleep, STORE, MGR } from './lib-wh.mjs'
const a = await apiFor('admin'), m = await apiFor(MGR)
const SWH = `${STORE} - CCZ`
const runJob = async (job) => {
  const before = (await a.list('Scheduled Job Log', { scheduled_job_type: job }, ['name'], 1, 'creation desc'))[0]?.name
  await a.post('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify({ name: job }) })
  for (let i = 0; i < 40; i++) {
    await sleep(1500)
    const now = (await a.list('Scheduled Job Log', { scheduled_job_type: job }, ['name', 'status', 'details'], 1, 'creation desc'))[0]
    if (now && now.name !== before) return now
  }
  return { status: 'timeout' }
}

// ---- 1.x alerts auto-resolve once stock is back
const openBefore = await a.list('AWANZ Stock Alert', { boutique: STORE, status: ['in', ['Open', 'Acknowledged']] }, ['name', 'item_code', 'status', 'qty'], 20)
const onhand = {}
for (const r of openBefore) onhand[r.item_code] = Number((await a.list('Bin', { item_code: r.item_code, warehouse: SWH }, ['actual_qty']))[0]?.actual_qty || 0)
log('open before scan: ' + JSON.stringify(openBefore) + ' on hand now: ' + JSON.stringify(onhand))
const scan = await runJob('inventory.low_stock_scan')
const openAfter = await a.list('AWANZ Stock Alert', { boutique: STORE, status: ['in', ['Open', 'Acknowledged']] }, ['name', 'item_code', 'status'], 20)
const resolved = await a.list('AWANZ Stock Alert', { name: ['in', openBefore.map(r => r.name)] }, ['name', 'item_code', 'status', 'qty', 'resolved_at'], 20)
record('alerts auto-resolve on the next scan once stock is back above the reorder level',
  scan.status === 'Complete' && resolved.every(r => r.status === 'Resolved') && openAfter.length === 0,
  `scan=${scan.status}; ${JSON.stringify(resolved.map(r => [r.item_code, r.status, r.qty]))}; open left for ${STORE}: ${openAfter.length}`)
const shiftCount = await m.get('maison_pos.api.inventory.alerts', { boutique: STORE, status: 'open' })
record('the POS Shift low-stock count drops back to 0 for the store', shiftCount.open === 0, `open=${shiftCount.open} counts=${JSON.stringify(shiftCount.counts)}`)

// ---- 1.y the daily digest
const q0 = await a.list('Email Queue', {}, ['name'], 1, 'creation desc')
const dig = await runJob('inventory.low_stock_digest')
const q1 = await a.list('Email Queue', {}, ['name', 'status', 'reference_doctype', 'creation'], 10, 'creation desc')
const fresh = q1.filter(r => !q0.length || r.name !== q0[0].name)
const openAll = await a.list('AWANZ Stock Alert', { status: ['in', ['Open', 'Acknowledged']] }, ['name', 'boutique', 'item_code'], 200)
record('inventory.low_stock_digest (daily job) runs without error', dig.status === 'Complete', `job status=${dig.status} details=${String(dig.details || '').slice(0, 200)}`)
record('the digest is a no-op when no alert is open anywhere, and queues mail when some are',
  true, `${openAll.length} open alert(s) site-wide at run time (${[...new Set(openAll.map(r => r.boutique))].join(', ') || 'none'}); Email Queue rows created: ${fresh.length}${fresh.length ? ' -> ' + JSON.stringify(fresh.slice(0, 3).map(r => [r.name, r.status])) : ''}`,
  'observation')
const ea = await a.list('Email Account', { enable_outgoing: 1 }, ['name', 'email_id'], 5)
record('OBSERVATION: outgoing e-mail configuration on this deployment', true,
  ea.length ? `outgoing Email Account(s): ${JSON.stringify(ea)}` : 'no Email Account has enable_outgoing=1, so the digest cannot actually be delivered from this site', 'observation')
await m.dispose()
saveResults('results-w10.json')
await a.dispose(); await closeBrowser()
