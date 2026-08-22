# Head-office dashboard v2 — "Command" (v0.5 L)

`/maison-dashboard` (roles: Maison Head Office, Maison Regional, System Manager). Vue 3 app in
`dashboard/`, built into `maison_pos/public/dashboard/`. Designed for a wall screen (1920×1080 and
3840×2160) and a laptop, for chains of 40–100 boutiques.

## Tabs

| Tab | What it shows | Data |
|---|---|---|
| **Live** (default) | KPI strip (net + vs same weekday last week, invoices, card/cash, avg ticket, returns, pending approvals, low stock, open feedback ≤ 2); chain ticker (latest 10 sales); **store-level live cards** ranked by net (vs LW %, tickets, "Sold · Perpetual 41 · $86,500 · 2 s ago", status) that pulse on a sale; region filter, search, sort; selecting a card opens the boutique's own item-level feed + hourly bars; chain hourly chart + low-stock tile | `dashboard.live_summary`, `dashboard.ticker`, `dashboard.boutique_feed`, socket events |
| **Boutiques** | Sortable table: net today / WTD / MTD, vs LW, WTD vs LW, tickets, avg ticket, conversion (identified clients / tickets, MTD), returns %, stock value, low-stock count, associates on shift, status, 14-day sparkline. Click a row → drill-in page (hourly, top items, associates, recent sales, alerts, feedback) | `dashboard.boutiques_table`, `dashboard.boutique_detail` |
| **Products** | **Trending in stores**: chain-wide items ranked by velocity change (units this 7 d vs previous 7 d and vs the 28 d baseline) with *Trending up / New / Cooling / Steady* badges, group + badge filters, stores selling, sell-through, days-on-hand. **Top products by store**: boutique selector or all → per-boutique top 10 by net or units with share of boutique sales, plus the item-group × boutique matrix | `dashboard.product_trends`, `dashboard.top_products` — both read the precomputed **Maison Product Trend** table |
| **Clients** | Churn-risk list for top tiers (Patron / Collector / Connoisseur filter) with "Assign call", follow-up rate per associate (CRM tasks done / assigned, 30 d), upcoming dates, recognition stats; associate performance (`hr.employee_performance`) and campaign performance (`campaigns.performance`) appear when those endpoints exist | `dashboard.clients_overview` |
| **Insights** | v0.4 H weekly insights (unchanged) | `api.insights.*` |
| **Reports** | Period comparison + report links (v0.4 F) | `api.reports.*` |

URL state: `?view=live|boutiques|products|clients|insights|reports`, `&boutique=CHI-OAK` (drill-in),
`&sub=top` (Products sub-tab).

## Performance design

* **Incremental aggregates, not refetches.** The store keeps one mutable record per boutique in a
  `Map` (`dashboard/src/lib/aggregate.ts`: `createAggState`, `foldSale`, `foldHeartbeat`,
  `reduceEvents`). A `maison_sale` socket event is folded in O(1): boutique net / tickets / returns /
  avg ticket / vs-LW / last sale / hourly bucket / per-boutique feed / chain ticker. Duplicates
  (reconnect replays) are dropped by invoice id. A full `live_summary` reconcile runs every 60 s
  and on socket reconnect (`seedFromSummary` keeps the live feeds).
* **rAF batching.** Socket events go through `lib/batch.ts` — queued and applied once per animation
  frame (timer fallback for hidden tabs), bumping one `version` counter so Vue re-renders once per
  batch. Vitest: 100 boutiques × 1,000 events fold in ≈ 3 ms and reconcile exactly.
* **Virtualised lists.** `components/VirtualList.vue` + `lib/virtual.ts` render only the rows in
  the viewport (+ 4 overscan) for the live cards and the Boutiques table: 100 boutiques → ~18 DOM
  rows (`dashboard/screenshots/v05/live-100-boutiques-*.png`, produced with
  `VITE_MOCK=1 VITE_MOCK_BOUTIQUES=100`).
* **Cheap server side.** `live_summary` is one grouped SQL (boutique × hour, with tender sub-sums),
  one query for the same weekday last week, one window-function query for the last sale per
  boutique, heartbeats / approvals / alerts, cached **5 s** in `frappe.cache` per user scope and
  date; `publish_sale` clears the cache so a sale is never served stale. Products read a
  precomputed table refreshed every 15 min. Measured on the seeded 3-boutique site
  (`tests/test_v0_5_dashboard.py::TestPerformanceBudget`): `live_summary` ≈ 13 ms uncached
  (< 150 ms budget), cached ≈ 0.2 ms; `product_trends` ≈ 4 ms and `top_products` ≈ 7 ms
  (< 100 ms budget). The Products tab reports its own load time in the toolbar (e2e: 54–129 ms
  end-to-end in the browser).

## Type scale

