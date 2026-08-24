import { apiFor, pageAs, closeBrowser, record, saveResults, log, sleep, shot, STORE, MGR, WH } from './lib-wh.mjs'
const a = await apiFor('admin'), m = await apiFor(MGR)
// role gate on the warehouse API
for (const [name, method, args] of [
  ['wall', 'maison_pos.api.shipping.wall', {}],
  ['warehouse stock', 'maison_pos.api.shipping.warehouse_stock', {}],
  ['vendor POs', 'maison_pos.api.shipping.vendor_pos', {}],
]) {
  const r = await m.tryGet(method, args)
  record(`a store manager is refused the warehouse-admin endpoint "${name}"`, !r.ok, `${r.status} ${String(r.exc).slice(0, 140)}`)
}
// the desk/wall screens gate in the UI
const { ctx, page } = await pageAs(MGR, { viewport: { width: 1600, height: 1000 }, tag: 'gate' })
await page.goto('/warehouse', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid=warehouse-desk]', { timeout: 45000 })
await sleep(2500)
const gate = await page.locator('[data-testid=desk-gate]').count()
const gateTxt = gate ? (await page.locator('[data-testid=desk-gate]').innerText()).replace(/\s+/g, ' ').trim() : ''
record('a store manager opening /warehouse gets the permission gate, not the desk', gate > 0, `"${gateTxt.slice(0, 200)}"`)
await shot(page, 'desk-gate-store-manager')
await page.goto('/warehouse-wall', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid=warehouse-wall]', { timeout: 45000 })
await sleep(2000)
record('a store manager opening /warehouse-wall gets the permission gate', (await page.locator('[data-testid=wall-gate]').count()) > 0,
  (await page.locator('[data-testid=wall-gate]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160))
await ctx.close()
// final clean board
const { ctx: c2, page: wall } = await pageAs(WH, { viewport: { width: 1920, height: 1080 }, tag: 'wall' })
await wall.addInitScript(() => { window.__maisonWallPrintDry = true })
await wall.goto('/warehouse-wall', { waitUntil: 'domcontentloaded' })
await wall.waitForSelector('[data-testid=warehouse-wall]', { timeout: 45000 })
await sleep(3000)
await shot(wall, 'wall-1920-clean-after-cleanup')
const txt = (await wall.locator('body').innerText()).replace(/\s+/g, ' ')
record('the board is back to empty at the end of the run', !/wall-card/.test(await wall.content()) || (await wall.$$('[data-testid^=wall-card-]')).length === 0, txt.slice(0, 200))
await c2.close()
saveResults('results-c5.json')
await m.dispose(); await a.dispose(); await closeBrowser()
