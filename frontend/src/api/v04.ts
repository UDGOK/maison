/**
 * v0.4 B/C/I — clienteling (crm.*), employee/shift (hr.*), promotions & coupons (promotions.*)
 * and feedback (feedback.*). Kept in its own module (typed client + in-memory mock) so the
 * core `MaisonApi` contract stays untouched; `v04` picks the implementation from `VITE_MOCK`.
 */
import { ApiError, type Customer } from './types'
import { CUSTOMERS, ITEMS, LOYALTY, PRICES } from './seed'
import { stripHtml } from '@/utils/text'

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------
export interface ClientProfileFields {
  ring_size?: string | null
  wrist_size?: string | null
  metal_preference?: string | null
  birthday?: string | null
  anniversary?: string | null
  spouse_name?: string | null
  style_notes?: string | null
  preferred_associate?: string | null
  preferred_associate_name?: string | null
  preferred_boutique?: string | null
  vip_tier_override?: string | null
  do_not_email?: 0 | 1
  do_not_sms?: 0 | 1
  do_not_phone?: 0 | 1
}

export interface WishlistRow {
  name: string
  item_code: string
  item_name: string
  notes?: string | null
  added_by?: string
  added_on?: string | null
  fulfilled: 0 | 1
  fulfilled_on?: string | null
  fulfilled_invoice?: string | null
}

export interface OwnedPiece {
  serial_no: string
  item_code: string
  item_name: string
  invoice: string
  date?: string | null
  boutique?: string | null
  rate: number
  metal?: string | null
  certificate_no?: string | null
}

export type InteractionType = 'Note' | 'Call' | 'Email' | 'SMS' | 'Visit' | 'Follow-up' | 'Wishlist match' | 'Birthday'

export interface Interaction {
  name: string
  customer: string
  customer_name?: string
  type: InteractionType
  note?: string | null
  boutique?: string | null
  associate?: string | null
  ts?: string | null
  follow_up_date?: string | null
  status: 'Open' | 'Done' | 'Cancelled'
  done_on?: string | null
  crm_task?: string | null
}

export interface TierRow {
  tier: string
  min_spent: number
  collection_factor?: number
}

/** `promotions.loyalty` / `crm.profile().loyalty` */
export interface TierProgress {
  program: string | null
  tier: string | null
  tier_override?: string | null
  points: number
  points_value?: number
  spent?: number
  tiers: TierRow[]
  next_tier: string | null
  next_tier_min_spent?: number | null
  to_next_tier?: number
  /** 0..1 */
  progress: number
  expiry_duration_days?: number
  points_expiring_90d?: number
  birthday_bonus_points?: number
}

export interface ClientProfile {
  customer: Customer
  profile: ClientProfileFields
  wishlist: WishlistRow[]
  owned_pieces: OwnedPiece[]
  follow_ups: Interaction[]
  interactions: Interaction[]
  loyalty: TierProgress
  next_best_offer: { item_code: string; item_name?: string; reason?: string }[]
  crm: { installed: boolean; contact?: string | null }
  can_edit_tier: boolean
}

export interface ShiftInfo {
  name: string
  boutique: string
  clock_in: string
  status: 'On shift' | 'On break' | 'Off shift'
  break_started?: string | null
  break_minutes: number
  worked_minutes: number
}

export interface ShiftStatus {
  on_shift: boolean
  shift: ShiftInfo | null
  created?: boolean
  closed?: boolean
  hrms?: boolean
}

export type PromoKind = 'percent' | 'amount' | 'rate' | 'free_item'

/** Compact ERPNext Pricing Rule as returned by `promotions.active` */
export interface Promotion {
  name: string
  title: string
  apply_on: 'Item Code' | 'Item Group' | 'Brand' | 'Transaction'
  targets: string[]
  kind: PromoKind
  rate: number
  discount_percentage: number
  discount_amount: number
  min_qty: number
  max_qty: number
  min_amt: number
  max_amt: number
  valid_from?: string | null
  valid_upto?: string | null
  warehouse?: string | null
  /** loyalty tier this promo is restricted to (Customer Group = tier name), null = everyone */
  tier?: string | null
  priority: number
}

