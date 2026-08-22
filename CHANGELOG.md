# Changelog

All notable changes to Maison POS. Versions follow the `SPEC*.md` contracts; the app version lives in
`maison_pos/__init__.py`, `frontend/package.json` and `dashboard/package.json`.

## 0.4.0 — 2026-08-22 "Operations & Intelligence"

Apps added alongside ERPNext: `payments` + `webshop` (`version-15`), `hrms` (`version-15`), `crm` (`main`).
`maison_pos.hooks.required_apps = ["erpnext", "hrms", "crm"]`; webshop / payments are feature-detected.

### Added
- **A Hardware** — V660p "reader printer" route (`printer/canvas.ts` 384-px monochrome receipt → `terminal.print(canvas)`), `Maison Boutique Reader` registry (`readers`, `damaged_warehouse`), Settings reader picker persisted per device, print route auto / reader / ePOS / browser, simulated reader with `has_printer`; `docs/hardware.md`.
- **B Clienteling** — `Maison Client Profile` (+ `Maison Wishlist Item`), `Maison Client Interaction`, CRM Contact / CRM Task glue, `api/crm.py` (`profile`, `update_profile`, `wishlist_add/remove`, `tasks`, `interactions`, `log_interaction`, `wishlist_matches`, `upcoming_dates`), wishlist arrival alerts on Stock Entry submit, POS Client → Clienteling tab (`ClientProfilePanel.vue`); `docs/crm.md`.
- **C Employees & payroll** — `Maison Associate.employee`, `Maison Shift` + HRMS Employee Checkin from the Unlock screen (`api/hr.py` `clock_in/out`, `toggle_break`, `on_shift`), `Maison Commission Rule` / `Maison Commission Entry` (created on submit, reversed on cancel / return), **Maison Commission Statement** report, `hr.payroll_export` (hrms / gusto / adp / quickbooks), employee performance tile; `docs/payroll.md`.
- **D Inventory** — `Maison Stock Alert` (hourly `inventory.low_stock_scan`, daily digest, Notification Log), `inventory.alerts / acknowledge / resolve / request_transfer` (Material Request), `Maison Cycle Count` + draft Stock Reconciliation (`CycleCountView.vue`, "Count" nav entry), Shift-screen Low stock card, dashboard tile.
- **E Returns & exchanges** — `api/returns.py` (`lookup`, `return_items`, `exchange`, `policy`, `recent`), credit notes with `update_stock`, serial back to the boutique or Damaged warehouse, Stripe refunds by PaymentIntent (`stripe_terminal.client.refund`), commission + loyalty reversal, manager PIN gate (`returns_manager_threshold`, `return_window_days`, `exchange_window_days`), `Maison Return Receipt` print format, `ReturnsView.vue` / `ExchangeView.vue`; `docs/returns.md`.
- **F Reports** — Script Reports Maison Sales Tax Summary, Daily Sales, Sales by Item, Sales by Associate, Hourly Sales Heatmap, Client Purchases (RFM), Serial Ledger, Returns, Promotion Performance, Commission Statement; `api/reports.py` (`list_reports`, `run`, `export` CSV, `period_comparison`) with boutique scoping; dashboard Reports section + period comparison widget.
- **G Web shop** — Monolith Gold storefront (`www/shop/*`, `templates/webshop/*`, `public/css/maison-web.css`), `MaisonWebsiteItem` override, web modes Buy / Enquire / Reserve-with-deposit (`Item.maison_web_mode`), availability per boutique, `Maison Web Enquiry`, click & collect Sales Orders (`maison_boutique`, `maison_web_status` New → Picking → Ready → Collected), `api/webshop.py`, POS `WebOrdersView.vue` (badge in the nav), simulated gateway without Stripe keys, `MaisonPaymentRequest`; `docs/webshop.md`.
- **H Insights** — `maison_pos/insights/` (affinity lift, client signals, product performance / rebalance, narrative), doctypes `Maison Client Recommendation`, `Maison Client Signal`, `Maison Rebalance Suggestion`, `Maison Insight Report`, weekly cron jobs (Mon 05:00 / 06:00), `api/insights.py`, POS "Suggested for this client" + "Pairs well with" tiles, dashboard Insights tab, `setup/demo_history.py` (`seed_history(months)`, `seed_history_remote`, `history_status`).
- **I Promotions, feedback, loyalty** — Pricing Rules on the basket (`PromotionsChip.vue`, `stores/promos.ts`), `Maison Coupon` + `Maison Coupon Redemption` (`promotions.check_coupon`, server re-validation in `submit_batch`), private feedback on `/r/<token>` (`Maison Feedback`, `feedback.submit` guest POST, HQ `list / summary / respond`, ≤ 2 alert), tier progress + points expiry on the basket / receipt page, daily `promotions.birthday_bonus`, tier Customer Groups (Collector / Connoisseur / Patron).
- **J Scanners** — prefix / suffix (Tab vs Enter) configuration and a Settings scanner test for Bluetooth HID scanners; `docs/scanners.md`.
- e2e `e2e/pos.v04.e2e.mjs` (37 checks: coupon, V660p canvas print, clock-in, low stock, clienteling, suggestions, return + exchange, web order collection, guest feedback, tax report, nav fit), screenshots in `e2e/shots-v04/`.

