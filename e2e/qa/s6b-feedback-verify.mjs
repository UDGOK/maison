import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, log } = L
const S5 = JSON.parse(fs.readFileSync(new URL('./created-s5.json', import.meta.url)))
const admin = await L.adminApi()
const guest = await L.guestApi()
const inv = await admin.doc('Sales Invoice', S5.invoice)
const token = inv.maison_receipt_token
const rows = await admin.list('AWANZ Feedback', { sales_invoice: inv.name }, ['name', 'rating', 'comment', 'boutique', 'customer', 'status'], 5)
record('B · feedback reaches HQ as an AWANZ Feedback record', rows.length === 1 && Number(rows[0].rating) === 2, JSON.stringify(rows[0]))
const fdoc = rows.length ? await admin.doc('AWANZ Feedback', rows[0].name) : null
record('B · the feedback record is scoped to the store and carries the comment', fdoc?.boutique === L.STORE && /QA4/.test(fdoc?.comment || ''),
  JSON.stringify({ boutique: fdoc?.boutique, rating: fdoc?.rating, alerted: fdoc?.alerted, alert_sent: fdoc?.alert_sent, status: fdoc?.status, source: fdoc?.source, comment: (fdoc?.comment || '').slice(0, 60) }))
let summary = null
try { summary = await admin.get('maison_pos.api.feedback.summary', { boutique: L.STORE }) } catch (e) { summary = { err: String(e).slice(0, 200) } }
record('B · HQ feedback summary reports the store\'s ratings', !!summary && !summary.err, JSON.stringify(summary).slice(0, 300))
// only HQ / managers may read feedback — a shopper must not
const S3 = JSON.parse(fs.readFileSync(new URL('./created-s3.json', import.meta.url)))
const shopper = await L.userApi(S3.NEW, '/shop')
const leak = await shopper.raw('frappe.client.get_list', { doctype: 'AWANZ Feedback', fields: JSON.stringify(['name', 'rating', 'comment']), limit_page_length: 5 })
record('B · feedback is not readable by a shopper', leak.status !== 200 || (leak.body?.message || []).length === 0, `${leak.status} rows=${(leak.body?.message || []).length}`)
// low-rating alert
const notif = await admin.list('Notification Log', { document_name: rows[0]?.name }, ['name', 'subject', 'for_user'], 10).catch(() => [])
const todo = await admin.list('ToDo', { reference_name: rows[0]?.name }, ['name', 'allocated_to'], 10).catch(() => [])
const comms = await admin.list('Communication', { reference_name: rows[0]?.name }, ['name', 'subject', 'recipients'], 10).catch(() => [])
record('B · a rating ≤ 2 alerts the store manager', notif.length > 0 || todo.length > 0 || comms.length > 0 || Number(fdoc?.alerted || 0) === 1,
  `alerted=${fdoc?.alerted} notification_logs=${notif.length} ${JSON.stringify(notif.slice(0, 2))} todos=${todo.length} communications=${comms.length}`)
// duplicate + bad token
const again = await guest.rawPost('maison_pos.api.feedback.submit', { token, rating: 5, comment: 'QA4 duplicate probe' })
const rows2 = await admin.list('AWANZ Feedback', { sales_invoice: inv.name }, ['name', 'rating'], 5)
record('B · only one feedback per receipt is stored', rows2.length === 1 && Number(rows2[0].rating) === 2, `${rows2.length} rows; second submit → ${again.status} ${JSON.stringify(again.body?.message || again.body?.exception).slice(0, 140)}`)
const badTok = await guest.rawPost('maison_pos.api.feedback.submit', { token: 'nosuchtoken1234', rating: 5 })
record('B · feedback with an unknown receipt token is refused', badTok.status !== 200, `${badTok.status} ${String(badTok.body?.exception || '').slice(0, 100)}`)
const badRating = await guest.rawPost('maison_pos.api.feedback.submit', { token, rating: 9 })
record('B · an out-of-range rating is refused', badRating.status !== 200, `${badRating.status} ${String(badRating.body?.exception || '').slice(0, 90)}`)
L.writeResults('results-s6b.json')
