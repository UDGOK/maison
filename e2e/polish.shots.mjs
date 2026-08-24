/**
 * v0.6 R — polish pass: capture every screen a defect was reported on, at the width it was seen.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc.localhost:8001 node e2e/polish.shots.mjs
 *
 * POS / shop shots land in `frontend/screenshots/polish`, Command shots in
 * `dashboard/screenshots/polish`. Nothing here writes to the site: the one doctored case (a
 * returns-heavy day, which is what produced the "−62% / 157%" KPI) is faked by rewriting the
 * `live_summary` response in the browser, not by posting invoices.
 */
import { chromium, devices } from './node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = process.env.BASE || 'http://cc.localhost:8001'
const ADMIN = { usr: process.env.ADMIN_USER || 'Administrator', pwd: process.env.ADMIN_PWD || 'admin' }
const PWD = process.env.DEMO_PWD || 'cloud123'
const STORE = process.env.STORE || 'HOU-MTR'
const ASSOC = { usr: `hou.mtr.a1@cloudchaserz.example`, pwd: PWD, pin: '2580' }
const MGR = { usr: `hou.mtr.manager@cloudchaserz.example`, pwd: PWD, pin: '1101' }
const WH = { usr: 'warehouse@cloudchaserz.example', pwd: PWD }
const TAG = process.env.TAG || 'after'

const here = path.dirname(fileURLToPath(import.meta.url))
const POS_SHOTS = path.join(here, '..', 'frontend', 'screenshots', 'polish')
const DASH_SHOTS = path.join(here, '..', 'dashboard', 'screenshots', 'polish')
mkdirSync(POS_SHOTS, { recursive: true })
mkdirSync(DASH_SHOTS, { recursive: true })

const log = (...a) => console.log(...a)
const notes = []
const browser = await chromium.launch({ headless: true })

async function shot(page, dir, name) {
  const file = path.join(dir, `${name}-${TAG}.png`)
  await page.screenshot({ path: file })
  log('  shot', path.basename(file))
}

async function ctxFor(user, viewport, extra = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport, ...extra })
  const r = await ctx.request.post('/api/method/login', { data: { usr: user.usr, pwd: user.pwd } })
  if (!r.ok()) throw new Error(`${user.usr} login failed ${r.status()}`)
  return ctx
}

async function unlockPos(page, user, store) {
  await page.goto('/pos/unlock')
  await page.evaluate(() => localStorage.setItem('awanzE2E', '1'))
  await page.goto('/pos')
  await page.waitForSelector('.unlock select.input', { timeout: 30000 })
  await page.selectOption('.unlock select.input >> nth=0', store)
  const load = page.locator('.unlock button:has-text("Load")')
  if (await load.count()) await load.click()
  await page.waitForSelector('.keypad', { timeout: 60000 })
  await page.selectOption('.unlock select.input >> nth=1', user.usr)
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(200)
    if ((await page.inputValue('.unlock select.input >> nth=1')) === user.usr) break
    await page.selectOption('.unlock select.input >> nth=1', user.usr)
  }
  for (const d of String(user.pin)) await page.click(`.keypad button:text-is("${d}")`)
  await page.waitForSelector('.topbar', { timeout: 30000 })
}

