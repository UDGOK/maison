/**
 * Reader-printer receipt (v0.4 A): the Verifone V660p prints whatever bitmap we hand to
 * `terminal.print(canvas)`. Its head is 384 dots wide (58 mm paper class, 203 dpi) — so we lay the
 * receipt out as a **monochrome 384-px canvas**.
 *
 * The layout is computed first as a pure model (`buildReceiptLayout`) — a list of positioned text
 * runs and rules — so it can be unit-tested without a canvas (node-canvas is not available in
 * vitest/jsdom); `renderReceiptCanvas` then paints that model with the 2D context.
 */
import type { ReceiptSnapshot } from '@/db'
import { fmtAmount } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'
import { receiptUrl } from '@/scan/payloads'

export const READER_PAPER_WIDTH = 384
export const READER_MARGIN = 12
/** printable width in px */
export const READER_COLS_PX = READER_PAPER_WIDTH - READER_MARGIN * 2

export type RunKind = 'text' | 'rule' | 'qr' | 'feed'
export interface LayoutRun {
  kind: RunKind
  y: number
  /** row height */
  h: number
  text?: string
  /** right-aligned text on the same row */
  right?: string
  align?: 'left' | 'center' | 'right'
  /** font px */
  size?: number
  bold?: boolean
  /** display face (Unbounded) vs body (Jost) */
  display?: boolean
  dashed?: boolean
  /** qr payload */
  payload?: string
  /** qr side in px */
  side?: number
}

export interface ReceiptLayout {
  width: number
  height: number
  runs: LayoutRun[]
}

export interface ReaderReceiptOptions {
  invoice_name?: string
  offline_uuid: string
  posting_datetime: string
  receipt_token?: string
  receipt_qr_enabled?: boolean
  receipt_qr_base_url?: string
  /** v0.4 E — credit notes print with a RETURN banner */
  kind?: 'sale' | 'return' | 'exchange'
  return_against?: string
  refund_method?: string
  store_credit?: number
}

const BODY = 20
const SMALL = 17
const LABEL = 15
const TITLE = 34
const TOTAL = 24
const LINE_GAP = 6

/**
 * Approximate advance width of the layout model: Jost averages ~0.47 em (0.50 em at 700),
 * Unbounded (display) is a wide face at ~0.80 em for 800/900 caps.
 */
export function textWidth(text: string, size: number, bold = false, display = false): number {
  const em = display ? 0.8 : bold ? 0.5 : 0.47
  return Math.ceil(text.length * size * em)
}

