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

/** Line value before any discount, rounded to cents like ERPNext's `amount`. */
export function lineGross(qty: number, rate: number): number {
  return round(qty * rate)
}

/**
 * What a discounted line is actually worth, to the cent.
 *
 * v0.8 POS D1 — a Sales Invoice Item stores the **net unit rate** at the currency's precision and
 * derives the line amount from it (`amount = flt(rate * qty, 2)`), so a whole-line discount that
 * does not divide into whole cents per unit cannot be booked as asked: 2 x $10.50 less $3.69 is a
 * unit rate of $8.655, which the ledger rounds to $8.66 and books as $17.32 — while the device
 * used to display and charge $17.31. Round the unit rate here, exactly as ERPNext does, so the
 * line the customer is shown is the line that gets booked.
 */
export function lineNet(qty: number, rate: number, discountAmount = 0): number {
  const amount = lineGross(qty, rate)
  const disc = Math.min(round(discountAmount || 0), amount)
  if (!disc) return amount
  if (!qty) return 0
  const unitNet = Math.max(0, round(rate - disc / qty))
  return round(unitNet * qty)
}

/**
 * Pure totals math shared by cart store, mock server and tests.
 *
 * Tax applies to a line only when `taxable` (Item.maison_taxable) and is computed on the
 * discounted line amount.
 *
 * --- v0.8 POS D1 — the device must compute the tax the way the server will ---
 * The boutique's tax template is a single *On Net Total* row, and ERPNext accumulates
 * `net_amount x rate` **unrounded** across the lines and rounds the row once, at the end
 * (`erpnext/controllers/taxes_and_totals.py::calculate_taxes` -> `round_off_totals`). Rounding
 * each line's tax and summing those — which this function used to do — is not the same number:
 * `sum(round(net_i x r)) != round(sum(net_i) x r)`. QA measured a >= 1c disagreement on 25.6 % of
 * two-line baskets and 54.9 % of eight-line baskets, and the server then refused the sale *after*
 * the customer had paid. So: one rate, applied once to the taxable total, rounded once — with
 * `round()`'s half-away-from-zero, which is the Commercial Rounding the site is pinned to.
 * Per-line nets stay rounded to cents because ERPNext rounds `net_amount` per row too.
 * --- end v0.8 POS D1 ---
 */
export function computeTotals(lines: TotalsLine[], taxRate: number, loyaltyPoints = 0, conversionFactor = 0): Totals {
  let gross = 0
  let discount = 0
  let taxable_total = 0
  for (const l of lines) {
    const amount = lineGross(l.qty, l.rate)
    const net = lineNet(l.qty, l.rate, l.discount_amount)
    gross = round(gross + amount)
    discount = round(discount + round(amount - net))
    if (l.taxable) taxable_total = round(taxable_total + net)
  }
  const total_taxes = round((taxable_total * taxRate) / 100)
  const net_total = round(gross - discount)
  const loyalty_amount = Math.min(round(loyaltyPoints * conversionFactor), round(net_total + total_taxes))
  const grand_total = round(net_total + total_taxes - loyalty_amount)
  return { gross, discount, net_total, taxable_total, total_taxes, loyalty_amount, grand_total }
}
