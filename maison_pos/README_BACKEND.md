# Maison POS — backend (Frappe app)

Python package for the Maison POS Frappe/ERPNext v15 app: doctypes, fixtures,
whitelisted API used by the PWA, Stripe Terminal helpers, receipt print format,
demo seed and tests.

## Requirements

- Frappe Framework v15, ERPNext v15 (`required_apps = ["erpnext"]`)
- Python 3.10+
- `stripe` Python SDK (installed automatically from `pyproject.toml`)

## Install

```bash
cd frappe-bench
bench get-app maison_pos https://github.com/<org>/maison            # or: bench get-app /path/to/maison
bench --site maison.localhost install-app maison_pos
bench --site maison.localhost migrate                                # syncs fixtures (roles, custom fields, workflow, print format)
```

`after_install` creates the four `Maison *` roles, the Item / Sales Invoice custom
fields, the `Cash` and `Card` modes of payment, the `Maison Price Approval`
workflow and the `Maison Receipt` print format. All steps are idempotent and
`after_migrate` re-applies roles, custom fields and modes of payment.

## Demo data

```bash
bench --site maison.localhost execute maison_pos.setup.demo.seed
```

Creates company **Maison** (abbr `MSN`, USD, Standard chart), three boutiques
(`NYC-5AV`, `CHI-OAK`, `MIA-DD`) each with Warehouse + Cost Center + POS Profile +
Sales Tax template, 41 items across Timepieces / High Jewellery / Bridal /
Accessories / Services (watches, high jewellery and solitaires are serialized;
opening stock is posted per boutique with generated serials such as
`TP-001-NYC-001`), `Standard Selling` prices, 20 customers, loyalty program
**Maison Collectors** (Collector / Connoisseur / Patron), and demo users.

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
| `catalog.bootstrap(boutique)` | Full snapshot: boutique, POS profile, taxes, modes of payment, item groups, departments, items, prices, pricing_rules (warehouse-scoped), serials, stock, loyalty program, `version`. |
| `catalog.delta(boutique, since)` | Same shape filtered by `modified >= since`, plus `deleted[]` and `serials_removed{}`. |
| `customers.search(q, limit)` / `customers.upsert(customer)` / `customers.history(customer, limit)` | Upsert matches by mobile / email when `name` is not given. |
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
`templates/print/receipt.html` at 80 mm. Boutique address / phone come from the
`Maison Boutique` linked via `maison_boutique`; card brand / last4 / approval from
the `maison_card_*` custom fields; signature line appears for totals ≥ 10 000.

## Scheduler

- every 2 minutes: `maison_pos.tasks.check_heartbeat_staleness` marks devices
  Offline after 180 s without a ping and publishes `maison_heartbeat`.
- daily: `maison_pos.tasks.purge_old_sync_logs` removes successful sync logs older than 90 days.

## Tests

```bash
bench --site maison.localhost run-tests --app maison_pos
```

Tests seed the demo data inside the test transaction and cover batch
idempotency, serial conflicts, price-change approval and boutique scoping.

## Export fixtures after editing in the desk

```bash
bench --site maison.localhost export-fixtures --app maison_pos
```
