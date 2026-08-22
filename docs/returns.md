# Maison POS — itemized returns & exchanges (v0.4 E)

## Policy (Maison POS Settings)

| Field | Default | Meaning |
| --- | --- | --- |
| `return_window_days` | 30 | Refunds after this many days need a manager PIN |
| `exchange_window_days` | 60 | Exchanges after this many days need a manager PIN |
| `returns_manager_threshold` | 2 500 | Refund / exchange credit (incl. tax) above this needs a manager PIN; `0` = always |

Reasons: *Change of mind, Defect, Sizing, Gift return, Other*. Conditions: *Sellable* (back on
the floor) / *Damaged* (to the boutique's **Damaged** warehouse, `Maison Boutique.damaged_warehouse`,
created by the seed / `after_migrate` as `<code> Damaged - <abbr>`).

## POS flow (`/returns`, `/exchange/:invoice`)

1. **Find** the sale: scan the receipt QR (`/r/<token>` URL), type the invoice number, or search
   the client (name / phone / client №). Wedge and camera scans are captured by the screen.
2. **Items**: tick lines, pick the serial chips (serialized pieces) or the qty (accessories), reason
   and condition per line. Lines already returned show "n returned"; nothing returnable twice.
3. **Refund**: original card (only if the sale carries a Stripe `maison_terminal_ref` and the amount
   does not exceed what was charged), cash (drawer) or store credit (needs a client). The credit
   shows live (`returns/math.ts: computeReturnTotals`). Over the threshold / outside the window the
   **Manager PIN** sheet opens (an unlocked manager approves implicitly).
4. **Done**: credit note number, refund reference (`re_…`, simulated without a key), print the
   return receipt (reader printer → ePOS → browser).
5. **Exchange instead** carries the selected lines to the Exchange screen: pick new pieces from the
   catalogue; the app shows *Client pays* (difference, card via the reader or cash) or *Refund to
   client* (remainder → card / cash / store credit) or *Even exchange*; one tap completes both
   documents.

## Backend (`maison_pos.api.returns`)

| Endpoint | Notes |
| --- | --- |
| `lookup(invoice?, token?, customer?, q?, limit)` | `{invoices: [...]}` with per-line `returnable_qty`, `returnable_serials`, `returned_*`, policy flags (`within_return_window`, `manager_threshold`, `days_since`), payments, `terminal_ref`, credit notes so far |
| `return_items(invoice, lines, refund_method, reason?, manager?, manager_pin?, device_id?, notes?)` | `lines = [{item_code, qty, serial_no?, row?, reason, condition}]`; `refund_method ∈ card / cash / store_credit`. Creates + submits the credit note, refunds, returns `{credit_note, grand_total (negative), refund_method, refund_id, receipt_token, payments, lines[], loyalty_points_reversed, manager_approved_by, receipt}` |
| `exchange(invoice, lines, new_items, payments?, refund_method?, …)` | credit note **and** new POS sale; returns the above plus `{new_invoice, new_grand_total, credit, applied, difference, refund_remainder, new_receipt_token, new_payments}` |
| `policy(boutique?)` | windows, threshold, reasons, conditions, `stripe_configured` |
| `recent(boutique, limit)` | latest credit notes of the boutique |

Errors carry `error_code`: `MANAGER_REQUIRED` (no / wrong manager PIN), `NOT_FOUND` (serial not on
the sale or already returned), `PAYMENT_MISMATCH` (card refund larger than the card charge,
exchange payments not covering the difference), `VALIDATION_ERROR`.

### What a return does in ERPNext

- `make_sales_return(invoice)` → only the selected rows are kept, `qty = −n`, serials limited to the
  chosen ones (`use_serial_batch_fields`), `update_stock = 1`, `is_return = 1`, `return_against`.
  ERPNext itself refuses quantities / serials beyond what was sold.
- **Serialized**: *Sellable* → row warehouse = boutique warehouse (serial becomes Active there again,
  visible in `catalog.bootstrap.serials`); *Damaged* → row warehouse = Damaged warehouse (not
  sellable from the POS; shows as *Damaged* in the Serial Ledger report).
- **Refund tenders** (credit note `is_pos = 1`): `Card` or `Cash` row with a negative amount equal
  to the credit note total. **Card** refunds call `stripe.Refund.create(payment_intent=…, amount=…)`
  (idempotency key `maison-refund-<credit note>`; partial refunds allowed); the refund id is stored
  in `maison_refund_id`. Without `stripe_secret_key` (or for `pi_sim_…` intents) the refund is
  simulated (`re_sim_…`).
- **Store credit**: credit note `is_pos = 0` with no tenders → stays **unallocated**
  (`outstanding_amount < 0` = the client's credit balance, allocate it later with Payment
  Reconciliation or as an advance on the next invoice).
- **Loyalty**: ERPNext recomputes the original sale's Loyalty Point Entry net of returns
  (`make_loyalty_point_entry` on the return), so points earned on returned lines disappear;
  the API reports the new value as `loyalty_points_reversed`.
- **Commission**: if `maison_pos.api.hr.reverse_commission` exists (section C) it is called with
  the original invoice (and `credit_note=` when the signature accepts it) — feature-detected, never
  required.
- Custom fields: `Sales Invoice.maison_refund_method / maison_refund_id / maison_return_reason /
  maison_exchange_invoice / maison_manager_approved_by`; `Sales Invoice Item.maison_return_reason /
  maison_return_condition`. A Comment is added to the original sale.

### Exchange accounting

The credit is carried with the **`Exchange Credit`** mode of payment (type *General*, account
`Exchange Clearing - <abbr>`, created by the seed / `after_migrate`):

| | credit note | new sale |
| --- | --- | --- |
| Exchange Credit | `−applied` | `+applied` |
| Card / Cash | `−remainder` (trade-down refund) | `+difference` (trade-up payment) |

`applied = min(credit, new total)`, so the clearing account nets to zero per exchange and only the
difference touches cash / card. A trade-down with `refund_method = store_credit` leaves the
remainder outstanding on the credit note. Both documents reference each other through
`maison_exchange_invoice`.

### Print formats

`Maison Return Receipt` (Jinja, `templates/print/return_receipt.html`, fixture in
`fixtures/print_format.json`) prints credit notes: RETURN / EXCHANGE banner, original sale, new
sale, approver, reason + condition per line, credit, refund tender or store credit, points note,
signature line, QR to `/r/<token>` (credit notes get their own receipt token; the public page and
`sales.receipt` payload include `return_against`, `refund_method`, `refund_id`, `store_credit`).

## Reports

`Maison Returns` (by reason / boutique / associate or line detail); `Maison Daily Sales`, `Maison
Sales Tax Summary`, `Maison Sales by Item / Associate`, `Maison Client Purchases` and the POS X/Z
report all net credit notes (negative rows) automatically. The dashboard "Low stock" tile shows
*Returns today* and `dashboard.live_summary.returns` carries the count / value.

## Tests

`maison_pos/tests/test_v0_4_returns.py` (11): serialized sellable → stock, damaged → Damaged
warehouse, card refund simulated / refused on a cash sale, store credit unallocated, partial qty +
loyalty reversal, manager PIN (threshold, wrong PIN, implicit manager), exchange up (difference
charged, Exchange Credit nets to zero), exchange down (remainder refunded), serialized-for-
serialized with store-credit remainder, lookup by token / customer. Frontend
`src/tests/returns.test.ts` covers the line math, exchange settlement, manager gate and the mock
API parity (same rules, same error codes).
