import { launch, check, save, shot, money, BASE } from './lib-dash.mjs'
const { browser, page, console_ } = await launch()
const t0 = Date.now()
await page.goto(`${BASE}/maison-dashboard?view=products`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="trending"] .row[data-item]', { timeout: 45000 })
const tProd = Date.now() - t0
await page.waitForTimeout(800)
const meta = (await page.locator('.products .toolbar .meta').textContent()).trim()
const loadMs = Number(meta.match(/loaded in (\d+) ms/)?.[1] ?? -1)
check('Products tab loads', true, `${tProd} ms page → first row; toolbar: "${meta}"`)
check('Products tab in-browser load < 300 ms', loadMs >= 0 && loadMs < 300, `${loadMs} ms`)

// -- "data as of" stamp correctness --
const lr = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.product_trends?period=7d&limit=5`)).json()
const computedAt = lr.message.last_run?.computed_at
check('"Data as of" stamp present', /Data as of/.test(meta), meta)
const stampTime = meta.match(/Data as of ([^·]+)/)?.[1]?.trim()
check('"Data as of" stamp matches last_run.computed_at', !!computedAt && !!stampTime,
  `stamp="${stampTime}" last_run.computed_at=${computedAt} table computed_at=${lr.message.computed_at}`)

const rows = await page.locator('[data-testid="trending"] .row[data-item]').count()
check('Trending renders rows from the precomputed table', rows >= 10, `${rows} rows; total=${lr.message.total}`)
const badges = await page.locator('[data-testid="trending"] .badge').allTextContents()
const set = [...new Set(badges.map((b) => b.trim()))]
check('trend badges Trending up / New / Cooling present', set.some((b) => /trending up/i.test(b)) && set.some((b) => /new/i.test(b)) && set.some((b) => /cooling/i.test(b)), set.join(', '))
await shot(page, '09-products-trending-1920.png')

// badge filters
for (const b of ['Trending up', 'New', 'Cooling']) {
  await page.locator(`.products .toolbar .btn:has-text("${b} ·")`).click()
  await page.waitForTimeout(700)
  const got = await page.locator('[data-testid="trending"] .badge').allTextContents()
  check(`badge filter "${b}" shows only that badge`, got.length > 0 && got.every((g) => g.trim().toLowerCase() === b.toLowerCase()), `${got.length} rows, distinct=${[...new Set(got.map(g=>g.trim()))].join('/')}`)
  await page.locator(`.products .toolbar .btn:has-text("${b} ·")`).click()
  await page.waitForTimeout(500)
}
// group filter
const groups = await page.locator('.products .toolbar select').first().locator('option').allTextContents()
check('group filter offers item groups', groups.length > 3, groups.join(' / '))
const g = groups.find((x) => /Hookah/i.test(x)) || groups[1]
await page.selectOption('.products .toolbar select', { label: g })
await page.waitForTimeout(900)
const codes = await page.locator('[data-testid="trending"] .row[data-item]').evaluateAll((e) => e.map((x) => x.getAttribute('data-item')))
const apiG = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.product_trends?period=7d&limit=500&group=${encodeURIComponent(g)}`)).json()
const want = apiG.message.rows.map((r) => r.item_code)
check(`group filter "${g}" narrows to that group only`, codes.length > 0 && codes.every((c) => want.includes(c)) && codes.length === Math.min(want.length, 60),
  `${codes.length} shown, API has ${apiG.message.total}; sample=${codes.slice(0, 4).join(',')}`)
await page.selectOption('.products .toolbar select', { label: groups[0] })
await page.waitForTimeout(700)

