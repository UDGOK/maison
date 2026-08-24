# QA — Head-office **Command** dashboard, reports, insights, campaigns, employee/commission KPIs

**Agent 3 of 6** · Live site **https://cloudchaserz.frappe.cloud** · 2026-08-23, 15:55–16:35 America/Chicago
(site tz is now `America/Chicago`, unlike the v0.6 run).
Harness: Playwright 1.56 / Chromium through `e2e/cloud-bridge.mjs` (`BRIDGE=1`), Administrator `sid` from
`press.api.site.login`; API recomputation in Python against `frappe.client.get_list`.

Scripts (all new, **no app source was modified**): `e2e/qa/dq.py` (API helper), `d1-recompute.py`,
`d2-boutiques.py`, `d3-trends.py`, `d4-top.py`, `d5-tax.py`, `d6-reports.py`, `d7-hr.py`, `d8-campaigns.py`,
`d9-reportnums.py`, `d10-cleanup1.py`, `lib-dash.mjs`, `e1-live.mjs` … `e9-shots.mjs`.
Raw results: `results-d*.json`, `results-e*.json`. Screenshots: `e2e/qa/shots-dashboard/` (34).

## Headline

* **The aggregates are right.** Independent recomputation of `live_summary` (11 stores × 11 metrics + 24 hourly
  buckets + 7 chain totals), `boutiques_table` (11 rows × 8 metrics + 14-point sparklines), `product_trends`
  (156 chain rows × 13 fields), `top_products` (11 stores, both rankings, 121-cell matrix), the Sales Tax
  Summary (hand-computed **and** checked against the tax booked on the invoices), `employee_performance` and the
  commission ledger produced **zero** discrepancies. Every "$" on the Live and Stores tabs is defensible.
* **Two published numbers are wrong**, both in *time* and *comparison* logic rather than in the sums:
  the Live/store **hourly chart silently drops 86 % of today's sales and reports the wrong peak hour** (D-1), and
  **`avg ticket vs boutique` compares an associate's gross average against a net boutique average**, flipping
  one associate from below-average to above-average (D-2). A third, the **Hourly Heatmap**, reports $813 of trade
  in an hour when nothing was sold (D-3).
* One control is dead on this tenant (**tier filter**, D-5), three reports are unreachable from the dashboard
  (D-6), and "**Frappe**" is still printed on the Reports tab (D-8).

**Counts** — 96 browser checks: **87 pass, 9 fail** (4 of those 9 are harness-strictness, see the table).
66 report runs across 11 Script Reports × 6 filter sets: **all executed**, 0 crashes.
~600 recomputed field-level assertions: **5 mismatches, all explained by Bin snapshot staleness** (not defects).
**23 findings**: 1 High, 6 Medium, 7 Low, 9 Informational.

---

