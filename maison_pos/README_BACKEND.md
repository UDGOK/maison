# AWANZ POS — backend (Frappe app)

Python package for the AWANZ POS Frappe/ERPNext v15 app: doctypes, fixtures,
whitelisted API used by the PWA, Stripe Terminal helpers, receipt print format,
demo seed and tests.

## Requirements

- Frappe Framework v15, ERPNext v15 (`required_apps = ["erpnext"]`)
- Python 3.10+
- `stripe` Python SDK and `segno` (receipt QR, pure python) — both installed automatically from `pyproject.toml`

## Install

```bash
cd frappe-bench
bench get-app maison_pos https://github.com/<org>/maison            # or: bench get-app /path/to/maison
bench --site maison.localhost install-app maison_pos
bench --site maison.localhost migrate                                # syncs fixtures (roles, custom fields, workflow, print format)
```

`after_install` creates the four `AWANZ *` roles, the Item / Sales Invoice / Customer
custom fields, the `Cash` and `Card` modes of payment, the `AWANZ Price Approval`
workflow and the `AWANZ Receipt` print format. All steps are idempotent and
`after_migrate` re-applies roles, custom fields, role permissions, modes of payment and
refreshes the receipt print format HTML. Custom fields live in
`fixtures/custom_field.json` (synced by `bench migrate` *and* applied through
`create_custom_fields` in `setup/install.py`, so a fresh site gets everything either way).
The v0.2 patch `maison_pos.patches.v0_2.backfill_client_numbers` assigns a client number to
every existing Customer; the v0.3 patch `maison_pos.patches.v0_3.biometrics_fields` adds the
biometric fields and fills the recognition settings defaults (consent text, threshold, retention).

## Demo data

```bash
bench --site maison.localhost execute maison_pos.setup.demo.seed
```

Creates company **AWANZ** (abbr `MSN`, USD, Standard chart), three boutiques
(`NYC-5AV`, `CHI-OAK`, `MIA-DD`) each with Warehouse + Cost Center + POS Profile +
Sales Tax template, 41 items across Timepieces / High Jewellery / Bridal /
Accessories / Services (watches, high jewellery and solitaires are serialized;
opening stock is posted per boutique with generated serials such as
`TP-001-NYC-001`), `Standard Selling` prices, 20 customers (each with a `MC######` client number), loyalty
program **AWANZ Collectors** (Collector / Connoisseur / Patron), and demo users. Every
item gets a deterministic EAN-13 (`Item.maison_barcode` + an `Item Barcode` row); serial
labels are Code-128 of the serial number itself.

| Login | Role | PIN |
| --- | --- | --- |
| `hq@maison.example` | AWANZ Head Office | — |
| `regional@maison.example` | AWANZ Regional | — |
| `nyc.5av.manager@maison.example` (and `chi.oak.`, `mia.dd.`) | AWANZ Manager | `1234` |
| `nyc.5av.a1@maison.example` / `nyc.5av.a2@...` (per boutique) | AWANZ Associate | `2580` / `1357` |

Password for every demo user: `maison123`. The seed is safe to re-run.

## Site config keys (`sites/<site>/site_config.json`)

| Key | Purpose |
| --- | --- |
| `stripe_secret_key` | Stripe secret key (`sk_live_…` / `sk_test_…`). When absent every Stripe Terminal endpoint returns `{"simulated": true, …}` and the PWA uses the simulated reader. |
| `stripe_publishable_key` | Returned to the client by `stripe_terminal.connection_token` / `status`. |
| `stripe_api_version` | Optional pin for the Stripe API version (default `2024-06-20`). |

## API

All endpoints live under `/api/method/maison_pos.api.<module>.<fn>` and accept
session or token auth (`Authorization: token api_key:api_secret`).

