import { launch, check, save, shot, money, BASE } from './lib-dash.mjs'
const { browser, page, console_ } = await launch()
const t0 = Date.now()
await page.goto(`${BASE}/maison-dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="live-cards"] .bcard', { timeout: 45000 })
const tLoad = Date.now() - t0
check('Live tab loads', true, `${tLoad} ms to first store card`)
await page.waitForTimeout(2500)
await shot(page, '01-live-1920.png')

// -- title / brand / no Frappe or ERPNext strings --
const title = await page.title()
const bodyText = await page.evaluate(() => document.body.innerText)
check('page title is CloudChaserz-branded', /CLOUDCHASERZ/i.test(title), title)
const bad = ['Frappe', 'ERPNext', 'frappe', 'erpnext'].filter((w) => bodyText.includes(w))
check('no "Frappe"/"ERPNext" visible on Live', bad.length === 0, bad.length ? `found: ${bad.join(', ')}` : 'none')
const maisonHits = (bodyText.match(/Maison/g) || []).length
check('brand wordmark not "Maison"', !/^\s*Maison/m.test(bodyText.split('\n')[0]), `first line: ${bodyText.split('\n').slice(0,3).join(' | ')}`)
const wordmark = await page.locator('.wordmark').first().textContent().catch(() => null)
const scope = await page.locator('.top').first().innerText().catch(() => '')
check('TopBar wordmark = CLOUDCHASERZ', /CLOUDCHASERZ/i.test(wordmark || ''), `wordmark="${wordmark}" topbar="${scope.replace(/\n/g,' | ').slice(0,200)}"`)
check('store noun used in nav (Stores not Boutiques)', /Stores/i.test(bodyText) && !/Boutiques/i.test(bodyText), `nav: ${await page.locator('.views').innerText().then(t=>t.replace(/\n/g,' | ')).catch(()=>'')}`)

// -- 11 cards, HOU-WH excluded --
const codes = await page.locator('[data-testid="live-cards"] .bcard').evaluateAll((els) => els.map((e) => e.getAttribute('data-boutique')))
const count = await page.locator('.list .toolbar .count').textContent().catch(() => '')
check('11 store cards, HOU-WH excluded', !codes.includes('HOU-WH'), `${codes.length} rendered (virtualised); counter="${count?.trim()}" codes=${codes.join(',')}`)

// -- KPI strip values vs API --
const api = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.live_summary?nocache=1`)).json()
const T = api.message.totals
const kpi = await page.locator('.kpis').innerText()
check('KPI strip rendered', kpi.length > 20, kpi.replace(/\n/g, ' | ').slice(0, 400))
console.log('API totals:', JSON.stringify(T))

// -- ticker --
const tks = await page.locator('[data-testid="ticker"] .tk').count().catch(() => 0)
const tickerTxt = await page.locator('[data-testid="ticker"]').innerText().catch(() => '')
check('chain ticker has rows', tks > 0, `${tks} rows: ${tickerTxt.replace(/\n/g, ' · ').slice(0, 220)}`)

// -- region filter --
const regions = await page.locator('.list .toolbar .seg').first().locator('.btn').allTextContents()
check('region filter buttons present', regions.length >= 2, regions.join(' / '))
let regionOk = true, regionDetail = []
for (const r of regions.filter((x) => x !== 'All')) {
  await page.locator('.list .toolbar .seg').first().locator(`.btn:text-is("${r}")`).click()
  await page.waitForTimeout(350)
  const c = await page.locator('.list .toolbar .count').textContent()
  const shown = await page.locator('[data-testid="live-cards"] .bcard').evaluateAll((els) => els.map((e) => e.getAttribute('data-boutique')))
  const expected = api.message.by_boutique.filter((b) => b.region === r).map((b) => b.boutique)
  const ok = shown.every((s) => expected.includes(s)) && c.trim().startsWith(String(expected.length))
  if (!ok) regionOk = false
  regionDetail.push(`${r}: shown=[${shown}] expect=${expected.length} counter="${c.trim()}"`)
}
check('region filter narrows to the right stores', regionOk, regionDetail.join(' ; '))
await page.locator('.list .toolbar .seg').first().locator('.btn:text-is("All")').click()
await page.waitForTimeout(250)

// -- search --
await page.fill('.list .toolbar .search', 'sap')
await page.waitForTimeout(350)
const s1 = await page.locator('[data-testid="live-cards"] .bcard').evaluateAll((e) => e.map((x) => x.getAttribute('data-boutique')))
check('search by code narrows cards', s1.length === 1 && s1[0] === 'OK-SAP', s1.join(','))
await page.fill('.list .toolbar .search', 'montrose')
await page.waitForTimeout(350)
const s2 = await page.locator('[data-testid="live-cards"] .bcard').evaluateAll((e) => e.map((x) => x.getAttribute('data-boutique')))
check('search by store name narrows cards', s2.length === 1 && s2[0] === 'HOU-MTR', s2.join(','))
await page.fill('.list .toolbar .search', 'zzzz')
await page.waitForTimeout(350)
const s3 = await page.locator('[data-testid="live-cards"] .bcard').count()
const empty = await page.locator('.list').innerText()
check('search with no match shows empty state', s3 === 0, `cards=${s3}; text tail="${empty.split('\n').slice(-3).join(' | ')}"`)
await page.fill('.list .toolbar .search', '')
await page.waitForTimeout(250)

// -- sorting --
const sortBtns = await page.locator('.list .toolbar .seg').nth(1).locator('.btn').allTextContents()
const sortDetail = []
let sortOk = true
for (const s of sortBtns) {
  await page.locator('.list .toolbar .seg').nth(1).locator(`.btn:text-is("${s}")`).click()
  await page.waitForTimeout(400)
  const vals = await page.locator('[data-testid="live-cards"] .bcard').evaluateAll((els) => els.map((e) => ({
    b: e.getAttribute('data-boutique'),
    net: e.querySelector('.net')?.textContent, vs: e.querySelector('.vs')?.textContent, tk: e.querySelector('.tickets')?.textContent })))
  sortDetail.push(`${s}: ${vals.slice(0, 4).map((v) => `${v.b}=${v.net}/${v.vs}/${v.tk}`).join(' ')}`)
  const nums = vals.map((v) => Number(String(s === 'Net' ? v.net : s === 'Tickets' ? v.tk : v.vs).replace(/[^\d.-]/g, '').replace('−','-')) || 0)
  if (s === 'Net' || s === 'Tickets') { if (JSON.stringify(nums) !== JSON.stringify([...nums].sort((a, b) => b - a))) { sortOk = false; sortDetail.push(`  ^ ${s} NOT descending: ${nums}`) } }
}
check('sort buttons reorder cards correctly', sortOk, sortDetail.join(' ; '))
await page.locator('.list .toolbar .seg').nth(1).locator('.btn').first().click()
await page.waitForTimeout(300)

// -- offline/online status pills --
const pills = await page.locator('[data-testid="live-cards"] .bcard .st').allTextContents()
check('status pills rendered per card', pills.length > 0, [...new Set(pills.map((p) => p.trim()))].join(' / '))

// -- tiles: pending approvals / low stock / feedback --
const kpiText = kpi.replace(/\n/g, ' | ')
check('pending approvals / low stock / feedback tiles present', /approval/i.test(kpiText) && /low stock/i.test(kpiText) && /feedback/i.test(kpiText), kpiText.slice(0, 400))
await shot(page, '02-live-toolbar-1920.png')
check('no console errors on Live', console_.filter(c=>!/favicon/.test(c)).length === 0, console_.slice(0, 4).join(' | '))
save('results-e1.json')
await browser.close()
