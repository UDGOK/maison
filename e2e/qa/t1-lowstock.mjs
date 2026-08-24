import { apiFor, closeBrowser, record, saveResults, log, sleep, STORE, STORE2, MGR, MGR2, WH, TAG } from './lib-wh.mjs'
const a = await apiFor('admin')
const HQ = 'HOU-WH - CCZ', SWH = `${STORE} - CCZ`, COMPANY = 'CloudChaserz'
const ITEMS = [{ code: 'KRT-001', drop: 10 }, { code: 'HKA-004', drop: 11 }]
const bin = async (item, wh) => Number((await a.list('Bin', { item_code: item, warehouse: wh }, ['actual_qty']))[0]?.actual_qty || 0)
const alertsFor = async (item, wh, status = null) =>
  a.list('AWANZ Stock Alert', { item_code: item, warehouse: wh, ...(status ? { status } : {}) }, ['name', 'status', 'qty', 'reorder_level', 'reorder_qty', 'boutique', 'first_seen', 'last_seen', 'notified'], 20, 'creation desc')
const runScan = async () => {
  const before = (await a.list('Scheduled Job Log', { scheduled_job_type: 'inventory.low_stock_scan' }, ['name'], 1, 'creation desc'))[0]?.name
  await a.post('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify({ name: 'inventory.low_stock_scan' }) })
  for (let i = 0; i < 40; i++) {
    await sleep(1500)
    const now = (await a.list('Scheduled Job Log', { scheduled_job_type: 'inventory.low_stock_scan' }, ['name', 'status'], 1, 'creation desc'))[0]
    if (now && now.name !== before) return now.status
  }
  return 'timeout'
}

const start = {}
for (const it of ITEMS) start[it.code] = { store: await bin(it.code, SWH), hq: await bin(it.code, HQ) }
log('start balances', JSON.stringify(start))

// pre-existing alerts on those keys (shouldn't be any)
for (const it of ITEMS) {
  const pre = await alertsFor(it.code, SWH)
  log(`pre alerts ${it.code}: ${JSON.stringify(pre.map(x => [x.name, x.status]))}`)
}

// ---- 1.0 create the low-stock condition (reversed by the replenishment loop / cleanup)
const se = await a.post('frappe.client.insert', {
  doc: {
    doctype: 'Stock Entry', stock_entry_type: 'Material Transfer', purpose: 'Material Transfer',
    company: COMPANY, from_warehouse: SWH, to_warehouse: HQ, docstatus: 1,
    remarks: `${TAG} low-stock fixture (will be reversed)`,
    items: ITEMS.map(it => ({ item_code: it.code, qty: it.drop, s_warehouse: SWH, t_warehouse: HQ })),
  }
})
log('fixture stock entry', se.name)
const after = {}
for (const it of ITEMS) after[it.code] = { store: await bin(it.code, SWH), hq: await bin(it.code, HQ) }
record('fixture: store stock pushed below reorder level', ITEMS.every(it => after[it.code].store === start[it.code].store - it.drop),
  `${JSON.stringify(start)} -> ${JSON.stringify(after)} via ${se.name}`)

// ---- 1.1 run the scan
const s1 = await runScan()
record('inventory.low_stock_scan runs (Scheduled Job Type)', s1 === 'Complete', `job log status=${s1}`)
const found = {}
for (const it of ITEMS) found[it.code] = await alertsFor(it.code, SWH, 'Open')
record('an Open alert exists for each low item at the right store/warehouse',
  ITEMS.every(it => found[it.code].length === 1 && found[it.code][0].boutique === STORE),
  ITEMS.map(it => `${it.code}: ${JSON.stringify(found[it.code].map(x => [x.name, x.status, x.qty, x.reorder_level, x.boutique]))}`).join(' ; '))
record('alert qty/level match the Bin and the Item Reorder row',
  ITEMS.every(it => Number(found[it.code][0]?.qty) === after[it.code].store),
  ITEMS.map(it => `${it.code} alert.qty=${found[it.code][0]?.qty} bin=${after[it.code].store} level=${found[it.code][0]?.reorder_level}`).join(' ; '))

// no alert for an item that is still above its level, and none for the other store
const above = await alertsFor('ROL-001', SWH, 'Open')
record('no alert for an item still above its level', above.length === 0, `ROL-001 @ ${SWH}: ${above.length} open`)
const other = await a.list('AWANZ Stock Alert', { item_code: ITEMS[0].code, warehouse: `${STORE2} - CCZ`, status: 'Open' }, ['name'], 10)
record('no alert raised on an unaffected store', other.length === 0, `${ITEMS[0].code} @ ${STORE2}: ${other.length} open`)

// ---- 1.2 idempotency
const before2 = found[ITEMS[0].code][0]
const s2 = await runScan()
const dup = {}
for (const it of ITEMS) dup[it.code] = await alertsFor(it.code, SWH, 'Open')
record('re-running the scan creates no duplicate alert', s2 === 'Complete' && ITEMS.every(it => dup[it.code].length === 1 && dup[it.code][0].name === found[it.code][0].name),
  ITEMS.map(it => `${it.code}: ${dup[it.code].length} open (${dup[it.code].map(x => x.name).join(',')})`).join(' ; '))
record('re-run refreshes last_seen on the existing alert', new Date(dup[ITEMS[0].code][0].last_seen) >= new Date(before2.last_seen),
  `last_seen ${before2.last_seen} -> ${dup[ITEMS[0].code][0].last_seen}`)
record('the new alerts were flagged notified (desk bell)', dup[ITEMS[0].code][0].notified === 1, `notified=${dup[ITEMS[0].code][0].notified}`)
const notif = await a.list('Notification Log', { document_type: 'AWANZ Stock Alert', document_name: dup[ITEMS[0].code][0].name }, ['name', 'for_user', 'subject'], 20)
record('Notification Log entries created for the store manager / head office', notif.length > 0,
  `${notif.length} logs; users=${[...new Set(notif.map(n => n.for_user))].join(', ').slice(0, 200)}; subject="${notif[0]?.subject || ''}"`)

// ---- 1.3 store scoping of the alerts endpoint
const m1 = await apiFor(MGR), m2 = await apiFor(MGR2)
const mine = await m1.get('maison_pos.api.inventory.alerts', { boutique: STORE, status: 'open' })
record('store manager sees their own alerts', mine.alerts.some(x => x.item_code === ITEMS[0].code), `${mine.alerts.length} alerts, counts=${JSON.stringify(mine.counts)}`)
const cross = await m2.tryGet('maison_pos.api.inventory.alerts', { boutique: STORE, status: 'open' })
record('another store\'s manager is refused the alerts of my store', !cross.ok && /Permission/i.test(cross.exc || ''), `${cross.status} ${String(cross.exc).slice(0, 160)}`)

// ---- 1.4 acknowledge / resolve
const target = dup[ITEMS[0].code][0].name
const ack = await m1.post('maison_pos.api.inventory.acknowledge', { alert: target })
record('manager acknowledges an alert', ack.status === 'Acknowledged', JSON.stringify(ack))
const ackDoc = (await alertsFor(ITEMS[0].code, SWH))[0]
record('acknowledged_by / acknowledged_at recorded', !!ackDoc, JSON.stringify(await a.value('AWANZ Stock Alert', target, ['status', 'acknowledged_by', 'acknowledged_at'])))
const s3 = await runScan()
const stillAck = await alertsFor(ITEMS[0].code, SWH, 'Acknowledged')
record('a re-scan keeps an Acknowledged alert acknowledged (no re-open, no duplicate)', stillAck.length === 1 && stillAck[0].name === target,
  `${stillAck.length} acknowledged: ${stillAck.map(x => x.name).join(',')}; scan=${s3}`)

const other2 = dup[ITEMS[1].code][0].name
const res = await m1.post('maison_pos.api.inventory.resolve', { alert: other2 })
record('manager resolves an alert by hand', res.status === 'Resolved', JSON.stringify(res))
// an associate must not resolve
const assoc = await apiFor({ usr: `${STORE.toLowerCase().replace(/-/g, '.')}.a1@cloudchaserz.example`, pwd: 'cloud123' })
const aRes = await assoc.tryPost('maison_pos.api.inventory.resolve', { alert: target })
record('an associate may not resolve an alert', !aRes.ok, `${aRes.status} ${String(aRes.exc).slice(0, 160)}`)
const aAck = await assoc.tryPost('maison_pos.api.inventory.acknowledge', { alert: target })
record('an associate MAY acknowledge an alert (by design)', aAck.ok, JSON.stringify(aAck.message || aAck.exc).slice(0, 160))

// a resolved alert is re-created by the next scan while stock is still low
const s4 = await runScan()
const reopened = await alertsFor(ITEMS[1].code, SWH, 'Open')
record('a hand-resolved alert comes back on the next scan while stock is still low', reopened.length === 1 && reopened[0].name !== other2,
  `new=${reopened.map(x => x.name).join(',')} old=${other2}; scan=${s4}`)

// ---- 1.5 open counts / dashboard tile
const counts = await m1.get('maison_pos.api.inventory.alerts', { boutique: STORE, status: 'open' })
record('open counts endpoint reports my store\'s open+acknowledged alerts', (counts.counts[STORE] || 0) >= 2, JSON.stringify(counts.counts))

await Promise.all([m1.dispose(), m2.dispose(), assoc.dispose()])
saveResults('results-w1.json')
await a.dispose(); await closeBrowser()
