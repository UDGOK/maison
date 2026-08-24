/**
 * v0.6 N/Q — age verification (`maison_pos.api.age`) and CloudChaserz Rewards
 * (`maison_pos.api.rewards`). Own module like `v04.ts`: typed client + in-memory mock picked by
 * `VITE_MOCK`, so the core `AwanzApi` contract stays untouched.
 */
import { ApiError, type AgeCheckPayload, type RewardTier } from './types'
import { evaluateAge, parseAamva, todayIso } from '@/scan/aamva'
import { humanizeServerMessage, SESSION_EXPIRED_MESSAGE } from '@/utils/text' // v0.8 POS D5 / D9
import { serverDateTime } from '@/utils/time' // v0.8 POS D2

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------
export interface AgeSettings {
  age_verification_required: 0 | 1 | boolean
  minimum_age: number
  id_scan_enabled: 0 | 1 | boolean
  webshop_age_restricted_sales?: 0 | 1 | boolean
}

export interface AgeCheckResult {
  ok: boolean
  verified: 0 | 1
  outcome: 'Verified' | 'Underage' | 'Expired' | 'Unreadable' | 'Declined'
  method: 'Scan' | 'Manual'
  age?: number | null
  minimum_age: number
  dob_year_ok?: 0 | 1
  expired?: 0 | 1
  initials?: string | null
  jurisdiction?: string | null
  /** `AWANZ Age Check` name (audit row, masked) */
  check?: string
  checked_at?: string
  message: string
}

export interface RewardTiersResult {
  program: string | null
  program_name: string
  allow_stacking: 0 | 1 | boolean
  points: number
  tiers: RewardTier[]
  affordable: RewardTier[]
  next_reward: { name: string; title: string; points: number; amount: number; points_needed: number } | null
}

export interface RewardsProgramCopy {
  earn: string
  redeem: string[]
  perks: { title: string; text: string }[]
}

export interface RewardsProgram {
  brand: { brand_name: string; tagline?: string; support_email?: string; [k: string]: unknown }
  program_name: string
  earn_rate: number
  tiers: { name?: string; title: string; points: number; amount: number }[]
  birthday: { type: string; value: number; lead_days: number; valid_days: number; label: string }
  copy: RewardsProgramCopy
  events: { title: string; date: string; link?: string | null }[]
  giveaways: { title: string; prize?: string | null; end_date: string; rule: string; amount_per_entry: number }[]
  signup_url: string
}

export interface V06Api {
  age: {
    settings(): Promise<AgeSettings>
    verify_scan(raw: string, boutique?: string, device_id?: string, offline_uuid?: string): Promise<AgeCheckResult>
    verify_manual(dob: string, boutique?: string, expiry?: string, initials?: string, device_id?: string, offline_uuid?: string): Promise<AgeCheckResult>
    decline(boutique?: string, device_id?: string, offline_uuid?: string): Promise<AgeCheckResult>
  }
  rewards: {
    tiers(customer?: string | null, boutique?: string): Promise<RewardTiersResult>
    giveaways(boutique?: string, customer?: string | null): Promise<{ giveaways: { name: string; title: string; prize_description?: string | null; end_date: string; entry_rule: string; amount_per_entry: number; my_entries: number }[] }>
    program(): Promise<RewardsProgram>
  }
}

/** The client's exact program copy — also served by the backend (`rewards.PROGRAM_COPY`); this is the offline / mock copy. */
export const PROGRAM_COPY: RewardsProgramCopy = {
  earn: 'Earn 1 point for every $1 you spend.',
  redeem: ['$5 off at 100 points', '$10 off at 200 points', '$15 off at 300 points'],
  perks: [
    { title: 'Birthday discount', text: 'A birthday coupon lands in your account a week before the big day — valid for 30 days.' },
    { title: 'Monthly sale promotions', text: 'Members see every monthly promotion first.' },
    { title: 'Latest product arrivals', text: 'New drops in your store, announced the week they land.' },
    { title: 'Product giveaways', text: 'Every receipt earns giveaway entries — winners are drawn and notified.' },
    { title: 'Exclusive event invites', text: 'Invitations to in-store events and launch nights.' }
  ]
}

