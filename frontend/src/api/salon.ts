/**
 * v0.5 K — Maison Salon (client-facing screen) API: `maison_pos.api.salon.*`.
 *
 * Two callers share the contract:
 *   - the POS (authenticated associate): `pairing_code`, `pos_status`, `pos_poll`, `publish`, `pending_consent`, `unpair_pos`;
 *   - the Salon device (a **guest** holding the session token): `pair`, `state`, `identify`, `signup`, `consent`,
 *     `consent_decline`, `ask`, `feedback`, `invite`, `email_receipt`, `preferences`, `unpair`.
 *
 * The mock (VITE_MOCK=1) keeps the "server" in `localStorage` (`maison.mock.salon`) so a real `/salon` tab — or the
 * dev "virtual salon" iframe in Settings — shares state with the POS tab through `storage` events.
 */
import { ApiError, type Customer } from './types'
import { CUSTOMERS, ITEMS, PRICES } from './seed'
import { stripHtml } from '@/utils/text'
import { firstName, maskClientNumber, maskEmail, maskPhone, sanitizeState } from '@/salon/mask'

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------
export type SalonScreen = 'idle' | 'identify' | 'client' | 'basket' | 'pay' | 'approved' | 'receipt' | 'consent' | 'feedback' | 'concierge'
export const SALON_SCREENS: SalonScreen[] = ['idle', 'identify', 'client', 'basket', 'pay', 'approved', 'receipt', 'consent', 'feedback', 'concierge']

/** The only client shape the Salon ever sees. */
export interface SalonClient {
  customer: string
  first_name: string
  customer_name?: string
  client_number_masked?: string | null
  phone_masked?: string | null
  email_masked?: string | null
  has_email?: boolean
  tier?: string | null
  loyalty_points?: number
  points_value?: number
  face_consent?: 0 | 1
  next_tier?: string | null
  to_next_tier?: number | null
  tier_progress?: number | null
}

export interface SalonLine {
  id?: string
  item_code: string
  item_name: string
  qty: number
  rate: number
  amount: number
  serial_no?: string
  certificate_no?: string
  image?: string | null
  metal?: string
  stones?: string
  carat?: string
  discount?: number
}

export interface SalonTotals {
  net_total: number
  discount: number
  total_taxes: number
  tax_rate?: number
  loyalty_amount?: number
  grand_total: number
  currency: string
}

export interface SalonPay {
  mode: 'card' | 'cash'
  amount: number
  step?: 'present' | 'processing' | 'approved' | 'error'
  card_brand?: string
  last4?: string
}

export interface SalonReceipt {
  receipt_token?: string | null
  receipt_url?: string | null
  sales_invoice?: string | null
  points_earned?: number
  points_balance?: number
  tier?: string | null
  next_tier?: string | null
  tier_progress?: number | null
  grand_total?: number
  currency?: string
  feedback_submitted?: boolean
}

export interface SalonState {
  screen: SalonScreen
  seq: number
  ts?: string
  client?: SalonClient | null
  lines?: SalonLine[]
  /** the line most recently added/changed — shown large */
  focus_line?: string | null
  totals?: SalonTotals | null
  points_earned?: number
  pay?: SalonPay | null
  receipt?: SalonReceipt | null
  receipt_token?: string | null
  sales_invoice?: string | null
  /** consent hand-off (`step`: agree → capture → done / unavailable) */
  step?: 'agree' | 'capture' | 'done' | 'unavailable'
  camera?: 0 | 1
  /** set by the server right after identify / signup, until the POS republishes */
  pending_pos?: boolean
  associate_first_name?: string
  [key: string]: unknown
}

export interface PlaylistPiece {
  item_code: string
  item_name: string
  caption?: string | null
  image?: string | null
  seconds: number
  metal?: string | null
  stones?: string | null
  carat?: string | number | null
  playlist?: string
  welcome_line?: string | null
}