// ---------------------------------------------------------------- 1/9/10 unlock screen
for (const vp of [
  { width: 1366, height: 1024 },
  { width: 1920, height: 1080 },
]) {
  const ctx = await ctxFor(ASSOC, vp)
  const p = await ctx.newPage()
  await p.goto('/pos/unlock')
  await p.waitForSelector('[data-testid=unlock-wordmark]', { timeout: 30000 })
  await p.waitForSelector('.unlock select.input', { timeout: 30000 })
  await p.waitForTimeout(400)
  await shot(p, POS_SHOTS, `01-unlock-preload-${vp.width}`)
  const m = await p.evaluate(() => {
    const sel = document.querySelector('.unlock select.input')
    const sub = document.querySelector('[data-testid=unlock-subline]')
    const de = document.documentElement
    const opt = sel.options[sel.selectedIndex]
    const probe = document.createElement('span')
    const cs = getComputedStyle(sel)
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`
    probe.textContent = opt.textContent.trim()
    document.body.appendChild(probe)
    const textW = probe.getBoundingClientRect().width
    probe.remove()
    return {
      subline: (sub?.textContent || '').trim(),
      option: opt.textContent.trim(),
      selWidth: Math.round(sel.getBoundingClientRect().width),
      textW: Math.round(textW),
      overflow: de.scrollWidth - de.clientWidth,
    }
  })
  notes.push([`unlock ${vp.width} pre-load`, JSON.stringify(m)])
  await unlockPos(p, ASSOC, STORE).catch(async (e) => {
    notes.push([`unlock ${vp.width}`, 'unlock failed: ' + e.message])
  })
  await p.goto('/pos/unlock')
  await p.waitForSelector('.keypad', { timeout: 30000 })
  await p.waitForTimeout(500)
  await shot(p, POS_SHOTS, `02-unlock-loaded-${vp.width}`)
  const box = await p.evaluate(() => {
    const b = document.querySelector('.shift .box')
    const r = b?.getBoundingClientRect()
    const cs = b ? getComputedStyle(b) : null
    return { w: Math.round(r?.width || 0), h: Math.round(r?.height || 0), border: cs?.borderTopWidth, color: cs?.borderTopColor }
  })
  notes.push([`unlock ${vp.width} clock-in box`, JSON.stringify(box)])
  await ctx.close()
}

// ---------------------------------------------------------------- 8 POS sell (department chips)
{
  const ctx = await ctxFor(ASSOC, { width: 1366, height: 1024 })
  const p = await ctx.newPage()
  await unlockPos(p, ASSOC, STORE)
  await p.waitForSelector('.tile', { timeout: 30000 })
  await p.waitForTimeout(600)
  await shot(p, POS_SHOTS, '03-pos-sell-1366')
  const chips = await p.evaluate(() => {
    const wrap = document.querySelector('.chips-wrap')
    const strip = document.querySelector('.chips')
    const last = [...document.querySelectorAll('.chips .chip')].pop()
    const sr = strip.getBoundingClientRect()
    const lr = last.getBoundingClientRect()
    return {
      classes: wrap.className,
      scrollable: strip.scrollWidth > strip.clientWidth,
      lastLabel: last.textContent.trim(),
      lastFullyVisible: lr.right <= sr.right + 1,
      navButtons: document.querySelectorAll('.chip-nav').length,
    }
  })
  notes.push(['pos dept chips 1366', JSON.stringify(chips)])
  // scroll to the end: the fade must flip sides
  await p.evaluate(() => {
    const s = document.querySelector('.chips')
    s.scrollLeft = s.scrollWidth
    s.dispatchEvent(new Event('scroll'))
  })
  await p.waitForTimeout(400)
  await shot(p, POS_SHOTS, '04-pos-sell-chips-scrolled-1366')
  notes.push(['pos dept chips scrolled', await p.evaluate(() => document.querySelector('.chips-wrap').className)])

  // 10 — age gate helper line
  const ageCode = await p.evaluate(async () => {
    const r = await fetch('/api/method/maison_pos.api.catalog.bootstrap?boutique=HOU-MTR', { headers: { Accept: 'application/json' } })
    const j = await r.json()
    return (j.message.items.find((i) => i.maison_age_restricted) || {}).item_code
  })
  if (ageCode) {
    await p.fill('.toolbar input[type=search]', ageCode)
    await p.waitForTimeout(500)
    await p.click('.tile >> nth=0')
    await p.waitForSelector('[data-testid=age-gate], .sheet, .modal', { timeout: 15000 }).catch(() => {})
    await p.waitForTimeout(600)
    await shot(p, POS_SHOTS, '05-age-gate-1366')
    const helper = await p.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => /Scan the PDF417/i.test(d.textContent) && d.children.length === 0)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(el)
      const lines = [...range.getClientRects()]
      return { text: el.textContent.trim().slice(-24), lines: lines.length, lastLineWidth: Math.round(lines[lines.length - 1]?.width || 0), width: Math.round(r.width) }
    })
    notes.push(['age-gate helper', JSON.stringify(helper)])
  }
  await ctx.close()
}

// ---------------------------------------------------------------- phone
{
  const ctx = await ctxFor(ASSOC, undefined, { ...devices['iPhone 13'] })
  const p = await ctx.newPage()
  await unlockPos(p, ASSOC, STORE)
  await p.waitForSelector('.tile', { timeout: 30000 })
  await p.waitForTimeout(600)
  await shot(p, POS_SHOTS, '06-pos-sell-390')
  await p.goto('/pos/unlock')
  await p.waitForSelector('.keypad', { timeout: 30000 })
  await p.waitForTimeout(400)
  await shot(p, POS_SHOTS, '07-unlock-390')
  notes.push(['phone overflow', await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)])
  await ctx.close()
}

// ---------------------------------------------------------------- 9 Receive
{
  const ctx = await ctxFor(MGR, { width: 1366, height: 1024 })
  const p = await ctx.newPage()
  await unlockPos(p, MGR, STORE)
  await p.goto('/pos/receive')
  await p.waitForSelector('[data-testid=inbound-shipments]', { timeout: 30000 })
  await p.waitForTimeout(800)
  await shot(p, POS_SHOTS, '08-receive-1366')
  const fill = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.cols .card')]
    const body = document.querySelector('.page-body')
    const br = body.getBoundingClientRect()
    const bottom = Math.max(...cards.map((c) => c.getBoundingClientRect().bottom))
    return { cards: cards.length, deadSpaceBelowCards: Math.round(br.bottom - bottom), viewport: window.innerHeight, stamp: (document.querySelector('.page-body .muted')?.textContent || '').trim() }
  })
  notes.push(['receive 1366', JSON.stringify(fill)])
  await ctx.close()
}

// ---------------------------------------------------------------- 7 warehouse wall
{
  const ctx = await ctxFor(WH, { width: 1920, height: 1080 })
  const p = await ctx.newPage()
  await p.goto('/warehouse-wall')
  await p.waitForSelector('[data-testid=warehouse-wall]', { timeout: 30000 })
  await p.waitForTimeout(1200)
  await shot(p, POS_SHOTS, '09-warehouse-wall-1920')
  const head = await p.evaluate(() => {
    const t = document.querySelector('[data-testid=sound-toggle]')
    const clock = document.querySelector('[data-testid=wall-clock]')
    const emoji = /\p{Extended_Pictographic}/u.test(document.querySelector('.wall-head').textContent)
    return { toggleHtml: t.innerHTML.trim().slice(0, 60), clock: clock?.textContent.trim(), emojiInHeader: emoji }
  })
  notes.push(['warehouse wall head', JSON.stringify(head)])
  await ctx.close()
}

// ---------------------------------------------------------------- 4/5/10 storefront + rewards
for (const vp of [
  { width: 1366, height: 1024 },
  { width: 390, height: 844 },
]) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: vp })
  const p = await ctx.newPage()
  await p.goto('/shop')
  await p.waitForSelector('.mw-hero', { timeout: 30000 })
  await p.waitForTimeout(600)
  await shot(p, POS_SHOTS, `10-shop-hero-${vp.width}`)
  const hero = await p.evaluate(() => {
    const art = document.querySelector('.mw-hero .art')
    const prices = [...document.querySelectorAll('.mw-price, .mw-card .price')].map((e) => e.textContent.trim())
    return {
      artSvgHasText: null,
      artImg: art?.querySelector('img')?.getAttribute('src') || null,
      tag: (art?.querySelector('.tag')?.textContent || '').replace(/\s+/g, ' ').trim(),
      pricesWithSpace: prices.filter((t) => /^\S\s+\d/.test(t)),
      samplePrices: prices.slice(0, 4),
    }
  })
  if (hero.artImg) {
    const svg = await (await ctx.request.get(hero.artImg)).text()
    hero.artSvgHasText = /<text/.test(svg)
  }
  notes.push([`shop ${vp.width}`, JSON.stringify(hero)])

  await p.goto('/rewards')
  await p.waitForSelector('.rw-join', { timeout: 30000 })
  await p.evaluate(() => document.querySelector('.rw-join').scrollIntoView({ block: 'center' }))
  await p.waitForTimeout(500)
  await shot(p, POS_SHOTS, `11-rewards-form-${vp.width}`)
  await p.check('#rw-consent')
  await p.check('#rw-consent-sms')
  await p.waitForTimeout(300)
  await shot(p, POS_SHOTS, `12-rewards-checked-${vp.width}`)
  const boxes = await p.evaluate(() => {
    const out = []
    for (const id of ['rw-consent-email', 'rw-consent-sms', 'rw-consent']) {
      const el = document.getElementById(id)
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      out.push({ id, w: Math.round(r.width), h: Math.round(r.height), checked: el.checked, bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor })
    }
    const footerStore = [...document.querySelectorAll('.mw-footer .col a')].find((a) => /Broken/.test(a.textContent))
    const rects = footerStore ? [...footerStore.getClientRects()] : []
    return { boxes: out, footer: footerStore?.textContent.replace(/\s+/g, ' ').trim(), footerLines: rects.length }
  })
  notes.push([`rewards ${vp.width}`, JSON.stringify(boxes)])
  if (vp.width === 1366) {
    await p.evaluate(() => document.querySelector('.mw-footer').scrollIntoView({ block: 'center' }))
    await p.waitForTimeout(400)
    await shot(p, POS_SHOTS, '13-shop-footer-1366')
  }
  await ctx.close()
}

// ---------------------------------------------------------------- 2/3/6 Command dashboard
for (const vp of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 1024 },
]) {
  const ctx = await ctxFor(ADMIN, vp)
  const p = await ctx.newPage()
  await p.goto('/awanz-dashboard')
  await p.waitForSelector('.kpis', { timeout: 40000 })
  await p.waitForTimeout(2500)
  await shot(p, DASH_SHOTS, `01-live-${vp.width}`)
  const strip = await p.evaluate(() => {
    const tiles = [...document.querySelectorAll('.kpi')]
    return tiles.map((t) => {
      const v = t.querySelector('.value')
      const r = v.getBoundingClientRect()
      const tr = t.getBoundingClientRect()
      return { label: t.querySelector('.label').textContent.trim(), value: v.textContent.replace(/\s+/g, ' ').trim(), bottom: Math.round(r.bottom), overflowRight: Math.round(r.right - tr.right) }
    })
  })
  notes.push([`dashboard kpis ${vp.width}`, JSON.stringify(strip)])
  const names = await p.evaluate(() => [...document.querySelectorAll('.bcard')].slice(0, 12).map((c) => ({ code: c.querySelector('.code').textContent.trim(), name: c.querySelector('.city').textContent.trim(), clipped: c.querySelector('.city').scrollWidth > c.querySelector('.city').clientWidth + 1 })))
  notes.push([`dashboard store names ${vp.width}`, JSON.stringify(names)])
  notes.push([`dashboard clock ${vp.width}`, await p.evaluate(() => document.querySelector('[data-testid=clock]')?.textContent.trim() + ' | ' + (document.querySelector('.stamp')?.textContent.trim() || ''))])

  // Products tab — precompute stamp
  await p.click('[data-view=products]')
  await p.waitForSelector('.products', { timeout: 30000 })
  await p.waitForTimeout(1500)
  await shot(p, DASH_SHOTS, `02-products-${vp.width}`)
  notes.push([`dashboard precompute stamp ${vp.width}`, await p.evaluate(() => document.querySelector('.products .meta')?.textContent.trim() || '')])
  await ctx.close()
}

// ------------------------------------------- the returns-heavy day that produced "−62% / 157%"
{
  const ctx = await ctxFor(ADMIN, { width: 1920, height: 1080 })
  const p = await ctx.newPage()
  await p.route('**/api/method/maison_pos.api.dashboard.live_summary*', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const m = body.message
    // one store refunds a big card sale, another takes cash: net stays positive, card goes negative
    if (m?.by_boutique?.length) {
      m.by_boutique[0].card = -317
      m.by_boutique[0].cash = 804
      m.by_boutique[0].net = 513
      m.by_boutique[0].invoices = 25
      m.by_boutique[0].returns = 18
      for (const b of m.by_boutique.slice(1)) {
        b.card = 0
        b.cash = 0
      }
      m.totals.card = -317
      m.totals.cash = 804
      m.totals.net = 513
      m.totals.avg_ticket = 20.52
    }
    await route.fulfill({ response: res, json: body })
  })
  await p.goto('/awanz-dashboard')
  await p.waitForSelector('.kpis', { timeout: 40000 })
  await p.waitForTimeout(2500)
  await shot(p, DASH_SHOTS, '03-live-returns-day-1920')
  const strip = await p.evaluate(() => {
    const tiles = [...document.querySelectorAll('.kpi')]
    const cardCash = document.querySelector('[data-testid=card-cash]')
    const tile = cardCash.closest('.kpi')
    const next = tile.nextElementSibling
    return {
      cardCash: cardCash.textContent.replace(/\s+/g, ' ').trim(),
      spillsIntoNeighbour: Math.round(cardCash.getBoundingClientRect().right) > Math.round(next.getBoundingClientRect().left),
      valueBottoms: tiles.map((t) => Math.round(t.querySelector('.value').getBoundingClientRect().bottom)),
    }
  })
  notes.push(['dashboard returns-day KPI', JSON.stringify(strip)])
  await ctx.close()
}

await browser.close()
log('\n--- measurements ---')
for (const [k, v] of notes) log(`${k}: ${v}`)
