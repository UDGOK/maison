// QA4 · A — guest tail: cart gate, listing truncation, mobile 390x844.
import * as L from './lib-srs.mjs'
const { record, note, shot, go, overflow, log } = L
const guest = await L.guestApi()
const browser = await L.newBrowser()
const cat = await guest.get('maison_pos.api.webshop.catalogue', { limit: 500 })
const BUY = cat.items.find((i) => i.item_code === 'ACC-007')
const AGE = cat.items.find((i) => i.item_code === 'DSP-001')
const { context, page } = await L.ctxFor(browser, null, 'guest')

// guest cart gate — check the redirect at HTTP level (bridge chokes on the /login asset bundle)
const r = await guest.ctx.get('/cart', { maxRedirects: 0 })
record('guest /cart redirects to sign-in', r.status() === 301 && /\/login\?redirect-to=\/cart/.test(r.headers()['location'] || ''), `${r.status()} → ${r.headers()['location']}`)

// listing truncation
await go(page, '/shop/collection')
const shown = await page.locator('.mw-card').count()
const pager = await page.locator('.mw-pager, [rel=next], a:has-text("Next"), button:has-text("Load more"), .mw-more').count()
record('A · /shop/collection shows the whole catalogue (or paginates)', shown >= cat.count || pager > 0, `${shown} of ${cat.count} published products shown, pagination controls=${pager}`, shown < cat.count && pager === 0 ? 'minor' : '')

// mobile 390x844
await page.setViewportSize({ width: 390, height: 844 })
const mobile = []
for (const [name, url] of [['home', '/shop'], ['collection', '/shop/collection'], ['item-buy', BUY.route], ['item-age', AGE.route], ['boutiques', '/shop/boutiques'], ['rewards', '/rewards'], ['account', '/shop/account']]) {
  await go(page, url)
  await page.waitForTimeout(600)
  const ov = await overflow(page)
  mobile.push(`${name}:${ov}`)
  await shot(page, `m-${name}-390`, true)
}
record('A · mobile 390x844: no horizontal overflow on the shop pages', mobile.every((m) => Number(m.split(':')[1]) <= 0), mobile.join(' '), mobile.every((m) => Number(m.split(':')[1]) <= 0) ? '' : 'minor')
// tap targets on phone
await go(page, BUY.route)
const small = await page.$$eval('.mw-cta button, .mw-cta a.mw-btn', (b) => b.map((e) => ({ t: e.textContent.trim().slice(0, 24), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 44))
record('A · mobile CTA buttons are ≥44 px tall', small.length === 0, small.length ? JSON.stringify(small) : 'all ok')

await context.close(); await browser.close()
L.writeResults('results-s1b.json')
