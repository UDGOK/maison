# Changelog

All notable changes to AWANZ POS. Versions follow the `SPEC*.md` contracts; the app version lives in
`maison_pos/__init__.py`, `frontend/package.json` and `dashboard/package.json`.

## 0.9.0 — unreleased

### The product is AWANZ

The platform was called **Maison** when it was a jewellery point of sale. Every name a customer, a
cashier or a head-office user can read is now **AWANZ**; the migration is
`maison_pos/patches/v0_9/rename_to_awanz.py`, registered under `[pre_model_sync]` so it runs
*before* `bench migrate` reads the JSON files and `frappe.rename_doc` can move the tables with
`RENAME TABLE` rather than a second set of doctypes appearing beside the old ones. It is
idempotent, and every step checks `exists(old) and not exists(new)` first.

- **Brand defaults** — `product_name` "Maison POS by CloudChaserz" → **"AWANZ POS by CloudChaserz"**,
  `sub_mark` "Maison POS" → **"AWANZ"**, and the jewellery profile's tokens (`brand_name`,
  `wordmark_text`, `legal_name`, `rewards_program_name`) in `BRAND_DEFAULTS`,
  `setup/demo.JEWELLERY_BRAND`, `frontend/src/brand/tokens.ts` (`DEFAULT_BRAND` +
  `JEWELLERY_BRAND`), `dashboard/src/stores/brand.ts` and both mock APIs. The stored settings of
  an existing site are rewritten by the patch, so a seeded tenant is rebranded in place.
- **Roles** — `Maison Associate / Manager / Regional / Head Office / Warehouse Admin` →
  `AWANZ …`, via `frappe.rename_doc("Role", …)`, which carries `Has Role`, `DocPerm` /
  `Custom DocPerm`, workflow transitions and report roles across: nobody loses a permission.
- **Doctypes** — all 47 `Maison X` → `AWANZ X`, with `Maison Boutique` → **`AWANZ Store`** and
  `Maison Boutique Reader` → `AWANZ Store Reader` (the brand's `store_noun` is "Store" outside the
  jewellery vertical). Folders moved to `maison_pos/awanz_pos/doctype/awanz_*`, the controller
  classes are `AWANZ*` (frappe resolves them by `doctype.replace(" ", "")`), and the desk module
  `Maison POS` → `AWANZ POS`.
- **Reports, print formats, workflows** — the 11 Script Reports, `AWANZ Receipt`,
  `AWANZ Return Receipt`, `AWANZ Packing List`, `AWANZ Price Approval` and
  `AWANZ Replenishment Approval`.
- **Routes** — the Command wall is `/awanz-dashboard`; `website_redirects` 301s the old
  `/maison-dashboard` (and everything under it) so bookmarks, mailed links and role home pages
  written before the rename keep working. `www/maison-dashboard.html` → `awanz-dashboard.html`,
  `public/js/maison-desk.js` → `awanz-desk.js`, `public/css/maison-web.css` → `awanz-web.css`.
- **Beyond `rename_doc`** — the patch also fixes what frappe does not know about: `__Auth.doctype`
  (v0.7 moved every associate's PIN hash there, so leaving it behind means **no PIN unlocks the
  till**), the `<doctype>-<fieldname>` names of `Custom Field` / `Property Setter` rows, every
  `reference_doctype` / `attached_to_doctype` / `parenttype`-style column, custom-field **labels**
  that read "Maison", the white-label revert snapshot key, `Role.home_page`, and the seeded tenant
  records (company, root cost centre, loyalty programme, store display names, simulated payment
  gateway, salary structure, addresses, stock-entry remarks). `install.ensure_awanz_names()`
  re-asserts the labels and brand tokens on every `after_migrate`, because `sync_fixtures`
  re-imports them.
- **Deliberately unchanged** — the python package `maison_pos` (a repo rename plus a re-install on
  every site), the `maison_*` **custom fieldnames** on ERPNext doctypes (an `ALTER TABLE` per
  column on the largest tables, invisible to users — their labels are rebranded), and the jewellery
  regression profile's `@maison.example` logins. Reasoning in `docs/white-label.md` §7.
- **`app_title`** is now `AWANZ POS`, so the desk, the launcher and the About dialog name the
  product correctly.

## 0.7.0 — unreleased

