# QA — POS core (selling, payments, receipts, offline, age verification, scanning, returns/exchanges)

**Target** `https://cloudchaserz.frappe.cloud` (live shared demo) · **Store** `HOU-MTR` — CloudChaserz Montrose
· **Tax template** `TX Sales Tax (Houston) - CCZ` — one row, *On Net Total*, **8.25 %**
· **Users** `hou.mtr.a1@cloudchaserz.example` (Dante Ruiz, PIN 2580), `hou.mtr.a2@…` (Keisha Brown, 1357),
`hou.mtr.manager@…` (Marisol Vega, 1101) · **Date** 2026-08-23, 14:19–15:05 UTC (09:19–10:05 America/Chicago).

**Result: 121 checks — 107 passed, 13 failed, 1 informational.** Three of the defects (D1–D3) are
release-blocking money bugs: the customer pays, a receipt prints, and the server then refuses the sale.

Screenshots: `e2e/qa/shots-pos/` (referenced below by number). Raw per-run results: `e2e/qa/results-t*.json` (15 runs).
Scripts (test-only, no application source was touched): `e2e/qa/lib-pos.mjs`, `t1…t12*.mjs`, `cleanup*.mjs`.

```bash
cd /home/claude/maison/e2e/qa
BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node t2-sell.mjs      # etc.
```

---

## Defects, worst first

### D1 — CRITICAL · the POS and the server disagree about sales tax by a cent, and the sale is refused *after* the customer has paid

The POS rounds tax **per line**; ERPNext applies the *On Net Total* row **once** to the whole net total.
Whenever the two disagree the server refuses the payment and no invoice is created — but the drawer has
already been opened / the card has already been charged and a receipt has already printed.

| direction | what I did | POS said | server said |
|---|---|---|---|
| client **under** | HKA-012 ×1 ($12.99) + HKA-013 ×2 ($33.98), **cash** | net 46.97 + tax **3.87** = **$50.84**, receipt printed, drawer opened | `Payments (50.84) do not cover the invoice total (50.85)` → **Rejected**, no invoice |
| client **over** | HKA-017 ×1 ($6.99) + ACC-002 ×1 ($1.79), **card** | net 8.78 + tax **0.73** = **$9.51**, charged on the reader (`pi_sim_…`) | `Card payments exceed the invoice total` → **Rejected**, no invoice |

Evidence: `015-sell-tax-basket.png`, `016-receipt-tax-case.png` (receipt reads *TAX 8.25 % 3.87 / TOTAL 50.84 /
CASH 50.84* beside a red **REJECTED** pill), `028-pay-card-tax-mismatch.png`; `Maison Sync Log` rows
`6209c674-…` and the card one.

**How often**: measured over this store's live price list, random baskets, qty 1–3 —
**2 lines 25.6 %**, 3 lines 34.0 %, 4 lines 39.5 %, 5 lines 45.1 %, 8 lines 54.9 % of baskets differ by ≥ 1 ¢.
Cash tolerates the over-payment case (change), card tolerates neither. A single-line basket is always safe,
which is why earlier runs did not catch it.

**Should**: the number the POS shows the customer must be the number the server books. Compute the tax the way
the template says — once, on the taxable total.

**Where**
* `frontend/src/utils/totals.ts` → `computeTotals()`: `total_taxes = round(total_taxes + round((net * taxRate) / 100))`
  inside the per-line loop. Summing `round(net_i × rate)` is not `round(Σnet_i × rate)`.
  `frontend/src/returns/math.ts::computeReturnTotals` has the **same** per-line shape
  (`tax = round(tax + round((n * taxRate) / 100))`), so a multi-line return will display a refund that can be a
  cent away from the credit note the server books — i.e. the associate hands over the wrong cash. Every return
  I exercised was single-line, so this one is read from the code, not observed.
* `maison_pos/api/sales.py` → `build_sales_invoice()` sets the taxes from the boutique template
  (`get_taxes_and_charges`, ERPNext recomputes), and `_validate_payments_cover_total()` (sales.py:297) is what
  raises. The guard is right; the client's arithmetic is what has to change.

