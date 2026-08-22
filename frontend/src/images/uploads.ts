/**
 * Offline queue for product-image uploads. Managers can set a tile photo while offline; the
 * blob sits in Dexie (`uploads`) until `replayUploads` runs on the next successful heartbeat.
 */
import { api, ApiError } from '@/api'
import { db, type UploadRow } from '@/db'

export async function queueUpload(item_code: string, blob: Blob, filename = `${item_code}.jpg`): Promise<UploadRow> {
  // One pending upload per item: the latest photo wins.
  await db.uploads.where('item_code').equals(item_code).delete()
  const row: UploadRow = { item_code, blob, filename, created_at: new Date().toISOString(), attempts: 0 }
  row.id = (await db.uploads.add(row)) as number
  return row
}

export interface UploadReplayOutcome {
  done: { item_code: string; url: string }[]
  failed: { item_code: string; error: string }[]
  pending: number
}

/** FIFO; stops at the first network failure, drops rows the server rejects outright. */
export async function replayUploads(): Promise<UploadReplayOutcome> {
  const out: UploadReplayOutcome = { done: [], failed: [], pending: 0 }
  const rows = (await db.uploads.toArray()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
  for (const r of rows) {
    try {
      const res = await api.catalog.upload_item_image(r.item_code, r.blob, r.filename)
      const url = res.image || (res as any).url
      await db.uploads.delete(r.id!)
      out.done.push({ item_code: r.item_code, url })
    } catch (e) {
      const err = e as ApiError
      const transient = err instanceof ApiError ? err.code === 'NETWORK' || err.status === 0 || err.status >= 500 : true
      if (transient) {
        await db.uploads.update(r.id!, { attempts: r.attempts + 1, error: err.message })
        break
      }
      await db.uploads.delete(r.id!)
      out.failed.push({ item_code: r.item_code, error: err.message })
    }
  }
  out.pending = await db.uploads.count()
  return out
}
