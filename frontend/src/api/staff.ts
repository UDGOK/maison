/**
 * v1.4 — **Staff from the warehouse desk** (`maison_pos/api/staff_admin.py`): the people who
 * work the chain — add, move, re-role, reset a PIN or a password, suspend, restore.
 *
 * Secrets travel one way: a generated password or PIN is in the response of the call that made
 * it, shown once by the sheet, and never held anywhere else in the app.
 */
import { ApiError } from './types'
import { humanizeServerMessage } from '@/utils/text'

export type StaffRole = 'Associate' | 'Manager' | 'Regional' | 'HeadOffice' | 'Warehouse'

export interface Person {
  user: string
  first_name: string
  last_name: string
  full_name: string
  login_enabled: number
  last_login: string | null
  last_active: string | null
  since: string
  boutique: string | null
  boutique_name: string | null
  role: StaffRole | null
  role_label: string
  till_enabled: number
  pin_set: boolean
  pin_locked: boolean
  employee: string | null
  frappe_roles: string[]
  is_owner: boolean
  editable: boolean
}

export interface StaffList {
  staff: Person[]
  count: number
  stores: { code: string; name: string; is_warehouse: number | boolean }[]
  roles: { key: StaffRole; label: string; needs_store: boolean; grantable: boolean }[]
  grantable_rank: number
}

export interface StaffDraft {
  first_name: string
  last_name: string
  email: string
  role: StaffRole
  boutique: string
  pin: string
  password: string
}

export interface Created {
  person: Person
  roles_granted: string[]
  initial_password: string | null
  pin: string | null
  password_was_supplied: boolean
  pin_was_supplied: boolean
}

const PIN_RE = /^\d{4,6}$/

export function emptyStaffDraft(boutique = ''): StaffDraft {
  return { first_name: '', last_name: '', email: '', role: 'Associate', boutique, pin: '', password: '' }
}

export function roleNeedsStore(role: StaffRole, roles: StaffList['roles']): boolean {
  return roles.find((r) => r.key === role)?.needs_store ?? true
}

/** The first thing wrong with the draft, in the words the sheet shows — or null. */
export function validateStaffDraft(d: StaffDraft, roles: StaffList['roles'], creating: boolean): string | null {
  if (!(d.first_name || '').trim()) return 'A first name is required.'
  const email = (d.email || '').trim()
  if (creating && (!email || !email.includes('@') || /\s/.test(email))) return 'A working e-mail address is the login — it is required.'
  const spec = roles.find((r) => r.key === d.role)
  if (!spec) return 'Choose a role.'
  if (!spec.grantable) return `You may not grant the ${spec.label} role.`
  if (spec.needs_store && !(d.boutique || '').trim()) return `${spec.label} needs a store.`
  if (creating && d.pin && !PIN_RE.test(d.pin.trim())) return 'PIN must be 4 to 6 digits.'
  if (creating && d.password && d.password.trim().length < 8) return 'A password you choose must be at least 8 characters — or leave it blank and one is generated.'
  return null
}

export interface StaffApi {
  list(store?: string, includeSuspended?: boolean): Promise<StaffList>
  create(payload: Record<string, unknown>): Promise<Created>
  update(user: string, payload: Record<string, unknown>): Promise<{ person: Person; changed: string[] }>
  resetPin(user: string, pin?: string): Promise<{ person: Person; pin: string | null; pin_was_supplied: boolean }>
  resetPassword(user: string): Promise<{ person: Person; initial_password: string }>
  suspend(user: string, reason?: string): Promise<{ person: Person; suspended: boolean }>
  restore(user: string): Promise<{ person: Person; restored: boolean }>
}

// ---------------------------------------------------------------------------------------------
// Frappe
// ---------------------------------------------------------------------------------------------
const BASE = '/api/method/maison_pos.api.staff_admin.'

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

