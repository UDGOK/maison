// AWANZ POS v0.3 end-to-end run — cloud variant (Frappe Cloud site). Client recognition with Chromium's fake
// camera fed the synthetic-face videos in frontend/e2e-assets/ (real on-device detection; the
// `window.__awanzRecognitionTest` hook is only a fallback when the detector never sees a face — every check
// reports whether it ran "real" or via the hook).
//
// Run:  BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
//       BASE=https://maison-demo.frappe.cloud ADMIN_SID=$(cat /tmp/sid) ADMIN_CSRF=$(cat /tmp/csrf) \
//       PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node e2e/pos.v03.cloud.e2e.mjs
// Env:  BASE, ADMIN_SID (Administrator session cookie), ADMIN_CSRF (token scraped from /app/home; needed for the
//       settings POSTs), ASSOC_USER/ASSOC_PWD, MANAGER_USER/MANAGER_PWD (revoke/purge via /api/method/login + CSRF),
//       SHOTS_DIR (default cloud-shots-v03), RESULTS (default results.v03.cloud.json), BRIDGE=1 (cloud-bridge.mjs),
//       KEEP_ENABLED=1 (skip switching recognition off at the end).
//
// Differences vs. the bench script (pos.v03.e2e.mjs): Administrator via sid cookie (+ CSRF for set_value), test
// enrolments are revoked by the MANAGER (recognition.revoke) instead of Administrator, the bridge is installed on
// every browser context (including the fake-camera ones), offline is simulated through the bridge, and three cloud
// checks were added: model weights load with HTTP 200 from /assets/maison_pos/pos/models/*, the service-worker
// precache holds those entries, and the verdicts were produced by the real detector (not the hook).
import { chromium, request } from 'playwright'
import { installBridge } from './cloud-bridge.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, process.env.SHOTS_DIR || 'cloud-shots-v03')
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })
const ASSETS = path.resolve(__dirname, '../frontend/e2e-assets')
const FACE_A = path.join(ASSETS, 'face_a.mjpeg')
const FACE_B = path.join(ASSETS, 'face_b.mjpeg')

const BASE = process.env.BASE || 'https://maison-demo.frappe.cloud'
const HOST = new URL(BASE).hostname
const BRIDGE = process.env.BRIDGE === '1'
const ADMIN_SID = process.env.ADMIN_SID || ''
const ADMIN_CSRF = process.env.ADMIN_CSRF || ''
const BOUTIQUE = 'CHI-OAK'
const ASSOC = { usr: process.env.ASSOC_USER || 'chi.oak.a1@maison.example', pwd: process.env.ASSOC_PWD || 'maison123', pin: '2580' }
const MANAGER = { usr: process.env.MANAGER_USER || 'chi.oak.manager@maison.example', pwd: process.env.MANAGER_PWD || 'maison123', pin: '1234' }
const MODEL = 'face-api/faceRecognitionNet@1'
const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json', 'tiny_face_detector_model.bin',
  'face_landmark_68_tiny_model-weights_manifest.json', 'face_landmark_68_tiny_model.bin',
  'face_recognition_model-weights_manifest.json', 'face_recognition_model.bin'
]
const RUN = Date.now().toString(36).slice(-5).toUpperCase()
const PHONE_A = `+1 312 555 ${String(1000 + (Date.now() % 9000)).slice(-4)}`
const PHONE_OFF = `+1 773 555 ${String(1000 + ((Date.now() + 4321) % 9000)).slice(-4)}`
const EMAIL_B = `theo.${RUN.toLowerCase()}@example.com`
const NAME_A = `Nadia Okafor ${RUN}`
const NAME_B = `Theo Brandt ${RUN}`
const NAME_OFF = `Offline Client ${RUN}`

const results = []
const consoleLog = []
let shotN = 0
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(page, name) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.waitForTimeout(250)
  await page.screenshot({ path: f, fullPage: false })
  log('  shot', path.basename(f))
  return f
}
function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()) && !/fonts\.(googleapis|gstatic)|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|ERR_CONNECTION_RESET/.test(m.text())) consoleLog.push({ tag, type: m.type(), text: m.text().slice(0, 300) })
  })
  page.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e.stack || e).slice(0, 400) }))
}

