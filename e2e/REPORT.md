# Maison POS — end-to-end verification against the real bench

Date: 2026-08-22. Bench `http://localhost:8000`, site `maison.localhost` (Frappe/ERPNext v15),
Playwright 1.56 / Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), POS viewport 1366x1024,
dashboard viewport 1920x1080. No mock mode — every call hits `maison_pos.api.*` on the bench.

Re-run:

```bash
cd /home/claude/maison/e2e
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pos.e2e.mjs      # exit 0 = all steps passed
# node_modules/playwright -> global install symlink; results.json + shots/*.png are rewritten
```

Login used: **`chi.oak.a1@maison.example` / `maison123` (Ines Calder, Maison Associate, CHI-OAK), PIN `2580`**
(from `maison_pos/setup/demo.py`). The associate login worked; Administrator was only used for the
API verification calls and for the dashboard.

## Final run — all 11 steps pass

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | `POST /api/method/login` as associate, open `/pos` | PASS | `shots/01-pos-landing.png` — Unlock screen, boutique list from `session.me` |
| 2 | Unlock with PIN 2580 → Sell shows real catalog | PASS | 42 tiles, rail `Accessories / Bridal / High Jewellery / Services / Timepieces`, `02-sell-after-unlock.png` |
| 2 | Add serialized watch (serial picker) + Silk Pocket Square | PASS | `03-basket-watch-accessory.png` (serial shown on the basket line) |
| 2 | Attach client via search "chen" | PASS | Mei-Lin Chen (Connoisseur, points shown), `04-client-attached.png` |
| 2 | CASH, tendered via keypad → receipt → **Synced** | PASS | `05-pay-cash.png`, `06-receipt-cash-initial.png` (Queued), `07-receipt-cash-synced.png` (`ACC-SINV-…`) |
| 2 | Server check via `frappe.client.get_list` + `get` | PASS | `docstatus=1`, `is_pos=1`, `customer` = Mei-Lin Chen's Customer, `maison_boutique=CHI-OAK`, serial on the item row, payment row `Cash` = grand_total |
| 3 | CARD with the in-app simulated reader (discover → connect → collect → process) | PASS | `08-pay-card-ready.png`, `09-pay-card-progress.png`, `10-receipt-card-synced.png`; invoice has payment `Card` and `maison_terminal_ref = pi_sim_…` |
| 4 | `context.setOffline(true)` → cash sale | PASS | Topbar `OFFLINE · 1 QUEUED`, receipt pill `QUEUED OFFLINE`, `12-offline-queued.png` |
| 4 | `setOffline(false)` → queue drains | PASS | Receipt flips to `SYNCED` with invoice name, topbar `ONLINE` with no queued count, invoice exists server-side, `13-online-drained.png` |
| 5 | `/maison-dashboard` as Administrator @1920x1080 | PASS | `14-dashboard-initial.png` — KPIs populated from `dashboard.live_summary` |
| 5 | Sale in the POS tab → dashboard updates via socket.io | PASS | New invoice in the live feed + KPI/boutique row update **within a few ms** of the POS receipt showing Synced (`maison_sale` over `ws://maison.localhost:9000/socket.io`), `16-dashboard-after-sale.png` |

`results.json` holds the machine-readable step list and the captured console output; `run.log` the last run.

## Browser console (final run)

| Page | Message | Verdict |
|------|---------|---------|
| pos, dashboard | `GET https://fonts.googleapis.com/css2?… net::ERR_CONNECTION_RESET` + `Failed to load resource` | Environment only: no outbound internet in this container. Fonts fall back to the stack. |
| pos | `The path of the provided scope ('/pos') is not under the max scope allowed ('/assets/maison_pos/pos/')…` | Expected under `bench serve` (no nginx). README documents the `Service-Worker-Allowed: /` header for `/assets/maison_pos/pos/sw.js`; `docker/` nginx adds it. The app works without the SW. |

No other errors, warnings, page errors or failed requests. Before the fixes there were also a
`417 EXPECTATION FAILED` (non-existent API method) and five `DataCloneError` page errors — both gone (bugs 1 and 8).

## Bugs found and fixed

All fixes are in `/home/claude/maison` (app is symlinked into the bench so backend edits are live;
frontend rebuilt with `npm run build` into `maison_pos/public/pos`, dashboard into `maison_pos/public/dashboard`;
`sites/assets/maison_pos` already symlinks to `maison_pos/public`, no `bench build` needed).

