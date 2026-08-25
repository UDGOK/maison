/**
 * v1.1 "Onboarding a product" — a brand-new product, from the rep's sheet to eleven shops,
 * end to end against a live bench.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc.localhost:8001 ADMIN_PWD=admin \
 *     node e2e/distribution.e2e.mjs
 *
 * SPEC_v1.1 §E asks for exactly this run, driven through the real `/warehouse` screens and then
 * checked against what the server actually stored. It is the story the client asked "how do I do
 * this?" about, in the order their day happens:
 *
 *   1. **Buying → New product.** A rep leaves a sheet behind: code, name, group, barcode, what we
 *      pay, when to reorder, what it sells for. One sheet, one call. The server must have built the
 *      `Item`, the `AWANZ Item Vendor` row, the vendor's **buying** `Item Price`, the `Item Reorder`
 *      row at HOU-WH and the selling price — and marked that vendor **preferred**, because it is the
 *      item's first.
 *   2. **Order it from scratch.** The product is one minute old, so the demand engine has never
 *      heard of it and there is no suggestion to tick. Buying → New order: pick the vendor, find the
 *      item by **their SKU** (the number printed on the rep's sheet), a whole case at a time, at the
 *      rate that defaulted from the vendor's own price list — then submit.
 *   3. **Receive it at Houston** with a hand-typed unit cost and freight on the pallet. The item had
 *      no stock and no valuation before this, so its moving average lands *exactly* on the landed
 *      rate — and this run computes that landed rate from first principles rather than reading it
 *      back off the document. Freight on an Actual + Valuation charge is spread **by line amount**,
 *      not evenly per unit (`e2e/purchasing.e2e.mjs` documents the ~7 % defect that proved it), so
 *      the receipt deliberately carries a second, far more expensive line: the two allocations are
 *      tens of dollars apart here, and the run asserts the server chose the right one.
 *   4. **Send it to three stores** — Stock → an item → Send to stores. One shipment per store and no
 *      more (client decision 3), each carrying `warehouse_push` on its request (decision 2), each an
 *      ordinary shipment sitting on the wall's *To pick* column, and Houston's position down by
 *      exactly the total sent.
 *   5. **A store receives its own shipment** on its own POS Receive screen, scanning the barcode
 *      that was typed into the create sheet ten minutes earlier, and its bin rises by exactly what
 *      was sent to *it* — not to the other two.
 *   6. **The refusals**, because two of the worst bugs in this project were permission holes: a store
 *      manager is refused every `distribution.*` endpoint and `create_product` over plain HTTP —
 *      including `send` addressed to their **own** store — and an over-allocation is refused with the
 *      shortfall named per item and **nothing written**: the run proves that afterwards by looking
 *      for a request, a shipment or a material request for the item and finding none at all.
 *   7. The three split modes (`even` / `velocity` / `topup`) and `left_at_warehouse`, checked against
 *      maths this file does for itself — on the new product (where every velocity is 0 and the
 *      honest answers are surprising) and on the chain's fastest seller (where the weighting bites).
 *
 * Nothing here is written to be lenient, and nothing is asserted by reading a number back off the
 * document that produced it. Where the app is wrong the check is left failing with the defect
 * spelled out in its own detail string.
 *
 * BASE defaults to the CloudChaserz site, which carries HOU-WH, eleven real stores and twelve
 * seeded vendors; `BRIDGE=1` routes every context through `cloud-bridge.mjs` for a run against the
 * live Frappe Cloud site. The run creates its own product with a stamped code and barcode, and
 * picks its own vendor and companion line out of whatever catalogue the site has, so it can be run
 * again on a site it has already bought from.
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
/** SPEC_v1.1 §A wants the gate proven **both ways**: head office may push, a store may not. */
const HO_USER = { usr: process.env.HO_USER || 'hq@cloudchaserz.example', pwd: PWD }

/**
 * The manager PINs the CloudChaserz seed writes (`setup/cloudchaserz/users.py::MANAGER_PINS`), so
 * the run can address any store's own Receive screen rather than one hard-coded shop.
 */
const MANAGER_PINS = {
  'HOU-MTR': '1101', 'OK-SAP': '2202', 'OK-BA': '3303', 'OK-BIX': '4404', 'OK-STUL': '5505',
  'OK-OWA': '6606', 'OK-MUS': '7707', 'OK-MINGO': '8808', 'OK-ETUL': '9909', 'OK-YALE': '1212',
  'OK-JENKS': '1313'
}
const managerFor = (code) => `${String(code).toLowerCase().replace(/-/g, '.')}.manager@cloudchaserz.example`

/** the three shops this distribution addresses; the first of them receives its parcel */
const PUSH_STORES = (process.env.PUSH_STORES || '').split(',').map((s) => s.trim()).filter(Boolean)

const here = path.dirname(fileURLToPath(import.meta.url))
const shots = path.join(here, process.env.SHOTS_DIR || 'shots-v11')
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
const sum = (xs) => xs.reduce((s, v) => s + Number(v || 0), 0)

/**
 * What ERPNext will make of a receipt line, computed from first principles rather than read back
 * off the document we are checking. Restated from `e2e/purchasing.e2e.mjs` on purpose — the two
 * runs must agree without sharing an implementation.
 *
 * A freight row of `charge_type = Actual`, `category = Valuation` is spread over the receipt's
 * lines **in proportion to net amount** (`erpnext/controllers/buying_controller.py::
 * update_valuation_rate`), not evenly per unit. The moving average is then
 * `(qty_before × rate_before + qty_in × landed_rate) / (qty_before + qty_in)`
 * (`erpnext/stock/stock_ledger.py::get_moving_average_values`) — and for a product that has never
 * been stocked, `qty_before = 0`, so it collapses to the landed rate itself.
 */
function expectedMovingAverage({ qtyBefore, rateBefore, qtyIn, rateIn, freight, receiptLines }) {
  const netTotal = sum(receiptLines.map((l) => l.qty * l.rate))
  const lineNet = qtyIn * rateIn
  const share = netTotal > 0 ? (Number(freight) || 0) * (lineNet / netTotal) : 0
  const valueAfter = qtyBefore * rateBefore + lineNet + share
  return { share, landedRate: (lineNet + share) / qtyIn, rate: valueAfter / (qtyBefore + qtyIn), qtyAfter: qtyBefore + qtyIn }
}

/** The same freight spread **evenly per unit** — the allocation that was wrong, kept as the foil. */
function perUnitFreightShare(receiptLines, freight, index) {
  const units = sum(receiptLines.map((l) => l.qty))
  if (units <= 0) return 0
  return (Number(freight) || 0) * receiptLines[index].qty / units
}

// ---------------------------------------------------------------- the split maths, restated
// `maison_pos/distribution.py::split_even / split_by_velocity / split_topup`, written out again
// here so the assertion is against the documented rule rather than against the implementation the
// sheet and the server already share.

/** Busiest first: highest velocity, then emptiest, then by code — a total order, so it is stable. */
function busiestFirst(rows) {
  return [...rows]
    .sort((a, b) =>
      (Number(b.velocity || 0) - Number(a.velocity || 0)) ||
      (Number(a.on_hand || 0) - Number(b.on_hand || 0)) ||
      (a.boutique < b.boutique ? -1 : a.boutique > b.boutique ? 1 : 0))
    .map((r) => r.boutique)
}

/** Largest-remainder apportionment, ties broken busiest-first, with an optional per-store cap. */
function apportion(total, weights, order, caps = null) {
  const out = {}
  for (const key of Object.keys(weights)) out[key] = 0
  total = Math.max(0, Math.trunc(Number(total) || 0))
  if (total <= 0) return out
  const positive = {}
  for (const [key, value] of Object.entries(weights)) positive[key] = Math.max(0, Number(value) || 0)
  const pool = sum(Object.values(positive))
  if (pool <= 0) return out
  const position = Object.fromEntries(order.map((k, i) => [k, i]))
  const exact = {}
  for (const [key, value] of Object.entries(positive)) exact[key] = (total * value) / pool
  for (const [key, value] of Object.entries(exact)) {
    const whole = Math.floor(value)
    out[key] = caps ? Math.min(whole, caps[key]) : whole
  }
  let remaining = total - sum(Object.values(out))
  const ranked = Object.keys(positive).sort((a, b) => {
    const fa = exact[a] - Math.floor(exact[a])
    const fb = exact[b] - Math.floor(exact[b])
    if (Math.abs(fb - fa) > 1e-12) return fb - fa
    return (position[a] ?? order.length) - (position[b] ?? order.length)
  })
  while (remaining > 0) {
    let handed = false
    for (const key of ranked) {
      if (remaining <= 0) break
      if (caps && out[key] >= caps[key]) continue
      out[key] += 1
      remaining -= 1
      handed = true
    }
    if (!handed) break // everybody is at their cap — the rest stays in Houston
  }
  return out
}

/** Equal across the chosen stores; the remainder to the busiest. */
function splitEven(qty, rows) {
  qty = Math.max(0, Math.trunc(Number(qty) || 0))
  const out = Object.fromEntries(rows.map((r) => [r.boutique, 0]))
  if (!rows.length || qty <= 0) return out
  const base = Math.floor(qty / rows.length)
  const remainder = qty - base * rows.length
  for (const key of Object.keys(out)) out[key] = base
  for (const key of busiestFirst(rows).slice(0, remainder)) out[key] += 1
  return out
}

