# Maison POS — Integration Notes (bench `maison.localhost`, Frappe/ERPNext v15)

Date: 2026-08-22. Bench: `/home/claude/frappe-bench`, site `maison.localhost`
(Administrator / admin). App installed as a **symlink** so edits in
`/home/claude/maison` are live:

```bash
ln -sfn /home/claude/maison /home/claude/frappe-bench/apps/maison_pos
./env/bin/pip install -e apps/maison_pos          # from the bench dir, as user claude
printf 'frappe\nerpnext\nmaison_pos\n' > sites/apps.txt
bench --site maison.localhost install-app maison_pos
bench --site maison.localhost migrate
bench --site maison.localhost execute maison_pos.setup.demo.seed   # run twice: idempotent
bench --site maison.localhost set-config allow_tests true
bench --site maison.localhost run-tests --app maison_pos            # 27 tests, OK
bench build --app maison_pos                                        # sites/assets/maison_pos -> public/
```

All bench commands must run as user `claude` (`sudo -u claude -H bash -lc 'cd /home/claude/frappe-bench && …'`).
After `pip install -e`, **restart `bench start`** — web/worker processes started
before the install cannot import `maison_pos` (`ModuleNotFoundError` on every request).

## What failed initially and what was changed

| # | Symptom | Fix (file) |
|---|---------|------------|
| 1 | `pip install -e` failed: flit `Description file README.md does not exist` (repo has no root README) | `pyproject.toml`: `readme = "maison_pos/README_BACKEND.md"` |
| 2 | `sites/apps.txt` had no trailing newline → `erpnextmaison_pos` when appending | rewrote `apps.txt` (bench side only) |
| 3 | `install-app` printed `Skipping fixture syncing from the file workflow.json. Reason: DocType Maison Price Change Request not found` | Transient first-install meta-cache issue; `after_install` already creates states/actions/workflow from the same fixtures. `sync_fixtures` re-run and `migrate` are clean; workflow is active. No code change. |
| 4 | Seed: `Could not find Warehouse Type: Transit` (then Item Group / UOM / Customer Group missing). The site had never completed the ERPNext setup wizard | `maison_pos/setup/demo.py`: new `ensure_erpnext_setup()` runs `erpnext.setup.setup_wizard.setup_wizard.setup_complete()` headlessly (fixtures, company "Maison"/MSN, fiscal year, defaults) when no Company exists, then marks `Installed Application.is_setup_complete` + `System Settings.setup_complete`. |
| 5 | Seed: Stock Entry `Please enter Difference Account or set default Stock Adjustment Account for company Maison` (headless company has no default ledgers) | `ensure_company()` sets `update_default_account=1`, calls `Company.set_default_accounts()` and fills `write_off_account` |
| 6 | Seed: demo password `maison123` rejected (`similar to a commonly used password`) | `ensure_user()` sets `user.flags.ignore_password_policy = True` |
| 7 | Seed: demo customers landed in Customer Group "Government" (first non-group match) | `ensure_customer()` prefers `Individual` |
| 8 | Tests: 4 errors + 1 failure in `test_price_change_approval` — `FrappeTestCase` keeps data across tests in a class, so the Pricing Rule created by one test changed `current_rate` for the next (`Proposed rate equals the current rate`, and the "equals current" assertion no longer raised) | `tests/test_price_change_approval.py`: per-test `frappe.db.savepoint` / `rollback(save_point=…)` in `setUp`/`tearDown`. No assertions removed. |
| 9 | Tests: `test_manager_can_void_own_boutique_only` → `PermissionError` from `get_mapped_doc` in `make_sales_return`: Maison Manager (Sales User) has no *create* on Sales Invoice in ERPNext v15 (only Accounts roles) | `maison_pos/setup/install.py`: new `create_role_permissions()` adds idempotent Custom DocPerms for the four Maison roles on Sales Invoice and Customer (`ROLE_DOCPERMS`), run from `after_install` and `after_migrate`. Row scoping still comes from the Warehouse User Permission. |
| 10 | `/maison-dashboard` rendered "Dashboard not built": Frappe maps `maison-dashboard.html` to controller `maison_dashboard.py` (hyphen → underscore), so `get_context` never ran | renamed `www/maison-dashboard.py` → `www/maison_dashboard.py` |
| 11 | Dashboard bundle `<script>`/`<link>` injected twice and HTML-escaped: context keys `head_html`/`body_html` collide with Frappe's `base.html` `{{ head_html }}`, and the template lacked `\| safe` | context keys renamed to `dashboard_head` / `dashboard_body`, rendered with `\| safe` in `www/maison-dashboard.html` |
| 12 | `download_pdf` → `wkhtmltopdf … HostNotFoundError` | Environment only: `maison.localhost` did not resolve inside the container, so wkhtmltopdf could not fetch `/assets/frappe/dist/css/print.bundle.css`. Added `127.0.0.1 maison.localhost` to `/etc/hosts`. HTML render had no Jinja errors before this. |

## Smoke tests (all run against the live bench)

