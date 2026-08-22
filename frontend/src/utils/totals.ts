import { round } from './money'

export interface TotalsLine {
  qty: number
  rate: number
  discount_amount?: number
  taxable: boolean
}

export interface Totals {
  /** sum of qty*rate before discounts */
  gross: number
  discount: number
  /** gross - discount */
  net_total: number
  taxable_total: number
  total_taxes: number
  /** loyalty value deducted from the payable amount */
  loyalty_amount: number
  /** net + taxes - loyalty, rounded to cents */
  grand_total: number
}

/**
 * Pure totals math shared by cart store, mock server and tests.
 * Tax is applied per line only when `taxable` (Item.maison_taxable) and is computed on
 * the discounted line amount; each line's tax is rounded to cents like ERPNext does per row.
 */
export function computeTotals(lines: TotalsLine[], taxRate: number, loyaltyPoints = 0, conversionFactor = 0): Totals {
  let gross = 0
  let discount = 0
  let taxable_total = 0
  let total_taxes = 0
  for (const l of lines) {
    const amount = round(l.qty * l.rate)
    const disc = Math.min(round(l.discount_amount || 0), amount)
    const net = round(amount - disc)
    gross = round(gross + amount)
    discount = round(discount + disc)
    if (l.taxable) {
      taxable_total = round(taxable_total + net)
      total_taxes = round(total_taxes + round((net * taxRate) / 100))
    }
  }
  const net_total = round(gross - discount)
  const loyalty_amount = Math.min(round(loyaltyPoints * conversionFactor), round(net_total + total_taxes))
  const grand_total = round(net_total + total_taxes - loyalty_amount)
  return { gross, discount, net_total, taxable_total, total_taxes, loyalty_amount, grand_total }
}
