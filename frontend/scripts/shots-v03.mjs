// v0.3 client-recognition e2e + screenshots, against the mock API with Chromium's fake camera
// fed a synthetic-face video (public-domain StyleGAN portraits from Wikimedia Commons).
//
//   VITE_MOCK=1 VITE_E2E=1 npm run dev
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/shots-v03.mjs
//
// Verifies: real on-device detection → "New client" → enrol (hold-to-agree) creates customer +
// consent + 3 templates on the (mock) server → reload with the same face auto-attaches
// ("Recognised · nn%") → Undo logs Undone → a different face does NOT match → decline path creates
// the client without biometrics → manager revoke purges templates. Falls back to the
// `window.__awanzRecognitionTest` hook when the detector cannot find a face (e.g. no video file).
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5173'
const OUT = resolve(process.env.OUT || 'screenshots/v03')
mkdirSync(OUT, { recursive: true })
const FACE_A = resolve('e2e-assets/face_a.mjpeg')
const FACE_B = resolve('e2e-assets/face_b.mjpeg')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const profiles = {
  desktop: { viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 1 },
  iphone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  }
}

function launch(video) {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  if (video && existsSync(video)) args.push(`--use-file-for-fake-video-capture=${video}`)
  return chromium.launch({ args })
}

async function newPage(browser, opts, name) {
  const ctx = await browser.newContext({ ...opts, permissions: ['camera'], colorScheme: 'dark' })
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    try {
      const r = await fetch(route.request().url(), { headers: { 'user-agent': opts.userAgent || 'Mozilla/5.0 Chrome/120' } })
      route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || '' }, body: Buffer.from(await r.arrayBuffer()) })
    } catch {
      route.abort()
    }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message))
  page.on('console', (m) => m.type() === 'error' && !/ERR_FAILED|fonts/.test(m.text()) && console.log(`[${name}] console.error`, m.text().slice(0, 160)))
  return { ctx, page }
}

async function freshDevice(page, mockState) {
  await page.goto(`${BASE}/unlock`)
  await page.evaluate(async (mock) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('awanzE2E', '1')
    if (mock) localStorage.setItem('awanz.mock.state', mock)
    const dbs = (await indexedDB.databases?.()) || [{ name: 'maison_pos' }]
    await Promise.all(dbs.map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name); req.onsuccess = req.onerror = req.onblocked = () => r() })))
  }, mockState || null)
}

async function unlock(page, pin = '1234') {
  await page.goto(`${BASE}/unlock`)
  await page.waitForSelector('select.input')
  await page.selectOption('select.input', 'CHI-OAK')
  await page.click('button:has-text("Load")')
  await page.waitForSelector('.keypad', { timeout: 15000 })
  for (const k of pin) await page.click(`.keypad .key:text-is("${k}")`)
  await page.waitForURL(/\/sell/)
  await page.waitForSelector('[data-testid=recognition-tile], .summary-bar')
  await page.evaluate(() => document.fonts.ready)
}

const tileState = (page) => page.evaluate(() => window.__awanzRecognitionTest?.state())
const mockState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('awanz.mock.state') || '{}'))
const dismissNotices = (page) => page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))

async function waitTile(page, states, timeout = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const s = await tileState(page)
    if (s && states.includes(s.tile)) return s
    await page.waitForTimeout(250)
  }
  return null
}

/** Deterministic synthetic embedding for the hook fallback. */
const FAKE_EMBEDDING = Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.37 + 1) * 0.1)

/** Wait for the detector to produce a verdict; if it never sees a face, inject one via the hook. */
async function waitVerdict(page, timeout = 30000) {
  let s = await waitTile(page, ['new', 'recognised'], timeout)
  let real = !!s
  if (!s) {
    await page.evaluate((e) => window.__awanzRecognitionTest.emit({ embedding: e, quality: 0.9 }), FAKE_EMBEDDING)
    s = await waitTile(page, ['new', 'recognised'], 8000)
  }
  return { state: s, real }
}

/** Hold the Agree button for > 600 ms (pointer events). */
async function holdAgree(page, ms = 800) {
  const el = page.locator('[data-testid=consent-agree]')
  const box = await el.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(ms)
  await page.mouse.up()
}

/** If the capture step stalls (no face), feed samples through the hook. */
async function ensureCapture(page) {
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    const s = await tileState(page)
    if (!s?.enrolOpen || s.enrolStep === 'saving' || s.enrolStep === 'done') return true
    await page.waitForTimeout(300)
  }
  await page.evaluate((e) => window.__awanzRecognitionTest.samples([{ embedding: e }, { embedding: e }, { embedding: e }]), FAKE_EMBEDDING)
  return false
}