### Security — the QA audit's six holes (`e2e/qa/security-ux-report.md`, `docs/security.md`)
- **S1/S5 Privilege escalation through `AWANZ Associate` (critical)** — a store manager could `frappe.client.set_value` their own `role` to `HeadOffice` (the `on_update` role sync then granted the Frappe role with `ignore_permissions`), promote their own staff, or re-point their `boutique` at another store. `user` / `boutique` / `role` are now **permlevel 1** (writable by Regional / Head Office / System Manager only); `scoping.associate_has_permission` refuses the write *before* the framework's permlevel reset so the caller gets a real 403; `AWANZAssociate._guard_privileged_fields` re-checks inside `validate`; and `_sync_user_role` can no longer grant a rank above the granting user's own **and** takes the old Frappe role back on a demotion (it used to be add-only). Managers keep their shop floor through the new `maison_associate.upsert` (own store, Associate level) plus `reset_pin`.
- **S2 PIN hashes readable chain-wide (critical)** — `frappe.client.get_list("AWANZ Associate", fields=[…,"pin_hash"])` returned every associate of every store, managers included; the hash walks past the 5-attempt lockout. `pin_hash` is now a **`Password` field** (encrypted into `__Auth`; the column holds only `*****`, which also kills the `like`-filter oracle Frappe's permlevels do not cover), the PIN fields are **permlevel 2** (System Manager only), and `AWANZ Associate` rows are scoped to the caller's own store by `permission_query_conditions` / `has_permission`. PBKDF2-SHA256 iterations 120 000 → **600 000** with a transparent re-hash on unlock. `session.associates` / `catalog.bootstrap` (the unlock screen) are unchanged.
- **S3 Anonymous rewards sign-up hijacked an existing client (high)** — `rewards.signup` elevated to Administrator and called `customers.upsert`, which matches an existing Customer by e-mail/phone and overwrites it, returning the victim's client number. A guest sign-up now never writes to an existing record and never reveals that it exists: the acknowledgement is identical either way and carries no client number (input is validated before the lookup so even the error paths match). Genuine new members are still created and enrolled — without elevating to Administrator. A **signed-in member of staff** keeps the linking behaviour, and it is audited.
- **S4 Rate limiting was a no-op (medium-high)** — `rewards.signup` set `frappe.rate_limit = None` (nothing reads that), and the Salon counted on `frappe.local.request_ip`, i.e. the *first* `X-Forwarded-For` hop, which the client writes. New `maison_pos/ratelimit.py`: `client_ip()` resolves the caller from the trusted end of the proxy chain (`maison_client_ip_header` / `maison_trusted_proxy_hops` / right-most public hop, IPv6 bucketed by `/64`), every counter is an atomic redis counter, and **every endpoint also has a global ceiling** with no identity in the key. Applied to rewards signup + program, all Salon guest endpoints, webshop guest endpoints, `sales.receipt`, feedback, and the authenticated `verify_pin`. Rejections are a clean **429** with a human sentence and no traceback. Off switch: `bench set-config -g awanz_rate_limits 0`.
- **S6 Chain-wide client PII readable from any till (low-medium)** — `Customer` list queries (`frappe.client.get_list`, `/api/resource/Customer`) are scoped for Manager / Associate to the clients of *their* store (bought there, created there, or homed there). Service is untouched: `customers.search` / `lookup` / `get` still cross the chain by exact-ish match — 3-character minimum, prefix instead of substring matching, a 25-row cap, an empty query listing the store's own clients — and every cross-store hit is written to `logs/awanz_security.log` (`maison_pos/audit.py`).
- `customers.upsert` no longer blanks a field that was simply not sent (an omitted `mobile_no` used to clear the stored one; `""` still clears it).
- **Migration** — `patches/v0_7/associate_hardening.py` moves existing PIN hashes out of the doctype table, mirrors the new permlevels into Custom DocPerm where a site uses those (re-asserted on every migrate), and re-syncs every associate's Frappe roles to what their record says, removing anything extra and logging each correction.
- **Tests** — `maison_pos/tests/test_v0_7_security.py`: 31 tests, HTTP-level where the exploit was (real sessions against the running bench), each one reproducing the audit's exploit path and asserting both that it now fails *and* that the legitimate use of the same endpoint still works.
- **Docs** — `docs/security.md`: the role model, the three scoping layers, what each fix changes, the rate-limit table, the demo-PIN caveat, and what is deliberately left open (single-document `Customer` reads, `User` enumeration, void thresholds, Salon linking) with the reasoning.

### Web shop, rewards, Salon, warehouse, dashboard & UX — the rest of the QA sweep (`e2e/qa/*.md`)

<!-- v0.8 QA — web shop -->
- **A1 The shop could not take an order from a new customer (critical)** — `Website Settings.disable_signup = 1`, no `Portal Settings.default_role` and not one Website User: `/cart` and `/shop/checkout` are behind a login, so the storefront was browse-only. `webshop/setup.ensure_portal_signup()` asserts sign-up + the `Customer` portal role wherever the webshop glue runs (install, **migrate**, both seeds), the CloudChaserz seed now calls `ensure_web_user` like the AWANZ one (demo shopper `shopper@cloudchaserz.example` / `cloud123`), and a new storefront route **`/shop/register`** takes the registration itself (`api/webshop.register`): the shopper picks their own password, gets the portal role, the Customer/Contact wiring webshop's cart needs, and is signed straight in — Frappe's own sign-up mails a random password, which a site with no outgoing Email Account can never deliver. The sign-in wall (`www/shop/_common.require_login`) now lands on that page, which offers both halves (create an account · sign in). Website User only, portal default role only, the platform password policy still applies, an existing address is never touched, rate-limited like every other public write.
- **A2 The product page scrolled 435 px sideways on a phone (major)** — `webshop/core.city_label` joined every in-stock city into a `white-space: nowrap` pill (730 px min-content). `availability_summary()` returns a label that fits ("Available at 7 stores") with the full city list behind a `<details>` disclosure, plus CSS guards so no label can widen the page again. 0 px overflow at 360 and 390.
- **A3 `/shop/checkout` scrolled 104 px sideways** — the four-step header (`.mw-steps`, a flex row of letter-spaced uppercase labels, 491 px at min-content) and the collection picker (`.mw-boutique`, `24px 1fr auto`) both get phone breakpoints.
- **A4 `/shop/collection` showed 96 of 155 products** — `api/webshop.catalogue` reports `total` / `has_more`, the page takes `start`, and the listing has Previous / Next plus an "x–y of n" count.
- **A5 An age-restricted item could be put in the bag** — `update_cart` refuses at add time with the reason ("21+ … sold in store only, bring a valid government ID") instead of leaving `place_order` to refuse the whole basket.
<!-- end v0.8 QA — web shop -->
<!-- v0.8 QA — rewards -->
- **B3 A sale could not be returned once its points had been spent (major)** — ERPNext rebuilds the original sale's Loyalty Point Entry when a credit note is submitted and refuses outright while a redemption points at it ("… can't be cancelled since the Loyalty Points earned has been redeemed. First cancel the Sales Invoice No …"), naming an unrelated later invoice. `api/returns` now pre-checks (`_loyalty_context`), submits the credit note with no `loyalty_program` so ERPNext skips its impossible rebuild, and claws the points back itself (`rewards.claw_back_points`) as ordinary negative entries against the client's live balance, FIFO by expiry — the balance can never go negative and no entry is left over-redeemed. When the client has already spent them there is nothing to recover: that is a write-off, so it asks for a manager exactly like an over-threshold refund and the result reports `points_clawed_back` / `points_shortfall`. `rebase_points_after_return` leaves a redeemed-against accrual alone.
<!-- end v0.8 QA — rewards -->
<!-- v0.8 QA — salon -->
- **C1 A client number could not be entered on the Salon** — the keypad is digits-only, the server wanted `MC######`. `identifiers.coerce_client_number` accepts the bare six digits (seven or more is a phone lookup) and both the Salon and the POS client lookup use it.
- **C2 The Salon ambient screen was bare on CloudChaserz** — the seed had no Salon step; `setup/cloudchaserz/salon.py` seeds a chain playlist and a store playlist with the tenant's own captions.
<!-- end v0.8 QA — salon -->
<!-- v0.8 QA — warehouse -->
- **W-D1 A request raised from a low-stock alert could never be rejected (high)** — `shipping.reject` deleted the draft Material Request *before* clearing `AWANZ Stock Alert.material_request`, so ERPNext's link check rolled the whole call back and the request sat on the wall for ever. Every link to the MR is cleared first (a submitted one is cancelled rather than deleted).
- **W-D2 The desk's "Waiting" column was wrong by the site's UTC offset** — it parsed the zone-less `requested_at` in the browser's zone, so every new request rendered amber off-zone while the wall and the Shipments tab (which use the server's `age_seconds`) disagreed. `request_dict` reports `age_seconds` and the desk ticks it locally like every other card.
- **W-D3 The low-stock digest failed outright, and one bad recipient killed every store's** — each send is its own attempt with `frappe.log_error`, and with no outgoing Email Account the job reports `skipped` instead of failing.
- **W-D4 `shipping.buy` silently orphaned an already-purchased label** — a second call overwrote carrier / rate / label / tracking of a label the carrier has already billed. It refuses unless `replace=1`, and records the voided label on the shipment.
- **W-D5 The cycle-count reconciliation was owned by Administrator** — the draft is inserted as Administrator by design (ERPNext checks write permission on it explicitly), so `owner` is now put back to the counting user and the count is recorded in a comment.
- **W-D6 `first_seen` / `last_seen` never reached any client** — `frappe.get_all` drops every field whose *name contains* an optional column (`_user_tags`, `_comments`, `_assign`, `_liked_by`, **`_seen`**) when the table lacks it, so both were silently missing from every alert list while filters and `order_by` on them worked. `inventory.alert_rows()` reads them through the query builder (as `tasks.check_heartbeat_staleness` already had to for `AWANZ Device Heartbeat.last_seen`).
- **Minor** — cancelling a shipment re-opens its replenishment request (Material Request cancelled, store notified) instead of leaving it Approved with nothing coming; every leg of a multi-leg receipt is linked (`AWANZ Shipment.receipt_entries`), not just the first; framework errors shown to warehouse users keep the document name and lose the raw `/app/…` desk link (`utils/text.humanizeServerMessage`); the simulated tracker runs on the site clock, so a label bought seconds ago no longer reports "Accepted at origin facility".
<!-- end v0.8 QA — warehouse -->
<!-- v0.8 QA — dashboard -->
- **D-1 The hourly chart hid 86 % of the day and named the wrong peak (high)** — `HourlyChart.vue` hard-coded 09:00–21:00 and reduced `peak` over that slice; on the QA day $512.73 of $597.38 sat in the 04:00 bucket. The window follows the data (`dashboard/src/lib/hourly.ts`), `peak` is computed over every bucket, and an all-zero day reports no peak instead of "PEAK 09:00 · 0".
- **D-3 The Hourly Heatmap invented an 8 a.m. peak** — `HOURS = range(8, 22)` plus `min(max(hour, 8), 21)` folded out-of-hours trade into the edge columns ($813 at 08:00 for 33 invoices rung at 04:36). Every hour that traded gets its own column; nothing is moved.
- **D-2 / D-4 / D-7 One definition each, applied and labelled** — the store's average ticket is now built from sales only, like the associate's (`avg_ticket_vs_boutique` was inflated 5 % and flipped the top associate's verdict); "avg ticket" everywhere is the average **sale** (returns excluded on both sides — the Live KPI read $19 where the average sale was $45) and the tile says "Avg sale · excl. returns", with the old figure kept as `net_per_ticket`; and "net sales" is `grand_total`, returns netted, tax included on every tab — the Reports period comparison used `net_total` under the same words (a $44 gap, exactly the day's tax) and now reports the pre-tax figure separately as `net_of_tax`.
- **D-5 The Clients tier filter emptied the list on every tenant but the first** — the chips were hard-coded `Patron / Collector / Connoisseur`; they come from the loyalty programme (`clients_overview.available_tiers`).
- **D-6 Three reports were unreachable and their CSV 404'd** — Commission Statement, Promotion Performance and Campaign Performance were missing from `api/reports.REPORTS`.
- **D-9 `share_pct` did not reconcile with the store total printed beside it** — the denominator clamped return-only items to zero while the header printed the true net.
- **D-12 Every non-cash tender was reported as "card"** — `live_summary` splits `card` and `other_tender` the way the Daily Sales report always has.
- **D-13 The Products "data as of" stamp could read a full cycle stale** — `compute_trends` set the stamp and cleared the caches *before* committing; it commits first now and drops the defaults cache after.
- **D-14 The Serial Ledger had no boutique scoping and no filter validation** — it was the one AWANZ report that skipped `normalize_filters`.
- **D-8 / D-10** — the Reports tab no longer prints the framework's name (the last such string in the product), and clicking the active STORES tab from a store page returns to the list.
<!-- end v0.8 QA — dashboard -->
<!-- v0.8 QA — UX -->
- **U1 "Powered by Futonix" was missing from the whole customer-facing website** — the storefront shell and the public receipt render the brand-driven credit, and `whitelabel.refresh_footer_credit()` (on migrate) keeps the stored `Website Settings.footer_powered` current, which is what `/login` and every standard web page print.
- **U2 The POS keyboard focus ring was invisible** — the browser default is a 1 px near-black outline on a near-black ground (≈1:1). One `:focus-visible` rule gives every control a 2 px gold ring, inverted to the ground colour on gold-filled buttons (WCAG 2.4.7 / 2.4.11).
- **U3 Dashboard contrast** — inactive nav tabs were 4.37:1 (AA needs 4.5) and are `--muted` (8.6:1) now; the dashboard page no longer renders the framework navbar it used to hide with CSS (its "Toggle navigation" button sat in the accessibility tree at 1.07:1), and the toggler is legible where the framework navbar is still used (`/login`, error pages).
- **U4 360 px overflow** — `/`, `/shop`, `/rewards` (17–19 px) and `/start` (30 px) are 0 px now: header tools keep a 44 px target on a tighter gutter, the rewards strip drops to one column, and a long wordmark scales instead of overflowing.
- **U5** — the two rewards consent checkboxes carry a programmatic label.
<!-- end v0.8 QA — UX -->
- **Tests** — `maison_pos/tests/test_v0_8_qa_defects.py` (34), `dashboard/src/lib/hourly.test.ts` (8) + `dashboard/src/qa_v08.test.ts` (4), `frontend/src/tests/qa_v08.test.ts` (6); the assertions that encoded the old behaviour were updated in `test_webshop.py`, `test_v0_4_reports.py`, `test_v0_5_campaigns.py` and `dashboard/src/lib/aggregate.test.ts`.

