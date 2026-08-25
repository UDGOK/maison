# Warehouse & shipping (v0.6 P)

The Houston head office (`HOU-WH`) picks, packs and ships replenishment consignments to the
11 stores. This document covers the carrier integration, the printing setup on the warehouse
floor, and the operational runbook.

Related: `docs/cloudchaserz.md` (stores, roles), `docs/rewards.md`, `SPEC_v0.6.md` section P.

---

## 1. The flow

```
store manager                 warehouse admin (HOU-WH)                  store manager
─────────────                 ────────────────────────                  ─────────────
Receive screen                /warehouse desk + /warehouse-wall         Receive screen
  "Request from warehouse" →  Approve / edit qty / Reject           →
  (or one tap on a
   low-stock alert)           ↓ on approve
                              AWANZ Shipment (Pending)
                              → Pick   (pick list, bins)
                              → Packed (parcels, weight)
                              → Buy label (rate shopping)
                              → Ship   ──────────────────────────────→  scan / count
                                                                        Confirm receipt
```

Documents created along the way:

| Step | Document |
|---|---|
| Manager requests | `AWANZ Replenishment Request` + draft **Material Request** (type *Material Transfer*, `HOU-WH` → store) |
| Warehouse approves | `AWANZ Shipment` (+ `AWANZ Shipment Line`), Pick List |
| Ship | **Stock Entry** — Material Transfer `HOU-WH` → `<code> In Transit` |
| Store confirms receipt | **Stock Entry** — Material Transfer `<code> In Transit` → `<code>` (and → `<code> Damaged` for damaged units) |
| Short / over / damaged | `AWANZ Receiving Discrepancy` (one per line) for the warehouse admin |

