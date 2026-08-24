import { describe, expect, it } from 'vitest'
import { EposBuilder, buildReceiptXml, escapeXml, lr, wrap, COLS } from '@/printer/epos'
import type { ReceiptSnapshot } from '@/db'

const snap: ReceiptSnapshot = {
  boutique: 'CHI-OAK',
  boutique_name: 'AWANZ Oak Street',
  address_line: '118 East Oak Street',
  city: 'Chicago, IL 60611',
  phone: '+1 312 555 0118',
  associate_name: 'Claire Dubois',
  customer_name: 'Eleanor Whitmore',
  customer_tier: 'Gold',
  lines: [
    { item_code: 'RG-SOL-001', item_name: 'Solitaire Round 1.02ct', qty: 1, rate: 12400, amount: 12400, serial_no: 'CHI00101', certificate_no: 'GIA-2200000000' },
    { item_code: 'AC-CLN-036', item_name: 'Jewelry Cleaning Kit & Cloth <premium>', qty: 2, rate: 45, amount: 90 }
  ],
  net_total: 12490,
  discount: 0,
  total_taxes: 1280.23,
  tax_rate: 10.25,
  loyalty_amount: 0,
  loyalty_points_redeemed: 0,
  grand_total: 13770.23,
  payments: [{ mode_of_payment: 'Card', amount: 13770.23, card_brand: 'Visa', last4: '4242', approval: 'A1B2C3' }],
  points_earned: 12490,
  points_balance: 20000,
  currency: 'USD'
}

describe('ePOS helpers', () => {
  it('escapes XML special characters', () => {
    expect(escapeXml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;')
  })
  it('justifies left/right into exactly 48 columns', () => {
    const s = lr('TOTAL', '13,770.23')
    expect(s.length).toBe(COLS)
    expect(s.startsWith('TOTAL')).toBe(true)
    expect(s.endsWith('13,770.23')).toBe(true)
  })
  it('truncates overly long left labels instead of overflowing', () => {
    const s = lr('X'.repeat(80), '1.00')
    expect(s.length).toBe(COLS)
    expect(s.endsWith(' 1.00')).toBe(true)
  })
  it('wraps text at column width', () => {
    const lines = wrap('the quick brown fox jumps over the lazy dog '.repeat(3).trim(), 20)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20)
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog '.repeat(3).trim())
  })
})

describe('EposBuilder', () => {
  it('emits a SOAP envelope with epos-print namespace', () => {
    const xml = new EposBuilder().text('Hi', { align: 'center', bold: true }).feed(2).cut().build()
    expect(xml).toContain('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">')
    expect(xml).toContain('<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">')
    expect(xml).toContain('<text align="center" em="true">Hi&#10;</text>')
    expect(xml).toContain('<feed line="2"/>')
    expect(xml).toContain('<cut type="feed"/>')
    expect(xml.endsWith('</epos-print></s:Body></s:Envelope>')).toBe(true)
  })
  it('drawer pulse is only emitted when requested', () => {
    expect(new EposBuilder().cut().build()).not.toContain('<pulse')
    expect(new EposBuilder().drawer().build()).toContain('<pulse drawer="drawer_1"')
  })
})

describe('buildReceiptXml', () => {
  const xml = buildReceiptXml(snap, { invoice_name: 'SINV-CHI-OAK-00001', offline_uuid: 'abc-123', posting_datetime: '2026-08-22T14:30:00Z', openDrawer: false })

  it('contains every SPEC receipt section', () => {
    expect(xml).toContain('AWANZ')
    expect(xml).toContain('AWANZ OAK STREET')
    expect(xml).toContain('118 East Oak Street')
    expect(xml).toContain('+1 312 555 0118')
    expect(xml).toContain('SINV-CHI-OAK-00001')
    expect(xml).toContain('Claire Dubois')
    expect(xml).toContain('Eleanor Whitmore / GOLD')
    expect(xml).toContain('SERIAL CHI00101')
    expect(xml).toContain('CERT GIA-2200000000')
    expect(xml).toContain('TAX 10.25%')
    expect(xml).toContain('13,770.23')
    expect(xml).toContain('CARD Visa **** 4242')
    expect(xml).toContain('APPROVAL')
    expect(xml).toContain('A1B2C3')
    expect(xml).toContain('POINTS EARNED')
    expect(xml).toContain('SIGNATURE')
  })
  it('escapes item names', () => {
    expect(xml).toContain('&amp; CLOTH &lt;PREMIUM&gt;')
    expect(xml).not.toContain('<PREMIUM>')
  })
  it('omits signature line under 10,000', () => {
    const small = buildReceiptXml({ ...snap, grand_total: 999 }, { offline_uuid: 'x', posting_datetime: '2026-08-22T14:30:00Z' })
    expect(small).not.toContain('SIGNATURE')
    expect(small).toContain('PENDING X')
  })
  it('opens the drawer only on request', () => {
    expect(xml).not.toContain('<pulse')
    const cash = buildReceiptXml(snap, { offline_uuid: 'x', posting_datetime: '2026-08-22T14:30:00Z', openDrawer: true })
    expect(cash).toContain('<pulse')
  })
  it('is well-formed XML', () => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    expect(doc.getElementsByTagName('parsererror').length).toBe(0)
    expect(doc.getElementsByTagName('text').length).toBeGreaterThan(20)
  })
})
