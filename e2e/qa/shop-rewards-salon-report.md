# QA — web shop, rewards & Salon on the live CloudChaserz site

**Agent 4 of 6.** Areas: **A** web shop + click & collect · **B** rewards / loyalty / promotions / feedback ·
**C** Salon client display + client recognition. (POS core, warehouse, dashboard, security and white-label
belong to the other agents and were left alone except where an area of mine crosses them — those crossings are
marked *cross-ref*.)

* Site: **https://cloudchaserz.frappe.cloud** (bench-46369, apps `frappe / erpnext / payments / webshop / hrms / maison_pos`)
* Date: **2026-08-23, 16:50 – 18:05 America/Chicago** (site time zone; the site clock is now correctly `America/Chicago`)
* Stores used: **OK-BA** (CloudChaserz Broken Arrow) for every POS/Salon step, **OK-OWA** only as the "other store"
  in scoping checks. HOU-MTR / OK-JENKS were not touched.
* Browsers: Playwright 1.56 / Chromium 1194 through `e2e/cloud-bridge.mjs` (`BRIDGE=1`), viewports
  1440×900 (shop), 390×844 (phone), 1440×1024 (POS), 1024×1366 + 1366×1024 (Salon iPad).
* Scripts (new, test-only — **no application source was modified**): `e2e/qa/lib-srs.mjs`, `s1`…`s14`, `z-cleanup*`.
* Screenshots: **`e2e/qa/shots-srs/`** (114). Raw results: `e2e/qa/results-s*.json`, logs `log-s10.txt`, `log-s11.txt`,
  cleanup ledger `cleanup-s*.json`.

Re-run (one example):

```bash
curl -s -X POST https://cloud.frappe.io/api/method/press.api.site.login -H "Authorization: Token <press>" \
  -H 'Content-Type: application/json' -d '{"name":"cloudchaserz.frappe.cloud","reason":"QA"}' \
  | python3 -c "import sys,json;open('/tmp/ccsid','w').write(json.load(sys.stdin)['message']['sid'])"
cd /home/claude/maison/e2e/qa
BRIDGE=1 NODE_USE_ENV_PROXY=1 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers RUNTAG=QA4A node s1-shop-guest.mjs
```

## Score

| Area | Checks | Pass | Fail | Distinct defects |
|---|---|---|---|---|
| **A — web shop / click & collect** | 105 | 97 | 8 | 5 (1 critical, 1 major, 2 moderate/minor, 1 minor) |
| **B — rewards / promotions / feedback** | 91 | 84 | 7 | 3 (3 major) — 4 of the 7 fails were my own assertion bugs, re-tested green |
| **C — Salon / recognition** | 73 | 64 | 9 | 2 (2 moderate) — 6 of the 9 fails were harness timing, re-tested green |
| **Total** | **271** | **246** | **24** | **10** |

Console errors across every run: none from the application. The only recurring browser warning is
`service worker registration failed … 403` inside the POS contexts — that is the sandbox bridge, not the site
(`GET /api/method/maison_pos.api.pwa.service_worker` returns **200 application/javascript** to both guest and
Administrator over plain curl).

## Defects, most severe first

| # | Sev | Area | Defect | Suspected code |
|---|---|---|---|---|
| **A1** | **critical** | A | **The web shop cannot take an order from a new customer.** `Website Settings.disable_signup = 1`, `Portal Settings.default_role` is unset and the site has **no Website User at all**; `sign_up` answers `Sign Up is disabled` and `/login` shows no sign-up link. Since `/cart` and `/shop/checkout` require a login (`www/shop/_common.py::require_login`), the whole storefront is browse-only. The Maison demo seed creates a shopper and sets the portal role (`setup/demo_v04_webshop.py::ensure_web_user`, lines 258-281) — the CloudChaserz seed never calls it. | `maison_pos/setup/cloudchaserz/catalog.py::seed_webshop` (calls `create_webshop_custom_fields / ensure_payment_gateway / ensure_webshop_settings` but **not** `web.ensure_web_user()`); `Website Settings.disable_signup` on the site |
| **B2** | **major** | B | **Public rewards sign-up can hijack an existing member.** Posting the join form with a member's phone (or e-mail) returns **200 with that member's client number** and silently overwrites their `customer_name` with whatever the stranger typed. There is no "you're already a member" branch. | `maison_pos/api/rewards.py::signup` → `maison_pos/api/customers.py::upsert` lines 261-274 (matches by `mobile_no`/`email_id`, then `doc.update(values)` with the posted name) |
| **B1** | **major** | B | **The 21+ / terms consent is not enforced server-side.** `signup(..., consent=0, consent_email=1)` succeeds: the guard is `if not consent and not (consent_email or consent_sms)`, and the marketing e-mail box is ticked by default in the form, so any caller that skips the browser can join without the age affirmation the page presents as *Required*. | `maison_pos/api/rewards.py::signup` line ~692: `if not cint(consent) and not (cint(consent_email) or cint(consent_sms))` — should require `consent` on its own |
| **A2** | **major** | A | **Product page scrolls sideways by 435 px on a 390 px phone** (and the availability pill is clipped even at 1440 px). `city_label()` joins every city that has stock — with 11 CloudChaserz stores that is "Available at Tulsa, Broken Arrow, Jenks, Houston, Muskogee, Owasso, Sapulpa" — inside `.mw-pill { white-space: nowrap }`, whose 730 px min-content widens the `1fr` grid track to 790 px. Harmless on 3-boutique Maison, broken on this tenant. | `maison_pos/webshop/core.py::city_label` (no cap) + `maison_pos/public/css/maison-web.css:225` (`.mw-pill` nowrap) / `:302` (`.mw-item` grid) |
| **B3** | **major** | B | **A sale can no longer be returned once its points have been spent.** The POS return raises ERPNext's *"Sales Invoice can't be cancelled since the Loyalty Points earned has been redeemed. First cancel the Sales Invoice No ACC-SINV-…"* — the counter cannot refund the customer and the message points at an unrelated later invoice. Returns against sales whose points are untouched work perfectly (points reversed, balance never negative). | `maison_pos/api/returns.py::return_items` → `_build_credit_note` insert; ERPNext `sales_invoice.validate_loyalty_points`. Needs either a pre-flight check with a clear message or a compensating point adjustment |
| **A3** | moderate | A | **`/shop/checkout` scrolls sideways by 104 px on a 390 px phone** — `.mw-boutique` is `grid-template-columns: 24px 1fr auto` with no phone breakpoint, so the address + "All pieces in boutique" column runs off the screen. | `maison_pos/public/css/maison-web.css:375` (`.mw-boutique`, no `@media (max-width: 600px)` rule) |
| **C1** | moderate | C | **A client number cannot be entered on the Salon.** The identify screen offers "Phone or client №" and a digits-only keypad, but the server only accepts the printed form `MC######` (`^MC\d{6}$`); typing `647413` answers "We could not find you". The same value with the prefix identifies correctly over the API. | `frontend/src/salon/views/SalonIdentify.vue` + `components/SalonKeypad.vue` (no letters, no prefix) vs `maison_pos/api/salon.py::_resolve_code` (`is_client_number` requires `MC`) |
| **C2** | moderate | C | **The Salon ambient screen has nothing to show.** There is no `Maison Salon Playlist` on the site (0 rows), so between sales the client display shows only the wordmark, the clock and the welcome line — the "curated pieces floating in and out" never appear. The Maison seed creates two playlists; the CloudChaserz seed has no Salon step at all. | `maison_pos/setup/cloudchaserz/__init__.py` (no salon/playlist seeding; cf. `maison_pos/setup/demo_v05_salon.py`) |
| **A4** | minor | A | **`/shop/collection` shows 96 of 155 published products and has no pagination** — 59 products can only be reached through a category chip or a search. | `maison_pos/www/shop/collection.py:23` (`catalogue(..., limit=96)`, no `start`/next-page control in `collection.html`) |
| **A5** | minor | A | **An age-restricted product can be put in the bag through the API.** `update_cart` has no web-mode guard; `place_order` then refuses the whole basket with a generic message, leaving a bag the shopper must fix by hand. The storefront itself never offers the button (it shows "Available in store"), so this is API/stale-cart only. | `maison_pos/api/webshop.py::update_cart` (line 424 — no `core.effective_web_mode` check, unlike `place_order` line 512) |

