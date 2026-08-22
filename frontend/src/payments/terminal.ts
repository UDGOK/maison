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

export interface TerminalDriver {
  readonly kind: 'stripe' | 'simulated'
  charge(opts: {
    boutique: string
    amount: number
    currency: string
    offline_uuid: string
    customer?: string
    onProgress: (p: TerminalProgress) => void
  }): Promise<CardResult>
  cancel(): Promise<void>
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class SimulatedReader implements TerminalDriver {
  readonly kind = 'simulated' as const
  private cancelled = false
  constructor(private delayMs = 2000) {}

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
    const reader = `Simulated WisePOS E (${opts.boutique})`
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

  constructor(private locationId?: string, private simulated = false) {}

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
    const t = await this.terminalInstance(opts.boutique)
    step('discovering', 'Discovering readers')
    const disc = await t.discoverReaders({ simulated: this.simulated, location: this.locationId })
    if (disc.error) throw new Error(disc.error.message)
    if (!disc.discoveredReaders?.length) throw new Error('No readers found at this location')
    const reader = disc.discoveredReaders[0]
    step('connecting', 'Connecting to reader', reader.label)
    const conn = await t.connectReader(reader)
    if (conn.error) throw new Error(conn.error.message)
    step('connected', 'Reader connected', reader.label)
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

export function createTerminal(opts: { publishableKey?: string; locationId?: string }): TerminalDriver {
  if (opts.publishableKey) return new StripeReader(opts.locationId, false)
  return new SimulatedReader(2000)
}
