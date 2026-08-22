// v0.4 H — deterministic insights mock (VITE_MOCK=1), shaped exactly like maison_pos.api.insights
import { BOUTIQUES } from '../mock'
import type { ClientSignal, ClientSignalsResult, HeatCell, InsightReport, InsightsSummary, PerfItemRow, ProductPerformance, RebalanceMove } from './types'

let seed = 11
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

const GROUPS = ['Timepieces', 'High Jewellery', 'Bridal', 'Accessories', 'Services']
const ITEMS: [string, string, string, number][] = [
  ['TP-001', 'Meridian Automatic 40mm Steel', 'Timepieces', 6900],
  ['TP-005', 'Corsaire Chronograph Titanium', 'Timepieces', 12800],
  ['TP-008', 'Petite Lune 28mm Yellow Gold', 'Timepieces', 17900],
  ['HJ-005', 'Lumiere Diamond Tennis Bracelet', 'High Jewellery', 42000],
  ['BR-001', 'Eternal Solitaire 1.0ct Platinum', 'Bridal', 14500],
  ['BR-006', 'Classic Wedding Band 2mm Platinum', 'Bridal', 1950],
  ['BR-008', 'Half Eternity Band 0.5ct', 'Bridal', 4800],
  ['AC-001', 'Signature Gold Chain 45cm', 'Accessories', 2400],
  ['AC-003', 'Monogram Pendant Small', 'Accessories', 1850],
  ['AC-005', 'Diamond Stud Earrings 0.5ct', 'Accessories', 3600],
  ['AC-008', 'Cuff Bracelet Hammered Silver', 'Accessories', 690],
  ['AC-012', 'Silk Pocket Square', 'Accessories', 160],
  ['SV-003', 'Watch Service Complete', 'Services', 850],
]
const B = BOUTIQUES.slice(0, 5).map((b) => b.code)

function row(code: string, name: string, group: string, rate: number, boutique: string, days: number): PerfItemRow {
  const units = Math.round(rnd() * (group === 'Accessories' ? 40 : group === 'Services' ? 12 : 6))
  const on_hand = group === 'Services' ? 0 : Math.round(rnd() * 12)
  const perDay = units / days
  return {
    item_code: code, item_name: name, item_group: group, boutique, units, revenue: units * rate, on_hand,
    velocity: Math.round(perDay * 7 * 1000) / 1000,
    days_on_hand: perDay > 0 ? Math.round((on_hand / perDay) * 10) / 10 : null,
    sell_through: units + on_hand ? units / (units + on_hand) : 0,
    stock_out_risk: perDay > 0 && on_hand < perDay * 21,
    chain_velocity: 0, index: null, rate, is_stock_item: group === 'Services' ? 0 : 1, has_serial_no: /^(TP|HJ)|BR-001/.test(code) ? 1 : 0,
  }
}

export function mockProductPerformance(days = 90): ProductPerformance {
  seed = 11
  const items: PerfItemRow[] = []
  for (const [code, name, group, rate] of ITEMS) for (const b of B) items.push(row(code, name, group, rate, b, days))
  for (const it of items) {
    const chain = items.filter((r) => r.item_code === it.item_code).reduce((s, r) => s + r.velocity, 0) / B.length
    it.chain_velocity = Math.round(chain * 1000) / 1000
    it.index = chain > 0 ? Math.round((it.velocity / chain) * 100) / 100 : null
  }
  const heatmap: HeatCell[] = []
  for (const g of GROUPS) {
    const rev = (b: string) => items.filter((r) => r.item_group === g && r.boutique === b).reduce((s, r) => s + r.revenue, 0)
    const avg = B.reduce((s, b) => s + rev(b), 0) / B.length
    for (const b of B) {
      const mine = items.filter((r) => r.item_group === g && r.boutique === b)
      heatmap.push({ item_group: g, boutique: b, revenue: rev(b), units: mine.reduce((s, r) => s + r.units, 0), on_hand: mine.reduce((s, r) => s + r.on_hand, 0), index: avg ? Math.round((rev(b) / avg) * 100) / 100 : null })
    }
  }
  const top: Record<string, PerfItemRow[]> = {}
  const slow: Record<string, PerfItemRow[]> = {}
  for (const b of B) {
    const mine = items.filter((r) => r.boutique === b)
    top[b] = [...mine].filter((r) => r.units > 0).sort((a, c) => c.revenue - a.revenue).slice(0, 5)
    slow[b] = [...mine].filter((r) => r.on_hand > 0 && r.is_stock_item).sort((a, c) => (c.days_on_hand ?? 1e9) - (a.days_on_hand ?? 1e9)).slice(0, 5)
  }
  return {
    period: { from: '2026-05-25', to: '2026-08-22', days },
    boutiques: B, item_groups: GROUPS, items, heatmap, top_movers: top, slow_movers: slow, rebalance: mockRebalance(),
    totals: { revenue: items.reduce((s, r) => s + r.revenue, 0), units: items.reduce((s, r) => s + r.units, 0), stock_out_risks: items.filter((r) => r.stock_out_risk).length },
  }
}

