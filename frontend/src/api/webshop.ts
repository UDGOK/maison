/**
 * v0.4 G — web orders (click & collect) for the POS "Web orders" queue (`maison_pos.api.webshop`).
 * Own module like ./v04.ts: typed client + in-memory mock; `webshopApi` picks by `VITE_MOCK`.
 */
import { ApiError, type Customer } from './types'
import { CUSTOMERS, ITEMS, PRICES } from './seed'
import { stripHtml } from '@/utils/text'

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------
export type WebOrderStatus = 'New' | 'Picking' | 'Ready' | 'Collected' | 'Cancelled'
export type WebMode = 'Buy' | 'Reserve-with-deposit'

export interface WebOrderLine {
  row: string
  item_code: string
  item_name: string
  qty: number
  rate: number
  amount: number
  image?: string | null
  available_here: number
  serials_here: string[]
  delivered_qty: number
}

export interface WebOrder {
  name: string
  boutique: string
  boutique_name?: string
  customer: string
  customer_name: string
  contact_email?: string | null
  contact_mobile?: string | null
  transaction_date: string
  creation: string
  status: WebOrderStatus
  erp_status?: string
  web_mode: WebMode
  fulfilment: string
  deposit_amount: number
  prepaid_amount: number
  net_total: number
  total_taxes: number
  grand_total: number
  rounded_total: number
  balance_due: number
  currency: string
  note?: string | null
  sales_invoice?: string | null
  receipt_token?: string | null
  collected_at?: string | null
  items: WebOrderLine[]
  /** POS-shaped customer (only on `web_order(name)`) */
  customer_doc?: Customer | null
}

export interface WebEnquiry {
  name: string
  status: 'New' | 'Contacted' | 'Closed'
  enquiry_date: string
  item_code: string
  item_name: string
  serial_no?: string | null
  customer_name: string
  email?: string | null
  phone?: string | null
  message?: string | null
  customer?: string | null
  response?: string | null
}

export interface WebOrdersResult {
  boutique: string
  orders: WebOrder[]
  enquiries: WebEnquiry[]
  counts: Record<'New' | 'Picking' | 'Ready' | 'Collected', number>
  server_time: string
}

export interface WebshopApi {
  web_orders(boutique: string, include_done?: boolean): Promise<WebOrdersResult>
  web_order(name: string): Promise<WebOrder>
  set_web_order_status(name: string, status: WebOrderStatus, note?: string): Promise<{ name: string; status: WebOrderStatus }>
  update_enquiry(name: string, status: WebEnquiry['status'], response?: string): Promise<{ name: string; status: string }>
}

// ---------------------------------------------------------------------------------------------
// Frappe client (same conventions as ./frappe.ts)
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.webshop.'

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

export const frappeWebshop: WebshopApi = {
  web_orders: (boutique, include_done = false) => call('web_orders', { boutique, include_done: include_done ? 1 : 0 }, true),
  web_order: (name) => call('web_order', { name }, true),
  set_web_order_status: (name, status, note) => call('set_web_order_status', { name, status, note }),
  update_enquiry: (name, status, response) => call('update_enquiry', { name, status, response })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1)
// ---------------------------------------------------------------------------------------------
function mockLine(code: string, qty: number, row: string): WebOrderLine {
  const item = ITEMS.find((i) => i.item_code === code)!
  const rate = PRICES[code] || 0
  return {
    row,
    item_code: code,
    item_name: item.item_name,
    qty,
    rate,
    amount: rate * qty,
    image: item.image || null,
    available_here: item.has_serial_no ? 2 : 12,
    serials_here: item.has_serial_no ? [`${code}-CHI-001`, `${code}-CHI-002`] : [],
    delivered_qty: 0
  }
}

