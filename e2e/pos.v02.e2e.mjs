// AWANZ POS v0.2 end-to-end run against the real bench (images, scanning, client №, receipt QR, iPhone).
// Run:  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/pos.v02.e2e.mjs
// Env:  BASE (default http://maison.localhost:8000), ASSOC_USER/ASSOC_PWD, ADMIN_PWD
import { chromium, request } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, 'shots-v02')
fs.mkdirSync(SHOTS, { recursive: true })

const BASE = process.env.BASE || 'http://maison.localhost:8000'
const BOUTIQUE = 'CHI-OAK'
const ASSOC = { usr: process.env.ASSOC_USER || 'chi.oak.a1@maison.example', pwd: process.env.ASSOC_PWD || 'maison123', pin: '2580' }
const ADMIN = { usr: 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const IMAGE_ITEM = 'AC-012' // Silk Pocket Square (non-serialized accessory)

const results = []
const consoleLog = []
let shotN = 0
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(page, name) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: f, fullPage: false })
  log('  shot', path.basename(f))
  return f
}
function wireConsole(page, tag) {
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type())) consoleLog.push({ tag, type: m.type(), text: m.text() })
  })
  page.on('pageerror', (e) => consoleLog.push({ tag, type: 'pageerror', text: String(e.stack || e) }))
  page.on('requestfailed', (r) => consoleLog.push({ tag, type: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure()?.errorText}` }))
}

// ---- tiny PNG generator (no deps): solid gold 64×64 -------------------------------
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function makePng(w = 64, h = 64, rgb = [0xc9, 0xa9, 0x6e]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      // diagonal stripe so the image is recognisable
      const dark = (x + y) % 16 < 8
      raw[o] = dark ? rgb[0] : 0x0b
      raw[o + 1] = dark ? rgb[1] : 0x0b
      raw[o + 2] = dark ? rgb[2] : 0x0a
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---- admin API helper -------------------------------------------------------------
async function adminApi() {
  const ctx = await request.newContext({ baseURL: BASE })
  const r = await ctx.post('/api/method/login', { data: ADMIN })
  if (!r.ok()) throw new Error('admin login failed ' + r.status())
  // a CSRF token is only issued once a page has been served to the session
  const pos = await ctx.get('/pos')
  const csrf = (await pos.text()).match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
  const headers = { 'X-Frappe-CSRF-Token': csrf }
  return {
    ctx,
    csrf,
    async get(method, params = {}) {
      const r = await ctx.get(`/api/method/${method}`, { params })
      const j = await r.json()
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.post(`/api/method/${method}`, { data, headers })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    list: (doctype, filters, fields = ['name'], limit = 50) =>
      ctx.get(`/api/method/frappe.client.get_list`, { params: { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit } })
        .then(async (r) => { const j = await r.json(); if (!r.ok()) throw new Error(`get_list ${doctype}: ${r.status()}`); return j.message }),
    async upload(method, fields, file) {
      const r = await ctx.post(`/api/method/${method}`, { headers, multipart: { ...fields, file } })
      const j = await r.json().catch(() => ({}))
      return { status: r.status(), body: j }
    },
    dispose: () => ctx.dispose()
  }
}

// ---- POS helpers ------------------------------------------------------------------
async function unlock(page, pin = ASSOC.pin) {
  await page.waitForSelector('.unlock select.input', { timeout: 20000 })
  await page.selectOption('.unlock select.input >> nth=0', BOUTIQUE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 30000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))
  const assoc = opts.find((o) => o.v === ASSOC.usr) || opts.find((o) => /Associate/.test(o.t)) || opts[0]
  await page.selectOption('.unlock select.input >> nth=1', assoc.v)
  for (const d of pin) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 15000 })
  await page.waitForSelector('.tile', { timeout: 15000 })
  return assoc
}

/** Simulate a keyboard-wedge scanner: fast burst + Enter with focus outside any text input. */
async function wedgeScan(page, code) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
  })
  await page.keyboard.type(code, { delay: 4 })
  await page.keyboard.press('Enter')
}

async function basketLines(page) {
  return page.$$eval('.basket .line', (ls) =>
    ls.map((l) => ({ name: l.querySelector('.line-name, .name')?.textContent?.trim() || l.textContent.trim(), text: l.textContent.replace(/\s+/g, ' ').trim() }))
  )
}

async function payCashUntilReceipt(page, tendered) {
  for (const d of String(tendered)) await page.click(`.pay .keypad button:text-is("${d}")`)
  await page.click('button:has-text("Complete cash sale")')
  await page.waitForSelector('.receipt-view', { timeout: 15000 })
}

async function waitSynced(page, ms = 25000) {
  await page.waitForFunction(() => /Synced|Rejected/.test(document.querySelector('.receipt-view .pill')?.textContent || ''), null, { timeout: ms })
  return (await page.locator('.receipt-view .pill').first().textContent()).trim()
}

// ====================================================================================
const browser = await chromium.launch({ headless: true })
const admin = await adminApi()

// 0. Manager uploads a tile photo via the API (small generated PNG), and seed data we scan.
let imageUrl = null
try {
  const up = await admin.upload('maison_pos.api.catalog.upload_item_image', { item_code: IMAGE_ITEM }, { name: 'pocket-square.png', mimeType: 'image/png', buffer: makePng() })
  imageUrl = up.body?.message?.image || null
  const ok = up.status === 200 && !!imageUrl && up.body.message.item_code === IMAGE_ITEM && /\/files\//.test(up.body.message.file_url || '')
  record('manager uploads item image via catalog.upload_item_image', ok, `${up.status} ${JSON.stringify(up.body?.message || up.body).slice(0, 160)}`)
  const img = await admin.ctx.get(imageUrl)
  record('uploaded image URL is served', img.ok() && /image\/png/.test(img.headers()['content-type'] || ''), `${img.status()} ${img.headers()['content-type']}`)
} catch (e) {
  record('manager uploads item image via catalog.upload_item_image', false, String(e))
}

// repeated runs sell the demo one-offs through: the serial scan needs an item with >= 2 free
// serials at this boutique, so receive a fresh pair when none is left (see INTEGRATION_NOTES v0.4 #12).
async function ensureTwoFreeSerials() {
  const b = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: BOUTIQUE })
  const byCode = Object.fromEntries(b.items.map((i) => [i.item_code, i]))
  if (Object.entries(b.serials).some(([ic, list]) => list.length >= 2 && byCode[ic])) return
  const code = b.items.find((i) => i.has_serial_no)?.item_code
  if (!code) return
  const bq = (await admin.list('AWANZ Store', { name: BOUTIQUE }, ['company', 'warehouse']))[0]
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase()
  await admin.post('frappe.client.insert', {
    doc: {
      doctype: 'Stock Entry', stock_entry_type: 'Material Receipt', company: bq.company, docstatus: 1,
      items: [1, 2].map((n) => ({ item_code: code, qty: 1, t_warehouse: bq.warehouse, basic_rate: 1000, allow_zero_valuation_rate: 1, use_serial_batch_fields: 1, serial_no: `${code}-CHI-E${tag}${n}` }))
    }
  })
  log(`  topped up ${code} @ ${BOUTIQUE}: +2 serials (${code}-CHI-E${tag}1/2)`)
}
// the phone flow taps IMAGE_ITEM: repeated runs sell it out and the tile goes `.tile.empty`
async function ensureStock(code, min = 6) {
  const b = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: BOUTIQUE })
  if ((b.stock?.[code] || 0) >= min) return
  const bq = (await admin.list('AWANZ Store', { name: BOUTIQUE }, ['company', 'warehouse']))[0]
  await admin.post('frappe.client.insert', {
    doc: {
      doctype: 'Stock Entry', stock_entry_type: 'Material Receipt', company: bq.company, docstatus: 1,
      items: [{ item_code: code, qty: 20, t_warehouse: bq.warehouse, basic_rate: 100, allow_zero_valuation_rate: 1 }]
    }
  })
  log(`  topped up ${code} @ ${BOUTIQUE}: +20`)
}
try { await ensureTwoFreeSerials() } catch (e) { log('  serial top-up skipped:', String(e).slice(0, 200)) }
try { await ensureStock(IMAGE_ITEM) } catch (e) { log('  stock top-up skipped:', String(e).slice(0, 200)) }

const boot = await admin.get('maison_pos.api.catalog.bootstrap', { boutique: BOUTIQUE })
const itemsByCode = Object.fromEntries(boot.items.map((i) => [i.item_code, i]))
const barcodes = boot.barcodes || {}
// an EAN-13 (13 digits) pointing at a non-serialized item with stock
const eanEntry = Object.entries(barcodes).find(([code, ic]) => /^\d{13}$/.test(code) && itemsByCode[ic] && !itemsByCode[ic].has_serial_no && (boot.stock[ic] || 0) > 0)
// a serial label (code === serial) of a serialized item with ≥2 serials so the scan must pick the exact one
const serialItem = Object.entries(boot.serials).find(([ic, list]) => list.length >= 2 && itemsByCode[ic])
const serialCode = serialItem ? serialItem[1][1] : null
record('bootstrap has settings/barcodes/images', !!boot.settings && !!eanEntry && !!serialCode && itemsByCode[IMAGE_ITEM]?.image === imageUrl,
  `settings=${JSON.stringify(boot.settings)} ean=${eanEntry?.[0]}→${eanEntry?.[1]} serial=${serialCode} image=${itemsByCode[IMAGE_ITEM]?.image}`)

const custs = await admin.get('maison_pos.api.customers.search', { q: 'MC', limit: 50 })
const seeded = custs.find((c) => /^MC\d{6}$/.test(c.client_number || '') && c.loyalty_program && !/walk-in/i.test(c.customer_name))
record('customers.search rows carry client_number / loyalty_points / points_value / tier', !!seeded && ['client_number', 'loyalty_points', 'points_value', 'tier'].every((k) => k in seeded),
  seeded ? `${seeded.customer_name} ${seeded.client_number} pts=${seeded.loyalty_points} value=${seeded.points_value} tier=${seeded.tier}` : 'no seeded MC customer')

// ---------------------------------------------------------------------------------
// Tablet run (1366×1024)
const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, baseURL: BASE })
const login = await context.request.post('/api/method/login', { data: { usr: ASSOC.usr, pwd: ASSOC.pwd } })
record('associate login', login.ok(), ASSOC.usr)
const page = await context.newPage()
wireConsole(page, 'pos')
let receiptToken = null
let receiptLink = null
try {
  await page.goto('/pos')
  await unlock(page)

  // 1. images toggle
  const imgBtn = page.locator('.sell .icon-btn[aria-label="Toggle product photos"]')
  await imgBtn.waitFor()
  const onBefore = await imgBtn.evaluate((b) => b.classList.contains('on'))
  if (!onBefore) await imgBtn.click()
  await page.fill('.sell .search input', 'Pocket Square')
  const tile = page.locator('.tile:has-text("Silk Pocket Square")').first()
  await tile.waitFor()
  // wait until the photo has actually decoded, not merely until the <img> exists — otherwise
  // naturalWidth is still 0 and the check flakes on a cold file cache
  await page.waitForFunction(
    () => {
      const i = document.querySelector('.tile.img img[src*="/files/"]')
      return !!i && i.complete && i.naturalWidth > 0
    },
    null,
    { timeout: 15000 }
  ).catch(() => {})
  const imgSrc = await tile.locator('img').first().getAttribute('src').catch(() => null)
  const natural = await tile.locator('img').first().evaluate((i) => i.naturalWidth).catch(() => 0)
  await shot(page, 'sell-images-on')
  record('images toggle shows tile photo for item with image', !!imgSrc && imgSrc.includes('/files/') && natural > 0, `src=${imgSrc} naturalWidth=${natural}`)
  await imgBtn.click()
  const stillImg = await page.locator('.tile.img').count()
  record('images toggle off hides photos', stillImg === 0, `tiles with photo: ${stillImg}`)
  await page.fill('.sell .search input', '')

  // 2. wedge scan: EAN → item added
  const [ean, eanItem] = eanEntry
  await wedgeScan(page, ean)
  await page.waitForFunction((n) => document.querySelectorAll('.basket .line').length >= n, 1, { timeout: 5000 }).catch(() => {})
  let lines = await basketLines(page)
  const eanOk = lines.some((l) => l.text.includes(itemsByCode[eanItem].item_name))
  record('wedge scan EAN adds item', eanOk, `${ean} → ${itemsByCode[eanItem].item_name}; basket: ${lines.map((l) => l.name).join(' | ')}`)

  // 3. wedge scan: serial → exact serial added
  await wedgeScan(page, serialCode)
  await page.waitForFunction((n) => document.querySelectorAll('.basket .line').length >= n, 2, { timeout: 5000 }).catch(() => {})
  lines = await basketLines(page)
  const serOk = lines.some((l) => l.text.includes(serialCode))
  await shot(page, 'sell-after-scans')
  record('wedge scan serial adds that exact serial', serOk, `${serialCode} (${itemsByCode[serialItem[0]].item_name}); basket: ${lines.map((l) => l.text).join(' | ')}`)

  // 4. client number via keypad
  await page.click('#client-no')
  await page.waitForSelector('.basket .cn-pad')
  for (const d of seeded.client_number.replace(/^MC/, '')) await page.click(`.basket .cn-pad button:text-is("${d}")`)
  await page.click('.basket .cn-btn.go')
  await page.waitForSelector('.basket .client-name:not(.dim)', { timeout: 15000 })
  const cardText = (await page.locator('.basket .client').textContent()).replace(/\s+/g, ' ')
  await shot(page, 'sell-client-attached')
  const ptsStr = Math.round(seeded.loyalty_points).toLocaleString('en-US')
  const clientOk = cardText.includes(seeded.customer_name) && cardText.includes(seeded.client_number) && cardText.includes('Points') && cardText.includes(ptsStr)
  record('client № keypad lookup attaches client with points', clientOk, cardText.slice(0, 200))

  // 5. cash pay → receipt with QR + link
  await page.click('.basket .pay button:has-text("Cash")')
  await page.waitForSelector('.pay .cash')
  const total = parseFloat((await page.locator('.pay .due').first().textContent().catch(() => '0')).replace(/[^0-9.]/g, ''))
  await payCashUntilReceipt(page, Math.max(100, Math.ceil((total || 1) / 100) * 100))
  const pill = await waitSynced(page)
  await page.waitForSelector('.receipt-view .r-qr img', { timeout: 15000 }).catch(() => {})
  const qrSrc = await page.locator('.receipt-view .r-qr img').first().getAttribute('src').catch(() => null)
  receiptLink = (await page.locator('.receipt-view .link-card a.link-url').first().getAttribute('href').catch(() => null)) || null
  receiptToken = receiptLink ? receiptLink.split('/r/')[1] : null
  await shot(page, 'receipt-qr')
  record('receipt screen shows QR and receipt link', pill === 'Synced' && !!qrSrc?.startsWith('data:image/png') && !!receiptLink && /\/r\/[A-Za-z0-9_-]{16}$/.test(receiptLink), `${pill} qr=${qrSrc?.slice(0, 30)} link=${receiptLink}`)
  await page.click('button:has-text("Done")')
} catch (e) {
  record('UNCAUGHT (tablet)', false, String(e.stack || e).split('\n').slice(0, 4).join(' '))
  await shot(page, 'failure').catch(() => {})
}

// 6. guest receipt page + JSON
if (receiptToken) {
  const guest = await request.newContext({ baseURL: BASE })
  const r = await guest.get(`/r/${receiptToken}`)
  const html = await r.text()
  record('GET /r/<token> as guest returns 200 with boutique name', r.status() === 200 && html.includes('AWANZ Oak Street'), `${r.status()} len=${html.length}`)
  const j = await guest.get('/api/method/maison_pos.api.sales.receipt', { params: { token: receiptToken } })
  const body = await j.json().catch(() => ({}))
  record('guest sales.receipt JSON has boutique, lines, totals and no PII', j.status() === 200 && body.message?.boutique?.name === 'AWANZ Oak Street' && body.message.lines?.length >= 1 && !('customer_name' in body.message) && !('client_number' in (body.message.client || {})),
    `${j.status()} client=${JSON.stringify(body.message?.client)}`)
  const bad = await guest.get('/r/not-a-real-token')
  record('GET /r/<bad token> is 404', bad.status() === 404, String(bad.status()))
  await guest.dispose()
} else {
  record('GET /r/<token> as guest returns 200 with boutique name', false, 'no token captured')
}
await context.close()

// ---------------------------------------------------------------------------------
// iPhone run (390×844)
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  baseURL: BASE
})
await phone.request.post('/api/method/login', { data: { usr: ASSOC.usr, pwd: ASSOC.pwd } })
const ph = await phone.newPage()
wireConsole(ph, 'phone')
try {
  await ph.goto('/pos')
  await ph.waitForSelector('.unlock select.input', { timeout: 20000 })
  await shot(ph, 'phone-unlock')
  await unlock(ph)
  const phoneLayout = await ph.evaluate(() => !!document.querySelector('.basket.phone'))
  const summaryBar = await ph.locator('.basket .summary-bar').count()
  await shot(ph, 'phone-sell')
  record('iPhone: phone layout with bottom-sheet summary bar', phoneLayout && summaryBar === 1, `basket.phone=${phoneLayout} summary-bar=${summaryBar}`)
  const overflowX = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  record('iPhone: no horizontal overflow', overflowX <= 0, `scrollWidth-clientWidth=${overflowX}`)

  // add item via tile; the sheet stays collapsed until tapped
  await ph.fill('.sell .search input', 'Pocket Square')
  const tile = ph.locator('.tile:has-text("Silk Pocket Square")').first()
  await tile.waitFor()
  await tile.tap()
  await ph.waitForFunction(() => /1 item/.test(document.querySelector('.basket .summary-bar')?.textContent || ''), null, { timeout: 5000 })
  await shot(ph, 'phone-item-added')
  await ph.locator('.basket .summary-bar .sum-left').tap()
  await ph.waitForSelector('.basket.expanded .line', { timeout: 5000 })
  const lineNames = await basketLines(ph)
  await shot(ph, 'phone-sheet-expanded')
  record('iPhone: add item via tile, bottom sheet expands with the line', lineNames.some((l) => l.text.includes('Silk Pocket Square')), lineNames.map((l) => l.name).join(' | '))

  // touch target sizes on the sheet
  const small = await ph.$$eval('.basket.expanded button, .basket.expanded .line button', (bs) =>
    bs.filter((b) => b.offsetParent !== null).map((b) => ({ t: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 20), h: b.getBoundingClientRect().height })).filter((b) => b.h < 48)
  )
  record('iPhone: sheet controls ≥48px tall', small.length === 0, small.map((s) => `${s.t}:${Math.round(s.h)}`).join(', ') || 'all ok')

  await ph.locator('.basket .pay button:has-text("Cash")').tap()
  await ph.waitForSelector('.pay .cash')
  await shot(ph, 'phone-pay-cash')
  for (const d of '200') await ph.locator(`.pay .keypad button:text-is("${d}")`).tap()
  await ph.locator('button:has-text("Complete cash sale")').tap()
  await ph.waitForSelector('.receipt-view', { timeout: 15000 })
  const pill = await waitSynced(ph)
  await ph.waitForSelector('.receipt-view .r-qr img', { timeout: 15000 }).catch(() => {})
  await shot(ph, 'phone-receipt')
  const hasQr = await ph.locator('.receipt-view .r-qr img').count()
  const link = await ph.locator('.receipt-view .link-card a.link-url').first().getAttribute('href').catch(() => null)
  record('iPhone: cash pay → receipt synced with QR + link', pill === 'Synced' && hasQr === 1 && !!link, `${pill} link=${link}`)
  const overflow2 = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  record('iPhone: receipt screen has no horizontal overflow', overflow2 <= 0, `scrollWidth-clientWidth=${overflow2}`)
} catch (e) {
  record('UNCAUGHT (phone)', false, String(e.stack || e).split('\n').slice(0, 4).join(' '))
  await shot(ph, 'phone-failure').catch(() => {})
}
await phone.close()

await admin.dispose()
await browser.close()

const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} passed`)
const noise = consoleLog.filter((c) => !/fonts\.g(oogleapis|static)\.com|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED/.test(c.text))
if (noise.length) {
  log(`Console errors/warnings (non-font): ${noise.length}`)
  for (const c of noise.slice(0, 20)) log(`  ${c.tag} ${c.type} ${c.text.slice(0, 300)}`)
}
fs.writeFileSync(path.join(__dirname, 'results.v02.json'), JSON.stringify({ results, console: consoleLog }, null, 2))
process.exit(passed === results.length ? 0 : 1)
