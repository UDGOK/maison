# AWANZ POS — v1.1 "Onboarding a product" (contract)

Read `SPEC.md` … `SPEC_v1.0.md`, `docs/purchasing.md` and `docs/shipping.md` first. Additive; keep
every suite green. Design system **Monolith Gold — no new design system**. New UI lives inside the
existing `/warehouse` sections. Internal package stays `maison_pos`; doctypes are `AWANZ *`;
`maison_` custom fieldnames on ERPNext doctypes are deliberate and unchanged.

## Why this release exists

v1.0 let Houston buy. Walking the client through "a brand-new product arrives, get it to the
stores" exposed three places where the touch screens dead-end into the branded desk, and one of
them is a genuine hole in the model:

1. **Houston cannot push stock to a store.** Every shipment begins with a store raising an
   `AWANZ Replenishment Request`. For a new product that is backwards — no store knows it exists,
   so none of them will ask, and the eleven managers would each have to be told to request it.
2. **A product cannot be created from the warehouse screens.** A rep shows the warehouse manager a
   new disposable and there is no way to add it without going to a laptop.
3. **A purchase order cannot be started from scratch.** Buying builds orders from the suggestion
   list only, so a one-off trial case of something with no reorder level has no path.

## Client decisions (locked — do not re-litigate)
1. **Buying stays centralised in Houston.** Nothing here lets a store buy or push to another store.
2. **A warehouse push is created and approved in one action.** The warehouse admin is both the
   requester and the approver, so a Pending step would be theatre — but the record must say plainly
   that Houston initiated it, and it must be told apart from a store's own request in every report.
3. **One shipment per store.** They are separate parcels with separate labels; do not batch.
4. **Never allocate stock Houston does not have.** Over-allocation is refused with the shortfall
   named per item — not silently trimmed.
5. **Creating a product is a purchasing-admin act.** Store managers and associates may not.

---

## A. Distribution — Houston pushes stock to stores

New `maison_pos/distribution.py` + `api/distribution.py`. Compose the **existing** parts: build the
request with `shipping.create_request` and approve it with `shipping.approve`. Do **not** write a
second shipment-creation path — the wall, the picking, the packing, the labels and the store's
Receive screen must all behave exactly as they do for a store-raised request.

New field on `AWANZ Replenishment Request`: `warehouse_push` (Check, default 0, read-only), set on
anything this module creates, so a push is distinguishable from a pull for ever.

**API**
- `plan(item_codes)` → for each item: HOU-WH on hand, already committed to open shipments, and a row
  per store carrying that store's current on-hand, its 28-day velocity, days of cover, and whether
  it has ever sold the item. This is what makes an allocation a decision rather than a guess.
- `send(lines, reason=None, priority="Normal")` where `lines = [{boutique, item_code, qty}]`.
  Groups by store, creates one request per store, approves each, returns
  `{shipments: [...], requests: [...], stores: n, units: n}`.
  Validate **before writing anything**: every store enabled, every item a stock item, every qty > 0,
  and the total per item at or under HOU-WH's available on hand. On failure raise with the shortfall
  named per item and write nothing at all — a half-sent distribution is worse than a refused one.
- `suggest_split(item_code, qty, mode)` → server-side allocation helpers so the maths is tested
  once rather than reimplemented in the sheet: `even` (equal across the chosen stores, remainder to
  the busiest), `velocity` (weighted by 28-day velocity, minimum one each), `topup` (bring every
  store up to a target days-of-cover).

Permissions: **AWANZ Warehouse Admin** and **AWANZ Head Office** only, proven both ways at the HTTP
level. A store manager calling `send` for their own store is still refused — pushing is Houston's.

## B. New product, from the warehouse

`api/purchasing.py::create_product(payload)` — one call, one sheet, everything a product needs
before it can be bought:

```
{item_code, item_name, item_group, uom?, barcode?, image?, selling_rate?,
 vendor: {supplier, vendor_sku?, cost?, case_pack?, moq?, lead_time_days?},
 reorder: {level, qty?}}
```

