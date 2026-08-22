import type { BoutiqueDetail, BoutiqueFeed, BoutiqueRow, BoutiqueTableRow, ClientsOverview, HeartbeatEvent, LiveSummary, PeriodComparison, PeriodTotals, ProductTrends, ReportLink, SaleEvent, TickerRow, TopProducts, TrendPeriod, TrendRow } from './types'
import { bucketByHour, computeTotals, deriveStatus } from './lib/aggregate'

const BASE_BOUTIQUES: { code: string; name: string; region: string }[] = [
  { code: 'PAR-VEN', name: 'Paris · Vendôme', region: 'Europe' },
  { code: 'LON-BND', name: 'London · Bond St', region: 'Europe' },
  { code: 'NYC-MAD', name: 'New York · Madison', region: 'Americas' },
  { code: 'GVA-RHN', name: 'Geneva · Rhône', region: 'Europe' },
  { code: 'MIL-MNT', name: 'Milan · Montenapoleone', region: 'Europe' },
  { code: 'DXB-MAL', name: 'Dubai · Mall', region: 'Middle East' },
  { code: 'HKG-CNT', name: 'Hong Kong · Central', region: 'Asia' },
  { code: 'TYO-GNZ', name: 'Tokyo · Ginza', region: 'Asia' },
]
/** VITE_MOCK_BOUTIQUES=100 renders a 100-store chain to exercise virtualisation. */
const N_MOCK = Number(import.meta.env.VITE_MOCK_BOUTIQUES || 0)
const CITIES = ['Lyon', 'Munich', 'Zurich', 'Vienna', 'Madrid', 'Lisbon', 'Osaka', 'Seoul', 'Singapore', 'Sydney', 'Toronto', 'Chicago', 'Miami', 'Dallas', 'Doha', 'Riyadh', 'Shanghai', 'Taipei', 'Mumbai', 'Bangkok']
const REGIONS = ['Europe', 'Europe', 'Europe', 'Europe', 'Europe', 'Europe', 'Asia', 'Asia', 'Asia', 'Asia', 'Americas', 'Americas', 'Americas', 'Americas', 'Middle East', 'Middle East', 'Asia', 'Asia', 'Asia', 'Asia']
export const BOUTIQUES: { code: string; name: string; region: string }[] = N_MOCK > BASE_BOUTIQUES.length
  ? [...BASE_BOUTIQUES, ...Array.from({ length: N_MOCK - BASE_BOUTIQUES.length }, (_, i) => ({ code: `${CITIES[i % CITIES.length]!.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(2, '0')}`, name: `${CITIES[i % CITIES.length]} · ${i + 1}`, region: REGIONS[i % REGIONS.length]! }))]
  : BASE_BOUTIQUES

const ITEMS = [
  ['Éclat Solitaire 1.2ct', 18400],
  ['Lune Tennis Bracelet', 9600],
  ['Astre Hoops, 18k', 2900],
  ['Sillage Pendant', 4200],
  ['Méridien Chronograph', 27500],
  ['Onde Band, Platinum', 3100],
  ['Brume Pearl Strand', 6800],
  ['Aube Studs 0.5ct', 5400],
  ['Voûte Signet', 2200],
  ['Lustre Cuff', 7900],
  ['Nacre Drop Earrings', 3600],
  ['Orbe Cocktail Ring', 12800],
] as const

const TIERS = ['Member', 'Member', 'Silver', 'Gold', 'Gold', 'Platinum', 'Noir']
const FIRST = ['A. Moreau', 'L. Chen', 'S. Al-Rashid', 'M. Rossi', 'K. Tanaka', 'E. Hartley', 'N. Okafor', 'V. Petrov', 'I. Lindqvist']

let seed = 7
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!

let invoiceSeq = 1040

