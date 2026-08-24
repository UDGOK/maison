/**
 * v0.8 — regression tests for the POS defects QA found on the live deployment
 * (`e2e/qa/pos-report.md`). Every test here fails against the code as it was.
 *
 *   D2  an offline sale of an age-restricted item could never sync (ISO `Z` timestamp)
 *   D3  a $0.00 comp / 100 % discount sale was always rejected
 *   D4  "Email receipt" did nothing
 *   D5  an expired session turned live sales into permanent "Rejected" rows, with an internal path
 *   D6  the PIN lockout was invisible — the till just kept saying "Incorrect PIN"
 *   D7  card brand / last 4 / approval never reached the invoice
 *   D9  the manager-PIN error rendered the Python exception class path
 *   D10 there was no split tender (cash + card)
 *   D11 the cash tendered and the change given were not recorded
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mockApi } from '@/api/mock'
import { decideOffline } from '@/api/v06'
import { humanizeServerMessage, isSessionExpired, SESSION_EXPIRED_MESSAGE, stripHtml } from '@/utils/text'
import { serverDateTime, setSiteTimeZone } from '@/utils/time'
import { ApiError, type POSInvoice } from '@/api/types'
import { useSessionStore } from '@/stores/session'

let seq = 0
function sale(over: Partial<POSInvoice> = {}): POSInvoice {
  return {
    offline_uuid: `d8-${++seq}-${Math.random().toString(36).slice(2)}`,
    boutique: 'CHI-OAK',
    associate: 'MA-0001',
    device_id: 'dev-1',
    posting_datetime: '2026-08-23T10:00:00Z',
    items: [{ item_code: 'AC-CLN-036', qty: 1, rate: 100 }],
    payments: [{ mode_of_payment: 'Cash', amount: 110.25 }],
    ...over
  }
}

// -----------------------------------------------------------------------------------------------
// D2 — the offline age check's timestamp
// -----------------------------------------------------------------------------------------------
describe('v0.8 POS D2 — an offline age check syncs', () => {
  it('stamps checked_at in the format a Frappe Datetime column takes, never ISO Z', () => {
    const r = decideOffline('Manual', '1990-05-15', '2030-05-15', 21)
    expect(r.verified).toBe(1)
    // `2026-08-23T19:39:08.269Z` is what MariaDB refused with "Incorrect datetime value"
    expect(r.checked_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(r.checked_at).not.toContain('T')
    expect(r.checked_at).not.toContain('Z')
  })

  it('uses the store clock, not the browser clock', () => {
    const at = new Date('2026-08-23T19:39:08.269Z')
    setSiteTimeZone('America/Chicago')
    expect(serverDateTime(at)).toBe('2026-08-23 14:39:08')
    setSiteTimeZone('UTC')
    expect(serverDateTime(at)).toBe('2026-08-23 19:39:08')
    setSiteTimeZone(null)
  })
})

// -----------------------------------------------------------------------------------------------
// D3 / D7 / D11 — what the till sends with a completed sale
// -----------------------------------------------------------------------------------------------
describe('v0.8 POS D3 — a $0.00 comp is a real sale', () => {
  it('books a fully discounted basket with no tender rows', async () => {
    const inv = sale({
      items: [{ item_code: 'AC-CLN-036', qty: 1, rate: 100, discount_amount: 100 }],
      payments: []
    })
    const res = (await mockApi.sales.submit_batch([inv])).results[0]
    expect(res.status, res.error).toBe('ok')
    expect(res.invoice_name).toBeTruthy()
  })

  it('still refuses a basket that comes to money with nothing tendered', async () => {
    const res = (await mockApi.sales.submit_batch([sale({ payments: [] })])).results[0]
    expect(res.status).toBe('error')
    expect(res.error).toMatch(/do not cover/i)
  })
})

describe('v0.8 POS D7 — the card reaches the invoice', () => {
  it('keeps brand / last 4 / approval so Returns can name the card it refunds', async () => {
    const inv = sale({
      payments: [
        {
          mode_of_payment: 'Card',
          amount: 110.25,
          stripe_payment_intent: 'pi_sim_d7',
          card_brand: 'Visa',
          last4: '4242',
          approval_code: '54DD0D'
        }
      ]
    })
    const res = (await mockApi.sales.submit_batch([inv])).results[0]
    expect(res.status, res.error).toBe('ok')
    const found = (await mockApi.returns.lookup({ invoice: res.invoice_name! })).invoices[0]
    // QA saw "Original card — Card ••••" with no digits
    expect(found.card_brand).toBe('Visa')
    expect(found.card_last4).toBe('4242')
  })
})

describe('v0.8 POS D11 — the drawer is reconcilable', () => {
  it('records what was tendered and gives the change back', async () => {
    const inv = sale({
      items: [{ item_code: 'AC-CLN-036', qty: 1, rate: 100 }],
      payments: [{ mode_of_payment: 'Cash', amount: 200 }] // $200 tendered on a $110.25 sale
    })
    const res = (await mockApi.sales.submit_batch([inv])).results[0]
    expect(res.status, res.error).toBe('ok')
    const day = await mockApi.sales.list('CHI-OAK', '2026-08-23')
    const row = day.invoices.find((i) => i.invoice === res.invoice_name)!
    expect(row.tendered).toBe(200)
    expect(row.change_amount).toBe(89.75)
    // cash in the drawer is the tender minus the change, i.e. still the sale value
    expect(row.cash).toBe(110.25)
  })

  it('refuses a card that overshoots the total (no change on a card)', async () => {
    const res = (
      await mockApi.sales.submit_batch([sale({ payments: [{ mode_of_payment: 'Card', amount: 130 }] })])
    ).results[0]
    expect(res.status).toBe('error')
    expect(res.error).toMatch(/exceed/i)
  })
})

describe('v0.8 POS D10 — split tender', () => {
  it('books a sale paid part cash, part card', async () => {
    const inv = sale({
      payments: [
        { mode_of_payment: 'Cash', amount: 60 },
        { mode_of_payment: 'Card', amount: 50.25, stripe_payment_intent: 'pi_sim_split', card_brand: 'Mastercard', last4: '5454', approval_code: 'AB12CD' }
      ]
    })
    const res = (await mockApi.sales.submit_batch([inv])).results[0]
    expect(res.status, res.error).toBe('ok')
    const day = await mockApi.sales.list('CHI-OAK', '2026-08-23')
    const row = day.invoices.find((i) => i.invoice === res.invoice_name)!
    expect(row.cash).toBe(60)
    expect(row.card).toBe(50.25)
    expect(row.change_amount).toBe(0)
  })

  it('still refuses a split that does not add up', async () => {
    const res = (
      await mockApi.sales.submit_batch([
        sale({ payments: [{ mode_of_payment: 'Cash', amount: 60 }, { mode_of_payment: 'Card', amount: 20 }] })
      ])
    ).results[0]
    expect(res.status).toBe('error')
    expect(res.error).toMatch(/do not cover/i)
  })
})

// -----------------------------------------------------------------------------------------------
// D4 — Email receipt
// -----------------------------------------------------------------------------------------------
describe('v0.8 POS D4 — "Email receipt" sends something', () => {
  it('posts the receipt to the server and reports it', async () => {
    const res = (await mockApi.sales.submit_batch([sale()])).results[0]
    const out = await mockApi.sales.email_receipt(res.receipt_token!, 'qa1.receipt@example.com')
    expect(out.ok).toBe(true)
    expect(out.queued).toBe(true)
    expect(out.invoice).toBe(res.invoice_name)
    expect(out.email_masked).toContain('@example.com')
  })

  it('rejects an address that is not one', async () => {
    const res = (await mockApi.sales.submit_batch([sale()])).results[0]
    await expect(mockApi.sales.email_receipt(res.invoice_name!, 'not-an-email')).rejects.toBeInstanceOf(ApiError)
  })

  it('cannot e-mail a receipt that does not exist', async () => {
    await expect(mockApi.sales.email_receipt('SINV-NOPE', 'a@b.com')).rejects.toBeInstanceOf(ApiError)
  })
})

// -----------------------------------------------------------------------------------------------
// D5 / D9 — what an associate is allowed to read
// -----------------------------------------------------------------------------------------------
describe('v0.8 POS D5 — a signed-out till says so, in plain words', () => {
  const LIVE_403 =
    'You are not permitted to access this resource.<details><summary>Login to access</summary>Function <strong>maison_pos.api.sales.submit_batch</strong> is not whitelisted.</details>'

  it('separates the run-together sentences instead of "Login to access**Function**"', () => {
    expect(stripHtml(LIVE_403)).not.toContain('accessFunction')
    expect(stripHtml(LIVE_403).split('\n')).toContain('Login to access')
  })

  it('never renders an internal method path or the untrue "not whitelisted" claim', () => {
    const out = humanizeServerMessage(LIVE_403)
    expect(out).not.toContain('maison_pos')
    expect(out).not.toMatch(/not whitelisted/i)
    expect(out).toContain('You are not permitted to access this resource.')
  })

  it('classifies a session_expired body as retryable', () => {
    expect(isSessionExpired(new ApiError('x', 'AUTH', 403, { session_expired: 1 }))).toBe(true)
    expect(isSessionExpired(new ApiError('x', 'SESSION_EXPIRED', 403))).toBe(true)
    expect(isSessionExpired(new ApiError('x', 'ValidationError', 417))).toBe(false)
    expect(isSessionExpired(new ApiError('x', 'NETWORK', 0))).toBe(false)
    expect(SESSION_EXPIRED_MESSAGE).toMatch(/sign in again/i)
  })
})

describe('v0.8 POS D9 — the manager-PIN refusal reads like English', () => {
  it('drops the exception class path Frappe puts in `exception`', () => {
    expect(humanizeServerMessage('maison_pos.api.returns.ManagerRequiredError: Manager PIN incorrect')).toBe(
      'Manager PIN incorrect'
    )
    expect(humanizeServerMessage('frappe.exceptions.ValidationError: Boutique HOU-MTR is disabled')).toBe(
      'Boutique HOU-MTR is disabled'
    )
  })

  it('leaves an ordinary server message untouched', () => {
    expect(humanizeServerMessage('PIN locked after too many failed attempts; ask a manager to reset it')).toBe(
      'PIN locked after too many failed attempts; ask a manager to reset it'
    )
    expect(humanizeServerMessage('32.0 units of ACC-003 needed in Warehouse HOU-MTR - CCZ')).toBe(
      '32.0 units of ACC-003 needed in Warehouse HOU-MTR - CCZ'
    )
  })
})

// -----------------------------------------------------------------------------------------------
// D6 — the PIN lockout
// -----------------------------------------------------------------------------------------------
describe('v0.8 POS D6 — a locked PIN says it is locked', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const LOCKED = 'PIN locked after too many failed attempts; ask a manager to reset it'

  it('keeps the server sentence so the shift does not stall on "Incorrect PIN"', async () => {
    const session = useSessionStore()
    session.associates = [{ name: 'MA-0002', full_name: 'Keisha Brown', role: 'Associate' } as never]
    const { api } = await import('@/api')
    const original = api.verifyPin
    api.verifyPin = async () => {
      throw new ApiError(LOCKED, 'AUTH', 401)
    }
    try {
      expect(await session.unlock('MA-0002', '1357')).toBe(false)
      expect(session.unlockError).toBe(LOCKED)
    } finally {
      api.verifyPin = original
    }
  })

  it('leaves the generic wording for a plain wrong PIN (the server answers ok:false)', async () => {
    const session = useSessionStore()
    session.associates = [{ name: 'MA-0002', full_name: 'Keisha Brown', role: 'Associate' } as never]
    const { api } = await import('@/api')
    const original = api.verifyPin
    api.verifyPin = async () => ({ ok: false }) as never
    try {
      expect(await session.unlock('MA-0002', '9999')).toBe(false)
      expect(session.unlockError).toBeNull()
    } finally {
      api.verifyPin = original
    }
  })
})
