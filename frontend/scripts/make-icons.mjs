// Generate PWA icons (gold "M" on onyx) by rasterising an SVG with Playwright — no native deps.
import { chromium } from '../../e2e/node_modules/playwright/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const out = resolve('public/icons')
mkdirSync(out, { recursive: true })

function svg(size, pad = 0.18) {
  const inner = size * (1 - pad * 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0B0B0A"/>
  <rect x="${size * pad}" y="${size * pad}" width="${inner}" height="${inner}" fill="none" stroke="#C9A96E" stroke-width="${size * 0.018}" opacity=".55"/>
  <text x="50%" y="50%" dy=".36em" text-anchor="middle" font-family="'Unbounded','Arial Black',Arial,sans-serif" font-weight="900" font-size="${size * 0.5}" fill="#C9A96E">M</text>
</svg>`
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })
await page.setContent(`<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@900&display=swap" rel="stylesheet"><body style="margin:0;background:#0B0B0A"></body>`)
await page.waitForTimeout(1500)
for (const [file, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  await page.setViewportSize({ width: size, height: size })
  await page.evaluate((s) => (document.body.innerHTML = s), svg(size))
  await page.evaluate(() => document.fonts.ready)
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false })
  writeFileSync(resolve(out, file), buf)
  console.log('wrote', file, size)
}
writeFileSync(resolve(out, 'icon.svg'), svg(512))
await browser.close()
