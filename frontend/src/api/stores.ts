/**
 * v1.4 — **Stores from the warehouse desk** (`maison_pos/api/stores_admin.py`): list, add, edit,
 * close and reopen a store. Head office / warehouse admin only.
 *
 * The pure helpers at the top (`validateStoreDraft`, `hoursToRows`, `rowsToHours`, `emptyDraft`)
 * are what the sheet reasons with; they take no network and are unit-tested on their own.
 */
import { ApiError } from './types'
import { humanizeServerMessage } from '@/utils/text'

export interface StoreRow {
  code: string
  name: string
  enabled: number
  is_warehouse: number | boolean
  company: string
  warehouse: string
  cost_center: string
  pos_profile: string
  tax_template: string | null
  tax_rate: number | null
  address_line: string | null
  city: string | null
  state: string | null
  zip: string | null
  phone: string | null
  email: string | null
  region: string | null
  timezone: string | null
  hours: Record<string, string>
  printer_ip: string | null
  printer_model: string | null
  show_product_images: number
  transit_warehouse: string | null
  damaged_warehouse: string | null
  on_hand_units?: number
  staff?: number
  open_requests?: number
}

export interface StoresList {
  stores: StoreRow[]
  count: number
  company: string | null
  abbr: string | null
  regions: string[]
  timezone: string
  template_store: string | null
  template_tax_rate: number | null
}

/** What the sheet edits. `code` is only read when creating. */
export interface StoreDraft {
  code: string
  boutique_name: string
  address_line: string
  city: string
  state: string
  zip: string
  phone: string
  email: string
  region: string
  timezone: string
  tax_rate: number | null
  hours: HoursRow[]
  show_product_images: boolean
}

export interface HoursRow {
  day: 'default' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
  hours: string
}

export const DAYS: HoursRow['day'][] = ['default', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const DAY_LABEL: Record<HoursRow['day'], string> = { default: 'Every day', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,11}$/
const HOURS_RE = /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/i

export function emptyDraft(timezone = 'America/Chicago', taxRate: number | null = null): StoreDraft {
  return {
    code: '',
    boutique_name: '',
    address_line: '',
    city: '',
    state: '',
    zip: '',
    phone: '',
    email: '',
    region: '',
    timezone,
    tax_rate: taxRate,
    hours: [{ day: 'default', hours: '10:00-21:00' }],
    show_product_images: true
  }
}

export function draftOf(row: StoreRow): StoreDraft {
  return {
    code: row.code,
    boutique_name: row.name || '',
    address_line: row.address_line || '',
    city: row.city || '',
    state: row.state || '',
    zip: row.zip || '',
    phone: row.phone || '',
    email: row.email || '',
    region: row.region || '',
    timezone: row.timezone || '',
    tax_rate: row.tax_rate,
    hours: hoursToRows(row.hours),
    show_product_images: !!row.show_product_images
  }
}

/** `{ default: "10:00-21:00", sun: "12:00-18:00" }` → editable rows, `default` first. */
export function hoursToRows(hours: Record<string, string> | null | undefined): HoursRow[] {
  const h = hours || {}
  const rows: HoursRow[] = []
  for (const day of DAYS) if (h[day]) rows.push({ day, hours: String(h[day]) })
  return rows.length ? rows : [{ day: 'default', hours: '' }]
}

export function rowsToHours(rows: HoursRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const v = (r.hours || '').trim()
    if (v) out[r.day] = v.toLowerCase() === 'closed' ? 'closed' : v
  }
  return out
}

/** The first thing wrong with the draft, in the words the sheet shows — or null when it is fine. */
export function validateStoreDraft(d: StoreDraft, creating: boolean): string | null {
  if (creating && !CODE_RE.test((d.code || '').trim().toUpperCase())) return 'The store code is 2–12 characters: letters, digits and dashes, e.g. OK-BIX.'
  if (!(d.boutique_name || '').trim()) return 'A store needs a name.'
  if (d.tax_rate !== null && d.tax_rate !== undefined && (Number.isNaN(Number(d.tax_rate)) || Number(d.tax_rate) < 0 || Number(d.tax_rate) > 30)) return 'Sales tax rate must be between 0 and 30 %.'
  const email = (d.email || '').trim()
  if (email && !email.includes('@')) return 'The store e-mail does not look like an address.'
  for (const r of d.hours) {
    const v = (r.hours || '').trim()
    if (v && v.toLowerCase() !== 'closed' && !HOURS_RE.test(v)) return `Hours for ${DAY_LABEL[r.day].toLowerCase()} must look like 10:00-21:00 or closed.`
  }
  const days = d.hours.map((r) => r.day)
  if (new Set(days).size !== days.length) return 'A day is listed twice in the opening hours.'
  return null
}

