import { apiFor, pageAs, closeBrowser, record, saveResults, log, sleep, shot, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { readFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin')
const { ctx, page } = await pageAs(MGR, { viewport: { width: 1366, height: 1024 }, tag: 'pos' })

async function unlock() {
  await page.goto('/pos/unlock', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.setItem('maisonE2E', '1'))
  await page.goto('/pos', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unlock select.input', { timeout: 45000 })
  await page.selectOption('.unlock select.input >> nth=0', STORE)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 60000 })
  for (let i = 0; i < 12; i++) {
    await page.selectOption('.unlock select.input >> nth=1', MGR.usr).catch(() => {})
    await page.waitForTimeout(400)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === MGR.usr) break
  }
  for (const d of String(MGR.pin)) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 45000 })
}
await unlock()
record('store manager unlocks the POS at their store (PIN)', true, `${MGR.usr} @ ${STORE}`)

// ---------------- Shift screen: the low-stock card
await page.goto('/pos/shift', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid=low-stock]', { timeout: 30000 })
await sleep(1500)
const ls = (await page.locator('[data-testid=low-stock]').innerText()).replace(/\s+/g, ' ').trim()
const apiAlerts = await (await apiFor(MGR)).get('maison_pos.api.inventory.alerts', { boutique: STORE, status: 'open' })
record('the Shift screen shows a "Low stock" card with the open-alert count', /\d+\s*open/i.test(ls), `"${ls.slice(0, 260)}"`)
record('the Shift count matches the alerts API for this store', new RegExp(`${apiAlerts.open}\\s*open`, 'i').test(ls), `card says "${(ls.match(/(\d+)\s*open/i) || [])[0]}", API open=${apiAlerts.open} (${apiAlerts.alerts.map(x => x.item_code + '/' + x.status).join(', ')})`)
record('each low-stock line shows on-hand vs reorder level and its state', /\d+\s*\/\s*\d+/.test(ls), ls.slice(0, 200))
await shot(page, 'pos-shift-low-stock')
const oneTap = await page.locator('[data-testid^=request-warehouse-]').count()
record('a low-stock line offers a one-tap "Request from warehouse" when nothing is on order yet', oneTap > 0,
  `${oneTap} one-tap buttons; ids=${JSON.stringify(await page.$$eval('[data-testid^=request-warehouse-]', es => es.map(e => e.getAttribute('data-testid'))))}`)
if (oneTap) {
  const id = await page.$eval('[data-testid^=request-warehouse-]', e => e.getAttribute('data-testid'))
  const before = new Set((await a.get('maison_pos.api.shipping.requests_list', { status: 'all', boutique: STORE, limit: 500 })).requests.map(r => r.name))
  await page.click(`[data-testid="${id}"]`)
  await sleep(4000)
  const after = (await a.get('maison_pos.api.shipping.requests_list', { status: 'all', boutique: STORE, limit: 500 })).requests.filter(r => !before.has(r.name))
  record('tapping it raises a replenishment request straight from the alert', after.length === 1,
    `${id} -> ${after.map(r => `${r.name} ${r.lines.map(l => l.item_code + '×' + l.qty)} ${r.priority}`).join('')}`)
  if (after[0]) global.__oneTapReq = after[0].name
  await shot(page, 'pos-shift-after-one-tap')
}

// ---------------- Receive screen
await page.goto('/pos/receive', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid=inbound-shipments]', { timeout: 30000 })
await sleep(1500)
await shot(page, 'pos-receive-screen')
const inbTxt = (await page.locator('[data-testid=inbound-shipments]').innerText()).replace(/\s+/g, ' ').trim()
record('the Receive screen lists what is in transit to this store', (await page.locator(`[data-testid="inbound-${S.SU}"]`).count()) > 0, inbTxt.slice(0, 240))
record('the Receive screen lists vendor POs addressed to the store', (await page.locator(`[data-testid="po-${S.po}"]`).count()) > 0,
  (await page.locator('[data-testid=vendor-pos]').innerText()).replace(/\s+/g, ' ').trim().slice(0, 200))
const reqTxt = (await page.locator('[data-testid=store-requests]').innerText()).replace(/\s+/g, ' ').trim()
record('the Receive screen shows my requests with their status and any rejection reason',
  /Rejected/.test(reqTxt) && /discontinued/i.test(reqTxt), reqTxt.slice(0, 300))