export function mockSale(at = new Date()): SaleEvent {
  const b = pick(BOUTIQUES)
  const n = rnd() < 0.7 ? 1 : rnd() < 0.7 ? 2 : 3
  const items: string[] = []
  let net = 0
  for (let i = 0; i < n; i++) {
    const it = pick(ITEMS)
    items.push(it[0])
    net += it[1]
  }
  const cardShare = rnd() < 0.78 ? 1 : rnd() < 0.5 ? 0 : 0.5
  const card = Math.round(net * cardShare)
  return {
    invoice: `SINV-${String(invoiceSeq++).padStart(5, '0')}`,
    boutique: b.code,
    boutique_name: b.name,
    posting_datetime: at.toISOString(),
    customer_name: pick(FIRST),
    tier: pick(TIERS),
    items,
    top_item: items[0] ?? null,
    is_return: false,
    net,
    card,
    cash: net - card,
  }
}

/** Build a plausible day-so-far: sales spread from 10:00 until now, roughly bell-shaped. */
export function mockLiveSummary(now = new Date()): LiveSummary {
  const open = new Date(now)
  open.setHours(10, 0, 0, 0)
  const sales: SaleEvent[] = []
  const span = Math.max(0, now.getTime() - open.getTime())
  const count = Math.floor(span / 60_000 / 3.2) // ~one sale per 3 min across chain
  for (let i = 0; i < count; i++) {
    const t = new Date(open.getTime() + rnd() * span)
    sales.push(mockSale(t))
  }
  sales.sort((a, b) => a.posting_datetime.localeCompare(b.posting_datetime))

  const rows: BoutiqueRow[] = BOUTIQUES.map((b, i) => {
    const mine = sales.filter((s) => s.boutique === b.code)
    const ageSec = i === 5 ? 900 : i === 2 ? 30 : 10 + Math.floor(rnd() * 50)
    const last_seen = new Date(now.getTime() - ageSec * 1000).toISOString()
    const pending = i === 2 ? 1 : 0
    const net = mine.reduce((a, s) => a + s.net, 0)
    const lw = Math.round(net * (0.7 + rnd() * 0.6))
    const last = mine[mine.length - 1]
    const by_hour = new Array<number>(24).fill(0)
    for (const s of mine) by_hour[new Date(s.posting_datetime).getHours()]! += s.net
    return {
      boutique: b.code,
      name: b.name,
      region: b.region,
      net,
      cash: mine.reduce((a, s) => a + s.cash, 0),
      card: mine.reduce((a, s) => a + s.card, 0),
      invoices: mine.length,
      returns: i % 4 === 0 ? 1 : 0,
      returns_value: i % 4 === 0 ? 2900 : 0,
      status: deriveStatus(last_seen, now, pending),
      last_seen,
      queued: i === 5 ? 3 : 0,
      pending_approvals: pending,
      low_stock: i % 3 === 0 ? 1 : 0,
      feedback_open: i === 1 ? 1 : 0,
      last_week_net: lw,
      vs_last_week_pct: lw > 0 ? Math.round(((net - lw) / lw) * 1000) / 10 : null,
      last_sale: last ? { invoice: last.invoice, item: last.top_item ?? null, amount: last.net, ts: last.posting_datetime, is_return: 0 } : null,
      by_hour,
    }
  })

  const totals = computeTotals(rows)
  const lwTotal = rows.reduce((a, r) => a + (r.last_week_net ?? 0), 0)
  return {
    totals: { ...totals, returns: rows.reduce((a, r) => a + (r.returns ?? 0), 0), returns_value: rows.reduce((a, r) => a + (r.returns_value ?? 0), 0), last_week_net: lwTotal, vs_last_week_pct: lwTotal ? ((totals.net - lwTotal) / lwTotal) * 100 : null, low_stock: mockLowStock()!.open, feedback_open: 1, online: rows.filter((r) => r.status !== 'offline').length, boutiques: rows.length },
    regions: [...new Set(rows.map((r) => r.region!))].sort(),
    by_boutique: rows,
    by_hour: bucketByHour(sales),
    pending_approvals: rows.reduce((a, r) => a + (r.pending_approvals ?? 0), 0),
    low_stock: mockLowStock(),
    returns: { count: 3, value: 6420 },
    // extra: recent sales so the feed isn't empty on load
    ...({ recent: sales.slice(-12) } as object),
  }
}

