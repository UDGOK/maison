import { launch, check, save, shot, BASE } from './lib-dash.mjs'
const { browser, page, console_ } = await launch()
await page.goto(`${BASE}/maison-dashboard?view=boutiques`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="boutiques-table"] .row.data', { timeout: 45000 })
await page.waitForTimeout(1000)
const hdrs = await page.locator('.hdr .th').evaluateAll((e) => e.map((x) => ({ s: x.getAttribute('data-sort'), t: x.textContent.trim() })))
check('sortable column headers present', hdrs.filter((h) => h.s).length >= 8, `${hdrs.filter(h=>h.s).length} sortable of ${hdrs.length}: ` + hdrs.map((h) => `${h.t}${h.s ? '['+h.s+']' : ''}`).join(' | '))
const api = await (await page.request.get(`${BASE}/api/method/maison_pos.api.dashboard.boutiques_table`)).json()
const rows = api.message.rows
const onScreen = () => page.locator('[data-testid="boutiques-table"] .row.data').evaluateAll((e) => e.map((x) => x.getAttribute('data-boutique')))
const sd = []; let sortOk = true
for (const h of hdrs.filter((x) => x.s)) {
  const k = h.s
  const numeric = rows.some((r) => typeof r[k] === 'number')
  const expectBy = (dir) => [...rows].sort((a, b) => {
    const av = a[k], bv = b[k]
    if (numeric) return (((av ?? -Infinity) - (bv ?? -Infinity)) * dir) || a.boutique.localeCompare(b.boutique)
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir || a.boutique.localeCompare(b.boutique)
  }).map((r) => r.boutique)
  await page.locator(`.hdr .th[data-sort="${k}"]`).click(); await page.waitForTimeout(280)
  const g1 = await onScreen()
  await page.locator(`.hdr .th[data-sort="${k}"]`).click(); await page.waitForTimeout(280)
  const g2 = await onScreen()
  const d1 = JSON.stringify(g1) === JSON.stringify(expectBy(-1))
  const a1 = JSON.stringify(g2) === JSON.stringify(expectBy(1))
  const flip = JSON.stringify(g1) === JSON.stringify([...g2].reverse())
  const ok = (d1 && a1) || flip
  if (!ok) { sortOk = false; sd.push(`${k}: desc-match=${d1} asc-match=${a1} reversal=${flip} got1=${g1.slice(0,4)} want1=${expectBy(-1).slice(0,4)}`) }
  else sd.push(`${k}:ok`)
}
check('every sortable column sorts correctly (desc + asc toggle)', sortOk, sd.join(' ; ').slice(0, 900))
await shot(page, '07-stores-sorted-1920.png')
check('no console errors', console_.filter(c=>!/favicon/.test(c)).length === 0, console_.slice(0,4).join(' | '))
save('results-e2b.json')
await browser.close()
