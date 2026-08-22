/**
 * In-memory mock of the Frappe backend. Enabled with `VITE_MOCK=1`.
 * - Simulates latency (120–400 ms).
 * - `window.__maisonOffline = true` makes every call fail with a NETWORK ApiError,
 *   exactly like a fetch() that cannot reach the bench.
 * - Tracks sold serials so duplicate/conflict errors behave like the real server.
 */
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
import { sha256Hex } from '@/utils/hash'
import { DEFAULT_DISTANCE_THRESHOLD, rankMatches } from '@/recognition/math'

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
  invoices: [] as (SalesSummaryRow & { boutique: string; item_codes: string[] })[],
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
        events: state.events
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
    face_recognition_enabled: recognitionEnabledFor(boutique)
  }
}

function recognitionEnabledFor(boutique: string): boolean {
  const o = BOUTIQUE_RECOGNITION[boutique] || 'Inherit'
  return o === 'Inherit' ? RECOGNITION_SETTINGS.face_recognition_enabled : o === 'On'
}

function bootstrapFor(boutique: string): Bootstrap {
  const b = BOUTIQUES.find((x) => x.name === boutique)
  if (!b) throw new ApiError(`Boutique ${boutique} not found`, 'NotFound', 404)
  const ser = JSON.parse(JSON.stringify(serials(boutique)))
  return {
    boutique: b,
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
    version: new Date().toISOString()
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
    }
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
  async boutiques() {
    await guard()
    return BOUTIQUES.map((b) => ({ name: b.name, boutique_name: b.boutique_name, city: b.city }))
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
  if (Math.abs(paid - totals.grand_total) > 0.01)
    return fail(inv, `Payments ${paid.toFixed(2)} do not match grand total ${totals.grand_total.toFixed(2)}`, 'PaymentMismatch')

  // Commit stock + serials
  for (const line of inv.items) {
    const item = ITEMS.find((i) => i.item_code === line.item_code)!
    if (item.has_serial_no) ser[line.item_code] = ser[line.item_code].filter((s) => s !== line.serial_no)
    stk[line.item_code] = (stk[line.item_code] ?? 0) - line.qty
  }
  const invoice_name = `SINV-${inv.boutique}-${String(state.seq++).padStart(5, '0')}`
  state.invoices.push({
    invoice: invoice_name,
    offline_uuid: inv.offline_uuid,
    posting_datetime: inv.posting_datetime,
    associate: inv.associate,
    customer: inv.customer,
    net_total: totals.net_total,
    total_taxes: totals.total_taxes,
    grand_total: totals.grand_total,
    cash: inv.payments.filter((p) => p.mode_of_payment === 'Cash').reduce((s, p) => s + p.amount, 0),
    card: inv.payments.filter((p) => p.mode_of_payment === 'Card').reduce((s, p) => s + p.amount, 0),
    items: inv.items.reduce((s, l) => s + l.qty, 0),
    boutique: inv.boutique,
    item_codes: inv.items.map((l) => l.item_code)
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
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}