// manual request through the modal (editable quantity)
await page.click('[data-testid=request-from-warehouse]')
await page.waitForSelector('[data-testid=req-search]', { timeout: 20000 })
await page.fill('[data-testid=req-search]', 'ROL-006')
await sleep(1200)
await page.click('.matches .match:has-text("ROL-006")')
await page.fill('.trow input.qty', '3')
await shot(page, 'pos-receive-request-modal')
const beforeR = new Set((await a.get('maison_pos.api.shipping.requests_list', { status: 'all', boutique: STORE, limit: 500 })).requests.map(r => r.name))
await page.click('[data-testid=req-send]')
await sleep(4000)
const newR = (await a.get('maison_pos.api.shipping.requests_list', { status: 'all', boutique: STORE, limit: 500 })).requests.filter(r => !beforeR.has(r.name))
record('a manual request with an edited quantity can be sent from the Receive screen', newR.length === 1 && newR[0].lines[0].qty === 3,
  newR.map(r => `${r.name} ${r.lines.map(l => l.item_code + '×' + l.qty)}`).join(''))
global.__manualReq = newR[0]?.name

// ---------------- count sheet: scan to count
await page.click(`[data-testid="inbound-${S.SU}"]`)
await page.waitForSelector('[data-testid=count-sheet]', { timeout: 20000 })
await shot(page, 'pos-receive-count-sheet')
const input = page.locator('[data-testid=count-input]')
for (let i = 0; i < 3; i++) { await input.fill('2007841007630'); await input.press('Enter'); await sleep(250) }
const scanned = (await page.locator('[data-testid=count-last-scan]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const qtyVal = await page.inputValue('[data-testid="count-qty-ROL-002"]').catch(() => '')
record('scanning the item barcode increments the counted quantity on the sheet', qtyVal === '3', `3 scans of EAN 2007841007630 -> counted "${qtyVal}"; pill="${scanned}"`)
await input.fill('9999999999999'); await input.press('Enter'); await sleep(600)
const bad = (await page.locator('[data-testid=count-last-scan]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
record('scanning a barcode that is not on this delivery is rejected with a clear pill', /not on this delivery/i.test(bad), `"${bad}"`)
const summary = (await page.locator('[data-testid=count-summary]').innerText()).replace(/\s+/g, ' ').trim()
record('the sheet summarises the short/over position before posting', summary.length > 0, `"${summary.slice(0, 200)}"`)
await shot(page, 'pos-receive-count-partial')
const hasPartial = await page.locator('[data-testid=count-partial]').count()
record('a "Save partial" action is offered while units are still missing', hasPartial > 0, `partial button present=${!!hasPartial}`)
if (hasPartial) {
  await page.click('[data-testid=count-partial]')
  await page.waitForSelector('[data-testid=receive-result]', { timeout: 30000 })
  const res = (await page.locator('[data-testid=receive-result]').innerText()).replace(/\s+/g, ' ').trim()
  const doc = await a.get('maison_pos.api.shipping.shipment', { shipment: S.SU })
  record('the partial receipt posts from the UI and the shipment stays in transit',
    doc.status === 'Shipped' && doc.units_received === 3, `"${res.slice(0, 180)}"; status=${doc.status} received=${doc.units_received}/${doc.units}`)
  await shot(page, 'pos-receive-partial-result')
}
// complete it
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid=inbound-shipments]', { timeout: 30000 })
await page.click(`[data-testid="inbound-${S.SU}"]`)
await page.waitForSelector('[data-testid=count-sheet]', { timeout: 20000 })
await page.click('[data-testid=count-fill-all]')
await page.click('[data-testid=count-confirm]')
await page.waitForSelector('[data-testid=receive-result]', { timeout: 30000 })
const finTxt = (await page.locator('[data-testid=receive-result]').innerText()).replace(/\s+/g, ' ').trim()
const finDoc = await a.get('maison_pos.api.shipping.shipment', { shipment: S.SU })
record('completing the count from the UI closes the shipment and posts the rest',
  finDoc.status === 'Received' && finDoc.units_received === 5, `"${finTxt.slice(0, 200)}"; status=${finDoc.status} received=${finDoc.units_received}`)
await shot(page, 'pos-receive-confirmed')

const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
record('no "Frappe"/"ERPNext" text visible on the POS Receive screen', !/frappe|erpnext/i.test(body), `${body.length} chars scanned`)
log('ONE TAP REQ ' + global.__oneTapReq + ' MANUAL REQ ' + global.__manualReq)
await ctx.close()
saveResults('results-w7b.json')
await a.dispose(); await closeBrowser()
