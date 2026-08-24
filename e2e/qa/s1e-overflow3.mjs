import * as L from './lib-srs.mjs'
const browser = await L.newBrowser()
const { context, page } = await L.ctxFor(browser, null, 'guest', { viewport: { width: 390, height: 844 } })
await L.go(page, '/accessories/aluminum-4-pc-grinder-25-keqpx')
await page.waitForTimeout(800)
const res = await page.evaluate(() => {
  const item = document.querySelector('.mw-item')
  const track = () => parseFloat(getComputedStyle(item).gridTemplateColumns)
  const base = track()
  const out = { base, culprits: [] }
  const walk = (root) => {
    for (const child of [...root.children]) {
      const prev = child.style.display
      child.style.display = 'none'
      const now = track()
      child.style.display = prev
      if (base - now > 20) {
        out.culprits.push({ sel: child.tagName.toLowerCase() + '.' + (child.className || '').toString().split(' ')[0], drop: Math.round(base - now), after: Math.round(now), txt: (child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) })
        walk(child)
      }
    }
  }
  walk(document.querySelector('.mw-item .info') || item)
  walk(document.querySelector('.mw-item .gallery'))
  return out
})
console.log(JSON.stringify(res, null, 1))
await context.close(); await browser.close()
