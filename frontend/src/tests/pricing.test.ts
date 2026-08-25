/**
 * v1.2 "What each store owes, and what each store charges" — §C the statement, §D the price
 * board and the approvals queue, §E the row the buying board cannot order.
 *
 * The repo has no component-mounting stack (`@vue/test-utils` is not a dependency), so each screen
 * exports the pure part a reviewer would otherwise have to read a template to check, and those are
 * tested here directly, together with the stores behind them (against the deterministic in-memory
 * pricing desk in `api/pricing.ts`).
 *
 * What is pinned here, and why each one earns its place:
 *
 *  · **`margin_pct` is `null` on an unpriced item, and renders `—`.** A board that says `0 %` for
 *    an item the chain has never priced is the sort of thing somebody prices against — this is
 *    the one defect in this release that would cost real money, so it is asserted at the payload,
 *    at the maths and at the rendering.
 *  · **The statement's totals as rendered.** The screen adds up the rows it is showing rather than
 *    printing a figure it did not compute, so `statementTotals` has to agree with the server's
 *    `totals` exactly — and must never sum eleven margin percentages.
 *  · **"Not priced" is not "worth nothing".** A consignment that shipped before v1.2 carries no
 *    stamp: its units are counted, its value is never guessed, and the screen says so in words.
 *  · **A reason is required on a price change.** The server throws without one; the board has to
 *    refuse first, or a manager meets that after typing eleven prices.
 *  · **The unorderable-row copy.** The v1.0 defect was a tick that appeared, a footer that read
 *    *Nothing selected*, and nothing anywhere explaining the gap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { __resetMockPricing, mockPricing, type StatementStore, type StorePrices } from '@/api/pricing'
import { __resetMockPurchasing, mockPurchasing, type Suggestion } from '@/api/purchasing'
import { usePricingStore } from '@/stores/pricing'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import type { WarehouseMe } from '@/api/warehouse'
import {
  applyMarkup,
  boardProblems,
  boardSummary,
  changeCopy,
  decisionProblem,
  hasUnpriced,
  isQuiet,
  isTouched,
  marginAt,
  marginPctText,
  marginTone,
  markupProblem,
  monthBounds,
  monthToDate,
  netNote,
  pendingCount,
  periodProblem,
  previousMonth,
  proposalsFrom,
  raiseCopy,
  raisedCopy,
  receivedInFull,
  statementTotals,
  unpricedNote,
  validateProposal,
  wholesaleOf,
  type PriceDraft
} from '@/warehouse/pricing'
import { blockedReason, isOrderable, orderableRows, selectAllNote } from '@/warehouse/buying'
import { pendingCopy, windowCopy } from '@/warehouse/components/pricing/PriceBoardSheet.vue'
import { hasMargins, moveCopy, sortRequests, REQUEST_STATUSES } from '@/warehouse/components/pricing/ApprovalsBoard.vue'
import { sortStores } from '@/warehouse/components/pricing/StatementBoard.vue'
import { ruleSummary, sortWholesale } from '@/warehouse/components/pricing/WholesaleBoard.vue'
import { blockedCopy } from '@/warehouse/components/purchasing/BuySuggestRow.vue'
import { addCopy, addedCopy, candidateProblems, draftFor, linesFrom } from '@/warehouse/components/purchasing/AddVendorItemsSheet.vue'

// the screens talk to the APIs through the stores; point both at the seeded desks
vi.mock('@/api/pricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/pricing')>()
  return { ...actual, pricingApi: actual.mockPricing }
})
vi.mock('@/api/purchasing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/purchasing')>()
  return { ...actual, purchasingApi: actual.mockPurchasing }
})

const ME: WarehouseMe = {
  user: 'warehouse@cloudchaserz.example',
  full_name: 'Wanda Houston',
  roles: ['AWANZ Warehouse Admin'],
  warehouse_admin: true,
  supply_unrestricted: true,
  boutique: null,
  main_warehouse: 'HOU-WH - CCZ',
  brand: { brand_name: 'CloudChaserz', wordmark_text: 'CLOUDCHASERZ', product_name: 'AWANZ POS by CloudChaserz' },
  provider: 'simulated',
  stores: ['HOU-MTR', 'OK-BIX', 'OK-JENKS']
}

function desk() {
  __resetMockPurchasing() // also resets the pricing desk — the price endpoints share its state
  setActivePinia(createPinia())
  useWarehouseStore().me = { ...ME }
  return usePricingStore()
}

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`

// =============================================================================================
// §A — the chain-wide rule, mirrored from maison_pos/pricing/wholesale.py
// =============================================================================================
describe('the wholesale rule', () => {
  beforeEach(__resetMockPricing)

  it('marks cost up by the chain percentage, and a typed price beats it', () => {
    expect(applyMarkup(9.34, 50)).toBe(14.01)
    expect(wholesaleOf(9.34, 50, null)).toBe(14.01)
    expect(wholesaleOf(9.34, 50, 12.5)).toBe(12.5)
    // blank is how a Frappe Currency column spells "use the rule" — zero must not win
    expect(wholesaleOf(9.34, 50, 0)).toBe(14.01)
    // 0% is a legitimate answer: ship at cost
    expect(applyMarkup(9.34, 0)).toBe(9.34)
  })

  it('refuses a negative markup and an absurd one, and allows zero', () => {
    expect(markupProblem(0)).toBe('')
    expect(markupProblem(50)).toBe('')
    expect(markupProblem(1000)).toBe('')
    expect(markupProblem(-1)).toMatch(/cannot be negative/)
    expect(markupProblem(1001)).toMatch(/typing slip/)
    expect(markupProblem('abc')).toMatch(/not a percentage/)
  })

  it('resolves many items in one pass, saying which rule each one followed', async () => {
    const out = await mockPricing.wholesale(['GB-PULSE-15K-BLUE', 'ZIG-ZAG-1-25', 'NOT-A-THING'])
    expect(out.count).toBe(2)
    expect(out.items[0]).toMatchObject({ item_code: 'GB-PULSE-15K-BLUE', cost: 9.34, override: null, wholesale: 14.01, source: 'markup' })
    // Zig-Zag carries a typed price, so the chain rule does not apply to it
    expect(out.items[1]).toMatchObject({ item_code: 'ZIG-ZAG-1-25', override: 1.75, wholesale: 1.75, source: 'override' })
    // `margin` on these rows is AWANZ's — wholesale less cost, not the store's
    expect(out.items[0].margin).toBe(4.67)
  })

  it('clears an override back to the rule, and a new markup moves every ruled item', async () => {
    expect((await mockPricing.set_wholesale('ZIG-ZAG-1-25', null)).item).toMatchObject({ override: null, source: 'markup', wholesale: 1.35 })
    const settings = await mockPricing.set_wholesale_markup(80)
    expect(settings.markup_pct).toBe(80)
    expect((await mockPricing.wholesale(['ZIG-ZAG-1-25'])).items[0].wholesale).toBe(1.62)
    await expect(mockPricing.set_wholesale_markup(-5)).rejects.toThrow(/cannot be negative/)
    await expect(mockPricing.set_wholesale_markup(2000)).rejects.toThrow(/typing slip/)
  })

  it('sorts hand-priced items first and counts them', async () => {
    const rows = (await mockPricing.wholesale(['GB-PULSE-15K-BLUE', 'ZIG-ZAG-1-25', 'RAW-KS-SLIM'])).items
    expect(sortWholesale(rows)[0].item_code).toBe('ZIG-ZAG-1-25')
    expect(ruleSummary(rows, 50)).toBe('2 on the 50% chain rule · 1 priced by hand.')
    expect(ruleSummary([], 50)).toBe('Nothing loaded yet.')
  })
})

// =============================================================================================
// §D — the price board's margin maths
// =============================================================================================
describe('price board margins', () => {
  it('is the store’s margin — shelf price less what they paid us', () => {
    expect(marginAt(24.99, 14.01)).toEqual({ margin: 10.98, margin_pct: 43.9, has_price: true })
    expect(marginAt(3.49, 1.82)).toEqual({ margin: 1.67, margin_pct: 47.9, has_price: true })
  })

  it('answers null — never 0 — when the item has no price at all, and renders it as an em dash', () => {
    const none = marginAt(0, 1.11)
    expect(none.margin_pct).toBeNull()
    expect(none.has_price).toBe(false)
    expect(marginPctText(none.margin_pct)).toBe('—')
    expect(marginPctText(undefined)).toBe('—')
    expect(marginPctText(Number.NaN)).toBe('—')
    expect(marginPctText(43.85)).toBe('43.9 %')
    // and the tone of "unknown" is muted, not critical: an unpriced item is not a bad margin
    expect(marginTone(none.margin_pct)).toBe('muted')
  })

  it('calls a shop selling at or below what it paid us critical, and a thin margin a warning', () => {
    expect(marginTone(-4)).toBe('crit')
    expect(marginTone(0)).toBe('crit')
    expect(marginTone(12)).toBe('warn')
    expect(marginTone(44)).toBe('good')
  })

  it('carries the margin through the payload for every store, and null for the unpriced item', async () => {
    __resetMockPricing()
    const board = await mockPricing.store_prices('GB-PULSE-15K-BLUE')
    expect(board.stores).toHaveLength(11)
    expect(board).toMatchObject({ internal: true, wholesale: 14.01, cost: 9.34, wholesale_source: 'markup' })
    const montrose = board.stores.find((s) => s.boutique === 'HOU-MTR')!
    expect(montrose).toMatchObject({ source: 'Chain default', is_override: false, rate: 24.99, margin_pct: 43.9 })
    // Sapulpa carries a live pricing rule of its own
    const sapulpa = board.stores.find((s) => s.boutique === 'OK-SAP')!
    expect(sapulpa).toMatchObject({ source: 'Store override', is_override: true, rate: 26.99, pricing_rule: 'PRLE-0028' })
    // Bixby is already waiting on head office for this exact item
    expect(board.stores.find((s) => s.boutique === 'OK-BIX')!.pending).toMatchObject({ name: 'PCR-00003', proposed_rate: 22.99 })

    const unpriced = await mockPricing.store_prices('CLIPPER-LTR-ASST')
    expect(unpriced.default_rate).toBe(0)
    expect(unpriced.stores.every((s) => s.margin_pct === null && s.has_price === false)).toBe(true)
  })
})

// =============================================================================================
// §D — typing a price, and the reason the server insists on
// =============================================================================================
describe('raising a price change', () => {
  it('refuses a blank price, a nonsense one, the price it already sells at — and a blank reason', () => {
    expect(validateProposal({ rate: '22.99', reason: 'matching next door' }, 24.99)).toEqual([])
    expect(validateProposal({ rate: '', reason: 'x' }, 24.99)[0]).toMatchObject({ field: 'rate' })
    expect(validateProposal({ rate: 'abc', reason: 'x' }, 24.99)[0].message).toMatch(/not a price/)
    expect(validateProposal({ rate: '0', reason: 'x' }, 24.99)[0].message).toMatch(/more than nothing/)
    expect(validateProposal({ rate: '24.99', reason: 'x' }, 24.99)[0].message).toMatch(/already selling at/)
    // the one the server throws on — collected here so nobody meets it after typing eleven prices
    expect(validateProposal({ rate: '22.99', reason: '   ' }, 24.99)).toEqual([
      { field: 'reason', message: 'Say why the price is changing — head office reads it when they approve.' }
    ])
  })

  it('turns the typed rows into one request each, and skips a store already waiting', async () => {
    __resetMockPricing()
    const board = await mockPricing.store_prices('GB-PULSE-15K-BLUE')
    const drafts: Record<string, PriceDraft> = {
      'HOU-MTR': { rate: '22.99', reason: 'matching the shop two doors down' },
      'OK-SAP': { rate: '25.49', reason: 'matching the shop two doors down' },
      // Bixby already has PCR-00003 waiting — a second request would give head office two
      // documents and one shelf
      'OK-BIX': { rate: '21.99', reason: 'matching the shop two doors down' },
      'OK-YALE': { rate: '', reason: '' }
    }
    const proposals = proposalsFrom(board, drafts)
    expect(proposals.map((p) => p.boutique)).toEqual(['HOU-MTR', 'OK-SAP'])
    expect(proposals[0]).toMatchObject({ current_rate: 24.99, proposed_rate: 22.99, item_code: 'GB-PULSE-15K-BLUE' })
    expect(proposals[0].margin).toEqual({ margin: 8.98, margin_pct: 39.1, has_price: true })
    expect(boardProblems(board, drafts)).toEqual([])
    expect(isTouched(drafts['OK-YALE'])).toBe(false)
    expect(isTouched(drafts['HOU-MTR'])).toBe(true)
  })

  it('reports the rows that need fixing rather than posting them', async () => {
    __resetMockPricing()
    const board = await mockPricing.store_prices('GB-PULSE-15K-BLUE')
    const drafts: Record<string, PriceDraft> = { 'HOU-MTR': { rate: '-3', reason: '' } }
    const problems = boardProblems(board, drafts)
    expect(problems).toHaveLength(1)
    expect(problems[0].problems.map((p) => p.field).sort()).toEqual(['rate', 'reason'])
    expect(proposalsFrom(board, drafts)).toEqual([])
    expect(raiseCopy([], problems)).toBe('1 row to fix')
  })

  it('says what it is about to do, and what it did', () => {
    expect(raiseCopy([], [])).toBe('Nothing to raise')
    expect(raiseCopy([{ boutique: 'A' }, { boutique: 'B' }] as never[], [])).toBe('Raise 2 price changes')
    expect(raisedCopy(['PCR-00006'])).toMatch(/^1 price change raised for approval — PCR-00006$/)
    expect(raisedCopy(['PCR-00006', 'PCR-00007'], 1)).toMatch(/2 price changes raised.*· 1 row refused$/)
    expect(raisedCopy([], 2)).toBe('Nothing was raised — 2 rows refused')
  })

  it('shows the change as an arrow with the difference beside it', () => {
    expect(changeCopy(24.99, 22.99, money)).toBe('$24.99 → $22.99 · −$2.00')
    expect(changeCopy(0, 12.99, money)).toBe('no price → $12.99 · +$12.99')
    expect(changeCopy(3.49, 3.49, money)).toBe('$3.49 → $3.49')
  })

  it('summarises the eleven rows as a state of play', async () => {
    __resetMockPricing()
    const board = await mockPricing.store_prices('GB-PULSE-15K-BLUE')
    expect(boardSummary(board)).toBe('11 stores · 1 with a price of their own · 1 change waiting for approval.')
    expect(pendingCount(board)).toBe(1)
    expect(boardSummary({ stores: [] } as unknown as StorePrices)).toBe('No enabled store to price this for.')
  })

  it('names who is waiting, and for how long an override is good for', async () => {
    __resetMockPricing()
    const board = await mockPricing.store_prices('GB-PULSE-15K-BLUE')
    const bixby = board.stores.find((s) => s.boutique === 'OK-BIX')!
    expect(pendingCopy(bixby, money)).toBe('bixby.manager asked for $22.99 — waiting for approval')
    expect(pendingCopy(board.stores.find((s) => s.boutique === 'OK-YALE')!, money)).toBe('')
    expect(windowCopy('2026-08-26', '2026-09-15')).toBe('2026-08-26 – 2026-09-15')
    expect(windowCopy('2026-08-26', null)).toBe('from 2026-08-26')
    expect(windowCopy(null, '2026-09-15')).toBe('until 2026-09-15')
    expect(windowCopy(null, null)).toBe('')
  })

  it('raises through the store, and the server refuses a blank reason', async () => {
    const pricing = desk()
    await pricing.loadBoard('GB-PULSE-15K-BLUE')
    const out = await pricing.raisePriceChange('GB-PULSE-15K-BLUE', 'HOU-MTR', 22.99, { reason: 'matching next door' })
    expect(out).toMatchObject({ boutique: 'HOU-MTR', proposed_rate: 22.99, workflow_state: 'Pending Approval' })
    // the board now shows Montrose as waiting rather than inviting a second request
    await pricing.loadBoard('GB-PULSE-15K-BLUE')
    expect(pricing.board!.stores.find((s) => s.boutique === 'HOU-MTR')!.pending!.name).toBe(out!.name)

    expect(await pricing.raisePriceChange('GB-PULSE-15K-BLUE', 'OK-YALE', 21.99, { reason: '  ' })).toBeNull()
    expect(pricing.error).toBe('Say why the price is changing — head office reads it when they approve')
  })
})

// =============================================================================================
// §D — the approvals queue
// =============================================================================================
describe('the approvals queue', () => {
  it('carries the wholesale price and both margins for a purchasing admin', async () => {
    __resetMockPricing()
    const out = await mockPurchasing.price_change_requests(undefined, 'Pending Approval')
    expect(out.count).toBe(3)
    const bixby = out.requests.find((r) => r.name === 'PCR-00003')!
    expect(bixby.wholesale).toBe(14.01)
    expect(hasMargins(bixby)).toBe(true)
    expect(bixby.margin_now).toEqual({ margin: 10.98, margin_pct: 43.9, has_price: true })
    expect(bixby.margin_proposed).toEqual({ margin: 8.98, margin_pct: 39.1, has_price: true })
  })

  it('renders an em dash rather than inventing a zero when the margins are not attached', async () => {
    __resetMockPricing()
    const bare = (await mockPurchasing.price_change_requests(undefined, 'Pending Approval')).requests.map((r) => ({
      ...r,
      wholesale: undefined,
      margin_now: undefined,
      margin_proposed: undefined
    }))
    expect(hasMargins(bare[0])).toBe(false)
  })

  it('puts what is waiting first and history after it', async () => {
    __resetMockPricing()
    const all = (await mockPurchasing.price_change_requests(undefined, 'all')).requests
    expect(sortRequests(all).map((r) => r.workflow_state)).toEqual(['Pending Approval', 'Pending Approval', 'Pending Approval', 'Approved'])
    expect([...REQUEST_STATUSES]).toEqual(['Pending Approval', 'Approved', 'Rejected', 'all'])
  })

  it('insists on a reason for a reject and not for an approve', () => {
    expect(decisionProblem('Approve', '')).toBe('')
    expect(decisionProblem('Reject', '  ')).toMatch(/Say why it is being rejected/)
    expect(decisionProblem('Reject', 'margin is too thin')).toBe('')
  })

  it('states the move in money', () => {
    expect(moveCopy(24.99, 22.99, money)).toBe('−$2.00 a unit')
    expect(moveCopy(2.99, 3.49, money)).toBe('+$0.50 a unit')
    expect(moveCopy(3.49, 3.49, money)).toBe('no change')
  })

  it('approving is what writes the store’s pricing rule — the board shows it afterwards', async () => {
    const pricing = desk()
    await pricing.loadBoard('GB-PULSE-15K-BLUE')
    expect(pricing.board!.stores.find((s) => s.boutique === 'OK-BIX')!.is_override).toBe(false)
    await pricing.loadRequests({ status: 'Pending Approval' })
    expect(pricing.pendingCount).toBe(3)

    const out = await pricing.decide('PCR-00003', 'Approve')
    expect(out!.workflow_state).toBe('Approved')
    expect(out!.pricing_rule).toMatch(/^PRLE-/)
    expect(pricing.notice).toMatch(/PCR-00003 approved/)
    // the board was re-read: Bixby now sells at the approved price, off its own rule
    const bixby = pricing.board!.stores.find((s) => s.boutique === 'OK-BIX')!
    expect(bixby).toMatchObject({ rate: 22.99, is_override: true, source: 'Store override' })
    expect(bixby.pending).toBeNull()
  })

  it('rejecting leaves the shelf where it was, and refuses to be decided twice', async () => {
    const pricing = desk()
    await pricing.loadRequests({ status: 'Pending Approval' })
    const out = await pricing.decide('PCR-00004', 'Reject', 'margin is too thin — hold at 27.99')
    expect(out!.workflow_state).toBe('Rejected')
    expect(out!.pricing_rule).toBeNull()
    expect(pricing.notice).toMatch(/rejected — the store keeps its current price/)
    expect(await pricing.decide('PCR-00004', 'Approve')).toBeNull()
    expect(pricing.error).toMatch(/already rejected/)
  })
})

// =============================================================================================
// §C — the statement, as the screen renders it
// =============================================================================================
describe('the month-end statement', () => {
  beforeEach(__resetMockPricing)

  it('is marked internal and is never an invoice', async () => {
    const out = await mockPricing.statement('2026-08-01', '2026-08-31')
    expect(out).toMatchObject({ internal: true, shows_cost: true, is_invoice: false, creates_receivable: false })
    expect(out.notice).toMatch(/not an invoice/i)
    expect(out.notice).toMatch(/Do not send it to a store/)
  })

  it('gives every enabled store a row, with zeros for the ones that received nothing', async () => {
    const out = await mockPricing.statement('2026-08-01', '2026-08-31')
    expect(out.stores).toHaveLength(11)
    const quiet = out.stores.filter(isQuiet).map((s) => s.boutique)
    expect(quiet).toEqual(['OK-MUS', 'OK-OWA'])
    expect(out.stores.find((s) => s.boutique === 'OK-MUS')).toMatchObject({ shipments: 0, units: 0, wholesale_value: 0, margin_pct: 0 })
  })

  it('nets short and damaged units off what a store is billed for', async () => {
    const out = await mockPricing.statement('2026-08-01', '2026-08-31')
    const montrose = out.stores.find((s) => s.boutique === 'HOU-MTR')!
    // 120 + 64 + 144 sent, 6 of the Geek Bars never arrived
    expect(montrose).toMatchObject({ units: 328, short_units: 6, damaged_units: 0, billable_units: 322 })
    expect(receivedInFull(montrose)).toBe(false)
    expect(netNote(montrose)).toBe('6 short came off')

    const ba = out.stores.find((s) => s.boutique === 'OK-BA')!
    expect(ba).toMatchObject({ units: 300, damaged_units: 12, billable_units: 288 })
    expect(netNote(ba)).toBe('12 damaged came off')

    const jenks = out.stores.find((s) => s.boutique === 'OK-JENKS')!
    expect(netNote(jenks)).toBe('2 short · 1 damaged came off')
    expect(netNote({ short_units: 0, damaged_units: 0 })).toBe('')
    expect(receivedInFull({ short_units: 0, damaged_units: 0 })).toBe(true)
  })

  it('values a store’s bill from what was stamped, and shows the cost beside it', async () => {
    const out = await mockPricing.statement('2026-08-01', '2026-08-31')
    const bixby = out.stores.find((s) => s.boutique === 'OK-BIX')!
    // 72 Geek Bars at 14.01 + 200 Zig-Zags at their typed 1.75 = 1008.72 + 350
    expect(bixby.wholesale_value).toBe(1358.72)
    // and what Houston paid: 72 × 9.34 + 200 × 0.90
    expect(bixby.cost_value).toBe(852.48)
    expect(bixby.margin).toBe(506.24)
    expect(bixby.margin_pct).toBe(37.3)
  })

  it('counts a pre-v1.2 consignment’s units and never values them', async () => {
    const july = await mockPricing.statement('2026-07-01', '2026-07-31')
    const sapulpa = july.stores.find((s) => s.boutique === 'OK-SAP')!
    expect(sapulpa).toMatchObject({ shipments: 2, unpriced_shipments: 2, units: 182, unpriced_units: 182 })
    // counted, billable — and worth nothing on the statement, because nobody knows what it was worth
    expect(sapulpa.billable_units).toBe(182)
    expect(sapulpa.wholesale_value).toBe(0)
    expect(sapulpa.cost_value).toBe(0)
    expect(hasUnpriced(july.stores)).toBe(true)
    expect(unpricedNote(sapulpa)).toBe(
      '2 consignments not priced (182 units) — sent before wholesale pricing existed, so they are counted but never valued.'
    )
    expect(unpricedNote({ unpriced_shipments: 0, unpriced_units: 0 })).toBe('')
    // August has no such consignment
    expect(hasUnpriced((await mockPricing.statement('2026-08-01', '2026-08-31')).stores)).toBe(false)
  })

  it('adds the chain total up from the rows on screen, and never sums margin percentages', async () => {
    const out = await mockPricing.statement('2026-08-01', '2026-08-31')
    const rendered = statementTotals(sortStores(out.stores))
    // the screen's own arithmetic has to agree with the server's, exactly
    expect(rendered.wholesale_value).toBe(out.totals.wholesale_value)
    expect(rendered.cost_value).toBe(out.totals.cost_value)
    expect(rendered.margin).toBe(out.totals.margin)
    expect(rendered.margin_pct).toBe(out.totals.margin_pct)
    expect(rendered.billable_units).toBe(out.totals.billable_units)
    expect(rendered.shipments).toBe(out.totals.shipments)
    expect(rendered.boutique).toBeNull()
    expect(rendered.boutique_name).toBe('Chain total')
    // eleven stores' percentages added together would be a three-figure number
    const summed = out.stores.reduce((s, r) => s + r.margin_pct, 0)
    expect(summed).toBeGreaterThan(rendered.margin_pct)
    expect(rendered.margin_pct).toBeLessThan(100)
  })

  it('totals an empty statement without producing a NaN', () => {
    const empty = statementTotals([])
    expect(empty).toMatchObject({ wholesale_value: 0, cost_value: 0, margin: 0, margin_pct: 0, shipments: 0 })
    expect(Number.isNaN(empty.margin_pct)).toBe(false)
  })

  it('puts the biggest bill first and a quiet store by name', async () => {
    const out = await mockPricing.statement('2026-08-01', '2026-08-31')
    const sorted = sortStores(out.stores)
    expect(sorted[0].boutique).toBe('HOU-MTR')
    expect(sorted.slice(-2).map((s) => s.boutique)).toEqual(['OK-MUS', 'OK-OWA'])
  })

  it('scopes to one store, and refuses a store that is not enabled', async () => {
    const one = await mockPricing.statement('2026-08-01', '2026-08-31', 'OK-BIX')
    expect(one.stores).toHaveLength(1)
    expect(one.totals.wholesale_value).toBe(one.stores[0].wholesale_value)
    await expect(mockPricing.statement('2026-08-01', '2026-08-31', 'NOWHERE')).rejects.toThrow(/not an enabled store/)
    await expect(mockPricing.statement('2026-08-31', '2026-08-01')).rejects.toThrow(/on or before/)
  })

  it('works out the period without ever reading the browser’s clock', () => {
    expect(monthBounds('2026-08-24')).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(monthBounds('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(monthBounds('2028-02-10').to).toBe('2028-02-29') // a leap year
    expect(previousMonth('2026-08-24')).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    expect(previousMonth('2026-01-04')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(monthToDate('2026-08-24')).toEqual({ from: '2026-08-01', to: '2026-08-24' })
    expect(periodProblem({ from: '2026-08-01', to: '2026-08-31' })).toBe('')
    expect(periodProblem({ from: '2026-08-31', to: '2026-08-01' })).toMatch(/on or before/)
    expect(periodProblem({ from: '', to: '2026-08-01' })).toMatch(/Choose a period/)
  })

  it('loads through the store and keeps the payload for the screen', async () => {
    const pricing = desk()
    const out = await pricing.loadStatement('2026-08-01', '2026-08-31')
    expect(out!.stores).toHaveLength(11)
    expect(pricing.statement!.is_invoice).toBe(false)
    expect(pricing.currency).toBe('USD')
    expect(await pricing.loadStatement('2026-08-31', '2026-08-01')).toBeNull()
    expect(pricing.error).toMatch(/on or before/)
  })

  it('spans two months when the period does', async () => {
    const both = await mockPricing.statement('2026-07-01', '2026-08-31')
    const july = await mockPricing.statement('2026-07-01', '2026-07-31')
    const august = await mockPricing.statement('2026-08-01', '2026-08-31')
    expect(both.totals.units).toBe(july.totals.units + august.totals.units)
    expect(both.totals.wholesale_value).toBeCloseTo(july.totals.wholesale_value + august.totals.wholesale_value, 2)
  })
})

// =============================================================================================
// §E — the row the buying board cannot order
// =============================================================================================
describe('an unorderable buying row', () => {
  let rows: Suggestion[]
  beforeEach(async () => {
    __resetMockPurchasing()
    rows = (await mockPurchasing.suggestions(true)).suggestions
  })
  const opms = () => rows.find((s) => s.item_code === 'OPMS-GOLD-3CT')!

  it('knows a row with no vendor cannot become a purchase order, and says why', () => {
    expect(isOrderable(opms())).toBe(false)
    expect(blockedReason(opms())).toBe('No vendor on file — add one before this can be ordered')
    expect(blockedCopy(opms())).toBe(
      'No vendor on file — add one before this can be ordered. It stays on the list — it simply cannot become a purchase order until somebody sells it to us.'
    )
    const ok = rows.find((s) => s.item_code === 'GB-PULSE-15K-BLUE')!
    expect(isOrderable(ok)).toBe(true)
    expect(blockedReason(ok)).toBe('')
    expect(blockedCopy(ok)).toBe('')
  })

  it('falls back to the same fact when a cached row arrives without the flag', () => {
    const older = { ...opms(), orderable: undefined, blocked_reason: undefined }
    expect(isOrderable(older)).toBe(false)
    expect(blockedReason(older)).toBe('No vendor on file — add one before this can be ordered')
    expect(isOrderable({ ...older, supplier: 'SUP-GULF' })).toBe(true)
  })

  it('says how many rows Select all skipped, and what to do about it', () => {
    expect(orderableRows(rows)).toHaveLength(5)
    expect(selectAllNote(rows)).toBe(
      '1 row skipped — no vendor on file — add one before this can be ordered. Add a vendor on the row to bring it back in.'
    )
    // nothing to say when everything can be ordered — the note is not decoration
    expect(selectAllNote(orderableRows(rows))).toBe('')
    expect(selectAllNote([])).toBe('')
  })

  it('unblocks the row the buyer is looking at, without waiting for the overnight run', async () => {
    setActivePinia(createPinia())
    useWarehouseStore().me = { ...ME }
    const store = usePurchasingStore()
    await store.loadSuggestions()
    expect(store.openSuggestions.find((s) => s.item_code === 'OPMS-GOLD-3CT')!.orderable).toBe(false)
    // the row is right to be dropped from the basket — you cannot order without a supplier
    store.select('OPMS-GOLD-3CT')
    expect(store.selectedLines.some((l) => l.item_code === 'OPMS-GOLD-3CT')).toBe(false)

    const out = await store.attachVendor('OPMS-GOLD-3CT', { supplier: 'SUP-GULF', cost: 4.4, case_pack: 6, moq: 12, is_preferred: true })
    expect(out!.suggestion).toMatchObject({ orderable: true, supplier: 'SUP-GULF', cost: 4.4, case_pack: 6, blocked_reason: null })
    expect(store.notice).toBe('Gulf Coast Distributing attached — OPMS-GOLD-3CT can be ordered now')
    // the refreshed row is in the list, re-rounded to the new vendor's case pack
    const refreshed = store.openSuggestions.find((s) => s.item_code === 'OPMS-GOLD-3CT')!
    expect(refreshed).toMatchObject({ orderable: true, supplier: 'SUP-GULF', qty: 18 })
    expect(selectAllNote(store.openSuggestions)).toBe('')
    // and it can now be ordered
    expect(store.selectedLines.some((l) => l.item_code === 'OPMS-GOLD-3CT')).toBe(true)
  })
})

// =============================================================================================
// §E — adding a sheet of items to a vendor
// =============================================================================================
describe('adding items to a vendor', () => {
  beforeEach(__resetMockPurchasing)

  it('offers everything not already on that vendor, orphans first', async () => {
    const out = await mockPurchasing.vendor_catalogue_candidates('SUP-GULF')
    expect(out.items.some((r) => r.item_code === 'GB-PULSE-15K-BLUE')).toBe(false) // already theirs
    expect(out.items[0]).toMatchObject({ item_code: 'OPMS-GOLD-3CT', has_vendor: false, unorderable: true, case_pack: 1, moq: 0 })
    expect(out.items[0].suggested_cost).toBe(4.65)
    expect(out.items.slice(1).every((r) => r.has_vendor)).toBe(true)
    expect((await mockPurchasing.vendor_catalogue_candidates('SUP-GULF', 'kratom')).items.map((r) => r.item_code)).toEqual(['OPMS-GOLD-3CT'])
  })

  it('validates the whole sheet before it writes any of it', async () => {
    const rows = (await mockPurchasing.vendor_catalogue_candidates('SUP-GULF')).items
    const drafts = Object.fromEntries(rows.map((r) => [r.item_code, draftFor(r)]))
    expect(candidateProblems(rows, drafts)).toEqual([]) // nothing picked, nothing to complain about

    drafts['OPMS-GOLD-3CT'] = { ...drafts['OPMS-GOLD-3CT'], picked: true, cost: '' }
    expect(candidateProblems(rows, drafts)[0].message).toMatch(/type what they charge us/)
    drafts['OPMS-GOLD-3CT'] = { ...drafts['OPMS-GOLD-3CT'], cost: '-1' }
    expect(candidateProblems(rows, drafts)[0].message).toMatch(/cannot be negative/)
    drafts['OPMS-GOLD-3CT'] = { ...drafts['OPMS-GOLD-3CT'], cost: '4.40', case_pack: '0' }
    expect(candidateProblems(rows, drafts)[0].message).toMatch(/case pack is at least 1/)

    drafts['OPMS-GOLD-3CT'] = { picked: true, cost: '4.40', case_pack: '6', moq: '12', vendor_sku: 'GC-OPMS-3' }
    expect(candidateProblems(rows, drafts)).toEqual([])
    expect(linesFrom(rows, drafts)).toEqual([{ item_code: 'OPMS-GOLD-3CT', cost: 4.4, case_pack: 6, moq: 12, vendor_sku: 'GC-OPMS-3' }])
    // the server refuses the same things
    await expect(mockPurchasing.add_vendor_items('SUP-GULF', [])).rejects.toThrow(/No items to add/)
    await expect(
      mockPurchasing.add_vendor_items('SUP-GULF', [{ item_code: 'OPMS-GOLD-3CT' }, { item_code: 'OPMS-GOLD-3CT' }])
    ).rejects.toThrow(/on the sheet twice/)
  })

  it('attaches them and hands back the buying rows that are no longer blocked', async () => {
    setActivePinia(createPinia())
    useWarehouseStore().me = { ...ME }
    const store = usePurchasingStore()
    await store.loadSuggestions()
    const out = await store.addVendorItems('SUP-GULF', [
      { item_code: 'OPMS-GOLD-3CT', cost: 4.4, case_pack: 6, moq: 12, vendor_sku: 'GC-OPMS-3' },
      { item_code: 'LM-MO20K-WM', cost: 11.8, case_pack: 12 }
    ])
    expect(out!.count).toBe(2)
    expect(out!.suggestions.map((s) => s.item_code)).toEqual(['OPMS-GOLD-3CT'])
    expect(out!.suggestions[0].orderable).toBe(true)
    expect(store.openSuggestions.find((s) => s.item_code === 'OPMS-GOLD-3CT')!.orderable).toBe(true)
    expect(addedCopy(out!.count, 1, 'Gulf Coast Distributing')).toBe('2 items added to Gulf Coast Distributing — 1 buying row can be ordered now')
    expect(addedCopy(1, 0, 'Gulf Coast Distributing')).toBe('1 item added to Gulf Coast Distributing')
    expect(addCopy(0, 'Gulf Coast Distributing')).toBe('Nothing picked')
    expect(addCopy(3, 'Gulf Coast Distributing')).toBe('Add 3 items to Gulf Coast Distributing')
  })
})

// =============================================================================================
// the store's own housekeeping
// =============================================================================================
describe('the pricing store', () => {
  it('surfaces a refusal without throwing, and clears it on demand', async () => {
    const pricing = desk()
    expect(await pricing.loadBoard('NOT-A-THING')).toBeNull()
    expect(pricing.error).toMatch(/does not exist/)
    pricing.clearError()
    expect(pricing.error).toBeNull()
    expect(await pricing.loadBoard('')).toBeNull()
    expect(pricing.error).toMatch(/Choose an item/)
  })

  it('refuses every write to a user who may not price, without calling the server', async () => {
    __resetMockPurchasing()
    setActivePinia(createPinia())
    useWarehouseStore().me = { ...ME, warehouse_admin: false, supply_unrestricted: false, roles: ['AWANZ Store Manager'], boutique: 'OK-BIX' }
    const pricing = usePricingStore()
    expect(pricing.allowed).toBe(false)
    expect(await pricing.setMarkup(80)).toBeNull()
    expect(pricing.error).toMatch(/head office/)
    expect(await pricing.setWholesale('GB-PULSE-15K-BLUE', 12)).toBeNull()
    expect(await pricing.decide('PCR-00003', 'Approve')).toBeNull()
    // the markup is untouched — the gate came before the call
    expect((await mockPricing.wholesale_settings()).markup_pct).toBe(50)
  })

  it('re-prices what is on screen when the chain rule moves', async () => {
    const pricing = desk()
    await pricing.loadWholesale(['GB-PULSE-15K-BLUE'])
    await pricing.loadBoard('GB-PULSE-15K-BLUE')
    expect(pricing.wholesale[0].wholesale).toBe(14.01)
    await pricing.setMarkup(100)
    expect(pricing.wholesale[0].wholesale).toBe(18.68)
    expect(pricing.board!.wholesale).toBe(18.68)
    // every store's margin fell with it — they pay us more for the same shelf price
    expect(pricing.board!.stores.find((s) => s.boutique === 'HOU-MTR')!.margin_pct).toBe(25.3)
    expect(pricing.notice).toMatch(/markup is now 100%/)
  })

  it('types a wholesale price on one item and puts it back on the rule', async () => {
    const pricing = desk()
    await pricing.loadWholesale(['GB-PULSE-15K-BLUE'])
    await pricing.setWholesale('GB-PULSE-15K-BLUE', 12.5)
    expect(pricing.wholesale[0]).toMatchObject({ override: 12.5, wholesale: 12.5, source: 'override' })
    expect(pricing.notice).toMatch(/priced by hand at 12.5/)
    await pricing.setWholesale('GB-PULSE-15K-BLUE', null)
    expect(pricing.wholesale[0]).toMatchObject({ override: null, wholesale: 14.01, source: 'markup' })
    expect(pricing.notice).toMatch(/back on the 50% chain rule/)
  })
})

// a compile-time reminder that the statement row type is what the totals helper consumes
const _shape: StatementStore = statementTotals([])
void _shape