export interface ActivePromotions {
  boutique: string
  date: string
  enabled: boolean
  promotions: Promotion[]
  coupons_available: boolean
  version: string
}

export interface CouponCheckLine {
  item_code: string
  qty: number
  rate: number
  discount_amount?: number
  item_group?: string
}

export interface CouponResult {
  valid: boolean
  code: string
  title?: string
  discount_type?: 'Percent' | 'Amount'
  value?: number
  item_group?: string | null
  discount?: number
  per_line?: number[]
  uses_left?: number | null
  reason?: string
  message?: string
}

export interface FeedbackSummary {
  days: number
  count: number
  avg_rating: number
  low_count: number
  by_boutique: { boutique: string; count: number; low: number; avg_rating: number }[]
  recent: { name: string; boutique: string; rating: number; comment: string; submitted_at: string; status: string }[]
  threshold: number
}

export interface V04Api {
  crm: {
    profile(customer: string): Promise<ClientProfile>
    update_profile(customer: string, values: Partial<ClientProfileFields>): Promise<ClientProfile>
    wishlist_add(customer: string, item_code: string, notes?: string): Promise<{ wishlist: WishlistRow[] }>
    wishlist_remove(customer: string, item_code?: string, row?: string): Promise<{ wishlist: WishlistRow[] }>
    tasks(args?: { customer?: string; boutique?: string; include_done?: 0 | 1 }): Promise<Interaction[]>
    log_interaction(args: { customer: string; type: InteractionType; note?: string; follow_up_date?: string }): Promise<Interaction>
    complete_task(name: string, status?: 'Done' | 'Cancelled' | 'Open'): Promise<Interaction>
  }
  hr: {
    clock_in(associate: string, boutique: string, device_id?: string): Promise<ShiftStatus>
    clock_out(associate: string, device_id?: string): Promise<ShiftStatus>
    toggle_break(associate: string): Promise<ShiftStatus>
    shift_status(associate?: string): Promise<ShiftStatus>
    on_shift(boutique: string): Promise<(ShiftInfo & { associate: string; associate_name: string })[]>
  }
  promotions: {
    active(boutique: string): Promise<ActivePromotions>
    check_coupon(code: string, lines: CouponCheckLine[], boutique?: string, customer?: string): Promise<CouponResult>
    loyalty(customer: string): Promise<TierProgress>
  }
  feedback: {
    summary(days?: number): Promise<FeedbackSummary>
  }
}

// ---------------------------------------------------------------------------------------------
// Frappe client (same conventions as ./frappe.ts)
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
      res = await fetch(`${url}?${qs}`, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json', 'X-Frappe-CSRF-Token': csrf() } })
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
        message = stripHtml((JSON.parse(body._server_messages) as string[]).map((m) => JSON.parse(m).message).join('\n'))
      } catch {
        /* ignore */
      }
    } else if (body?.exception) message = stripHtml(String(body.exception).split('\n').pop()) || message
    throw new ApiError(message, res.status === 401 || res.status === 403 ? 'AUTH' : body?.exc_type || `HTTP_${res.status}`, res.status, body)
  }
  return (body?.message ?? body) as T
}

