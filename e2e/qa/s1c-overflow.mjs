import * as L from './lib-srs.mjs'
const browser = await L.newBrowser()
const { context, page } = await L.ctxFor(browser, null, 'guest', { viewport: { width: 390, height: 844 } })
await L.go(page, '/accessories/aluminum-4-pc-grinder-25-keqpx')
await page.waitForTimeout(800)
const bad = await page.evaluate(() => {
  const out = []
  const vw = document.documentElement.clientWidth
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > vw + 1) out.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60), id: el.id, right: Math.round(r.right), w: Math.round(r.width), txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) })
  })
  return { vw, scrollW: document.documentElement.scrollWidth, out: out.slice(0, 25) }
})
console.log(JSON.stringify(bad, null, 1))
// visible-only tap targets
const small = await page.$$eval('.mw-cta button, .mw-cta a.mw-btn', (b) => b.filter((e) => e.offsetParent !== null).map((e) => ({ t: e.textContent.trim().slice(0, 24), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h < 44))
console.log('small visible CTAs:', JSON.stringify(small))
await L.shot(page, 'm-item-overflow-390', true)
await context.close(); await browser.close()
