/**
 * v1.5 — **Promotions from the warehouse desk** (`maison_pos/api/promotions_admin.py`): the
 * rewards programme and its tiers, coupons, giveaways, sales (Pricing Rules the till applies by
 * itself) and the monthly calendar — read in one call, written one record at a time.
 */
import { ApiError } from './types'
import { humanizeServerMessage } from '@/utils/text'

export interface Program {
  name: string
  title: string
  company: string | null
  points_per_dollar: number
  expiry_days: number
  members: number
}

export interface RewardsSettings {
  rewards_program_name: string
  reward_allow_stacking: number
  birthday_coupon_enabled: number
  birthday_coupon_type: 'Percent' | 'Amount'
  birthday_coupon_value: number
  birthday_coupon_lead_days: number
  birthday_coupon_valid_days: number
  new_arrivals_days: number
  giveaway_entries_per_amount: number
  promotions_enabled: number
  birthday_bonus_points: number
}

export interface Tier {
  name: string
  title: string
  points: number
  amount: number
  enabled: number
  description: string | null
}

export type CouponState = 'live' | 'off' | 'expired' | 'used up'

export interface Coupon {
  code: string
  title: string
  enabled: number
  discount_type: 'Percent' | 'Amount'
  value: number
  min_basket: number
  usage: 'Single-use' | 'Multi-use'
  max_uses: number
  used_count: number
  customer: string | null
  boutique: string | null
  boutique_name: string | null
  item_group: string | null
  valid_from: string | null
  valid_upto: string | null
  state: CouponState
  is_birthday: boolean
}

export type GiveawayStatus = 'Draft' | 'Open' | 'Closed' | 'Drawn'

export interface Giveaway {
  name: string
  title: string
  status: GiveawayStatus
  prize_item: string | null
  prize_description: string | null
  start_date: string | null
  end_date: string | null
  boutique: string | null
  boutique_name: string | null
  entry_rule: 'Per amount' | 'Per visit'
  amount_per_entry: number
  max_entries_per_invoice: number
  requires_member: number
  description: string | null
  entries: number
  participants: number
  winner: string | null
  winner_name: string | null
  drawn_on: string | null
}

export type PromoKind = 'percent' | 'amount' | 'rate'
export type PromoApplyOn = 'Item Code' | 'Item Group' | 'Brand' | 'Transaction'
export type PromoState = 'live' | 'scheduled' | 'ended' | 'off'

export interface Promotion {
  name: string
  title: string
  enabled: number
  apply_on: PromoApplyOn
  targets: string[]
  kind: PromoKind
  value: number
  min_qty: number
  min_amt: number
  valid_from: string | null
  valid_upto: string | null
  boutique: string | null
  boutique_name: string | null
  priority: number
  state: PromoState
  coupon_code_based: number
}

export interface CalendarMonth {
  name: string
  month: string
  title: string
  status: 'Planned' | 'Active' | 'Sent' | 'Closed'
  headline: string | null
  body: string | null
  coupon: string | null
  pricing_rules: { name: string; title: string | null }[]
  featured_items: { item_code: string; item_name: string | null; blurb: string | null }[]
  sent_on: string | null
  audience_size: number
  notes: string | null
}

export interface PromotionsOverview {
  program: Program | null
  settings: RewardsSettings
  tiers: Tier[]
  coupons: Coupon[]
  giveaways: Giveaway[]
  promotions: Promotion[]
  calendar: CalendarMonth[]
  stores: { code: string; boutique_name: string; warehouse: string; is_warehouse: number }[]
  item_groups: string[]
  brands: string[]
  as_of: string
}

// ---------------------------------------------------------------------------------------------
// drafts + validation (pure — unit-tested)
// ---------------------------------------------------------------------------------------------
export interface CouponDraft {
  code: string
  title: string
  discount_type: 'Percent' | 'Amount'
  value: number | null
  min_basket: number | null
  usage: 'Single-use' | 'Multi-use'
  max_uses: number | null
  boutique: string
  item_group: string
  valid_from: string
  valid_upto: string
  enabled: boolean
}

