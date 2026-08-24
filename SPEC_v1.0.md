# AWANZ POS — v1.0 "Procurement" (contract)

Read SPEC.md … SPEC_v0.6.md and `docs/shipping.md` first. Additive; keep every suite green. Design system **Monolith Gold — no new design system**. All new UI lives inside the existing `/warehouse` desk (touch-first for floor work) or the branded Frappe desk (form-first for buying paperwork). Internal package stays `maison_pos`; doctypes are `AWANZ *`.

## Client decisions (locked — do not re-litigate)
1. **Costing: Moving Average.** Set `Company.default_valuation_method = "Moving Average"` on install/migrate for the tenant company, and on every stock Item. This is what makes "same product, two vendors, two costs" correct without a workaround.
2. **Known price lists, no RFQ.** Rates are negotiated per vendor and stored. No Request for Quotation, no supplier-quote comparison flow.
3. **Freight is manual**, entered by the warehouse manager per purchase order, and lands in item valuation.
4. **Every price is manually overridable** — purchase rate on any PO line, freight, and the receipt cost.
5. **Store selling price** is adjusted per store through the **existing** `AWANZ Price Change Request` + `AWANZ Price Approval` workflow → warehouse-scoped Pricing Rule. Do NOT build a second mechanism; wire the new screens to this one.
6. **Buying is centralised in Houston.** Stores never raise a purchase order. A store's need reaches a vendor only through the warehouse admin, either as stock shipped from HOU-WH or as a vendor drop-ship addressed to that store.

## A. Vendors
Use ERPNext **Supplier** as the vendor master. Add custom fields (prefix `maison_`, labels say AWANZ/vendor, never "Maison"):
`maison_lead_time_days` (Int), `maison_min_order_value` (Currency), `maison_dropship_capable` (Check), `maison_order_method` (Select: Email / Portal / Phone / EDI), `maison_portal_url` (Data), `maison_account_number` (Data — the number *they* know us by), `maison_rep_name`, `maison_rep_phone`, `maison_rep_email`, `maison_notes` (Small Text), `maison_active` (Check, default 1).

Each vendor gets its own **buying Price List** named `<Supplier> Buying`, created on first save (idempotent). Negotiated rates are `Item Price` rows on that list (`buying=1`, `supplier` set). A PO for that vendor defaults its rates from that list; **every rate stays editable on the line**.

API `api/purchasing.py`: `vendors(search, active_only)`, `vendor(name)` (profile + catalogue + open POs + last 10 receipts + spend 12 m), `save_vendor(payload)`, `set_vendor_active(name, active)`.

## B. Item ↔ vendor catalogue
New child table **`AWANZ Item Vendor`** on Item (field `maison_vendors`): `supplier` (Link Supplier), `vendor_sku` (Data), `case_pack` (Int, default 1), `moq` (Int), `cost` (Currency — the negotiated unit cost; mirrors/writes the vendor price list), `lead_time_days` (Int), `is_preferred` (Check), `last_purchase_date` (Date, read-only), `last_purchase_rate` (Currency, read-only), `notes`.

Rules: exactly one `is_preferred` per item (enforced in validate — setting a new one clears the rest); `cost` writes through to the vendor's Item Price so the PO picks it up; `last_purchase_*` are stamped on Purchase Receipt submit. A vendor row may exist with no cost (buy at whatever they quote that day).

API: `item_vendors(item_code)`, `save_item_vendor(item_code, row)`, `remove_item_vendor(item_code, row_name)`, `set_preferred_vendor(item_code, supplier)`.

## C. What to buy — the demand engine
`purchasing/demand.py` builds a suggestion list from three sources, deduped by item:
1. HOU-WH quantity at or below its reorder level (ERPNext Item Reorder for the main warehouse).
2. Open store replenishment requests the warehouse **cannot fill** from HOU-WH stock (the shortfall only).
3. Items flagged trending-up by `insights/trends.py` whose HOU-WH cover is under a configurable horizon.

Each suggestion carries: item, on-hand at HOU-WH, already on order (open PO qty), open store demand, suggested qty (rounded **up to the vendor's case pack**, never below MOQ), preferred vendor with cost/lead time, and the alternative vendors with their costs. Everything is editable before the buyer commits.

`AWANZ Purchase Suggestion` doctype caches a run (item, source, suggested_qty, supplier, cost, status Open/Ordered/Dismissed, run_id) so a buyer can work a list across a session. Scheduled daily 06:00 site time; also on demand.

API: `suggestions(refresh=0)`, `dismiss_suggestion(name, reason)`, `create_orders(lines)` → groups the chosen lines by supplier into one draft Purchase Order per supplier and returns their names.

## D. Purchase orders
Native **Purchase Order**, plus:
- Custom fields: `maison_dropship_store` (Link AWANZ Store — set on the PO when the whole order ships direct to a store), `maison_freight_amount` (Currency), `maison_source_request` (Link AWANZ Replenishment Request — the store ask that caused this buy).
- **Drop-ship** = set the PO's `set_warehouse` (and every line's `warehouse`) to that store's warehouse and stamp `maison_dropship_store`. Nothing else changes: the store's existing **Receive** screen already lists vendor POs addressed to it and posts the Purchase Receipt (`api/inventory.py::receive_purchase_order`), and a short/over count already raises an `AWANZ Receiving Discrepancy` to the warehouse admin. Validate on submit: a drop-ship PO's lines must all point at the same store warehouse, and that store must be enabled.
- **Freight**: `maison_freight_amount` maintains a single row in `taxes` — `charge_type = "Actual"`, `category = "Valuation"`, `add_deduct_tax = "Add"`, account = the company's freight/expenses-included-in-valuation account, `distribute_charges_based_on = "Amount"`. Setting it to 0 removes the row. That is what puts freight into moving-average cost without a Landed Cost Voucher.
- **Send**: `send_order(po, method)` — email the PO PDF to the vendor's rep (print format `AWANZ Purchase Order`), or mark it sent when ordered by phone/portal, stamping `maison_sent_on` / `maison_sent_by` / `maison_sent_method`.

