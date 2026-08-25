# Pricing (v1.2 "What each store owes, and what each store charges")

Two prices, and they are not the same thing.

* **Wholesale** — what a *store* pays AWANZ Houston for a unit of stock it is sent. §1–§3.
* **Retail** — what a *client* pays in a shop. That workflow has existed since v0.1; v1.2 finally
  gives it a screen. §5.

Related: `docs/shipping.md` (the consignment that carries the wholesale figure), `docs/purchasing.md`
(what the warehouse paid in the first place), `SPEC_v1.2.md`.

---

## 0. What this is, and — plainly — what it is not

The eleven stores are separately-owned LLCs. Houston buys centrally and sends them stock, and the
client needs to bill each store for what it received.

The correct long-term answer is **twelve ERPNext companies with real intercompany invoices**: a
Sales Invoice in Houston's books, a Purchase Invoice in the store's, a receivable that ages, cash
applied against it. That is a re-platform, and it is not this release.

This release is the stepping stone the client asked for instead:

* price the stock to the stores (§1);
* carry that price on every consignment (§2);
* produce a **statement** per store per period they can bill from by hand (§3).

**It changes no accounting.** Stock still moves at cost. Nothing here creates an invoice, a
receivable, an ageing bucket or a payment; nothing lands in a partner's books; no ledger entry is
posted. The statement is an internal AWANZ report and every payload it produces says so:

```json
{"internal": true, "shows_cost": true, "is_invoice": false, "creates_receivable": false,
 "notice": "Internal AWANZ document — it shows the AWANZ warehouse's own cost and margin. …"}
```

The flag is not decoration. The statement shows Houston's **buying cost** next to what the store
is charged, because head office needs to see the margin — and sooner or later somebody will
forward that spreadsheet to a store owner. The CSV export leads with the banner for the same
reason, and the screen is expected to say it in words.

---

## 1. The wholesale price

**One price for every store.** Sapulpa and Montrose pay the same. Per-partner terms are a
multi-company concern and are deliberately out of scope (client decision 1).

**Markup by default, override per item** (client decision 2):

```
wholesale = maison_wholesale_rate            when the item carries one
          = cost × (1 + wholesale_markup_pct / 100)   otherwise, rounded to 2
```

| Where | Field | Default |
| --- | --- | --- |
| AWANZ POS Settings | `wholesale_markup_pct` (Percent) | 50 |
| Item | `maison_wholesale_rate` (Currency) | blank — "use the rule" |

Blank means the rule. Clearing an override writes 0, which is how a Currency column spells blank
(Frappe declares them `NOT NULL`), and the item goes back to the markup on its next read.
A markup of **0 is a legitimate answer** — ship at cost — so "never set" is tested for absence,
not for falsiness; that is why the patch fills the setting in rather than trusting the field
default.

### The cost it marks up

`cost` is the item's **moving-average valuation at the main warehouse** — `Bin.valuation_rate` at
`HOU-WH` — because that is what Houston actually paid for the units it is sending. Two fallbacks,
for an item the warehouse has never held: `Item.valuation_rate`, then `Item.last_purchase_rate`.

It is deliberately **not a price list**. A buying price list says what a vendor charges today,
which is a different question from what the stock on the shelf cost; and freight is capitalised
into the moving average (see `docs/purchasing.md`) but into no price list. A test asserts exactly
this: an item with 999.00 sitting on two price lists still prices from its 10.00 valuation.

### API

All of §1–§3 is **AWANZ Warehouse Admin / AWANZ Head Office only** (`assert_purchasing_admin`).
A store manager is refused every endpoint, including the statement for their own store — proven
both ways at HTTP level in `maison_pos/tests/test_v1_2_pricing_http.py`.

| Endpoint | Arguments | Returns |
| --- | --- | --- |
| `pricing.wholesale_settings` | — | `{markup_pct, default_markup_pct, warehouse, currency, cost_basis, per_store_terms, internal, notice}` |
| `pricing.set_wholesale_markup` | `pct` | the same payload |
| `pricing.wholesale` | `item_codes` (list or JSON) | `{markup_pct, currency, warehouse, items: [{item_code, item_name, cost, override, wholesale, source, markup_pct, margin, margin_pct}], count}` |
| `pricing.set_wholesale` | `item_code`, `rate` (`null` clears) | `{item: {…same row…}, markup_pct, currency}` |

