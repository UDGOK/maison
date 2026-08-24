/**
 * v1.0 "Procurement" — the buying loop end to end, against a live bench.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc.localhost:8001 ADMIN_PWD=admin \
 *     node e2e/purchasing.e2e.mjs
 *
 * SPEC_v1.0 "Quality" asks for exactly this run, driven through the real `/warehouse` screens and
 * then checked against what the server actually stored:
 *
 *   1. warehouse admin opens `/warehouse` → **Buying**; the suggestion list is there with its
 *      source badges (Low stock / Store demand / Trending)
 *   2. a suggestion's quantity is edited (and snaps **up** to the vendor's case pack), the row is
 *      swapped to an **alternative vendor** (and the unit cost moves with it), then
 *      **Create orders** → one *draft* Purchase Order per vendor
 *   3. the order is opened: a **line rate is overridden by hand** (decision 4) and **freight is
 *      entered by hand** (decision 3) → saved; the server stores both and landed = net + freight
 *   4. the order is **submitted** and then **sent** — by phone, so no real e-mail is fired —
 *      and `maison_sent_on` / `maison_sent_method` are stamped
 *   5. **Inbound** → receive by scan, one line **short**, one line with a **unit-cost override**,
 *      submit → Purchase Receipt exists, `received_qty` rose, an `AWANZ Receiving Discrepancy` of
 *      type *Short* stands **against the vendor**, and the item's **moving-average valuation rate
 *      moved to the value this run computes for it**, freight included
 *   6. a **drop-ship** order addressed to a store is submitted and the **store** receives it on its
 *      own POS `Receive` screen, while `/warehouse` stays shut to that store user
 *   7. the purchasing endpoints refuse a store manager over plain HTTP — `suggestions`,
 *      `create_order`, `stock`, `vendors`
 *
 * plus the cheap proofs that were worth having while we were in there: the **Stock** board values
 * at moving average with cover days, the **Vendors** board opens a vendor and its catalogue, and
 * the wall's new **Inbound** column renders.
 *
 * Nothing here is written to be lenient. Four checks failed on the first run, each on a real
 * defect; all four are now fixed, and the checks stand as their regression tests:
 *
 *   · "tapping an alternative vendor straight after typing a quantity registers on the first tap"
 *     — `BuySuggestRow.vue` committed the quantity on blur and cleared its note, the note
 *       paragraph unmounted, the vendor buttons jumped ~46 px, and the tap that caused the blur
 *       was swallowed. The note is now always mounted, so nothing moves under a finger;
 *   · "the moving-average preview the sheet showed is the move that actually happened"
 *     — `warehouse/inbound.ts` split freight evenly **per unit**, while the freight row the server
 *       writes is an Actual + Valuation charge, which ERPNext spreads **by line amount**; on a
 *       receipt of a $6 bowl and a $73 hookah the preview was out by ~7 %. `freightAllocation`
 *       now allocates the way the posting will;
 *   · "“this is the whole delivery” closes the order, the way the sheet says it will"
 *     — `receive_purchase_order(final=1)` raised the Short discrepancies but never closed the
 *       order, so a delivery fully settled with the vendor kept sitting on Inbound as still
 *       expected, contradicting both the toggle's copy and `receiveOutcome`'s. It closes now;
 *   · "the store is told, line by line, what the receipt actually booked"
 *     — `ReceiveView.vue` printed `prResult.lines[].qty`, a key `receive_purchase_order` never
 *       returns, so the store manager read "CBD-003 × undefined". It reads `accepted_qty` — what
 *       actually went into their stock — and the client type now matches the server's payload.
 *
 * BASE defaults to the CloudChaserz site, which carries HOU-WH, twelve seeded vendors and the
 * item↔vendor catalogue; `BRIDGE=1` routes every context through `cloud-bridge.mjs` for a run
 * against the live Frappe Cloud site. The run picks its own vendor and items out of whatever the
 * demand engine produced, so it can be run again on a site it has already bought from.
 */
import { chromium } from './node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { installBridge } from './cloud-bridge.mjs'

const BASE = process.env.BASE || 'http://cc.localhost:8001'
const BRIDGE = process.env.BRIDGE === '1'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const PWD = process.env.DEMO_PWD || 'cloud123'
const WH_USER = { usr: process.env.WH_USER || 'warehouse@cloudchaserz.example', pwd: PWD }
/** the store a drop-ship order is addressed to, and the manager who receives it */
const STORE = process.env.STORE || 'OK-BA'
const MANAGER = {
  usr: process.env.MANAGER || 'ok.ba.manager@cloudchaserz.example',
  pwd: PWD,
  pin: process.env.MANAGER_PIN || '3303'
}

const here = path.dirname(fileURLToPath(import.meta.url))
const shots = path.join(here, process.env.SHOTS_DIR || 'shots-v10')
mkdirSync(shots, { recursive: true })

const results = []
const log = (...a) => console.log(...a)
const record = (step, ok, detail = '') => {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 500) })
  log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`)
}
const console_ = []
/**
 * Noise this harness creates or a plain `bench serve` cannot avoid, so the console list stays worth
 * reading: we abort Google Fonts ourselves, and `bench serve` does not proxy /socket.io (the desk
 * and the wall fall back to polling, which is what the realtime code is meant to do).
 */
const ENVIRONMENTAL = [/socket\.io/i, /fonts\.(googleapis|gstatic)/i, /Failed to load resource: net::ERR_FAILED/i]
function wireConsole(page, tag) {
  const keep = (text) => !ENVIRONMENTAL.some((re) => re.test(text))
  page.on('console', (m) => {
    const text = m.text().slice(0, 200)
    if (['error', 'warning'].includes(m.type()) && keep(text)) console_.push({ tag, type: m.type(), text })
  })
  page.on('pageerror', (e) => console_.push({ tag, type: 'pageerror', text: String(e).slice(0, 200) }))
}
let shotN = 0
async function shot(page, name, full = false) {
  const file = `${String(++shotN).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: path.join(shots, file), fullPage: full })
  log('  shot ' + file)
  return file
}

// ---------------------------------------------------------------- maths this run does for itself
const round = (v, p = 2) => Math.round((Number(v) + Number.EPSILON) * 10 ** p) / 10 ** p
/** `purchasing.round_up_to_case_pack` / `buying.ts::roundToCasePack`, restated here on purpose. */
function roundToCasePack(qty, casePack = 1, moq = 0) {
  let out = Math.max(0, Number(qty) || 0)
  const pack = Math.max(1, Math.trunc(Number(casePack) || 0))
  if (out > 0) out = (Math.floor(out / pack) + (out % pack ? 1 : 0)) * pack
  const min = Math.max(0, Math.trunc(Number(moq) || 0))
  if (min && out && out < min) out = (Math.floor(min / pack) + (min % pack ? 1 : 0)) * pack
  return out
}
/**
 * What ERPNext will make of a receipt line, computed from first principles rather than read back
 * off the document we are checking.
 *
 * A freight row of `charge_type = Actual`, `category = Valuation` is spread over the receipt's
 * lines **in proportion to net amount** (`erpnext/controllers/buying_controller.py::
 * update_valuation_rate`), not evenly per unit, so a receipt whose lines have very different unit
 * costs does not share it evenly. The moving average is then
 * `(qty_before × rate_before + qty_in × landed_rate) / (qty_before + qty_in)`
 * (`erpnext/stock/stock_ledger.py::get_moving_average_values`).
 */