export interface SalonSettings {
  boutique_name?: string
  city?: string
  consent_text?: string
  consent_text_version?: string
  face_recognition_enabled: 0 | 1
  feedback_enabled: 0 | 1
  receipt_qr_base_url?: string
  currency?: string
}

export interface SalonSession {
  token: string
  boutique: string
  boutique_name?: string
  city?: string
  status: 'Paired' | 'Unpaired' | 'Expired'
  paired_at?: string | null
  expires_at?: string | null
  pos_device_id?: string
  salon_device_id?: string | null
  seq: number
  screen: SalonScreen
  server_time?: string
  state?: SalonState
  playlist?: PlaylistPiece[]
  settings?: SalonSettings
}

export type SalonMessageType =
  | 'client_attached'
  | 'consent_agreed'
  | 'consent_declined'
  | 'question'
  | 'feedback'
  | 'invite'
  | 'email_receipt'
  | 'preferences'

export interface SalonMessage {
  seq: number
  type: SalonMessageType
  ts: string
  customer?: string
  how?: 'identify' | 'signup'
  created?: boolean
  client?: SalonClient
  consent?: { method: 'Hold-to-agree' | 'Signature'; text_version: string; captured_at?: string; customer?: string }
  has_signature?: boolean
  question?: string
  item_code?: string | null
  item_name?: string | null
  interaction?: string | null
  rating?: number
  wants_invitation?: 0 | 1
  email_masked?: string | null
  fields?: string[]
  styles?: string[]
  occasions?: string[]
  [key: string]: unknown
}

export interface PairingCode {
  code: string
  expires_at: string
  ttl_seconds: number
  qr: string
  salon_url: string
  boutique: string
  pos_device_id: string
}

export interface SalonPreferences {
  ring_size?: string
  wrist_size?: string
  metal_preference?: string
  styles?: string[]
  occasions?: string[]
  anniversary?: string
  birthday?: string
  notes?: string
}

export interface SalonApi {
  // ---- POS side (associate)
  pairing_code(boutique: string, pos_device_id: string): Promise<PairingCode>
  pos_status(boutique: string, pos_device_id: string, since?: number): Promise<{ paired: boolean; session: SalonSession | null; messages: SalonMessage[]; inbox_seq: number }>
  pos_poll(session: string, since: number): Promise<{ ok: boolean; status: string; inbox_seq: number; messages: SalonMessage[]; seq: number; screen: SalonScreen }>
  publish(session: string, event: SalonScreen, payload: Record<string, unknown>): Promise<{ ok: boolean; seq: number; screen: SalonScreen }>
  pending_consent(session: string): Promise<{ consent: { method: 'Hold-to-agree' | 'Signature'; text_version: string; signature_data_url?: string; customer: string } | null }>
  unpair_pos(args: { session?: string; boutique?: string; pos_device_id?: string }): Promise<{ ok: boolean; unpaired: boolean }>
  // ---- Salon side (guest + token)
  pair(code: string, salon_device_id?: string): Promise<SalonSession>
  state(token: string, since?: number): Promise<SalonSession & { changed: boolean; pending_consent?: boolean }>
  playlist(token: string): Promise<{ boutique: string; playlist: PlaylistPiece[]; settings: SalonSettings }>
  identify(token: string, code: string): Promise<{ found: boolean; client?: SalonClient; created?: boolean }>
  signup(token: string, args: { name: string; phone?: string; email?: string; birthday?: string; marketing_email?: 0 | 1; marketing_sms?: 0 | 1 }): Promise<{ ok: boolean; client: SalonClient; created: boolean; face_recognition_enabled: 0 | 1 }>
  consent(token: string, method: 'Hold-to-agree' | 'Signature', text_version?: string, signature_data_url?: string): Promise<{ ok: boolean; camera: 0 | 1 }>
  consent_decline(token: string): Promise<{ ok: boolean }>
  ask(token: string, question: string, item_code?: string): Promise<{ ok: boolean; interaction?: string | null }>
  feedback(token: string, rating: number, comment?: string): Promise<{ ok: boolean; duplicate?: boolean; feedback?: string }>
  invite(token: string, wants_invitation: 0 | 1): Promise<{ ok: boolean; wants_invitation: 0 | 1 }>
  email_receipt(token: string, email?: string): Promise<{ ok: boolean; email_masked: string | null; sent: boolean; queued: boolean }>
  preferences(token: string, answers: SalonPreferences): Promise<{ ok: boolean; saved: string[]; styles: string[]; occasions: string[] }>
  unpair(token: string): Promise<{ ok: boolean; unpaired: boolean }>
}