export const frappeStaff: StaffApi = {
  list: (store, includeSuspended = true) => call('staff', { store, include_suspended: includeSuspended ? 1 : 0 }, true),
  create: (payload) => call('create_staff', { payload }),
  update: (user, payload) => call('update_staff', { user, payload }),
  resetPin: (user, pin) => call('reset_pin', { user, pin }),
  resetPassword: (user) => call('reset_password', { user }),
  suspend: (user, reason) => call('suspend', { user, reason }),
  restore: (user) => call('restore', { user })
}

// ---------------------------------------------------------------------------------------------
// Mock (VITE_MOCK=1 / unit tests)
// ---------------------------------------------------------------------------------------------
const ROLE_LABEL: Record<StaffRole, string> = { Associate: 'Associate', Manager: 'Store manager', Regional: 'Regional', HeadOffice: 'Head office', Warehouse: 'Warehouse admin' }
const ROLE_RANK: Record<StaffRole, number> = { Associate: 1, Manager: 2, Regional: 3, HeadOffice: 4, Warehouse: 3 }
const MOCK_GRANTABLE = 4

const mockPeople: Person[] = [
  { user: 'hq@cloudchaserz.example', first_name: 'Helene', last_name: 'Quarry', full_name: 'Helene Quarry', login_enabled: 1, last_login: '2026-08-24 08:12:00', last_active: null, since: '2026-08-01', boutique: null, boutique_name: null, role: 'HeadOffice', role_label: 'Head office', till_enabled: 1, pin_set: true, pin_locked: false, employee: null, frappe_roles: ['AWANZ Head Office', 'Sales Manager'], is_owner: false, editable: true },
  { user: 'hou.mtr.manager@cloudchaserz.example', first_name: 'Olivia', last_name: 'Hartmann', full_name: 'Olivia Hartmann', login_enabled: 1, last_login: '2026-08-24 09:40:00', last_active: null, since: '2026-08-01', boutique: 'HOU-MTR', boutique_name: 'CloudChaserz Montrose', role: 'Manager', role_label: 'Store manager', till_enabled: 1, pin_set: true, pin_locked: false, employee: null, frappe_roles: ['AWANZ Manager', 'Sales User', 'Stock User'], is_owner: false, editable: true },
  { user: 'hou.mtr.a1@cloudchaserz.example', first_name: 'Theo', last_name: 'Lindqvist', full_name: 'Theo Lindqvist', login_enabled: 0, last_login: null, last_active: null, since: '2026-08-01', boutique: 'HOU-MTR', boutique_name: 'CloudChaserz Montrose', role: 'Associate', role_label: 'Associate', till_enabled: 0, pin_set: true, pin_locked: false, employee: null, frappe_roles: ['AWANZ Associate', 'Sales User'], is_owner: false, editable: true }
]
const mockStores = [
  { code: 'HOU-WH', name: 'Houston Warehouse', is_warehouse: 1 },
  { code: 'HOU-MTR', name: 'CloudChaserz Montrose', is_warehouse: 0 },
  { code: 'OK-BIX', name: 'CloudChaserz Bixby', is_warehouse: 0 }
]
const pause = () => new Promise((r) => setTimeout(r, 5))

function mockRoles(): StaffList['roles'] {
  return (Object.keys(ROLE_LABEL) as StaffRole[]).map((k) => ({ key: k, label: ROLE_LABEL[k], needs_store: k === 'Associate' || k === 'Manager' || k === 'Warehouse', grantable: ROLE_RANK[k] <= MOCK_GRANTABLE }))
}

