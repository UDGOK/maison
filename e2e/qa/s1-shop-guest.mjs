// QA4 · A — web shop as a guest: home, collection, filters, search, product pages, age gate, mobile.
import * as L from './lib-srs.mjs'
const { record, note, shot, go, overflow, log } = L

const admin = await L.adminApi()
const guest = await L.guestApi()
const browser = await L.newBrowser()

// pick fixtures from the live catalogue
const cat = await guest.get('maison_pos.api.webshop.catalogue', { limit: 200 })
const buy = cat.items.filter((i) => i.web_mode === 'Buy' && !i.in_store_only)
const restricted = cat.items.filter((i) => i.in_store_only)
const BUY = buy.find((i) => i.item_code === 'ACC-007') || buy[0]
const AGE = restricted.find((i) => i.item_code === 'DSP-001') || restricted[0]
log(`fixtures: BUY=${BUY.item_code} ${BUY.item_name} ${BUY.route} · AGE=${AGE.item_code} ${AGE.item_name} ${AGE.route}`)
record('guest catalogue API returns items + groups', cat.items.length > 100 && cat.item_groups.length > 3, `${cat.items.length} items, ${cat.item_groups.length} groups, ${buy.length} buyable, ${restricted.length} in-store-only`)

const set = await admin.doc('Maison POS Settings')
record('webshop_age_restricted_sales is OFF (precondition)', !Number(set.webshop_age_restricted_sales), `webshop_age_restricted_sales=${set.webshop_age_restricted_sales} minimum_age=${set.minimum_age}`)

const { context, page } = await L.ctxFor(browser, null, 'guest')

// ---- home
await go(page, '/shop')
const heroH1 = (await page.locator('.mw-hero h1').first().textContent().catch(() => '')).replace(/\s+/g, ' ').trim()
const cards = await page.locator('.mw-card').count()
const cats = await page.locator('.mw-collections a').count()
record('/shop home renders (hero, categories, featured)', /Order online|Pick up in store/i.test(heroH1) && cards >= 6, `hero="${heroH1}" cards=${cards} collection-tiles=${cats}`)
const storeNames = await page.$$eval('.mw-section:has-text("Where to find us") .mw-collections a', (a) => a.map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)))
record('home lists stores ("Where to find us")', storeNames.length >= 4, `${storeNames.length}: ${storeNames.slice(0, 3).join(' | ')}`)
await shot(page, 'shop-home-1440', true)

// ---- collection + filters
await go(page, '/shop/collection')
const all = await page.locator('.mw-card').count()
record('/shop/collection lists the catalogue', all >= 20, `${all} cards`)
const groups = await page.$$eval('.mw-filters .mw-chip', (c) => c.map((e) => e.textContent.trim()))
await go(page, '/shop/collection?item_group=Accessories')
const accCards = await page.locator('.mw-card').count()
const accGroups = await page.$$eval('.mw-card .group', (g) => [...new Set(g.map((e) => e.textContent.trim()))])
record('collection filters by category', accCards > 0 && accCards < all && accGroups.length === 1 && accGroups[0] === 'Accessories', `${accCards}/${all} cards, groups=${accGroups.join(',')}`)
await shot(page, 'shop-collection-accessories', true)

await go(page, '/shop/collection?q=grinder')
const qCards = await page.$$eval('.mw-card .name', (n) => n.map((e) => e.textContent.trim()))
record('collection search finds matching products', qCards.length > 0 && qCards.every((n) => /grinder/i.test(n)), `${qCards.length}: ${qCards.slice(0, 3).join(' | ')}`)
await go(page, '/shop/collection?q=zzzznotathing')
record('collection search with no hits shows the empty state', (await page.locator('.mw-empty').count()) === 1 && (await page.locator('.mw-card').count()) === 0)
await go(page, '/shop/collection?mode=Buy')
const modeLabels = await page.$$eval('.mw-card .mode', (m) => [...new Set(m.map((e) => e.textContent.trim()))])
const modeCards = await page.locator('.mw-card').count()
record('collection filters by mode=Buy (only purchasable)', modeCards > 0 && !modeLabels.some((m) => /In store|Enquire/i.test(m)), `${modeCards} cards, modes=${modeLabels.join(' | ')}`)
await go(page, '/all-products')
record('/all-products serves the Maison listing', (await page.locator('.mw-grid .mw-card').count()) > 10, `${await page.locator('.mw-grid .mw-card').count()} cards`)