export const DEFAULT_TIERS: RewardTier[] = [
  { name: 'MRT-100', title: '$5 off at 100 points', points: 100, amount: 5 },
  { name: 'MRT-200', title: '$10 off at 200 points', points: 200, amount: 10 },
  { name: 'MRT-300', title: '$15 off at 300 points', points: 300, amount: 15 }
]

/** Pure: tiers the client can afford with `points`, cheapest first. */
export function affordableTiers(points: number, tiers: RewardTier[]): RewardTier[] {
  return [...tiers].sort((a, b) => a.points - b.points).filter((t) => points >= t.points)
}

/** Pure: the first tier the client cannot afford yet (null when the top tier is reachable). */
export function nextReward(points: number, tiers: RewardTier[]): { name: string; title: string; points: number; amount: number; points_needed: number } | null {
  for (const t of [...tiers].sort((a, b) => a.points - b.points)) if (points < t.points) return { name: t.name, title: t.title, points: t.points, amount: t.amount, points_needed: Math.ceil(t.points - points) }
  return null
}

/** Pure: the discount a tier selection yields, capped by the bill (never drives points negative). */
export function tierDiscount(selected: RewardTier[], bill: number): number {
  const amount = selected.reduce((s, t) => s + t.amount, 0)
  return Math.max(0, Math.min(Math.round(amount * 100) / 100, Math.round(bill * 100) / 100))
}

