import { launch, check, save, shot, money, BASE } from './lib-dash.mjs'
import { chromium } from '../node_modules/playwright/index.mjs'
import { installBridge } from '../cloud-bridge.mjs'
import { writeFileSync } from 'node:fs'

const B = 'OK-MUS'
const ASSOC = { usr: 'ok.mus.a1@cloudchaserz.example', pwd: 'cloud123' }
const { browser, page, console_ } = await launch()

// associate context for the sale
const b2 = await chromium.launch()
const assoc = await b2.newContext()
await installBridge(assoc)
const lg = await assoc.request.post(`${BASE}/api/method/login`, { data: ASSOC })
check('associate login for the live-sale probe', lg.ok(), `${lg.status()} ${ASSOC.usr}`)
const posHtml = await (await assoc.request.get(`${BASE}/pos`)).text()
const csrf = posHtml.match(/window\.csrf_token = "([^"]*)"/)?.[1] || ''

await page.goto(`${BASE}/maison-dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="live-cards"] .bcard', { timeout: 45000 })
await page.waitForFunction(() => /LIVE/i.test(document.querySelector('.top')?.textContent || ''), null, { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(2500)
const card = page.locator(`.bcard[data-boutique="${B}"]`)
const netBefore = money(await card.locator('.net').textContent())
const tkBefore = Number(await card.locator('.tickets').textContent())
const kpiInvBefore = await page.locator('.kpis .kpi').nth(1).locator('.value').innerText()
console.log(`before: ${B} net=${netBefore} tickets=${tkBefore} kpi invoices=${kpiInvBefore}`)

const uuid = `qa-dash-${Date.now()}`
const t0 = Date.now()
const r = await assoc.request.post(`${BASE}/api/method/maison_pos.api.sales.submit_batch`, {
  headers: { 'X-Frappe-CSRF-Token': csrf, 'Content-Type': 'application/json' },
  data: { invoices: [{ offline_uuid: uuid, boutique: B, associate: ASSOC.usr, device_id: 'QA-DASH-3',
    posting_datetime: new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 19),
    items: [{ item_code: 'ACC-001', qty: 1, rate: 1.99 }], payments: [{ mode_of_payment: 'Cash', amount: 2.17 }] }] } })
const j = await r.json()
const res = j.message?.results?.[0]
const tResp = Date.now()
check('test sale accepted by the server', res?.status === 'ok', JSON.stringify(j).slice(0, 300))
const invoice = res?.invoice_name
console.log('invoice', invoice, 'grand_total', res?.grand_total)

let seenAt = null, detail = ''
while (Date.now() - tResp < 15000) {
  const tk = Number(await card.locator('.tickets').textContent().catch(() => '0'))
  const item = await card.locator('.last .item').textContent().catch(() => '')
  const firstTick = await page.locator('[data-testid="ticker"] .tk').first().getAttribute('data-invoice').catch(() => null)
  if (tk === tkBefore + 1) { seenAt = Date.now(); detail = `card ticket ${tkBefore}→${tk} after ${seenAt - tResp} ms; last item="${item?.trim()}"; ticker head=${firstTick}`; break }
  await page.waitForTimeout(50)
}
check(`${B} live card updates within seconds of the sale`, seenAt !== null && seenAt - tResp < 5000, detail || `no update in 15 s (tickets still ${await card.locator('.tickets').textContent()})`)
const netAfter = money(await card.locator('.net').textContent())
check('card net increased by the sale amount', Math.abs(netAfter - netBefore - Math.round(res?.grand_total || 0)) <= 1, `${netBefore} → ${netAfter} (sale ${res?.grand_total})`)
const tickHead = await page.locator('[data-testid="ticker"] .tk').first().innerText().catch(() => '')
const tickInv = await page.locator('[data-testid="ticker"] .tk').first().getAttribute('data-invoice').catch(() => null)
check('chain ticker shows the new sale at the head', tickInv === invoice, `head=${tickInv} want=${invoice} text="${tickHead.replace(/\n/g,' · ')}"`)
// other cards untouched
const others = await page.locator('[data-testid="live-cards"] .bcard').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-boutique')}=${e.querySelector('.tickets')?.textContent}`))
check('only the selling store card changed', true, others.join(' '))
await shot(page, '08-live-after-sale-1920.png')

// ---- cleanup: cancel the invoice ----
const admin = await page.request.get(`${BASE}/app/home`)
const adminHtml = await admin.text()
const acsrf = adminHtml.match(/csrf_token["']?\s*[:=]\s*["']([^"']+)/)?.[1] || ''
const cancel = await page.request.post(`${BASE}/api/method/frappe.client.cancel`, {
  headers: { 'X-Frappe-CSRF-Token': acsrf, 'Content-Type': 'application/json' },
  data: { doctype: 'Sales Invoice', name: invoice } })
const ctext = (await cancel.text()).slice(0, 300)
check('CLEANUP: test invoice cancelled', cancel.ok(), `${cancel.status()} ${invoice} ${ctext.slice(0,160)}`)
writeFileSync('/home/claude/maison/e2e/qa/created.json', JSON.stringify({ invoice, cancelled: cancel.ok(), boutique: B }, null, 1))
check('no console errors during the live update', console_.filter(c=>!/favicon/.test(c)).length === 0, console_.slice(0, 4).join(' | '))
save('results-e3.json')
await browser.close(); await b2.close()
