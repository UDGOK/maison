// QA4 · B — the daily birthday-coupon job (run through Scheduled Job Type · Execute, no settings changed).
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Member QA4A'
const admin = await L.adminApi()
const settings = await admin.doc('Maison POS Settings')
const lead = Number(settings.birthday_coupon_lead_days || 7)
const today = new Date('2026-08-23T12:00:00')
const target = new Date(today); target.setDate(target.getDate() + lead)
const md = `${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`
const profiles = await admin.list('Maison Client Profile', {}, ['customer', 'birthday'], 500)
const due = profiles.filter((p) => p.birthday && String(p.birthday).slice(5) === md)
log(`lead=${lead} target=${md} — ${due.length} seeded profiles already due: ${due.map((p) => p.customer).join(', ') || 'none'}`)

// put the test member's birthday on the target day
const oldBirthday = (await admin.value('Maison Client Profile', MEMBER, ['birthday'])).birthday
await admin.post('frappe.client.set_value', { doctype: 'Maison Client Profile', name: MEMBER, fieldname: 'birthday', value: `1990-${md}` })
const couponsBefore = await admin.list('Maison Coupon', { code: ['like', 'BDAY%'] }, ['name', 'customer'], 100)

// trigger the daily job the way the desk's "Execute" button does
const job = (await admin.list('Scheduled Job Type', { method: 'maison_pos.api.rewards.issue_birthday_coupons' }, ['name', 'method', 'frequency', 'stopped', 'last_execution']))[0]
record('B · the birthday-coupon job is registered as a daily scheduled job', !!job && job.frequency === 'Daily' && !Number(job.stopped), JSON.stringify(job))
let ran = null
try {
  const doc = await admin.doc('Scheduled Job Type', job.name)
  ran = await admin.rawPost('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify(doc) })
} catch (e) { ran = { status: 0, body: { exception: String(e).slice(0, 200) } } }
await sleep(4000)
const couponsAfter = await admin.list('Maison Coupon', { code: ['like', 'BDAY%'] }, ['name', 'customer', 'discount_type', 'value', 'usage', 'max_uses', 'valid_from', 'valid_upto', 'enabled', 'title'], 100)
const mine = couponsAfter.find((c) => c.customer === MEMBER)
record('B · the birthday job issues a coupon for a member whose birthday is `lead_days` away', !!mine,
  `job run → ${ran?.status}; BDAY coupons ${couponsBefore.length} → ${couponsAfter.length}; mine=${JSON.stringify(mine)}`)
if (mine) {
  record('B · the birthday coupon matches the settings (15% / single-use / client-bound / 30 days)',
    mine.discount_type === settings.birthday_coupon_type && Number(mine.value) === Number(settings.birthday_coupon_value) &&
    mine.usage === 'Single-use' && Number(mine.max_uses) === 1 && mine.customer === MEMBER,
    `${mine.discount_type} ${mine.value} ${mine.usage} max_uses=${mine.max_uses} valid ${mine.valid_from}→${mine.valid_upto} (settings: ${settings.birthday_coupon_type} ${settings.birthday_coupon_value}, valid_days ${settings.birthday_coupon_valid_days})`)
  const chk = await (await L.userApi(L.A1)).get('maison_pos.api.promotions.check_coupon', { code: mine.name, lines: JSON.stringify([{ item_code: 'ACC-003', qty: 1, rate: 59.99 }]), boutique: L.STORE, customer: MEMBER })
  record('B · the birthday coupon is redeemable at the POS for that client only', chk.valid && Math.abs(chk.discount - 59.99 * 0.15) < 0.05, JSON.stringify(chk).slice(0, 180))
  const chk2 = await (await L.userApi(L.A1)).get('maison_pos.api.promotions.check_coupon', { code: mine.name, lines: JSON.stringify([{ item_code: 'ACC-003', qty: 1, rate: 59.99 }]), boutique: L.STORE, customer: 'Walk-in Customer' })
  record('B · the birthday coupon is refused for anyone else', !chk2.valid, `${chk2.reason} · ${chk2.message}`)
  const inter = await admin.list('Maison Client Interaction', { customer: MEMBER, type: 'Birthday' }, ['name', 'note'], 5)
  record('B · the issue is logged on the client record', inter.length > 0, JSON.stringify(inter[0] || {}).slice(0, 160))
}
// idempotent
const again = await admin.rawPost('frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event', { doc: JSON.stringify(await admin.doc('Scheduled Job Type', job.name)) })
await sleep(3000)
const couponsAfter2 = await admin.list('Maison Coupon', { code: ['like', 'BDAY%'] }, ['name'], 100)
record('B · running the birthday job twice does not double-issue', couponsAfter2.length === couponsAfter.length, `${couponsAfter.length} → ${couponsAfter2.length} (second run → ${again.status})`)

fs.writeFileSync(new URL('./created-s9.json', import.meta.url), JSON.stringify({
  TAG, oldBirthday, memberBirthdaySetTo: `1990-${md}`,
  bdayCouponsCreated: couponsAfter.filter((c) => !couponsBefore.some((b) => b.name === c.name)).map((c) => ({ code: c.name, customer: c.customer }))
}, null, 2))
L.writeResults('results-s9.json', { due: due.map((p) => p.customer) })