// ---------------------------------------------------------------------------------------------
// Frappe client
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.'
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
      res = await fetch(`${url}?${qs.toString()}`, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json', 'X-Frappe-CSRF-Token': csrf() } })
    } else {
      res = await fetch(url, { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': csrf() }, body: JSON.stringify(args) })
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
    // v0.8 POS D5 / D9 — same sanitising as `api/frappe.ts`: no module paths, no exception classes
    let message = ''
    if (body?._server_messages) {
      try {
        message = humanizeServerMessage((JSON.parse(body._server_messages) as string[]).map((m) => JSON.parse(m).message).join('\n'))
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = humanizeServerMessage(String(body.exception).split('\n').pop())
    if (body?.session_expired || (!message && (res.status === 401 || res.status === 403))) message = SESSION_EXPIRED_MESSAGE
    throw new ApiError(message || `${res.status} ${res.statusText}`, body?.session_expired ? 'SESSION_EXPIRED' : res.status === 401 || res.status === 403 ? 'AUTH' : body?.exc_type || `HTTP_${res.status}`, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappeV06: V06Api = {
  age: {
    settings: () => call('age.settings', {}, true),
    verify_scan: (raw, boutique, device_id, offline_uuid) => call('age.verify_scan', { raw, boutique, device_id, offline_uuid }),
    verify_manual: (dob, boutique, expiry, initials, device_id, offline_uuid) => call('age.verify_manual', { dob, boutique, expiry, initials, device_id, offline_uuid }),
    decline: (boutique, device_id, offline_uuid) => call('age.decline', { boutique, device_id, offline_uuid })
  },
  rewards: {
    tiers: (customer, boutique) => call('rewards.tiers', { customer: customer || undefined, boutique }, true),
    giveaways: (boutique, customer) => call('rewards.giveaways', { boutique, customer: customer || undefined }, true),
    program: () => call('rewards.program', {}, true)
  }
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1) — decisions run through the same pure parser the device uses offline
// ---------------------------------------------------------------------------------------------
export const MOCK_AGE: AgeSettings = { age_verification_required: 1, minimum_age: 21, id_scan_enabled: 1, webshop_age_restricted_sales: 0 }
let mockSeq = 0
function mockMessage(outcome: AgeCheckResult['outcome'], min: number): string {
  if (outcome === 'Verified') return `ID verified — ${min}+`
  if (outcome === 'Underage') return `Under ${min} — sale of age-restricted items refused`
  if (outcome === 'Expired') return 'ID expired — ask for a valid ID'
  if (outcome === 'Unreadable') return 'Could not read the date of birth — enter it manually'
  return 'Age verification declined'
}
function mockDecide(method: 'Scan' | 'Manual', dob: string | null, expiry: string | null, initials: string | null, jurisdiction: string | null): AgeCheckResult {
  const d = evaluateAge(dob, expiry, MOCK_AGE.minimum_age, todayIso())
  return { ok: d.ok, verified: d.ok ? 1 : 0, outcome: d.outcome, method, age: d.age, minimum_age: MOCK_AGE.minimum_age, dob_year_ok: d.dob_year_ok, expired: d.expired, initials, jurisdiction, check: `MAC-MOCK-${++mockSeq}`, checked_at: serverDateTime(), message: mockMessage(d.outcome, MOCK_AGE.minimum_age) }
}

export const mockV06: V06Api = {
  age: {
    settings: async () => ({ ...MOCK_AGE }),
    verify_scan: async (raw) => {
      const p = parseAamva(raw)
      return mockDecide('Scan', p.dob, p.expiry, p.initials, p.jurisdiction)
    },
    verify_manual: async (dob, _b, expiry, initials) => mockDecide('Manual', dob || null, expiry || null, (initials || '').slice(0, 2).toUpperCase() || null, null),
    decline: async () => ({ ok: false, verified: 0, outcome: 'Declined', method: 'Manual', minimum_age: MOCK_AGE.minimum_age, check: `MAC-MOCK-${++mockSeq}`, message: mockMessage('Declined', MOCK_AGE.minimum_age) })
  },
  rewards: {
    tiers: async (customer) => {
      const { CUSTOMERS } = await import('./seed')
      const c = customer ? CUSTOMERS.find((x) => x.name === customer) : null
      const points = c?.loyalty_points || 0
      return { program: c ? 'Mock Rewards' : null, program_name: 'Mock Rewards', allow_stacking: 0, points, tiers: DEFAULT_TIERS, affordable: affordableTiers(points, DEFAULT_TIERS), next_reward: nextReward(points, DEFAULT_TIERS) }
    },
    giveaways: async () => ({ giveaways: [{ name: 'MGV-0001', title: 'Mock giveaway', prize_description: 'A prize', end_date: '2030-01-01', entry_rule: 'Per amount', amount_per_entry: 25, my_entries: 0 }] }),
    program: async () => ({ brand: { brand_name: 'AWANZ', tagline: 'Fine jewellery & timepieces', support_email: 'concierge@maison.example' }, program_name: 'Mock Rewards', earn_rate: 1, tiers: DEFAULT_TIERS, birthday: { type: 'Percent', value: 15, lead_days: 7, valid_days: 30, label: '15% off' }, copy: PROGRAM_COPY, events: [], giveaways: [], signup_url: '/rewards#join' })
  }
}

/**
 * Quick offline-safe age check (no server): identical decision to the mock / server.
 *
 * v0.8 POS D2 — `checked_at` goes onto a Frappe Datetime column when the queued sale replays, so
 * it is the site's wall clock in the server's format, never `Date.toISOString()`'s UTC `Z` form
 * (which MariaDB rejected outright, making every offline 21+ sale unsyncable).
 */
export function decideOffline(method: 'Scan' | 'Manual', dob: string | null, expiry: string | null, minimumAge: number, initials?: string | null, jurisdiction?: string | null): AgeCheckResult {
  const d = evaluateAge(dob, expiry, minimumAge, todayIso())
  return { ok: d.ok, verified: d.ok ? 1 : 0, outcome: d.outcome, method, age: d.age, minimum_age: minimumAge, dob_year_ok: d.dob_year_ok, expired: d.expired, initials: initials || null, jurisdiction: jurisdiction || null, checked_at: serverDateTime(), message: mockMessage(d.outcome, minimumAge) }
}

export function toPayload(r: AgeCheckResult, offline: boolean): AgeCheckPayload {
  return { verified: r.verified, method: r.method, check: r.check, checked_at: r.checked_at, dob_year_ok: r.dob_year_ok, age: r.age ?? undefined, initials: r.initials, jurisdiction: r.jurisdiction, offline: offline ? 1 : 0 }
}

export const v06: V06Api = import.meta.env.VITE_MOCK === '1' ? mockV06 : frappeV06