```bash
J=cj.txt; H="Host: maison.localhost"; B=http://localhost:8000
curl -s -c $J -H "$H" -X POST $B/api/method/login -H 'Content-Type: application/json' -d '{"usr":"Administrator","pwd":"admin"}'
# -> {"message":"Logged In","home_page":"/app/home","full_name":"Administrator"}

curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.catalog.bootstrap?boutique=CHI-OAK"
# -> keys/sizes: boutique 16, pos_profile 10, taxes 1, modes_of_payment 2, item_groups 9, departments 5,
#    items 42, prices 42, pricing_rules 0, serials 21 item codes, stock 37, loyalty_program, version ISO ts

curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.customers.search?q=chen"
# -> [{"name":"Mei-Lin Chen","mobile_no":"+1 312 555 0105","loyalty_points":0.0,"tier":"Collector",...}]

# POSTs after visiting /pos need the CSRF token (session gets one once the page is served):
CSRF=$(curl -s -b $J -H "$H" $B/pos | grep -o 'window.csrf_token = "[^"]*"' | cut -d'"' -f2)
POST() { curl -s -b $J -H "$H" -H "X-Frappe-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST "$B/api/method/$1" -d "$2"; echo; }

POST maison_pos.api.sales.submit_batch '{"invoices":[{"offline_uuid":"smoke-cash-0001","boutique":"CHI-OAK","associate":"chi.oak.a1@maison.example","device_id":"SMOKE-1","customer":"Mei-Lin Chen","posting_datetime":"2026-08-22T05:15:00","items":[{"item_code":"AC-012","qty":2,"rate":160}],"payments":[{"mode_of_payment":"Cash","amount":352.80}]}]}'
# -> {"results":[{"offline_uuid":"smoke-cash-0001","status":"ok","invoice_name":"ACC-SINV-2026-00001","grand_total":352.8,...}]}
# same payload again:
# -> {"results":[{"offline_uuid":"smoke-cash-0001","status":"duplicate","invoice_name":"ACC-SINV-2026-00001"}]}

POST maison_pos.api.sales.submit_batch '{"invoices":[{"offline_uuid":"smoke-card-0001","boutique":"CHI-OAK","associate":"chi.oak.a1@maison.example","device_id":"SMOKE-1","posting_datetime":"2026-08-22T05:15:00","items":[{"item_code":"TP-001","qty":1,"rate":6900,"serial_no":"TP-001-CHI-001"}],"payments":[{"mode_of_payment":"Card","amount":7607.25,"stripe_payment_intent":"pi_sim_smoke1"}]}]}'
# -> {"results":[{"offline_uuid":"smoke-card-0001","status":"ok","invoice_name":"ACC-SINV-2026-00002","grand_total":7607.25,...}]}
# same serial with offline_uuid smoke-card-0002:
# -> {"results":[{"offline_uuid":"smoke-card-0002","status":"error","error_code":"SERIAL_UNAVAILABLE",
#     "error":"Serial number(s) no longer available: TP-001-CHI-001 (not_in_warehouse)","details":{"serials":[...]}}]}

curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.dashboard.live_summary"
# -> totals {"net":7960.05,"invoices":2,"cash":352.8,"card":7607.25,"avg_ticket":3980.025,"boutiques":3};
#    by_boutique CHI-OAK net 7960.05, MIA-DD 0, NYC-5AV 0; by_hour[24]; pending_approvals 0

POST maison_pos.api.dashboard.heartbeat '{"boutique":"CHI-OAK","device_id":"SMOKE-1","queued":0}'
# -> {"ok":true,"server_time":"...","status":"Online"}

POST maison_pos.api.stripe_terminal.connection_token '{"boutique":"CHI-OAK"}'
# -> {"secret":"pst_sim_…","simulated":true,"location":null,"publishable_key":null}

curl -s -o /dev/null -w "%{http_code}\n" -b $J -H "$H" $B/pos                # 200
#   contains <script type="module" crossorigin src="/assets/maison_pos/pos/assets/index-HxiZ3mPV.js">
curl -s -o /dev/null -w "%{http_code}\n" -b $J -H "$H" $B/maison-dashboard   # 200
#   contains exactly one <script type="module" … src="/assets/maison_pos/dashboard/assets/index-CC4L0oAU.js">
#   and <link rel="stylesheet" … index-CQD2HKWW.css>, plus <div id="app">

# Receipt
bench --site maison.localhost execute frappe.get_print --kwargs '{"doctype":"Sales Invoice","name":"ACC-SINV-2026-00002","print_format":"Maison Receipt","no_letterhead":1}'
#   -> HTML with wordmark, "Oak Street" address/phone, TP-001-CHI-001 serial line, Card $7,607.25, points earned; no Jinja errors
curl -s -o receipt.pdf -w "%{http_code} %{content_type}\n" -b $J -H "$H" "$B/api/method/frappe.utils.print_format.download_pdf?doctype=Sales%20Invoice&name=ACC-SINV-2026-00002&format=Maison%20Receipt&no_letterhead=1"
#   -> 200 application/pdf (24 KB, %PDF-1.4)
```

## Results

- `install-app`, `migrate`: clean.
- `maison_pos.setup.demo.seed`: succeeds, second run identical (`items 42, serials 102, customers 20, associates 11`).
- `run-tests --app maison_pos`: **Ran 27 tests — OK**.
- `bench build --app maison_pos`: `sites/assets/maison_pos -> /home/claude/maison/maison_pos/public`.
- Bench left running via `bench start` (honcho) — `curl -s -H 'Host: maison.localhost' localhost:8000/api/method/frappe.ping` → `pong`.

## Notes for operators

- On a fresh site the seed now bootstraps ERPNext itself (company, fiscal year, chart of accounts). Running the interactive setup wizard first is also fine — the seed only runs the headless wizard when no Company exists.
- `allow_tests` is set in `site_config.json` for the dev site.
- The PWA needs `X-Frappe-CSRF-Token` on POSTs once a session has a token (`www/pos.py` injects it as `window.csrf_token`).