---

### D2 — CRITICAL · an offline sale of an age-restricted item can never sync

Offline, rang up `DSP-007` (21+), passed the gate with a manual DOB (the gate correctly runs on-device offline),
took cash, went back online, pressed **Sync now**:

```
(1292, "Incorrect datetime value: '2026-08-23T19:39:08.269Z' for column
 `_1c16a14f83a97af7`.`tabSales Invoice`.`maison_age_checked_at` at row 1")
```

Rejected, no invoice; reproduced twice (`DSP-007`, `DEV-007`). The *same* offline flow with non-restricted
items syncs fine (6.1b/6.5 passed), so the age check is the trigger. **127 of the 160 items in this catalogue
are 21+**, so offline mode — the one feature that exists for when the network is down — is effectively unusable
at a smoke shop. The raw MariaDB error, including the internal table name, is what the associate is shown
(`063-offline-age-sync.png`).

**Where**
* `frontend/src/api/v06.ts` → `decideOffline()`: `checked_at: new Date().toISOString()` → `…T19:39:08.269Z`.
* `maison_pos/api/age.py` → `apply_to_invoice()`: `si.maison_age_checked_at = check.get("checked_at") or now_datetime()`
  — the client string is written straight to a Datetime column. `sales.py` already has `parse_datetime()` for
  `posting_datetime`; the same normalisation is missing here.

Evidence: `062-offline-age-gate.png`, `063-offline-age-sync.png`.

---

### D3 — HIGH · a $0.00 sale (comp / 100 % discount) is always rejected

Rang up ACC-002, applied a 100 % line discount, basket **$0.00**, *Amount due $0.00*, "Complete cash sale"
succeeded in the UI and printed a receipt. Sync: `Invoice has no payments` → **Rejected**, no invoice.
A comped item, a giveaway prize or a fully-discounted line can never be recorded.

**Where** `frontend/src/views/PayView.vue::finalize()` sends `payments: total.value > 0.005 ? [ … ] : []`;
`maison_pos/api/sales.py:163` throws `PaymentMismatchError("Invoice has no payments")` unless a `sales_order`
is present. Either send a zero-amount tender or let the server accept a zero-total POS invoice.

Evidence: `104-edge-zero-basket.png`, `105-edge-zero-receipt.png`.

---

### D4 — MEDIUM · "Email receipt" silently does nothing

Entered `qa1.receipt@example.com`, pressed *Send on sync*; the button flipped to **"Email queued"**.
Server side: the invoice's `maison_notes` is `null` and the `Email Queue` has no row for it. The intent is
written into the local Dexie row of a sale that **has already been sent**, and nothing ever re-posts it.
A working endpoint exists (`maison_pos.api.salon.email_receipt(token, email)` — used by the client display)
but the POS never calls it.

**Where** `frontend/src/views/ReceiptView.vue::sendEmail()`. Evidence: `036-receipt-email.png`.

---

### D5 — MEDIUM · an expired session turns live sales into permanent "Rejected" rows, with a misleading internal message

Replayed the exact 403 body the live site returns for a stale `sid` on `sales.submit_batch`
(captured with curl: `{"session_expired":1, "_server_messages":["…not permitted…Function <strong>maison_pos.api.sales.submit_batch</strong> is not whitelisted."], …}`).

What the associate sees on the receipt (`161-session-expired-real-body.png`):

> **SERVER REJECTED THIS SALE**
> You are not permitted to access this resource. Login to access**Function maison_pos.api.sales.submit_batch is not whitelisted.**

Three problems:

1. It names an internal Python path (`maison_pos.api.sales.submit_batch`) and asserts something untrue —
   the method *is* whitelisted; the till is simply signed out. The two sentences are also run together with no
   space ("Login to access**Function**") because `stripHtml` removes `</summary>` without inserting a separator.
