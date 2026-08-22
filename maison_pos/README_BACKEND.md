# Maison POS — backend (Frappe app)

Python package for the Maison POS Frappe/ERPNext v15 app: doctypes, fixtures,
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

`after_install` creates the four `Maison *` roles, the Item / Sales Invoice / Customer
custom fields, the `Cash` and `Card` modes of payment, the `Maison Price Approval`
workflow and the `Maison Receipt` print format. All steps are idempotent and
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

Creates company **Maison** (abbr `MSN`, USD, Standard chart), three boutiques
(`NYC-5AV`, `CHI-OAK`, `MIA-DD`) each with Warehouse + Cost Center + POS Profile +
Sales Tax template, 41 items across Timepieces / High Jewellery / Bridal /
Accessories / Services (watches, high jewellery and solitaires are serialized;
opening stock is posted per boutique with generated serials such as
`TP-001-NYC-001`), `Standard Selling` prices, 20 customers (each with a `MC######` client number), loyalty
program **Maison Collectors** (Collector / Connoisseur / Patron), and demo users. Every
item gets a deterministic EAN-13 (`Item.maison_barcode` + an `Item Barcode` row); serial
labels are Code-128 of the serial number itself.

| Login | Role | PIN |
| --- | --- | --- |
| `hq@maison.example` | Maison Head Office | — |
| `regional@maison.example` | Maison Regional | — |
| `nyc.5av.manager@maison.example` (and `chi.oak.`, `mia.dd.`) | Maison Manager | `1234` |
| `nyc.5av.a1@maison.example` / `nyc.5av.a2@...` (per boutique) | Maison Associate | `2580` / `1357` |

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
| `catalog.upload_item_image(item_code, file)` | `POST` multipart (field `file`, JPEG/PNG/WebP ≤ 5 MB). Maison Manager / Head Office / System Manager. Creates a public `File` attached to the Item, sets `Item.image`; returns `{item_code, image (absolute), file_url, file_name}`. |
| `customers.search(q, limit)` / `customers.lookup(code)` / `customers.upsert(customer)` / `customers.history(customer, limit)` | `search` matches client number, phone (digits only, 4+ digits, any formatting), email and name; rows include `client_number`, `loyalty_points`, `points_value`, `tier`. `lookup` is exact: `MC123456`, `MC:<customer_id>` / `MC:MC123456` (client QR), full phone, email → one row or `null`. Upsert matches by mobile / email when `name` is not given. |
| `sales.receipt(token)` | **Guest**, `GET`. JSON receipt for the token printed in the receipt QR (boutique, datetime, lines, totals, payment brand/last4, masked client number, points). Same payload backs the public page `/r/<token>`. |
| `sales.submit_batch(invoices)` | Idempotent on `offline_uuid` (`Maison Sync Log` + unique custom field). Each invoice runs in its own savepoint; failures return `status: "error"` with `error_code` (`SERIAL_UNAVAILABLE`, `PAYMENT_MISMATCH`, `PERMISSION_DENIED`, `NOT_FOUND`, `VALIDATION_ERROR`, `SERVER_ERROR`). |
| `sales.list(boutique, date)` | X/Z report summary. |
| `sales.void(invoice, reason)` | Manager+. Creates and submits a POS Sales Return; idempotent per invoice. |
| `stripe_terminal.connection_token(boutique)` / `create_payment_intent(amount, currency, offline_uuid, customer?)` / `capture(payment_intent_id)` | `card_present`, `capture_method=manual`, idempotency key derived from `offline_uuid`. |
| `dashboard.live_summary(date?)` | Totals, per-boutique (with `status: online / offline / pending_approval`), hourly series, pending approvals. |
| `dashboard.heartbeat(boutique, device_id, queued, app_version?)` | Upserts `Maison Device Heartbeat`, publishes `maison_heartbeat`. |
| `session.me()` / `session.associates(boutique)` | Helpers for the Unlock screen. |
| `maison_pos.maison_pos.doctype.maison_associate.maison_associate.verify_pin(associate, pin)` | PIN unlock (PBKDF2-SHA256, locks after 5 failures). |

Realtime (socket.io room `maison_dashboard`): `maison_sale`, `maison_sale_cancelled`,
`maison_heartbeat`, `maison_price_approved`.

### Boutique scoping

`maison_pos.scoping` resolves the caller's `Maison Associate`. Users holding
`Maison Associate` / `Maison Manager` can only act on their own boutique
(`assert_boutique_access`); `Maison Head Office`, `Maison Regional`,
`System Manager` and Administrator are unrestricted. List views of
`Maison Price Change Request`, `Maison Device Heartbeat` and `Maison Sync Log`
are filtered through `permission_query_conditions`. The demo seed also adds a
User Permission on the boutique warehouse for managers/associates.

