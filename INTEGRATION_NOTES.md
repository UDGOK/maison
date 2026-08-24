# AWANZ POS — Integration Notes (bench `maison.localhost`, Frappe/ERPNext v15)

Date: 2026-08-22. Bench: `/home/claude/frappe-bench`, site `maison.localhost`
(Administrator / admin). App installed as a **symlink** so edits in
`/home/claude/awanz` are live:

```bash
ln -sfn /home/claude/awanz /home/claude/frappe-bench/apps/maison_pos
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
| 3 | `install-app` printed `Skipping fixture syncing from the file workflow.json. Reason: DocType AWANZ Price Change Request not found` | Transient first-install meta-cache issue; `after_install` already creates states/actions/workflow from the same fixtures. `sync_fixtures` re-run and `migrate` are clean; workflow is active. No code change. |
| 4 | Seed: `Could not find Warehouse Type: Transit` (then Item Group / UOM / Customer Group missing). The site had never completed the ERPNext setup wizard | `maison_pos/setup/demo.py`: new `ensure_erpnext_setup()` runs `erpnext.setup.setup_wizard.setup_wizard.setup_complete()` headlessly (fixtures, company "AWANZ"/MSN, fiscal year, defaults) when no Company exists, then marks `Installed Application.is_setup_complete` + `System Settings.setup_complete`. |
| 5 | Seed: Stock Entry `Please enter Difference Account or set default Stock Adjustment Account for company AWANZ` (headless company has no default ledgers) | `ensure_company()` sets `update_default_account=1`, calls `Company.set_default_accounts()` and fills `write_off_account` |
| 6 | Seed: demo password `maison123` rejected (`similar to a commonly used password`) | `ensure_user()` sets `user.flags.ignore_password_policy = True` |
| 7 | Seed: demo customers landed in Customer Group "Government" (first non-group match) | `ensure_customer()` prefers `Individual` |
| 8 | Tests: 4 errors + 1 failure in `test_price_change_approval` — `FrappeTestCase` keeps data across tests in a class, so the Pricing Rule created by one test changed `current_rate` for the next (`Proposed rate equals the current rate`, and the "equals current" assertion no longer raised) | `tests/test_price_change_approval.py`: per-test `frappe.db.savepoint` / `rollback(save_point=…)` in `setUp`/`tearDown`. No assertions removed. |
| 9 | Tests: `test_manager_can_void_own_boutique_only` → `PermissionError` from `get_mapped_doc` in `make_sales_return`: AWANZ Manager (Sales User) has no *create* on Sales Invoice in ERPNext v15 (only Accounts roles) | `maison_pos/setup/install.py`: new `create_role_permissions()` adds idempotent Custom DocPerms for the four AWANZ roles on Sales Invoice and Customer (`ROLE_DOCPERMS`), run from `after_install` and `after_migrate`. Row scoping still comes from the Warehouse User Permission. |
| 10 | `/awanz-dashboard` rendered "Dashboard not built": Frappe maps `awanz-dashboard.html` to controller `awanz_dashboard.py` (hyphen → underscore), so `get_context` never ran | renamed `www/awanz-dashboard.py` → `www/awanz_dashboard.py` |
| 11 | Dashboard bundle `<script>`/`<link>` injected twice and HTML-escaped: context keys `head_html`/`body_html` collide with Frappe's `base.html` `{{ head_html }}`, and the template lacked `\| safe` | context keys renamed to `dashboard_head` / `dashboard_body`, rendered with `\| safe` in `www/awanz-dashboard.html` |
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
curl -s -o /dev/null -w "%{http_code}\n" -b $J -H "$H" $B/awanz-dashboard   # 200
#   contains exactly one <script type="module" … src="/assets/maison_pos/dashboard/assets/index-CC4L0oAU.js">
#   and <link rel="stylesheet" … index-CQD2HKWW.css>, plus <div id="app">

# Receipt
bench --site maison.localhost execute frappe.get_print --kwargs '{"doctype":"Sales Invoice","name":"ACC-SINV-2026-00002","print_format":"AWANZ Receipt","no_letterhead":1}'
#   -> HTML with wordmark, "Oak Street" address/phone, TP-001-CHI-001 serial line, Card $7,607.25, points earned; no Jinja errors
curl -s -o receipt.pdf -w "%{http_code} %{content_type}\n" -b $J -H "$H" "$B/api/method/frappe.utils.print_format.download_pdf?doctype=Sales%20Invoice&name=ACC-SINV-2026-00002&format=AWANZ%20Receipt&no_letterhead=1"
#   -> 200 application/pdf (24 KB, %PDF-1.4)
```

## Results

- `install-app`, `migrate`: clean.
- `maison_pos.setup.demo.seed`: succeeds, second run identical (`items 42, serials 102, customers 20, associates 11`).
- `run-tests --app maison_pos`: **Ran 27 tests — OK**.
- `bench build --app maison_pos`: `sites/assets/maison_pos -> /home/claude/awanz/maison_pos/public`.
- Bench left running via `bench start` (honcho) — `curl -s -H 'Host: maison.localhost' localhost:8000/api/method/frappe.ping` → `pong`.

## Notes for operators

- On a fresh site the seed now bootstraps ERPNext itself (company, fiscal year, chart of accounts). Running the interactive setup wizard first is also fine — the seed only runs the headless wizard when no Company exists.
- `allow_tests` is set in `site_config.json` for the dev site.
- The PWA needs `X-Frappe-CSRF-Token` on POSTs once a session has a token (`www/pos.py` injects it as `window.csrf_token`).

## v0.3 — Client recognition backend (2026-08-22)

Changes: doctypes `AWANZ Face Template` (child of Customer, `maison_face_templates`),
`AWANZ Biometric Consent`, `AWANZ Recognition Event`; settings fields (`recognition_model`,
`match_threshold`, `biometric_retention_months`, `recognition_offline_cache`, `consent_text`,
`consent_text_version`; `face_recognition_enabled` is now writable); `AWANZ Store.face_recognition_enabled`
(Inherit/On/Off); Customer `maison_face_consent_at` (+ hidden legacy `_on` mirror); `maison_pos/api/recognition.py`;
`maison_pos/biometrics.py` (cosine math, threshold conversion, consent text); daily
`maison_pos.tasks.purge_expired_biometrics`; `dashboard.live_summary.recognition`; patch
`maison_pos.patches.v0_3.biometrics_fields`; `docs/biometrics-policy.md`; `tests/test_recognition.py` (23 tests).

```bash
bench --site maison.localhost migrate                     # clean; runs patches.v0_3.biometrics_fields
bench --site maison.localhost run-tests --app maison_pos   # Ran 72 tests — OK (3 consecutive runs)
pkill -f honcho; setsid nohup bench start > logs/bench-start.log 2>&1 &   # restart after python changes
```

Notes / gotchas found while integrating:

| # | Symptom | Fix |
|---|---------|-----|
| 1 | numpy is **not** installed in the bench env | `maison_pos/biometrics.py` uses pure-python cosine (numpy is picked up automatically if present). |
| 2 | `bootstrap.settings.scan_enabled / receipt_qr_enabled / loyalty_lookup_enabled` came back `0` after the Single was saved once from the desk: Frappe does not apply field defaults to an existing Single row, so unsaved Check fields load as 0 and get persisted as 0 on the next save | `get_pos_settings` now reads the stored row (`get_singles_dict`) and applies defaults for missing keys; `ensure_settings_defaults` (after_install / after_migrate / v0.3 patch) persists the v0.2 defaults (=1) and the v0.3 recognition defaults when absent. The dev site row was repaired by hand (`set_single_value` → 1). |
| 3 | `templates(since=…)` returned `deleted: []` when `since` was a UTC timestamp | All API timestamps are site-local (like every other endpoint). Use the `version` returned by the previous `templates` call as `since`. |
| 4 | MariaDB and the bench were not running at the start of the session | `service mariadb start`, then `bench start` as user claude. |

