/**
 * Stripe Terminal abstraction.
 * - With VITE_STRIPE_PUBLISHABLE_KEY: loads @stripe/terminal-js (internet reader / simulated reader).
 * - Without a key: an in-app SimulatedReader that mimics discover → connect → collect → process
 *   with ~2 s delays, wired to the same stripe_terminal.* endpoints so the server flow is exercised.
 */
import { api } from '@/api'

export type TerminalStep = 'idle' | 'discovering' | 'connecting' | 'connected' | 'collecting' | 'processing' | 'capturing' | 'done' | 'error'

export interface TerminalProgress {
  step: TerminalStep
  message: string
  reader?: string
}

export interface CardResult {
  payment_intent: string
  charge_id: string
  card_brand: string
  last4: string
  approval: string
}

export interface ReaderPrintResult {
  ok: boolean
  reader?: string
  /** PNG data URL of what was sent (simulated reader keeps it for the e2e / Settings preview) */
  preview?: string
}

export interface TerminalDriver {
  readonly kind: 'stripe' | 'simulated'
  /** v0.4 A — which paired reader this driver connects to (Maison Boutique Reader row) */
  readonly readerId?: string
  charge(opts: {
    boutique: string
    amount: number
    currency: string
    offline_uuid: string
    customer?: string
    onProgress: (p: TerminalProgress) => void
  }): Promise<CardResult>
  cancel(): Promise<void>
  /**
   * v0.4 A — print a 384-px monochrome canvas on the reader's built-in printer (Verifone V660p).
   * Rejects when the connected reader has no printer; the printer store then falls back to ePOS.
   */
  print(canvas: HTMLCanvasElement, opts: { boutique: string }): Promise<ReaderPrintResult>
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class SimulatedReader implements TerminalDriver {
  readonly kind = 'simulated' as const
  private cancelled = false
  /** last printed bitmap (data URL) — inspected by e2e / the Settings "Test reader print" */
  lastPrint: string | null = null
  constructor(
    private delayMs = 2000,
    public readonly readerId?: string,
    /** simulated reader gains `has_printer` so e2e can exercise the canvas print path */
    public readonly hasPrinter = true,
    public readonly label = 'Simulated WisePOS E'
  ) {}

  async print(canvas: HTMLCanvasElement): Promise<ReaderPrintResult> {
    if (!this.hasPrinter) throw new Error('Reader has no printer')
    await wait(Math.min(this.delayMs / 4, 400))
    let preview: string | undefined
    try {
      preview = canvas.toDataURL('image/png')
    } catch {
      preview = undefined
    }
    this.lastPrint = preview || null
    if (typeof window !== 'undefined') (window as unknown as { __maisonLastReaderPrint?: string }).__maisonLastReaderPrint = preview
    return { ok: true, reader: this.label, preview }
  }

  async cancel() {
    this.cancelled = true
  }

  private check() {
    if (this.cancelled) throw new Error('Payment cancelled')
  }

  async charge(opts: Parameters<TerminalDriver['charge']>[0]): Promise<CardResult> {
    this.cancelled = false
    const step = (step: TerminalStep, message: string, reader?: string) => opts.onProgress({ step, message, reader })
    step('discovering', 'Discovering readers')
    await api.stripe_terminal.connection_token(opts.boutique)
    await wait(this.delayMs / 2)
    this.check()
    const reader = `${this.label} (${opts.boutique})`
    step('connecting', 'Connecting to reader', reader)
    await wait(this.delayMs / 2)
    this.check()
    step('connected', 'Reader connected', reader)
    const pi = await api.stripe_terminal.create_payment_intent(opts.amount, opts.currency, opts.offline_uuid, opts.customer)
    step('collecting', 'Present card on reader', reader)
    await wait(this.delayMs)
    this.check()
    step('processing', 'Processing payment', reader)
    await wait(this.delayMs)
    this.check()
    step('capturing', 'Capturing', reader)
    const cap = await api.stripe_terminal.capture(pi.id)
    if (cap.status !== 'succeeded') throw new Error(`Payment ${cap.status}`)
    step('done', 'Approved', reader)
    return {
      payment_intent: pi.id,
      charge_id: cap.charge_id,
      card_brand: cap.card_brand,
      last4: cap.last4,
      approval: cap.charge_id.slice(-6).toUpperCase()
    }
  }
}

export class StripeReader implements TerminalDriver {
  readonly kind = 'stripe' as const
  private terminal: any = null
  private current: any = null

  private connectedReader: any = null

  constructor(
    private locationId?: string,
    private simulated = false,
    public readonly readerId?: string
  ) {}

