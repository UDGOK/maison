# Maison POS — end-to-end check against the LIVE Frappe Cloud site

Date: 2026-08-22 (07:30–07:50 UTC = 02:30–02:50 America/Chicago, the site's timezone).
Site: `https://maison-demo.frappe.cloud`. Playwright 1.56 / Chromium 1194, POS viewport 1366x1024, dashboard 1920x1080.
Script: `/home/claude/maison/e2e/pos.cloud.e2e.mjs` (copy of `pos.e2e.mjs`; no source under `maison_pos/` or `frontend/` was touched).
Screenshots: `/home/claude/maison/e2e/cloud-shots/`. Raw results: `results.cloud.json`, log: `cloud-run.log`.

Re-run:

```bash
cd /home/claude/maison/e2e
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
BASE=https://maison-demo.frappe.cloud ADMIN_SID=$(cat /tmp/sid) \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pos.cloud.e2e.mjs
```

## What changed vs. the bench script

- `ADMIN_SID`: when set, the admin API request context and the dashboard browser context are created with a
  Playwright `storageState` carrying cookie `sid=<ADMIN_SID>` for `maison-demo.frappe.cloud` instead of
  `POST /api/method/login`. Validity is asserted via `GET /api/method/frappe.auth.get_logged_user` (`Administrator`).
  All admin verification calls are GETs (`frappe.client.get_list`, `frappe.client.get`, `frappe.client.get_value`,
  `maison_pos.api.dashboard.live_summary`), so no CSRF token is needed. The associate flow is unchanged
  (`chi.oak.a1@maison.example` / `maison123`, PIN 2580, login via `POST /api/method/login` in the POS context).
- `SHOTS_DIR` (default `cloud-shots`), `RESULTS` (default `results.cloud.json`).
- Extra steps: Google Fonts (`document.fonts` — Unbounded loaded + used in computed styles), service-worker
  registration (`navigator.serviceWorker.getRegistrations()`), and a dedicated "dashboard receives realtime events"
  check on the socket.io frames. The "dashboard updates live" step now also requires the sale to have actually synced
  (the bench version passed trivially when the invoice name was empty).
- `BRIDGE=1` + `cloud-bridge.mjs` (sandbox-only plumbing): in this sandbox the egress proxy resets Chromium's own
  TLS connections (`net::ERR_CONNECTION_RESET` for every https host; curl/Node through the same proxy are fine, incl.
  with `--proxy-server`, TLS 1.2 only, HTTP/2 off, PQ/ECH off). The bridge intercepts every request with
  `context.route` and performs it with Playwright's Node-side request context (shares the browser cookie jar, follows
  `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS`), and relays WebSockets via `context.routeWebSocket` + Node's built-in
  `WebSocket`. Page URLs/origins are untouched (still `https://maison-demo.frappe.cloud`), so cookies, secure context,
  service workers and cross-origin font loads behave as in a normal browser. Not needed outside this sandbox.

## Results (run 2, 07:45–07:50 UTC)

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Associate `POST /api/method/login` on the cloud site | PASS | `as chi.oak.a1@maison.example` |
| 2 | Open `/pos` → redirected to `/pos/unlock?next=/sell` | PASS | `cloud-shots/01-pos-landing.png` |
| 3 | Unlock CHI-OAK, PIN 2580, catalog loaded | PASS | 42 tiles, Ines Calder · Associate — `02-sell-after-unlock.png` |
| 4 | Add serialized watch (serial picker) + Silk Pocket Square | PASS | serial `TP-007-CHI-001` — `03-basket-watch-accessory.png` |
| 5 | Attach client via search "chen" | PASS | Mei-Lin Chen — `04-client-attached.png` |
| 6 | CASH sale → synced + server invoice verified | **FAIL (site data)** | Receipt pill **REJECTED** — `05-pay-cash.png`, `06-receipt-cash-initial.png`, `07-receipt-cash-synced.png`; see Finding 1 |
| 7 | CARD sale (simulated reader) → synced + verified | **FAIL (site data)** | `08-pay-card-ready.png`, `09-pay-card-progress.png`, `10-receipt-card-synced.png` — same server error |
| 8 | Offline: `setOffline(true)` → cash sale queued | PASS | pill `Queued offline`, topbar `Offline · 1 queued` — `11-pay-cash.png`, `12-offline-queued.png` |
| 9 | Reconnect → queue drained, invoice server-side | **FAIL (site data)** | queue drained (topbar `Online`, 0 queued) but the server rejected the invoice (NegativeStockError, Finding 1) — `13-online-drained.png` |
| 10 | Dashboard `/maison-dashboard` opens as Administrator (sid cookie) | PASS | `14-dashboard-initial.png` |
| 11 | Google Fonts on the cloud: Unbounded (POS) | PASS | stylesheet `https://fonts.googleapis.com/css2?family=Unbounded:wght@800;900&family=Jost:...` loads; `FontFace` Unbounded 800 + 900 `status=loaded`; Unbounded present in computed `font-family` of headings/totals (visible in every POS shot, e.g. `$204,138.90` in `07-receipt-cash-synced.png`) |
| 12 | Google Fonts: Unbounded (dashboard) | PASS | 800/900 faces `loaded`; the dashboard's Unbounded usage is on the KPI numbers / `MAISON` wordmark (`14-dashboard-initial.png`), the selector sample in the script just did not hit those nodes (`usedInComputedStyle=false` is a test artefact, not a bug) |
| 13 | Service worker registers on `/pos` | **FAIL (product)** | `getRegistrations()` → `[]`, `controller=null`, console: `The path of the provided scope ('/pos') is not under the max scope allowed ('/assets/maison_pos/pos/')…` — Finding 2 |
| 14 | Dashboard updates live within 5 s after a sale | **FAIL (blocked by Finding 1)** | the 4th sale (Cufflinks) was also rejected, so there was no invoice for the dashboard to show; `live_summary.totals.invoices` 0→0 — `15-pay-cash.png`, `16-dashboard-after-sale.png` |
| 15 | Dashboard receives realtime (socket.io) events | PASS | WebSocket `wss://maison-demo.frappe.cloud/socket.io/?EIO=4&transport=websocket` relayed; frames received: `list_update {doctype: "Sales Invoice", name: "ACC-SINV-2026-00001", user: chi.oak.a1@…}` (the draft that was then rolled back) and `maison_heartbeat {boutique: "CHI-OAK", device_id: "dev-…", queued: …}`; CHI-OAK flips to ONLINE on the boutique table from the heartbeat (`16-dashboard-after-sale.png`) |

Console errors/warnings over the whole run: 1 (the service-worker scope error above). No `requestfailed`, no page errors.

## Findings

### 1. Every CHI-OAK sale is rejected — demo stock receipts are timestamped ~10 h in the future (site data, not app code)

Server side (`Error Log`, read via `frappe.client.get`):

- Watch + accessory (cash) and the card sale → `Maison submit_batch … [SERIAL_UNAVAILABLE]`:
  `SerialNoExistsInFutureTransactionError: Since the stock reconciliation exists for future dates, cancel it first …
  TP-007-CHI-001 in MAT-STE-2026-00002`.
