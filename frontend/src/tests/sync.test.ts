import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MaisonDB, type ReceiptSnapshot } from '@/db'
import { QueueReplayer, backoffMs } from '@/sync/replay'
import { ApiError, type MaisonApi, type POSInvoice, type SubmitResult } from '@/api/types'

const receipt: ReceiptSnapshot = {
  boutique: 'CHI-OAK', boutique_name: 'Maison Oak Street', address_line: '', city: '', phone: '', associate_name: 'A',
  lines: [], net_total: 100, discount: 0, total_taxes: 10.25, tax_rate: 10.25, loyalty_amount: 0, loyalty_points_redeemed: 0,
  grand_total: 110.25, payments: [{ mode_of_payment: 'Cash', amount: 110.25 }], points_earned: 0, currency: 'USD'
}

function inv(uuid: string): POSInvoice {
  return {
    offline_uuid: uuid, boutique: 'CHI-OAK', associate: 'MA-0001', device_id: 'dev-1', posting_datetime: '2026-08-22T10:00:00Z',
    items: [{ item_code: 'AC-CLN-036', qty: 1, rate: 100 }], payments: [{ mode_of_payment: 'Cash', amount: 110.25 }]
  }
}

function fakeApi(submit: (invoices: POSInvoice[]) => Promise<{ results: SubmitResult[] }>): MaisonApi {
  return { sales: { submit_batch: submit } } as unknown as MaisonApi
}

let dbi = 0
let now = 1_000_000
const clock = () => now

describe('backoff', () => {
  it('doubles and caps', () => {
    expect(backoffMs(1)).toBe(2000)
    expect(backoffMs(2)).toBe(4000)
    expect(backoffMs(3)).toBe(8000)
    expect(backoffMs(20)).toBe(5 * 60 * 1000)
  })
})