export function emptyCouponDraft(): CouponDraft {
  return { code: '', title: '', discount_type: 'Percent', value: null, min_basket: null, usage: 'Multi-use', max_uses: null, boutique: '', item_group: '', valid_from: '', valid_upto: '', enabled: true }
}

export function couponDraftOf(c: Coupon): CouponDraft {
  return { code: c.code, title: c.title, discount_type: c.discount_type, value: c.value, min_basket: c.min_basket || null, usage: c.usage, max_uses: c.max_uses || null, boutique: c.boutique || '', item_group: c.item_group || '', valid_from: c.valid_from || '', valid_upto: c.valid_upto || '', enabled: !!c.enabled }
}

const CODE_RE = /^[A-Z0-9-]{3,24}$/

/** Upper-case, no spaces — what the server does, so the sheet shows the code as it will be. */
export function normalizeCode(code: string): string {
  return (code || '').replace(/\s+/g, '').toUpperCase()
}

export function validateCouponDraft(d: CouponDraft, creating: boolean): string | null {
  const code = normalizeCode(d.code)
  if (creating && !CODE_RE.test(code)) return 'A coupon code is 3 to 24 letters, digits or dashes.'
  if (!(d.title || '').trim()) return 'Give the coupon a title — it is what the receipt says.'
  const v = Number(d.value)
  if (!(v > 0)) return 'The discount must be above zero.'
  if (d.discount_type === 'Percent' && v > 100) return 'A percent discount is at most 100.'
  if (d.min_basket !== null && Number(d.min_basket) < 0) return 'The minimum basket cannot be negative.'
  if (d.usage === 'Multi-use' && d.max_uses !== null && Number(d.max_uses) < 0) return 'Maximum uses cannot be negative.'
  if (d.valid_from && d.valid_upto && d.valid_upto < d.valid_from) return 'The coupon cannot end before it starts.'
  return null
}

export function couponPayload(d: CouponDraft): Record<string, unknown> {
  return {
    code: normalizeCode(d.code),
    title: d.title.trim(),
    discount_type: d.discount_type,
    value: Number(d.value),
    min_basket: d.min_basket === null ? 0 : Number(d.min_basket),
    usage: d.usage,
    max_uses: d.usage === 'Single-use' ? 1 : d.max_uses === null ? 0 : Number(d.max_uses),
    boutique: d.boutique || null,
    item_group: d.item_group || null,
    valid_from: d.valid_from || null,
    valid_upto: d.valid_upto || null,
    enabled: d.enabled ? 1 : 0
  }
}

export interface GiveawayDraft {
  name: string | null
  title: string
  status: 'Draft' | 'Open' | 'Closed'
  prize_item: string
  prize_description: string
  start_date: string
  end_date: string
  boutique: string
  entry_rule: 'Per amount' | 'Per visit'
  amount_per_entry: number | null
  max_entries_per_invoice: number | null
  requires_member: boolean
  description: string
}

export function emptyGiveawayDraft(amountPerEntry = 25): GiveawayDraft {
  return { name: null, title: '', status: 'Draft', prize_item: '', prize_description: '', start_date: '', end_date: '', boutique: '', entry_rule: 'Per amount', amount_per_entry: amountPerEntry, max_entries_per_invoice: 10, requires_member: true, description: '' }
}

export function giveawayDraftOf(g: Giveaway): GiveawayDraft {
  return {
    name: g.name,
    title: g.title,
    status: g.status === 'Drawn' ? 'Closed' : g.status,
    prize_item: g.prize_item || '',
    prize_description: g.prize_description || '',
    start_date: g.start_date || '',
    end_date: g.end_date || '',
    boutique: g.boutique || '',
    entry_rule: g.entry_rule,
    amount_per_entry: g.amount_per_entry,
    max_entries_per_invoice: g.max_entries_per_invoice,
    requires_member: !!g.requires_member,
    description: g.description || ''
  }
}

