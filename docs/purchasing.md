# Purchasing (v1.0 "Procurement")

Buying is **centralised in Houston**. Stores never raise a purchase order; a store's need reaches
a vendor only through the warehouse admin — either as stock shipped from `HOU-WH`, or as a vendor
**drop-ship** addressed to that store. This document covers the loop as a warehouse manager
works it (§1), then the vendor master, the price lists, freight, drop-ship, the screens, who may
do what, and the things v1.0 deliberately does *not* do.

Related: `docs/shipping.md` (warehouse → store), `docs/cloudchaserz.md` (stores, roles),
`SPEC_v1.0.md`.

---

## 1. A day in the warehouse

This section is the loop itself, in the order a warehouse manager works it. Everything it
describes lives at **`/warehouse`**; nothing here needs the Frappe desk.

### Morning: work the buying list

Sign in and open **`/warehouse` → Buying**. The **Suggest** tab is the buying list, rebuilt
overnight at 06:00 — the header says when ("List built …"), and **Refresh** rebuilds it now.

Every row is one item, with a badge saying why it is there:

* **Low stock** — Houston is at or under its reorder level for that item.
* **Store demand** — a store asked for it and the warehouse has not got it to send.
* **Trending** — it is selling faster than usual chain-wide and Houston's cover is thin.

An item that qualifies on more than one count appears **once**, badged with the most urgent
reason, quantified for the largest of the three needs. Read the row left to right: **On hand**,
**On order** (already coming), **Store demand** (what stores are waiting for), **Reorder at**, and
**Cover** in days.

Then decide, per row:

* **Quantity.** The suggested figure is already rounded up to the vendor's case pack and lifted to
  their MOQ. − and + move it **one case at a time**, and typing a number snaps up to the next whole
  case. You will not accidentally order 7 of something sold in 12s.
* **Vendor.** The preferred vendor is selected and marked *Preferred*; the alternatives sit beside
  it with **their** cost, so the choice between "$4.10 from the distributor" and "$3.85 direct, ten
  days" is in front of you. Tap one and the row's cost follows it.
* **Not this week.** **Dismiss** takes the row off the list for 14 days and asks why. It is not a
  deletion — if the item is still short in a fortnight it comes back.

Tick the rows you want. The footer keeps a running **Selected / Units / Value**. If the whole lot
is going **direct from the vendor to one store**, pick that store in *Deliver to* before you
create — the footer warns you in words ("The whole order goes to OK-BA, not Houston"). Then
**Create orders**, which groups what you ticked **by vendor** and makes one **draft** order each.
Nothing has been sent to anybody yet.

### Then: finish each order

Open a draft from the banner, or from the **Orders** tab. On the order sheet:

* **Every unit rate is editable.** The rate arrives from the vendor's negotiated price list; type
  over it when the rep quoted something else. Amounts and the landed total follow as you type.
* **Freight** goes in *Freight on this order*, by hand, as one number for the delivery. There is
  no carrier lookup here — you type what the vendor or the freight company told you. The sheet
  shows *Freight per unit* beside it as a sanity check, and *Landed total* = net + freight.
  Setting it to **0** removes the charge.
* **Deliver to** is Houston or a drop-ship store, changeable while the order is a draft.
* **Save** first, then **Submit order**. Submitting is what tells ERPNext this stock is on order —
  it is the number the buying list reads as "On order" tomorrow morning.
* **Send** the order. *Email* attaches the `AWANZ Purchase Order` PDF and sends it to the rep on
  the vendor profile (override the address for a one-off). If you rang them instead, choose
  *Phone* — the order is stamped as sent, by whom, when and how, which is what the follow-up in
  three days' time is based on. If the site has no mail set up, the sheet tells you the order was
  stamped but no e-mail left.

A draft you no longer want is **deleted**, and its items go back on the buying list. A **submitted**
order is **closed**, never deleted — the vendor has it, and it may already have receipts.

### When it arrives: receive it

**`/warehouse` → Inbound** lists what is expected, oldest first, with the vendor, the ETA from
their lead time, units expected, what has already been received and the freight on the order. Scan
a barcode into *Scan barcode to open a delivery* and it opens the right one.

On the receive sheet, per line: **Received**, **Damaged**, and the **Unit cost**, which starts at
the order's rate and is yours to change. Change it when the invoice on the pallet says something
else — that is the whole point of the field, and it is the number that goes into the item's
average cost. Beside each line the sheet previews the **moving average** the posting will produce,
freight included, so a cost you did not expect is visible *before* you post it.

Scanning a barcode adds one to that line's count; the − and + buttons and the keypad do the same
thing by hand. **All as expected** fills every line with what is outstanding, which is the common
case — then correct the one or two lines that are wrong.

At the bottom:

* **Freight on this receipt** — leave it as the order's figure, or change it if the actual freight
  came in differently. It is shared across the lines by value (§6).
* **This is the whole delivery** — the toggle that ends the order. Off (the default) means "more is
  coming": what is missing stays on order and nothing is raised. On means "that was the lot": the
  order is **closed** and anything still outstanding becomes a **Short** discrepancy against the
  vendor (§9).
* **Notes** — anything the driver said.

Post it. If you counted **more** than was ordered, or turned *whole delivery* on with units
still outstanding, the sheet asks you to confirm once first — those are the two ways to make a
mess a second receipt cannot undo.