## 0.6.0 — 2026-08-23 "CloudChaserz"

Rebrand to a real tenant (CloudChaserz, a Houston/Oklahoma smoke-shop chain), store-manager
receiving, a head-office warehouse & shipping module, and the client's rewards programme.
Internal doctype and module names stay `AWANZ *` / `maison_pos`; everything user-facing is driven
by brand settings. Additive — the jewellery profile stays a first-class vertical.

### Added
<!-- v0.6 N -->
- **N Brand, vertical & age verification** — `AWANZ POS Settings` gains `brand_name`, `product_name`, `tagline`, `wordmark_text`, `sub_mark`, `legal_name`, `support_email`, `brand_website`, `brand_logo`, `head_office_boutique`, `main_warehouse`, `vertical` (Smoke Shop / Jewellery / General). `maison_pos/brand.py` + `catalog.bootstrap.brand{…}`; POS, Salon, dashboard, web shop, receipts, print formats and e-mails read the brand token — no hard-coded "AWANZ" in user-facing copy, and "Boutique" becomes "Store" outside the jewellery vertical. Frontend `src/brand/tokens.ts` (pure) + `src/stores/brand.ts` (`useBrand()`). Vertical product attributes (`maison_brand`, `maison_flavor`, `maison_nicotine_mg`, `maison_volume_ml`, `maison_puffs`, `maison_age_restricted`, `maison_msrp`) and the smoke-shop Item Groups. **21+ age gate**: AAMVA PDF417 parser on the device (`src/scan/aamva.ts`), `AgeGateSheet.vue`, Salon `SalonIdCheck.vue`, `api/age.py` + `AWANZ Age Check` (outcome, method, initials, issuing state only — never the payload, name, licence number or address), settings `age_verification_required` / `minimum_age` / `id_scan_enabled`, `webshop_age_restricted_sales` off by default. `setup/cloudchaserz/*`: company, 11 stores + `HOU-WH`, tax templates, ~120-item catalogue with EAN-13 + generated SVG art, users and PINs, adapted history seed. `docs/cloudchaserz.md`.
<!-- end v0.6 N -->
<!-- v0.6 O -->
- **O Store scoping & receiving** — `AWANZ Manager` is store-scoped in every endpoint (`scoping.py`) *and* in desk list views (`permission_query_conditions` / `has_permission`) for Stock Entries, Purchase Receipts, Material Requests, Stock Alerts, Sales Invoices, Employees/shifts, feedback and cycle counts; proved over real HTTP by `tests/test_v0_6_scoping_http.py` and `e2e/cloudchaserz.e2e.mjs`. New POS screen **Receive** (`views/ReceiveView.vue`): inbound warehouse shipments and vendor-direct POs, scan or tap to count, highlighted discrepancies, partial receipt, one-tap "Request from warehouse" from the low-stock list. `AWANZ Receiving Discrepancy` per short / over / damaged line; in-transit stock flow (`HOU-WH` → `<code> In Transit` on ship, → store on confirm).
<!-- end v0.6 O -->
<!-- v0.6 P -->
- **P Warehouse & shipping** — role `AWANZ Warehouse Admin`; `AWANZ Replenishment Request` (+ Line) → approve / edit quantities / reject with reason → `AWANZ Shipment` (+ Line) with the Pending → Picking → Packed → Shipped → Received lifecycle and its stock postings. Rate shopping behind one adapter interface (`shipping/providers/{base,simulated,shippo,easypost}.py`): **Simulated** by USPS zone and billable weight (default), **Shippo** implemented for real (`site_config.shippo_api_key`, test mode), EasyPost as the alternative — Pirate Ship has no public API and is documented as a manual fallback only. Cheapest auto-selected with a fastest toggle. Warehouse admin desk `/warehouse` and the 55" **Warehouse Wall** `/warehouse-wall` (1920×1080 kanban, age timers, priority flags, realtime with a 10 s polling fallback, sound/flash, touch actions) with **auto-print** of the packing list and label through a hidden iframe (`warehouse/print.ts`, `window.__awanzLastWallPrint`), documented for Chrome `--kiosk --kiosk-printing`. `AWANZ Packing List` print format; hourly tracking refresh; Command dashboard "Supply" tile. `docs/shipping.md`.
<!-- end v0.6 P -->
<!-- v0.6 Q -->
- **Q CloudChaserz Rewards** — $1 = 1 point, fixed redemption tiers `AWANZ Reward Tier` ($5/100, $10/200, $15/300; one per transaction unless `reward_allow_stacking`), points never negative and reversed on return. Birthday coupon auto-issued 7 days ahead and valid 30 days, `AWANZ Promotion Calendar` (+ Item, + Rule) sent on the 1st, weekly new-arrivals campaign, `AWANZ Giveaway` (+ Entry) with a seeded, auditable draw, Events campaign channel with RSVP. Public `/rewards` page and sign-up, the same copy in the Salon Join flow, points / balance / next reward / giveaway entries on every receipt. `api/rewards.py`, `docs/rewards.md`.
<!-- end v0.6 Q -->