// ---------------------------------------------------------------------------------------------
// Frappe client
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.salon.'

function csrf(): string {
  return (typeof window !== 'undefined' && window.csrf_token) || ''
}

async function call<T>(method: string, args: Record<string, unknown> = {}, get = false): Promise<T> {
  const url = BASE + method
  let res: Response
  try {
    if (get) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) qs.set(k, typeof v === 'string' ? v : JSON.stringify(v))
      res = await fetch(`${url}?${qs}`, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } })
    } else {
      const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
      if (csrf()) headers['X-Frappe-CSRF-Token'] = csrf()
      res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(args) })
    }
  } catch (e) {
    throw new ApiError((e as Error).message || 'Network error', 'NETWORK', 0)
  }
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    if (body?._server_messages) {
      try {
        message = stripHtml((JSON.parse(body._server_messages) as string[]).map((m) => JSON.parse(m).message).join('\n'))
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = stripHtml(String(body.exception).split('\n').pop()) || message
    throw new ApiError(message, res.status === 401 || res.status === 403 ? 'AUTH' : body?.exc_type || `HTTP_${res.status}`, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappeSalon: SalonApi = {
  pairing_code: (boutique, pos_device_id) => call('pairing_code', { boutique, pos_device_id }),
  pos_status: (boutique, pos_device_id, since = 0) => call('pos_status', { boutique, pos_device_id, since }, true),
  pos_poll: (session, since) => call('pos_poll', { session, since }, true),
  publish: (session, event, payload) => call('publish', { session, event, payload }),
  pending_consent: (session) => call('pending_consent', { session }),
  unpair_pos: (args) => call('unpair_pos', { ...args }),
  pair: (code, salon_device_id) => call('pair', { code, salon_device_id }),
  state: (token, since = 0) => call('state', { token, since }, true),
  playlist: (token) => call('playlist', { token }, true),
  identify: (token, code) => call('identify', { token, code }),
  signup: (token, args) => call('signup', { token, ...args }),
  consent: (token, method, text_version, signature_data_url) => call('consent', { token, method, text_version, signature_data_url }),
  consent_decline: (token) => call('consent_decline', { token }),
  ask: (token, question, item_code) => call('ask', { token, question, item_code }),
  feedback: (token, rating, comment) => call('feedback', { token, rating, comment }),
  invite: (token, wants_invitation) => call('invite', { token, wants_invitation }),
  email_receipt: (token, email) => call('email_receipt', { token, email }),
  preferences: (token, answers) => call('preferences', { token, answers }),
  unpair: (token) => call('unpair', { token })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1) — the "server" lives in localStorage so several windows share it
// ---------------------------------------------------------------------------------------------
export const MOCK_LS = 'maison.mock.salon'
export const MOCK_EVENT = 'maison:salon-mock'
export const PAIR_TTL_MS = 10 * 60 * 1000
export const SESSION_HOURS = 12

interface MockSession extends SalonSession {
  sales_invoice?: string | null
  inbox: SalonMessage[]
  inbox_seq: number
  customer?: string | null
  pending_consent?: Record<string, unknown> | null
  feedback?: { invoice: string; rating: number; comment?: string }[]
}

interface MockServer {
  codes: Record<string, { boutique: string; pos_device_id: string; expires_at: string }>
  sessions: Record<string, MockSession>
  customers: Customer[]
  interactions: { customer: string; type: string; note: string; ts: string; boutique: string }[]
  profiles: Record<string, Record<string, unknown>>
  feedback: { invoice: string; boutique: string; rating: number; comment?: string; ts: string; customer?: string | null }[]
  seq: number
}

const MOCK_BOUTIQUES: Record<string, { boutique_name: string; city: string }> = {
  'CHI-OAK': { boutique_name: 'Maison Oak Street', city: 'Chicago, IL 60611' },
  'NYC-MAD': { boutique_name: 'Maison Madison Avenue', city: 'New York, NY 10065' },
  'LA-RODEO': { boutique_name: 'Maison Rodeo Drive', city: 'Beverly Hills, CA 90210' }
}

export const MOCK_PLAYLIST: PlaylistPiece[] = [
  { item_code: 'HJ-PAR-032', item_name: 'Parure Lumière', caption: 'Eighteen carats of light, set by hand over four hundred hours.', seconds: 12, metal: 'Platinum', stones: 'Diamonds' },
  { item_code: 'WT-CHR-026', item_name: 'Chronographe Atelier', caption: 'A movement finished by one watchmaker, start to finish.', seconds: 12, metal: '18k Rose Gold' },
  { item_code: 'RG-HAL-003', item_name: 'Halo Cushion 1.2ct', caption: 'The proposal piece.', seconds: 12, metal: '18k Rose Gold', stones: 'Cushion G VS2' },
  { item_code: 'ER-STD-020', item_name: 'Diamond Studs 1.0ct', caption: 'Two carats, F colour, worn every day.', seconds: 10, metal: 'Platinum' }
].map((p) => ({ ...p, item_name: ITEMS.find((i) => i.item_code === p.item_code)?.item_name || p.item_name, image: ITEMS.find((i) => i.item_code === p.item_code)?.image || null, welcome_line: 'Welcome to the house' }))

function fresh(): MockServer {
  return { codes: {}, sessions: {}, customers: [], interactions: [], profiles: {}, feedback: [], seq: 1 }
}

function load(): MockServer {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(MOCK_LS) : null
    if (raw) return { ...fresh(), ...(JSON.parse(raw) as Partial<MockServer>) }
  } catch {
    /* ignore */
  }
  return fresh()
}

function save(s: MockServer) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MOCK_LS, JSON.stringify(s))
  } catch {
    /* quota */
  }
  try {
    window.dispatchEvent(new CustomEvent(MOCK_EVENT))
  } catch {
    /* not in a browser */
  }
}

