# AWANZ POS — v1.2 "What each store owes, and what each store charges" (contract)

Read `SPEC.md` … `SPEC_v1.1.md`, `docs/purchasing.md` and `docs/shipping.md` first. Additive; keep
every suite green. Design system **Monolith Gold — no new design system**. Internal package stays
`maison_pos`; doctypes are `AWANZ *`; `maison_` custom fieldnames on ERPNext doctypes are deliberate.

## Why this release exists

Two things the client needs weekly, and one bug they hit on day one.

The stores are separately-owned LLCs. The proper answer is twelve companies with real intercompany
invoices, and that is a re-platform (see the architecture note, not this contract). **This release
is the stepping stone the client asked for instead**: Houston prices stock to the stores, every
shipment carries what it is worth, and at month end there is a statement per store to bill from.
It is a *report*, not an invoice — it does not create a receivable, does not age, and nothing lands
in a partner's books. Say so in the docs and on the screen, so nobody mistakes it for AR.

Separately, setting a store's **retail** price is a daily job that today means filling in a
submittable document in the ERP back office. The workflow, the approval and the pricing rules have
existed since v0.1 and there has never been a screen. There is now.

## Client decisions (locked — do not re-litigate)
1. **One wholesale price for every store.** Sapulpa and Montrose pay the same. Per-partner terms
   are a multi-company concern, not this one.
2. **Markup by default, override per item.** A chain-wide percentage covers everything; a specific
   wholesale price can be typed on any item and wins for that item.
3. **The statement shows cost and margin.** It is an internal document. Mark it as such — a partner
   must not be handed a report carrying Houston's buying price.
4. **The statement is net of returns and shortages.** Bill for what a store actually received.
5. **Store level, not line by line.** One row per store per period. Line detail belongs in the CSV
   export, not on the screen.
6. **Stock still moves at cost.** The wholesale figure is carried alongside for reporting; the
   ledger is untouched. This release changes no accounting.

---

## A. The wholesale price

- `AWANZ POS Settings` gains `wholesale_markup_pct` (Percent, default 50) — the chain-wide rule.
- Item gains `maison_wholesale_rate` (Currency) — the per-item override. Blank means "use the rule".
- `pricing/wholesale.py::wholesale_rate(item_code, cost=None)` resolves one item: the override when
  set, else `cost × (1 + pct/100)`, rounded to 2. **Cost is the item's moving-average valuation at
  the main warehouse**, because that is what Houston actually paid — not a price list.
- `wholesale_for(item_codes)` resolves many in one query; the screens list 160 items at a time.

API `api/pricing.py`: `wholesale(item_codes)`, `set_wholesale(item_code, rate)` (`null` clears the
override and returns the item to the rule), `wholesale_settings()` / `set_wholesale_markup(pct)`.
**AWANZ Warehouse Admin and Head Office only**, proven both ways at HTTP level.

## B. Stamping a shipment

`AWANZ Shipment Line` gains `cost_rate`, `wholesale_rate` (both Currency, read-only).

Stamp them **when the shipment ships**, never on read. A shipment sent in March must still say what
it was worth in March after April's buying moves the moving average — a statement that changes
after you have billed from it is worse than no statement.

`AWANZ Shipment` gains `wholesale_total` and `cost_total`, summed from the lines at the same moment.

Backfill is out of scope: shipments that shipped before this release carry no stamp and are shown
as *not priced* in the statement rather than silently valued at today's numbers.

## C. The month-end statement

`reports/store_statement.py` + a Script Report `AWANZ Store Statement`, registered in
`api/reports.py::REPORTS` so CSV export and the dashboard Reports list pick it up.

One row per store for the period: shipments, units shipped, **units billable** (shipped less
anything the store did not receive — an open or resolved `AWANZ Receiving Discrepancy` of type
*Short* or *Damaged* against that shipment), wholesale value, cost value, margin, margin %.
Chain totals. A store with nothing shipped still appears, with zeros — an absent row reads as an
oversight.

`api/pricing.py::statement(from_date, to_date, boutique=None)` returns the same figures for the
screen, plus a `lines` breakdown per store that the screen does not render but the CSV does.

**Mark it internal.** The payload and the report both carry a flag saying it shows Houston's cost,
and the screen says so in words. Client decision 3 exists because somebody will eventually e-mail
this to a partner.

## D. Store retail prices — the screen that never existed

