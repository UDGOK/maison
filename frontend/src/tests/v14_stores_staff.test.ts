/**
 * v1.4 — Stores and Staff from the warehouse desk: the pure helpers the two sheets reason with,
 * the mock APIs' rules (a store closes only when empty; secrets come back once), and the receipt
 * mark's raster packing.
 */
import { describe, expect, it } from 'vitest'
import { draftOf, emptyDraft, hoursToRows, mockStores, payloadOf, rowsToHours, validateStoreDraft } from '@/api/stores'
import { emptyStaffDraft, mockStaff, validateStaffDraft, type StaffList } from '@/api/staff'
import { sortStores, fmtHours } from '@/warehouse/components/stores/StoresBoard.vue'
import { groupStaff, lastSeen } from '@/warehouse/components/staff/StaffBoard.vue'
import { packRaster } from '@/printer/logo'

describe('v1.4 — store draft', () => {
  it('validates the code, the name, the tax rate and the hours in the sheet’s words', () => {
    const d = emptyDraft()
    expect(validateStoreDraft(d, true)).toMatch(/store code/)
    d.code = 'ok-bix'
    expect(validateStoreDraft(d, true)).toMatch(/needs a name/)
    d.boutique_name = 'Scents of Arabia Bixby'
    expect(validateStoreDraft(d, true)).toBeNull()
    d.tax_rate = 45
    expect(validateStoreDraft(d, true)).toMatch(/between 0 and 30/)
    d.tax_rate = 8.917
    d.hours = [{ day: 'default', hours: '10am-9pm' }]
    expect(validateStoreDraft(d, true)).toMatch(/every day must look like/)
    d.hours = [{ day: 'default', hours: '10:00-21:00' }, { day: 'default', hours: 'closed' }]
    expect(validateStoreDraft(d, true)).toMatch(/listed twice/)
    d.hours = [{ day: 'default', hours: '10:00-21:00' }, { day: 'sun', hours: 'Closed' }]
    expect(validateStoreDraft(d, true)).toBeNull()
    // editing never re-checks the code
    d.code = ''
    expect(validateStoreDraft(d, false)).toBeNull()
  })

  it('round-trips opening hours and upper-cases the code and state in the payload', () => {
    const rows = hoursToRows({ sun: '12:00-18:00', default: '10:00-21:00' })
    expect(rows.map((r) => r.day)).toEqual(['default', 'sun'])
    expect(rowsToHours([{ day: 'default', hours: '10:00-21:00' }, { day: 'sat', hours: 'CLOSED' }, { day: 'mon', hours: '' }])).toEqual({ default: '10:00-21:00', sat: 'closed' })
    const d = { ...emptyDraft(), code: 'ok-bix', boutique_name: ' Bixby ', state: 'ok', tax_rate: 8.917 }
    const p = payloadOf(d)
    expect(p.code).toBe('OK-BIX')
    expect(p.state).toBe('OK')
    expect(p.boutique_name).toBe('Bixby')
    expect(p.tax_rate).toBe(8.917)
    expect(payloadOf({ ...d, tax_rate: null }).tax_rate).toBeNull()
  })

  it('makes an editable draft of a store row', async () => {
    const list = await mockStores.list(true)
    const row = list.stores.find((s) => s.code === 'HOU-MTR')!
    const d = draftOf(row)
    expect(d.code).toBe('HOU-MTR')
    expect(d.boutique_name).toBe('CloudChaserz Montrose')
    expect(d.hours[0]).toEqual({ day: 'default', hours: '9:00-24:00' })
    expect(d.tax_rate).toBe(8.25)
  })
})

describe('v1.4 — stores board helpers and mock rules', () => {
  it('sorts the warehouse first, open stores by name, closed last', async () => {
    const list = await mockStores.list(true)
    const codes = sortStores(list.stores).map((s) => s.code)
    expect(codes[0]).toBe('HOU-WH')
    expect(codes[codes.length - 1]).toBe('OK-BIX')
  })

  it('prints hours compactly', () => {
    expect(fmtHours({ default: '10:00-21:00', sun: '12:00-18:00' })).toBe('10:00-21:00 · Sun 12:00-18:00')
    expect(fmtHours({})).toBe('—')
  })

  it('provisions a store on create, refuses a bad code and a duplicate, closes only when empty', async () => {
    await expect(mockStores.create({ code: 'x' })).rejects.toThrow(/store code/)
    const out = await mockStores.create({ code: 'ok-tul', boutique_name: 'Tulsa Hills', tax_rate: 8.517, hours: { default: '10:00-21:00' } })
    expect(out.store.code).toBe('OK-TUL')
    expect(out.created.warehouse).toMatch(/^OK-TUL - /)
    expect(out.created.transit_warehouse).toMatch(/In Transit/)
    await expect(mockStores.create({ code: 'OK-TUL', boutique_name: 'again' })).rejects.toThrow(/already exists/)
    // Montrose holds stock — closing is refused with the units named
    await expect(mockStores.close('HOU-MTR')).rejects.toThrow(/340 units/)
    const closed = await mockStores.close('OK-TUL')
    expect(closed.closed).toBe(true)
    expect(closed.store.enabled).toBe(0)
    const again = await mockStores.close('OK-TUL')
    expect(again.already).toBe(true)
    const reopened = await mockStores.reopen('OK-TUL')
    expect(reopened.store.enabled).toBe(1)
  })

  it('updates only what changed and re-templates the tax rate', async () => {
    const out = await mockStores.update('HOU-MTR', { boutique_name: 'CloudChaserz Montrose', phone: '(713) 555-0199', tax_rate: 8.5 })
    expect(out.changed).toEqual(['phone', 'tax_rate'])
    expect(out.store.tax_template).toBe('Sales Tax (HOU-MTR)')
    expect(out.store.tax_rate).toBe(8.5)
  })
})