### Smoke tests (live bench, Administrator)

```bash
J=cj.txt; H="Host: maison.localhost"; B=http://localhost:8000
curl -s -c $J -H "$H" -X POST $B/api/method/login -H 'Content-Type: application/json' -d '{"usr":"Administrator","pwd":"admin"}'
CSRF=$(curl -s -b $J -H "$H" $B/pos | grep -o 'window.csrf_token = "[^"]*"' | cut -d'"' -f2)
POST() { curl -s -b $J -H "$H" -H "X-Frappe-CSRF-Token: $CSRF" -H 'Content-Type: application/json' -X POST "$B/api/method/$1" -d "$2"; echo; }
# E = JSON list of 3 x 128 floats, P = a jittered copy of E[0], O = an unrelated vector (see scratch vecs.json)

POST frappe.client.set_value '{"doctype":"AWANZ POS Settings","name":"AWANZ POS Settings","fieldname":"face_recognition_enabled","value":1}'
curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.catalog.bootstrap?boutique=CHI-OAK"   # settings now include:
# {"face_recognition_enabled":1,"face_recognition_global":1,"recognition_model":"face-api/faceRecognitionNet@1",
#  "match_threshold":0.84875,"match_distance_threshold":0.55,"biometric_retention_months":36,"recognition_offline_cache":1,
#  "consent_text":"I agree that AWANZ may create and store …","consent_text_version":"2026-08-1"}

POST maison_pos.api.recognition.match "{\"embedding\":$P,\"model\":\"face-api/faceRecognitionNet@1\",\"boutique\":\"CHI-OAK\",\"device_id\":\"SMOKE-1\"}"
# -> {"matches":[],"threshold":0.84875,"best_score":0.0,"model":"face-api/faceRecognitionNet@1","candidates":0,"event":"mvh19r8tdr"}

POST maison_pos.api.recognition.enroll "{\"embeddings\":$E,\"model\":\"face-api/faceRecognitionNet@1\",\"quality\":[0.91,0.93,0.9],\"boutique\":\"CHI-OAK\",\"device_id\":\"SMOKE-1\",\"consent\":{\"method\":\"Hold-to-agree\",\"text_version\":\"2026-08-1\"},\"phone\":\"+1 312 555 0199\",\"name\":\"Smoke Client\",\"offline_uuid\":\"smoke-enrol-0001\"}"
# -> {"customer":"Smoke Client","customer_name":"Smoke Client","client_number":"MC595284","tier":"Collector","loyalty_points":0.0,
#     "points_value":0.0,"face_consent":1,"face_consent_at":"2026-08-22 11:12:37.802490","consent":"MBC-2026-00001",
#     "templates":["mvq4tni1ka","mvqr2qk9nn","mvqiqrmgar"],"created":true,"consent_text_version":"2026-08-1","event":"mvqtul8mfq"}

POST maison_pos.api.recognition.match "{\"embedding\":$P,...}"
# -> {"matches":[{"customer":"Smoke Client",...,"score":0.998543}],"threshold":0.84875,"best_score":0.998543,"candidates":3,"event":"…"}
POST maison_pos.api.recognition.match "{\"embedding\":$O,...}"
# -> {"matches":[],"threshold":0.84875,"best_score":0.039206,"candidates":3,"event":"…"}

curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.recognition.templates?boutique=CHI-OAK"
# -> {"templates":[{"template":"mvq4tni1ka","customer":"Smoke Client","customer_name":"Smoke Client","client_number":"MC595284",
#     "embedding":[-0.0524,…128 unit-normalised floats],"model":"face-api/faceRecognitionNet@1","dims":128,"captured_at":"2026-08-22 11:12:37.802490"}, …3 rows],
#     "deleted":[],"enabled":1,"model":"face-api/faceRecognitionNet@1","threshold":0.84875,"version":"2026-08-22T11:12:38.030701"}
# delta: ...templates?boutique=CHI-OAK&since=<version>  -> 3 new rows after a re-enrol; after revoke -> {"templates":[],"deleted":["Smoke Client"],…}

POST maison_pos.api.recognition.log_event '{"outcome":"Undone","customer":"Smoke Client","score":0.93,"boutique":"CHI-OAK","device_id":"SMOKE-1"}'
# -> {"ok":true,"event":"mvsu18snsc"}
curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.recognition.status?customer=Smoke%20Client"
# -> {"customer":"Smoke Client",…,"face_consent":1,"consent":{"name":"MBC-2026-00001","captured_at":"…","consent_text_version":"2026-08-1","method":"Hold-to-agree","boutique":"CHI-OAK"},"templates":3,"can_revoke":true}

POST maison_pos.api.recognition.decline '{"boutique":"CHI-OAK","device_id":"SMOKE-1","email":"smoke.decline@example.com","name":"Smoke Decliner"}'
# -> {"customer":"Smoke Decliner","customer_name":"Smoke Decliner","client_number":"MC521818",…,"face_consent":0,"face_consent_at":null,"created":true,"event":"mvubqvlqat"}

curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.dashboard.live_summary" | jq .message.recognition
# -> {"matched_today":1,"enrolled_today":1,"nomatch_today":2,"declined_today":1,"undone_today":1}

POST maison_pos.api.recognition.revoke '{"customer":"Smoke Client","reason":"smoke test"}'
# -> {"ok":true,"customer":"Smoke Client","purged_templates":3,"revoked_consents":["MBC-2026-00001"],"event":"mvvjpoad8v"}

# Associate (chi.oak.a1@maison.example / maison123) calling revoke -> HTTP 403 (PermissionError)
bench --site maison.localhost execute maison_pos.tasks.purge_expired_biometrics     # -> {"checked": 0, "purged": []}
POST frappe.client.set_value '{"doctype":"AWANZ POS Settings","name":"AWANZ POS Settings","fieldname":"face_recognition_enabled","value":0}'   # back to default off
```

## v0.3 — Full integration + match-threshold contract fix (2026-08-22)

**Contract fix.** face-api 128-d descriptors are not unit vectors (‖d‖ ≈ 1.4–1.6; the e2e run measured
1.57–1.59), so the earlier backend rule — cosine ≥ 0.849 (0.55 converted as if vectors were unit) — false-matched
different people (cross-person cosine 0.85–0.90). Both sides now share ONE rule, face-api's published one:
**euclidean distance between the RAW descriptors `< match_threshold`, default 0.6**.