export function mockHeartbeat(code: string, queued = 0): HeartbeatEvent {
  return { boutique: code, device_id: `ipad-${code.toLowerCase()}-1`, queued, ts: new Date().toISOString() }
}

/** Simulated stream: a sale every 3–8s, heartbeats every 20s (one boutique stays silent). */
export function startMockStream(onSale: (s: SaleEvent) => void, onHeartbeat: (h: HeartbeatEvent) => void): () => void {
  let saleTimer: number
  const scheduleSale = () => {
    saleTimer = window.setTimeout(() => {
      onSale(mockSale())
      scheduleSale()
    }, 3000 + rnd() * 5000)
  }
  scheduleSale()
  const hb = window.setInterval(() => {
    for (const b of BOUTIQUES) {
      if (b.code === 'DXB-MAL') continue // stays offline with queued sales
      onHeartbeat(mockHeartbeat(b.code, 0))
    }
  }, 20_000)
  return () => {
    clearTimeout(saleTimer)
    clearInterval(hb)
  }
}

// ---------------------------------------------------------------------------
// v0.4 D/F — mock low-stock block, reports catalogue, period comparison
// ---------------------------------------------------------------------------
export function mockLowStock(): LiveSummary['low_stock'] {
  const top = [
    { name: 'MSA-2026-00001', item_code: 'AC-007', item_name: 'Pearl Strand 18 inch Akoya', boutique: 'NYC-MAD', qty: 1, reorder_level: 2, status: 'Open' as const },
    { name: 'MSA-2026-00002', item_code: 'BR-009', item_name: 'Full Eternity Band 1.5ct', boutique: 'PAR-VEN', qty: 0, reorder_level: 2, status: 'Open' as const },
    { name: 'MSA-2026-00003', item_code: 'AC-012', item_name: 'Silk Pocket Square', boutique: 'LON-BND', qty: 6, reorder_level: 12, status: 'Acknowledged' as const },
    { name: 'MSA-2026-00004', item_code: 'AC-010', item_name: 'Leather Watch Strap Alligator', boutique: 'DXB-MAL', qty: 4, reorder_level: 10, status: 'Open' as const },
    { name: 'MSA-2026-00005', item_code: 'BR-006', item_name: 'Classic Wedding Band 2mm Platinum', boutique: 'NYC-MAD', qty: 3, reorder_level: 4, status: 'Open' as const },
  ]
  const by_boutique: Record<string, number> = {}
  for (const t of top) by_boutique[t.boutique] = (by_boutique[t.boutique] || 0) + 1
  return { open: top.length, by_boutique, top }
}

export function mockReports(): ReportLink[] {
  const rows: [string, string, string][] = [
    ['Maison Sales Tax Summary', 'Tax', 'Taxable vs non-taxable sales, tax collected, returns netted — by boutique / jurisdiction. CSV for filings.'],
    ['Maison Daily Sales', 'Sales', 'Per boutique per day: gross, discounts, returns, net, tax, cash, card, tickets, avg ticket, items/ticket.'],
    ['Maison Sales by Item', 'Sales', 'By item, item group or department; returns netted.'],
    ['Maison Sales by Associate', 'Sales', 'Tickets, net sales, avg ticket, clients attached per associate.'],
    ['Maison Hourly Sales Heatmap', 'Sales', 'Weekday × hour net sales per boutique.'],
    ['Maison Client Purchases', 'Clients', 'RFM per client: recency, frequency, monetary, tier, lifetime.'],
    ['Maison Serial Ledger', 'Inventory', 'Every serial: received → sold / returned / transferred, current location.'],
    ['Maison Returns', 'Returns', 'Credit notes by reason / boutique / associate, or line detail.'],
  ]
  return rows.map(([name, group, description]) => ({ name, group, description, installed: true, url: `/app/query-report/${encodeURIComponent(name)}`, csv: `/api/method/maison_pos.api.reports.export?report=${encodeURIComponent(name)}` }))
}