2. The sale is marked **Rejected**, a terminal state. Pressing **Sync now** does *not* re-send it
   (`0 pending · 1 rejected · 0 synced` after the session is restored).
3. Only the per-row **Retry** recovers it — which it does correctly (`ACC-SINV-2026-03078` created), so nothing
   is lost, but the operator has to know to go into the Queue and find it.

**Should**: a `session_expired` / `AUTH` response is transient — keep the sale *pending*, retry it after the
next successful login, and say "Signed out — sign in again to sync this sale".

**Where** `frontend/src/api/frappe.ts` builds the message from `_server_messages` via
`stripHtml` (`utils/text.ts`, which has no separator rule for `</summary>`);
`frontend/src/stores/sync.ts` classifies every non-network failure as terminal, ignoring `body.session_expired`
and the `AUTH` code that `frappe.ts` already sets for 401/403.

Evidence: `161-session-expired-real-body.png`, `162-session-expired-real-queue.png`, `151-queue-retry-recovered.png`.

### D6 — MEDIUM · PIN lockout is invisible: the till just keeps saying "Incorrect PIN"

Five wrong PINs for Keisha Brown set `Maison Associate.failed_pin_attempts = 5` and the **correct** PIN is then
refused — correct and important behaviour. But the screen says *"Incorrect PIN for Keisha Brown"* every time,
including after the lock. The server's message —
*"PIN locked after too many failed attempts; ask a manager to reset it"* — never reaches the associate, so the
shift stalls with no idea why the right PIN stopped working.

**Where** `maison_pos/maison_pos/doctype/maison_associate/maison_associate.py::verify_pin` throws
`AuthenticationError` with the right text; `frontend/src/stores/session.ts::unlock` catches it, keeps only
`ok = false` and discards `ApiError.message`; `frontend/src/views/UnlockView.vue::fail()` then writes the
generic line. Evidence: `007-pin-lockout.png`.

---

### D7 — MEDIUM · card brand / last-4 / approval code never reach the invoice

The printed receipt reads `CARD VISA **** 4242 … APPROVAL 54DD0D`, but the invoice stores only the payment
intent: `maison_card_brand = null`, `maison_card_last4 = null`, `maison_approval_code = null`. Consequence in
my own area: the Returns screen's refund button reads **"Original card — Card ••••"** with no digits, so the
associate cannot confirm which card is about to be refunded, and card reconciliation has nothing to match on.

**Where** `frontend/src/views/PayView.vue::finalize()` builds
`payments: [{ mode_of_payment, amount, stripe_payment_intent: card?.payment_intent }]` — it drops
`card.card_brand`, `card.last4`, `card.approval`, even though `maison_pos/api/sales.py` already reads
`p.get("card_brand")`, `p.get("last4")`, `p.get("approval_code")`.

Evidence: `026-receipt-card.png`, `132-returns-card-method.png`.

---

### D8 — MEDIUM · an exchange produces two invoices that can never be cancelled

The exchange writes `maison_exchange_invoice` on **both** documents pointing at each other
(credit note `…03064` ⇄ new sale `…03065`). Frappe then refuses to cancel either — `LinkExistsError`, each
naming the other — so an exchange booked in error can only be neutralised by *voiding* (which adds a third
document). Six invoices from this run are stuck this way; see *Clean-up* below.

**Where** the exchange writer in `maison_pos/api/returns.py` (sets `maison_exchange_invoice` on the credit note
and on the new invoice). One direction should be enough, or the field should be `ignore_links`.

---

### D9 — LOW · the wrong-manager-PIN message shows the Python exception path

The manager-approval modal renders **"maison_pos.api.returns.ManagerRequiredError: Manager PIN incorrect"**.
The behaviour is right (refused, retryable), the wording is not. This response carries no `_server_messages`, so `api/frappe.ts` falls back to `body.exception` and keeps the
exception class path. Evidence: `093-returns-manager-pin-wrong.png`.

### D10 — LOW · no split tender
Pay offers a single mode (tabs *Cash | Card*) and `finalize()` always sends exactly one payment row; the POS
Profile has `allow_partial_payment = 0`. A customer paying part cash / part card cannot be served.

