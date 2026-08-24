import { launch, check, save, shot, BASE } from './lib-dash.mjs'
import { writeFileSync } from 'node:fs'
const { browser, page, console_ } = await launch()
const t0 = Date.now()
await page.goto(`${BASE}/awanz-dashboard?view=clients`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.clients .card', { timeout: 45000 })
await page.waitForTimeout(2000)
check('Clients tab loads', true, `${Date.now() - t0} ms`)
await shot(page, '13-clients-1920.png')
const api = (await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.clients_overview?limit=40`)).json()).message

const churn = await page.locator('.card.churn .li[data-signal]').count()
check('churn-risk list renders', churn > 0 && churn === api.churn.length, `${churn} rows on screen, API churn=${api.churn.length}`)
const c0 = await page.locator('.card.churn .li[data-signal]').first().innerText()
check('churn row shows client / reason / LTV / store', /\d/.test(c0) && c0.split('\n').length >= 4, `${c0.replace(/\n/g, ' | ')} || API[0]=${api.churn[0].customer_name} risk=${api.churn[0].churn_risk} ltv=${api.churn[0].lifetime_spend} ${api.churn[0].boutique}`)

const fu = await page.locator('.li.fu').count()
const fuTxt = await page.locator('.li.fu').allTextContents()
check('follow-up rate card renders', fu === api.follow_ups.length, `${fu} rows: ${fuTxt.map((t) => t.replace(/\n/g, ' ')).join(' ; ')} || API=${JSON.stringify(api.follow_ups)}`)

const up = await page.locator('.li.up3').count()
check('upcoming dates card renders', up === api.upcoming.length, `${up} rows; API=${api.upcoming.length}; first="${await page.locator('.li.up3').first().innerText().then(t=>t.replace(/\n/g,' | ')).catch(()=>'')}"`)

const rec = await page.locator('.card.tiles').innerText()
check('recognition stats card renders', /Enrolled/.test(rec), `${rec.replace(/\n/g, ' | ')} || API=${JSON.stringify(api.recognition)}`)

const perf = await page.locator('.li.perfrow').count()
check('associate performance card renders', perf === api.performance.length, `${perf} rows, API=${api.performance.length}; first="${await page.locator('.li.perfrow').first().innerText().then(t=>t.replace(/\n/g,' | ')).catch(()=>'')}"`)

const camp = await page.locator('.li.camp').count()
check('campaign performance card renders', camp > 0, `${camp} rows; API campaigns=${api.campaigns ? api.campaigns.campaigns.length : 'null'}; first="${await page.locator('.li.camp').first().innerText().then(t=>t.replace(/\n/g,' | ')).catch(()=>'none')}"`)

// tier filter
const tierBtns = await page.locator('.clients .toolbar .btn').allTextContents()
check('tier filter buttons present', tierBtns.length >= 2, tierBtns.join(' / '))
await page.locator('.clients .toolbar .btn').first().click()
await page.waitForTimeout(900)
const churn2 = await page.locator('.card.churn .li[data-signal]').count()
const t1 = tierBtns[0]
const apiT = (await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.clients_overview?limit=40&tiers=${encodeURIComponent(t1)}`)).json()).message
check(`tier filter "${t1}" narrows the churn list`, churn2 === apiT.churn.length, `${churn2} on screen, API=${apiT.churn.length} (unfiltered ${api.churn.length})`)
await page.locator('.clients .toolbar .btn').first().click()
await page.waitForTimeout(700)
await shot(page, '14-clients-tier-1920.png')

// ---- Assign call ----
const sig = await page.locator('.card.churn .li[data-signal]').first().getAttribute('data-signal')
const before = (await (await page.request.get(`${BASE}/api/method/frappe.client.get_count?doctype=AWANZ%20Client%20Interaction`)).json()).message
await page.locator(`.card.churn .li[data-signal="${sig}"] .assign`).click()
await page.waitForTimeout(2500)
const after = (await (await page.request.get(`${BASE}/api/method/frappe.client.get_count?doctype=AWANZ%20Client%20Interaction`)).json()).message
const sigDoc = (await (await page.request.get(`${BASE}/api/method/frappe.client.get?doctype=AWANZ%20Client%20Signal&name=${sig}`)).json()).message
check('"Assign call" creates a follow-up task', after === before + 1 && !!sigDoc.call_task,
  `interactions ${before}→${after}; signal.call_task=${sigDoc.call_task} crm_task=${sigDoc.crm_task} assigned=${sigDoc.assigned_associate} at=${sigDoc.assigned_at}`)
const inter = sigDoc.call_task ? (await (await page.request.get(`${BASE}/api/method/frappe.client.get?doctype=AWANZ%20Client%20Interaction&name=${sigDoc.call_task}`)).json()).message : null
check('the follow-up is a Call, Open, with a due date and the right client', !!inter && inter.type === 'Call' && inter.status === 'Open' && !!inter.follow_up_date && inter.customer === sigDoc.customer,
  inter ? `type=${inter.type} status=${inter.status} due=${inter.follow_up_date} customer=${inter.customer} associate=${inter.associate}` : 'no interaction')
await shot(page, '15-clients-assign-call-1920.png')
writeFileSync('/home/claude/awanz/e2e/qa/created-assign.json', JSON.stringify({ signal: sig, interaction: sigDoc.call_task, crm_task: sigDoc.crm_task, customer: sigDoc.customer }, null, 1))
check('no console errors on Clients', console_.filter(c=>!/favicon/.test(c)).length === 0, console_.slice(0, 5).join(' | '))
save('results-e5.json')
await browser.close()
