/**
 * v0.6 P — Warehouse Wall logic (pure, unit-tested): column aggregation from the server payload or
 * from a flat list of shipments / requests, age tiers (warn 4 h / crit 24 h), card ordering
 * (priority first, oldest first), rate selection (cheapest / fastest), and the diff that decides when
 * to play the sound / flash and which documents to auto-print.
 *
 * v1.0 §F — plus the **Inbound** column: the vendor deliveries the floor is waiting for, as a third
 * kind of card on the same union, ordered and tiered by how overdue they are.
 */
import type { PurchaseOrderWithItems } from '@/api/purchasing'
import type { Rate, ReplenishmentRequest, Shipment, WallColumn, WallData, WallEvent } from '@/api/warehouse'
import { etaOf, overdueDays } from './inbound'

/**
 * v1.0 §F — one expected vendor delivery on the wall.
 *
 * It carries `boutique` / `boutique_name` / `items` / `units` / `status` like the other two kinds so
 * the three share one union (and one card anatomy); `boutique` is where the delivery is *going* —
 * the warehouse, or the store a drop-ship order is addressed to — not the vendor, which has its own
 * `supplier` fields.
 */
export interface InboundCard {
  kind: 'inbound'
  /** the Purchase Order */
  name: string
  supplier: string
  supplier_name?: string | null
  /** destination code: the warehouse, or a drop-ship store */
  boutique: string
  boutique_name?: string
  status: string
  /** lines still outstanding */
  items: number
  /** units still outstanding */
  units: number
  /** ordered units, for the progress figure */
  units_ordered: number
  per_received: number
  /** `YYYY-MM-DD`, the promised date or today + the vendor's lead time */
  eta: string
  /** whole days past the ETA; 0 when it is not yet due */
  overdue_days: number
  /** seconds overdue — what `sortCards` and `ageTier` read */
  age_seconds?: number
  priority?: string | null
  dropship_store?: string | null
}

export type WallCard = ((ReplenishmentRequest | Shipment) & { kind: 'request' | 'shipment' }) | InboundCard
export type AgeTier = 'ok' | 'warn' | 'crit'

export const DEFAULT_WARN_S = 4 * 3600
export const DEFAULT_CRIT_S = 24 * 3600

/** A delivery is amber the day after its ETA and red three days late — hours mean nothing here. */
export const INBOUND_WARN_S = 24 * 3600
export const INBOUND_CRIT_S = 3 * 24 * 3600

export function isShipment(card: WallCard | ReplenishmentRequest | Shipment): card is Shipment & { kind: 'shipment' } {
  return (card as Shipment).kind === 'shipment' || 'to_warehouse' in card && 'est_weight' in card
}

/** Column for one document (mirrors `maison_pos.api.shipping.wall`). */
export function columnFor(doc: ReplenishmentRequest | Shipment, today = new Date()): WallColumn | null {
  if ((doc as ReplenishmentRequest).kind === 'request' || !('est_weight' in doc)) {
    return (doc as ReplenishmentRequest).status === 'Pending Approval' ? 'pending_approval' : null
  }
  const s = doc as Shipment
  if (s.status === 'Pending' || s.status === 'Picking') return 'to_pick'
  if (s.status === 'Packed') return s.label_url ? 'ready' : 'packing'
  if (s.status === 'Shipped' && s.shipped_at && sameDay(new Date(s.shipped_at), today)) return 'shipped_today'
  return null
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Build the five columns from a flat list (mock / optimistic updates); sorted like the server. */
export function aggregate(docs: (ReplenishmentRequest | Shipment)[], today = new Date()): Record<WallColumn, WallCard[]> {
  const cols: Record<WallColumn, WallCard[]> = { pending_approval: [], to_pick: [], packing: [], ready: [], shipped_today: [] }
  for (const d of docs) {
    const col = columnFor(d, today)
    if (!col) continue
    const kind = 'est_weight' in d ? 'shipment' : 'request'
    cols[col].push({ ...d, kind } as WallCard)
  }
  for (const k of Object.keys(cols) as WallColumn[]) cols[k] = sortCards(cols[k])
  return cols
}

/** Priority (Urgent, then Low stock ⚑) first, then the oldest (longest waiting) on top. */
export function sortCards<T extends { priority?: string | null; age_seconds?: number }>(cards: T[]): T[] {
  return [...cards].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || (b.age_seconds || 0) - (a.age_seconds || 0))
}