  /** Discover + connect, preferring the reader picked in Settings (`readerId` = Stripe reader id). */
  private async connect(boutique: string, step: (s: TerminalStep, m: string, r?: string) => void) {
    const t = await this.terminalInstance(boutique)
    if (this.connectedReader && t.getConnectionStatus?.() === 'connected') return { t, reader: this.connectedReader }
    step('discovering', 'Discovering readers')
    const disc = await t.discoverReaders({ simulated: this.simulated, location: this.locationId })
    if (disc.error) throw new Error(disc.error.message)
    if (!disc.discoveredReaders?.length) throw new Error('No readers found at this location')
    const reader = (this.readerId && disc.discoveredReaders.find((r: any) => r.id === this.readerId)) || disc.discoveredReaders[0]
    step('connecting', 'Connecting to reader', reader.label)
    const conn = await t.connectReader(reader)
    if (conn.error) throw new Error(conn.error.message)
    this.connectedReader = conn.reader || reader
    step('connected', 'Reader connected', reader.label)
    return { t, reader: this.connectedReader }
  }

  /** Verifone V660p: `terminal.print(canvas)` (feature-detected so older SDKs / printer-less readers reject cleanly). */
  async print(canvas: HTMLCanvasElement, opts: { boutique: string }): Promise<ReaderPrintResult> {
    const { t, reader } = await this.connect(opts.boutique, () => undefined)
    if (reader?.device_type && reader.device_type !== 'verifone_v660p') throw new Error(`${reader.label || reader.device_type} has no printer`)
    if (typeof t.print !== 'function') throw new Error('This Terminal SDK build cannot print')
    const res = await t.print(canvas)
    if (res?.error) throw new Error(res.error.message)
    return { ok: true, reader: reader?.label }
  }

  private async terminalInstance(boutique: string) {
    if (this.terminal) return this.terminal
    const { loadStripeTerminal } = await import('@stripe/terminal-js')
    const StripeTerminal = await loadStripeTerminal()
    if (!StripeTerminal) throw new Error('Stripe Terminal SDK failed to load')
    this.terminal = StripeTerminal.create({
      onFetchConnectionToken: async () => (await api.stripe_terminal.connection_token(boutique)).secret,
      onUnexpectedReaderDisconnect: () => {
        this.terminal = null
      }
    })
    return this.terminal
  }

  async cancel() {
    try {
      await this.terminal?.cancelCollectPaymentMethod()
    } catch {
      /* nothing in flight */
    }
  }

  async charge(opts: Parameters<TerminalDriver['charge']>[0]): Promise<CardResult> {
    const step = (step: TerminalStep, message: string, reader?: string) => opts.onProgress({ step, message, reader })
    const { t, reader } = await this.connect(opts.boutique, step)
    const pi = await api.stripe_terminal.create_payment_intent(opts.amount, opts.currency, opts.offline_uuid, opts.customer)
    step('collecting', 'Present card on reader', reader.label)
    const col = await t.collectPaymentMethod(pi.client_secret)
    if (col.error) throw new Error(col.error.message)
    step('processing', 'Processing payment', reader.label)
    const proc = await t.processPayment(col.paymentIntent)
    if (proc.error) throw new Error(proc.error.message)
    step('capturing', 'Capturing', reader.label)
    const cap = await api.stripe_terminal.capture(proc.paymentIntent.id)
    if (cap.status !== 'succeeded') throw new Error(`Payment ${cap.status}`)
    step('done', 'Approved', reader.label)
    return {
      payment_intent: proc.paymentIntent.id,
      charge_id: cap.charge_id,
      card_brand: cap.card_brand,
      last4: cap.last4,
      approval: cap.charge_id.slice(-6).toUpperCase()
    }
  }
}

export interface CreateTerminalOptions {
  publishableKey?: string
  locationId?: string
  /** v0.4 A — reader picked in Settings (Maison Boutique Reader): its Stripe id, type and printer flag */
  reader?: { stripe_reader_id?: string; device_type?: string; has_printer?: boolean | 0 | 1; label?: string } | null
}

/** Per-device singleton so Pay / Receipt / Settings share one reader connection. */
let current: { key: string; driver: TerminalDriver } | null = null

export function createTerminal(opts: CreateTerminalOptions): TerminalDriver {
  const key = JSON.stringify([!!opts.publishableKey, opts.locationId, opts.reader?.stripe_reader_id, opts.reader?.device_type, !!opts.reader?.has_printer])
  if (current && current.key === key) return current.driver
  const driver: TerminalDriver = opts.publishableKey
    ? new StripeReader(opts.locationId, false, opts.reader?.stripe_reader_id)
    : new SimulatedReader(2000, opts.reader?.stripe_reader_id, opts.reader ? !!opts.reader.has_printer : true, opts.reader?.label || 'Simulated WisePOS E')
  current = { key, driver }
  return driver
}

/** Readers that can print through `terminal.print(canvas)`. */
export function readerCanPrint(reader?: { device_type?: string; has_printer?: boolean | 0 | 1 } | null): boolean {
  if (!reader) return false
  if (reader.device_type === 'verifone_v660p') return reader.has_printer === undefined || !!reader.has_printer
  return reader.device_type === 'simulated' && !!reader.has_printer
}
