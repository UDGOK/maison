import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockApi, __resetMock } from '@/api/mock'
import { EposBuilder, buildReceiptXml, receiptQrContent } from '@/printer/epos'
import type { POSInvoice } from '@/api/types'
import type { ReceiptSnapshot } from '@/db'
import { fitWithin } from '@/images/resize'

describe('mock API v0.2 contract', () => {
  beforeEach(() => __resetMock())

  it('bootstrap returns settings, barcodes (items + serials) and images for ~half the items', async () => {
    const b = await mockApi.catalog.bootstrap('CHI-OAK')
    expect(b.settings).toMatchObject({ show_product_images: true, scan_enabled: true, receipt_qr_enabled: true, loyalty_lookup_enabled: true })
    expect(b.settings.receipt_qr_base_url).toMatch(/^https?:\/\//)
    const withImage = b.items.filter((i) => i.image).length
    expect(withImage).toBeGreaterThanOrEqual(18)
    expect(withImage).toBeLessThanOrEqual(22)
    expect(b.items.every((i) => i.maison_barcode?.length === 13)).toBe(true)
    for (const it of b.items) expect(b.barcodes[it.maison_barcode!]).toBe(it.item_code)
    for (const [code, list] of Object.entries(b.serials)) for (const sn of list) expect(b.barcodes[sn]).toBe(code)
    const nyc = await mockApi.catalog.bootstrap('NYC-MAD')
    expect(nyc.settings.show_product_images).toBe(false)
  })

  it('customers carry unique client numbers; search and lookup match them', async () => {
    const all = await mockApi.customers.search('', 50)
    const nums = new Set(all.map((c) => c.client_number))
    expect(nums.size).toBe(all.length)
    expect(all.every((c) => /^MC\d{6}$/.test(c.client_number!))).toBe(true)
    const c = all[3]
    expect((await mockApi.customers.search(c.client_number!.slice(2)))[0].name).toBe(c.name)
    expect((await mockApi.customers.lookup(c.client_number!))?.name).toBe(c.name)
    expect((await mockApi.customers.lookup(c.client_number!.toLowerCase()))?.name).toBe(c.name)
    expect((await mockApi.customers.lookup(`MC:${c.name}`))?.name).toBe(c.name)
    expect((await mockApi.customers.lookup(c.mobile_no!.replace(/\D/g, '').slice(-7)))?.name).toBe(c.name)
    expect(await mockApi.customers.lookup('MC000000')).toBeNull()
    const created = await mockApi.customers.upsert({ customer_name: 'New Person' })
    expect((created as { client_number?: string }).client_number).toMatch(/^MC\d{6}$/)
  })

  it('submit_batch returns a 16-char receipt token and sales.receipt resolves it (guest)', async () => {
    const inv: POSInvoice = {
      offline_uuid: 'v02-1', boutique: 'CHI-OAK', associate: 'MA-0001', device_id: 'd', posting_datetime: new Date().toISOString(),
      items: [{ item_code: 'AC-CLN-036', qty: 1, rate: 45 }],
      payments: [{ mode_of_payment: 'Cash', amount: 49.61 }]
    }
    const r = await mockApi.sales.submit_batch([inv])
    expect(r.results[0].status).toBe('ok')
    const token = r.results[0].receipt_token!
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/)
    const pub = await mockApi.sales.receipt(token)
    expect(pub).toMatchObject({ invoice: r.results[0].invoice_name, boutique: 'CHI-OAK', grand_total: 49.61 })
    expect(pub.lines[0].item_name).toBe('Jewelry Cleaning Kit')
    await expect(mockApi.sales.receipt('nope')).rejects.toMatchObject({ code: 'NotFound' })
    // duplicate keeps the same token
    const again = await mockApi.sales.submit_batch([inv])
    expect(again.results[0]).toMatchObject({ status: 'duplicate', receipt_token: token })
  })

  it('upload_item_image stores the photo and bootstrap returns it', async () => {
    const blob = new Blob(['fakejpeg'], { type: 'image/jpeg' })
    const { image: url } = await mockApi.catalog.upload_item_image('RG-SIG-005', blob, 'x.jpg')
    expect(url.startsWith('data:image/jpeg')).toBe(true)
    const b = await mockApi.catalog.bootstrap('CHI-OAK')
    expect(b.items.find((i) => i.item_code === 'RG-SIG-005')!.image).toBe(url)
    await expect(mockApi.catalog.upload_item_image('NOPE', blob)).rejects.toMatchObject({ code: 'NotFound' })
  })
})

