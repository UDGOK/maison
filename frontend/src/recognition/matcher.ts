/**
 * Matching: local Dexie `face_templates` first (works offline), then the server
 * (`recognition.match`) when reachable. If the two disagree the smaller distance wins.
 * Rule (same as the server): euclidean distance on the raw descriptors `< threshold` (0.6).
 * Only consented clients ever reach either side: the server filters Active consents,
 * and the local cache is populated exclusively from `recognition.templates`.
 */
import type { MaisonApi, RecognitionMatch, TemplatesResult } from '@/api/types'
import type { FaceTemplateRow, MaisonDB } from '@/db'
import { bestMatch, effectiveThreshold, isMatch, reconcile } from './math'

export interface MatchOutcome {
  match: RecognitionMatch | null
  source: 'local' | 'server' | 'none'
  /** the server was consulted */
  online: boolean
  /** effective maximum distance */
  threshold: number
  localScore?: number
  serverScore?: number
  localDistance?: number
  serverDistance?: number
}

export class TemplateCache {
  constructor(private db: MaisonDB) {}

  async all(model?: string): Promise<FaceTemplateRow[]> {
    const rows = await this.db.face_templates.toArray()
    return model ? rows.filter((r) => r.model === model) : rows
  }

  async count(): Promise<number> {
    return this.db.face_templates.count()
  }

  /** Replace the cached templates with a server snapshot (full or delta with `deleted`). */
  async apply(res: TemplatesResult, full: boolean): Promise<void> {
    await this.db.transaction('rw', this.db.face_templates, async () => {
      if (full) await this.db.face_templates.clear()
      for (const c of res.deleted || []) await this.db.face_templates.where('customer').equals(c).delete()
      const byCustomer = new Map<string, number>()
      const touched = new Set<string>()
      for (const t of res.templates || []) {
        if (!touched.has(t.customer)) {
          // a customer's rows are replaced wholesale by the snapshot
          await this.db.face_templates.where('customer').equals(t.customer).delete()
          touched.add(t.customer)
        }
        const i = byCustomer.get(t.customer) ?? 0
        byCustomer.set(t.customer, i + 1)
        await this.db.face_templates.put({
          id: `${t.customer}#${i}`,
          customer: t.customer,
          customer_name: t.customer_name,
          client_number: t.client_number,
          model: t.model,
          embedding: Array.from(t.embedding),
          synced_at: new Date().toISOString()
        })
      }
    })
  }

  /** Test hook / revoke: drop one client's templates. */
  async remove(customer: string): Promise<void> {
    await this.db.face_templates.where('customer').equals(customer).delete()
  }

  async clear(): Promise<void> {
    await this.db.face_templates.clear()
  }
}

export interface MatcherDeps {
  db: MaisonDB
  api: MaisonApi
  /** reachable server (sync store) */
  online: () => boolean
}

export async function matchEmbedding(deps: MatcherDeps, embedding: number[], model: string, boutique: string, threshold: number): Promise<MatchOutcome> {
  const cache = new TemplateCache(deps.db)
  const local = bestMatch(embedding, await cache.all(model), threshold, model)
  const localMatch: RecognitionMatch | null = local
    ? { customer: local.template.customer, customer_name: local.template.customer_name, client_number: local.template.client_number, distance: round(local.distance), score: round(local.score) }
    : null
  const offline = (): MatchOutcome => ({ match: localMatch, source: localMatch ? 'local' : 'none', online: false, threshold, localScore: local?.score, localDistance: local?.distance })

  if (!deps.online()) return offline()

  try {
    const res = await deps.api.recognition.match(embedding, model, boutique)
    // The server's distance threshold is authoritative; a device (manager) override may only tighten it (lower).
    const th = effectiveThreshold(res.threshold_distance ?? res.threshold, threshold)
    const server =
      (res.matches || [])
        .filter((m) => typeof m.distance === 'number' && isMatch(m.distance, th))
        .sort((a, b) => (a.distance as number) - (b.distance as number))[0] ?? null
    // the effective threshold also applies to the local candidate (the device may have been looser than the server)
    const picked = reconcile(local && isMatch(local.distance, th) ? localMatch : null, server)
    return {
      match: picked,
      source: picked ? (picked === server ? 'server' : 'local') : 'none',
      online: true,
      threshold: th,
      localScore: local?.score,
      serverScore: server?.score,
      localDistance: local?.distance,
      serverDistance: server?.distance
    }
  } catch {
    return offline()
  }
}

function round(x: number) {
  return Math.round(x * 1000) / 1000
}