## 1. Correctness of numbers — independent recomputation (priority)

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 1.1 | `live_summary` **net sales today** per store + chain, recomputed from `Sales Invoice.grand_total` | **PASS** | 11/11 stores exact. Chain `net` API **597.38** = calc **597.38**. HOU-MTR 917.00, OK-BIX 20.66, OK-ETUL 0.00, OK-OWA −2.71 … OK-MINGO −79.19 — all exact. `d1-recompute.py`, `results-d1.json` | — |
| 1.2 | **Invoice / return counts** | **PASS** | invoices 31 = 31, returns 22 = 22, returns_value 785.15 = 785.15 (all 11 per-store pairs exact) | — |
| 1.3 | **Card / cash split** recomputed from `Sales Invoice Payment` (cash net of `change_amount`) | **PASS on the amounts** | cash API **892.78** = calc 892.78; card API **−320.40** = calc −320.40. Per-store exact. *But see D-11/D-12 for how those amounts are labelled and bucketed* | — |
| 1.4 | **Avg ticket** | **PASS on arithmetic, WRONG as a KPI** | API 19.2703 = net/invoices exactly. The average **sale** today is **$44.60** (sales-only $1,382.53 ÷ 31). See **D-4** | Med |
| 1.5 | **Returns** (count + value) | **PASS** | 22 / $785.15, matches; per-store exact | — |
| 1.6 | **Per-store net** | **PASS** | all 11 exact (table above) | — |
| 1.7 | **vs-last-week %** vs `posting_date = 2026-08-16` | **PASS** | chain −46.8 % = calc −46.8 %; every store matches incl. the `None` for OK-MUS (last week = 0). `last_week_net` 1122.81 = 1122.81 | — |
| 1.8 | **Hourly buckets** (24 per store + chain) | **PASS** | 264 bucket assertions, 0 mismatches. Chain non-zero: `{04: 512.73, 12: 47.88, 14: 28.99, 15: 7.78}`, sums to 597.38 | — |
| 1.9 | `boutiques_table`: WTD / MTD net, WTD-vs-LW %, MTD tickets / avg ticket / conversion, returns %, stock value, 14-day sparkline | **PASS** | 11 rows × 8 metrics + 154 sparkline points, **0 discrepancies**. e.g. HOU-MTR WTD 1862.72, MTD 6537.08, WTD vs LW +19.4 %, conv 0.530, returns 8.3 %, stock $29,074.54 (= Σ `Bin.stock_value`). Week start 2026-08-17 (Mon) and month start 2026-08-01 both correct. `d2-boutiques.py` | — |
| 1.10 | **Trending velocity** — `product_trends` 7 d chain: units, units_prev, units_baseline, net, net_prev, **velocity**, delta %, baseline delta %, store_count, badge | **PASS** | 156/156 rows exact on all of these; badge histogram identical (`Trending up 27 / Steady 79 / Cooling 47 / New 3`). `d3-trends.py` | — |
| 1.11 | **Sell-through & days-on-hand** | **PASS (3 items stale)** | 156 rows exact except `on_hand` (and the derived `days_on_hand`) on ROL-002 (524 vs 512), ROL-006 (514 vs 512), ACC-002 (508 vs 504) — the trend table snapshots `Bin.actual_qty` at compute time and the warehouse agent moved stock afterwards. Expected behaviour, not a defect | Info |
| 1.12 | **Top products by store** — by net and by units, ordering, ranks, matrix, `boutique_net` | **PASS** | HOU-MTR top-10 by net and by units both match a raw `Sales Invoice Item` recompute item-for-item (HKA-012 $792.39 / 61 u, DSP-002 $131.19 / 6 u …). `boutique_net` 1720.79 = Σ 7-day lines. All 8 matrix cells for HOU-MTR exact on revenue **and** units. `d4-top.py` | — |
| 1.13 | **`share_pct`** on the same rows | **FAIL** | HKA-012 shown as **44.19 %** of a header that prints **"1,721 net"**; 792.39 ÷ 1720.79 = **46.05 %**. Denominator used is 1793.23 (positives only). See **D-9** | Low |
| 1.14 | **Sales Tax Summary hand-computed** — HOU-MTR, 2026-08-23 | **PASS** | Hand-computed from `Sales Invoice Item.net_amount` × 8.25 % (per line, rounded to cents): gross 1232.93, returns 385.80, taxable 847.13, non-taxable 0.00, net 847.13, tax on sales 101.72, tax refunded 31.85, **tax collected 69.87**, 30 tickets / 12 returns — **every field identical to the report**. Cross-check against the tax actually booked: Σ`total_taxes_and_charges` = **69.87**, Σ`net_total` = 847.13, Σ`grand_total` = 917.00 = the Live board's HOU-MTR net. `d5-tax.py` | — |
| 1.15 | Chain tax summary MTD | **PASS** | 11 jurisdiction rows, rates 8.25–9.50 %, totals 737 tickets / $29,891.94 net / $2,599.28 tax collected | — |
| 1.16 | `employee_performance` recomputed (HOU-MTR, 30 d, 185 invoices) | **PASS on fields** | sales, gross_sales, tickets, returns, returns_amount, with_client all exact for 3 associates. Returns correctly re-attributed to the original seller | — |
| 1.17 | **Commission** — statement vs the raw `Maison Commission Entry` ledger | **PASS** | 286 entries; Dante Ruiz 149.85, Keisha Brown 73.75, Marisol Vega 33.89 — statement, `employee_performance.commission` and the ledger sum all agree to the cent | — |
| 1.18 | `avg_ticket_vs_boutique` | **FAIL — wrong number** | See **D-2** | **Med-High** |

---

## 2. Live tab

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 2.1 | 11 store cards, **HOU-WH excluded** | **PASS** | counter `11 / 11`; codes HOU-MTR, OK-BIX, OK-ETUL, OK-OWA, OK-STUL, OK-YALE, OK-SAP, OK-MUS, OK-BA, OK-JENKS, OK-MINGO. v0.6 defect D4 is fixed (`get_retail_boutiques`). `01-live-1920.png` | — |
| 2.2 | Brand: wordmark, scope line, nav | **PASS** | `CLOUDCHASERZ` · `Today · All Stores` · nav `LIVE / STORES / PRODUCTS / CLIENTS / INSIGHTS / REPORTS`; tab title `CLOUDCHASERZ · Command`; no "Boutique" anywhere. v0.6 defect D1 is fixed | — |
| 2.3 | Chain ticker | **PASS** | 10 rows, e.g. `15:22 · HOU-MTR · 18650 Battery 3000mAh 2-pack · 37`; site-zone clock (16:05 CDT). No PII in the payload (`invoice, boutique, amount, top_item, items, tier, ts, is_return`) | — |
| 2.4 | **A real sale elsewhere updates the right card within seconds** | **PASS** | Sale rung as `ok.mus.a1@` at **OK-MUS** → `ACC-SINV-2026-03080` $2.17. The OK-MUS card went 0 → 1 tickets **144 ms after the POS response**, net −60 → −58, last sale "Clipper Lighter — Assorted"; the ticker head became `ACC-SINV-2026-03080`. No other card moved. `08-live-after-sale-1920.png`. **Invoice cancelled afterwards** (docstatus 2) | — |
| 2.5 | Region filter | **PASS** | `All / Houston / Oklahoma / Tulsa Metro`; Houston→[HOU-MTR] (1/11), Oklahoma→[OK-SAP, OK-MUS] (2/11), Tulsa Metro→8 stores — each set exactly matches `live_summary.by_boutique[].region`. `20-live-region-tulsa-1920.png` | — |
| 2.6 | Search by code / by name / no match | **PASS** | "sap"→OK-SAP, "montrose"→HOU-MTR, "zzzz"→0 cards. `21-live-search-1920.png` | — |
| 2.7 | Sorting (Net / vs LW / Tickets / Last sale) | **PASS** | Net and Tickets verified strictly descending against the rendered values | — |
| 2.8 | Offline / online status | **PASS** | All 11 `OFFLINE` and `0 / 11 stores online` — correct: newest heartbeat 15:24, `STALE_AFTER_SECONDS` exceeded by 16:05. 56 heartbeat rows exist | — |
| 2.9 | Pending approvals / low stock / feedback tiles | **PASS (all correctly 0)** | 0 `Maison Price Change Request`; all 4 `Maison Stock Alert` rows are **Resolved**; the single `Maison Feedback` has rating 5 (threshold ≤ 2). Tiles are right, but the tenant cannot demo a non-zero state | Info |
| 2.10 | Card drill-in (item feed + hourly) | **PASS** | HOU-MTR panel: `NET 917 · TICKETS 30 · AVG TICKET 31 · RETURNS 12` + item-level feed. `03-live-drillin-1920.png` | — |
| 2.11 | **Chain hourly chart / PEAK** | **FAIL** | See **D-1** | **High** |
| 2.12 | Card/Cash KPI | **FAIL (labelling)** | See **D-11** | Low |