| Where | Change |
|---|---|
| `maison_pos/biometrics.py` | `euclidean`, `is_match`, `best_distances`; `distance_to_score(d) = clamp(1 − d/1.2, 0, 1)` (display only); `DEFAULT_DISTANCE_THRESHOLD = 0.6`, `MAX_DISTANCE_THRESHOLD = 1.5`. Cached/stored vectors stay raw. |
| `api/recognition.py` | `match` → `matches[].distance` + `score`, `threshold_distance` (+ `threshold` alias), `best_distance`, `best_score`; `templates` returns **raw** embeddings + `threshold_distance`; `enroll` returns `templates` (row names) **and** `template_count`; `find_or_create_customer` tolerates a concurrent duplicate insert (links instead of 409). |
| `AWANZ POS Settings` | `match_threshold` = max distance (0.6); validate 0 < d ≤ 1.5; invalid stored value → default. Patch `patches.v0_3.match_threshold_distance` moves sites still on the old default 0.55 to 0.6. |
| `api/customers.py` | `search` / `lookup` now emit the contract fields the POS reads: `maison_face_consent`, `maison_face_consent_at`, `face_templates` (kept `face_consent` as alias). Before this the Client screen never showed "enrolled · Delete" on the real bench. |
| frontend `recognition/math.ts` | `euclidean`, `distanceToScore`, `isMatch`, `clampThreshold`, `effectiveThreshold` (device may only **tighten**); `rankMatches` sorts by distance; `reconcile` picks the smaller distance. `DEFAULT_SETTINGS.match_threshold = 0.6`. |
| frontend `matcher.ts` / store / Settings | effective threshold = `min(server, device)`; server rows without `distance` are ignored; slider is a max-distance (0.20 … boutique value); test-mode log prints distances. Stability tracker uses distance < 0.5 between frames. |
| frontend bugs | `pending_enrolments.add` threw `DataCloneError` (reactive proxies) → queue stores plain arrays; replay is re-entrant-safe and sends `offline_uuid` (the `online` event + heartbeat raced and enrolled twice → 409); 409 is retried; decline of an existing client used `log_event('Declined')` (rejected by the server) → uses `recognition.decline({customer})`; declined clients were cached with `maison_face_consent: 1` → fixed. |
| tests | backend `tests/test_recognition.py` uses realistic non-unit synthetic descriptors (shared "mean face" + deviation: ‖v‖ ≈ 1.6, cross-person cosine ≈ 0.87, distance ≈ 0.78) incl. `test_cross_person_false_match_regression` (cosine > 0.85, distance > 0.6 → NoMatch) and `test_customer_search_exposes_biometric_status`. Frontend `src/tests/recognition.test.ts` mirrors it (euclidean rule, threshold helpers, cross-person regression, 409/offline_uuid replay). |

```bash
cd frontend && npm run models && npm run build        # 7.55 MB of weights/WASM copied; vite build + sw.js (39 precache entries)
bench --site maison.localhost migrate                 # runs patches.v0_3.match_threshold_distance (0.55 → 0.6 on the dev site)
bench build --app maison_pos; pkill -u claude -f honcho; setsid nohup bench start > logs/bench-start.log 2>&1 &
bench --site maison.localhost run-tests --app maison_pos   # Ran 75 tests — OK
cd frontend && npm test                                     # 9 files, 92 tests passed; npm run lint clean
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/pos.e2e.mjs       # 11/11
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/pos.v02.e2e.mjs   # 20/20
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/pos.v03.e2e.mjs   # 31/31
```

`e2e/pos.v03.e2e.mjs` (screenshots `e2e/shots-v03/`, results `e2e/results.v03.json`) runs real on-device detection in
headless Chromium (`--use-fake-device-for-media-stream --use-file-for-fake-video-capture=frontend/e2e-assets/face_a|b.mjpeg`,
WASM backend — WebGL is unavailable headless, the warning is expected): enables recognition as Administrator, revokes
stale consents from earlier runs, then as `chi.oak.a1` Looking → New client → enrol with phone (hold-to-agree; 200 ms
press rejected) → server Customer + Active consent + 3 raw 128-d templates + `Enrolled` event → reload → Recognised
(**d = 0.115–0.127, score 0.89–0.90, threshold 0.6**, local and server agree) → Undo (`Matched` + `Undone` events) →
face B against A's templates → New client → decline creates the client without consent/templates (`Declined` event) →
`chi.oak.manager` Client screen "enrolled <date>" → Delete → templates 0, consent Revoked, `Revoked` event, cache 0 →
offline (`context.setOffline`) enrolment queued (pending 1, provisional client) → reconnect replays in ~3 s (Customer +
consent + 3 templates, real client swapped onto the basket) → `live_summary.recognition` deltas
`{matched 2, enrolled 2, nomatch 2, declined 1, undone 1}` → `face_recognition_enabled` set back to 0 (boutique Inherit).

Operator notes: `maison.localhost` must resolve (`127.0.0.1 maison.localhost` in `/etc/hosts`, re-added this session);
`frappe.client.get_list` cannot list the child table `AWANZ Face Template` — use `recognition.status(customer).templates`
or `recognition.templates`. Devices with an old cached threshold override (0.5–0.99 "score") are clamped: any override
≥ the boutique distance is ignored, so no device ends up looser than the server. Recognition remains **off** on the dev site.

<!-- v0.4 H — AI & insights + history seed -->
## v0.4 H — AI & insights, 6-month history seed (2026-08-22)

New: `maison_pos/insights/{affinity,client_signals,product_performance,narrative,jobs}.py`, `maison_pos/api/insights.py`,
doctypes `AWANZ Client Recommendation`, `AWANZ Client Signal`, `AWANZ Rebalance Suggestion`, `AWANZ Insight Report`,
`maison_pos/setup/demo_history.py`, tests `maison_pos/tests/test_insights.py` (20), frontend `stores/insights.ts` +
`components/SuggestionTiles.vue` (wired into `BasketPanel.vue`, delimited `v0.4 H` blocks) + `src/tests/insights.test.ts` (5),
dashboard `src/insights/*` + `components/insights/*` + Insights tab in `App.vue` (delimited), screenshots
`dashboard/screenshots/v04/` (`dashboard/scripts/shots-v04-insights.mjs`, 11/11 checks). Hooks: scheduler cron
`0 5 * * 1` `maison_pos.insights.jobs.compute_weekly`, `0 6 * * 1` `maison_pos.insights.jobs.weekly_narrative`;
`before_tests = maison_pos.setup.demo.before_tests`; permission_query_conditions for the two client tables.

```bash
bench --site maison.localhost migrate
bench --site maison.localhost execute maison_pos.setup.demo_history.seed_history --kwargs '{"months": 6}'
# -> planned 1501, posted 1501 (+70 recent serialized), 8+3 returns via api.returns, reposts processed
bench --site maison.localhost execute maison_pos.insights.jobs.compute_weekly
# -> affinity {customers 116, recommendations 580, baskets 1627, pairs 619}; signals 73 (Due this week 27, Overdue 19,
#    VIP lapsing 12, Spend drop 12, New client 2, Birthday 1); rebalance 8 suggestions
bench --site maison.localhost execute maison_pos.insights.jobs.weekly_narrative
# -> MIR-2026-08-16-Weekly (Template); e-mail skipped: no outgoing Email Account on the dev site (recorded in `error`)
bench --site maison.localhost run-tests --module maison_pos.tests.test_insights   # Ran 20 tests — OK
cd frontend && npm test (141) && npm run lint && npm run build; cd ../dashboard && npm test (12) && npm run build
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node dashboard/scripts/shots-v04-insights.mjs
```

Runtime of `seed_history`: first run 287 s for 550 invoices before it was interrupted by a concurrent `migrate`
("Table definition has changed"), resume 491 s for the remaining 951 incl. 125 s of reposts → ≈ 0.38 s per invoice,
≈ 9.5 min of posting + ≈ 2 min reposts for the full 1,500 on this bench (single process; the Sales Invoice naming
series lock makes parallel posting pointless). The recent-serialized top-up (70 invoices) took 105 s incl. reposts.

Gotchas found while integrating:

