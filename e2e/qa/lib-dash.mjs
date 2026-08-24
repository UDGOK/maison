import { chromium } from '../node_modules/playwright/index.mjs'
import { installBridge } from '../cloud-bridge.mjs'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const BASE = 'https://cloudchaserz.frappe.cloud'
export const SHOTS = '/home/claude/maison/e2e/qa/shots-dashboard'
mkdirSync(SHOTS, { recursive: true })
export const SID = readFileSync('/tmp/ccsid', 'utf8').trim()

export const results = []
export const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`)
  return ok
}
export const save = (file) => writeFileSync(path.join('/home/claude/maison/e2e/qa', file), JSON.stringify(results, null, 1))
export const money = (s) => Number(String(s).replace(/[^\d.-]/g, '').replace(/−/g, '-')) || 0

export async function launch({ viewport = { width: 1920, height: 1080 }, sid = SID } = {}) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport,
    storageState: sid ? { cookies: [{ name: 'sid', value: sid, domain: 'cloudchaserz.frappe.cloud', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }], origins: [] } : undefined,
  })
  await installBridge(ctx)
  const page = await ctx.newPage()
  const console_ = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console_.push(`${m.type()}: ${m.text()}`.slice(0, 300)) })
  page.on('pageerror', (e) => console_.push(`pageerror: ${String(e).slice(0, 300)}`))
  page.on('requestfailed', (r) => console_.push(`requestfailed: ${r.url().slice(0, 140)} ${r.failure()?.errorText}`))
  return { browser, ctx, page, console_ }
}
export const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: false })