export const frappeV04: V04Api = {
  crm: {
    profile: (customer) => call('crm.profile', { customer }, true),
    update_profile: (customer, values) => call('crm.update_profile', { customer, values }),
    wishlist_add: (customer, item_code, notes) => call('crm.wishlist_add', { customer, item_code, notes }),
    wishlist_remove: (customer, item_code, row) => call('crm.wishlist_remove', { customer, item_code, row }),
    tasks: (args = {}) => call('crm.tasks', { ...args }, true),
    log_interaction: (args) => call('crm.log_interaction', { ...args }),
    complete_task: (name, status = 'Done') => call('crm.complete_task', { name, status })
  },
  hr: {
    clock_in: (associate, boutique, device_id) => call('hr.clock_in', { associate, boutique, device_id }),
    clock_out: (associate, device_id) => call('hr.clock_out', { associate, device_id }),
    toggle_break: (associate) => call('hr.toggle_break', { associate }),
    shift_status: (associate) => call('hr.shift_status', { associate }, true),
    on_shift: (boutique) => call('hr.on_shift', { boutique }, true)
  },
  promotions: {
    active: (boutique) => call('promotions.active', { boutique }, true),
    check_coupon: (code, lines, boutique, customer) => call('promotions.check_coupon', { code, lines, boutique, customer }),
    loyalty: (customer) => call('promotions.loyalty', { customer }, true)
  },
  feedback: {
    summary: (days = 30) => call('feedback.summary', { days }, true)
  }
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1) — deterministic, in-memory, persisted like ./mock.ts
// ---------------------------------------------------------------------------------------------
export const MOCK_PROMOTIONS: Promotion[] = [
  {
    name: 'PRLE-0001',
    title: 'Accessories week −15%',
    apply_on: 'Item Group',
    targets: ['Accessories'],
    kind: 'percent',
    rate: 0,
    discount_percentage: 15,
    discount_amount: 0,
    min_qty: 0,
    max_qty: 0,
    min_amt: 0,
    max_amt: 0,
    valid_from: '2026-08-19',
    valid_upto: '2026-09-21',
    warehouse: null,
    tier: null,
    priority: 1
  },
  {
    name: 'PRLE-0002',
    title: 'Platinum privilege −5% on Rings',
    apply_on: 'Item Group',
    targets: ['Rings'],
    kind: 'percent',
    rate: 0,
    discount_percentage: 5,
    discount_amount: 0,
    min_qty: 0,
    max_qty: 0,
    min_amt: 0,
    max_amt: 0,
    valid_from: '2026-07-23',
    valid_upto: null,
    warehouse: null,
    tier: 'Platinum',
    priority: 1
  },
  {
    name: 'PRLE-0003',
    title: '$200 off Watches over $5,000',
    apply_on: 'Item Group',
    targets: ['Watches'],
    kind: 'amount',
    rate: 0,
    discount_percentage: 0,
    discount_amount: 200,
    min_qty: 0,
    max_qty: 0,
    min_amt: 5000,
    max_amt: 0,
    valid_from: null,
    valid_upto: null,
    warehouse: null,
    tier: null,
    priority: 2
  }
]

interface MockCoupon {
  code: string
  title: string
  discount_type: 'Percent' | 'Amount'
  value: number
  min_basket: number
  item_group?: string | null
  customer?: string | null
  usage: 'Single-use' | 'Multi-use'
  max_uses: number
  used_count: number
  enabled: boolean
}

export const MOCK_COUPONS: MockCoupon[] = [
  { code: 'WELCOME10', title: 'Welcome 10% off', discount_type: 'Percent', value: 10, min_basket: 0, usage: 'Multi-use', max_uses: 0, used_count: 3, enabled: true },
  { code: 'BRIDAL500', title: '$500 off bridal', discount_type: 'Amount', value: 500, min_basket: 5000, item_group: 'Rings', usage: 'Multi-use', max_uses: 50, used_count: 0, enabled: true },
  { code: 'VIP-ELEANOR', title: 'Private 15% for Eleanor', discount_type: 'Percent', value: 15, min_basket: 0, customer: 'CUST-0001', usage: 'Single-use', max_uses: 1, used_count: 0, enabled: true }
]

const TIERS: TierRow[] = LOYALTY.tiers.map((t) => ({ tier: t.tier, min_spent: t.min_spent, collection_factor: 1 }))

const mock = {
  profiles: new Map<string, ClientProfileFields>(),
  wishlists: new Map<string, WishlistRow[]>(),
  interactions: [] as Interaction[],
  shifts: new Map<string, ShiftInfo>(),
  coupons: MOCK_COUPONS.map((c) => ({ ...c })),
  seq: 1
}

