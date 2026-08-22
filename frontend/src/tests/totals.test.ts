import { describe, expect, it } from 'vitest'
import { computeTotals } from '@/utils/totals'
import { round } from '@/utils/money'

describe('round', () => {
  it('rounds half away from zero and tolerates float noise', () => {
    expect(round(1.005)).toBe(1.01)
    expect(round(2.675)).toBe(2.68)
    expect(round(-1.005)).toBe(-1.01)
    expect(round(0.1 + 0.2)).toBe(0.3)
  })
})

describe('computeTotals', () => {
  const TAX = 10.25

  it('applies tax only to taxable lines', () => {
    const t = computeTotals(
      [
        { qty: 1, rate: 12400, taxable: true },
        { qty: 2, rate: 500, taxable: false } // gift cards
      ],
      TAX
    )
    expect(t.gross).toBe(13400)
    expect(t.net_total).toBe(13400)
    expect(t.taxable_total).toBe(12400)
    expect(t.total_taxes).toBe(1271) // 12400 * 10.25%
    expect(t.grand_total).toBe(14671)
  })

  it('computes tax on the discounted amount and rounds per line', () => {
    const t = computeTotals(
      [
        { qty: 1, rate: 1850, discount_amount: 185, taxable: true }, // 1665 * 10.25% = 170.6625 -> 170.66
        { qty: 3, rate: 45, taxable: true } // 135 * 10.25% = 13.8375 -> 13.84
      ],
      TAX
    )
    expect(t.discount).toBe(185)
    expect(t.net_total).toBe(1800)
    expect(t.total_taxes).toBe(round(170.66 + 13.84))
    expect(t.grand_total).toBe(round(1800 + 184.5))
  })

  it('caps discounts at the line amount', () => {
    const t = computeTotals([{ qty: 1, rate: 100, discount_amount: 500, taxable: true }], TAX)
    expect(t.discount).toBe(100)
    expect(t.net_total).toBe(0)
    expect(t.grand_total).toBe(0)
  })

  it('deducts loyalty value and never goes below zero', () => {
    const t = computeTotals([{ qty: 1, rate: 980, taxable: true }], TAX, 5000, 0.01)
    // 980 + 100.45 = 1080.45 ; loyalty 50.00
    expect(t.total_taxes).toBe(100.45)
    expect(t.loyalty_amount).toBe(50)
    expect(t.grand_total).toBe(1030.45)

    const all = computeTotals([{ qty: 1, rate: 10, taxable: false }], TAX, 100000, 0.01)
    expect(all.loyalty_amount).toBe(10)
    expect(all.grand_total).toBe(0)
  })

  it('is stable for large luxury tickets', () => {
    const t = computeTotals([{ qty: 1, rate: 240000, taxable: true }, { qty: 1, rate: 145000, taxable: true }], TAX)
    expect(t.net_total).toBe(385000)
    expect(t.total_taxes).toBe(39462.5)
    expect(t.grand_total).toBe(424462.5)
  })

  it('returns zeros for an empty basket', () => {
    const t = computeTotals([], TAX)
    expect(t.grand_total).toBe(0)
    expect(t.total_taxes).toBe(0)
  })
})
