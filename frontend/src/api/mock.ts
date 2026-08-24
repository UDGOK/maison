/**
 * In-memory mock of the Frappe backend. Enabled with `VITE_MOCK=1`.
 * - Simulates latency (120–400 ms).
 * - `window.__maisonOffline = true` makes every call fail with a NETWORK ApiError,
 *   exactly like a fetch() that cannot reach the bench.
 * - Tracks sold serials so duplicate/conflict errors behave like the real server.
 */
import { __mockCollectWebOrder, __mockWebOrderPrepaid } from './webshop' // v0.4 G
import {
  ApiError,
  type Bootstrap,
  type Customer,
  type CustomerHistoryRow,
  type Delta,
  type EnrollRequest,
  type EnrollResult,
  type MatchResult,
  type RecognitionOutcome,
  type TemplateRow,
  type TemplatesResult,
  DEFAULT_CONSENT_TEXT,
  RECOGNITION_MODEL,
  type LiveSummary,
  type MaisonApi,
  type POSInvoice,
  type PublicReceipt,
  type Recommendation,
  type SalesList,
  type SalesSummaryRow,
  type SubmitResult
} from './types'
import {
  ASSOCIATES,
  BOUTIQUES,
  CUSTOMERS,
  DEPARTMENTS,
  ITEMS,
  ITEM_GROUPS,
  LOYALTY,
  PRICES,
  PRICING_RULES,
  TAXES,
  BOUTIQUE_SHOW_IMAGES,
  SETTINGS_GLOBAL,
  barcodesFor,
  clientNumberFor,
  serialsFor,
  stockFor
} from './seed'
import { computeTotals } from '@/utils/totals'
import { round } from '@/utils/money' // v0.8 POS D1 / D11
import { computeExchange, computeReturnTotals, managerRequired } from '@/returns/math'
import { compareCount } from '@/inventory/count'
import type { CycleCountResult, ExchangeRequest, ExchangeResult, POSInvoiceItem, ReturnRequest, ReturnResult, ReturnableInvoice, StockAlert } from './types'
import { sha256Hex } from '@/utils/hash'
import { DEFAULT_DISTANCE_THRESHOLD, rankMatches } from '@/recognition/math'
import { JEWELLERY_BRAND } from '@/brand/tokens' // v0.6 N (pure tokens: importing @/stores/brand here closes an import cycle)

/** v0.3 — server-side face template (embedding only, never an image). */
interface MockTemplate {
  name: string
  customer: string
  embedding: number[]
  model: string
  dims: number
  quality: number
  captured_at: string
  boutique: string
  device_id: string
  consent: string
}
interface MockConsent {
  name: string
  customer: string
  status: 'Active' | 'Revoked'
  consent_text_version: string
  method: string
  boutique: string
  device_id: string
  captured_at: string
  revoked_at?: string
  revoked_by?: string
  has_signature: boolean
}
interface MockEvent {
  customer?: string
  boutique: string
  device_id: string
  score?: number
  outcome: RecognitionOutcome
  sales_invoice?: string
  ts: string
}

/** v0.4 E — mock credit note. */
interface MockCreditNote {
  name: string
  return_against: string
  boutique: string
  customer?: string
  customer_name?: string
  posting_datetime: string
  lines: { row: string; item_code: string; item_name: string; qty: number; rate: number; serials: string[]; reason: string; condition: string; warehouse: string }[]
  net_total: number
  total_taxes: number
  grand_total: number
  refund_method: string
  refund_id?: string
  exchange_invoice?: string
  receipt_token: string
  payments: { mode_of_payment: string; amount: number }[]
}
/** v0.4 E — mock returns policy (Maison POS Settings). */
export const RETURNS_POLICY = { return_window_days: 30, exchange_window_days: 60, returns_manager_threshold: 2500 }

/** Mock `Maison POS Settings` recognition block; `match_threshold` is the maximum euclidean distance between RAW descriptors (face-api rule: < 0.6). */
export const RECOGNITION_SETTINGS = {
  face_recognition_enabled: true,
  recognition_model: RECOGNITION_MODEL,
  match_threshold: DEFAULT_DISTANCE_THRESHOLD,
  biometric_retention_months: 36,
  consent_text: DEFAULT_CONSENT_TEXT,
  consent_text_version: '2026-08-1',
  recognition_offline_cache: true
}
/** Per-boutique override (Maison Boutique `face_recognition_enabled`: Inherit/On/Off). */
export const BOUTIQUE_RECOGNITION: Record<string, 'Inherit' | 'On' | 'Off'> = { 'CHI-OAK': 'On', 'NYC-MAD': 'Inherit', 'LA-RODEO': 'Off' }

const state = {
  customers: CUSTOMERS.map((c) => ({ ...c })),
  /** per-boutique serials still available */
  serials: new Map<string, Record<string, string[]>>(),
  stock: new Map<string, Record<string, number>>(),
  submitted: new Map<string, SubmitResult>(),
  // v0.8 POS D7 / D11 — card brand / last 4 / approval and the cash tendered + change given
  /** v0.8 POS D4 — receipts the mock has "sent" (asserted by the vitest suite) */
  emails: [] as { invoice: string; email: string; at: string }[],
  invoices: [] as (SalesSummaryRow & { boutique: string; item_codes: string[]; lines?: POSInvoiceItem[]; receipt_token?: string; terminal_ref?: string; card_brand?: string; card_last4?: string; approval_code?: string; last4?: string; change_amount?: number; tendered?: number; tax_rate?: number })[],
  /** v0.4 E: credit notes */
  returns: [] as MockCreditNote[],
  /** v0.4 D: stock alerts */
  alerts: [] as StockAlert[],
  history: new Map<string, CustomerHistoryRow[]>(),
  seq: 1,
  /** v0.2: Item.image overrides uploaded from the POS */
  images: {} as Record<string, string>,
  /** v0.2: receipt token → public receipt */
  receipts: {} as Record<string, PublicReceipt>,
  /** v0.3: in-memory face templates / consents / recognition events */
  templates: [] as MockTemplate[],
  consents: [] as MockConsent[],
  events: [] as MockEvent[]
}

// --- persistence: keep the "server" alive across page reloads in dev (localStorage) ---
const LS_KEY = 'maison.mock.state'
function load() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null
    if (!raw) return
    const j = JSON.parse(raw)
    state.customers = j.customers || state.customers
    state.serials = new Map(Object.entries(j.serials || {}))
    state.stock = new Map(Object.entries(j.stock || {}))
    state.submitted = new Map(Object.entries(j.submitted || {}))
    state.invoices = j.invoices || []
    state.history = new Map(Object.entries(j.history || {}))
    state.seq = j.seq || 1
    state.images = j.images || {}
    state.receipts = j.receipts || {}
    state.templates = j.templates || []
    state.consents = j.consents || []
    state.events = j.events || []
    state.returns = j.returns || []
    state.alerts = j.alerts || []
    state.emails = j.emails || [] // v0.8 POS D4
  } catch {
    /* ignore corrupt state */
  }
}
function save() {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        customers: state.customers,
        serials: Object.fromEntries(state.serials),
        stock: Object.fromEntries(state.stock),
        submitted: Object.fromEntries(state.submitted),
        invoices: state.invoices,
        history: Object.fromEntries(state.history),
        seq: state.seq,
        images: state.images,
        receipts: state.receipts,
        templates: state.templates,
        consents: state.consents,
        events: state.events,
        returns: state.returns,
        alerts: state.alerts,
        emails: state.emails // v0.8 POS D4
      })
    )
  } catch {
    /* quota */
  }
}
load()

function serials(b: string) {
  if (!state.serials.has(b)) state.serials.set(b, serialsFor(b))
  return state.serials.get(b)!
}
function stock(b: string) {
  if (!state.stock.has(b)) state.stock.set(b, stockFor(b))
  return state.stock.get(b)!
}

function delay(min = 120, max = 400) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))
}

async function guard() {
  await delay()
  if (typeof window !== 'undefined' && window.__maisonOffline) {
    throw new ApiError('Failed to fetch', 'NETWORK', 0)
  }
}

function itemsWithImages() {
  return ITEMS.map((it) => (state.images[it.item_code] ? { ...it, image: state.images[it.item_code] } : it))
}