const LS = 'maison.mock.v04'
function load() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS) : null
    if (!raw) return
    const j = JSON.parse(raw)
    mock.profiles = new Map(Object.entries(j.profiles || {}))
    mock.wishlists = new Map(Object.entries(j.wishlists || {}))
    mock.interactions = j.interactions || []
    mock.shifts = new Map(Object.entries(j.shifts || {}))
    mock.coupons = j.coupons || mock.coupons
    mock.seq = j.seq || 1
  } catch {
    /* ignore */
  }
}
function save() {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(
      LS,
      JSON.stringify({
        profiles: Object.fromEntries(mock.profiles),
        wishlists: Object.fromEntries(mock.wishlists),
        interactions: mock.interactions,
        shifts: Object.fromEntries(mock.shifts),
        coupons: mock.coupons,
        seq: mock.seq
      })
    )
  } catch {
    /* quota */
  }
}
load()

const SEED_PROFILES: Record<string, ClientProfileFields & { wishlist: string[] }> = {
  'CUST-0001': { ring_size: '6.5', wrist_size: '15.5', metal_preference: 'Platinum', birthday: '1981-03-14', anniversary: '2009-06-21', spouse_name: 'Marco Whitmore', style_notes: 'Clean lines, no yellow gold. Collects chronographs for Marco.', preferred_boutique: 'CHI-OAK', preferred_associate: 'chi.oak.a1@maison.example', preferred_associate_name: 'Ines Calder', wishlist: ['HJ-PAR-032', 'RG-HAL-003'] },
  'CUST-0002': { wrist_size: '18', metal_preference: 'White Gold', birthday: '1974-11-02', style_notes: 'Watch collector; wants bracelet sizing on the spot.', preferred_boutique: 'NYC-MAD', wishlist: ['WT-CHR-026'] },
  'CUST-0006': { ring_size: '10', metal_preference: 'Yellow Gold', birthday: '1969-01-19', anniversary: '2004-05-15', spouse_name: 'Anna Lindqvist', style_notes: 'One significant timepiece a year, usually Q4.', preferred_boutique: 'CHI-OAK', do_not_phone: 1, wishlist: ['WT-GMT-030', 'AC-CLN-036'] },
  'CUST-0007': { ring_size: '5', metal_preference: 'Rose Gold', birthday: '1989-10-10', style_notes: 'Bridal set completed 2025; building everyday fine jewellery.', preferred_boutique: 'LA-RODEO', vip_tier_override: 'Gold', wishlist: ['ER-STD-020'] }
}