### Verified-fixed / not reproduced

* **D5 from the v0.6 report** (Walk-in Customer enrolled in the rewards programme with 61 045 points) is **fixed**:
  `Walk-in Customer.loyalty_program` and `.maison_client_number` are now null, and `_is_walk_in` kept the placeholder
  out of my anonymous baskets.
* The site time zone (v0.6 observation 1) is now **America/Chicago**.

## Observations (not defects)

1. **Points on a redeeming sale are earned on `net_total − loyalty_amount`.** Redeeming $15 on a $119.98 basket
   earned 104 points, not 119 (`api/rewards.py::rebase_points_on_net`, `eligible = net_total - loyalty_amount`).
   Defensible ("you earn on what you paid") and consistent with ERPNext, but `/rewards` only promises
   "1 point for every $1 you spend" — worth a line of copy or a decision.
2. **The Salon thank-you screen self-clears 20 s after the last touch**, taking the receipt QR, "How was your
   visit?" and the private-viewing invitation with it. A client who reaches for their phone loses the QR; the
   countdown is shown ("This screen clears in N s") but 20 s is short for a scan + a rating.
3. **Jewellery / Maison vocabulary survives on the storefront** (cross-ref agent 6): "excl. tax · collected in
   **boutique**" on every product page, "ALL PIECES IN **BOUTIQUE**" and "Sales tax · Of the **boutique** of
   collection" on checkout, "Pieces in your bag are not reserved…" on the bag, and the POS web-order detail says
   "**Pieces** to prepare" / "16 in **boutique**". `store_noun` is `Store` for this tenant.
   (`www/shop/checkout.html:14`, `cart.html:21`, `templates/webshop/item.html:35`, `views/WebOrdersView.vue:187,195`.)
4. **80 mm receipt amounts carry no currency symbol** — "NEXT REWARD 15.00 off at 300 pts (98 to go)" — consistent
   with every other line on that receipt (`utils/money.ts::fmtAmount`), while the public `/r/` page prints
   "$5.00 off at 100 pts". Cosmetic, but the two receipts differ.
5. **Three rewards jobs have never run** on this site (`rewards.issue_birthday_coupons`,
   `rewards.send_monthly_promotions`, `rewards.new_arrivals_campaign` all have `last_execution = null`, while
   `inventory.low_stock_digest` ran today). The scheduler is enabled and the rows are not stopped, so this is most
   likely "created at the last migrate, first daily window not yet reached" — but it means a demo opened today
   shows no birthday coupons and no monthly-promotion campaign unless the job is run by hand.
   I triggered the birthday job once through **Scheduled Job Type → Execute** (no setting changed) to test it.
6. **The seeded promotion calendar rows are still `Planned`** (`PROMO-2026-08`, `PROMO-2026-09`) and
   `campaign`/`sent_on` are empty, because `send_monthly_promotions` only acts on the 1st.
7. **Store stock is thin for a demo**: OK-BA had 9 units of the $59.99 Blazer torch, and my test sales exhausted
   it mid-run (the sale was correctly refused with a NegativeStock error). Everything was restored by the cleanup.
8. **The Salon and the shop are correctly brand-tokenised otherwise** — `/shop`, `/rewards`, the Salon wordmark,
   the join screen and the receipt all read CloudChaserz, and `/rewards` carries the client's exact copy.

## Area A — web shop and click & collect

