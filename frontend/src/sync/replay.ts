/**
 * FIFO queue replay with exponential backoff. Pure logic (no Pinia) so it is unit-testable
 * against fake-indexeddb and a stubbed API.
 */
import { stripHtml } from '@/utils/text'
import type { MaisonDB, QueueRow, ReceiptSnapshot } from '@/db'
import { ApiError, type MaisonApi, type POSInvoice, type SubmitResult } from '@/api/types'

export const BACKOFF_BASE_MS = 2000
export const BACKOFF_MAX_MS = 5 * 60 * 1000

export function backoffMs(attempts: number, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS): number {
  return Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)))
}

export interface ReplayOutcome {
  sent: number
  ok: number
  duplicate: number
  errors: number
  /** true when the network was unreachable (queue left untouched apart from backoff) */
  offline: boolean
}

export class QueueReplayer {
  private running = false
  constructor(
    private db: MaisonDB,
    private api: MaisonApi,
    private now: () => number = () => Date.now(),
    private batchSize = 10
  ) {}

  async enqueue(invoice: POSInvoice, receipt: ReceiptSnapshot): Promise<QueueRow> {
    const row: QueueRow = {
      offline_uuid: invoice.offline_uuid,
      seq: this.now() * 1000 + Math.floor(Math.random() * 1000),
      invoice,
      status: 'pending',
      attempts: 0,
      next_attempt_at: 0,
      created_at: new Date(this.now()).toISOString(),
      receipt
    }
    await this.db.queue.add(row)
    return row
  }

  async pending(): Promise<QueueRow[]> {
    const rows = await this.db.queue.where('status').anyOf('pending', 'sending', 'error').toArray()
    return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  }

  /** Rows due now (respecting backoff). Rows in 'sending' left by a crash are retried too. */
  async due(): Promise<QueueRow[]> {
    const t = this.now()
    return (await this.pending()).filter((r) => r.status !== 'error' && r.next_attempt_at <= t)
  }

  /** Manually re-arm an errored invoice (after the associate fixed the cause). */
  async retry(offline_uuid: string) {
    await this.db.queue.update(offline_uuid, { status: 'pending', next_attempt_at: 0, error: undefined, error_code: undefined })
  }

  async discard(offline_uuid: string) {
    await this.db.queue.delete(offline_uuid)
  }

  /**
   * Replay FIFO. Stops at the first network failure (keeps ordering), marks structured
   * server errors on their row and continues with the rest of the batch.
   */
  async replay(): Promise<ReplayOutcome> {
    const out: ReplayOutcome = { sent: 0, ok: 0, duplicate: 0, errors: 0, offline: false }
    if (this.running) return out
    this.running = true
    try {
      const rows = (await this.due()).slice(0, this.batchSize)
      if (!rows.length) return out
      await Promise.all(rows.map((r) => this.db.queue.update(r.offline_uuid, { status: 'sending', attempts: r.attempts + 1 })))
      let results: SubmitResult[]
      try {
        results = (await this.api.sales.submit_batch(rows.map((r) => r.invoice))).results
      } catch (e) {
        const err = e as ApiError
        const transient = err instanceof ApiError ? err.code === 'NETWORK' || err.status >= 500 || err.status === 0 : true
        for (const r of rows) {
          const attempts = r.attempts + 1
          await this.db.queue.update(r.offline_uuid, {
            status: transient ? 'pending' : 'error',
            next_attempt_at: this.now() + backoffMs(attempts),
            error: stripHtml(err.message),
            error_code: err instanceof ApiError ? err.code : 'UNKNOWN'
          })
        }
        out.offline = transient
        if (!transient) out.errors = rows.length
        return out
      }
      const byUuid = new Map(results.map((r) => [r.offline_uuid, r]))
      for (const r of rows) {
        const res = byUuid.get(r.offline_uuid)
        out.sent++
        if (!res) {
          await this.db.queue.update(r.offline_uuid, {
            status: 'error',
            error: 'Server returned no result for this invoice',
            error_code: 'NO_RESULT'
          })
          out.errors++
        } else if (res.status === 'ok' || res.status === 'duplicate') {
          await this.db.queue.update(r.offline_uuid, {
            status: 'ok',
            invoice_name: res.invoice_name,
            sent_at: new Date(this.now()).toISOString(),
            error: undefined,
            error_code: undefined
          })
          if (res.status === 'ok') out.ok++
          else out.duplicate++
        } else {
          await this.db.queue.update(r.offline_uuid, {
            status: 'error',
            error: stripHtml(res.error) || 'Rejected by server',
            error_code: res.error_code || 'SERVER_ERROR'
          })
          out.errors++
        }
      }
      return out
    } finally {
      this.running = false
    }
  }
}
