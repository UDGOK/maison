export type BoutiqueStatus = 'online' | 'offline' | 'pending_approval' | 'queued'

export interface Totals {
  net: number
  invoices: number
  cash: number
  card: number
  avg_ticket: number
}

export interface LastSaleSummary {
  invoice?: string
  item: string | null
  amount: number
  ts: string
  is_return?: number
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
  /** v0.5 L */
  city?: string | null
  region?: string
  returns?: number
  returns_value?: number
  avg_ticket?: number
  conversion?: number
  last_week_net?: number
  vs_last_week_pct?: number | null
  last_sale?: LastSaleSummary | null
  low_stock?: number
  feedback_open?: number
  by_hour?: number[]
}

export interface HourBucket {
  hour: number // 0..23
  net: number
  invoices: number
}

export interface LiveTotals extends Totals {
  returns?: number
  returns_value?: number
  online?: number
  boutiques?: number
  last_week_net?: number
  vs_last_week_pct?: number | null
  low_stock?: number
  feedback_open?: number
  pending_approvals?: number
}

export interface LiveSummary {
  date?: string
  generated_at?: string
  cached?: boolean
  totals: LiveTotals
  regions?: string[]
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
  /** v0.5 L — highest-value line */
  top_item?: string | null
  is_return?: boolean
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

// ---------------------------------------------------------------------------
// v0.5 L — Command payloads (maison_pos.api.dashboard v2)
// ---------------------------------------------------------------------------
export interface TickerRow {
  invoice: string
  boutique: string
  amount: number
  top_item: string | null
  items: number
  tier: string | null
  ts: string
  is_return: number
}

export interface FeedSale {
  invoice: string
  boutique: string
  customer?: string | null
  customer_name?: string | null
  amount: number
  posting_datetime: string
  associate?: string | null
  is_return: number
  items: { item_code: string; item_name: string; qty: number; amount: number; serial_no?: string | null }[]
  top_item: string | null
}

export interface BoutiqueFeed {
  boutique: string
  date: string
  sales: FeedSale[]
  by_hour: HourBucket[]
}

export interface BoutiqueTableRow extends BoutiqueRow {
  wtd_net: number
  mtd_net: number
  wtd_vs_lw_pct: number | null
  mtd_tickets: number
  mtd_avg_ticket: number
  mtd_conversion: number
  returns_pct: number
  stock_value: number
  on_shift: number
  sparkline: number[]
}

export interface BoutiqueDetail {
  boutique: string
  row: BoutiqueRow | null
  period: { from: string; to: string; days: number }
  by_hour: HourBucket[]
  recent_sales: FeedSale[]
  top_items: { item_code: string; item_name: string; units: number; net: number }[]
  associates: { associate: string; associate_name: string | null; tickets: number; net: number; with_customer: number; avg_ticket: number; conversion: number }[]
  alerts: LowStockAlert[]
  feedback: { name: string; rating: number; comment: string | null; status: string; creation: string }[]
  sparkline: number[]
}

export type TrendBadge = 'Trending up' | 'New' | 'Cooling' | 'Steady' | ''
export type TrendPeriod = '7d' | '28d'

export interface TrendRow {
  item_code: string
  item_name: string
  item_group: string | null
  boutique: string
  period: TrendPeriod
  badge: TrendBadge
  rank: number
  rank_units: number
  store_count: number
  units: number
  units_prev: number
  units_baseline: number
  net: number
  net_prev: number
  velocity: number
  delta_pct: number | null
  baseline_delta_pct: number | null
  share_pct: number
  has_prev: number
  on_hand: number
  sell_through: number
  days_on_hand: number | null
  period_from: string
  period_to: string
  computed_at: string
}

export interface ProductTrends {
  scope: 'chain' | 'boutique'
  boutique: string
  period: TrendPeriod
  group: string | null
  rows: TrendRow[]
  total: number
  badges: Record<string, number>
  groups: string[]
  computed_at: string | null
  last_run: { computed_at?: string; rows?: number; seconds?: number } | null
  cached?: boolean
}

export interface MatrixCell {
  item_group: string
  boutique: string
  revenue: number
  units: number
  on_hand: number
  index: number | null
}

export interface TopProducts {
  period: TrendPeriod
  by: 'net' | 'units'
  n: number
  boutiques: string[]
  top: Record<string, TrendRow[]>
  matrix: MatrixCell[]
  groups: string[]
  boutique_net: Record<string, number>
  last_run: { computed_at?: string } | null
  cached?: boolean
}

export interface ChurnRow {
  name: string
  customer: string
  customer_name: string
  boutique: string | null
  preferred_associate: string | null
  signal_type: string
  priority: number
  reason: string
  churn_risk: number
  cadence_days: number
  expected_next_visit: string | null
  last_visit: string | null
  days_since_last_visit: number | null
  visits: number
  lifetime_spend: number
  spend_trend: number
  tier: string | null
}

export interface FollowUpRow {
  associate: string
  associate_name: string | null
  boutique: string | null
  assigned: number
  completed: number
  rate: number
}

export interface PerformanceRow {
  associate: string
  associate_name?: string | null
  boutique?: string
  sales: number
  tickets: number
  returns: number
  with_client: number
  follow_ups_done: number
  commission: number
  avg_ticket: number
  conversion: number
  follow_up_rate?: number
  returns_rate?: number
  recognition_enrolments?: number
}

export interface ClientsOverview {
  boutique: string | null
  tiers: string[]
  churn: ChurnRow[]
  upcoming: ChurnRow[]
  follow_ups: FollowUpRow[]
  performance: PerformanceRow[]
  campaigns: Record<string, unknown> | null
  recognition: Record<string, number>
  as_of: string
}