- creates the `Item` (stock item, the tenant company's defaults), sets `maison_barcode`
- writes the `AWANZ Item Vendor` row through `purchasing/vendors.py` so the vendor's buying price
  list is updated the same way an edit would
- marks that vendor preferred when it is the item's first
- sets the selling rate as a standard `Item Price` on the selling price list
- adds the `Item Reorder` row for the main warehouse
- **all or nothing**: if any step fails the item must not be left half-built

Refuse duplicates clearly: an existing `item_code`, and a `maison_barcode` already on another item
(that one is a real hazard — two products sharing a barcode means the till rings up the wrong one).
`assert_purchasing_admin()`. Return the full item payload plus the catalogue row.

Also `purchasing.item_groups()` → the groups a new product can be filed under, so the sheet does not
have to guess.

## C. Purchase order from scratch

No new backend — `purchasing.create_order(supplier, lines, …)` already does it. What is missing is
the way in. Add `purchasing.vendor_catalogue(supplier, search)` → that vendor's items with cost,
case pack, MOQ and last purchase rate, searchable by code, name or **their** SKU, so the buyer can
build an order by scanning or typing.

## D. Screens (inside `/warehouse` — Monolith Gold, touch-first, ≥48 px targets)

- **Stock → an item → "Send to stores"** opens the distribution sheet: the item, what Houston holds,
  and every enabled store as a row with its on-hand, cover days and a quantity box. Quick actions
  *Same to all* / *Split evenly* / *Weight by sales* / *Only stores that stock it* / *Clear*. A
  running footer: stores chosen, units, what is left at Houston after — turning red **before** the
  send if it would go negative. Send creates the shipments and drops them onto the wall; the
  confirmation names them.
- **Buying → "New product"** opens the create sheet: what it is (code, name, group, barcode — with a
  scan button, UOM), what we pay (vendor, their SKU, cost, case pack, MOQ, lead time), when to
  reorder (level, qty at HOU-WH), what it sells for. Saving offers **Order it now** as the next
  step, because that is always what happens next.
- **Buying → Orders → "New order"**: pick a vendor, then search or scan their catalogue, quantities
  default to a whole case, rates default from their price list and stay editable. Creates the draft
  and opens the existing `OrderSheet`.
- **Vendors → a vendor → "Order from this vendor"** — the same sheet, vendor pre-chosen.
- The distribution sheet must also be reachable from the **Inbound** receipt confirmation: the
  moment a new product is received, "Send to stores" is the obvious next act.

## E. Quality

Backend `FrappeTestCase`: a push creates one shipment per store and each is a normal shipment the
store can receive; `warehouse_push` is set and a store-raised request is unaffected;
over-allocation is refused with the shortfall named and **nothing written**; a disabled store is
refused; a store manager is refused both ways at HTTP level; the three split modes; `create_product`
builds item + vendor row + price list + reorder atomically, refuses a duplicate code and a duplicate
barcode, and leaves nothing behind when it fails.

Frontend vitest for the split maths as the sheet renders it, the "left at Houston" figure, and the
create-product form validation. Extend `e2e/purchasing.e2e.mjs` (or a sibling
`e2e/distribution.e2e.mjs`): create a product from the warehouse screen → order it from scratch →
receive it → send it to three stores → one store receives its shipment → HOU-WH and the store bins
both moved by the right amounts.

Docs: extend `docs/purchasing.md` (create a product, order from scratch) and `docs/shipping.md`
(the push, and how it differs from a store's pull). Update `README` + `CHANGELOG` (1.1.0) and bump
`maison_pos/__init__.py`, `frontend/package.json`, `dashboard/package.json`.

## Out of scope for v1.1 (record in docs, do not build)
Store-to-store transfers; automatic distribution of every new product without a human choosing;
allocation by forecast rather than by history; purchase-order approval workflows (Houston's buyer
is trusted, and a second pair of eyes is a v2 conversation).