`AWANZ Price Change Request` + the `AWANZ Price Approval` workflow have been in the app since v0.1
and v1.0 exposed them as `purchasing.price_change_requests` / `.request_price_change` /
`.approve_price_change`. **No screen has ever called them.** Build it.

On `/warehouse` → **Stock** → an item → **Prices**: every enabled store as a row with its current
effective retail price, where that price comes from (chain default or a store override), the
wholesale price, and the margin that store makes at it. Type a new price on any row → raises a
price change request for that store. Several rows at once raises several requests.

A **Approvals** area for head office: the pending queue, each showing store, item, current price,
proposed price, who asked, why, and the margin it implies. Approve or reject in one tap, with a
reason on a reject. Approving is what creates the store-scoped pricing rule — that is existing
behaviour, do not reimplement it.

Permissions follow the existing workflow exactly: any AWANZ role may raise a request **for their
own store**; only Head Office / Regional / System Manager may approve. Prove both.

## E. The Buying board tells the truth about a row it cannot order

A suggestion for an item with **no vendor on file** silently fails to select: the checkbox ticks,
the footer says *Nothing selected*, and nothing explains why. `selectedLines` is right to drop a
line with no supplier — you cannot raise a purchase order without one — but the screen must say so.

- Such a row renders as unorderable, with the reason in words, and its checkbox disabled.
- *Select all* says how many it skipped and why.
- The row offers **Add a vendor** inline, which attaches a supplier to the item (`save_item_vendor`)
  and refreshes the row — the buyer is looking at the thing they need to fix, so fix it there.
- **Vendors → a vendor → Catalogue** gains **Add items**: search the catalogue and attach items to
  that vendor with cost, case pack and MOQ, rather than editing items one at a time in the desk.

## G. Build a despatch — a basket of items for one store

v1.1 shipped *one item → many stores*, which is right for introducing a new product and wrong for
the everyday job. What the warehouse actually does is **fill one store's order**: three SKUs to
Bixby, four to Sapulpa. `distribution.send` already accepts any combination of store, item and
quantity — this is a screen, not new plumbing.

On `/warehouse` → **Outbound** → **New despatch**:

- **Add items** by scanning a barcode or searching. Each added line shows what Houston holds, what
  is already committed, the quantity to send, and its wholesale value.
- **One destination per despatch.** The store is chosen on the basket, not per line — the manager
  is filling one box for one shop, and a per-line destination invites the mistake of sending half
  a basket to the wrong place. After sending, offer **Send another** with the destination cleared
  and the item search focused, because the next thing they do is Sapulpa.
- A running footer: lines, units, wholesale value, and — per client decision 3, this screen is
  internal — the cost and margin.
- The same refusal as everywhere else: never more than Houston has available, shortfall named per
  item, nothing written on failure.
- Scanning an item already in the basket **increments it** rather than adding a second line.
- A line for an item the destination store has never sold is flagged, quietly — it is usually
  deliberate, occasionally a scanning mistake.

Both routes stay: **Stock → an item → Send to stores** for spreading one product across the chain,
and **Outbound → New despatch** for filling one store's order. They post through the same endpoint
and produce the same shipments, so the wall, the picking and the store's Receive screen cannot tell
them apart.

## F. Quality

Backend `FrappeTestCase`: the markup rule and the per-item override, and clearing an override;
wholesale resolved from the main warehouse's moving average, not a price list; a shipment stamped
at ship time and **unchanged** when the valuation later moves; the statement netting a Short and a
Damaged discrepancy off billable units; a store with no shipments appearing with zeros; the
internal-cost flag present; a store manager refused every pricing endpoint and allowed to raise a
price change for their own store but not another's; approval creating the pricing rule.

Frontend vitest for the price board's margin maths, the statement's totals as rendered, the
unorderable-row copy, and the despatch basket (scan increments, availability, the refusal). Extend `e2e/purchasing.e2e.mjs` or add `e2e/pricing.e2e.mjs`: set a markup,
override one item, ship to two stores, raise and approve a retail price change, then read the
statement and assert the numbers against what the run itself computed.

Docs: `docs/pricing.md` (the markup, the override, what the statement is and — plainly — what it is
not), and a note in `docs/shipping.md` that shipment lines now carry a stamped value. Update
README + CHANGELOG (1.2.0) and bump all three version files.

## Out of scope for v1.2 (record in docs, do not build)
Per-partner wholesale terms; invoices, receivables or ageing of any kind; multi-company anything;
backfilling the value of shipments sent before this release; sell-through comparison on the
statement; staff onboarding and the head-office desk tidy-up (both v1.3).
