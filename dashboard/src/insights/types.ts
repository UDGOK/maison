// v0.4 H — insights payloads (maison_pos.api.insights)

export interface PerfItemRow {
  item_code: string
  item_name: string
  item_group: string
  boutique: string
  units: number
  revenue: number
  on_hand: number
  velocity: number // units / week
  days_on_hand: number | null // null = nothing sold in the period
  sell_through: number
  stock_out_risk: boolean
  chain_velocity: number
  index: number | null
  rate: number
  is_stock_item: 0 | 1
  has_serial_no: 0 | 1
}

export interface HeatCell {
  item_group: string
  boutique: string
  revenue: number
  units: number
  on_hand: number
  index: number | null // revenue vs chain average for the group (1 = average)
}

export interface RebalanceMove {
  name?: string
  item_code: string
  item_name: string
  item_group?: string
  from_boutique: string
  to_boutique: string
  qty: number
  value: number
  from_on_hand: number
  to_on_hand: number
  from_velocity: number
  to_velocity: number
  from_days_on_hand: number | null
  to_days_on_hand: number | null
  reason: string
  status?: 'Open' | 'Transferred' | 'Dismissed'
  material_transfer?: string | null
  can_transfer?: boolean
}

export interface ProductPerformance {
  period: { from: string; to: string; days: number }
  boutiques: string[]
  item_groups: string[]
  items: PerfItemRow[]
  heatmap: HeatCell[]
  top_movers: Record<string, PerfItemRow[]>
  slow_movers: Record<string, PerfItemRow[]>
  rebalance: RebalanceMove[]
  totals: { revenue: number; units: number; stock_out_risks: number }
}

export type SignalType = 'Overdue visit' | 'Due this week' | 'Birthday' | 'Anniversary' | 'Spend drop' | 'VIP lapsing' | 'New client follow-up'

export interface ClientSignal {
  name: string
  customer: string
  customer_name: string
  boutique: string | null
  preferred_associate?: string | null
  signal_type: SignalType
  priority: number
  status: 'Open' | 'Contacted' | 'Dismissed'
  week: string
  reason: string
  recommended_item?: string | null
  recommended_item_name?: string | null
  churn_risk: number
  cadence_days: number
  expected_next_visit?: string | null
  last_visit?: string | null
  days_since_last_visit?: number | null
  visits: number
  lifetime_spend: number
  spend_trend: number
  preferred_department?: string | null
  preferred_metal?: string | null
  mobile_no?: string | null
  email_id?: string | null
  client_number?: string | null
}

export interface ClientSignalsResult {
  boutique: string | null
  signals: ClientSignal[]
  by_type: Record<string, number>
  week: string
}

export interface InsightReport {
  name: string
  title: string
  period_start: string
  period_end: string
  generator: 'Template' | 'Anthropic'
  model?: string | null
  generated_at?: string
  net: number
  invoices: number
  change_pct: number | null
  narrative: string
  emailed_to?: string | null
  error?: string | null
}

export interface InsightsSummary {
  open_signals: number
  open_rebalances: number
  recommended_clients: number
  latest_report: { name: string; title: string; period_end: string; generator: string } | null
  last_run: { computed_at?: string } | null
  llm: boolean
}