export const mockStaff: StaffApi = {
  async list(store, includeSuspended = true) {
    await pause()
    const staff = mockPeople.filter((p) => (!store || p.boutique === store) && (includeSuspended || p.login_enabled)).map((p) => ({ ...p }))
    return { staff, count: staff.length, stores: mockStores.map((s) => ({ ...s })), roles: mockRoles(), grantable_rank: MOCK_GRANTABLE }
  },
  async create(payload) {
    await pause()
    const email = String(payload.email || '').toLowerCase()
    if (!email.includes('@')) throw new ApiError('A working e-mail address is the login — it is required', 'ValidationError', 417)
    if (mockPeople.some((p) => p.user === email)) throw new ApiError(`${email} already has a login — edit that person instead`, 'DuplicateEntryError', 409)
    const role = (payload.role as StaffRole) || 'Associate'
    if (ROLE_RANK[role] > MOCK_GRANTABLE) throw new ApiError(`You may not grant the ${ROLE_LABEL[role]} role`, 'PermissionError', 403)
    const store = mockStores.find((s) => s.code === payload.boutique)
    const person: Person = {
      user: email,
      first_name: String(payload.first_name || ''),
      last_name: String(payload.last_name || ''),
      full_name: `${payload.first_name || ''} ${payload.last_name || ''}`.trim(),
      login_enabled: 1,
      last_login: null,
      last_active: null,
      since: '2026-08-24',
      boutique: store?.code || null,
      boutique_name: store?.name || null,
      role,
      role_label: ROLE_LABEL[role],
      till_enabled: 1,
      pin_set: true,
      pin_locked: false,
      employee: null,
      frappe_roles: [],
      is_owner: false,
      editable: true
    }
    mockPeople.push(person)
    const pinGiven = !!payload.pin
    const pwGiven = !!payload.password
    return { person: { ...person }, roles_granted: [], initial_password: pwGiven ? null : 'Temp' + Math.random().toString(36).slice(2, 10), pin: pinGiven ? null : '123456', password_was_supplied: pwGiven, pin_was_supplied: pinGiven }
  },
  async update(user, payload) {
    await pause()
    const p = mockPeople.find((x) => x.user === user)
    if (!p) throw new ApiError(`User ${user} does not exist`, 'DoesNotExistError', 404)
    const changed: string[] = []
    if ('first_name' in payload && payload.first_name !== p.first_name) {
      p.first_name = String(payload.first_name)
      changed.push('first_name')
    }
    if ('last_name' in payload && payload.last_name !== p.last_name) {
      p.last_name = String(payload.last_name)
      changed.push('last_name')
    }
    p.full_name = `${p.first_name} ${p.last_name}`.trim()
    if ('role' in payload && payload.role !== p.role) {
      p.role = payload.role as StaffRole
      p.role_label = ROLE_LABEL[p.role]
      changed.push('role')
    }
    if ('boutique' in payload && (payload.boutique || null) !== p.boutique) {
      const store = mockStores.find((s) => s.code === payload.boutique)
      p.boutique = store?.code || null
      p.boutique_name = store?.name || null
      changed.push('boutique')
    }
    return { person: { ...p }, changed }
  },
  async resetPin(user, pin) {
    await pause()
    const p = mockPeople.find((x) => x.user === user)
    if (!p) throw new ApiError(`User ${user} does not exist`, 'DoesNotExistError', 404)
    p.pin_set = true
    p.pin_locked = false
    return { person: { ...p }, pin: pin ? null : '246810', pin_was_supplied: !!pin }
  },
  async resetPassword(user) {
    await pause()
    const p = mockPeople.find((x) => x.user === user)
    if (!p) throw new ApiError(`User ${user} does not exist`, 'DoesNotExistError', 404)
    return { person: { ...p }, initial_password: 'Temp' + Math.random().toString(36).slice(2, 10) }
  },
  async suspend(user) {
    await pause()
    const p = mockPeople.find((x) => x.user === user)
    if (!p) throw new ApiError(`User ${user} does not exist`, 'DoesNotExistError', 404)
    p.login_enabled = 0
    p.till_enabled = 0
    return { person: { ...p }, suspended: true }
  },
  async restore(user) {
    await pause()
    const p = mockPeople.find((x) => x.user === user)
    if (!p) throw new ApiError(`User ${user} does not exist`, 'DoesNotExistError', 404)
    p.login_enabled = 1
    p.till_enabled = 1
    return { person: { ...p }, restored: true }
  }
}

const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const staffApi: StaffApi = IS_MOCK ? mockStaff : frappeStaff