describe('QueueReplayer', () => {
  let db: MaisonDB
  beforeEach(() => {
    db = new MaisonDB(`test_${dbi++}`)
    now = 1_000_000
  })

  it('replays FIFO and marks rows ok with invoice names', async () => {
    const seen: string[][] = []
    const api = fakeApi(async (invoices) => {
      seen.push(invoices.map((i) => i.offline_uuid))
      return { results: invoices.map((i) => ({ offline_uuid: i.offline_uuid, status: 'ok' as const, invoice_name: `SINV-${i.offline_uuid}` })) }
    })
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt); now += 10
    await r.enqueue(inv('b'), receipt); now += 10
    await r.enqueue(inv('c'), receipt)
    const out = await r.replay()
    expect(out).toMatchObject({ sent: 3, ok: 3, errors: 0, offline: false })
    expect(seen).toEqual([['a', 'b', 'c']])
    const rows = await db.queue.toArray()
    expect(rows.every((x) => x.status === 'ok')).toBe(true)
    expect((await db.queue.get('b'))?.invoice_name).toBe('SINV-b')
    expect(await r.pending()).toHaveLength(0)
  })

  it('keeps rows pending with exponential backoff on network failure', async () => {
    let calls = 0
    const api = fakeApi(async () => {
      calls++
      throw new ApiError('Failed to fetch', 'NETWORK', 0)
    })
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt)
    let out = await r.replay()
    expect(out.offline).toBe(true)
    let row = (await db.queue.get('a'))!
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.next_attempt_at).toBe(now + 2000)

    // not yet due -> no call
    out = await r.replay()
    expect(calls).toBe(1)
    expect(out.sent).toBe(0)

    now += 2001
    await r.replay()
    row = (await db.queue.get('a'))!
    expect(calls).toBe(2)
    expect(row.attempts).toBe(2)
    expect(row.next_attempt_at).toBe(now + 4000)
  })

  it('treats duplicate as success (idempotent offline_uuid)', async () => {
    const api = fakeApi(async (invoices) => ({
      results: invoices.map((i) => ({ offline_uuid: i.offline_uuid, status: 'duplicate' as const, invoice_name: 'SINV-EXISTING' }))
    }))
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt)
    const out = await r.replay()
    expect(out.duplicate).toBe(1)
    expect((await db.queue.get('a'))).toMatchObject({ status: 'ok', invoice_name: 'SINV-EXISTING' })
  })

  it('never sends the same invoice twice once it is ok', async () => {
    const submit = vi.fn(async (invoices: POSInvoice[]) => ({
      results: invoices.map((i) => ({ offline_uuid: i.offline_uuid, status: 'ok' as const, invoice_name: 'X' }))
    }))
    const r = new QueueReplayer(db, fakeApi(submit), clock)
    await r.enqueue(inv('a'), receipt)
    await r.replay()
    await r.replay()
    await r.replay()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate enqueue of the same offline_uuid', async () => {
    const r = new QueueReplayer(db, fakeApi(async () => ({ results: [] })), clock)
    await r.enqueue(inv('a'), receipt)
    await expect(r.enqueue(inv('a'), receipt)).rejects.toBeTruthy()
  })

  it('surfaces structured server errors per row and continues the batch', async () => {
    const api = fakeApi(async (invoices) => ({
      results: invoices.map((i) =>
        i.offline_uuid === 'b'
          ? { offline_uuid: 'b', status: 'error' as const, error: 'Solitaire: serial CHI00101 is no longer available', error_code: 'SerialConflict' }
          : { offline_uuid: i.offline_uuid, status: 'ok' as const, invoice_name: `SINV-${i.offline_uuid}` }
      )
    }))
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt); now += 1
    await r.enqueue(inv('b'), receipt); now += 1
    await r.enqueue(inv('c'), receipt)
    const out = await r.replay()
    expect(out).toMatchObject({ sent: 3, ok: 2, errors: 1 })
    const b = (await db.queue.get('b'))!
    expect(b.status).toBe('error')
    expect(b.error_code).toBe('SerialConflict')
    expect(b.error).toContain('no longer available')
    expect((await db.queue.get('c'))?.status).toBe('ok')

    // errored rows are not retried automatically
    const submit = vi.spyOn(api.sales, 'submit_batch')
    await r.replay()
    expect(submit).not.toHaveBeenCalled()

    // manual retry re-arms it
    await r.retry('b')
    expect((await db.queue.get('b'))?.status).toBe('pending')
    await r.replay()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('marks the batch as error (not pending) on non-transient HTTP errors', async () => {
    const api = fakeApi(async () => {
      throw new ApiError('Boutique CHI-OAK is disabled', 'ValidationError', 417)
    })
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt)
    const out = await r.replay()
    expect(out.offline).toBe(false)
    expect(out.errors).toBe(1)
    expect((await db.queue.get('a'))).toMatchObject({ status: 'error', error_code: 'ValidationError' })
  })

  // --- v0.8 POS D5 ---------------------------------------------------------------------------
  // A stale `sid` used to turn completed sales into permanent "Rejected" rows: `Sync now` would
  // not re-send them and only the per-row Retry recovered them. Signing in again is all it takes.
  it('keeps a sale queued when the till session expired, and says so without internals', async () => {
    let calls = 0
    const api = fakeApi(async (invoices) => {
      calls++
      if (calls === 1)
        throw new ApiError('Signed out — sign in again to sync this sale.', 'SESSION_EXPIRED', 403, { session_expired: 1 })
      return { results: invoices.map((i) => ({ offline_uuid: i.offline_uuid, status: 'ok' as const, invoice_name: 'ACC-SINV-2026-03078' })) }
    })
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt)

    const out = await r.replay()
    expect(out.authExpired).toBe(true)
    expect(out.errors).toBe(0)
    const row = (await db.queue.get('a'))!
    expect(row.status).toBe('pending') // NOT 'error' — nothing is wrong with the sale
    expect(row.error_code).toBe('SESSION_EXPIRED')
    expect(row.error).not.toMatch(/maison_pos|whitelisted/)
    expect(row.error).toMatch(/sign in again/i)

    // once the operator has signed in again the queue drains itself
    now += 60_000
    const after = await r.replay()
    expect(after.ok).toBe(1)
    expect(after.authExpired).toBeFalsy()
    expect((await db.queue.get('a'))).toMatchObject({ status: 'ok', invoice_name: 'ACC-SINV-2026-03078' })
  })

  it('treats a bare 401/403 on the batch endpoint the same way', async () => {
    const api = fakeApi(async () => {
      throw new ApiError('Signed out — sign in again to sync this sale.', 'AUTH', 401)
    })
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt)
    const out = await r.replay()
    expect(out.authExpired).toBe(true)
    expect((await db.queue.get('a'))?.status).toBe('pending')
  })

  it('strips internal paths out of a rejection the server sends back per row', async () => {
    const api = fakeApi(async (invoices) => ({
      results: invoices.map((i) => ({
        offline_uuid: i.offline_uuid,
        status: 'error' as const,
        error: 'maison_pos.api.returns.ManagerRequiredError: Manager PIN incorrect',
        error_code: 'PERMISSION_DENIED'
      }))
    }))
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt)
    await r.replay()
    expect((await db.queue.get('a'))?.error).toBe('Manager PIN incorrect')
  })
  // --- end v0.8 POS D5 ---

  it('flags rows the server silently dropped', async () => {
    const api = fakeApi(async () => ({ results: [] }))
    const r = new QueueReplayer(db, api, clock)
    await r.enqueue(inv('a'), receipt)
    await r.replay()
    expect((await db.queue.get('a'))).toMatchObject({ status: 'error', error_code: 'NO_RESULT' })
  })

  it('retries rows stuck in sending after a crash', async () => {
    const r = new QueueReplayer(db, fakeApi(async (invoices) => ({ results: invoices.map((i) => ({ offline_uuid: i.offline_uuid, status: 'ok' as const })) })), clock)
    await r.enqueue(inv('a'), receipt)
    await db.queue.update('a', { status: 'sending' })
    const out = await r.replay()
    expect(out.ok).toBe(1)
  })
})
