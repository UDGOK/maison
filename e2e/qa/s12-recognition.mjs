// QA4 · C — client recognition: it ships OFF; consent / enrolment / decline / revoke behave; no
// enrolment without consent. Only the STORE-level override is touched (never the global switch).
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const mgr = await L.userApi(L.MGR)
const guest = await L.guestApi()
const created = { customers: [], consents: [] }
const vec = (seed) => Array.from({ length: 128 }, (_, i) => Math.sin(seed * 7.13 + i * 0.37) * 0.14)
// a vector far from `base`: shift every dimension by 0.1 → Euclidean distance 0.1*sqrt(128) = 1.13 (threshold 0.6)
const far = (base) => base.map((x) => x + 0.1)

// ---------- 1. it ships OFF
const set = await admin.doc('AWANZ POS Settings')
const storeOverrideBefore = (await admin.value('AWANZ Store', L.STORE, ['face_recognition_enabled'])).face_recognition_enabled || 'Inherit'
record('C · client recognition is OFF globally (as shipped)', !Number(set.face_recognition_enabled),
  `AWANZ POS Settings.face_recognition_enabled=${set.face_recognition_enabled}; consent_text_version=${set.consent_text_version}; model=${set.recognition_model}; threshold=${set.match_distance_threshold}`)
const overrides = await admin.list('AWANZ Store', {}, ['name', 'face_recognition_enabled'], 20)
record('C · no store overrides recognition on', overrides.every((b) => !b.face_recognition_enabled || b.face_recognition_enabled === 'Inherit'), JSON.stringify(overrides.map((b) => [b.name, b.face_recognition_enabled || 'Inherit'])))
const boot = await assoc.get('maison_pos.api.catalog.bootstrap', { boutique: L.STORE })
record('C · the POS bootstrap reports recognition disabled for this store', !Number(boot.settings.face_recognition_enabled) && !Number(boot.settings.face_recognition_global),
  `face_recognition_enabled=${boot.settings.face_recognition_enabled} global=${boot.settings.face_recognition_global}`)
const consented = await admin.list('Customer', { maison_face_consent: 1 }, ['name'], 20)
const templates = await admin.list('AWANZ Face Template', {}, ['name'], 20).catch(() => [])
record('C · no client is enrolled and no face template exists', consented.length === 0 && templates.length === 0, `consented=${consented.length} templates=${templates.length}`)
// off → the API refuses
const offEnroll = await assoc.rawPost('maison_pos.api.recognition.enroll', {
  embeddings: JSON.stringify([vec(1)]), model: set.recognition_model, boutique: L.STORE, device_id: `QA4-${TAG}`,
  consent: JSON.stringify({ method: 'Hold-to-agree', text_version: set.consent_text_version }), name: `QA4 Recog ${TAG}`, phone: '9185550999'
})
record('C · with recognition off, enrolment is refused', offEnroll.status !== 200, `${offEnroll.status} ${String(offEnroll.body?.exception || '').slice(0, 130)}`)
const offMatch = await assoc.rawPost('maison_pos.api.recognition.match', { embedding: JSON.stringify(vec(1)), model: set.recognition_model, boutique: L.STORE })
record('C · with recognition off, matching is refused', offMatch.status !== 200, `${offMatch.status} ${String(offMatch.body?.exception || '').slice(0, 130)}`)
const created0 = await admin.list('Customer', { customer_name: `QA4 Recog ${TAG}` }, ['name'], 5)
record('C · a refused enrolment creates nothing', created0.length === 0, `${created0.length} customers created`)

// ---------- 2. enable for THIS STORE ONLY (store override, never the global switch)
await admin.post('frappe.client.set_value', { doctype: 'AWANZ Store', name: L.STORE, fieldname: 'face_recognition_enabled', value: 'On' })
const after = await admin.value('AWANZ POS Settings', 'AWANZ POS Settings', ['face_recognition_enabled'])
record('C · enabling the store override leaves the global switch off', !Number(after.face_recognition_enabled),
  `global=${after.face_recognition_enabled}, ${L.STORE} override=On (restored to ${storeOverrideBefore} at the end)`)
