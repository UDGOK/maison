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
                              Maison Shipment (Pending)
                              → Pick   (pick list, bins)
                              → Packed (parcels, weight)
                              → Buy label (rate shopping)
                              → Ship   ──────────────────────────────→  scan / count
                                                                        Confirm receipt
```

Documents created along the way:

| Step | Document |
|---|---|
| Manager requests | `Maison Replenishment Request` + draft **Material Request** (type *Material Transfer*, `HOU-WH` → store) |
| Warehouse approves | `Maison Shipment` (+ `Maison Shipment Line`), Pick List |
| Ship | **Stock Entry** — Material Transfer `HOU-WH` → `<code> In Transit` |
| Store confirms receipt | **Stock Entry** — Material Transfer `<code> In Transit` → `<code>` (and → `<code> Damaged` for damaged units) |
| Short / over / damaged | `Maison Receiving Discrepancy` (one per line) for the warehouse admin |

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
**Maison Warehouse Admin** may approve, pick, buy a label or ship. `e2e/cloudchaserz.e2e.mjs`
asserts the 403s over plain HTTP.

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
3. Set `shipping_provider` to `Shippo` in **Maison POS Settings**.
4. Fill the ship-from block in the same settings (`ship_from_name`, `ship_from_street1`,
   `ship_from_city`, `ship_from_state`, `ship_from_zip`, `ship_from_phone`, `ship_from_email`).
   The ship-to address comes from each `Maison Boutique`.

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
| **Packing list** | `Maison Packing List` print format — store ship-to, lines with barcodes, carton count, weight, a QR of the shipment | ordinary A4 / Letter laser |
| **Carrier label** | the PDF the carrier returns (`label_url`) | 4×6 thermal label printer (Zebra / Rollo / DYMO) |

### Automatic printing from the wall

The wall page (`/warehouse-wall`) prints without anyone touching a dialog:

* when a shipment becomes **Approved** it prints the packing list,
* when a label is bought (**Ready to ship**) it prints the label.

Both go through `frontend/src/warehouse/print.ts`, which loads the document into a hidden iframe
and calls `contentWindow.print()`. Every job is recorded on `window.__maisonLastWallPrint` (and a
`maison-wall-print` event fires) — that is what `e2e/warehouse.e2e.mjs` asserts, so the behaviour is
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
raises a `Maison Receiving Discrepancy` visible on the warehouse desk. Resolve it with a reason
(`resolve_discrepancy`) — that is the audit trail, so resolve it honestly rather than deleting it.

**Nothing prints.** Confirm Chrome is running with `--kiosk-printing` (not just `--kiosk`), that a
default printer is set for that user, and that `auto_print_packing_list` is on. In the browser
console, `window.__maisonLastWallPrint` shows whether the job was dispatched at all — if it is
populated, the app did its part and the problem is the OS print queue.