export function validateGiveawayDraft(d: GiveawayDraft): string | null {
  if (!(d.title || '').trim()) return 'Give the giveaway a title.'
  if (!(d.prize_description || '').trim() && !(d.prize_item || '').trim()) return 'Say what the prize is.'
  if (!d.start_date || !d.end_date) return 'A giveaway runs between two dates.'
  if (d.end_date < d.start_date) return 'The giveaway cannot end before it starts.'
  if (d.entry_rule === 'Per amount' && !(Number(d.amount_per_entry) > 0)) return 'Dollars per entry must be above zero.'
  if (d.max_entries_per_invoice !== null && Number(d.max_entries_per_invoice) < 0) return 'Maximum entries per receipt cannot be negative.'
  return null
}

export function giveawayPayload(d: GiveawayDraft): Record<string, unknown> {
  return {
    name: d.name || undefined,
    title: d.title.trim(),
    status: d.status,
    prize_item: d.prize_item || null,
    prize_description: d.prize_description.trim() || null,
    start_date: d.start_date,
    end_date: d.end_date,
    boutique: d.boutique || null,
    entry_rule: d.entry_rule,
    amount_per_entry: Number(d.amount_per_entry) || 0,
    max_entries_per_invoice: d.max_entries_per_invoice === null ? 0 : Number(d.max_entries_per_invoice),
    requires_member: d.requires_member ? 1 : 0,
    description: d.description.trim() || null
  }
}

export interface PromotionDraft {
  name: string | null
  title: string
  apply_on: PromoApplyOn
  targets: string
  kind: PromoKind
  value: number | null
  min_qty: number | null
  min_amt: number | null
  valid_from: string
  valid_upto: string
  boutique: string
  enabled: boolean
}

export function emptyPromotionDraft(today = ''): PromotionDraft {
  return { name: null, title: '', apply_on: 'Item Group', targets: '', kind: 'percent', value: null, min_qty: null, min_amt: null, valid_from: today, valid_upto: '', boutique: '', enabled: true }
}

export function promotionDraftOf(p: Promotion): PromotionDraft {
  return { name: p.name, title: p.title, apply_on: p.apply_on, targets: p.targets.join(', '), kind: p.kind, value: p.value, min_qty: p.min_qty || null, min_amt: p.min_amt || null, valid_from: p.valid_from || '', valid_upto: p.valid_upto || '', boutique: p.boutique || '', enabled: !!p.enabled }
}

