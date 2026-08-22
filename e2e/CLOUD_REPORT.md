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
