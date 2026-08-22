/**
 * v0.5 K — Pinia store for the Salon device (client-facing iPad).
 *
 * Holds the session token (localStorage), the reduced model (`reducer.ts`), the playlist and the
 * boutique settings, and drives the transport: realtime when available, 2 s polling always.
 */
import { defineStore } from 'pinia'
import { salonApi, type PlaylistPiece, type SalonClient, type SalonPreferences, type SalonSession, type SalonSettings, type SalonState } from '@/api/salon'
import { clientOf, initialModel, isStale, reduce, viewOf, type IdentifyMode, type ReceiptStage, type SalonEvent, type SalonModel, type SalonView } from './reducer'
import { connectSalonRealtime, POLL_MS, type Unsubscribe } from './transport'
import { SALON_DEVICE_KEY, SALON_TOKEN_KEY, normalizeCode } from './pairing'

interface SalonStoreState {
  token: string | null
  session: SalonSession | null
  model: SalonModel
  playlist: PlaylistPiece[]
  settings: SalonSettings | null
  connected: boolean
  polling: boolean
  busy: boolean
  error: string
  now: number
  deviceId: string
  /** the last question the client typed (to show "sent") */
  askedAt: number
  emailMasked: string | null
  feedbackDone: boolean
  inviteAnswer: 0 | 1 | null
  prefsSaved: string[]
}

let unsub: Unsubscribe | null = null
let pollTimer = 0
let clockTimer = 0

function deviceId(): string {
  try {
    let id = localStorage.getItem(SALON_DEVICE_KEY)
    if (!id) {
      id = 'SALON-' + Math.random().toString(36).slice(2, 8).toUpperCase()
      localStorage.setItem(SALON_DEVICE_KEY, id)
    }
    return id
  } catch {
    return 'SALON-' + Math.random().toString(36).slice(2, 8).toUpperCase()
  }
}