const mockOrders: WebOrder[] = [
  {
    name: 'SAL-ORD-2026-00101',
    boutique: 'CHI-OAK',
    boutique_name: 'Maison Oak Street',
    customer: CUSTOMERS[4].name,
    customer_name: CUSTOMERS[4].customer_name,
    contact_email: CUSTOMERS[4].email_id,
    contact_mobile: CUSTOMERS[4].mobile_no,
    transaction_date: new Date().toISOString().slice(0, 10),
    creation: new Date(Date.now() - 40 * 60000).toISOString(),
    status: 'New',
    web_mode: 'Buy',
    fulfilment: 'Click & Collect',
    deposit_amount: 0,
    prepaid_amount: 2425.5,
    net_total: 2200,
    total_taxes: 225.5,
    grand_total: 2425.5,
    rounded_total: 2425.5,
    balance_due: 0,
    currency: 'USD',
    note: null,
    items: [mockLine('NK-CHN-012', 1, 'r1')]
  },
  {
    name: 'SAL-ORD-2026-00102',
    boutique: 'CHI-OAK',
    boutique_name: 'Maison Oak Street',
    customer: CUSTOMERS[5].name,
    customer_name: CUSTOMERS[5].customer_name,
    transaction_date: new Date().toISOString().slice(0, 10),
    creation: new Date(Date.now() - 3 * 3600000).toISOString(),
    status: 'Ready',
    web_mode: 'Buy',
    fulfilment: 'Click & Collect',
    deposit_amount: 0,
    prepaid_amount: 0,
    net_total: 1350,
    total_taxes: 138.38,
    grand_total: 1488.38,
    rounded_total: 1488.38,
    balance_due: 1488.38,
    currency: 'USD',
    note: 'Client asked for gift wrapping',
    items: [mockLine('RG-STK-008', 1, 'r2')]
  },
  {
    name: 'SAL-ORD-2026-00103',
    boutique: 'CHI-OAK',
    boutique_name: 'Maison Oak Street',
    customer: CUSTOMERS[12].name,
    customer_name: CUSTOMERS[12].customer_name,
    transaction_date: new Date().toISOString().slice(0, 10),
    creation: new Date(Date.now() - 26 * 3600000).toISOString(),
    status: 'New',
    web_mode: 'Reserve-with-deposit',
    fulfilment: 'Click & Collect',
    deposit_amount: 1240,
    prepaid_amount: 1240,
    net_total: 12400,
    total_taxes: 1271,
    grand_total: 13671,
    rounded_total: 13671,
    balance_due: 12431,
    currency: 'USD',
    note: 'Reserved serial RG-SOL-001-CHI-001.',
    items: [mockLine('RG-SOL-001', 1, 'r3')]
  }
]
const mockEnquiries: WebEnquiry[] = [
  {
    name: 'MWE-2026-00001',
    status: 'New',
    enquiry_date: new Date(Date.now() - 5 * 3600000).toISOString(),
    item_code: 'HJ-BRO-034',
    item_name: 'Panther Brooch',
    customer_name: 'Victoria Sterling',
    email: 'v.sterling@example.com',
    phone: '+1 646 555 0115',
    message: 'Could I see the Solstice pendant in the boutique on Saturday? Is a matching ring possible?',
    customer: CUSTOMERS[14]?.name
  }
]

const NEXT: Record<WebOrderStatus, WebOrderStatus[]> = { New: ['Picking', 'Cancelled'], Picking: ['Ready', 'Cancelled'], Ready: ['Collected', 'Picking', 'Cancelled'], Collected: [], Cancelled: [] }

export const mockWebshop: WebshopApi = {
  async web_orders(boutique, include_done = false) {
    const orders = mockOrders.filter((o) => o.boutique === boutique && (include_done || ['New', 'Picking', 'Ready'].includes(o.status)))
    const counts = { New: 0, Picking: 0, Ready: 0, Collected: 0 }
    for (const o of mockOrders) if (o.boutique === boutique && o.status in counts) counts[o.status as keyof typeof counts]++
    return { boutique, orders: orders.map((o) => ({ ...o })), enquiries: mockEnquiries.filter((e) => include_done || e.status !== 'Closed'), counts, server_time: new Date().toISOString() }
  },
  async web_order(name) {
    const o = mockOrders.find((x) => x.name === name)
    if (!o) throw new ApiError(`Web order ${name} not found`, 'NOT_FOUND', 404)
    const c = CUSTOMERS.find((x) => x.name === o.customer) || null
    return { ...o, customer_doc: c }
  },
  async set_web_order_status(name, status, note) {
    const o = mockOrders.find((x) => x.name === name)
    if (!o) throw new ApiError(`Web order ${name} not found`, 'NOT_FOUND', 404)
    if (!NEXT[o.status].includes(status)) throw new ApiError(`Cannot move a web order from ${o.status} to ${status}`, 'VALIDATION_ERROR', 417)
    o.status = status
    if (note !== undefined) o.note = note
    return { name, status }
  },
  async update_enquiry(name, status, response) {
    const e = mockEnquiries.find((x) => x.name === name)
    if (!e) throw new ApiError(`Enquiry ${name} not found`, 'NOT_FOUND', 404)
    e.status = status
    if (response !== undefined) e.response = response
    return { name, status }
  }
}

/** Mock hook for the sync layer: amount already paid online for a mock order. */
export function __mockWebOrderPrepaid(name: string): number {
  return mockOrders.find((x) => x.name === name)?.prepaid_amount || 0
}

/** Mock hook for the sync layer: a collected mock order moves to Collected. */
export function __mockCollectWebOrder(name: string, invoice: string) {
  const o = mockOrders.find((x) => x.name === name)
  if (o) {
    o.status = 'Collected'
    o.sales_invoice = invoice
    o.collected_at = new Date().toISOString()
  }
}

export const webshopApi: WebshopApi = import.meta.env.VITE_MOCK === '1' ? mockWebshop : frappeWebshop
