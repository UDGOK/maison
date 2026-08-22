# Maison POS

A luxury-retail point of sale and head-office platform built as a custom app on **Frappe Framework v15 + ERPNext v15**, for a boutique chain growing from 40 to 100+ stores. Current release: **v0.4 "Operations & Intelligence"** (see `CHANGELOG.md`).

| Part | Where | What |
|---|---|---|
| Backend app | `maison_pos/` | Doctypes, REST API (`maison_pos.api.*`), Stripe Terminal, workflows, print formats, Script Reports, insights jobs, demo + history seed, tests |
| POS PWA | `frontend/` → `maison_pos/public/pos` | Vue 3 offline-first iPad / iPhone point of sale served at `/pos` |
| Head-office dashboard | `dashboard/` → `maison_pos/public/dashboard` | "Command" wall for 40–100 boutiques at `/maison-dashboard`: Live / Boutiques / Products / Clients / Insights / Reports over Frappe realtime (see `docs/dashboard.md`) |
| Web shop | `maison_pos/webshop/`, `www/shop/*` | Monolith Gold storefront on Frappe Webshop (`/shop`, click & collect) |
| Dev environment | `docker/` | docker-compose stack (MariaDB, Redis, Frappe/ERPNext v15, nginx) |

Design system: **Monolith Gold** — Unbounded + Jost on deep black `#0B0B0A`, gold accent. See `SPEC.md` … `SPEC_v0.4.md`.

## Apps

| App | Repo | Branch | Role |
|---|---|---|---|
| `frappe` | https://github.com/frappe/frappe | `version-15` | framework |
| `erpnext` | https://github.com/frappe/erpnext | `version-15` | stock, accounting, POS Profiles, Pricing Rules, Loyalty |
| `payments` | https://github.com/frappe/payments | `version-15` | Stripe gateway for web checkout (v0.4) |
| `webshop` | https://github.com/frappe/webshop | `version-15` | online boutique, cart, Website Items (v0.4) |
| `hrms` | https://github.com/frappe/hrms | `version-15` | Employees, Employee Checkin, Additional Salary / Payroll (v0.4) |
| `crm` | https://github.com/frappe/crm | `main` | Frappe CRM: Contacts, CRM Tasks for clienteling follow-ups (v0.4) |
| `maison_pos` | https://github.com/UDGOK/maison | `main` | this app (`required_apps`: erpnext, hrms, crm; webshop/payments are feature-detected) |

Install order on a site: `erpnext`, `payments`, `webshop`, `hrms`, `crm`, **then** `maison_pos` (verified from scratch in `INTEGRATION_NOTES.md`).

## Features by release

**v0.1 — Point of sale foundation.** Maison Boutique (warehouse + cost centre + POS Profile + receipt address), Maison Associate with PIN unlock and roles (Associate / Manager / Regional / Head Office), offline-first PWA with IndexedDB catalogue, serial pickers, idempotent `sales.submit_batch` (`maison_offline_uuid`), Stripe Terminal (semi-integrated, simulated reader without keys), 80 mm ePOS receipt + `Maison Receipt` print format, voids, Z-report, `Maison Price Approval` workflow → warehouse-scoped Pricing Rule, device heartbeats, live head-office dashboard over socket.io, docker stack, demo seed, Playwright e2e.

**v0.2 — Monolith Gold & scanning.** Gold palette, product images, barcode / receipt-QR scanning (camera + Bluetooth HID wedge), iPhone layout with bottom-sheet basket, receipt QR → public receipt page `/r/<token>`, client numbers (`MC######`) with keypad lookup, loyalty points on the basket and receipt, recognition scaffold.

**v0.3 — On-device client recognition.** face-api descriptors computed on the device, consent (hold-to-agree, `Maison Biometric Consent`), enrolment / match / undo / decline / revoke, raw-descriptor euclidean matching (`match_threshold` 0.6), offline enrolment queue, BIPA retention purge, `docs/biometrics-policy.md`.

