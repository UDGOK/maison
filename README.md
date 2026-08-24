# AWANZ POS

A multi-store point of sale and head-office platform built as a custom app on **Frappe Framework v15 + ERPNext v15**. Current release: **v0.6 "CloudChaserz"** (see `CHANGELOG.md`).

The platform is **tenant-branded**: every user-facing string — wordmark, product name, receipt
header, "Store" vs "Boutique", the rewards programme name — comes from brand settings, while the
doctypes, roles and module are named for the product (`AWANZ *`, module `AWANZ POS`). It ships with
two verticals: the **Smoke Shop** profile (CloudChaserz: 11 stores, a Houston warehouse, 21+ age
verification) and the **Jewellery** profile it grew up as.

> **v0.9 renamed the product from Maison to AWANZ.** Doctypes, roles, reports, print formats, the
> module and the dashboard route all moved (`/maison-dashboard` still redirects to
> `/awanz-dashboard`); `bench migrate` carries an existing site across in
> `maison_pos/patches/v0_9/rename_to_awanz.py`. The python package is still `maison_pos` and the
> `maison_*` custom fieldnames on ERPNext doctypes are unchanged — neither is user-visible, and
> both are documented with the reasoning in `docs/white-label.md` §7.

| Part | Where | What |
|---|---|---|
| Backend app | `maison_pos/` | Doctypes, REST API (`maison_pos.api.*`), Stripe Terminal, workflows, print formats, Script Reports, insights jobs, demo + history seed, tests |
| POS PWA | `frontend/` → `maison_pos/public/pos` | Vue 3 offline-first iPad / iPhone point of sale served at `/pos` |
| Head-office dashboard | `dashboard/` → `maison_pos/public/dashboard` | "Command" wall for 40–100 boutiques at `/awanz-dashboard`: Live / Boutiques / Products / Clients / Insights / Reports over Frappe realtime (see `docs/dashboard.md`) |
| Web shop | `maison_pos/webshop/`, `www/shop/*` | Monolith Gold storefront on Frappe Webshop (`/shop`, click & collect) |
| Warehouse & wall | `maison_pos/shipping/`, `frontend/src/warehouse/` | head-office desk at `/warehouse` and the 55" kanban wall at `/warehouse-wall` (see `docs/shipping.md`) |
| Dev environment | `docker/` | docker-compose stack (MariaDB, Redis, Frappe/ERPNext v15, nginx) |

Design system: **Monolith Gold** — Unbounded + Jost on deep black `#0B0B0A`, gold accent; it carries the
CloudChaserz wordmark as readily as the jewellery one. See `SPEC.md` … `SPEC_v0.6.md`.

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

**v0.1 — Point of sale foundation.** AWANZ Store (warehouse + cost centre + POS Profile + receipt address), AWANZ Associate with PIN unlock and roles (Associate / Manager / Regional / Head Office), offline-first PWA with IndexedDB catalogue, serial pickers, idempotent `sales.submit_batch` (`maison_offline_uuid`), Stripe Terminal (semi-integrated, simulated reader without keys), 80 mm ePOS receipt + `AWANZ Receipt` print format, voids, Z-report, `AWANZ Price Approval` workflow → warehouse-scoped Pricing Rule, device heartbeats, live head-office dashboard over socket.io, docker stack, demo seed, Playwright e2e.

**v0.2 — Monolith Gold & scanning.** Gold palette, product images, barcode / receipt-QR scanning (camera + Bluetooth HID wedge), iPhone layout with bottom-sheet basket, receipt QR → public receipt page `/r/<token>`, client numbers (`MC######`) with keypad lookup, loyalty points on the basket and receipt, recognition scaffold.

**v0.3 — On-device client recognition.** face-api descriptors computed on the device, consent (hold-to-agree, `AWANZ Biometric Consent`), enrolment / match / undo / decline / revoke, raw-descriptor euclidean matching (`match_threshold` 0.6), offline enrolment queue, BIPA retention purge, `docs/biometrics-policy.md`.

