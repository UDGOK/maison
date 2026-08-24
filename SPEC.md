# AWANZ POS — Build Specification (v0.1)

Custom Frappe app `maison_pos` for a luxury jewelry chain (40→100+ boutiques) on **Frappe Framework v15 + ERPNext v15**, with an **offline-first Vue 3 PWA** point of sale, **Stripe Terminal** card payments, thermal receipt printing, and a live head-office dashboard.

Repo layout (single repo = the Frappe app):

```
maison_pos/                     # python package (Frappe app)
  hooks.py, modules.txt, patches.txt
  maison_pos/                   # module "AWANZ POS"
    doctype/<doctype>/...       # custom doctypes (JSON + .py)
    workflow/, print_format/    # fixtures exported via hooks.fixtures
  api/                          # whitelisted REST endpoints (see API CONTRACT)
    catalog.py, sales.py, customers.py, stripe_terminal.py, dashboard.py
  stripe_terminal/              # stripe helpers
  public/                       # built PWA assets land in public/pos/ (symlinked via hooks)
  www/pos.html + www/pos.py     # serves the PWA shell at /pos
  templates/print/receipt.html  # 80mm thermal receipt Jinja print format
  fixtures/                     # exported Role, Workflow, Print Format, Custom Field JSON
frontend/                       # Vue 3 + Vite + TS PWA (builds into ../maison_pos/public/pos)
dashboard/                      # (optional) Vue app for head-office live wall, built into public/dashboard
docker/                         # docker-compose for local dev (frappe_docker based)
README.md, SPEC.md, CHANGELOG.md
```

## Store model (ERPNext-native; no parallel "store" concept)
- One Company (multi-company supported later). Each boutique = **Warehouse** + **Cost Center** + **POS Profile**.
- Custom doctype **AWANZ Store** (name = store code e.g. `CHI-OAK`) links: `warehouse`, `cost_center`, `pos_profile`, `company`, `address_line`, `city`, `phone`, `email`, `tax_template`, `stripe_location_id`, `printer_ip`, `printer_model`, `enabled`. This is the single place the receipt pulls address/phone from.
- User ↔ boutique: custom doctype **AWANZ Associate** (`user`, `boutique`, `role` in [Associate, Manager, Regional, HeadOffice], `pin` hashed 4–6 digits for fast POS unlock). User Permission on Warehouse enforces data scoping for Manager/Associate.
- Roles (fixtures): `AWANZ Associate`, `AWANZ Manager`, `AWANZ Regional`, `AWANZ Head Office`.

## Catalog, stock, pricing
- Items are standard ERPNext Items. Custom Fields on Item (fixtures): `maison_metal`, `maison_carat`, `maison_stones`, `maison_certificate_no`, `maison_appraisal_value`, `maison_department` (Link to Item Group is the category; department is a Select), `maison_taxable` (Check, default 1), `maison_image_url`.
- Serialized items (watches, one-offs) use ERPNext Serial No; accessories use qty.
- Global price list `Standard Selling`. Store override = **Pricing Rule** with `warehouse` = the boutique's warehouse, created only via doctype **AWANZ Price Change Request** (`item_code`, `boutique`, `current_rate`, `proposed_rate`, `reason`, `requested_by`, `valid_from`, `valid_upto`, workflow_state). Workflow **AWANZ Price Approval**: Draft → Pending Approval (Manager submits) → Approved (Head Office/Regional) | Rejected. On Approved, `on_update_after_submit`/workflow action creates/updates the Pricing Rule.
- Same pattern for **AWANZ Item Change Request** (proposed field changes as JSON) — can be phase 2; scaffold doctype only.

## Sales
- A POS sale = ERPNext **Sales Invoice** with `is_pos=1`, `pos_profile`, `set_warehouse`, `update_stock=1`, payments child table (Mode of Payment `Cash` / `Card`), `customer`, `maison_boutique` (custom field), `maison_offline_uuid` (custom field, unique, idempotency key), `maison_associate`, `maison_terminal_ref` (Stripe PaymentIntent id), `maison_device_id`.
- Offline invoices are accepted via batch endpoint; server recomputes taxes/totals from the item rates sent and **rejects with a structured error** if a serial number is no longer available (conflict) — the client shows it to the associate.
- Loyalty: ERPNext Loyalty Program (points per currency). Redemption passed as `loyalty_points` + `redeem_loyalty_points=1` on the invoice.
- Corrections at head office = standard cancel/amend; expose `maison_pos.api.sales.void(invoice)` for managers (creates Sales Return / credit note).