`source` is `"override"` or `"markup"`. `margin` / `margin_pct` on these rows are **AWANZ's**
margin (wholesale less cost, as a share of wholesale) — not the store's.

`wholesale_for(item_codes)` in `maison_pos/pricing/wholesale.py` resolves the whole list in one
pass; the price board asks for 160 items at a time.

---

## 2. The consignment carries it

Stamped at despatch, never on read. See `docs/shipping.md` §1c for the fields and the reasoning.
The short version: a statement whose numbers move after the client has billed from it is worse
than no statement, so the figures are frozen the moment the consignment leaves the building, and
consignments that shipped before v1.2 are reported as *not priced* rather than valued at today's
cost.

---

## 3. The month-end statement

`maison_pos/reports/store_statement.py`, surfaced two ways that share one implementation:

* **Script Report `AWANZ Store Statement`** — registered in `api/reports.py::REPORTS`, so it
  appears in the dashboard Reports list, opens in the desk and exports as CSV. Filters:
  `from_date`, `to_date`, `boutique`, `detail`.
* **`pricing.statement(from_date, to_date, boutique=None)`** — the same figures for the screen.

### What a row says

One row per store per period (client decision 5 — store level, not line by line):

| Field | Meaning |
| --- | --- |
| `shipments` | consignments despatched in the period (`shipped_at` decides the period) |
| `units` | units shipped |
| `short_units` / `damaged_units` | what the store did not actually receive |
| `billable_units` | `units − short − damaged` |
| `wholesale_value` | Σ billable × the stamped wholesale rate |
| `cost_value` | Σ billable × the stamped cost rate — **internal** |
| `margin`, `margin_pct` | wholesale less cost, as a share of wholesale |
| `unpriced_shipments`, `unpriced_units` | consignments carrying no stamp (pre-v1.2) |
| `lines` | the per-item breakdown — API payload and CSV only, never the screen |

**Net of returns and shortages** (client decision 4 — bill for what a store actually received).
The netting comes from `AWANZ Receiving Discrepancy` rows of type *Short* or *Damaged* against the
consignment, **open or resolved alike**: resolving a shortage settles it with the warehouse, but
the store still never received the goods. *Over* is not netted in the other direction — a store
that was sent too much is a warehouse problem, not a billing one.

A partial receipt can raise more than one discrepancy for the same line, and each one carries the
*running* total off the shipment line rather than that receipt's slice, so the netting takes the
largest figure seen per (consignment, item, type) and never their sum.

**Every enabled store appears**, with zeros when nothing was sent — an absent row reads as an
oversight and somebody rings up about it. The chain total is computed in the module, not left to
`add_total_row`, which would happily add eleven stores' margin percentages together.

### The payload

```
pricing.statement(from_date, to_date, boutique=None) ->
{
  from_date, to_date,
  internal: true, shows_cost: true, is_invoice: false, creates_receivable: false, notice,
  markup_pct, currency, shipments, generated_at,
  stores: [ { boutique, boutique_name, shipments, units, short_units, damaged_units,
              billable_units, wholesale_value, cost_value, margin, margin_pct,
              unpriced_shipments, unpriced_units,
              lines: [ { item_code, item_name, shipments, units, short_units, damaged_units,
                         billable_units, wholesale_rate, cost_rate, wholesale_value,
                         cost_value, margin, margin_pct } ] } ],
  totals: { …the same keys, boutique: null, boutique_name: "Chain total" }
}
```

`wholesale_rate` / `cost_rate` on a line are the weighted average over the period — a line can
gather consignments stamped on different days at different costs.

---

## 4. Doing the month end

1. **Set the markup once.** `/warehouse` → Prices, or AWANZ POS Settings. 50% unless the client
   says otherwise.
2. **Override the exceptions.** Anything the chain-wide rule prices wrongly gets a typed price on
   the item; it wins until it is cleared.