Once it posts, the sheet tells you what was booked, line by line, and names any discrepancy it
raised. Damaged units are booked too, into the receiving warehouse's Damaged shelf: in stock,
not sellable.

### Dealing with a short

You ordered 24, 18 turned up, and the driver says that is all there is. Count 18, turn **This is
the whole delivery** on, post. Three things happen:

1. the 18 go into stock at the cost you entered;
2. an `AWANZ Receiving Discrepancy` of type **Short**, quantity 6, is raised **against the
   vendor** — it appears under *Open vendor discrepancies* on the Inbound tab, not on any store's
   queue;
3. the order is **closed**, so it stops appearing as expected.

If instead the missing 6 are following next week, leave the toggle **off**. Nothing is raised, the
order stays open for 6, and you receive again when they arrive.

A vendor discrepancy is settled by talking to the vendor and then resolving it **Accepted** (they
credited us, or shipped it) or **Write off** (we are eating it). There is no return leg to post:
unlike a store shipment, the goods never left our building.

---

## 2. Costing: Moving Average

Every stock item is valued at **Moving Average**. That is what makes "same product, two vendors,
two costs" correct without a workaround: buy 10 at $10.00 from vendor A and 10 at $14.00 from
vendor B and the warehouse's cost per unit becomes $12.00, not whichever queue FIFO happens to
pop.

`maison_pos.purchasing.ensure_moving_average()` runs on every install and migrate and is
idempotent. It pins:

| Where | Why |
|---|---|
| `Stock Settings.valuation_method = "Moving Average"` | ERPNext v15's site-wide default; new items inherit it |
| `Item.valuation_method = "Moving Average"` on every stock item | so each item says so on its own form, whatever the setting later becomes |

> **Deviation from the contract, deliberate.** SPEC_v1.0 says "set
> `Company.default_valuation_method`". **There is no such field in ERPNext v15** — valuation is
> resolved as `Item.valuation_method or Stock Settings.valuation_method or "FIFO"`
> (`erpnext.stock.utils.get_valuation_method`). Pinning both places above is the same intent, and
> is stronger: every existing item is set explicitly, not just the default for new ones. The
> per-item write goes through `frappe.db.set_value` on purpose — ERPNext's `Item.validate` refuses
> to change a valuation method once the item has stock ledger entries, and this is a chain-wide
> policy decision, not a per-item one.

`AWANZ Item Purchase History` prints the drift the average is averaging: every receipt of an item
with its unit cost, freight share, landed cost, the valuation it produced and the running average.

---

## 3. Vendors

The vendor master is ERPNext **Supplier** plus `maison_*` fields:

| Field | Meaning |
|---|---|
| `maison_lead_time_days` | quoted lead time; seeds the PO's expected date |
| `maison_min_order_value` | their minimum order value (shown to the buyer, not enforced) |
| `maison_dropship_capable` | will ship direct to a store |
| `maison_order_method` | Email / Portal / Phone / EDI — how we place orders with them |
| `maison_portal_url` | their B2B portal |
| `maison_account_number` | **the number they know us by**; it prints on the PO |
| `maison_rep_name` / `_phone` / `_email` | the human who answers |
| `maison_notes` | anything the buyer needs to remember |
| `maison_active` | deactivate rather than delete; `disabled` follows it |

Deactivating a vendor keeps every order, receipt and cost they are attached to. Nothing in
purchasing deletes a vendor.

### Their price list

Each vendor owns a buying price list named **`<Supplier> Buying`**, created on the vendor's first
save (a `Supplier` doc event, so it also happens for a vendor typed straight into the desk).
Negotiated rates are ordinary `Item Price` rows on that list with `buying = 1` and `supplier` set.

A Purchase Order for that vendor defaults `buying_price_list` to their list, so line rates come
from what was negotiated with **that** vendor — and **every rate stays editable on the line**.

---

## 4. The item ↔ vendor catalogue

`AWANZ Item Vendor` is a child table on Item (`Item.maison_vendors`): vendor, their SKU, case
pack, MOQ, negotiated cost, lead time, preferred flag, and the read-only `last_purchase_date` /
`last_purchase_rate` stamped when a receipt is submitted.

Rules, enforced in `maison_pos.purchasing.vendors`:

* **exactly one preferred vendor per item.** Ticking a new one clears the rest; if none is ticked,
  the first row becomes preferred, so the demand engine is never ambiguous.
* **`cost` writes through** to that vendor's `Item Price` on save, which is how the PO picks it up.
* a vendor row **may carry no cost** ("buy at whatever they quote that day") — the price row is
  removed and the PO falls back to the item's last purchase rate.

---

## 5. What to buy

`maison_pos/purchasing/demand.py` builds the buying list from three sources, deduped by item:

| Source | Rule |
|---|---|
| **Low stock** | HOU-WH quantity at or below its `Item Reorder` level for the main warehouse |
| **Store demand** | open store replenishment requests the warehouse **cannot fill** from HOU-WH stock — the shortfall only |
| **Trending** | items `insights/trends.py` flags *Trending up* chain-wide whose HOU-WH cover is under `AWANZ POS Settings.purchase_cover_days` (default 21 days) |

An item in more than one source is bought once, for the **largest** of the three needs, less what
is already on order, rounded **up to the preferred vendor's case pack** and never below their MOQ.
The badge shown is the most urgent source; all of them are listed.