// ---- API helpers ----------------------------------------------------------------------
const adminStorageState = () => ({
  cookies: [{ name: 'sid', value: ADMIN_SID, domain: HOST, path: '/', expires: -1, httpOnly: true, secure: BASE.startsWith('https'), sameSite: 'Lax' }],
  origins: []
})
function wrap(ctx, headers) {
  const api = {
    ctx,
    async get(method, params = {}) {
      const r = await ctx.get(`/api/method/${method}`, { params })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.post(`/api/method/${method}`, { data, headers })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    setValue: (doctype, name, fieldname, value) => api.post('frappe.client.set_value', { doctype, name, fieldname, value }),
    list: (doctype, filters, fields = ['name'], limit = 50) => api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit, order_by: 'creation desc' }),
    events: (customer, outcome) => api.list('AWANZ Recognition Event', { customer, outcome }, ['name', 'outcome', 'score', 'boutique', 'device_id', 'ts']),
    customerByPhone: async (phone) => (await api.get('maison_pos.api.customers.search', { q: phone.replace(/\D/g, '').slice(-7), limit: 20 })).find((c) => (c.mobile_no || '').replace(/\D/g, '').endsWith(phone.replace(/\D/g, '').slice(-7))) || null,
    customerByEmail: async (email) => (await api.list('Customer', { email_id: email }, ['name', 'customer_name', 'maison_face_consent', 'maison_client_number']))[0] || null,
    status: (customer) => api.get('maison_pos.api.recognition.status', { customer }),
    templateCount: async (customer) => (await api.status(customer)).templates,
    templateRows: async (customer) => (await api.get('maison_pos.api.recognition.templates', { boutique: BOUTIQUE })).templates.filter((t) => t.customer === customer),
    dispose: () => ctx.dispose()
  }
  return api
}
async function adminApi() {
  if (!ADMIN_SID) throw new Error('ADMIN_SID required')
  const ctx = await request.newContext({ baseURL: BASE, storageState: adminStorageState() })
  const who = await ctx.get('/api/method/frappe.auth.get_logged_user')
  const j = await who.json().catch(() => ({}))
  if (!who.ok() || j.message !== 'Administrator') throw new Error(`ADMIN_SID is not a valid Administrator session (${who.status()} ${JSON.stringify(j).slice(0, 200)})`)
  let csrf = ADMIN_CSRF
  if (!csrf) {
    const home = await ctx.get('/app/home', { maxRedirects: 5 })
    csrf = (await home.text()).match(/csrf_token[^"]*"([0-9a-f]{20,})"/)?.[1] || ''
  }
  return wrap(ctx, { 'X-Frappe-CSRF-Token': csrf })
}
async function managerApi() {
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.post('/api/method/login', { data: { usr: MANAGER.usr, pwd: MANAGER.pwd } })
  if (!r.ok()) throw new Error(`manager login failed ${r.status()}`)
  const pos = await ctx.get('/pos/', { maxRedirects: 5 })
  const csrf = (await pos.text()).match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
  return wrap(ctx, { 'X-Frappe-CSRF-Token': csrf })
}

// ---- POS helpers ------------------------------------------------------------------
function launch(video) {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  if (video && fs.existsSync(video)) args.push(`--use-file-for-fake-video-capture=${video}`)
  return chromium.launch({ headless: true, args })
}

/** Context with bridge, camera permission and associate/manager login; tracks model-file responses. */
async function posContext(browser, user, tag, offlineRef = { v: false }) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, baseURL: BASE, permissions: ['camera'], colorScheme: 'dark' })
  if (BRIDGE) await installBridge(context, { isOffline: () => offlineRef.v })
  const login = await context.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!login.ok()) throw new Error(`${user.usr} login failed ${login.status()}`)
  const page = await context.newPage()
  wireConsole(page, tag)
  const modelResponses = []
  page.on('response', (r) => {
    if (/\/assets\/maison_pos\/pos\/models\//.test(r.url())) modelResponses.push({ url: r.url().split('/models/')[1], status: r.status(), fromSW: r.fromServiceWorker(), type: r.headers()['content-type'] })
  })
  return { context, page, modelResponses }
}

