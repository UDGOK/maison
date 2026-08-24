/**
 * v0.8 POS D1 — the number on the screen must be the number the server books.
 *
 * The boutique tax template is a single *On Net Total* row. ERPNext accumulates `net_amount x rate`
 * **unrounded** across the item rows and rounds the tax row once, at the end
 * (`erpnext/controllers/taxes_and_totals.py::calculate_taxes` -> `round_off_totals`), with the
 * site's Commercial Rounding (half away from zero). `serverTaxModel` below is that behaviour.
 *
 * The device used to round each line's tax and sum those instead. QA measured a >= 1c disagreement
 * on 25.6 % of two-line baskets and 54.9 % of eight-line baskets; the server then refused the sale
 * *after* the customer had paid and no invoice existed. These fuzz over many random baskets
 * (multi-line, mixed taxable / non-taxable, discounts, quantities) and demand parity to the cent
 * on every single one.
 */
import { describe, expect, it } from 'vitest'
import { computeTotals, type TotalsLine } from '@/utils/totals'
import { computeReturnTotals, type ReturnLineInput } from '@/returns/math'
import { round } from '@/utils/money'

/**
 * What a Sales Invoice Item books for one line: ERPNext stores the discounted **unit rate** at the
 * currency's precision and derives `amount = flt(rate x qty, 2)` from it.
 */
function serverLineNet(l: TotalsLine): number {
  const amount = round(l.qty * l.rate)
  const disc = Math.min(round(l.discount_amount || 0), amount)
  if (!disc) return amount
  return round(Math.max(0, round(l.rate - disc / l.qty)) * l.qty)
}

/** What ERPNext books: one rate, applied once to the taxable net, rounded once. */
function serverTaxModel(lines: TotalsLine[], rate: number) {
  let net = 0
  let taxableNet = 0
  let taxRaw = 0
  for (const l of lines) {
    const n = serverLineNet(l)
    net = round(net + n)
    if (l.taxable) {
      taxableNet = round(taxableNet + n)
      taxRaw += (n * rate) / 100 // accumulated unrounded, exactly like `tax.tax_amount +=`
    }
  }
  const tax = round(taxRaw)
  return { net_total: net, total_taxes: tax, grand_total: round(net + tax) }
}

/** The defect: rounding each line's tax before summing. Kept so the fuzz proves it diverges. */
function perLineTaxModel(lines: TotalsLine[], rate: number): number {
  let tax = 0
  for (const l of lines) {
    const n = serverLineNet(l)
    if (l.taxable) tax = round(tax + round((n * rate) / 100))
  }
  return tax
}