### Changed
- `sales.submit_batch` line semantics are now enforced as specified: `rate` = unit list rate, `discount_amount` = whole-line discount (manual + promotion). Previously the server treated `rate` as net and the discount as per-unit, so any discounted line produced `PAYMENT_MISMATCH`.
- System Settings `rounding_method` is pinned to **Commercial Rounding** on install / migrate (`setup.install.ensure_rounding_method`) so server totals equal the device's half-away-from-zero totals on half-cent taxes.
- `catalog.bootstrap.boutique` now carries `readers[]` and `damaged_warehouse`.
- TopBar: 8 entries (Sell, Client, Returns, Web orders, Count, Queue, Shift, Settings); compact labels and boutique code only ≤ 1100 px so the row fits an iPad in landscape; phone drawer lists all entries.
- Frappe Cloud: `payments`, `webshop`, `hrms`, `crm` must be added to the release group (see `INTEGRATION_NOTES.md`).

### Fixed
- `tests/test_recognition.test_retention_purge` was order dependent: back-dating an invoice at DB level before the next stock submit triggered an item-wise repost of the same item that failed on the 2023 date.
- `tests/test_insights.test_client_recommendations_exclude_owned_items` assumed a demo client with no history; uses a dedicated client.
- Promotions chip on the iPhone sheet was 44 px tall (touch targets are ≥ 48 px).
- e2e serial detection picked the promotion marker on non-serialized lines (`.line-sub .good.serial`).

## 0.3.0 — 2026-08-22 "Client recognition"
On-device face-api descriptors, consent (`Maison Biometric Consent`, hold-to-agree), enrol / match / undo / decline / revoke, raw-descriptor euclidean matching (`match_threshold` 0.6, patch `v0_3.match_threshold_distance`), template delta sync, offline enrolment queue, BIPA retention purge (`tasks.purge_expired_biometrics`), `docs/biometrics-policy.md`, `e2e/pos.v03.e2e.mjs`.

## 0.2.0 — 2026-08-22 "Monolith Gold"
Gold palette, product images, barcode / QR scanning (camera + HID wedge), iPhone layout with bottom-sheet basket, receipt QR + public receipt page `/r/<token>` (`sales.receipt` guest JSON), client numbers `MC######` (patch `v0_2.backfill_client_numbers`), loyalty points on basket / receipt, `e2e/pos.v02.e2e.mjs`.

## 0.1.0 — 2026-08-21 "Foundation"
Frappe app (`Maison Boutique`, `Maison Associate`, `Maison Price Change Request` + workflow, `Maison Device Heartbeat`, `Maison Sync Log`, `Maison POS Settings`), offline-first Vue 3 PWA at `/pos`, idempotent `sales.submit_batch`, Stripe Terminal (simulated without keys), ePOS 80 mm receipts + `Maison Receipt` print format, voids, Z-report, live dashboard at `/maison-dashboard`, docker stack, demo seed (`seed`, `seed_remote`), `e2e/pos.e2e.mjs`.