async function freshDevice(page) {
  await page.goto('/pos/unlock')
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('awanzE2E', '1')
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
  })
}

async function unlock(page, user) {
  await page.goto('/pos')
  await page.waitForSelector('.unlock select.input', { timeout: 20000 })
  await page.selectOption('.unlock select.input >> nth=0', BOUTIQUE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 30000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))
  const assoc = opts.find((o) => o.v === user.usr)
  if (!assoc) throw new Error(`${user.usr} not in the associate list: ${opts.map((o) => o.v).join(', ')}`)
  await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  for (const d of user.pin) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 15000 })
  await page.waitForSelector('.tile', { timeout: 15000 })
}

const tileState = (page) => page.evaluate(() => window.__awanzRecognitionTest?.state())
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))
const attachedName = (page) => page.evaluate(() => document.querySelector('.basket .client-name')?.textContent.trim())

async function waitTile(page, states, timeout = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const s = await tileState(page)
    if (s && states.includes(s.tile)) return s
    await page.waitForTimeout(250)
  }
  return null
}

const FAKE_EMBEDDING = Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.37 + 1) * 0.19)
let hookUsed = 0

async function waitVerdict(page, timeout = 60000) {
  let s = await waitTile(page, ['new', 'recognised'], timeout)
  const real = !!s
  if (!s) {
    hookUsed++
    await page.evaluate((e) => window.__awanzRecognitionTest.emit({ embedding: e, quality: 0.9 }), FAKE_EMBEDDING)
    s = await waitTile(page, ['new', 'recognised'], 10000)
  }
  return { state: s, real }
}

async function holdAgree(page, ms = 800) {
  const el = page.locator('[data-testid=consent-agree]')
  const box = await el.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(ms)
  await page.mouse.up()
}

async function ensureCapture(page) {
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    const s = await tileState(page)
    if (!s?.enrolOpen || s.enrolStep === 'saving' || s.enrolStep === 'done') return true
    await page.waitForTimeout(300)
  }
  hookUsed++
  await page.evaluate((e) => window.__awanzRecognitionTest.samples([{ embedding: e }, { embedding: e }, { embedding: e }]), FAKE_EMBEDDING)
  return false
}

async function waitEnrolClosed(page, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms && (await tileState(page))?.enrolOpen) await page.waitForTimeout(250)
  return !(await tileState(page))?.enrolOpen
}

async function enrolFlow(page, { phone, email, name }) {
  await page.click('[data-testid=recognition-enrol]')
  await page.waitForSelector('[data-testid=enrol-sheet]')
  if (phone) await page.fill('#enrol-phone', phone)
  if (email) await page.fill('#enrol-email', email)
  if (name) await page.fill('#enrol-name', name)
  await page.waitForTimeout(300)
  await page.click('[data-testid=enrol-continue]')
  await page.waitForSelector('[data-testid=consent-screen]')
}

/** Service-worker precache inspection (runs in the page; the SW cache is origin-scoped). */
const swPrecache = (page) => page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations()
  const names = await caches.keys()
  const out = { regs: regs.map((r) => ({ scope: r.scope, state: (r.active || r.waiting || r.installing)?.state })), caches: {} }
  for (const n of names) {
    const keys = await (await caches.open(n)).keys()
    out.caches[n] = keys.map((k) => k.url.replace(location.origin, ''))
  }
  return out
})

// ====================================================================================
const admin = await adminApi()
let manager = null
try { manager = await managerApi() } catch (e) { record('manager login + CSRF (for revoke)', false, String(e)) }
const dist = (m) => (typeof m?.distance === 'number' ? m.distance.toFixed(3) : '?')
const created = []