### Fixed
- **Vitest hung indefinitely** on the whole frontend suite: `@/api/mock` imported `@/stores/brand`, which imports `@/stores/catalog`, which imports `@/api` — so a suite calling `vi.mock('@/api', async () => await import('@/api/mock'))` deadlocked inside its own mock factory. The pure brand tokens moved to `@/brand/tokens.ts` (no store imports) and `@/stores/brand.ts` keeps only `useBrand()`.
- **One bad date blanked a whole screen**: `Intl.DateTimeFormat.format()` throws `RangeError: Invalid time value` on an Invalid Date, and a throw inside a template took out the entire Returns view. `fmtDate` / `fmtDateTime` now render an em dash for missing or unparsable timestamps.
- **Cross-company replenishment** — `shipping.get_main_warehouse` is company-aware: on a bench carrying more than one company the settings-level `main_warehouse` of the *other* company could be handed back as the source, and ERPNext refused the transfer with `InvalidWarehouseCompany`.
- **Collecting a prepaid web order failed** when an in-store promotion made the counter invoice smaller than the amount paid online (`Advance amount cannot be greater than …`). The allocation is capped at the invoice total and the remainder stays as an unallocated advance.
- **Loyalty programme configuration** — `expiry_duration: 0` expired points the day they were earned (every balance read 0), and `conversion_factor: 1.0` valued 100 points at $100 so tier redemption was refused. The seed now uses 3650 days and $0.05 a point, matching the tier table.
- **Points were earned on the taxed total** — ERPNext accrues on `grand_total`, so a Houston sale handed out 8.25% more points than the "$1 = 1 point on the net amount" the programme and the `/rewards` page promise. `rewards.rebase_points_on_net` re-prices the accrual entry onto `net_total` after ERPNext writes it, leaving the negative redemption row alone.
- **`/rewards` rendered empty sections** — the template read `p.copy.earn`, which resolves to the `dict.copy` builtin rather than the `copy` key, so the earn line, the redeem rows and the perks silently disappeared.
- **Top bar overflowed on the rebranded POS** — the 12-character CLOUDCHASERZ wordmark at 0.3em tracking pushed the menu button 18 px off a 390 px screen, and the 9th nav entry ("Receive") plus longer store names made the full labels collide at 1366×1024. The phone wordmark tightens and may ellipsise; the compact top bar now applies up to 1400 px.
- **Test isolation** — `test_v0_2` assigned to `frappe.request`, rebinding the module-level werkzeug LocalProxy to a plain value for the rest of the process and breaking every later test that set `frappe.local.request` (the v0.5 campaign webhook tests). Tests that ring up stock items now guarantee their own stock (`tests/helpers.ensure_stock`) instead of assuming pristine demo data.