/** The payload `create_store` / `update_store` take. */
export function payloadOf(d: StoreDraft): Record<string, unknown> {
  return {
    code: (d.code || '').trim().toUpperCase(),
    boutique_name: d.boutique_name.trim(),
    address_line: d.address_line.trim(),
    city: d.city.trim(),
    state: d.state.trim().toUpperCase(),
    zip: d.zip.trim(),
    phone: d.phone.trim(),
    email: d.email.trim(),
    region: d.region.trim(),
    timezone: d.timezone.trim(),
    tax_rate: d.tax_rate === null || d.tax_rate === undefined || d.tax_rate === ('' as unknown) ? null : Number(d.tax_rate),
    hours: rowsToHours(d.hours),
    show_product_images: d.show_product_images ? 1 : 0
  }
}

export interface StoresApi {
  list(includeClosed?: boolean): Promise<StoresList>
  get(code: string): Promise<StoreRow>
  create(payload: Record<string, unknown>): Promise<{ store: StoreRow; created: Record<string, string | null> }>
  update(code: string, payload: Record<string, unknown>): Promise<{ store: StoreRow; changed: string[] }>
  close(code: string, reason?: string): Promise<{ store: StoreRow; closed: boolean; already?: boolean }>
  reopen(code: string): Promise<{ store: StoreRow; reopened: boolean }>
}

// ---------------------------------------------------------------------------------------------
// Frappe
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.stores_admin.'

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

export const frappeStores: StoresApi = {
  list: (includeClosed = true) => call('stores', { include_closed: includeClosed ? 1 : 0 }, true),
  get: (code) => call('store', { code }, true),
  create: (payload) => call('create_store', { payload }),
  update: (code, payload) => call('update_store', { code, payload }),
  close: (code, reason) => call('close_store', { code, reason }),
  reopen: (code) => call('reopen_store', { code })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests) — three stores in memory, provisioning simulated
// ---------------------------------------------------------------------------------------------
const MOCK_ABBR = 'CCZ'
const mockRows: StoreRow[] = [
  { code: 'HOU-WH', name: 'Houston Warehouse', enabled: 1, is_warehouse: 1, company: 'CloudChaserz', warehouse: `HOU-WH - ${MOCK_ABBR}`, cost_center: `HOU-WH - ${MOCK_ABBR}`, pos_profile: 'HOU-WH POS', tax_template: null, tax_rate: 8.25, address_line: '5700 Hartsdale Dr', city: 'Houston, TX 77036', state: 'TX', zip: '77036', phone: '', email: null, region: 'Houston', timezone: 'America/Chicago', hours: { default: '9:00-18:00' }, printer_ip: null, printer_model: 'TM-m30III', show_product_images: 1, transit_warehouse: null, damaged_warehouse: null, on_hand_units: 1200, staff: 1, open_requests: 0 },
  { code: 'HOU-MTR', name: 'CloudChaserz Montrose', enabled: 1, is_warehouse: 0, company: 'CloudChaserz', warehouse: `HOU-MTR - ${MOCK_ABBR}`, cost_center: `HOU-MTR - ${MOCK_ABBR}`, pos_profile: 'HOU-MTR POS', tax_template: 'TX Sales Tax (Houston)', tax_rate: 8.25, address_line: '1211 Westheimer Rd', city: 'Houston, TX 77006', state: 'TX', zip: '77006', phone: '(713) 555-0101', email: null, region: 'Houston', timezone: 'America/Chicago', hours: { default: '9:00-24:00' }, printer_ip: null, printer_model: 'TM-m30III', show_product_images: 1, transit_warehouse: `HOU-MTR In Transit - ${MOCK_ABBR}`, damaged_warehouse: `HOU-MTR Damaged - ${MOCK_ABBR}`, on_hand_units: 340, staff: 3, open_requests: 1 },
  { code: 'OK-BIX', name: 'CloudChaserz Bixby', enabled: 0, is_warehouse: 0, company: 'CloudChaserz', warehouse: `OK-BIX - ${MOCK_ABBR}`, cost_center: `OK-BIX - ${MOCK_ABBR}`, pos_profile: 'OK-BIX POS', tax_template: 'OK Sales Tax (Bixby)', tax_rate: 8.917, address_line: '8181 E 111th St', city: 'Bixby, OK 74008', state: 'OK', zip: '74008', phone: '', email: null, region: 'Tulsa Metro', timezone: 'America/Chicago', hours: { default: '10:00-21:00' }, printer_ip: null, printer_model: 'TM-m30III', show_product_images: 1, transit_warehouse: null, damaged_warehouse: null, on_hand_units: 0, staff: 0, open_requests: 0 }
]

const pause = () => new Promise((r) => setTimeout(r, 5))

function mockList(includeClosed: boolean): StoresList {
  const rows = mockRows.filter((r) => includeClosed || r.enabled).map((r) => ({ ...r, hours: { ...r.hours } }))
  return { stores: rows, count: rows.length, company: 'CloudChaserz', abbr: MOCK_ABBR, regions: ['Houston', 'Tulsa Metro'], timezone: 'America/Chicago', template_store: 'HOU-MTR', template_tax_rate: 8.25 }
}