// 0. Recognition on for CHI-OAK; nothing enrolled; dashboard counters
let before
try {
  await admin.setValue('AWANZ POS Settings', 'AWANZ POS Settings', 'face_recognition_enabled', 1)
  const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: BOUTIQUE })
  const s = boot.settings
  record('recognition enabled for CHI-OAK on the cloud site (Administrator sid + CSRF)', s.face_recognition_enabled === 1 && s.match_distance_threshold === 0.6 && s.recognition_model === MODEL,
    `face_recognition_enabled=${s.face_recognition_enabled} global=${s.face_recognition_global} threshold=${s.match_distance_threshold} model=${s.recognition_model} consent v${s.consent_text_version}`)
  const stale = await admin.list('Customer', { maison_face_consent: 1 }, ['name'], 100)
  record('no pre-existing consented clients on the site', stale.length === 0, `consented=${stale.length}`)
  for (const c of stale) if (manager) await manager.post('maison_pos.api.recognition.revoke', { customer: c.name, reason: 'e2e reset' })
  before = (await admin.get('maison_pos.api.dashboard.live_summary')).recognition
  record('dashboard live_summary exposes recognition counters', before && ['matched_today', 'enrolled_today', 'nomatch_today', 'declined_today', 'undone_today'].every((k) => typeof before[k] === 'number'), JSON.stringify(before))
  // model files + SW script from the cloud (request context)
  const heads = []
  for (const f of MODEL_FILES) { const r = await admin.ctx.get(`/assets/maison_pos/pos/models/${f}`); heads.push({ f, status: r.status(), len: (await r.body()).length }) }
  record('model weights served by Frappe Cloud (/assets/maison_pos/pos/models/*, HTTP 200)', heads.every((h) => h.status === 200 && h.len > 1000), heads.map((h) => `${h.f}=${h.status}/${h.len}`).join(' '))
  const sw = await (await admin.ctx.get('/api/method/maison_pos.api.pwa.service_worker')).text()
  record('service-worker precache manifest lists the model files + wasm backends', MODEL_FILES.every((f) => sw.includes(`models/${f}`)) && /models\/wasm\/tfjs-backend-wasm-simd\.wasm/.test(sw), `sw.js ${sw.length} bytes`)
} catch (e) {
  record('recognition enabled for CHI-OAK on the cloud site (Administrator sid + CSRF)', false, String(e))
}

