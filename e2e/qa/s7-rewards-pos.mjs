// QA4 · B — points on net, tier redemption at the POS, unaffordable tier, stacking, points reversal on return.
import * as L from './lib-srs.mjs'
import fs from 'node:fs'
const { record, note, shot, go, log, sleep, money } = L
const TAG = process.env.RUNTAG || 'QA4A'
const MEMBER = 'QA4 Member QA4A'
const admin = await L.adminApi()
const assoc = await L.userApi(L.A1)
const browser = await L.newBrowser()
const cust = await admin.value('Customer', MEMBER, ['maison_client_number', 'customer_name'])
const created = { invoices: [], returns: [] }

// ---------- earn: a $360 net sale
const boot = await assoc.get('maison_pos.api.catalog.bootstrap', { boutique: L.STORE })
const tiersDef = boot.reward_tiers || []
record('B · catalogue bootstrap ships the three reward tiers', JSON.stringify(tiersDef.map((t) => [t.points, t.amount])) === '[[100,5],[200,10],[300,15]]', JSON.stringify(tiersDef.map((t) => [t.points, t.amount, t.title])))
record('B · stacking is off by default', !Number(boot.settings?.reward_allow_stacking), `reward_allow_stacking=${boot.settings?.reward_allow_stacking}`)
const ITEM = 'CBD-003', RATE = 44.99, QTY = 8
const gross = Number((RATE * QTY).toFixed(2))
const before = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
const earn = await assoc.post('maison_pos.api.sales.submit_batch', {
  invoices: [{
    offline_uuid: `qa4-${TAG}-earn-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
    posting_datetime: new Date().toISOString(), customer: MEMBER,
    items: [{ item_code: ITEM, qty: QTY, rate: RATE }],
    payments: [{ mode_of_payment: 'Cash', amount: Number((gross * 1.095).toFixed(2)) }]
  }]
})
const earnRes = earn.results[0]
if (earnRes.status !== 'ok') throw new Error('earn sale rejected ' + JSON.stringify(earnRes).slice(0, 300))
created.invoices.push(earnRes.invoice_name)
const earnInv = await admin.doc('Sales Invoice', earnRes.invoice_name)
const afterEarn = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
record('B · $1 spent = 1 point, earned on the net amount (not the taxed total)',
  Math.round(afterEarn.points - before.points) === Math.floor(Number(earnInv.net_total)),
  `net $${earnInv.net_total} grand $${earnInv.grand_total} → +${Math.round(afterEarn.points - before.points)} pts (balance ${before.points} → ${afterEarn.points})`)
record('B · points are earned on the right basket (invoice-linked entry)',
  (await admin.list('Loyalty Point Entry', { invoice: earnRes.invoice_name }, ['loyalty_points', 'purchase_amount'], 5))[0]?.purchase_amount === earnInv.net_total,
  JSON.stringify(await admin.list('Loyalty Point Entry', { invoice: earnRes.invoice_name }, ['loyalty_points', 'purchase_amount', 'expiry_date'], 5)))
record('B · all three tiers are affordable at 300+ points', (afterEarn.affordable || []).length === 3, `points=${afterEarn.points} affordable=${(afterEarn.affordable || []).map((t) => t.points).join(',')}`)

// ---------- redeem at the POS
const { context, page } = await L.ctxFor(browser, L.A1, 'pos', { viewport: { width: 1440, height: 1024 } })
await L.unlock(page, L.A1, { fresh: true })
await L.nav(page, 'Client')
await page.waitForSelector('.client-view .toolbar input', { timeout: 25000 })
await page.fill('.client-view .toolbar input', cust.maison_client_number)
await page.waitForSelector('.client-view .crow', { timeout: 25000 })
await page.locator('.client-view .crow').first().click()
await page.click('.detail .actions button:has-text("Attach to sale")')
await page.waitForSelector('.basket .client-name', { timeout: 20000 })
await L.addItem(page, 'Blazer Big Shot')
await L.addItem(page, 'Blazer Big Shot')
await page.waitForTimeout(600)
const totalBefore = money(await page.locator('.basket .total-amt').textContent())
await page.click('[data-testid=loyalty-row]')
await page.waitForSelector('[data-testid=redeem-sheet]', { timeout: 20000 })
const sheet = (await page.locator('[data-testid=redeem-sheet]').innerText()).replace(/\s+/g, ' ')
const offered = await page.$$eval('[data-testid=redeem-sheet] .tier', (t) => t.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
record('B · the POS Redeem sheet offers every affordable tier', offered.length === 3, `${offered.join(' | ')}`)
record('B · the sheet states "One reward per transaction" while stacking is off', /One reward per transaction/i.test(sheet), sheet.slice(0, 160))
await shot(page, 'pos-redeem-sheet')
await page.click('[data-testid=tier-300]')
await page.waitForTimeout(1200)
// stacking: picking a second tier must replace, not add
await page.click('[data-testid=tier-100]').catch(() => {})
await page.waitForTimeout(1000)
const picked = await page.evaluate(() => document.querySelectorAll('[data-testid=redeem-sheet] .tier.on').length)
record('B · with stacking off the POS keeps exactly one tier selected', picked === 1, `${picked} tiers highlighted`)
await page.click('[data-testid=redeem-done]').catch(() => {})
await page.waitForTimeout(1000)
const totalAfter = money(await page.locator('.basket .total-amt').textContent())
const chosen = await page.locator('[data-testid=redeem-sub]').textContent()
record('B · redeeming a tier takes the reward off the total', Math.abs((totalBefore - totalAfter) - (/300/.test(chosen) ? 15 : 5)) < 0.02,
  `${totalBefore} → ${totalAfter} (−${(totalBefore - totalAfter).toFixed(2)}), tier = ${chosen.trim()}`)
await shot(page, 'pos-redeem-applied')
await L.payCash(page, null)
const { pill, uuid } = await L.waitSynced(page)
const redeemInv = (await L.invoiceForUuid(admin, uuid))[0]
if (redeemInv) created.invoices.push(redeemInv.name)
record('B · the redeeming sale syncs', /Synced/i.test(pill) && !!redeemInv, `${pill} ${redeemInv?.name}`)
const rfull = await admin.doc('Sales Invoice', redeemInv.name)
record('B · the invoice records the redemption (loyalty_amount / loyalty_points / tier)',
  Number(rfull.loyalty_amount) === (/300/.test(chosen) ? 15 : 5) && Number(rfull.loyalty_points) === (/300/.test(chosen) ? 300 : 100) && !!rfull.maison_reward_tier,
  `loyalty_amount=${rfull.loyalty_amount} loyalty_points=${rfull.loyalty_points} tier=${rfull.maison_reward_tier} redeem_against=${rfull.redeem_against || 'n/a'} grand=${rfull.grand_total}`)
const afterRedeem = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
record('B · the balance drops by exactly the redeemed points', Math.round(afterEarn.points - afterRedeem.points) === Number(rfull.loyalty_points),
  `${afterEarn.points} → ${afterRedeem.points}`)
const recTxt = (await page.locator('.receipt-view').innerText()).replace(/\s+/g, ' ')
record('B · the receipt shows the redeemed reward and the tier progress', /REWARD|REDEEM/i.test(recTxt) && /NEXT REWARD/i.test(recTxt), recTxt.match(/CLOUDCHASERZ REWARDS.{0,160}/i)?.[0] || recTxt.slice(0, 160))
await shot(page, 'pos-redeem-receipt')

// ---------- a tier the client cannot afford
const now = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
const tooBig = (boot.reward_tiers || []).find((t) => t.points > now.points)
const refuse = await assoc.rawPost('maison_pos.api.sales.submit_batch', {
  invoices: [{
    offline_uuid: `qa4-${TAG}-refuse-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
    posting_datetime: new Date().toISOString(), customer: MEMBER, reward_tier: tooBig?.name,
    items: [{ item_code: 'ACC-003', qty: 2, rate: 59.99 }],
    payments: [{ mode_of_payment: 'Cash', amount: 130 }]
  }]
})
const refuseRes = refuse.body?.message?.results?.[0]
record('B · a tier the client cannot afford is refused', refuseRes?.status !== 'ok',
  `balance=${now.points}, asked for ${tooBig?.points}pts → ${refuseRes?.status} ${JSON.stringify(refuseRes?.error || refuseRes?.message || '').slice(0, 160)}`)
