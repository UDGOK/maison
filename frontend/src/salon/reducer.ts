/**
 * v0.5 K — the Salon's screen state machine, pure and unit-tested.
 *
 * Input: server states (`salon_state`, strictly increasing `seq`), local intents (the client tapped
 * "Join AWANZ", finished the feedback, …) and clock ticks. Output: `view` — the screen the Salon
 * renders — plus the local flags each screen needs. The remote state is the source of truth; local
 * state only refines it (sub-steps inside identify / receipt) and is reset whenever the POS moves on.
 */
import type { SalonClient, SalonState } from '@/api/salon'

export type SalonView =
  | 'pair'
  | 'ambient'
  | 'identify'
  | 'signup'
  | 'client'
  | 'basket'
  | 'pay'
  | 'approved'
  | 'thankyou'
  | 'feedback'
  | 'invite'
  | 'consent'
  | 'concierge'
  | 'idcheck' // v0.6 N — "Please present your ID"
  | 'unpaired'

export type IdentifyMode = 'menu' | 'keypad' | 'email' | 'scan' | 'signup' | 'dismissed'
export type ReceiptStage = 'thanks' | 'feedback' | 'invite' | 'done'

export interface SalonModel {
  paired: boolean
  remote: SalonState
  /** seq of the last remote state that was applied */
  seq: number
  /** identify sub-step */
  identify: IdentifyMode
  /** receipt sub-step */
  receiptStage: ReceiptStage
  /** the client attached locally (identify / sign-up) before the POS republishes */
  localClient: SalonClient | null
  /** epoch ms when the thank-you flow auto-returns to ambient (0 = no timer) */
  ambientAt: number
  /** remote seq the client dismissed back to ambient (thank-you finished) */
  dismissedSeq: number
  /** stale = no state or poll for STALE_MS */
  lastSeen: number
  feedbackRating: number
  error: string
  /** sign-up finished; the optional recognition offer is still on screen */
  offer: boolean
}

export type SalonEvent =
  | { type: 'paired'; state?: SalonState | null; now?: number }
  | { type: 'unpaired' }
  | { type: 'remote'; state: SalonState; now?: number }
  | { type: 'seen'; now: number }
  | { type: 'identify_mode'; mode: IdentifyMode }
  | { type: 'attached'; client: SalonClient; offer?: boolean }
  | { type: 'offer_done' }
  | { type: 'receipt_stage'; stage: ReceiptStage; now?: number }
  | { type: 'feedback_sent'; rating: number; now?: number }
  | { type: 'dismiss'; now?: number }
  | { type: 'tick'; now: number }
  | { type: 'error'; message: string }

export const THANK_YOU_MS = 20_000
export const STALE_MS = 15_000

export const initialModel = (): SalonModel => ({
  paired: false,
  remote: { screen: 'idle', seq: 0 },
  seq: 0,
  identify: 'menu',
  receiptStage: 'thanks',
  localClient: null,
  ambientAt: 0,
  dismissedSeq: -1,
  lastSeen: 0,
  feedbackRating: 0,
  error: '',
  offer: false
})

function resetLocal(m: SalonModel): SalonModel {
  return { ...m, identify: 'menu', receiptStage: 'thanks', ambientAt: 0, feedbackRating: 0, error: '' }
}