---

## 3. Stores tab

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 3.1 | Sortable columns | **PASS (14/15)** | 15 sortable headers; Store, Net today, vs LW, WTD, WTD vs LW, MTD, Tickets, Avg ticket, Conv., Returns, Stock, Low, On shift all sort desc **and** asc against the API order. `Status` is not exercisable — all 11 stores are `offline`, so the sort is a no-op. `07-stores-sorted-1920.png` | — |
| 3.2 | Sparklines | **PASS** | 11 svgs / 11 rows; all 154 datapoints match a raw 14-day recompute | — |
| 3.3 | Drill-in page: hourly, top items, associates, alerts, feedback | **PASS** | `boutique_detail(HOU-MTR)` → 10 top items, 3 associates, 0 alerts, 0 feedback, 20 recent sales; the page's #1 item "CocoUrth Coconut Coals 72 pc (flats)" matches the API (net 818.37, 63 u). URL state `?view=boutiques&boutique=HOU-MTR`. `05-store-page-HOU-MTR-1920.png` | — |
| 3.4 | **Store with zero sales today** (OK-ETUL) | **PASS** | Renders cleanly: `NET TODAY 0 · VS SAME DAY LW −100% · TICKETS 0 · AVG TICKET 0 · RETURNS 0`; no NaN / Infinity / undefined. `06-store-page-zero-sales-OK-ETUL-1920.png`. Nit: it prints `PEAK 09:00 · 0` for an all-zero series | Info |
| 3.5 | Navigation back to the list | **FAIL** | See **D-10** | Low |

---

## 4. Products tab

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 4.1 | Trending table from the precomputed `Maison Product Trend` | **PASS** | 60 of 156 rows rendered; row #1 `HKA-012 · 61 u · prev 1 · +6000 % · +275 % · $792 · 1 store · 26 % sell-through · 20 DOH · TRENDING UP` — every figure equals the API row | — |
| 4.2 | Badges up / new / cooling | **PASS** | filters return exactly `Trending up 27`, `New 3`, `Cooling 47`, each list 100 % that badge. (The first 60 delta-sorted rows happen to contain no `New`, which is why the naive "all three visible at once" assertion failed) | — |
| 4.3 | Group filter | **PASS** | 12 options; "Hookah & Shisha" → 17 rows, exactly the API's 17 | — |
| 4.4 | 7 d / 28 d period switch | **PASS** | 28 d → 60 rows of 160, matches the API | — |
| 4.5 | Top-by-store, **by net** and **by units**, matrix | **PASS** | 11 columns (no HOU-WH), 121 matrix cells; both orderings match the API and a raw recompute; single-store selector narrows to 1 column. `10/11/12-products-*.png` | — |
| 4.6 | **Precomputed table refreshes** (`insights.trends.compute_trends`) | **PASS** | Scheduler observed at 15:45:52 → 16:00:53 → 16:15:54 → 16:30:56 (15-min cadence). On-demand `dashboard.compute_trends` (HQ) ran in **1.35 s**, wrote 2,500 rows / 160 items / 11 stores and moved `computed_at` to 16:23:26 | — |
| 4.7 | **"Data as of" stamp** | **PASS, with a race** | Stamp `Data as of 23 Aug, 16:00 CDT · loaded in 182 ms` matched `last_run.computed_at` and the row `computed_at` exactly at that moment. But see **D-13** — 15 minutes later the two diverged | Low |
| 4.8 | Products load time | **PASS** | in-browser `loaded in 182 ms` (budget < 300 ms) | — |

---

## 5. Clients tab

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 5.1 | Churn-risk list | **PASS** | 26 rows = API; row 1 `Zach Wolf · Member · "Usually visits every 1 days — last seen 76 days ago" · $611 · OK-YALE` (churn_risk 1.0) | — |
| 5.2 | Follow-up rates | **PASS** | 1 associate: Dante Ruiz HOU-MTR `2 / 2 · 100 %` = API | — |
| 5.3 | Upcoming dates | **PASS** | 30 rows — the component requests `limit: 30`, so 30 is correct (my 40-row API probe was the mismatch) | — |
| 5.4 | Recognition stats | **PASS** | `Enrolled 0 · Matched today 0 · Enrolled today 0 · Declined 0` = `recognition_counts` | — |
| 5.5 | Associate performance card | **PASS** | 33 rows = API; first `Dante Ruiz · HOU-MTR · 4,286 · 103 · 45 · 53 % · 0` | — |
| 5.6 | Campaign performance card | **PASS (renders, no data)** | 1 row `CloudChaserz launch night — Event · 0 sent · 0 opened · $0` | Info |
| 5.7 | **Tier filter** | **FAIL** | See **D-5** — every chip empties the list. `22-clients-tier-empty-1920.png` | Med |
| 5.8 | **"Assign call" creates a task** | **PASS** | Clicking `ASSIGN CALL` on Zach Wolf's row created `Maison Client Interaction 6m2m5spnbv` (interactions 8 → 9): type **Call**, status **Open**, `follow_up_date 2026-08-25` (today + 2), customer Zach Wolf, associate `ok.yale.a1@`; the signal was stamped `assigned_associate` + `call_task`. `crm_task = null` — correct, Frappe CRM is absent and the call is feature-detected. `15-clients-assign-call-1920.png`. **Reverted** (interaction deleted, signal stamps cleared) | — |