| Endpoint | Notes |
| --- | --- |
| `catalog.bootstrap(boutique)` | Full snapshot: boutique (incl. `show_product_images`), POS profile, `settings`, taxes, modes of payment, item groups, departments, items (with absolute `image` URL or `null`, `maison_barcode`), prices, pricing_rules (warehouse-scoped), serials, `barcodes`, stock, loyalty program, `version`. |
| `catalog.delta(boutique, since)` | Same shape filtered by `modified >= since`, plus `deleted[]` and `serials_removed{}`. |
| `catalog.upload_item_image(item_code, file)` | `POST` multipart (field `file`, JPEG/PNG/WebP ≤ 5 MB). AWANZ Manager / Head Office / System Manager. Creates a public `File` attached to the Item, sets `Item.image`; returns `{item_code, image (absolute), file_url, file_name}`. |
| `customers.search(q, limit)` / `customers.lookup(code)` / `customers.upsert(customer)` / `customers.history(customer, limit)` | `search` matches client number, phone (digits only, 4+ digits, any formatting), email and name; rows include `client_number`, `loyalty_points`, `points_value`, `tier`. `lookup` is exact: `MC123456`, `MC:<customer_id>` / `MC:MC123456` (client QR), full phone, email → one row or `null`. Upsert matches by mobile / email when `name` is not given. |
| `sales.receipt(token)` | **Guest**, `GET`. JSON receipt for the token printed in the receipt QR (boutique, datetime, lines, totals, payment brand/last4, masked client number, points). Same payload backs the public page `/r/<token>`. |
| `sales.submit_batch(invoices)` | Idempotent on `offline_uuid` (`AWANZ Sync Log` + unique custom field). Each invoice runs in its own savepoint; failures return `status: "error"` with `error_code` (`SERIAL_UNAVAILABLE`, `PAYMENT_MISMATCH`, `PERMISSION_DENIED`, `NOT_FOUND`, `VALIDATION_ERROR`, `SERVER_ERROR`). |
| `sales.list(boutique, date)` | X/Z report summary. |
| `sales.void(invoice, reason)` | Manager+. Creates and submits a POS Sales Return; idempotent per invoice. |
| `stripe_terminal.connection_token(boutique)` / `create_payment_intent(amount, currency, offline_uuid, customer?)` / `capture(payment_intent_id)` | `card_present`, `capture_method=manual`, idempotency key derived from `offline_uuid`. |
| `dashboard.live_summary(date?)` | Totals, per-boutique (with `status: online / offline / pending_approval`), hourly series, pending approvals. |
| `dashboard.heartbeat(boutique, device_id, queued, app_version?)` | Upserts `AWANZ Device Heartbeat`, publishes `awanz_heartbeat`. |
| `session.me()` / `session.associates(boutique)` | Helpers for the Unlock screen. |
| `maison_pos.awanz_pos.doctype.awanz_associate.awanz_associate.verify_pin(associate, pin)` | PIN unlock (PBKDF2-SHA256, locks after 5 failures). |

Realtime (socket.io room `awanz_dashboard`): `awanz_sale`, `awanz_sale_cancelled`,
`awanz_heartbeat`, `maison_price_approved`.

### Boutique scoping

`maison_pos.scoping` resolves the caller's `AWANZ Associate`. Users holding
`AWANZ Associate` / `AWANZ Manager` can only act on their own boutique
(`assert_boutique_access`); `AWANZ Head Office`, `AWANZ Regional`,
`System Manager` and Administrator are unrestricted. List views of
`AWANZ Price Change Request`, `AWANZ Device Heartbeat` and `AWANZ Sync Log`
are filtered through `permission_query_conditions`. The demo seed also adds a
User Permission on the boutique warehouse for managers/associates.

## Price overrides

`AWANZ Price Change Request` (submittable) drives the `AWANZ Price Approval`
workflow: Draft → Pending Approval (Manager) → Approved / Rejected (Head Office or
Regional). On Approved the document creates or updates a Pricing Rule titled
`AWANZ <boutique> <item_code>` with `warehouse` = the boutique's warehouse,
`rate_or_discount = Rate`, valid dates copied from the request. Cancelling the
request disables the rule.

## Receipt

Print Format **AWANZ Receipt** (Jinja, Sales Invoice) renders
`templates/print/receipt.html` at 80 mm (the same HTML is embedded in
`fixtures/print_format.json`; keep both in sync). Boutique address / phone come from the
`AWANZ Store` linked via `maison_boutique`; card brand / last4 / approval from
the `awanz_card_*` custom fields; the client number (`Customer.maison_client_number`)
and points earned / balance are printed; signature line appears for totals ≥ 10 000.

### Receipt QR / public receipt

