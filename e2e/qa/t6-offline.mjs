import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const { record, note, shot, money, sleep } = L
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))

const admin = await L.adminApi()
const browser = await L.newBrowser()
const { context, page, offline } = await L.posContext(browser, L.A1, 'pos')
const created = []
const lineCount = () => page.locator('.basket .line').count()
async function pick(code, times = 1) {
  if (!/\/sell/.test(page.url())) { await page.click('.nav-btn[title=Sell]'); await page.waitForSelector('.tile', { timeout: 20000 }) }
  await page.locator('.sell .search input').fill(code)
  await page.waitForTimeout(500)
  for (let i = 0; i < times; i++) { await page.locator('.tile:not(.empty)').first().click(); await page.waitForTimeout(250) }
  await page.locator('.sell .search input').fill('')
}
const goOffline = async () => { offline.v = true; await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await sleep(900) }
const goOnline = async () => { offline.v = false; await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(900) }

try {
  await L.unlock(page, L.A1, { fresh: true })

  // ---- 6.0 service worker
  await page.waitForFunction(async () => {
    const regs = await navigator.serviceWorker.getRegistrations()
    return regs.some((r) => r.active && r.active.state === 'activated')
  }, null, { timeout: 40000 }).catch(() => {})
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.topbar', { timeout: 30000 })
  await sleep(2500)
  const sw = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations()
    const keys = await caches.keys()
    const counts = {}
    for (const k of keys) counts[k] = (await (await caches.open(k)).keys()).length
    return { regs: regs.map((r) => ({ scope: r.scope, state: r.active?.state })), controller: navigator.serviceWorker.controller?.scriptURL || null, caches: counts }
  })
  record('6.0 service worker registered and controls /pos', sw.regs.length >= 1 && !!sw.controller, JSON.stringify(sw))

  // ---- 6.1 go offline mid-basket
  await pick('ACC-002')  // 1.79
  await goOffline()
  const badge = (await page.locator('.topbar').innerText()).replace(/\s+/g, ' ')
  await pick('ACC-015')  // 6.99 — added while offline, from the cached catalogue
  const linesOff = await lineCount()
  record('6.1 the till keeps selling after the network drops', linesOff === 2 && /OFFLINE|NO NETWORK/i.test(badge),
    `top bar="${badge.slice(0, 120)}" lines=${linesOff}`)
  await shot(page, 'offline-basket')

  // ---- 6.1b complete a cash sale offline
  const gOff = money(await page.locator('.basket .total-amt').textContent())
  await L.payCash(page, 20)
  const pill = (await page.locator('.receipt-view .pill').first().textContent()).trim()
  const uuidOff = page.url().split('/receipt/')[1]
  record('6.1b a cash sale completes offline and is queued', /Queued/i.test(pill), `pill="${pill}" total=${gOff} uuid=${uuidOff}`)
  await shot(page, 'offline-receipt')
  const qrCard = (await page.locator('.receipt-view .link-card').innerText()).replace(/\s+/g, ' ')
  record('6.1c the offline receipt explains the missing QR instead of showing a broken link', /Available once the sale has synced/i.test(qrCard), qrCard.slice(0, 160))

  // ---- 6.2 queue shows it
  await page.click('.nav-btn[title=Queue]')
  await page.waitForSelector('.page-title', { timeout: 15000 })
  const qTxt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('6.2 the queue lists the pending sale', /1 pending/i.test(qTxt), qTxt.slice(0, 200))
  await shot(page, 'offline-queue')

  // ---- 6.3 reload the page while offline
  let navErr = null
  try { await page.goto('/pos/sell', { waitUntil: 'load', timeout: 30000 }) } catch (e) { navErr = String(e.message).split('\n')[0] }
  await sleep(3000)
  const st = await page.evaluate(() => ({
    url: location.href, title: document.title,
    hasApp: !!document.querySelector('#app, .unlock, .topbar, .sell'),
    unlock: !!document.querySelector('.unlock'), topbar: !!document.querySelector('.topbar'),
    body: document.body.innerText.slice(0, 200).replace(/\s+/g, ' '),
    chromeErr: /chrome-error|ERR_/.test(location.href) || /can.t be reached|No internet/i.test(document.body.innerText)
  }))
  record('6.3 reloading the page while offline still renders the app shell', !navErr && st.hasApp && !st.chromeErr, `navErr=${navErr}; ${JSON.stringify(st)}`)
  await shot(page, 'offline-reload')
  // unlock again offline (cached PIN digest)
  if (st.unlock) {
    await page.waitForSelector('.keypad', { timeout: 20000 }).catch(() => {})
    if (await page.locator('.keypad').count()) {
      await L.pickAssociate(page, L.A1).catch(() => {})
      await L.typePin(page, L.A1.pin)
      await page.waitForSelector('.topbar', { timeout: 20000 }).catch(() => {})
    }
    record('6.3b PIN unlock works offline from the cached digest', await page.locator('.topbar').count() > 0, `url=${page.url()}`)
    await shot(page, 'offline-unlock')
  }

  // ---- 6.4 back online, queue drains
  await goOnline()
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 20000 })
  const syncBtn = page.locator('button:has-text("Sync now")')
  if (await syncBtn.count()) await syncBtn.click()
  await page.waitForFunction(() => /0 pending/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {})
  const qTxt2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('6.4 the queue drains once the network is back', /0 pending/.test(qTxt2), qTxt2.slice(0, 200))
  await shot(page, 'online-queue-drained')

  // ---- 6.5 exactly one invoice
  const rows = await L.invoiceForUuid(admin, uuidOff)
  if (rows[0]) created.push(rows[0].name)
  record('6.5 the offline sale exists server-side exactly once', rows.length === 1 && Number(rows[0].docstatus) === 1,
    `${rows.length} invoice(s) for uuid ${uuidOff}: ${JSON.stringify(rows.map((r) => ({ n: r.name, ds: r.docstatus, gt: r.grand_total })))}`)
  // force a replay of the same payload — the server must de-duplicate
  const a1api = await L.userApi(L.A1)
  const replay = await a1api.post('maison_pos.api.sales.submit_batch', {
    invoices: JSON.stringify([{ offline_uuid: uuidOff, boutique: L.STORE, associate: L.A1.usr, device_id: 'qa1-replay',
      posting_datetime: new Date().toISOString(), items: [{ item_code: 'ACC-002', qty: 1, rate: boot.prices['ACC-002'] }],
      payments: [{ mode_of_payment: 'Cash', amount: 1.94 }] }])
  })
  const rows2 = await admin.list('Sales Invoice', { maison_offline_uuid: uuidOff }, ['name', 'docstatus'], 5)
  record('6.5b replaying the same offline_uuid does not create a second invoice', rows2.length === 1 && replay.results?.[0]?.status === 'duplicate',
    `replay result=${JSON.stringify(replay.results?.[0])}; invoices now=${JSON.stringify(rows2)}`)
  await a1api.dispose()

  // ---- 6.6 stock conflict surfaces cleanly
  const lowCode = 'DEV-007' // stock 5
  const binBefore = (await admin.list('Bin', { item_code: lowCode, warehouse: L.WH }, ['actual_qty'], 1))[0]
  await page.goto('/pos/sell', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tile', { timeout: 20000 })
  await goOffline()
  await pick(lowCode)
  // age gate (DEV items are 21+)
  if (await page.locator('[data-testid=age-gate]').count()) {
    await page.click('[data-testid=age-tab-manual]')
    await page.fill('[data-testid=age-dob]', '1990-05-15')
    await page.click('[data-testid=age-manual-submit]')
    await page.waitForSelector('[data-testid=age-gate]', { state: 'detached', timeout: 20000 }).catch(() => {})
  }
  const more = page.locator('.basket .line').first().locator('.qty-btn[aria-label=More]')
  for (let i = 0; i < 40; i++) await more.click()
  await sleep(500)
  const qtyBig = (await page.locator('.basket .line').first().locator('.qty-n').textContent()).trim()
  await L.payCash(page, 9999)
  const uuidConf = page.url().split('/receipt/')[1]
  await shot(page, 'offline-oversell-queued')
  await goOnline()
  await page.goto('/pos/queue', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.page-title', { timeout: 20000 })
  if (await page.locator('button:has-text("Sync now")').count()) await page.click('button:has-text("Sync now")')
  await page.waitForFunction(() => /rejected/i.test(document.body.innerText) && !/0 rejected/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {})
  await sleep(3000)
  const qConf = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const srvLog = (await admin.list('Maison Sync Log', { offline_uuid: uuidConf }, ['status', 'error'], 2))[0]
  const confInv = await admin.list('Sales Invoice', { maison_offline_uuid: uuidConf }, ['name'], 3)
  const htmlLeak = /<\/?[a-z][\s\S]*>/i.test(qConf.slice(0, 4000)) || /Traceback|File \"/i.test(qConf)
  record('6.6 a stock conflict is refused and surfaces cleanly in the queue',
    confInv.length === 0 && /rejected/i.test(qConf) && !htmlLeak,
    `sold qty ${qtyBig} of ${lowCode} (bin had ${binBefore?.actual_qty}); server log=${JSON.stringify(srvLog)}; invoices=${JSON.stringify(confInv)}; queue text="${qConf.slice(0, 400)}"`)
  await shot(page, 'offline-conflict-queue', true)
  const binAfter = (await admin.list('Bin', { item_code: lowCode, warehouse: L.WH }, ['actual_qty'], 1))[0]
  record('6.6b the refused sale did not move stock', Number(binAfter?.actual_qty) === Number(binBefore?.actual_qty),
    `bin ${lowCode} before=${binBefore?.actual_qty} after=${binAfter?.actual_qty}`)
  // discard the rejected row so the till is clean for the next tester
  const discard = page.locator('button:has-text("Discard"), button:has-text("Delete"), button:has-text("Remove")')
  note('6.6c queue actions offered on a rejected row', JSON.stringify(await page.$$eval('.queue button, .page-body button', (b) => b.map((x) => x.textContent.trim()))))
} catch (e) {
  record('t6 crashed', false, String(e.stack || e), 'high')
  await shot(page, 'crash-t6').catch(() => {})
} finally {
  L.writeResults('results-t6.json', { created })
  fs.appendFileSync('/tmp/qa-created.txt', created.join('\n') + '\n')
  await context.close(); await browser.close(); await admin.dispose()
}