### Changed
- Version 0.6.0 across `maison_pos/__init__.py`, `frontend/package.json`, `dashboard/package.json`.
- Wall card store names no longer clip their descenders; `.rail-chips` and the nav strip scroll rather than widening the page.

## 0.5.0 — 2026-08-22 "Salon & Command"

### Added
<!-- v0.5 K -->
- **K AWANZ Salon (client-facing screen)** — `/salon` child app in the same PWA bundle (`www/salon.py`, guest page, own layout): pairing by 6-digit code / QR / deep link from Settings → "Client display", ambient screen with the generative "light on metal" canvas + HQ playlist (`AWANZ Salon Playlist` / items, seed `setup/demo_v05_salon.py`), identify (masked keypad, e-mail, client QR) / **Join AWANZ** sign-up (+ marketing consent, optional v0.3 `ConsentScreen` reused with a `controller`), basket mirror (piece large, serial, certificate, running total, points, "Ask about this piece" → CRM note), payment / Approved gold pulse, thank-you (points, tier progress, receipt QR, e-mail receipt, private feedback 1–5 → `AWANZ Feedback`, private-viewing invitation → `AWANZ Client Profile.private_viewing_invite`), Concierge Q&A (ring sizer, wrist, metal, style cards, occasions → profile). Backend `api/salon.py` (+ `AWANZ Salon Session`, token = doc name, Guest read-one / never list, realtime document room + 2 s polling, `sanitize_state` masking, rate limits, 12 h expiry `salon.expire_sessions`). POS: `stores/salon.ts` mirror (debounced 150 ms), `SalonSettingsCard`, `SalonBar` in the basket, dev `VirtualSalon` pane (mock parity via `localStorage` storage events). `cart.pointsEarned` now honours per-tier collection factors. Tests: `tests/test_v0_5_salon.py` (23), `src/tests/salon.test.ts` (19), `e2e/salon.e2e.mjs` (two contexts, 32 checks, `e2e/shots-salon/`); `docs/salon.md`.
<!-- end v0.5 K -->
<!-- v0.5 M -->
- **M HQ intelligence** — campaign attribution: `AWANZ Campaign` (+ `AWANZ Campaign Item` featured pieces), `AWANZ Campaign Touch`, `AWANZ Campaign Attribution`; rule last-touch 14 d + assisted 30 d + item-level (`maison_pos/campaigns/attribution.py`, nightly `attribution.nightly`), segment builder tier × boutique × item affinity × signal (`campaigns/segments.py`), signed inbound webhooks `campaigns.webhook_klaviyo` / `webhook_brevo` (`site_config` `klaviyo_webhook_secret` / `brevo_webhook_secret`), `campaigns.performance`, `attributed_sales`, `segment`, `export_segment` (CSV / Email Group), `record_touch`, `sync_email_campaign`, `run_attribution`; Script Report **AWANZ Campaign Performance**; `hr.employee_performance` finalised (follow-up rate, clients identified per sale, avg ticket vs boutique, returns rate, recognition enrolments); VIP-lapsing owner fallback + `insights.assign_call(signal)` → CRM Task; seed `setup/demo_v05_campaigns.py` (3 campaigns lined up with history invoices); `docs/campaigns.md`; `tests/test_v0_5_campaigns.py` (31).
<!-- end v0.5 M -->
<!-- v0.5 L -->
- **L Command dashboard** — `dashboard/` rebuilt for 40–100 boutiques: tabs Live / Boutiques / Products / Clients / Insights / Reports; store-level live feed (per-boutique live cards that pulse on a sale with "Sold · item · amount · n s ago", chain ticker, drill-in with item-level feed + hourly bars, region filter, search, sort); virtualised lists (`VirtualList.vue`, `lib/virtual.ts`), rAF-batched socket events (`lib/batch.ts`) folded into incremental per-boutique aggregates (`lib/aggregate.ts`: `createAggState` / `reduceEvents` / `seedFromSummary`), full reconcile only every 60 s / on reconnect; sortable Boutiques table (today / WTD / MTD, vs LW, conversion, returns %, stock value, low stock, on shift, status, 14-day sparkline) + boutique page; Products "Trending in stores" + "Top products by store" (+ item-group × boutique matrix); Clients (churn risk for top tiers with Assign call, follow-up rates, upcoming dates, recognition, associate / campaign performance when present); rem type scale for laptop / 1080p wall / 4K wall. Backend: `AWANZ Product Trend` + `insights/trends.py` (`compute_trends`, cron every 15 min), `api/dashboard.py` v2 (`live_summary` one grouped SQL cached 5 s with `vs_last_week_pct` / `last_sale`, `ticker`, `boutique_feed`, `boutiques_table`, `boutique_detail`, `product_trends`, `top_products`, `clients_overview`, `compute_trends`), realtime `awanz_sale` payload adds `amount`, `top_item`, `tier`, `is_return`; `tests/test_v0_5_dashboard.py` (17 incl. benchmarks: live_summary ≈ 13 ms, product_trends ≈ 4 ms), dashboard vitest 24 (reducer 100 boutiques × 1,000 events ≈ 3 ms), `e2e/dashboard.v05.e2e.mjs` (18 checks; card + ticker update 43 ms after the POS response), screenshots `dashboard/screenshots/v05/` (1920×1080 + 3840×2160, every tab, 100-boutique mock); `docs/dashboard.md`.
<!-- end v0.5 L -->