Everything in the v0.5 components is `rem`-based; `html { font-size }` selects the device:
laptop (≤ 1600 px) 13 px, wall 1920×1080 15 px, wall 3840×2160 (≥ 3000 px) 30 px — so the 4K
wall reads exactly like the 1080p wall at double the pixels. Tokens in `dashboard/src/style.css`
(`--fs-label … --fs-hero`, `--row-h`, `--pad-x`).

Dataviz discipline: one accent (champagne gold) for the hero number, current / peak bars and
sparkline endpoints; faint 1 px grids; tabular numerals; status colours reserved for status
(returns and cooling in crit, warn for low stock); never a dual axis.

## Backend

### `Maison Product Trend` + `maison_pos/insights/trends.py`

One row per `item × (boutique | ALL) × period` (`7d`, `28d`):
`units, units_prev, units_baseline (4-period window / 4), net, net_prev, velocity (units/week),
delta_pct (vs previous period; undefined → has_prev = 0), baseline_delta_pct, rank (net),
rank_units, share_pct (of the boutique's net), store_count (ALL rows: boutiques with units),
on_hand, sell_through, days_on_hand, badge, period_from/to, computed_at`.

Badges (`trends.badge_for`): **New** — sold this period, nothing earlier in the baseline window;
**Trending up** — ≥ +25 % vs previous period *and* vs baseline with ≥ 2 units (or no previous
period, ≥ 2 units, ≥ +25 % vs baseline); **Cooling** — ≤ −25 % vs a previous period of ≥ 2
units; otherwise **Steady**.

Refresh: scheduler `*/15 * * * *` → `maison_pos.insights.trends.compute_trends` (one grouped SQL
over the last 112 days, `delete` + `bulk_insert`, ≈ 0.25 s on the seeded site). On demand:

```bash
bench --site maison.localhost execute maison_pos.insights.trends.compute_trends
# or, as Head Office: POST /api/method/maison_pos.api.dashboard.compute_trends
```

### `maison_pos/api/dashboard.py` (all boutique-scoped; managers see only their boutique)

```
live_summary(date?, nocache?)      -> {totals{net, invoices, returns, returns_value, cash, card, avg_ticket, online,
                                        boutiques, last_week_net, vs_last_week_pct, low_stock, feedback_open, pending_approvals},
                                       regions[], by_boutique[{boutique, name, city, region, net, cash, card, invoices, returns,
                                        returns_value, avg_ticket, conversion, status online|offline|queued|pending_approval,
                                        last_seen, queued, pending_approvals, low_stock, feedback_open, last_week_net,
                                        vs_last_week_pct, last_sale{invoice, item, amount, ts, is_return}, by_hour[24]}],
                                       by_hour[24], pending_approvals, low_stock, returns, recognition, cached}
ticker(limit=10)                    -> [{invoice, boutique, amount, top_item, items, tier, ts, is_return}]   (no PII)
recent_sales(limit, boutique?)      -> feed rows with item lines
boutique_feed(boutique, limit)      -> {sales[], by_hour[24]}            (today, item level)
boutiques_table(date?)              -> {rows[{...live row, wtd_net, mtd_net, wtd_vs_lw_pct, mtd_tickets, mtd_avg_ticket,
                                        mtd_conversion, returns_pct, stock_value, on_shift, sparkline[14]}]}
boutique_detail(boutique, days=28)  -> {row, by_hour, recent_sales, top_items, associates, alerts, feedback, sparkline}
product_trends(scope=chain|boutique, boutique?, group?, period=7d|28d, limit, badge?)
                                    -> {rows[] ranked by delta_pct, badges{}, groups[], total, computed_at, last_run}
top_products(boutique|all, by=net|units, period, n=10)
                                    -> {top{code: rows[]}, matrix[{item_group, boutique, revenue, units, on_hand, index}], groups, boutique_net}
clients_overview(boutique?, tiers?, limit)
                                    -> {churn[], upcoming[], follow_ups[], performance[], campaigns|null, recognition}
compute_trends()                    -> {rows, items, boutiques, seconds}
heartbeat(...)                      (unchanged)
```

Realtime (`maison_pos.utils.invoice_summary`, room `doctype:Sales Invoice`, event `maison_sale`)
now carries `amount`, `top_item` (highest-value line), `tier` (loyalty tier) and `is_return`. No
phone / e-mail / address ever leaves the server; `customer_name` stays for the v0.2 feed contract.

## Tests & proofs

```bash
bench --site maison.localhost run-tests --module maison_pos.tests.test_v0_5_dashboard   # 17 tests incl. benchmarks
cd dashboard && npm test                                                              # 24 tests (reducer 100×1000, virtualisation, batcher)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin \
  node e2e/dashboard.v05.e2e.mjs            # POS sale (associate) -> CHI-OAK card + ticker < 1 s; Products; Boutiques sort
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin \
  node dashboard/scripts/shots-v05.mjs      # screenshots, every tab, 1920×1080 + 3840×2160 -> dashboard/screenshots/v05/
```

Mock mode for design work without a bench: `cd dashboard && VITE_MOCK=1 VITE_MOCK_BOUTIQUES=100 npm run dev`.