function expectedMovingAverage({ qtyBefore, rateBefore, qtyIn, rateIn, freight, receiptLines }) {
  const netTotal = receiptLines.reduce((s, l) => s + l.qty * l.rate, 0)
  const lineNet = qtyIn * rateIn
  const share = netTotal > 0 ? (Number(freight) || 0) * (lineNet / netTotal) : 0
  const valueAfter = qtyBefore * rateBefore + lineNet + share
  return { share, landedRate: (lineNet + share) / qtyIn, rate: valueAfter / (qtyBefore + qtyIn), qtyAfter: qtyBefore + qtyIn }
}

/** Poll until *check* is happy (the screens write through the server, so we wait on the server). */
async function until(check, { timeout = 25000, every = 500 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await check()
    if (last) return last
    if (Date.now() > deadline) return last
    await new Promise((r) => setTimeout(r, every))
  }
}

// ---------------------------------------------------------------- api helper
const browser = await chromium.launch({ headless: true })

async function newContext(opts = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, colorScheme: 'dark', ...opts })
  if (BRIDGE) await installBridge(ctx)
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort()).catch(() => {})
  return ctx
}

async function client(user) {
  const ctx = await newContext()
  const r = await ctx.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!r.ok()) throw new Error(`${user.usr} login failed ${r.status()}`)
  const html = await (await ctx.request.get('/pos')).text()
  const csrf = html.match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''
  const headers = { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' }
  const api = {
    ctx,
    csrf,
    async get(method, params = {}) {
      const r = await ctx.request.get(`/api/method/${method}`, { params })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    async post(method, data = {}) {
      const r = await ctx.request.post(`/api/method/${method}`, { headers, data })
      const j = await r.json().catch(() => ({}))
      if (!r.ok()) throw new Error(`${method}: ${r.status()} ${JSON.stringify(j).slice(0, 300)}`)
      return j.message
    },
    /** status + body, for the permission checks that must see the HTTP code */
    async rawGet(method, params = {}) {
      const r = await ctx.request.get(`/api/method/${method}`, { params })
      return { status: r.status(), body: await r.json().catch(() => ({})) }
    },
    async rawPost(method, data = {}) {
      const r = await ctx.request.post(`/api/method/${method}`, { headers, data })
      return { status: r.status(), body: await r.json().catch(() => ({})) }
    },
    list: (doctype, filters, fields = ['name'], limit = 200) =>
      api.get('frappe.client.get_list', { doctype, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit }),
    /** the whole document, child tables included */
    doc: (doctype, name) => api.get('frappe.client.get', { doctype, name }),
    value: (doctype, name, fields) =>
      api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    dispose: () => ctx.close()
  }
  return api
}

const admin = await client(ADMIN)
const whApi = await client(WH_USER)

// ---------------------------------------------------------------- what the site gives us to work with
const HQ = (await whApi.get('maison_pos.api.shipping.me'))?.main_warehouse
if (!HQ) throw new Error('no main warehouse configured — is this an AWANZ site?')
const storeRow = (await admin.list('AWANZ Store', { name: STORE }, ['name', 'warehouse', 'enabled', 'company']))[0]
if (!storeRow?.enabled) throw new Error(`drop-ship store ${STORE} is missing or disabled on ${BASE}`)

const binOf = async (item, warehouse) => {
  const b = (await admin.list('Bin', { item_code: item, warehouse }, ['actual_qty', 'valuation_rate', 'stock_value']))[0]
  return { qty: Number(b?.actual_qty || 0), rate: Number(b?.valuation_rate || 0), value: Number(b?.stock_value || 0) }
}
const poNames = async () => new Set(await admin.get('frappe.client.get_list', {
  doctype: 'Purchase Order', fields: JSON.stringify(['name']), limit_page_length: 2000
}).then((rows) => rows.map((r) => r.name)))

// A fresh demand run, so the buying list is the one this run reasons about. POST, not GET: the
// run is cached in `AWANZ Purchase Suggestion`, and Frappe rolls a GET back — which is exactly why
// `api/purchasing.ts` calls this one with POST too.
const built = await whApi.post('maison_pos.api.purchasing.suggestions', { refresh: 1 })
const suggestions = built.suggestions || []
if (!suggestions.length) throw new Error('the demand engine produced no suggestions — nothing to buy on this site')

const stockRows = (await whApi.get('maison_pos.api.purchasing.stock', { limit: 1000 })).rows || []
const stockOf = Object.fromEntries(stockRows.map((r) => [r.item_code, r]))

/** vendor → the suggestions that vendor is preferred on, largest group first then alphabetical */
const byVendor = new Map()
for (const s of suggestions) {
  if (!s.supplier) continue
  if (!byVendor.has(s.supplier)) byVendor.set(s.supplier, [])
  byVendor.get(s.supplier).push(s)
}
const ranked = [...byVendor.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
const [VENDOR, group] = ranked[0] || []
if (!group || group.length < 3) {
  throw new Error(`need a vendor with three buying suggestions to drive the whole loop; best was ${VENDOR} with ${group?.length ?? 0}`)
}
// the row that gets moved to an alternative vendor — it has to have one, at a different cost
const SWAP = group.find((s) => (s.vendors || []).some((v) => v.supplier !== s.supplier && Number(v.cost) !== Number(s.cost)))
if (!SWAP) throw new Error(`no row on ${VENDOR} has an alternative vendor at a different cost`)
const ALT = [...(SWAP.vendors || [])].filter((v) => v.supplier !== SWAP.supplier && Number(v.cost) !== Number(SWAP.cost))
  .sort((a, b) => Math.abs(Number(b.cost) - Number(SWAP.cost)) - Math.abs(Number(a.cost) - Number(SWAP.cost)))[0]
// the two lines that stay with the preferred vendor: one carries the moving-average proof (so it
// needs stock on hand at a known rate), the other is the one that arrives short
const keepers = group.filter((s) => s !== SWAP)
const MA_ROW = keepers.find((s) => stockOf[s.item_code]?.actual_qty > 0 && stockOf[s.item_code]?.valuation_rate > 0)
const SHORT_ROW = keepers.find((s) => s !== MA_ROW)
if (!MA_ROW || !SHORT_ROW) throw new Error(`${VENDOR} needs one stocked line for the moving-average proof and one more to arrive short`)

// a second vendor entirely, for the drop-ship order
const DROP = ranked.map(([, rows]) => rows).flat().find((s) => s.supplier !== VENDOR)
if (!DROP) throw new Error('no suggestion from a second vendor to drop-ship')

// the numbers this run drives, and the ones it will check against
const TYPED_QTY = Math.max(1, Math.round(Number(SWAP.case_pack) * 1.25) || 5) // deliberately not a whole case
const SNAPPED_QTY = roundToCasePack(TYPED_QTY, SWAP.case_pack, SWAP.moq)
const ORDER_QTY_MA = 12
const ORDER_QTY_SHORT = 6
const RECEIVE_SHORT = 4 // → 2 short
const ORDER_RATE_SHORT = round(Number(SHORT_ROW.cost) * 1.05) // the manual rate override on the order
const RECEIPT_RATE_MA = round(Number(MA_ROW.cost) * 1.1) // the manual unit-cost override at receipt
const FREIGHT = 45
const DROP_QTY = 6

log(`  vendor=${VENDOR} swap=${SWAP.item_code}→${ALT.supplier} ma=${MA_ROW.item_code} short=${SHORT_ROW.item_code} dropship=${DROP.item_code}/${DROP.supplier}`)
log(`  ${MA_ROW.item_code} at ${HQ}: ${stockOf[MA_ROW.item_code].actual_qty} @ ${stockOf[MA_ROW.item_code].valuation_rate}`)

// ================================================================ 1. /warehouse → Buying
const deskCtx = await newContext({ viewport: { width: 1600, height: 1000 } })
const login = await deskCtx.request.post('/api/method/login', { data: { usr: WH_USER.usr, pwd: WH_USER.pwd } })
if (!login.ok()) throw new Error(`warehouse admin login failed ${login.status()}`)
const desk = await deskCtx.newPage()
wireConsole(desk, 'warehouse')

await desk.goto('/warehouse', { waitUntil: 'domcontentloaded' })
await desk.waitForSelector('[data-testid=warehouse-desk]', { timeout: 40000 })
await desk.click('[data-testid=tab-buying]')
await desk.waitForSelector('[data-testid=buying-board]', { timeout: 30000 })
await desk.waitForSelector(`[data-testid="sug-${SWAP.item_code}"]`, { timeout: 30000 })

const rowCount = await desk.locator('article[data-testid^="sug-"]').count()
const badges = await desk.$$eval('[data-testid=source-badge]', (es) => es.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
const KNOWN_SOURCES = ['Low stock', 'Store demand', 'Trending']
record('the Buying board opens on /warehouse and lists the demand engine\'s suggestions',
  rowCount === suggestions.length && rowCount > 0,
  `${rowCount} rows rendered, server built ${suggestions.length} (run ${built.run_id})`)
record('every suggestion carries a source badge and every badge is one of the three sources',
  badges.length === rowCount && badges.length > 0 && badges.every((b) => KNOWN_SOURCES.some((s) => b.toLowerCase().includes(s.toLowerCase()))),
  `${badges.length} badges: ${[...new Set(badges)].join(' | ')}`)
await shot(desk, 'buying-suggestions', true)

// ================================================================ 2. edit the quantity, swap the vendor, create the orders
const qtySel = `[data-testid="sug-qty-${SWAP.item_code}"]`
await desk.fill(qtySel, String(TYPED_QTY))
await desk.press(qtySel, 'Enter')
await desk.waitForFunction(
  ([sel, want]) => document.querySelector(sel)?.value === String(want),
  [qtySel, SNAPPED_QTY],
  { timeout: 10000 }
).catch(() => {})
const shownQty = await desk.inputValue(qtySel)
const snapNote = await desk.locator(`[data-testid="sug-note-${SWAP.item_code}"]`).innerText().catch(() => '')
record('a typed quantity snaps up to a whole case of the vendor\'s case pack',
  Number(shownQty) === SNAPPED_QTY && SNAPPED_QTY > TYPED_QTY,
  `typed ${TYPED_QTY} → ${shownQty} (case pack ${SWAP.case_pack}, MOQ ${SWAP.moq}) · "${snapNote.replace(/\s+/g, ' ').trim()}"`)

const altSel = `[data-testid="sug-vendor-${SWAP.item_code}-${ALT.supplier}"]`
const isChosen = () => desk.locator(altSel).evaluate((e) => e.classList.contains('on')).catch(() => false)
/** where the vendor button sits *inside its own card* — immune to the scrolling Playwright does */
const offsetInRow = (sel) => desk.locator(sel)
  .evaluate((e) => Math.round(e.getBoundingClientRect().top - e.closest('article').getBoundingClientRect().top))
  .catch(() => null)

// a buyer edits the quantity and then taps the vendor they want: one gesture after the other, with
// the quantity input still focused. Watch whether the row moves under the finger while they do it.
const noteHeight = await desk.locator(`[data-testid="sug-note-${SWAP.item_code}"]`)
  .evaluate((e) => Math.round(e.getBoundingClientRect().height)).catch(() => null)
const offsetBefore = await offsetInRow(altSel)
await desk.click(altSel)
await desk.waitForTimeout(400)
const firstTapTook = await isChosen()
const offsetAfter = await offsetInRow(altSel)
const shifted = offsetBefore != null && offsetAfter != null ? offsetAfter - offsetBefore : null
record('tapping an alternative vendor straight after typing a quantity registers on the first tap',
  firstTapTook,
  firstTapTook
    ? `${ALT.supplier} selected on the first tap`
    : `the tap was swallowed. Committing the quantity on blur cleared the ${SWAP.item_code} note, which unmounted a ` +
      `${noteHeight}px paragraph and moved the vendor buttons ${shifted}px up inside their own card between mousedown ` +
      `and mouseup, so the pointer was released off the button and no click event was ever dispatched ` +
      `(BuySuggestRow.vue: @blur=commitQty sets note='' → <p data-testid="sug-note-*"> unmounts → .vendors jumps)`)

// whichever way that went, the swap itself is the contract — settle the layout and tap again
if (!firstTapTook) {
  await desk.locator(qtySel).blur().catch(() => {})
  await desk.waitForTimeout(400)
  await desk.click(altSel)
  await desk.waitForTimeout(400)
}
const altOn = await isChosen()
const deltaText = await desk.locator(`[data-testid="sug-delta-${SWAP.item_code}-${ALT.supplier}"]`).innerText().catch(() => '')
const swapNote = await desk.locator(`[data-testid="sug-note-${SWAP.item_code}"]`).innerText().catch(() => '')
const expectedDelta = round(Number(ALT.cost) - Number(SWAP.cost), 4)
record('the row moves to the alternative vendor and the unit cost moves with it',
  altOn && !!deltaText && deltaText.includes(Math.abs(expectedDelta).toFixed(2)),
  `${SWAP.item_code}: ${SWAP.supplier} $${SWAP.cost} → ${ALT.supplier} $${ALT.cost} · chip "${deltaText.replace(/\s+/g, ' ').trim()}" · "${swapNote.replace(/\s+/g, ' ').trim()}"`)

// the two rows that stay with the preferred vendor
for (const row of [MA_ROW, SHORT_ROW]) {
  await desk.click(`[data-testid="sug-${row.item_code}"] .pick input`)
}
await desk.waitForTimeout(200)
const footer = (await desk.locator('[data-testid=buy-footer]').innerText()).replace(/\s+/g, ' ').trim()
const createCopy = (await desk.locator('[data-testid=buy-create]').innerText()).trim()
record('the footer plans one order per vendor before anything is written',
  /Create 2 orders across 2 vendors/i.test(createCopy),
  `${createCopy} · ${footer}`)
await shot(desk, 'buying-selected', true)

const before = await poNames()
await desk.click('[data-testid=buy-create]')
await desk.waitForSelector('[data-testid=buy-created]', { timeout: 30000 })
const createdBanner = (await desk.locator('[data-testid=buy-created]').innerText()).replace(/\s+/g, ' ').trim()
const after = await poNames()
const createdOrders = [...after].filter((n) => !before.has(n))
const orderDocs = {}
for (const name of createdOrders) orderDocs[name] = await admin.get('maison_pos.api.purchasing.order', { name })
const mainOrder = createdOrders.find((n) => orderDocs[n].supplier === VENDOR)
const altOrder = createdOrders.find((n) => orderDocs[n].supplier === ALT.supplier)
record('Create orders returns one draft Purchase Order per vendor, and nothing else',
  createdOrders.length === 2 && !!mainOrder && !!altOrder &&
    orderDocs[mainOrder].docstatus === 0 && orderDocs[altOrder].docstatus === 0 &&
    orderDocs[mainOrder].items.length === 2 && orderDocs[altOrder].items.length === 1,
  `${createdOrders.map((n) => `${n}=${orderDocs[n].supplier}(${orderDocs[n].items.length} lines, docstatus ${orderDocs[n].docstatus})`).join(', ')} · banner "${createdBanner}"`)

const altLine = orderDocs[altOrder]?.items?.[0]
record('the swapped line was bought from the alternative vendor at the alternative vendor\'s cost',
  !!altLine && altLine.item_code === SWAP.item_code && round(altLine.rate) === round(Number(ALT.cost)) && round(altLine.rate) !== round(Number(SWAP.cost)),
  `${altOrder}: ${altLine?.item_code} ×${altLine?.qty} @ $${altLine?.rate} from ${orderDocs[altOrder]?.supplier} (preferred ${SWAP.supplier} was $${SWAP.cost})`)

// ================================================================ 3. override a rate, add freight by hand
await desk.click('[data-testid=buy-tab-orders]')
await desk.waitForSelector(`[data-testid="order-${mainOrder}"]`, { timeout: 25000 })
await desk.click(`[data-testid="open-order-${mainOrder}"]`)
await desk.waitForSelector('[data-testid=order-sheet]', { timeout: 25000 })

// trim both lines to a delivery a person can actually count, and override the short line's rate
await desk.fill(`[data-testid="order-qty-${MA_ROW.item_code}"]`, String(ORDER_QTY_MA))
await desk.fill(`[data-testid="order-qty-${SHORT_ROW.item_code}"]`, String(ORDER_QTY_SHORT))
await desk.fill(`[data-testid="order-rate-${SHORT_ROW.item_code}"]`, String(ORDER_RATE_SHORT))
await desk.fill('[data-testid=order-freight-input]', String(FREIGHT))
await desk.waitForTimeout(300)
const expectedNet = round(ORDER_QTY_MA * Number(MA_ROW.cost) + ORDER_QTY_SHORT * ORDER_RATE_SHORT)
const landedText = (await desk.locator('[data-testid=order-landed]').innerText()).trim()
await shot(desk, 'order-freight-override', true)
await desk.click('[data-testid=order-save]')
const saved = await until(
  async () => {
    const doc = await admin.get('maison_pos.api.purchasing.order', { name: mainOrder })
    return round(doc.freight) === FREIGHT ? doc : null
  },
  { timeout: 25000 }
) || await admin.get('maison_pos.api.purchasing.order', { name: mainOrder })
const savedShort = saved.items.find((l) => l.item_code === SHORT_ROW.item_code)
const savedMa = saved.items.find((l) => l.item_code === MA_ROW.item_code)
record('the hand-typed line rate is what the server stored (client decision 4)',
  !!savedShort && round(savedShort.rate) === ORDER_RATE_SHORT && round(savedShort.rate) !== round(Number(SHORT_ROW.cost)),
  `${SHORT_ROW.item_code}: catalogue $${SHORT_ROW.cost} → stored $${savedShort?.rate} (×${savedShort?.qty}); ${MA_ROW.item_code} ×${savedMa?.qty} @ $${savedMa?.rate}`)

const poDoc = await admin.doc('Purchase Order', mainOrder)
const poTaxes = poDoc.taxes || []
const freightRow = poTaxes.find((t) => Number(t.tax_amount) === FREIGHT) || poTaxes[0]
record('the hand-entered freight is stored and posted as one Actual/Valuation charge (decision 3)',
  round(saved.freight) === FREIGHT && poTaxes.length === 1 && !!freightRow && freightRow.charge_type === 'Actual' &&
    freightRow.category === 'Valuation' && freightRow.add_deduct_tax === 'Add' && round(freightRow.tax_amount) === FREIGHT,
  `maison_freight_amount=${saved.freight}; ${poTaxes.length} tax row(s): ${freightRow?.charge_type}/${freightRow?.category}/${freightRow?.add_deduct_tax} "${freightRow?.description}" $${freightRow?.tax_amount} → ${freightRow?.account_head}`)

record('landed total = net + freight, on the screen and on the document',
  round(saved.net_total) === expectedNet && round(saved.landed_total) === round(expectedNet + FREIGHT) &&
    landedText.replace(/[^0-9.]/g, '') === round(expectedNet + FREIGHT).toFixed(2),
  `net $${saved.net_total} + freight $${saved.freight} = landed $${saved.landed_total}; screen showed ${landedText} (expected $${round(expectedNet + FREIGHT).toFixed(2)})`)

// ================================================================ 4. submit, then send it by phone
await desk.click('[data-testid=order-submit]')
const submitted = await until(
  async () => {
    const doc = await admin.get('maison_pos.api.purchasing.order', { name: mainOrder })
    return doc.docstatus === 1 ? doc : null
  },
  { timeout: 30000 }
) || await admin.get('maison_pos.api.purchasing.order', { name: mainOrder })
record('submitting the order moves it out of draft on the server',
  submitted.docstatus === 1 && submitted.status !== 'Draft',
  `${mainOrder} docstatus=${submitted.docstatus} status=${submitted.status} expected ${submitted.schedule_date}`)

const commsBefore = await admin.list('Email Queue', {}, ['name'], 500).then((r) => r.length).catch(() => 0)
await desk.click('[data-testid=order-send-open]')
await desk.waitForSelector('[data-testid=send-method-Phone]', { timeout: 15000 })
await desk.click('[data-testid=send-method-Phone]')
await desk.click('[data-testid=order-send]')
await desk.waitForSelector('[data-testid=order-sent]', { timeout: 25000 })
const sentLine = (await desk.locator('[data-testid=order-sent]').innerText()).replace(/\s+/g, ' ').trim()
const sentDoc = await admin.value('Purchase Order', mainOrder, ['maison_sent_on', 'maison_sent_by', 'maison_sent_method'])
const commsAfter = await admin.list('Email Queue', {}, ['name'], 500).then((r) => r.length).catch(() => 0)
record('“sent by phone” stamps sent_on / sent_by / sent_method and fires no e-mail',
  !!sentDoc?.maison_sent_on && sentDoc.maison_sent_method === 'Phone' && sentDoc.maison_sent_by === WH_USER.usr &&
    commsAfter === commsBefore && /Phone/.test(sentLine),
  `${sentDoc?.maison_sent_method} on ${sentDoc?.maison_sent_on} by ${sentDoc?.maison_sent_by}; e-mail queue ${commsBefore}→${commsAfter}; screen "${sentLine}"`)
await shot(desk, 'order-submitted-sent', true)
await desk.click('.modal-head button.close')
await desk.waitForSelector('[data-testid=order-sheet]', { state: 'detached', timeout: 15000 }).catch(() => {})

// ================================================================ the wall's new Inbound column
const wallCtx = await newContext({ viewport: { width: 1920, height: 1080 } })
await wallCtx.request.post('/api/method/login', { data: { usr: WH_USER.usr, pwd: WH_USER.pwd } })
const wall = await wallCtx.newPage()
wireConsole(wall, 'wall')
await wall.addInitScript(() => { window.__awanzWallPrintDry = true })
await wall.goto('/warehouse-wall', { waitUntil: 'domcontentloaded' })
await wall.waitForSelector('[data-testid=warehouse-wall]', { timeout: 40000 })
let wallCard = false
try {
  await wall.waitForSelector(`[data-testid="wall-inbound-${mainOrder}"]`, { timeout: 30000 })
  wallCard = true
} catch { wallCard = false }
const inboundCount = await wall.locator('[data-testid=col-inbound]').getAttribute('data-count').catch(() => null)
const inboundText = await wall.locator('[data-testid=col-inbound]').innerText().catch(() => '')
record('the wall board carries an Inbound column and the submitted order lands on it',
  wallCard && Number(inboundCount) >= 1,
  `col-inbound count=${inboundCount}; card for ${mainOrder}: ${wallCard} · ${inboundText.replace(/\s+/g, ' ').trim().slice(0, 160)}`)
await shot(wall, 'wall-inbound', false)
await wallCtx.close()

// ================================================================ 5. receive it at HOU-WH, by scan, one line short
await desk.click('[data-testid=tab-inbound]')
await desk.waitForSelector('[data-testid=inbound-board]', { timeout: 25000 })
await desk.waitForSelector(`[data-testid="inbound-po-${mainOrder}"]`, { timeout: 25000 })
const etaPill = (await desk.locator(`[data-testid="inbound-eta-${mainOrder}"]`).innerText()).replace(/\s+/g, ' ').trim()
record('the submitted order is on Inbound as expected stock, with an ETA',
  !!etaPill,
  `${mainOrder} ETA pill "${etaPill}" · ${(await desk.locator(`[data-testid="inbound-po-${mainOrder}"]`).innerText()).replace(/\s+/g, ' ').trim().slice(0, 160)}`)
await shot(desk, 'inbound-expected', true)

// the state the moving-average expectation is computed from, read one moment before the receipt
const maBefore = await binOf(MA_ROW.item_code, HQ)
const shortBefore = await binOf(SHORT_ROW.item_code, HQ)

await desk.click(`[data-testid="inbound-receive-${mainOrder}"]`)
await desk.waitForSelector('[data-testid=receive-lines]', { timeout: 25000 })

// scan every unit in: one barcode read per unit, exactly as the floor does it
const maBarcode = stockOf[MA_ROW.item_code]?.barcode || MA_ROW.barcode || MA_ROW.item_code
const shortBarcode = stockOf[SHORT_ROW.item_code]?.barcode || SHORT_ROW.barcode || SHORT_ROW.item_code
const scan = desk.locator('[data-testid=receive-scan]')
for (let i = 0; i < ORDER_QTY_MA; i++) { await scan.fill(maBarcode); await scan.press('Enter') }
for (let i = 0; i < RECEIVE_SHORT; i++) { await scan.fill(shortBarcode); await scan.press('Enter') }
const lastScan = (await desk.locator('[data-testid=receive-last-scan]').innerText()).replace(/\s+/g, ' ').trim()
const countedMa = await desk.inputValue(`[data-testid="receive-qty-${MA_ROW.item_code}"]`)
const countedShort = await desk.inputValue(`[data-testid="receive-qty-${SHORT_ROW.item_code}"]`)
record('scanning a barcode counts one unit onto the line it belongs to',
  Number(countedMa) === ORDER_QTY_MA && Number(countedShort) === RECEIVE_SHORT,
  `${maBarcode} ×${ORDER_QTY_MA} → ${countedMa}; ${shortBarcode} ×${RECEIVE_SHORT} → ${countedShort} (ordered ${ORDER_QTY_SHORT}) · "${lastScan}"`)

// the manual unit-cost override at receipt, and "this is the whole delivery"
await desk.fill(`[data-testid="receive-rate-${MA_ROW.item_code}"]`, String(RECEIPT_RATE_MA))
await desk.click('[data-testid=receive-final]')
await desk.waitForTimeout(400)
const variance = await desk.locator(`[data-testid="receive-variance-${SHORT_ROW.item_code}"]`).innerText().catch(() => '')
record('the sheet flags the short line before anything is posted',
  /short/i.test(variance),
  `${SHORT_ROW.item_code}: "${variance.replace(/\s+/g, ' ').trim()}" (ordered ${ORDER_QTY_SHORT}, counted ${RECEIVE_SHORT})`)

const receiptLines = [
  { qty: ORDER_QTY_MA, rate: RECEIPT_RATE_MA },
  { qty: RECEIVE_SHORT, rate: ORDER_RATE_SHORT }
]
const expected = expectedMovingAverage({
  qtyBefore: maBefore.qty, rateBefore: maBefore.rate,
  qtyIn: ORDER_QTY_MA, rateIn: RECEIPT_RATE_MA, freight: FREIGHT, receiptLines
})
// what the screen is telling the manager will happen
const previewText = (await desk.locator(`[data-testid="receive-ma-${MA_ROW.item_code}"]`).innerText()).replace(/\s+/g, ' ').trim()
const previewAfter = Number((previewText.match(/([\d,]+\.\d{2})\s*$/)?.[1] || '').replace(/,/g, ''))
await shot(desk, 'receive-scan-override', true)

await desk.click('[data-testid=receive-post]')
// `final` with something outstanding asks for confirmation first
if (await desk.locator('[data-testid=receive-confirm-panel]').count()) {
  await shot(desk, 'receive-confirm', true)
  await desk.click('[data-testid=receive-post]')
}
await desk.waitForSelector('[data-testid=receive-lines]', { state: 'detached', timeout: 40000 }).catch(() => {})
await desk.waitForTimeout(1500)

const receivedPo = await until(
  async () => {
    const doc = await admin.get('maison_pos.api.purchasing.order', { name: mainOrder })
    return doc.receipts?.length ? doc : null
  },
  { timeout: 30000 }
) || await admin.get('maison_pos.api.purchasing.order', { name: mainOrder })
const receipts = receivedPo.receipts || []
const prName = receipts[0]?.purchase_receipt
const maLine = receivedPo.items.find((l) => l.item_code === MA_ROW.item_code)
const shortLine = receivedPo.items.find((l) => l.item_code === SHORT_ROW.item_code)
record('posting the receipt creates a Purchase Receipt and raises received_qty on the order',
  !!prName && maLine?.received_qty === ORDER_QTY_MA && shortLine?.received_qty === RECEIVE_SHORT,
  `${prName || 'no receipt'} · ${MA_ROW.item_code} received ${maLine?.received_qty}/${maLine?.qty}, ${SHORT_ROW.item_code} received ${shortLine?.received_qty}/${shortLine?.qty} · per_received ${receivedPo.per_received}%`)

const discs = await admin.list('AWANZ Receiving Discrepancy', { purchase_order: mainOrder },
  ['name', 'type', 'status', 'supplier', 'item_code', 'short_qty', 'purchase_receipt', 'boutique'], 50)
const shortDisc = discs.find((d) => d.type === 'Short' && d.item_code === SHORT_ROW.item_code)
record('the missing units raise a Short AWANZ Receiving Discrepancy against the vendor',
  !!shortDisc && shortDisc.supplier === VENDOR && Number(shortDisc.short_qty) === ORDER_QTY_SHORT - RECEIVE_SHORT && shortDisc.status === 'Open',
  `${shortDisc?.name}: ${shortDisc?.type} ${shortDisc?.short_qty} of ${SHORT_ROW.item_code} vs ${shortDisc?.supplier} (${shortDisc?.status}) on ${shortDisc?.purchase_receipt}; all raised: ${discs.map((d) => `${d.type}×${d.short_qty || d.over_qty || d.damaged_qty}`).join(', ')}`)

// "This is the whole delivery" — the toggle says, in the sheet's own words, "Closes the order and
// raises a Short discrepancy against the vendor for anything missing", and `receiveOutcome` repeats
// it ("The order is closed. The shorts are on the Inbound discrepancies list").
const stillExpected = (await whApi.get('maison_pos.api.purchasing.inbound')).expected.map((p) => p.name)
record('“this is the whole delivery” closes the order, the way the sheet says it will',
  ['Closed', 'Completed'].includes(receivedPo.status) && !stillExpected.includes(mainOrder),
  `${mainOrder} is ${receivedPo.status} at ${round(receivedPo.per_received, 2)}% received and ` +
  `${stillExpected.includes(mainOrder) ? 'still on' : 'off'} the Inbound expected list ` +
  `(${SHORT_ROW.item_code} left ${ORDER_QTY_SHORT - RECEIVE_SHORT} outstanding, already settled as a Short against ${VENDOR})`)

const prDoc = prName ? await admin.doc('Purchase Receipt', prName) : null
const prTaxes = prDoc?.taxes || []
const prFreight = prTaxes.find((t) => t.category === 'Valuation')
record('the freight travels onto the Purchase Receipt as its own valuation charge',
  !!prFreight && prTaxes.length === 1 && prFreight.charge_type === 'Actual' && prFreight.add_deduct_tax === 'Add' &&
    round(prFreight.tax_amount) === FREIGHT && round(prDoc.maison_freight_amount) === FREIGHT,
  `${prName}: ${prTaxes.length} tax row(s) — ${prFreight?.charge_type}/${prFreight?.category}/${prFreight?.add_deduct_tax} $${prFreight?.tax_amount} → ${prFreight?.account_head}`)

const maAfter = await binOf(MA_ROW.item_code, HQ)
const drift = Math.abs(maAfter.rate - expected.rate)
record('the item\'s moving-average valuation rate moved to the value this run computed, freight included',
  drift < 0.005 && maAfter.qty === expected.qtyAfter,
  `${MA_ROW.item_code}: ${maBefore.qty} @ $${maBefore.rate} + ${ORDER_QTY_MA} @ $${RECEIPT_RATE_MA}` +
  ` (+$${round(expected.share)} of the $${FREIGHT} freight, shared by line amount → landed $${round(expected.landedRate, 4)})` +
  ` ⇒ expected $${round(expected.rate, 4)} on ${expected.qtyAfter}; server says $${round(maAfter.rate, 4)} on ${maAfter.qty} (drift $${round(drift, 6)})`)

const noFreight = expectedMovingAverage({ qtyBefore: maBefore.qty, rateBefore: maBefore.rate, qtyIn: ORDER_QTY_MA, rateIn: RECEIPT_RATE_MA, freight: 0, receiptLines })
record('freight really is inside that valuation — the same receipt without it lands somewhere else',
  Math.abs(maAfter.rate - noFreight.rate) > 0.005,
  `with freight $${round(expected.rate, 4)} vs without $${round(noFreight.rate, 4)} — server booked $${round(maAfter.rate, 4)}`)

record('the moving-average preview the sheet showed is the move that actually happened',
  Number.isFinite(previewAfter) && Math.abs(previewAfter - maAfter.rate) < 0.01,
  `sheet previewed "${previewText}" (after $${previewAfter}); the receipt actually moved ${MA_ROW.item_code} to $${round(maAfter.rate, 4)}`)

const shortAfter = await binOf(SHORT_ROW.item_code, HQ)
record('the short line put nothing extra into stock beyond what was counted',
  shortAfter.qty === shortBefore.qty + RECEIVE_SHORT,
  `${SHORT_ROW.item_code}: ${shortBefore.qty} → ${shortAfter.qty} (counted ${RECEIVE_SHORT} of the ${ORDER_QTY_SHORT} ordered)`)

// ---------------------------------------------------------------- Stock board: value at MA, cover days
await desk.click('[data-testid=tab-stock]')
await desk.waitForSelector('[data-testid=stock-board]', { timeout: 25000 })
await desk.fill('[data-testid=stock-search]', MA_ROW.item_code)
await desk.waitForSelector(`[data-testid="stock-${MA_ROW.item_code}"]`, { timeout: 20000 })
const stockRowText = (await desk.locator(`[data-testid="stock-${MA_ROW.item_code}"]`).innerText()).replace(/\s+/g, ' ').trim()
const coverText = (await desk.locator(`[data-testid="stock-cover-${MA_ROW.item_code}"]`).innerText()).replace(/\s+/g, ' ').trim()
const summaryText = (await desk.locator('[data-testid=stock-summary]').innerText()).replace(/\s+/g, ' ').trim()
record('the Stock board values HOU-WH at the new moving average and shows cover days',
  stockRowText.includes(round(maAfter.rate).toFixed(2)) && !!coverText && /\d/.test(summaryText),
  `${MA_ROW.item_code} row "${stockRowText.slice(0, 150)}" · cover "${coverText}" · ${summaryText.slice(0, 120)}`)
await shot(desk, 'stock-board', true)

// ---------------------------------------------------------------- Vendors board: a vendor and its catalogue
await desk.click('[data-testid=tab-vendors]')
await desk.waitForSelector('[data-testid=vendors-board]', { timeout: 25000 })
await desk.waitForSelector(`[data-testid="open-vendor-${VENDOR}"]`, { timeout: 20000 })
const spendCell = (await desk.locator(`[data-testid="vendor-spend-${VENDOR}"]`).innerText()).trim()
await desk.click(`[data-testid="open-vendor-${VENDOR}"]`)
await desk.waitForSelector('[data-testid=vendor-sheet]', { timeout: 20000 })
await desk.click('[data-testid=vendor-tab-catalogue]')
await desk.waitForSelector('[data-testid=vendor-catalogue]', { timeout: 20000 })
const catRows = await desk.locator('tr[data-testid^="cat-"]').count()
const catalogue = await admin.get('maison_pos.api.purchasing.vendor', { name: VENDOR })
record('the Vendors board opens a vendor and shows the catalogue we buy from them',
  catRows > 0 && catRows === (catalogue.catalogue || []).length,
  `${VENDOR}: ${catRows} catalogue rows on screen, ${(catalogue.catalogue || []).length} on the server; 12-month spend cell "${spendCell}"`)
await shot(desk, 'vendor-catalogue', true)
await desk.click('.modal-head button.close').catch(() => {})

// ================================================================ 6. a drop-ship order the store receives itself
await desk.click('[data-testid=tab-buying]')
await desk.waitForSelector('[data-testid=buying-board]', { timeout: 25000 })
await desk.click('[data-testid=buy-tab-suggest]').catch(() => {})
await desk.waitForSelector(`[data-testid="sug-${DROP.item_code}"]`, { timeout: 25000 })
await desk.click(`[data-testid="sug-${DROP.item_code}"] .pick input`)
await desk.selectOption('[data-testid=buy-dropship]', STORE)
await desk.waitForTimeout(200)
const dropBefore = await poNames()
await desk.click('[data-testid=buy-create]')
await desk.waitForSelector('[data-testid=buy-created]', { timeout: 30000 })
const dropOrder = [...(await poNames())].find((n) => !dropBefore.has(n))
record('a drop-ship order is raised against the vendor but addressed to the store',
  !!dropOrder,
  `${dropOrder} → ${STORE}`)

// trim it to a countable delivery and submit
await desk.click('[data-testid=buy-tab-orders]')
await desk.waitForSelector(`[data-testid="order-${dropOrder}"]`, { timeout: 25000 })
await desk.click(`[data-testid="open-order-${dropOrder}"]`)
await desk.waitForSelector('[data-testid=order-sheet]', { timeout: 25000 })
const dropWarn = (await desk.locator('[data-testid=order-dropship-warning]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
await desk.fill(`[data-testid="order-qty-${DROP.item_code}"]`, String(DROP_QTY))
await desk.waitForTimeout(200)
await desk.click('[data-testid=order-save]')
await until(async () => {
  const doc = await admin.get('maison_pos.api.purchasing.order', { name: dropOrder })
  return doc.items?.[0]?.qty === DROP_QTY ? doc : null
}, { timeout: 25000 })
await desk.click('[data-testid=order-submit]')
const dropDoc = await until(async () => {
  const doc = await admin.get('maison_pos.api.purchasing.order', { name: dropOrder })
  return doc.docstatus === 1 ? doc : null
}, { timeout: 30000 }) || await admin.get('maison_pos.api.purchasing.order', { name: dropOrder })
await shot(desk, 'dropship-order', true)

const dropWarehouse = storeRow.warehouse
record('the drop-ship order ships every line to the store\'s own warehouse and is submitted',
  dropDoc.docstatus === 1 && dropDoc.dropship_store === STORE && dropDoc.set_warehouse === dropWarehouse &&
    dropDoc.items.every((l) => l.warehouse === dropWarehouse),
  `${dropOrder}: dropship_store=${dropDoc.dropship_store} set_warehouse=${dropDoc.set_warehouse} lines→${[...new Set(dropDoc.items.map((l) => l.warehouse))].join(',')} docstatus=${dropDoc.docstatus} · screen said "${dropWarn.slice(0, 120)}"`)
await desk.click('.modal-head button.close').catch(() => {})

// ---- the store receives it on the POS Receive screen
const mgrCtx = await newContext({ viewport: { width: 1366, height: 1024 } })
const mgrLogin = await mgrCtx.request.post('/api/method/login', { data: { usr: MANAGER.usr, pwd: MANAGER.pwd } })
if (!mgrLogin.ok()) throw new Error(`store manager login failed ${mgrLogin.status()}`)
const mgr = await mgrCtx.newPage()
wireConsole(mgr, 'store')

async function unlockPos(page, user, store) {
  await page.goto('/pos/unlock', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { localStorage.setItem('awanzE2E', '1') })
  await page.goto('/pos', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unlock select.input', { timeout: 40000 })
  await page.selectOption('.unlock select.input >> nth=0', store)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 60000 })
  const opts = await page.$$eval('.unlock select.input >> nth=1 >> option', (os) => os.map((o) => o.value))
  if (!opts.includes(user.usr)) throw new Error(`${user.usr} is not on ${store}'s associate list: ${opts.join(', ')}`)
  await page.selectOption('.unlock select.input >> nth=1', user.usr)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === user.usr) break
    await page.selectOption('.unlock select.input >> nth=1', user.usr)
  }
  for (const d of String(user.pin)) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 40000 })
}