const snap: ReceiptSnapshot = {
  boutique: 'CHI-OAK', boutique_name: 'AWANZ Oak Street', address_line: '118 East Oak Street', city: 'Chicago, IL 60611', phone: '+1 312 555 0118',
  associate_name: 'Claire Dubois', customer_name: 'Eleanor Whitmore', customer_tier: 'Gold', customer_client_number: 'MC482910',
  receipt_qr_base_url: 'https://maison-demo.frappe.cloud',
  lines: [{ item_code: 'AC-CLN-036', item_name: 'Jewelry Cleaning Kit', qty: 1, rate: 45, amount: 45 }],
  net_total: 45, discount: 0, total_taxes: 4.61, tax_rate: 10.25, loyalty_amount: 0, loyalty_points_redeemed: 0, grand_total: 49.61,
  payments: [{ mode_of_payment: 'Cash', amount: 49.61, tendered: 50, change: 0.39 }], points_earned: 45, points_balance: 1245, currency: 'USD'
}

describe('receipt QR', () => {
  it('receiptQrContent builds <base>/r/<token> and respects the toggle', () => {
    expect(receiptQrContent({ receipt_token: 'abcdefghijklmnop', receipt_qr_base_url: 'https://x.example/' })).toBe('https://x.example/r/abcdefghijklmnop')
    expect(receiptQrContent({ receipt_token: 'abcdefghijklmnop', receipt_qr_enabled: false, receipt_qr_base_url: 'https://x.example' })).toBeNull()
    expect(receiptQrContent({ receipt_qr_base_url: 'https://x.example' })).toBeNull()
    expect(receiptQrContent({ receipt_token: 't' }, 'https://fallback.example')).toBe('https://fallback.example/r/t')
  })
  it('EposBuilder.qr emits an ESC/POS qrcode_model_2 symbol', () => {
    const xml = new EposBuilder().qr('https://x.example/r/a&b', { align: 'center' }).build()
    expect(xml).toContain('<symbol type="qrcode_model_2" level="M" width="5">https://x.example/r/a&amp;b</symbol>')
    expect(xml).toContain('<text align="center"/>')
  })
  it('buildReceiptXml prints the QR + client number only when a token is present', () => {
    const meta = { offline_uuid: 'u', posting_datetime: '2026-08-22T10:00:00Z', invoice_name: 'SINV-1' }
    const without = buildReceiptXml(snap, meta)
    expect(without).not.toContain('<symbol')
    expect(without).toContain('CLIENT NO')
    expect(without).toContain('MC482910')
    const withQr = buildReceiptXml(snap, { ...meta, receipt_token: 'abcdefghijklmnop', receipt_qr_enabled: true })
    expect(withQr).toContain('<symbol type="qrcode_model_2" level="M" width="5">https://maison-demo.frappe.cloud/r/abcdefghijklmnop</symbol>')
    expect(withQr).toContain('SCAN FOR YOUR DIGITAL RECEIPT')
    expect(buildReceiptXml(snap, { ...meta, receipt_token: 'abcdefghijklmnop', receipt_qr_enabled: false })).not.toContain('<symbol')
  })
})

describe('image resize math', () => {
  it('fits the longest edge to 1200 px without upscaling', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1200, height: 900 })
    expect(fitWithin(3000, 4000)).toEqual({ width: 900, height: 1200 })
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })
})

describe('settings coercion (backend sends Check fields as 0/1)', () => {
  it('normalizeSettings turns ints into booleans and strips trailing slashes', async () => {
    const { normalizeSettings } = await import('@/api/types')
    const s = normalizeSettings({ show_product_images: 1, scan_enabled: 0, receipt_qr_enabled: 0, receipt_qr_base_url: 'https://x.example/', loyalty_lookup_enabled: '1' } as any)
    expect(s).toMatchObject({ show_product_images: true, scan_enabled: false, receipt_qr_enabled: false, receipt_qr_base_url: 'https://x.example', loyalty_lookup_enabled: true })
    expect(normalizeSettings(null).receipt_qr_enabled).toBe(true)
  })
})
