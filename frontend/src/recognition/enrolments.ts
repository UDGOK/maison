/**
 * Offline enrolment queue. An enrolment (consent + 3 embeddings) or a decline captured while
 * the bench is unreachable sits in Dexie `pending_enrolments` and is replayed FIFO by the sync
 * store on the next successful heartbeat — exactly like sales. Never contains images.
 */
import { ApiError, type EnrollResult, type AwanzApi } from '@/api/types'
import type { AwanzDB, PendingEnrolmentRow } from '@/db'
import { v4 as uuidv4 } from 'uuid'

export type PendingEnrolment = Omit<PendingEnrolmentRow, 'id' | 'created_at' | 'attempts' | 'error'>

export interface EnrolmentReplayOutcome {
  done: { row: PendingEnrolmentRow; result: EnrollResult | { customer: string; client_number?: string; customer_name?: string } }[]
  failed: { row: PendingEnrolmentRow; error: string }[]
  pending: number
  offline: boolean
}

export function isTransient(e: unknown): boolean {
  // 409 = DuplicateEntry: a concurrent replay created the same client; the retry links to it (offline_uuid / phone)
  if (e instanceof ApiError) return e.code === 'NETWORK' || e.status === 0 || e.status === 409 || e.status >= 500
  return true
}

/** Index-by-index copy: works for number[], Float32Array and reactive proxies of either. */
function plainVector(e: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < e.length; i++) out.push(Number(e[i]))
  return out
}

export class EnrolmentQueue {
  constructor(
    private db: AwanzDB,
    private api: AwanzApi,
    private now: () => Date = () => new Date()
  ) {}

  async enqueue(p: PendingEnrolment): Promise<PendingEnrolmentRow> {
    // Deep-clone into plain data: the store hands us reactive (Proxy) sample objects, which
    // IndexedDB's structured clone rejects with DataCloneError.
    const plain = JSON.parse(JSON.stringify({ ...p, embeddings: (p.embeddings || []).map(plainVector) })) as PendingEnrolment
    const row: PendingEnrolmentRow = { ...plain, offline_uuid: plain.offline_uuid || uuidv4(), created_at: this.now().toISOString(), attempts: 0 }
    row.id = (await this.db.pending_enrolments.add(row)) as number
    return row
  }

  pending(): Promise<PendingEnrolmentRow[]> {
    return this.db.pending_enrolments.orderBy('id').toArray()
  }

  count(): Promise<number> {
    return this.db.pending_enrolments.count()
  }

  private replaying: Promise<EnrolmentReplayOutcome> | null = null

  /**
   * FIFO; stops at the first network failure; drops rows the server rejects outright.
   * Re-entrant callers (the `online` event and the heartbeat both fire on reconnect) share one run.
   */
  replay(): Promise<EnrolmentReplayOutcome> {
    if (!this.replaying) this.replaying = this.replayOnce().finally(() => (this.replaying = null))
    return this.replaying
  }

  private async replayOnce(): Promise<EnrolmentReplayOutcome> {
    const out: EnrolmentReplayOutcome = { done: [], failed: [], pending: 0, offline: false }
    for (const row of await this.pending()) {
      try {
        const result =
          row.kind === 'enroll'
            ? await this.api.recognition.enroll({
                embeddings: row.embeddings,
                model: row.model,
                quality: row.quality,
                boutique: row.boutique,
                device_id: row.device_id,
                consent: row.consent!,
                customer: row.customer,
                phone: row.phone,
                email: row.email,
                name: row.name,
                offline_uuid: row.offline_uuid
              })
            : await this.api.recognition.decline({ boutique: row.boutique, device_id: row.device_id, phone: row.phone, email: row.email, name: row.name })
        await this.db.pending_enrolments.delete(row.id!)
        out.done.push({ row, result })
      } catch (e) {
        if (isTransient(e)) {
          await this.db.pending_enrolments.update(row.id!, { attempts: row.attempts + 1, error: (e as Error).message })
          out.offline = true
          break
        }
        await this.db.pending_enrolments.delete(row.id!)
        out.failed.push({ row, error: (e as Error).message })
      }
    }
    out.pending = await this.count()
    return out
  }
}
