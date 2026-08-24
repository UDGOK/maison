# QA — warehouse, shipping, receiving, inventory

**Target** `https://cloudchaserz.frappe.cloud` (live, shared) · **Store under test** `OK-JENKS` — CloudChaserz Jenks
(`ok.jenks.manager@cloudchaserz.example`, PIN 1313; `ok.jenks.a1@…`) · **Second store** `OK-YALE` (cross-store refusals only)
· **Warehouse admin** `warehouse@cloudchaserz.example` (Walter Hines) · **Main warehouse** `HOU-WH - CCZ`
· **Provider** `simulated` (test mode) · **Site TZ** America/Chicago · **Date** 2026-08-23, 15:14–15:50 UTC (10:14–10:50 CDT).

Everything created carries the prefix **`QA2`** in its reason / remark. All balances were restored — see
[Cleanup](#cleanup) (verified: 17 Stock Entries + 1 Purchase Receipt net to **zero in every warehouse**).

**Result: 270 checks — 247 passed as written, 13 failed as written (8 of those were my own assertion
errors, re-verified correct; **5 are real**), 10 recorded as informational observations.**
**6 defects**, 1 High, 2 Medium, 3 Low.

Screenshots: `e2e/qa/shots-warehouse/` (referenced by number). Raw results: `e2e/qa/results-w*.json`, `results-c*.json`.
Scripts (test-only; **no application source was modified**): `e2e/qa/lib-wh.mjs`, `t1…t11*.mjs`, `c1…c5*.mjs`.

```bash
cd /home/claude/maison/e2e/qa
BRIDGE=1 NODE_USE_ENV_PROXY=1 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node t6-wall.mjs   # etc.
```

---

## Defects, worst first

### D1 — HIGH · a request raised by one tap on a low-stock alert can never be rejected

The documented happy path is: *Shift → low-stock line → "Request from warehouse"*. `inventory.replenish` links the
alert to the draft Material Request (`Maison Stock Alert.material_request`). When the warehouse admin then presses
**Reject…**, `shipping.reject` deletes that draft MR **before** it clears the alert's link, so ERPNext's link check
fires and the whole call rolls back.

```
POST shipping.reject {request: MRR-2026-00043, reason: "…"}
→ 417 frappe.exceptions.LinkExistsError: Cannot delete or cancel because Material Request
  MAT-MR-2026-00017 is linked with Maison Stock Alert MSA-2026-00017
```

The request stays `Pending Approval` with its MR intact, sits on the wall forever and its age timer goes amber
(4 h) then red (24 h). There is no way out from the POS or the warehouse desk — I could only reject it after
clearing `Maison Stock Alert.material_request` by hand, which proves the cause (`results-c3.json`).

**Location** `maison_pos/api/shipping.py:428-437` — `mr.delete()` (line 433) runs before the
`for line in req.lines: … set_value(stock_alert, "material_request", None)` loop (lines 434-436).
**Fix** clear the alert links (and commit) *before* deleting the Material Request, or cancel/keep the MR instead of
deleting it. Note `approve()` has no such problem because it never deletes the MR.

### D2 — MEDIUM · the warehouse desk's "Waiting" column is wrong by the site's UTC offset

`WarehouseDesk.vue:207` computes a request's age as `now - new Date(x.requested_at)`. `requested_at` arrives as a
**zone-less** site-local ISO string (`request_dict` → `_iso()`), so JavaScript parses it in the *browser's* zone.
Any browser not set to America/Chicago is off by the offset.

| | value |
|---|---|
| request | `MRR-2026-00050`, `requested_at = 2026-08-23 15:39:26` (site, CDT) |
| server age (`shipping.wall`) | **254 s (~4 m)** |
| desk "Waiting" cell | **"5h 04m"**, cell class `num warn` (amber) |
| browser TZ | `UTC` |

Every brand-new request is therefore rendered amber immediately (warn = 4 h), and at 24 h everything is red — the
column is useless off-zone. The Shipments tab is *not* affected (`WarehouseDesk.vue:248` uses the server's
`age_seconds` via `liveAge`), nor is the 55" wall — which makes the two screens disagree about the same document.
The app already knows the site zone (`shipping.me.time_zone`, used for the wall clock, v0.6 R).
Evidence `021-desk-requests-tab.png`, `results-w11.json`.
**Fix** use the server's `age_seconds` for requests too (as the wall and the Shipments tab do), or parse
`requested_at` through the site zone.

### D3 — MEDIUM · the daily low-stock digest fails outright, and one bad recipient kills the whole run

`inventory.low_stock_digest` (Daily scheduler job) is enabled and works when there is nothing to send. With a real
open alert it aborts:

```
Scheduled Job Log 33386en1lp — Failed
  File "apps/maison_pos/maison_pos/api/inventory.py", line 203, in low_stock_digest
    _send_digest(ho, rows, _("Maison low stock digest — {0} open alert(s)").format(len(rows)))
  frappe.exceptions.OutgoingEmailError: Please setup default outgoing Email Account from Tools > Email Account
```

Two things: (a) **site config** — no `Email Account` on this deployment has `enable_outgoing = 1`, so the digest
has never been delivered; (b) **product robustness** — `low_stock_digest` calls `_send_digest` unguarded, so the
head-office send failing means no store manager gets theirs either and the job is recorded Failed. Compare
`_notify_new_alerts`, which wraps each insert in `try/except`. 0 Email Queue rows were produced.
**Location** `maison_pos/api/inventory.py:188-212`. **Fix** wrap each `_send_digest` in `try/except` +
`frappe.log_error`, and short-circuit when no outgoing account exists.

### D4 — LOW · `shipping.buy` can be called repeatedly and silently orphans the previous label

There is no "already bought" guard: `buy` only refuses when the shipment is Shipped / Received / Cancelled. Calling
it again on a Packed shipment overwrites `carrier`, `service`, `rate_amount`, `label_url` and `tracking_no`.

```
buy(MSH-2026-00021, rate_id=UPS 2nd Day Air)  → tracking 1Z840D324033235145
buy(MSH-2026-00021, rate_id=USPS Ground Adv.) → tracking 9400642013041446230174   ← accepted, first label lost
```

Harmless on the simulated provider; on Shippo/EasyPost the first label has been **purchased and billed** and its
tracking number is now unrecoverable from the app — and `docs/shipping.md` states the only remedy is a manual
refund in the carrier dashboard. The wall's "Buy label" tap action makes a double-press plausible.
**Location** `maison_pos/api/shipping.py:597-645`. **Fix** refuse when `doc.label_url` is set unless an explicit
`replace=1` is passed (and record the voided label).

### D5 — LOW · the cycle-count reconciliation is attributed to Administrator, not to the counter

`submit_cycle_count` deliberately sets `sr.owner = user` before inserting the draft Stock Reconciliation
(`maison_pos/api/inventory.py:446`), but the insert runs as Administrator and Frappe overwrites `owner` with
`frappe.session.user` for new documents — so the draft a manager is asked to approve shows
`owner = Administrator`.

```
MAT-RECO-2026-00001  docstatus=0  set_warehouse=OK-JENKS - CCZ  owner=Administrator
(counted by ok.jenks.manager@cloudchaserz.example)
```

Mitigated by `Maison Cycle Count` itself recording `associate` and `owner` correctly, so the audit trail is not
lost — only the reconciliation's own provenance is. **Fix** set `owner` with `db_set` after insert, or stamp the
counting user into `remarks` / a custom field.

### D6 — LOW · `first_seen` / `last_seen` never reach any client of the alerts API

`ALERT_FIELDS` (`maison_pos/api/inventory.py:33`) lists both, but `frappe.get_all` silently drops exactly these two
names on this deployment, so `inventory.alerts` never returns them. The columns exist and hold correct values —
filtering and `order_by` on them work, and `frappe.client.get` returns
`first_seen 2026-08-23 15:16:55 / last_seen 2026-08-23 15:17:05` — but every list query omits them, including the
app's own. The server's traceback for D3 shows the same truncated dicts. Sibling `Datetime` fields
(`acknowledged_at`, `resolved_at`, and `Maison Shipment.label_at` etc.) come back fine, so it is specific to these
two field names; I did not isolate the cause (a stale metadata/table-column cache is the likeliest candidate —
I deliberately did not run a cache clear on a shared site).
**Effect** no screen can show "this has been low for 3 days"; the underlying refresh logic is correct.

### Minor notes (not counted as defects)

| # | Note |
|---|---|
| N1 | Cancelling a shipment leaves its replenishment request `Approved` and its Material Request submitted, and nobody tells the store. `MSH-2026-00024` cancelled → `MRR-2026-00023` still "Approved", `MAT-MR-2026-00007` still Pending. `shipping.py:735-742` — consider re-opening or rejecting the request and notifying the store. |
| N2 | On a multi-leg (partial → final) receipt only the **first** receipt Stock Entry is linked on the shipment; later legs are findable only through the Stock Entry remark. `inventory.py:640`. |
| N3 | Error text shown to warehouse users embeds raw desk links — `NegativeStockError … <a href="/app/Form/Item/HKA-002">`, `LinkExistsError … https://cloudchaserz.frappe.cloud/app/material-request/MAT-MR-2026-00017`. No "Frappe"/"ERPNext" wording, but it exposes the underlying desk from the white-labelled product. |
| N4 | The simulated tracker mixes clocks: `simulated.py:142` uses `datetime.utcnow()` while `shipped_at` is site-local (`api/shipping.py::_track_doc`). A label bought at 15:24:59 CDT reported **`TRANSIT` / "Accepted at origin facility"** seconds later — the timeline runs ~5 h (the UTC offset) ahead. Demo-only surface, but it makes a fresh shipment look already-collected. |
| N5 | The raw warehouse name leaks into user-facing copy on the Cycle count screen (`OK-JENKS - CCZ`), the desk header and the wall header (`HOU-WH - CCZ`) — the Receive screen has an explicit code comment saying this should be the store code. |
| N6 | Two admins approving the same request at once: exactly one shipment is created (correct), but the loser sees a raw `TimestampMismatchError: Document has been modified after you have opened it…`. |
| N7 | `shipment_dict` does not expose `received_by`, so the Receive result / desk cannot show who counted a delivery. |
| N8 | POS console (unrelated to this area, for the POS agent): `service worker registration failed … /api/method/maison_pos.api.pwa.service_worker — An unknown error occurred when fetching the script` (may be an artefact of the sandbox request bridge). |

---

## 1 · Low stock

| Test | Result | Evidence | Severity |
|---|---|---|---|
| `inventory.low_stock_scan` runs (Scheduled Job Type, hourly) | PASS | job log `Complete`; the site scheduler also runs it hourly (13:00/14:00/15:00 logs) | — |
| Alerts appear for the right store + items | PASS | fixture pushed `KRT-001` 12→2 (level 3) and `HKA-004` 14→3 (level 4) at OK-JENKS → `MSA-2026-00016`, `MSA-2026-00015`, both `boutique=OK-JENKS`, `warehouse=OK-JENKS - CCZ` | — |
| Alert qty / level mirror the Bin and the Item Reorder row | PASS | `alert.qty=2 bin=2 level=3`, `alert.qty=3 bin=3 level=4` | — |
| No alert for an item still above its level | PASS | `ROL-001 @ OK-JENKS`: 0 open | — |
| No alert raised on an unaffected store | PASS | `KRT-001 @ OK-YALE`: 0 open | — |
| Re-running the scan creates no duplicate | PASS | 2nd + 3rd + 4th run: still exactly 1 open alert per (item, warehouse), same names | — |
| Re-run refreshes `last_seen` | PASS (via doc read) | `first_seen 15:16:55.001 → last_seen 15:17:05.645` on `MSA-2026-00016`; **the list API never returns the field** → D6 | Low |
| New alerts flagged `notified`, Notification Log written | PASS | `notified=1`; 2 logs — `ok.jenks.manager@…` and `hq@cloudchaserz.example`, subject *"Low stock at OK-JENKS: 2 item(s)"* | — |
| Store scoping of `inventory.alerts` | PASS | OK-YALE manager → `403 PermissionError: You are not permitted to act on boutique OK-JENKS` | — |
| Acknowledge (manager) | PASS | `MSA-2026-00016 → Acknowledged`, `acknowledged_by=ok.jenks.manager@…`, `acknowledged_at=15:17:01` | — |
| Acknowledge (associate) allowed by design | PASS | `ok.jenks.a1@…` → 200 | — |
| A re-scan keeps an Acknowledged alert acknowledged | PASS | still 1 `Acknowledged`, same name, no duplicate | — |
| Resolve (manager) | PASS | `MSA-2026-00015 → Resolved` | — |
| Resolve refused for an associate | PASS | `403 PermissionError: Only managers may resolve stock alerts` | — |
| A hand-resolved alert returns on the next scan while stock is still low | PASS | new `MSA-2026-00017` replaces resolved `MSA-2026-00015` | — |
| Alerts auto-resolve once stock is back | PASS | after the replenishment loop (`KRT-001` 12, `HKA-004` 14) the next scan flipped both to `Resolved` with the current qty; 0 open left | — |
| The Shift screen count | PASS | `011-pos-shift-low-stock.png` — *"LOW STOCK · 2 OPEN"*, lines `KRT-001 2 / 3 ACKNOWLEDGED`, `HKA-004 3 / 4 OPEN`, matching `alerts.open=2`; drops to 0 open after restock | — |
| The daily digest function | **FAIL** | `inventory.low_stock_digest` → job **Failed**, `OutgoingEmailError`, 0 Email Queue rows — **D3** | Medium |

## 2 · Replenishment requests

| Test | Result | Evidence | Severity |
|---|---|---|---|
| One-tap request from a low-stock alert (API) | PASS | `MRR-2026-00018`, `KRT-001 ×8`, `Pending Approval`, priority **Low stock** | — |
| One-tap quantity defaults to the alert's `reorder_qty` | PASS | qty 8 = `MSA-2026-00016.reorder_qty` | — |
| One-tap request from the **Shift screen button** | PASS | `request-warehouse-HKA-004` → `MRR-2026-00043` `HKA-004 ×10`, priority Low stock — `012-pos-shift-after-one-tap.png` | — |
| Draft Material Request created (Material Transfer HQ → store) | PASS | `MAT-MR-2026-00005`, `set_from_warehouse=HOU-WH - CCZ`, `set_warehouse=OK-JENKS - CCZ`, `docstatus=0` | — |
| The alert is linked to the MR and flipped to Acknowledged | PASS | `{status: Acknowledged, material_request: MAT-MR-2026-00005}` | — |
| On-hand snapshots captured on the request line | PASS | `on_hand_store=2`, `on_hand_warehouse=70` | — |
| Manual multi-line request, quantities editable | PASS | `MRR-2026-00019` `HKA-004 ×11` + `ROL-001 ×5`, 16 units, priority Normal | — |
| Manual request from the POS Receive modal, qty edited | PASS | `014-pos-receive-request-modal.png` → `MRR-2026-00044` `ROL-006 ×3` | — |
| A request for **another store** is refused | PASS | OK-JENKS manager → OK-YALE: `403 PermissionError: You are not permitted to act on boutique OK-YALE` | — |
| qty 0 / negative / unknown item / empty are refused | PASS | `417 ValidationError: No valid lines` ×3, `404 DoesNotExistError: Item NO-SUCH-ITEM does not exist` | — |
| The warehouse admin sees it on `/warehouse` | PASS | desk Requests tab row `MRR-2026-00033 · OK-JENKS · 1 · 6 · Normal · PENDING APPROVAL · REVIEW` — `002-warehouse-desk.png`, `021-desk-requests-tab.png` | — |
| The store manager sees it on Receive | PASS | `013-pos-receive-screen.png`, `030-pos-receive-requests-list.png` | — |
| Another store's manager sees none of it | PASS | OK-YALE manager: 0 requests, `scope=OK-YALE`; `request_detail` by name → 403 | — |
| It lands in the wall's *Pending approval* column with an age timer | PASS | `pending_approval` contains `MRR-2026-00018`, `age_seconds=1` | — |
| A store manager may not approve or reject | PASS | both `403 PermissionError: Warehouse admin role required` | — |

## 3 · Approval workflow

| Test | Result | Evidence | Severity |
|---|---|---|---|
| Approve with an **edited** quantity | PASS | requested 8 → approved **10** → shipment `MSH-2026-00020` lines `[["KRT-001",10]]`; also through the desk UI (`003-warehouse-approve-sheet.png`, `ROL-002` 6→**4**) | — |
| The Material Request is submitted with the approved quantities | PASS | `MAT-MR-2026-00005 docstatus=1`, item qty 10 | — |
| Shipment wired to request / MR / transit warehouse | PASS | `req=MRR-2026-00018 mr=MAT-MR-2026-00005 from=HOU-WH - CCZ transit=OK-JENKS In Transit - CCZ to=OK-JENKS - CCZ` | — |
| `approved_by` / `approved_at` recorded, store manager notified | PASS | `warehouse@cloudchaserz.example` @ 15:22:20; Notification Log *"Replenishment MRR-2026-00018 approved — shipment MSH-2026-00020"* | — |
| A line approved at **0** is dropped from shipment and MR | PASS | request `[HKA-004 11→11, ROL-001 5→0]` → shipment `[HKA-004 11]`, MR `[HKA-004 11]` | — |
| **Approve twice** — idempotent? | PASS (refused, 1 shipment) | 2nd call `417 ValidationError: Request MRR-2026-00018 is Approved`; shipments for that request: **1** | — |
| Reject requires a reason | PASS | blank reason → `417 A rejection reason is required` | — |
| Reject with a reason | PASS | `MRR-2026-00022 → Rejected`, *"QA2 discontinued — order the 20K instead"*; no shipment created | — |
| The manager is notified of the rejection with the reason | PASS | Notification Log for `ok.jenks.manager@…`: *"Replenishment MRR-2026-00022 rejected: QA2 discontinued — order the 20K instead"* | — |
| Rejecting deletes the draft MR | PASS | `MAT-MR-2026-00007` gone; request shows `material_request=null` | — |
| The rejected request + reason show on the store's Receive feed | PASS | `MRR-2026-00022 · 1 item · 7 u REJECTED … · QA2 DISCONTINUED — ORDER THE 20K INSTEAD` — `030-pos-receive-requests-list.png` | — |
| **Rejecting a request raised from a low-stock alert** | **FAIL** | `417 LinkExistsError … Material Request MAT-MR-2026-00017 is linked with Maison Stock Alert MSA-2026-00017`; request stuck `Pending Approval` — **D1** | **High** |
| Approve a request the warehouse cannot cover | PASS (by design) | `HKA-002`: HQ holds 6, approved **31** → `MSH-2026-00024` created. No stock check at approval; the shortfall is visible as `on_hand_warehouse=6` on the line. The ledger stops it at **ship** time (see §4) | — |
| Approving / rejecting an already-approved request | PASS | both `417 ValidationError: Request … is Approved` | — |

## 4 · Shipment lifecycle & stock postings

| Test | Result | Evidence | Severity |
|---|---|---|---|
| Pick list contents | PASS | `KRT-001 qty 10, on_hand 70 (HOU-WH), bin E-07-1, barcode 2009995201711`; header `HOU-WH - CCZ → OK-JENKS (CloudChaserz Jenks)`; readable by the destination store's manager | — |
| Pick list sorted by bin location, 50 lines | PASS | `A-01-1, A-01-2, A-01-3, A-02-2, A-02-3 …` — sorted; 50 lines in 196 ms — `026-desk-shipment-sheet-picklist.png` | — |
| **Partial pick** | PASS | `picked 4/10`, status `Pending → Picking` | — |
| Picking more than approved is refused | PASS | `417 ValidationError: Picked more than approved for KRT-001` | — |
| Pick completes to the full quantity | PASS | `picked=10` | — |
| Pack with parcels / weight; zero weight refused | PASS | `Packed`, parcel `30×22×14, 2.4 kg`, `packages=1`; weight 0 → `417 Parcel weight must be positive` | — |
| **No stock moves** at pick / pack / label | PASS | balances identical at each step: `{hq:70, transit:0, store:2}` | — |
| Ship → Material Transfer HQ → `<store> In Transit` | PASS | `MAT-STE-2026-00049`, submitted Material Transfer, remark *"Maison Shipment MSH-2026-00020 → OK-JENKS (in transit)"*; **Bin** HQ 70→**60**, In Transit 0→**10**, store 2→2 | — |
| Stock Ledger at ship | PASS | `[HOU-WH -10, OK-JENKS In Transit +10]` | — |
| Shipping twice is refused | PASS | 2nd `ship` → refused | — |
| The shipment shows on the store's inbound list | PASS | `inventory.inbound → shipments=[MSH-2026-00020]`, plus `preparing` for the unshipped ones | — |
| Receive → In Transit → store | PASS | `MAT-STE-2026-00050`; Bin In Transit 10→**0**, store 2→**12**, HQ unchanged at 60 | — |
| Stock Ledger at receive | PASS | `[OK-JENKS In Transit -10, OK-JENKS +10]` | — |
| Clean receipt raises no discrepancy | PASS | `discrepancies=[]`; request closed `Approved` | — |
| Receiving twice | PASS (refused) | `417 ValidationError: Shipment MSH-2026-00020 is Received, not in transit`; balances unchanged | — |
| Shipping more than the warehouse holds | PASS (refused, nothing posted) | `417 NegativeStockError: 25.0 units of Item HKA-002 needed in Warehouse HOU-WH - CCZ`; balances unchanged; shipment left at `Picking` with `stock_entry_ship=null` | — |
| **Cancel a shipment mid-flow** | PASS | `MSH-2026-00024` (Picking) → `Cancelled`, no stock posted, card leaves the wall | — |
| A shipped/received consignment cannot be cancelled | PASS | `417 A shipped consignment cannot be cancelled — receive it at the store` | — |
| Cancelling leaves the request `Approved` and the MR submitted | OBSERVATION | `MRR-2026-00023` still Approved after `MSH-2026-00024` was cancelled — **N1** | Low |
| No pick / pack / buy / ship / mark-back on a Received shipment | PASS | 5 × `417 ValidationError: Shipment MSH-2026-00042 is (already) Received`; `mark(status="Teleported")` → `417 Unsupported status` | — |

## 5 · Rates and labels

| Test | Result | Evidence | Severity |
|---|---|---|---|
| Rate list, cheapest first | PASS | 8 rates: `USPS Ground Advantage $17.17/3d` → `UPS Ground $25.32/3d` → `FedEx Home $26.28/3d` → `USPS Priority $27.33/2d` → `FedEx 2Day $55.97/2d` → `UPS 2nd Day $56.14/2d` → `USPS Priority Express $74.40/1d` → `UPS Next Day Saver $102.66/1d` — monotonically increasing | — |
| Cheapest pre-selected | PASS | `selected = USPS Ground Advantage $17.17`, `selected.provider_rate_id == cheapest` | — |
| Each rate carries carrier / service / amount / days / id | PASS | `{carrier:USPS, service:Ground Advantage, amount:17.17, days:3, provider_rate_id:sim_909b9bbd2dbb, currency:USD, attributes:[tracking, zone_4, 16_lb]}` | — |
| Quote echoes ship-from / ship-to / parcels | PASS | `Houston TX 77098 → Jenks, OK 74037`, parcel `40×30×25, 6.95 kg` | — |
| **"Fastest" toggle** (API) | PASS | `prefer=fastest` → `USPS Priority Mail Express $74.40, 1 d`, `selected == fastest`, cheapest still reported | — |
| "Fastest" toggle (desk UI) | PASS | `027-desk-rate-chooser-cheapest.png` (badges CHEAPEST / FASTEST, cheapest first) → `028-desk-rate-chooser-fastest.png` (selection moves to `USPS Priority Mail Express · 1 BUSINESS DAY · FASTEST`) | — |
| Quote cached on the shipment (`rate_options`) | PASS | 2 020 chars of `rate_options` after the UI's POST call. (Calling `rates` over **GET** leaves it empty — Frappe only commits on writes; not user-visible since the client POSTs) | — |
| Buy a label (simulated) | PASS | `simulated / USPS Ground Advantage / $9.85`, status stays `Packed`, `tracking_status=PRE_TRANSIT` | — |
| Tracking number + URL are carrier-shaped | PASS | `1Z840D324033235145` → `https://www.ups.com/track?tracknum=…`; `9400…` → `https://tools.usps.com/go/TrackConfirmAction?tLabels=…` | — |
| The label URL is servable | PASS | `GET /shipping-label/1Z840D…` → `200 text/html`, `<title>CloudChaserz - Label 1Z840D…</title>` | — |
| Buy a specific non-cheapest rate | PASS | bought `UPS 2nd Day Air $56.14 (2 d)` while the cheapest was $17.17 | — |
| Buying a rate not in the last quote | PASS (refused) | `417 Rate sim_deadbeef is not in the last quote — fetch rates again` | — |
| **Buying twice overwrites the label** | **FAIL** | second `buy` accepted, tracking `1Z840D…` replaced by `9400642…` — **D4** | Low |
| `shipping.refresh_tracking` (hourly job) | PASS | job `Complete`; shipment stamped `tracking_status=TRANSIT`, `tracking_updated_at=15:25:02` | — |
| `shipping.track` on demand | PASS | `status=TRANSIT`, `eta=2026-08-26T15:24:59`, events `[PRE_TRANSIT, TRANSIT]`; store manager may refresh their own inbound shipment | — |
| Tracking a shipment with no label | PASS | `{tracking_no: null, status: null, events: []}` — no error | — |
| Tracking timeline runs ~5 h ahead | OBSERVATION | label bought 15:24:59 → `track` says *"Accepted at origin facility"* seconds later — **N4** | Low |
| **An error from the provider** | PASS | `provider=shippo` → `417 ValidationError: Shippo is not configured: set 'shippo_api_key' in site_config.json`; `provider=pirateship` → `417 Unknown shipping provider 'pirateship'`; both clean messages, no traceback | — |
| Re-quoting after shipping | PASS (refused) | `417 Shipment MSH-2026-00021 is already Shipped` | — |

## 6 · Wall board `/warehouse-wall` @ 1920×1080

| Test | Result | Evidence | Severity |
|---|---|---|---|
| Opens at 1920×1080 for the warehouse admin | PASS | first paint + cards in **1 318 ms** — `001-wall-1920-all-columns.png` | — |
| Five columns, cards in the right one | PASS | `pending_approval` = the two Pending-Approval requests; `to_pick` = Pending shipment; `packing` = Packed **without** label; `ready` = Packed **with** label; `shipped_today` = shipped today | — |
| Age timer — warn at 4 h | PASS | 5 h-old request `data-tier="warn"`, reads `5h 01m`; 6 h-old shipment `warn`, `6h 01m` | — |
| Age timer — crit at 24 h | PASS | 30 h-old request `data-tier="crit"`, reads `1d 6h` | — |
| Fresh cards are green | PASS | `data-tier="ok"`, `1m` | — |
| Priority flag | PASS | Urgent card renders `⚑` and class `flagged`; a Normal card does not | — |
| Card ordering (priority, then oldest) | PASS | `MRR-…26 (Urgent, 30 h) > MRR-…25 (Normal, 5 h) > MRR-…33 (Normal, 0 h)` | — |
| Card content | PASS | `OK-JENKS · CloudChaserz Jenks · 1 item · 2 units · Pending · MSH-2026-00028 · [Pick]`; carrier + tracking once bought | — |
| Live connection + **site** clock | PASS | pill `LIVE`, clock `15:29 CDT` (site zone, not the browser's UTC) | — |
| **Realtime update when approved elsewhere** | PASS | approval done in the `/warehouse` desk in a separate browser context → card appeared on the wall after **7 ms** — `004-wall-after-realtime-approval.png` | — |
| **Auto-print hook fires** | PASS | `window.__maisonLastWallPrint = {kind:"packing_list", url:"/printview?doctype=Maison Shipment&name=MSH-2026-00034&format=Maison Packing List…", shipment:"MSH-2026-00034", via:"dry"}` | — |
| The packing list actually renders | PASS | `200`, 14 309 bytes, CloudChaserz + OK-JENKS address, inline SVG barcodes + QR; 50-line version: 180 306 bytes, **51** inline barcode/QR SVGs; no "Frappe"/"ERPNext" in the body text | — |
| Tap actions work | PASS | `act-MSH-2026-00028` → shipment goes `Pending → Picking` **and** the shipment sheet opens — `005-wall-tap-action-sheet.png` | — |
| Legible + performant with many cards | PASS | 60 extra cards injected per column: `count 62 / rendered 8-9` (virtualised), reload+render **4 609 ms**, **~61 fps**, no horizontal overflow at 1920×1080, store-code type **26 px** — `006-wall-1920-many-cards.png` | — |
| Wall payload build time with a 50-line consignment | PASS | `shipping.wall` in **128 ms** | — |
| Role gate | PASS | store manager on `/warehouse-wall` and `/warehouse` → *"WAREHOUSE ADMIN ROLE REQUIRED …"*; `wall` / `warehouse_stock` / `vendor_pos` all `403 Warehouse admin role required` — `031-desk-gate-store-manager.png` | — |
| No "Frappe"/"ERPNext" text on wall or desk | PASS | 4 919 + 545 chars scanned, none | — |

## 7 · Receiving at the store

| Test | Result | Evidence | Severity |
|---|---|---|---|
| Inbound list | PASS | `013-pos-receive-screen.png` — *"FROM THE WAREHOUSE · 1 IN TRANSIT · MSH-2026-00042 · 5 UNITS · USPS GROUND ADVANTAGE · 9400320… · SHIPPED AUG 23, 2026, 15:33"*, plus a *"being prepared"* section and the vendor-PO panel | — |
| **Scan to count** | PASS | 3 scans of EAN `2007841007630` → counted `3`, pill `COUNTED · 2007841007630` — `015-pos-receive-count-sheet.png` | — |
| Unknown barcode rejected | PASS | pill `NOT ON THIS DELIVERY · 9999999999999` | — |
| Short/over summary before posting | PASS | `3 / 5 UNITS · 1 SHORT` — `016-pos-receive-count-partial.png` | — |
| **Partial receipt, then completing it** (UI) | PASS | *Save partial* → `MSH-2026-00042 · PARTIAL RECEIPT SAVED`, `MAT-STE-2026-00059`, status stays `Shipped`, `3/5` received (`017-…`); then *All as expected* + confirm → `RECEIVED`, `MAT-STE-2026-00060`, `5/5` (`018-…`) | — |
| Partial receipt (API), balances | PASS | `final=0` with 5 of 11: store 3→**8**, transit 11→**6**, shipment stays `Shipped`, **no** Short discrepancy; inbound list shows `units_received=5` | — |
| Completion posts the remainder | PASS | `final=1` → `Received`, store **14**, transit **0**, no discrepancy | — |
| **Short** quantity | PASS | `ROL-002` shipped 6, counted 4 → 4 to store, **2 left in transit**, `short_qty=2` | — |
| **Over** quantity | PASS | `ACC-002` shipped 4, counted 5 → only **4** move (no phantom stock), `over_qty=1` | — |
| **Damaged** quantity | PASS | `ROL-006` shipped 3, counted 2 + 1 damaged → 2 to `OK-JENKS - CCZ`, **1 to `OK-JENKS Damaged - CCZ`** via its own Stock Entry `MAT-STE-2026-00056` | — |
| Stock Ledger of the whole receipt | PASS | ship `[ROL-002 -6, ACC-002 -4, ROL-006 -3 @HOU-WH → +6/+4/+3 @In Transit]`; receive `[-4/-4/-2 @In Transit → +4/+4/+2 @OK-JENKS]`; damaged `[-1 @In Transit → +1 @Damaged]` | — |
| Negative counted qty refused | PASS | `417 Negative quantity for ROL-002` | — |
| Another store's manager cannot receive my shipment | PASS | `403 PermissionError: You are not permitted to act on boutique OK-JENKS` | — |
| **Discrepancy record created, visible to the warehouse admin** | PASS | one per line — `MRD-2026-00037 Short 2`, `MRD-2026-00038 Over 1`, `MRD-2026-00039 Damaged 1`; desk Discrepancies tab lists all three (`023-desk-discrepancies-tab.png`); Notification Log to `warehouse@…`: *"OK-JENKS: 3 receiving discrepancy(ies) on MSH-2026-00036"* | — |
| Discrepancy scoping | PASS | the store sees only its own (3, all OK-JENKS); OK-YALE sees 0 | — |
| Resolve — *Returned to warehouse* | PASS | `MAT-STE-2026-00057` posts `[OK-JENKS In Transit -2 → HOU-WH +2]`; transit back to 0 | — |
| Resolve — *Accepted* / *Re-ship* | PASS | Over accepted with no Stock Entry; Damaged → `Re-ship` raised `MRR-2026-00040`, priority **Urgent**, boutique OK-JENKS | — |
| Unknown resolution / resolve twice / store manager resolving | PASS | `417 Unknown resolution Shrug`; `417 Already resolved`; `403 Warehouse admin role required` | — |
| **Receiving a vendor PO directly** | PASS | `PUR-ORD-2026-00001` (QA2 Test Supplier) appears on Receive; `inventory.receive_po` 3 of 5 → `MAT-PRE-2026-00001`, store +3, PO `per_received=60 %`, still open; a PO addressed elsewhere → `403 Purchase Order … is not addressed to OK-YALE` | — |
| Only the first receipt Stock Entry is linked | OBSERVATION | `stock_entry_receive=MAT-STE-2026-00052` after two legs (`…52`, `…53`) — **N2** | Low |
| The demo seeds no Supplier / Purchase Order | OBSERVATION | 0 Suppliers and 0 POs before this run, so *Vendor deliveries* on Receive and *Vendor POs* on the desk are always empty on the demo — `025-desk-vendor-pos-tab.png` | Info |

## 8 · Cycle count

| Test | Result | Evidence | Severity |
|---|---|---|---|
| Expected counts | PASS | `warehouse=OK-JENKS - CCZ`, **155** qty items, 0 serialised items, `as_of` stamped | — |
| Screen loads and offers the scan flow | PASS | `029-pos-cycle-count.png` — *"CYCLE COUNT · OK-JENKS - CCZ · system as of Aug 23, 2026, 15:44 · CAMERA SCAN · SERIALS 0/0 · COUNTED 0/155 · SERIALS / QUANTITIES tabs"* | — |
| A matching count is clean, no reconciliation | PASS | `MCC-2026-00045`, `clean=true`, 0 diffs, `stock_reconciliation=null` | — |
| **Variance vs expected** | PASS | `DSP-021` expected 19 counted 17 diff **-2**; `DSP-009` expected 24 counted 25 diff **+1** | — |
| Unexpected serial reported | PASS | `{serial_no: QA2-NOT-A-REAL-SERIAL, status: not_found}` | — |
| The count is stored as a Draft `Maison Cycle Count` | PASS | `status=Draft`, boutique/warehouse/device_id/associate recorded | — |
| **Draft Stock Reconciliation created** | PASS | `MAT-RECO-2026-00001`, `purpose=Stock Reconciliation`, `set_warehouse=OK-JENKS - CCZ` | — |
| **It requires manager approval (unsubmitted)** | PASS | `docstatus=0`; `DSP-021` on hand still **19** (counted 17) — nothing posts until someone submits | — |
| It carries exactly the counted quantities | PASS | `[[DSP-009, 25], [DSP-021, 17]]` | — |
| The cycle count links its reconciliation | PASS | `stock_reconciliation=MAT-RECO-2026-00001` | — |
| Reconciliation attributed to the counting user | **FAIL** | `owner=Administrator` — **D5** | Low |
| Store scoping | PASS | OK-YALE manager refused on both `cycle_count_expected` and `submit_cycle_count` (`403`) | — |
| Serial scan path | NOT COVERED | the site has **0 `Serial No` records and 0 items with `has_serial_no`**, so the serialised half of the count (and serialised shipments) cannot be exercised on CloudChaserz | Info |

## 9 · Edge cases

| Test | Result | Evidence | Severity |
|---|---|---|---|
| **Two people requesting simultaneously** | PASS | 4 parallel `replenish` calls from the manager and an associate → 4 distinct requests + 4 distinct MRs in 784 ms, all persisted `Pending Approval`, none lost | — |
| Two admins approving the same request at once | PASS | exactly **one** shipment (`MSH-2026-00051`); the loser got `417 TimestampMismatchError` (raw wording — **N6**) | — |
| **Approving an already-shipped request** | PASS (refused) | `417 Request MRR-2026-00041 is Approved`; reject likewise | — |
| Acting on an already-received shipment | PASS (refused) | pick / pack / buy / ship / mark-back all `417`; receive again `417 … is Received, not in transit` | — |
| **Receiving twice** | PASS (refused) | balances unchanged after the second attempt | — |
| **A shipment with 50 lines** | PASS | request 50 lines/50 units in 1 419 ms → `MSH-2026-00053` 50 lines in 2 389 ms; `est_weight 27.21 kg`, dims `40×30×75`; rates → **3 parcels** of 9.07 kg, 8 quotes in 112 ms (cheapest $165.85); pick list 50 lines in 196 ms sorted by bin; wall payload 128 ms; packing list 180 KB with 51 barcode/QR SVGs — `026-desk-shipment-sheet-picklist.png` | — |

---

## Console errors

Zero console errors, page errors or failed requests on `/warehouse` and `/warehouse-wall` across every run, including
the 60-cards-per-column stress run. On the POS screens two entries appeared: the service-worker registration warning
noted in **N8** (POS agent's area), and one `requestfailed … maison_pos.api.session.me — net::ERR_ABORTED` caused by my
own test navigating away mid-request (harness artefact, not reproducible by hand). No visible "Frappe" or "ERPNext" text on any warehouse surface — desk, wall, Receive, Shift,
Cycle count, the packing-list print format, or the simulated label page (all scanned programmatically). See **N3** for
raw `/app/...` desk links appearing inside *error* strings.

## Cleanup

Verified by `c4-verify.mjs` (`results-c4.json`), all PASS:

* **17 Stock Entries + 1 Purchase Receipt posted during this run net to exactly 0 in every warehouse** for every item
  touched (`KRT-001`, `HKA-004`, `ROL-002`, `ACC-002`, `ROL-006`). Two compensating transfers were posted
  (`MAT-STE-2026-00063`, `…64`, remark *"QA2 QA cleanup — restoring balances"*).
* `OK-JENKS In Transit` and `OK-JENKS Damaged` are **empty**.
* 0 open shipments, 0 requests pending approval, 0 open discrepancies, 0 open low-stock alerts (site-wide), 0 half-open
  Material Requests for the store. The wall is back to `{pending_approval:0, to_pick:0, packing:0, ready:0,
  shipped_today:0}`, `in_transit=0`, `open_discrepancies=0` — `032-wall-1920-clean-after-cleanup.png`.
* Deleted: `Stock Reconciliation MAT-RECO-2026-00001`, `Maison Cycle Count MCC-2026-00045/00046`,
  `Purchase Receipt MAT-PRE-2026-00001` (cancelled first).

**Left behind (could not be removed):**

| Item | Why |
|---|---|
| `MRR-2026-00018…00052` (20 requests) and `MSH-2026-00020…00053` (11 shipments), all in terminal states (Received / Cancelled / Rejected) | Deleting them would dangle the links between request ↔ shipment ↔ Material Request. They are closed, so they do not appear on the wall or in the desk's default filters. |
| `Maison Receiving Discrepancy MRD-2026-00037/38/39` — all **Resolved** | audit trail by design (`docs/shipping.md`: "resolve it honestly rather than deleting it") |
| `Purchase Order PUR-ORD-2026-00001` — **Cancelled** | `LinkExistsError` on delete (linked to the cancelled Purchase Receipt) |
| `Supplier "QA2 Test Supplier"` — **disabled** | ERPNext refuses deletion once a PO exists ("You can disable this Supplier instead") |
| `Maison Stock Alert MSA-2026-00015…00017`, `00054` — all **Resolved** | the scan's own lifecycle records |
| ~40 `Notification Log` rows and 7 `Scheduled Job Log` rows | side effects of the flows under test |
| `MSA-2026-00017.material_request` cleared by hand | required to unstick D1 during cleanup (noted for completeness) |

Nothing outside `OK-JENKS` / `HOU-WH` was touched; no global setting, seed or other agent's data was changed.