describe('v1.4 — staff draft and mock rules', () => {
  const roles: StaffList['roles'] = [
    { key: 'Associate', label: 'Associate', needs_store: true, grantable: true },
    { key: 'Manager', label: 'Store manager', needs_store: true, grantable: true },
    { key: 'Regional', label: 'Regional', needs_store: false, grantable: false },
    { key: 'HeadOffice', label: 'Head office', needs_store: false, grantable: false },
    { key: 'Warehouse', label: 'Warehouse admin', needs_store: true, grantable: false }
  ]

  it('validates a new person: name, e-mail, a grantable role, a store for store roles, a sane PIN', () => {
    const d = emptyStaffDraft()
    expect(validateStaffDraft(d, roles, true)).toMatch(/first name/)
    d.first_name = 'Amira'
    expect(validateStaffDraft(d, roles, true)).toMatch(/e-mail/)
    d.email = 'amira@example.com'
    expect(validateStaffDraft(d, roles, true)).toMatch(/needs a store/)
    d.boutique = 'OK-BIX'
    expect(validateStaffDraft(d, roles, true)).toBeNull()
    d.role = 'HeadOffice'
    expect(validateStaffDraft(d, roles, true)).toMatch(/may not grant the Head office/)
    d.role = 'Manager'
    d.pin = '12'
    expect(validateStaffDraft(d, roles, true)).toMatch(/4 to 6 digits/)
    d.pin = '246810'
    d.password = 'short'
    expect(validateStaffDraft(d, roles, true)).toMatch(/at least 8/)
    d.password = ''
    expect(validateStaffDraft(d, roles, true)).toBeNull()
  })

  it('creates a person and hands the generated password and PIN back once', async () => {
    const out = await mockStaff.create({ first_name: 'Amira', last_name: 'Haddad', email: 'Amira@Example.com', role: 'Associate', boutique: 'HOU-MTR' })
    expect(out.person.user).toBe('amira@example.com')
    expect(out.person.boutique_name).toBe('CloudChaserz Montrose')
    expect(out.initial_password).toBeTruthy()
    expect(out.pin).toBeTruthy()
    expect(out.password_was_supplied).toBe(false)
    const again = await mockStaff.create({ first_name: 'Bilal', email: 'bilal@example.com', role: 'Associate', boutique: 'HOU-MTR', pin: '1234', password: 'chosen-by-manager' })
    expect(again.pin).toBeNull()
    expect(again.initial_password).toBeNull()
    await expect(mockStaff.create({ first_name: 'X', email: 'amira@example.com', role: 'Associate', boutique: 'HOU-MTR' })).rejects.toThrow(/already has a login/)
  })

  it('suspends and restores without deleting, and reports what changed on update', async () => {
    const s = await mockStaff.suspend('hou.mtr.manager@cloudchaserz.example')
    expect(s.person.login_enabled).toBe(0)
    expect(s.person.till_enabled).toBe(0)
    const r = await mockStaff.restore('hou.mtr.manager@cloudchaserz.example')
    expect(r.person.login_enabled).toBe(1)
    const u = await mockStaff.update('hou.mtr.manager@cloudchaserz.example', { first_name: 'Olivia', last_name: 'Hartmann-Reyes', role: 'Manager', boutique: 'OK-BIX' })
    expect(u.changed).toEqual(['last_name', 'boutique'])
    expect(u.person.boutique_name).toBe('CloudChaserz Bixby')
  })

  it('groups people by store with head office first and reads last-seen', async () => {
    const list = await mockStaff.list()
    const groups = groupStaff(list.staff)
    expect(groups[0].title).toBe('Head office')
    expect(groups.some((g) => g.title === 'CloudChaserz Montrose')).toBe(true)
    expect(lastSeen(list.staff.find((p) => p.user === 'hq@cloudchaserz.example')!)).toBe('2026-08-24 08:12')
    expect(lastSeen({ ...list.staff[0], last_login: null, last_active: null })).toBe('never signed in')
  })
})

describe('v1.4 — receipt mark raster', () => {
  it('packs a monochrome canvas into 1-bit rows, MSB first, 1 = black', () => {
    // jsdom has no 2D context; drive packRaster with a stand-in that returns known pixels
    const w = 10
    const h = 2
    const px = new Uint8ClampedArray(w * h * 4).fill(255)
    // row 0: dots 0 and 9 black; row 1: dot 3 black
    for (const [x, y] of [
      [0, 0],
      [9, 0],
      [3, 1]
    ]) {
      const i = (y * w + x) * 4
      px[i] = px[i + 1] = px[i + 2] = 0
    }
    const fake = { width: w, height: h, getContext: () => ({ getImageData: () => ({ data: px }) }) } as unknown as HTMLCanvasElement
    const out = packRaster(fake)!
    expect(out.width).toBe(16) // padded to a byte boundary
    expect(out.height).toBe(2)
    const bytes = Uint8Array.from(atob(out.base64), (c) => c.charCodeAt(0))
    expect(Array.from(bytes)).toEqual([0b10000000, 0b01000000, 0b00010000, 0b00000000])
  })
})