---

## 6. Insights

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 6.1 | `insights.compute` on demand (HQ) | **PASS** | 9.5 s → affinity 186 customers / 930 recommendations / 3,033 baskets / 7,601 pairs; signals 156 (`Due this week 118, Overdue visit 24, Birthday 14`); rebalance 0 of 1,733 items. `last_run` refreshed immediately | — |
| 6.2 | Tiles | **PASS** | `Clients to contact 155 · Rebalance moves 0 · Stock-out risks 28 · Revenue·90 days 122K · Clients with offers 179 · Narrative · template` — all match `insights.summary` / `product_performance`. `16-insights-1920.png` | — |
| 6.3 | Recommendations | **PASS** | `recommend_for_client(Zach Wolf)` → Voopoo Drag 5 Kit, score 41.95, lift 28.38, *"Bought with Twist Pink Punch Lemonade 60ml 0mg in 10 % of baskets"*; **no overlap with owned items**. `recommend_for_basket([HKA-012])` → Al Fakher Grape with Mint 250g (lift 26.76) | — |
| 6.4 | Client signals list | **PASS** | 40 rows rendered, matches `client_signals` (by_type Birthday 13 / Overdue 24 / Due 13) | — |
| 6.5 | **Rebalance suggestions + one-click Material Transfer** | **NOT DEMONSTRABLE** | See **D-15**. Guard verified: `create_transfer('does-not-exist')` → clean `DoesNotExistError` | Med |
| 6.6 | **Weekly narrative (template mode)** | **PASS** | `narrative(generate=1)` in 0.5 s → `MIR-2026-08-16-Weekly`, `generator: Template`, `model: null`. Prose: *"Week 2026-08-10 to 2026-08-16: the chain took $9,518 across 228 tickets, down -8 % against $10,338 the week before. Average ticket was $42 and 62 % of tender went on card…"* — **independently verified: net 9,518.26, 228 tickets, 0 returns, prev 10,337.60 (−7.9 %), card share 0.619, avg 41.75, and all 11 per-store figures exact**. Correctly CloudChaserz-named, zero "Maison". `18-insights-narrative-1920.png`. **Report deleted afterwards** | — |
| 6.7 | Group heatmap / movers | **PASS** | 121 heatmap cells; movers table lists all 11 stores with `2.2×` index values | — |

---

## 7. Reports

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 7.1 | **Every Script Report × 6 filter sets** (today / MTD all / MTD one store / 90 d one store / empty window / inverted range) | **PASS — 66 runs, 0 crashes** | Sales Tax Summary, Daily Sales, Sales by Item, Sales by Associate, Hourly Heatmap, Client Purchases, Serial Ledger, Returns, Commission Statement, Promotion Performance, Campaign Performance. Row counts and timings in `results-d6.json`; slowest is Client Purchases MTD-all at 1.8 s | — |
| 7.2 | Inverted range rejected | **PASS (9/11)** | 9 reports throw `From Date must be before To Date`; Commission Statement throws with different casing (`from_date must be before to_date`). **Serial Ledger and Promotion Performance do not validate at all** (see D-14) | Low |
| 7.3 | **Sales by Item / Group / Department** | **PASS** | `group_by` filter → 156 items / 11 item groups / 6 departments (Vape, Accessories, Kratom & CBD, Hookah, Glass, Services), all with correct totals | — |
| 7.4 | Sales by Item numbers | **PASS** | HOU-MTR today: all 10 items exact on units_sold / units_returned / gross / returns_value / net_sales | — |
| 7.5 | Daily Sales numbers | **PASS** | HOU-MTR today: gross 1232.93, returns 385.80, net 847.13, tax 69.87, total 917.00, tickets 30, returns 12, cash 934.83, items/ticket 3.07 — all match. `card −38.95` + `other −3.88` = the Live board's `card −42.83` (see D-12) | — |
| 7.6 | Sales by Associate numbers | **PASS** | 3 rows exact on net_sales / tickets / returns / with_client; returns with no associate correctly grouped under a blank row (8 returns, −332.24) | — |
| 7.7 | **Hourly Heatmap** | **FAIL** | See **D-3** | Med |
| 7.8 | Client Purchases (RFM) | **PASS** | 112 rows; Gabriela Wolf `frequency 5 · monetary 588.20 · recency 17 · last_visit 2026-08-06 · first_visit 2026-06-23 · Member` — recomputed: 5 invoices, Σ grand_total 588.20, last 2026-08-06, 17 days ago. Correct | — |
| 7.9 | Serial Ledger | **PASS (empty is correct)** | 0 rows for every filter — the tenant has **0 `Serial No` records and 0 items with `has_serial_no`**. Untestable by data | Info |
| 7.10 | Returns | **PASS** | HOU-MTR today: `Change of mind 22 u / $312.78 / 7 credit notes / 81.1 %`, `Sizing 6 u / $46.24 / 3`, `— 2 u / $26.78 / 2`; total $385.80 = the recomputed returns value | — |
| 7.11 | Commission Statement | **PASS** | matches the ledger exactly (7.1.17 above) | — |
| 7.12 | Promotion Performance | **PASS** | `PRLE-0001 Disposables month Aug 2026 · 5 redemptions · $18.75 discount · $106.20 revenue · 15.0 %` | — |
| 7.13 | **CSV export** | **PASS for 8, 404 for 3** | `Maison Sales Tax Summary` → `200 text/csv`, `content-disposition: attachment; filename=maison_sales_tax_summary_2026-08-23.csv`, 12 lines, header + 11 jurisdictions. See **D-6** for the three that 404 | Med |
| 7.14 | Reports tab catalogue + links | **PASS on the 8 present** | 8 links + 8 CSV links, hrefs well formed (`/app/query-report/…`, `…reports.export?report=…&filters=…`). `17-reports-1920.png` | — |
| 7.15 | Period comparison widget | **PASS on arithmetic** | today −46.4 %, WTD −0.9 %, MTD −6.5 %, YTD n/a (no prior year). **But the absolute figures disagree with the Live tab** — see **D-7** | Med |
| 7.16 | **"Frappe" visible** | **FAIL** | See **D-8**. `23-reports-frappe-desk.png` | Low-Med |

