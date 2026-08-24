/**
 * v0.5 K — POS side of the AWANZ Salon (client-facing screen).
 *
 * Pairs this POS device with a Salon iPad (6-digit code / QR from Settings → "Client display"),
 * mirrors the sale into `salon.publish` calls (debounced 150 ms, coalesced, only when something
 * changed) and reacts to what the client did on the Salon (`client_attached`, `consent_agreed`,
 * `question`, …) via realtime + 2 s polling. The mirror payload is built from the cart / route /
 * pay / receipt state; the server masks it again before the Salon sees it.
 */
import { defineStore } from 'pinia'
import { watch } from 'vue'
import { api, type Customer } from '@/api'
import { salonApi, type PairingCode, type SalonMessage, type SalonPay, type SalonReceipt, type SalonScreen, type SalonSession, type SalonState } from '@/api/salon'
import { connectSalonRealtime, POLL_MS, type Unsubscribe } from '@/salon/transport'
import { remainingMs } from '@/salon/pairing'
import { sanitizeState } from '@/salon/mask'
import { getSetting, setSetting } from '@/db'
import { useCartStore } from './cart'
import { useAgeStore } from './age' // v0.6 N
import { useSessionStore } from './session'
import { useCatalogStore } from './catalog'
import { lineNet } from '@/utils/totals' // v0.8 POS D1
import { useSyncStore } from './sync'
import { router } from '@/router'

export const PUBLISH_DEBOUNCE_MS = 150
const SETTING_KEY = 'salon_session'
const VIRTUAL_KEY = 'awanz.salon.virtual'

interface SalonPosState {
  session: SalonSession | null
  pairing: PairingCode | null
  pairingRemainingMs: number
  inboxSeq: number
  connected: boolean
  polling: boolean
  busy: boolean
  error: string
  /** associate switched the Salon to Concierge mode */
  concierge: boolean
  /** associate asked the Salon to show "Are you a client of the house?" */
  identifyRequested: boolean
  /** the sale the identify screen was auto-shown for (first line added, no client) */
  identifyShownFor: string
  pay: SalonPay | null
  receipt: SalonReceipt | null
  lastPublished: { screen: SalonScreen; payload: Record<string, unknown> } | null
  lastScreen: SalonScreen
  publishedSeq: number
  questions: SalonMessage[]
  /** dev: virtual salon pane (mock mode) */
  virtualOpen: boolean
  /** consent hand-off progress mirrored back to the Salon */
  consentStep: 'capture' | 'done' | 'unavailable' | null
  consentCaptured: number
  focusLine: string | null
}

let unsub: Unsubscribe | null = null
let pollTimer = 0
let pairTimer = 0
let publishTimer = 0
let pending: { screen: SalonScreen; payload: Record<string, unknown> } | null = null
let watching = false
let lineSig = ''