const dropBinBefore = await binOf(DROP.item_code, dropWarehouse)
let storeReceived = ''
let storeOk = false
try {
  await unlockPos(mgr, MANAGER, STORE)
  await mgr.goto('/pos/receive', { waitUntil: 'domcontentloaded' })
  await mgr.waitForSelector('[data-testid=vendor-pos]', { timeout: 30000 })
  await mgr.waitForSelector(`[data-testid="po-${dropOrder}"]`, { timeout: 25000 })
  await shot(mgr, 'store-vendor-pos', false)
  await mgr.click(`[data-testid="po-${dropOrder}"]`)
  await mgr.waitForSelector('[data-testid=count-sheet]', { timeout: 20000 })
  const bc = stockOf[DROP.item_code]?.barcode || DROP.barcode || DROP.item_code
  const input = mgr.locator('[data-testid=count-input]')
  for (let i = 0; i < DROP_QTY; i++) { await input.fill(bc); await input.press('Enter') }
  const counted = await mgr.inputValue(`[data-testid="count-qty-${DROP.item_code}"]`)
  storeReceived = `scanned ${bc} ×${DROP_QTY} → ${counted}`
  await shot(mgr, 'store-count-sheet', false)
  await mgr.click('[data-testid=count-confirm]')
  await mgr.waitForSelector('[data-testid=pr-result]', { timeout: 40000 })
  storeReceived += ' | ' + (await mgr.locator('[data-testid=pr-result]').innerText()).replace(/\s+/g, ' ').trim().slice(0, 160)
  storeOk = true
} catch (e) {
  storeReceived = String(e).slice(0, 300)
}
const dropReceipts = (await until(
  async () => {
    const doc = await admin.get('maison_pos.api.purchasing.order', { name: dropOrder })
    return doc.receipts?.length ? doc : null
  },
  { timeout: 20000 }
))?.receipts || []
const dropBinAfter = await binOf(DROP.item_code, dropWarehouse)
record(`the ${STORE} manager receives the drop-ship on their own Receive screen`,
  storeOk && dropReceipts.length === 1 && dropReceipts[0].warehouse === dropWarehouse &&
    Number(dropReceipts[0].qty) === DROP_QTY && dropBinAfter.qty === dropBinBefore.qty + DROP_QTY,
  `${dropReceipts[0]?.purchase_receipt || 'no receipt'} into ${dropReceipts[0]?.warehouse}; ${DROP.item_code} at ${STORE} ${dropBinBefore.qty}→${dropBinAfter.qty} · ${storeReceived}`)
