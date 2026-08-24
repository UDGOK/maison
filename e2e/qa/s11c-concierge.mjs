// QA4 · C — Concierge Q&A (client attached, empty basket) → Maison Client Profile.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Salon QA4A'
const PORTRAIT = { width: 1024, height: 1366 }
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const browser = await L.newBrowser()
const waitView = (page, view, ms = 25000) => page.waitForFunction((v) => document.documentElement.dataset.salonView === v, view, { timeout: ms })
const salonView = (page) => page.evaluate(() => document.documentElement.dataset.salonView)
const cust = await admin.value('Customer', MEMBER, ['maison_client_number'])
const before = await admin.doc('Maison Client Profile', MEMBER)

const pos = await L.ctxFor(browser, L.A1, 'pos', { viewport: { width: 1440, height: 1024 } })
const salon = await L.ctxFor(browser, null, 'salon', { viewport: PORTRAIT })
await L.unlock(pos.page, L.A1, { fresh: true })
const deviceId = await pos.page.evaluate(() => localStorage.getItem('maison.device_id') || '')
await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-settings]', { timeout: 20000 })
await pos.page.click('[data-testid=salon-pair]')
await pos.page.waitForSelector('[data-testid=salon-pair-code]', { timeout: 20000 })
const code = (await pos.page.locator('[data-testid=salon-pair-code]').textContent()).replace(/\D/g, '')
await go(salon.page, '/salon')
await salon.page.evaluate(() => localStorage.clear())
await go(salon.page, `/salon?code=${code}`)
await waitView(salon.page, 'ambient', 30000)
const st = (await assoc.get('maison_pos.api.salon.pos_status', { boutique: L.STORE, pos_device_id: deviceId })).session

// attach the client on the POS (no basket)
await L.nav(pos.page, 'Client')
await pos.page.waitForSelector('.client-view .toolbar input', { timeout: 25000 })
await pos.page.fill('.client-view .toolbar input', cust.maison_client_number)
await pos.page.waitForSelector('.client-view .crow', { timeout: 25000 })
await pos.page.locator('.client-view .crow').first().click()
await pos.page.click('.detail .actions button:has-text("Attach to sale")')
await pos.page.waitForSelector('.basket .client-name', { timeout: 20000 })
await waitView(salon.page, 'client', 25000).catch(() => {})
record('C · with a client attached and no basket the Salon shows the welcome screen', (await salonView(salon.page)) === 'client', await salonView(salon.page))

await L.nav(pos.page, 'Settings')
await pos.page.waitForSelector('[data-testid=salon-concierge-toggle]', { timeout: 20000 })
await pos.page.locator('[data-testid=salon-concierge-toggle]').check({ force: true }).catch(async () => pos.page.locator('[data-testid=salon-concierge-toggle]').click({ force: true }))
const conc = await waitView(salon.page, 'concierge', 25000).then(() => true).catch(() => false)
record('C · the associate can switch the Salon to Concierge', conc, `salon view = ${await salonView(salon.page)}`)
const steps = []
if (conc) {
  await shot(salon.page, 'salon-concierge')
  for (let i = 0; i < 10; i++) {
    steps.push(await salon.page.locator('[data-testid=salon-concierge]').getAttribute('data-step'))
    if (await salon.page.locator('[data-testid=concierge-finish]').count()) {
      await salon.page.locator('[data-testid^=style-]').first().click().catch(() => {})
      await salon.page.locator('[data-testid^=occasion-]').first().click().catch(() => {})
      await shot(salon.page, 'salon-concierge-last-step')
      await salon.page.click('[data-testid=concierge-finish]')
      break
    }
    await salon.page.locator('[data-testid^=metal-]').first().click().catch(() => {})
    const next = salon.page.locator('[data-testid=concierge-next]').first()
    if (!(await next.count())) break
    await next.click(); await sleep(800)
  }
  await sleep(4000)
  const saved = await salon.page.locator('[data-testid=concierge-saved]').count()
  const p = await admin.doc('Maison Client Profile', MEMBER)
  const changed = Object.keys(p).filter((k) => !k.startsWith('_') && JSON.stringify(p[k]) !== JSON.stringify(before[k]) && !['modified', 'modified_by'].includes(k))
  record('C · Concierge answers are written to the client profile', saved === 1 || changed.length > 0,
    `steps=${steps.join('→')} · saved-banner=${saved} · profile fields changed: ${JSON.stringify(changed.map((k) => [k, String(p[k]).slice(0, 60)]))}`)
  await shot(salon.page, 'salon-concierge-done')
}
// switch concierge back off and unpair
await L.nav(pos.page, 'Settings')
await pos.page.locator('[data-testid=salon-concierge-toggle]').uncheck({ force: true }).catch(() => {})
await sleep(1500)
await pos.page.click('[data-testid=salon-unpair]')
await sleep(2500)
record('C · Concierge can be switched off again', ['client', 'idle', 'ambient', 'pair'].includes(await salonView(salon.page)), await salonView(salon.page))
L.writeResults('results-s11c.json', { steps })
await pos.context.close(); await salon.context.close(); await browser.close()