function delay() {
  return new Promise((r) => setTimeout(r, 120 + Math.random() * 200))
}
async function guard() {
  await delay()
  if (typeof window !== 'undefined' && window.__maisonOffline) throw new ApiError('Failed to fetch', 'NETWORK', 0)
}
function customerOr404(customer: string): Customer {
  const c = CUSTOMERS.find((x) => x.name === customer)
  if (!c) throw new ApiError(`Customer ${customer} not found`, 'DoesNotExistError', 404)
  return c
}
function profileOf(customer: string): ClientProfileFields {
  if (!mock.profiles.has(customer)) {
    const seed = SEED_PROFILES[customer]
    const { wishlist, ...fields } = seed || { wishlist: [] as string[] }
    mock.profiles.set(customer, { do_not_email: 0, do_not_sms: 0, do_not_phone: 0, ...fields })
    if (!mock.wishlists.has(customer)) {
      mock.wishlists.set(
        customer,
        (wishlist || []).map((code, i) => ({
          name: `W${customer}-${i}`,
          item_code: code,
          item_name: ITEMS.find((it) => it.item_code === code)?.item_name || code,
          notes: 'Mentioned in boutique',
          added_by: 'Administrator',
          added_on: '2026-08-01 10:00:00',
          fulfilled: 0
        }))
      )
    }
    save()
  }
  return mock.profiles.get(customer)!
}
function spentOf(c: Customer): number {
  return Math.round(c.loyalty_points / 0.12)
}
export function mockTierProgress(c: Customer, override?: string | null): TierProgress {
  const spent = spentOf(c)
  const tiers = TIERS
  let current: TierRow | null = null
  for (const t of tiers) if (spent >= t.min_spent) current = t
  const next = tiers.find((t) => !current || t.min_spent > current.min_spent) || null
  const base = current?.min_spent || 0
  const progress = next ? Math.max(0, Math.min(1, (spent - base) / (next.min_spent - base))) : 1
  return {
    program: LOYALTY.name,
    tier: override || current?.tier || null,
    tier_override: override || null,
    points: c.loyalty_points,
    points_value: Math.round(c.loyalty_points * LOYALTY.conversion_factor * 100) / 100,
    spent,
    tiers,
    next_tier: next?.tier || null,
    next_tier_min_spent: next?.min_spent ?? null,
    to_next_tier: next ? next.min_spent - spent : 0,
    progress,
    expiry_duration_days: 730,
    points_expiring_90d: c.loyalty_points > 20000 ? 1200 : 0,
    birthday_bonus_points: 250
  }
}
function buildProfile(customer: string): ClientProfile {
  const c = customerOr404(customer)
  const profile = profileOf(customer)
  const owned: OwnedPiece[] =
    customer === 'CUST-0001' || customer === 'CUST-0006'
      ? [
          { serial_no: `WT-DRS-027-${customer.slice(-2)}-001`, item_code: 'WT-DRS-027', item_name: ITEMS.find((i) => i.item_code === 'WT-DRS-027')?.item_name || 'WT-DRS-027', invoice: 'ACC-SINV-2026-00014', date: '2026-03-02', boutique: 'CHI-OAK', rate: PRICES['WT-DRS-027'] || 0, metal: 'Steel' },
          { serial_no: `RG-SOL-001-${customer.slice(-2)}-002`, item_code: 'RG-SOL-001', item_name: ITEMS.find((i) => i.item_code === 'RG-SOL-001')?.item_name || 'RG-SOL-001', invoice: 'ACC-SINV-2025-00311', date: '2025-12-18', boutique: 'NYC-MAD', rate: PRICES['RG-SOL-001'] || 0, metal: 'Platinum', certificate_no: 'GIA 2231-8842' }
        ]
      : []
  return {
    customer: { ...c, tier: profile.vip_tier_override || c.tier },
    profile,
    wishlist: mock.wishlists.get(customer) || [],
    owned_pieces: owned,
    follow_ups: mock.interactions.filter((i) => i.customer === customer && i.follow_up_date && i.status === 'Open'),
    interactions: mock.interactions.filter((i) => i.customer === customer).slice(-20).reverse(),
    loyalty: mockTierProgress(c, profile.vip_tier_override),
    next_best_offer: [],
    crm: { installed: true, contact: `CONTACT-${customer}` },
    can_edit_tier: true
  }
}

