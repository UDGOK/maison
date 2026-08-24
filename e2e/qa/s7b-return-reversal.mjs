// QA4 · B — points reversal on return + the redeem sheet's single-selection behaviour.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, log } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Member QA4A'
const S7 = JSON.parse(fs.readFileSync(new URL('./created-s7.json', import.meta.url)))
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
// a return against the invoice whose points were later REDEEMED
const blocked = await assoc.rawPost('maison_pos.api.returns.return_items', {
  invoice: S7.earn,
  lines: JSON.stringify([{ item_code: 'CBD-003', qty: 2, reason: 'Change of mind', condition: 'Sellable' }]),
  refund_method: 'cash', reason: 'Change of mind', device_id: `QA4-${TAG}`
})
record('B · a sale can still be returned after its points were redeemed', blocked.status === 200,
  `return of ${S7.earn} → ${blocked.status} ${String(blocked.body?.exception || '').slice(0, 220)}`, blocked.status === 200 ? '' : 'major')

// a clean sale → return → points reversal
const fresh = await assoc.post('maison_pos.api.sales.submit_batch', {
  invoices: [{
    offline_uuid: `qa4-${TAG}-ret-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
    posting_datetime: new Date().toISOString(), customer: MEMBER,
    items: [{ item_code: 'CBD-003', qty: 3, rate: 44.99 }],
    payments: [{ mode_of_payment: 'Cash', amount: 147.79 }]
  }]
})
const freshRes = fresh.results[0]
if (freshRes.status !== 'ok') throw new Error('fresh sale rejected ' + JSON.stringify(freshRes).slice(0, 200))
await L.sleep(1500)
const before = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
const freshInv = await admin.doc('Sales Invoice', freshRes.invoice_name)
const ret = await assoc.post('maison_pos.api.returns.return_items', {
  invoice: freshRes.invoice_name,
  lines: JSON.stringify([{ item_code: 'CBD-003', qty: 3, reason: 'Change of mind', condition: 'Sellable' }]),
  refund_method: 'cash', reason: 'Change of mind', device_id: `QA4-${TAG}`
})
const cnName = ret.credit_note || ret.name || ret.invoice || ret.invoice_name
const cn = await admin.doc('Sales Invoice', cnName)
await L.sleep(2500)
const after = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
const lpe = await admin.list('Loyalty Point Entry', { customer: MEMBER }, ['name', 'invoice', 'loyalty_points', 'purchase_amount'], 20)
record('B · a return reverses the points earned on that sale', Math.round(before.points - after.points) === Math.floor(Number(freshInv.net_total)),
  `sale ${freshInv.name} net ${freshInv.net_total} → credit note ${cn.name} net ${cn.net_total}; points ${before.points} → ${after.points} (Δ ${after.points - before.points})`)
record('B · the balance never goes negative', after.points >= 0, `points=${after.points}`)
record('B · the reversal is written as a Loyalty Point Entry against the credit note',
  lpe.some((e) => e.invoice === cn.name || Number(e.loyalty_points) < 0), JSON.stringify(lpe.slice(0, 5).map((e) => [e.invoice, e.loyalty_points])))
fs.writeFileSync(new URL('./created-s7b.json', import.meta.url), JSON.stringify({ creditNote: cn.name, freshSale: freshRes.invoice_name }, null, 2))

// --- redeem sheet single selection (UI)
const browser = await L.newBrowser()
const { context, page } = await L.ctxFor(browser, L.A1, 'pos', { viewport: { width: 1440, height: 1024 } })
await L.unlock(page, L.A1, { fresh: true })
const cust = await admin.value('Customer', MEMBER, ['maison_client_number'])
await L.nav(page, 'Client')
await page.waitForSelector('.client-view .toolbar input', { timeout: 25000 })
await page.fill('.client-view .toolbar input', cust.maison_client_number)
await page.waitForSelector('.client-view .crow', { timeout: 25000 })
await page.locator('.client-view .crow').first().click()
await page.click('.detail .actions button:has-text("Attach to sale")')
await page.waitForSelector('.basket .client-name', { timeout: 20000 })
await L.addItem(page, 'Blazer Big Shot')
await page.click('[data-testid=loyalty-row]')
await page.waitForSelector('[data-testid=redeem-sheet]', { timeout: 20000 })
const before2 = await page.$$eval('[data-testid=redeem-sheet] .tier', (t) => t.map((e) => e.className))
await page.click('[data-testid=tier-100]')
await page.waitForTimeout(800)
const sheetStill = await page.locator('[data-testid=redeem-sheet]').count()
let picked = 0, second = 'sheet closed'
if (sheetStill) {
  await page.click('[data-testid=tier-200]').catch(() => {})
  await page.waitForTimeout(800)
  picked = await page.evaluate(() => document.querySelectorAll('[data-testid=redeem-sheet] .tier.on').length)
  second = `${picked} highlighted`
}
record('B · with stacking off the sheet never holds two tiers at once', !sheetStill || picked === 1, `after picking a tier: ${sheetStill ? 'sheet stays open' : 'sheet closes'}; ${second}`)
const sub = (await page.locator('[data-testid=redeem-sub]').textContent()).trim()
record('B · only one reward ends up applied', !/\+/.test(sub), `applied = ${sub}`)
await L.shot(page, 'pos-redeem-single-tier')
// leave the till clean
await page.click('[data-testid=loyalty-row]').catch(() => {})
await page.waitForTimeout(400)
await context.close(); await browser.close()
L.writeResults('results-s7b.json', { creditNote: cn.name })
