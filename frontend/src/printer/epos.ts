/**
 * Epson ePOS-Print XML builder + LAN transport.
 * Spec: https://download4.epson.biz/sec_pubs/pos/reference_en/epos_print/
 * 80 mm paper, Font A = 48 columns (TM-m30 family).
 */
import type { ReceiptSnapshot } from '@/db'
import { fmtAmount } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'
import { receiptUrl } from '@/scan/payloads'

export const COLS = 48

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
}

/** Left/right justified pair on one 48-col line. */
export function lr(left: string, right: string, cols = COLS): string {
  const r = right.slice(0, cols)
  const maxLeft = cols - r.length - 1
  const l = left.length > maxLeft ? left.slice(0, Math.max(0, maxLeft)) : left
  return l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r
}

export function wrap(text: string, cols = COLS): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > cols) {
      if (cur) lines.push(cur)
      cur = w
    } else cur = (cur + ' ' + w).trim()
  }
  if (cur) lines.push(cur)
  return lines
}

export class EposBuilder {
  private parts: string[] = []

  text(s: string, opts: { align?: 'left' | 'center' | 'right'; bold?: boolean; w?: number; h?: number; ul?: boolean } = {}) {
    const attrs: string[] = []
    if (opts.align) attrs.push(`align="${opts.align}"`)
    if (opts.bold !== undefined) attrs.push(`em="${opts.bold}"`)
    if (opts.ul !== undefined) attrs.push(`ul="${opts.ul}"`)
    if (opts.w || opts.h) attrs.push(`dw="${(opts.w || 1) > 1}" dh="${(opts.h || 1) > 1}"`)
    this.parts.push(`<text${attrs.length ? ' ' + attrs.join(' ') : ''}>${escapeXml(s)}&#10;</text>`)
    return this
  }
  line(ch = '-') {
    return this.text(ch.repeat(COLS))
  }
  feed(n = 1) {
    this.parts.push(`<feed line="${n}"/>`)
    return this
  }
  cut() {
    this.parts.push('<cut type="feed"/>')
    return this
  }
  drawer() {
    this.parts.push('<pulse drawer="drawer_1" time="pulse_100"/>')
    return this
  }
  /** ESC/POS 2D symbol — QR Code model 2, EC level M, module width 5 (≈ 29 mm at 203 dpi). */
  qr(data: string, opts: { level?: 'L' | 'M' | 'Q' | 'H'; width?: number; align?: 'left' | 'center' | 'right' } = {}) {
    if (opts.align) this.parts.push(`<text align="${opts.align}"/>`)
    this.parts.push(`<symbol type="qrcode_model_2" level="${opts.level || 'M'}" width="${opts.width ?? 5}">${escapeXml(data)}</symbol>`)
    if (opts.align && opts.align !== 'left') this.parts.push('<text align="left"/>')
    return this
  }
  build(): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      '<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">' +
      this.parts.join('') +
      '</epos-print></s:Body></s:Envelope>'
    )
  }
}

/** Render a receipt snapshot to ePOS-Print XML matching the SPEC receipt layout. */
export interface ReceiptMeta {
  invoice_name?: string
  offline_uuid: string
  posting_datetime: string
  openDrawer?: boolean
  /** v0.2 — when present (and QR enabled) prints `${receipt_qr_base_url}/r/${token}` as a QR */
  receipt_token?: string
  receipt_qr_base_url?: string
  receipt_qr_enabled?: boolean
}

/** QR content for a receipt, or null when no token / disabled. */
export function receiptQrContent(meta: Pick<ReceiptMeta, 'receipt_token' | 'receipt_qr_base_url' | 'receipt_qr_enabled'>, fallbackBase = ''): string | null {
  if (meta.receipt_qr_enabled === false || !meta.receipt_token) return null
  const base = meta.receipt_qr_base_url || fallbackBase
  if (!base) return null
  return receiptUrl(base, meta.receipt_token)
}