A run is cached in `AWANZ Purchase Suggestion` (`Open` → `Ordered` / `Dismissed`) so a buyer can
work the list across a session. It is rebuilt every morning at **06:00 site time**
(`maison_pos.purchasing.demand.daily_run`) and on demand with `suggestions(refresh=1)`. An item
the buyer dismisses stays off the list for 14 days.

Everything is editable before the buyer commits: quantity, vendor (the alternatives and their
costs are on the row) and rate. "Create orders" groups the chosen lines by vendor into **one draft
Purchase Order per vendor**.

---

## 6. Freight

Freight is **manual**, entered per order by the warehouse manager, and it lands in item valuation.

`Purchase Order.maison_freight_amount` maintains exactly one row in `taxes`:

```
charge_type    = Actual
category       = Valuation
add_deduct_tax = Add
account_head   = the company's freight / valuation account (see below)
description    = "Freight (AWANZ)"
```

Setting the amount to **0 removes the row**. The row is maintained from a `before_validate` doc
event, so it works the same whether the order is edited on the Buying screen or in the desk, and
ERPNext's own totals calculation sees it.

Because the charge is *Valuation*, it never touches the payable total — it is added to the cost of
the goods. ERPNext distributes an **Actual valuation charge across the lines in proportion to net
amount** (`erpnext.controllers.taxes_and_totals.get_current_tax_amount`), which is the
"distributed on Amount" the contract asks for.

> **Deviation from the contract, cosmetic.** `distribute_charges_based_on` is a **Landed Cost
> Voucher** field; it does not exist on `Purchase Taxes and Charges` in ERPNext v15. The behaviour
> it names is what ERPNext already does for an Actual valuation charge, so the row is written
> without it (and *with* it on any site that has added it as a custom field).

### How freight is split across the lines — read this before you change anything

**An Actual + Valuation charge is distributed by line amount, not evenly per unit.** This is the
one thing in purchasing a maintainer is most likely to get wrong, because "spread the freight over
the units" is the intuitive reading and it is not what posts.

ERPNext walks the lines and gives each one
`charge × (line net amount ÷ total net amount)`
(`erpnext.controllers.taxes_and_totals.get_current_tax_amount`, applied to valuation in
`buying_controller.update_valuation_rate`). A cheap line and an expensive line on the same pallet
do **not** carry the same freight.

The worked example is the one the e2e drives, and it is pinned as a test in
`frontend/src/tests/inbound_stock.test.ts` ("v1.0 e2e defects"):

| Line | Qty | Rate | Amount | Freight allocated | Per unit |
|---|---:|---:|---:|---:|---:|
| the cheap one | 12 | $6.05 | $72.60 | **$8.91** | $0.7426 |
| the dear one | 4 | $73.50 | $294.00 | **$36.09** | $9.0221 |
| | **16** | | **$366.60** | **$45.00** | |

$45 × 72.60/366.60 = $8.91 and $45 × 294.00/366.60 = $36.09. Split evenly per unit instead, every
unit of both lines would carry **$2.8125** — so the cheap line would take 12 × $2.8125 = $33.75
(nearly four times its share) and the dear line 4 × $2.8125 = $11.25 (under a third of its
share). The total still comes to $45 either way, which is exactly why the mistake is easy to
miss: it only shows up per item, in the valuation.

`frontend/src/warehouse/buying.ts::freightAllocation` mirrors the server's rule **on purpose**, so
the receive sheet's moving-average preview is the move that actually posts.
`freightShareForLine` divides one line's allocation by its quantity and hands that to
`movingAverageAfter`. Before v1.0 shipped, `warehouse/inbound.ts` split evenly per unit and the
preview on exactly the receipt above was ~7 % away from what the bench booked — a number a
manager was making decisions on. These two functions exist to mirror the server; if ERPNext's
distribution ever changes, they change with it, and `inbound_stock.test.ts` is where that gets
proved.

The blunt per-unit figure survives as **`freightSharePerUnit`**, and it is fine where it is used:
the order sheet's headline "freight per unit", a rough "about $2.81 a unit" for a buyer sizing up
a delivery. It is identical to the by-amount allocation only when every line carries the same
rate. Never feed it into a valuation preview.

Two more things that follow from the charge living on the document:

* the freight on a **receipt** is spread over **that receipt's** lines, not the whole order. On a
  full delivery the two agree; on a partial receipt they must not be confused.
* when every line amount is zero (a free-of-charge delivery), there is nothing to weight by, so
  `freightAllocation` falls back to a per-unit split rather than dividing by zero.

### Which account

`maison_pos.purchasing.freight_account(company)` resolves, in order:

1. **`Company.expenses_included_in_valuation`** — the account ERPNext creates for exactly this
   purpose (account type *Expenses Included In Valuation*) and the one its own Landed Cost Voucher
   posts to. On both seeded companies that is `Expenses Included In Valuation - <ABBR>`.
2. any account of that type belonging to the company;
3. failing both, a `Freight & Valuation Charges` leaf created under *Stock Expenses*, of the same
   account type, and pinned on the company.

Under perpetual inventory a Valuation charge is debited to stock and credited to this account, so
it nets to zero over the life of the goods — which is what "capitalised freight" means.

**Not** `Freight and Forwarding Charges`: that is an Indirect Expense head for freight that is
*not* capitalised. Using it for a valuation charge would misstate both the P&L and stock value.

---

## 7. Purchase orders