On submit of a POS invoice `before_submit` stores a 16-char url-safe
`maison_receipt_token`. The QR content is `<receipt_qr_base_url>/r/<token>`
(`AWANZ POS Settings.receipt_qr_base_url`, default = site URL). The print format renders
the QR server-side with `segno` as an SVG data URI (`receipt_qr_svg(doc)` Jinja helper;
empty when `receipt_qr_enabled` is off). `/r/<token>` (`www/r.py` + `www/r.html`,
`website_route_rules`) is a guest page in Monolith Gold with self-contained CSS, `noindex`,
404 for unknown tokens. `maison_pos.api.sales.receipt?token=…` returns the JSON.

## AWANZ POS Settings (single)

| Field | Default | Used for |
| --- | --- | --- |
| `show_product_images_default` | 0 | Tiles show `Item.image`; `AWANZ Store.show_product_images` turns it on per store (merged into `bootstrap.settings.show_product_images`). |
| `scan_enabled` | 1 | Keyboard-wedge / camera scanning in the PWA. |
| `receipt_qr_enabled` | 1 | QR on printed receipts and `/r/<token>` page. |
| `receipt_qr_base_url` | site URL | Base of the QR link. |
| `loyalty_lookup_enabled` | 1 | Client № lookup in Sell. |
| `face_recognition_enabled` | 0 | v0.3 client recognition master switch — see "Client recognition". |

## Barcodes

`Item.maison_barcode` (Data, unique, indexed) complements the standard `Item Barcode`
table. `catalog.bootstrap` / `delta` return `barcodes: {code: item_code}` built from
`maison_barcode`, every `Item Barcode` row and every active serial number in the
boutique's warehouse (a serial label scan resolves to the item here and to the exact
serial via `serials`). Client QR payload is `MC:<customer_id>`; invoice QR is the
`/r/<token>` URL.

## Client numbers and loyalty

`Customer.maison_client_number` (`MC` + 6 digits, unique) is assigned in
`events.customer.before_insert`; the seed and the v0.2 patch backfill existing rows.
`customers.search` / `lookup` return `client_number`, `loyalty_points`, `points_value`
(points × conversion factor) and `tier`.

## Client recognition (v0.3)

Camera-based client recognition, **off by default**. Embeddings are computed on the device;
the backend stores only vectors (never images), matches them server-side and keeps the
consent/audit trail. Legal template, consent wording (EN/ES), signage and the DPIA risk list
live in `docs/biometrics-policy.md` — read it before switching a boutique on.

Doctypes:

- `AWANZ Face Template` — child table `Customer.maison_face_templates`: `embedding`
  (Long Text JSON float array), `model`, `dims`, `quality`, `captured_at`, `boutique`,
  `device_id`, `consent` (Link). Written only by `recognition.enroll`.
- `AWANZ Biometric Consent` (`MBC-YYYY-#####`): `customer`, `status` (Active / Revoked /
  Superseded — a re-enrolment supersedes the previous consent), `consent_text_version`,
  `consent_text` snapshot, `method` (Hold-to-agree / Signature), `signature` (private
  Attach Image), `boutique`, `associate`, `device_id`, `captured_at`, `ip`, `offline_uuid`
  (idempotency for queued enrolments), `revoked_at` / `revoked_by` / `revoke_reason`.
- `AWANZ Recognition Event`: `ts`, `outcome` (Matched / NoMatch / Enrolled / Undone /
  Declined / Revoked / Purged), `score`, `customer?`, `boutique`, `device_id`,
  `sales_invoice?`, `user`, `detail`. Scoped by boutique for managers.
- Customer: `maison_face_consent` (Check) + `maison_face_consent_at` (Datetime; the v0.2
  `maison_face_consent_on` is kept as a hidden mirror). Both are derived from the consent
  records; unticking the box in the desk purges the templates and revokes the consent.

Settings (`AWANZ POS Settings`, merged into `bootstrap.settings`):