export const mockV04: V04Api = {
  crm: {
    async profile(customer) {
      await guard()
      return JSON.parse(JSON.stringify(buildProfile(customer)))
    },
    async update_profile(customer, values) {
      await guard()
      const p = profileOf(customer)
      Object.assign(p, values)
      save()
      return JSON.parse(JSON.stringify(buildProfile(customer)))
    },
    async wishlist_add(customer, item_code, notes) {
      await guard()
      const it = ITEMS.find((i) => i.item_code === item_code)
      if (!it) throw new ApiError(`Item ${item_code} not found`, 'DoesNotExistError', 404)
      profileOf(customer)
      const list = mock.wishlists.get(customer) || []
      const existing = list.find((w) => w.item_code === item_code && !w.fulfilled)
      if (existing) existing.notes = notes ?? existing.notes
      else list.push({ name: `W${mock.seq++}`, item_code, item_name: it.item_name, notes: notes || null, added_by: 'pos', added_on: new Date().toISOString(), fulfilled: 0 })
      mock.wishlists.set(customer, list)
      save()
      return { wishlist: JSON.parse(JSON.stringify(list)) }
    },
    async wishlist_remove(customer, item_code, row) {
      await guard()
      const list = (mock.wishlists.get(customer) || []).filter((w) => !((row && w.name === row) || (!row && item_code && w.item_code === item_code)))
      mock.wishlists.set(customer, list)
      save()
      return { wishlist: JSON.parse(JSON.stringify(list)) }
    },
    async tasks(args = {}) {
      await guard()
      return mock.interactions.filter((i) => i.follow_up_date && (args.include_done || i.status === 'Open') && (!args.customer || i.customer === args.customer))
    },
    async log_interaction(args) {
      await guard()
      customerOr404(args.customer)
      const row: Interaction = {
        name: `INT${mock.seq++}`,
        customer: args.customer,
        customer_name: customerOr404(args.customer).customer_name,
        type: args.type,
        note: args.note || null,
        boutique: 'CHI-OAK',
        associate: 'chi.oak.a1@maison.example',
        ts: new Date().toISOString(),
        follow_up_date: args.follow_up_date || null,
        status: args.follow_up_date ? 'Open' : 'Done',
        done_on: args.follow_up_date ? null : new Date().toISOString(),
        crm_task: args.follow_up_date ? `CRM-TASK-${mock.seq}` : null
      }
      mock.interactions.push(row)
      save()
      return { ...row }
    },
    async complete_task(name, status = 'Done') {
      await guard()
      const row = mock.interactions.find((i) => i.name === name)
      if (!row) throw new ApiError('Not found', 'DoesNotExistError', 404)
      row.status = status
      row.done_on = status === 'Done' ? new Date().toISOString() : null
      save()
      return { ...row }
    }
  },
  hr: {
    async clock_in(associate, boutique) {
      await guard()
      const existing = mock.shifts.get(associate)
      if (existing && existing.status !== 'Off shift') return { on_shift: true, shift: { ...existing }, created: false, hrms: true }
      const shift: ShiftInfo = { name: `SHIFT${mock.seq++}`, boutique, clock_in: new Date().toISOString(), status: 'On shift', break_minutes: 0, worked_minutes: 0 }
      mock.shifts.set(associate, shift)
      save()
      return { on_shift: true, shift: { ...shift }, created: true, hrms: true }
    },
    async clock_out(associate) {
      await guard()
      const s = mock.shifts.get(associate)
      if (!s || s.status === 'Off shift') return { on_shift: false, shift: null, closed: false }
      s.status = 'Off shift'
      s.worked_minutes = Math.max(0, Math.round((Date.now() - new Date(s.clock_in).getTime()) / 60000) - s.break_minutes)
      save()
      return { on_shift: false, shift: { ...s }, closed: true }
    },
    async toggle_break(associate) {
      await guard()
      const s = mock.shifts.get(associate)
      if (!s || s.status === 'Off shift') throw new ApiError('Not clocked in', 'ValidationError', 417)
      if (s.status === 'On break') {
        s.break_minutes += Math.round((Date.now() - new Date(s.break_started!).getTime()) / 60000)
        s.break_started = null
        s.status = 'On shift'
      } else {
        s.break_started = new Date().toISOString()
        s.status = 'On break'
      }
      save()
      return { on_shift: true, shift: { ...s } }
    },
    async shift_status(associate) {
      await guard()
      const s = associate ? mock.shifts.get(associate) : undefined
      if (!s || s.status === 'Off shift') return { on_shift: false, shift: null, hrms: true }
      return { on_shift: true, shift: { ...s, worked_minutes: Math.max(0, Math.round((Date.now() - new Date(s.clock_in).getTime()) / 60000) - s.break_minutes) }, hrms: true }
    },
    async on_shift(boutique) {
      await guard()
      return [...mock.shifts.entries()].filter(([, s]) => s.boutique === boutique && s.status !== 'Off shift').map(([a, s]) => ({ ...s, associate: a, associate_name: a.split('@')[0] }))
    }
  },
  promotions: {
    async active(boutique) {
      await guard()
      return { boutique, date: new Date().toISOString().slice(0, 10), enabled: true, promotions: JSON.parse(JSON.stringify(MOCK_PROMOTIONS)), coupons_available: true, version: new Date().toISOString() }
    },
    async check_coupon(code, lines, boutique, customer) {
      await guard()
      const norm = code.replace(/\s+/g, '').toUpperCase()
      const c = mock.coupons.find((x) => x.code === norm)
      const fail = (reason: string, message: string): CouponResult => ({ valid: false, code: norm, reason, message })
      if (!c) return fail('unknown', `Unknown coupon ${norm}`)
      if (!c.enabled) return fail('disabled', `Coupon ${norm} is disabled`)
      if (c.customer && c.customer !== customer) return fail('wrong_customer', `Coupon ${norm} is reserved for another client`)
      const limit = c.usage === 'Single-use' ? 1 : c.max_uses
      if (limit && c.used_count >= limit) return fail('exhausted', `Coupon ${norm} has already been used`)
      const groupOf = (code: string) => ITEMS.find((i) => i.item_code === code)?.item_group
      const nets = lines.map((l) => Math.round((l.qty * l.rate - (l.discount_amount || 0)) * 100) / 100)
      const basket = nets.reduce((a, b) => a + b, 0)
      if (c.min_basket && basket < c.min_basket) return fail('min_basket', `Coupon ${norm} needs a basket of at least ${c.min_basket}`)
      const eligible = lines.map((l, i) => (!c.item_group || groupOf(l.item_code) === c.item_group ? i : -1)).filter((i) => i >= 0)
      const base = eligible.reduce((a, i) => a + nets[i], 0)
      if (base <= 0) return fail('not_applicable', `Coupon ${norm} does not apply to anything in this basket`)
      const total = c.discount_type === 'Percent' ? Math.round(base * c.value) / 100 : Math.min(c.value, base)
      const per_line = lines.map(() => 0)
      let acc = 0
      eligible.forEach((i, k) => {
        const share = k === eligible.length - 1 ? Math.round((total - acc) * 100) / 100 : Math.round(((total * nets[i]) / base) * 100) / 100
        per_line[i] = share
        acc += share
      })
      return { valid: true, code: norm, title: c.title, discount_type: c.discount_type, value: c.value, item_group: c.item_group || null, discount: total, per_line, uses_left: limit ? limit - c.used_count : null }
    },
    async loyalty(customer) {
      await guard()
      return mockTierProgress(customerOr404(customer), profileOf(customer).vip_tier_override)
    }
  },
  feedback: {
    async summary(days = 30) {
      await guard()
      return {
        days,
        count: 6,
        avg_rating: 4.2,
        low_count: 1,
        by_boutique: [
          { boutique: 'CHI-OAK', count: 3, low: 1, avg_rating: 3.7 },
          { boutique: 'NYC-MAD', count: 2, low: 0, avg_rating: 4.5 },
          { boutique: 'LA-RODEO', count: 1, low: 0, avg_rating: 5 }
        ],
        recent: [{ name: 'FB1', boutique: 'CHI-OAK', rating: 2, comment: 'Felt rushed at the counter.', submitted_at: '2026-08-20 11:02:00', status: 'New' }],
        threshold: 2
      }
    }
  }
}

/** Redeem a coupon in the mock server (called by the mock submit path of the promos store). */
export function __mockRedeemCoupon(code: string) {
  const c = mock.coupons.find((x) => x.code === code.toUpperCase())
  if (c) {
    c.used_count += 1
    save()
  }
}

export function __resetMockV04() {
  mock.profiles.clear()
  mock.wishlists.clear()
  mock.interactions = []
  mock.shifts.clear()
  mock.coupons = MOCK_COUPONS.map((c) => ({ ...c }))
  mock.seq = 1
  save()
}

export const v04: V04Api = import.meta.env.VITE_MOCK === '1' ? mockV04 : frappeV04