/** Deep-equal for the small JSON payloads we publish. */
export function samePayload(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Debounce helper with coalescing: the last call within `ms` wins. Exported for unit tests. */
export function makeDebouncer(ms: number, fn: (screen: SalonScreen, payload: Record<string, unknown>) => void) {
  let t = 0
  let last: { screen: SalonScreen; payload: Record<string, unknown> } | null = null
  return (screen: SalonScreen, payload: Record<string, unknown>) => {
    last = { screen, payload }
    clearTimeout(t)
    t = window.setTimeout(() => {
      const l = last
      last = null
      if (l) fn(l.screen, l.payload)
    }, ms)
  }
}

export const useSalonPosStore = defineStore('salon', {
  state: (): SalonPosState => ({
    session: null,
    pairing: null,
    pairingRemainingMs: 0,
    inboxSeq: 0,
    connected: false,
    polling: false,
    busy: false,
    error: '',
    concierge: false,
    identifyRequested: false,
    identifyShownFor: '',
    pay: null,
    receipt: null,
    lastPublished: null,
    lastScreen: 'idle',
    publishedSeq: 0,
    questions: [],
    virtualOpen: false,
    consentStep: null,
    consentCaptured: 0,
    focusLine: null
  }),
  getters: {
    paired: (s) => !!s.session && s.session.status === 'Paired',
    token: (s) => s.session?.token || null,
    pairingActive: (s) => !!s.pairing && s.pairingRemainingMs > 0
  },
  actions: {
    async restore() {
      try {
        this.virtualOpen = localStorage.getItem(VIRTUAL_KEY) === '1'
      } catch {
        /* ignore */
      }
      const saved = await getSetting<SalonSession | null>(SETTING_KEY, null)
      if (saved?.token) this.session = saved
      const session = useSessionStore()
      if (!session.boutique) return
      try {
        const st = await salonApi.pos_status(session.boutique.name, session.device_id, 0)
        if (st.paired && st.session) {
          this.session = st.session
          this.inboxSeq = st.inbox_seq
          await setSetting(SETTING_KEY, JSON.parse(JSON.stringify(st.session)))
          this.start()
        } else if (this.session) {
          this.session = null
          await setSetting(SETTING_KEY, null)
        }
      } catch {
        // offline: keep what we had; polling will sort it out
        if (this.session) this.start()
      }
      this.attachMirror()
    },
    /** Settings → "Pair a client display": a fresh code + 10 min countdown; polls until a Salon redeems it. */
    async requestCode() {
      const session = useSessionStore()
      if (!session.boutique) return
      this.error = ''
      this.busy = true
      try {
        this.pairing = await salonApi.pairing_code(session.boutique.name, session.device_id)
        // server timestamps are site-local; count down from the TTL on the device clock instead
        const deadline = new Date(Date.now() + (this.pairing.ttl_seconds || 600) * 1000).toISOString()
        this.pairingRemainingMs = remainingMs(deadline)
        clearInterval(pairTimer)
        pairTimer = window.setInterval(() => {
          this.pairingRemainingMs = remainingMs(deadline)
          if (this.pairingRemainingMs <= 0) clearInterval(pairTimer)
        }, 1000)
        // the paired event may also arrive by socket (user room); polling covers the rest
        if (!this.polling) this.pollUntilPaired()
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.busy = false
      }
    },
    cancelCode() {
      this.pairing = null
      this.pairingRemainingMs = 0
      clearInterval(pairTimer)
    },
    pollUntilPaired() {
      const session = useSessionStore()
      clearTimeout(pollTimer)
      const tick = async () => {
        if (this.paired || !this.pairing || !session.boutique) return
        try {
          const st = await salonApi.pos_status(session.boutique.name, session.device_id, 0)
          if (st.paired && st.session) {
            await this.onPaired(st.session, st.inbox_seq)
            return
          }
        } catch {
          /* retry */
        }
        if (this.pairingRemainingMs > 0) pollTimer = window.setTimeout(tick, POLL_MS)
      }
      pollTimer = window.setTimeout(tick, POLL_MS)
    },
    async onPaired(session: SalonSession, inboxSeq = 0) {
      this.session = session
      this.inboxSeq = inboxSeq
      this.cancelCode()
      await setSetting(SETTING_KEY, JSON.parse(JSON.stringify(session)))
      this.lastPublished = null
      this.start()
      useSyncStore().notify('good', 'Client display paired', `${session.salon_device_id || 'Salon'} · ${session.boutique_name || session.boutique}`)
      this.attachMirror()
      this.publishNow()
    },
    async unpair() {
      const t = this.token
      this.stop()
      this.session = null
      this.lastPublished = null
      await setSetting(SETTING_KEY, null)
      if (t) void salonApi.unpair_pos({ session: t }).catch(() => undefined)
    },
    start() {
      this.stop()
      const t = this.token
      if (!t) return
      unsub = connectSalonRealtime(t, {
        onMessage: (m) => void this.handle(m),
        onConnection: (c) => (this.connected = c),
        onPaired: (info) => {
          if (!this.paired && info.token)
            void salonApi.pos_status(useSessionStore().boutique!.name, useSessionStore().device_id, 0).then((st) => {
              if (st.paired && st.session) void this.onPaired(st.session, st.inbox_seq)
            })
        }
      })
      this.polling = true
      const tick = async () => {
        if (!this.polling || !this.token) return
        try {
          const r = await salonApi.pos_poll(this.token, this.inboxSeq)
          if (r.status !== 'Paired') {
            await this.unpair()
            useSyncStore().notify('warn', 'Client display unpaired')
            return
          }
          for (const m of r.messages) await this.handle(m)
          // a republish after the Salon attached a client (server flips state to "client" with pending_pos)
          if (r.screen === 'client' && this.lastPublished && this.lastPublished.screen !== 'client') this.publishNow()
        } catch (e) {
          const code = (e as { code?: string }).code
          if (code === 'AUTH' || (e as { status?: number }).status === 403) {
            await this.unpair()
            useSyncStore().notify('warn', 'Client display session ended')
            return
          }
        }
        pollTimer = window.setTimeout(tick, POLL_MS)
      }
      pollTimer = window.setTimeout(tick, 500)
    },
    stop() {
      unsub?.()
      unsub = null
      this.polling = false
      this.connected = false
      clearTimeout(pollTimer)
    },

    // ---- Salon → POS ------------------------------------------------------------------------
    async handle(m: SalonMessage) {
      if (m.seq <= this.inboxSeq) return
      this.inboxSeq = m.seq
      const cart = useCartStore()
      const sync = useSyncStore()
      switch (m.type) {
        case 'client_attached': {
          if (!m.customer) return
          if (cart.customer?.name === m.customer) return
          let c: Customer | null = null
          try {
            c = await api.customers.lookup(`MC:${m.customer}`)
          } catch {
            c = null
          }
          if (!c && (m as { customer_row?: Customer }).customer_row) c = (m as { customer_row?: Customer }).customer_row!
          if (!c && m.client) c = { name: m.customer, customer_name: m.client.customer_name || m.client.first_name, loyalty_points: m.client.loyalty_points || 0, tier: m.client.tier || null, points_value: m.client.points_value }
          if (!c) return
          cart.setCustomer(c)
          this.identifyRequested = false
          sync.notify('good', m.created ? `${c.customer_name} joined AWANZ` : `${c.customer_name} identified on the Salon`, m.how === 'signup' ? 'New client created from the client display' : undefined)
          this.publishNow()
          break
        }
        case 'consent_agreed':
          await this.enrolFromSalon(m)
          break
        case 'consent_declined':
          this.consentStep = null
          sync.notify('warn', 'Recognition declined on the Salon', 'The client stays attached without biometrics')
          break
        case 'question':
          this.questions = [m, ...this.questions].slice(0, 10)
          sync.notify('warn', `Client asks${m.item_name ? ` about ${m.item_name}` : ''}`, m.question)
          break
        case 'feedback':
          sync.notify('good', 'Private feedback received', 'Sent to head office')
          break
        case 'invite':
          if (m.wants_invitation) sync.notify('good', 'Private viewing', `${cart.customer?.customer_name || 'The client'} asked for an invitation`)
          break
        case 'email_receipt':
          sync.notify('good', 'Receipt e-mailed', m.email_masked || undefined)
          break
        case 'preferences':
          sync.notify('good', 'Concierge answers saved', (m.fields || []).join(', '))
          break
      }
    },
    /** The client agreed on the Salon; the POS owns the camera → capture 3 samples and enrol. */
    async enrolFromSalon(m: SalonMessage) {
      const cart = useCartStore()
      const sync = useSyncStore()
      if (!this.token || !m.customer) return
      const { useRecognitionStore } = await import('./recognition')
      const recognition = useRecognitionStore()
      let consent = m.consent as { method: 'Hold-to-agree' | 'Signature'; text_version: string; signature_data_url?: string } | undefined
      if (m.has_signature) {
        try {
          consent = (await salonApi.pending_consent(this.token)).consent || consent
        } catch {
          /* keep the summary */
        }
      }
      if (!consent) return
      if (cart.customer?.name !== m.customer) {
        try {
          const c = await api.customers.lookup(`MC:${m.customer}`)
          if (c) cart.setCustomer(c)
        } catch {
          /* ignore */
        }
      }
      const cameraRunning = recognition.active && ['looking', 'recognised', 'new', 'starting'].includes(recognition.tile)
      if (!cameraRunning) {
        this.consentStep = 'unavailable'
        this.publishNow()
        sync.notify('warn', 'Client agreed to recognition', 'Camera is off on this device — enrol from the client panel')
        setTimeout(() => {
          this.consentStep = null
          this.publishNow()
        }, 6000)
        return
      }
      this.consentStep = 'capture'
      this.consentCaptured = 0
      this.publishNow()
      recognition.openEnrol({ customer: cart.customer })
      const stopWatch = watch(
        () => recognition.captureSamples.length,
        (n) => {
          this.consentCaptured = n
          this.publishNow()
        }
      )
      const ok = await recognition.agree({ method: consent.method, text_version: consent.text_version, signature_data_url: consent.signature_data_url })
      stopWatch()
      this.consentStep = ok ? 'done' : 'unavailable'
      this.publishNow()
      if (!ok) sync.notify('crit', 'Enrolment from the Salon failed', recognition.enrolError || 'Try again from the client panel')
      setTimeout(() => {
        this.consentStep = null
        this.publishNow()
      }, 4000)
    },

    // ---- associate controls -----------------------------------------------------------------
    requestIdentify() {
      this.identifyRequested = true
      this.publishNow()
    },
    setConcierge(on: boolean) {
      this.concierge = on
      this.publishNow()
    },
    setPay(p: SalonPay | null) {
      this.pay = p
      this.publishNow()
    },
    setReceipt(r: SalonReceipt | null) {
      this.receipt = r
      this.publishNow()
    },
    setVirtual(open: boolean) {
      this.virtualOpen = open
      try {
        localStorage.setItem(VIRTUAL_KEY, open ? '1' : '0')
      } catch {
        /* ignore */
      }
    },

    // ---- POS → Salon mirror -----------------------------------------------------------------
    /** Compute the screen + payload the Salon should show right now. Pure w.r.t. stores. */
    snapshot(): { screen: SalonScreen; payload: Record<string, unknown> } {
      const cart = useCartStore()
      const session = useSessionStore()
      const catalog = useCatalogStore()
      const route = router.currentRoute.value.name as string | undefined
      const customer = cart.customer?.name || null
      const lines = cart.lines.map((l) => {
        const item = catalog.byCode[l.item_code]
        return {
          id: l.id,
          item_code: l.item_code,
          item_name: l.item_name,
          qty: l.qty,
          rate: l.rate,
          amount: lineNet(l.qty, l.rate, l.discount_amount + (cart.extras[l.id] || 0)), // v0.8 POS D1
          serial_no: l.serial_no,
          certificate_no: l.certificate_no,
          image: item?.image || null,
          metal: item?.maison_metal,
          stones: item?.maison_stones,
          carat: item?.maison_carat,
          discount: Math.round((l.discount_amount + (cart.extras[l.id] || 0)) * 100) / 100 || undefined
        }
      })
      const t = cart.totals
      const totals = { net_total: t.net_total, discount: t.discount, total_taxes: t.total_taxes, tax_rate: catalog.taxRate, loyalty_amount: t.loyalty_amount, grand_total: t.grand_total, currency: session.currency }
      const base: Record<string, unknown> = { customer, lines, totals, points_earned: cart.pointsEarned, focus_line: this.focusLine, associate_first_name: session.associate?.full_name?.split(' ')[0] }
      if (!session.unlocked) return { screen: 'idle', payload: {} }
      // --- v0.6 N: the POS is asking for an ID → "Please present your ID" on the client display ---
      const ageState = useAgeStore().salonState
      if (ageState) return { screen: 'age_check', payload: { ...base, age: ageState } }
      // --- end v0.6 N ---
      if (this.consentStep && customer) return { screen: 'consent', payload: { customer, step: this.consentStep, captured: this.consentCaptured, camera: 1 } }
      if (route === 'pay') return { screen: this.pay?.step === 'approved' ? 'approved' : 'pay', payload: { ...base, pay: this.pay || { mode: 'cash', amount: t.grand_total } } }
      if (route === 'receipt') return { screen: 'receipt', payload: { customer: this.receipt ? (this.receipt as { customer?: string }).customer || null : null, receipt: this.receipt, receipt_token: this.receipt?.receipt_token || null, sales_invoice: this.receipt?.sales_invoice || null, points_earned: this.receipt?.points_earned || 0, totals: { ...totals, grand_total: this.receipt?.grand_total ?? t.grand_total } } }
      if (this.concierge && customer) return { screen: 'concierge', payload: { customer } }
      const saleRoutes = ['sell', 'client', 'returns', 'exchange', 'web-orders']
      if (!saleRoutes.includes(route || '')) return lines.length || customer ? { screen: 'basket', payload: base } : { screen: 'idle', payload: {} }
      if (!customer && (this.identifyRequested || (lines.length && this.identifyShownFor === lines[0].id))) return { screen: 'identify', payload: { ...base, ask: this.identifyRequested || undefined } }
      if (customer && !lines.length) return { screen: 'client', payload: base }
      if (lines.length) return { screen: 'basket', payload: base }
      return { screen: 'idle', payload: {} }
    },
    /** Watch the sale and publish (debounced). Safe to call repeatedly. */
    attachMirror() {
      if (watching) return
      watching = true
      const cart = useCartStore()
      watch(
        () => cart.lines.map((l) => `${l.id}:${l.qty}:${l.discount_amount}`).join('|'),
        (sig, prev) => {
          // the newest / changed line becomes the focus; first line of a sale without a client → identify
          const before = new Set((prev || '').split('|'))
          const changed = cart.lines.filter((l) => !before.has(`${l.id}:${l.qty}:${l.discount_amount}`))
          if (changed.length) this.focusLine = changed[changed.length - 1].id
          else if (!cart.lines.some((l) => l.id === this.focusLine)) this.focusLine = cart.lines[cart.lines.length - 1]?.id || null
          if (cart.lines.length === 1 && !prev && !cart.customer) this.identifyShownFor = cart.lines[0].id
          if (!cart.lines.length) {
            this.identifyShownFor = ''
            this.identifyRequested = false
            this.concierge = false
          }
          lineSig = sig
        }
      )
      watch(
        () => [lineSig, cart.customer?.name, cart.loyalty_points_redeemed, cart.totals.grand_total, router.currentRoute.value.name, useSessionStore().unlocked, this.pay?.step, this.receipt?.receipt_token, this.concierge, this.identifyRequested, this.consentStep, useAgeStore().open, useAgeStore().last?.outcome, this.receipt?.next_reward, this.receipt?.giveaway_entries], // v0.6 N/Q: age gate + rewards lines
        () => this.schedule(),
        { immediate: true }
      )
    },
    schedule() {
      if (!this.paired) return
      pending = this.snapshot()
      clearTimeout(publishTimer)
      publishTimer = window.setTimeout(() => void this.flush(), PUBLISH_DEBOUNCE_MS)
    },
    publishNow() {
      if (!this.paired) return
      pending = this.snapshot()
      clearTimeout(publishTimer)
      void this.flush()
    },
    async flush() {
      const p = pending
      pending = null
      if (!p || !this.token) return
      // Identify is sticky once the client dismissed it on the Salon only via the server; the POS just
      // avoids re-sending identical states.
      const payload = sanitizeState({ ...p.payload })
      if (this.lastPublished && this.lastPublished.screen === p.screen && samePayload(this.lastPublished.payload, payload)) return
      this.lastPublished = { screen: p.screen, payload }
      this.lastScreen = p.screen
      try {
        const r = await salonApi.publish(this.token, p.screen, { ...payload, customer: p.payload.customer })
        this.publishedSeq = r.seq
      } catch (e) {
        const code = (e as { code?: string }).code
        this.lastPublished = null
        if (code === 'AUTH' || (e as { status?: number }).status === 403) await this.unpair()
      }
    },
    /** Test hook: the state the Salon would receive for the current POS state. */
    preview(): SalonState {
      const s = this.snapshot()
      return { ...(sanitizeState(s.payload) as Record<string, unknown>), screen: s.screen, seq: this.publishedSeq } as SalonState
    }
  }
})