/** Boutique overrides global (`Maison POS Settings` merged with `Maison Boutique`). */
function settingsFor(boutique: string) {
  return {
    show_product_images: BOUTIQUE_SHOW_IMAGES[boutique] ?? SETTINGS_GLOBAL.show_product_images_default,
    scan_enabled: SETTINGS_GLOBAL.scan_enabled,
    receipt_qr_enabled: SETTINGS_GLOBAL.receipt_qr_enabled,
    receipt_qr_base_url: SETTINGS_GLOBAL.receipt_qr_base_url,
    loyalty_lookup_enabled: SETTINGS_GLOBAL.loyalty_lookup_enabled,
    ...RECOGNITION_SETTINGS,
    face_recognition_enabled: recognitionEnabledFor(boutique),
    ...RETURNS_POLICY
  }
}

function recognitionEnabledFor(boutique: string): boolean {
  const o = BOUTIQUE_RECOGNITION[boutique] || 'Inherit'
  return o === 'Inherit' ? RECOGNITION_SETTINGS.face_recognition_enabled : o === 'On'
}

function bootstrapFor(boutique: string): Bootstrap {
  const b = BOUTIQUES.find((x) => x.name === boutique)
  if (!b) throw new ApiError(`Boutique ${boutique} not found`, 'NotFound', 404)
  ensureDemoHistory(boutique)
  const ser = JSON.parse(JSON.stringify(serials(boutique)))
  return {
    boutique: { ...b, readers: b.readers || readersFor(boutique), damaged_warehouse: b.damaged_warehouse || `${boutique} Damaged - MJ` },
    associates: ASSOCIATES.filter((a) => a.boutique === boutique || a.role === 'HeadOffice'),
    pos_profile: b.pos_profile,
    taxes: TAXES,
    modes_of_payment: ['Cash', 'Card'],
    item_groups: ITEM_GROUPS,
    departments: DEPARTMENTS,
    items: itemsWithImages(),
    prices: { ...PRICES },
    pricing_rules: PRICING_RULES.filter((r) => r.warehouse === b.warehouse),
    serials: ser,
    stock: { ...stock(boutique) },
    loyalty_program: LOYALTY,
    barcodes: barcodesFor(ser),
    settings: settingsFor(boutique),
    version: new Date().toISOString(),
    // --- v0.6 N/Q: the mock world is the jewellery house (brand tokens, no fixed tiers) ---
    brand: { ...JEWELLERY_BRAND },
    reward_tiers: []
    // --- end v0.6 N/Q ---
  }
}

