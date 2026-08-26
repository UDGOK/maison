/**
 * v0.5 K — AWANZ Salon: masking (mirrors maison_pos.api.salon), the screen reducer, pairing-code TTL
 * helpers, the publish debouncer and the mock API contract (pair → identify → publish → feedback).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { digitsOnly, firstName, maskClientNumber, maskEmail, maskPhone, maskTyping, sanitizeState } from '@/salon/mask'
import { clientOf, initialModel, isStale, reduce, THANK_YOU_MS, viewOf, type SalonModel } from '@/salon/reducer'
import { codeFromScan, formatCode, formatRemaining, isCodeValid, isCompleteCode, normalizeCode, parseServerTime, remainingMs } from '@/salon/pairing'
import { socketTarget } from '@/salon/transport'
import { makeDebouncer, samePayload } from '@/stores/salon'
import { mockSalon, __mockSalon, SALON_SCREENS } from '@/api/salon'

describe('salon masking', () => {
  it('masks phones to the last four digits', () => {
    expect(maskPhone('+1 312 555 0105')).toBe('•••• 0105')
    expect(maskPhone('123')).toBe('••••')
    expect(maskPhone('')).toBeNull()
    expect(maskPhone(undefined)).toBeNull()
    expect(digitsOnly('+1 (312) 555-0105')).toBe('13125550105')
  })
  it('masks e-mails and client numbers', () => {
    expect(maskEmail('mei-lin.chen@example.com')).toBe('m•••@example.com')
    expect(maskEmail('nope')).toBeNull()
    expect(maskClientNumber('MC595284')).toBe('MC •• 284')
    expect(maskClientNumber('MC12')).toBe('MC12')
    expect(firstName('Mei-Lin Chen')).toBe('Mei-Lin')
    expect(firstName('')).toBe('')
  })
  it('sanitizes a state recursively and is idempotent', () => {
    const s = sanitizeState({
      client: { customer_name: 'Mei-Lin Chen', mobile_no: '+1 312 555 0105', email_id: 'x@y.z', client_number: 'MC595284', birthday: '1981-03-14' },
      lines: [{ item_name: 'Ring', phone: 'leak', amount: 1 }],
      totals: { grand_total: 1 }
    }) as any
    expect(s.client.mobile_no).toBeUndefined()
    expect(s.client.email_id).toBeUndefined()
    expect(s.client.birthday).toBeUndefined()
    expect(s.client.first_name).toBe('Mei-Lin')
    expect(s.client.client_number).toBeUndefined()
    expect(s.client.client_number_masked).toBe('MC •• 284')
    expect(s.lines[0].phone).toBeUndefined()
    expect(s.lines[0].amount).toBe(1)
    expect(sanitizeState(s)).toEqual(s)
  })
  it('masks while typing on the keypad (last four visible)', () => {
    expect(maskTyping('3125550105')).toBe('••••••0105')
    expect(maskTyping('312')).toBe('312')
    expect(maskTyping('a@b.c')).toBe('a@b.c')
  })
})

describe('salon reducer', () => {
  const client = { customer: 'CUST-1', first_name: 'Mei-Lin' }
  let m: SalonModel
  beforeEach(() => {
    m = reduce(initialModel(), { type: 'paired', state: { screen: 'idle', seq: 1 }, now: 1000 })
  })
  it('starts on pair, ambient when idle', () => {
    expect(viewOf(initialModel())).toBe('pair')
    expect(viewOf(m)).toBe('ambient')
    expect(m.seq).toBe(1)
  })
  it('follows the POS through a sale and ignores stale seqs', () => {
    m = reduce(m, { type: 'remote', state: { screen: 'identify', seq: 2 } })
    expect(viewOf(m)).toBe('identify')
    m = reduce(m, { type: 'identify_mode', mode: 'keypad' })
    expect(m.identify).toBe('keypad')
    m = reduce(m, { type: 'remote', state: { screen: 'basket', seq: 1 } }) // older
    expect(viewOf(m)).toBe('identify')
    m = reduce(m, { type: 'remote', state: { screen: 'basket', seq: 3, client, lines: [] } })
    expect(viewOf(m)).toBe('basket')
    expect(m.identify).toBe('menu') // local memory reset on a new screen
    m = reduce(m, { type: 'remote', state: { screen: 'pay', seq: 4, pay: { mode: 'card', amount: 10, step: 'present' } } })
    expect(viewOf(m)).toBe('pay')
    m = reduce(m, { type: 'remote', state: { screen: 'pay', seq: 5, pay: { mode: 'card', amount: 10, step: 'approved' } } })
    expect(viewOf(m)).toBe('approved')
    m = reduce(m, { type: 'remote', state: { screen: 'approved', seq: 6 } })
    expect(viewOf(m)).toBe('approved')
  })
  it('identify: a local attach shows the welcome card until the POS republishes', () => {
    m = reduce(m, { type: 'remote', state: { screen: 'identify', seq: 2 } })
    m = reduce(m, { type: 'attached', client })
    expect(viewOf(m)).toBe('client')
    expect(clientOf(m)).toEqual(client)
    // server's optimistic "client" state keeps the local client
    m = reduce(m, { type: 'remote', state: { screen: 'client', seq: 3, client, pending_pos: true } })
    expect(clientOf(m)?.customer).toBe('CUST-1')
    // the POS republishes with its own client → local copy dropped
    m = reduce(m, { type: 'remote', state: { screen: 'basket', seq: 4, client: { ...client, tier: 'Patron' } } })
    expect(m.localClient).toBeNull()
    expect(clientOf(m)?.tier).toBe('Patron')
    m = reduce(m, { type: 'remote', state: { screen: 'idle', seq: 5 } })
    expect(clientOf(m)).toBeNull()
  })
  it('sign-up offer keeps the signup screen until answered', () => {
    m = reduce(m, { type: 'remote', state: { screen: 'identify', seq: 2 } })
    m = reduce(m, { type: 'identify_mode', mode: 'signup' })
    expect(viewOf(m)).toBe('signup')
    m = reduce(m, { type: 'attached', client, offer: true })
    expect(viewOf(m)).toBe('signup')
    m = reduce(m, { type: 'remote', state: { screen: 'client', seq: 3, client, pending_pos: true } })
    expect(viewOf(m)).toBe('signup')
    m = reduce(m, { type: 'offer_done' })
    expect(viewOf(m)).toBe('client')
    // consent hand-off from the server
    m = reduce(m, { type: 'remote', state: { screen: 'consent', seq: 4, client, step: 'capture' } })
    expect(viewOf(m)).toBe('consent')
    expect(m.offer).toBe(false)
    m = reduce(m, { type: 'remote', state: { screen: 'basket', seq: 5, client, lines: [] } })
    expect(viewOf(m)).toBe('basket')
  })
  it('thank-you: feedback → invite → done, auto-returns to ambient after 20 s', () => {
    m = reduce(m, { type: 'remote', state: { screen: 'receipt', seq: 2, client }, now: 10_000 })
    expect(viewOf(m)).toBe('thankyou')
    expect(m.ambientAt).toBe(10_000 + THANK_YOU_MS)
    m = reduce(m, { type: 'tick', now: 10_000 + THANK_YOU_MS - 1 })
    expect(viewOf(m)).toBe('thankyou')
    m = reduce(m, { type: 'receipt_stage', stage: 'feedback', now: 20_000 })
    expect(viewOf(m)).toBe('feedback')
    expect(m.ambientAt).toBe(20_000 + THANK_YOU_MS) // interaction extends the timer
    m = reduce(m, { type: 'feedback_sent', rating: 5, now: 25_000 })
    expect(viewOf(m)).toBe('invite')
    expect(m.feedbackRating).toBe(5)
    m = reduce(m, { type: 'tick', now: 25_000 + THANK_YOU_MS })
    expect(viewOf(m)).toBe('ambient')
    expect(m.dismissedSeq).toBe(2)
    // the same receipt seq stays dismissed; a new sale shows again
    m = reduce(m, { type: 'remote', state: { screen: 'receipt', seq: 2, client } })
    expect(viewOf(m)).toBe('ambient')
    m = reduce(m, { type: 'remote', state: { screen: 'basket', seq: 3 } })
    expect(viewOf(m)).toBe('basket')
  })
  it('dismiss returns to ambient immediately; unpaired resets', () => {
    m = reduce(m, { type: 'remote', state: { screen: 'receipt', seq: 2 } })
    m = reduce(m, { type: 'dismiss' })
    expect(viewOf(m)).toBe('ambient')
    m = reduce(m, { type: 'remote', state: { screen: 'unpaired' as never, seq: 3 } })
    expect(m.paired).toBe(false)
    expect(viewOf(m)).toBe('pair')
  })
  it('stale detection', () => {
    m = reduce(m, { type: 'seen', now: 1000 })
    expect(isStale(m, 5000)).toBe(false)
    expect(isStale(m, 1000 + 15_001)).toBe(true)
  })
  it('concierge mode', () => {
    m = reduce(m, { type: 'remote', state: { screen: 'concierge', seq: 2, client } })
    expect(viewOf(m)).toBe('concierge')
  })
})

describe('pairing code TTL', () => {
  it('normalises, validates and formats codes', () => {
    expect(normalizeCode('MS:123456')).toBe('123456')
    expect(normalizeCode('12 34 56 78')).toBe('123456')
    expect(isCompleteCode('12345')).toBe(false)
    expect(isCompleteCode('123456')).toBe(true)
    expect(formatCode('123456')).toBe('123 456')
    expect(formatCode('12')).toBe('12')
    expect(codeFromScan('MS:654321')).toBe('654321')
    expect(codeFromScan('https://maison.example/salon?code=111222')).toBe('111222')
    expect(codeFromScan('MC:CUST-1')).toBeNull()
  })
  it('counts down a 10 minute code and expires it', () => {
    const now = Date.parse('2026-08-22T12:00:00Z')
    const expires = new Date(now + 600_000).toISOString()
    expect(remainingMs(expires, now)).toBe(600_000)
    expect(isCodeValid(expires, now + 599_999)).toBe(true)
    expect(isCodeValid(expires, now + 600_000)).toBe(false)
    expect(remainingMs(expires, now + 700_000)).toBe(0)
    expect(formatRemaining(600_000)).toBe('10:00')
    expect(formatRemaining(61_000)).toBe('1:01')
    expect(formatRemaining(0)).toBe('0:00')
    expect(isCodeValid(null, now)).toBe(false)
  })
  it('parses Frappe site-local timestamps', () => {
    const t = parseServerTime('2026-08-22 18:18:26.800196')
    expect(t).toBe(new Date('2026-08-22T18:18:26').getTime())
    expect(parseServerTime('2026-08-22T18:18:26Z')).toBe(Date.parse('2026-08-22T18:18:26Z'))
  })
})

describe('publish debouncer', () => {
  it('coalesces bursts into the last call after 150 ms', () => {
    vi.useFakeTimers()
    const calls: unknown[] = []
    const d = makeDebouncer(150, (s, p) => calls.push([s, p]))
    d('basket', { n: 1 })
    d('basket', { n: 2 })
    vi.advanceTimersByTime(100)
    d('pay', { n: 3 })
    vi.advanceTimersByTime(149)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual([['pay', { n: 3 }]])
    vi.useRealTimers()
  })
  it('samePayload compares structurally', () => {
    expect(samePayload({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(samePayload({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('mock salon API contract', () => {
  beforeEach(() => {
    localStorage.clear()
    __mockSalon.reset()
  })
  it('pairs once per code, mirrors sanitised state, attaches by identify and takes feedback', async () => {
    const pc = await mockSalon.pairing_code('CHI-OAK', 'POS-1')
    expect(pc.code).toMatch(/^\d{6}$/)
    expect(pc.ttl_seconds).toBe(600)
    const s = await mockSalon.pair(pc.qr, 'SALON-1')
    expect(s.status).toBe('Paired')
    expect(s.state?.screen).toBe('idle')
    expect(s.playlist?.length).toBeGreaterThan(0)
    await expect(mockSalon.pair(pc.code)).rejects.toThrow()
    const st = await mockSalon.pos_status('CHI-OAK', 'POS-1')
    expect(st.paired && st.session?.token).toBe(s.token)

    await mockSalon.publish(s.token, 'basket', { customer: 'CUST-0001', lines: [{ item_code: 'X', item_name: 'X', qty: 1, rate: 1, amount: 1 }], mobile_no: 'leak' })
    const r = await mockSalon.state(s.token, 0)
    expect(r.changed).toBe(true)
    expect(r.state?.screen).toBe('basket')
    expect(r.state?.client?.phone_masked).toMatch(/^•••• \d{4}$/)
    expect((r.state as any).mobile_no).toBeUndefined()
    expect((r.state as any).customer).toBeUndefined()
    expect((await mockSalon.state(s.token, r.seq)).changed).toBe(false)
    await expect(mockSalon.publish(s.token, 'nope' as never, {})).rejects.toThrow()
    expect(SALON_SCREENS).toContain('concierge')

    const who = await mockSalon.identify(s.token, '412 555 1037')
    expect(who.found).toBe(true)
    expect(who.client?.customer).toBe('CUST-0002')
    expect(await mockSalon.identify(s.token, '+1 999 000 0000')).toEqual({ found: false })
    const poll = await mockSalon.pos_poll(s.token, 0)
    expect(poll.messages[0].type).toBe('client_attached')
    expect(poll.messages[0].customer).toBe('CUST-0002')

    await expect(mockSalon.feedback(s.token, 5)).rejects.toThrow() // no receipt yet
    await mockSalon.publish(s.token, 'receipt', { customer: 'CUST-0002', receipt_token: 'tok123', sales_invoice: 'INV-1' })
    expect((await mockSalon.feedback(s.token, 2, 'slow')).ok).toBe(true)
    expect((await mockSalon.feedback(s.token, 4)).duplicate).toBe(true)
    expect(__mockSalon.feedback()[0]).toMatchObject({ invoice: 'INV-1', rating: 2, boutique: 'CHI-OAK' })

    const inv = await mockSalon.invite(s.token, 1)
    expect(inv.wants_invitation).toBe(1)
    expect(__mockSalon.profiles()['CUST-0002'].private_viewing_invite).toBe(1)
  })
  it('sign-up creates a customer with marketing preferences and links on repeat', async () => {
    const pc = await mockSalon.pairing_code('CHI-OAK', 'POS-2')
    const s = await mockSalon.pair(pc.code)
    const r = await mockSalon.signup(s.token, { name: 'Salon Newcomer', phone: '+1 312 555 0777', marketing_email: 1, marketing_sms: 0 })
    expect(r.created).toBe(true)
    expect(r.client.first_name).toBe('Salon')
    expect(r.client.phone_masked).toBe('•••• 0777')
    expect(r.face_recognition_enabled).toBe(1)
    const again = await mockSalon.signup(s.token, { name: 'Salon Newcomer', phone: '312-555-0777' })
    expect(again.created).toBe(false)
    expect(again.client.customer).toBe(r.client.customer)
    await expect(mockSalon.signup(s.token, { name: 'X', phone: '+1 312 555 0778' })).rejects.toThrow()
    const prefs = await mockSalon.preferences(s.token, { ring_size: '6.5', metal_preference: 'Rose Gold', styles: ['Minimal'], occasions: ['Anniversary'] })
    expect(prefs.saved).toEqual(['metal_preference', 'ring_size', 'style_notes'])
    const c = await mockSalon.consent(s.token, 'Hold-to-agree')
    expect(c.camera).toBe(1)
    const pc2 = await mockSalon.pending_consent(s.token)
    expect(pc2.consent?.method).toBe('Hold-to-agree')
    expect((await mockSalon.pending_consent(s.token)).consent).toBeNull()
    const msgs = (await mockSalon.pos_poll(s.token, 0)).messages.map((m) => m.type)
    expect(msgs).toEqual(['client_attached', 'client_attached', 'preferences', 'consent_agreed'])
    await mockSalon.unpair(s.token)
    await expect(mockSalon.state(s.token)).rejects.toMatchObject({ status: 403 })
  })
})

/**
 * v1.2 — socket.io's namespace is the **site name**, not the host. These pin the bug that made the
 * wall fall back to polling the day a custom domain was pointed at the live site.
 */