export function mockRebalance(): RebalanceMove[] {
  return [
    { name: 'RB-1', item_code: 'TP-001', item_name: 'Meridian Automatic 40mm Steel', from_boutique: B[3], to_boutique: B[0], qty: 2, value: 13800, from_on_hand: 4, to_on_hand: 1, from_velocity: 0, to_velocity: 0.47, from_days_on_hand: null, to_days_on_hand: 15, reason: `${B[0]} sells 0.47/wk and has 1 on hand (~15 days cover); ${B[3]} holds 4 with no sales in the last 90 days`, status: 'Open', can_transfer: true },
    { name: 'RB-2', item_code: 'BR-008', item_name: 'Half Eternity Band 0.5ct', from_boutique: B[4], to_boutique: B[1], qty: 3, value: 14400, from_on_hand: 7, to_on_hand: 0, from_velocity: 0.08, to_velocity: 0.62, from_days_on_hand: 612, to_days_on_hand: 0, reason: `${B[1]} sells 0.62/wk and has 0 on hand (no cover); ${B[4]} holds 7 with 612 days of cover in the last 90 days`, status: 'Open', can_transfer: true },
    { name: 'RB-3', item_code: 'AC-005', item_name: 'Diamond Stud Earrings 0.5ct', from_boutique: B[2], to_boutique: B[0], qty: 4, value: 14400, from_on_hand: 9, to_on_hand: 2, from_velocity: 0.16, to_velocity: 1.4, from_days_on_hand: 394, to_days_on_hand: 10, reason: `${B[0]} sells 1.4/wk and has 2 on hand (~10 days cover); ${B[2]} holds 9 with 394 days of cover in the last 90 days`, status: 'Open', can_transfer: false },
  ]
}

const NAMES = ['Ava Delacroix', 'Noah Ferreira', 'Camille Lindgren', 'Julien Nakashima', 'Sienna Okafor', 'Mateo Brennan', 'Ingrid Castellano', 'Rafael Haddad', 'Yuki Ivanova', 'Leon Kowalski', 'Aurora Moreau', 'Tariq Novak']
const TYPES: ClientSignal['signal_type'][] = ['VIP lapsing', 'Birthday', 'Overdue visit', 'Due this week', 'Spend drop', 'Overdue visit', 'Due this week', 'New client follow-up', 'VIP lapsing', 'Due this week', 'Anniversary', 'Overdue visit']