// ---- product page: buyable
await go(page, BUY.route)
const addBtn = page.locator('#mw-add')
record('buyable product page shows "Add to bag"', (await addBtn.count()) === 1 && !(await addBtn.isDisabled()), `${BUY.item_code} ${BUY.item_name}`)
const avail = await page.locator('#mw-avail li').count()
record('product page shows availability per store', avail >= 5, `${avail} store rows`)
await shot(page, 'shop-item-buy', true)

// ---- product page: age restricted (must NOT be purchasable)
await go(page, AGE.route)
const bodyTxt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const inStoreCta = await page.locator('.mw-cta a.mw-btn:has-text("Available in store")').count()
const addCount = await page.locator('#mw-add').count()
const reserveCount = await page.locator('[data-mw-sheet=mw-reserve]').count()
record('A · age-restricted item is NOT purchasable online', addCount === 0 && reserveCount === 0, `${AGE.item_code} ${AGE.item_name} — add-to-bag buttons=${addCount}, reserve=${reserveCount}`)
record('A · age-restricted item says "Available in store"', inStoreCta === 1 && /sold in store only/i.test(bodyTxt), `cta=${inStoreCta} · note="${(await page.locator('[data-testid=in-store-only]').textContent().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120)}"`)
record('A · age-restricted item shows the 21+ / ID spec', /21\+/.test(bodyTxt), bodyTxt.match(/Age\s*21\+[^A-Z]{0,20}/)?.[0] || 'n/a')
await shot(page, 'shop-item-age-restricted', true)
const cardPill = await go(page, `/shop/collection?item_group=${encodeURIComponent(AGE.item_group)}`).then(async () => ({
  pills: await page.locator('.mw-card .mw-pill.flag').count(),
  modes: await page.$$eval('.mw-card .mode', (m) => [...new Set(m.map((e) => e.textContent.trim()))])
}))
record('A · listing marks age-restricted cards "21+ / In store · 21+"', cardPill.pills > 0 && cardPill.modes.some((m) => /In store/i.test(m)), `pills=${cardPill.pills} modes=${cardPill.modes.join(' | ')}`)

// guest API view of the same item
const av = await guest.get('maison_pos.api.webshop.availability', { item_code: AGE.item_code })
record('A · availability API reports in_store_only + Enquire mode', av.in_store_only === true && av.web_mode === 'Enquire', JSON.stringify({ mode: av.web_mode, in_store_only: av.in_store_only, chain_qty: av.chain_qty }))

// ---- boutiques page
await go(page, '/shop/boutiques')
const bcount = await page.locator('.mw-boutique-card, .mw-card, .mw-panel').count()
record('/shop/boutiques lists the stores', /Broken Arrow|Tulsa|Houston/i.test(await page.locator('body').innerText()), `${bcount} blocks`)
await shot(page, 'shop-boutiques', true)

// ---- guest cart is gated
await go(page, '/cart')
record('guest /cart requires sign-in', /sign in|log in|login/i.test(await page.locator('body').innerText()) || page.url().includes('/login'), page.url())
await shot(page, 'shop-cart-guest')

// ---- mobile 390x844
await page.setViewportSize({ width: 390, height: 844 })
const mobile = []
for (const [name, url] of [['home', '/shop'], ['collection', '/shop/collection'], ['item-buy', BUY.route], ['item-age', AGE.route], ['boutiques', '/shop/boutiques'], ['rewards', '/rewards'], ['account', '/shop/account']]) {
  await go(page, url)
  await page.waitForTimeout(500)
  const ov = await overflow(page)
  mobile.push(`${name}:${ov}`)
  await shot(page, `m-${name}-390`, true)
}
record('A · mobile 390x844: no horizontal overflow on any shop page', mobile.every((m) => Number(m.split(':')[1]) <= 0), mobile.join(' '))

await context.close()
await browser.close()
L.writeResults('results-s1.json', { fixtures: { BUY: BUY.item_code, AGE: AGE.item_code, buyRoute: BUY.route, ageRoute: AGE.route } })