## 0.4.0 — 2026-08-22 "Operations & Intelligence"

Apps added alongside ERPNext: `payments` + `webshop` (`version-15`), `hrms` (`version-15`), `crm` (`main`).
`maison_pos.hooks.required_apps = ["erpnext", "hrms", "crm"]`; webshop / payments are feature-detected.

### Added
- **A Hardware** — V660p "reader printer" route (`printer/canvas.ts` 384-px monochrome receipt → `terminal.print(canvas)`), `AWANZ Store Reader` registry (`readers`, `damaged_warehouse`), Settings reader picker persisted per device, print route auto / reader / ePOS / browser, simulated reader with `has_printer`; `docs/hardware.md`.
- **B Clienteling** — `AWANZ Client Profile` (+ `AWANZ Wishlist Item`), `AWANZ Client Interaction`, CRM Contact / CRM Task glue, `api/crm.py` (`profile`, `update_profile`, `wishlist_add/remove`, `tasks`, `interactions`, `log_interaction`, `wishlist_matches`, `upcoming_dates`), wishlist arrival alerts on Stock Entry submit, POS Client → Clienteling tab (`ClientProfilePanel.vue`); `docs/crm.md`.
- **C Employees & payroll** — `AWANZ Associate.employee`, `AWANZ Shift` + HRMS Employee Checkin from the Unlock screen (`api/hr.py` `clock_in/out`, `toggle_break`, `on_shift`), `AWANZ Commission Rule` / `AWANZ Commission Entry` (created on submit, reversed on cancel / return), **AWANZ Commission Statement** report, `hr.payroll_export` (hrms / gusto / adp / quickbooks), employee performance tile; `docs/payroll.md`.
- **D Inventory** — `AWANZ Stock Alert` (hourly `inventory.low_stock_scan`, daily digest, Notification Log), `inventory.alerts / acknowledge / resolve / request_transfer` (Material Request), `AWANZ Cycle Count` + draft Stock Reconciliation (`CycleCountView.vue`, "Count" nav entry), Shift-screen Low stock card, dashboard tile.
- **E Returns & exchanges** — `api/returns.py` (`lookup`, `return_items`, `exchange`, `policy`, `recent`), credit notes with `update_stock`, serial back to the boutique or Damaged warehouse, Stripe refunds by PaymentIntent (`stripe_terminal.client.refund`), commission + loyalty reversal, manager PIN gate (`returns_manager_threshold`, `return_window_days`, `exchange_window_days`), `AWANZ Return Receipt` print format, `ReturnsView.vue` / `ExchangeView.vue`; `docs/returns.md`.
- **F Reports** — Script Reports AWANZ Sales Tax Summary, Daily Sales, Sales by Item, Sales by Associate, Hourly Sales Heatmap, Client Purchases (RFM), Serial Ledger, Returns, Promotion Performance, Commission Statement; `api/reports.py` (`list_reports`, `run`, `export` CSV, `period_comparison`) with boutique scoping; dashboard Reports section + period comparison widget.
- **G Web shop** — Monolith Gold storefront (`www/shop/*`, `templates/webshop/*`, `public/css/awanz-web.css`), `AwanzWebsiteItem` override, web modes Buy / Enquire / Reserve-with-deposit (`Item.maison_web_mode`), availability per boutique, `AWANZ Web Enquiry`, click & collect Sales Orders (`maison_boutique`, `maison_web_status` New → Picking → Ready → Collected), `api/webshop.py`, POS `WebOrdersView.vue` (badge in the nav), simulated gateway without Stripe keys, `AwanzPaymentRequest`; `docs/webshop.md`.
- **H Insights** — `maison_pos/insights/` (affinity lift, client signals, product performance / rebalance, narrative), doctypes `AWANZ Client Recommendation`, `AWANZ Client Signal`, `AWANZ Rebalance Suggestion`, `AWANZ Insight Report`, weekly cron jobs (Mon 05:00 / 06:00), `api/insights.py`, POS "Suggested for this client" + "Pairs well with" tiles, dashboard Insights tab, `setup/demo_history.py` (`seed_history(months)`, `seed_history_remote`, `history_status`).
- **I Promotions, feedback, loyalty** — Pricing Rules on the basket (`PromotionsChip.vue`, `stores/promos.ts`), `AWANZ Coupon` + `AWANZ Coupon Redemption` (`promotions.check_coupon`, server re-validation in `submit_batch`), private feedback on `/r/<token>` (`AWANZ Feedback`, `feedback.submit` guest POST, HQ `list / summary / respond`, ≤ 2 alert), tier progress + points expiry on the basket / receipt page, daily `promotions.birthday_bonus`, tier Customer Groups (Collector / Connoisseur / Patron).
- **J Scanners** — prefix / suffix (Tab vs Enter) configuration and a Settings scanner test for Bluetooth HID scanners; `docs/scanners.md`.
- e2e `e2e/pos.v04.e2e.mjs` (37 checks: coupon, V660p canvas print, clock-in, low stock, clienteling, suggestions, return + exchange, web order collection, guest feedback, tax report, nav fit), screenshots in `e2e/shots-v04/`.