export function priorityRank(p?: string | null): number {
  return p === 'Urgent' ? 2 : p === 'Low stock' ? 1 : 0
}

export function isFlagged(p?: string | null): boolean {
  return priorityRank(p) > 0
}

/** Age tier from seconds — `warn` at 4 h, `crit` at 24 h by default (server thresholds override). */
export function ageTier(seconds: number, warn = DEFAULT_WARN_S, crit = DEFAULT_CRIT_S): AgeTier {
  if (seconds >= crit) return 'crit'
  if (seconds >= warn) return 'warn'
  return 'ok'
}

/** "12m" · "3h 05m" · "1d 2h" — big-type friendly. */
export function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

/** Age right now, given the age the server reported and when it reported it (cards tick locally). */
export function liveAge(card: { age_seconds?: number }, fetchedAt: number, now = Date.now()): number {
  return (card.age_seconds || 0) + Math.max(0, Math.floor((now - fetchedAt) / 1000))
}

// ---------------------------------------------------------------------------------------------
// v1.0 §F — the Inbound column
// ---------------------------------------------------------------------------------------------
/** Seconds an expected delivery is overdue: whole days past its ETA, 0 while it is still due. */
export function overdueSeconds(eta: string, today: string): number {
  return overdueDays(eta, today) * 86400
}

/** `ok` until the ETA passes, `warn` a day late, `crit` three days late — through the same tierer. */
export function inboundTier(card: Pick<InboundCard, 'age_seconds'>): AgeTier {
  return ageTier(card.age_seconds || 0, INBOUND_WARN_S, INBOUND_CRIT_S)
}

/**
 * Turn the expected vendor orders (`purchasing.inbound().expected`) into wall cards. Quantities are
 * what is still **outstanding**, not what was ordered — the floor is waiting for the rest, not for
 * the part that already landed.
 */
export function inboundCards(orders: PurchaseOrderWithItems[], opts: { leadTimes?: Record<string, number>; today: string; warehouse?: string } = { today: '' }): InboundCard[] {
  const today = opts.today
  const cards: InboundCard[] = []
  for (const order of orders || []) {
    const lines = (order.items || []).filter((l) => Number(l.pending_qty) > 0)
    const eta = etaOf(order, opts.leadTimes || {}, today || new Date())
    const late = overdueDays(eta, today)
    cards.push({
      kind: 'inbound',
      name: order.name,
      supplier: order.supplier,
      supplier_name: order.supplier_name ?? null,
      boutique: order.dropship_store || opts.warehouse || order.set_warehouse || '',
      boutique_name: order.supplier_name || order.supplier,
      status: order.status,
      items: lines.length,
      units: lines.reduce((sum, l) => sum + Number(l.pending_qty || 0), 0),
      units_ordered: Number(order.units || 0),
      per_received: Number(order.per_received || 0),
      eta,
      overdue_days: late,
      age_seconds: late * 86400,
      priority: null,
      dropship_store: order.dropship_store ?? null
    })
  }
  return sortInboundCards(cards)
}

/**
 * Most overdue first, then the soonest ETA. `sortCards` orders by priority then age; a pre-sort on
 * the ETA gives the not-yet-due cards (all age 0) a meaningful order under its stable sort.
 */
export function sortInboundCards(cards: InboundCard[]): InboundCard[] {
  const byEta = [...(cards || [])].sort((a, b) => (a.eta || '').localeCompare(b.eta || '') || a.name.localeCompare(b.name))
  return sortCards(byEta)
}

// ---------------------------------------------------------------------------------------------
// rate selection
// ---------------------------------------------------------------------------------------------
export type Prefer = 'cheapest' | 'fastest'