export const mockStores: StoresApi = {
  async list(includeClosed = true) {
    await pause()
    return mockList(includeClosed)
  },
  async get(code) {
    await pause()
    const row = mockRows.find((r) => r.code === code)
    if (!row) throw new ApiError(`Store ${code} does not exist`, 'DoesNotExistError', 404)
    return { ...row, hours: { ...row.hours } }
  },
  async create(payload) {
    await pause()
    const code = String(payload.code || '').toUpperCase()
    if (!/^[A-Z0-9][A-Z0-9-]{1,11}$/.test(code)) throw new ApiError('The store code is 2–12 characters: letters, digits and dashes, e.g. OK-BIX', 'ValidationError', 417)
    if (mockRows.some((r) => r.code === code)) throw new ApiError(`Store ${code} already exists`, 'DuplicateEntryError', 409)
    const row: StoreRow = {
      code,
      name: String(payload.boutique_name || ''),
      enabled: 1,
      is_warehouse: 0,
      company: 'CloudChaserz',
      warehouse: `${code} - ${MOCK_ABBR}`,
      cost_center: `${code} - ${MOCK_ABBR}`,
      pos_profile: `${code} POS`,
      tax_template: payload.tax_rate === null || payload.tax_rate === undefined ? 'TX Sales Tax (Houston)' : `Sales Tax (${code})`,
      tax_rate: payload.tax_rate === null || payload.tax_rate === undefined ? 8.25 : Number(payload.tax_rate),
      address_line: String(payload.address_line || ''),
      city: String(payload.city || ''),
      state: String(payload.state || ''),
      zip: String(payload.zip || ''),
      phone: String(payload.phone || ''),
      email: String(payload.email || '') || null,
      region: String(payload.region || ''),
      timezone: String(payload.timezone || 'America/Chicago'),
      hours: (payload.hours as Record<string, string>) || {},
      printer_ip: null,
      printer_model: 'TM-m30III',
      show_product_images: payload.show_product_images ? 1 : 0,
      transit_warehouse: `${code} In Transit - ${MOCK_ABBR}`,
      damaged_warehouse: `${code} Damaged - ${MOCK_ABBR}`,
      on_hand_units: 0,
      staff: 0,
      open_requests: 0
    }
    mockRows.push(row)
    return { store: { ...row }, created: { warehouse: row.warehouse, cost_center: row.cost_center, pos_profile: row.pos_profile, tax_template: row.tax_template, transit_warehouse: row.transit_warehouse, damaged_warehouse: row.damaged_warehouse } }
  },
  async update(code, payload) {
    await pause()
    const row = mockRows.find((r) => r.code === code)
    if (!row) throw new ApiError(`Store ${code} does not exist`, 'DoesNotExistError', 404)
    const changed: string[] = []
    const set = (k: keyof StoreRow, v: unknown) => {
      if ((row as any)[k] !== v) {
        ;(row as any)[k] = v
        changed.push(String(k))
      }
    }
    if ('boutique_name' in payload) set('name', String(payload.boutique_name || ''))
    for (const k of ['address_line', 'city', 'state', 'zip', 'phone', 'region', 'timezone'] as const) if (k in payload) set(k, String(payload[k] || ''))
    if ('email' in payload) set('email', String(payload.email || '') || null)
    if ('hours' in payload) {
      row.hours = (payload.hours as Record<string, string>) || {}
      changed.push('hours')
    }
    if ('show_product_images' in payload) set('show_product_images', payload.show_product_images ? 1 : 0)
    if ('tax_rate' in payload && payload.tax_rate !== null && payload.tax_rate !== undefined && Number(payload.tax_rate) !== row.tax_rate) {
      row.tax_rate = Number(payload.tax_rate)
      row.tax_template = `Sales Tax (${code})`
      changed.push('tax_rate')
    }
    return { store: { ...row, hours: { ...row.hours } }, changed }
  },
  async close(code) {
    await pause()
    const row = mockRows.find((r) => r.code === code)
    if (!row) throw new ApiError(`Store ${code} does not exist`, 'DoesNotExistError', 404)
    if ((row.on_hand_units || 0) > 0) throw new ApiError(`${row.name} still holds ${row.on_hand_units} units — send them back to the warehouse before closing it`, 'ValidationError', 417)
    const already = !row.enabled
    row.enabled = 0
    return { store: { ...row }, closed: !already, already }
  },
  async reopen(code) {
    await pause()
    const row = mockRows.find((r) => r.code === code)
    if (!row) throw new ApiError(`Store ${code} does not exist`, 'DoesNotExistError', 404)
    row.enabled = 1
    return { store: { ...row }, reopened: true }
  }
}

const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const storesApi: StoresApi = IS_MOCK ? mockStores : frappeStores