export const useSalonStore = defineStore('salonDevice', {
  state: (): SalonStoreState => ({
    token: null,
    session: null,
    model: initialModel(),
    playlist: [],
    settings: null,
    connected: false,
    polling: false,
    busy: false,
    error: '',
    now: Date.now(),
    deviceId: deviceId(),
    askedAt: 0,
    emailMasked: null,
    feedbackDone: false,
    inviteAnswer: null,
    prefsSaved: []
  }),
  getters: {
    view: (s): SalonView => viewOf(s.model),
    remote: (s): SalonState => s.model.remote,
    client: (s): SalonClient | null => clientOf(s.model),
    stale: (s): boolean => isStale(s.model, s.now),
    boutiqueName: (s): string => s.session?.boutique_name || s.settings?.boutique_name || 'Maison',
    currency: (s): string => s.model.remote.totals?.currency || s.settings?.currency || 'USD',
    welcomeLine(s): string {
      const fromPlaylist = s.playlist.find((p) => p.welcome_line)?.welcome_line
      return fromPlaylist || `Welcome to ${s.session?.boutique_name || 'Maison'}`
    },
    ambientCountdown: (s): number => (s.model.ambientAt ? Math.max(0, Math.ceil((s.model.ambientAt - s.now) / 1000)) : 0)
  },
  actions: {
    dispatch(e: SalonEvent) {
      const before = this.model
      this.model = reduce(before, e)
      // a new remote screen resets the per-screen UI memory
      if (e.type === 'remote' && before.remote.screen !== this.model.remote.screen) {
        this.askedAt = 0
        this.emailMasked = null
        this.feedbackDone = false
        this.inviteAnswer = null
        this.prefsSaved = []
        this.error = ''
      }
    },
    /** Boot: restore the token and resume (or land on the pairing screen). */
    async restore() {
      try {
        this.token = localStorage.getItem(SALON_TOKEN_KEY)
      } catch {
        this.token = null
      }
      this.startClock()
      if (!this.token) return
      try {
        const s = await salonApi.state(this.token, 0)
        this.session = s
        this.dispatch({ type: 'paired', state: s.state, now: Date.now() })
        const pl = await salonApi.playlist(this.token)
        this.playlist = pl.playlist
        this.settings = pl.settings
        this.start()
      } catch (e) {
        if ((e as { code?: string }).code === 'AUTH' || (e as { status?: number }).status === 403) this.forget()
        else {
          // offline at boot: keep the token, keep trying
          this.dispatch({ type: 'paired', state: null, now: 0 })
          this.start()
        }
      }
    },
    async pair(code: string): Promise<boolean> {
      this.error = ''
      this.busy = true
      try {
        const s = await salonApi.pair(normalizeCode(code), this.deviceId)
        this.token = s.token
        try {
          localStorage.setItem(SALON_TOKEN_KEY, s.token)
        } catch {
          /* ignore */
        }
        this.session = s
        this.playlist = s.playlist || []
        this.settings = s.settings || null
        this.dispatch({ type: 'paired', state: s.state, now: Date.now() })
        this.start()
        return true
      } catch (e) {
        this.error = (e as Error).message || 'Could not pair'
        return false
      } finally {
        this.busy = false
      }
    },
    forget() {
      this.stop()
      this.token = null
      this.session = null
      try {
        localStorage.removeItem(SALON_TOKEN_KEY)
      } catch {
        /* ignore */
      }
      this.dispatch({ type: 'unpaired' })
    },
    async unpair() {
      if (this.token) void salonApi.unpair(this.token).catch(() => undefined)
      this.forget()
    },
    startClock() {
      if (clockTimer) return
      clockTimer = window.setInterval(() => {
        this.now = Date.now()
        this.dispatch({ type: 'tick', now: this.now })
      }, 1000)
    },
    start() {
      this.stop()
      if (!this.token) return
      unsub = connectSalonRealtime(this.token, {
        onState: (s) => this.dispatch({ type: 'remote', state: s, now: Date.now() }),
        onConnection: (c) => (this.connected = c)
      })
      this.polling = true
      const tick = async () => {
        if (!this.polling || !this.token) return
        try {
          const r = await salonApi.state(this.token, this.model.seq)
          this.dispatch({ type: 'seen', now: Date.now() })
          if (r.status !== 'Paired') {
            this.forget()
            return
          }
          if (r.changed && r.state) this.dispatch({ type: 'remote', state: r.state, now: Date.now() })
        } catch (e) {
          const code = (e as { code?: string }).code
          if (code === 'AUTH' || (e as { status?: number }).status === 403) {
            this.forget()
            return
          }
        }
        pollTimer = window.setTimeout(tick, POLL_MS)
      }
      pollTimer = window.setTimeout(tick, 300)
    },
    stop() {
      unsub?.()
      unsub = null
      this.polling = false
      clearTimeout(pollTimer)
      this.connected = false
    },

    // ---- client actions -----------------------------------------------------------------
    setIdentifyMode(mode: IdentifyMode) {
      this.dispatch({ type: 'identify_mode', mode })
    },
    async identify(code: string): Promise<boolean> {
      if (!this.token) return false
      this.busy = true
      this.error = ''
      try {
        const r = await salonApi.identify(this.token, code)
        if (!r.found || !r.client) {
          this.error = 'We could not find you — try another number, or join the house.'
          return false
        }
        this.dispatch({ type: 'attached', client: r.client })
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    async signup(args: { name: string; phone?: string; email?: string; birthday?: string; marketing_email?: 0 | 1; marketing_sms?: 0 | 1 }): Promise<{ ok: boolean; offerRecognition: boolean }> {
      if (!this.token) return { ok: false, offerRecognition: false }
      this.busy = true
      this.error = ''
      try {
        const r = await salonApi.signup(this.token, args)
        const offer = !!r.face_recognition_enabled && !r.client.face_consent
        this.dispatch({ type: 'attached', client: r.client, offer })
        return { ok: true, offerRecognition: offer }
      } catch (e) {
        this.error = (e as Error).message
        return { ok: false, offerRecognition: false }
      } finally {
        this.busy = false
      }
    },
    async consent(method: 'Hold-to-agree' | 'Signature', signature_data_url?: string): Promise<boolean> {
      if (!this.token) return false
      this.busy = true
      try {
        await salonApi.consent(this.token, method, this.settings?.consent_text_version, signature_data_url)
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    async declineConsent() {
      if (!this.token) return
      await salonApi.consent_decline(this.token).catch(() => undefined)
    },
    async ask(question: string, item_code?: string): Promise<boolean> {
      if (!this.token) return false
      this.busy = true
      try {
        await salonApi.ask(this.token, question, item_code)
        this.askedAt = Date.now()
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    setReceiptStage(stage: ReceiptStage) {
      this.dispatch({ type: 'receipt_stage', stage, now: Date.now() })
    },
    async feedback(rating: number, comment?: string): Promise<boolean> {
      if (!this.token) return false
      this.busy = true
      this.error = ''
      try {
        await salonApi.feedback(this.token, rating, comment)
        this.feedbackDone = true
        this.dispatch({ type: 'feedback_sent', rating, now: Date.now() })
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    async invite(wants: 0 | 1) {
      if (!this.token) return
      this.busy = true
      try {
        await salonApi.invite(this.token, wants)
        this.inviteAnswer = wants
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.busy = false
      }
      this.dispatch({ type: 'receipt_stage', stage: 'invite', now: Date.now() })
    },
    async emailReceipt(email?: string): Promise<boolean> {
      if (!this.token) return false
      this.busy = true
      this.error = ''
      try {
        const r = await salonApi.email_receipt(this.token, email)
        this.emailMasked = r.email_masked
        this.dispatch({ type: 'receipt_stage', stage: this.model.receiptStage, now: Date.now() })
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    async savePreferences(answers: SalonPreferences): Promise<boolean> {
      if (!this.token) return false
      this.busy = true
      this.error = ''
      try {
        const r = await salonApi.preferences(this.token, answers)
        this.prefsSaved = r.saved
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    offerDone() {
      this.dispatch({ type: 'offer_done' })
    },
    dismiss() {
      this.dispatch({ type: 'dismiss', now: Date.now() })
    }
  }
})