export function selectRate(rates: Rate[], prefer: Prefer = 'cheapest'): Rate | null {
  if (!rates.length) return null
  const sorted = [...rates].sort(prefer === 'fastest' ? (a, b) => (a.days ?? 99) - (b.days ?? 99) || a.amount - b.amount : (a, b) => a.amount - b.amount || (a.days ?? 99) - (b.days ?? 99))
  return sorted[0]
}

/** Rates in display order for the chooser: cheapest first; badges for CHEAPEST / FASTEST. */
export function rateRows(rates: Rate[]): (Rate & { badges: string[] })[] {
  const cheapest = selectRate(rates, 'cheapest')?.provider_rate_id
  const fastest = selectRate(rates, 'fastest')?.provider_rate_id
  return [...rates]
    .sort((a, b) => a.amount - b.amount || (a.days ?? 99) - (b.days ?? 99))
    .map((r) => ({ ...r, badges: [...(r.provider_rate_id === cheapest ? ['Cheapest'] : []), ...(r.provider_rate_id === fastest ? ['Fastest'] : [])] }))
}

// ---------------------------------------------------------------------------------------------
// diffing: what changed between two wall snapshots (sound / flash / auto-print)
// ---------------------------------------------------------------------------------------------
export interface WallDiff {
  /** shipments that appeared in To pick (newly approved) → sound + flash + packing list print */
  approved: string[]
  /** shipments that appeared in Ready (label bought) → label print */
  labelled: string[]
  /** new pending requests */
  requested: string[]
}

function names(cards: { name: string }[] | undefined): Set<string> {
  return new Set((cards || []).map((c) => c.name))
}

export function diffWall(prev: WallData['columns'] | null, next: WallData['columns']): WallDiff {
  if (!prev) return { approved: [], labelled: [], requested: [] }
  const seenBefore = new Set<string>()
  for (const k of Object.keys(prev) as WallColumn[]) for (const c of prev[k] || []) seenBefore.add(c.name)
  const wasReady = names(prev.ready)
  const wasShipped = names(prev.shipped_today)
  return {
    approved: (next.to_pick || []).map((c) => c.name).filter((n) => !seenBefore.has(n)),
    labelled: (next.ready || []).map((c) => c.name).filter((n) => !wasReady.has(n) && !wasShipped.has(n)),
    requested: (next.pending_approval || []).map((c) => c.name).filter((n) => !seenBefore.has(n))
  }
}

/** Which print jobs a realtime event asks for (the wall page opens them in a hidden iframe). */
export function printJobsFor(ev: WallEvent, settings: { auto_print_packing_list: boolean; auto_print_label: boolean }, packingListUrl: (shipment: string) => string): { kind: 'packing_list' | 'label'; url: string; shipment: string }[] {
  const jobs: { kind: 'packing_list' | 'label'; url: string; shipment: string }[] = []
  if (!ev.shipment) return jobs
  if (ev.event === 'approved' && settings.auto_print_packing_list && ev.print_packing_list !== false) jobs.push({ kind: 'packing_list', url: packingListUrl(ev.shipment), shipment: ev.shipment })
  if (ev.event === 'label' && settings.auto_print_label && ev.label_url && ev.print_label !== false) jobs.push({ kind: 'label', url: ev.label_url, shipment: ev.shipment })
  return jobs
}

/** Next action button for a card, by column. */
export function primaryAction(col: WallColumn): { label: string; action: 'approve' | 'pick' | 'packed' | 'buy' | 'ship' | 'none' } {
  switch (col) {
    case 'pending_approval':
      return { label: 'Approve', action: 'approve' }
    case 'to_pick':
      return { label: 'Pick', action: 'pick' }
    case 'packing':
      return { label: 'Buy label', action: 'buy' }
    case 'ready':
      return { label: 'Ship', action: 'ship' }
    default:
      return { label: '', action: 'none' }
  }
}

export function totalUnits(cards: { units?: number }[]): number {
  return cards.reduce((s, c) => s + (c.units || 0), 0)
}