### Changed
- `sales.submit_batch` line semantics are now enforced as specified: `rate` = unit list rate, `discount_amount` = whole-line discount (manual + promotion). Previously the server treated `rate` as net and the discount as per-unit, so any discounted line produced `PAYMENT_MISMATCH`.
- System Settings `rounding_method` is pinned to **Commercial Rounding** on install / migrate (`setup.install.ensure_rounding_method`) so server totals equal the device's half-away-from-zero totals on half-cent taxes.
- `catalog.bootstrap.boutique` now carries `readers[]` and `damaged_warehouse`.
- TopBar: 8 entries (Sell, Client, Returns, Web orders, Count, Queue, Shift, Settings); compact labels and boutique code only ≤ 1100 px so the row fits an iPad in landscape; phone drawer lists all entries.
- Frappe Cloud: `payments`, `webshop`, `hrms`, `crm` must be added to the release group (see `INTEGRATION_NOTES.md`).

### Fixed
- `tests/test_recognition.test_retention_purge` was order dependent: back-dating an invoice at DB level before the next stock submit triggered an item-wise repost of the same item that failed on the 2023 date.
- `tests/test_insights.test_client_recommendations_exclude_owned_items` assumed a demo client with no history; uses a dedicated client.
- Promotions chip on the iPhone sheet was 44 px tall (touch targets are ≥ 48 px).
- e2e serial detection picked the promotion marker on non-serialized lines (`.line-sub .good.serial`).

