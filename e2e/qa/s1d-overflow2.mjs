import * as L from './lib-srs.mjs'
const browser = await L.newBrowser()
const { context, page } = await L.ctxFor(browser, null, 'guest', { viewport: { width: 390, height: 844 } })
await L.go(page, '/accessories/aluminum-4-pc-grinder-25-keqpx')
await page.waitForTimeout(800)
const info = await page.evaluate(() => {
  const chain = []
  let el = document.querySelector('.mw-item .gallery')
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el)
    chain.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50), w: Math.round(el.getBoundingClientRect().width), minW: cs.minWidth, display: cs.display, gtc: cs.gridTemplateColumns.slice(0, 60) })
    el = el.parentElement
  }
  return { vw: document.documentElement.clientWidth, chain, mq900: window.matchMedia('(max-width: 900px)').matches, bodyW: Math.round(document.body.getBoundingClientRect().width) }
})
console.log(JSON.stringify(info, null, 1))
await context.close(); await browser.close()