try {
  const boot2 = await assoc.get('maison_pos.api.catalog.bootstrap', { boutique: L.STORE })
  record('C · the store now reports recognition enabled while the chain stays off', Number(boot2.settings.face_recognition_enabled) === 1 && !Number(boot2.settings.face_recognition_global),
    `store=${boot2.settings.face_recognition_enabled} global=${boot2.settings.face_recognition_global}`)

  // no enrolment without consent
  const noConsent = await assoc.rawPost('maison_pos.api.recognition.enroll', {
    embeddings: JSON.stringify([vec(2), vec(3), vec(4)]), model: set.recognition_model, boutique: L.STORE, device_id: `QA4-${TAG}`,
    consent: JSON.stringify({}), name: `QA4 Recog ${TAG}`, phone: '9185550999'
  })
  record('C · no biometric enrolment is possible without a consent record', noConsent.status !== 200, `${noConsent.status} ${String(noConsent.body?.exception || '').slice(0, 140)}`)
  const oldVersion = await assoc.rawPost('maison_pos.api.recognition.enroll', {
    embeddings: JSON.stringify([vec(2), vec(3), vec(4)]), model: set.recognition_model, boutique: L.STORE, device_id: `QA4-${TAG}`,
    consent: JSON.stringify({ method: 'Hold-to-agree', text_version: '2020-01-1' }), name: `QA4 Recog ${TAG}`, phone: '9185550999'
  })
  record('C · a consent captured against an outdated text version is refused', oldVersion.status !== 200, `${oldVersion.status} ${String(oldVersion.body?.exception || '').slice(0, 140)}`)
  const badMethod = await assoc.rawPost('maison_pos.api.recognition.enroll', {
    embeddings: JSON.stringify([vec(2)]), model: set.recognition_model, boutique: L.STORE, device_id: `QA4-${TAG}`,
    consent: JSON.stringify({ method: 'Verbal', text_version: set.consent_text_version }), name: `QA4 Recog ${TAG}`, phone: '9185550999'
  })
  record('C · only the recorded consent methods are accepted', badMethod.status !== 200, `${badMethod.status} ${String(badMethod.body?.exception || '').slice(0, 120)}`)
  record('C · none of the refused attempts created a client or a template',
    (await admin.list('Customer', { customer_name: `QA4 Recog ${TAG}` }, ['name'], 5)).length === 0 && (await admin.list('AWANZ Face Template', {}, ['name'], 5).catch(() => [])).length === 0)

  // a consented enrolment
  const ok = await assoc.post('maison_pos.api.recognition.enroll', {
    embeddings: JSON.stringify([vec(2), vec(3), vec(4)]), model: set.recognition_model, boutique: L.STORE, device_id: `QA4-${TAG}`,
    consent: JSON.stringify({ method: 'Hold-to-agree', text_version: set.consent_text_version }),
    name: `QA4 Recog ${TAG}`, phone: '9185550999', email: `qa4.recog.${TAG.toLowerCase()}@example.com`
  })
  created.customers.push(ok.customer); created.consents.push(ok.consent)
  record('C · a consented enrolment stores the consent and the templates', ok.template_count === 3 && !!ok.consent, JSON.stringify({ customer: ok.customer, consent: ok.consent, templates: ok.template_count, created: ok.created }))
  const consentDoc = await admin.doc('AWANZ Biometric Consent', ok.consent)
  record('C · the consent record snapshots the wording, method, store and device', consentDoc.status === 'Active' && consentDoc.method === 'Hold-to-agree' && consentDoc.boutique === L.STORE && !!consentDoc.consent_text,
    `${consentDoc.status} ${consentDoc.method} v${consentDoc.consent_text_version} @${consentDoc.boutique} device=${consentDoc.device_id} ip=${consentDoc.ip ? 'set' : 'none'}`)
  const tpls = await admin.list('AWANZ Face Template', { parent: ok.customer }, ['name'], 10, 'creation asc').catch(() => [])
  const tplDoc = await admin.doc('Customer', ok.customer)
  const tplRows = tplDoc.maison_face_templates || []
  record('C · templates are vectors only — no image is stored', tplRows.length === 3 && tplRows.every((t) => !!t.embedding && !t.image && !t.photo),
    JSON.stringify(tplRows.map((t) => ({ dims: JSON.parse(t.embedding || '[]').length, keys: Object.keys(t).filter((k) => /image|photo|file/i.test(k)) }))).slice(0, 200))
  const status = await assoc.get('maison_pos.api.recognition.status', { customer: ok.customer })
  record('C · the client screen reports the enrolment status', Number(status.face_consent) === 1 && !!status.face_consent_at, JSON.stringify(status).slice(0, 220))
  const matched = await assoc.post('maison_pos.api.recognition.match', { embedding: JSON.stringify(vec(2)), model: set.recognition_model, boutique: L.STORE, device_id: `QA4-${TAG}` })
  record('C · an enrolled client is matched by their own template', (matched.matches || [])[0]?.customer === ok.customer && matched.best_distance < matched.threshold_distance,
    `matches=${(matched.matches || []).length} best_distance=${matched.best_distance} threshold=${matched.threshold_distance}`)
  const noMatch = await assoc.post('maison_pos.api.recognition.match', { embedding: JSON.stringify(far(vec(2))), model: set.recognition_model, boutique: L.STORE, device_id: `QA4-${TAG}` })
  record('C · a face outside the threshold is not matched (no identity leaked)', (noMatch.matches || []).length === 0 && noMatch.best_distance > noMatch.threshold_distance,
    `matches=${(noMatch.matches || []).length} best_distance=${noMatch.best_distance} threshold=${noMatch.threshold_distance}`)

  // decline
  const declined = await assoc.post('maison_pos.api.recognition.decline', { boutique: L.STORE, device_id: `QA4-${TAG}`, name: `QA4 Declined ${TAG}`, phone: '9185550998' })
  created.customers.push(declined.customer)
  const dCust = await admin.value('Customer', declined.customer, ['maison_face_consent'])
  const dTpl = await admin.doc('Customer', declined.customer)
  record('C · "No thanks" still creates the client but stores no biometrics', !Number(dCust.maison_face_consent) && (dTpl.maison_face_templates || []).length === 0,
    `customer=${declined.customer} consent=${dCust.maison_face_consent} templates=${(dTpl.maison_face_templates || []).length}`)
  const ev = await admin.list('AWANZ Recognition Event', { customer: declined.customer }, ['name', 'outcome'], 5).catch(() => [])
  record('C · the decline is logged as an event', ev.some((e) => e.outcome === 'Declined'), JSON.stringify(ev))

  // revoke
  const rev = await mgr.post('maison_pos.api.recognition.revoke', { customer: ok.customer, reason: `QA4 ${TAG} cleanup`, boutique: L.STORE, device_id: `QA4-${TAG}` })
  const afterRev = await admin.doc('Customer', ok.customer)
  const consentAfter = await admin.value('AWANZ Biometric Consent', ok.consent, ['status', 'revoked_by', 'revoked_at', 'revoke_reason'])
  const evR = await admin.list('AWANZ Recognition Event', { customer: ok.customer }, ['name', 'outcome'], 10).catch(() => [])
  record('C · a manager can revoke: templates purged, consent Revoked, event logged',
    (afterRev.maison_face_templates || []).length === 0 && !Number(afterRev.maison_face_consent) && consentAfter.status === 'Revoked' && evR.some((e) => e.outcome === 'Revoked'),
    `templates=${(afterRev.maison_face_templates || []).length} consent=${consentAfter.status} by=${consentAfter.revoked_by} at=${consentAfter.revoked_at} events=${JSON.stringify(evR.map((e) => e.outcome))}`)
  const listAfter = await assoc.get('maison_pos.api.recognition.templates', { boutique: L.STORE })
  record('C · the revoked client is gone from the device template list', !(listAfter.templates || listAfter.rows || []).some((t) => t.customer === ok.customer), `${JSON.stringify(listAfter).slice(0, 140)}`)
} finally {
  // ---------- 3. restore
  await admin.post('frappe.client.set_value', { doctype: 'AWANZ Store', name: L.STORE, fieldname: 'face_recognition_enabled', value: storeOverrideBefore })
  const back = await admin.value('AWANZ Store', L.STORE, ['face_recognition_enabled'])
  const glob = await admin.value('AWANZ POS Settings', 'AWANZ POS Settings', ['face_recognition_enabled'])
  const still = await admin.list('Customer', { maison_face_consent: 1 }, ['name'], 10)
  record('C · the store override and the global switch are back to their original values',
    (back.face_recognition_enabled || 'Inherit') === storeOverrideBefore && !Number(glob.face_recognition_enabled) && still.length === 0,
    `${L.STORE}=${back.face_recognition_enabled || 'Inherit'} (was ${storeOverrideBefore}) · global=${glob.face_recognition_enabled} · consented clients=${still.length}`)
}
fs.writeFileSync(new URL('./created-s12.json', import.meta.url), JSON.stringify({ TAG, created }, null, 2))
L.writeResults('results-s12.json', { created })