describe('socket target', () => {
  const LOC = (hostname: string, port = '', protocol = 'https:') => ({
    origin: `${protocol}//${hostname}${port ? ':' + port : ''}`,
    hostname,
    port,
    protocol
  })
  const reset = () => {
    delete (window as { awanz_site_name?: string }).awanz_site_name
    delete (window as { dev_server?: unknown }).dev_server
    delete (window as { socketio_port?: number }).socketio_port
    delete (window as { frappe?: unknown }).frappe
  }

  beforeEach(reset)

  it('uses the injected site name, not the domain the browser is on', () => {
    // the actual failure: a custom domain asked for a namespace that does not exist
    window.awanz_site_name = 'cloudchaserz.frappe.cloud'
    expect(socketTarget(LOC('www.cc-ok.com'))).toBe('https://www.cc-ok.com/cloudchaserz.frappe.cloud')
  })

  it('is unchanged on the frappe.cloud domain, where host and site happen to match', () => {
    window.awanz_site_name = 'cloudchaserz.frappe.cloud'
    expect(socketTarget(LOC('cloudchaserz.frappe.cloud'))).toBe(
      'https://cloudchaserz.frappe.cloud/cloudchaserz.frappe.cloud'
    )
  })

  it('falls back to the desk boot, then the hostname, for a page that predates the fix', () => {
    window.frappe = { boot: { sitename: 'booted.site' } }
    expect(socketTarget(LOC('anything.example'))).toBe('https://anything.example/booted.site')
    delete (window as { frappe?: unknown }).frappe
    expect(socketTarget(LOC('anything.example'))).toBe('https://anything.example/anything.example')
  })

  it('talks to the socketio process directly under bench serve, keeping the site name', () => {
    window.awanz_site_name = 'maison.localhost'
    window.socketio_port = 9000
    expect(socketTarget(LOC('maison.localhost', '8000', 'http:'))).toBe('http://maison.localhost:9000/maison.localhost')
  })
})