/** Greedy word-wrap for `maxPx` at `size`. */
export function wrapPx(text: string, size: number, maxPx = READER_COLS_PX, bold = false): string[] {
  const words = String(text || '')
    .split(/\s+/)
    .filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (textWidth(next, size, bold) > maxPx && cur) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

/** Truncate so that `left` + gap + `right` fit on one row. */
export function fitPair(
  left: string,
  right: string,
  size: number,
  maxPx = READER_COLS_PX,
  bold = false
): string {
  const gap = size
  const avail = maxPx - textWidth(right, size) - gap
  if (textWidth(left, size, bold) <= avail) return left
  let l = left
  while (l.length > 1 && textWidth(l + '…', size, bold) > avail) l = l.slice(0, -1)
  return l + '…'
}

export function buildReceiptLayout(r: ReceiptSnapshot, opts: ReaderReceiptOptions): ReceiptLayout {
  const runs: LayoutRun[] = []
  let y = READER_MARGIN
  const add = (run: Omit<LayoutRun, 'y'>) => {
    runs.push({ ...run, y })
    y += run.h
  }
  const text = (t: string, o: Partial<LayoutRun> = {}) => {
    const size = o.size || BODY
    for (const line of wrapPx(t, size, READER_COLS_PX, o.bold))
      add({ kind: 'text', text: line, h: size + LINE_GAP, size, ...o })
  }
  const pair = (l: string, rt: string, o: Partial<LayoutRun> = {}) => {
    const size = o.size || BODY
    add({
      kind: 'text',
      text: fitPair(l, rt, size, READER_COLS_PX, o.bold),
      right: rt,
      h: size + LINE_GAP,
      size,
      ...o
    })
  }
  const rule = (dashed = false) => add({ kind: 'rule', h: 14, dashed })
  const feed = (px = 10) => add({ kind: 'feed', h: px })

  text('MAISON', { align: 'center', size: TITLE, bold: true, display: true })
  text(r.boutique_name.toUpperCase(), { align: 'center', size: LABEL })
  text([r.address_line, r.city].filter(Boolean).join(', '), { align: 'center', size: SMALL })
  if (r.phone) text(r.phone, { align: 'center', size: SMALL })
  if (opts.kind === 'return' || opts.kind === 'exchange') {
    feed(4)
    text(opts.kind === 'exchange' ? 'EXCHANGE · CREDIT NOTE' : 'RETURN · CREDIT NOTE', {
      align: 'center',
      size: BODY,
      bold: true
    })
  }
  rule()
  pair('RECEIPT', opts.invoice_name || opts.offline_uuid.slice(0, 8).toUpperCase(), { size: SMALL })
  if (opts.return_against) pair('ORIGINAL SALE', opts.return_against, { size: SMALL })
  pair('DATE', fmtDateTime(opts.posting_datetime), { size: SMALL })
  pair('ASSOCIATE', r.associate_name, { size: SMALL })
  if (r.customer_name)
    pair('CLIENT', r.customer_tier ? `${r.customer_name} · ${r.customer_tier}` : r.customer_name, {
      size: SMALL
    })
  if (r.customer_client_number) pair('CLIENT №', r.customer_client_number, { size: SMALL })
  rule()
  const isCredit = opts.kind === 'return' || opts.kind === 'exchange'
  const amt = (v: number) => fmtAmount(isCredit ? Math.abs(v) : v)
  for (const l of r.lines) {
    pair(l.item_name, amt(l.amount), { bold: true })
    if (l.qty !== 1) text(`  ${Math.abs(l.qty)} × ${fmtAmount(l.rate)}`, { size: SMALL })
    if (l.serial_no) text(`  Serial ${l.serial_no}`, { size: SMALL })
    if (l.certificate_no) text(`  Cert. ${l.certificate_no}`, { size: SMALL })
    if (l.discount_amount)
      text(`  Discount −${fmtAmount(l.discount_amount * Math.abs(l.qty))}`, { size: SMALL })
  }
  rule(true)
  pair('SUBTOTAL', amt(r.net_total), { size: SMALL })
  if (r.discount) pair('DISCOUNT', `−${fmtAmount(r.discount)}`, { size: SMALL })
  pair(`TAX ${r.tax_rate}%`, amt(r.total_taxes), { size: SMALL })
  if (r.loyalty_amount)
    pair('LOYALTY', `−${fmtAmount(r.loyalty_amount)} (${r.loyalty_points_redeemed} pts)`, { size: SMALL })
  feed(4)
  pair(
    opts.kind === 'return' || opts.kind === 'exchange' ? 'CREDIT' : 'TOTAL',
    `${r.currency} ${fmtAmount(Math.abs(r.grand_total))}`,
    { size: TOTAL, bold: true, display: true }
  )
  rule(true)
  for (const p of r.payments) {
    const label =
      p.mode_of_payment === 'Card' && p.card_brand
        ? `${p.mode_of_payment} · ${p.card_brand} •••• ${p.last4 || ''}`
        : p.mode_of_payment
    pair((opts.kind === 'return' ? 'REFUND · ' : '') + label.toUpperCase(), fmtAmount(Math.abs(p.amount)), {
      size: SMALL
    })
    if (p.approval) text(`  Approval ${p.approval}`, { size: SMALL })
    if (p.tendered !== undefined && p.change) {
      pair('TENDERED', fmtAmount(p.tendered), { size: SMALL })
      pair('CHANGE', fmtAmount(p.change), { size: SMALL })
    }
  }
  if (opts.store_credit) pair('STORE CREDIT', fmtAmount(opts.store_credit), { size: SMALL })
  if (r.customer_name && (r.points_earned || r.points_balance)) {
    rule(true)
    if (r.points_earned) pair('POINTS EARNED', String(Math.round(r.points_earned)), { size: SMALL })
    if (r.points_balance !== undefined)
      pair('POINTS BALANCE', String(Math.round(r.points_balance)), { size: SMALL })
  }
  if (Math.abs(r.grand_total) >= 10000 || opts.kind === 'return') {
    feed(18)
    text('CLIENT SIGNATURE', { size: LABEL })
    feed(44)
    add({ kind: 'rule', h: 10 })
  }
  if (opts.receipt_qr_enabled && opts.receipt_token && opts.receipt_qr_base_url) {
    feed(8)
    const side = 132
    add({
      kind: 'qr',
      h: side + 6,
      payload: receiptUrl(opts.receipt_qr_base_url, opts.receipt_token),
      side,
      align: 'center'
    })
    text('SCAN FOR YOUR RECEIPT', { align: 'center', size: LABEL })
  }
  feed(6)
  text('Thank you for choosing Maison.', { align: 'center', size: SMALL })
  text('Exchanges within 30 days with receipt.', { align: 'center', size: SMALL })
  feed(READER_MARGIN * 2)
  return { width: READER_PAPER_WIDTH, height: y, runs }
}

/** Paint a layout onto a canvas (sized to the layout). Black on white, no anti-aliasing needed: thermal heads threshold. */
export async function renderReceiptCanvas(
  layout: ReceiptLayout,
  canvas: HTMLCanvasElement
): Promise<HTMLCanvasElement> {
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.fillStyle = '#000'
  ctx.strokeStyle = '#000'
  ctx.textBaseline = 'top'
  for (const run of layout.runs) {
    if (run.kind === 'rule') {
      ctx.lineWidth = 2
      ctx.setLineDash(run.dashed ? [4, 4] : [])
      ctx.beginPath()
      ctx.moveTo(READER_MARGIN, run.y + run.h / 2)
      ctx.lineTo(layout.width - READER_MARGIN, run.y + run.h / 2)
      ctx.stroke()
      ctx.setLineDash([])
    } else if (run.kind === 'text') {
      const size = run.size || BODY
      ctx.font = `${run.bold ? 700 : 400} ${size}px ${run.display ? '"Unbounded", "Arial Black", Arial' : '"Jost", "Helvetica Neue", Arial'}, sans-serif`
      const t = run.text || ''
      if (run.right !== undefined) {
        ctx.textAlign = 'left'
        ctx.fillText(t, READER_MARGIN, run.y)
        ctx.textAlign = 'right'
        ctx.fillText(run.right, layout.width - READER_MARGIN, run.y)
      } else if (run.align === 'center') {
        ctx.textAlign = 'center'
        ctx.fillText(t, layout.width / 2, run.y)
      } else if (run.align === 'right') {
        ctx.textAlign = 'right'
        ctx.fillText(t, layout.width - READER_MARGIN, run.y)
      } else {
        ctx.textAlign = 'left'
        ctx.fillText(t, READER_MARGIN, run.y)
      }
    } else if (run.kind === 'qr' && run.payload) {
      try {
        const QR = await import('qrcode')
        const side = run.side || 132
        const tmp = document.createElement('canvas')
        await QR.toCanvas(tmp, run.payload, {
          width: side,
          margin: 0,
          errorCorrectionLevel: 'M',
          color: { dark: '#000000', light: '#ffffff' }
        })
        ctx.drawImage(tmp, (layout.width - side) / 2, run.y)
      } catch {
        /* qr lib unavailable: skip the symbol */
      }
    }
  }
  // threshold to pure monochrome so the thermal head does not dither grey anti-aliasing
  const img = ctx.getImageData(0, 0, layout.width, layout.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3 < 160 ? 0 : 255
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

export async function buildReceiptCanvas(
  r: ReceiptSnapshot,
  opts: ReaderReceiptOptions
): Promise<HTMLCanvasElement> {
  return renderReceiptCanvas(buildReceiptLayout(r, opts), document.createElement('canvas'))
}