### D11 — LOW · the invoice keeps no record of what was tendered
Cash sale of $1.94 with $20.00 tendered: the receipt correctly prints *TENDERED 20.00 / CHANGE 18.06*, but the
invoice books `paid_amount = 1.94`, `change_amount = 0`. Financially neutral (net cash is the same), but the
till cannot be reconciled against actual tendered cash from the invoice, and the change given is not auditable.
(`frontend/src/views/PayView.vue::finalize()` sends `amount: total`, never `tendered`.)

### D12 — LOW · a partial return leaves the client one loyalty point too many
Sale $17.30 (net 15.98) → 15 pts on `net_total`. After returning $7.57 of it, ERPNext deletes and recreates the
entry on a different base (`grand_total − returned` = 9.73) → **9 pts**, where the remaining $8.99 item earns
**8** when bought on its own. Points *are* reversed (a full return leaves 0), the base is just inconsistent.

### Non-defect observations
* The service worker registers (`scope /pos/`, `activated`) and **controls** the page after a reload; the
  precache holds 59 entries and an offline reload of `/pos/sell` renders the shell. `controller` is `null` on
  the very first load only (expected — that client is not yet claimed).
* Rejection messages *are* stripped of HTML before display — the raw ERPNext stock error
  (`<strong>32.0</strong> units of <a href="/app/Form/Item/ACC-003">…`) renders as clean prose in both the
  Queue and the receipt panel (`133-receipt-rejected-html.png`). The raw HTML with `/app/Form/…` desk links is
  still what gets stored in `Maison Sync Log.error`.
* **No POS screen renders "Frappe" or "ERPNext" in visible text** — nine screens walked (Sell, Client, Returns,
  Web orders, Count, Receive, Queue, Shift, Settings) plus Unlock, Pay, Receipt and the guest receipt page. The
  only occurrence anywhere is the deployment hostname `cloudchaserz.frappe.cloud` inside the receipt-link URL,
  which is unavoidable. Two *server* error paths do leak internal Python identifiers into the UI, though
  (`maison_pos.api.sales.submit_batch`, `maison_pos.api.returns.ManagerRequiredError`) — D5 and D9.
* **Console is clean.** Every error captured across 16 runs traces to a deliberate negative test
  (403 wrong PIN / expired session, 401 PIN, 402 simulated decline, 417 rejected sync). The only other entries
  are an IndexedDB "another connection wants to delete database" warning caused by my own device-reset helper,
  and one service-worker registration failure in the very first run before the Playwright SW flag was enabled.

---

## Full results

### 1 · Unlock, clock in/out, lock

| # | Test | Result | Evidence |
|---|---|---|---|
| 1.1 | Catalogue loads from the Unlock screen | **PASS** | keypad in 1.7 s; `001-unlock-loaded.png` |
| 1.1b | No Frappe/ERPNext wording on Unlock | **PASS** | full body text checked |
| 1.2 | Correct PIN unlocks to Sell | **PASS** | `003-sell-unlocked.png` |
| 1.2b | No Frappe/ERPNext wording on Sell | **PASS** | |
| 1.3 | Wrong PIN refused, message names the associate | **PASS** | "Incorrect PIN for Dante Ruiz"; `002-unlock-wrong-pin.png` |
| 1.4 | Another associate's PIN (Keisha's 1357 with Dante selected) refused | **PASS** | still "Incorrect PIN for **Dante Ruiz**" — the named-person message does exactly its job |
| 1.5 | Clock in → on shift | **PASS** | "On shift since Aug 23, 2026, 14:19"; `005-clocked-in.png` |
| 1.5b | Clock-in recorded server-side | **PASS** | `Maison Shift 1j9u8depbn`, status *On shift* |
| 1.6 | Clock out works and never opens the till | **PASS** | "Clocked out · 0m worked", stays on `/pos/unlock`; `006` |
| 1.7 | Lock returns to the unlock screen | **PASS** | `004-locked.png` |
| 1.8 | PIN lockout after 5 failures (implemented) | **PASS** | `failed_pin_attempts = 5` |
| 1.8b | UI says the PIN is *locked* | **FAIL — D6** | still "Incorrect PIN for Keisha Brown"; `007` |
| 1.8c | Correct PIN refused while locked | **PASS** | |