Native ERPNext **Purchase Order**, plus `maison_dropship_store`, `maison_freight_amount`,
`maison_source_request` and the `maison_sent_on` / `_by` / `_method` stamps.

Lifecycle: `create_order` → edit (rates, freight, destination) → `submit_order` → `send_order`
→ receive → `close_order` if the vendor cannot finish it.

**A draft's terminal action is Delete.** `close_order` is ERPNext's `update_status("Closed")`,
which needs `docstatus == 1` — so a draft the buyer no longer wants has nothing to end it.
`delete_order(name, reason)` deletes a **draft only** and releases everything pointing at it
first: every `AWANZ Purchase Suggestion` that this order flipped to *Ordered* goes back to *Open*
with the order cleared off it, so the item returns to the buying list rather than quietly falling
out of it. It answers `{"deleted": …, "suggestions_reopened": [...]}`, and it refuses a submitted
order — that one is **closed**, because the vendor already has it and it may carry receipts.

**Send.** `send_order(name, method)` mails the `AWANZ Purchase Order` PDF to the vendor's rep
(method *Email*) or simply records that it was ordered by *Phone* / *Portal* / *EDI*. Either way
the order carries who sent it, when and how. With no outgoing e-mail account configured the order
is still stamped and the response carries a `warning` — it never silently claims to have e-mailed.

**Every price is manually overridable** — the PO line rate, the freight, and the receipt unit cost.
Which means ERPNext's *Maintain Same Rate Throughout the Purchase Cycle* has to be off, and
`setup/install_v10_purchasing.ensure_buying_settings()` turns it off (idempotently). Without that,
a receipt at a different cost from the order is refused outright, and the whole point of the
override — the vendor charged something else on the day — cannot be recorded. The drift is not
lost: it lands in moving-average cost and prints in `AWANZ Item Purchase History`.

---

## 8. Drop-ship

A drop-ship order ships **straight from the vendor to one store**. Mechanically it is just a
Purchase Order whose `set_warehouse` and every line's `warehouse` are that store's warehouse, with
`maison_dropship_store` stamped on the header.

Nothing else changes, and that is the point: **the store's existing Receive screen already lists
vendor POs addressed to it** (`inventory.inbound`) and posts the Purchase Receipt
(`inventory.receive_po`). v1.0 did not build a second receiving path.

The destination is chosen when the order is raised (`create_order(..., dropship_store=…)`) and
changed afterwards on a **draft** with `update_order(name, dropship_store=…)` — which is what the
Buying screen's "Drop-ship to store" control calls. Passing `null` / `""` clears the drop-ship and
moves the header *and* every line back to `HOU-WH`; both paths resolve the destination through the
same `purchasing.orders.destination_warehouse`, so they cannot drift apart. On a **submitted**
order the destination is fixed: it is on paperwork the vendor already has, and ERPNext has booked
the ordered quantity against that warehouse — close it and raise a new order instead.

Guard rails:

* setting `maison_dropship_store` forces the header and every line to that store's warehouse;
* clearing it moves them back to the main Houston warehouse — leaving them on a store warehouse
  would simply make the next save stamp the order as a drop-ship again (the rule below);
* an order raised in the desk whose warehouse *is* a store warehouse is stamped as drop-ship
  automatically, so it shows up on that store's Receive screen;
* **on submit**, every line must point at that one store's warehouse and the store must be
  enabled — otherwise the order is refused;
* a store manager may read only an order addressed to **their** store (§11).

`AWANZ Shipment.source_purchase_order` closes the other half of the loop: stock that arrived from
a vendor and was then shipped on to a store is traceable end to end.

---

## 9. Receiving

One code path — `maison_pos/purchasing/receiving.py` — serves both doors:

| Door | Endpoint |
|---|---|
| HOU-WH receives from a vendor | `purchasing.receive` (= `shipping.receive_vendor_po`) |
| A store receives a drop-ship | `inventory.receive_po` |

Per line: received, damaged, and **an editable unit cost** that defaults to the PO rate. Optional
freight adjustment at receipt. Then submit → **Purchase Receipt**.

* **Damaged** units are booked as the receipt's *rejected* quantity into the receiving store's
  `<code> Damaged` warehouse, so they are in stock but not sellable.
* **Short / over / damaged** raise an `AWANZ Receiving Discrepancy` **against the vendor** — the
  doctype gained a nullable `supplier` (plus `purchase_order` / `purchase_receipt`), and `shipment`
  became nullable so both kinds of discrepancy live in the same queue.
* `final = 1` means "that is the whole delivery" and turns whatever is still outstanding into a
  *Short*. Vendor orders routinely arrive in parts, so the **default is a partial receipt that
  raises nothing** — call it again as the rest arrives.
* An **over**-delivery is booked only as far as ERPNext's over-receipt allowance permits; the
  excess is recorded on the discrepancy rather than forced into stock.
* A vendor discrepancy can be resolved *Accepted* or *Write off* only — there is no in-transit leg
  to send back, the conversation is with the vendor.
* On submit, `last_purchase_date` / `last_purchase_rate` are stamped on the item-vendor row.

### What `final` does

`final = 1` is the *This is the whole delivery* toggle, and it does **two** things:

1. **It closes the order** (`_close_if_final` → `update_status("Closed")`, as Administrator), so
   the order stops appearing on Inbound as still expected.