## Price overrides

`Maison Price Change Request` (submittable) drives the `Maison Price Approval`
workflow: Draft → Pending Approval (Manager) → Approved / Rejected (Head Office or
Regional). On Approved the document creates or updates a Pricing Rule titled
`MAISON <boutique> <item_code>` with `warehouse` = the boutique's warehouse,
`rate_or_discount = Rate`, valid dates copied from the request. Cancelling the
request disables the rule.

## Receipt

Print Format **Maison Receipt** (Jinja, Sales Invoice) renders
`templates/print/receipt.html` at 80 mm (the same HTML is embedded in
`fixtures/print_format.json`; keep both in sync). Boutique address / phone come from the
`Maison Boutique` linked via `maison_boutique`; card brand / last4 / approval from
the `maison_card_*` custom fields; the client number (`Customer.maison_client_number`)
and points earned / balance are printed; signature line appears for totals ≥ 10 000.

### Receipt QR / public receipt

On submit of a POS invoice `before_submit` stores a 16-char url-safe
`maison_receipt_token`. The QR content is `<receipt_qr_base_url>/r/<token>`
(`Maison POS Settings.receipt_qr_base_url`, default = site URL). The print format renders
the QR server-side with `segno` as an SVG data URI (`receipt_qr_svg(doc)` Jinja helper;
empty when `receipt_qr_enabled` is off). `/r/<token>` (`www/r.py` + `www/r.html`,
`website_route_rules`) is a guest page in Monolith Gold with self-contained CSS, `noindex`,
404 for unknown tokens. `maison_pos.api.sales.receipt?token=…` returns the JSON.

## Maison POS Settings (single)

| Field | Default | Used for |
| --- | --- | --- |
| `show_product_images_default` | 0 | Tiles show `Item.image`; `Maison Boutique.show_product_images` turns it on per store (merged into `bootstrap.settings.show_product_images`). |
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

- `Maison Face Template` — child table `Customer.maison_face_templates`: `embedding`
  (Long Text JSON float array), `model`, `dims`, `quality`, `captured_at`, `boutique`,
  `device_id`, `consent` (Link). Written only by `recognition.enroll`.
- `Maison Biometric Consent` (`MBC-YYYY-#####`): `customer`, `status` (Active / Revoked /
  Superseded — a re-enrolment supersedes the previous consent), `consent_text_version`,
  `consent_text` snapshot, `method` (Hold-to-agree / Signature), `signature` (private
  Attach Image), `boutique`, `associate`, `device_id`, `captured_at`, `ip`, `offline_uuid`
  (idempotency for queued enrolments), `revoked_at` / `revoked_by` / `revoke_reason`.
- `Maison Recognition Event`: `ts`, `outcome` (Matched / NoMatch / Enrolled / Undone /
  Declined / Revoked / Purged), `score`, `customer?`, `boutique`, `device_id`,
  `sales_invoice?`, `user`, `detail`. Scoped by boutique for managers.
- Customer: `maison_face_consent` (Check) + `maison_face_consent_at` (Datetime; the v0.2
  `maison_face_consent_on` is kept as a hidden mirror). Both are derived from the consent
  records; unticking the box in the desk purges the templates and revokes the consent.

Settings (`Maison POS Settings`, merged into `bootstrap.settings`):

| Field | Default | Notes |
| --- | --- | --- |
| `face_recognition_enabled` | 0 | Master switch (Head Office). `Maison Boutique.face_recognition_enabled` = Inherit / On / Off overrides per store; `bootstrap.settings.face_recognition_enabled` is the effective value. |
| `recognition_model` | `face-api/faceRecognitionNet@1` | Templates are matched only within the same model (and dims). |
| `match_threshold` | 0.6 | **Maximum euclidean distance between RAW face-api descriptors** (face-api's rule: `distance < 0.6` = same person; descriptors are *not* unit vectors, so cosine would false-match). The same rule runs on the device. `recognition.match` returns `distance` per candidate, `threshold_distance` (alias `threshold`) and a display-only `score = clamp(1 − distance/1.2, 0, 1)`. `bootstrap.settings.match_threshold` / `match_distance_threshold` are that distance; a device may only tighten (lower) it. |
| `biometric_retention_months` | 36 | Daily purge window (no POS visit for N months). |
| `recognition_offline_cache` | 1 | Allows `recognition.templates` (device cache). |
| `consent_text` / `consent_text_version` | EN text / `2026-08-1` | Bump the version when the text changes; enrolments with another version are rejected. |

API (`maison_pos.api.recognition`, vectors as JSON lists, Maison Associate+ unless stated):

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
  Offline after 180 s without a ping and publishes `maison_heartbeat`.
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