### 2 · Selling

| # | Test | Result | Evidence |
|---|---|---|---|
| 2.1 | Add by tapping a tile | **PASS** | ACC-015 → $7.57 (6.99 + 8.25 %); `011` |
| 2.2 | Add by search (name) | **PASS** | "Mouth Tips" → 1 tile → basket |
| 2.2b | Search by item code | **PASS** | "ACC-005" → Butane Refill |
| 2.3 | Barcode wedge — type EAN `2003645894131` + Enter | **PASS** | Boveda added, focus outside a text field; `012` |
| 2.3b | Unknown barcode refused, nothing added | **PASS** | notice *"Not in catalogue — 2000000000001 · tap Search"*; `131` |
| 2.4 | Quantity + / − | **PASS** | 1→3→2 |
| 2.4b | Decrement past 1 removes the line | **PASS** | |
| 2.5 | Line discount by % (10 %) | **PASS** | −$0.70 on the line and a Discount row in totals; `014` |
| 2.5b | Line discount by amount ($1.50) | **PASS** | |
| 2.6 | Remove line | **PASS** | |
| 2.7 | Clear basket | **PASS** | "Basket empty" |
| 2.7b | Clear a 40+ line basket | **PASS** | |
| 2.8 | 40+ line basket renders and totals to the cent | **PASS** | 42 lines, net $1,363.43, tax $112.45, total $1,475.88 — matches the per-line model exactly; `017` |
| 2.9 | Basket tax = 8.25 % of net, per the store template | **PASS (client model)** | 46.97 → 3.87; `015` |
| 2.9b | Server invoice tax equals what the POS charged | **FAIL — D1** | server 3.88 / 50.85 vs POS 3.87 / 50.84 |
| 2.9c | The sale is accepted by the server | **FAIL — D1** | `Payments (50.84) do not cover the invoice total (50.85)`; `016` |
| 2.10 | A service (non-stock) item can be sold | **PASS** | SVC-004 tile reads "Service", not stock-gated |
| 2.10b | Service sale posts server-side | **PASS** | `ACC-SINV-2026-03047`, $5.41; `018` |

### 3 · Payments

| # | Test | Result | Evidence |
|---|---|---|---|
| 3.1 | Cash — no tender typed defaults to exact, change $0.00 | **PASS** | `021` |
| 3.2 | Cash — over-tender computes change | **PASS** | $20.00 on $1.94 → $18.06; `023` |
| 3.2b | Receipt prints tendered + change | **PASS** | `024` |
| 3.2c | Change booked on the invoice | **INFO — D11** | `change_amount = 0`, `paid_amount = 1.94` |
| 3.3 | Cash — under-tender blocks completion | **PASS** | "Short $0.94", Complete disabled; `022` |
| 3.4 | Card via the simulated reader | **PASS** | discover→connect→collect→process→approved, `pi_sim_…` on the invoice; `026` |
| 3.4b | Card brand / last-4 stored on the invoice | **FAIL — D7** | receipt has VISA ****4242, invoice has `null` |
| 3.4c | Returns screen can name the card it refunds | **FAIL — D7** | reads "Original card — Card ••••"; `132` |
| 3.5 | Split cash + card | **FAIL (not supported) — D10** | single-mode Pay screen, one payment row |
| 3.6 | Cancel mid-payment | **PASS** | cancelled during "Discovering readers"; back on Sell, basket intact, no invoice; `025` |
| 3.7 | Decline path (processor error on capture) | **PASS** | error shown on the reader panel, **Retry card** offered, no sale created; `027` |
| 3.7b | Retry after a decline completes the sale exactly once | **PASS** | `ACC-SINV-2026-03050` |
| 3.8 | Card sale whose per-line tax rounds **up** | **FAIL — D1** | `Card payments exceed the invoice total`; `028` |