function delay() {
  return new Promise((r) => setTimeout(r, 40 + Math.random() * 80))
}
async function guard() {
  await delay()
  if (typeof window !== 'undefined' && window.__maisonOffline) throw new ApiError('Failed to fetch', 'NETWORK', 0)
}

function allCustomers(s: MockServer): Customer[] {
  // seed customers + the ones created from the Salon (the POS tab's own mock customers are in its memory;
  // `client_attached` carries the full summary so the POS can attach without a lookup)
  let extra: Customer[] = []
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('maison.mock.state') : null
    if (raw) extra = ((JSON.parse(raw).customers as Customer[]) || []).filter((c) => !CUSTOMERS.some((x) => x.name === c.name))
  } catch {
    /* ignore */
  }
  return [...CUSTOMERS, ...extra.filter((c) => !s.customers.some((x) => x.name === c.name)), ...s.customers]
}

function digits(v?: string | null): string {
  return (v || '').replace(/\D+/g, '')
}

export function mockClientSummary(c: Customer): SalonClient {
  const tiers = ['Collector', 'Connoisseur', 'Patron', 'Ambassador']
  const idx = Math.max(0, tiers.indexOf(c.tier || 'Collector'))
  return {
    customer: c.name,
    first_name: firstName(c.customer_name),
    customer_name: c.customer_name,
    client_number_masked: maskClientNumber(c.client_number),
    phone_masked: maskPhone(c.mobile_no),
    email_masked: maskEmail(c.email_id),
    has_email: !!c.email_id,
    tier: c.tier,
    loyalty_points: c.loyalty_points,
    points_value: c.points_value ?? c.loyalty_points,
    face_consent: c.maison_face_consent || 0,
    next_tier: tiers[idx + 1] || null,
    to_next_tier: tiers[idx + 1] ? [5000, 25000, 100000][idx] : 0,
    tier_progress: tiers[idx + 1] ? Math.min(0.95, (c.loyalty_points % 5000) / 5000 + 0.1) : 1
  }
}

