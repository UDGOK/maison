/**
 * Pure return / exchange math shared by the Returns and Exchange screens, the mock server and
 * the vitest suite. Mirrors `maison_pos/api/returns.py`: a credit note carries the selected
 * lines at their original rate (discounts kept proportionally), tax per line only when the
 * item is taxable, and an exchange settles only the difference between credit and new sale.
 */
import { round } from '@/utils/money'

export interface ReturnLineInput {
  rate: number
  /** quantity being returned (positive) */
  qty: number
  /** original line discount per unit, if any */
  discount_amount?: number
  taxable?: boolean | 0 | 1
}

export interface ReturnTotals {
  net: number
  tax: number
  /** credit incl. tax (positive number) */
  total: number
}

export function returnLineNet(line: ReturnLineInput): number {
  const unit = round(line.rate - (line.discount_amount || 0))
  return round(Math.max(0, unit) * line.qty)
}

/** Credit for the selected lines at `taxRate` %. */
export function computeReturnTotals(lines: ReturnLineInput[], taxRate: number): ReturnTotals {
  let net = 0
  let tax = 0
  for (const l of lines) {
    if (!l.qty || l.qty <= 0) continue
    const n = returnLineNet(l)
    net = round(net + n)
    if (l.taxable === undefined || l.taxable) tax = round(tax + round((n * taxRate) / 100))
  }
  return { net, tax, total: round(net + tax) }
}

export interface ExchangeSettlement {
  credit: number
  new_total: number
  /** part of the credit consumed by the new sale */
  applied: number
  /** > 0: client pays; < 0: client is refunded |difference| */
  difference: number
  /** amount to collect from the client (0 when difference <= 0) */
  to_collect: number
  /** amount to refund to the client (0 when difference >= 0) */
  to_refund: number
}

export function computeExchange(credit: number, newTotal: number): ExchangeSettlement {
  const c = round(Math.max(0, credit))
  const n = round(Math.max(0, newTotal))
  const applied = round(Math.min(c, n))
  const difference = round(n - c)
  return {
    credit: c,
    new_total: n,
    applied,
    difference,
    to_collect: difference > 0 ? difference : 0,
    to_refund: difference < 0 ? round(-difference) : 0
  }
}

export interface ManagerGate {
  required: boolean
  reason: 'threshold' | 'window' | null
}

/**
 * Manager PIN rule (same as the backend): outside the policy window, or credit above the
 * threshold (a threshold of 0 means "always"). Managers approve implicitly.
 */
export function managerRequired(args: {
  credit: number
  threshold: number
  daysSince: number
  windowDays: number
  isManager?: boolean
}): ManagerGate {
  if (args.isManager) return { required: false, reason: null }
  if (args.daysSince > args.windowDays) return { required: true, reason: 'window' }
  if (args.credit > args.threshold) return { required: true, reason: 'threshold' }
  return { required: false, reason: null }
}

/** Serials still returnable on a line after previous credit notes. */
export function returnableSerials(sold: string[], returned: string[]): string[] {
  const done = new Set(returned)
  return sold.filter((s) => !done.has(s))
}

/** Clamp a requested return qty to what is left on the line (serialized lines: number of serials picked). */
export function clampReturnQty(requested: number, returnable: number, pickedSerials?: string[]): number {
  if (pickedSerials) return Math.min(pickedSerials.length, returnable)
  if (!Number.isFinite(requested) || requested < 0) return 0
  return Math.min(Math.floor(requested), Math.floor(returnable))
}