### 4 · Receipt

| # | Test | Result | Evidence |
|---|---|---|---|
| 4.1 | QR renders on the 80 mm preview | **PASS** | 98×98 px `img`; `031` |
| 4.2 | Receipt link opens as a guest (no session) | **PASS** | `GET /r/RlRqM2REba2CD_ds` → 200, shows the invoice; `032` |
| 4.2b | Guest receipt page has no Frappe/ERPNext wording | **PASS** | only the hostname in the URL |
| 4.3 | Points line matches the server ledger | **PASS** | receipt "Points earned 8" = `Loyalty Point Entry` 8 |
| 4.3a | Client attaches by client № | **PASS** | MC699911 → Andre Baptiste, tier + balance on the card |
| 4.4 | Print → reader canvas route (V660p) | **PASS** | 41 KB PNG handed to the reader, "Printed on Counter 1 · V660p"; `034` |
| 4.4b | Print → browser dialog fallback | **PASS** | route forced to *browser*, `window.print()` called once; `035` |
| 4.5 | Email receipt actually sends / queues | **FAIL — D4** | button says "Email queued"; nothing server-side; `036` |
| 4.6 | Receipt screen free of Frappe/ERPNext wording | **PASS** | |

### 5 · Age verification (21+) — no failures

| # | Test | Result | Evidence |
|---|---|---|---|
| 5.1 | Restricted item raises the gate and is **not** added | **PASS** | "Check ID · 21+", basket unchanged; `041` |
| 5.2 | Under-21 DOB refused | **PASS** | "Under 21 — sale of age-restricted items refused"; `042` |
| 5.2b | Refusal audited (masked) | **PASS** | `Maison Age Check` outcome *Underage*, age 19, dob_year 2007, **no name/licence number** |
| 5.3 | Expired ID refused (manual) | **PASS** | "ID expired — ask for a valid ID"; `043` |
| 5.3b | Expired outcome audited | **PASS** | `id_expired = 1` |
| 5.3c | Expired ID refused on the scan path | **PASS** | AAMVA with `DBA` in the past |
| 5.4 | Valid manual DOB passes, parked item added | **PASS** | `046` |
| 5.5 | AAMVA PDF417 scan passes | **PASS** | synthetic ANSI 636015 payload; `048` |
| 5.5b | Non-licence payload rejected clearly | **PASS** | "That is not a driver's licence barcode — scan the PDF417 on the back of the ID"; `049` |
| 5.5c | Scan-verified sale records `method = Scan` | **PASS** | `ACC-SINV-2026-03054` |
| 5.6 | Non-restricted item unaffected | **PASS** | no gate |
| 5.7 | The check is stored on the invoice | **PASS** | `maison_age_verified=1, method=Manual, dob_year_ok=1, checked_by, checked_at, maison_age_check` |
| 5.7b | Audit row linked back to the invoice, masked only | **PASS** | `sales_invoice`, outcome *Verified*, `initials=AQ`, `dob_year=1990` — no PII |
| 5.7c | Receipt records the check | **PASS** | "ID CHECKED · 21+ VERIFIED"; `144` |
| 5.8 | "No ID" declines: parked items dropped | **PASS** | |
| 5.8b | Decline audited | **PASS** | outcome *Declined*, reason *declined* |
| 5.9 | One passed check covers the rest of the transaction | **PASS** | second restricted item added with no re-gate |
| 5.10 | The check does not leak into the next transaction | **PASS** | gate reopens after the sale |
| 5.11 | Server refuses a restricted sale posted with no check | **PASS** | direct API call → `AGE_VERIFICATION`: "Age verification (21+) is required for: DSP-004", no invoice |

### 6 · Offline