/** Weighted by 28-day velocity, minimum one each; even when nobody has ever sold it. */
function splitByVelocity(qty, rows) {
  qty = Math.max(0, Math.trunc(Number(qty) || 0))
  const out = Object.fromEntries(rows.map((r) => [r.boutique, 0]))
  if (!rows.length || qty <= 0) return out
  const order = busiestFirst(rows)
  if (qty <= rows.length) {
    for (const key of order.slice(0, qty)) out[key] = 1
    return out
  }
  const weights = Object.fromEntries(rows.map((r) => [r.boutique, Math.max(0, Number(r.velocity) || 0)]))
  if (sum(Object.values(weights)) <= 0) return splitEven(qty, rows)
  for (const key of Object.keys(out)) out[key] = 1
  for (const [key, extra] of Object.entries(apportion(qty - rows.length, weights, order))) out[key] += extra
  return out
}

/** Bring every store up to `coverDays` days of cover; nothing at all when everybody is covered. */
function splitTopup(qty, rows, coverDays = 21) {
  qty = Math.max(0, Math.trunc(Number(qty) || 0))
  const out = Object.fromEntries(rows.map((r) => [r.boutique, 0]))
  if (!rows.length || qty <= 0) return out
  const target = Math.max(1, Math.trunc(Number(coverDays) || 0) || 21)
  const gap = {}
  for (const row of rows) {
    const short = (Number(row.velocity) || 0) * target - (Number(row.on_hand) || 0)
    gap[row.boutique] = short > 0 ? Math.ceil(short) : 0
  }
  const totalGap = sum(Object.values(gap))
  if (totalGap <= 0) return out
  if (totalGap <= qty) return { ...gap }
  const weights = Object.fromEntries(Object.entries(gap).map(([k, v]) => [k, Number(v)]))
  return apportion(qty, weights, busiestFirst(rows), gap)
}

const SPLITTERS = { even: splitEven, velocity: splitByVelocity, topup: splitTopup }

/** `{store: qty}` → a comparable, stable string, so a mismatch reads like a diff. */
const allocText = (alloc) =>
  Object.keys(alloc).sort().filter((k) => alloc[k] > 0).map((k) => `${k}:${alloc[k]}`).join(' ') || '(nothing)'
const sameAlloc = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (Number(a[key] || 0) !== Number(b[key] || 0)) return false
  return true
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
    /** status + body, for the permission checks and the refusals that must see the HTTP code */
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
    /** a child table, which Frappe will only list when it is told whose child it is */
    childList: (doctype, parent, filters, fields = ['name'], limit = 500) =>
      api.get('frappe.client.get_list', { doctype, parent, filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: limit }),
    /** the whole document, child tables included */
    doc: (doctype, name) => api.get('frappe.client.get', { doctype, name }),
    value: (doctype, name, fields) =>
      api.get('frappe.client.get_value', { doctype, filters: JSON.stringify({ name }), fieldname: JSON.stringify(fields) }),
    dispose: () => ctx.close()
  }
  return api
}

/**
 * What a Frappe refusal actually says, unwrapped from the doubly-encoded `_server_messages` the
 * desk renders — so a detail string carries the sentence the manager would read, not JSON.
 */