API: `orders(status, supplier, store, from, to)`, `order(name)`, `create_order(supplier, lines, dropship_store=None, freight=0, source_request=None)`, `update_order(name, lines, freight)`, `submit_order(name)`, `send_order(name, method)`, `close_order(name, reason)`.

Permissions: **AWANZ Warehouse Admin** and **AWANZ Head Office** only. A store manager may *read* a PO addressed to their own store (so Receive works) and nothing else — prove it with an HTTP-level test both ways.

## E. Receiving at the warehouse
Extend the existing `/warehouse` **Inbound** area: expected POs (with vendor, ETA from lead time, lines), receive by scanning barcodes or tapping counts, per-line received/short/over/damaged, **an editable unit cost per line** (the manual override — defaults to the PO rate), optional freight adjustment at receipt, then submit → Purchase Receipt. Short/over raises `AWANZ Receiving Discrepancy` against the vendor (new `supplier` field on that doctype, nullable so store-shipment discrepancies still work). Damaged goes to the Damaged warehouse. Stamp `last_purchase_date` / `last_purchase_rate` on the item-vendor row.

`AWANZ Shipment` gains `source_purchase_order` so "arrived from vendor → shipped on to store" is traceable end to end.

## F. Screens (inside the existing warehouse area — Monolith Gold, no new system)
Add a section nav to `/warehouse`: **Outbound** (today's board, unchanged) · **Inbound** · **Buying** · **Vendors** · **Stock**.
- **Stock** — HOU-WH on hand: item, qty, value at moving average, cover days, on order, reorder level; search and group filter; low-stock first.
- **Vendors** — list with spend and on-time %, open a vendor for profile, catalogue (their items, SKU, cost, case pack, MOQ, preferred flag), open POs, recent receipts. Add and edit a vendor. Deactivate rather than delete.
- **Buying** — the suggestion list (source badge: Low stock / Store demand / Trending), editable quantity and vendor per line with the alternatives visible, "Create orders" grouping by vendor; then the order list with status, and an order detail where every rate and the freight are editable before submit and send. A "Drop-ship to store" control on the order.
- **Inbound** — expected, receive-by-scan, discrepancies.
- Wall board gains an **Inbound** column so the floor sees what is arriving.

Touch-first: ≥48 px targets, scan-driven, one-handed on the phone layout. Buying paperwork remains available in the branded desk for anything the touch screens don't cover.

## G. Reports
`AWANZ Purchase by Vendor` (spend, orders, units, average lead time, on-time %), `AWANZ Item Purchase History` (every receipt of an item: date, vendor, qty, unit cost, freight share, landed cost — so the buyer can see the cost drift moving average is averaging), `AWANZ Open Purchase Orders` (with ageing and expected date), `AWANZ Drop-ship Deliveries` (by store, with receipt status and discrepancies). All registered in `api/reports.py::REPORTS` so CSV export works, and linked from the dashboard Reports section.

## H. Seed
Extend the CloudChaserz seed: ~12 realistic vendors (distributors and brand-direct), each with a buying price list; item-vendor rows for the 160 items — most with two vendors at different costs so moving average is visibly exercised, one preferred; reorder levels at HOU-WH; a handful of historical Purchase Orders and Receipts at varying costs so the reports and the cost-drift view have data; two open POs (one normal, one drop-ship to OK-BA). Keep it inside `setup/cloudchaserz/` and idempotent.

## Quality
Backend `FrappeTestCase` per section, including: moving-average valuation across two vendors at different costs; freight raising landed cost; case-pack rounding and MOQ; one-preferred-vendor enforcement; drop-ship PO validation and the store receiving it; a store manager blocked from purchasing endpoints both ways; suggestion dedup across the three sources. Frontend vitest for the suggestion table maths and the order editor. An e2e `e2e/purchasing.e2e.mjs`: suggestion → create PO → override a rate → add freight → submit → send → receive at HOU-WH by scan with a short line → discrepancy raised → moving-average cost moved as expected; plus a drop-ship PO received at the store. Docs `docs/purchasing.md` (vendors, price lists, freight, drop-ship, who may do what, and the deliberate choice not to do RFQ or invoice matching). Update README + CHANGELOG (1.0.0).

## Explicitly out of scope for v1.0 (record in docs, do not build)
Request for Quotation and quote comparison; three-way invoice matching and AP (purchase invoices stay in the client's accounting package for now); Landed Cost Voucher (freight is on the PO); EDI; vendor portals; store-initiated purchasing.