// =============================================================================================
// 1. Desktop, face A: detect → enrol → recognise → undo → client screen → revoke → settings
// =============================================================================================
let savedMock = null
{
  const browser = await launch(FACE_A)
  const { ctx, page } = await newPage(browser, profiles.desktop, 'desktop')
  const shot = async (file) => {
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(OUT, `desktop-${file}.png`) })
    console.log('desktop', file)
  }
  await freshDevice(page)
  await unlock(page)

  // Looking state (before the first verdict)
  const looking = await waitTile(page, ['looking'], 20000)
  check('tile reaches Looking (camera + model loaded)', !!looking)
  await shot('01-tile-looking')

  const v1 = await waitVerdict(page)
  check('first verdict is New client (no templates yet)', v1.state?.tile === 'new', v1.real ? 'real on-device detection' : 'via test hook')
  const backend = await page.evaluate(() => document.querySelector('[data-testid=recognition-state]')?.textContent.trim())
  console.log('   chip:', backend)
  await shot('02-tile-new-client')

  // Enrol sheet
  await page.click('[data-testid=recognition-enrol]')
  await page.waitForSelector('[data-testid=enrol-sheet]')
  await page.fill('#enrol-phone', '+1 312 555 0199')
  await page.fill('#enrol-name', 'Nadia Okafor')
  await page.waitForTimeout(400)
  await shot('03-enrol-sheet')
  await page.click('[data-testid=enrol-continue]')
  await page.waitForSelector('[data-testid=consent-screen]')
  await shot('04-consent')

  // hold-to-agree: a short press must NOT agree
  await holdAgree(page, 200)
  await page.waitForTimeout(300)
  const stillConsent = await page.$('[data-testid=consent-agree]')
  check('short press (200 ms) does not agree', !!stillConsent)
  // half-way ring shot
  const el = page.locator('[data-testid=consent-agree]')
  const b = await el.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(330)
  await page.screenshot({ path: resolve(OUT, 'desktop-05-consent-holding.png') })
  await page.waitForTimeout(500)
  await page.mouse.up()
  const capture = await page.waitForSelector('[data-testid=capture-progress]', { timeout: 5000 }).catch(() => null)
  check('hold 800 ms → capture step', !!capture)
  await page.waitForTimeout(500)
  await shot('06-capture')
  const realCapture = await ensureCapture(page)
  const t0 = Date.now()
  while (Date.now() - t0 < 15000 && (await tileState(page))?.enrolOpen) await page.waitForTimeout(250)
  const afterEnrol = await tileState(page)
  check('enrolment completed (sheet closed)', !afterEnrol.enrolOpen, realCapture ? '3 real captures' : 'samples via hook')
  let mock = await mockState(page)
  const nadia = (mock.customers || []).find((c) => c.customer_name === 'Nadia Okafor')
  check('server: customer created by phone', !!nadia, nadia?.name)
  check('server: Active consent stored (Hold-to-agree)', (mock.consents || []).some((c) => c.customer === nadia?.name && c.status === 'Active' && c.method === 'Hold-to-agree'))
  check('server: 3 templates stored, no images', (mock.templates || []).filter((t) => t.customer === nadia?.name).length === 3 && !JSON.stringify(mock.templates).includes('data:image'))
  check('server: Enrolled event logged', (mock.events || []).some((e) => e.outcome === 'Enrolled' && e.customer === nadia?.name))
  const attached = await page.evaluate(() => document.querySelector('.basket .client-name')?.textContent.trim())
  check('client attached to the sale after enrolment', attached === 'Nadia Okafor', attached)
  await page.evaluate(() => document.querySelectorAll('.notice .notice-btn:last-child').forEach((b) => b.click()))
  await shot('07-enrolled-attached')

  // Re-run with the same face: auto-attach + Undo
  await page.reload()
  await page.waitForSelector('[data-testid=recognition-tile]')
  const v2 = await waitVerdict(page)
  check('same face again → Recognised', v2.state?.tile === 'recognised', `${v2.real ? 'real detection' : 'hook'} · score ${v2.state?.recognised?.score}`)
  check('recognised the enrolled customer', v2.state?.recognised?.customer === nadia?.name)
  await page.waitForTimeout(400)
  await shot('08-tile-recognised')
  const undoBtn = await page.$('[data-testid=recognition-undo]')
  check('Undo offered within 5 s', !!undoBtn)
  if (undoBtn) await undoBtn.click()
  await page.waitForTimeout(700)
  const afterUndo = await page.evaluate(() => document.querySelector('.basket .client-name')?.textContent.trim())
  check('Undo detaches the client', afterUndo === 'Walk-in', afterUndo)
  mock = await mockState(page)
  check('server: Undone event logged', (mock.events || []).some((e) => e.outcome === 'Undone' && e.customer === nadia?.name))
  check('server: Matched event logged', (mock.events || []).some((e) => e.outcome === 'Matched' && e.customer === nadia?.name))
  savedMock = JSON.stringify(mock)

  // Client screen: biometric status + manager revoke
  await page.goto(`${BASE}/client`)
  await page.fill('.toolbar input', 'Nadia')
  await page.waitForSelector('.crow:has-text("Nadia Okafor")')
  await page.click('.crow:has-text("Nadia Okafor")')
  await page.waitForSelector('[data-testid=biometric-status]')
  const bio = await page.evaluate(() => document.querySelector('[data-testid=biometric-status]')?.textContent.replace(/\s+/g, ' ').trim())
  check('client screen shows "Face recognition: enrolled <date>"', /enrolled \w+ \d/.test(bio || ''), bio)
  await shot('09-client-biometric-status')
  await page.click('[data-testid=biometric-revoke]')
  await page.waitForSelector('[data-testid=biometric-revoke-confirm]')
  await shot('10-client-revoke-modal')
  await page.click('[data-testid=biometric-revoke-confirm]')
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 })
  await page.waitForTimeout(300)
  const bio2 = await page.evaluate(() => document.querySelector('[data-testid=biometric-status]')?.textContent.replace(/\s+/g, ' ').trim())
  check('after revoke: not enrolled', /not enrolled/.test(bio2 || ''), bio2)
  mock = await mockState(page)
  check('server: templates purged + consent Revoked', (mock.templates || []).filter((t) => t.customer === nadia?.name).length === 0 && (mock.consents || []).some((c) => c.customer === nadia?.name && c.status === 'Revoked'))
  const cached = (await tileState(page))?.cached
  check('local template cache emptied after revoke', cached === 0, `cached=${cached}`)
  await dismissNotices(page)
  await shot('11-client-revoked')

  // Settings card + test mode
  await page.goto(`${BASE}/settings`)
  await page.waitForSelector('[data-testid=recognition-test]')
  await page.evaluate(() => document.querySelector('.rec-block')?.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await shot('12-settings-recognition')
  await page.click('[data-testid=recognition-test]')
  await page.waitForSelector('[data-testid=recognition-test-panel]')
  const t1 = Date.now()
  while (Date.now() - t1 < 20000 && !(await page.$('.test-log .small:not(.dim)'))) await page.waitForTimeout(300)
  const logLine = await page.evaluate(() => document.querySelector('.test-log .small')?.textContent.trim())
  check('Settings "Test recognition" reports candidates without attaching', !!logLine && !logLine.startsWith('Waiting'), logLine)
  const dbg = await page.evaluate(() => document.querySelector('.rec .dbg')?.textContent.trim())
  console.log('   backend/fps:', dbg)
  await page.evaluate(() => document.querySelector('[data-testid=recognition-test-panel]')?.scrollIntoView({ block: 'center' }))
  await shot('13-settings-test-mode')
  await page.click('[data-testid=recognition-test]')
  await ctx.close()
  await browser.close()
}

