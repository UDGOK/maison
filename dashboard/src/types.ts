export type BoutiqueStatus = 'online' | 'offline' | 'pending_approval'

export interface Totals {
  net: number
  invoices: number
  cash: number
  card: number
  avg_ticket: number
}

export interface BoutiqueRow {
  boutique: string // store code e.g. CHI-OAK
  name: string // display name
  net: number
  cash: number
  card: number
  invoices: number
  status: BoutiqueStatus
  last_seen: string | null // ISO datetime
  queued?: number
  pending_approvals?: number
  last_sale?: string | null // ISO datetime
}

export interface HourBucket {
  hour: number // 0..23
  net: number
  invoices: number
}

export interface LiveSummary {
  totals: Totals
  by_boutique: BoutiqueRow[]
  by_hour: HourBucket[]
  pending_approvals: number
}

export interface SaleEvent {
  invoice: string
  boutique: string
  boutique_name?: string
  posting_datetime: string // ISO
  customer_name?: string
  tier?: string
  items: string[]
  net: number
  cash: number
  card: number
}

export interface HeartbeatEvent {
  boutique: string
  device_id: string
  queued: number
  pending_approvals?: number
  ts: string // ISO
}