---

## 8. Campaigns

Tested end to end by injecting two touches, running attribution, verifying, then **fully reverting**.

| # | Test | Result | Evidence | Sev |
|---|---|---|---|---|
| 8.1 | Tenant campaign state | **Info** | 1 campaign (`EVENTS-LAUNCH`, Event, Scheduled, send_date 2026-09-02), **0 touches, 0 attributions** — the whole feature is dark on this site. See **D-16** | Info |
| 8.2 | `record_touch` + upsert semantics | **PASS** | A `clicked` touch back-filled open + send → counters `sends 2 / opens 1 / clicks 1`, `open_rate 0.5`, `click_rate 0.5` | — |
| 8.3 | **Attribution job** | **PASS** | `run_attribution(2026-07-09 → 2026-08-23, EVENTS-LAUNCH)` → 12 invoices scanned, 4 attributed, **3 Direct + 1 Assisted** | — |
| 8.4 | **Direct vs assisted rule verified by hand** | **PASS** | 5 d → Direct, 12 d → Direct, 2 d → Direct, **24 d → Assisted** (direct window 14 d, assisted 30 d). Every `amount` equals the invoice's `net_total` to the cent (48.97 / 14.99 / 24.99 / 31.98) | — |
| 8.5 | **Campaign performance card / endpoint / desk report agree** | **PASS** | `performance()`: direct **88.95**, assisted **31.98**, revenue **120.93**, buyers 2, invoices 3/1; `attributed_sales()` 4 rows; the **Maison Campaign Performance** Script Report reports the same 88.95 / 31.98 / 2 with a bar chart | — |
| 8.6 | **Segment export** | **PASS** | `segment()` → 221 customers. `export_segment(csv)` → `200 text/csv`, `filename=EVENTS-LAUNCH-segment.csv`, **222 lines** (1 header + 221), columns exactly `client_number, customer_name, email, mobile, tier, boutique, preferred_associate, utm_campaign, coupon` | — |
| 8.7 | Report ignores date filters | **Info** | Maison Campaign Performance returns the same 2 rows for every window incl. an inverted range — it lists all campaigns and only the attributed columns should move with the filter. Could not be distinguished from correct behaviour once counters were back to zero | Info |
| 8.8 | **Cleanup** | **PASS** | 0 touches, 0 attributions, counters back to `0/0/0/0.0/0.0/0` | — |

---

## 9. Performance & viewports

| Metric | 1920×1080 | 1440×900 |
|---|---|---|
| Live (goto → first card) | 1,420 ms | 1,292 ms |
| Stores | 1,161 ms | 989 ms |
| Products | 967 ms | 867 ms |
| Clients | 1,586 ms | 1,560 ms |
| Insights | 882 ms | 825 ms |
| Reports | 1,164 ms | 1,173 ms |
| Horizontal overflow | **0 px on all 6 tabs** | **0 px on all 6 tabs** |
| Console errors / page errors / failed requests | **0** | **0** |

API response times (median of 5, measured in-browser through the sandbox proxy — real latency is lower):

| Endpoint | median |
|---|---|
| `live_summary` (5 s cache hit) | **71 ms** |
| `live_summary?nocache=1` | **129 ms** (budget < 150 ms) |
| `product_trends` 7 d | **74 ms** (budget < 100 ms) |
| `top_products` all stores | **82 ms** |
| `boutiques_table` | **116 ms** |
| `clients_overview` | **437 ms** — the slowest dashboard call |

Realtime: a POS sale reached the Live board in **144 ms**.
Layout at 1440×900 reflows correctly (Insights drops to one column, tiles to 3-up) with no clipping — `20…25-*-1440x900.png`.

---

# Defects, ranked

### D-1 · **HIGH** — the Live/store hourly chart drops every hour outside 09:00–21:59, and "PEAK" is computed on the truncated window

`dashboard/src/components/HourlyChart.vue:6-15` hard-codes `from: 9, to: 21` and filters:
`const visible = computed(() => props.hours.filter(h => h.hour >= from && h.hour <= to))`; `peak` (line 48) then
reduces over `visible` only.

Today's chain `by_hour` is `{04: $512.73, 12: $47.88, 14: $28.99, 15: $7.78}` — **$512.73 of the $597.38 the KPI
next to it announces (86 %) is in the 04:00 bucket and is never drawn.** The chart therefore shows three small
bars and labels the day **"PEAK 12:00 · 48"**, when the largest hour is 04:00 with $512.73.
The bars also no longer sum to the headline number — the two halves of the same screen disagree.

