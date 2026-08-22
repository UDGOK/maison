import type { BoutiqueRow, HeartbeatEvent, LiveSummary, PeriodComparison, PeriodTotals, ReportLink, SaleEvent } from './types'
import { bucketByHour, computeTotals, deriveStatus } from './lib/aggregate'

export const BOUTIQUES: { code: string; name: string }[] = [
  { code: 'PAR-VEN', name: 'Paris · Vendôme' },
  { code: 'LON-BND', name: 'London · Bond St' },
  { code: 'NYC-MAD', name: 'New York · Madison' },
  { code: 'GVA-RHN', name: 'Geneva · Rhône' },
  { code: 'MIL-MNT', name: 'Milan · Montenapoleone' },
  { code: 'DXB-MAL', name: 'Dubai · Mall' },
  { code: 'HKG-CNT', name: 'Hong Kong · Central' },
  { code: 'TYO-GNZ', name: 'Tokyo · Ginza' },
]

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
    return {
      boutique: b.code,
      name: b.name,
      net: mine.reduce((a, s) => a + s.net, 0),
      cash: mine.reduce((a, s) => a + s.cash, 0),
      card: mine.reduce((a, s) => a + s.card, 0),
      invoices: mine.length,
      status: deriveStatus(last_seen, now, pending),
      last_seen,
      queued: i === 5 ? 3 : 0,
      pending_approvals: pending,
      last_sale: mine.length ? mine[mine.length - 1]!.posting_datetime : null,
    }
  })

  return {
    totals: computeTotals(rows),
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