## API CONTRACT (all `frappe.whitelist()` under `/api/method/maison_pos.api.*`; JSON in/out; token or session auth)
```
catalog.bootstrap(boutique)            -> {boutique, pos_profile, taxes, modes_of_payment, item_groups, departments, items[], prices{item_code:rate}, pricing_rules[], serials{item_code:[serial_no]}, stock{item_code:qty}, loyalty_program, version: ISO ts}
catalog.delta(boutique, since)         -> same shape but only changed rows + deleted[]
customers.search(q, limit=20)          -> [{name, customer_name, mobile_no, email_id, loyalty_points, tier, last_visit, last_boutique}]
customers.upsert(customer: {...})      -> {name}
customers.history(customer, limit=20)  -> [{invoice, date, boutique, items[], grand_total}]
sales.submit_batch(invoices: [POSInvoice]) -> {results: [{offline_uuid, status: "ok"|"duplicate"|"error", invoice_name?, error?, error_code?}]}
sales.list(boutique, date)             -> summaries for X report
sales.void(invoice, reason)            -> {credit_note}
stripe_terminal.connection_token(boutique) -> {secret}
stripe_terminal.create_payment_intent(amount, currency, offline_uuid, customer?) -> {id, client_secret}
stripe_terminal.capture(payment_intent_id) -> {status, charge_id, card_brand, last4}
dashboard.live_summary(date?)          -> {totals:{net, invoices, cash, card, avg_ticket}, by_boutique:[{boutique, name, net, cash, card, invoices, status: online|offline|pending_approval, last_seen}], by_hour:[...] , pending_approvals: n}
dashboard.heartbeat(boutique, device_id, queued: n) -> {ok}    # POS pings every 60s; drives online/offline
```
POSInvoice (client → server):
```
{offline_uuid, boutique, associate, device_id, customer?, posting_datetime, items:[{item_code, qty, rate, serial_no?, discount_amount?}], payments:[{mode_of_payment:"Cash"|"Card", amount, stripe_payment_intent?}], loyalty_points_redeemed?, notes?}
```
Realtime: on Sales Invoice submit with `is_pos`, publish `frappe.publish_realtime("awanz_sale", {...summary}, room="awanz_dashboard")`. Heartbeats publish `awanz_heartbeat`.

## Frontend (frontend/) — Vue 3 + TypeScript + Vite + Pinia + vite-plugin-pwa + Dexie (IndexedDB)
Design system **"Monolith"**: ground `#0A1410`, surface `#0F1C16`, line `#1E3128`, text `#E9ECE6`, muted `#9FB3A6`, dim `#6F8579`, accent platinum `#E9ECE6` (buttons), semantic good `#7FA98A` warn `#D3A55B` crit `#C4736A`. Display face **Unbounded** (800/900, uppercase, tight tracking) for wordmark, section titles, prices and big numerals; **Jost** (300/400/500) for body, labels (11px, letter-spacing .25em uppercase), and data. Tabular numerals everywhere. Square corners, 1px lines, no shadows except device chrome. Landscape iPad 4:3 and 16:10 touch targets ≥ 48px. Dark only.
Screens: `Unlock` (boutique + associate PIN), `Sell` (category rail, department filter, item grid with serial chips, search; right panel = client + basket + totals), `Client` (search/create, history, points), `Pay` (cash with tendered/change; card via Stripe Terminal JS SDK — use simulated reader when no key), `Receipt` (print via Epson ePOS-Print XML over LAN, email, done), `Queue` (offline queue with retry/errors), `Shift` (X/Z report), `Settings`.
Offline: service worker precaches shell; Dexie stores catalog/prices/serials/customers/queue; `sync` store replays queue FIFO with idempotent `offline_uuid`; banner shows Online/Offline and queued count; heartbeat every 60s when online. Mock API layer (`VITE_MOCK=1`) with realistic seed data so the UI runs without a bench.
Build output → `../maison_pos/public/pos/` with `base: "/assets/maison_pos/pos/"`; `www/pos.html` loads it and PWA scope is `/pos`.

## Dashboard (head office)
Frappe Page or separate Vue app at `/awanz-dashboard`: KPI strip (net, invoices, card %, avg ticket), hourly bars, boutique table with status pills (Online / Offline · n queued / Price approval pending), pending approvals list, live feed of sales via socket.io. Same Monolith system.

## Receipt (80 mm)
Jinja print format `AWANZ Receipt`: wordmark (Unbounded-style caps rendered as text), boutique line + address/phone from AWANZ Store, invoice no, datetime, associate, client + tier, lines (item, serial, certificate), subtotal, tax, loyalty, total, payment line with card brand/last4/approval, points earned, signature line if total ≥ 10,000, footer. Also generate an ePOS-Print XML builder in the frontend for direct LAN printing.

## Dev environment
`docker/docker-compose.yml` based on frappe_docker (mariadb 10.6, redis, frappe/erpnext v15 image) + script `docker/setup.sh` that creates site `maison.localhost`, installs erpnext + maison_pos, seeds demo data (`maison_pos.setup.demo.seed()` → company, 3 boutiques, 40 items, 20 customers, loyalty program, roles, users). `bench --site maison.localhost execute maison_pos.setup.demo.seed`.

## Quality bar
Python: type hints, docstrings, `frappe.get_doc` patterns, no raw SQL unless needed, tests in `maison_pos/tests/` using `frappe.tests.utils.FrappeTestCase`. Frontend: `vitest` unit tests for sync queue, totals/tax math, ePOS XML; `eslint`+`prettier`. Every endpoint validates input and permission (`frappe.has_permission` / boutique scoping). Secrets via `site_config.json` (`stripe_secret_key`, `stripe_publishable_key`).