| # | Symptom | Fix |
|---|---|---|
| 1 | History run died mid-way: every invoice after #550 failed with `OperationalError 1412 Table definition has changed` (another agent ran `bench migrate` which altered `tabSales Invoice`), then `Deadlock found` on the returns | `_post_plan` retries transient DB errors (deadlock / lock wait / table changed) up to 3× with a full rollback and re-queues the uncommitted chunk; completion marker only when ≥ 98 % of the plan is in, so `seed_history` is safely re-runnable / resumable |
| 2 | Serialized pieces sold out early in the period (per-boutique caps consumed by March) → "no sales in 90 days" everywhere for watches | added the deterministic `build_recent_plan` (70 serialized sales over the last 100 days with their own `-R###` receipts); kept the main plan byte-identical so the already posted invoices stay consistent |
| 3 | Every `bench run-tests` wiped `tabItem Price` (ERPNext `erpnext.setup.utils.before_tests` → `delete from tabItem Price` + commit) → POS tiles / suggestions showed $0.00 on the dev site | `hooks.before_tests = maison_pos.setup.demo.before_tests` restores the demo prices after ERPNext's hook; `maison_pos.setup.demo.seed` also repairs them |
| 4 | `frappe.sendmail(delayed=False)` raises `OutgoingEmailError` on a site without an outgoing account → the Monday narrative job would fail | `narrative.email_report` catches it, stores the message in `AWANZ Insight Report.error`, the report itself is still saved |
| 5 | Back-dated history invoices precede the regular demo opening stock → ERPNext queues a Repost Item Valuation per voucher | `Stock Reposting Settings.item_based_reposting = 1` during the run (deduped per item × warehouse) + `process_reposts()` at the end; bins are always exact (`update_bin_qty` recomputes for back-dated rows) |
| 6 | `"count(name) as n"` works in `frappe.get_all` with `group_by`, but fields containing `_seen`-like names get dropped (known) — not hit here; `AWANZ Client Profile` is feature-detected (birthday / anniversary / do-not-contact), so H works with or without section B installed | — |

Smoke (Administrator, live bench):

```bash
curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.insights.recommend_for_client?customer=Ren%20Yamada&n=3&boutique=NYC-5AV"
# -> owned [AC-001, AC-003, AC-005, AC-011, AC-012, BR-003, BR-004, BR-006, BR-007, SV-001, SV-002] source cache
#    items: SV-005 Appraisal Certificate (score 18.4, "Bought with Eternal Solitaire 2.0ct Platinum in 24% of baskets"),
#           BR-001, BR-002 — none of the owned codes
curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.insights.recommend_for_basket?items=%5B%22TP-001%22%5D&n=3&boutique=CHI-OAK"
# -> AC-010 Leather Watch Strap (lift 4.1, 32 % of baskets), SV-002 Engraving, BR-009
curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.insights.rebalance_suggestions"
# -> e.g. TP-006 NYC-5AV (4 on hand, 0.23/wk, 120 d cover) → CHI-OAK (1 on hand, 0.54/wk, 12 d cover) qty 2, can_transfer true
curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.insights.narrative" | jq .message.narrative
```
<!-- end v0.4 H -->

## v0.4 A/D/E/F — hardware print route, inventory, returns & exchanges, reports (2026-08-22)

Backend: `api/inventory.py`, `api/returns.py`, `api/reports.py`, `reports.py` (shared query helpers),
8 Script Reports under `maison_pos/awanz_pos/report/*`, doctypes `AWANZ Stock Alert`, `AWANZ Cycle
Count`, child `AWANZ Store Reader` (+ `AWANZ Store.readers`, `damaged_warehouse`), settings
fields (returns windows / threshold / digest), custom fields `Sales Invoice.maison_refund_method /
maison_refund_id / maison_return_reason / maison_exchange_invoice / maison_manager_approved_by`,
`Sales Invoice Item.maison_return_reason / maison_return_condition`, `stripe_terminal.client.refund`,
print format `AWANZ Return Receipt`, hooks (hourly `inventory.low_stock_scan`, daily
`inventory.low_stock_digest`, permission queries for the two doctypes), `setup/install_v04_inventory.py`
(Exchange Credit MOP + clearing account, Damaged warehouses; called from after_install/after_migrate),
`setup/demo_v04_inventory.py` (called from `seed()`), `dashboard.live_summary.low_stock / returns`,
`utils.receipt_payload` credit-note keys. Docs: `docs/hardware.md`, `docs/returns.md`.

```bash
bench --site maison.localhost migrate && bench --site maison.localhost execute maison_pos.setup.demo.seed
bench --site maison.localhost execute maison_pos.api.inventory.low_stock_scan   # {"checked": 48, ...}
bench --site maison.localhost run-tests --module maison_pos.tests.test_v0_4_returns     # 11 OK
bench --site maison.localhost run-tests --module maison_pos.tests.test_v0_4_inventory   # 4 OK
bench --site maison.localhost run-tests --module maison_pos.tests.test_v0_4_reports     # 5 OK
cd frontend && npm test      # 13 files, 118 tests (returns math / exchange / canvas layout / cycle count / mock parity)
VITE_MOCK=1 npx vite --port 5174 & PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://localhost:5174 node scripts/shots-v04.mjs   # 28/28, shots in screenshots/v04-returns/
```

Gotchas found:

| # | Symptom | Fix |
|---|---------|-----|
| 1 | `make_sales_return` maps every line; a partial return needs only the selected rows | `returns._build_credit_note` keeps the selected mapped rows, sets `qty = −n`, limits `serial_no` to the chosen serials (ERPNext still validates them against the original) |
| 2 | Stock Reconciliation draft from the cycle count failed for associates: `get_stock_balance_for` calls `frappe.has_permission("Stock Reconciliation", "write", throw=True)` regardless of `ignore_permissions` | the draft is inserted as Administrator with `owner` = the associate (`inventory.submit_cycle_count`) |
| 3 | `frappe.desk.query_report.get_report_doc` refuses associates (report roles) | `reports.run` loads the Report doc directly; access is gated by `assert_roles` + boutique scoping in `normalize_filters` |
| 4 | `Serial No` has no `purchase_date`, `Serial and Batch Bundle` has `posting_datetime` (not date/time) | Serial Ledger uses `creation` / `posting_datetime` |
| 5 | Card refunds on exchanges/returns need the intent: POS sales store it in `maison_terminal_ref` | `card` refund refused (PAYMENT_MISMATCH) when the sale has no terminal ref or the amount exceeds the card charge |
| 6 | Stripe Terminal JS has no reader selection API beyond discovery | driver connects to the reader whose id matches the Settings pick (`readers[].stripe_reader_id`), else the first discovered |

Known failures **outside this section** at the time of writing (full `run-tests --app maison_pos`:
139 tests, 38 errors / 1 failure): `test_recognition`, `test_v0_2`, `test_scoping` (void) and
`test_v0_4_crm_hr` fail with *"Cannot select a Group type Customer Group"* when creating customers and
*"SAVEPOINT awanz_batch_0 does not exist"* inside `submit_batch` (a submit hook commits) — both come
from the concurrent B/C/I work (customer-group tier mapping, commission / coupon hooks), not from
D/E/F. The three v0.4 D/E/F modules pass on their own and `test_submit_batch` / `test_demo_rebase` /
`test_price_change_approval` are unaffected.

## v0.4 G — Web shop (Frappe Webshop + Payments) — 2026-08-22

Apps added to the bench and site (`sites/apps.txt` now `frappe, hrms, erpnext, webshop, maison_pos, payments`, …):