export function buildReceiptXml(r: ReceiptSnapshot, meta: ReceiptMeta): string {
  const b = new EposBuilder()
  b.text('MAISON', { align: 'center', bold: true, w: 2, h: 2 })
  b.text(r.boutique_name.toUpperCase(), { align: 'center' })
  b.text(r.address_line, { align: 'center' })
  b.text(r.city, { align: 'center' })
  b.text(r.phone, { align: 'center' })
  b.line('=')
  b.text(lr('INVOICE', meta.invoice_name || `PENDING ${meta.offline_uuid.slice(0, 8).toUpperCase()}`))
  b.text(lr('DATE', fmtDateTime(meta.posting_datetime)))
  b.text(lr('ASSOCIATE', r.associate_name))
  if (r.customer_name) b.text(lr('CLIENT', `${r.customer_name}${r.customer_tier ? ' / ' + r.customer_tier.toUpperCase() : ''}`))
  if (r.customer_client_number) b.text(lr('CLIENT NO', r.customer_client_number))
  b.line()
  for (const l of r.lines) {
    for (const w of wrap(l.item_name.toUpperCase())) b.text(w, { bold: true })
    if (l.serial_no) b.text(`  SERIAL ${l.serial_no}`)
    if (l.certificate_no) b.text(`  CERT ${l.certificate_no}`)
    b.text(lr(`  ${l.qty} x ${fmtAmount(l.rate)}`, fmtAmount(l.amount)))
    if (l.discount_amount) b.text(lr('  DISCOUNT', `-${fmtAmount(l.discount_amount)}`))
  }
  b.line()
  b.text(lr('SUBTOTAL', fmtAmount(r.net_total + r.discount)))
  if (r.discount) b.text(lr('DISCOUNT', `-${fmtAmount(r.discount)}`))
  b.text(lr(`TAX ${r.tax_rate}%`, fmtAmount(r.total_taxes)))
  if (r.loyalty_amount) b.text(lr(`LOYALTY (${r.loyalty_points_redeemed} PTS)`, `-${fmtAmount(r.loyalty_amount)}`))
  b.text(lr('TOTAL ' + r.currency, fmtAmount(r.grand_total)), { bold: true, w: 2, h: 2 })
  b.line()
  for (const p of r.payments) {
    if (p.mode_of_payment === 'Card') {
      b.text(lr(`CARD ${p.card_brand || ''} ${p.last4 ? '**** ' + p.last4 : ''}`.trim(), fmtAmount(p.amount)))
      if (p.approval) b.text(lr('  APPROVAL', p.approval))
    } else {
      b.text(lr('CASH', fmtAmount(p.amount)))
      if (p.tendered !== undefined) b.text(lr('  TENDERED', fmtAmount(p.tendered)))
      if (p.change) b.text(lr('  CHANGE', fmtAmount(p.change)))
    }
  }
  b.line()
  if (r.customer_name) {
    b.text(lr('POINTS EARNED', String(r.points_earned)))
    if (r.points_balance !== undefined) b.text(lr('POINTS BALANCE', String(r.points_balance)))
  }
  if (r.grand_total >= 10000) {
    b.feed(3)
    b.text('SIGNATURE ' + '_'.repeat(COLS - 10))
    b.feed(1)
  }
  b.feed(1)
  b.text('THANK YOU FOR VISITING MAISON', { align: 'center' })
  b.text('Exchanges within 30 days with receipt.', { align: 'center' })
  const qr = receiptQrContent({ ...meta, receipt_qr_base_url: meta.receipt_qr_base_url || r.receipt_qr_base_url })
  if (qr) {
    b.feed(1)
    b.qr(qr, { level: 'M', width: 5, align: 'center' })
    b.text('SCAN FOR YOUR DIGITAL RECEIPT', { align: 'center' })
  }
  b.text(meta.offline_uuid, { align: 'center' })
  b.feed(2)
  b.cut()
  if (meta.openDrawer) b.drawer()
  return b.build()
}

/**
 * POST the XML to the printer's ePOS service. Uses mode:'no-cors' so LAN printers (plain http,
 * no CORS headers) accept the job; response is opaque so success = request did not throw.
 */
export async function sendToPrinter(printerIp: string, xml: string, timeoutMs = 8000): Promise<void> {
  const url = `http://${printerIp}/cgi-bin/epos/service.cgi?devid=local_printer&timeout=${timeoutMs}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      body: xml,
      signal: ctrl.signal
    })
  } finally {
    clearTimeout(t)
  }
}