**v0.4 — Operations & Intelligence.**
- **A Hardware** — Verifone V660p on Stripe Terminal as the handheld: receipts rendered to a 384-px canvas and printed with `terminal.print(canvas)`; reader registry per boutique (`Maison Boutique.readers`) + Settings reader picker; S710 + Epson TM-P20II alternative; simulated reader with `has_printer` for e2e. `docs/hardware.md`.
- **B Clienteling** — `Maison Client Profile` (sizes, metals, dates, do-not-contact, wishlist, owned pieces), Frappe CRM Contact / CRM Task glue, interactions timeline, wishlist arrival alerts, POS Client → Clienteling tab. `docs/crm.md`.
- **C Employees & payroll** — Maison Associate ↔ HRMS Employee, clock-in / out on the Unlock screen (`Maison Shift` → Employee Checkin), commission rules + entries (reversed on return), Commission Statement, payroll exports (HRMS Additional Salary, Gusto / ADP / QuickBooks CSV). `docs/payroll.md`.
- **D Inventory** — Item Reorder levels → hourly `inventory.low_stock_scan` → `Maison Stock Alert` + notifications + daily digest, Shift-screen alerts with transfer requests, Cycle count screen → `Maison Cycle Count` + draft Stock Reconciliation.
- **E Returns & exchanges** — Returns screen (receipt QR / invoice / client), line + serial + reason + condition, refund to original card (Stripe refund) / cash / store credit, exchanges with difference, manager PIN over threshold / outside window, `Maison Return Receipt`, Damaged warehouses. `docs/returns.md`.
- **F Reports** — 8 Script Reports (Sales Tax Summary, Daily Sales, Sales by Item / Group / Department, Sales by Associate, Hourly Heatmap, Client Purchases RFM, Serial Ledger, Returns) + Commission Statement + Promotion Performance; `reports.run / export` with boutique scoping; dashboard Reports section + period comparison.
- **G Web shop** — Frappe Webshop + Payments with a Monolith Gold theme (`/shop`, collection, item, cart, checkout, account), web modes Buy / Enquire / Reserve-with-deposit, availability per boutique, click & collect → POS "Web orders" queue (pick → ready → collect → Sales Invoice with the advance allocated), loyalty lookup on the web. `docs/webshop.md`.
- **H Insights** — affinity / next-best-offer (`Maison Client Recommendation`), client signals (cadence, churn risk, dates), product performance + rebalance suggestions with one-click Material Transfer, weekly narrative (template or Anthropic), dashboard Insights tab, `seed_history(months)` for 6 months of plausible sales.
- **I Promotions, feedback, loyalty** — ERPNext Pricing Rules applied on the basket (Promotions chip), `Maison Coupon` (single / multi-use, client-bound, item-group scoped), private post-visit feedback on `/r/<token>` → `Maison Feedback` + HQ tile + low-rating alerts, tier progress, points expiry, birthday bonus.
- **J Scanners** — Bluetooth HID scanners (Socket Mobile S740, Zebra CS6080, Inateck) with prefix / suffix configuration and a Settings scanner test. `docs/scanners.md`.

## Quick start (existing bench)
```bash
bench get-app payments --branch version-15 && bench get-app webshop --branch version-15
bench get-app hrms --branch version-15     && bench get-app crm --branch main
bench get-app https://github.com/UDGOK/maison
bench --site yoursite install-app erpnext payments webshop hrms crm maison_pos
bench --site yoursite execute maison_pos.setup.demo.seed                                    # company, 3 boutiques, 42 items, clients, PINs, v0.4 demo data
bench --site yoursite execute maison_pos.setup.demo_history.seed_history --kwargs '{"months":6}'   # ~10 min: 1,500 back-dated invoices
bench --site yoursite execute maison_pos.insights.jobs.compute_weekly                      # recommendations, signals, rebalance
bench build --app maison_pos
```
Then open `/pos` (associate login, PIN unlock), `/maison-dashboard` (Head Office role) and `/shop`.
Demo associate: `chi.oak.a1@maison.example` / `maison123`, PIN `2580`; manager `chi.oak.manager@maison.example`, PIN `1234`; web shopper `client@maison.example` / `maison123` (see `maison_pos/setup/demo*.py`).

Stripe: add `stripe_secret_key` / `stripe_publishable_key` to `site_config.json`; without them the POS uses a simulated reader (with printer) and the web shop a simulated gateway. Optional `anthropic_api_key` turns on the LLM weekly narrative.

## Quick start (docker)
```bash
cd docker && ./setup.sh        # see docker/README.md
```

## Develop
```bash
cd frontend  && npm i && npm run models && VITE_MOCK=1 npm run dev   # POS with mock API
cd dashboard && npm i && VITE_MOCK=1 npm run dev                     # dashboard with simulated sales stream
npm test && npx vue-tsc --noEmit && npm run lint && npm run build     # in either folder
bench --site yoursite run-tests --app maison_pos                      # 153 backend tests
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://yoursite:8000 ADMIN_PWD=admin BENCH=/path/to/bench \
  node e2e/pos.v04.e2e.mjs                                            # also pos.e2e / pos.v02 / pos.v03 / webshop
```

## Docs
`SPEC*.md` (contracts + design system) · `CHANGELOG.md` · `maison_pos/README_BACKEND.md` · `INTEGRATION_NOTES.md` (bench + Frappe Cloud steps) · `docs/*.md` (hardware, crm, payroll, returns, webshop, scanners, biometrics-policy) · `e2e/REPORT.md`, `e2e/CLOUD_REPORT.md` · `docker/README.md`