| App | Branch | Commit | `__version__` |
| --- | --- | --- | --- |
| payments | version-15 | `9885a6e` | 0.0.1 |
| webshop | version-15 | `6c8fd00` | 0.0.1 |

```bash
bench get-app payments --branch version-15 --skip-assets && bench get-app webshop --branch version-15 --skip-assets
bench --site maison.localhost install-app payments    # see quirk 1
bench --site maison.localhost install-app webshop
bench --site maison.localhost migrate
bench --site maison.localhost execute maison_pos.setup.demo_v04_webshop.seed_webshop --args "[True]"
bench build --app maison_pos
bench --site maison.localhost run-tests --module maison_pos.tests.test_webshop     # Ran 12 tests — OK
cd frontend && npm run build && npm test                                            # 15 files, 145 tests
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers ADMIN_PWD=admin node e2e/webshop.e2e.mjs # 29/29, shots in e2e/shots-webshop/
```

| # | Symptom | Fix |
|---|---------|-----|
| 1 | `install-app payments` → `Web Form: Options must be a valid DocType for field Payment Gateway in row 60` (after_install custom fields ran before the doctype was synced) | `bench execute payments.utils.make_custom_fields`; documented in docs/webshop.md |
| 2 | Template override by path (`templates/generators/item/item.html`) depends on app install order (`reversed(installed_apps)`): webshop installed after maison_pos wins | `override_doctype_class["Website Item"]` = `AwanzWebsiteItem` with `website.template = "maison_pos/templates/webshop/item.html"`; `/cart` and `/all-products` re-routed with `website_route_rules` to `www/shop/*` |
| 3 | `Website Item.make_thumbnail` (Pillow) fails on the generated SVG visuals | `AwanzWebsiteItem.make_thumbnail` uses the SVG as its own thumbnail |
| 4 | Portal shopper (role Customer) `update_cart` → PermissionError on Item (`get_item_details` → `item.check_permission()` in ERPNext 15.119) and on Account (`get_party_account` strict check) | `maison_pos.webshop.setup.create_portal_permissions`: Custom DocPerms for Customer (Item, Item Price, Website Item, Price List, Sales Taxes and Charges Template read; Account select) |
| 5 | Frappe creates a bare Contact for every new User; webshop resolves the party through the first Contact of the user → a second Customer was created and login failed with "Cannot select a Group type Customer Group" (stale cached settings) | seed links every Contact of the demo shopper to the Customer; `frappe.clear_cache` after the seed |
| 6 | `frappe.csrf_token` rendered as `"None"` on storefront pages after an API login → every `frappe.call` POST failed silently | `shop_context()` calls `frappe.sessions.get_csrf_token()` for signed-in users before the page is rendered |
| 7 | Paying a Payment Request as the shopper → PermissionError creating the Payment Entry (`get_account_details` checks Payment Entry read); same for the manager reconciling the advance at collection | `simulate_payment` and `AwanzPaymentRequest.on_payment_authorized` run the payment as Administrator; AWANZ roles get Payment Entry read (HO full) |
| 8 | ERPNext auto-invoices a *Shopping Cart* Sales Order when its Payment Request is paid (`set_as_paid → make_invoice`) — the POS could then no longer invoice the collection | web Sales Orders use `order_type = Sales`; the advance PE stays against the order |
| 9 | POS invoices skip `update_against_document_in_jv` (ERPNext assumes they are fully tendered) → outstanding stayed = total after collection | `maison_pos.webshop.events.on_invoice_submit` reconciles the advances for `is_pos` invoices with `advances` |
| 10 | webshop's `update_cart(qty=0)` on the last line crashes in `set_cart_count(None)` | `api.webshop.update_cart` deletes the cart Quotation cleanly |
| 11 | `override_doctype_class["Payment Request"]` is declared by both webshop and maison_pos; Frappe takes the last app in `installed_apps` (webshop on this bench) | `simulate_payment` does not depend on it; for real gateways install maison_pos after webshop (documented) |
| 12 | ERPNext `before_tests` deletes every Item Price on each `bench run-tests` — the storefront showed "Price on request" / `$ 0 deposit` while other work-streams ran tests | `maison_pos.setup.demo.before_tests` (v0.4 H) restores them; `ensure_items` re-creates them; demo web orders are only created when prices exist |

## v0.4 — Integration of the four streams (2026-08-22)

Four agents (A/D/E/F, B/C/I/J, G, H) edited the same tree concurrently. This pass merged the result,
made every suite green, proved a from-scratch install, ran every e2e script and wrote `CHANGELOG.md`.
App versions bumped to **0.4.0** (`maison_pos/__init__.py`, `frontend/package.json`, `dashboard/package.json`).

### What was broken and what changed

| # | Symptom | Root cause / fix |
|---|---------|------------------|
| 1 | Full suite: `test_insights.test_client_recommendations_exclude_owned_items` — `owned == {AC-001, AC-012}` failed with an extra `BR-006` | The test used the demo client *Isabella Marchetti*, who carries real history on any site where `seed_history` ran. Uses a dedicated client (`ensure_customer("Insights Owned Test", …)`) — `tests/test_insights.py`. |
| 2 | Full suite (order dependent): `test_recognition.test_retention_purge` — the *second* invoice was refused: *Date 04-22-2023 is not in any active Fiscal Year* | The test back-dated the first invoice at DB level (`posting_date` → 40 months ago) and then submitted another invoice of the same item/warehouse. Whenever a later-dated SLE existed (e.g. sales posted a few hours earlier in UTC from another run) ERPNext's `repost_future_sle_and_gle` re-generated the GL of the back-dated invoice and hit the fiscal-year check. Fix: both visits are posted first, the back-dating happens afterwards and is undone in `addCleanup`. |
| 3 | "Cannot select a Group type Customer Group", "SAVEPOINT awanz_batch_0 does not exist" (reported by the D/E/F stream) | Already fixed upstream by the B/C/I stream before this pass: `customers._default_customer_group()` skips group nodes and prefers *Individual*; no `frappe.db.commit()` remains in any `doc_events` hook (`grep` over `maison_pos` — commits only in scheduler jobs, install and seeds). Verified: 0 errors across 3 full runs. |
| 4 | ERPNext `before_tests` wiping Item Prices | `hooks.before_tests = maison_pos.setup.demo.before_tests` (H stream) restores the demo prices after ERPNext's hook and again at process exit (`atexit`). Ordering verified: prices present after every `run-tests`. |
| 5 | POS Settings showed only *Simulated reader* — the V660p print route could never be picked on the real bench (only the mock had readers) | `catalog.bootstrap.boutique` never carried the v0.4 A child table. `_boutique_dict` now returns `readers[]` (+ `damaged_warehouse`); `tests/test_v0_4_inventory.py` asserts it. |
| 6 | Any **discounted line** (15 % *Accessories week* promotion, manual discount) was refused: `PAYMENT_MISMATCH — Payments (149.94) do not cover the invoice total (176.4)` | v0.1 `build_sales_invoice` treated `rate` as the *net* rate and `discount_amount` as per unit (`price_list_rate = rate + discount`), while the device (and `SPEC.md`) send `rate` = unit list rate and `discount_amount` = whole-line amount. The server now sets `price_list_rate = rate`, `discount_amount = discount / qty`, `rate = list − unit discount` (same semantics `promotions.apply_coupon_to_invoice` already used). `test_submit_batch.test_line_discount_is_whole_line_amount_off_the_list_rate`. |
| 7 | Card sale of TP-002 with WELCOME10 refused: *Card payments exceed the invoice total* — device 24 310.13, server 24 310.12 | Frappe's default **Banker's Rounding** (half to even) vs the device's half-away-from-zero `round()`: 10.25 % of 22 050 = 2 260.125. `setup.install.ensure_rounding_method` pins System Settings `rounding_method = Commercial Rounding` on install / migrate (retail standard; receipts, tags and tax filings expect it). `test_submit_batch.test_half_cent_tax_rounds_like_the_device`. |
| 8 | `e2e/pos.v03.e2e.mjs` manager step: the associate select snapped back to the first associate after it was chosen (`Incorrect PIN`) | `UnlockView.onMounted` awaited `shift.restore()` / `loadBoutiques()` (v0.4 C) and *then* reset `selectedAssociate` to the first associate — undoing a choice made while the cached catalogue already showed the keypad. Only defaults when nothing is selected. |
| 9 | `pos.v02` iPhone check: *sheet controls ≥ 48 px* — the Promotions chip was 44 px | `PromotionsChip.vue` `min-height: 48px`. |
| 10 | `pos.e2e` "add serialized watch + accessory" — the accessory reported a serial | The e2e read `.line-sub .good` as the serial; the promotion marker (`✦ −$24.00`) is also `.good`. Serial span is now `.good.serial`; every e2e script (incl. cloud copies) uses it. |
| 11 | TopBar at iPad width (1024 px): 8 entries overflowed, *Web orders* and *Count* ran together | Compact mode ≤ 1100 px (short label *Web*, boutique code only, tighter tracking), `.nav` scrolls as a last resort; new **Count** entry (cycle count). Phone drawer lists all 8 entries. Verified by `pos.v04` at 1024 × 768 and 393 × 852. |
| 12 | `webshop.e2e` / `pos.v04` flaked on repeated runs: BR-006 sold out at Oak Street, TP-002 fully reserved | Data exhaustion, not code: `webshop.e2e` tops BR-006 up (Material Receipt) and reserves at the next boutique with a piece; `pos.v04` prefers a watch with ≥ 2 free serials. |
| 13 | After the e2e runs the backend suite lost 7 tests (`test_webshop` "TP-002 not available at Oak Street", `test_insights` rebalance "no TP-005 serial", `test_recognition` candidate counts off by the clients an aborted e2e run left enrolled) | Tests assumed the pristine demo state. They now create what they need inside their rolled-back transaction: `test_webshop` / `test_insights` receive a fresh serial into Oak Street, `test_recognition` starts from an empty gallery (templates deleted, consents revoked at `setUpClass`). The suite is green on a site that has been used. |

