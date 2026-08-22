/**
 * Resolve a scanned code against local data. Pure function over small lookup interfaces so it is
 * unit-testable without Pinia; `useScanHandler` (scan/handler.ts) applies the result to the UI.
 */
import type { Customer, Item } from '@/api/types'
import { parsePayload } from './payloads'

export interface ResolveSources {
  /** barcode / serial → item (+serial) */
  resolveCode(code: string): { item: Item; serial_no?: string } | null
  /** local customer by id (MC:<id>) */
  customerById?(id: string): Promise<Customer | null> | Customer | null
  /** local queue row with that invoice name → offline_uuid */
  invoiceUuid?(invoiceName: string): Promise<string | null> | string | null
}

export type Resolution =
  | { kind: 'item'; item: Item; serial_no?: string }
  | { kind: 'client'; customer: Customer }
  | { kind: 'client-remote'; customer: string }
  | { kind: 'invoice'; invoice: string; offline_uuid: string | null }
  | { kind: 'receipt'; token: string; url: string }
  | { kind: 'unknown'; code: string }

export async function resolveScan(raw: string, src: ResolveSources): Promise<Resolution> {
  const p = parsePayload(raw)
  if (p.kind === 'client') {
    const c = src.customerById ? await src.customerById(p.customer) : null
    return c ? { kind: 'client', customer: c } : { kind: 'client-remote', customer: p.customer }
  }
  if (p.kind === 'invoice') {
    const uuid = src.invoiceUuid ? await src.invoiceUuid(p.invoice) : null
    return { kind: 'invoice', invoice: p.invoice, offline_uuid: uuid }
  }
  if (p.kind === 'receipt') return { kind: 'receipt', token: p.token, url: p.url }
  const hit = src.resolveCode(p.code)
  if (hit) return { kind: 'item', item: hit.item, serial_no: hit.serial_no }
  return { kind: 'unknown', code: p.code }
}