// =============================================================================================
// 2. Desktop, face B (different person) on the server state where A is enrolled → no match; decline
// =============================================================================================
{
  // restore the server state with Nadia enrolled (before revoke): re-enrol via mock seed instead
  const browser = await launch(FACE_B)
  const { ctx, page } = await newPage(browser, profiles.desktop, 'faceB')
  await freshDevice(page, savedMock)
  await unlock(page)
  // A's templates were revoked in step 1; re-seed them from the saved state through the hook so B is tested against A
  const saved = JSON.parse(savedMock || '{}')
  const nadia = (saved.customers || []).find((c) => c.customer_name === 'Nadia Okafor')
  const aTemplates = (saved.templates || []).filter((t) => t.customer === nadia?.name)
  if (aTemplates.length) {
    await page.evaluate((list) => window.__awanzRecognitionTest.setTemplates(list), aTemplates.map((t) => ({ customer: t.customer, embedding: t.embedding, customer_name: 'Nadia Okafor' })))
  }
  const v = await waitVerdict(page)
  check('different face (B) against A\'s templates → New client (no false match)', v.state?.tile === 'new', v.real ? 'real detection' : 'hook')
  const last = await page.evaluate(() => {
    const s = window.__awanzRecognitionTest.state()
    return s
  })
  console.log('   B verdict:', JSON.stringify(last))
  // decline path
  await page.click('[data-testid=recognition-enrol]')
  await page.waitForSelector('[data-testid=enrol-sheet]')
  await page.fill('#enrol-email', 'theo.brandt@example.com')
  await page.fill('#enrol-name', 'Theo Brandt')
  await page.click('[data-testid=enrol-continue]')
  await page.waitForSelector('[data-testid=consent-decline]')
  await page.click('[data-testid=consent-decline]')
  await page.waitForSelector('[data-testid=consent-screen]', { state: 'detached', timeout: 8000 })
  await page.waitForTimeout(300)
  const attached = await page.evaluate(() => document.querySelector('.basket .client-name')?.textContent.trim())
  const mock = await mockState(page)
  const theo = (mock.customers || []).find((c) => c.customer_name === 'Theo Brandt')
  check('decline: client created + attached without biometrics', attached === 'Theo Brandt' && theo && !theo.maison_face_consent && !(mock.templates || []).some((t) => t.customer === theo.name), attached)
  check('server: Declined event logged', (mock.events || []).some((e) => e.outcome === 'Declined' && e.customer === theo?.name))
  await dismissNotices(page)
  await page.screenshot({ path: resolve(OUT, 'desktop-14-declined-attached.png') })
  await ctx.close()
  await browser.close()
}