### Final counts

| Suite | Result |
|---|---|
| Backend `bench --site maison.localhost run-tests --app maison_pos` | **Ran 153 tests — OK** (3 consecutive runs, incl. one right after the e2e batch) |
| Frontend `npm test` / `vue-tsc` / `lint` / `build` | **145 tests, 15 files** — clean |
| Dashboard `npm test` / `vue-tsc` / `build` | **12 tests** — clean |
| e2e `pos.e2e` / `pos.v02` / `pos.v03` / `webshop` / `pos.v04` | **11/11 · 20/20 · 31/31 · 29/29 · 37/37** (one sequential batch after the final build; console noise is the sandbox proxy's `ERR_CERT_AUTHORITY_INVALID` on Google Fonts and headless "WebGL not supported") |

Dashboard: no duplicated tabs / stores (`Live` + `Insights`), `npm test` 12, `vue-tsc` clean, build clean (no lint script in `dashboard/`).
Frontend stores are unique (`cart, catalog, insights, inventory, layout, loyalty, printer, promos, recognition, scan, session, shift, sync, webOrders`), router has one entry per screen (`returns`, `exchange/:invoice`, `count`, `web-orders`).

### Commands run (all as user `claude`)

```bash
cd frontend  && npm run models && npm test && npx vue-tsc --noEmit && npm run lint && npm run build   # 15 files, 145 tests
cd dashboard && npm test && npx vue-tsc --noEmit && npm run build                                    # 12 tests
bench --site maison.localhost run-tests --app maison_pos        # Ran 153 tests — OK (see counts below)
bench build --app maison_pos; bench --site maison.localhost clear-cache
pkill -u claude -f "^/usr/bin/python3 /usr/local/bin/honcho"; setsid nohup bench start > logs/bench-start.log 2>&1 &
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin BENCH=/home/claude/frappe-bench \
  node e2e/pos.e2e.mjs && node e2e/pos.v02.e2e.mjs && node e2e/pos.v03.e2e.mjs && node e2e/webshop.e2e.mjs && node e2e/pos.v04.e2e.mjs
```

`e2e/pos.v04.e2e.mjs` (37 checks, `e2e/shots-v04/`, `results.v04.json`): coupon WELCOME10 applied on the basket, on the
on-screen receipt and on the server invoice (+ `AWANZ Coupon Redemption`); V660p reader picked in Settings → `Print receipt`
goes through `terminal.print(canvas)` on the simulated reader (384-px PNG captured from `window.__awanzLastReaderPrint`,
saved as `09-reader-print-bitmap.png`); clock-in on Unlock → `AWANZ Shift` + HRMS Employee Checkin; `inventory.low_stock_scan`
(run through `bench execute` when `BENCH` is set) → alert visible on the Shift screen; Clienteling tab (wishlist, owned piece =
the watch just sold), "Suggested for this client" tiles; manager return of the card line → credit note, Stripe (simulated)
refund, serial back in `CHI-OAK - MSN`, commission reversal, return receipt printed on the reader + `/printview` of
`AWANZ Return Receipt`; cash sale → exchange for a pricier piece, difference paid cash; web order placed through the
webshop API → Web orders: pick → ready → collect → Sales Invoice with the advance; guest feedback on `/r/<token>` → `AWANZ
Feedback` + `feedback.summary`; `reports.run("AWANZ Sales Tax Summary")` (Administrator all boutiques, manager CHI-OAK only);
phone drawer + iPad top bar.

### Fresh site from scratch (install order proof)

```bash
bench new-site maison2.localhost --admin-password admin --db-root-password admin
for a in erpnext payments webshop hrms crm maison_pos; do bench --site maison2.localhost install-app $a; done   # all clean
bench --site maison2.localhost execute maison_pos.setup.demo.seed
# -> items 42, serials 102, customers 20, associates 11, v04_crm_hr {employees 11, salary_assignments 11, commission_rules 5,
#    promotions [PRLE-0001, PRLE-0002], coupons 3, profiles 10, follow_ups 5, hrms true, crm true}; webshop seeded
bench --site maison2.localhost execute maison_pos.setup.demo_history.seed_history --kwargs '{"months":3}'
# -> planned 1532, posted 1602 (incl. recent serialized), clients_created 60, failed 0, returns 8 (≈ 6 min)
bench --site maison2.localhost execute maison_pos.insights.jobs.compute_weekly
# -> affinity {customers 51, recommendations 255, baskets 1602, pairs 656}; signals 45; rebalance 0 (3-month window)
bench drop-site maison2.localhost --force --db-root-password admin
```

Nothing had to be fixed for the fresh install: the seed's headless ERPNext setup wizard, `payments` before `webshop`
(the `make_custom_fields` quirk from v0.4 G did not recur in this order) and `maison_pos` last (its
`override_doctype_class` for *Payment Request* wins) all worked first time.

### Frappe Cloud deployment

1. **Release group → Apps**: add, in this order, with these sources / branches
   - `erpnext` — https://github.com/frappe/erpnext — `version-15`
   - `payments` — https://github.com/frappe/payments — `version-15`
   - `webshop` — https://github.com/frappe/webshop — `version-15`
   - `hrms` — https://github.com/frappe/hrms — `version-15`
   - `crm` — https://github.com/frappe/crm — `main` (Frappe CRM 1.x; supports Frappe 15)
   - `maison_pos` — https://github.com/UDGOK/maison — `main`
   Then **Deploy** (build). `maison_pos.hooks.required_apps = ["erpnext", "hrms", "crm"]`, so the bench must contain
   hrms and crm or `install-app maison_pos` fails; webshop / payments are optional but expected for section G.
2. **Site → Apps**: install (or verify installed) `erpnext`, `payments`, `webshop`, `hrms`, `crm`, `maison_pos` — same order.
   Existing sites that already have maison_pos: install `payments`, `webshop`, `hrms`, `crm`, then **Migrate**
   (`after_migrate` creates the v0.4 custom fields, tier Customer Groups, Damaged warehouses, Exchange Credit / Web
   Payment tenders, the 10 Script Reports, pins Commercial Rounding; patch `v0_4.crm_hr_fields` runs).
3. **Site config** (Site → Config): `stripe_secret_key`, `stripe_publishable_key` (Terminal + web checkout; without them the
   POS uses the simulated reader and the shop a simulated gateway), optional `anthropic_api_key` (weekly narrative),
   `allow_tests` only on dev sites.
4. **Post-deploy seeding** (Administrator session, `POST /api/method/...` with the session cookie + `X-Frappe-CSRF-Token`,
   or the Frappe Cloud *Bench console*):
   ```bash
   POST /api/method/maison_pos.setup.demo.seed_remote                                  # idempotent demo data incl. v0.4 (≈ 1 min)
   POST /api/method/maison_pos.setup.demo_history.seed_history_remote  {"months": 6}  # enqueued on the long queue (≈ 10 min)
   GET  /api/method/maison_pos.setup.demo_history.history_status                      # marker.completed, invoices
   POST /api/method/maison_pos.api.insights.compute  {"narrative": 1}                  # recommendations, signals, rebalance, narrative
   ```
   Bench console equivalents: `bench --site <site> execute maison_pos.setup.demo.seed`,
   `… execute maison_pos.setup.demo_history.seed_history --kwargs '{"months":6}'`,
   `… execute maison_pos.insights.jobs.compute_weekly`.
5. **Scheduler** must be enabled on the site (hourly `inventory.low_stock_scan`, daily digest / biometrics purge /
   birthday bonus, Monday 05:00 + 06:00 insights + narrative in the site time zone).
6. **Web shop domain**: Site → Domains → add `shop.brand.com` (CNAME to the site); storefront lives at `/shop`
   (`docs/webshop.md`). Outgoing e-mail account for digests / narrative / feedback alerts.
7. **Devices**: open `/pos`, pick the boutique, Settings → Reader (V660p) and print route; `/awanz-dashboard` for Head Office.

<!-- v0.5 K — AWANZ Salon -->
## v0.5 K — AWANZ Salon, client-facing screen (2026-08-22)

New: doctypes `AWANZ Salon Session`, `AWANZ Salon Playlist` (+ `AWANZ Salon Playlist Item`), `AWANZ Client Profile.private_viewing_invite[_on]`,
`api/salon.py`, `www/salon.{py,html}` (+ route `/salon/<path>`), hooks (hourly `salon.expire_sessions`, `permission_query_conditions` /
`has_permission` for the session doctype), `setup/demo_v05_salon.py` (called from `seed()`), `tests/test_v0_5_salon.py` (23);
frontend `src/salon/**`, `src/stores/salon.ts`, `src/api/salon.ts`, `SalonSettingsCard` / `SalonBar` / `VirtualSalon`, `ConsentScreen`
`controller` prop, `socket.io-client` dependency, Unbounded 300/400 added to the font link; `e2e/salon.e2e.mjs`; `docs/salon.md`.

```bash
bench --site maison.localhost migrate && bench --site maison.localhost execute maison_pos.setup.demo_v05_salon.seed_salon_v05
bench --site maison.localhost run-tests --module maison_pos.tests.test_v0_5_salon     # Ran 23 tests — OK
cd frontend && npm i && npm run lint && npm test && npm run build                        # 16 files, 164 tests
bench build --app maison_pos; pkill -u claude -f honcho; setsid nohup bench start > logs/bench-start.log 2>&1 &
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/salon.e2e.mjs   # 32/32
```

| # | Symptom | Fix |
|---|---|---|
| 1 | Pairing codes kept in `frappe.cache` vanished mid-pairing: saving an AWANZ Store (the e2e flips `face_recognition_enabled`) clears the cache | codes live on a *Pending* `AWANZ Salon Session` row (`pairing_code`, `code_expires_at`); `pair` promotes it |
| 2 | POS countdown showed 0:00 and the card fell back to "Not paired": `expires_at` is site-local, the device clock is not | the POS counts down from `ttl_seconds` on its own clock |
| 3 | `hooks.py` edit lost to a concurrent agent's write (permission_query_conditions entry) → Guest could list sessions | re-applied inside a `v0.5 K` block; covered by `test_guest_cannot_list_sessions_but_can_read_its_own` and the e2e |
| 4 | `frappe.get_all` does not accept `ifnull(...)` keys in dict filters (playlist validity window) | filtered in Python |
| 5 | `expire_sessions` committed inside tests → `SAVEPOINT does not exist` | no explicit commit (scheduler commits) |
| 6 | The real bench returns the loyalty collection factor per tier (`tiers[].collection_factor`), never at the top level → `cart.pointsEarned` (POS receipt + Salon) showed 0 | `cart.collectionFactor()` reads the client's tier row, else the base tier |
| 7 | Headless screenshots rendered Unbounded Black for the Salon's light numerals (only 800/900 installed locally) | Unbounded 300/400 installed in `/root/.fonts` for the e2e; the page links them from Google Fonts |
| 8 | Guest socket: Frappe's socket.io joins every socket to its user room only; custom rooms cannot be joined | events are published to the **document room** (`doctype`/`docname`), Guest gets read on that one document via `has_permission`, never list (`1=0`) |

Known outside this section: `test_insights.test_basket_recommendations` asserts the demo affinity (AC-005 ↔ AC-011) and fails on a site
where e2e runs sold AC-005 together with other pieces; `test_v0_5_campaigns` webhook tests belong to stream M.
<!-- end v0.5 K -->

<!-- v0.6 N/O/P/Q -->
## v0.6 N/O/P/Q — CloudChaserz, receiving, warehouse & rewards (2026-08-23)

New: `maison_pos/brand.py`, `api/{age,rewards,shipping}.py`, `shipping/{__init__,providers/*}.py`,
doctypes `AWANZ Shipment` (+ Line), `AWANZ Replenishment Request` (+ Line), `AWANZ Receiving
Discrepancy`, `AWANZ Age Check`, `AWANZ Giveaway` (+ Entry), `AWANZ Promotion Calendar`
(+ Item, + Rule), `AWANZ Reward Tier`; `setup/cloudchaserz/{__init__,stores,catalog,users,art,
rewards,history}.py`, `setup/install_v06{,_shipping}.py`, `www/{warehouse,warehouse-wall,rewards,
shipping-label}.*`; frontend `src/brand/tokens.ts`, `src/stores/{brand,age,warehouse}.ts`,
`src/warehouse/**`, `src/views/ReceiveView.vue`, `src/components/AgeGateSheet.vue`,
`src/salon/views/SalonIdCheck.vue`, `src/scan/aamva.ts`, `src/api/{v06,warehouse}.ts`;
tests `test_v0_6_warehouse.py`, `test_v0_6_scoping_http.py`, `warehouse.test.ts`,
`v06_age_rewards.test.ts`; `e2e/{warehouse,cloudchaserz}.e2e.mjs`;
`docs/{cloudchaserz,shipping,rewards}.md`.

```bash
cd frontend && npm i && npx vitest run && npm run lint && npm run build      # 18 files, 196 tests
cd dashboard && npx vitest run && npm run build                              # 24 tests
bench --site maison.localhost migrate
bench --site maison.localhost run-tests --app maison_pos                     # Ran 248 tests — OK
bench build --app maison_pos
# CloudChaserz site, from scratch
bench new-site cc.localhost --admin-password admin --db-root-password admin
for a in erpnext payments webshop hrms crm maison_pos; do bench --site cc.localhost install-app $a; done
bench --site cc.localhost execute maison_pos.setup.cloudchaserz.seed
bench --site cc.localhost execute maison_pos.setup.cloudchaserz.seed_history --kwargs '{"months":1}'
bench --site cc.localhost execute maison_pos.insights.jobs.compute_weekly
```

### One brand per site

`AWANZ POS Settings` is a **singleton**, so the brand belongs to the site, not to the company.
The two profiles use different companies and *can* coexist, but seeding CloudChaserz onto the
jewellery demo site rebrands it and points `main_warehouse` at `HOU-WH - CCZ` — which then fails
every jewellery replenishment with `InvalidWarehouseCompany`. Keep them on separate sites:
`maison.localhost` = jewellery (what the v0.1–v0.5 e2e assert), `cc.localhost` = CloudChaserz.

### Serving two sites from one bench

`bench serve` binds to the default site, so the `Host:` header alone does not route. Run a second
dev server for the second site:

```bash
bench --site cc.localhost serve --port 8001      # maison.localhost stays on 8000
```

| # | Symptom | Fix |
|---|---|---|
| 1 | `npx vitest run` hung forever with no output (>9 min) | An import cycle, not a timer: `@/api/mock` imported `JEWELLERY_BRAND` from `@/stores/brand`, which imports `@/stores/catalog`, which imports `@/api`. `insights.test.ts` calls `vi.mock('@/api', async () => await import('@/api/mock'))`, so the mock factory awaited a module that awaited the mock factory — a deadlock with no timeout. The pure tokens moved to `@/brand/tokens.ts` (no store imports); `@/stores/brand.ts` keeps `useBrand()` and re-exports them. |
| 2 | Every later test in a run saw the wrong `frappe.request` (the v0.5 campaign webhook tests errored with *Invalid webhook signature*) | `test_v0_2` assigned to `frappe.request`, which **rebinds the module-level werkzeug LocalProxy** to a plain value for the rest of the process. Always assign `frappe.local.request`. |
| 3 | `Warehouse HOU-WH - CCZ does not belong to company AWANZ` on every warehouse test | `get_main_warehouse` returned the settings-level warehouse regardless of company. It takes a `company` now, and `create_request` / the Replenishment Request pass the store's own company. |
| 4 | Returns screen went completely blank; console `RangeError: Invalid time value` | `Intl.DateTimeFormat.format()` throws on an Invalid Date and the throw inside the template killed the view. `fmtDate` / `fmtDateTime` return an em dash for missing or unparsable values. |
| 5 | Collecting a prepaid web order: *Advance amount cannot be greater than USD 2042.38* | An in-store promotion made the counter invoice smaller than the amount paid online. `apply_web_order_advances` now allocates at most the invoice total and leaves the rest as an unallocated advance. |
| 6 | Rewards balance always 0 despite Loyalty Point Entries existing | The seeded programme had `expiry_duration: 0`, and ERPNext stamps `expiry_date = posting_date + expiry_duration` — the points expired the day they were earned. 3650 days now. Related: a device posting `new Date().toISOString()` (UTC) to a site in `America/Chicago` can date an entry *tomorrow*, and ERPNext excludes future entries from the balance — the e2e posts the server's clock. |
| 7 | Redeeming the $5 / 100-point tier: *You can't redeem Loyalty Points having more value than the Total Amount* | ERPNext's `conversion_factor` is the **redemption** value (currency per point), not the earning rate. Every tier is $0.05 a point; the seed had 1.0, so 100 points were valued at $100. |
| 8 | `/rewards` rendered the earn line, the redeem rows and the perks as blank / `{{ no such element }}` | The template read `p.copy.earn`; Jinja resolves `.copy` to the `dict.copy` builtin before the key. Subscript (`program['copy']`) forces the item lookup. |
| 9 | POS top bar broke on the rebranded tenant | Three separate causes: the 12-character `CLOUDCHASERZ` wordmark at 0.3em tracking pushed the menu button 18 px off a 390 px screen; the 9th nav entry (*Receive*) plus longer store names made the full labels collide at 1366×1024; and once the wordmark was allowed to shrink it ellipsised the *brand*. Final shape: compact bar up to 1400 px, the wordmark never shrinks, the store code yields first, and under 440 px the status pill drops to its dot. |
| 10 | Storefront scrolled sideways (page 2435 px wide at a 1366 viewport) | The smoke-shop catalogue has 11 item groups where the jewellery one had 4: `.mw-nav` was a non-shrinking flex row of `nowrap` links. It shrinks and scrolls inside itself now; the footer columns got `min-width: 0` for the same reason at 390 px. |
| 11 | Wall cards cut the descenders off the store name | `.wcard` is a fixed-height column flex box, so the name row shrank below its own line box and `.ellipsis`'s `overflow: hidden` clipped it. `flex: 0 0 auto` + explicit line height. |
| 12 | Backend / e2e failures that were data, not code — `AC-012` sold out at CHI-OAK, no item with two free serials, a leftover `AWANZ Shipment`, a stale `Ready` web order | The shared bench is sold through by every e2e run. Tests guarantee their own stock (`tests/helpers.ensure_stock`), `pos.v02` / `pos.v04` top up before they start, and the scoping test asserts *what* comes back rather than a global count. |
| 13 | `nav(page, 'Web orders')` timed out after the compact bar was widened to 1400 px | The compact bar renders short labels (`Web`, `Rcv`); the full label is always on the button's `title`, so the e2e select on `.nav-btn[title="…"]`. |

### Final counts

| Suite | Result |
|---|---|
| Backend `bench --site maison.localhost run-tests --app maison_pos` | **Ran 248 tests — OK** |
| Frontend `npx vitest run` / `lint` / `build` | **196 tests, 18 files** — clean |
| Dashboard `npx vitest run` / `build` | **24 tests** — clean |
| e2e `pos` / `pos.v02` / `pos.v03` / `webshop` / `pos.v04` / `salon` / `dashboard.v05` | 11 · 20 · 31 · 29 · 37 · 32 · 18 |
| e2e `warehouse` / `cloudchaserz` (cc.localhost) | 16 · 27 |

Screenshots: `e2e/shots-v06/` (Receive, warehouse desk, approval, wall 1920×1080, wall after ship,
count sheet, receipt confirmation, POS 1366×1024, age gate / blocked / passed, POS iPhone 390×844,
Salon ID-check, `/rewards`).
<!-- end v0.6 N/O/P/Q -->
