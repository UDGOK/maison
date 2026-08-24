import { apiFor, closeBrowser, record, saveResults, log, sleep, STORE, MGR, WH, TAG, BASE } from './lib-wh.mjs'
import { readFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin'), m = await apiFor(MGR), w = await apiFor(WH)
const S2 = S.S2

// ---- 5.1 rate list
await w.post('maison_pos.api.shipping.pick', { shipment: S2 })
await w.post('maison_pos.api.shipping.pack', { shipment: S2 })
const q = await w.get('maison_pos.api.shipping.rates', { shipment: S2 })
const amts = q.rates.map(r => Number(r.amount))
record('rate shopping returns a list of carrier options', q.rates.length >= 4, `${q.rates.length} rates from provider "${q.provider}" (test_mode=${q.test_mode})`)
record('the rate list is sorted cheapest-first', JSON.stringify(amts) === JSON.stringify([...amts].sort((x, y) => x - y)),
  q.rates.map(r => `${r.carrier} ${r.service} $${r.amount}/${r.days}d`).join(' | '))
record('the cheapest rate is pre-selected by default', q.selected && Number(q.selected.amount) === Math.min(...amts) && q.selected.provider_rate_id === q.cheapest,
  `selected=${q.selected.carrier} ${q.selected.service} $${q.selected.amount}; cheapest id=${q.cheapest}`)
record('every rate carries carrier, service, amount, transit days and a rate id',
  q.rates.every(r => r.carrier && r.service && r.amount > 0 && r.days > 0 && r.provider_rate_id), JSON.stringify(q.rates[0]))
record('the quote echoes the ship-from and ship-to addresses used', !!q.ship_from?.zip && !!q.ship_to?.zip,
  `from ${q.ship_from.city} ${q.ship_from.state} ${q.ship_from.zip} -> to ${q.ship_to.city} ${q.ship_to.state} ${q.ship_to.zip}`)
record('the quote echoes the parcel it priced', (q.parcels || []).length > 0, JSON.stringify(q.parcels))

// ---- 5.2 fastest toggle
const qf = await w.get('maison_pos.api.shipping.rates', { shipment: S2, prefer: 'fastest' })
const minDays = Math.min(...qf.rates.map(r => r.days))
record('the "fastest" toggle selects the quickest service (ties broken by price)',
  qf.selected && qf.selected.days === minDays && qf.selected.provider_rate_id === qf.fastest,
  `fastest=${qf.selected.carrier} ${qf.selected.service} $${qf.selected.amount} ${qf.selected.days}d; cheapest is still ${qf.cheapest === q.cheapest ? 'reported' : 'MISSING'} ($${q.selected.amount})`)
record('cheapest and fastest are different services here (the toggle actually changes something)',
  qf.fastest !== q.cheapest, `cheapest=${q.selected.carrier} ${q.selected.service}, fastest=${qf.selected.carrier} ${qf.selected.service}`)
const cached = await a.value('Maison Shipment', S2, ['rate_options'])
record('the quote is cached on the shipment so the desk shows what it was quoted', String(cached.rate_options || '').includes('provider_rate_id'),
  `rate_options length=${String(cached.rate_options || '').length}`)

// ---- 5.3 provider errors
const badProv = await w.tryGet('maison_pos.api.shipping.rates', { shipment: S2, provider: 'shippo' })
record('an unconfigured carrier account fails with a readable message (no traceback to the user)',
  !badProv.ok && /not configured/i.test(badProv.exc || ''), `${badProv.status} ${String(badProv.exc).slice(0, 200)}`)
const unknownProv = await w.tryGet('maison_pos.api.shipping.rates', { shipment: S2, provider: 'pirateship' })
record('an unknown provider name fails cleanly', !unknownProv.ok && /Unknown shipping provider/i.test(unknownProv.exc || ''), `${unknownProv.status} ${String(unknownProv.exc).slice(0, 200)}`)
const badRate = await w.tryPost('maison_pos.api.shipping.buy', { shipment: S2, rate_id: 'sim_deadbeef' })
record('buying a rate that is not in the last quote is refused', !badRate.ok && /not in the last quote/i.test(badRate.exc || ''), `${badRate.status} ${String(badRate.exc).slice(0, 200)}`)

// ---- 5.4 buy a specific (non-cheapest) rate
const pickRow = q.rates.find(r => r.carrier === 'UPS' && r.days <= 2) || q.rates[q.rates.length - 1]
const bought = await w.post('maison_pos.api.shipping.buy', { shipment: S2, rate_id: pickRow.provider_rate_id })
record('the admin can buy any quoted rate, not just the cheapest',
  bought.carrier === pickRow.carrier && bought.service === pickRow.service && Number(bought.rate_amount) === Number(pickRow.amount),
  `bought ${bought.carrier} ${bought.service} $${bought.rate_amount} (${bought.rate_days}d) vs cheapest $${q.selected.amount}`)
record('the label carries a carrier-shaped tracking number and a public tracking URL',
  /^\d{22}$|^1Z|^\d{12}$/.test(bought.tracking_no) && /^https:\/\/(www\.ups|tools\.usps|www\.fedex)\./.test(bought.tracking_url || ''),
  `tracking=${bought.tracking_no} url=${bought.tracking_url}`)
record('the shipment stores the label URL for printing', !!bought.label_url, `label_url=${bought.label_url}`)
// is the label URL actually servable?
const labelRes = await a.ctx.request.get(bought.label_url.startsWith('http') ? bought.label_url : BASE + bought.label_url)
const labelBody = (await labelRes.text()).slice(0, 200)
record('the label URL resolves to a printable document', labelRes.ok(), `GET ${bought.label_url} -> ${labelRes.status()} ${labelRes.headers()['content-type'] || ''} ${labelBody.replace(/\s+/g, ' ').slice(0, 120)}`)
const buyAgain = await w.tryPost('maison_pos.api.shipping.buy', { shipment: S2, rate_id: q.rates[0].provider_rate_id })
record('OBSERVATION: buy can be called again and overwrites the label/tracking (no "already bought" guard)',
  true, buyAgain.ok ? `second buy accepted: ${buyAgain.message.carrier} ${buyAgain.message.service} tracking ${buyAgain.message.tracking_no} replaced ${bought.tracking_no}` : `refused: ${String(buyAgain.exc).slice(0, 150)}`, 'observation')

// ---- 5.5 tracking
const st = await w.get('maison_pos.api.shipping.shipment', { shipment: S2 })
const tr0 = await w.get('maison_pos.api.shipping.track', { shipment: S2 })
record('tracking can be refreshed on demand and returns carrier events', Array.isArray(tr0.events),
  `status=${tr0.status} eta=${tr0.eta} events=${JSON.stringify((tr0.events || []).map(e => e.status))}`)
record('BUG CANDIDATE: a label bought seconds ago already reports post-label carrier events',
  true, `label bought at ${st.label_at} (site tz), track says "${tr0.status}" / "${tr0.status_detail}"; first event at ${tr0.events?.[0]?.at}`, 'observation')
// ship it so refresh_tracking has something to poll
await w.post('maison_pos.api.shipping.ship', { shipment: S2 })
const before = (await a.list('Scheduled Job Log', { scheduled_job_type: 'shipping.refresh_tracking' }, ['name'], 1, 'creation desc'))[0]?.name
await a.post('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify({ name: 'shipping.refresh_tracking' }) })
let jobStatus = 'timeout'
for (let i = 0; i < 30; i++) {
  await sleep(1500)
  const now = (await a.list('Scheduled Job Log', { scheduled_job_type: 'shipping.refresh_tracking' }, ['name', 'status'], 1, 'creation desc'))[0]
  if (now && now.name !== before) { jobStatus = now.status; break }
}
const after = await a.value('Maison Shipment', S2, ['tracking_status', 'tracking_updated_at', 'tracking_url'])
record('shipping.refresh_tracking (hourly job) runs and stamps the shipment', jobStatus === 'Complete' && !!after.tracking_updated_at,
  `job=${jobStatus}; tracking_status=${after.tracking_status} updated_at=${after.tracking_updated_at}`)
const noTrack = await w.get('maison_pos.api.shipping.track', { shipment: S.S5 })
record('tracking a shipment with no label returns an empty result instead of an error', noTrack.tracking_no === null, JSON.stringify(noTrack))
const mgrTrack = await m.tryGet('maison_pos.api.shipping.track', { shipment: S2 })
record('the store manager may refresh tracking for their own inbound shipment', mgrTrack.ok, `${mgrTrack.status}`)

// ---- 5.6 rates after shipping
const lateRates = await w.tryGet('maison_pos.api.shipping.rates', { shipment: S2 })
record('re-quoting a shipment that has already shipped is refused', !lateRates.ok, `${lateRates.status} ${String(lateRates.exc).slice(0, 160)}`)
await Promise.all([m.dispose(), w.dispose()])
saveResults('results-w5.json')
await a.dispose(); await closeBrowser()