// =============================================================================================
// 3. iPhone 390×844 — tile in the bottom sheet, enrol sheet, consent, recognised
// =============================================================================================
{
  const browser = await launch(FACE_A)
  const { ctx, page } = await newPage(browser, profiles.iphone, 'iphone')
  const shot = async (file) => {
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(OUT, `iphone-${file}.png`) })
    console.log('iphone', file)
  }
  await freshDevice(page)
  await unlock(page)
  await page.click('.summary-bar')
  await page.waitForSelector('[data-testid=recognition-tile]')
  await waitTile(page, ['looking'], 20000)
  await shot('01-tile-looking')
  const v = await waitVerdict(page)
  check('iphone: first verdict New client', v.state?.tile === 'new', v.real ? 'real detection' : 'hook')
  await shot('02-tile-new-client')
  await page.click('[data-testid=recognition-enrol]')
  await page.waitForSelector('[data-testid=enrol-sheet]')
  await page.fill('#enrol-phone', '+1 312 555 0199')
  await page.fill('#enrol-name', 'Nadia Okafor')
  await page.waitForTimeout(300)
  await shot('03-enrol-sheet')
  await page.click('[data-testid=enrol-continue]')
  await page.waitForSelector('[data-testid=consent-screen]')
  await shot('04-consent')
  await page.click('button:has-text("Sign instead")')
  await page.waitForTimeout(300)
  // draw a signature stroke
  const pad = await page.locator('.pad').boundingBox()
  await page.mouse.move(pad.x + 30, pad.y + 80)
  await page.mouse.down()
  for (let i = 1; i <= 24; i++) await page.mouse.move(pad.x + 30 + i * 10, pad.y + 80 + Math.sin(i / 2) * 25)
  await page.mouse.up()
  await page.waitForTimeout(200)
  await shot('05-consent-signature')
  await page.click('[data-testid=consent-agree]')
  await page.waitForSelector('[data-testid=capture-progress]', { timeout: 5000 })
  await shot('06-capture')
  const realCapture = await ensureCapture(page)
  const t0 = Date.now()
  while (Date.now() - t0 < 15000 && (await tileState(page))?.enrolOpen) await page.waitForTimeout(250)
  const mock = await mockState(page)
  const consent = (mock.consents || []).find((c) => c.method === 'Signature' && c.status === 'Active')
  check('iphone: signature consent stored (has_signature)', !!consent && consent.has_signature, realCapture ? '3 real captures' : 'samples via hook')
  await dismissNotices(page)
  await shot('07-enrolled-attached')
  await page.reload()
  await page.waitForSelector('.summary-bar')
  await page.click('.summary-bar')
  await page.waitForSelector('[data-testid=recognition-tile]')
  const v2 = await waitVerdict(page)
  check('iphone: same face → Recognised', v2.state?.tile === 'recognised', `score ${v2.state?.recognised?.score}`)
  await shot('08-tile-recognised')
  await ctx.close()
  await browser.close()
}

writeFileSync(resolve(OUT, 'results.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