// ---------------------------------------------------------------------------------
// 1. Face A — Looking → New client → enrol (hold-to-agree) → server verification → Recognised → Undo
let customerA = null
{
  const browser = await launch(FACE_A)
  const { context, page, modelResponses } = await posContext(browser, ASSOC, 'faceA')
  try {
    await freshDevice(page)
    await unlock(page, ASSOC)
    const looking = await waitTile(page, ['looking', 'new', 'recognised'], 60000)
    record('tile reaches Looking (camera + models loaded from the cloud)', !!looking, `tile=${looking?.tile} cached=${looking?.cached}`)
    await shot(page, 'tile-looking')
    const backend = await page.evaluate(() => window.__awanzRecognitionTest?.state()?.backend ?? null)
    const mr = modelResponses
    record('model weights fetched by the browser with HTTP 200 from /assets/maison_pos/pos/models/', MODEL_FILES.every((f) => mr.some((r) => r.url === f && r.status === 200)), `${mr.map((r) => `${r.url}:${r.status}${r.fromSW ? '(sw)' : ''}`).join(' ')} backend=${backend}`)

    const v1 = await waitVerdict(page)
    const chip = await page.evaluate(() => document.querySelector('[data-testid=recognition-state]')?.textContent.trim())
    record('first verdict is New client (no consented templates) — REAL detector', v1.state?.tile === 'new' && v1.real, `${v1.real ? 'real on-device detection' : 'via test hook'} · chip "${chip}" · last=${JSON.stringify(v1.state?.last)}`)
    await shot(page, 'tile-new-client')

    await enrolFlow(page, { phone: PHONE_A, name: NAME_A })
    await shot(page, 'consent-screen')
    await holdAgree(page, 200)
    await page.waitForTimeout(300)
    record('short press (200 ms) does not agree', !!(await page.$('[data-testid=consent-agree]')))
    await holdAgree(page, 800)
    const capture = await page.waitForSelector('[data-testid=capture-progress]', { timeout: 5000 }).catch(() => null)
    record('hold-to-agree 800 ms → capture step', !!capture)
    await shot(page, 'capture')
    const realCapture = await ensureCapture(page)
    const closed = await waitEnrolClosed(page)
    const attached = await attachedName(page)
    record('enrolment completed and client attached to the sale — REAL captures', closed && attached === NAME_A && realCapture, `${realCapture ? '3 real captures' : 'samples via hook'} · attached "${attached}"`)
    await dismissNotices(page)
    await shot(page, 'enrolled-attached')

    customerA = await admin.customerByPhone(PHONE_A)
    if (customerA) created.push(customerA.name)
    record('server: Customer created by phone', !!customerA && customerA.customer_name === NAME_A && /^MC\d{6}$/.test(customerA.client_number || ''), customerA ? `${customerA.name} ${customerA.client_number} consent=${customerA.maison_face_consent}` : 'not found')
    if (customerA) {
      const st = await admin.status(customerA.name)
      record('server: Active consent (Hold-to-agree, current text version)', st.face_consent === 1 && st.consent?.method === 'Hold-to-agree' && st.consent?.consent_text_version && st.consent?.boutique === BOUTIQUE, JSON.stringify(st.consent))
      const tpls = await admin.templateRows(customerA.name)
      const norms = tpls.map((t) => Math.hypot(...t.embedding))
      record('server: 3 face templates (128-d raw descriptors, no images)', st.templates === 3 && tpls.length === 3 && tpls.every((t) => t.dims === 128 && t.model === MODEL && t.embedding.length === 128) && norms.every((n) => n > 1.05) && !JSON.stringify(tpls).includes('data:image'),
        `status.templates=${st.templates} rows=${tpls.length} ‖d‖=${norms.map((n) => n.toFixed(2)).join('/')}`)
      const enrolled = await admin.events(customerA.name, 'Enrolled')
      record('server: Recognition Event Enrolled logged', enrolled.length >= 1 && enrolled[0].boutique === BOUTIQUE, enrolled[0] ? `${enrolled[0].name} device=${enrolled[0].device_id}` : 'none')
    }

    // reload → Recognised (models should now come from the SW precache)
    modelResponses.length = 0
    await page.reload()
    await page.waitForSelector('[data-testid=recognition-tile]', { timeout: 30000 })
    const v2 = await waitVerdict(page)
    const rec = v2.state?.recognised
    const th = v2.state?.last?.threshold
    const expectedScore = rec ? Math.max(0, Math.min(1, 1 - rec.distance / 1.2)) : NaN
    record('same face after reload → Recognised (euclidean distance < threshold) — REAL detector', v2.real && v2.state?.tile === 'recognised' && rec?.customer === customerA?.name && typeof rec?.distance === 'number' && rec.distance < 0.6 && rec.distance < (th ?? 0.6),
      `${v2.real ? 'real detection' : 'hook'} · ${rec?.customer_name} d=${dist(rec)} score=${rec?.score} threshold=${th} source=${v2.state?.last?.source} local d=${v2.state?.last?.localDistance?.toFixed?.(3)} server d=${v2.state?.last?.serverDistance?.toFixed?.(3)}`)
    record('score is the display mapping 1 − d/1.2 (rounded)', rec && Math.abs(rec.score - expectedScore) < 0.002, `score=${rec?.score} expected=${expectedScore.toFixed(3)}`)
    const chip2 = await page.evaluate(() => document.querySelector('[data-testid=recognition-state]')?.textContent.trim())
    record('chip shows "Recognised · nn %"', /Recognised/.test(chip2 || '') && /\d+\s*%/.test(chip2 || ''), chip2)
    await shot(page, 'tile-recognised')
    const pc = await swPrecache(page)
    const precache = Object.entries(pc.caches).find(([n]) => /precache/.test(n))
    const cachedModels = precache ? MODEL_FILES.filter((f) => precache[1].some((u) => u.includes(`/models/${f}`))) : []
    record('SW registered on the cloud and its precache holds all model weights', pc.regs.length === 1 && pc.regs[0].state === 'activated' && cachedModels.length === MODEL_FILES.length,
      `regs=${JSON.stringify(pc.regs)} precache=${precache?.[0]} entries=${precache?.[1].length} models cached=${cachedModels.length}/${MODEL_FILES.length} wasm=${precache?.[1].filter((u) => /\.wasm(\?|$)/.test(u)).length}; reload fetches: ${modelResponses.map((r) => `${r.url}:${r.status}${r.fromSW ? '(sw)' : ''}`).join(' ') || 'none (no refetch)'}`)
    const undoBtn = await page.$('[data-testid=recognition-undo]')
    record('Undo offered within 5 s', !!undoBtn)
    if (undoBtn) await undoBtn.click()
    await page.waitForTimeout(800)
    const afterUndo = await attachedName(page)
    record('Undo detaches the client', afterUndo === 'Walk-in', afterUndo)
    await shot(page, 'after-undo')
    if (customerA) {
      await sleep(1000)
      const matched = await admin.events(customerA.name, 'Matched')
      const undone = await admin.events(customerA.name, 'Undone')
      record('server: Matched + Undone events logged', matched.length >= 1 && undone.length >= 1, `matched=${matched.length} (score ${matched[0]?.score}) undone=${undone.length}`)
    }
  } catch (e) {
    record('face A flow', false, String(e.stack || e))
    await shot(page, 'faceA-error').catch(() => {})
  }
  await context.close()
  await browser.close()
}