2. **It raises a Short discrepancy** against the vendor for everything still outstanding on every
   ordered line — including lines nobody counted, which is why the plan is built from the order's
   lines and not only from what was sent up.

Both, or neither. Closing without raising the shorts loses the claim against the vendor; raising
the shorts without closing leaves a settled delivery sitting on the expected list. The first
version of `receive_purchase_order` did the second half only, and `e2e/purchasing.e2e.mjs` caught
it: the toggle's own copy and `receiveOutcome`'s message both promised the order would close, and
it did not. Left in, every finished order would have stayed on Inbound for ever and the expected
list would only ever have grown.

**A fully received order still has to be closed here.** It is tempting to assume ERPNext will
finish the order itself once everything has arrived — it will not, in *this* system. ERPNext marks
a Purchase Order *Completed* only when `per_received >= 100` **and** `per_billed == 100`
(`erpnext/controllers/status_updater.py`). We do not bill in AWANZ — purchase invoices stay in the
client's accounting package, by decision — so `per_billed` never leaves 0 and a fully received
order rests at **To Bill** indefinitely. `final` is the only thing that ends it.

Closing is deliberately forgiving: it never fails the receipt. If `update_status` throws, the
traceback is logged and the receipt still stands — stock that has physically arrived must be in
the system whatever the paperwork does. An order already *Closed*, *Completed* or *Cancelled* is
left alone, and the response's `closed` flag says what actually happened, which is what the screen
reads before it claims anything.

Vendor orders routinely arrive in parts, so the **default is `final = 0`**: a partial receipt that
raises nothing, leaves the balance on order, and can be called again as the rest turns up.

---

## 10. The warehouse desk: five sections, and the old links

`/warehouse` is one Vue view (`warehouse/views/WarehouseDesk.vue`) with a section nav across the
top. Monolith Gold, ≥48 px targets, the same bundle as the POS.

| Section | What it is | Badge |
|---|---|---|
| **Outbound** | the v0.6 board, unchanged — store replenishment: Requests · Shipments · Discrepancies, now as sub-tabs | requests waiting for approval |
| **Inbound** | vendor deliveries expected at HOU-WH, receive-by-scan, and the open vendor discrepancies | deliveries expected |
| **Buying** | Suggest (the demand engine) and Orders (the purchase orders, and one order in full) | open suggestions |
| **Vendors** | the vendor list with spend and on-time %, and a vendor's profile, catalogue, open orders and recent receipts | — |
| **Stock** | HOU-WH on hand: qty, value at moving average, cover days, on order, reorder level; low first | items under their reorder level |

The 1920×1080 wall (`/warehouse-wall`) gains a third column, **Inbound**, built from the same
`purchasing.inbound()` payload, so the floor can see what is arriving without asking.

### Legacy routes

The v0.6 desk had a flat tab strip, and there are bookmarks, role home pages and e2e specs
pointing at those keys. **They all still work.** `resolveTab` in `warehouse/inbound.ts` owns the
mapping and is the only place that knows it:

| `/warehouse/<key>` | Resolves to | URL rewritten? |
|---|---|---|
| *(nothing)* | Outbound · Requests | no |
| `requests` · `shipments` · `discrepancies` | Outbound, with that board selected | **no** — a deep link to one Outbound board keeps working |
| `stock` | Stock | no |
| `outbound` · `inbound` · `buying` · `vendors` | themselves | no |
| **`vendor`** | **Inbound** | **yes** → `/warehouse/inbound` |
| anything else | Outbound · Requests | yes → `/warehouse/outbound` |

`vendor` is the one retired key. The v0.6 "Vendor POs" tab did two jobs; v1.0 split them —
receiving is **Inbound**, ordering is **Buying** — so the old key resolves to the receiving half,
which is what a warehouse user following an old link was almost certainly after, and the address
bar is corrected so the bookmark self-heals.

Going the other way, `tabKeyFor(section, outbound)` writes Outbound's **sub-tab** key back to the
URL rather than the word "outbound", which is why `/warehouse/shipments` still means in v1.0
exactly what it meant in v0.6.

The mapping is exhaustively tested (`frontend/src/tests/inbound_stock.test.ts`), including the
rule that a rewrite always lands somewhere that does not rewrite again.

---

## 11. Who may do what

| | Warehouse Admin | Head Office | Regional | Store Manager | Associate |
|---|---|---|---|---|---|
| Vendors: list, open, add, edit, deactivate | ✅ | ✅ | ❌ | ❌ | ❌ |
| Item ↔ vendor catalogue (costs) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Buying suggestions | ✅ | ✅ | ❌ | ❌ | ❌ |
| Create / edit / submit / send / close / delete a PO | ✅ | ✅ | ❌ | ❌ | ❌ |
| List purchase orders | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Read one PO addressed to their own store** | ✅ | ✅ | ❌ | ✅ | ❌ |
| Receive at HOU-WH | ✅ | ✅ | ❌ | ❌ | ❌ |
| Receive a drop-ship at their own store | ✅ | ✅ | ❌ | ✅ | ✅ |
| Buying reports (`AWANZ Purchase by Vendor`, …) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Request a store selling-price change | — | ✅ | ✅ | ✅ | ❌ |
| Approve a store selling-price change | ❌ | ✅ | ✅ | ❌ | ❌ |

`AWANZ Regional` is unrestricted almost everywhere else in the product; it is **not** on the
purchasing list on purpose — a regional manager reads the chain's numbers, they do not spend its
money. Buying is centralised in Houston.