function periodTotals(net: number, tickets: number, returns: number): PeriodTotals {
  const gross = Math.round(net * 1.0925)
  return { net, gross, tax: gross - net, tickets, returns, returns_value: Math.round(returns * 1900), avg_ticket: tickets ? Math.round((gross / tickets) * 100) / 100 : 0 }
}

export function mockPeriodComparison(): PeriodComparison {
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const mk = (label: string, cur: PeriodTotals, prev: PeriodTotals, days: number): PeriodComparison['periods']['mtd'] => {
    const delta: Record<string, number> = {}
    const pct: Record<string, number | null> = {}
    for (const k of ['net', 'gross', 'tickets', 'avg_ticket', 'returns_value'] as const) {
      delta[k] = Math.round((cur[k] - prev[k]) * 100) / 100
      if (k !== 'returns_value') pct[k] = prev[k] ? Math.round(((cur[k] - prev[k]) / prev[k]) * 1000) / 10 : null
    }
    const from = new Date(today.getTime() - days * 86400000)
    return { label, current: cur, previous: prev, delta, pct, range: { from: iso(from), to: iso(today) }, previous_range: { from: iso(new Date(from.getTime() - (days + 1) * 86400000)), to: iso(new Date(today.getTime() - (days + 1) * 86400000)) } }
  }
  return {
    boutiques: BOUTIQUES.map((b) => b.code),
    as_of: iso(today),
    periods: {
      today_vs_same_weekday: mk('Today vs same weekday last week', periodTotals(186400, 41, 2), periodTotals(171900, 38, 1), 0),
      wtd: mk('Week to date vs last week', periodTotals(642300, 148, 6), periodTotals(688100, 155, 4), today.getDay() || 7),
      mtd: mk('Month to date vs last month', periodTotals(2893500, 655, 19), periodTotals(2410200, 560, 23), today.getDate() - 1),
      ytd: mk('Year to date vs last year', periodTotals(21475000, 4890, 142), periodTotals(18620000, 4410, 160), 234),
    },
  }
}


// ---------------------------------------------------------------------------
// v0.5 L — Command mocks
// ---------------------------------------------------------------------------
const GROUPS = ['High Jewellery', 'Timepieces', 'Bridal', 'Accessories', 'Services']
const today = () => new Date().toISOString().slice(0, 10)

export function mockTicker(limit = 10): TickerRow[] {
  return Array.from({ length: limit }, (_, i) => {
    const s = mockSale(new Date(Date.now() - i * 90_000))
    return { invoice: s.invoice, boutique: s.boutique, amount: s.net, top_item: s.top_item ?? null, items: s.items.length, tier: s.tier ?? null, ts: s.posting_datetime, is_return: 0 }
  })
}

export function mockBoutiqueFeed(boutique: string, limit = 30): BoutiqueFeed {
  const sales = Array.from({ length: Math.min(limit, 14) }, (_, i) => {
    const s = mockSale(new Date(Date.now() - i * 11 * 60_000))
    return { invoice: s.invoice, boutique, amount: s.net, posting_datetime: s.posting_datetime, is_return: i === 5 ? 1 : 0, top_item: s.top_item ?? null, items: s.items.map((n, j) => ({ item_code: `IT-${j}`, item_name: n, qty: 1, amount: s.net / s.items.length, serial_no: j === 0 ? `${boutique}-${1000 + i}` : null })) }
  })
  return { boutique, date: today(), sales, by_hour: bucketByHour(sales.map((s) => ({ posting_datetime: s.posting_datetime, net: s.amount }))) }
}