| Field | Default | Notes |
| --- | --- | --- |
| `face_recognition_enabled` | 0 | Master switch (Head Office). `AWANZ Store.face_recognition_enabled` = Inherit / On / Off overrides per store; `bootstrap.settings.face_recognition_enabled` is the effective value. |
| `recognition_model` | `face-api/faceRecognitionNet@1` | Templates are matched only within the same model (and dims). |
| `match_threshold` | 0.6 | **Maximum euclidean distance between RAW face-api descriptors** (face-api's rule: `distance < 0.6` = same person; descriptors are *not* unit vectors, so cosine would false-match). The same rule runs on the device. `recognition.match` returns `distance` per candidate, `threshold_distance` (alias `threshold`) and a display-only `score = clamp(1 − distance/1.2, 0, 1)`. `bootstrap.settings.match_threshold` / `match_distance_threshold` are that distance; a device may only tighten (lower) it. |
| `biometric_retention_months` | 36 | Daily purge window (no POS visit for N months). |
| `recognition_offline_cache` | 1 | Allows `recognition.templates` (device cache). |
| `consent_text` / `consent_text_version` | EN text / `2026-08-1` | Bump the version when the text changes; enrolments with another version are rejected. |

API (`maison_pos.api.recognition`, vectors as JSON lists, AWANZ Associate+ unless stated):

| Endpoint | Returns |
| --- | --- |
| `match(embedding, model, boutique, device_id?)` | `{matches: [{customer, customer_name, client_number, distance, score, tier, loyalty_points, points_value, face_consent, face_consent_at}], threshold_distance, threshold, best_distance, best_score, model, candidates, event}` — only candidates with `distance < threshold_distance` (closest first, max 3). Logs Matched / NoMatch. Throws when recognition is off for the boutique. |
| `enroll(embeddings, model, boutique, device_id, consent{method, text_version, signature_data_url?}, quality?, customer?, phone?, email?, name?, offline_uuid?)` | `{customer, customer_name, client_number, tier, loyalty_points, points_value, face_consent, face_consent_at, consent, templates[] (row names), template_count, created, consent_text_version, event}`; replays with the same `offline_uuid` return `duplicate: true`. Finds the customer by id, else e-mail (case-insensitive), else phone (digits, ≥7), else creates one. Replaces previous templates. |
| `decline(boutique, device_id, phone?, email?, name?, customer?)` | same customer summary + `{created, event}`; no biometrics. Logs Declined. |
| `templates(boutique, since?)` | `{templates: [{template, customer, customer_name, client_number, embedding (unit-normalised), model, dims, captured_at}], deleted: [customer], enabled, model, threshold, version}`. Pass the previous `version` as `since` (site-local ISO). Empty with `enabled: 0` when the cache or recognition is off. |
| `revoke(customer, reason, boutique?, device_id?)` | **Manager+** → `{ok, customer, purged_templates, revoked_consents[], event}`. |
| `log_event(outcome, customer?, score?, sales_invoice?, boutique?, device_id?)` | `{ok, event}`; `outcome` ∈ Undone / Matched / NoMatch (offline decisions). |
| `status(customer)` | customer summary + `{consent: {name, captured_at, consent_text_version, method, boutique} \| null, templates: n, can_revoke}` for the Client screen. |

Matching uses a process-level cache of normalised vectors keyed by a version token in
`frappe.cache`; the token is bumped by the Customer `on_update` hook whenever the template
table changes and by `enroll` / `revoke` / the purge, so every web/worker process reloads on
its next call. Numpy is used when present (it is not in the reference bench); the pure-python
path is fine for thousands of templates.

`dashboard.live_summary` adds `recognition: {matched_today, enrolled_today, nomatch_today,
declined_today, undone_today}`.

## Scheduler

- every 2 minutes: `maison_pos.tasks.check_heartbeat_staleness` marks devices
  Offline after 180 s without a ping and publishes `awanz_heartbeat`.
- daily: `maison_pos.tasks.purge_old_sync_logs` removes successful sync logs older than 90 days.
- daily: `maison_pos.tasks.purge_expired_biometrics` destroys face templates of clients with
  no visit in `biometric_retention_months` (revokes the consent, logs `Purged`).

## Tests

```bash
bench --site maison.localhost run-tests --app maison_pos
```

Tests seed the demo data inside the test transaction and cover batch
idempotency, serial conflicts, price-change approval, boutique scoping, and (v0.2,
`tests/test_v0_2.py`) receipt tokens + the guest endpoint + QR, client number assignment /
search / lookup, the barcode map and settings in bootstrap, and `upload_item_image`
permissions, and (v0.3, `tests/test_recognition.py`) match math / threshold conversion,
enrol by phone / e-mail, decline, revoke, retention purge and role checks.

## Export fixtures after editing in the desk

```bash
bench --site maison.localhost export-fixtures --app maison_pos
```

<!-- v0.4 H — AI & insights -->
## AI & insights (v0.4 H)

Pure-python analytics in `maison_pos/insights/` (no numpy / pandas in the reference bench):

| Module | What it computes |
| --- | --- |
| `affinity.py` | Item co-purchase **lift** from submitted POS baskets (+ client co-ownership at half weight). `recommend_for_basket(items)` = "Pairs well with", `recommend_for_client(customer)` = "Suggested for this client" — never an item the client already owns (net of full returns); same-group bestsellers as fallback. Weekly cache table **AWANZ Client Recommendation** (rank, score, lift, confidence, reason). |
| `client_signals.py` | Per client: visits, cadence (mean gap between visits, chain median when < 2 visits), expected next visit, churn risk (`churn_score(days_since, cadence)` → 0–1: 0.2 at one cadence, ≈0.9 at 3×), spend trend (last 90 vs previous 90 days), preferred department / metal / boutique / associate, birthday / anniversary within 30 days (read from **AWANZ Client Profile** when installed). One signal per client → **AWANZ Client Signal** (`Overdue visit`, `Due this week`, `Birthday`, `Anniversary`, `Spend drop`, `VIP lapsing`, `New client follow-up`; priority 0–100; status Open / Contacted / Dismissed; `week` = ISO week). |
| `product_performance.py` | Item × boutique over N days (default 90): units, revenue, velocity (units/week), on hand, days on hand, sell-through, stock-out risk (< 21 days cover), index vs chain average; heatmap item group × boutique; top / slow movers; **rebalance rule** (slow store with ≥ 120 days cover or no sales → fast store at stock-out risk, `qty = min(surplus − 45-day keep, need for 31 days)`, moves under $300 ignored) → **AWANZ Rebalance Suggestion**. |
| `narrative.py` | `build_numbers()` (chain + per-boutique week vs previous week, best sellers, open signals / moves, new clients) → `template_narrative()` (deterministic) or the Anthropic Messages API when `anthropic_api_key` is in `site_config.json` (`anthropic_model`, default `claude-sonnet-4-5`; `insights_narrative_llm: 0` forces the template). Only aggregated numbers are sent — no client names or invoice rows. Stored as **AWANZ Insight Report** (`MIR-<period_end>-Weekly`, one per period, `generator`, `model`, `numbers` JSON, `error`), e-mailed to every enabled user with **AWANZ Head Office**. |
| `jobs.py` | `compute_weekly` (Monday 05:00 site tz: recommendations → signals → rebalance) and `weekly_narrative` (Monday 06:00: last Mon–Sun, e-mail). Both runnable by hand: `bench --site X execute maison_pos.insights.jobs.compute_weekly`. |

API (`maison_pos.api.insights`):

| Endpoint | Who | Returns |
| --- | --- | --- |
| `recommend_for_client(customer, n=3, boutique?)` | any AWANZ role | `{items: [{item_code, item_name, item_group, rate, image, score, lift, confidence, because, because_name, reason, in_stock}], owned[], source: cache \| live}` |
| `recommend_for_basket(items, n=3, boutique?, customer?)` | any AWANZ role | `{basket, items[]}` (basket lines and the client's owned items excluded) |
| `client_signals(boutique?, limit=50, status="Open")` | any AWANZ role, boutique-scoped | `{signals[], by_type, week, last_run}` (+ `mobile_no`, `email_id`, `client_number`) |
| `mark_signal(signal, status, note?)` | any AWANZ role (own boutique) | Contacted (records user + time) / Dismissed / Open; handled clients stay out of the next recompute of the same week |
| `product_performance(period=90, boutique?)` | Manager+ | `{period, boutiques, item_groups, items[], heatmap[], top_movers{}, slow_movers{}, rebalance[], totals}` |
| `rebalance_suggestions(status="Open")` | Manager+ (scoped to own boutique) | `{suggestions[] (+ can_transfer), last_run}` |
| `create_transfer(suggestion, qty?)` | manager of either boutique / HQ | submits a **Stock Entry – Material Transfer** (specific serials for serialized pieces), marks the suggestion Transferred, publishes `awanz_rebalance` |
| `dismiss_suggestion(suggestion, note?)` | same | the (item, from, to) pair is not re-suggested by later runs |
| `narrative(period_end?, generate=0)` | Manager+ (`generate=1`: HQ) | latest weekly report (`narrative`, `numbers`, `generator`, …) |
| `compute(narrative=0, send=0)` | HQ / System Manager | runs the weekly job now |
| `summary()` | any AWANZ role | `{open_signals, open_rebalances, recommended_clients, latest_report, last_run, llm}` for dashboard tiles |

POS: `BasketPanel` shows up to three "Suggested for this client" tiles under the attached client and "Pairs well with" under the basket (debounced, hidden offline; tapping adds the item — a serialized piece with one free serial is added directly, otherwise the grid is filtered to it). Dashboard: the **Insights** tab (`/awanz-dashboard?view=insights`) — weekly narrative, item-group × boutique heatmap, top / slow movers per boutique, "Clients to contact this week" (Done / dismiss), rebalance suggestions with one-click **Create transfer**.

### Historical sales seed

```bash
bench --site maison.localhost execute maison_pos.setup.demo_history.seed_history --kwargs '{"months": 6}'
# or over the API (System Manager): POST /api/method/maison_pos.setup.demo_history.seed_history_remote  (enqueued on the long queue; sync=1 runs inline)
# status: maison_pos.setup.demo_history.history_status
```

Deterministic (`random.Random(20260822)`): ~1,500 submitted POS invoices over the last 6 months across the three boutiques (weekday + seasonal intensity — Valentine's, Mother's Day, wedding season, summer dip), 120 extra clients with personas (home boutique, visit cadence, department / metal preference, budget band, a lapsed subset), built-in co-purchase patterns (watch → strap, solitaire → band, chain → pendant, high jewellery → appraisal), mixed cash / card, plus a second small plan of ~70 serialized-piece sales spread over the last 100 days. Every unit / serial sold is received first through back-dated Material Receipts (`AWANZ demo history stock …`, serials `<item>-<city>-H###` / `-R###`), so serial availability and bins are always consistent. ~12 returns go through `maison_pos.api.returns.return_items` when that module exists (else `sales.void`). Idempotent: invoices carry `maison_offline_uuid = hist-<seed>-<n>` / `hist-r<seed>-<n>`; a marker (`frappe.defaults` key `awanz_history_seed`) short-circuits completed runs, an interrupted run resumes, and transient DB errors (deadlocks, "table definition has changed" during a concurrent migrate) are retried. Commits every 50 invoices; `item_based_reposting` is switched on for the run and the queued Repost Item Valuation entries are processed at the end (`run_reposts=0` to leave them to the hourly scheduler). Runtime on the reference bench: ≈ 0.38 s per invoice → about 9–10 minutes for the full history plus ~2 minutes of reposts.

Note for dev sites: ERPNext's `before_tests` hook deletes every **Item Price** (and commits) on each `bench run-tests`; `maison_pos.setup.demo.before_tests` puts the demo prices back afterwards.
<!-- end v0.4 H -->

## v0.4 — CRM / employees / promotions / feedback / scanners (sections B, C, I, J)

Apps: **hrms 15.63.3** (`version-15`) and **crm 1.81.2** (`main`, supports Frappe v15/v16) are in
`required_apps`; every glue path feature-detects them (`api.hr.hrms_installed()`,
`api.crm.crm_installed()`) and keeps working when they are absent. Details: `docs/crm.md`,
`docs/payroll.md`, `docs/scanners.md`.

New doctypes: `AWANZ Client Profile` (+ child `AWANZ Wishlist Item`), `AWANZ Client
Interaction`, `AWANZ Commission Rule`, `AWANZ Commission Entry`, `AWANZ Shift`, `AWANZ
Coupon`, `AWANZ Coupon Redemption`, `AWANZ Feedback`. `AWANZ Associate.employee` (Link →
Employee). Custom fields (`setup/install_v04_crm.py`, also applied by patch
`patches.v0_4.crm_hr_fields`): Sales Invoice `maison_coupon`, `maison_coupon_discount`,
`maison_promotions`; Sales Invoice Item `maison_coupon_discount`; AWANZ POS Settings
`promotions_enabled` (1), `birthday_bonus_points` (0), `feedback_enabled` (1),
`feedback_alert_threshold` (2). Tier Customer Groups (Collector / Connoisseur / Patron).

| Endpoint | Notes |
| --- | --- |
| `crm.profile / update_profile / wishlist_add / wishlist_remove / tasks / interactions / log_interaction / complete_task / wishlist_matches / upcoming_dates` | Clienteling (docs/crm.md). |
| `hr.clock_in / clock_out / toggle_break / shift_status / on_shift / shifts` | Shifts → HRMS Employee Checkin. |
| `hr.commission_statement / employee_performance / payroll_export(format=gusto\|adp\|quickbooks\|hrms) / payroll_export_download` | Commissions & payroll (docs/payroll.md). |
| `promotions.active(boutique)` | Pricing Rules the POS applies (percent/amount, item group/code/transaction, min qty/amt, tier via Customer Group). |
| `promotions.check_coupon(code, lines, boutique?, customer?)` | POS preview — `{valid, discount, per_line, reason?}` never raises. |
| `promotions.loyalty(customer)` | Tier ladder, progress to next tier, points expiring in 90 days. |
| `promotions.performance(from, to, boutique?)` | Coupon / promotion performance (also report **AWANZ Promotion Performance**). |
| `feedback.status(token)` (guest GET) / `feedback.submit(token, rating, comment)` (guest POST) | Private feedback from `/r/<token>`; guests can never read feedback. |
| `feedback.list / summary / respond` | Manager (own boutique) / HQ. `summary` feeds the dashboard tile. |

`sales.submit_batch` accepts `coupon_code` + per-line `coupon_discount` (and `promotions[]`);
the server re-validates the coupon and folds the discount into the line discounts before
taxes; mismatches / invalid coupons return `error_code: COUPON_INVALID` with
`details.reason` (unknown, disabled, expired, not_started, wrong_boutique, wrong_customer,
exhausted, min_basket, not_applicable, mismatch).

Hooks (grouped in `hooks.py`): Sales Invoice on_submit → commissions, coupon redemption,
wishlist fulfilment; on_cancel → reversals; Stock Entry on_submit → wishlist alerts; daily
`promotions.birthday_bonus`. Realtime: `awanz_shift`, `maison_wishlist_match`,
`awanz_feedback`, `awanz_feedback_alert`. Reports: **AWANZ Commission Statement**,
**AWANZ Promotion Performance**. Tests: `tests/test_v0_4_crm_hr.py` (24).

## v0.4 D/E/F — inventory alerts, returns & exchanges, reports (see `docs/returns.md`, `docs/hardware.md`)

Doctypes: `AWANZ Stock Alert` (`MSA-YYYY-#####`: item, warehouse, boutique, status Open /
Acknowledged / Resolved, qty, reorder_level, lifecycle fields; one open row per item+warehouse),
`AWANZ Cycle Count` (`MCC-…`: counted serials vs expected, unaccounted / unexpected serials,
qty differences, link to the draft Stock Reconciliation), child table `AWANZ Store Reader`
(`AWANZ Store.readers`: label, stripe_reader_id, device_type `verifone_v660p` / `stripe_s710` /
`bbpos_wisepos_e` / `simulated`, has_printer, enabled) and `AWANZ Store.damaged_warehouse`.

Settings (`AWANZ POS Settings`, merged into `bootstrap.settings`): `return_window_days` (30),
`exchange_window_days` (60), `returns_manager_threshold` (2 500), `low_stock_digest_enabled` (1),
`low_stock_notify_regional` (0).

| Endpoint | Notes |
| --- | --- |
| `inventory.alerts(boutique?, status="open")` | `{boutiques, alerts[], open, counts{boutique: n}}` (scoped) |
| `inventory.acknowledge(alert)` / `inventory.resolve(alert)` | resolve = Manager+ |
| `inventory.request_transfer(item, to, qty, from_warehouse?, alert?, reason?)` | Material Request (Material Transfer) into the boutique warehouse; `from_warehouse` accepts a boutique code or a warehouse |
| `inventory.cycle_count_expected(boutique?)` | `{warehouse, serials{item: [serial]}, qty{item: n}, items{code: name}}` |
| `inventory.submit_cycle_count(boutique, serials[], qty{}, device_id?, notes?)` | `{cycle_count, missing[], unexpected[], qty_differences[], stock_reconciliation (draft) \| null, clean}` |
| `inventory.low_stock_scan()` (hourly) / `inventory.low_stock_digest()` (daily) | Item Reorder levels vs Bin → alerts (idempotent, auto-resolve), Notification Log to boutique managers + Head Office, e-mail digest |
| `returns.lookup / return_items / exchange / policy / recent` | see `docs/returns.md` |
| `reports.list_reports()` / `reports.run(report, filters)` / `reports.export(report, filters)` (CSV download) / `reports.period_comparison(boutique?)` | 8 Script Reports (module AWANZ POS): AWANZ Sales Tax Summary, Daily Sales, Sales by Item (group_by Item / Item Group / Department), Sales by Associate, Hourly Sales Heatmap, Client Purchases (RFM), Serial Ledger, Returns (group_by Reason / Boutique / Associate / Detail). Scoped users only see their boutique. |

`dashboard.live_summary` adds `low_stock: {open, by_boutique, top[]}` and `returns: {count, value}`;
realtime `awanz_stock_alerts` is published after each scan / acknowledge. Print format
`AWANZ Return Receipt` (credit notes). Seed (`setup/demo_v04_inventory.py`): reorder levels for
accessories / bands per boutique, `<code> Damaged` warehouses, `Exchange Credit` tender, two
readers per boutique, two sample alerts. Tests: `tests/test_v0_4_returns.py`,
`tests/test_v0_4_inventory.py`, `tests/test_v0_4_reports.py`.

## Web shop (v0.4 G — Frappe Webshop + Payments)

Installed apps `payments` and `webshop` (both `version-15`) power the online boutique; AWANZ adds
`maison_pos/webshop/` (web modes, availability per boutique, click & collect orders, Payment Request
override, `Website Item` template override), `api/webshop.py`, the Monolith Gold storefront
(`www/shop/*`, `templates/webshop/*`, `public/css/awanz-web.css`), the doctype **AWANZ Web Enquiry**,
custom fields on Item / Quotation / Sales Order / Sales Invoice (created by `maison_pos.webshop.setup`
on install/migrate, not in the shared fixture file) and the seed `setup/demo_v04_webshop.py`
(called from `demo.seed()`, no-op without the app). Everything is documented in
[`docs/webshop.md`](../docs/webshop.md): install on Frappe Cloud, Stripe vs simulated gateway,
native-vs-custom map, API, and how a marketing site links to `shop.brand.com`.

Quick reference:

| Endpoint | Notes |
| --- | --- |
| `webshop.catalogue / availability / boutiques / enquire / loyalty_lookup` | guest |
| `webshop.cart / update_cart / set_boutique / place_order / reserve / simulate_payment / my_orders / order` | signed-in shopper (Website User with Contact → Customer) |
| `webshop.web_orders / web_order / set_web_order_status / update_enquiry` | POS "Web orders" queue, boutique-scoped |
| `sales.submit_batch` with `sales_order` on the payload | collection: lines linked to the order, online payment allocated as advance, `Sales Order.maison_web_status = Collected` |

Tests: `tests/test_webshop.py` (skipped when webshop is absent).

## v0.4 integration notes (sales semantics, rounding, bootstrap)

- **Line semantics of `sales.submit_batch`** (enforced since 0.4.0): `items[].rate` is the unit *list* rate the
  tile showed, `items[].discount_amount` is the discount for the **whole line** (manual + automatic promotion),
  `items[].coupon_discount` the coupon share (re-validated server-side). The server stores
  `price_list_rate = rate`, `discount_amount = discount / qty` (ERPNext keeps it per unit) and
  `rate = list − unit discount`, so `qty × rate − discount_amount` on the device equals `amount` on the invoice.
- **Rounding**: `setup.install.ensure_rounding_method` pins System Settings `rounding_method` to
  *Commercial Rounding* (half away from zero) on install / migrate — the device rounds the same way, Frappe's
  default banker's rounding produced 1-cent `PAYMENT_MISMATCH` refusals on half-cent taxes.
- **`catalog.bootstrap.boutique`** carries `readers[]` (`AWANZ Store Reader`: name, label, stripe_reader_id,
  device_type, has_printer, enabled, serial_number) and `damaged_warehouse` for the POS reader picker / print route.
- Tests are self-sufficient on a used site (serials received inside the test transaction, empty biometric gallery).