3. **Ship as usual.** Nothing about picking, packing, labelling or receiving changes.
4. **On the 1st, run the statement** for last month, per store or for the chain.
5. **Export the CSV** for the line detail (`detail = 1`) and bill from it **by hand**. The system
   does not invoice, does not track what was paid, and will not tell you who is behind.

---

## 5. Retail — the store's shelf price

Unchanged mechanism, new screen. `AWANZ Price Change Request` + the `AWANZ Price Approval`
workflow have existed since v0.1:

```
Draft --(Submit for Approval)--> Pending Approval --(Approve)--> Approved  → Pricing Rule
                                                  --(Reject)---> Rejected
```

* **Any AWANZ role may raise a request for their own store**, and for no other.
* **Only Head Office / Regional / System Manager may approve.**
* **Approving is what creates the store-scoped `Pricing Rule`** (titled `AWANZ <store> <item>`,
  fenced to the store's warehouse). Nothing else writes it, and v1.2 did not reimplement it.
* A **reason is required** on the request — head office reads it when approving.

The endpoints are v1.0's, in `maison_pos.api.purchasing`: `price_change_requests`,
`request_price_change`, `approve_price_change`. v1.2 adds two reads:

| Endpoint | Arguments | Returns |
| --- | --- | --- |
| `pricing.store_prices` | `item_code`, `price_list="Standard Selling"` | `{item_code, item_name, item_group, uom, barcode, image, price_list, default_rate, currency, wholesale, wholesale_source, cost, markup_pct, internal, notice, count, stores: [{boutique, boutique_name, warehouse, rate, source, is_override, pricing_rule, valid_from, valid_upto, wholesale, margin, margin_pct, pending}]}` |
| `purchasing.price_change_requests` | unchanged | each row **additionally** carries `wholesale`, `margin_now`, `margin_proposed` — **for a purchasing admin only** |

`source` is `"Store override"` (a live Pricing Rule) or `"Chain default"` (the `Item Price` on the
selling list). `margin` / `margin_pct` on these rows are the **store's** margin: shelf price less
what they paid us. `margin_pct` is **`null`** when the item has no price at all (`has_price:
false`) — an unpriced item is not a 0 % margin, and a board that says 0 % is the sort of thing
somebody prices against. `margin_now` / `margin_proposed` on the approvals queue are the same
three-key shape.

The margin figures on the approvals queue are attached only when the caller may see them. A store
manager reading their own queue gets exactly the payload v1.0 gave them — what we pay for the
stock is not shop-floor information.

---

## 5b. Two ways to send stock, and when to use which

| Route | Shape | Use it when |
|---|---|---|
| **Stock → an item → Send to stores** | one item, many stores | A new product is going out to the whole chain, or one line needs rebalancing across the shops |
| **Outbound → New despatch** | many items, one store | The everyday job: filling a shop's order — three lines for Bixby, four for Sapulpa |

They post through the same endpoint and produce the same consignments. The wall, the pick list, the
packing step and the store's Receive screen cannot tell them apart.

**Building a despatch.** Choose the destination once, then scan or search items in. A scan of
something already in the basket adds one more to that line — not a second line for the same item.
Each line shows what Houston holds and what is already committed to consignments raised but not yet
shipped, so the same units are never promised to two shops. The footer carries what the store pays,
and behind an *internal* label, the cost and margin.

**Send another** clears the destination and returns the cursor to the scan box, because the next
thing that happens is the next store.

If the basket asks for more than Houston has, nothing is sent and the shortfall is named per item.
A half-sent despatch would leave phantom consignments on the wall for the floor to pick.

## 6. Deliberately not built in v1.2

Recorded here so nobody goes looking for them:

* **Per-partner wholesale terms.** One price for every store; per-partner terms need the
  multi-company model.
* **Invoices, receivables or ageing of any kind.** The statement is a report. Full stop.
* **Multi-company anything.** The twelve-company re-platform is its own project.
* **Backfilling consignments sent before v1.2.** They are reported as *not priced*.
* **Sell-through on the statement** (what the store actually sold of what it was billed for).
* **Payment tracking.** Nothing records that a store has settled a statement.
