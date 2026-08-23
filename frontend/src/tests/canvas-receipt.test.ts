import { describe, expect, it } from 'vitest'
import {
  READER_COLS_PX,
  READER_PAPER_WIDTH,
  buildReceiptLayout,
  fitPair,
  textWidth,
  wrapPx
} from '@/printer/canvas'
import type { ReceiptSnapshot } from '@/db'

const snap: ReceiptSnapshot = {
  boutique: 'CHI-OAK',
  boutique_name: 'Maison Oak Street',
  address_line: '106 East Oak Street',
  city: 'Chicago, IL 60611',
  phone: '+1 312 555 0172',
  associate_name: 'Marcus Lee',
  customer_name: 'Amara Okonkwo',
  customer_tier: 'Connoisseur',
  customer_client_number: 'MC482910',
  receipt_qr_base_url: 'https://maison.example',
  lines: [
    {
      item_code: 'WT-CHR-026',
      item_name: 'Chronograph 41mm Steel with a very long descriptive name',
      qty: 1,
      rate: 8500,
      amount: 8500,
      serial_no: 'WT-CHR-026-CHI-001'
    },
    { item_code: 'AC-CLN-040', item_name: 'Jewelry Cleaning Kit', qty: 2, rate: 45, amount: 90 }
  ],
  net_total: 8590,
  discount: 0,
  total_taxes: 880.48,
  tax_rate: 10.25,
  loyalty_amount: 0,
  loyalty_points_redeemed: 0,
  grand_total: 9470.48,
  payments: [
    { mode_of_payment: 'Card', amount: 9470.48, card_brand: 'Visa', last4: '4242', approval: 'A1B2C3' }
  ],
  points_earned: 85,
  points_balance: 1200,
  currency: 'USD'
}

describe('384-px reader receipt layout model', () => {
  it('is exactly 384 px wide and every run stays inside the printable margin', () => {
    const l = buildReceiptLayout(snap, {
      invoice_name: 'SINV-CHI-OAK-00001',
      offline_uuid: 'u',
      posting_datetime: '2026-08-22T15:20:00Z',
      receipt_token: 'tok',
      receipt_qr_enabled: true,
      receipt_qr_base_url: 'https://maison.example'
    })
    expect(l.width).toBe(READER_PAPER_WIDTH)
    expect(l.height).toBeGreaterThan(600)
    expect(l.runs.length).toBeGreaterThan(20)
    for (const r of l.runs) {
      if (r.kind !== 'text') continue
      const w =
        textWidth(r.text || '', r.size || 20, r.bold) +
        (r.right ? textWidth(r.right, r.size || 20) + (r.size || 20) : 0)
      expect(w).toBeLessThanOrEqual(READER_COLS_PX)
    }
    // runs are laid out top-down without overlap
    for (let i = 1; i < l.runs.length; i++)
      expect(l.runs[i].y).toBeGreaterThanOrEqual(l.runs[i - 1].y + l.runs[i - 1].h)
    expect(l.runs[l.runs.length - 1].y + l.runs[l.runs.length - 1].h).toBe(l.height)
  })
  it('wraps long item names and truncates left text to fit the amount', () => {
    const lines = wrapPx('Chronograph 41mm Steel with a very long descriptive name', 20)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((x) => textWidth(x, 20) <= READER_COLS_PX)).toBe(true)
    const fitted = fitPair('A'.repeat(80), '9,470.48', 20)
    expect(fitted.endsWith('…')).toBe(true)
    expect(textWidth(fitted, 20) + textWidth('9,470.48', 20) + 12).toBeLessThanOrEqual(READER_COLS_PX)
  })
  it('carries header, serial, card tender, QR and the signature block for ≥ 10 000', () => {
    const l = buildReceiptLayout(
      { ...snap, grand_total: 12000 },
      {
        offline_uuid: 'u',
        posting_datetime: '2026-08-22T15:20:00Z',
        receipt_token: 'tok',
        receipt_qr_enabled: true,
        receipt_qr_base_url: 'https://maison.example'
      }
    )
    const texts = l.runs
      .filter((r) => r.kind === 'text')
      .map((r) => `${r.text}${r.right ? ' ' + r.right : ''}`)
    // v0.6 N — the header is brand-driven (`snap.brand.wordmark`); with no brand on the snapshot
    // it falls back to the default tenant wordmark rather than a hard-coded "MAISON".
    expect(texts[0]).toBe('CLOUDCHASERZ')
    expect(texts.some((t) => t.includes('WT-CHR-026-CHI-001'))).toBe(true)
    expect(texts.some((t) => t.includes('VISA •••• 4242'))).toBe(true)
    expect(texts.some((t) => t.startsWith('TOTAL') && t.includes('12,000.00'))).toBe(true)
    expect(texts).toContain('CLIENT SIGNATURE')
    const qr = l.runs.find((r) => r.kind === 'qr')
    expect(qr?.payload).toBe('https://maison.example/r/tok')
    expect(qr?.side).toBeLessThanOrEqual(READER_COLS_PX)
  })
  it('v0.6 N — header and thank-you line come from the brand tokens on the snapshot', () => {
    const branded = buildReceiptLayout(
      { ...snap, brand: { wordmark: 'MAISON', brand_name: 'Maison', thanks: 'Thank you for visiting Maison' } },
      { offline_uuid: 'u', posting_datetime: '2026-08-22T15:20:00Z' }
    )
    const texts = branded.runs.filter((r) => r.kind === 'text').map((r) => r.text ?? '')
    expect(texts[0]).toBe('MAISON')
    expect(texts.some((t) => t === 'Thank you for visiting Maison.')).toBe(true)
    expect(texts.some((t) => t.includes('CloudChaserz'))).toBe(false)
  })
  it('credit notes get the RETURN banner, CREDIT total and store-credit line; no QR when disabled', () => {
    const l = buildReceiptLayout(
      { ...snap, grand_total: -9470.48, payments: [] },
      {
        offline_uuid: 'cn',
        posting_datetime: '2026-08-22T15:20:00Z',
        kind: 'return',
        return_against: 'SINV-1',
        store_credit: 9470.48,
        receipt_qr_enabled: false
      }
    )
    const texts = l.runs
      .filter((r) => r.kind === 'text')
      .map((r) => `${r.text}${r.right ? ' ' + r.right : ''}`)
    expect(texts).toContain('RETURN · CREDIT NOTE')
    expect(texts.some((t) => t.startsWith('ORIGINAL SALE') && t.includes('SINV-1'))).toBe(true)
    expect(texts.some((t) => t.startsWith('CREDIT') && t.includes('9,470.48'))).toBe(true)
    expect(texts.some((t) => t.startsWith('STORE CREDIT'))).toBe(true)
    expect(l.runs.some((r) => r.kind === 'qr')).toBe(false)
  })
})