function refusalText(body) {
  const out = []
  try {
    for (const raw of JSON.parse(body?._server_messages || '[]')) {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw
      out.push(String(msg?.message ?? msg))
    }
  } catch { /* not a server message — fall through to the exception line */ }
  if (!out.length && body?.exception) out.push(String(body.exception).replace(/^[\w.]*(Error|Exception):\s*/, ''))
  if (!out.length) out.push(JSON.stringify(body || ''))
  return out.join(' | ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const admin = await client(ADMIN)
const whApi = await client(WH_USER)

// ---------------------------------------------------------------- what the site gives us to work with
const HQ = (await whApi.get('maison_pos.api.shipping.me'))?.main_warehouse
if (!HQ) throw new Error('no main warehouse configured — is this an AWANZ site?')

const binOf = async (item, warehouse) => {
  const b = (await admin.list('Bin', { item_code: item, warehouse }, ['actual_qty', 'valuation_rate', 'stock_value']))[0]
  return { qty: Number(b?.actual_qty || 0), rate: Number(b?.valuation_rate || 0), value: Number(b?.stock_value || 0) }
}
const poNames = async () => new Set(await admin.get('frappe.client.get_list', {
  doctype: 'Purchase Order', fields: JSON.stringify(['name']), limit_page_length: 5000
}).then((rows) => rows.map((r) => r.name)))

// the shops a push may address — never HOU-WH itself
const storeList = await whApi.get('maison_pos.api.distribution.stores')
const shops = (storeList.stores || []).filter((s) => MANAGER_PINS[s.boutique])
if (shops.length < 3) throw new Error(`need three shops with a seeded manager PIN; found ${shops.length}`)
const chosen = PUSH_STORES.length >= 3 ? PUSH_STORES.slice(0, 3) : shops.slice(0, 3).map((s) => s.boutique)
const STORES = chosen.map((code) => {
  const row = shops.find((s) => s.boutique === code)
  if (!row) throw new Error(`${code} is not a shop a push may address on ${BASE}`)
  return row
})
const RECEIVER = STORES[0]
const MANAGER = { usr: managerFor(RECEIVER.boutique), pwd: PWD, pin: MANAGER_PINS[RECEIVER.boutique] }

// ---- the vendor this run buys from: the widest catalogue on the site, because the freight
// allocation only tells the two rules apart when the receipt's lines cost very different amounts
const vendorRows = (await whApi.get('maison_pos.api.purchasing.vendors', { active_only: 1 })).vendors || []
const catalogues = []
for (const v of vendorRows) {
  const cat = await whApi.get('maison_pos.api.purchasing.vendor_catalogue', { supplier: v.name }).catch(() => null)
  if (cat && (cat.items || []).length >= 8) catalogues.push(cat)
}
catalogues.sort((a, b) => Math.max(...b.items.map((i) => i.rate || 0)) - Math.max(...a.items.map((i) => i.rate || 0)))
const catalogue = catalogues[0]
if (!catalogue) throw new Error('no vendor on this site carries a catalogue of eight items to order from')
const VENDOR = catalogue.supplier
const COMPANION = [...catalogue.items].sort((a, b) => (b.rate || 0) - (a.rate || 0))[0]

// the group the vendor mostly sells, so the new product is filed where its siblings are
const groupCounts = {}
for (const row of catalogue.items) if (row.item_group) groupCounts[row.item_group] = (groupCounts[row.item_group] || 0) + 1
const GROUP = Object.keys(groupCounts).sort((a, b) => groupCounts[b] - groupCounts[a] || (a < b ? -1 : 1))[0]

/** A plausible new line for whatever the vendor sells, so the screenshots read like their day. */
const PRODUCT_BY_GROUP = {
  Disposables: ['Pulse X 25K — Blue Razz Ice', 'PULSE-X-25K-BRI'],
  'E-Liquid': ['Mango Ice 100ml — 6 mg', 'MANGO-ICE-100-6'],
  'Glass & Rigs': ['14 mm Beaker — Frost', 'BEAKER-14-FROST'],
  'Hookah & Shisha': ['Double Apple 250 g', 'SHISHA-DAPP-250'],
  'Pods & Coils': ['0.6Ω Mesh Coil — 5 pack', 'MESH-06-5PK'],
  'Devices & Mods': ['Compact 40 W Kit — Graphite', 'KIT-40W-GRAPH'],
  Kratom: ['Green Maeng Da 60 ct', 'KRATOM-GMD-60'],
  'CBD & Hemp': ['Full Spectrum 1000 mg Tincture', 'CBD-FS-1000'],
  'Rolling & Papers': ['King Slim Papers — 32 leaves', 'PAPERS-KS-32'],
  Accessories: ['Torch Lighter — Gunmetal', 'TORCH-GUN']
}
const STAMP = Date.now().toString(36).toUpperCase().slice(-5)
const [PRODUCT_NAME, PRODUCT_SLUG] = PRODUCT_BY_GROUP[GROUP] || [`${GROUP} — house line`, 'HOUSE-LINE']
const ITEM = `${PRODUCT_SLUG}-${STAMP}`
const SKU = `SKU-${STAMP}`
let BARCODE = '20' + String(Date.now()).slice(-11)
while ((await admin.list('Item', { maison_barcode: BARCODE }, ['name'], 1)).length) BARCODE = '20' + String(Date.now() + 7).slice(-11)

// the numbers this run drives, and the ones it will check against
const COST = 9.25 // what we negotiated with the vendor
const CASE_PACK = 10
const MOQ = 20
const LEAD_DAYS = Number(catalogue.lead_time_days) || 7
const SELLING = 24.99
const REORDER_LEVEL = 40
const REORDER_QTY = 60
const ORDER_CASES = 3 // 30 units — three taps of "+", one case each
const ORDER_QTY = CASE_PACK * ORDER_CASES
const RECEIPT_RATE = round(COST * 1.12) // the hand-typed unit cost at the dock
const FREIGHT = 45
const SEND_QTY = [8, 7, 6] // deliberately different, so "its own parcel" means something
const SEND_TOTAL = sum(SEND_QTY)
const OVER_BY = 7 // how far past Houston's stock the refused attempt reaches

if (!(COMPANION.rate >= COST * 2.5)) {
  log(`  ! ${VENDOR}'s dearest line is only $${COMPANION.rate} — the freight-allocation check will be weak`)
}
log(`  vendor=${VENDOR} companion=${COMPANION.item_code} @ $${COMPANION.rate} · new product ${ITEM} "${PRODUCT_NAME}" in ${GROUP}`)
log(`  stores=${STORES.map((s) => s.boutique).join(',')} receiver=${RECEIVER.boutique} (${MANAGER.usr})`)

// ================================================================ 1. Buying → New product
const deskCtx = await newContext({ viewport: { width: 1600, height: 1000 } })
const login = await deskCtx.request.post('/api/method/login', { data: { usr: WH_USER.usr, pwd: WH_USER.pwd } })
if (!login.ok()) throw new Error(`warehouse admin login failed ${login.status()}`)
const desk = await deskCtx.newPage()
wireConsole(desk, 'warehouse')

await desk.goto('/warehouse', { waitUntil: 'domcontentloaded' })
await desk.waitForSelector('[data-testid=warehouse-desk]', { timeout: 40000 })
await desk.click('[data-testid=tab-buying]')
await desk.waitForSelector('[data-testid=buying-board]', { timeout: 30000 })
await desk.click('[data-testid=buy-new-product]')
await desk.waitForSelector('[data-testid=product-sheet]', { timeout: 25000 })

// the sheet fetches its groups and its vendor list after it mounts
await desk.waitForFunction(
  () => document.querySelectorAll('[data-testid=product-group] option[value]:not([value=""])').length > 0 &&
        document.querySelectorAll('[data-testid=product-vendor] option[value]:not([value=""])').length > 0,
  null,
  { timeout: 30000 }
)
const groupOptions = await desk.$$eval('[data-testid=product-group] option', (os) => os.map((o) => o.value).filter(Boolean))
const useGroup = groupOptions.includes(GROUP) ? GROUP : groupOptions[0]
record('the create sheet offers the groups a product can be filed under, not a free-text box',
  groupOptions.length > 0 && groupOptions.includes(useGroup),
  `${groupOptions.length} groups on the select; filing ${ITEM} under "${useGroup}"${useGroup === GROUP ? '' : ` (${GROUP} was not offered)`}`)

await desk.fill('[data-testid=product-code]', ITEM)
await desk.fill('[data-testid=product-name]', PRODUCT_NAME)
await desk.selectOption('[data-testid=product-group]', useGroup)
await desk.fill('[data-testid=product-barcode]', BARCODE)
await desk.fill('[data-testid=product-uom]', 'Nos')
await desk.selectOption('[data-testid=product-vendor]', VENDOR)
await desk.fill('[data-testid=product-sku]', SKU)
await desk.fill('[data-testid=product-cost]', String(COST))
await desk.fill('[data-testid=product-case-pack]', String(CASE_PACK))
await desk.fill('[data-testid=product-moq]', String(MOQ))
await desk.fill('[data-testid=product-lead]', String(LEAD_DAYS))
await desk.fill('[data-testid=product-reorder-level]', String(REORDER_LEVEL))
await desk.fill('[data-testid=product-reorder-qty]', String(REORDER_QTY))
await desk.fill('[data-testid=product-selling-rate]', String(SELLING))
await desk.waitForTimeout(250)
const marginNote = (await desk.locator('[data-testid=product-margin]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
await shot(desk, 'new-product-sheet', true)

await desk.click('[data-testid=product-save]')
await desk.waitForSelector('[data-testid=product-created]', { timeout: 30000 })
const createdPanel = (await desk.locator('[data-testid=product-created]').innerText()).replace(/\s+/g, ' ').trim()
await shot(desk, 'new-product-created', true)

// ---- what the server actually built
const itemDoc = await admin.doc('Item', ITEM).catch(() => null)
record('“New product” creates the Item itself — a stock item, at Moving Average, in the group chosen',
  !!itemDoc && itemDoc.item_name === PRODUCT_NAME && itemDoc.item_group === useGroup && Number(itemDoc.is_stock_item) === 1 &&
    itemDoc.valuation_method === 'Moving Average' && itemDoc.stock_uom === 'Nos' && !Number(itemDoc.disabled),
  `${ITEM} "${itemDoc?.item_name}" · group ${itemDoc?.item_group} · uom ${itemDoc?.stock_uom} · stock_item ${itemDoc?.is_stock_item} · ${itemDoc?.valuation_method}`)

const barcodeRows = (itemDoc?.barcodes || []).map((b) => b.barcode)
record('the barcode is stamped on both surfaces a scanner reads — maison_barcode and Item Barcode',
  itemDoc?.maison_barcode === BARCODE && barcodeRows.includes(BARCODE),
  `maison_barcode=${itemDoc?.maison_barcode}; Item Barcode rows [${barcodeRows.join(', ') || 'none'}] (typed ${BARCODE})`)

const vendorRow = (itemDoc?.maison_vendors || []).find((r) => r.supplier === VENDOR)
record('the vendor terms are written as an AWANZ Item Vendor row — their SKU, our cost, the case',
  !!vendorRow && vendorRow.vendor_sku === SKU && round(vendorRow.cost) === COST && Number(vendorRow.case_pack) === CASE_PACK &&
    Number(vendorRow.moq) === MOQ && Number(vendorRow.lead_time_days) === LEAD_DAYS,
  `${VENDOR}: sku ${vendorRow?.vendor_sku} · $${vendorRow?.cost} · case ${vendorRow?.case_pack} · moq ${vendorRow?.moq} · lead ${vendorRow?.lead_time_days} d ` +
  `(${(itemDoc?.maison_vendors || []).length} vendor row(s) on the item)`)

record('that vendor is marked preferred, because it is the item\'s first',
  !!vendorRow && Number(vendorRow.is_preferred) === 1 && (itemDoc?.maison_vendors || []).filter((r) => Number(r.is_preferred)).length === 1,
  `is_preferred=${vendorRow?.is_preferred} on ${VENDOR}; preferred rows on ${ITEM}: ${(itemDoc?.maison_vendors || []).filter((r) => Number(r.is_preferred)).map((r) => r.supplier).join(', ') || 'none'}`)

const buyingList = catalogue.price_list
const buyPrices = await admin.list('Item Price', { item_code: ITEM, price_list: buyingList }, ['name', 'price_list_rate', 'buying', 'selling', 'price_list'], 20)
record('the negotiated cost lands on the vendor\'s own buying price list, the way an edit would write it',
  buyPrices.length === 1 && round(buyPrices[0].price_list_rate) === COST && Number(buyPrices[0].buying) === 1,
  `${buyPrices.length} row(s) on "${buyingList}": ${buyPrices.map((p) => `$${p.price_list_rate} buying=${p.buying}`).join(', ') || 'none'}`)

const sellPrices = await admin.list('Item Price', { item_code: ITEM, selling: 1 }, ['name', 'price_list', 'price_list_rate'], 20)
record('the selling rate lands on the selling price list the tills read',
  sellPrices.length === 1 && round(sellPrices[0].price_list_rate) === SELLING,
  `${sellPrices.map((p) => `${p.price_list} $${p.price_list_rate}`).join(', ') || 'none'} (typed $${SELLING}) · sheet said "${marginNote}"`)

const reorder = (itemDoc?.reorder_levels || []).find((r) => r.warehouse === HQ)
record('the reorder level is written against HOU-WH, so the demand engine will find it from now on',
  !!reorder && Number(reorder.warehouse_reorder_level) === REORDER_LEVEL && Number(reorder.warehouse_reorder_qty) === REORDER_QTY &&
    reorder.material_request_type === 'Purchase',
  `${reorder?.warehouse}: level ${reorder?.warehouse_reorder_level}, qty ${reorder?.warehouse_reorder_qty}, ${reorder?.material_request_type} ` +
  `(${(itemDoc?.reorder_levels || []).length} reorder row(s))`)

record('the confirmation tells the manager what was written, in the order they typed it',
  createdPanel.includes(ITEM) && createdPanel.includes(VENDOR) && /preferred/i.test(createdPanel) && /Reorders at/i.test(createdPanel),
  `"${createdPanel.slice(0, 260)}"`)

// ---- the two refusals that protect the till, from the same screen
const dupCode = await whApi.rawPost('maison_pos.api.purchasing.create_product', {
  payload: { item_code: ITEM, item_name: 'a second one', item_group: useGroup }
})
const dupBarcode = await whApi.rawPost('maison_pos.api.purchasing.create_product', {
  payload: { item_code: `${ITEM}-X`, item_name: 'same barcode', item_group: useGroup, barcode: BARCODE }
})
const dupCodeLeft = await admin.list('Item', { name: `${ITEM}-X` }, ['name'], 5)
record('a duplicate item code and a duplicate barcode are both refused, and neither leaves an item behind',
  dupCode.status >= 400 && /already exists/i.test(refusalText(dupCode.body)) &&
    dupBarcode.status >= 400 && new RegExp(`already on item ${ITEM}`, 'i').test(refusalText(dupBarcode.body)) &&
    dupCodeLeft.length === 0,
  `code → ${dupCode.status} "${refusalText(dupCode.body).slice(0, 110)}"; barcode → ${dupBarcode.status} "${refusalText(dupBarcode.body).slice(0, 140)}"; ` +
  `${ITEM}-X exists afterwards: ${dupCodeLeft.length > 0}`)

// ================================================================ 2. order it from scratch
// The reorder row the sheet just wrote is not decoration: the demand engine's very next run must
// find it. It cannot help with *this* order — nothing has been bought yet, so there is nothing to
// receive and the buyer still has to build the order by hand — but from tomorrow the product is on
// the buying list like any other, filed against the vendor the sheet marked preferred.
const suggestNow = await whApi.post('maison_pos.api.purchasing.suggestions', { refresh: 1 })
const mySuggestion = (suggestNow.suggestions || []).find((s) => s.item_code === ITEM)
record('the reorder level the create sheet wrote is live at once — the next demand run raises it as low stock',
  !!mySuggestion && mySuggestion.source === 'Low stock' && mySuggestion.supplier === VENDOR && mySuggestion.qty > 0,
  mySuggestion
    ? `run ${suggestNow.run_id}: ${ITEM} — ${mySuggestion.source}, buy ${mySuggestion.qty} from ${mySuggestion.supplier} ` +
      `(${mySuggestion.on_hand} on hand against a reorder level of ${mySuggestion.reorder_level})`
    : `run ${suggestNow.run_id} produced ${(suggestNow.suggestions || []).length} suggestions and ${ITEM} is not one of them, ` +
      `though the create sheet wrote a reorder level of ${REORDER_LEVEL} at ${HQ} with nothing on hand`)

// Whatever the suggestion list says, this order is built from scratch: the buyer never ticks a row.
await desk.click('[data-testid=product-order-now]')
await desk.waitForSelector('[data-testid=new-order-sheet]', { timeout: 25000 })
await desk.waitForSelector(`[data-testid="new-order-line-${ITEM}"]`, { timeout: 25000 })
const startQty = await desk.inputValue(`[data-testid="new-order-qty-${ITEM}"]`)
const startRate = await desk.inputValue(`[data-testid="new-order-rate-${ITEM}"]`)
record('“Order it now” hands the new product straight to the order sheet, a whole case at the vendor\'s rate',
  Number(startQty) === CASE_PACK && round(startRate) === COST,
  `${ITEM} in ${VENDOR}'s basket at ${startQty} × $${startRate} (case pack ${CASE_PACK}, price list "${buyingList}" $${COST})`)

// find it the way the buyer would: by the number printed on the rep's sheet
await desk.fill('[data-testid=new-order-search]', SKU)
await desk.waitForTimeout(300)
const skuMatches = await desk.$$eval('button[data-testid^="new-order-item-"]', (es) => es.map((e) => e.getAttribute('data-testid').replace('new-order-item-', '')))
record('the vendor\'s catalogue is searchable by **their** SKU, which is what the rep left behind',
  skuMatches.length === 1 && skuMatches[0] === ITEM,
  `typing "${SKU}" narrowed ${catalogue.items.length + 1} catalogue rows to ${skuMatches.length}: ${skuMatches.join(', ') || 'nothing'}`)
await shot(desk, 'new-order-sku-search', true)

// a whole case at a time, then a second line so the receipt's freight has something to weigh
await desk.click(`[data-testid="new-order-plus-${ITEM}"]`)
await desk.click(`[data-testid="new-order-plus-${ITEM}"]`)
await desk.waitForTimeout(200)
const steppedQty = await desk.inputValue(`[data-testid="new-order-qty-${ITEM}"]`)
record('the − / + steppers move a whole case, so nobody orders seven of something sold in tens',
  Number(steppedQty) === ORDER_QTY,
  `${CASE_PACK} + two taps of "+" → ${steppedQty} (expected ${ORDER_CASES} cases of ${CASE_PACK} = ${ORDER_QTY})`)

await desk.fill('[data-testid=new-order-search]', COMPANION.item_code)
await desk.waitForSelector(`[data-testid="new-order-item-${COMPANION.item_code}"]`, { timeout: 15000 })
await desk.click(`[data-testid="new-order-item-${COMPANION.item_code}"]`)
await desk.waitForSelector(`[data-testid="new-order-line-${COMPANION.item_code}"]`, { timeout: 15000 })
const companionQty = Number(await desk.inputValue(`[data-testid="new-order-qty-${COMPANION.item_code}"]`))
const companionRate = round(await desk.inputValue(`[data-testid="new-order-rate-${COMPANION.item_code}"]`))
await shot(desk, 'new-order-basket', true)

const beforeOrders = await poNames()
await desk.click('[data-testid=new-order-create]')
await desk.waitForSelector('[data-testid=order-sheet]', { timeout: 30000 })
const PO = [...(await poNames())].find((n) => !beforeOrders.has(n))
const draft = PO ? await admin.get('maison_pos.api.purchasing.order', { name: PO }) : null
const draftLine = draft?.items?.find((l) => l.item_code === ITEM)
record('a purchase order is built from scratch against the vendor, with no suggestion behind it',
  !!PO && draft.supplier === VENDOR && draft.docstatus === 0 && draft.items.length === 2 &&
    draftLine?.qty === ORDER_QTY && round(draftLine?.rate) === COST,
  `${PO} draft for ${draft?.supplier}: ${draft?.items?.map((l) => `${l.item_code} ×${l.qty} @ $${l.rate}`).join(' | ')}`)

await desk.click('[data-testid=order-submit]')
const submitted = await until(async () => {
  const doc = await admin.get('maison_pos.api.purchasing.order', { name: PO })
  return doc.docstatus === 1 ? doc : null
}, { timeout: 30000 }) || await admin.get('maison_pos.api.purchasing.order', { name: PO })
record('submitting it moves the order out of draft and onto the floor\'s Inbound list',
  submitted.docstatus === 1 && submitted.status !== 'Draft',
  `${PO} docstatus=${submitted.docstatus} status=${submitted.status} expected ${submitted.schedule_date} (vendor lead ${LEAD_DAYS} d)`)
await shot(desk, 'order-submitted', true)
await desk.click('.modal-head button.close').catch(() => {})
await desk.waitForSelector('[data-testid=order-sheet]', { state: 'detached', timeout: 15000 }).catch(() => {})

// ================================================================ 3. receive it at Houston
const beforeReceipt = await binOf(ITEM, HQ)
record('the new product has no stock and no valuation at Houston before the delivery',
  beforeReceipt.qty === 0 && beforeReceipt.rate === 0,
  `${ITEM} at ${HQ}: ${beforeReceipt.qty} units, valuation $${beforeReceipt.rate} — so its first moving average is the landed rate itself`)

await desk.click('[data-testid=tab-inbound]')
await desk.waitForSelector('[data-testid=inbound-board]', { timeout: 25000 })
await desk.waitForSelector(`[data-testid="inbound-po-${PO}"]`, { timeout: 25000 })
await desk.click(`[data-testid="inbound-receive-${PO}"]`)
await desk.waitForSelector('[data-testid=receive-lines]', { timeout: 25000 })
await desk.click('[data-testid=receive-fill-all]')
await desk.fill(`[data-testid="receive-rate-${ITEM}"]`, String(RECEIPT_RATE))
await desk.fill('[data-testid=receive-freight]', String(FREIGHT))
await desk.waitForTimeout(400)

const receiptLines = [{ qty: ORDER_QTY, rate: RECEIPT_RATE }, { qty: companionQty, rate: companionRate }]
const expected = expectedMovingAverage({
  qtyBefore: beforeReceipt.qty, rateBefore: beforeReceipt.rate,
  qtyIn: ORDER_QTY, rateIn: RECEIPT_RATE, freight: FREIGHT, receiptLines
})
const perUnit = perUnitFreightShare(receiptLines, FREIGHT, 0)
const perUnitRate = (ORDER_QTY * RECEIPT_RATE + perUnit) / ORDER_QTY

const previewText = (await desk.locator(`[data-testid="receive-ma-${ITEM}"]`).innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const previewAfter = Number((previewText.match(/([\d,]+\.\d{2})\s*$/)?.[1] || '').replace(/,/g, ''))
await shot(desk, 'receive-override-freight', true)

await desk.click('[data-testid=receive-post]')
if (await desk.locator('[data-testid=receive-confirm-panel]').count()) await desk.click('[data-testid=receive-post]')
await desk.waitForSelector('[data-testid=receive-booked]', { timeout: 45000 })
const bookedPanel = (await desk.locator('[data-testid=receive-booked]').innerText()).replace(/\s+/g, ' ').trim()
const sendFromInbound = await desk.locator(`[data-testid="booked-send-${ITEM}"]`).count()
await shot(desk, 'receive-booked', true)

const received = await until(async () => {
  const doc = await admin.get('maison_pos.api.purchasing.order', { name: PO })
  return doc.receipts?.length ? doc : null
}, { timeout: 30000 }) || await admin.get('maison_pos.api.purchasing.order', { name: PO })
const PR = received.receipts?.[0]?.purchase_receipt
const receivedLine = received.items.find((l) => l.item_code === ITEM)
record('posting the receipt creates a Purchase Receipt and puts every unit ordered into Houston',
  !!PR && receivedLine?.received_qty === ORDER_QTY,
  `${PR || 'no receipt'} · ${ITEM} received ${receivedLine?.received_qty}/${receivedLine?.qty}; per_received ${round(received.per_received, 2)}%; status ${received.status}`)

const prDoc = PR ? await admin.doc('Purchase Receipt', PR) : null
const prLine = (prDoc?.items || []).find((l) => l.item_code === ITEM)
const prFreight = (prDoc?.taxes || []).find((t) => t.category === 'Valuation')
record('the hand-typed unit cost is what the receipt booked, not the rate the order carried',
  !!prLine && round(prLine.rate) === RECEIPT_RATE && RECEIPT_RATE !== COST,
  `${ITEM}: ordered at $${COST}, received at $${prLine?.rate} (typed $${RECEIPT_RATE} at the dock)`)
record('the freight typed at the dock is posted as one Actual / Valuation charge on the receipt',
  !!prFreight && (prDoc.taxes || []).length === 1 && prFreight.charge_type === 'Actual' && prFreight.add_deduct_tax === 'Add' &&
    round(prFreight.tax_amount) === FREIGHT && round(prDoc.maison_freight_amount) === FREIGHT,
  `${PR}: ${(prDoc?.taxes || []).length} tax row(s) — ${prFreight?.charge_type}/${prFreight?.category}/${prFreight?.add_deduct_tax} $${prFreight?.tax_amount} → ${prFreight?.account_head}`)

const afterReceipt = await binOf(ITEM, HQ)
const drift = Math.abs(afterReceipt.rate - expected.rate)
record('the new product\'s moving-average valuation is the value this run computed, freight included',
  drift < 0.005 && afterReceipt.qty === expected.qtyAfter,
  `${ITEM}: nothing on hand + ${ORDER_QTY} @ $${RECEIPT_RATE} (+$${round(expected.share)} of the $${FREIGHT} freight, shared by line amount ` +
  `over a net of $${round(sum(receiptLines.map((l) => l.qty * l.rate)))}) ⇒ landed $${round(expected.landedRate, 4)} ⇒ expected $${round(expected.rate, 4)} ` +
  `on ${expected.qtyAfter}; server says $${round(afterReceipt.rate, 4)} on ${afterReceipt.qty} (drift $${round(drift, 6)})`)

record('the freight really was shared by line amount — spreading it per unit lands somewhere else entirely',
  Math.abs(perUnitRate - expected.rate) > 0.01 && Math.abs(afterReceipt.rate - perUnitRate) > 0.01,
  `by line amount $${round(expected.share, 2)} of $${FREIGHT} on ${ITEM} → $${round(expected.rate, 4)}; ` +
  `evenly per unit $${round(perUnit, 2)} → $${round(perUnitRate, 4)}; the server booked $${round(afterReceipt.rate, 4)} ` +
  `(the other line is ${COMPANION.item_code} ×${companionQty} @ $${companionRate})`)

record('the moving-average preview the sheet showed is the move that actually happened',
  Number.isFinite(previewAfter) && Math.abs(previewAfter - afterReceipt.rate) < 0.01,
  `sheet previewed "${previewText}" (after $${previewAfter}); the receipt moved ${ITEM} to $${round(afterReceipt.rate, 4)}`)

record('the receipt confirmation offers “Send to stores” on the line that just arrived (§D)',
  sendFromInbound === 1,
  `booked-send-${ITEM} buttons on the confirmation: ${sendFromInbound} · "${bookedPanel.slice(0, 200)}"`)
await desk.click('[data-testid=receive-done]').catch(() => {})
await desk.waitForSelector('[data-testid=receive-booked]', { state: 'detached', timeout: 15000 }).catch(() => {})

// ================================================================ 4. Stock → an item → Send to stores
await desk.click('[data-testid=tab-stock]')
await desk.waitForSelector('[data-testid=stock-board]', { timeout: 25000 })
await desk.fill('[data-testid=stock-search]', ITEM)
await desk.click('[data-testid=stock-search-go]')
await desk.waitForSelector(`[data-testid="stock-${ITEM}"]`, { timeout: 25000 })
const stockRowText = (await desk.locator(`[data-testid="stock-${ITEM}"]`).innerText()).replace(/\s+/g, ' ').trim()
record('the new product is on the Stock board at Houston, valued at what the receipt booked',
  stockRowText.includes(String(ORDER_QTY)) && stockRowText.includes(round(afterReceipt.rate).toFixed(2)),
  `"${stockRowText.slice(0, 170)}"`)

await desk.click(`[data-testid="stock-send-${ITEM}"]`)
await desk.waitForSelector('[data-testid=send-sheet]', { timeout: 25000 })
await desk.waitForSelector(`[data-testid="send-row-${STORES[0].boutique}"]`, { timeout: 25000 })

const plan = await whApi.get('maison_pos.api.distribution.plan', { item_codes: JSON.stringify([ITEM]) })
const planItem = plan.items[0]
const planRows = planItem.stores
record('the plan gives Houston\'s position and a row per store — on hand, velocity, cover, ever sold',
  planItem.on_hand === ORDER_QTY && planItem.available === ORDER_QTY && planRows.length === storeList.count &&
    planRows.every((r) => r.on_hand === 0 && r.velocity === 0 && r.cover_days === null && r.ever_sold === false),
  `${HQ}: ${planItem.on_hand} on hand, ${planItem.committed} committed, ${planItem.available} available; ` +
  `${planRows.length} store rows, all at 0 on hand / 0 a day / cover null / never sold — which is the whole point of a push`)

const rowsOnScreen = await desk.locator('tr[data-testid^="send-row-"]').count()
const neverSold = await desk.locator('[data-testid=send-sheet] .new-here').count()
record('the sheet puts every enabled store on screen and says out loud that none of them has ever sold it',
  rowsOnScreen === planRows.length && neverSold === planRows.length,
  `${rowsOnScreen} store rows rendered (server offers ${planRows.length}); "never sold here" on ${neverSold} of them`)
await shot(desk, 'send-to-stores-sheet', true)

// ---------------------------------------------------------------- 7. the three split modes
const POOL = 25 // deliberately not a multiple of eleven, so the remainder rule is exercised
const splitChecks = []
for (const mode of ['even', 'velocity', 'topup']) {
  await desk.fill('[data-testid=send-pool]', String(POOL))
  if (mode === 'topup') await desk.fill('[data-testid=send-cover-days]', '21')
  await desk.click(`[data-testid=send-split-${mode}]`)
  await desk.waitForTimeout(700)
  const rendered = {}
  for (const row of planRows) rendered[row.boutique] = Number(await desk.inputValue(`[data-testid="send-qty-${row.boutique}"]`))
  const mine = SPLITTERS[mode](POOL, planRows.map((r) => ({ boutique: r.boutique, on_hand: r.on_hand, velocity: r.velocity })), 21)
  const note = (await desk.locator('[data-testid=send-note]').innerText()).replace(/\s+/g, ' ').trim()
  splitChecks.push({ mode, rendered: allocText(rendered), mine: allocText(mine), note })
  const rule = {
    even: `${Math.floor(POOL / planRows.length)} each and the remaining ${POOL % planRows.length} to the busiest — every velocity is 0 here, so "busiest" falls to the store code`,
    velocity: 'nobody has ever sold it, so there is no signal to weight by and the rule falls back to an even split rather than piling the lot on one store',
    topup: 'every store is already at its target at 0 on hand, because 0 a day covers any number of days'
  }[mode]
  record(`the “${mode}” split renders exactly the allocation this run computes for it`,
    sameAlloc(rendered, mine),
    `${POOL} units over ${planRows.length} stores — sheet ${allocText(rendered)}; this run ${allocText(mine)} — ${rule} · "${note}"`)
  if (mode === 'velocity') {
    // `splitNote` already has an honest branch for *top up* allocating nothing ("every store
    // already holds more than N days of cover · raise the target"), because a surprising answer
    // that is not explained reads as a broken button. The *velocity* fallback is the same class of
    // surprise — `split_by_velocity` deliberately falls back to an even split when every velocity
    // is 0 — and it is the case this whole release exists for: a product nobody has ever sold.
    record('“Weight by sales” does not claim a weighting on a product that has never been sold anywhere',
      !/weighted by sales/i.test(note) || /no sales|never sold|no history|evenly|nothing to weigh/i.test(note),
      `every one of the ${planRows.length} stores is at 0/day, so the server fell back to an even split — the same ` +
      `${allocText(rendered)} “Split evenly” produced a moment ago — but the sheet reports it as "${note}". ` +
      `SendToStoresSheet.vue::splitNote picks its label from out.mode alone and only explains the surprising case for ` +
      `topup; the velocity fallback needs the same honesty (out.lines.every(l => !l.velocity) → "No sales anywhere yet ` +
      `— split evenly across N stores instead"), or the manager is told the eleven quantities were weighted by sales ` +
      `history that does not exist`)
  }
  if (mode === 'topup') {
    record('“Top up” honestly allocates nothing for a product nobody has ever sold, and says why',
      sum(Object.values(rendered)) === 0 && /allocated nothing/i.test(note) && /cover/i.test(note),
      `every store's velocity is 0, so a 21-day target is already met at 0 on hand: ${allocText(rendered)} · "${note}"`)
  }
}
await shot(desk, 'send-split-modes', true)

// the weighting only bites where there is a sales history, so prove it on the chain's fastest seller
const stockRows = (await whApi.get('maison_pos.api.purchasing.stock', { limit: 1000 })).rows || []
const mover = [...stockRows].sort((a, b) => b.velocity - a.velocity)[0]
if (mover?.velocity > 0) {
  const moverPlan = await whApi.get('maison_pos.api.distribution.plan', { item_codes: JSON.stringify([mover.item_code]) })
  const moverRows = moverPlan.items[0].stores.map((r) => ({ boutique: r.boutique, on_hand: r.on_hand, velocity: r.velocity }))
  const Q = 60
  const spread = moverPlan.items[0].stores.map((r) => `${r.boutique} ${r.velocity}/d @${r.on_hand}`).slice(0, 4).join(', ')

  const velServer = await whApi.get('maison_pos.api.distribution.suggest_split', { item_code: mover.item_code, qty: Q, mode: 'velocity' })
  const velRows = Object.fromEntries(velServer.lines.map((l) => [l.boutique, l.qty]))
  const velMine = splitByVelocity(Q, moverRows)
  record('“velocity” on a product with a real sales history weights the split the way the rule says',
    sameAlloc(velRows, velMine) && new Set(Object.values(velRows)).size > 1,
    `${mover.item_code} (${mover.velocity}/d chain-wide), ${Q} units — server ${allocText(velRows)}; this run ${allocText(velMine)}; stores ${spread}…`)

  // *Top up* only has anything to do when some store is actually short of the target, and a chain
  // this well stocked is covered for months — so ask for a target it is not covered for, rather
  // than pretending an all-zero answer proves the apportionment.
  const target = [21, 30, 45, 60, 90, 120, 180, 270, 365, 540]
    .find((t) => Object.values(splitTopup(Q, moverRows, t)).filter((v) => v > 0).length >= 2)
  if (target) {
    const topServer = await whApi.get('maison_pos.api.distribution.suggest_split', { item_code: mover.item_code, qty: Q, mode: 'topup', cover_days: target })
    const topRows = Object.fromEntries(topServer.lines.map((l) => [l.boutique, l.qty]))
    const topMine = splitTopup(Q, moverRows, target)
    const gaps = moverRows.map((r) => Math.max(0, Math.ceil(r.velocity * target - r.on_hand)))
    record('“top up” shares what there is in proportion to each store\'s gap, and gives no store more than it needs',
      sameAlloc(topRows, topMine) && Object.values(topRows).filter((v) => v > 0).length >= 2 && sum(Object.values(topRows)) <= Q,
      `${mover.item_code}, ${Q} units to ${target} days of cover (gaps add up to ${sum(gaps)}, so the ${Q} are apportioned and capped) — ` +
      `server ${allocText(topRows)}; this run ${allocText(topMine)}`)
  } else {
    record('“top up” shares what there is in proportion to each store\'s gap, and gives no store more than it needs',
      false,
      `no cover target up to 540 days leaves two stores of ${mover.item_code} short, so the apportionment could not be exercised ` +
      `(stores ${spread}…)`)
  }
} else {
  record('“velocity” on a product with a real sales history weights the split the way the rule says',
    false, 'no item on this site has a non-zero 28-day velocity, so the weighting could not be exercised')
}

// `left_at_warehouse` — the footer figure, negative exactly when the send would be refused
const exact = await whApi.get('maison_pos.api.distribution.suggest_split', { item_code: ITEM, qty: planItem.available, mode: 'even' })
const over = await whApi.get('maison_pos.api.distribution.suggest_split', { item_code: ITEM, qty: planItem.available + OVER_BY, mode: 'even' })
record('left_at_warehouse hits zero at exactly Houston\'s stock and goes negative one unit past it',
  exact.left_at_warehouse === 0 && over.left_at_warehouse === -OVER_BY && exact.allocated === planItem.available && over.allocated === planItem.available + OVER_BY,
  `available ${planItem.available}: allocating ${exact.qty} leaves ${exact.left_at_warehouse}; allocating ${over.qty} leaves ${over.left_at_warehouse} ` +
  `(a calculator, not a gate — suggest_split allocates it, send is what refuses)`)

// ---------------------------------------------------------------- the refused over-allocation
await desk.click('[data-testid=send-clear]')
await desk.waitForTimeout(200)
const overEach = Math.ceil((planItem.available + OVER_BY) / 3)
for (const store of STORES) await desk.fill(`[data-testid="send-qty-${store.boutique}"]`, String(overEach))
await desk.waitForTimeout(300)
const overLeft = (await desk.locator('[data-testid=send-left]').innerText()).trim()
const overTone = await desk.locator('[data-testid=send-left]').getAttribute('class')
const overShort = (await desk.locator('[data-testid=send-shortfall]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const goDisabled = await desk.locator('[data-testid=send-go]').isDisabled()
const goCopy = (await desk.locator('[data-testid=send-go]').innerText()).trim()
record('the sheet turns red **before** the send when the allocation is more than Houston holds',
  Number(overLeft.replace(/[^0-9.-]/g, '')) < 0 && /crit/.test(overTone || '') && goDisabled && /More than Houston has/i.test(goCopy) && overShort.includes(ITEM),
  `${overEach} × 3 = ${overEach * 3} against ${planItem.available} available → left "${overLeft}" (class "${overTone}"), button "${goCopy}" disabled=${goDisabled} · "${overShort}"`)
await shot(desk, 'send-over-allocated', true)

// the sheet's button is down, so the refusal itself has to be proven over plain HTTP
const overLines = STORES.map((s) => ({ boutique: s.boutique, item_code: ITEM, qty: overEach }))
const refused = await whApi.rawPost('maison_pos.api.distribution.send', { lines: overLines, reason: 'over-allocation probe' })
const refusalMsg = refusalText(refused.body)
record('an over-allocation is refused with the shortfall named per item (client decision 4)',
  refused.status >= 400 && refusalMsg.includes(ITEM) && /short\s*\d/i.test(refusalMsg) &&
    new RegExp(`${overEach * 3}\\b`).test(refusalMsg) && new RegExp(`${overEach * 3 - planItem.available}\\b`).test(refusalMsg),
  `${refused.status} — "${refusalMsg.slice(0, 240)}" (asked ${overEach * 3}, available ${planItem.available}, short ${overEach * 3 - planItem.available})`)

const leftBehind = {
  requests: await admin.list('AWANZ Replenishment Request', { boutique: ['in', STORES.map((s) => s.boutique)] }, ['name', 'creation'], 500)
    .then((rs) => rs.length),
  shipmentLines: await admin.childList('AWANZ Shipment Line', 'AWANZ Shipment', { item_code: ITEM }, ['parent'], 200),
  requestLines: await admin.childList('AWANZ Replenishment Line', 'AWANZ Replenishment Request', { item_code: ITEM }, ['parent'], 200),
  mrLines: await admin.childList('Material Request Item', 'Material Request', { item_code: ITEM }, ['parent'], 200)
}
record('a refused distribution writes **nothing** — no request, no shipment, no material request',
  leftBehind.requestLines.length === 0 && leftBehind.shipmentLines.length === 0 && leftBehind.mrLines.length === 0,
  `after the refusal, documents mentioning ${ITEM}: ${leftBehind.requestLines.length} replenishment request line(s), ` +
  `${leftBehind.shipmentLines.length} shipment line(s), ${leftBehind.mrLines.length} material request line(s) — all three must be zero`)

// ---------------------------------------------------------------- the send that goes through
await desk.click('[data-testid=send-clear]')
await desk.waitForTimeout(200)
for (const [i, store] of STORES.entries()) await desk.fill(`[data-testid="send-qty-${store.boutique}"]`, String(SEND_QTY[i]))
await desk.fill('[data-testid=send-reason]', `New line — ${SEND_QTY.join('/')} to try`)
await desk.selectOption('[data-testid=send-priority]', 'Normal')
await desk.waitForTimeout(300)
const footStores = await desk.locator('[data-testid=send-total-stores]').innerText()
const footUnits = await desk.locator('[data-testid=send-total-units]').innerText()
const footLeft = await desk.locator('[data-testid=send-left]').innerText()
const goCopyOk = (await desk.locator('[data-testid=send-go]').innerText()).trim()
record('the running footer counts the stores, the units, and what is left at Houston after',
  Number(footStores) === 3 && Number(footUnits.replace(/,/g, '')) === SEND_TOTAL &&
    Number(footLeft.replace(/[^0-9.-]/g, '')) === planItem.available - SEND_TOTAL && new RegExp(`Send ${SEND_TOTAL} to 3 stores`, 'i').test(goCopyOk),
  `${footStores} stores · ${footUnits} units · ${footLeft} left of ${planItem.available} · button "${goCopyOk}"`)
await shot(desk, 'send-allocated', true)

const houstonBeforeSend = await binOf(ITEM, HQ)
await desk.click('[data-testid=send-go]')
await desk.waitForSelector('[data-testid=send-confirmation]', { timeout: 40000 })
const confirmation = (await desk.locator('[data-testid=send-confirmation]').innerText()).replace(/\s+/g, ' ').trim()
const sentRows = await desk.$$eval('tr[data-testid^="sent-"]', (es) => es.map((e) => e.getAttribute('data-testid').replace('sent-', '')))
await shot(desk, 'send-confirmation', true)

const shipLines = await admin.childList('AWANZ Shipment Line', 'AWANZ Shipment', { item_code: ITEM }, ['parent', 'qty'], 200)
const shipNames = [...new Set(shipLines.map((r) => r.parent))]
const shipments = []
for (const name of shipNames) shipments.push(await admin.doc('AWANZ Shipment', name))
shipments.sort((a, b) => (a.boutique < b.boutique ? -1 : 1))
const byStore = Object.fromEntries(shipments.map((s) => [s.boutique, s]))
record('one AWANZ Shipment per store and no more — separate parcels, never batched (decision 3)',
  shipments.length === 3 && STORES.every((s) => !!byStore[s.boutique]) &&
    STORES.every((s, i) => sum((byStore[s.boutique].lines || []).map((l) => l.qty)) === SEND_QTY[i]),
  `${shipments.length} shipment(s) carrying ${ITEM}: ${shipments.map((s) => `${s.name}→${s.boutique} ×${sum((s.lines || []).map((l) => l.qty))}`).join(', ')}; ` +
  `confirmation listed ${sentRows.join(', ')}`)

const requests = []
for (const s of shipments) requests.push(await admin.value('AWANZ Replenishment Request', s.replenishment_request, ['name', 'warehouse_push', 'status', 'boutique', 'reason', 'requested_by', 'approved_by']))
record('every request behind a push carries warehouse_push, so a push and a pull are told apart for ever',
  requests.length === 3 && requests.every((r) => Number(r.warehouse_push) === 1 && r.status === 'Approved' && r.requested_by === WH_USER.usr && r.approved_by === WH_USER.usr),
  requests.map((r) => `${r.name}(${r.boutique}) push=${r.warehouse_push} ${r.status} by ${r.requested_by}→${r.approved_by}`).join(' · '))

const pulls = await admin.list('AWANZ Replenishment Request', { warehouse_push: 0 }, ['name'], 5)
record('a store\'s own request is untouched by any of this — warehouse_push stays 0 on a pull',
  pulls.length > 0,
  `${pulls.length} existing store-raised request(s) still at warehouse_push=0 (e.g. ${pulls.slice(0, 3).map((r) => r.name).join(', ')}); ` +
  `${requests.length} pushed request(s) at 1`)

record('each pushed shipment is an ordinary shipment: Pending, out of HOU-WH, into the store\'s own warehouse',
  shipments.every((s) => s.status === 'Pending' && s.from_warehouse === HQ) &&
    STORES.every((s) => byStore[s.boutique].to_warehouse === s.warehouse) &&
    shipments.every((s) => !!s.material_request),
  shipments.map((s) => `${s.name}: ${s.status} ${s.from_warehouse}→${s.to_warehouse} mr=${s.material_request}`).join(' · '))

const houstonAfterSend = await binOf(ITEM, HQ)
const availAfterSend = (await whApi.get('maison_pos.api.distribution.plan', { item_codes: JSON.stringify([ITEM]) })).items[0]
record('Houston\'s available stock falls by exactly the total sent the moment the push is raised',
  availAfterSend.committed === SEND_TOTAL && availAfterSend.available === planItem.available - SEND_TOTAL && houstonAfterSend.qty === houstonBeforeSend.qty,
  `${ITEM} at ${HQ}: available ${planItem.available} → ${availAfterSend.available} (committed ${availAfterSend.committed} = ${SEND_QTY.join('+')}); ` +
  `the bin still counts ${houstonAfterSend.qty} because nothing has physically left yet — that happens when the floor ships it`)

// ---------------------------------------------------------------- the wall picks, packs and ships
const wallCtx = await newContext({ viewport: { width: 1920, height: 1080 } })
await wallCtx.request.post('/api/method/login', { data: { usr: WH_USER.usr, pwd: WH_USER.pwd } })
const wall = await wallCtx.newPage()
wireConsole(wall, 'wall')
await wall.addInitScript(() => { window.__awanzWallPrintDry = true })
await wall.goto('/warehouse-wall', { waitUntil: 'domcontentloaded' })
await wall.waitForSelector('[data-testid=warehouse-wall]', { timeout: 40000 })

// the board polls every 10 s, so wait for the cards rather than reading an empty first paint
const onWall = []
for (const s of shipments) {
  try {
    await wall.waitForSelector(`[data-testid="wall-card-${s.name}"]`, { timeout: 40000 })
    onWall.push(await wall.locator(`[data-testid="wall-card-${s.name}"]`)
      .evaluate((e) => e.closest('[data-testid^="col-"]')?.getAttribute('data-testid') || 'no column'))
  } catch {
    onWall.push('never appeared')
  }
}
const toPickCount = await wall.locator('[data-testid=col-to_pick]').getAttribute('data-count').catch(() => null)
record('all three land on the wall\'s “To pick” column, as ordinary work for the floor',
  onWall.length === 3 && onWall.every((c) => c === 'col-to_pick'),
  `${shipments.map((s, i) => `${s.name} → ${onWall[i]}`).join(', ')} (col-to_pick holds ${toPickCount} card(s))`)
await shot(wall, 'wall-pushed-shipments', false)

async function shipFromWall(page, name) {
  await page.waitForSelector(`[data-testid="wall-card-${name}"]`, { timeout: 30000 })
  await page.click(`[data-testid="act-${name}"]`) // Pick — the server picks every line in full
  await page.waitForSelector('[data-testid=shipment-sheet]', { timeout: 30000 })
  await page.click('[data-testid=action-packed]')
  await page.waitForTimeout(1200)
  await page.click('[data-testid=action-ship]')
  await page.waitForSelector('[data-testid=shipment-sheet]', { state: 'detached', timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(600)
}

let shippedOk = true
let shipError = ''
for (const s of shipments) {
  try {
    await shipFromWall(wall, s.name)
  } catch (e) {
    shippedOk = false
    shipError += `${s.name}: ${String(e).slice(0, 120)} `
  }
}
const shippedDocs = []
for (const s of shipments) shippedDocs.push(await admin.doc('AWANZ Shipment', s.name))
record('the floor picks, packs and ships all three off the wall, each posting its own transfer out of Houston',
  shippedOk && shippedDocs.every((d) => d.status === 'Shipped' && !!d.stock_entry_ship) &&
    new Set(shippedDocs.map((d) => d.stock_entry_ship)).size === 3,
  shippedDocs.map((d) => `${d.name} ${d.status} ${d.stock_entry_ship}`).join(' · ') + (shipError ? ` · ${shipError}` : ''))
await shot(wall, 'wall-after-ship', false)
await wallCtx.close()

const houstonAfterShip = await binOf(ITEM, HQ)
record('HOU-WH\'s bin falls by exactly the total sent once the parcels leave',
  houstonAfterShip.qty === houstonBeforeSend.qty - SEND_TOTAL,
  `${ITEM} at ${HQ}: ${houstonBeforeSend.qty} → ${houstonAfterShip.qty} (sent ${SEND_QTY.join(' + ')} = ${SEND_TOTAL}); ` +
  `valuation held at $${round(houstonAfterShip.rate, 4)}`)

// ================================================================ 5. the store receives its own parcel
const mine = byStore[RECEIVER.boutique]
const storeBefore = await binOf(ITEM, RECEIVER.warehouse)
const mgrCtx = await newContext({ viewport: { width: 1366, height: 1024 } })
const mgrLogin = await mgrCtx.request.post('/api/method/login', { data: { usr: MANAGER.usr, pwd: MANAGER.pwd } })
if (!mgrLogin.ok()) throw new Error(`${MANAGER.usr} login failed ${mgrLogin.status()}`)
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

let storeStory = ''
let storeOk = false
let onlyMine = false
try {
  await unlockPos(mgr, MANAGER, RECEIVER.boutique)
  await mgr.goto('/pos/receive', { waitUntil: 'domcontentloaded' })
  await mgr.waitForSelector('[data-testid=inbound-shipments]', { timeout: 30000 })
  await mgr.waitForSelector(`[data-testid="inbound-${mine.name}"]`, { timeout: 30000 })
  // the other two stores' parcels must not be on this store's screen
  const others = await Promise.all(shipments.filter((s) => s.name !== mine.name).map((s) => mgr.locator(`[data-testid="inbound-${s.name}"]`).count()))
  onlyMine = others.every((n) => n === 0)
  await shot(mgr, 'store-inbound', false)
  await mgr.click(`[data-testid="inbound-${mine.name}"]`)
  await mgr.waitForSelector('[data-testid=count-sheet]', { timeout: 20000 })
  // scan the barcode that was typed into the create sheet, one read per unit, as the counter does
  const input = mgr.locator('[data-testid=count-input]')
  for (let i = 0; i < SEND_QTY[0]; i++) { await input.fill(BARCODE); await input.press('Enter') }
  const counted = await mgr.inputValue(`[data-testid="count-qty-${ITEM}"]`)
  const lastScan = (await mgr.locator('[data-testid=count-last-scan]').innerText()).replace(/\s+/g, ' ').trim()
  storeStory = `scanned ${BARCODE} ×${SEND_QTY[0]} → ${counted} · "${lastScan}"`
  await shot(mgr, 'store-count-sheet', false)
  await mgr.click('[data-testid=count-confirm]')
  await mgr.waitForSelector('[data-testid=receive-result]', { timeout: 40000 })
  storeStory += ' | ' + (await mgr.locator('[data-testid=receive-result]').innerText()).replace(/\s+/g, ' ').trim().slice(0, 160)
  storeOk = true
} catch (e) {
  storeStory = String(e).slice(0, 300)
}
await shot(mgr, 'store-received', false)

record(`the barcode created on the warehouse screen scans on ${RECEIVER.boutique}'s counter, ten minutes later`,
  storeOk && storeStory.includes(`→ ${SEND_QTY[0]}`) && /counted/i.test(storeStory),
  storeStory.slice(0, 260))

const mineAfter = await until(async () => {
  const doc = await admin.doc('AWANZ Shipment', mine.name)
  return doc.status === 'Received' ? doc : null
}, { timeout: 30000 }) || await admin.doc('AWANZ Shipment', mine.name)
const storeAfter = await binOf(ITEM, RECEIVER.warehouse)
record(`${RECEIVER.boutique}'s bin rises by exactly what was sent to it — not by what the other two got`,
  storeAfter.qty === storeBefore.qty + SEND_QTY[0] && mineAfter.status === 'Received' && !!mineAfter.stock_entry_receive,
  `${ITEM} at ${RECEIVER.warehouse}: ${storeBefore.qty} → ${storeAfter.qty} (sent ${SEND_QTY[0]}; the other two carried ${SEND_QTY.slice(1).join(' and ')}); ` +
  `${mineAfter.name} ${mineAfter.status} via ${mineAfter.stock_entry_receive}`)

record('a store sees only its own parcel on its Receive screen, never another store\'s',
  onlyMine,
  `${shipments.filter((s) => s.name !== mine.name).map((s) => `${s.name}(${s.boutique})`).join(', ')} absent from ${RECEIVER.boutique}'s inbound list: ${onlyMine}`)

const stillOut = await Promise.all(shipments.filter((s) => s.name !== mine.name).map((s) => admin.doc('AWANZ Shipment', s.name)))
const otherBins = []
for (const store of STORES.slice(1)) otherBins.push({ store: store.boutique, ...(await binOf(ITEM, store.warehouse)) })
record('the other two parcels are untouched by this store\'s receipt — still in transit, nothing in their bins',
  stillOut.every((d) => d.status === 'Shipped') && otherBins.every((b) => b.qty === 0),
  stillOut.map((d) => `${d.name} ${d.status}`).join(', ') + ' · ' + otherBins.map((b) => `${b.store} ${b.qty} on hand`).join(', '))

// ================================================================ 6. the refusals
// ---- the gate, proven the other way: head office is Houston too (SPEC §A)
const hoApi = await client(HO_USER)
const hoPlan = await hoApi.rawGet('maison_pos.api.distribution.plan', { item_codes: JSON.stringify([ITEM]) })
const hoStores = await hoApi.rawGet('maison_pos.api.distribution.stores')
record('head office may push as well as the warehouse admin — the gate is a role, not one account',
  hoPlan.status === 200 && hoStores.status === 200 && hoPlan.body?.message?.items?.[0]?.item_code === ITEM,
  `${HO_USER.usr} (AWANZ Head Office): plan=${hoPlan.status} stores=${hoStores.status}; ` +
  `plan came back with ${hoPlan.body?.message?.items?.length ?? 0} item(s) and ${hoStores.body?.message?.count ?? 0} shops`)
await hoApi.dispose()

// ---- send is POST-only on purpose: a state-changing endpoint reachable by GET is one link away
// from being fired by somebody else's page, because Frappe only checks CSRF on non-GET requests
const shipmentsBeforeGet = (await admin.childList('AWANZ Shipment Line', 'AWANZ Shipment', { item_code: ITEM }, ['parent'], 200)).length
const sendByGet = await whApi.rawGet('maison_pos.api.distribution.send', {
  lines: JSON.stringify([{ boutique: STORES[1].boutique, item_code: ITEM, qty: 1 }])
})
const shipmentsAfterGet = (await admin.childList('AWANZ Shipment Line', 'AWANZ Shipment', { item_code: ITEM }, ['parent'], 200)).length
record('send cannot be fired by a GET, even by the warehouse admin — and a refused GET ships nothing',
  sendByGet.status !== 200 && shipmentsAfterGet === shipmentsBeforeGet,
  `GET maison_pos.api.distribution.send → ${sendByGet.status} "${refusalText(sendByGet.body).slice(0, 90)}"; ` +
  `shipment lines carrying ${ITEM}: ${shipmentsBeforeGet} → ${shipmentsAfterGet}`)

const mgrApi = await client(MANAGER)
const denied = []
denied.push(['stores', await mgrApi.rawGet('maison_pos.api.distribution.stores')])
denied.push(['plan', await mgrApi.rawGet('maison_pos.api.distribution.plan', { item_codes: JSON.stringify([ITEM]) })])
denied.push(['suggest_split', await mgrApi.rawGet('maison_pos.api.distribution.suggest_split', { item_code: ITEM, qty: 3, mode: 'even' })])
// their own store, one unit — pushing is Houston's act, not the store's
denied.push(['send(own store)', await mgrApi.rawPost('maison_pos.api.distribution.send', {
  lines: [{ boutique: RECEIVER.boutique, item_code: ITEM, qty: 1 }], reason: 'store trying to pull stock to itself'
})])
denied.push(['create_product', await mgrApi.rawPost('maison_pos.api.purchasing.create_product', {
  payload: { item_code: `STORE-MADE-${STAMP}`, item_name: 'a store inventing a product', item_group: useGroup }
})])
record('every distribution endpoint and create_product answers a store manager with 403 over plain HTTP',
  denied.every(([, r]) => r.status === 403),
  denied.map(([n, r]) => `${n}=${r.status}`).join(' ') + ` (as ${MANAGER.usr})`)
// (the `exc` traceback beside it is Frappe's own `developer_mode: 1` behaviour on this bench, not
// something this app chooses — what is asserted here is the message the refusal actually carries)
record('and the refusal says why — Houston\'s, in words, on every one of the five',
  denied.every(([, r]) => /Houston|centralis|permitted|not allowed/i.test(refusalText(r.body))),
  denied.map(([n, r]) => `${n}: "${(refusalText(r.body).match(/message\\?": \\?"([^"\\]+)/)?.[1] || refusalText(r.body)).slice(0, 70)}"`).join(' · '))
const storeMade = await admin.list('Item', { name: `STORE-MADE-${STAMP}` }, ['name'], 5)
record('the refused create_product left no item behind either',
  storeMade.length === 0,
  `STORE-MADE-${STAMP} exists: ${storeMade.length > 0}`)

// and the desk itself is shut to them
await mgr.goto('/warehouse/stock', { waitUntil: 'domcontentloaded' })
await mgr.waitForSelector('[data-testid=desk-gate]', { timeout: 25000 }).catch(() => {})
const gate = (await mgr.locator('[data-testid=desk-gate]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const sawStock = await mgr.locator('[data-testid=stock-board]').count()
record('a deep link to /warehouse/stock — where “Send to stores” lives — is gated for a store manager',
  !!gate && sawStock === 0,
  `gate: "${gate.slice(0, 150)}"; stock board rendered: ${sawStock}`)
await shot(mgr, 'store-gated', false)
await mgrApi.dispose()

// ---------------------------------------------------------------- report
const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} checks passed; console issues: ${console_.length}`)
for (const c of console_.slice(0, 10)) log(`  ${c.tag} ${c.type} ${c.text}`)
writeFileSync(path.join(here, 'results.distribution.json'), JSON.stringify({
  base: BASE,
  warehouse: HQ,
  product: { item_code: ITEM, item_name: PRODUCT_NAME, item_group: useGroup, barcode: BARCODE, vendor: VENDOR, vendor_sku: SKU, cost: COST, selling: SELLING },
  order: { name: PO, qty: ORDER_QTY, companion: COMPANION.item_code, companion_qty: companionQty, companion_rate: companionRate },
  receipt: {
    purchase_receipt: PR,
    unit_cost_override: RECEIPT_RATE,
    freight: FREIGHT,
    freight_share_by_line_amount: round(expected.share, 4),
    freight_share_if_spread_per_unit: round(perUnit, 4),
    landed_unit_rate: round(expected.landedRate, 4),
    expected_moving_average: round(expected.rate, 4),
    actual_moving_average: round(afterReceipt.rate, 4),
    sheet_preview_after: previewAfter
  },
  distribution: {
    stores: STORES.map((s, i) => ({ boutique: s.boutique, warehouse: s.warehouse, qty: SEND_QTY[i], shipment: byStore[s.boutique]?.name })),
    units: SEND_TOTAL,
    houston_before: houstonBeforeSend.qty,
    houston_after_ship: houstonAfterShip.qty,
    receiver: RECEIVER.boutique,
    receiver_bin: { before: storeBefore.qty, after: storeAfter.qty }
  },
  splits: splitChecks,
  results,
  console: console_
}, null, 1))
await browser.close()
process.exit(passed === results.length ? 0 : 1)