export function mockBoutiquesTable(): { date: string; rows: BoutiqueTableRow[] } {
  const live = mockLiveSummary()
  return {
    date: today(),
    rows: live.by_boutique.map((r, i) => {
      const spark = Array.from({ length: 14 }, () => Math.round(20000 + rnd() * 90000))
      spark[13] = r.net
      const wtd = spark.slice(8).reduce((a, b) => a + b, 0)
      const lw = spark.slice(1, 7).reduce((a, b) => a + b, 0)
      return { ...r, avg_ticket: r.invoices ? r.net / r.invoices : 0, conversion: 0.3 + rnd() * 0.4, wtd_net: wtd, mtd_net: wtd * 3.2, wtd_vs_lw_pct: lw ? Math.round(((wtd - lw) / lw) * 1000) / 10 : null, mtd_tickets: 60 + i * 7, mtd_avg_ticket: 8200 + i * 300, mtd_conversion: 0.35 + (i % 5) * 0.08, returns_pct: (i % 4) * 3.1, stock_value: 900000 + i * 120000, on_shift: 2 + (i % 3), sparkline: spark }
    }),
  }
}

export function mockBoutiqueDetail(boutique: string, days = 28): BoutiqueDetail {
  const live = mockLiveSummary()
  const row = live.by_boutique.find((b) => b.boutique === boutique) ?? null
  const feed = mockBoutiqueFeed(boutique, 20)
  return {
    boutique,
    row,
    period: { from: new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10), to: today(), days },
    by_hour: feed.by_hour,
    recent_sales: feed.sales,
    top_items: ITEMS.slice(0, 8).map((it, i) => ({ item_code: `IT-${i}`, item_name: it[0], units: 9 - i, net: it[1] * (9 - i) })),
    associates: FIRST.slice(0, 5).map((n, i) => ({ associate: n, associate_name: n, tickets: 30 - i * 4, net: 420000 - i * 60000, with_customer: 12 - i, avg_ticket: (420000 - i * 60000) / (30 - i * 4), conversion: (12 - i) / (30 - i * 4) })),
    alerts: mockLowStock()!.top.slice(0, 3).map((a) => ({ ...a, boutique })),
    feedback: [
      { name: 'FB-1', rating: 5, comment: 'Wonderful attention from Anaïs.', status: 'New', creation: new Date().toISOString() },
      { name: 'FB-2', rating: 2, comment: 'Waited twenty minutes at the counter.', status: 'New', creation: new Date(Date.now() - 3600000).toISOString() },
    ],
    sparkline: Array.from({ length: 14 }, () => Math.round(20000 + rnd() * 90000)),
  }
}

function trendRow(i: number, boutique: string, period: TrendPeriod): TrendRow {
  const it = ITEMS[i % ITEMS.length]!
  const units = Math.round(2 + rnd() * 30)
  const prev = i % 6 === 0 ? 0 : Math.round(1 + rnd() * 30)
  const base = (units + prev * 3) / 4
  const delta = prev ? Math.round(((units - prev) / prev) * 1000) / 10 : null
  const badge = prev === 0 ? 'New' : delta! >= 25 ? 'Trending up' : delta! <= -25 ? 'Cooling' : 'Steady'
  const on_hand = Math.round(rnd() * 40)
  return { item_code: `IT-${String(i).padStart(3, '0')}`, item_name: it[0], item_group: GROUPS[i % GROUPS.length]!, boutique, period, badge, rank: i + 1, rank_units: i + 1, store_count: 1 + (i % 7), units, units_prev: prev, units_baseline: base, net: units * it[1], net_prev: prev * it[1], velocity: units / (period === '7d' ? 1 : 4), delta_pct: delta, baseline_delta_pct: base ? Math.round(((units - base) / base) * 1000) / 10 : null, share_pct: Math.round((30 / (i + 2)) * 100) / 100, has_prev: prev ? 1 : 0, on_hand, sell_through: units / (units + on_hand), days_on_hand: units ? Math.round((on_hand / (units / (period === '7d' ? 7 : 28))) * 10) / 10 : null, period_from: today(), period_to: today(), computed_at: new Date().toISOString() }
}