This is not only a seeded-data artefact: over the 3-month history **106 invoices worth $3.0 k fall outside the
window**, 58 of them (\$2,331) *after* 21:00 — normal late trade for a smoke shop, permanently invisible on the
head-office board. A store that opens at 06:00 or closes at 23:00 has no hourly picture at all.

Evidence: `01-live-1920.png` (chart axis 09:00→21:00, "PEAK 12:00 · 48"), `results-d1.json` (`by_hour`).
Fix: derive the window from the data (min/max non-zero hour, or the boutique's opening hours), or render all 24
buckets; compute `peak` over the full array either way.

### D-2 · **MEDIUM-HIGH** — `avg_ticket_vs_boutique` compares a gross average against a net average, flipping an associate's verdict

`maison_pos/api/hr.py`:
* line 478 — `s["avg_ticket"] = gross_sales / tickets` (**returns excluded** from the numerator);
* lines 453-457 — `boutique_totals[…]["sales"] += base_net_total` for **every** invoice including returns, while
  `tickets` counts sales only;
* line 480-481 — `boutique_avg_ticket = bt["sales"] / bt["tickets"]`, then
  `avg_ticket_vs_boutique = avg_ticket / boutique_avg_ticket`.

HOU-MTR, last 30 days (185 invoices): `boutique_avg_ticket` = **44.46** (net basis); the same-basis gross figure is
**46.69**. Every associate's ratio is therefore inflated by exactly **+5.0 %**:

| Associate | avg ticket | ratio shown | same-basis ratio |
|---|---|---|---|
| Dante Ruiz | 45.00 | **1.012 (above store average)** | **0.964 (below)** |
| Keisha Brown | 43.37 | 0.975 | 0.929 |
| Marisol Vega | 74.64 | 1.679 | 1.599 |

The top associate is reported as *above* the store average when he is *below* it. This is a KPI managers act on.
Evidence: `d7-hr.py`, `results-d7.json`. Fix: build `boutique_totals["sales"]` from non-return invoices only
(one `if inv.is_return: continue` before line 456), or switch `avg_ticket` to the net basis — either way, one basis.

### D-3 · **MEDIUM** — the Hourly Sales Heatmap reports $813 of trade in an hour with no trade

`maison_pos/maison_pos/report/maison_hourly_sales_heatmap/maison_hourly_sales_heatmap.py:12,23`:
`HOURS = list(range(8, 22))` and `hour = min(max(hour, 8), 21)` — everything before 08:00 is **clamped into the
08:00 column** and everything after 21:59 into 21:00.

HOU-MTR, 2026-08-23: the report shows `h08 = $813.16, n08 = 25 tickets`. Nothing was sold at 08:00 — those
33 invoices were posted at **04:36**. The report's own `total` is $847.13, so 96 % of the day is attributed to a
phantom 8 a.m. peak. Chain-wide over the seeded history: 48 invoices ($657) folded into 08:00 and 58 ($2,331)
into 21:00. The report exists to plan staffing, so an invented peak is the worst possible failure mode.

Evidence: `d9-reportnums.py` output; the full row is `{h08: 813.16, n08: 25, h14: 26.78, n14: 4, h15: 7.19, n15: 1}`
against a recomputed `{04: 813.16/33, 14: 26.78/6, 15: 7.19/3}`. Fix: widen to 0–23, or emit an
"outside opening hours" column rather than folding into a real one.

### D-4 · **MEDIUM** — "Avg ticket" divides a net-of-returns numerator by a sales-only denominator

`maison_pos/api/dashboard.py:235` — `avg_ticket = net / invoices`, where `net = Σ grand_total` (returns included,
negative) and `invoices` counts sales only. Same convention in `mtd_avg_ticket` (line ~538) and on the Daily Sales
report (`total / tickets`).

Today the Live KPI reads **AVG TICKET 19** ($19.27). The average **sale** today was **$44.60**
($1,382.53 ÷ 31). HOU-MTR's card reads **31** ($30.57) against a real $44.49.
On a normal 2 % return day the error is ~2 %; on any returns-heavy day it is catastrophic, and it is
inconsistent with `hr.employee_performance`, which uses the correct gross basis ($45.00 for the same store).
Either relabel ("net sales per ticket") or use gross/tickets. Evidence: `results-d1.json`, `19-kpi-strip-card-negative.png`.

### D-5 · **MEDIUM** — the Clients tier filter is hard-coded to the jewellery tenant's tiers and empties the list on CloudChaserz

`dashboard/src/components/clients/ClientsView.vue:15` — `const TIERS = ['Patron', 'Collector', 'Connoisseur']`.
`CloudChaserz Rewards` has exactly **one** `Loyalty Program Collection` tier: **"Member"** (min_spent 0). All 26
churn rows and all 131 upcoming rows carry `tier: "Member"`, so **each of the three chips filters the list to 0
rows** — verified against the API too (`clients_overview(tiers=Patron|Collector|Connoisseur)` → churn 0, upcoming 0).
The card then reads "0 CLIENTS · NO CHURN SIGNALS FOR THE SELECTED TIERS".
Evidence: `22-clients-tier-empty-1920.png`, `results-e9.json`. Fix: derive the chips from
`Loyalty Program Collection` (or from the tiers present in the response) instead of a constant.

### D-6 · **MEDIUM** — three of the eleven Maison Script Reports are unreachable from the dashboard and cannot be exported

`maison_pos/api/reports.py:22-31` lists 8 reports in `REPORTS`. **Maison Commission Statement**,
**Maison Promotion Performance** and **Maison Campaign Performance** are missing, so:
* they never appear on the Reports tab (verified: 8 links rendered), and
* `reports.export?report=Maison Commission Statement` → **HTTP 404 `DoesNotExistError: Unknown report`**
  (same for the other two), because `_check()` gates on `REPORT_NAMES`.

Head office therefore has no CSV of commissions, promotions or campaign performance — precisely the three an
accountant or a marketer would ask for. Evidence: `results-e6.json`, curl transcript in section 7.13.

### D-7 · **MEDIUM** — "net sales" means two different things on the same dashboard

* Live tab KPI "Net sales · today" = **$597.38** — `Σ grand_total`, **tax-inclusive** (`dashboard.py:120`).
* Reports tab "Period comparison · net sales · returns netted", "Today vs same weekday last week" = **$553.25** —
  `Σ net_total`, **pre-tax** (`maison_pos/reports.py::period_totals`, `PeriodComparison.vue:24,33`).

Same day, same 11 stores, same word, a $44.13 gap (exactly the day's tax). A head-office user switching tabs sees
two different "net sales" for today with no explanation. The Daily Sales report has both (`Net Sales 847.13` and
`Total (incl. tax) 917.00`) and is unambiguous — the two dashboard surfaces are not.

### D-8 · **LOW-MEDIUM** — the Reports tab prints "Frappe"

`dashboard/src/components/ReportsSection.vue:24` —
`<span class="label">month to date · Frappe desk</span>` renders as **"MONTH TO DATE · FRAPPE DESK"**.
It is the **only** "Frappe"/"ERPNext" string on the whole dashboard: a case-insensitive scan of every tab at
both 1920×1080 and 1440×900 found this one and nothing else.
Evidence: `23-reports-frappe-desk.png`, `results-e7.json`.

### D-9 · **LOW** — Top-by-store `share_pct` does not reconcile with the store net printed beside it

`maison_pos/insights/trends.py:117` — `total_net = sum(max(0.0, flt(r["net"])) for r in group)` clamps
return-only items to zero, whereas `dashboard.py::top_products` returns
`boutique_net = sum(flt(r["net"]))` **including** them, and `TopByStore.vue:12` prints that as the column header.

HOU-MTR 7 d: header prints **"1,721 net"**; `share_pct` uses **1,793.23** (the four negative rows ROL-011 −2.49,
ROL-009 −5.98, DSP-007 −27.99, DSP-015 −35.98 are clamped out). HKA-012 ($792.39) is shown as **44 %** where
792.39 ÷ 1,720.79 = **46 %**. Evidence: `d4-top.py`.

### D-10 · **LOW** — clicking the active "Stores" tab from a store drill-in does not return to the list

`dashboard/src/App.vue::setView` — `if (v !== 'boutiques') boutique.value = null`. From
`?view=boutiques&boutique=HOU-MTR`, clicking **STORES** is a no-op: the user stays on the store page with no
visual feedback. Only the page's own `← STORES` button works. Evidence: `results-e2.json`.

### D-11 · **LOW** — the Card/Cash split shows a refund as 26 % of "tender taken"

`dashboard/src/stores/dashboard.ts:116-118` — `cardPct = |card| / (|card| + |cash|)`.
Today the tile reads **"26 % / 74 % — of gross · -320 · 893"** with the tooltip *"share of gross tender **taken**
today"*, while card tender was net **−$320.40** (money refunded, not taken). The v0.6 R comment documents the
deliberate switch to absolute values (to avoid the old "−62 % / 157 %"), so this is a known trade-off — but the
label still asserts something false on a returns day, and a reader cannot tell 26 % of takings from 26 % of refunds.
Secondary: `cash + card = $572.38` vs `net = $597.38`; the $25.00 gap is loyalty redeemed today, and nothing on
the tile says so.

### D-12 · **LOW** — `live_summary` calls every non-cash tender "card"

`dashboard.py:126` — `... where lower(p.mode_of_payment) <> 'cash'` is summed into `card`. The Daily Sales report
splits the same day into `card −38.95` **and** `other −3.88`; the Live board reports `card −42.83`. Gift cards,
store credit and any future tender are silently reported to head office as card.

### D-13 · **LOW** — the Products "Data as of" stamp can be a full 15-minute cycle stale

Observed at 16:22 CDT: `product_trends()` returned `computed_at (row) = 2026-08-23 16:15:54` but
`last_run.computed_at = 2026-08-23 16:00:53` — and `ProductsView.vue:58` builds the stamp from
`last_run.computed_at`, so the tab claimed data was "as of 16:00" when it was in fact from 16:15.
Suspected cause: `insights/trends.py::compute_trends` calls `frappe.db.set_default(LAST_RUN_KEY, …)` and
`clear_cache()` **before** `frappe.db.commit()`; a concurrent read between the cache clear and the commit
repopulates the defaults cache with the pre-commit value, which then sticks for the rest of the cycle.
Reproduced once; the 16:30:56 tick came back in sync. Fix: commit before clearing the cache / setting the default.

### D-14 · **LOW** — the Serial Ledger report has no boutique scoping and no filter validation

`maison_pos/maison_pos/report/maison_serial_ledger/maison_serial_ledger.py:15` — `f = dict(filters or {})`
instead of `normalize_filters(filters)`, unlike every other Maison report. It therefore ignores
`from_date`/`to_date`, never validates an inverted range (the only Maison report other than Promotion
Performance that silently accepted `from > to`), and applies **no `_boutiques` restriction** — a scoped manager
running it in the desk would see every store's serials. Not exploitable on this tenant (0 serial numbers exist),
but it should be brought in line. *(Flagging for the security agent as well.)*

### D-15 · **MEDIUM (feature dark)** — rebalance suggestions are structurally impossible on this tenant, so one-click Material Transfer cannot be exercised

`insights.summary.open_rebalances = 0`; the last weekly job reports `rebalance: {items: 1733, suggestions: 0}`.
Root cause is arithmetic, not a bug in the pairing code: `product_performance.metrics` flags
`stock_out_risk = on_hand < per_day × 21`, and **not one stock item at any store is under 21 days of cover** —
median cover across 1,733 item×store rows is **540 days** (minimum 33). The only 28 `stock_out_risk` rows are the
five **service** items (SVC-*, `is_stock_item = 0`), which `suggest_rebalances` correctly excludes. I re-ran the
pairing myself with `MIN_MOVE_VALUE` removed entirely: still **0 candidates**.
Secondary tuning issue: `MIN_MOVE_VALUE = 300.0` (`product_performance.py:34`) was calibrated for a jewellery
catalogue; CloudChaserz's most expensive item is **$199.99** and the median line is under $25, so even when
candidates do appear most will be filtered out.
Consequence: the Insights tab permanently reads *"Stock is where it sells — nothing to move"* and the
one-click **Material Transfer** path has no way to be demonstrated. `create_transfer` itself is sound —
`create_transfer('does-not-exist')` returns a clean `DoesNotExistError`.
Fix for the demo: seed at least one under-stocked/over-stocked pair; fix for the product: make
`RISK_COVER_DAYS` / `MIN_MOVE_VALUE` tenant-configurable.

### D-16 · **INFO** — the campaign feature ships with no data on CloudChaserz

1 `Maison Campaign` (`EVENTS-LAUNCH`, status *Scheduled*, `send_date 2026-09-02` — in the future), **0 touches,
0 attributions**, so the Clients-tab campaign card shows `0 sent · 0 opened · $0` and the desk report is empty.
The machinery is correct — I proved the whole loop (section 8) and reverted it — but the demo shows nothing.
The v0.5 seed (`demo_v05_campaigns`) creates three campaigns with touches for the Maison tenant; the
CloudChaserz profile has no equivalent.

### D-17 · **INFO** — `Maison Regional` is completely unscoped

`maison_pos/scoping.py:18` puts `Maison Regional` in `UNRESTRICTED_ROLES`. Verified over HTTP:
`regional.ok@` and `regional.tx@` each receive **all 11 stores** and the same chain net ($597.38) from
`live_summary`; only store managers are narrowed (`hou.mtr.manager@` → `[HOU-MTR]`, $917.00). This is documented
behaviour, but a tenant that ships one regional per region and a dashboard with a Region filter implies otherwise.

### D-18 · **INFO** — Serial Ledger is empty because the tenant has no serialized items
0 `Serial No` records, 0 items with `has_serial_no = 1`. The report is correct but untestable here.

### D-19 · **INFO** — the Sales Tax Summary Total row blends tax rates
The appended Total row prints `Rate % = 8.7396` — the unweighted mean of 11 jurisdiction rates. Meaningless on a
filing report; the cell should be blank.

### D-20 · **INFO** — jewellery vocabulary survives in reports and APIs
Returns reason **"Sizing"** on a smoke shop; `insights.recommend_for_client` returns a `"metal": ""` field on
every item. (Consistent with observation 5 of the v0.6 report.)

### D-21 · **INFO** — narrative copy prints a double negative
*"down -8% against $10,338"* — the card above it correctly shows `▼ 8%`. `insights/narrative.py`.

### D-22 · **INFO** — a store with no sales reports `PEAK 09:00 · 0`
OK-ETUL's page shows a peak hour for an all-zero series (a consequence of D-1's `reduce` over a filtered window).
Should read "—".

### D-23 · **INFO** — the "today" slice is still mostly returns
As in the v0.6 report: 22 of today's 31 chain invoices are credit notes, so 8 of 11 store cards show a negative
net and the KPI strip shows a negative card total. Everything downstream is arithmetically right, but a demo
opened cold looks broken. Seeding a partial day of sales would fix D-11's optics and much of the Live board's.

---

## Site state left behind

* **Created and reverted**: POS sale `ACC-SINV-2026-03080` (OK-MUS, $2.17) — **cancelled**, docstatus 2, OK-MUS
  back to net −60.00 / 0 tickets; `Maison Client Interaction 6m2m5spnbv` — **deleted** (count back to 8) and the
  signal's `assigned_associate` / `call_task` cleared; 2 `Maison Campaign Touch` + 4 `Maison Campaign Attribution`
  rows — **deleted**, attribution re-run, campaign counters back to `0/0/0/0.0/0.0/0`; `Maison Insight Report
  MIR-2026-08-16-Weekly` — **deleted** (count 0).
* **Jobs run on demand** (idempotent, same as the schedulers): `dashboard.compute_trends` (2,500 rows) and
  `insights.compute` (affinity + signals + rebalance). Both are scheduled jobs that would have run anyway;
  `Maison Client Signal` names changed as a result, as they do on every weekly run.
* **Not touched**: system settings, timezone, seeds, users, stock, POS profiles, loyalty, any other agent's data.
* Final re-verification after cleanup: `live_summary` reconciles at **0 discrepancies**, 11 stores, HOU-WH absent.