**v0.4 — Operations & Intelligence.**
- **A Hardware** — Verifone V660p on Stripe Terminal as the handheld: receipts rendered to a 384-px canvas and printed with `terminal.print(canvas)`; reader registry per boutique (`AWANZ Store.readers`) + Settings reader picker; S710 + Epson TM-P20II alternative; simulated reader with `has_printer` for e2e. `docs/hardware.md`.
- **B Clienteling** — `AWANZ Client Profile` (sizes, metals, dates, do-not-contact, wishlist, owned pieces), Frappe CRM Contact / CRM Task glue, interactions timeline, wishlist arrival alerts, POS Client → Clienteling tab. `docs/crm.md`.
- **C Employees & payroll** — AWANZ Associate ↔ HRMS Employee, clock-in / out on the Unlock screen (`AWANZ Shift` → Employee Checkin), commission rules + entries (reversed on return), Commission Statement, payroll exports (HRMS Additional Salary, Gusto / ADP / QuickBooks CSV). `docs/payroll.md`.
- **D Inventory** — Item Reorder levels → hourly `inventory.low_stock_scan` → `AWANZ Stock Alert` + notifications + daily digest, Shift-screen alerts with transfer requests, Cycle count screen → `AWANZ Cycle Count` + draft Stock Reconciliation.
- **E Returns & exchanges** — Returns screen (receipt QR / invoice / client), line + serial + reason + condition, refund to original card (Stripe refund) / cash / store credit, exchanges with difference, manager PIN over threshold / outside window, `AWANZ Return Receipt`, Damaged warehouses. `docs/returns.md`.
- **F Reports** — 8 Script Reports (Sales Tax Summary, Daily Sales, Sales by Item / Group / Department, Sales by Associate, Hourly Heatmap, Client Purchases RFM, Serial Ledger, Returns) + Commission Statement + Promotion Performance; `reports.run / export` with boutique scoping; dashboard Reports section + period comparison.
- **G Web shop** — Frappe Webshop + Payments with a Monolith Gold theme (`/shop`, collection, item, cart, checkout, account), web modes Buy / Enquire / Reserve-with-deposit, availability per boutique, click & collect → POS "Web orders" queue (pick → ready → collect → Sales Invoice with the advance allocated), loyalty lookup on the web. `docs/webshop.md`.
- **H Insights** — affinity / next-best-offer (`AWANZ Client Recommendation`), client signals (cadence, churn risk, dates), product performance + rebalance suggestions with one-click Material Transfer, weekly narrative (template or Anthropic), dashboard Insights tab, `seed_history(months)` for 6 months of plausible sales.
- **I Promotions, feedback, loyalty** — ERPNext Pricing Rules applied on the basket (Promotions chip), `AWANZ Coupon` (single / multi-use, client-bound, item-group scoped), private post-visit feedback on `/r/<token>` → `AWANZ Feedback` + HQ tile + low-rating alerts, tier progress, points expiry, birthday bonus.
- **J Scanners** — Bluetooth HID scanners (Socket Mobile S740, Zebra CS6080, Inateck) with prefix / suffix configuration and a Settings scanner test. `docs/scanners.md`.

**v0.5 — Salon & Command.**
- **K AWANZ Salon** — a client-facing second screen (`/salon`) in the same PWA bundle: paired to a till with a 6-digit code / QR, ambient "light on metal" canvas + HQ playlist, identify or join, live basket mirror (piece, serial, certificate, running total, points), payment pulse, thank-you with receipt QR, private 1–5 feedback and a private-viewing invitation, plus a Concierge Q&A that writes back to the client profile. `docs/salon.md`.
- **L Command dashboard v2** — rebuilt for 40–100 stores: Live / Stores / Products / Clients / Insights / Reports, per-store live cards that pulse on a sale, chain ticker, drill-in with item-level feed, virtualised lists and rAF-batched socket events folded into incremental aggregates (full reconcile only every 60 s), sortable store table with sparklines, trending products by store. `docs/dashboard.md`.
- **M HQ intelligence** — campaign attribution (last-touch 14 d + assisted 30 d + item level), segment builder, signed Klaviyo / Brevo webhooks, campaign performance report, associate KPIs, VIP assign-call → CRM task. `docs/campaigns.md`.

**v0.6 — CloudChaserz.**
- **N Brand, vertical & age verification** — brand settings drive every user-facing string (`catalog.bootstrap.brand{…}`); `vertical` selects the product attributes, the item groups and "Store" vs "Boutique". **21+ age gate**: scan the PDF417 on a US licence (AAMVA parsed on the device) or key the DOB; under-age and expired IDs are refused before the item reaches the basket; `AWANZ Age Check` records the outcome, method, initials and issuing state and nothing else. The CloudChaserz seed builds the 11 real stores, the `HOU-WH` warehouse, ~120 smoke-shop items with EAN-13 and generated art, the tax templates and the demo staff. `docs/cloudchaserz.md`.
- **O Store scoping & receiving** — store managers are scoped server-side *and* in desk list views; a manager gets 403 on another store's data over plain HTTP. New POS **Receive** screen: inbound shipments and vendor POs, scan or tap to count, discrepancies highlighted, partial receipts, and one-tap "Request from warehouse" from the low-stock list.
- **P Warehouse & shipping** — replenishment request → warehouse approval (edit quantities or reject with a reason) → `AWANZ Shipment` picked, packed, labelled and shipped, with an in-transit stock leg so nothing is ever "nowhere". Rate shopping behind one adapter (Simulated by default, **Shippo** implemented for real, EasyPost as the alternative — Pirate Ship has no public API); cheapest auto-selected. `/warehouse` desk and the 1920×1080 `/warehouse-wall` kanban with age timers, realtime updates and silent auto-printing of packing lists and labels under Chrome kiosk mode. `docs/shipping.md`.
- **Q CloudChaserz Rewards** — $1 = 1 point; fixed tiers $5/100, $10/200, $15/300, offered only when affordable and reversed on return; birthday coupon, monthly promotion calendar, weekly new-arrivals campaign, seeded auditable giveaways and event invites; public `/rewards` page and sign-up, with points, balance and next reward on every receipt. `docs/rewards.md`.