| # | Symptom seen in the browser | Root cause | Fix |
|---|-----------------------------|------------|-----|
| 1 | Unlock screen: empty boutique dropdown, console `417` | PWA called `maison_pos.api.catalog.boutiques`, which does not exist (the list lives in `session.me().boutiques`) | `frontend/src/api/frappe.ts`: `boutiques()` calls `session.me` and maps `boutiques` |
| 2 | Associate dropdown empty, `"undefined" is not valid JSON`, PIN never accepted | Contract mismatch: the PWA expected `bootstrap.associates[]` with SHA-256 `pin_hash` (mock design); the backend returns no associates and verifies PINs server-side with PBKDF2 + lockout (`maison_associate.verify_pin`) and deliberately never ships hashes | Backend `api/catalog.py`: `bootstrap` returns `associates` (no hashes). Frontend `stores/session.ts`: online unlock calls `verify_pin` (new `api.verifyPin` in `frappe.ts` / `mock.ts` / `types.ts`) and caches a device-local SHA-256 digest of the accepted PIN so the documented offline unlock still works; offline compares against that cache. |
| 3 | Any sale with a serial number: receipt `REJECTED — PermissionError` (`No permission for Serial and Batch Bundle`) | ERPNext v15 creates a *Serial and Batch Bundle* on submit with permission checks; `Sales User` (Maison Associate) cannot create it | `setup/install.py` `ROLE_DOCPERMS`: Custom DocPerms on *Serial and Batch Bundle* for Maison Associate / Manager / Head Office (applied with `create_role_permissions`, also runs on migrate) |
| 4 | Category rail rendered JSON blobs and listed every ERPNext group (Consumable, Raw Material…) | `_item_groups()` returned dicts; contract is `item_groups: string[]` | `api/catalog.py`: returns leaf group names that hold sales items |
| 5 | Services (Engraving, Appraisal…) greyed out as `OUT OF STOCK` | Non-stock items have no Bin, PWA only looked at qty | Backend ships `is_stock_item`; `ItemTile.vue` treats `is_stock_item = 0` as always sellable (`SERVICE` label) |
| 6 | Department chips overlapped each other | flex children shrank inside the scroll strip | `SellView.vue`: `.chips > .chip { flex: 0 0 auto }` |
| 7 | Dashboard never updated on a sale | (a) backend published to `room="maison_dashboard"`, a room Frappe's socket.io server never lets clients join (only site/user/doctype/doc/task rooms); (b) www pages ship `frappe.realtime` but never `init()` it, so `fr.on(...)` was a silent no-op; (c) own-socket fallback used namespace `/` and port 8000, both rejected by Frappe's socketio | `maison_pos/utils.py`: `DASHBOARD_ROOM = "doctype:Sales Invoice"` (also used by `maison_price_change_request.py`). `dashboard/src/realtime.ts`: init `frappe.realtime` when needed, `doctype_subscribe('Sales Invoice')`, real connect/disconnect status; fallback builds host/port/namespace the way `socketio_client.js` does |
| 8 | Once events arrived: feed showed `NAN`, `[object Object]`, `GUEST`, `SPLIT`; KPIs went NaN. Also five `DataCloneError`s in the POS | Realtime payload (`invoice_summary`: `grand_total`, `items` as objects, `customer_name`) did not match the dashboard `SaleEvent` (`net`, `items: string[]`, `tier`); heartbeat uses `last_seen` not `ts`. The DataCloneErrors came from Vue reactive proxies (the group dicts) written to IndexedDB on every `catalog.persist()` | `dashboard/src/stores/dashboard.ts`: `normalizeSale` / `normalizeHeartbeat` adapters (negate cancellations, dedupe); `LiveFeed.vue` shows customer name when no tier. `frontend/src/stores/catalog.ts`: JSON-clone `item_groups`/`departments` before Dexie |
| 9 | Sales posted 4 h in the future (`posting_time` 05:35 while site time was 01:35), wrong hour bucket | `utils.parse_datetime` stripped the `Z` from `Date.toISOString()` and treated UTC as site-local | `parse_datetime` converts tz-aware strings to the system timezone |
| 10 | Boutique `OFFLINE` (and `· 1 QUEUED`) although the POS was heart-beating; `Last sale —` | (a) `frappe.get_all` silently drops any field/filter containing `_seen` (treated as the optional `_seen` column) → `last_seen` never returned; the same bug made `tasks.check_heartbeat_staleness` drop its `last_seen < cutoff` filter (would mark **every** online device offline); (b) naive site-local timestamps were parsed by the browser as browser-local; (c) stale devices' `queued` summed forever; (d) `by_boutique` had no `last_sale` | `api/dashboard.py` + `tasks.py`: query builder instead of `get_all`; new `utils.iso_with_tz()` used for `last_seen`, `last_sale`, `ts`, `posting_datetime` in API + realtime payloads; only live devices contribute to `queued`; `last_sale` = max `posting_time` |

### Checked and left as-is

- The hourly chart only draws 09:00–21:00, so sales made at 01:xx site time (this container's clock) show no bar — a display window choice, not a data bug.
- Serialized stock is finite: the script picks the first *in-stock* serialized Timepiece instead of a fixed SKU (TP-001 sold out during earlier runs). The idempotent seed does not recreate sold serials.

## Test suites after the changes

- `cd frontend && npm test` → 4 files, **31 passed**; `npm run lint` clean; `npm run build` (vue-tsc) clean.
- `cd dashboard && npm test` → **12 passed**; build clean.
- `bench --site maison.localhost run-tests --app maison_pos` → **Ran 27 tests — OK** (run after the perms and timestamp changes).

## Files

- Script: `/home/claude/maison/e2e/pos.e2e.mjs` (Playwright, plain Node ESM; `e2e/node_modules/playwright` symlinks the global install)
- Output: `/home/claude/maison/e2e/results.json`, `/home/claude/maison/e2e/run.log`, `/home/claude/maison/e2e/shots/01…16-*.png`
- Changed frontend: `frontend/src/api/{frappe,mock,types}.ts`, `frontend/src/stores/{session,catalog}.ts`, `frontend/src/components/ItemTile.vue`, `frontend/src/views/SellView.vue`
- Changed dashboard: `dashboard/src/realtime.ts`, `dashboard/src/stores/dashboard.ts`, `dashboard/src/components/LiveFeed.vue`, `dashboard/src/env.d.ts`
- Changed backend: `maison_pos/api/{catalog,dashboard}.py`, `maison_pos/utils.py`, `maison_pos/tasks.py`, `maison_pos/setup/install.py`, `maison_pos/maison_pos/doctype/maison_device_heartbeat/maison_device_heartbeat.py`, `maison_pos/maison_pos/doctype/maison_price_change_request/maison_price_change_request.py`
