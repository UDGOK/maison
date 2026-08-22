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
  /** v0.4 D — low-stock tile */
  low_stock?: LowStockBlock
  /** v0.4 E — today's credit notes */
  returns?: { count: number; value: number }
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

// ---------------------------------------------------------------------------
// v0.4 D/F — inventory tile, reports, period comparison
// ---------------------------------------------------------------------------
export interface LowStockAlert {
  name: string
  item_code: string
  item_name?: string
  boutique: string
  qty: number
  reorder_level: number
  status: 'Open' | 'Acknowledged' | 'Resolved'
}
export interface LowStockBlock {
  open: number
  by_boutique: Record<string, number>
  top: LowStockAlert[]
}

export interface ReportLink {
  name: string
  group: string
  description: string
  installed: boolean
  url: string
  csv: string
}

export interface PeriodTotals {
  net: number
  gross: number
  tax: number
  tickets: number
  returns: number
  returns_value: number
  avg_ticket: number
}
export interface PeriodBlock {
  label: string
  current: PeriodTotals
  previous: PeriodTotals
  delta: Record<string, number>
  pct: Record<string, number | null>
  range: { from: string; to: string }
  previous_range: { from: string; to: string }
}
export type PeriodKind = 'today_vs_same_weekday' | 'wtd' | 'mtd' | 'ytd'
export interface PeriodComparison {
  boutiques: string[]
  periods: Record<PeriodKind, PeriodBlock>
  as_of: string
}