| # | Test | Result | Evidence |
|---|---|---|---|
| 6.0 | Service worker registered and controlling `/pos` | **PASS** | scope `/pos/`, *activated*, controller set after reload; precache 59 entries |
| 6.1 | Selling continues after the network drops | **PASS** | top bar flips to OFFLINE, cached catalogue still rings up; `051` |
| 6.1b | Cash sale completes offline and is queued | **PASS** | pill "Queued offline"; `052` |
| 6.1c | Offline receipt explains the missing QR | **PASS** | "Available once the sale has synced" — no broken link |
| 6.2 | Queue lists the pending sale | **PASS** | "1 pending"; `053` |
| 6.3 | Reload while offline still renders the shell | **PASS** | no Chromium error page, app routes normally; `054` |
| 6.3b | PIN unlock works offline from the cached digest | **PASS** | |
| 6.4 | Queue drains when the network returns | **PASS** | "0 pending · 1 synced"; `055` |
| 6.5 | The offline sale exists server-side **exactly once** | **PASS** | 1 invoice for the uuid |
| 6.5b | Replaying the same `offline_uuid` creates no second invoice | **PASS** | server answered `status: "duplicate"` with the original invoice + token |
| 6.6 | Stock conflict refused server-side | **PASS** | offline sale of 41 × ACC-003 (9 in stock) → "32.0 units … needed in Warehouse HOU-MTR - CCZ"; `061` |
| 6.6b | The refused sale moved no stock | **PASS** | bin 9 → 9 |
| 6.6c | Rejection readable in the Queue (no HTML / traceback) | **PASS** | tags stripped for display |
| 6.6d | Rejection readable on the receipt screen | **PASS** | `133` |
| 6.7 | The 21+ gate still works offline (rules run on the device) | **PASS** | `062` |
| 6.7b | An offline sale of an age-restricted item syncs | **FAIL — D2** | MariaDB datetime error, no invoice; `063` |

### 7 · Returns & exchanges

| # | Test | Result | Evidence |
|---|---|---|---|
| 7.1 | Partial line return → credit note for that line only | **PASS** | `…03057` −$7.57 against `…03056`; `072` |
| 7.2 | Full return of the remaining line, cash refund | **PASS** | `…03058` −$9.73; original becomes *Credit Note Issued*; `078` |
| 7.2b | An already-returned line is flagged and cannot be returned twice | **PASS** | "1 RETURNED" pill, line disabled; `077` |
| 7.3 | Find the sale by receipt QR (pasted `…/r/<token>`) | **PASS** | resolves to the invoice |
| 7.4 | Find by invoice number | **PASS** | `071` |
| 7.4b | Find by client name | **PASS** | 4 results, picked the right one; `079` |
| 7.5 | Reasons + conditions per line | **PASS** | Change of mind / Defect / Sizing / Gift return / Other · Sellable / Damaged |
| 7.5b | Damaged goes to the store's Damaged warehouse, not the floor | **PASS** | `HOU-MTR Damaged - CCZ` 0 → 1, sales floor unchanged; `080` |
| 7.6 | Refund to the original card | **PASS** | `Stripe refund re_sim_… (simulated)`; `073` |
| 7.7 | Refund to store credit | **PASS** | `maison_refund_method = Store Credit`, credit note outstanding −$16.23 on the account; `081` |
| 7.8 | Exchange, positive difference | **PASS** | $1.79 → $24.99 tee: "Client pays $25.11"; `095` |
| 7.8b | Exchange posts a credit note **and** a new sale | **PASS** | CN `…03064` + sale `…03065`; `096` |
| 7.8c | Exchange, negative difference | **PASS** | $24.99 → $1.79: "Refund to client $25.11"; `097` |
| 7.8d | Negative exchange completes and states what was refunded | **PASS** | `098` |
| 7.9 | Manager PIN threshold ($2,500) | **PASS** | $2,598 refund → "Manager PIN required — above $2,500.00"; `091` |
| 7.9b | The PIN modal explains why | **PASS** | `092` |
| 7.9c | Wrong manager PIN refused | **PASS** (wording — D9) | "…ManagerRequiredError: Manager PIN incorrect"; `093` |
| 7.9d | Correct manager PIN releases the refund and is recorded | **PASS** | `maison_manager_approved_by = hou.mtr.manager@…`; `094` |
| 7.10 | Points reversal | **PASS** | full return removes them (0 pts / $0.00 purchase amount); partial return recomputes — see D12 |
| 7.11 | Return receipt prints | **PASS** | 42 KB canvas on Counter 1 · V660p; `074` |
| 7.12 | An exchange can be cancelled / undone | **FAIL — D8** | circular `maison_exchange_invoice`; Frappe refuses both |