export function splitTargets(s: string): string[] {
  return (s || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

export function validatePromotionDraft(d: PromotionDraft): string | null {
  const title = (d.title || '').trim()
  if (!title) return 'Give the sale a name — the till shows it on the line.'
  if (title.startsWith('AWANZ ')) return "A sale's name may not start with 'AWANZ ' — that shape is reserved for store shelf prices."
  if (d.apply_on !== 'Transaction' && !splitTargets(d.targets).length) return `Pick at least one ${d.apply_on === 'Item Code' ? 'item' : d.apply_on === 'Brand' ? 'brand' : 'item group'}.`
  const v = Number(d.value)
  if (!(v > 0)) return 'The discount must be above zero.'
  if (d.kind === 'percent' && v > 100) return 'A percent discount is at most 100.'
  if (d.apply_on === 'Transaction' && d.kind === 'rate') return 'A fixed price applies to items, not to the whole basket.'
  if (d.valid_from && d.valid_upto && d.valid_upto < d.valid_from) return 'The sale cannot end before it starts.'
  return null
}

export function promotionPayload(d: PromotionDraft): Record<string, unknown> {
  return {
    name: d.name || undefined,
    title: d.title.trim(),
    apply_on: d.apply_on,
    targets: d.apply_on === 'Transaction' ? [] : splitTargets(d.targets),
    kind: d.kind,
    value: Number(d.value),
    min_qty: d.min_qty === null ? 0 : Number(d.min_qty),
    min_amt: d.min_amt === null ? 0 : Number(d.min_amt),
    valid_from: d.valid_from || null,
    valid_upto: d.valid_upto || null,
    boutique: d.boutique || null,
    enabled: d.enabled ? 1 : 0
  }
}

/** "20% off" · "$5 off" · "$49 each" — what a sale does, in three words. */
export function describePromotion(p: { kind: PromoKind; value: number }, money: (n: number) => string): string {
  if (p.kind === 'percent') return `${Number.isInteger(p.value) ? p.value : p.value.toFixed(1)}% off`
  if (p.kind === 'amount') return `${money(p.value)} off`
  return `${money(p.value)} each`
}

/** "Item group · Oud & Oils, Gift Sets" — what a sale applies to. */
export function describeScope(p: { apply_on: PromoApplyOn; targets: string[] }): string {
  if (p.apply_on === 'Transaction') return 'Whole basket'
  const label = p.apply_on === 'Item Code' ? 'Items' : p.apply_on === 'Brand' ? 'Brand' : 'Item group'
  return `${label} · ${p.targets.join(', ')}`
}

// ---------------------------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------------------------
export interface PromotionsApi {
  overview(): Promise<PromotionsOverview>
  saveRewardsSettings(payload: Record<string, unknown>): Promise<{ changed: string[]; settings: RewardsSettings; program: Program | null }>
  saveTier(payload: Record<string, unknown>): Promise<{ tier: Tier; tiers: Tier[] }>
  saveCoupon(payload: Record<string, unknown>): Promise<{ coupon: Coupon; created: boolean }>
  setCouponEnabled(code: string, enabled: boolean): Promise<{ coupon: Coupon }>
  saveGiveaway(payload: Record<string, unknown>): Promise<{ giveaway: Giveaway; created: boolean }>
  drawGiveaway(name: string): Promise<{ draw: { winner: string; winner_name: string | null; entry: string }; giveaway: Giveaway }>
  savePromotion(payload: Record<string, unknown>): Promise<{ promotion: Promotion; created: boolean }>
  setPromotionEnabled(name: string, enabled: boolean): Promise<{ promotion: Promotion }>
  saveCalendar(payload: Record<string, unknown>): Promise<{ calendar: CalendarMonth; created: boolean }>
  sendCalendar(name: string): Promise<{ sent: Record<string, unknown>; calendar: CalendarMonth }>
}

// ---------------------------------------------------------------------------------------------
// Frappe
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.promotions_admin.'

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
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': csrf() },
        body: JSON.stringify(args)
      })
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
        message = humanizeServerMessage((JSON.parse(body._server_messages) as string[]).map((m) => JSON.parse(m).message).join('\n')) || message
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = humanizeServerMessage(String(body.exception).split('\n').pop()) || message
    throw new ApiError(message, res.status === 401 || res.status === 403 ? 'AUTH' : body?.exc_type || `HTTP_${res.status}`, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappePromotions: PromotionsApi = {
  overview: () => call('overview', {}, true),
  saveRewardsSettings: (payload) => call('save_rewards_settings', { payload }),
  saveTier: (payload) => call('save_tier', { payload }),
  saveCoupon: (payload) => call('save_coupon', { payload }),
  setCouponEnabled: (code, enabled) => call('set_coupon_enabled', { code, enabled: enabled ? 1 : 0 }),
  saveGiveaway: (payload) => call('save_giveaway', { payload }),
  drawGiveaway: (name) => call('draw_giveaway', { name }),
  savePromotion: (payload) => call('save_promotion', { payload }),
  setPromotionEnabled: (name, enabled) => call('set_promotion_enabled', { name, enabled: enabled ? 1 : 0 }),
  saveCalendar: (payload) => call('save_calendar', { payload }),
  sendCalendar: (name) => call('send_calendar', { name })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests)
// ---------------------------------------------------------------------------------------------
const STORES = [
  { code: 'HOU-WH', boutique_name: 'Houston Warehouse', warehouse: 'HOU-WH - CC', is_warehouse: 1 },
  { code: 'HOU-MTR', boutique_name: 'CloudChaserz Montrose', warehouse: 'HOU-MTR - CC', is_warehouse: 0 },
  { code: 'OK-BIX', boutique_name: 'CloudChaserz Bixby', warehouse: 'OK-BIX - CC', is_warehouse: 0 }
]

const mockState = {
  settings: {
    rewards_program_name: 'CloudChaserz Rewards',
    reward_allow_stacking: 0,
    birthday_coupon_enabled: 1,
    birthday_coupon_type: 'Percent',
    birthday_coupon_value: 15,
    birthday_coupon_lead_days: 7,
    birthday_coupon_valid_days: 30,
    new_arrivals_days: 14,
    giveaway_entries_per_amount: 25,
    promotions_enabled: 1,
    birthday_bonus_points: 0
  } as RewardsSettings,
  program: { name: 'CloudChaserz Rewards', title: 'CloudChaserz Rewards', company: 'CloudChaserz', points_per_dollar: 1, expiry_days: 0, members: 412 } as Program,
  tiers: [
    { name: 'RT-100-00001', title: '$5 off at 100 points', points: 100, amount: 5, enabled: 1, description: null },
    { name: 'RT-200-00002', title: '$10 off at 200 points', points: 200, amount: 10, enabled: 1, description: null },
    { name: 'RT-300-00003', title: '$15 off at 300 points', points: 300, amount: 15, enabled: 1, description: null }
  ] as Tier[],
  coupons: [
    { code: 'WELCOME10', title: '10% off your first visit', enabled: 1, discount_type: 'Percent', value: 10, min_basket: 0, usage: 'Multi-use', max_uses: 0, used_count: 38, customer: null, boutique: null, boutique_name: null, item_group: null, valid_from: null, valid_upto: null, state: 'live', is_birthday: false },
    { code: 'OUD20', title: '$20 off oud over $150', enabled: 1, discount_type: 'Amount', value: 20, min_basket: 150, usage: 'Multi-use', max_uses: 200, used_count: 200, customer: null, boutique: null, boutique_name: null, item_group: 'Oud & Oils', valid_from: '2026-08-01', valid_upto: '2026-12-31', state: 'used up', is_birthday: false }
  ] as Coupon[],
  giveaways: [
    { name: 'GIVE-2026-00001', title: 'Win a 100 ml Royal Oud', status: 'Open', prize_item: null, prize_description: '100 ml Royal Oud', start_date: '2026-09-01', end_date: '2026-09-30', boutique: null, boutique_name: null, entry_rule: 'Per amount', amount_per_entry: 25, max_entries_per_invoice: 10, requires_member: 1, description: null, entries: 143, participants: 61, winner: null, winner_name: null, drawn_on: null }
  ] as Giveaway[],
  promotions: [
    { name: 'PRLE-0001', title: 'Gift sets 15% off', enabled: 1, apply_on: 'Item Group', targets: ['Gift Sets'], kind: 'percent', value: 15, min_qty: 0, min_amt: 0, valid_from: '2026-09-01', valid_upto: '2026-09-30', boutique: null, boutique_name: null, priority: 5, state: 'live', coupon_code_based: 0 }
  ] as Promotion[],
  calendar: [
    { name: 'PROMO-2026-09', month: '2026-09-01', title: 'September 2026 promotions', status: 'Sent', headline: 'Gift sets 15% off all month', body: null, coupon: 'WELCOME10', pricing_rules: [{ name: 'PRLE-0001', title: 'Gift sets 15% off' }], featured_items: [], sent_on: '2026-09-01 08:00:00', audience_size: 398, notes: null }
  ] as CalendarMonth[],
  seq: 2
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function couponState(c: Coupon, today: string): CouponState {
  if (!c.enabled) return 'off'
  if (c.valid_upto && c.valid_upto < today) return 'expired'
  if (c.max_uses && c.used_count >= c.max_uses) return 'used up'
  return 'live'
}

function promoState(p: Promotion, today: string): PromoState {
  if (!p.enabled) return 'off'
  if (p.valid_from && p.valid_from > today) return 'scheduled'
  if (p.valid_upto && p.valid_upto < today) return 'ended'
  return 'live'
}

const TODAY = () => new Date().toISOString().slice(0, 10)

export const mockPromotions: PromotionsApi = {
  async overview() {
    return clone({ program: mockState.program, settings: mockState.settings, tiers: mockState.tiers, coupons: mockState.coupons, giveaways: mockState.giveaways, promotions: mockState.promotions, calendar: mockState.calendar, stores: STORES, item_groups: ['Designer Fragrance', 'Oud & Oils', 'Gift Sets', 'Body Sprays'], brands: [], as_of: new Date().toISOString() })
  },
  async saveRewardsSettings(payload) {
    const changed: string[] = []
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'points_per_dollar') {
        const n = Number(v)
        if (!(n > 0) || n > 100) throw new ApiError('Points per dollar must be between 0.01 and 100', 'ValidationError', 417)
        if (mockState.program.points_per_dollar !== n) {
          mockState.program.points_per_dollar = n
          changed.push(k)
        }
        continue
      }
      if (!(k in mockState.settings)) continue
      if (k === 'rewards_program_name' && !String(v || '').trim()) throw new ApiError('The programme needs a name — it is printed on every receipt', 'ValidationError', 417)
      const cur = (mockState.settings as any)[k]
      if (cur !== v) {
        ;(mockState.settings as any)[k] = v
        changed.push(k)
      }
    }
    return clone({ changed, settings: mockState.settings, program: mockState.program })
  },
  async saveTier(payload) {
    const points = Number(payload.points) || 0
    const amount = Number(payload.amount) || 0
    if (points <= 0) throw new ApiError('A tier needs a points figure above zero', 'ValidationError', 417)
    if (amount <= 0) throw new ApiError('A tier needs a dollar value above zero', 'ValidationError', 417)
    let tier = payload.name ? mockState.tiers.find((t) => t.name === payload.name) : undefined
    if (!tier) {
      if (mockState.tiers.some((t) => t.points === points)) throw new ApiError(`There is already a tier at ${points} points — edit that one`, 'DuplicateEntryError', 409)
      tier = { name: `RT-${points}-${String(++mockState.seq).padStart(5, '0')}`, title: '', points, amount, enabled: 1, description: null }
      mockState.tiers.push(tier)
    }
    tier.title = String(payload.title || '').trim() || `$${amount} off at ${points} points`
    tier.points = points
    tier.amount = amount
    tier.enabled = payload.enabled === undefined ? 1 : Number(payload.enabled) ? 1 : 0
    tier.description = String(payload.description || '').trim() || null
    mockState.tiers.sort((a, b) => a.points - b.points)
    return clone({ tier, tiers: mockState.tiers })
  },
  async saveCoupon(payload) {
    const code = normalizeCode(String(payload.code || ''))
    if (!CODE_RE.test(code)) throw new ApiError('A coupon code is 3 to 24 letters or digits', 'ValidationError', 417)
    if (!String(payload.title || '').trim()) throw new ApiError('Give the coupon a title — it is what the receipt says', 'ValidationError', 417)
    let c = mockState.coupons.find((x) => x.code === code)
    const created = !c
    if (!c) {
      c = { code, title: '', enabled: 1, discount_type: 'Percent', value: 0, min_basket: 0, usage: 'Multi-use', max_uses: 0, used_count: 0, customer: null, boutique: null, boutique_name: null, item_group: null, valid_from: null, valid_upto: null, state: 'live', is_birthday: false }
      mockState.coupons.unshift(c)
    }
    Object.assign(c, {
      title: String(payload.title).trim(),
      enabled: Number(payload.enabled ?? 1) ? 1 : 0,
      discount_type: payload.discount_type || 'Percent',
      value: Number(payload.value) || 0,
      min_basket: Number(payload.min_basket) || 0,
      usage: payload.usage || 'Multi-use',
      max_uses: payload.usage === 'Single-use' ? 1 : Number(payload.max_uses) || 0,
      boutique: (payload.boutique as string) || null,
      boutique_name: STORES.find((s) => s.code === payload.boutique)?.boutique_name || null,
      item_group: (payload.item_group as string) || null,
      valid_from: (payload.valid_from as string) || null,
      valid_upto: (payload.valid_upto as string) || null
    })
    c.state = couponState(c, TODAY())
    return clone({ coupon: c, created })
  },
  async setCouponEnabled(code, enabled) {
    const c = mockState.coupons.find((x) => x.code === code)
    if (!c) throw new ApiError(`Coupon ${code} does not exist`, 'DoesNotExistError', 404)
    c.enabled = enabled ? 1 : 0
    c.state = couponState(c, TODAY())
    return clone({ coupon: c })
  },
  async saveGiveaway(payload) {
    if (!String(payload.title || '').trim()) throw new ApiError('Give the giveaway a title', 'ValidationError', 417)
    if (!payload.start_date || !payload.end_date) throw new ApiError('A giveaway runs between two dates', 'ValidationError', 417)
    let g = payload.name ? mockState.giveaways.find((x) => x.name === payload.name) : undefined
    const created = !g
    if (g && g.status === 'Drawn') throw new ApiError(`${g.name} has been drawn and can no longer change`, 'ValidationError', 417)
    if (!g) {
      g = { name: `GIVE-2026-${String(++mockState.seq).padStart(5, '0')}`, title: '', status: 'Draft', prize_item: null, prize_description: null, start_date: null, end_date: null, boutique: null, boutique_name: null, entry_rule: 'Per amount', amount_per_entry: 25, max_entries_per_invoice: 10, requires_member: 1, description: null, entries: 0, participants: 0, winner: null, winner_name: null, drawn_on: null }
      mockState.giveaways.unshift(g)
    }
    Object.assign(g, {
      title: String(payload.title).trim(),
      status: payload.status || 'Draft',
      prize_item: (payload.prize_item as string) || null,
      prize_description: (payload.prize_description as string) || null,
      start_date: payload.start_date,
      end_date: payload.end_date,
      boutique: (payload.boutique as string) || null,
      boutique_name: STORES.find((s) => s.code === payload.boutique)?.boutique_name || null,
      entry_rule: payload.entry_rule || 'Per amount',
      amount_per_entry: Number(payload.amount_per_entry) || 0,
      max_entries_per_invoice: Number(payload.max_entries_per_invoice) || 0,
      requires_member: Number(payload.requires_member ?? 1) ? 1 : 0,
      description: (payload.description as string) || null
    })
    return clone({ giveaway: g, created })
  },
  async drawGiveaway(name) {
    const g = mockState.giveaways.find((x) => x.name === name)
    if (!g) throw new ApiError(`${name} does not exist`, 'DoesNotExistError', 404)
    if (g.status === 'Drawn') throw new ApiError(`${name} has already been drawn`, 'ValidationError', 417)
    if (!g.entries) throw new ApiError('No entries to draw from', 'ValidationError', 417)
    Object.assign(g, { status: 'Drawn', winner: 'CUST-00042', winner_name: 'Amira Haddad', drawn_on: new Date().toISOString().slice(0, 19).replace('T', ' ') })
    return clone({ draw: { winner: 'CUST-00042', winner_name: 'Amira Haddad', entry: 'e1' }, giveaway: g })
  },
  async savePromotion(payload) {
    const title = String(payload.title || '').trim()
    if (!title) throw new ApiError('Give the sale a name — the till shows it on the line', 'ValidationError', 417)
    if (title.startsWith('AWANZ ')) throw new ApiError("A sale's name may not start with 'AWANZ '", 'ValidationError', 417)
    const targets = (payload.targets as string[]) || []
    if (payload.apply_on !== 'Transaction' && !targets.length) throw new ApiError('Pick at least one item group', 'ValidationError', 417)
    let p = payload.name ? mockState.promotions.find((x) => x.name === payload.name) : undefined
    const created = !p
    if (!p) {
      p = { name: `PRLE-${String(++mockState.seq).padStart(4, '0')}`, title, enabled: 1, apply_on: 'Item Group', targets: [], kind: 'percent', value: 0, min_qty: 0, min_amt: 0, valid_from: null, valid_upto: null, boutique: null, boutique_name: null, priority: 5, state: 'live', coupon_code_based: 0 }
      mockState.promotions.unshift(p)
    }
    Object.assign(p, {
      title,
      enabled: Number(payload.enabled ?? 1) ? 1 : 0,
      apply_on: payload.apply_on || 'Item Group',
      targets,
      kind: payload.kind || 'percent',
      value: Number(payload.value) || 0,
      min_qty: Number(payload.min_qty) || 0,
      min_amt: Number(payload.min_amt) || 0,
      valid_from: (payload.valid_from as string) || TODAY(),
      valid_upto: (payload.valid_upto as string) || null,
      boutique: (payload.boutique as string) || null,
      boutique_name: STORES.find((s) => s.code === payload.boutique)?.boutique_name || null
    })
    p.state = promoState(p, TODAY())
    return clone({ promotion: p, created })
  },
  async setPromotionEnabled(name, enabled) {
    const p = mockState.promotions.find((x) => x.name === name)
    if (!p) throw new ApiError(`Sale ${name} does not exist`, 'DoesNotExistError', 404)
    p.enabled = enabled ? 1 : 0
    p.state = promoState(p, TODAY())
    return clone({ promotion: p })
  },
  async saveCalendar(payload) {
    if (!payload.month) throw new ApiError('Which month?', 'ValidationError', 417)
    const month = String(payload.month).slice(0, 7) + '-01'
    const name = `PROMO-${month.slice(0, 7)}`
    let c = mockState.calendar.find((x) => x.name === name)
    const created = !c
    if (c && c.status === 'Sent' && payload.status && !['Sent', 'Closed'].includes(String(payload.status))) throw new ApiError(`${name} has been sent; it can only be closed now`, 'ValidationError', 417)
    if (!c) {
      c = { name, month, title: '', status: 'Planned', headline: null, body: null, coupon: null, pricing_rules: [], featured_items: [], sent_on: null, audience_size: 0, notes: null }
      mockState.calendar.unshift(c)
      mockState.calendar.sort((a, b) => (a.month < b.month ? 1 : -1))
    }
    const d = new Date(month + 'T00:00:00')
    Object.assign(c, {
      title: String(payload.title || '').trim() || `${d.toLocaleString('en-US', { month: 'long' })} ${d.getFullYear()} promotions`,
      status: payload.status || c.status,
      headline: (payload.headline as string) || null,
      body: (payload.body as string) || null,
      coupon: (payload.coupon as string) || null,
      notes: (payload.notes as string) || null
    })
    if (payload.pricing_rules) c.pricing_rules = (payload.pricing_rules as string[]).map((n) => ({ name: n, title: mockState.promotions.find((p) => p.name === n)?.title || null }))
    if (payload.featured_items) c.featured_items = (payload.featured_items as { item_code: string; blurb?: string }[]).map((r) => ({ item_code: r.item_code, item_name: r.item_code, blurb: r.blurb || null }))
    return clone({ calendar: c, created })
  },
  async sendCalendar(name) {
    const c = mockState.calendar.find((x) => x.name === name)
    if (!c) throw new ApiError(`${name} does not exist`, 'DoesNotExistError', 404)
    if (c.status === 'Sent') throw new ApiError(`${name} has already been sent`, 'ValidationError', 417)
    c.status = 'Sent'
    c.sent_on = new Date().toISOString().slice(0, 19).replace('T', ' ')
    c.audience_size = mockState.program.members
    return clone({ sent: { audience: c.audience_size }, calendar: c })
  }
}

const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const promotionsApi: PromotionsApi = IS_MOCK ? mockPromotions : frappePromotions