The in-transit leg means stock is never "nowhere": it leaves HQ when the parcel leaves and only
lands in the store when someone actually counts it. Partial receipts are supported — call
`inventory.receive_shipment(..., final=0)` (the Receive screen's *Save partial count*) as many
times as needed; the shipment stays *Shipped* until the final confirmation.

### Endpoints

| Method | What |
|---|---|
| `maison_pos.api.inventory.replenish` | store manager creates a request (`lines`, or one-tap `item` + `alert`) |
| `maison_pos.api.shipping.requests_list` / `.request_detail` | the approval queue |
| `maison_pos.api.shipping.approve` / `.reject` | approve (with edited `approved_qty`) or reject with a reason |
| `maison_pos.api.shipping.pick` / `.pick_list` / `.pack` | picking and packing (parcels, weights) |
| `maison_pos.api.shipping.rates` / `.buy` / `.track` / `.mark` / `.ship` | rate shopping, label purchase, tracking, status |
| `maison_pos.api.shipping.wall` | the 55" board payload |
| `maison_pos.api.inventory.inbound` / `.receive_shipment` | the store's Receive screen |
| `maison_pos.api.shipping.discrepancies` / `.resolve_discrepancy` | short / over / damaged follow-up |

Everything is store-scoped server-side: a store manager only ever sees their own store's requests,
shipments and stock entries (`maison_pos/scoping.py` + `permission_query_conditions`), and only a
**AWANZ Warehouse Admin** may approve, pick, buy a label or ship. `e2e/cloudchaserz.e2e.mjs`
asserts the 403s over plain HTTP.

---

## 1b. The other direction: Houston pushes (v1.1)

Everything above starts with a store asking. For a **brand-new product** that is backwards: no
store knows it exists, so none of them will ask, and the eleven managers would each have to be
told to request it. v1.1 adds the push.

```
warehouse admin (HOU-WH)                                        store manager
────────────────────────                                        ─────────────
Stock → an item → "Send to stores"
  plan: what Houston holds, what is already committed,
        every store's on-hand / cover / has-it-ever-sold
  split: Same to all · Split evenly · Weight by sales · Top up
  Send  ─────────────────────────────────────────────┐
                                                     │
                        one AWANZ Replenishment Request per store (warehouse_push = 1)
                        + its Material Request, approved in the same action
                        → AWANZ Shipment (Pending) ──→ the wall, exactly as a pull
                                                     └──────→ Receive screen · Confirm receipt
```

**It is the same shipment.** `maison_pos/distribution.py` composes the existing
`shipping.create_request` and `shipping.approve`; there is no second creation path. The wall, the
pick list, the packing step, the label purchase and the store's Receive screen cannot tell the
difference and are not asked to.

### How a push differs from a store's pull

| | Store pull | Houston push |
|---|---|---|
| Who starts it | store manager (Receive screen, or one tap on a low-stock alert) | warehouse admin (Stock → *Send to stores*) |
| Approval | a separate act by the warehouse admin — the request waits in *Pending Approval* | created **and** approved in one action: the admin is both requester and approver, so a pending step would be theatre (client decision 2) |
| `warehouse_push` | `0` | `1` — read-only, set by `maison_pos.distribution` and by nothing else, so the two are told apart in every screen and report for ever |
| `requested_by` | the store manager | the warehouse admin |
| Reason | whatever the manager typed | *Warehouse push from Houston*, unless the admin typed one |
| Batching | one request per store, as raised | one request **and one shipment per store** — separate parcels, separate labels, never batched (client decision 3) |

### Never allocate stock Houston does not have

`send` validates **everything before writing anything**: every store enabled and a real shop,
every item a stock item, every quantity above zero, and the total per item at or under HOU-WH's
*available* on hand — where available is the bin quantity **minus** what is already committed to
shipments that have been raised but not yet shipped (Pending / Picking / Packed still sit in the
bin). A failure names the shortfall per item and writes nothing at all:

```
Houston does not hold enough stock to send this distribution:
• CC-DISPO-14 — 40 requested, 25 available, short 15
• CC-COIL-07 — 12 requested, 0 available, short 12
Nothing was sent — lower the quantities or buy more first.
```

That is deliberate (client decision 4). Over-allocation is never silently trimmed, and the write
phase runs inside a savepoint so an unexpected failure on the fourth store cannot leave the first
three on the wall. A half-sent distribution leaves phantom shipments the floor will pick and ship.

### Allocation helpers

The maths lives on the server so the sheet never re-implements it
(`maison_pos.api.distribution.suggest_split`):

| Mode | What it does |
|---|---|
| `even` | equal across the chosen stores; the remainder goes to the busiest (highest 28-day velocity, then emptiest, then store code — a total order, so the same input always splits the same way) |
| `velocity` | weighted by 28-day velocity with a **minimum of one each**. Fewer units than stores → the busiest get what there is. Nobody has ever sold it → no signal to weight by, so it falls back to `even` rather than piling the lot on one store |
| `topup` | brings every store up to a target days-of-cover (`velocity × cover_days − on hand`, rounded up). Gaps smaller than the quantity → each store gets exactly its gap and the rest stays in Houston (reported as `remainder`); gaps larger → shared in proportion to the gap, and no store is given more than it needs |

### Endpoints

| Method | What |
|---|---|
| `maison_pos.api.distribution.stores` | the enabled shops a push may address |
| `maison_pos.api.distribution.plan` | per item: HOU-WH on hand / committed / available, and a row per store with on-hand, 28-day velocity, days of cover and whether it has ever sold it |
| `maison_pos.api.distribution.suggest_split` | `even` / `velocity` / `topup`, plus `left_at_warehouse` for the running footer |
| `maison_pos.api.distribution.send` | create + approve one shipment per store, all or nothing |

**AWANZ Warehouse Admin** and **AWANZ Head Office** only — the same set as buying. A store manager
calling `send` for their **own** store is still refused: pushing is Houston's act, and a store may
neither pull for itself without approval nor push to another store.
`maison_pos/tests/test_v1_1_distribution_http.py` asserts the 403s over plain HTTP.

### Deliberately not built in v1.1

* **No store-to-store transfers.** Stock moves out of Houston or it does not move.
* **No automatic distribution of every new product.** A human chooses the stores and the
  quantities; the split helpers only suggest.
* **No allocation by forecast.** Velocity is measured from what actually sold in the last 28 days.

---

## 2. Carriers

### Why not Pirate Ship

**Pirate Ship has no public API.** It is a free web UI over USPS (and now UPS) commercial rates;
there is no documented, supported programmatic interface, no API keys, and no sandbox. Screen
scraping their site would break at every deploy and violates their terms. So Pirate Ship is not an
option for an automated warehouse — it stays available as a manual fallback in a browser.

### What we use instead

| Provider | Module | Notes |
|---|---|---|
| **Simulated** (default) | `maison_pos/shipping/providers/simulated.py` | realistic USPS Ground Advantage / Priority / Priority Express, UPS Ground / 2nd Day / Next Day Saver, FedEx Home / 2Day tiers priced by USPS zone and billable weight. No network, no keys — this is what demos and the e2e run on. |
| **Shippo** (recommended) | `maison_pos/shipping/providers/shippo.py` | fully implemented against the REST API (`2018-02-08`). Free tier includes API access; the same USPS Commercial Plus / UPS discounted rates Pirate Ship resells. |
| **EasyPost** (alternative) | `maison_pos/shipping/providers/easypost.py` | same adapter interface; use it if you already have an EasyPost account or need carriers Shippo does not cover. |

All three implement the interface in `providers/base.py`:

```python
rates(from_addr, to_addr, parcels) -> [{carrier, service, amount, days, provider_rate_id}]
buy(rate)                          -> {label_url, tracking_no, tracking_url}
track(tracking_no)                 -> {status, eta, events}
```

so switching provider is a settings change, not a code change.

### Configuring Shippo

1. Create an account at <https://goshippo.com> and copy the API token.
2. Add it to the site's `site_config.json`:
   ```json
   {
     "shippo_api_key": "shippo_test_xxxxxxxxxxxxxxxxxxxx"
   }
   ```
   A `shippo_test_…` token runs in **test mode**: rates are real, labels are watermarked test PDFs
   and nothing is charged. Swap for a `shippo_live_…` token to buy real postage. Optional
   `shippo_api_url` points at a mock server for CI.
3. Set `shipping_provider` to `Shippo` in **AWANZ POS Settings**.
4. Fill the ship-from block in the same settings (`ship_from_name`, `ship_from_street1`,
   `ship_from_city`, `ship_from_state`, `ship_from_zip`, `ship_from_phone`, `ship_from_email`).
   The ship-to address comes from each `AWANZ Store`.

Rates are cached on the shipment (`rate_options`) when they are fetched, so the warehouse sees the
same list it was quoted. **Cheapest is auto-selected**; the wall's rate sheet has a *fastest*
toggle and the admin can pick any row. `shipping.track` refreshes tracking hourly through the
scheduler.

### Parcels and weight

Weight comes from the item's `weight_per_unit` plus the box; dimensions from the optional
`maison_length` / `maison_width` / `maison_height` custom fields. Anything missing falls back to a
conservative default so a rate is always quotable — check the parcel on the Packed step before
buying a label for anything unusual (a 4-foot bong is not a default box).

---

## 3. Printing on the warehouse floor

Two documents print, and they want two different printers:

| Document | Format | Printer |
|---|---|---|
| **Packing list** | `AWANZ Packing List` print format — store ship-to, lines with barcodes, carton count, weight, a QR of the shipment | ordinary A4 / Letter laser |
| **Carrier label** | the PDF the carrier returns (`label_url`) | 4×6 thermal label printer (Zebra / Rollo / DYMO) |

### Automatic printing from the wall

The wall page (`/warehouse-wall`) prints without anyone touching a dialog:

* when a shipment becomes **Approved** it prints the packing list,
* when a label is bought (**Ready to ship**) it prints the label.

Both go through `frontend/src/warehouse/print.ts`, which loads the document into a hidden iframe
and calls `contentWindow.print()`. Every job is recorded on `window.__awanzLastWallPrint` (and a
`awanz-wall-print` event fires) — that is what `e2e/warehouse.e2e.mjs` asserts, so the behaviour is
covered without a physical printer. Toggle either job off with `auto_print_packing_list` /
`auto_print_label` in settings.

### Kiosk mode (the PC driving the 55" screen)

`window.print()` normally opens a dialog. Chrome started in kiosk-printing mode skips it and sends
straight to the **default** printer:

```bash
google-chrome \
  --kiosk --kiosk-printing \
  --disable-session-crashed-bubble --disable-infobars \
  --no-first-run --start-fullscreen \
  "http://pos.cloudchaserzworld.com/warehouse-wall"
```

On Windows, put a shortcut with those flags in `shell:startup` so the wall comes back after a
reboot. Set the screen to never sleep, and log the machine in as the `warehouse@` user so the
board is authenticated.

### The two-printer limitation (read this before buying hardware)

`--kiosk-printing` always prints to the OS **default printer**. Chrome offers no way to choose a
different printer per document, so a single kiosk browser cannot send the packing list to the
laser *and* the label to the thermal printer. Three ways out, in order of preference:

1. **Two machines.** The wall PC's default printer is the laser (packing lists). A second small
   PC / NUC at the pack bench runs its own kiosk Chrome on the shipment detail page with the
   thermal printer as its default. Cheapest and most robust; no custom software.
2. **A print agent.** A small local service (Node or Python) listening on `localhost`, which the
   wall posts the document URL and a target printer to, and which shells out to the right queue
   (`lp -d label-printer file.pdf` / `PDFtoPrinter.exe /s "Zebra"`). One machine, one extra moving
   part to keep alive. `print.ts` already routes cross-origin PDFs through `window.open`, which is
   the hook an agent would replace.
3. **Manual for labels.** Leave `auto_print_label` off and let the packer press *Print label* on
   the shipment sheet, choosing the thermal printer in the normal dialog. Slowest, but zero setup.

Cross-origin label PDFs (a real Shippo label lives on `deliver.goshippo.com`) cannot be printed
from an iframe at all — the browser will not let a page reach into another origin's document. The
wall detects this and opens them in a new window instead, where kiosk-printing still applies.

---

## 4. Runbook

**A shipment is stuck in Pending.** Nobody has picked it. The wall's age timer turns amber at
4 hours (`wall_warn_hours`) and red at 24 (`wall_crit_hours`); both are settings.

**Rates come back empty.** Check `shipping_provider`, the API key, and that the store has a
complete ship-to address including ZIP. The Simulated provider always returns rates, so if
switching to Simulated fixes it, the problem is the carrier account.

**A label was bought for the wrong service.** `shipping.buy` refuses to buy a second label for a
shipment that already has one (v0.8 QA W-D4 — it used to overwrite the first silently, and that
label was already billed with its tracking number unrecoverable from the app). Pass `replace=1`
to buy the replacement: the voided label's carrier / service / tracking is written to the
shipment's notes and returned as `voided_label`, and you still have to refund it in the carrier's
dashboard (Shippo refunds unused labels within 30 days).

**A shipment had to be cancelled.** Cancelling puts its replenishment request back to *Pending
Approval*, cancels the Material Request and notifies the store (v0.8 QA W-N1) — the request used
to stay Approved with its MR submitted and nobody told. Approve it again to raise a fresh
shipment, or reject it with a reason.

**The store reports a short.** Their Receive screen records the counted quantity; the difference
raises a `AWANZ Receiving Discrepancy` visible on the warehouse desk. Resolve it with a reason
(`resolve_discrepancy`) — that is the audit trail, so resolve it honestly rather than deleting it.

**Nothing prints.** Confirm Chrome is running with `--kiosk-printing` (not just `--kiosk`), that a
default printer is set for that user, and that `auto_print_packing_list` is on. In the browser
console, `window.__awanzLastWallPrint` shows whether the job was dispatched at all — if it is
populated, the app did its part and the problem is the OS print queue.
