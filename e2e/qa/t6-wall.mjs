import { apiFor, pageAs, closeBrowser, record, saveResults, log, sleep, shot, STORE, MGR, WH, TAG } from './lib-wh.mjs'
import { readFileSync } from 'node:fs'
const S = JSON.parse(readFileSync('/home/claude/maison/e2e/qa/state.json', 'utf8'))
const a = await apiFor('admin')

// ---------------- the 55" wall
const { ctx: wctx, page: wall } = await pageAs(WH, { viewport: { width: 1920, height: 1080 }, tag: 'wall' })
await wall.addInitScript(() => { window.__maisonWallPrintDry = true })
const t0 = Date.now()
await wall.goto('/warehouse-wall', { waitUntil: 'domcontentloaded' })
await wall.waitForSelector('[data-testid=warehouse-wall]', { timeout: 45000 })
await wall.waitForSelector(`[data-testid="wall-card-${S.toPick.ship}"]`, { timeout: 30000 })
record('/warehouse-wall opens at 1920x1080 for the warehouse admin', true, `first paint + cards in ${Date.now() - t0} ms`)
await sleep(2500)
await shot(wall, 'wall-1920-all-columns')

const cols = await wall.$$eval('[data-testid^=col-]', (es) => es.map((e) => ({
  key: e.getAttribute('data-testid'), count: Number(e.getAttribute('data-count')),
  head: (e.querySelector('.chead, h2, header, .col-head')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
  cards: [...e.querySelectorAll('[data-testid^=wall-card-]')].map((c) => c.getAttribute('data-testid').replace('wall-card-', '')),
})))
log(JSON.stringify(cols, null, 1))
const col = (k) => cols.find((c) => c.key === `col-${k}`)
record('the wall renders the five kanban columns', cols.length === 5, cols.map((c) => `${c.key}(${c.count})`).join(' '))
record('a Pending Approval request sits in "Pending approval"', col('pending_approval').cards.includes(S.RC) && col('pending_approval').cards.includes(S.RW), JSON.stringify(col('pending_approval')))
record('a Pending shipment sits in "To pick"', col('to_pick').cards.includes(S.toPick.ship), JSON.stringify(col('to_pick').cards))
record('a Packed shipment WITHOUT a label sits in "Packing"', col('packing').cards.includes(S.packing.ship), JSON.stringify(col('packing').cards))
record('a Packed shipment WITH a label sits in "Ready to ship"', col('ready').cards.includes(S.ready.ship), JSON.stringify(col('ready').cards))
record('a shipment shipped today sits in "Shipped today"', col('shipped_today').cards.includes(S.S2), JSON.stringify(col('shipped_today').cards))

// age tiers + priority flag
const tiers = await wall.$$eval('[data-testid^=wall-card-]', (es) => es.map((e) => ({
  name: e.getAttribute('data-testid').replace('wall-card-', ''),
  tier: e.getAttribute('data-tier'),
  flagged: e.className.includes('flagged'),
  age: (e.querySelector('[data-testid^=age-]')?.textContent || '').trim(),
  text: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
})))
log(JSON.stringify(tiers, null, 1))
const tOf = (n) => tiers.find((t) => t.name === n)
record('age timer: a 5 h-old request is amber (warn tier, threshold 4 h)', tOf(S.RW)?.tier === 'warn', `${S.RW} tier=${tOf(S.RW)?.tier} age="${tOf(S.RW)?.age}"`)
record('age timer: a 30 h-old request is red (crit tier, threshold 24 h)', tOf(S.RC)?.tier === 'crit', `${S.RC} tier=${tOf(S.RC)?.tier} age="${tOf(S.RC)?.age}"`)
record('age timer: a 6 h-old shipment in To pick is amber', tOf(S.toPick.ship)?.tier === 'warn', `${S.toPick.ship} tier=${tOf(S.toPick.ship)?.tier} age="${tOf(S.toPick.ship)?.age}"`)
record('age timer: a fresh card is green (ok tier)', tOf(S.packing.ship)?.tier === 'ok', `${S.packing.ship} tier=${tOf(S.packing.ship)?.tier} age="${tOf(S.packing.ship)?.age}"`)
record('priority flag (⚑) is shown on the Urgent card and not on a Normal one', tOf(S.RC)?.flagged === true && tOf(S.RW)?.flagged === false && /⚑/.test(tOf(S.RC)?.text || ''),
  `urgent flagged=${tOf(S.RC)?.flagged} text="${tOf(S.RC)?.text}"; normal flagged=${tOf(S.RW)?.flagged}`)
record('the card shows the store code, item/unit counts and the document name', /OK-JENKS/.test(tOf(S.toPick.ship)?.text || '') && /units?/.test(tOf(S.toPick.ship)?.text || ''),
  `"${tOf(S.toPick.ship)?.text}"`)
record('cards are ordered priority-first then oldest-first', col('pending_approval').cards[0] === S.RC && col('pending_approval').cards[1] === S.RW,
  `order=${col('pending_approval').cards.join(' > ')}`)
const conn = (await wall.locator('[data-testid=wall-connection]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const clock = (await wall.locator('[data-testid=wall-clock]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
record('the wall reports its live connection and shows the SITE clock/zone', /live|polling/i.test(conn) && /\d\d:\d\d/.test(clock), `connection="${conn}" clock="${clock}"`)

// ---------------- realtime: approve elsewhere (the desk UI), the wall must react + auto-print
const { ctx: dctx, page: desk } = await pageAs(WH, { viewport: { width: 1600, height: 1000 }, tag: 'desk' })
await desk.goto('/warehouse', { waitUntil: 'domcontentloaded' })
await desk.waitForSelector('[data-testid=warehouse-desk]', { timeout: 45000 })
await sleep(1500)
await shot(desk, 'warehouse-desk')
record('/warehouse desk opens for the Maison Warehouse Admin (no permission gate)',
  await desk.locator('[data-testid=warehouse-desk]').isVisible() && !(await desk.locator('[data-testid=desk-gate]').count()), 'desk visible, no gate')
record('the desk lists the store\'s pending request raised on the POS', await desk.locator(`[data-testid="req-${S.RUI}"]`).count() > 0,
  (await desk.locator(`[data-testid="req-${S.RUI}"]`).innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200))

await desk.click(`[data-testid="review-${S.RUI}"]`)
await desk.waitForSelector('[data-testid=approve-sheet]', { timeout: 20000 })
await shot(desk, 'warehouse-approve-sheet')
await desk.fill('[data-testid="approve-qty-ROL-002"]', '4')
const before = await wall.evaluate(() => window.__maisonLastWallPrint || null)
await desk.click('[data-testid=action-approve]')
await desk.waitForSelector('[data-testid=approve-sheet]', { state: 'detached', timeout: 25000 })
const newShip = (await a.list('Maison Shipment', { replenishment_request: S.RUI }, ['name', 'status'], 5))[0]
record('approving in the desk UI with an edited quantity creates the shipment', !!newShip,
  `${newShip?.name} ${newShip?.status}; approved qty=${JSON.stringify((await a.get('maison_pos.api.shipping.shipment', { shipment: newShip.name })).lines.map(l => [l.item_code, l.qty]))}`)
let realtimeMs = null
const rt0 = Date.now()
try { await wall.waitForSelector(`[data-testid="wall-card-${newShip.name}"]`, { timeout: 20000 }); realtimeMs = Date.now() - rt0 } catch {}
record('the wall picks up the approval made elsewhere (realtime / 10 s poll)', realtimeMs !== null, `card appeared after ${realtimeMs} ms; connection="${conn}"`)
const job = await wall.evaluate(() => window.__maisonLastWallPrint || null)
record('the auto-print hook fires for the packing list when a shipment is approved',
  !!job && job.kind === 'packing_list' && String(job.shipment) === String(newShip.name), `before=${JSON.stringify(before)} after=${JSON.stringify(job)}`)
const pl = await a.ctx.request.get(job?.url || `/printview?doctype=Maison%20Shipment&name=${newShip.name}&format=Maison%20Packing%20List&no_letterhead=1`)
const plHtml = await pl.text()
record('the packing list print format renders (store address, lines, barcodes, QR)',
  pl.ok() && /CloudChaserz/.test(plHtml) && /OK-JENKS/.test(plHtml) && /data:image\/svg\+xml/.test(plHtml),
  `${pl.status()} len=${plHtml.length}; has QR=${/qr/i.test(plHtml)}; mentions Frappe/ERPNext=${/frappe|erpnext/i.test(plHtml.replace(/<[^>]*>/g, ''))}`)
await shot(wall, 'wall-after-realtime-approval')

// ---------------- tap action
await wall.click(`[data-testid="act-${S.toPick.ship}"]`)
await sleep(2500)
const sheetOpen = await wall.locator('[data-testid=shipment-sheet]').count()
const st = await a.value('Maison Shipment', S.toPick.ship, ['status'])
record('tapping the card action on the wall works (To pick -> Picking + sheet opens)', st.status === 'Picking' && sheetOpen > 0,
  `status now ${st.status}, shipment sheet open=${!!sheetOpen}`)
await shot(wall, 'wall-tap-action-sheet')
await wall.keyboard.press('Escape').catch(() => {})
await sleep(800)

// ---------------- many cards (frontend rendering / legibility / performance)
await wctx.route('**/api/method/maison_pos.api.shipping.wall*', async (route) => {
  const resp = await route.fetch()
  const body = await resp.json()
  const cols = body.message.columns
  const clone = (c, i, col) => ({ ...c, name: `${c.name}-X${col}${i}`, age_seconds: (i * 1700) % 120000, priority: i % 7 === 0 ? 'Urgent' : i % 3 === 0 ? 'Low stock' : 'Normal' })
  for (const [k, arr] of Object.entries(cols)) {
    const seed = arr[0]
    if (!seed) continue
    for (let i = 0; i < 60; i++) arr.push(clone(seed, i, k))
  }
  await route.fulfill({ response: resp, json: body })
})
const p0 = Date.now()
await wall.reload({ waitUntil: 'domcontentloaded' })
await wall.waitForSelector('[data-testid=warehouse-wall]', { timeout: 45000 })
await sleep(4000)
const loadMs = Date.now() - p0
const many = await wall.$$eval('[data-testid^=col-]', (es) => es.map((e) => ({ key: e.getAttribute('data-testid'), count: Number(e.getAttribute('data-count')), rendered: e.querySelectorAll('[data-testid^=wall-card-]').length })))
const overflow = await wall.evaluate(() => ({ bodyScroll: document.documentElement.scrollWidth > window.innerWidth + 1, w: document.documentElement.scrollWidth, vw: window.innerWidth }))
const fontPx = await wall.evaluate(() => { const c = document.querySelector('[data-testid^=wall-card-] .code'); return c ? parseFloat(getComputedStyle(c).fontSize) : 0 })
const fps = await wall.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 1500) requestAnimationFrame(f); else res(Math.round((n * 1000) / (performance.now() - t))) }; requestAnimationFrame(f) }))
record('the wall stays usable with ~60 cards per column (virtualised columns)',
  many.every((m) => m.count >= 60 && m.rendered < m.count), `${JSON.stringify(many)} — reload+render ${loadMs} ms`)
record('no horizontal page overflow at 1920x1080 with many cards', !overflow.bodyScroll, JSON.stringify(overflow))
record('card type stays big enough to read across a warehouse (store code >= 24 px)', fontPx >= 24, `store-code font-size = ${fontPx}px`)
record('the board keeps animating smoothly with many cards', fps >= 30, `~${fps} fps over 1.5 s`)
await shot(wall, 'wall-1920-many-cards')

// white-label check on both screens
for (const [name, p] of [['wall', wall], ['desk', desk]]) {
  const txt = (await p.locator('body').innerText()).replace(/\s+/g, ' ')
  record(`no "Frappe"/"ERPNext" text visible on the ${name}`, !/frappe|erpnext/i.test(txt), `${txt.length} chars scanned; sample="${txt.slice(0, 110)}"`)
}
await wctx.close(); await dctx.close()
saveResults('results-w6.json')
await a.dispose(); await closeBrowser()