Enforced in three independent places, so a gap in one does not open the door:

1. `maison_pos.scoping.assert_purchasing_admin()` on every purchasing endpoint;
2. `permission_query_conditions` on `AWANZ Purchase Suggestion` and `AWANZ Item Vendor`, and the
   v0.6 `Purchase Order` / `Purchase Receipt` warehouse narrowing, for the generic REST surface;
3. `Custom DocPerm` — the purchasing roles get write on Purchase Order / Supplier / Item Price;
   store roles keep read-only Purchase Order from v0.6.

Both directions are proved over HTTP in `maison_pos/tests/test_v1_0_purchasing_http.py`.

One residual, recorded honestly: a store manager holds ERPNext's `Stock User` role (they need it
to count and transfer stock), and `Stock User` has standard read on **Supplier**, so vendor
*names* are listable through the REST API. What we *pay* is not: buying `Item Price` rows, the
`AWANZ Item Vendor` catalogue and the suggestion list all refuse them.

### Store selling price

The store selling-price override goes through the **existing** `AWANZ Price Change Request` +
`AWANZ Price Approval` workflow → warehouse-scoped Pricing Rule, unchanged since v0.1. v1.0 adds
no second mechanism; it only exposes that workflow to the new screens as
`purchasing.price_change_requests` / `.request_price_change` / `.approve_price_change`.

---

## 12. API surface

`maison_pos.api.purchasing.*`

| Method | What |
|---|---|
| `vendors(search, active_only)` / `vendor(name)` | the Vendors screen: list with 12-month spend and on-time %, then profile + catalogue + open POs + last 10 receipts |
| `save_vendor(payload)` / `set_vendor_active(name, active)` | add / edit; deactivate rather than delete |
| `item_vendors(item_code)` / `save_item_vendor(item_code, row)` / `remove_item_vendor(item_code, row_name)` / `set_preferred_vendor(item_code, supplier)` | the item ↔ vendor catalogue. `vendor(name).catalogue` rows carry the same `name`, so the Vendors screen removes a line straight from the catalogue without an `item_vendors()` round trip per row |
| `suggestions(refresh)` / `dismiss_suggestion(name, reason)` / `create_orders(lines)` | the buying list, and one draft PO per vendor |
| `orders(status, supplier, store, from, to)` / `order(name)` | the order list and one order in full. Every list row carries its `units` — the lines themselves are left off, but counting them is cheap and the list has a units column |
| `create_order(supplier, lines, dropship_store, freight, source_request)` | draft order |
| `update_order(name, lines, freight, dropship_store)` / `submit_order(name)` | edit every rate, the freight and the drop-ship destination, then submit. `dropship_store` left out leaves the destination alone; `null` / `""` clears it back to `HOU-WH`; draft only |
| `send_order(name, method)` / `close_order(name, reason)` | e-mail the PDF or record a phone / portal order; close what will not arrive |
| `delete_order(name, reason)` | bin a **draft** nobody wants (Close needs a submitted order) and put its suggestions back on the buying list |
| `inbound(warehouse)` / `receive(po, lines, freight, final, notes)` | the warehouse **Inbound** area |
| `stock(q, limit)` | HOU-WH on hand: qty, value at moving average, cover days, on order, reorder level |
| `price_change_requests` / `request_price_change` / `approve_price_change` | the **existing** store-price workflow |
| `item_groups()` | v1.1 — the groups a new product can be filed under, with how many items each already holds, so the create sheet does not have to guess |
| `create_product(payload)` | v1.1 — one call, one sheet: Item + vendor row + vendor price list + selling price + reorder level, **atomically** |
| `vendor_catalogue(supplier, search, limit)` | v1.1 — that vendor's items with cost, case pack, MOQ and last purchase rate, searchable by our code, our name, **their** SKU or the barcode |

Store side, unchanged from v0.6 and now carrying the v1.0 extras:
`maison_pos.api.inventory.inbound` and `.receive_po(po, lines, boutique, freight, final, notes)`.

`orders()` takes `from` / `to` over HTTP exactly as the contract says; because `from` is a Python
keyword the function reads it out of `**kwargs` (and also accepts `from_date` / `to_date`).

---

## 13. Reports

All four are registered in `maison_pos.api.reports.REPORTS`, so they run in the desk, render in
the dashboard's Reports section and export as CSV. They carry a `roles` gate — buying figures are
not shop-floor information.

| Report | Answers |
|---|---|
| `AWANZ Purchase by Vendor` | spend, orders, units, average lead time, on-time % |
| `AWANZ Item Purchase History` | every receipt of an item: date, vendor, qty, unit cost, freight share, landed cost, running average — the cost drift |
| `AWANZ Open Purchase Orders` | what is outstanding, with ageing and expected date |
| `AWANZ Drop-ship Deliveries` | by store: receipt status, days late, discrepancies |

CSV: `/api/method/maison_pos.api.reports.export?report=AWANZ%20Purchase%20by%20Vendor`.

---

## 14. Print format

`AWANZ Purchase Order` (Jinja, `templates/print/purchase_order.html`) is the PDF the vendor gets:
brand header, **our account number with them**, rep, ship-to (the warehouse, or the store with a
*Drop-ship* flag), lines with the **vendor's own SKU**, freight, total, and terms that ask them to
quote the order number and to advise anything they cannot ship in full.