/** Deterministic PRNG so a failure is always reproducible from the seed in the message. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function basket(rand: () => number, lineCount: number): TotalsLine[] {
  const lines: TotalsLine[] = []
  for (let i = 0; i < lineCount; i++) {
    // real CloudChaserz prices: $0.99 – $249.99 in cents, plus the odd big-ticket item
    const rate = round(0.99 + rand() * (rand() < 0.9 ? 60 : 250))
    const qty = 1 + Math.floor(rand() * 3)
    const line: TotalsLine = { qty, rate, taxable: rand() > 0.15 }
    const roll = rand()
    if (roll < 0.2) line.discount_amount = round(qty * rate * (0.05 + rand() * 0.4)) // % off
    else if (roll < 0.3) line.discount_amount = round(rand() * 5) // $ off
    lines.push(line)
  }
  return lines
}

// the store templates in the two seeds, plus a rate with a nastier remainder
const RATES = [8.25, 8.875, 10.25, 7, 6.375]

describe('v0.8 POS D1 — device tax == server tax', () => {
  it('matches ERPNext to the cent on 4,000 random baskets', () => {
    let checked = 0
    for (const rate of RATES) {
      for (let lineCount = 1; lineCount <= 8; lineCount++) {
        for (let seed = 1; seed <= 100; seed++) {
          const rand = rng(seed * 7919 + lineCount * 31 + Math.round(rate * 1000))
          const lines = basket(rand, lineCount)
          const device = computeTotals(lines, rate)
          const server = serverTaxModel(lines, rate)
          const where = `rate=${rate} lines=${lineCount} seed=${seed}`
          expect(device.total_taxes, `tax ${where}`).toBe(server.total_taxes)
          expect(device.net_total, `net ${where}`).toBe(server.net_total)
          expect(device.grand_total, `total ${where}`).toBe(server.grand_total)
          checked++
        }
      }
    }
    expect(checked).toBe(RATES.length * 8 * 100)
  })

  it('would have failed before the fix — the per-line model really does diverge', () => {
    // guards the test itself: if this ever stops finding divergences the fuzz proves nothing
    let diverged = 0
    let twoLine = 0
    let twoLineDiverged = 0
    for (let seed = 1; seed <= 400; seed++) {
      for (const lineCount of [2, 8]) {
        const lines = basket(rng(seed * 104729 + lineCount), lineCount)
        const correct = serverTaxModel(lines, 8.25).total_taxes
        if (perLineTaxModel(lines, 8.25) !== correct) {
          diverged++
          if (lineCount === 2) twoLineDiverged++
        }
        if (lineCount === 2) twoLine++
      }
    }
    expect(diverged).toBeGreaterThan(0)
    // QA measured ~25.6 % of two-line baskets on the live price list; anything in that region
    // confirms the generator is producing realistic money, not a degenerate corner.
    expect(twoLineDiverged / twoLine).toBeGreaterThan(0.1)
  })

  it('keeps mixed taxable / non-taxable baskets exact', () => {
    const lines: TotalsLine[] = [
      { qty: 1, rate: 12.99, taxable: true },
      { qty: 2, rate: 16.99, taxable: true },
      { qty: 1, rate: 25, taxable: false } // gift card
    ]
    const t = computeTotals(lines, 8.25)
    expect(t.taxable_total).toBe(46.97)
    expect(t.total_taxes).toBe(3.88) // 46.97 * 8.25 % = 3.875025 -> 3.88, not 1.07 + 2.80 = 3.87
    expect(t.net_total).toBe(71.97)
    expect(t.grand_total).toBe(75.85)
  })

  it('reproduces the exact basket QA rang up (HKA-012 + 2 x HKA-013)', () => {
    // POS said 3.87 / 50.84; the server booked 3.88 / 50.85 and refused the payment
    const t = computeTotals(
      [
        { qty: 1, rate: 12.99, taxable: true },
        { qty: 2, rate: 16.99, taxable: true }
      ],
      8.25
    )
    expect(t.net_total).toBe(46.97)
    expect(t.total_taxes).toBe(3.88)
    expect(t.grand_total).toBe(50.85)
  })

  it('reproduces the card basket QA rang up (HKA-017 + ACC-002)', () => {
    // POS said 0.73 / 9.51 and charged the card; the server said "Card payments exceed the total"
    const t = computeTotals(
      [
        { qty: 1, rate: 6.99, taxable: true },
        { qty: 1, rate: 1.79, taxable: true }
      ],
      8.25
    )
    expect(t.net_total).toBe(8.78)
    expect(t.total_taxes).toBe(0.72)
    expect(t.grand_total).toBe(9.5)
  })
})

describe('v0.8 POS D1 — refund credit == credit note', () => {
  it('matches the server on 2,000 random multi-line returns', () => {
    for (const rate of RATES) {
      for (let lineCount = 1; lineCount <= 8; lineCount++) {
        for (let seed = 1; seed <= 50; seed++) {
          const rand = rng(seed * 6151 + lineCount * 17 + Math.round(rate * 100))
          const lines: ReturnLineInput[] = basket(rand, lineCount).map((l) => ({
            rate: l.rate,
            qty: l.qty,
            // the credit note keeps the discount proportionally, i.e. per unit
            discount_amount: l.discount_amount ? round(l.discount_amount / l.qty) : 0,
            taxable: l.taxable
          }))
          const device = computeReturnTotals(lines, rate)
          const server = serverTaxModel(
            lines.map((l) => ({ qty: l.qty, rate: Math.max(0, round(l.rate - (l.discount_amount || 0))), taxable: !!l.taxable })),
            rate
          )
          const where = `rate=${rate} lines=${lineCount} seed=${seed}`
          expect(device.tax, `tax ${where}`).toBe(server.total_taxes)
          expect(device.total, `credit ${where}`).toBe(server.grand_total)
        }
      }
    }
  })
})