## 0.3.0 — 2026-08-22 "Client recognition"
On-device face-api descriptors, consent (`AWANZ Biometric Consent`, hold-to-agree), enrol / match / undo / decline / revoke, raw-descriptor euclidean matching (`match_threshold` 0.6, patch `v0_3.match_threshold_distance`), template delta sync, offline enrolment queue, BIPA retention purge (`tasks.purge_expired_biometrics`), `docs/biometrics-policy.md`, `e2e/pos.v03.e2e.mjs`.

## 0.2.0 — 2026-08-22 "Monolith Gold"
Gold palette, product images, barcode / QR scanning (camera + HID wedge), iPhone layout with bottom-sheet basket, receipt QR + public receipt page `/r/<token>` (`sales.receipt` guest JSON), client numbers `MC######` (patch `v0_2.backfill_client_numbers`), loyalty points on basket / receipt, `e2e/pos.v02.e2e.mjs`.

## 0.1.0 — 2026-08-21 "Foundation"
Frappe app (`AWANZ Store`, `AWANZ Associate`, `AWANZ Price Change Request` + workflow, `AWANZ Device Heartbeat`, `AWANZ Sync Log`, `AWANZ POS Settings`), offline-first Vue 3 PWA at `/pos`, idempotent `sales.submit_batch`, Stripe Terminal (simulated without keys), ePOS 80 mm receipts + `AWANZ Receipt` print format, voids, Z-report, live dashboard at `/awanz-dashboard`, docker stack, demo seed (`seed`, `seed_remote`), `e2e/pos.e2e.mjs`.
