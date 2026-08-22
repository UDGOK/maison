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

## v0.3 — Client recognition backend (2026-08-22)

Changes: doctypes `Maison Face Template` (child of Customer, `maison_face_templates`),
`Maison Biometric Consent`, `Maison Recognition Event`; settings fields (`recognition_model`,
`match_threshold`, `biometric_retention_months`, `recognition_offline_cache`, `consent_text`,
`consent_text_version`; `face_recognition_enabled` is now writable); `Maison Boutique.face_recognition_enabled`
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

POST frappe.client.set_value '{"doctype":"Maison POS Settings","name":"Maison POS Settings","fieldname":"face_recognition_enabled","value":1}'
curl -s -b $J -H "$H" "$B/api/method/maison_pos.api.catalog.bootstrap?boutique=CHI-OAK"   # settings now include:
# {"face_recognition_enabled":1,"face_recognition_global":1,"recognition_model":"face-api/faceRecognitionNet@1",
#  "match_threshold":0.84875,"match_distance_threshold":0.55,"biometric_retention_months":36,"recognition_offline_cache":1,
#  "consent_text":"I agree that Maison may create and store …","consent_text_version":"2026-08-1"}

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
POST frappe.client.set_value '{"doctype":"Maison POS Settings","name":"Maison POS Settings","fieldname":"face_recognition_enabled","value":0}'   # back to default off
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
| `Maison POS Settings` | `match_threshold` = max distance (0.6); validate 0 < d ≤ 1.5; invalid stored value → default. Patch `patches.v0_3.match_threshold_distance` moves sites still on the old default 0.55 to 0.6. |
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
`frappe.client.get_list` cannot list the child table `Maison Face Template` — use `recognition.status(customer).templates`
or `recognition.templates`. Devices with an old cached threshold override (0.5–0.99 "score") are clamped: any override
≥ the boutique distance is ignored, so no device ends up looser than the server. Recognition remains **off** on the dev site.