---

## 15. Demo seed

`maison_pos.setup.cloudchaserz.purchasing.seed_purchasing()` (part of the CloudChaserz seed,
idempotent, safe to re-run):

* 12 vendors — five distributors, seven brand-direct — each with a buying price list, lead time,
  MOQ, order method, account number and rep;
* an item-vendor row on all 160 catalogue items, ~85 % of them dual-sourced with the second vendor
  4–12 % dearer, exactly one preferred;
* reorder levels at HOU-WH on every stock item;
* eight received orders across four vendors at drifting costs, most with freight, receipted a day
  early or a few days late so on-time % is a real number;
* two open orders: one normal delivery to HOU-WH, one **drop-ship to OK-BA** (Broken Arrow).

Order creation only runs when the company has no purchase orders yet, so re-running never
duplicates history.

---

## 16. Deliberately not built

Recorded here so nobody goes looking for them:

* **No Request for Quotation and no supplier-quote comparison.** Rates are negotiated per vendor
  and stored on their price list. A buyer who wants to compare sees both vendors' costs on the
  suggestion row and picks one.
* **No three-way invoice matching and no AP.** Purchase invoices stay in the client's accounting
  package for now. We record what was ordered and what arrived, at what cost; we do not record
  what was billed or paid.
* **No Landed Cost Voucher.** Freight is on the purchase order as a maintained Actual / Valuation
  charge (§6). One document, entered once, by the person who knows the number.
* **No EDI and no vendor portal integrations.** `maison_order_method` records how we place an
  order with each vendor; placing it is a human action (e-mail with the PDF, or their portal).
* **No store-initiated purchasing.** A store asks the warehouse (`AWANZ Replenishment Request`);
  the warehouse decides whether that becomes a transfer from HOU-WH or a purchase.
* **No purchase-order approval workflow** (v1.1). Houston's buyer is trusted; a second pair of
  eyes is a v2 conversation.

---

## 17. Runbook & troubleshooting

**"Rate must be same as Purchase Order".** *Maintain Same Rate Throughout the Purchase Cycle* has
been switched back on in Buying Settings. Turn it off, or run
`bench --site <site> execute maison_pos.setup.install_v10_purchasing.ensure_buying_settings`.

**"No freight / valuation account found for <company>".** The company has no
*Expenses Included In Valuation* account and none could be created. Set one on the Company, or run
`bench --site <site> execute maison_pos.setup.install_v10_purchasing.ensure_freight_accounts`.

**A buyer gets "User don't have permissions to select/read this account".** They are missing read
on `Account`, which ERPNext needs to resolve the vendor's payable account while validating the
order. `create_docperms()` grants it to both purchasing roles; re-run the install glue.

**The buying list is empty.** No reorder levels at HOU-WH, or everything is covered by what is
already on order. `suggestions(refresh=1)` recomputes; `AWANZ Purchase Suggestion` shows the last
run, including rows dismissed in the last 14 days.

**A drop-ship order will not submit.** Every line must point at the store's warehouse and the
store must be enabled. Re-set the *Drop-ship to Store* field — that rewrites the lines for you.

**An item still values at FIFO.** Run
`bench --site <site> execute maison_pos.purchasing.ensure_moving_average` — it is idempotent, and
also runs on every migrate.

**A suggestion will not go away.** Dismissing is a **14-day snooze**, not a delete
(`demand.DISMISS_DAYS`), and it is keyed on the item, not the row — the list is recomputed from
live data on every run, so if the underlying need is still true the item comes back on day 15.
Check which source is putting it there: the badge says. *Low stock* means HOU-WH is still at or
under its `Item Reorder` level — either buy it or move the level. *Store demand* means a store has
an open `AWANZ Replenishment Request` the warehouse cannot fill; approving or rejecting that
request clears it. *Trending* means its HOU-WH cover is still under
`AWANZ POS Settings.purchase_cover_days`. A row that keeps reappearing **immediately** after an
order was raised usually means the order is still a **draft**: only a *submitted* order counts
towards "on order", which is what the engine subtracts. Deleting a draft order deliberately puts
its suggestions back to *Open* (`delete_order` reports `suggestions_reopened`), so that is not a
bug either.

**A vendor's rates are not picked up on a new order.** `vendor_rate(item, supplier)` looks in two
places, in this order:

1. the **`AWANZ Item Vendor` row** for that (item, vendor) pair — its `cost`;
2. failing that, an **`Item Price`** on `<Supplier> Buying` whose **`supplier` field is set to
   that vendor**.

Both come back empty and the line is created at 0, which is a rate the buyer then has to type. The
usual causes, in the order they occur: the vendor has no `<Supplier> Buying` price list at all (it
is created by the `Supplier` doc event, which is **skipped during install and migrate** — run
`vendors.ensure_price_list(<supplier>)`, or just re-save the vendor); the `Item Price` row exists
but was created by hand without `supplier`, so the lookup misses it; the item-vendor row exists
with a **blank cost**, which is a legitimate state meaning "buy at whatever they quote that day".
Note also that `create_order` only sets `buying_price_list` when the list exists — a PO with a
blank buying price list is the visible symptom of the first case.