const prPanel = storeOk ? (await mgr.locator('[data-testid=pr-result]').innerText()).replace(/\s+/g, ' ').trim() : ''
record('the store is told, line by line, what the receipt actually booked',
  prPanel.includes(`${DROP.item_code} × ${DROP_QTY}`) && !/undefined/.test(prPanel),
  `panel reads "${prPanel}" — expected "${DROP.item_code} × ${DROP_QTY}"` +
  (/undefined/.test(prPanel)
    ? ' (ReceiveView.vue prints prResult.lines[].qty, but receiving.receive_purchase_order returns received_qty / posted_qty / accepted_qty and no qty)'
    : ''))
await shot(mgr, 'store-received', false)

// ================================================================ 7. the store manager is shut out of buying
await mgr.goto('/warehouse', { waitUntil: 'domcontentloaded' })
let gate = ''
try {
  await mgr.waitForSelector('[data-testid=desk-gate]', { timeout: 25000 })
  gate = (await mgr.locator('[data-testid=desk-gate]').innerText()).replace(/\s+/g, ' ').trim()
} catch { gate = '' }
const sawBuying = await mgr.locator('[data-testid=buying-board]').count()
record('/warehouse offers a store manager nothing — the desk gates them out',
  !!gate && sawBuying === 0,
  `gate: "${gate.slice(0, 160)}"; buying board rendered: ${sawBuying}`)