## Quick start (existing bench)
```bash
bench get-app payments --branch version-15 && bench get-app webshop --branch version-15
bench get-app hrms --branch version-15     && bench get-app crm --branch main
bench get-app https://github.com/UDGOK/maison
bench --site yoursite install-app erpnext payments webshop hrms crm maison_pos
```

**CloudChaserz (the smoke-shop tenant — 11 stores, warehouse, 21+, rewards):**
```bash
bench --site yoursite execute maison_pos.setup.cloudchaserz.seed                                   # company, 11 stores + HOU-WH, ~120 items, users, rewards
bench --site yoursite execute maison_pos.setup.cloudchaserz.seed_history --kwargs '{"months":3}'   # back-dated sales across the 11 stores
bench --site yoursite execute maison_pos.insights.jobs.compute_weekly                              # recommendations, signals, rebalance
bench build --app maison_pos
```
Open `/pos`, `/warehouse`, `/warehouse-wall`, `/awanz-dashboard`, `/shop`, `/rewards`, `/salon`.
Everything is branded CloudChaserz. Demo password **`cloud123`**: associate
`hou.mtr.a1@cloudchaserz.example` PIN `2580`, manager `hou.mtr.manager@cloudchaserz.example` PIN
`1101`, warehouse `warehouse@cloudchaserz.example`, head office `hq@cloudchaserz.example`, web
shopper `shopper@cloudchaserz.example` (full table in `docs/cloudchaserz.md`). New shoppers
register on the storefront itself at `/shop/register` — no mail server needed. On a managed host without shell access, the same seed over
the API: `POST /api/method/maison_pos.setup.cloudchaserz.seed_remote`, then
`…cloudchaserz.seed_history_remote {"months": 3}` and `…cloudchaserz.status` to watch it.

**Jewellery (the original profile, what the regression suites use):**
```bash
bench --site yoursite execute maison_pos.setup.demo.seed --kwargs '{"vertical":"Jewellery"}'       # company, 3 boutiques, 42 items, clients, PINs
bench --site yoursite execute maison_pos.setup.demo_history.seed_history --kwargs '{"months":6}'   # ~10 min: 1,500 back-dated invoices
bench --site yoursite execute maison_pos.insights.jobs.compute_weekly
bench build --app maison_pos
```
Demo associate: `chi.oak.a1@maison.example` / `maison123`, PIN `2580`; manager `chi.oak.manager@maison.example`, PIN `1234`; web shopper `client@maison.example` / `maison123` (see `maison_pos/setup/demo*.py`).

> **These demo passwords and PINs are shared constants, identical on every seeded site** — they
> are a convenience, not credentials. A seeded site must hold no real client data, and any site
> reachable from the internet has to be re-credentialed first (`maison_associate.reset_pin` per
> associate, new passwords, `bench set-admin-password`). See `docs/security.md`.

> One brand per site. The two profiles use different companies so they *can* coexist, but the brand
> settings are a singleton — seeding CloudChaserz onto a jewellery site rebrands it.

Stripe: add `stripe_secret_key` / `stripe_publishable_key` to `site_config.json`; without them the POS uses a simulated reader (with printer) and the web shop a simulated gateway. Optional `anthropic_api_key` turns on the LLM weekly narrative. Shipping: add `shippo_api_key` for real carrier rates and labels — without it the warehouse uses the simulated carrier (`docs/shipping.md`).

## Quick start (docker)
```bash
cd docker && ./setup.sh        # see docker/README.md
```

## Develop
```bash
cd frontend  && npm i && npm run models && VITE_MOCK=1 npm run dev   # POS with mock API
cd dashboard && npm i && VITE_MOCK=1 npm run dev                     # dashboard with simulated sales stream
npm test && npx vue-tsc --noEmit && npm run lint && npm run build     # in either folder
bench --site yoursite run-tests --app maison_pos                      # 248 backend tests
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://yoursite:8000 ADMIN_PWD=admin BENCH=/path/to/bench \
  node e2e/pos.v04.e2e.mjs        # also pos.e2e / pos.v02 / pos.v03 / webshop / salon / dashboard.v05
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc-site:8000 ADMIN_PWD=admin \
  node e2e/warehouse.e2e.mjs && node e2e/cloudchaserz.e2e.mjs         # against a CloudChaserz site
```

## Docs
`SPEC*.md` (contracts + design system) · `CHANGELOG.md` · `maison_pos/README_BACKEND.md` · `INTEGRATION_NOTES.md` (bench + Frappe Cloud steps) · `docs/*.md` (cloudchaserz, **security**, **white-label**, shipping, rewards, salon, dashboard, campaigns, hardware, crm, payroll, returns, webshop, scanners, biometrics-policy) · `e2e/REPORT.md`, `e2e/CLOUD_REPORT.md` · `docker/README.md`