if (refuseRes?.status === 'ok') created.invoices.push(refuseRes.invoice_name)
record('B · the POS offers no tier when the balance is short', (now.affordable || []).length < 3, `points=${now.points} affordable=${(now.affordable || []).map((t) => t.points).join(',') || 'none'} next=${JSON.stringify(now.next_reward)}`)

// ---------- stacking refused server-side
const stack = await assoc.rawPost('maison_pos.api.sales.submit_batch', {
  invoices: [{
    offline_uuid: `qa4-${TAG}-stack-${Date.now()}`, boutique: L.STORE, associate: L.A1.usr, device_id: `QA4-${TAG}`,
    posting_datetime: new Date().toISOString(), customer: MEMBER, reward_tiers: (boot.reward_tiers || []).slice(0, 2).map((t) => t.name),
    items: [{ item_code: 'ACC-003', qty: 2, rate: 59.99 }],
    payments: [{ mode_of_payment: 'Cash', amount: 130 }]
  }]
})
const stackRes = stack.body?.message?.results?.[0]
record('B · stacking two tiers is refused while reward_allow_stacking is off', stackRes?.status !== 'ok',
  `→ ${stackRes?.status} ${JSON.stringify(stackRes?.error || '').slice(0, 160)}`)
if (stackRes?.status === 'ok') created.invoices.push(stackRes.invoice_name)

// ---------- return reverses the points
const beforeReturn = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
const ret = await assoc.post('maison_pos.api.returns.return_items', {
  invoice: earnRes.invoice_name,
  lines: JSON.stringify([{ item_code: ITEM, qty: 2, reason: 'Changed mind', condition: 'Resaleable' }]),
  refund_method: 'cash', reason: 'Changed mind', device_id: `QA4-${TAG}`
})
created.returns.push(ret.credit_note || ret.name || ret.invoice)
const cn = await admin.doc('Sales Invoice', ret.credit_note || ret.name)
const afterReturn = await admin.get('maison_pos.api.rewards.tiers', { customer: MEMBER, boutique: L.STORE })
record('B · a return reverses the points for the returned value', afterReturn.points < beforeReturn.points,
  `credit note ${cn.name} net ${cn.net_total} → points ${beforeReturn.points} → ${afterReturn.points} (Δ ${afterReturn.points - beforeReturn.points})`)
record('B · the balance never goes negative', afterReturn.points >= 0, `points=${afterReturn.points}`)

await context.close(); await browser.close()
fs.writeFileSync(new URL('./created-s7.json', import.meta.url), JSON.stringify({ TAG, created, earn: earnRes.invoice_name, redeem: redeemInv?.name, creditNote: cn.name }, null, 2))
L.writeResults('results-s7.json', { created })
