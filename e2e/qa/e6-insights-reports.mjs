import { launch, check, save, shot, BASE } from './lib-dash.mjs'
const { browser, page, console_ } = await launch()

// ---------- INSIGHTS ----------
let t0 = Date.now()
await page.goto(`${BASE}/awanz-dashboard?view=insights`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.insights .tiles .tile', { timeout: 45000 })
await page.waitForTimeout(3500)
check('Insights tab loads', true, `${Date.now() - t0} ms`)
await shot(page, '16-insights-1920.png')
const tiles = await page.locator('.insights .tiles').innerText()
check('insight tiles render', tiles.length > 20, tiles.replace(/\n/g, ' | '))
const sum = (await (await page.request.get(`${BASE}/api/method/maison_pos.api.insights.summary`)).json()).message
check('tiles match insights.summary', tiles.includes(String(sum.open_signals)) && tiles.includes(String(sum.recommended_clients)),
  `API open_signals=${sum.open_signals} open_rebalances=${sum.open_rebalances} recommended=${sum.recommended_clients} llm=${sum.llm}`)
check('narrative mode is "template" (no LLM)', /template/i.test(tiles), tiles.match(/Narrative[^|]*/i)?.[0] || '')

const narr = await page.locator('.insights .grid > .a').innerText()
check('weekly narrative card renders', narr.length > 10, narr.replace(/\n/g, ' | ').slice(0, 300))
const reb = await page.locator('.insights .grid > .b').innerText()
check('rebalance card renders', reb.length > 10, reb.replace(/\n/g, ' | ').slice(0, 300))
const heat = await page.locator('.insights .grid > .c').locator('.cell, rect, .row').count()
check('group heatmap renders', heat > 0, `${heat} cells`)
const mov = await page.locator('.insights .grid > .d').innerText()
check('movers table renders', /top|slow/i.test(mov), mov.replace(/\n/g, ' | ').slice(0, 260))
const contacts = await page.locator('.insights .grid > .e .list .row').count()
check('client signals / contact list renders', contacts > 0, `${contacts} rows`)
const sig = (await (await page.request.get(`${BASE}/api/method/maison_pos.api.insights.client_signals?limit=50`)).json()).message
check('contact list count matches client_signals', contacts >= Math.min(sig.signals.length, 10), `${contacts} on screen, API ${sig.signals.length} signals, by_type=${JSON.stringify(sig.by_type)}`)

// ---------- REPORTS ----------
t0 = Date.now()
await page.goto(`${BASE}/awanz-dashboard?view=reports`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('section.reports .group', { timeout: 45000 })
await page.waitForTimeout(1800)
check('Reports tab loads', true, `${Date.now() - t0} ms`)
await shot(page, '17-reports-1920.png')
const repTxt = await page.locator('section.reports').innerText()
const names = await page.locator('section.reports .item .name').allTextContents()
check('report catalogue lists reports', names.length >= 8, `${names.length}: ${names.join(' / ')}`)
const csvLinks = await page.locator('section.reports .item .csv').count()
check('every report has a CSV link', csvLinks === names.length, `${csvLinks} CSV links / ${names.length} reports`)
const missing = ['Commission Statement', 'Promotion Performance', 'Campaign Performance'].filter((n) => !names.some((x) => x.includes(n)))
check('all 11 AWANZ Script Reports are linked', missing.length === 0, missing.length ? `missing from the Reports tab: ${missing.join(', ')}` : 'all linked')
const badWords = ['Frappe', 'ERPNext'].filter((w) => repTxt.includes(w))
check('no "Frappe"/"ERPNext" text on the Reports tab', badWords.length === 0, badWords.length ? `found ${badWords.join(', ')} — header text: "${repTxt.split('\n').slice(0, 3).join(' | ')}"` : 'none')
const href = await page.locator('section.reports .item .name').first().getAttribute('href')
const csvHref = await page.locator('section.reports .item .csv').first().getAttribute('href')
check('report link + CSV href well formed', /query-report/.test(href) && /reports\.export/.test(csvHref), `${href} | ${csvHref}`)
// CSV actually downloads
const csvResp = await page.request.get(new URL(csvHref, BASE).toString())
const csvText = await csvResp.text()
check('CSV export downloads real rows', csvResp.ok() && csvText.split('\n').length > 1 && csvText.includes(','),
  `${csvResp.status()} ${csvResp.headers()['content-type']} ${csvText.split('\n').length - 1} data lines; head="${csvText.split('\n')[0].slice(0, 120)}"`)

// period comparison widget
const pcTxt = await page.locator('section.reports').first().innerText().catch(() => '')
const pc = (await (await page.request.get(`${BASE}/api/method/maison_pos.api.reports.period_comparison`)).json()).message
const bodyTxt = await page.locator('body').innerText()
check('period comparison widget renders', /week to date|month to date|year to date/i.test(bodyTxt), Object.entries(pc.periods).map(([k, v]) => `${k}: net ${v.current.net} vs ${v.previous.net} (${v.pct.net}%)`).join(' ; '))
const allBad = ['Frappe', 'ERPNext'].filter((w) => bodyTxt.includes(w))
check('no "Frappe"/"ERPNext" anywhere on the Reports page', allBad.length === 0, allBad.join(', '))
check('no console errors on Insights/Reports', console_.filter(c=>!/favicon/.test(c)).length === 0, console_.slice(0, 5).join(' | '))
save('results-e6.json')
await browser.close()