// ---------------------------------------------------------------------------------
// 2. Face B against A's templates → no match → decline creates the customer without biometrics
let customerB = null
{
  const browser = await launch(FACE_B)
  const { context, page } = await posContext(browser, ASSOC, 'faceB')
  try {
    await freshDevice(page)
    await unlock(page, ASSOC)
    const v = await waitVerdict(page)
    const last = v.state?.last
    record("different face (B) against A's templates → New client (no false match) — REAL detector", v.real && v.state?.tile === 'new' && !v.state?.recognised,
      `${v.real ? 'real detection' : 'hook'} · cached=${v.state?.cached} · local d=${last?.localDistance?.toFixed?.(3)} server d=${last?.serverDistance?.toFixed?.(3)} threshold=${last?.threshold}`)
    await shot(page, 'faceB-new-client')
    await enrolFlow(page, { email: EMAIL_B, name: NAME_B })
    await page.click('[data-testid=consent-decline]')
    await page.waitForSelector('[data-testid=consent-screen]', { state: 'detached', timeout: 10000 })
    await page.waitForTimeout(800)
    const attached = await attachedName(page)
    customerB = await admin.customerByEmail(EMAIL_B)
    if (customerB) created.push(customerB.name)
    const tplB = customerB ? await admin.templateCount(customerB.name) : -1
    const consentsB = customerB ? await admin.list('AWANZ Biometric Consent', { customer: customerB.name }) : []
    record('decline: client created + attached WITHOUT biometrics', attached === NAME_B && customerB && !customerB.maison_face_consent && tplB === 0 && consentsB.length === 0,
      `attached "${attached}" · ${customerB?.name} consent=${customerB?.maison_face_consent} templates=${tplB} consents=${consentsB.length}`)
    const declined = customerB ? await admin.events(customerB.name, 'Declined') : []
    record('server: Recognition Event Declined logged', declined.length >= 1, declined[0]?.name)
    await dismissNotices(page)
    await shot(page, 'declined-attached')
  } catch (e) {
    record('face B flow', false, String(e.stack || e))
    await shot(page, 'faceB-error').catch(() => {})
  }
  await context.close()
  await browser.close()
}