**A receipt posted nothing.** `receive` answers `purchase_receipt: null` and the sheet says
*Nothing posted*. No Purchase Receipt is created when **no line had a postable quantity**: either
nothing was counted at all, or everything counted was already received and the over-receipt
allowance left no room. This is not a failure — with *This is the whole delivery* on it is the
normal outcome of a delivery that never came: the shorts are still raised against the vendor and
the order is still closed, and the response's `closed` flag says so. If you expected it to post,
check that the counted lines actually belong to *this* order (a scan that matches nothing silently
counts nothing), and check `per_received` on the order.

**A store cannot see its drop-ship order.** Their Receive screen (`inventory.inbound` →
`open_purchase_orders`) lists Purchase Orders by warehouse, and every one of these has to be true:
the order is **submitted** (a draft is invisible), `set_warehouse` is **that store's** warehouse,
`per_received < 100`, and the status is not Closed / Completed / Cancelled. Check
`maison_dropship_store` on the order — re-setting that field rewrites the header and every line's
warehouse for you, which fixes the common case of a line left pointing at `HOU-WH`. The store must
also be **enabled**; submit refuses a drop-ship to a disabled store. If the order is right and the
screen is still empty, it is a permission problem, not a data one: a store manager gets read on a
Purchase Order addressed to their own store from the v0.6 warehouse narrowing plus the v1.0
`Custom DocPerm` — re-run `setup.install_v10_purchasing.create_docperms`.

---

## 18. New in v1.1 — onboarding a product

Walking the client through *"a brand-new product arrives, get it to the eleven stores"* found
three places where the touch screens dead-ended into the branded desk. Two of them are here; the
third — Houston pushing stock out to the stores — is `docs/shipping.md` §1b.

### Creating a product from the warehouse

A rep shows the warehouse manager a new disposable. Before v1.1 there was no way to add it without
going to a laptop. Now: **Buying → New product**, one sheet, one call.

```python
maison_pos.api.purchasing.create_product({
    "item_code": "CC-DISPO-14", "item_name": "Nebula 12k Blue Razz",
    "item_group": "Disposables", "uom": "Nos",
    "barcode": "0712345678901", "image": "/files/nebula-12k.jpg",
    "selling_rate": 24.99,
    "vendor": {"supplier": "Gulf Coast Distribution", "vendor_sku": "GC-NB12-BR",
               "cost": 11.50, "case_pack": 10, "moq": 50, "lead_time_days": 5},
    "reorder": {"level": 120, "qty": 240},
})
```

What it does, in order:

1. creates the **Item** — stock item, Moving Average, the tenant company's defaults
   (company + `HOU-WH` as the default warehouse), `maison_barcode` **and** a standard
   `Item Barcode` row, because the scanner reads both;
2. writes the `AWANZ Item Vendor` row **through `purchasing/vendors.py`**, so the vendor's
   `<Supplier> Buying` price list is maintained exactly as an edit maintains it — the next
   purchase order for that vendor picks the rate up by itself;
3. marks that vendor **preferred**, because it is the item's first;
4. puts `selling_rate` on the selling price list the tills read as a standard `Item Price`;
5. adds the `Item Reorder` row for `HOU-WH`, so the item joins the buying list the moment it runs
   low.

**All or nothing.** Everything is validated before a single row is written, and the writes run
inside a savepoint: if any step fails the item must not be left half-built, so the whole thing is
unwound and nothing survives — no orphan item, no price row, no reorder level.

Two refusals matter:

* **a duplicate `item_code`** — *"Item CC-DISPO-14 already exists — open it instead of creating it
  again"*;
* **a barcode already on another item** — *"Barcode 0712345678901 is already on item CC-DISPO-09 —
  two products on one barcode rings up the wrong one"*. This one is a real-money bug: a shared
  barcode means the till sells the wrong product at the wrong price and the stock figures for both
  drift. Both surfaces the scanner reads are checked (`Item.maison_barcode` and `Item Barcode`).

`assert_purchasing_admin()` — **AWANZ Warehouse Admin** and **AWANZ Head Office** only. Creating a
product is a purchasing-admin act (client decision 5); store managers and associates may not.

`item_groups()` feeds the sheet's group picker: every non-group `Item Group` with how many items it
already holds, and the busiest one as the suggested default.

### A purchase order from scratch

Buying built orders from the suggestion list only, so a one-off trial case of something with no
reorder level had no path. The backend already had `create_order` — what was missing was the way
in, and that is `vendor_catalogue`:

```python
maison_pos.api.purchasing.vendor_catalogue("Gulf Coast Distribution", search="GC-NB12")
```

One row per item the vendor sells us, searchable by **our** item code, **our** item name,
**their** SKU or the barcode — so the buyer can build an order by typing or by scanning what is on
the rep's own sheet. Each row carries `cost`, `case_pack`, `moq`, `lead_time_days`,
`last_purchase_date` / `last_purchase_rate`, `on_hand` at HOU-WH, plus the two defaults the order
sheet starts from:

* `default_qty` — a whole case;
* `rate` — the vendor's own buying price list, falling back to the negotiated cost and then to the
  last purchase rate.

Both stay editable on the line, as every rate in v1.0 does. Preferred-vendor rows sort first.

### The walk-through, end to end

**Buying → New product** → *Order it now* (`vendor_catalogue` → `create_order` → the existing
`OrderSheet`) → **Inbound** receives it at HOU-WH → *Send to stores*
(`maison_pos.api.distribution`, `docs/shipping.md` §1b) → each store's Receive screen counts it in.
That is the whole of v1.1.
