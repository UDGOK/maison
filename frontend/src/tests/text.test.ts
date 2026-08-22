import { describe, it, expect } from 'vitest'
import { stripHtml } from '@/utils/text'

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