### 8 · Edge cases

| # | Test | Result | Evidence |
|---|---|---|---|
| 8.1 | Triple-tapping CHARGE creates exactly one sale | **PASS** | 1 invoice for the uuid; `101` |
| 8.2 | Browser Back from the receipt does not re-charge | **PASS** | lands on Sell, still 1 invoice; `102` |
| 8.2b | Browser Back from Pay keeps the basket | **PASS** | |
| 8.3 | A sale rung up after the session expired is kept, not lost | **PASS** | held in the queue as Rejected, recoverable; `161` |
| 8.3b | The message names the real problem, without internals | **FAIL — D5** | "…Login to access**Function maison_pos.api.sales.submit_batch is not whitelisted.**"; `161` |
| 8.3c | "Sync now" recovers it automatically | **FAIL — D5** | stays `0 pending · 1 rejected`; `162` |
| 8.3d | The per-row **Retry** recovers it | **PASS** | `ACC-SINV-2026-03078` created; `151` |
| 8.4 | A second tab on the same till asks for the PIN again | **PASS** | `/pos/queue` → `/pos/unlock?next=/queue` (unlock is per-tab `sessionStorage`); `111` |
| 8.4b | Two tabs: independent baskets, one shared sync queue | **PASS** | tab 2's sale appears in tab 1's queue; `112` |
| 8.5 | Very large amounts | **PASS** | 121 × $100 → $13,098.25, formatting and math exact; `103` |
| 8.6 | A $0.00 (fully discounted) sale can be completed | **FAIL — D3** | `Invoice has no payments`; `105` |
| 8.7 | No POS screen renders "Frappe" / "ERPNext" | **PASS** | 9 screens walked; `115`–`123` |

---

## Clean-up

**Everything I created was reversed and stock is back to where it started.**

* **24 Sales Invoices cancelled** (`ACC-SINV-2026-03047` … `03062`, `03069` … `03075`, `03078`) via `frappe.client.cancel`.
* **6 invoices could not be cancelled** — the exchange pairs `03063/03064/03065` and `03066/03067/03068`
  (defect **D8**, circular link). I neutralised them with the product's own `sales.void` as the HOU-MTR manager,
  which added credit notes `03076` and `03077`. **Net residual across all eight: $0.00.**
* **Stock verified restored**: all 16 items I touched at `HOU-MTR - CCZ` are back to their pre-run quantities
  (0 drift), and `HOU-MTR Damaged - CCZ` is back to 0.
* **Loyalty**: Andre Baptiste's point entries created by my sales were removed with the cancellations; his
  balance is back to 0, as it was before the run.
* **PIN counters reset**: `failed_pin_attempts` set back to 0 for both HOU-MTR associates after the lockout test
  (1.8) — Keisha Brown's till is usable again.
* Dante Ruiz was clocked in and out once (1.5/1.6) — one closed `Maison Shift` row, left in place.

**Left behind on purpose / could not be removed**

* 8 zero-net Sales Invoices from the two exchanges (above).
* ~14 `Maison Age Check` audit rows (Verified / Underage / Expired / Declined) — deliberately kept; these are
  the compliance trail the feature exists to produce, and they hold no personal data.
* ~6 `Maison Sync Log` rows with status *Error* — the evidence for D1, D2 and D3. Left as-is.
* Nothing global was touched: no brand, timezone, feature flag, POS setting or seed was changed, and no other
  agent's data was modified or deleted.