// ---------------------------------------------------------------------------------
// 3. Manager revoke from the Client screen → purge verified server-side
{
  const browser = await launch(FACE_B)
  const { context, page } = await posContext(browser, MANAGER, 'manager')
  try {
    await freshDevice(page)
    await unlock(page, MANAGER)
    await page.goto('/pos/client')
    await page.waitForSelector('.toolbar input', { timeout: 20000 })
    await page.fill('.toolbar input', NAME_A)
    await page.waitForSelector(`.crow:has-text("${NAME_A}")`, { timeout: 15000 })
    await page.click(`.crow:has-text("${NAME_A}")`)
    await page.waitForSelector('[data-testid=biometric-status]', { timeout: 10000 })
    const bio = await page.evaluate(() => document.querySelector('[data-testid=biometric-status]')?.textContent.replace(/\s+/g, ' ').trim())
    record('client screen shows "Face recognition: enrolled <date>" with manager Delete', /enrolled \w+ \d/.test(bio || '') && !!(await page.$('[data-testid=biometric-revoke]')), bio)
    await shot(page, 'client-biometric-status')
    await page.click('[data-testid=biometric-revoke]')
    await page.waitForSelector('[data-testid=biometric-revoke-confirm]')
    await shot(page, 'client-revoke-modal')
    await page.click('[data-testid=biometric-revoke-confirm]')
    await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 })
    await page.waitForTimeout(600)
    const bio2 = await page.evaluate(() => document.querySelector('[data-testid=biometric-status]')?.textContent.replace(/\s+/g, ' ').trim())
    record('after revoke the client screen shows not enrolled', /not enrolled/.test(bio2 || ''), bio2)
    if (customerA) {
      const st = await admin.status(customerA.name)
      const tpl = await admin.templateCount(customerA.name)
      const consents = await admin.list('AWANZ Biometric Consent', { customer: customerA.name }, ['name', 'status', 'revoked_by', 'revoke_reason'])
      const revoked = await admin.events(customerA.name, 'Revoked')
      record('server: templates purged, consent Revoked, flags cleared, Revoked event', tpl === 0 && st.face_consent === 0 && !st.consent && consents.length >= 1 && consents.every((c) => c.status === 'Revoked') && revoked.length >= 1,
        `templates=${tpl} face_consent=${st.face_consent} consents=${consents.map((c) => `${c.status}/${c.revoked_by}`).join(',')} revoked_events=${revoked.length}`)
      const tl = await admin.get('maison_pos.api.recognition.templates', { boutique: BOUTIQUE })
      record('server: recognition.templates no longer lists the client', !tl.templates.some((t) => t.customer === customerA.name) && tl.threshold_distance === 0.6, `rows=${tl.templates.length}`)
    }
    const cached = (await tileState(page))?.cached
    record('local template cache emptied after revoke', cached === 0, `cached=${cached}`)
    await dismissNotices(page)
    await shot(page, 'client-revoked')
  } catch (e) {
    record('manager revoke flow', false, String(e.stack || e))
    await shot(page, 'manager-error').catch(() => {})
  }
  await context.close()
  await browser.close()
}

// ---------------------------------------------------------------------------------
// 4. Offline enrolment queues (provisional client) and replays on reconnect (offline simulated through the bridge)
let customerOff = null
{
  const browser = await launch(FACE_A)
  const offlineRef = { v: false }
  const { context, page } = await posContext(browser, ASSOC, 'offline', offlineRef)
  try {
    await freshDevice(page)
    await unlock(page, ASSOC)
    await waitTile(page, ['looking', 'new', 'recognised'], 60000)
    offlineRef.v = true
    await context.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await page.waitForFunction(() => /Offline/.test(document.querySelector('.topbar .status')?.textContent || ''), null, { timeout: 30000 })
    const v = await waitVerdict(page)
    record('offline: detector still runs and reports New client (local cache only)', v.state?.tile === 'new', `${v.real ? 'real detection' : 'hook'} · source=${v.state?.last?.source}`)
    await enrolFlow(page, { phone: PHONE_OFF, name: NAME_OFF })
    await holdAgree(page, 800)
    await page.waitForSelector('[data-testid=capture-progress]', { timeout: 5000 })
    const realCapture = await ensureCapture(page)
    const closed = await waitEnrolClosed(page)
    const st = await tileState(page)
    const attached = await attachedName(page)
    record('offline: enrolment queued in pending_enrolments, provisional client attached', closed && st?.pending === 1 && attached === NAME_OFF, `${realCapture ? 'real captures' : 'hook samples'} · pending=${st?.pending} attached "${attached}"`)
    await shot(page, 'offline-enrolment-queued')
    const notYet = await admin.customerByPhone(PHONE_OFF)
    record('server: nothing created while offline', !notYet, notYet ? notYet.name : 'no customer')

    offlineRef.v = false
    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    const t0 = Date.now()
    let pending = 1
    while (Date.now() - t0 < 60000) {
      pending = (await tileState(page))?.pending ?? 1
      if (pending === 0) break
      await page.waitForTimeout(1000)
    }
    await page.waitForTimeout(1500)
    customerOff = await admin.customerByPhone(PHONE_OFF)
    if (customerOff) created.push(customerOff.name)
    const tpl = customerOff ? await admin.templateCount(customerOff.name) : -1
    const stOff = customerOff ? await admin.status(customerOff.name) : null
    const attached2 = await attachedName(page)
    record('reconnect: queue replayed → Customer + consent + 3 templates server-side; real client swapped onto the basket', pending === 0 && customerOff && tpl === 3 && stOff?.face_consent === 1 && stOff?.consent?.method === 'Hold-to-agree' && attached2 === NAME_OFF,
      `pending=${pending} ${customerOff?.name} templates=${tpl} consent=${stOff?.consent?.name} attached "${attached2}" after ${Math.round((Date.now() - t0) / 1000)}s`)
    await dismissNotices(page)
    await shot(page, 'offline-enrolment-replayed')
  } catch (e) {
    record('offline enrolment flow', false, String(e.stack || e))
    await shot(page, 'offline-error').catch(() => {})
  }
  await context.close()
  await browser.close()
}