export const mockApi: MaisonApi = {
  catalog: {
    async bootstrap(boutique) {
      await guard()
      return bootstrapFor(boutique)
    },
    async delta(boutique): Promise<Delta> {
      await guard()
      // Mock: nothing changes server-side except serials/stock, so resend those only.
      const full = bootstrapFor(boutique)
      return { ...full, items: [], prices: {}, pricing_rules: [], deleted: [] }
    },
    async upload_item_image(item_code, file) {
      await guard()
      if (!ITEMS.some((i) => i.item_code === item_code)) throw new ApiError(`Item ${item_code} not found`, 'NotFound', 404)
      if (!file || !file.size) throw new ApiError('No file', 'ValidationError', 417)
      // The real server stores a File doc and returns its URL; the mock returns a data URI so
      // the tile updates immediately (and survives reloads via localStorage).
      const url = await blobToDataUrl(file)
      state.images[item_code] = url
      save()
      return { item_code, image: url, file_url: url, file_name: `${item_code}.jpg` }
    }
  },
  customers: {
    async search(q, limit = 20) {
      await guard()
      const s = q.trim().toLowerCase()
      const digits = s.replace(/\D/g, '')
      const rows = state.customers.filter(
        (c) =>
          !s ||
          c.customer_name.toLowerCase().includes(s) ||
          (c.client_number || '').toLowerCase().includes(s) ||
          (digits.length >= 4 && (c.mobile_no || '').replace(/\D/g, '').includes(digits)) ||
          (c.email_id || '').toLowerCase().includes(s)
      )
      return rows.slice(0, limit)
    },
    async lookup(code) {
      await guard()
      const raw = code.trim()
      if (!raw) return null
      const up = raw.toUpperCase()
      const qr = up.startsWith('MC:') ? raw.slice(3) : null
      const digits = raw.replace(/\D/g, '')
      const c = state.customers.find(
        (x) =>
          (qr && x.name === qr) ||
          (x.client_number || '').toUpperCase() === up ||
          (digits.length >= 6 && (x.mobile_no || '').replace(/\D/g, '') === digits) ||
          (digits.length >= 7 && (x.mobile_no || '').replace(/\D/g, '').endsWith(digits))
      )
      return c ? { ...c } : null
    },
    async upsert(customer) {
      await guard()
      if (!customer.customer_name?.trim()) throw new ApiError('Customer name is required', 'ValidationError', 417)
      if (customer.name) {
        const idx = state.customers.findIndex((c) => c.name === customer.name)
        if (idx >= 0) {
          state.customers[idx] = { ...state.customers[idx], ...customer } as Customer
          return { name: customer.name }
        }
      }
      const idx = state.customers.length + 1
      const name = `CUST-${String(idx).padStart(4, '0')}`
      const client_number = clientNumberFor(idx - 1)
      state.customers.unshift({
        name,
        customer_name: customer.customer_name,
        mobile_no: customer.mobile_no,
        email_id: customer.email_id,
        loyalty_points: 0,
        tier: 'Member',
        client_number,
        maison_face_consent: 0
      })
      save()
      return { name, client_number }
    },
    async history(customer, limit = 20) {
      await guard()
      const cust = state.customers.find((c) => c.name === customer)
      const seeded: CustomerHistoryRow[] = cust?.last_visit
        ? [
            {
              invoice: `SINV-${cust.name.slice(-4)}-01`,
              date: cust.last_visit,
              boutique: cust.last_boutique || 'CHI-OAK',
              items: [ITEMS[parseInt(cust.name.slice(-4)) % ITEMS.length].item_name],
              grand_total: Math.round(cust.loyalty_points / 0.12 / 3)
            }
          ]
        : []
      return [...(state.history.get(customer) || []), ...seeded].slice(0, limit)
    }
  },
  sales: {
    async submit_batch(invoices) {
      await guard()
      const results: SubmitResult[] = []
      for (const inv of invoices) results.push(processInvoice(inv))
      save()
      return { results }
    },
    async list(boutique, date): Promise<SalesList> {
      await guard()
      const rows = state.invoices.filter((i) => i.boutique === boutique && i.posting_datetime.slice(0, 10) === date)
      const net = rows.reduce((s, r) => s + r.net_total, 0)
      const tax = rows.reduce((s, r) => s + r.total_taxes, 0)
      const gross = rows.reduce((s, r) => s + r.grand_total, 0)
      const cash = rows.reduce((s, r) => s + r.cash, 0)
      const card = rows.reduce((s, r) => s + r.card, 0)
      return {
        boutique,
        date,
        totals: { net, tax, gross, cash, card, invoices: rows.length, avg_ticket: rows.length ? gross / rows.length : 0 },
        invoices: rows
      }
    },
    async void(invoice, reason) {
      await guard()
      if (!reason?.trim()) throw new ApiError('Reason is required', 'ValidationError', 417)
      const row = state.invoices.find((i) => i.invoice === invoice)
      if (!row) throw new ApiError(`Invoice ${invoice} not found`, 'NotFound', 404)
      return { credit_note: invoice.replace('SINV', 'CN') }
    },
    async receipt(token) {
      await delay()
      const r = state.receipts[token]
      if (!r) throw new ApiError('Receipt not found', 'NotFound', 404)
      return r
    },
    // --- v0.8 POS D4 — the mock sends for real too, so the receipt screen can be exercised offline ---
    async email_receipt(invoice_or_token, email) {
      await guard()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((email || '').trim()))
        throw new ApiError('That e-mail address does not look right', 'ValidationError', 417)
      const inv = state.invoices.find((i) => i.invoice === invoice_or_token || i.receipt_token === invoice_or_token)
      if (!inv) throw new ApiError('Receipt not found', 'NotFound', 404)
      state.emails.push({ invoice: inv.invoice, email: email.trim().toLowerCase(), at: new Date().toISOString() })
      save()
      const [user, domain] = email.trim().toLowerCase().split('@')
      return { ok: true, queued: true, invoice: inv.invoice, email_masked: `${user.slice(0, 2)}•••@${domain}` }
    }
    // --- end v0.8 POS D4 ---
  },
  stripe_terminal: {
    async connection_token(boutique) {
      await guard()
      return { secret: `pst_test_${boutique}_${Date.now().toString(36)}` }
    },
    async create_payment_intent(amount, currency, offline_uuid) {
      await guard()
      if (amount <= 0) throw new ApiError('Amount must be positive', 'ValidationError', 417)
      const id = `pi_${offline_uuid.replace(/-/g, '').slice(0, 20)}`
      return { id, client_secret: `${id}_secret_${currency.toLowerCase()}` }
    },
    async capture(payment_intent_id) {
      await guard()
      const brands = ['Visa', 'Mastercard', 'Amex']
      const n = parseInt(payment_intent_id.slice(-2), 36) || 0
      return {
        status: 'succeeded',
        charge_id: `ch_${payment_intent_id.slice(3)}`,
        card_brand: brands[n % brands.length],
        last4: String(4000 + (n % 1000)).padStart(4, '0')
      }
    }
  },
  recognition: {
    async match(embedding, model, boutique): Promise<MatchResult> {
      await guard()
      if (!Array.isArray(embedding) || !embedding.length) throw new ApiError('embedding is required', 'ValidationError', 417)
      if (!recognitionEnabledFor(boutique)) throw new ApiError('Recognition is off for this boutique', 'PermissionError', 403)
      const threshold = RECOGNITION_SETTINGS.match_threshold
      const ranked = rankMatches(embedding, activeTemplates(), threshold, model)
      const matches = ranked.map((r) => {
        const c = state.customers.find((x) => x.name === r.template.customer)
        return {
          customer: r.template.customer,
          customer_name: c?.customer_name || r.template.customer,
          client_number: c?.client_number,
          distance: Math.round(r.distance * 1e6) / 1e6,
          score: Math.round(r.score * 1000) / 1000,
          tier: c?.tier ?? null,
          loyalty_points: c?.loyalty_points ?? 0
        }
      })
      logEvent({ boutique, device_id: 'mock', customer: matches[0]?.customer, score: matches[0]?.score, outcome: matches[0] ? 'Matched' : 'NoMatch' })
      const best = ranked[0] ?? null
      return { matches, threshold_distance: threshold, threshold, best_distance: best ? matches[0].distance : null, best_score: best ? matches[0].score : 0 }
    },
    async enroll(req: EnrollRequest): Promise<EnrollResult> {
      await guard()
      if (!req.consent || !req.consent.method) throw new ApiError('Consent is required to enrol', 'ValidationError', 417)
      if (!req.embeddings?.length) throw new ApiError('At least one embedding is required', 'ValidationError', 417)
      const dims = req.embeddings[0].length
      if (req.embeddings.some((e) => !Array.isArray(e) || e.length !== dims || e.some((x) => typeof x !== 'number' || !Number.isFinite(x))))
        throw new ApiError('Embeddings must be equal-length numeric arrays', 'ValidationError', 417)
      const before = state.customers.length
      const cust = findOrCreateCustomer(req)
      const created = state.customers.length > before
      // one Active consent per customer: a re-enrolment revokes the previous one
      for (const c of state.consents) if (c.customer === cust.name && c.status === 'Active') Object.assign(c, { status: 'Revoked', revoked_at: new Date().toISOString(), revoked_by: 'system' })
      state.templates = state.templates.filter((t) => t.customer !== cust.name)
      const consent: MockConsent = {
        name: `MBC-${String(state.consents.length + 1).padStart(5, '0')}`,
        customer: cust.name,
        status: 'Active',
        consent_text_version: req.consent.text_version,
        method: req.consent.method,
        boutique: req.boutique,
        device_id: req.device_id,
        captured_at: new Date().toISOString(),
        has_signature: !!req.consent.signature_data_url
      }
      state.consents.push(consent)
      req.embeddings.forEach((embedding, i) =>
        state.templates.push({
          name: `MFT-${cust.name}-${i}`,
          customer: cust.name,
          embedding: [...embedding],
          model: req.model || RECOGNITION_MODEL,
          dims,
          quality: req.quality?.[i] ?? 0,
          captured_at: consent.captured_at,
          boutique: req.boutique,
          device_id: req.device_id,
          consent: consent.name
        })
      )
      cust.maison_face_consent = 1
      cust.maison_face_consent_at = consent.captured_at
      cust.face_templates = req.embeddings.length
      logEvent({ boutique: req.boutique, device_id: req.device_id, customer: cust.name, outcome: 'Enrolled' })
      save()
      return { customer: cust.name, client_number: cust.client_number, customer_name: cust.customer_name, consent: consent.name, template_count: req.embeddings.length, created }
    },
    async decline(args) {
      await guard()
      const cust = findOrCreateCustomer(args)
      logEvent({ boutique: args.boutique, device_id: args.device_id, customer: cust.name, outcome: 'Declined' })
      save()
      return { customer: cust.name, client_number: cust.client_number, customer_name: cust.customer_name }
    },
    async templates(boutique, since): Promise<TemplatesResult> {
      await guard()
      if (!RECOGNITION_SETTINGS.recognition_offline_cache) throw new ApiError('Offline cache is disabled', 'PermissionError', 403)
      const rows: TemplateRow[] = activeTemplates()
        .filter((t) => !since || t.captured_at > since)
        .map((t) => {
          const c = state.customers.find((x) => x.name === t.customer)
          return { customer: t.customer, customer_name: c?.customer_name || t.customer, client_number: c?.client_number, embedding: [...t.embedding], model: t.model }
        })
      const deleted = state.consents.filter((c) => c.status === 'Revoked' && (!since || (c.revoked_at || '') > since)).map((c) => c.customer)
      return { templates: rows, deleted: [...new Set(deleted)].filter((c) => !rows.some((r) => r.customer === c)), version: new Date().toISOString() }
    },
    async revoke(customer, reason) {
      await guard()
      if (!reason?.trim()) throw new ApiError('Reason is required', 'ValidationError', 417)
      const cust = state.customers.find((c) => c.name === customer)
      if (!cust) throw new ApiError(`Customer ${customer} not found`, 'NotFound', 404)
      state.templates = state.templates.filter((t) => t.customer !== customer)
      const now = new Date().toISOString()
      for (const c of state.consents) if (c.customer === customer && c.status === 'Active') Object.assign(c, { status: 'Revoked', revoked_at: now, revoked_by: 'manager' })
      cust.maison_face_consent = 0
      cust.maison_face_consent_at = undefined
      cust.face_templates = 0
      logEvent({ boutique: cust.last_boutique || 'CHI-OAK', device_id: 'mock', customer, outcome: 'Declined' })
      save()
      return { ok: true }
    },
    async log_event(args) {
      await guard()
      logEvent({ boutique: args.boutique || 'CHI-OAK', device_id: args.device_id || 'mock', customer: args.customer, score: args.score, outcome: args.outcome, sales_invoice: args.sales_invoice })
      save()
      return { ok: true }
    }
  },
  dashboard: {
    async live_summary(): Promise<LiveSummary> {
      await guard()
      return {
        totals: { net: 0, invoices: 0, cash: 0, card: 0, avg_ticket: 0 },
        by_boutique: BOUTIQUES.map((b) => ({
          boutique: b.name,
          name: b.boutique_name,
          net: 0,
          cash: 0,
          card: 0,
          invoices: 0,
          status: 'online' as const,
          last_seen: new Date().toISOString()
        })),
        by_hour: [],
        pending_approvals: 2,
        recognition: {
          matched_today: state.events.filter((e) => e.outcome === 'Matched' && e.ts.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
          enrolled_today: state.events.filter((e) => e.outcome === 'Enrolled' && e.ts.slice(0, 10) === new Date().toISOString().slice(0, 10)).length
        }
      }
    },
    async heartbeat() {
      await guard()
      return { ok: true }
    }
  },
  // v0.4 H — insights (parity with maison_pos.api.insights: owned items are never suggested)
  insights: {
    async recommend_for_client(customer, n = 3, boutique) {
      await guard()
      const owned = mockOwnedItems(customer)
      return { customer, owned: [...owned].sort(), source: 'cache', items: mockRecommend([...owned], owned, n, boutique) }
    },
    async recommend_for_basket(items, n = 3, boutique, customer) {
      await guard()
      if (!items.length) return { basket: [], items: [] }
      const exclude = new Set<string>([...items, ...(customer ? mockOwnedItems(customer) : [])])
      return { basket: items, items: mockRecommend(items, exclude, n, boutique) }
    }
  },
  async boutiques() {
    await guard()
    return BOUTIQUES.map((b) => ({ name: b.name, boutique_name: b.boutique_name, city: b.city }))
  },
  // ---- v0.4 E returns & exchanges ----
  returns: {
    async lookup(args) {
      await guard()
      let rows = state.invoices
      if (args.token) {
        const t = args.token.includes('/r/') ? args.token.split('/r/')[1].split('?')[0].replace(/\/$/, '') : args.token.trim()
        rows = rows.filter((i) => i.receipt_token === t)
        if (!rows.length) throw new ApiError('Receipt not found', 'NotFound', 404)
      } else if (args.invoice) {
        const q = args.invoice.trim().toUpperCase()
        rows = rows.filter((i) => i.invoice.toUpperCase() === q || i.invoice.toUpperCase().includes(q))
        if (!rows.length) throw new ApiError(`Invoice ${args.invoice} not found`, 'NotFound', 404)
      } else if (args.customer) rows = rows.filter((i) => i.customer === args.customer)
      else if (args.q) {
        const hits = (await mockApi.customers.search(args.q, 5)).map((c) => c.name)
        rows = rows.filter((i) => i.customer && hits.includes(i.customer))
      } else throw new ApiError('Pass invoice, token or customer', 'ValidationError', 417)
      return { invoices: rows.slice(-(args.limit || 10)).reverse().map(returnableFor) }
    },
    async return_items(req: ReturnRequest): Promise<ReturnResult> {
      await guard()
      if (!['card', 'cash', 'store_credit'].includes(req.refund_method)) throw new ApiError('refund_method must be card, cash or store_credit', 'ValidationError', 417)
      const src = state.invoices.find((i) => i.invoice === req.invoice)
      if (!src) throw new ApiError(`Invoice ${req.invoice} not found`, 'NotFound', 404)
      const info = returnableFor(src)
      const { lines, totals } = selectReturnLines(info, req.lines)
      gateManager(info, totals.total, req)
      if (req.refund_method === 'card' && !src.terminal_ref) throw new ApiError(`${src.invoice} was not paid by card on this terminal; refund in cash or as store credit`, 'ValidationError', 417)
      const cn = createCreditNote(src, info, lines, totals)
      cn.refund_method = req.refund_method === 'card' ? 'Card' : req.refund_method === 'cash' ? 'Cash' : 'Store Credit'
      if (req.refund_method !== 'store_credit') cn.payments.push({ mode_of_payment: cn.refund_method, amount: -totals.total })
      if (req.refund_method === 'card') cn.refund_id = `re_sim_${cn.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`
      save()
      return creditNoteResult(cn, src, req.manager)
    },
    async exchange(req: ExchangeRequest): Promise<ExchangeResult> {
      await guard()
      const src = state.invoices.find((i) => i.invoice === req.invoice)
      if (!src) throw new ApiError(`Invoice ${req.invoice} not found`, 'NotFound', 404)
      if (!req.new_items?.length) throw new ApiError('An exchange needs at least one new item', 'ValidationError', 417)
      const info = returnableFor(src)
      const { lines, totals } = selectReturnLines(info, req.lines)
      gateManager(info, totals.total, req, 'exchange')
      const newTotals = computeTotals(
        req.new_items.map((l) => {
          const item = ITEMS.find((i) => i.item_code === l.item_code)
          if (!item) throw new ApiError(`Item ${l.item_code} not found`, 'ValidationError', 417)
          return { qty: l.qty, rate: l.rate, discount_amount: l.discount_amount || 0, taxable: item.maison_taxable === 1 }
        }),
        TAXES.reduce((s, t) => s + t.rate, 0)
      )
      const x = computeExchange(totals.total, newTotals.grand_total)
      const paid = (req.payments || []).reduce((s, p) => s + p.amount, 0)
      if (x.to_collect > 0 && paid + 0.005 < x.to_collect) throw new ApiError(`Payments (${paid.toFixed(2)}) do not cover the exchange difference (${x.to_collect.toFixed(2)})`, 'ValidationError', 417)
      const payments = [...(x.applied > 0 ? [{ mode_of_payment: 'Exchange Credit' as 'Cash', amount: x.applied }] : []), ...(x.to_collect > 0 ? req.payments || [] : [])]
      const res = processInvoice({
        offline_uuid: req.offline_uuid || `xchg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        boutique: src.boutique,
        associate: src.associate,
        device_id: req.device_id || 'mock',
        customer: req.customer || src.customer,
        posting_datetime: new Date().toISOString(),
        items: req.new_items,
        payments,
        notes: `Exchange against ${src.invoice}`
      })
      if (res.status !== 'ok') throw new ApiError(res.error || 'Exchange failed', res.error_code || 'ValidationError', 417)
      const cn = createCreditNote(src, info, lines, totals)
      cn.exchange_invoice = res.invoice_name
      if (x.applied > 0) cn.payments.push({ mode_of_payment: 'Exchange Credit', amount: -x.applied })
      cn.refund_method = 'Exchange'
      const method = req.refund_method || 'cash'
      if (x.to_refund > 0 && method !== 'store_credit') {
        cn.refund_method = method === 'card' ? 'Card' : 'Cash'
        cn.payments.push({ mode_of_payment: cn.refund_method, amount: -x.to_refund })
        if (method === 'card') cn.refund_id = `re_sim_${cn.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`
      }
      const newInv = state.invoices.find((i) => i.invoice === res.invoice_name)!
      save()
      return {
        ...creditNoteResult(cn, src, req.manager),
        new_invoice: res.invoice_name!,
        new_grand_total: x.new_total,
        credit: x.credit,
        applied: x.applied,
        difference: x.difference,
        refund_remainder: x.to_refund,
        new_receipt_token: res.receipt_token,
        new_receipt: state.receipts[res.receipt_token!] as unknown as Record<string, unknown>,
        new_payments: payments.map((p) => ({ mode_of_payment: p.mode_of_payment, amount: p.amount })),
        simulated_refund: true,
        ...(newInv ? {} : {})
      }
    },
    async policy() {
      await guard()
      return { ...RETURNS_POLICY, reasons: ['Change of mind', 'Defect', 'Sizing', 'Gift return', 'Other'], conditions: ['Sellable', 'Damaged'], refund_methods: ['card', 'cash', 'store_credit', 'exchange'], stripe_configured: false } as const
    },
    async recent(boutique, limit = 20) {
      await guard()
      return {
        boutique,
        returns: state.returns
          .filter((r) => r.boutique === boutique)
          .slice(-limit)
          .reverse()
          .map((r) => ({ name: r.name, posting_date: r.posting_datetime.slice(0, 10), posting_time: r.posting_datetime.slice(11, 19), return_against: r.return_against, customer_name: r.customer_name, grand_total: r.grand_total, maison_refund_method: r.refund_method, maison_return_reason: r.lines[0]?.reason, maison_exchange_invoice: r.exchange_invoice, maison_receipt_token: r.receipt_token }))
      }
    }
  },
  // ---- v0.4 D inventory ----
  inventory: {
    async alerts(boutique, status = 'open') {
      await guard()
      ensureDemoAlerts()
      const boutiques = boutique ? [boutique] : BOUTIQUES.map((b) => b.name)
      const rows = state.alerts.filter((a) => boutiques.includes(a.boutique) && (status === 'all' || (status === 'open' ? a.status !== 'Resolved' : a.status === status)))
      const counts: Record<string, number> = {}
      for (const a of state.alerts) if (a.status !== 'Resolved') counts[a.boutique] = (counts[a.boutique] || 0) + 1
      return { boutiques, alerts: rows.map((a) => ({ ...a })), open: rows.filter((a) => a.status !== 'Resolved').length, counts }
    },
    async acknowledge(alert) {
      await guard()
      const a = state.alerts.find((x) => x.name === alert)
      if (!a) throw new ApiError(`Alert ${alert} not found`, 'NotFound', 404)
      if (a.status === 'Open') Object.assign(a, { status: 'Acknowledged', acknowledged_at: new Date().toISOString(), acknowledged_by: 'mock' })
      save()
      return { name: a.name, status: a.status }
    },
    async resolve(alert) {
      await guard()
      const a = state.alerts.find((x) => x.name === alert)
      if (!a) throw new ApiError(`Alert ${alert} not found`, 'NotFound', 404)
      Object.assign(a, { status: 'Resolved', resolved_at: new Date().toISOString() })
      save()
      return { name: a.name, status: a.status }
    },
    async request_transfer(args) {
      await guard()
      if (!(args.qty > 0)) throw new ApiError('Quantity must be positive', 'ValidationError', 417)
      const to = BOUTIQUES.find((b) => b.name === args.to)
      if (!to) throw new ApiError(`Boutique ${args.to} not found`, 'NotFound', 404)
      const from = args.from_warehouse ? BOUTIQUES.find((b) => b.name === args.from_warehouse)?.warehouse || args.from_warehouse : null
      const name = `MAT-MR-${String(state.seq++).padStart(5, '0')}`
      const alert = args.alert ? state.alerts.find((a) => a.name === args.alert) : undefined
      if (alert) alert.material_request = name
      save()
      return { material_request: name, status: 'Draft', item: args.item, qty: args.qty, to_warehouse: to.warehouse, from_warehouse: from }
    },
    async cycle_count_expected(boutique) {
      await guard()
      const b = boutique || BOUTIQUES[0].name
      const ser = serials(b)
      const stk = stock(b)
      const serialsOut: Record<string, string[]> = {}
      for (const [code, list] of Object.entries(ser)) if (list.length) serialsOut[code] = [...list]
      const qty: Record<string, number> = {}
      for (const [code, n] of Object.entries(stk)) if (n > 0 && !serialsOut[code]) qty[code] = n
      const items = Object.fromEntries(ITEMS.map((i) => [i.item_code, i.item_name]))
      return { boutique: b, warehouse: BOUTIQUES.find((x) => x.name === b)!.warehouse, serials: serialsOut, qty, items, as_of: new Date().toISOString() }
    },
    async submit_cycle_count(args): Promise<CycleCountResult> {
      await guard()
      const exp = await mockApi.inventory.cycle_count_expected(args.boutique)
      const cmp = compareCount(exp, args.serials, args.qty)
      const known = new Set(Object.values(serials(args.boutique)).flat())
      const name = `MCC-${String(state.seq++).padStart(5, '0')}`
      return {
        cycle_count: name,
        warehouse: exp.warehouse,
        expected_serials: cmp.expected_serials,
        scanned_serials: args.serials.length,
        missing: cmp.missing,
        unexpected: cmp.unexpected.map((s) => ({ serial_no: s, item_code: null, warehouse: null, status: known.has(s) ? 'other_warehouse' : 'not_found' })),
        qty_differences: cmp.qty_differences,
        stock_reconciliation: cmp.qty_differences.length ? `MAT-RECO-${String(state.seq++).padStart(5, '0')}` : null,
        clean: cmp.clean
      }
    }
  },
  async verifyPin(associate, pin) {
    await guard()
    const a = ASSOCIATES.find((x) => x.name === associate)
    if (!a) throw new ApiError('Associate not found', 'NOT_FOUND', 404)
    const ok = a.pin_hash === (await sha256Hex(pin))
    return { ok, associate: a.name, full_name: a.full_name, boutique: a.boutique, role: a.role }
  }
}

// ---- v0.3 recognition helpers ----
function activeTemplates(): MockTemplate[] {
  const active = new Set(state.consents.filter((c) => c.status === 'Active').map((c) => c.customer))
  return state.templates.filter((t) => active.has(t.customer))
}

function logEvent(e: Omit<MockEvent, 'ts'>) {
  state.events.push({ ...e, ts: new Date().toISOString() })
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500)
}

/** Same resolution order as the backend: explicit customer → phone digits → email → create. */
function findOrCreateCustomer(args: { customer?: string; phone?: string; email?: string; name?: string }): Customer {
  if (args.customer) {
    const c = state.customers.find((x) => x.name === args.customer)
    if (!c) throw new ApiError(`Customer ${args.customer} not found`, 'NotFound', 404)
    return c
  }
  const digits = (args.phone || '').replace(/\D/g, '')
  const email = (args.email || '').trim().toLowerCase()
  if (!digits && !email) throw new ApiError('Phone or email is required', 'ValidationError', 417)
  const found = state.customers.find(
    (x) => (digits.length >= 7 && (x.mobile_no || '').replace(/\D/g, '').endsWith(digits.slice(-10))) || (email && (x.email_id || '').toLowerCase() === email)
  )
  if (found) {
    if (args.name?.trim() && !found.customer_name) found.customer_name = args.name.trim()
    return found
  }
  const idx = state.customers.length + 1
  const c: Customer = {
    name: `CUST-${String(idx).padStart(4, '0')}`,
    customer_name: args.name?.trim() || (email ? email.split('@')[0] : `Client ${digits.slice(-4)}`),
    mobile_no: args.phone?.trim() || undefined,
    email_id: email || undefined,
    loyalty_points: 0,
    tier: 'Member',
    client_number: clientNumberFor(idx - 1),
    maison_face_consent: 0
  }
  state.customers.unshift(c)
  return c
}

/** Test hook: inspect / seed the mock "server" (enrolment e2e, screenshots). */
export const __mockRecognition = {
  templates: () => state.templates.map((t) => ({ ...t })),
  consents: () => state.consents.map((c) => ({ ...c })),
  events: () => state.events.map((e) => ({ ...e })),
  customers: () => state.customers.map((c) => ({ ...c })),
  /** Seed consented templates directly (as if enrolled elsewhere). */
  setTemplates(list: { customer: string; embedding: number[]; model?: string }[]) {
    const now = new Date().toISOString()
    state.templates = state.templates.filter((t) => !list.some((l) => l.customer === t.customer))
    for (const l of list) {
      if (!state.consents.some((c) => c.customer === l.customer && c.status === 'Active'))
        state.consents.push({ name: `MBC-T-${l.customer}`, customer: l.customer, status: 'Active', consent_text_version: RECOGNITION_SETTINGS.consent_text_version, method: 'Hold-to-agree', boutique: 'CHI-OAK', device_id: 'test', captured_at: now, has_signature: false })
      const i = state.templates.filter((t) => t.customer === l.customer).length
      state.templates.push({ name: `MFT-${l.customer}-${i}`, customer: l.customer, embedding: [...l.embedding], model: l.model || RECOGNITION_MODEL, dims: l.embedding.length, quality: 1, captured_at: now, boutique: 'CHI-OAK', device_id: 'test', consent: `MBC-T-${l.customer}` })
      const c = state.customers.find((x) => x.name === l.customer)
      if (c) {
        c.maison_face_consent = 1
        c.maison_face_consent_at = now
        c.face_templates = i + 1
      }
    }
    save()
  }
}

function processInvoice(inv: POSInvoice): SubmitResult {
  const prior = state.submitted.get(inv.offline_uuid)
  if (prior) return { ...prior, status: prior.status === 'ok' ? 'duplicate' : prior.status }

  if (!inv.items?.length) return fail(inv, 'Invoice has no items', 'ValidationError')
  if (!BOUTIQUES.some((b) => b.name === inv.boutique)) return fail(inv, `Unknown boutique ${inv.boutique}`, 'ValidationError')

  const ser = serials(inv.boutique)
  const stk = stock(inv.boutique)
  for (const line of inv.items) {
    const item = ITEMS.find((i) => i.item_code === line.item_code)
    if (!item) return fail(inv, `Item ${line.item_code} not found`, 'ValidationError')
    if (item.has_serial_no) {
      if (!line.serial_no) return fail(inv, `${item.item_name}: serial number required`, 'SerialRequired')
      if (!ser[line.item_code]?.includes(line.serial_no))
        return fail(inv, `${item.item_name}: serial ${line.serial_no} is no longer available`, 'SerialConflict')
    } else if ((stk[line.item_code] ?? 0) < line.qty) {
      return fail(inv, `${item.item_name}: insufficient stock`, 'StockShort')
    }
  }

  // Server-side recompute of totals.
  const totals = computeTotals(
    inv.items.map((l) => {
      const item = ITEMS.find((i) => i.item_code === l.item_code)!
      return { qty: l.qty, rate: l.rate, discount_amount: l.discount_amount || 0, taxable: item.maison_taxable === 1 }
    }),
    TAXES.reduce((s, t) => s + t.rate, 0),
    inv.loyalty_points_redeemed || 0,
    LOYALTY.conversion_factor
  )
  const paid = inv.payments.reduce((s, p) => s + p.amount, 0)
  // v0.4 G — a web order's online payment is an advance: only the balance is tendered at the counter
  const advance = inv.sales_order ? __mockWebOrderPrepaid(inv.sales_order) : 0
  // --- v0.8 POS D1 / D3 / D11 — mirror the server's tender rules exactly ---
  // D11: a cash row carries what was *tendered*, so paying over is normal and the drawer gives
  // change back; only a card may not exceed the total. D3: a $0.00 comp has nothing to tender.
  // D1: a gap no larger than one cent is a rounding difference, booked rather than refused.
  const due = round(totals.grand_total - advance)
  const nonCash = inv.payments.filter((p) => p.mode_of_payment !== 'Cash').reduce((s, p) => s + p.amount, 0)
  if (paid + 0.005 < due && round(due - paid) > 0.01)
    return fail(inv, `Payments ${paid.toFixed(2)} do not cover the invoice total ${due.toFixed(2)}`, 'PaymentMismatch')
  if (nonCash - 0.005 > due && round(nonCash - due) > 0.01)
    return fail(inv, 'Card payments exceed the invoice total', 'PaymentMismatch')
  const change = round(Math.max(0, paid - due))
  // --- end v0.8 POS D1 / D3 / D11 ---

  // Commit stock + serials
  for (const line of inv.items) {
    const item = ITEMS.find((i) => i.item_code === line.item_code)!
    if (item.has_serial_no) ser[line.item_code] = ser[line.item_code].filter((s) => s !== line.serial_no)
    stk[line.item_code] = (stk[line.item_code] ?? 0) - line.qty
  }
  const invoice_name = `SINV-${inv.boutique}-${String(state.seq++).padStart(5, '0')}`
  if (inv.sales_order) __mockCollectWebOrder(inv.sales_order, invoice_name) // v0.4 G
  state.invoices.push({
    invoice: invoice_name,
    offline_uuid: inv.offline_uuid,
    posting_datetime: inv.posting_datetime,
    associate: inv.associate,
    customer: inv.customer,
    net_total: totals.net_total,
    total_taxes: totals.total_taxes,
    grand_total: totals.grand_total,
    // v0.8 POS D11 — the drawer keeps the tender minus the change handed back
    cash: round(inv.payments.filter((p) => p.mode_of_payment === 'Cash').reduce((s, p) => s + p.amount, 0) - change),
    card: inv.payments.filter((p) => p.mode_of_payment === 'Card').reduce((s, p) => s + p.amount, 0),
    // v0.8 POS D7 — the terminal result is kept on the invoice, so Returns can name the card
    card_brand: inv.payments.find((p) => p.card_brand)?.card_brand,
    card_last4: inv.payments.find((p) => p.last4)?.last4,
    approval_code: inv.payments.find((p) => p.approval_code)?.approval_code,
    change_amount: change,
    tendered: round(inv.payments.filter((p) => p.mode_of_payment === 'Cash').reduce((s, p) => s + p.amount, 0)),
    items: inv.items.reduce((s, l) => s + l.qty, 0),
    boutique: inv.boutique,
    item_codes: inv.items.map((l) => l.item_code),
    lines: inv.items.map((l) => ({ ...l })),
    receipt_token: receiptToken(inv.offline_uuid),
    terminal_ref: inv.payments.find((p) => p.stripe_payment_intent)?.stripe_payment_intent,
    tax_rate: TAXES.reduce((s, t) => s + t.rate, 0)
  })
  if (inv.customer) {
    const c = state.customers.find((x) => x.name === inv.customer)
    if (c) {
      c.loyalty_points = c.loyalty_points - (inv.loyalty_points_redeemed || 0) + Math.floor(totals.net_total * LOYALTY.collection_factor)
      c.last_visit = inv.posting_datetime
      c.last_boutique = inv.boutique
    }
    const h = state.history.get(inv.customer) || []
    h.unshift({
      invoice: invoice_name,
      date: inv.posting_datetime,
      boutique: inv.boutique,
      items: inv.items.map((l) => ITEMS.find((i) => i.item_code === l.item_code)?.item_name || l.item_code),
      grand_total: totals.grand_total
    })
    state.history.set(inv.customer, h)
  }
  const receipt_token = receiptToken(inv.offline_uuid)
  state.receipts[receipt_token] = {
    token: receipt_token,
    invoice: invoice_name,
    boutique: inv.boutique,
    boutique_name: BOUTIQUES.find((b) => b.name === inv.boutique)?.boutique_name || inv.boutique,
    posting_datetime: inv.posting_datetime,
    lines: inv.items.map((l) => ({
      item_name: ITEMS.find((i) => i.item_code === l.item_code)?.item_name || l.item_code,
      qty: l.qty,
      rate: l.rate,
      amount: l.qty * l.rate - (l.discount_amount || 0),
      serial_no: l.serial_no
    })),
    net_total: totals.net_total,
    total_taxes: totals.total_taxes,
    grand_total: totals.grand_total,
    currency: 'USD',
    payments: inv.payments.map((p) => ({ mode_of_payment: p.mode_of_payment, amount: p.amount }))
  }
  const res: SubmitResult = { offline_uuid: inv.offline_uuid, status: 'ok', invoice_name, receipt_token }
  state.submitted.set(inv.offline_uuid, res)
  return res
}

/** 16-char urlsafe token, deterministic per offline_uuid in the mock (server: secrets.token_urlsafe). */
function receiptToken(uuid: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let h = 2166136261
  let out = ''
  for (let i = 0; i < 16; i++) {
    for (const ch of uuid + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
    out += alphabet[h % 64]
  }
  return out
}

function blobToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new ApiError('Could not read file', 'ValidationError', 417))
    fr.readAsDataURL(file)
  })
}

function fail(inv: POSInvoice, error: string, error_code: string): SubmitResult {
  return { offline_uuid: inv.offline_uuid, status: 'error', error, error_code }
}

/** Test helper: reset mock state. */
export function __resetMock() {
  state.customers = CUSTOMERS.map((c) => ({ ...c }))
  state.serials.clear()
  state.stock.clear()
  state.submitted.clear()
  state.invoices = []
  state.history.clear()
  state.seq = 1
  state.images = {}
  state.receipts = {}
  state.templates = []
  state.consents = []
  state.events = []
  state.returns = []
  state.alerts = []
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}

/* ---------- v0.4 H: affinity mock ---------- */

/** Co-purchase table over the mock catalogue: trigger prefix -> [companion, lift, confidence]. */
const AFFINITY: [string, string, number, number][] = [
  ['RG-SOL', 'RG-ETE-004', 3.4, 0.52],
  ['RG-HAL', 'RG-ETE-004', 3.1, 0.48],
  ['RG-', 'AC-CLN-036', 1.6, 0.21],
  ['WT-', 'AC-STR-037', 4.2, 0.38],
  ['WT-', 'AC-WND-038', 2.7, 0.17],
  ['NK-CHN', 'NK-PND-010', 3.8, 0.45],
  ['NK-', 'ER-STD-020', 1.9, 0.19],
  ['ER-STD', 'NK-PND-010', 2.2, 0.24],
  ['ER-', 'AC-BOX-035', 1.5, 0.14],
  ['BR-TEN', 'ER-STD-021', 2.4, 0.22],
  ['BR-', 'AC-CLN-036', 1.4, 0.16],
  ['HJ-', 'SV-APP-040', 5.1, 0.62],
  ['HJ-', 'AC-BOX-035', 2.9, 0.35],
  ['AC-GFT', 'ER-PRL-024', 1.7, 0.18]
]
const BESTSELLERS = ['ER-STD-020', 'NK-PND-010', 'RG-ETE-004', 'BR-BNG-016', 'AC-STR-037', 'ER-HUG-025', 'NK-CHN-012', 'AC-BOX-035']

function mockOwnedItems(customer: string): Set<string> {
  const owned = new Set<string>()
  for (const inv of state.invoices) if (inv.customer === customer) for (const c of inv.item_codes) owned.add(c)
  const cust = state.customers.find((c) => c.name === customer)
  if (cust?.last_visit) owned.add(ITEMS[parseInt(cust.name.slice(-4)) % ITEMS.length]!.item_code) // the seeded history row
  return owned
}

function mockRecommend(context: string[], exclude: Set<string>, n: number, boutique?: string): Recommendation[] {
  const scores = new Map<string, { score: number; lift: number; confidence: number; because: string }>()
  for (const ctx of context) {
    for (const [prefix, companion, lift, confidence] of AFFINITY) {
      if (!ctx.startsWith(prefix) || exclude.has(companion) || context.includes(companion)) continue
      const cur = scores.get(companion)
      if (!cur) scores.set(companion, { score: lift, lift, confidence, because: ctx })
      else {
        cur.score += lift
        if (lift > cur.lift) Object.assign(cur, { lift, confidence, because: ctx })
      }
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).map(([code, r]) => ({ code, ...r }))
  for (const code of BESTSELLERS) {
    if (ranked.length >= n) break
    if (exclude.has(code) || context.includes(code) || ranked.some((r) => r.code === code)) continue
    ranked.push({ code, score: 0.3, lift: 0, confidence: 0, because: '' })
  }
  const stock = boutique ? stockFor(boutique) : null
  return ranked.slice(0, n).flatMap((r) => {
    const it = ITEMS.find((i) => i.item_code === r.code)
    if (!it) return []
    const because = r.because ? ITEMS.find((i) => i.item_code === r.because) : undefined
    return [
      {
        item_code: it.item_code,
        item_name: it.item_name,
        item_group: it.item_group,
        department: it.maison_department,
        metal: it.maison_metal,
        image: it.image ?? null,
        has_serial_no: it.has_serial_no,
        is_stock_item: it.is_stock_item ?? 1,
        rate: PRICES[it.item_code] ?? 0,
        score: Math.round(r.score * 1000) / 1000,
        lift: r.lift,
        confidence: r.confidence,
        because: r.because || null,
        because_name: because?.item_name ?? null,
        reason: because ? `Bought with ${because.item_name} in ${Math.round(r.confidence * 100)}% of baskets` : 'Bestseller',
        in_stock: stock ? (stock[it.item_code] ?? 0) > 0 : null
      } satisfies Recommendation
    ]
  })
}

// ---- v0.4 A/D/E mock helpers ----
function readersFor(boutique: string) {
  const slug = boutique.toLowerCase().replace(/-/g, '')
  return [
    { name: `${slug}-r1`, label: 'Counter 1 · V660p', stripe_reader_id: `tmr_sim_${slug}_1`, device_type: 'verifone_v660p' as const, has_printer: 1 as const, enabled: 1 as const, serial_number: `SIM-${boutique}-01` },
    { name: `${slug}-r2`, label: 'Roaming · S710', stripe_reader_id: `tmr_sim_${slug}_2`, device_type: 'stripe_s710' as const, has_printer: 0 as const, enabled: 1 as const, serial_number: `SIM-${boutique}-02` }
  ]
}

const IS_TEST = typeof process !== 'undefined' && !!(process as unknown as { env?: Record<string, string> }).env?.VITEST

/** Two sales from "yesterday" per boutique so the Returns screen has something to find in mock mode. */
function ensureDemoHistory(boutique: string) {
  if (IS_TEST || state.invoices.some((i) => i.boutique === boutique)) return
  const yesterday = new Date(Date.now() - 86400000)
  yesterday.setHours(15, 20, 0, 0)
  const assoc = ASSOCIATES.find((a) => a.boutique === boutique && a.role === 'Associate')?.name || 'MA-0002'
  const cust = state.customers[2]
  const ser = serials(boutique)
  const watch = ITEMS.find((i) => i.has_serial_no && ser[i.item_code]?.length)
  const accessories = ITEMS.filter((i) => !i.has_serial_no && (stock(boutique)[i.item_code] ?? 0) > 3).slice(0, 2)
  const taxRate = TAXES.reduce((s, t) => s + t.rate, 0)
  const mk = (items: POSInvoiceItem[], card: boolean, uuid: string) => {
    const t = computeTotals(items.map((l) => ({ qty: l.qty, rate: l.rate, taxable: true })), taxRate)
    processInvoice({ offline_uuid: uuid, boutique, associate: assoc, device_id: 'demo', customer: cust?.name, posting_datetime: yesterday.toISOString(), items, payments: [{ mode_of_payment: card ? 'Card' : 'Cash', amount: t.grand_total, stripe_payment_intent: card ? `pi_sim_demo_${uuid}` : undefined }] })
  }
  if (watch) mk([{ item_code: watch.item_code, qty: 1, rate: PRICES[watch.item_code], serial_no: ser[watch.item_code][0] }], true, `demo-${boutique}-1`)
  if (accessories.length) mk(accessories.map((a, i) => ({ item_code: a.item_code, qty: i === 0 ? 2 : 1, rate: PRICES[a.item_code] })), false, `demo-${boutique}-2`)
  save()
}

function ensureDemoAlerts() {
  if (state.alerts.length) return
  let n = 1
  for (const b of BOUTIQUES) {
    const stk = stock(b.name)
    const low = ITEMS.filter((i) => !i.has_serial_no && (stk[i.item_code] ?? 0) > 0)
      .sort((a, c) => (stk[a.item_code] ?? 0) - (stk[c.item_code] ?? 0))
      .slice(0, 2)
    for (const it of low) {
      const qty = stk[it.item_code] ?? 0
      state.alerts.push({ name: `MSA-${String(n++).padStart(5, '0')}`, item_code: it.item_code, item_name: it.item_name, warehouse: b.warehouse, boutique: b.name, status: 'Open', qty, reorder_level: qty + 3, reorder_qty: 6, first_seen: new Date(Date.now() - 3600000 * 5).toISOString(), last_seen: new Date().toISOString() })
    }
  }
  save()
}

function returnableFor(src: (typeof state.invoices)[number]): ReturnableInvoice {
  const lines: POSInvoiceItem[] = src.lines || src.item_codes.map((c) => ({ item_code: c, qty: 1, rate: PRICES[c] }))
  const returnedFor = (row: string) => state.returns.filter((r) => r.return_against === src.invoice).flatMap((r) => r.lines.filter((l) => l.row === row))
  const days = Math.max(0, Math.floor((Date.now() - new Date(src.posting_datetime).getTime()) / 86400000))
  const out: ReturnableInvoice = {
    name: src.invoice,
    posting_date: src.posting_datetime.slice(0, 10),
    posting_datetime: src.posting_datetime,
    boutique: src.boutique,
    associate: src.associate,
    customer: src.customer,
    customer_name: state.customers.find((c) => c.name === src.customer)?.customer_name,
    currency: 'USD',
    net_total: src.net_total,
    total_taxes: src.total_taxes,
    tax_rate: src.tax_rate ?? TAXES.reduce((s, t) => s + t.rate, 0),
    grand_total: src.grand_total,
    loyalty_amount: 0,
    payments: [...(src.cash ? [{ mode_of_payment: 'Cash', amount: src.cash }] : []), ...(src.card ? [{ mode_of_payment: 'Card', amount: src.card }] : [])],
    terminal_ref: src.terminal_ref || null,
    // v0.8 POS D7 — what the terminal actually returned, not a hard-coded guess
    card_brand: src.card ? src.card_brand || 'Visa' : null,
    card_last4: src.card ? src.card_last4 || '4242' : null,
    receipt_token: src.receipt_token,
    days_since: days,
    within_return_window: days <= RETURNS_POLICY.return_window_days,
    within_exchange_window: days <= RETURNS_POLICY.exchange_window_days,
    return_window_days: RETURNS_POLICY.return_window_days,
    exchange_window_days: RETURNS_POLICY.exchange_window_days,
    manager_threshold: RETURNS_POLICY.returns_manager_threshold,
    credit_notes: state.returns.filter((r) => r.return_against === src.invoice).map((r) => r.name),
    fully_returned: false,
    lines: lines.map((l, i) => {
      const row = `${src.invoice}-${i + 1}`
      const item = ITEMS.find((x) => x.item_code === l.item_code)
      const sold = l.serial_no ? [l.serial_no] : []
      const ret = returnedFor(row)
      const returned_qty = ret.reduce((s, r) => s + r.qty, 0)
      const returned_serials = ret.flatMap((r) => r.serials)
      return {
        row,
        item_code: l.item_code,
        item_name: item?.item_name || l.item_code,
        qty: l.qty,
        rate: l.rate,
        amount: l.qty * l.rate - (l.discount_amount || 0),
        discount_amount: l.discount_amount || 0,
        serials: sold,
        returned_qty,
        returned_serials,
        returnable_qty: Math.max(0, l.qty - returned_qty),
        returnable_serials: sold.filter((s) => !returned_serials.includes(s)),
        taxable: (item?.maison_taxable ?? 1) as 0 | 1,
        is_stock_item: (item?.is_stock_item ?? 1) as 0 | 1
      }
    })
  }
  out.fully_returned = out.lines.every((l) => l.returnable_qty <= 0)
  return out
}

function selectReturnLines(info: ReturnableInvoice, req: ReturnRequest['lines']) {
  if (!req?.length) throw new ApiError('Select at least one line to return', 'ValidationError', 417)
  const lines = req.map((r) => {
    const src = (r.row && info.lines.find((l) => l.row === r.row)) || info.lines.find((l) => l.item_code === r.item_code && l.returnable_qty > 0)
    if (!src) throw new ApiError(`${r.item_code}: nothing left to return on ${info.name}`, 'NotFound', 404)
    const serials = r.serial_no ? r.serial_no.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : []
    const qty = r.qty || serials.length || 1
    if (qty > src.returnable_qty) throw new ApiError(`${r.item_code}: only ${src.returnable_qty} left to return`, 'ValidationError', 417)
    if (src.serials.length) {
      const pick = serials.length ? serials : src.returnable_serials.slice(0, qty)
      const bad = pick.filter((s) => !src.returnable_serials.includes(s))
      if (bad.length) throw new ApiError(`Serial ${bad.join(', ')} was not sold on ${info.name} (or is already returned)`, 'NotFound', 404)
      return { src, qty: pick.length, serials: pick, reason: r.reason || 'Other', condition: r.condition || 'Sellable' }
    }
    return { src, qty, serials: [], reason: r.reason || 'Other', condition: r.condition || 'Sellable' }
  })
  const totals = computeReturnTotals(lines.map((l) => ({ rate: l.src.rate, qty: l.qty, discount_amount: l.src.discount_amount, taxable: l.src.taxable })), info.tax_rate)
  return { lines, totals }
}

function gateManager(info: ReturnableInvoice, credit: number, req: { manager?: string; manager_pin?: string }, kind: 'return' | 'exchange' = 'return') {
  const gate = managerRequired({ credit, threshold: RETURNS_POLICY.returns_manager_threshold, daysSince: info.days_since, windowDays: kind === 'exchange' ? RETURNS_POLICY.exchange_window_days : RETURNS_POLICY.return_window_days })
  if (!gate.required) return
  const why = gate.reason === 'window' ? `sale is ${info.days_since} days old` : `credit ${credit.toFixed(2)} is above the manager threshold ${RETURNS_POLICY.returns_manager_threshold}`
  if (!req.manager) throw new ApiError(`Manager approval required: ${why}`, 'MANAGER_REQUIRED', 417)
  const m = ASSOCIATES.find((a) => a.name === req.manager)
  if (!m || m.role === 'Associate') throw new ApiError(`${req.manager} is not a manager`, 'MANAGER_REQUIRED', 417)
  // The real server approves implicitly when the *session user* is a manager; the mock has no
  // session, so the POS sends its unlocked manager as `manager` without a PIN. With a PIN
  // (associate flow) the check is synchronous: managers all use 1234 (see seed PIN_HASHES).
  if (req.manager_pin !== undefined && req.manager_pin !== '1234') throw new ApiError('Manager PIN incorrect', 'MANAGER_REQUIRED', 417)
}

function createCreditNote(src: (typeof state.invoices)[number], info: ReturnableInvoice, lines: ReturnType<typeof selectReturnLines>['lines'], totals: { net: number; tax: number; total: number }): MockCreditNote {
  const ser = serials(src.boutique)
  const stk = stock(src.boutique)
  const boutique = BOUTIQUES.find((b) => b.name === src.boutique)!
  const damaged = `${src.boutique} Damaged - MJ`
  const cn: MockCreditNote = {
    name: `CN-${src.boutique}-${String(state.seq++).padStart(5, '0')}`,
    return_against: src.invoice,
    boutique: src.boutique,
    customer: src.customer,
    customer_name: info.customer_name,
    posting_datetime: new Date().toISOString(),
    lines: lines.map((l) => ({ row: l.src.row, item_code: l.src.item_code, item_name: l.src.item_name, qty: l.qty, rate: l.src.rate, serials: l.serials, reason: l.reason, condition: l.condition, warehouse: l.condition === 'Damaged' ? damaged : boutique.warehouse })),
    net_total: -totals.net,
    total_taxes: -totals.tax,
    grand_total: -totals.total,
    refund_method: 'Cash',
    receipt_token: receiptToken(`cn-${state.seq}-${Date.now()}`),
    payments: []
  }
  for (const l of lines) {
    if (l.condition === 'Sellable') {
      if (l.serials.length) ser[l.src.item_code] = [...(ser[l.src.item_code] || []), ...l.serials]
      stk[l.src.item_code] = (stk[l.src.item_code] ?? 0) + l.qty
    }
  }
  if (src.customer) {
    const c = state.customers.find((x) => x.name === src.customer)
    if (c) c.loyalty_points = Math.max(0, c.loyalty_points - Math.floor(totals.net * LOYALTY.collection_factor))
  }
  state.returns.push(cn)
  return cn
}

function creditNoteResult(cn: MockCreditNote, src: (typeof state.invoices)[number], manager?: string): ReturnResult {
  const c = src.customer ? state.customers.find((x) => x.name === src.customer) : undefined
  return {
    credit_note: cn.name,
    return_against: cn.return_against,
    grand_total: cn.grand_total,
    net_total: cn.net_total,
    total_taxes: cn.total_taxes,
    refund_method: cn.refund_method,
    refund_id: cn.refund_id || null,
    receipt_token: cn.receipt_token,
    payments: cn.payments.map((p) => ({ ...p })),
    lines: cn.lines.map((l) => ({ item_code: l.item_code, item_name: l.item_name, qty: -l.qty, rate: l.rate, amount: -(l.qty * l.rate), serials: l.serials, warehouse: l.warehouse, reason: l.reason, condition: l.condition })),
    loyalty_points_reversed: c?.loyalty_points ?? 0,
    manager_approved_by: manager || null,
    simulated_refund: true,
    receipt: { invoice: cn.name, return_against: cn.return_against, refund_method: cn.refund_method, refund_id: cn.refund_id, store_credit: cn.refund_method === 'Store Credit' ? -cn.grand_total : 0 }
  }
}

/** Test hook: inspect the mock returns / alerts state. */
export const __mockOps = {
  invoices: () => state.invoices.map((i) => ({ ...i })),
  returns: () => state.returns.map((r) => ({ ...r })),
  alerts: () => state.alerts.map((a) => ({ ...a })),
  serials: (b: string) => JSON.parse(JSON.stringify(serials(b))) as Record<string, string[]>,
  stock: (b: string) => ({ ...stock(b) })
}
