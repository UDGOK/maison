/**
 * QR payload builders + parsers. Shared by the scanner, the client card, the receipt and
 * (by contract) the server: `MC:<customer_id>` on loyalty cards, `INV:<name>` on invoices,
 * `<base>/r/<token>` on receipts.
 */

export const CLIENT_QR_PREFIX = 'MC:'
export const INVOICE_QR_PREFIX = 'INV:'

export function clientQr(customerId: string): string {
  return CLIENT_QR_PREFIX + customerId.trim()
}

export function invoiceQr(invoiceName: string): string {
  return INVOICE_QR_PREFIX + invoiceName.trim()
}

/** `${base}/r/${token}` with a single slash regardless of a trailing slash on base. */
export function receiptUrl(base: string, token: string): string {
  return `${(base || '').replace(/\/+$/, '')}/r/${encodeURIComponent(token)}`
}

export type ScanPayload =
  | { kind: 'client'; customer: string }
  | { kind: 'invoice'; invoice: string }
  | { kind: 'receipt'; token: string; url: string }
  | { kind: 'code'; code: string }

/** Classify a raw scanned string. Product codes fall through as `code` for the catalogue lookup. */
export function parsePayload(raw: string): ScanPayload {
  const s = raw.trim()
  const up = s.toUpperCase()
  if (up.startsWith(CLIENT_QR_PREFIX) && s.length > CLIENT_QR_PREFIX.length) return { kind: 'client', customer: s.slice(CLIENT_QR_PREFIX.length).trim() }
  if (up.startsWith(INVOICE_QR_PREFIX) && s.length > INVOICE_QR_PREFIX.length) return { kind: 'invoice', invoice: s.slice(INVOICE_QR_PREFIX.length).trim() }
  const m = s.match(/^https?:\/\/[^\s]+\/r\/([A-Za-z0-9_-]{8,64})\/?$/)
  if (m) return { kind: 'receipt', token: m[1], url: s }
  return { kind: 'code', code: s }
}