await mgr.goto('/warehouse/buying', { waitUntil: 'domcontentloaded' })
await mgr.waitForSelector('[data-testid=desk-gate]', { timeout: 25000 }).catch(() => {})
const gateB = await mgr.locator('[data-testid=desk-gate]').count()
const buyingB = await mgr.locator('[data-testid=buying-board]').count()
record('a deep link straight to /warehouse/buying is gated the same way',
  gateB === 1 && buyingB === 0,
  `desk-gate=${gateB} buying-board=${buyingB}`)
await shot(mgr, 'store-gated', false)

const mgrApi = await client(MANAGER)
const denied = []
denied.push(['suggestions', await mgrApi.rawGet('maison_pos.api.purchasing.suggestions')])
denied.push(['stock', await mgrApi.rawGet('maison_pos.api.purchasing.stock')])
denied.push(['vendors', await mgrApi.rawGet('maison_pos.api.purchasing.vendors')])
denied.push(['create_order', await mgrApi.rawPost('maison_pos.api.purchasing.create_order', {
  supplier: VENDOR, lines: [{ item_code: MA_ROW.item_code, qty: 1 }]
})])
const allDenied = denied.every(([, r]) => r.status === 403)
record('every purchasing endpoint answers a store manager with 403 over plain HTTP',
  allDenied,
  denied.map(([n, r]) => `${n}=${r.status}`).join(' '))
