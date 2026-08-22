import { describe, expect, it } from 'vitest'
import { WedgeParser } from '@/scan/wedge'
import { clientQr, invoiceQr, parsePayload, receiptUrl } from '@/scan/payloads'
import { resolveScan } from '@/scan/resolve'
import { ITEMS, barcodesFor, ean13CheckDigit, ean13For, serialsFor } from '@/api/seed'
import type { Customer, Item } from '@/api/types'

function burst(p: WedgeParser, text: string, start = 1000, gap = 8): string | null {
  let t = start
  for (const ch of text) {
    p.feed({ key: ch, time: t })
    t += gap
  }
  return p.feed({ key: 'Enter', time: t })
}

describe('keyboard-wedge burst parser', () => {
  it('accepts a fast burst ending in Enter', () => {
    const p = new WedgeParser()
    expect(burst(p, '2000733100019')).toBe('2000733100019')
  })
  it('rejects slow human typing even when it ends in Enter', () => {
    const p = new WedgeParser()
    expect(burst(p, '2000733100019', 1000, 120)).toBeNull()
  })
  it('drops a burst shorter than minLength and a bare Enter', () => {
    const p = new WedgeParser({ minLength: 4 })
    expect(burst(p, 'ab')).toBeNull()
    expect(p.feed({ key: 'Enter', time: 5000 })).toBeNull()
  })
  it('resets after a gap so two scans are separate', () => {
    const p = new WedgeParser()
    expect(burst(p, 'CHI00101', 1000)).toBe('CHI00101')
    expect(burst(p, 'MC:CUST-0007', 3000)).toBe('MC:CUST-0007')
  })
  it('ignores modifier keys inside the burst and a stale prefix', () => {
    const p = new WedgeParser()
    p.feed({ key: 'x', time: 0 }) // stale char, > gap before the burst
    let t = 1000
    for (const ch of 'ABC') {
      p.feed({ key: ch, time: t })
      t += 5
    }
    p.feed({ key: 'Shift', time: t })
    p.feed({ key: 'D', time: t + 5 })
    expect(p.feed({ key: 'Enter', time: t + 10 })).toBe('ABCD')
  })
  it('rejects a burst that took longer than maxBurstMs overall', () => {
    const p = new WedgeParser({ maxGapMs: 50, maxBurstMs: 200 })
    expect(burst(p, 'ABCDEFGHIJ', 0, 45)).toBeNull() // 10 × 45 = 450 ms > 200
  })
})

describe('QR payload builders', () => {
  it('builds client / invoice / receipt payloads', () => {
    expect(clientQr('CUST-0001')).toBe('MC:CUST-0001')
    expect(invoiceQr('SINV-CHI-OAK-00001')).toBe('INV:SINV-CHI-OAK-00001')
    expect(receiptUrl('https://maison.example/', 'abc123DEF456ghi_')).toBe('https://maison.example/r/abc123DEF456ghi_')
    expect(receiptUrl('https://maison.example', 'tok')).toBe('https://maison.example/r/tok')
  })
  it('parses payloads back (case-insensitive prefixes, receipt URLs)', () => {
    expect(parsePayload('MC:CUST-0003')).toEqual({ kind: 'client', customer: 'CUST-0003' })
    expect(parsePayload('inv:SINV-1')).toEqual({ kind: 'invoice', invoice: 'SINV-1' })
    expect(parsePayload('https://maison.example/r/abc123DEF456ghi_')).toMatchObject({ kind: 'receipt', token: 'abc123DEF456ghi_' })
    expect(parsePayload(' 2000733100019 ')).toEqual({ kind: 'code', code: '2000733100019' })
    expect(parsePayload('MC:')).toEqual({ kind: 'code', code: 'MC:' })
  })
})

describe('EAN-13 seed', () => {
  it('computes a valid check digit', () => {
    expect(ean13CheckDigit('400638133393')).toBe('1')
    const code = ean13For(1)
    expect(code).toHaveLength(13)
    expect(ean13CheckDigit(code.slice(0, 12))).toBe(code[12])
  })
  it('is unique per item', () => {
    const set = new Set(ITEMS.map((i) => i.maison_barcode))
    expect(set.size).toBe(ITEMS.length)
  })
})

describe('barcode resolution', () => {
  const serials = serialsFor('CHI-OAK')
  const barcodes = barcodesFor(serials)
  const byCode = Object.fromEntries(ITEMS.map((i) => [i.item_code, i])) as Record<string, Item>
  const resolveCode = (c: string) => {
    const item_code = barcodes[c] ?? (byCode[c] ? c : undefined)
    if (!item_code) return null
    const serial = (serials[item_code] || []).find((s) => s === c)
    return serial ? { item: byCode[item_code], serial_no: serial } : { item: byCode[item_code] }
  }
  const cust: Customer = { name: 'CUST-0001', customer_name: 'Eleanor Whitmore', loyalty_points: 0, tier: 'Member', client_number: 'MC482910' }

  it('EAN-13 → item', async () => {
    const r = await resolveScan(ITEMS[4].maison_barcode!, { resolveCode })
    expect(r).toMatchObject({ kind: 'item', item: { item_code: ITEMS[4].item_code } })
    expect((r as any).serial_no).toBeUndefined()
  })
  it('serial label → item + that exact serial', async () => {
    const sn = serials['RG-SOL-001'][0]
    const r = await resolveScan(sn, { resolveCode })
    expect(r).toMatchObject({ kind: 'item', item: { item_code: 'RG-SOL-001' }, serial_no: sn })
  })
  it('client QR → local customer, or remote when not cached', async () => {
    expect(await resolveScan('MC:CUST-0001', { resolveCode, customerById: () => cust })).toMatchObject({ kind: 'client', customer: { name: 'CUST-0001' } })
    expect(await resolveScan('MC:CUST-0099', { resolveCode, customerById: () => null })).toEqual({ kind: 'client-remote', customer: 'CUST-0099' })
  })
  it('invoice QR → receipt on this device when queued', async () => {
    expect(await resolveScan('INV:SINV-CHI-OAK-00001', { resolveCode, invoiceUuid: () => 'uuid-1' })).toEqual({ kind: 'invoice', invoice: 'SINV-CHI-OAK-00001', offline_uuid: 'uuid-1' })
  })
  it('unknown code → unknown', async () => {
    expect(await resolveScan('9999999999999', { resolveCode })).toEqual({ kind: 'unknown', code: '9999999999999' })
  })
})