// ---------------------------------------------------------------------------------
// 5. Dashboard counters, cleanup (manager revoke), recognition off again
try {
  const after = (await admin.get('maison_pos.api.dashboard.live_summary')).recognition
  const d = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before?.[k] ?? 0)]))
  record('dashboard live_summary.recognition counters incremented', d.enrolled_today >= 2 && d.matched_today >= 1 && d.undone_today >= 1 && d.declined_today >= 1 && d.nomatch_today >= 1, `delta ${JSON.stringify(d)} · now ${JSON.stringify(after)}`)
} catch (e) {
  record('dashboard live_summary.recognition counters incremented', false, String(e))
}
record('all verdicts/captures came from the real detector (hook never used)', hookUsed === 0, `hook fallbacks=${hookUsed}`)
try {
  const still = await admin.list('Customer', { maison_face_consent: 1 }, ['name'], 100)
  for (const c of still) await manager.post('maison_pos.api.recognition.revoke', { customer: c.name, reason: 'e2e cleanup (cloud)' })
  const remaining = await admin.list('Customer', { maison_face_consent: 1 }, ['name'], 100)
  const tl = await admin.get('maison_pos.api.recognition.templates', { boutique: BOUTIQUE })
  record('cleanup: manager revoked every test enrolment; no consented clients / templates remain', remaining.length === 0 && tl.templates.length === 0, `revoked=${still.map((c) => c.name).join(',')} remaining=${remaining.length} templates=${tl.templates.length}`)
} catch (e) {
  record('cleanup: manager revoked every test enrolment; no consented clients / templates remain', false, String(e))
}
if (process.env.KEEP_ENABLED !== '1') {
  try {
    await admin.setValue('AWANZ POS Settings', 'AWANZ POS Settings', 'face_recognition_enabled', 0)
    const s = (await admin.get('maison_pos.api.catalog.bootstrap', { boutique: BOUTIQUE })).settings
    record('recognition switched off again on the cloud site', s.face_recognition_enabled === 0 && s.face_recognition_global === 0, JSON.stringify({ face_recognition_enabled: s.face_recognition_enabled, global: s.face_recognition_global }))
  } catch (e) {
    record('recognition switched off again on the cloud site', false, String(e))
  }
}
await admin.dispose()
if (manager) await manager.dispose()

// ---------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
fs.writeFileSync(path.join(__dirname, process.env.RESULTS || 'results.v03.cloud.json'), JSON.stringify({ base: BASE, run: RUN, created, results, console: consoleLog }, null, 2))
log(`\n${results.length - failed.length}/${results.length} checks passed; console issues: ${consoleLog.length}; customers created: ${created.join(', ')}`)
for (const c of consoleLog.slice(0, 10)) log('  console', c.tag, c.type, c.text)
process.exit(failed.length ? 1 : 0)