record('and the refusal says why, rather than leaking a stack trace',
  denied.every(([, r]) => /centralis|permitted|not allowed/i.test(JSON.stringify(r.body))),
  String(denied[0][1].body?._server_messages || denied[0][1].body?.exception || '').slice(0, 200))

const readOwn = await mgrApi.rawGet('maison_pos.api.purchasing.order', { name: dropOrder })
const readOther = await mgrApi.rawGet('maison_pos.api.purchasing.order', { name: mainOrder })
record('the one purchasing right a store keeps: read its own drop-ship order, and nothing else',
  readOwn.status === 200 && readOther.status === 403,
  `${dropOrder} (addressed to ${STORE}) → ${readOwn.status}; ${mainOrder} (Houston) → ${readOther.status}`)
await mgrApi.dispose()

// ---------------------------------------------------------------- report
const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed; console issues: ${console_.length}`)
for (const c of console_.slice(0, 10)) log(`  ${c.tag} ${c.type} ${c.text}`)
writeFileSync(path.join(here, 'results.purchasing.json'), JSON.stringify({
  base: BASE,
  warehouse: HQ,
  vendor: VENDOR,
  items: { moving_average: MA_ROW.item_code, short: SHORT_ROW.item_code, swapped: SWAP.item_code, dropship: DROP.item_code },
  alternative_vendor: ALT?.supplier,
  orders: { main: mainOrder, alternative: altOrder, dropship: dropOrder },
  moving_average: {
    item: MA_ROW.item_code,
    qty_before: maBefore.qty,
    rate_before: maBefore.rate,
    received_qty: ORDER_QTY_MA,
    unit_cost_override: RECEIPT_RATE_MA,
    freight_on_receipt: FREIGHT,
    freight_share_on_this_line: round(expected.share, 4),
    landed_unit_rate: round(expected.landedRate, 4),
    expected_rate: round(expected.rate, 4),
    actual_rate: round(maAfter.rate, 4),
    sheet_preview_after: previewAfter
  },
  results,
  console: console_
}, null, 1))
await browser.close()
process.exit(passed === results.length ? 0 : 1)