function sessionOr403(s: MockServer, token: string): MockSession {
  const sess = s.sessions[token]
  if (!sess || sess.status !== 'Paired') throw new ApiError('Salon session ended', 'PermissionError', 403)
  if (sess.expires_at && Date.now() >= new Date(sess.expires_at).getTime()) {
    sess.status = 'Expired'
    save(s)
    throw new ApiError('Salon session expired', 'PermissionError', 403)
  }
  return sess
}

function pub(s: MockServer, sess: MockSession): SalonSession {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { inbox, inbox_seq, customer, pending_consent, feedback, sales_invoice, ...rest } = sess
  return { ...rest, server_time: new Date().toISOString() }
}

function setState(sess: MockSession, screen: SalonScreen, payload: Record<string, unknown>) {
  sess.seq += 1
  sess.screen = screen
  sess.state = { ...(payload as SalonState), screen, seq: sess.seq, ts: new Date().toISOString() }
}

function pushInbox(sess: MockSession, type: SalonMessageType, payload: Record<string, unknown> = {}): SalonMessage {
  sess.inbox_seq += 1
  const msg: SalonMessage = { seq: sess.inbox_seq, type, ts: new Date().toISOString(), ...payload }
  sess.inbox = [...sess.inbox, msg].slice(-50)
  return msg
}

function attach(s: MockServer, sess: MockSession, c: Customer, how: 'identify' | 'signup', created = false) {
  const client = mockClientSummary(c)
  sess.customer = c.name
  const msg = pushInbox(sess, 'client_attached', { customer: c.name, how, created, client, customer_row: { ...c } })
  const prev = sess.state || { screen: 'idle', seq: 0 }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seq, ts, screen, ...keep } = prev
  setState(sess, 'client', { ...keep, client, pending_pos: true })
  save(s)
  return { ok: true, client, created, message_seq: msg.seq }
}