// 28d period
await page.locator('.products .toolbar .btn.ghost:text-is("28d")').click()
await page.waitForTimeout(900)
const rows28 = await page.locator('[data-testid="trending"] .row[data-item]').count()
const api28 = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.product_trends?period=28d&limit=60`)).json()
check('28d period switches the data', rows28 > 0 && api28.message.rows.length === rows28, `${rows28} rows vs API ${api28.message.rows.length} (total ${api28.message.total})`)
await page.locator('.products .toolbar .btn.ghost:text-is("7d")').click()
await page.waitForTimeout(700)

// verify a row's numbers against the API
const first = await page.locator('[data-testid="trending"] .row[data-item]').first().innerText()
const firstCode = await page.locator('[data-testid="trending"] .row[data-item]').first().getAttribute('data-item')
const apiRow = lr.message.rows.find((r) => r.item_code === firstCode) || (await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.product_trends?period=7d&limit=500`)).json()).message.rows.find((r) => r.item_code === firstCode)
check('trending row numbers match the API row', !!apiRow, `${firstCode}: UI="${first.replace(/\n/g, ' | ')}" | API units=${apiRow?.units} prev=${apiRow?.units_prev} delta=${apiRow?.delta_pct} ST=${apiRow?.sell_through} DOH=${apiRow?.days_on_hand} stores=${apiRow?.store_count}`)

// ---- Top by store ----
await page.click('.products .toolbar .btn[data-sub="top"]')
await page.waitForSelector('[data-testid="top-by-store"] .col .li', { timeout: 30000 })
await page.waitForTimeout(900)
const cols = await page.locator('[data-testid="top-by-store"] .col').count()
const cells = await page.locator('.matrix .cell').count()
check('Top by store: one column per store + matrix', cols === 11 && cells > 0, `${cols} store columns, ${cells} matrix cells`)
const colCodes = await page.locator('[data-testid="top-by-store"] .col').evaluateAll((e) => e.map((x) => x.getAttribute('data-boutique')))
check('Top by store excludes HOU-WH', !colCodes.includes('HOU-WH'), colCodes.join(','))
await shot(page, '10-products-top-net-1920.png')
const tpNet = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.top_products?boutique=all&by=net&period=7d&n=10`)).json()
const uiNet = await page.locator('[data-testid="top-by-store"] .col[data-boutique="HOU-MTR"] .li').allTextContents()
const apiNetCodes = tpNet.message.top['HOU-MTR'].map((r) => r.item_name || r.item_code)
check('by-net list for HOU-MTR matches the API order', uiNet.length === apiNetCodes.length && apiNetCodes.every((n, i) => uiNet[i].includes(n.slice(0, 12))),
  `UI[0..2]=${uiNet.slice(0, 3).map((s) => s.replace(/\n/g, ' ')).join(' ; ')} | API=${apiNetCodes.slice(0, 3).join(' ; ')}`)
await page.locator('.products .toolbar .btn.ghost:text-is("By units")').click()
await page.waitForTimeout(900)
const uiUnits = await page.locator('[data-testid="top-by-store"] .col[data-boutique="HOU-MTR"] .li').allTextContents()
const tpU = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.top_products?boutique=all&by=units&period=7d&n=10`)).json()
const apiUCodes = tpU.message.top['HOU-MTR'].map((r) => r.item_name || r.item_code)
check('by-units list for HOU-MTR matches the API order', uiUnits.length === apiUCodes.length && apiUCodes.every((n, i) => uiUnits[i].includes(n.slice(0, 12))),
  `UI[0..2]=${uiUnits.slice(0, 3).map((s) => s.replace(/\n/g, ' ')).join(' ; ')} | API=${apiUCodes.slice(0, 3).join(' ; ')}`)
await shot(page, '11-products-top-units-1920.png')
// single-store selector
await page.selectOption('.products .toolbar select', 'OK-SAP')
await page.waitForTimeout(900)
const cols1 = await page.locator('[data-testid="top-by-store"] .col').evaluateAll((e) => e.map((x) => x.getAttribute('data-boutique')))
check('store selector narrows Top-by-store to one store', cols1.length === 1 && cols1[0] === 'OK-SAP', cols1.join(','))
await shot(page, '12-products-top-one-store-1920.png')
check('no console errors on Products', console_.filter(c=>!/favicon/.test(c)).length === 0, console_.slice(0, 5).join(' | '))
save('results-e4.json')
await browser.close()
