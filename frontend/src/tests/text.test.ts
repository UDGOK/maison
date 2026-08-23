import { describe, it, expect } from 'vitest'
import { plural, storeShortName, stripHtml } from '@/utils/text'

describe('stripHtml', () => {
  it('leaves plain text alone', () => {
    expect(stripHtml('1.0 units of Item AC-011 needed')).toBe('1.0 units of Item AC-011 needed')
  })
  it('strips ERPNext HTML error markup into lines', () => {
    const html =
      'Since the stock reconciliation exists for future dates, cancel it first:<br><ul><li>TP-007 in <a href="/app/stock-entry/MAT-STE-1">MAT-STE-1</a></li><li>B &amp; C</li></ul>'
    expect(stripHtml(html)).toBe('Since the stock reconciliation exists for future dates, cancel it first:\n• TP-007 in MAT-STE-1\n• B & C')
  })
  it('handles null/undefined', () => {
    expect(stripHtml(undefined)).toBe('')
  })
})

// --- v0.6 R -----------------------------------------------------------------------------------
describe('storeShortName', () => {
  it('drops the repeated brand prefix so the distinguishing word survives a tight column', () => {
    expect(storeShortName('CloudChaserz Montrose', 'CloudChaserz')).toBe('Montrose')
    expect(storeShortName('CloudChaserz Broken Arrow', 'CloudChaserz')).toBe('Broken Arrow')
    expect(storeShortName('CloudChaserz — Yale', 'CloudChaserz')).toBe('Yale')
  })
  it('keeps names that do not start with the brand, and never returns empty', () => {
    expect(storeShortName('Montrose', 'CloudChaserz')).toBe('Montrose')
    expect(storeShortName('CloudChaserz', 'CloudChaserz')).toBe('CloudChaserz')
    expect(storeShortName('Maison Chicago Oak Street', 'Maison')).toBe('Chicago Oak Street')
    expect(storeShortName('', 'CloudChaserz')).toBe('')
  })
  it('is case-insensitive about the prefix', () => {
    expect(storeShortName('CLOUDCHASERZ Bixby', 'CloudChaserz')).toBe('Bixby')
  })
})

describe('plural', () => {
  it('agrees with the count', () => {
    expect(plural(1, 'item')).toBe('1 item')
    expect(plural(2, 'item')).toBe('2 items')
    expect(plural(0, 'item')).toBe('0 items')
    expect(plural(1, 'discrepancy', 'discrepancies')).toBe('1 discrepancy')
    expect(plural(3, 'discrepancy', 'discrepancies')).toBe('3 discrepancies')
  })
})
