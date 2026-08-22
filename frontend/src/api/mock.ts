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
  type LiveSummary,
  type MaisonApi,
  type POSInvoice,
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
  serialsFor,
  stockFor
} from './seed'
import { computeTotals } from '@/utils/totals'
import { sha256Hex } from '@/utils/hash'

const state = {
  customers: CUSTOMERS.map((c) => ({ ...c })),
  /** per-boutique serials still available */
  serials: new Map<string, Record<string, string[]>>(),
  stock: new Map<string, Record<string, number>>(),
  submitted: new Map<string, SubmitResult>(),
  invoices: [] as (SalesSummaryRow & { boutique: string; item_codes: string[] })[],
  history: new Map<string, CustomerHistoryRow[]>(),
  seq: 1
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
        seq: state.seq
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

function bootstrapFor(boutique: string): Bootstrap {
  const b = BOUTIQUES.find((x) => x.name === boutique)
  if (!b) throw new ApiError(`Boutique ${boutique} not found`, 'NotFound', 404)
  return {
    boutique: b,
    associates: ASSOCIATES.filter((a) => a.boutique === boutique || a.role === 'HeadOffice'),
    pos_profile: b.pos_profile,
    taxes: TAXES,
    modes_of_payment: ['Cash', 'Card'],
    item_groups: ITEM_GROUPS,
    departments: DEPARTMENTS,
    items: ITEMS,
    prices: { ...PRICES },
    pricing_rules: PRICING_RULES.filter((r) => r.warehouse === b.warehouse),
    serials: JSON.parse(JSON.stringify(serials(boutique))),
    stock: { ...stock(boutique) },
    loyalty_program: LOYALTY,
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
    }
  },
  customers: {
    async search(q, limit = 20) {
      await guard()
      const s = q.trim().toLowerCase()
      const rows = state.customers.filter(
        (c) =>
          !s ||
          c.customer_name.toLowerCase().includes(s) ||
          (c.mobile_no || '').replace(/\s/g, '').includes(s.replace(/\s/g, '')) ||
          (c.email_id || '').toLowerCase().includes(s)
      )
      return rows.slice(0, limit)
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
      const name = `CUST-${String(state.customers.length + 1).padStart(4, '0')}`
      state.customers.unshift({
        name,
        customer_name: customer.customer_name,
        mobile_no: customer.mobile_no,
        email_id: customer.email_id,
        loyalty_points: 0,
        tier: 'Member'
      })
      save()
      return { name }
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
        pending_approvals: 2
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
  const res: SubmitResult = { offline_uuid: inv.offline_uuid, status: 'ok', invoice_name }
  state.submitted.set(inv.offline_uuid, res)
  return res
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
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}