- Travel Jewellery Case (offline sale) and Cufflinks Onyx and Gold → `[VALIDATION_ERROR]`
  `NegativeStockError: 1.0 units of Item AC-011 / AC-009 needed in Warehouse CHI-OAK - MSN`
  (Bin shows 30 / 15 on hand, but not at the invoice's posting time).

Cause: the three demo Material Receipts (`MAT-STE-2026-0000{1,2,3}`) carry `posting_date=2026-08-22,
posting_time=12:50:1x`, while `System Settings.time_zone` was set to `America/Chicago` at `2026-08-22 02:24:44`
(Version log: `time_zone null → America/Chicago`) — i.e. the stock was seeded **before** the timezone was set
(12:50 in the Frappe Cloud default `Asia/Kolkata` = 07:20 UTC = 02:20 Chicago), and the wall-clock timestamps
were kept. Current site time during the run was 02:3x–02:5x Chicago, so every POS invoice
(`set_posting_time=1`, `posting_datetime` = now converted to site tz in `maison_pos/utils.py:parse_datetime`) is
dated *before* the stock arrived. The app's behaviour is correct and the PWA surfaces the rejection cleanly
(REJECTED pill, server message, queue entry kept).

Fix (site data, needs an Administrator POST with CSRF): cancel the three Stock Entries and re-post them with
`set_posting_time=1` and a posting date/time earlier than any sale (e.g. `2026-08-21 09:00`), or re-run the demo seed
after the timezone is set. I prepared this (`frappe.client.cancel` + `frappe.client.insert` with `docstatus=1`,
CSRF token scraped from `/app/home`) but did **not** execute it: mutating live-site data was blocked by the
permission classifier, and it is outside "run the check". Without it the sales steps cannot pass before
12:50 America/Chicago (17:50 UTC) today, after which they will pass on their own.

Note for `maison_pos/setup/demo.py`: `ensure_stock()` inserts Stock Entries without `set_posting_time`, so the
seed is only safe if the timezone is already final when it runs (the wizard step in the same file sets
`America/New_York`, yet the cloud site ends up on `America/Chicago`, which means the cloud site was set up in a
different order / by hand). Seeding with an explicit back-dated `posting_date` would make it order-independent.

### 2. Service worker never registers on Frappe Cloud (product / deployment gap)

`registerSW()` (`frontend/src/main.ts`) registers `/assets/maison_pos/pos/sw.js` with scope `/pos`. Browsers only
allow that with `Service-Worker-Allowed: /` on the script response. `maison_pos/www/pos.py` documents that
**nginx must add this header** (and `docker/` does), but on Frappe Cloud the asset is served by the platform's
nginx without it (`curl -I …/sw.js` → only `content-type: application/javascript`, `x-content-type-options`), so
registration fails with the scope error above. Result: no offline shell / asset caching on the cloud; the app
still works online and the in-app IndexedDB queue handled the offline sale (step 8). Fix options that don't need
nginx: serve the worker from a `/pos/sw.js` route (e.g. a `www/pos/sw.py` that returns the built file with
`Service-Worker-Allowed`), or register with scope `/assets/maison_pos/pos/` and move the shell under it.

### 3. Minor: rejection message renders raw HTML

The "Server rejected this sale" panel prints the ERPNext message verbatim, including `<br><ul><li>… <a href=…>`
tags (`07-receipt-cash-synced.png`). Either strip tags or render as sanitised HTML.

### 4. Cosmetic: dashboard clock

The dashboard header shows the browser's local time (`07:49:43`, UTC here) while the site/boutiques run on
America/Chicago; not a failure, but worth deciding which clock the head office should see.

## Environment notes

- Admin verification used the provided `sid` cookie only (`frappe.auth.get_logged_user` → `Administrator`); no
  Administrator password was used or needed, and no POST was issued as Administrator.
- `/pos` 301-redirects to `/pos/`, then the PWA routes to `/pos/unlock?next=/sell`.
- Realtime: socket.io upgraded from polling to websocket normally (`2probe`/`3probe`); the site namespace is
  `/maison-demo.frappe.cloud`.

## Run 2 — after the two product fixes were deployed (2026-08-22, 08:24–08:27 UTC = 03:24–03:27 America/Chicago)

Same script and invocation as above (`pos.cloud.e2e.mjs`, `BRIDGE=1`), plus a dedicated offline-reload check in
`/home/claude/maison/e2e/pos.cloud.offline-reload.mjs` (new test script; no app source touched).
Screenshots: `/home/claude/maison/e2e/cloud-shots-2/`. Raw results: `results.cloud-2.json`,
`results.cloud-2.offline-reload.json`; log: `cloud-run-2.log`. Exit code 0 for both scripts.

```bash
cd /home/claude/maison/e2e
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
BASE=https://maison-demo.frappe.cloud ADMIN_SID=$(cat /tmp/sid) SHOTS_DIR=cloud-shots-2 RESULTS=results.cloud-2.json \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pos.cloud.e2e.mjs
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
BASE=https://maison-demo.frappe.cloud SHOTS_DIR=cloud-shots-2 \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pos.cloud.offline-reload.mjs
```

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Associate `POST /api/method/login` | PASS | `as chi.oak.a1@maison.example` |
| 2 | Open `/pos` → `/pos/unlock?next=/sell` | PASS | `cloud-shots-2/01-pos-landing.png` |
| 3 | Unlock CHI-OAK, PIN 2580, catalog loaded | PASS | 42 tiles, Ines Calder · Associate — `02-sell-after-unlock.png` |
| 4 | Add serialized watch + Silk Pocket Square | PASS | serial `TP-007-CHI-001` — `03-basket-watch-accessory.png` |
| 5 | Attach client via search "chen" | PASS | Mei-Lin Chen — `04-client-attached.png` |
| 6 | CASH sale → synced + server invoice verified | PASS | **`ACC-SINV-2026-00001`**, grand_total 204,138.90, docstatus 1, is_pos, Cash payment, serial on row, customer = Mei-Lin Chen — `05-pay-cash.png`, `06-receipt-cash-initial.png`, `07-receipt-cash-synced.png` |
| 7 | CARD sale (simulated reader) → synced + verified | PASS | **`ACC-SINV-2026-00002`**, `maison_terminal_ref=pi_sim_89fd7a598a27599f` — `08-pay-card-ready.png`, `09-pay-card-progress.png`, `10-receipt-card-synced.png` |
| 8 | Offline: cash sale queued | PASS | pill `Queued offline`, topbar `Offline · 1 queued` — `11-pay-cash.png`, `12-offline-queued.png` |
| 9 | Reconnect → queue drained, invoice server-side | PASS | **`ACC-SINV-2026-00003`**, topbar `Online` (0 queued) — `13-online-drained.png` |
| 10 | Dashboard `/maison-dashboard` opens as Administrator (sid cookie) | PASS | `14-dashboard-initial.png` |
| 11 | Google Fonts: Unbounded (POS) | PASS | 800 + 900 `loaded`, used in computed style |
| 12 | Google Fonts: Unbounded (dashboard) | PASS | 800 + 900 `loaded` (selector-sample artefact as in run 1) |
| 13 | Service worker registered on `/pos` | PASS | `getRegistrations()` → exactly one: `scope=https://maison-demo.frappe.cloud/pos/`, `state=activated`, script `https://maison-demo.frappe.cloud/api/method/maison_pos.api.pwa.service_worker` (worker now served from a same-scope route, no `Service-Worker-Allowed` needed). `controller=null` on the first load only (expected: page wasn't yet controlled). Dashboard: no registration (expected) |
| 14 | Dashboard updates live within 5 s after a sale | PASS | **`ACC-SINV-2026-00004`** (Cufflinks Onyx and Gold) seen on the dashboard 3 ms after the receipt synced; `live_summary.totals.invoices` 3→4 — `15-pay-cash.png`, `16-dashboard-after-sale.png` |
| 15 | Dashboard receives realtime (socket.io) events | PASS | `wss://maison-demo.frappe.cloud/socket.io/…`; frames `maison_heartbeat {boutique: CHI-OAK, device_id: dev-41418fe5 …}` and `list_update {doctype: "Sales Invoice", name: "ACC-SINV-2026-00004"}` |
| 16 | SW controls the page after an online reload of `/pos/sell` | PASS | `controller=…/maison_pos.api.pwa.service_worker`; cache `workbox-precache-v2-https://maison-demo.frappe.cloud/pos/` holds 26 entries — `17-online-before-offline-reload.png` |
| 17 | **Offline reload**: context offline → `page.goto('/pos/sell')` | PASS | No navigation error, no Chromium error page. Shell served from the precache: `title=Maison POS`, app routes to `/pos/unlock?next=/sell`, unlock screen with boutique select + `NO NETWORK` badge ("Load the boutique catalog to unlock. Once loaded, unlock works offline.") — `18-offline-reload-sell.png` |

Invoices created in this run (all CHI-OAK, associate chi.oak.a1@maison.example): `ACC-SINV-2026-00001` (cash,
watch TP-007-CHI-001 + pocket square, Mei-Lin Chen), `ACC-SINV-2026-00002` (card, watch), `ACC-SINV-2026-00003`
(cash, Travel Jewellery Case, queued offline then drained), `ACC-SINV-2026-00004` (cash, Cufflinks Onyx and Gold).
Note the numbering restarted at 00001, i.e. the rejected drafts from run 1 were rolled back and the series is fresh.

Console errors/warnings: main run 0 (the run-1 `Service-Worker-Allowed` scope error is gone). Offline-reload
script: 2 `Failed to load resource` (`net::ERR_FAILED` / `net::ERR_INTERNET_DISCONNECTED`) — these are the expected
network fetches while offline (fonts/API), not shell failures.

Status of run-1 findings: Finding 1 (future-dated stock) — fixed, all four sales accepted. Finding 2 (SW scope) —
fixed, registration + offline shell verified. Finding 3 (raw HTML in rejection panel) — not exercised this run (no
rejections). Finding 4 (dashboard clock in browser-local time) — unchanged, cosmetic.

## v0.2 cloud run (2026-08-22, 14:23–14:30 UTC = 09:23–09:30 America/Chicago)

Site: `https://maison-demo.frappe.cloud` (v0.2 build live: Monolith Gold palette, images, scanning, client №, receipt QR).
Scripts: `pos.cloud.e2e.mjs` (v0.1 flow) and the new `/home/claude/maison/e2e/pos.v02.cloud.e2e.mjs` (v0.2 flow, adapted
from `pos.v02.e2e.mjs`). No app source touched. Screenshots: `/home/claude/maison/e2e/cloud-shots-v02/` (v0.2) and
`/home/claude/maison/e2e/cloud-shots-v02/v01/` (v0.1 flow). Raw results: `results.cloud-v02run.v01.json`,
`results.v02.cloud.json`; logs: `cloud-run-v02.v01.log`, `cloud-run-v02.log`. Exit code 0 for both.

```bash
cd /home/claude/maison/e2e
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
BASE=https://maison-demo.frappe.cloud ADMIN_SID=$(cat /tmp/sid) SHOTS_DIR=cloud-shots-v02/v01 RESULTS=results.cloud-v02run.v01.json \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pos.cloud.e2e.mjs
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
BASE=https://maison-demo.frappe.cloud ADMIN_SID=$(cat /tmp/sid) \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pos.v02.cloud.e2e.mjs
```

### What `pos.v02.cloud.e2e.mjs` changes vs. the bench v0.2 script

- Administrator: `ADMIN_SID` cookie via `storageState` (validated with `frappe.auth.get_logged_user`), GETs only
  (`catalog.bootstrap`, `customers.search`).
- Manager image upload: `chi.oak.manager@maison.example` / `maison123` via `POST /api/method/login` in its own request
  context, CSRF token scraped from `window.csrf_token` on `/pos/`, then the multipart POST to
  `maison_pos.api.catalog.upload_item_image` with `X-Frappe-CSRF-Token`.
- New checks: gold palette (computed `body` background on `/pos/sell` + `--ground` token), and `GET /r/<token>`
  rendered in a cookie-less browser context (desktop 1366x1024 and iPhone 390x844) asserting `sid=Guest`/`user_id=Guest`
  response cookies, one `.mg-qr img` that is `complete` with `naturalWidth>0`, and the boutique name.
- `BRIDGE=1` (`cloud-bridge.mjs`) on every browser context; `SHOTS_DIR` default `cloud-shots-v02`, `RESULTS` default
  `results.v02.cloud.json`.
- Two selector updates in the **v0.1** cloud script for the v0.2 frontend (test code only): the serial picker label is now
  `.serial-btn .num-sn` (was `.num`), and the basket client card opens the client view from the `.client-name` button
  (clicking the `.client` container no longer navigates). Both were harness staleness, not product bugs.

### v0.1 flow on the v0.2 site (`pos.cloud.e2e.mjs`) — 15/15 PASS

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Associate login | PASS | `chi.oak.a1@maison.example` |
| 2 | `/pos` → `/pos/unlock?next=/sell` | PASS | `v01/01-pos-landing.png` |
| 3 | Unlock CHI-OAK, PIN 2580, catalog | PASS | 42 tiles, Ines Calder — `v01/02-sell-after-unlock.png` |
| 4 | Serialized watch + Silk Pocket Square | PASS | `TP-006-CHI-002` — `v01/03-basket-watch-accessory.png` |
| 5 | Attach client "chen" | PASS | Mei-Lin Chen — `v01/04-client-attached.png` |
| 6 | CASH sale synced + verified | PASS | **`ACC-SINV-2026-00008`** 10,539.90 — `v01/05…07` |
| 7 | CARD sale synced + verified | PASS | **`ACC-SINV-2026-00009`** `pi_sim_8853ab2b7a8f8571` — `v01/08…10` |
| 8 | Offline cash sale queued | PASS | `Queued offline`, `Offline · 1 queued` — `v01/11…12` |
| 9 | Reconnect → drained + server invoice | PASS | **`ACC-SINV-2026-00010`** — `v01/13-online-drained.png` |
| 10 | Dashboard as Administrator | PASS | `v01/14-dashboard-initial.png` |
| 11–12 | Google Fonts Unbounded (POS / dashboard) | PASS | 800 + 900 loaded |
| 13 | Service worker registered | PASS | scope `/pos/`, `activated`, script `…/maison_pos.api.pwa.service_worker` |
| 14 | Dashboard live update ≤5 s | PASS | **`ACC-SINV-2026-00011`** seen after 8 ms; invoices 10→11 — `v01/15…16` |
| 15 | socket.io realtime frames | PASS | `maison_heartbeat` + `list_update ACC-SINV-2026-00011` |

Console errors/warnings: 0.

### v0.2 flow (`pos.v02.cloud.e2e.mjs`) — 24/24 PASS

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Manager login + CSRF token from `/pos` | PASS | `chi.oak.manager@maison.example`, token present |
| 2 | Manager uploads item image (`upload_item_image`, multipart) | PASS | 200, `AC-012` → `/files/AC-012-f1db14.png` (`image` absolute `https://maison-demo.frappe.cloud/files/…`) |
| 3 | Uploaded image URL served | PASS | 200 `image/png` |
| 4 | `catalog.bootstrap` has settings / barcodes / serials / image | PASS | `scan_enabled=1 receipt_qr_enabled=1 receipt_qr_base_url=https://maison-demo.frappe.cloud loyalty_lookup_enabled=1 show_product_images=0 face_recognition_enabled=0`; EAN `2004103867421→BR-006`; serial `BR-002-CHI-002`; `AC-012.image` = uploaded URL |
| 5 | `customers.search` rows carry `client_number / loyalty_points / points_value / tier` | PASS | William Ashcroft `MC906714`, tier Collector |
| 6 | Associate login | PASS | |
| 7 | **Gold palette live** | PASS | computed `body` background `rgb(11, 11, 10)` = `#0B0B0A`, `--ground: #0b0b0a` (also `rgb(11, 11, 10)` on the guest `/r/` page) |
| 8 | Images toggle shows tile photo | PASS | `src=…/files/AC-012-f1db14.png naturalWidth=64` — `01-sell-images-on.png` |
| 9 | Images toggle off hides photos | PASS | 0 `.tile.img` |
| 10 | Wedge scan EAN adds item | PASS | `2004103867421` → Classic Wedding Band 2mm Platinum |
| 11 | Wedge scan serial adds that exact serial | PASS | `BR-002-CHI-002` (Eternal Solitaire 1.5ct Platinum) — `02-sell-after-scans.png` |
| 12 | Client № keypad lookup attaches client with points | PASS | `MC906714` William Ashcroft · Collector · Points 0 — `03-sell-client-attached.png` |
| 13 | Cash sale → receipt with QR (PNG data URI) + `/r/` link | PASS | Synced, `https://maison-demo.frappe.cloud/r/a5qWqqGWbdb29Wyd` — `04-receipt-qr.png` |
| 14 | `GET /r/<token>` (request ctx, guest) 200 + boutique name | PASS | 200, "Maison Oak Street" |
| 15 | Guest `sales.receipt` JSON: boutique, lines, totals, no PII | PASS | `client={"present":true,"client_number_masked":"MC•••714","tier":"Connoisseur","points_earned":21131,"points_balance":21131}`; no `customer_name`/`client_number` |
| 16 | `GET /r/<bad token>` → 404 | PASS | 404 |
| 17 | **`/r/<token>` renders as guest (desktop) with QR image** | PASS | cookies `sid=Guest user_id=Guest`; `.mg-qr img` SVG data URI 175x175 complete; `ACC-SINV-2026-00014`, PAID, client `MC···714 · Connoisseur` — `05-guest-receipt-desktop.png` |
| 18 | **`/r/<token>` renders as guest (iPhone 390x844)** | PASS | same assertions; QR sits below the first fold in the viewport shot — `06-guest-receipt-phone.png` |
| 19 | iPhone: phone layout + bottom-sheet summary bar | PASS | `07-phone-unlock.png`, `08-phone-sell.png` |
| 20 | iPhone: no horizontal overflow (sell) | PASS | 0 px |
| 21 | iPhone: tile tap → sheet expands with the line | PASS | Silk Pocket Square — `09-phone-item-added.png`, `10-phone-sheet-expanded.png` |
| 22 | iPhone: sheet controls ≥48 px | PASS | all ok |
| 23 | iPhone: cash pay → receipt synced with QR + link | PASS | `https://maison-demo.frappe.cloud/r/Iqks-x_JLNWKR4rH` — `11-phone-pay-cash.png`, `12-phone-receipt.png` |
| 24 | iPhone: receipt screen no horizontal overflow | PASS | 0 px |

Console errors/warnings (non-font): 0.

Invoices created this run (all CHI-OAK, associate chi.oak.a1@maison.example): v0.1 flow `ACC-SINV-2026-00008`
(cash, TP-006-CHI-002 + pocket square, Mei-Lin Chen), `00009` (card), `00010` (cash, queued offline → drained),
`00011` (cash, dashboard-live check); v0.2 flow `ACC-SINV-2026-00014` (cash, 31,696.88, William Ashcroft, token
`a5qWqqGWbdb29Wyd`) and `ACC-SINV-2026-00015` (iPhone cash, 176.40, walk-in, token `Iqks-x_JLNWKR4rH`).
`ACC-SINV-2026-00012`/`00013` (Elena Volkova, walk-in) come from a first pass of the v0.2 script that ended 22/24 only
because my guest-identity probe called `frappe.auth.get_logged_user` (403 for guests); the page itself rendered
correctly — the probe was replaced by the response-cookie assertion and the script re-run clean.

Observations (no product bugs found this run):
- Dashboard clock still browser-local (Finding 4 from run 1) — cosmetic, unchanged.
- The `/r/` page's QR is an SVG data URI (`qr_svg_data_uri`, gold `#C9A96E`), while the in-POS receipt QR is a PNG data
  URI; both render. On a 390x844 viewport the QR is below the first screen — fine for a scroll, but if the intent is
  "QR visible on open" on phones it would need to move up.
- Image upload returns `file_name` `AC-012-00092e.png` but `file_url` `/files/AC-012-f1db14.png` on the second upload
  (the first upload's name): the API appears to de-duplicate by content hash and reuse the existing File — harmless, but the
  two fields are inconsistent in that case.

## v0.3 cloud run (2026-08-22, 16:19–16:26 UTC = 11:19–11:26 America/Chicago)

Site: `https://maison-demo.frappe.cloud` (v0.3 build live: `catalog.bootstrap.settings` carries `face_recognition_*`,
`recognition_model=face-api/faceRecognitionNet@1`, `match_distance_threshold=0.6`, consent text `2026-08-1`).
Script: new `/home/claude/maison/e2e/pos.v03.cloud.e2e.mjs` (adapted from `pos.v03.e2e.mjs`; no app source touched).
Screenshots: `/home/claude/maison/e2e/cloud-shots-v03/` (14). Raw results: `results.v03.cloud.json`; log: `cloud-run-v03.log`.
**Exit code 0 — 38/38 checks passed; the `__maisonRecognitionTest` hook was never needed (0 fallbacks): every verdict
and every enrolment capture came from the real on-device detector in Chromium fed the fake-camera videos.**

```bash
# fresh Administrator sid via press.api.site.login → /tmp/sid; CSRF token scraped from /app/home → /tmp/csrf
cd /home/claude/maison/e2e
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
BASE=https://maison-demo.frappe.cloud ADMIN_SID=$(cat /tmp/sid) ADMIN_CSRF=$(cat /tmp/csrf) \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pos.v03.cloud.e2e.mjs
```

### What `pos.v03.cloud.e2e.mjs` changes vs. the bench v0.3 script

- Administrator via the `sid` cookie (`storageState`, validated with `frappe.auth.get_logged_user`); the two
  `frappe.client.set_value` POSTs on `Maison POS Settings.face_recognition_enabled` (1 before, 0 after) carry the CSRF
  token scraped from `/app/home` (`ADMIN_CSRF`, or scraped by the script when unset).
- Test enrolments are revoked/purged by the **manager** (`chi.oak.manager@maison.example`, `/api/method/login` + CSRF from
  `/pos/`, `maison_pos.api.recognition.revoke`) — once through the UI (Client screen → Delete) and once as the final cleanup.
- `cloud-bridge.mjs` installed on every browser context, including the fake-camera contexts (`--use-fake-device-for-media-stream`,
  `--use-file-for-fake-video-capture=frontend/e2e-assets/face_{a,b}.mjpeg`); the offline step flips the bridge's `isOffline`
  together with `context.setOffline(true)`.
- Three cloud-specific checks: (a) every model weight fetched by the browser from `/assets/maison_pos/pos/models/*` returns
  HTTP 200 (`page.on('response')`, incl. `fromServiceWorker`), (b) the SW precache (`caches` API inside the page) holds all six
  model files, (c) "REAL detector" is asserted on the New-client / Recognised / no-false-match verdicts and on the captures.
- Fonts are not blocked (they load through the bridge); `SHOTS_DIR` default `cloud-shots-v03`, `RESULTS` default
  `results.v03.cloud.json`, `KEEP_ENABLED=1` skips switching recognition off at the end.

### Results — 38/38 PASS

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Recognition enabled on the cloud (Administrator sid + CSRF, `set_value` on the single) | PASS | `face_recognition_enabled=1 global=1 threshold=0.6 model=face-api/faceRecognitionNet@1 consent v2026-08-1`; CHI-OAK = `Inherit` |
| 2 | No pre-existing consented clients | PASS | 0 |
| 3 | `live_summary.recognition` counters present | PASS | all five = 0 before the run |
| 4 | **Model weights served by Frappe Cloud** (request context) | PASS | all six `/assets/maison_pos/pos/models/*` → 200: `tiny_face_detector` 3,219 B + 193,321 B, `face_landmark_68_tiny` 4,806 B + 77,224 B, `face_recognition` 19,615 B + 6,444,032 B |
| 5 | **SW script precache manifest lists models + wasm** | PASS | `maison_pos.api.pwa.service_worker` (27,374 B) contains the 6 model entries and `models/wasm/tfjs-backend-wasm{,-simd,-threaded-simd}.wasm` |
| 6 | Tile reaches Looking (camera + models loaded from the cloud) | PASS | `tile=looking cached=0` — `01-tile-looking.png` |
| 7 | **Browser fetched the weights with HTTP 200** | PASS | 6/6 model files + `wasm/tfjs-backend-wasm-simd.wasm` all `200` from the network on first load |
| 8 | First verdict New client — real detector | PASS | chip "New client", `last.source=none` — `02-tile-new-client.png` |
| 9 | Short press (200 ms) does not agree | PASS | `03-consent-screen.png` |
| 10 | Hold-to-agree 800 ms → capture step | PASS | `04-capture.png` |
| 11 | Enrolment completed, client attached — 3 real captures | PASS | "Nadia Okafor L60YN" — `05-enrolled-attached.png` |
| 12 | Server: Customer by phone | PASS | `MC675179`, consent=1 |
| 13 | Server: Active consent (Hold-to-agree, v2026-08-1, CHI-OAK) | PASS | `MBC-2026-00001` |
| 14 | Server: 3 templates, 128-d raw descriptors, no images | PASS | ‖d‖ = 1.58/1.58/1.58 |
| 15 | Server: Enrolled event | PASS | device `dev-230ff77d` |
| 16 | **Reload → Recognised (real detector, d < 0.6)** | PASS | `d=0.144 score=0.880047 threshold=0.6 source=server` (local d = server d = 0.144) — `06-tile-recognised.png` |
| 17 | Score = 1 − d/1.2 | PASS | 0.880 |
| 18 | Chip "Recognised · 88%" | PASS | |
| 19 | **SW registered + precache holds all model weights** | PASS | one registration, scope `https://maison-demo.frappe.cloud/pos/`, `activated`; `workbox-precache-v2-https://maison-demo.frappe.cloud/pos/` = 39 entries, **6/6 model files cached**; on the reload all model + wasm requests were answered `200` **from the service worker** (`fromServiceWorker=true`) |
| 20–21 | Undo offered ≤5 s, Undo detaches → Walk-in | PASS | `07-after-undo.png` |
| 22 | Server: Matched + Undone events | PASS | matched=1 (score 0.88), undone=1 |
| 23 | **Face B vs A's templates → New client, no false match — real detector** | PASS | `cached=3` templates on the device — `08-faceB-new-client.png` |
| 24 | Decline: client created + attached WITHOUT biometrics | PASS | "Theo Brandt L60YN", consent=0, templates=0, consents=0 — `09-declined-attached.png` |
| 25 | Server: Declined event | PASS | |
| 26 | Manager Client screen: "Face recognition: enrolled Aug 22, 2026 · Consent on file · templates only, no images" + Delete | PASS | `10-client-biometric-status.png`, `11-client-revoke-modal.png` |
| 27 | After revoke: "not enrolled" | PASS | `12-client-revoked.png` |
| 28 | Server: templates purged, consent Revoked by `chi.oak.manager@maison.example`, flags cleared, Revoked event | PASS | |
| 29 | `recognition.templates` no longer lists the client | PASS | rows=0 |
| 30 | Local template cache emptied after revoke | PASS | cached=0 |
| 31 | Offline (bridge + `setOffline`): detector still reports New client | PASS | real detection, `source=none` |
| 32 | Offline enrolment queued (pending=1), provisional client attached | PASS | real captures — `13-offline-enrolment-queued.png` |
| 33 | Server: nothing created while offline | PASS | |
| 34 | Reconnect: queue replayed → Customer + consent `MBC-2026-00002` + 3 templates, basket swapped to the real client | PASS | 3 s — `14-offline-enrolment-replayed.png` |
| 35 | Dashboard `live_summary.recognition` deltas | PASS | `matched 2, enrolled 2, nomatch 2, declined 1, undone 1` |
| 36 | Hook never used | PASS | 0 fallbacks |
| 37 | **Cleanup: manager revoked every remaining enrolment** | PASS | `Offline Client L60YN` revoked; consented clients 0, `recognition.templates` rows 0 |
| 38 | **Recognition switched off again** | PASS | `face_recognition_enabled=0 global=0` (re-verified with curl after the run) |

Backend actually used by the detector in this headless sandbox: WebGL is unavailable (SwiftShader not exposed), so
face-api fell back to the **WASM SIMD** backend (`models/wasm/tfjs-backend-wasm-simd.wasm`), i.e. the cloud run exercised
the WASM path end to end (the WebGL path is not covered by this sandbox).

### Site state after the run (left clean)

- `Maison POS Settings.face_recognition_enabled = 0`, `Maison Boutique CHI-OAK.face_recognition_enabled = Inherit` (untouched).
- Customers with `maison_face_consent=1`: none. `recognition.templates` for CHI-OAK: 0 rows.
- Records that remain, by design of the purge (audit trail, no biometric data): three test Customers `Nadia Okafor L60YN`
  (`MC675179`), `Theo Brandt L60YN` (`theo.l60yn@example.com`, never enrolled), `Offline Client L60YN`; two
  `Maison Biometric Consent` rows `MBC-2026-00001/00002` with `status=Revoked`; Recognition Events (Enrolled/Matched/Undone/
  NoMatch/Declined/Revoked) for today. Nothing else was created (no invoices this run).

### Observations / product notes (no functional bugs found)

1. **`.wasm` served as `application/octet-stream`** (`curl -I …/models/wasm/tfjs-backend-wasm-simd.wasm` →
   `content-type: application/octet-stream`, `x-content-type-options: nosniff`). Chromium logs
   `wasm streaming compile failed: TypeError: … Incorrect response MIME type. Expected 'application/wasm'` → `falling back to
   ArrayBuffer instantiation`. Functionally fine (TF.js falls back automatically), but the streaming compile is lost and the
   warning appears on every cold start. Frappe Cloud's nginx does not know the `.wasm` extension; the app cannot set the header
   for `/assets/…`, so the only in-app fix would be serving the wasm files from a route (as already done for the service
   worker) or accepting the fallback. Same class as run-1 Finding 2.
2. `Initialization of backend webgl failed / WebGL is not supported on this device` warnings: environment (headless sandbox
   without GPU), not the site; on an iPad/desktop the WebGL path is taken first.
3. `Another connection wants to delete database 'maison_pos'` warning: caused by the harness's `freshDevice()` wiping
   IndexedDB while the app holds it open; test artefact.
4. The capture step (`04-capture.png`) shows no camera preview — identical to the bench screenshot, so by design
   ("No photograph is stored"); noting it only because an associate may wonder whether the camera is on.
5. `state.backend` is not exposed by the `__maisonRecognitionTest` hook (the script prints `backend=null`); cosmetic for the
   harness only.

---

## v0.6 CloudChaserz cloud run (2026-08-23, 13:15–13:29 site time)

Site: **`https://cloudchaserz.frappe.cloud`** (bench-46369). Apps live: `frappe`, `erpnext`, `payments`,
`webshop`, `hrms`, `maison_pos` — **Frappe CRM is deliberately absent** and every CRM touchpoint was
re-verified as feature-detected (below). Seed confirmed via `maison_pos.setup.cloudchaserz.status`:
11 stores + `HOU-WH`, 160 items, `CloudChaserz Rewards`, 3,002 history invoices, insights precomputed
(`2026-08-23 13:15`).

Script: new **`/home/claude/maison/e2e/cloudchaserz.cloud.e2e.mjs`** (no app source under `maison_pos/`,
`frontend/` or `dashboard/` was touched by this run). Screenshots: **`/home/claude/maison/e2e/cloud-shots-v06/`**
(29). Raw results: **`results.v06.cloud.json`**, log: **`cloud-run-v06.log`**.

```bash
# fresh Administrator sid → /tmp/ccsid
curl -s -X POST https://cloud.frappe.io/api/method/press.api.site.login \
  -H "Authorization: Token <press-token>" -H 'Content-Type: application/json' \
  -d '{"name":"cloudchaserz.frappe.cloud","reason":"v0.6 verification"}' \
  | python3 -c "import sys,json;open('/tmp/ccsid','w').write(json.load(sys.stdin)['message']['sid'])"

cd /home/claude/maison/e2e
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
BASE=https://cloudchaserz.frappe.cloud ADMIN_SID=$(cat /tmp/ccsid) \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node cloudchaserz.cloud.e2e.mjs
```

**Result: 69 / 71 checks passed, 0 console errors or page errors across 11 browser contexts.**
The two failures are real product defects, not harness problems (D1 and D2 below); every functional
area in the brief passed end to end.

### Results by area

| # | Area | Result | Evidence |
|---|------|--------|----------|
| 0 | Tenant + brand tokens + CRM-absent degradation | **PASS** (3/3) | `brand_name=CloudChaserz`, `wordmark_text=CLOUDCHASERZ`, `sub_mark=Maison POS`, `vertical=Smoke Shop`, `store_noun=Store`; `crm.profile` 200 with `crm.installed=false`, `crm.tasks` 200, `crm.log_interaction` wrote `52md59hvqi` with no `crm` app present |
| 1 | POS: login → PIN unlock → brand → item → cash sale → receipt QR + points → guest `/r/` | **PASS** (10/11) | `hou.mtr.a1@` / PIN 2580 at HOU-MTR; top bar `CLOUDCHASERZ · Maison POS · HOU-MTR`, store name `CloudChaserz Montrose` (≥1400 px); cash sale **`ACC-SINV-2026-03040`** $14.06 → `Synced`; receipt QR is a PNG data-URI + link `/r/scfXDvoACBH_qNj6`; rewards block `CLOUDCHASERZ REWARDS · POINTS EARNED 12 · BALANCE 24 · NEXT REWARD $5.00 at 100 pts (76 to go)`; guest `GET /r/<token>` **200**, `GET /r/<bad>` **404**; iPhone 390×844 no horizontal overflow. **1 fail — D2** (`01-…`, `02-…`, `03-…`, `04-…`, `05-…`) |
| 2 | Age gate (21+) | **PASS** (9/9) | API: under-21 → `Underage` "Under 21 — sale of age-restricted items refused"; expired → `Expired`; valid → `Verified` age 34, `Maison Age Check 63c0lfsksv` storing only `initials=AR, issuer=TX, age_years=34` (no name/address/licence no.). UI: tapping `DSP-002` raised the gate **before** the basket; under-21 DOB and expired ID both refused with 0 basket lines; a **valid AAMVA PDF417 payload through the Scan-ID tab** passed and the item rang up; sale **`ACC-SINV-2026-03041`** carries `maison_age_verified=1`, `maison_age_check=a3fqgrkghd` (`06-…`, `07-…`, `08-…`, `09-…`) |
| 3 | Rewards $5/100 redeem + return reversal | **PASS** (8/8) | Tiers `100→$5, 200→$10, 300→$15`; member `CC Rewards IIP0Y` (`MC610760`) earned **129 pts on $129.90 net** (not the $140.62 taxed total) via `ACC-SINV-2026-03042`; the POS tier picker offered only the affordable tier; picking it took the basket **$56.25 → $51.25**; invoice **`ACC-SINV-2026-03043`** `loyalty_amount=5, loyalty_points=100, maison_reward_tier=RT-100-00001`; balance 129 → 75; credit note **`ACC-SINV-2026-03044`** put it back to 124 (never negative) (`10-…`, `11-…`) |
| 4 | Store scoping over HTTP | **PASS** (5/5) | `hou.mtr.manager@` → **403 `PermissionError: You are not permitted to act on boutique OK-SAP`** on `catalog.bootstrap`, `inventory.alerts`, `inventory.inbound`, `inventory.replenishment_requests`, `shipping.shipments`, `shipping.requests_list`; mirror holds for `ok.sap.manager@` → HOU-MTR; own store still 200; `dashboard.live_summary` returns `by_boutique=[HOU-MTR]` only; unscoped `shipments` / `alerts` narrow to the caller. **See D3 for a leak outside the `maison_pos` API surface** |
| 5 | Warehouse replenishment loop | **PASS** (14/14) | `ok.sap.manager@` requested `DEV-006 ×6` from the **POS Receive** screen → **`MRR-2026-00011`** (Pending Approval, `MAT-MR-2026-00004`, HOU-WH → OK-SAP); `warehouse@` approved on `/warehouse` with the qty edited to 4 → **`MSH-2026-00012`**; the 1920×1080 wall showed the card over realtime (`OK-SAP · CloudChaserz Sapulpa · 1 ITEMS 4 UNITS · PENDING`) and `window.__maisonLastWallPrint` fired `{kind: "packing_list", shipment: MSH-2026-00012}`; the wall transport went `POLLING` → **`LIVE`**; 8 simulated rates **cheapest-first** (USPS Ground Advantage $15.71 → UPS Next Day Air Saver $95.11) with the cheapest pre-selected; label bought (`9400016071039279356086`); ship posted HQ 55→51 / In Transit 0→4; the store manager **received it by scanning EAN `2003553313403` four times** on Receive (`MAT-STE-2026-00045`); final balances HQ 51, In Transit 0, OK-SAP 3→7 (`12-…` … `19-…`) |
| 6 | Dashboard `/maison-dashboard` as `hq@` | **PASS on data (4/5), FAIL on brand — D1** | Live tab renders a store card for **all 11 stores** (plus HOU-WH, see D4) with real numbers (`01 HOU-MTR CloudChaserz Montrose 866 +1052% 24 · RETURN CocoUrth Coconut Coals · −56 · 28 s ago · ONLINE`); a new POS sale moved the HOU-MTR card **893 ms** after the POS response (`ACC-SINV-2026-03045`); Products → Trending 60 rows from the precomputed table in 99 ms with real CloudChaserz SKUs; Products → Top by store 12 store columns + 132 matrix cells (`20-…` … `23-…`) |
| 7 | `/shop`, `/rewards`, `/salon` | **PASS** (7/7) | `/shop` fully CloudChaserz (hero "Order online. Pick up in store today.", 11 category tiles, "Where to find us" with all 11 addresses); `/rewards` carries the exact copy — **"Earn 1 point for every $1 you spend"**, **"$5 off at 100 points"**, **"$10 off at 200 points"**, **"$15 off at 300 points"** — plus all four member perks, the live giveaway and the join form; the only "Maison" string on either page is the intentional `Maison POS` sub-mark. `/salon` paired from code `152972` (session `eb1217c7…`), mirrored the walk-in basket on the identify screen ("Meanwhile, your associate has set aside CocoUrth Coconut Coals 72 pc (flats)") and then matched the POS exactly: **salon $28.12 = POS $28.12** (`24-…` … `29-…`) |

### Screenshots reviewed (`e2e/cloud-shots-v06/`)

`01-pos-unlock-1366` · `02-pos-cloudchaserz-1366` · `03-pos-receipt-qr` · `04-public-receipt-390` ·
`05-pos-cloudchaserz-iphone-390` · `06-pos-age-gate` · `07-pos-age-blocked-under21` · `08-pos-age-passed` ·
`09-pos-age-receipt` · `10-pos-reward-picker` · `11-pos-reward-applied` · `12-pos-receive-screen` ·
`13-pos-receive-request-modal` · `14-warehouse-desk` · `15-warehouse-approve` · `16-warehouse-wall-1920` ·
`17-warehouse-wall-shipped-1920` · `18-pos-receive-count-sheet` · `19-pos-receive-confirmed` ·
`20-dashboard-live-1920` · `21-dashboard-live-after-sale-1920` · `22-dashboard-products-trending-1920` ·
`23-dashboard-products-top-1920` · `24-shop-1440` · `25-rewards-1440` · `26-salon-pair-1024` ·
`27-salon-ambient-1024` · `28-salon-identify-1024` · `29-salon-basket-mirror-1024`

All 29 were opened and read. The POS, receipt, age gate, reward picker, Receive, warehouse desk, wall,
shop, rewards and salon screens are all correctly CloudChaserz-branded and typographically clean.

### Defects found

**D1 — the Command dashboard is still branded "Maison" (v0.6 N regression, most visible defect).**
`/maison-dashboard` renders the wordmark **`Maison`**, the scope line **`Today · All Boutiques`** and a
**`BOUTIQUES`** nav tab / **`All boutiques`** filter, on a tenant whose `store_noun` is `Store`. The brand
payload is already on the page — the Jinja shell injects
`window.maison_brand = {"wordmark_text": "CLOUDCHASERZ", "store_noun": "Store", …}`
(`maison_pos/www/maison-dashboard.html:12`) and the tab title is correctly `CLOUDCHASERZ · Command` — but the
Vue SPA never reads it: `dashboard/src/components/TopBar.vue:18-20` hard-codes `<span class="display
wordmark">Maison</span>` and `Today · All Boutiques`, and "boutique" appears 164 times across
`dashboard/src/**/*.vue`. Every other surface (POS, unlock, receipt, warehouse desk, 55" wall, `/shop`,
`/rewards`, `/salon`) took the brand tokens correctly. Fix: read `window.maison_brand` in the dashboard
TopBar (wordmark + `store_noun` for the scope line and the Boutiques tab/column headings). Evidence:
`20-dashboard-live-1920.png`, `22-…`, `23-…`.

**D2 — the unlock screen overflows the 1366×1024 POS viewport by 147 px.**
`UnlockView.vue` uses `grid-template-columns: 1fr 480px`; a grid `1fr` track has `min-width: auto`, so the
left column cannot shrink below the min-content width of `.brand .wordmark` (`font-size: 64px;
letter-spacing: 0.3em`). "CLOUDCHASERZ" is 12 glyphs — measured min-content **1033 px** — so the 480 px
panel column ends at **x = 1513 px** and `document.documentElement.scrollWidth − clientWidth = 147`. The
store picker, Load button and PIN keypad are clipped off the right edge and the page scrolls sideways; the
screen needs ≥ 1513 px to fit. Not a problem for "MAISON" (6 glyphs ≈ 560 px), i.e. this is triggered by the
longer v0.6 wordmark. Minimal fix: `grid-template-columns: minmax(0, 1fr) 480px` (plus a `clamp()` on the
wordmark size for narrower tills). Evidence: `01-pos-unlock-1366.png`.

**D3 — cross-store leakage outside the `maison_pos` API: 10 other-store credit notes are listable by a
store manager.** Every `maison_pos.api.*` endpoint is correctly 403 (area 4), but the generic Frappe REST
list is not scoped: as `hou.mtr.manager@`, `frappe.client.get_list` on `Sales Invoice` filtered
`maison_boutique != HOU-MTR` returns **10 rows** from OK-BA, OK-BIX, OK-ETUL, OK-JENKS, OK-MINGO (×2),
OK-MUS, OK-OWA, OK-SAP, OK-STUL, OK-YALE. All ten are `is_return=1`: store scoping for `Sales Invoice`
relies solely on the per-user **Warehouse** User Permission (`users.py::ensure_user_permission`), and return
credit notes carry no `set_warehouse`, so the permission never matches them. `hooks.py`
`permission_query_conditions` covers 20 doctypes but not `Sales Invoice`. Only invoice headers leak (name,
store, totals) — no line items or client data were reachable — but it is a genuine boundary hole. Fix:
either set `set_warehouse` on POS credit notes or add a `Sales Invoice` entry to
`permission_query_conditions` alongside the existing `maison_pos.scoping.*` helpers.

**D4 — the `HOU-WH` warehouse is shown as a 12th "store" on the dashboard.**
`maison_pos/api/dashboard.py::_live_summary` (and `boutiques_table`, Products → Top by store) call
`get_allowed_boutiques()` without excluding `is_warehouse` / `boutique_type = "Warehouse"` — which
`maison_pos/api/rewards.py:583` *does* do. HOU-WH therefore appears on the Live board permanently at
`$0 · 0 tickets · NO SALE YET · OFFLINE`, and as a `0 NET / NO SALES IN PERIOD` column on Top by store.
Cosmetic, but it reads as a dead store to head office. Evidence: `20-…`, `23-…`.

**D5 — the "Walk-in Customer" placeholder is itself a rewards member with 61,045 points.**
`Customer "Walk-in Customer"` — the default customer on **all 12 POS Profiles** — carries
`loyalty_program = CloudChaserz Rewards`, client number `MC990463` and **61,045 points (≈ $3,052
redeemable)**, accrued from the 3,002 seeded history invoices, because the seeded Loyalty Program has
`auto_opt_in = 1` (`maison_pos/setup/cloudchaserz/rewards.py:53`) and ERPNext enrols any customer on its
first invoice. `maison_pos/api/rewards.py::_is_walk_in` guards *giveaway* entries but not accrual or
redemption. Counter effect: an anonymous basket renders **`WALK-IN CUSTOMER · MEMBER · 60,946 POINTS ·
3 rewards available`** with a live Redeem switch, the walk-in heads the default POS client list, and the
placeholder prints on anonymous receipts as `Walk-in Customer / Member · MC990463`. Left untouched (it is
seeded state, and the loyalty ledger is consistent); the demo fix is two fields — clear
`Walk-in Customer.loyalty_program` and `.maison_client_number` — and the product fix is to apply
`_is_walk_in` in `rebase_points_on_net` / `apply_to_invoice`.

### Smaller observations

1. **Site time zone is unset.** `System Settings.time_zone` is `null`, so the site falls back to Frappe
   Cloud's `Asia/Kolkata` (UTC+5:30) for an 11-store Texas/Oklahoma chain: the site clock read `13:27`
   while Houston was `02:57`. Every server-side day boundary and hour bucket (dashboard "today",
   `by_hour` peak `13:00`, `posting_time`) is therefore Indian time. Not changed here — re-timezoning a
   site *after* the stock and 3-month history were seeded is exactly what broke run 1 on
   `maison-demo.frappe.cloud` (Finding 1 above); it should be set before the next reseed.
2. **Today has no seeded sales — only returns.** The seeded history ends `2026-08-22`; today's slice is
   17 return credit notes and 0 sales, so a demo opened before anyone rings a sale shows the Live board
   with 11 negative/offline stores (`−79, −71, −65, …`). Ringing one sale fixes it (this run's card went
   to `866 · +1052% · 24 tickets`), but the seed should post a partial day of sales for "today".
3. **The unlock screen prints the sub-mark twice**: `MAISON POS · MAISON POS BY CLOUDCHASERZ`.
   `UnlockView.vue:127` renders `{{ brand.subMark }} · {{ brand.productName }}` and `product_name`
   already contains the sub-mark.
4. **Browser-local clocks.** The Salon and the dashboard both render `new Date()` in the *browser's*
   locale/zone (`7:58 AM` against a site clock of `13:27`), and the Salon's "Good morning / evening"
   greeting is derived from it. Same class as the v0.1 dashboard-clock observation; it matters more now
   that the Salon greets clients by time of day.
5. **Jewellery vocabulary survives in the Salon**: "ASK ABOUT THIS PIECE", "NOT NOW — SHOW MY PIECES",
   "YOUR SELECTION" on a smoke-shop tenant. The brand system carries `store_noun` but no item noun.
6. **The under-21 refusal is surfaced twice** — as the modal ("SALE REFUSED") and simultaneously as a
   sync-style notice in the corner carrying a **QUEUE** action button, which is not meaningful for an age
   refusal (`07-pos-age-blocked-under21.png`).
7. **The compact top bar (≤ 1400 px) hides the store name** by design (`TopBar.vue:37`), so at the brief's
   1366×1024 the bar shows `HOU-MTR` only; the full `CloudChaserz Montrose` renders from 1401 px up —
   verified by resizing mid-run.
8. The 55" wall reports `POLLING` at first paint and upgrades to `LIVE` a few seconds later; the approved
   card and the auto-print both arrived over the live transport.
9. `Maison POS Settings.consent_text` (face recognition, currently disabled) still reads "I agree that
   **Maison** may create and store a mathematical template…" — it is not brand-tokenised.

### Site state left behind (clean, demo-ready)

- **Created by this run and left in place** (real, consistent records): sales `ACC-SINV-2026-03040`
  (cash + rewards receipt), `ACC-SINV-2026-03041` (21+ verified), `ACC-SINV-2026-03042` (rewards earn),
  `ACC-SINV-2026-03043` (reward redeemed), `ACC-SINV-2026-03045` (dashboard-live sale), credit note
  `ACC-SINV-2026-03044`; replenishment `MRR-2026-00011` → shipment `MSH-2026-00012` (**Received**, so
  nothing is stuck in transit and there was no test shipment left to cancel); age checks and the
  `MAT-STE-2026-00045` receipt transfer.
- **Reverted**: the two stock top-ups the harness makes so repeated runs do not exhaust the shelf were
  returned with Material Issues `MAT-STE-2026-00046/00047` — `HKA-012 @ HOU-MTR` back to **23** and
  `DSP-002 @ HOU-MTR` back to **42**, i.e. the seeded quantities.
- **Hidden**: the five `CC Rewards …` test members created across the verification runs were set
  `disabled = 1`, so they no longer head the POS client list (their invoices and points are untouched).
- **Verified empty at the end**: no open shipments, no open replenishment requests, no paired Salon
  sessions, no basket left on any till, warehouse desk and wall idle.
- **Not touched**: all seeded stores, users, PINs, the 160-item catalogue, the 3,002 history invoices,
  precomputed insights, the Walk-in Customer's loyalty state (D5) and the site time zone (observation 1).
