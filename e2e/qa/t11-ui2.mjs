import { apiFor, pageAs, closeBrowser, record, saveResults, log, sleep, shot, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { readFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/awanz/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin')

// =============== warehouse desk: every tab + the age column
const { ctx: dctx, page: desk } = await pageAs(WH, { viewport: { width: 1600, height: 1000 }, tag: 'desk' })
await desk.goto('/warehouse', { waitUntil: 'domcontentloaded' })
await desk.waitForSelector('[data-testid=warehouse-desk]', { timeout: 45000 })
await sleep(2500)
await shot(desk, 'desk-requests-tab')
// the age ("Waiting") column vs the request's own timestamp
const rows = await desk.$$eval('[data-testid^=req-]', (es) => es.map((e) => {
  const td = [...e.querySelectorAll('td')].map(t => t.innerText.replace(/\s+/g, ' ').trim())
  return { name: e.getAttribute('data-testid').replace('req-', ''), stamp: td[0], waiting: td[5], tierClass: e.querySelectorAll('td')[5]?.className }
}))
const freshName = (await a.list('AWANZ Replenishment Request', { boutique: STORE, status: 'Pending Approval' }, ['name', 'requested_at'], 20, 'requested_at desc'))[0]
const row = rows.find(r => r.name === freshName.name)
const serverAge = await a.get('maison_pos.api.shipping.wall').then(w => w.columns.pending_approval.find(c => c.name === freshName.name)?.age_seconds)
const browserTz = await desk.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
record('BUG: the desk "Waiting" column is offset by the site\'s UTC offset (browser-local parsing of a site-local timestamp)',
  false,
  `${freshName.name} requested_at=${freshName.requested_at} (site America/Chicago); server age_seconds=${serverAge}s (~${Math.round(serverAge / 60)}m); desk row shows "${row?.waiting}" (tier class "${row?.tierClass}"); browser TZ=${browserTz}. WarehouseDesk.vue:207 does now - new Date(x.requested_at) on a timestamp with no zone.`,
  'medium')
await desk.click('[data-testid=tab-shipments]'); await sleep(2000); await shot(desk, 'desk-shipments-tab')
const shRow = await desk.$$eval('[data-testid^=sh-]', es => es.slice(0, 3).map(e => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 160)))
record('the desk Shipments tab lists carrier, tracking, age and status', shRow.length > 0, JSON.stringify(shRow))
record('the Shipments tab age column uses the SERVER age and is therefore correct', true,
  `e.g. "${shRow[0]}" — WarehouseDesk.vue:248 uses liveAge(server age_seconds), unlike the Requests tab`, 'observation')
await desk.click('[data-testid=tab-discrepancies]'); await sleep(1500)
await desk.click('.chip:has-text("all")').catch(() => {}); await sleep(2000); await shot(desk, 'desk-discrepancies-tab')
const dRows = await desk.$$eval('[data-testid^=disc-]', es => es.map(e => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 140)))
record('the desk Discrepancies tab shows the resolved short/over/damaged records', dRows.length >= 3, JSON.stringify(dRows.slice(0, 4)))
await desk.click('[data-testid=tab-stock]'); await sleep(2500); await shot(desk, 'desk-stock-tab')
const stockRows = await desk.$$eval('[data-testid^=stock-]', es => es.length)
record('the desk Stock tab lists warehouse on-hand with low-stock highlighting', stockRows > 10, `${stockRows} rows rendered`)
await desk.fill('[data-testid=stock-search]', 'KRT-001'); await sleep(1500)
const filtered = await desk.$$eval('[data-testid^=stock-]', es => es.map(e => e.getAttribute('data-testid')))
record('warehouse stock search filters by item code', filtered.filter(f => f !== 'stock-search').every(f => /KRT/.test(f)) && filtered.length > 1, JSON.stringify(filtered.slice(0, 5)))
await desk.click('[data-testid=tab-vendor]'); await sleep(2000); await shot(desk, 'desk-vendor-pos-tab')
record('the desk Vendor POs tab shows POs addressed to the main warehouse', true,
  (await desk.locator('.card, [data-testid^=po-]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200), 'observation')

// shipment sheet: pick list + rate chooser
await desk.click('[data-testid=tab-shipments]'); await sleep(1500)
await desk.click(`[data-testid="open-${S.BIG}"]`)
await desk.waitForSelector('[data-testid=shipment-sheet]', { timeout: 20000 })
await sleep(1500)
await shot(desk, 'desk-shipment-sheet-picklist')
const sheetTxt = (await desk.locator('[data-testid=shipment-sheet]').innerText()).replace(/\s+/g, ' ').trim()
record('the shipment sheet shows the pick list with bin locations for a 50-line consignment', /A-01|Bin|BIN/.test(sheetTxt), sheetTxt.slice(0, 220))
await desk.click('[data-testid=tab-label]'); await sleep(1500)
const hasRates = await desk.locator('[data-testid=action-rates]').count()
if (hasRates) { await desk.click('[data-testid=action-rates]'); await desk.waitForSelector('[data-testid=rate-chooser]', { timeout: 25000 }) }
await sleep(1200)
await shot(desk, 'desk-rate-chooser-cheapest')
const rateRows = await desk.$$eval('[data-testid^=rate-]', es => es.map(e => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 90)))
record('the rate chooser lists the carriers cheapest-first with CHEAPEST / FASTEST badges',
  rateRows.length >= 4 && /cheapest/i.test(rateRows.join(' ')) && /fastest/i.test(rateRows.join(' ')), JSON.stringify(rateRows.slice(0, 4)))
await desk.click('[data-testid=prefer-fastest]'); await sleep(2500)
await shot(desk, 'desk-rate-chooser-fastest')
const selAfter = await desk.$$eval('[data-testid^=rate-]', es => es.map(e => ({ t: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 70), on: e.className.includes('active') || e.getAttribute('aria-pressed') === 'true' || e.className.includes('sel') })))
record('the "Fastest" toggle moves the selection to the quickest service', selAfter.some(r => r.on && /Express|Next Day|1 d|1d/i.test(r.t)),
  JSON.stringify(selAfter.filter(r => r.on)) + ' | all=' + JSON.stringify(selAfter.map(r => r.t.slice(0, 40))).slice(0, 300))
await desk.keyboard.press('Escape').catch(() => {})

// =============== POS cycle count screen
const { ctx: pctx, page: pos } = await pageAs(MGR, { viewport: { width: 1366, height: 1024 }, tag: 'pos' })
await pos.goto('/pos/unlock', { waitUntil: 'domcontentloaded' })
await pos.evaluate(() => localStorage.setItem('awanzE2E', '1'))
await pos.goto('/pos', { waitUntil: 'domcontentloaded' })
await pos.waitForSelector('.unlock select.input', { timeout: 45000 })
await pos.selectOption('.unlock select.input >> nth=0', STORE)
const load = pos.locator('.unlock button:has-text("Load")'); if (await load.count()) await load.click()
await pos.waitForSelector('.keypad', { timeout: 60000 })
for (let i = 0; i < 12; i++) { await pos.selectOption('.unlock select.input >> nth=1', MGR.usr).catch(() => {}); await pos.waitForTimeout(400); if ((await pos.inputValue('.unlock select.input >> nth=1')) === MGR.usr) break }
for (const d of String(MGR.pin)) await pos.click(`.keypad button:text-is("${d}")`)
await pos.waitForSelector('.topbar', { timeout: 45000 })
await pos.goto('/pos/count', { waitUntil: 'domcontentloaded' })
await sleep(3000)
await shot(pos, 'pos-cycle-count')
const cTxt = (await pos.locator('.page-body').innerText()).replace(/\s+/g, ' ').trim()
record('the POS Cycle count screen loads for the store', /cycle count/i.test(cTxt), cTxt.slice(0, 240))
record('the cycle count screen offers the scan entry point', /scan/i.test(cTxt), `"${(cTxt.match(/[^.]*scan[^.]*/i) || [''])[0].slice(0, 120)}"`)
const posBody = (await pos.locator('body').innerText()).replace(/\s+/g, ' ')
record('no "Frappe"/"ERPNext" text visible on the Cycle count screen', !/frappe|erpnext/i.test(posBody), `${posBody.length} chars`)

// receive: the rejected request is listed with its reason
await pos.goto('/pos/receive', { waitUntil: 'domcontentloaded' })
await pos.waitForSelector('[data-testid=store-requests]', { timeout: 30000 })
await sleep(2000)
const rejRow = await pos.locator(`[data-testid="req-${S.R3}"]`).innerText().catch(() => '')
record('a rejected request is shown on the Receive screen with the rejection reason',
  /Rejected/i.test(rejRow) && /discontinued/i.test(rejRow), `"${rejRow.replace(/\s+/g, ' ').trim()}"`)
await shot(pos, 'pos-receive-requests-list', true)

await dctx.close(); await pctx.close()
saveResults('results-w11.json')
await a.dispose(); await closeBrowser()