export function mockClientSignals(): ClientSignalsResult {
  seed = 23
  const signals: ClientSignal[] = NAMES.map((n, i) => {
    const cadence = 20 + Math.round(rnd() * 60)
    const since = TYPES[i]!.includes('Overdue') || TYPES[i] === 'VIP lapsing' ? cadence * 2 + Math.round(rnd() * 40) : Math.round(rnd() * cadence)
    const spend = TYPES[i] === 'VIP lapsing' ? 60000 + Math.round(rnd() * 200000) : 3000 + Math.round(rnd() * 40000)
    const reason =
      TYPES[i] === 'Birthday' ? 'Birthday in 6 days' : TYPES[i] === 'Anniversary' ? 'Anniversary in 12 days'
      : TYPES[i] === 'Spend drop' ? 'Spend down 64% vs the previous 90 days'
      : TYPES[i] === 'New client follow-up' ? 'First purchase 14 days ago ($ 12,800) — thank-you call'
      : TYPES[i] === 'Due this week' ? `Expected back around 2026-08-25 (every ~${cadence} days)`
      : `Usually visits every ${cadence} days — last seen ${since} days ago`
    return {
      name: `CS-${i + 1}`, customer: n, customer_name: n, boutique: B[i % B.length], signal_type: TYPES[i]!, priority: Math.round(95 - i * 5.5 - rnd() * 3), status: 'Open', week: '2026-W34', reason,
      recommended_item: ITEMS[i % ITEMS.length][0], recommended_item_name: ITEMS[i % ITEMS.length][1], churn_risk: Math.round(Math.min(1, since / cadence / 3) * 100) / 100,
      cadence_days: cadence, last_visit: '2026-07-02', days_since_last_visit: since, visits: 2 + Math.round(rnd() * 9), lifetime_spend: spend, spend_trend: TYPES[i] === 'Spend drop' ? -0.64 : 0.1,
      preferred_department: ['Timepieces', 'Bridal', 'Accessories', 'High Jewellery'][i % 4], preferred_metal: ['Platinum', '18k Yellow Gold', '18k Rose Gold'][i % 3], mobile_no: `+1 212 555 01${String(10 + i).padStart(2, '0')}`,
    }
  })
  const by_type: Record<string, number> = {}
  for (const s of signals) by_type[s.signal_type] = (by_type[s.signal_type] ?? 0) + 1
  return { boutique: null, signals, by_type, week: '2026-W34' }
}

export function mockNarrative(): InsightReport {
  return {
    name: 'MIR-2026-08-16-Weekly', title: 'Week 2026-08-10 – 2026-08-16', period_start: '2026-08-10', period_end: '2026-08-16', generator: 'Template', net: 288443, invoices: 58, change_pct: -28.6, generated_at: '2026-08-17 06:00:00',
    narrative:
      'Week 2026-08-10 to 2026-08-16: the chain took $288,443 across 58 tickets, down sharply (-29%) against $403,803 the week before. Average ticket was $4,973 and 96% of tender went on card. No returns were processed.\n\n' +
      `By boutique: ${BOUTIQUES[0].name} (${B[0]}) $136,654 on 28 tickets, down sharply (-24%); ${BOUTIQUES[1].name} (${B[1]}) $88,156 on 20 tickets, up strongly (+116%); ${BOUTIQUES[2].name} (${B[2]}) $63,633 on 10 tickets, down sharply (-65%). ${BOUTIQUES[0].name} led the week.\n\n` +
      'Best sellers by revenue: Eternal Solitaire 1.5ct Platinum (2 sold, $53,600), Petite Lune 28mm Yellow Gold (2 sold, $35,800), Diamond Stud Earrings 0.5ct (7 sold, $25,200).\n\n' +
      'Clienteling: 12 clients to contact this week — 4 due this week, 3 overdue visit, 2 vip lapsing, 1 spend drop, 1 birthday, 1 anniversary.\n\n' +
      `Stock: 3 rebalance suggestions are open, e.g. 2 × Meridian Automatic 40mm Steel from ${B[3]} to ${B[0]}; 3 × Half Eternity Band 0.5ct from ${B[4]} to ${B[1]}.`,
  }
}

export function mockSummary(): InsightsSummary {
  return { open_signals: 12, open_rebalances: 3, recommended_clients: 116, latest_report: { name: 'MIR-2026-08-16-Weekly', title: 'Week 2026-08-10 – 2026-08-16', period_end: '2026-08-16', generator: 'Template' }, last_run: { computed_at: '2026-08-17 05:00:12' }, llm: false }
}

export async function mockTransfer(suggestion: string): Promise<{ ok: boolean; stock_entry: string; qty: number }> {
  await new Promise((r) => setTimeout(r, 300))
  return { ok: true, stock_entry: `MAT-STE-2026-${suggestion.slice(-1).padStart(5, '0')}`, qty: 2 }
}