| Test | Result | Evidence | Severity |
|---|---|---|---|
| guest catalogue API returns items + groups | pass | 155 items, 11 groups, 28 buyable, 127 in-store-only | — |
| webshop_age_restricted_sales is OFF (precondition) | pass | webshop_age_restricted_sales=0 minimum_age=21 | — |
| /shop home renders (hero, categories, featured) | pass | hero="Order online. Pick up in store today." cards=8 collection-tiles=25 | — |
| home lists stores ("Where to find us") | pass | 11 stores with addresses | — |
| /shop/collection lists the catalogue | pass | 96 cards | — |
| collection filters by category | pass | 17/96 cards, groups=Accessories | — |
| collection search finds matching products | pass | q=grinder → 2 hits, both grinders | — |
| collection search with no hits shows the empty state | pass | 0 cards + empty state | — |
| collection filters by mode=Buy (only purchasable) | pass | 19 cards, no Enquire/In-store labels | — |
| /all-products serves the Maison listing | pass | 96 cards | — |
| buyable product page shows "Add to bag" | pass | ACC-007 Aluminum 4-pc Grinder | — |
| product page shows availability per store | pass | 11 store rows | — |
| age-restricted item is NOT purchasable online | pass | DSP-001: add-to-bag buttons=0, reserve=0 | — |
| age-restricted item says "Available in store" | pass | cta=1 · "Age-restricted (21+) products are sold in store only — bring a valid government ID." | — |
| age-restricted item shows the 21+ / ID spec | pass | AGE 21+ · ID required | — |
| listing marks age-restricted cards "21+ / In store · 21+" | pass | pills=26 modes=In store · 21+ | — |
| availability API reports in_store_only + Enquire mode | pass | {"mode":"Enquire","in_store_only":true,"chain_qty":327} | — |
| /shop/boutiques lists the stores | pass | Broken Arrow / Tulsa / Houston present | — |
| guest /cart redirects to sign-in | pass | 301 → /login?redirect-to=/cart | — |
| /shop/collection shows the whole catalogue (or paginates) | FAIL | 96 of 155 published products are listed and there is no pagination control — 59 products are unreachable by browsing (reachable only via a category or search). `001-shop-home-1440.png` | minor (A4) |
| mobile 390x844: no horizontal overflow on the shop pages | FAIL | product page scrollWidth 825 px in a 390 px viewport (**+435 px**); home/collection/boutiques/rewards/account are 0. Culprit isolated by bisection: the `.mw-avail .head .mw-pill` "Available at Tulsa, Broken Arrow, Jenks, Houston, Muskogee, Owasso, Sapulpa" (min-content 730 px, `white-space: nowrap`). `009-m-item-age-390.png`, `013-m-item-overflow-390.png` | **major (A2)** |
| mobile CTA buttons are ≥44 px tall | n/a | test artefact: the hidden "View bag" button measured 0 px; all visible CTAs are ≥44 px | — |
| a new shopper can sign up on the web shop | FAIL | `Website Settings.disable_signup = 1`, `Portal Settings.default_role = null`, **0 Website Users on the site** before I created test ones. `POST frappe.core.doctype.user.user.sign_up` → `ValidationError: Sign Up is disabled`. The bag/checkout require a login (`/cart` 301 → `/login?redirect-to=/cart`), so **no new customer can place a web order at all**. `026-shop-login.png` | **critical (A1)** |
| /login offers a "Sign up" route for new shoppers | FAIL | the login page shows no sign-up link (consequence of A1). `026-shop-login.png` | **critical (A1)** |
| test shopper qa4.newshopper.qa4a@cloudchaserz.example exists with the Customer role | pass | Website User · roles=Customer | — |
| test shopper qa4.client.qa4a@cloudchaserz.example exists with the Customer role | pass | Website User · roles=Customer | — |
| existing shopper is linked to a rewards member (Contact → Customer) | pass | qa4.client.qa4a@cloudchaserz.example → QA4 Member QA4A (MC647413) contact=QA4 Member Shopper QA4A-QA4 Member QA4A | — |
| qa4.newshopper.qa4a can sign in | pass | 200 | — |
| qa4.client.qa4a can sign in | pass | 200 | — |
| "Add to bag" adds the line and offers "View bag" | pass | ACC-007 | — |
| bag lists both lines | pass | 2 lines | — |
| quantity + updates the line and the totals | pass | qty=2 server=[["ACC-007",2],["ACC-002",1]] total=41.77 | — |
| quantity − updates the line | pass | [["ACC-007",1],["ACC-002",1]] | — |
| Remove deletes the line | pass | ["ACC-007"] | — |
| removing the last line empties the bag cleanly | pass | [] | — |
| empty bag shows the empty state | pass |  | — |
| age-restricted item cannot be added to the bag | FAIL | `maison_pos.api.webshop.update_cart(DSP-001, 1)` → 200 and the line sits in the bag; `place_order` then refuses with "…cannot be bought online — please enquire or reserve it instead", so the bag is stuck until the shopper removes it. The storefront never offers the button, so this is reachable only through the API/an older cart. `033-shop-cart-age-restricted.png` | minor (A5) |
| …and checkout refuses it | pass | place_order → 417 frappe.exceptions.ValidationError: Geek Bar Pulse 15K — Miami Mint cannot be bought online — please enquire or reserve it instead | — |
| checkout offers every store as a collection point (with stock status) | pass | 11: CloudChaserz Bixby 11063-B S Memorial Dr · Tulsa, OK 74133 ALL PIECES  \| CloudChaserz Broken Arrow 6420 S Elm Pl · Broken Arrow, OK 74011 ALL P | — |
| the warehouse (HOU-WH) is not offered as a collection point | pass | OK-BIX,OK-BA,OK-ETUL,OK-JENKS,OK-MINGO,HOU-MTR,OK-MUS,OK-OWA,OK-SAP,OK-STUL,OK-YALE | — |
| placing the order goes to the payment page | pass | https://cloudchaserz.frappe.cloud/shop/pay?pr=ACC-PRQ-2026-00002 | — |
| simulated payment returns to the order page | pass | https://cloudchaserz.frappe.cloud/shop/order?name=SAL-ORD-2026-00002&paid=1 | — |
| Sales Order carries the web-order fields and the chosen store | pass | SAL-ORD-2026-00002 boutique=OK-BA status=New order_type=Sales total=43.35 taxes=OK Sales Tax (Broken Arrow) - CCZ | — |
| online payment is recorded as an advance on the order | pass | advance_paid=43.35 maison_prepaid_amount=43.35 payment_entries=[] | — |
| the order is taxed with the collecting store template | pass | OK Sales Tax (Broken Arrow) - CCZ → 3.37 | — |
| order history lists the order | pass | 1 rows | — |
| order page shows the collection timeline and store | pass | CLOUDCHASERZ MAISON POS ALL PRODUCTS ACCESSORIES CBD & HEMP DEVICES & MODS DISPOSABLES E-LIQUID GLASS & RIGS HOOKAH & SHISHA KRATOM PODS & C | — |
| fully prepaid order shows no "payment due" | pass | none | — |
| another shopper cannot see this order in my_orders | pass | 0 orders for the other shopper | — |
| another shopper cannot open this order by name | pass | 403 frappe.exceptions.PermissionError: Not permitted | — |
| Sales Order carries the web-order fields and the chosen store | pass | SAL-ORD-2026-00003 boutique=OK-BA status=New order_type=Sales total=43.35 taxes=OK Sales Tax (Broken Arrow) - CCZ | — |
| another shopper cannot see this order in my_orders | pass | 1 orders for the other shopper | — |
| web-order queue of the store lists both new orders | pass | 3 open at OK-BA; counts={"New":2,"Picking":0,"Ready":1,"Collected":0} | — |
| an associate cannot read another store's web-order queue | pass | OK-OWA → 403 frappe.exceptions.PermissionError: You are not permitted to act on boutique OK-OWA | — |
| the order does not appear in another store's queue | pass | OK-OWA queue = 0 orders | — |
| POS "Web orders" queue shows the orders for this store | pass | 3 rows: SAL-ORD-2026-00003,SAL-ORD-2026-00001,SAL-ORD-2026-00002 | — |
| a fully prepaid order is flagged "Paid online" | pass | QA4 Impostor2 QA4A READY SAL-ORD-2026-00003 · 2 pieces · 5 min ago · Paid online $43.35 | — |
| order detail shows lines, stock in this store, totals and balance | pass | SAL-ORD-2026-00003 · AUG 23, 2026, 16:56 QA4 IMPOSTOR2 QA4A +1 918 555 9407 · qa4.client.qa4a@cloudchaserz.example NEW PICKING READY COLLECTED PIECES TO PREPARE Aluminum 4-pc Grinder 2.5" ACC-007 · 2 × $19.99 16 in boutique $39.98 Subtotal $39.98 Tax $3.37 Tot | — |
| Ready → "Back to picking" returns the order to Picking | pass | walked back from Ready | — |
| "Start picking" moves the order to Picking | pass | {"maison_web_status":"Picking"} | — |
| "Mark ready" moves the order to Ready | pass | {"maison_web_status":"Ready"} | — |
| the shopper's order page reflects "Ready" | pass | status=Ready | — |
| Collect loads the order into the cart and opens Pay | pass | CASH CARD AMOUNT DUE $0.00 Web order SAL-ORD-2026-00003 · paid online $43.35 of $43.35 2 items · QA4 Impostor2 QA4A · MC647413 TENDERED $0.00 $0.00 CHANGE $0.00 1 2 3 4 5 6 7 8 9 . 0 ← BACK COMPLETE C | — |
| collection completes and syncs | pass | pill=Synced uuid=a74881b9-6fbc-437b-9f08-e57c532512e9 | — |
| collection creates a submitted Sales Invoice | pass | {"name":"ACC-SINV-2026-03081","grand_total":43.35,"net_total":39.98,"total_taxes_and_charges":3.37,"docstatus":1,"is_return":0,"customer":"QA4 Member QA4A","maison_receipt_token":"eOdOPPKsgHe6Qf3M","maison_boutique":"OK-BA","rounded_total":43.35,"loyalty_point | — |
| the online payment is allocated as an advance on the invoice | pass | advances=[["ACC-PAY-2026-00003",43.35]] outstanding=0 grand=43.35 | — |
| the invoice is linked to the Sales Order | pass | maison_sales_order=SAL-ORD-2026-00003 item.sales_order=SAL-ORD-2026-00003 | — |
| nothing is left outstanding on a prepaid collection | pass | outstanding=0 | — |
| the Sales Order is marked Collected | pass | {"maison_web_status":"Collected","status":"Completed","per_billed":100} | — |
| points are awarded on the collection (on the net amount) | pass | points 0 → 39; entries=[["ACC-SINV-2026-03081",39,39.98]]; invoice net=39.98 grand=43.35 | — |
| points are earned on net, not on the taxed total | pass | points=39 net=39.98 grand=43.35 | — |
| the receipt shows the rewards block | pass | CLOUDCHASERZ REWARDS POINTS EARNED 39 POINTS BALANCE 39 NEXT REWARD 5.00 off at 100 pts (61 to go) GIVEAWAY ENTRIES 1 · Geek Bar Pulse X giv | — |
| loyalty lookup refuses a wrong e-mail | pass | error="We could not match that client number and e-mail." | — |
| loyalty lookup shows points for client number + e-mail | pass | CLOUDCHASERZ REWARDS · Client № MC647413 · q***@example.com · POINTS 39 · VALUE $1.95 | — |
| loyalty lookup needs both the client number and the e-mail | pass | 417 Enter both your client number and the e-mail we have on file | — |
| unknown client number returns nothing (no enumeration hint) | pass | null | — |
| "pay at the store" places an unpaid web order | pass | SAL-ORD-2026-00004 total=21.67 advance=0 prepaid=0 payment_url=null | — |
| the unpaid order shows a balance due at collection | pass | {"name":"SAL-ORD-2026-00004","boutique":"OK-BA","boutique_name":"CloudChaserz Broken Arrow","customer":"QA4 New Shopper QA4A","customer_name":"QA4 New Shopper QA4A","contact_email":"qa4.newshopper.qa4 | — |
| the queue walks New → Picking → Ready | pass | status=Ready balance_due=21.67 | — |
| collecting an unpaid order tenders the full balance | pass | {"offline_uuid":"qa4-QA4A-collect-1787525038938","status":"ok","invoice_name":"ACC-SINV-2026-03094","grand_total":21.67,"rounded_total":21.67,"change_amount":0,"receipt_token":"uCRyWfoOHdYsqMfb","rewa | — |
| the collection invoice is linked to the order, fully paid, no advance | pass | ACC-SINV-2026-03094 outstanding=0 advances=0 paid=[["Cash",21.67]] | — |
| the Sales Order is Collected | pass | {"maison_web_status":"Collected","status":"Completed"} | — |
| an enquiry on an age-restricted product reaches the chosen store | pass | {"name":"MWE-2026-00001","boutique":"OK-BA","item_code":"DSP-001","status":"New","customer_name":"QA4 Enquirer QA4A"} | — |
| the enquiry shows in the store's POS queue | pass | 1 enquiries · counts={"New":2,"Picking":0,"Ready":0,"Collected":2} | — |
| the enquiry does not leak into another store's queue | pass | OK-OWA enquiries=0 | — |
| an associate can answer the enquiry | pass | {"status":"Contacted","response":"QA4 QA4A test response"} | — |
| mobile 390×844: bag, checkout and order history do not scroll sideways | FAIL | `/shop/checkout` scrollWidth 494 px in a 390 px viewport (**+104 px**): `.mw-boutique` is `grid-template-columns: 24px 1fr auto` with no phone breakpoint, so the store address + "All pieces in boutique" column push off-screen. Bag and order history are clean. `193-m-checkout-390.png` | moderate (A3) |
## Area B — rewards, promotions, coupons, giveaways, feedback

| Test | Result | Evidence | Severity |
|---|---|---|---|
| /rewards states "Earn 1 point for every $1 you spend" | pass | Earn 1 point for every $1 you spend. | — |
| /rewards states "$5 off at 100 points" | pass |  | — |
| /rewards states "$10 off at 200 points" | pass |  | — |
| /rewards states "$15 off at 300 points" | pass |  | — |
| tier tiles read $5/100, $10/200, $15/300 | pass | copy is correct; the tiles render uppercase ("$5 OFF AT 100 POINTS · 100 points = 100 dollars spent"), my regex was case-sensitive | — |
| programme name is CloudChaserz Rewards | pass | CloudChaserz Rewards | — |
| all five member perks listed | pass | Birthday discount \| Monthly sale promotions \| Latest product arrivals \| Product giveaways \| Exclusive event invites | — |
| server tiers match the copy (100/5, 200/10, 300/15) | pass | [[100,5],[200,10],[300,15]] | — |
| birthday perk copy matches settings | pass | page reads "15% off coupon, issued 7 days before your birthday, valid 30 days" — matches settings; regex artefact | — |
| live giveaways are listed on /rewards | pass | 1 giveaway rows · api=[{"title":"Geek Bar Pulse X giveaway","prize":"A Geek Bar Pulse X 25K in the flavor of your choice","end_date":"2026-09-22","rule":"Per amount","amount_per_entry":25}] | — |
| join form refuses without the 21+ / terms checkbox (client side) | pass | ok visible=false; validity=true | — |
| server enforces the 21+/terms consent (consent=0 must be refused) | FAIL | `POST maison_pos.api.rewards.signup {name, phone, consent:0, consent_email:1}` → **200 ok**, member created (MC647777). The form marks the 21+/terms box `required`, but only the browser enforces it. `022-rewards-join-consent-required.png` | **major (B1)** |
| signup without any consent is refused | pass | 417 frappe.exceptions.ValidationError: Please accept the program terms | — |
| signup without a name is refused | pass | 417 frappe.exceptions.ValidationError: Name is required | — |
| signup without phone or e-mail is refused | pass | 417 frappe.exceptions.ValidationError: Phone or e-mail is required | — |
| sign-up through /rewards creates a member with a client number | pass | Welcome, QA4 Member QA4A! Your member number is MC647413. Show your phone number at any store to earn points. | — |
| member is enrolled in CloudChaserz Rewards + profile written | pass | {"name":"QA4 Member QA4A","maison_client_number":"MC647413","loyalty_program":"CloudChaserz Rewards","mobile_no":"+1 918 555 9407","email_id":"qa4.member.qa4a@example.com"} | — |
| birthday, home store and marketing consents stored on the profile | pass | {"birthday":"1990-04-11","preferred_boutique":"OK-BA","do_not_email":0,"do_not_sms":1} | — |
| duplicate phone does not silently rename the existing member | FAIL | signing up with an existing member's phone returns **200 with that member's client number (MC647413)** and overwrites their `customer_name` with the stranger's. No "you are already a member" path. | **major (B2)** |
| duplicate e-mail does not silently rename the existing member | FAIL | same via e-mail: `customer_name` became "QA4 Impostor2 QA4A"; the impostor is handed the member's client number | **major (B2)** |
| duplicate phone does not create a second Customer | pass | 1 customers with +1 918 555 9407 | — |
| public receipt shows points earned and balance | pass | POINTS EARNED 39 POINTS BALANCE 39 | — |
| public receipt shows tier progress ("next reward … to go") | pass | NEXT REWARD $5.00 off at 100 pts · 61 to go | — |
| public receipt masks the client number and shows no name | pass | MC···413, no customer name on the page | — |
| public receipt shows a giveaway-entry line | pass | GIVEAWAY ENTRIES 1 · Geek Bar Pulse X giveaway | — |
| the receipt page offers private feedback | pass | 1 feedback form | — |
| feedback reaches HQ as a Maison Feedback record | pass | {"name":"4jretiisc1","rating":2,"comment":"QA4 QA4A — test feedback, please ignore (rating 2)","boutique":"OK-BA","customer":"QA4 Member QA4A","status":"New"} | — |
| the feedback record is scoped to the store and carries the comment | pass | {"boutique":"OK-BA","rating":2,"alerted":1,"status":"New","comment":"QA4 QA4A — test feedback, please ignore (rating 2)"} | — |
| HQ feedback summary reports the store's ratings | pass | {"days":30,"count":2,"avg_rating":3.5,"low_count":1,"by_boutique":[{"boutique":"OK-BA","count":1,"low":1,"avg_rating":2},{"boutique":"OK-BIX","count":1,"low":0,"avg_rating":5}],"recent":[{"name":"4jretiisc1","boutique":"OK-BA","rating":2,"comment":"QA4 QA4A —  | — |
| feedback is not readable by a shopper | pass | 403 rows=0 | — |
| a rating ≤ 2 alerts the store manager | pass | alerted=1 notification_logs=2 [{"name":"4jred8efuj","subject":"Low rating (2/5) at OK-BA — ACC-SINV-2026-03081","for_user":"hq@cloudchaserz.example"},{"name":"4jref2uqpl","subject":"Low rating (2/5) at OK-BA — ACC-SINV-2026-03081","for_user":"ok.ba.manager@clo | — |
| only one feedback per receipt is stored | pass | 1 rows; second submit → 200 {"ok":true,"duplicate":true,"thanks":"Thank you — we already have your feedback for this visit."} | — |
| feedback with an unknown receipt token is refused | pass | 404  | — |
| an out-of-range rating is refused | pass | 417 frappe.exceptions.ValidationError: Rating must be between 1 and 5 | — |
| catalogue bootstrap ships the three reward tiers | pass | [[100,5,"$5 off at 100 points"],[200,10,"$10 off at 200 points"],[300,15,"$15 off at 300 points"]] | — |
| stacking is off by default | pass | reward_allow_stacking=0 | — |
| $1 spent = 1 point, earned on the net amount (not the taxed total) | pass | net $359.92 grand $390.21 -> +359 pts (balance 39 -> 398), ACC-SINV-2026-03082 | — |
| points are earned on the right basket (invoice-linked entry) | pass | [{"loyalty_points":359,"purchase_amount":359.92,"expiry_date":"2036-08-20"}] | — |
| all three tiers are affordable at 300+ points | pass | points=398 affordable=100,200,300 | — |
| the POS Redeem sheet offers every affordable tier | pass | $5.00 off 100 POINTS \| $10.00 off 200 POINTS \| $15.00 off 300 POINTS | — |
| the sheet states 'One reward per transaction' while stacking is off | pass | QA4 member has 398 points. One reward per transaction. | — |
| redeeming a tier takes the reward off the total | pass | 130.08 -> 115.08 (-15.00), tier = $15 off at 300 points | — |
| the redeeming sale syncs | pass | Synced ACC-SINV-2026-03083 | — |
| the invoice records the redemption (loyalty_amount / loyalty_points / tier) | pass | loyalty_amount=15 loyalty_points=300 tier=RT-300-00003 grand=130.08 | — |
| the balance moves by redeemed minus earned | pass | 398 -> 202 (-300 redeemed, +104 earned on net 119.98 - 15 reward) | — |
| the receipt shows the redeemed reward and the tier progress | pass | REWARD REDEEMED $15 off at 300 points / POINTS EARNED 104 / POINTS BALANCE 202 / NEXT REWARD 15.00 off at 300 pts (98 to go) / GIVEAWAY ENTRIES 4 | — |
| a tier the client cannot afford is refused | pass | balance=202, asked 300 -> error "Not enough points: 300 needed, 202 available" | — |
| the POS offers no tier when the balance is short | pass | points=202 affordable=100,200 next={points_needed:98} | — |
| stacking two tiers is refused while reward_allow_stacking is off | pass | error "Only one reward can be redeemed per transaction" | — |
| a sale can still be returned after its points were redeemed | FAIL | ERPNext refuses the credit note: *"Sales Invoice can't be cancelled since the Loyalty Points earned has been redeemed. First cancel the Sales Invoice No ACC-SINV-2026-03083"* — a store cannot refund a member who has since spent points, and the message names an unrelated invoice | **major (B3)** |
| a return reverses the points earned on that sale | pass | sale ACC-SINV-2026-03084 net 134.97 → credit note ACC-SINV-2026-03085 net -134.97; points 336 → 202 (Δ -134) | — |
| the balance never goes negative | pass | points=202 | — |
| the reversal is written as a Loyalty Point Entry against the credit note | pass | [["ACC-SINV-2026-03084",0],["ACC-SINV-2026-03083",-300],["ACC-SINV-2026-03083",104],["ACC-SINV-2026-03082",359],["ACC-SINV-2026-03081",39]] | — |
| with stacking off the sheet never holds two tiers at once | pass | after picking a tier: sheet closes; sheet closed | — |
| only one reward ends up applied | pass | applied = $5 off at 100 points | — |
| a valid coupon previews its discount | pass | {"valid":true,"code":"QA4SINGLEQA4A","title":"QA4 single-use QA4A","discount_type":"Amount","value":3,"item_group":null,"customer":null,"discount":3,"per_line": | — |
| an expired coupon is refused | pass | expired · Coupon QA4EXPIREDQA4A has expired | — |
| an unknown coupon is refused (no exception) | pass | unknown · Unknown coupon QA4NOSUCHCODE | — |
| a client-bound coupon is refused without that client | pass | wrong_customer · Coupon QA4CLIENTQA4A is reserved for another client | — |
| a client-bound coupon works for its client | pass | {"valid":true,"code":"QA4CLIENTQA4A","title":"QA4 client-bound QA4A","discount_type":"Amount","value":4,"item_group":null,"customer":"QA4 Me | — |
| a client-bound coupon is refused for another client | pass | wrong_customer · Coupon QA4CLIENTQA4A is reserved for another client | — |
| an item-group coupon discounts only that group | pass | discount=12 per_line=[12,0] (Accessories 59.99, CBD 44.99) | — |
| an item-group coupon is refused on a basket without that group | pass | not_applicable · Coupon QA4GROUPQA4A does not apply to anything in this basket | — |
| a coupon can be redeemed on a sale | pass | {"offline_uuid":"qa4-QA4A-coupon-1787523330144","status":"ok","invoice_name":"ACC-SINV-2026-03086","grand_total":61.79,"rounded_total":61.79,"change_amount":0.71,"receipt_token":"n | — |
| the invoice records the coupon and its discount | pass | coupon=QA4SINGLEQA4A discount=3 net=56.99 grand=61.79 | — |
| redemption is recorded and used_count is bumped | pass | {"name":"7qh5tjvpd0","sales_invoice":"ACC-SINV-2026-03086","amount":3,"customer":"QA4 Member QA4A"} used_count=1 | — |
| a single-use coupon is refused the second time | pass | exhausted · Coupon QA4SINGLEQA4A has already been used | — |
| a multi-use coupon stays valid | pass | {"valid":true,"code":"QA4MULTIQA4A","title":"QA4 multi-use QA4A","discount_type":"Percent","value":10,"item_group":null, | — |
| a monthly promotion calendar exists | pass | [{"name":"PROMO-2026-08","title":"Disposables month — August 2026","month":"2026-08-01","status":"Planned","coupon":"PROMO2608","campaign":null,"sent_on":null},{"name":"PROMO-2026-09","title":"Glass & hookah month — September 2026","month":"2026-09-01","status | — |
| this month's calendar carries its pricing rules and featured items | pass | Disposables month — August 2026 · rules=1 featured=4 coupon=PROMO2608 status=Planned | — |
| the POS sees this month's promotions | pass | {"boutique":"OK-BA","date":"2026-08-23","enabled":true,"promotions":[{"name":"PRLE-0001","title":"Disposables month Aug 2026","apply_on":"Item Group","targets":["Disposables"],"kind":"percent","rate":0,"discount_percentage":15,"discount_amount":0,"min_qty":0," | — |
| the rewards jobs are scheduled (birthday / monthly promo / new arrivals) | pass | [["new_arrivals_campaign","Weekly",0,null],["send_monthly_promotions","Daily",0,null],["issue_birthday_coupons","Daily",0,null]] | — |
| the scheduler is enabled on the site | pass | enable_scheduler=1; note: these three jobs have never run (last_execution null) | — |
| the POS lists open giveaways with the client's entries | pass | {"giveaways":[{"name":"GIVE-2026-00004","title":"Geek Bar Pulse X giveaway","boutique":null,"entry_rule":"Per amount","amount_per_entry":25,"max_entries_per_invoice":10,"requires_member":1,"prize_description":"A Geek Bar | — |
| entries accrue at 1 per $25 of net spend | pass | [["ACC-SINV-2026-03086",2],["ACC-SINV-2026-03084",5],["ACC-SINV-2026-03083",4],["ACC-SINV-2026-03082",10],["ACC-SINV-2026-03081",1]] (net of ACC-SINV-2026-03086 = 56.99) | — |
| a sale during a giveaway creates the right number of entries | pass | net 59.97 → [["QA4 Member QA4A",2]] | — |
| Head Office can draw a winner with a recorded seed | pass | winner=QA4 Impostor2 QA4A entry=bqhrjp6ar7 pool=2 seed=qa4-seed-1 | — |
| the draw is stored with an audit trail | pass | status=Drawn winner=QA4 Member QA4A audit={  "seed": "qa4-seed-1",  "algorithm": "python random.Random(seed).randrange(len(pool)) over entries sorted by name, eac | — |
| a drawn giveaway cannot be drawn twice | pass | 417 frappe.exceptions.ValidationError: GIVE-2026-00055 has already been drawn | — |
| an associate may not draw a giveaway | pass | 403 frappe.exceptions.PermissionError: Only Head Office may draw a giveaway | — |
| the draw is reproducible from the recorded seed (audit records index + pool) | pass | audit index=1 entries_hash=699dca82fec27ea6… | — |
| the birthday-coupon job is registered as a daily scheduled job | pass | {"name":"rewards.issue_birthday_coupons","method":"maison_pos.api.rewards.issue_birthday_coupons","frequency":"Daily","stopped":0,"last_execution":null} | — |
| the birthday job issues a coupon for a member whose birthday is `lead_days` away | pass | job run → 200; BDAY coupons 0 → 2; mine={"name":"BDAY26F9D7E5","customer":"QA4 Member QA4A","discount_type":"Percent","value":15,"usage":"Single-use","max_uses":1,"valid_from":"2026-08-23","valid_upto":"2026-09-22","enabled":1,"title":"Birthday 2026 — QA4 Impo | — |
| the birthday coupon matches the settings (15% / single-use / client-bound / 30 days) | pass | Percent 15 Single-use max_uses=1 valid 2026-08-23→2026-09-22 (settings: Percent 15, valid_days 30) | — |
| the birthday coupon is redeemable at the POS for that client only | pass | {"valid":true,"code":"BDAY26F9D7E5","title":"Birthday 2026 — QA4 Impostor2 QA4A","discount_type":"Percent","value":15,"item_group":null,"customer":"QA4 Member QA4A","discount":9,"p | — |
| the birthday coupon is refused for anyone else | pass | wrong_customer · Coupon BDAY26F9D7E5 is reserved for another client | — |
| the issue is logged on the client record | pass | {"name":"dr411qgu90","note":"Birthday coupon BDAY26F9D7E5 issued (valid until 2026-09-22)"} | — |
| running the birthday job twice does not double-issue | pass | 2 → 2 (second run → 200) | — |
| the $10 / 200 points tier redeems at the POS | pass | ACC-SINV-2026-03095: loyalty_amount=10 loyalty_points=200 tier=RT-200-00002 grand=65.04 (balance 641 → 490) | — |
| the $5 / 100 points tier redeems at the POS | pass | **re-tested (results-s13b.json)**: ACC-SINV-2026-03096 `loyalty_amount=5 loyalty_points=100 tier=RT-100-00001`; the first attempt tendered $60.00 against a $60.04 total (my payload) and the server correctly refused | — |
| the $5 / 100 points tier redeems at the POS | pass | **re-tested (results-s13b.json)**: ACC-SINV-2026-03096 `loyalty_amount=5 loyalty_points=100 tier=RT-100-00001`; the first attempt tendered $60.00 against a $60.04 total (my payload) and the server correctly refused | — |
## Area C — Salon client display and client recognition

| Test | Result | Evidence | Severity |
|---|---|---|---|
| POS Settings has a "Client display" card | pass | Not paired | — |
| the POS shows a 6-digit pairing code, its QR and a 10-minute countdown | pass | 711524 · 10:00 · qr=1 | — |
| the Salon pairs with the 6-digit code and lands on the ambient screen | pass | code 711524 | — |
| the POS card flips to "Paired" | pass |  | — |
| the server holds a Paired Maison Salon Session for this POS device | pass | e42c57d5d1… boutique=OK-BA | — |
| the ambient screen shows the brand, the hour and a curated piece | FAIL | wordmark + clock render, but `[data-testid=ambient-piece]` = 0: there is **no `Maison Salon Playlist` on the site** (0 rows), so the ambient screen has nothing to show. `143-salon-ambient-1024.png` | moderate (C2) |
| the first piece with no client switches the Salon to "identify" | pass | GOOD AFTERNOON Are you a client of the house? Let us know who you are and your points and preferences follow you to the counter. PHONE OR CLIENT № E-MAIL SCAN CLIENT CARD JOIN CLOU | — |
| the keypad masks what the client types | pass | ••7413 | — |
| a client number typed on the Salon keypad identifies the client | FAIL | the screen offers "Phone or client №" and the keypad has digits only, so "MC647413" cannot be typed; `647413` → "We could not find you". The same code with the MC prefix works over the API. `145-salon-identify-keypad.png` | moderate (C1) |
| the identify API accepts the printed client number (MC######) | pass | bare digits → found=false; "MC647413" → found=true | — |
| identify by e-mail finds the client | pass | qa4.member.qa4a@example.com → {"customer":"QA4 Member QA4A","first_name":"QA4","customer_name":"QA4 Impostor2 QA4A","client_number_masked":"MC •• 413","phone_masked":"••• | — |
| an unknown number answers "not found" with no hint | pass | {"found":false} | — |
| the client screen welcomes the client with masked contact details | pass | "QA4" · "Client № MC •• 413 · •••• 9407 · q•••@example.com" · points=560 | — |
| the Salon state carries no full phone, e-mail or other client's data | pass | state payload checked for qa4.member.qa4a@example.com / +1 918 555 9407 | — |
| the POS basket picks up the client the Salon identified | pass | QA4 Impostor2 QA4A | — |
| the basket mirror follows the POS (lines, focus piece, total) | pass | focus="BIC Lighter — Classic" salon $88.65 vs POS $88.65 | — |
| the mirror shows the points this visit will earn | pass | + 81 points with this visit | — |
| "Ask about this piece" reaches the POS and the client profile | pass | POS notice=true · interaction={"name":"82r08q8chv","type":"Note","note":"Client asked about BIC Lighter — Classic: QA4 QA4A: does this come in a bigge | — |
| the Salon shows the payment screen with the amount due | pass | salon $88.65 vs POS $88.65 | — |
| the Salon shows the "approved" state before the receipt | pass | salon view now = thankyou | — |
| the thank-you screen shows the points earned and the receipt QR | pass | **re-tested in s11b**: QR image present, "+79 POINTS EARNED"; the first attempt asserted ~1 s after the screen appeared, while it still read "Issuing your receipt…". `171-salon-thankyou-full.png` | — |
| the thank-you screen shows the tier progress | pass | **re-tested in s11**: "Next reward: $5.00 off at 100 points · 79 to go" (the first member was above every tier, so `next_reward` was correctly null) | — |
| the thank-you screen shows giveaway entries | pass | **re-tested in s11b** on the session state: `giveaway_entries: 3 · Geek Bar Pulse X giveaway` | — |
| the thank-you screen shows no full name, phone or e-mail | pass | THANK YOU Until next time, QA4 +81 POINTS EARNED Balance 641 · Member Issuing your receipt… Scan for your receipt EMAIL | — |
| the pairing QR is rendered on the POS | pass | data:image/png;base64,iVBORw0KGgoAAAANSU… | — |
| the Salon pairs from the QR deep link (/salon?code=…) | pass | code 570971 → ambient | — |
| a paired session lasts 12 h | pass | paired_at=2026-08-23 17:33:43.305656 expires_at=2026-08-24 05:33:43.305656 | — |
| sessions are expired by an hourly job | pass | {"name":"salon.expire_sessions","frequency":"Hourly","stopped":0,"last_execution":"2026-08-23 17:01:00.164350"} | — |
| an unknown session token is refused with no detail | pass | 403 frappe.exceptions.PermissionError: Salon session not found | — |
| a guest cannot list Salon sessions | pass | 403 rows=0 | — |
| the Join screen names the programme and its terms | pass | JOIN CLOUDCHASERZ REWARDS Earn 1 point for every $1 you spend. $5 off at 100 points $10 off at 200 points $15 off at 300 points BIRTHDAY DISCOUNT MONTHLY SALE PROMOTIONS LATEST PRODUCT ARRIVALS PRODUC | — |
| Join from the Salon creates the member and attaches them to the sale | pass | {"name":"QA4 Salon QA4A","maison_client_number":"MC517789","loyalty_program":"CloudChaserz Rewards","mobile_no":"9185557970","email_id":"qa4.salon.qa4a7970@example.com"} | — |
| the marketing preferences chosen on the Salon are stored | pass | {"birthday":"1994-02-02","do_not_email":0,"do_not_sms":1} | — |
| the POS shows the client that joined on the Salon | pass | QA4 Salon QA4A | — |
| the thank-you screen shows the points earned and the receipt QR | pass | **re-tested in s11b**: QR image present, "+79 POINTS EARNED"; the first attempt asserted ~1 s after the screen appeared, while it still read "Issuing your receipt…". `171-salon-thankyou-full.png` | — |
| the thank-you screen shows the tier progress (next reward) | pass | **re-tested in s11**: "Next reward: $5.00 off at 100 points · 79 to go" (the first member was above every tier, so `next_reward` was correctly null) | — |
| the thank-you screen shows the giveaway entries | n/a | basket was $21.78 net — below the $25/entry rule, so no entry line is correct; entries verified in s11b and s8 | — |
| Salon feedback reaches Head Office against this sale | pass | {"name":"a6o1b7eo97","rating":5,"comment":"QA4 QA4A salon feedback — please ignore","boutique":"OK-BA","customer":"QA4 Salon QA4A"} | — |
| the thank-you state carries points, receipt QR link and giveaway entries | pass | {"customer":"QA4 Salon QA4A","receipt_token":"Q420nFNHr_Ylw_56","receipt_url":"https://cloudchaserz.frappe.cloud/r/Q420nFNHr_Ylw_56","sales_invoice":"ACC-SINV-2026-03093","points_earned":79,"points_balance":100,"tier":"Member","grand_total":86.71,"currency":"U | — |
| the private-viewing invitation is recorded on the client profile | pass | invite offered=true · {"private_viewing_invite":1,"private_viewing_invite_on":"2026-08-23 17:36:26.241390"} | — |
| the thank-you screen (receipt QR, feedback, invitation) self-clears 20 s after the last touch | note | observed while testing: the QR and the "How was your visit?" / invitation buttons disappear on the countdown | — |
| the associate can switch the Salon to Concierge | pass | **re-tested in s11c**: Concierge needs a client attached (`stores/salon.ts:426 this.concierge && customer`); with the client attached the Salon switched and saved the answers. `181-salon-concierge.png` | — |
| an unpaired Salon shows only the pairing screen (no client data) | pass | view=pair | — |
| Unpair from the POS returns the Salon to the pairing screen | pass | salon view = pair | — |
| the session is Unpaired on the server | pass | {"status":"Unpaired"} | — |
| the old token no longer serves a paired session | pass | 403 {} | — |
| with a client attached and no basket the Salon shows the welcome screen | pass | client | — |
| the associate can switch the Salon to Concierge | pass | **re-tested in s11c**: Concierge needs a client attached (`stores/salon.ts:426 this.concierge && customer`); with the client attached the Salon switched and saved the answers. `181-salon-concierge.png` | — |
| Concierge answers are written to the client profile | pass | steps=ring→wrist→metal→style→occasion · saved-banner=1 · profile fields changed: [["ring_size","6.5"],["metal_preference","Yellow Gold"],["style_notes","[Salon 2026-08-23] Occasions: Anniversary"]] | — |
| Concierge can be switched off again | pass | pair | — |
| client recognition is OFF globally (as shipped) | pass | Maison POS Settings.face_recognition_enabled=0; consent_text_version=2026-08-1; model=face-api/faceRecognitionNet@1; threshold=undefined | — |
| no store overrides recognition on | pass | [["HOU-WH","Inherit"],["OK-JENKS","Inherit"],["OK-YALE","Inherit"],["OK-ETUL","Inherit"],["OK-MINGO","Inherit"],["OK-MUS","Inherit"],["OK-OWA","Inherit"],["OK-STUL","Inherit"],["OK-BIX","Inherit"],["OK-BA","Inherit"],["OK-SAP","Inherit"],["HOU-MTR","Inherit"]] | — |
| the POS bootstrap reports recognition disabled for this store | pass | face_recognition_enabled=0 global=0 | — |
| no client is enrolled and no face template exists | pass | consented=0 templates=0 | — |
| with recognition off, enrolment is refused | pass | 417 frappe.exceptions.ValidationError: Client recognition is not enabled for boutique OK-BA | — |
| with recognition off, matching is refused | pass | 417 frappe.exceptions.ValidationError: Client recognition is not enabled for boutique OK-BA | — |
| a refused enrolment creates nothing | pass | passed on the clean first run (0 customers); the re-run counted the customer left by the previous successful enrolment | — |
| enabling the store override leaves the global switch off | pass | global=0, OK-BA override=On (restored to Inherit at the end) | — |
| the store now reports recognition enabled while the chain stays off | pass | store=1 global=0 | — |
| no biometric enrolment is possible without a consent record | pass | 417 frappe.exceptions.ValidationError: consent.method must be one of Hold-to-agree, Signature | — |
| a consent captured against an outdated text version is refused | pass | 417 frappe.exceptions.ValidationError: Consent text version 2020-01-1 is outdated; current version is 2026-08-1. Reload settings and show the ne | — |
| only the recorded consent methods are accepted | pass | 417 frappe.exceptions.ValidationError: consent.method must be one of Hold-to-agree, Signature | — |
| none of the refused attempts created a client or a template | pass | same re-run artefact as above | — |
| a consented enrolment stores the consent and the templates | pass | {"customer":"QA4 Recog QA4A","consent":"MBC-2026-00002","templates":3,"created":false} | — |
| the consent record snapshots the wording, method, store and device | pass | Active Hold-to-agree v2026-08-1 @OK-BA device=QA4-QA4A ip=set | — |
| templates are vectors only — no image is stored | pass | [{"dims":128,"keys":[]},{"dims":128,"keys":[]},{"dims":128,"keys":[]}] | — |
| the client screen reports the enrolment status | pass | {"customer":"QA4 Recog QA4A","customer_name":"QA4 Recog QA4A","client_number":"MC856498","tier":"Member","loyalty_points":0,"points_value":0,"face_consent":1,"face_consent_at":"2026-08-23 17:43:00.543958","consent":{"nam | — |
| an enrolled client is matched by their own template | pass | matches=1 best_distance=0 threshold=0.6 | — |
| a face outside the threshold is not matched (no identity leaked) | pass | matches=0 best_distance=1.131371 threshold=0.6 | — |
| "No thanks" still creates the client but stores no biometrics | pass | customer=QA4 Declined QA4A consent=0 templates=0 | — |
| the decline is logged as an event | pass | [{"name":"bakl28g8vo","outcome":"Declined"},{"name":"4a33i7vvt6","outcome":"Declined"}] | — |
| a manager can revoke: templates purged, consent Revoked, event logged | pass | templates=0 consent=Revoked by=ok.ba.manager@cloudchaserz.example at=2026-08-23 17:43:01.675249 events=["Revoked","Matched","Enrolled","Revoked","Matched","Matched","Enrolled"] | — |
| the revoked client is gone from the device template list | pass | {"templates":[],"deleted":[],"enabled":1,"model":"face-api/faceRecognitionNet@1","threshold_distance":0.6,"threshold":0.6,"version":"2026-08 | — |
| the store override and the global switch are back to their original values | pass | OK-BA=Inherit (was Inherit) · global=0 · consented clients=0 | — |
## Recognition: what was and was not testable

Recognition **ships off** and is off on this site: `Maison POS Settings.face_recognition_enabled = 0` and all
twelve stores are on `Inherit`. With it off, `recognition.enroll` and `recognition.match` both refuse
(`Client recognition is not enabled for boutique OK-BA`) and nothing is created.

The brief allows testing only if it can be enabled without a **global** setting change. It can:
`maison_pos_settings.py::is_recognition_enabled(boutique)` lets a **store** override (`Maison Boutique.face_recognition_enabled = On`)
win over the global switch. I therefore switched **OK-BA only** to `On`, ran the consent / enrolment / decline /
revoke checks, and set it straight back to `Inherit` — the global switch was never written and was re-verified as
`0` afterwards, with zero consented clients and zero templates left.

Not covered (and why):

* **Camera capture on a real device** — the enrolment vectors were posted the way the device posts them
  (128-float descriptors); the on-device face-api detector path was exercised on `maison-demo` in the v0.3 run and
  is out of scope for a store I must leave untouched.
* **The Salon consent screen end-to-end** — the Salon hands consent to the POS only while the POS holds a running
  camera; the sandbox POS has no camera, so I verified the server contract (`salon.consent` / `pending_consent`
  exist, `salon_settings.face_recognition_enabled` follows the store override) but not the on-screen hold-to-agree
  on the Salon itself. The same `ConsentScreen` component and its 600 ms hold were verified on the POS in v0.3.
* **The 36-month retention purge** (`tasks.purge_expired_biometrics`) — needs a clock change.

## Data created and cleaned up

Everything I created carried a `QA4` prefix. Cleanup ledger: `cleanup-s.json`, `cleanup-s2.json`, `cleanup-s3.json`.

**Removed / reverted**

* **16 POS Sales Invoices cancelled** (`ACC-SINV-2026-03081` … `03096`, including the credit notes) — all four
  cancellation passes succeeded, and store stock is back at its seeded numbers (ACC-003 9, ACC-007 16, ACC-013 10,
  ACC-002 52, CBD-002 11, CBD-003 11).
* **4 web orders cancelled** (`SAL-ORD-2026-00002/00003/00004` + their Payment Requests / advance Payment Entries).
  `SAL-ORD-2026-00001` (customer "Walter Hines") was **not** mine and was left alone.
* **7 Salon sessions** at OK-BA set to `Unpaired`. One `Paired` session remains at HOU-MTR — another agent's.
* **Test giveaway `GIVE-2026-00055` and its entries deleted**; the seeded "Geek Bar Pulse X giveaway" is untouched
  (its entries from my — now cancelled — invoices remain as rows, see below).
* **My two Maison Feedback rows and their manager notifications deleted** (a 2★ rating on OK-BA would otherwise
  skew the HQ feedback tile), and the test **Maison Web Enquiry** deleted.
* **Birthday coupon issued to the seeded customer Gabriela Santos deleted** — I triggered the daily job a day
  early to test it; deleting the coupon lets tomorrow's scheduled run issue it normally. Her
  `Maison Client Interaction` "Birthday coupon … issued" note remains (see below).
* **OK-BA `face_recognition_enabled` restored to `Inherit`**; global switch never touched (`0`, re-verified).
* The test member's `customer_name` and birthday were restored before the customer was disabled.

**Left behind on purpose**

| What | Why |
|---|---|
| 6 test Customers, all `disabled = 1` (`QA4 Member/Salon/Recog/Declined/Bypass/New Shopper QA4A`) | deleting them would dangle cancelled invoices, loyalty entries, consents and giveaway entries |
| 2 Website Users `qa4.client.qa4a@` / `qa4.newshopper.qa4a@`, both `enabled = 0` | same; they also carry the cancelled orders |
| 5 `QA4*` coupons + the QA4 birthday coupon, all `enabled = 0` | a `Maison Coupon Redemption` row points at `QA4SINGLEQA4A` |
| `Maison Biometric Consent` MBC-2026-00001/00002, status **Revoked**, and the Recognition Events | the biometrics policy keeps consent + event records (without biometric data) as the compliance trail; **no template survives** |
| `Maison Client Interaction` notes (Salon question, concierge answers, birthday coupon) | audit trail on disabled customers |
| Giveaway entries of the seeded giveaway that point at my cancelled invoices | deleting them would rewrite the seeded giveaway's entry pool |
| 16 cancelled invoices + 3 cancelled orders (docstatus 2) | cancellation is the required trail; they are excluded from every report |

**Could not clean:** nothing. The two cancellation failures in the first pass (Sales Orders blocked by their
Payment Requests, the giveaway blocked by its own winner link) were resolved in the second pass.

**Global settings: none were changed.** `webshop_age_restricted_sales` stayed 0, `reward_allow_stacking` 0,
`birthday_coupon_*` untouched, `face_recognition_enabled` 0, and no seed was run.