export function mockProductTrends(args: { period?: TrendPeriod; group?: string | null; badge?: string | null; limit?: number }): ProductTrends {
  const period = args.period ?? '7d'
  let rows = Array.from({ length: 40 }, (_, i) => trendRow(i, 'ALL', period))
  rows.sort((a, b) => (a.delta_pct === null ? 1 : 0) - (b.delta_pct === null ? 1 : 0) || (b.delta_pct ?? 0) - (a.delta_pct ?? 0))
  const badges: Record<string, number> = {}
  for (const r of rows) badges[r.badge] = (badges[r.badge] ?? 0) + 1
  if (args.group) rows = rows.filter((r) => r.item_group === args.group)
  if (args.badge) rows = rows.filter((r) => r.badge === args.badge)
  return { scope: 'chain', boutique: 'ALL', period, group: args.group ?? null, rows: rows.slice(0, args.limit ?? 60), total: rows.length, badges, groups: GROUPS, computed_at: new Date().toISOString(), last_run: { computed_at: new Date().toISOString(), rows: 274, seconds: 0.2 } }
}

export function mockTopProducts(args: { boutique?: string; by?: 'net' | 'units'; period?: TrendPeriod; n?: number }): TopProducts {
  const period = args.period ?? '7d'
  const boutiques = args.boutique && args.boutique !== 'all' ? [args.boutique] : BOUTIQUES.slice(0, 4).map((b) => b.code)
  const top: Record<string, TrendRow[]> = {}
  const matrix: TopProducts['matrix'] = []
  const boutique_net: Record<string, number> = {}
  for (const b of boutiques) {
    const rows = Array.from({ length: args.n ?? 10 }, (_, i) => trendRow(i, b, period))
    rows.sort((x, y) => (args.by === 'units' ? y.units - x.units : y.net - x.net))
    rows.forEach((r, i) => { r.rank = i + 1; r.rank_units = i + 1 })
    top[b] = rows
    boutique_net[b] = rows.reduce((a, r) => a + r.net, 0) * 1.6
    for (const g of GROUPS) matrix.push({ item_group: g, boutique: b, revenue: Math.round(rnd() * 400000), units: Math.round(rnd() * 40), on_hand: Math.round(rnd() * 30), index: Math.round((0.4 + rnd() * 1.4) * 100) / 100 })
  }
  return { period, by: args.by ?? 'net', n: args.n ?? 10, boutiques, top, matrix, groups: GROUPS, boutique_net, last_run: { computed_at: new Date().toISOString() } }
}

export function mockClientsOverview(args: { tiers?: string[] } = {}): ClientsOverview {
  const tiers = ['Patron', 'Collector', 'Connoisseur']
  const churn = FIRST.map((n, i) => ({ name: `SIG-${i}`, customer: n, customer_name: n, boutique: BOUTIQUES[i % BOUTIQUES.length]!.code, preferred_associate: null, signal_type: i % 3 === 0 ? 'VIP lapsing' : 'Overdue visit', priority: 100 - i * 8, reason: `Usually visits every ${6 + i} days — last seen ${40 + i * 9} days ago`, churn_risk: 1 - i * 0.08, cadence_days: 6 + i, expected_next_visit: null, last_visit: null, days_since_last_visit: 40 + i * 9, visits: 12 - i, lifetime_spend: 180000 - i * 14000, spend_trend: -0.5, tier: tiers[i % 3]! }))
  return {
    boutique: null,
    tiers: args.tiers ?? [],
    churn: churn.filter((c) => !args.tiers?.length || args.tiers.includes(c.tier!)),
    upcoming: churn.slice(0, 4).map((c, i) => ({ ...c, name: `UP-${i}`, signal_type: i % 2 ? 'Birthday' : 'Due this week', reason: i % 2 ? 'Birthday on 28 Aug' : 'Expected back this week', expected_next_visit: today() })),
    follow_ups: FIRST.slice(0, 6).map((n, i) => ({ associate: n, associate_name: n, boutique: BOUTIQUES[i % 4]!.code, assigned: 14 - i, completed: Math.max(0, 12 - i * 2), rate: Math.max(0, 12 - i * 2) / (14 - i) })),
    performance: [],
    campaigns: null,
    recognition: { matched_today: 4, enrolled_today: 1, declined_today: 0, enrolled_total: 37 },
    as_of: today(),
  }
}