export function reduce(m: SalonModel, e: SalonEvent): SalonModel {
  switch (e.type) {
    case 'paired': {
      const state = e.state || { screen: 'idle', seq: 0 }
      return { ...resetLocal(m), paired: true, remote: state, seq: state.seq || 0, localClient: null, dismissedSeq: -1, lastSeen: e.now ?? m.lastSeen }
    }
    case 'unpaired':
      return { ...initialModel(), paired: false }
    case 'remote': {
      if (!m.paired) return m
      const s = e.state
      if ((s.screen as string) === 'unpaired') return reduce(m, { type: 'unpaired' })
      if (typeof s.seq === 'number' && s.seq < m.seq) return { ...m, lastSeen: e.now ?? m.lastSeen } // stale / out of order
      const screenChanged = s.screen !== m.remote.screen
      const sameSeq = s.seq === m.seq
      let next: SalonModel = { ...m, remote: s, seq: s.seq ?? m.seq, lastSeen: e.now ?? m.lastSeen }
      if (!sameSeq && screenChanged) next = resetLocal(next)
      // the associate pressed "Ask to identify" again → bring the menu back even if the client dismissed it
      if (!sameSeq && s.screen === 'identify' && s.ask) next.identify = 'menu'
      // the POS took over (it republished with the client) → drop the optimistic local client
      if (s.client && !s.pending_pos) next.localClient = null
      if (s.screen === 'idle') next.localClient = null
      // the offer lives until the client answers it; a consent hand-off (or any other screen) ends it
      if (!['identify', 'client', 'basket'].includes(s.screen)) next.offer = false
      if (s.screen === 'receipt' && (screenChanged || !m.ambientAt)) next.ambientAt = (e.now ?? Date.now()) + THANK_YOU_MS
      return next
    }
    case 'seen':
      return { ...m, lastSeen: e.now }
    case 'identify_mode':
      return { ...m, identify: e.mode, error: '' }
    case 'attached':
      return { ...m, localClient: e.client, identify: 'menu', error: '', offer: !!e.offer }
    case 'offer_done':
      return { ...m, offer: false }
    case 'receipt_stage': {
      const now = e.now ?? Date.now()
      // every interaction extends the auto-return
      return { ...m, receiptStage: e.stage, ambientAt: e.stage === 'done' ? now + 4000 : now + THANK_YOU_MS }
    }
    case 'feedback_sent':
      return { ...m, feedbackRating: e.rating, receiptStage: 'invite', ambientAt: (e.now ?? Date.now()) + THANK_YOU_MS }
    case 'dismiss':
      return { ...m, dismissedSeq: m.seq, ambientAt: 0, receiptStage: 'done' }
    case 'tick':
      if (m.ambientAt && e.now >= m.ambientAt) return { ...m, dismissedSeq: m.seq, ambientAt: 0, receiptStage: 'done' }
      return m
    case 'error':
      return { ...m, error: e.message }
  }
}

/** The client to show: the POS's (authoritative) or the one just attached on the Salon. */
export function clientOf(m: SalonModel): SalonClient | null {
  return (m.remote.client as SalonClient | null) || m.localClient
}

export function isStale(m: SalonModel, now: number): boolean {
  return m.paired && m.lastSeen > 0 && now - m.lastSeen > STALE_MS
}

/** Derive the rendered screen. */
export function viewOf(m: SalonModel): SalonView {
  if (!m.paired) return 'pair'
  const r = m.remote
  if (m.dismissedSeq === m.seq && m.seq > 0) return 'ambient'
  if (m.offer && (r.screen === 'identify' || r.screen === 'client' || r.screen === 'basket')) return 'signup'
  switch (r.screen) {
    case 'idle':
      return 'ambient'
    case 'identify':
      if (clientOf(m)) return 'client'
      if (m.identify === 'dismissed') return r.lines?.length ? 'basket' : 'identify'
      return m.identify === 'signup' ? 'signup' : 'identify'
    case 'client':
      return 'client'
    case 'basket':
      return 'basket'
    case 'pay':
      return r.pay?.step === 'approved' ? 'approved' : 'pay'
    case 'approved':
      return 'approved'
    case 'receipt':
      if (m.receiptStage === 'feedback') return 'feedback'
      if (m.receiptStage === 'invite') return 'invite'
      if (m.receiptStage === 'done') return 'thankyou'
      return 'thankyou'
    case 'consent':
      return 'consent'
    case 'feedback':
      return 'feedback'
    case 'concierge':
      return 'concierge'
    case 'age_check': // v0.6 N
      return 'idcheck'
    default:
      return 'ambient'
  }
}