export const mockSalon: SalonApi = {
  async pairing_code(boutique, pos_device_id) {
    await guard()
    const s = load()
    let code = ''
    do code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    while (s.codes[code])
    const expires_at = new Date(Date.now() + PAIR_TTL_MS).toISOString()
    s.codes[code] = { boutique, pos_device_id, expires_at }
    save(s)
    return { code, expires_at, ttl_seconds: PAIR_TTL_MS / 1000, qr: `MS:${code}`, salon_url: `${location.origin}/salon?code=${code}`, boutique, pos_device_id }
  },
  async pos_status(boutique, pos_device_id, since = 0) {
    await guard()
    const s = load()
    const sess = Object.values(s.sessions).find((x) => x.boutique === boutique && x.pos_device_id === pos_device_id && x.status === 'Paired')
    if (!sess) return { paired: false, session: null, messages: [], inbox_seq: 0 }
    return { paired: true, session: pub(s, sess), messages: sess.inbox.filter((m) => m.seq > since), inbox_seq: sess.inbox_seq }
  },
  async pos_poll(session, since) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, session)
    return { ok: true, status: sess.status, inbox_seq: sess.inbox_seq, messages: sess.inbox.filter((m) => m.seq > since), seq: sess.seq, screen: sess.screen }
  },
  async publish(session, event, payload) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, session)
    if (!SALON_SCREENS.includes(event)) throw new ApiError(`Unknown salon event ${event}`, 'ValidationError', 417)
    const data = sanitizeState({ ...payload }) as Record<string, unknown>
    const customer = payload.customer as string | undefined
    if (customer) {
      const c = allCustomers(s).find((x) => x.name === customer)
      if (c) data.client = mockClientSummary(c)
      sess.customer = customer
    } else if ('client' in data && customer === null) delete data.client
    delete data.customer
    if (event === 'idle') {
      sess.customer = null
      sess.pending_consent = null
      sess.sales_invoice = null
    }
    if (event === 'receipt' && data.sales_invoice) sess.sales_invoice = data.sales_invoice as string
    setState(sess, event, data)
    save(s)
    return { ok: true, seq: sess.seq, screen: event }
  },
  async pending_consent(session) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, session)
    const consent = (sess.pending_consent as any) || null
    sess.pending_consent = null
    save(s)
    return { consent }
  },
  async unpair_pos({ session, boutique, pos_device_id }) {
    await guard()
    const s = load()
    const sess = session ? s.sessions[session] : Object.values(s.sessions).find((x) => x.boutique === boutique && x.pos_device_id === pos_device_id && x.status === 'Paired')
    if (!sess || sess.status !== 'Paired') return { ok: true, unpaired: false }
    sess.status = 'Unpaired'
    sess.seq += 1
    save(s)
    return { ok: true, unpaired: true }
  },

  async pair(code, salon_device_id) {
    await guard()
    const s = load()
    code = digits(String(code).replace(/^MS:/i, ''))
    if (code.length !== 6) throw new ApiError('Enter the 6-digit code shown on the point of sale', 'ValidationError', 417)
    const info = s.codes[code]
    if (!info || Date.now() > new Date(info.expires_at).getTime()) throw new ApiError('That code is not valid any more — ask the associate for a new one', 'ValidationError', 417)
    delete s.codes[code]
    for (const old of Object.values(s.sessions)) if (old.boutique === info.boutique && old.pos_device_id === info.pos_device_id && old.status === 'Paired') old.status = 'Unpaired'
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
    const now = new Date()
    const sess: MockSession = {
      token,
      boutique: info.boutique,
      boutique_name: MOCK_BOUTIQUES[info.boutique]?.boutique_name || info.boutique,
      city: MOCK_BOUTIQUES[info.boutique]?.city,
      status: 'Paired',
      paired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString(),
      pos_device_id: info.pos_device_id,
      salon_device_id: salon_device_id || null,
      seq: 1,
      screen: 'idle',
      state: { screen: 'idle', seq: 1 },
      inbox: [],
      inbox_seq: 0,
      customer: null
    }
    s.sessions[token] = sess
    save(s)
    return { ...pub(s, sess), playlist: MOCK_PLAYLIST, settings: mockSettings(info.boutique) }
  },
  async state(token, since = 0) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    const changed = sess.seq !== since
    const out = pub(s, sess)
    if (!changed) delete out.state
    return { ...out, changed, pending_consent: !!sess.pending_consent }
  },
  async playlist(token) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    return { boutique: sess.boutique, playlist: MOCK_PLAYLIST, settings: mockSettings(sess.boutique) }
  },
  async identify(token, code) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    code = code.trim()
    const list = allCustomers(s)
    let c: Customer | undefined
    if (/^MC:/i.test(code)) {
      const p = code.slice(3).trim()
      c = list.find((x) => x.name === p || x.client_number === p.toUpperCase())
    } else if (/^MC\d{6}$/i.test(code)) c = list.find((x) => x.client_number === code.toUpperCase())
    else if (code.includes('@')) c = list.find((x) => (x.email_id || '').toLowerCase() === code.toLowerCase())
    else {
      const d = digits(code)
      if (d.length >= 7) {
        const exact = list.filter((x) => digits(x.mobile_no).endsWith(d))
        if (exact.length === 1) c = exact[0]
      }
    }
    if (!c) return { found: false }
    return { found: true, ...attach(s, sess, c, 'identify') }
  },
  async signup(token, args) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    const name = (args.name || '').trim().replace(/\s+/g, ' ')
    if (name.length < 2) throw new ApiError('Please tell us your name', 'ValidationError', 417)
    const phone = (args.phone || '').trim() || undefined
    const email = (args.email || '').trim().toLowerCase() || undefined
    if (!phone && !email) throw new ApiError('A phone number or an e-mail is needed to find you again', 'ValidationError', 417)
    const list = allCustomers(s)
    let c = list.find((x) => (email && (x.email_id || '').toLowerCase() === email) || (phone && digits(phone).length >= 4 && digits(x.mobile_no).endsWith(digits(phone))))
    let created = false
    if (!c) {
      created = true
      c = { name: `CUST-S${String(s.seq++).padStart(4, '0')}`, customer_name: name, mobile_no: phone, email_id: email, loyalty_points: 0, points_value: 0, tier: 'Collector', client_number: `MC${String(700000 + s.seq).padStart(6, '0')}`, maison_face_consent: 0 }
      s.customers.push(c)
    }
    s.profiles[c.name] = { ...(s.profiles[c.name] || {}), do_not_email: args.marketing_email ? 0 : 1, do_not_sms: args.marketing_sms ? 0 : 1, birthday: args.birthday || (s.profiles[c.name] || {}).birthday }
    s.interactions.push({ customer: c.name, type: 'Visit', note: created ? `Joined Maison from the Salon at ${sess.boutique}` : 'Salon sign-up linked existing client', ts: new Date().toISOString(), boutique: sess.boutique })
    const r = attach(s, sess, c, 'signup', created)
    return { ...r, face_recognition_enabled: mockSettings(sess.boutique).face_recognition_enabled }
  },
  async consent(token, method, text_version, signature_data_url) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    if (!sess.customer) throw new ApiError('Identify or join first', 'ValidationError', 417)
    const consent = { method, text_version: text_version || '2026-08-1', captured_at: new Date().toISOString(), customer: sess.customer, signature_data_url }
    sess.pending_consent = consent
    pushInbox(sess, 'consent_agreed', { customer: sess.customer, consent: { method, text_version: consent.text_version, captured_at: consent.captured_at, customer: sess.customer }, has_signature: !!signature_data_url })
    const camera = mockSettings(sess.boutique).face_recognition_enabled
    const c = allCustomers(s).find((x) => x.name === sess.customer)
    setState(sess, 'consent', { client: c ? mockClientSummary(c) : sess.state?.client, step: 'capture', camera })
    save(s)
    return { ok: true, camera }
  },
  async consent_decline(token) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    sess.pending_consent = null
    pushInbox(sess, 'consent_declined', { customer: sess.customer })
    save(s)
    return { ok: true }
  },
  async ask(token, question, item_code) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    question = question.trim().replace(/\s+/g, ' ').slice(0, 500)
    if (!question) throw new ApiError('Please type a question', 'ValidationError', 417)
    const item_name = ITEMS.find((i) => i.item_code === item_code)?.item_name || null
    let interaction: string | null = null
    if (sess.customer) {
      interaction = `INT-${s.seq++}`
      s.interactions.push({ customer: sess.customer, type: 'Note', note: item_code ? `Client asked about ${item_name || item_code}: ${question}` : `Client asked: ${question}`, ts: new Date().toISOString(), boutique: sess.boutique })
    }
    pushInbox(sess, 'question', { question, item_code: item_code || null, item_name, interaction })
    save(s)
    return { ok: true, interaction }
  },
  async feedback(token, rating, comment) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    if (rating < 1 || rating > 5) throw new ApiError('Rating must be between 1 and 5', 'ValidationError', 417)
    const invoice = (sess.sales_invoice as string) || (sess.state?.receipt_token as string) || (sess.state?.receipt?.receipt_token as string)
    if (!invoice) throw new ApiError('The receipt is still being issued — one moment', 'ValidationError', 417)
    if (s.feedback.some((f) => f.invoice === invoice)) return { ok: true, duplicate: true }
    const name = `MFB-${s.seq++}`
    s.feedback.push({ invoice, boutique: sess.boutique, rating, comment: comment?.trim() || undefined, ts: new Date().toISOString(), customer: sess.customer })
    pushInbox(sess, 'feedback', { rating, feedback: name })
    save(s)
    return { ok: true, feedback: name }
  },
  async invite(token, wants_invitation) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    if (!sess.customer) throw new ApiError('Identify or join first', 'ValidationError', 417)
    s.profiles[sess.customer] = { ...(s.profiles[sess.customer] || {}), private_viewing_invite: wants_invitation, private_viewing_invite_on: wants_invitation ? new Date().toISOString() : null }
    pushInbox(sess, 'invite', { customer: sess.customer, wants_invitation })
    save(s)
    return { ok: true, wants_invitation }
  },
  async email_receipt(token, email) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    email = (email || '').trim().toLowerCase()
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError('That e-mail does not look right', 'ValidationError', 417)
    if (!email && sess.customer) email = allCustomers(s).find((x) => x.name === sess.customer)?.email_id || ''
    if (!email) throw new ApiError('Please enter an e-mail', 'ValidationError', 417)
    pushInbox(sess, 'email_receipt', { email_masked: maskEmail(email), sent: true })
    save(s)
    return { ok: true, email_masked: maskEmail(email), sent: true, queued: true }
  },
  async preferences(token, answers) {
    await guard()
    const s = load()
    const sess = sessionOr403(s, token)
    if (!sess.customer) throw new ApiError('Identify or join first', 'ValidationError', 417)
    const saved: string[] = []
    const p = { ...(s.profiles[sess.customer] || {}) } as Record<string, unknown>
    for (const k of ['ring_size', 'wrist_size', 'metal_preference', 'birthday', 'anniversary'] as const) {
      if (answers[k]) {
        p[k] = answers[k]
        saved.push(k)
      }
    }
    const styles = (answers.styles || []).slice(0, 6)
    const occasions = (answers.occasions || []).slice(0, 6)
    const bits = [styles.length ? 'Style: ' + styles.join(', ') : '', occasions.length ? 'Occasions: ' + occasions.join(', ') : '', answers.notes || ''].filter(Boolean)
    if (bits.length) {
      p.style_notes = ((p.style_notes as string) ? (p.style_notes as string) + '\n' : '') + `[Salon ${new Date().toISOString().slice(0, 10)}] ` + bits.join(' · ')
      saved.push('style_notes')
    }
    s.profiles[sess.customer] = p
    s.interactions.push({ customer: sess.customer, type: 'Note', note: 'Concierge: ' + (bits.join(' · ') || saved.join(', ')), ts: new Date().toISOString(), boutique: sess.boutique })
    pushInbox(sess, 'preferences', { customer: sess.customer, fields: saved.sort(), styles, occasions })
    save(s)
    return { ok: true, saved: saved.sort(), styles, occasions }
  },
  async unpair(token) {
    await guard()
    const s = load()
    const sess = s.sessions[token]
    if (!sess || sess.status !== 'Paired') return { ok: true, unpaired: false }
    sess.status = 'Unpaired'
    sess.seq += 1
    save(s)
    return { ok: true, unpaired: true }
  }
}

function mockSettings(boutique: string): SalonSettings {
  return {
    boutique_name: MOCK_BOUTIQUES[boutique]?.boutique_name,
    city: MOCK_BOUTIQUES[boutique]?.city,
    consent_text: undefined,
    consent_text_version: '2026-08-1',
    face_recognition_enabled: boutique === 'CHI-OAK' ? 1 : 0,
    feedback_enabled: 1,
    receipt_qr_base_url: typeof location !== 'undefined' ? location.origin : 'https://maison.example',
    currency: 'USD'
  }
}

/** Test / dev hook: inspect the mock "server". */
export const __mockSalon = {
  load,
  save,
  reset: () => save(fresh()),
  feedback: () => load().feedback,
  interactions: () => load().interactions,
  profiles: () => load().profiles,
  sessions: () => load().sessions,
  price: (code: string) => PRICES[code]
}

export const salonApi: SalonApi = import.meta.env.VITE_MOCK === '1' ? mockSalon : frappeSalon
export const IS_SALON_MOCK = import.meta.env.VITE_MOCK === '1'
