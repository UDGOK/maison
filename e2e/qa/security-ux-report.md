# CloudChaserz — QA 5+6: Security / Isolation & White-label / UX

Live site: **https://cloudchaserz.frappe.cloud** · Date: 2026-08-23 (17:30–18:40 UTC)
Scope: **(A)** security, permissions, multi-store data isolation; **(B)** white-label integrity,
branding, accessibility, cross-device UX. Shared live site — read-only wherever possible; every
write was prefixed `QA-SECUX` / flagged and reverted (final state re-verified clean).

Personas (password `cloud123`, PIN 2580): guest · associate `ok.mingo.a1@` (OK-MINGO) · manager
`ok.mingo.manager@` (OK-MINGO) · manager-B `ok.etul.manager@` (OK-ETUL) · warehouse admin
`warehouse@` (HOU-WH) · head office `hq@`. **No Maison Regional user exists on the seed.**

Harness/scripts: `e2e/qa/harness.py`, `t_signup.py`, `t_generic.py`, `t_escalation*.py`,
`t_headoffice.py`, `t_guest_auth.py`, `t_a4.py`, `t_sweep.py`, `ux_crawl.mjs`, `ux_pos.mjs`,
`ux_errors.mjs`. Screenshots: `e2e/qa/shots-secux/`.

---

## A. Security, permissions & multi-store isolation

| # | Test | Result | Evidence | Severity |
|---|------|--------|----------|----------|
| S1 | Store **Manager self-escalates to Head Office** (unrestricted, all 11 stores) | **HOLE** | As `ok.mingo.manager@`: `POST frappe.client.set_value {doctype:"Maison Associate", name:"ok.mingo.manager@…", fieldname:"role", value:"HeadOffice"}` → `on_update._sync_user_role` (add-only, `ignore_permissions`) grants `Maison Head Office`. Proof: after, `catalog.bootstrap(boutique=OK-ETUL)` → **200** (was 403). `role` Select allows `Regional`/`HeadOffice`; Manager has `write=1` on Maison Associate at permlevel 0. Reverted. `t_headoffice.py` | **CRITICAL** |
| S2 | **Cross-store PIN-hash disclosure** → offline crack + impersonation | **HOLE** | As plain **associate**, `frappe.client.get_list("Maison Associate", fields=[…,"pin_hash"])` returns **all 37 rows across 13 stores, every one exposing `pin_hash`** (incl. every manager's); also via `/api/resource/Maison Associate/<name>`. `pin_hash` is `hidden/read_only` (UI-only) but permlevel-0 readable by Maison Associate. PIN = 4–6 digits, `pbkdf2_sha256$120000$…` hex (offline-verifiable; seed PINs are the shared constant 2580 / mgr 1101,2202). Exposed hash **bypasses the 5-attempt online lockout**. `t_generic.py` | **CRITICAL** |
| S3 | **Anonymous `rewards.signup` overwrites an existing Customer as Administrator + leaks client number** | **HOLE** | `rewards.signup` (allow_guest) runs `frappe.set_user("Administrator")` → `customers.upsert` matches existing Customer by email/phone and `doc.save(ignore_permissions)`. Guest signup with an existing email overwrote `customer_name` ORIG→HIJACKED and **returned the victim's client number** `MC348947`. Lets an attacker knowing a target's on-file email learn their loyalty number and rewrite name/phone/marketing-consent/preferred-store. Proven on QA data, reverted. `t_signup.py` | **HIGH** |
| S4 | **No rate limiting** on public `rewards.signup`; salon limits ineffective on Frappe Cloud | **HOLE** | `rewards.signup` sets `frappe.rate_limit=None` (no-op): 12 rapid anon signups → all 200 (unbounded anon Customer creation = spam/DoS, enables S3 brute force). Salon uses `_rate_limit()` keyed on `frappe.local.request_ip`, which behind the platform proxy doesn't throttle — 16 `salon.pair` (limit 12) → 0 blocked. `t_signup.py`, `harness` salon probe | **MEDIUM-HIGH** |
| S5 | Manager grants Frappe roles to own-store staff; Manager self-repoints boutique (same root as S1) | **HOLE** | Manager sets own-store associate `role=Manager` → grants `Maison Manager` User role (sync hook). Manager `set_value` own `boutique` OK-MINGO→**OK-ETUL** succeeded (X5) — moves data scope to another store. Associate write is correctly blocked (403). Reverted. `t_escalation2.py` | **MEDIUM** |
| S6 | Global client PII readable by every store user; User enumeration | **NOTE (by-design?)** | Any associate/manager `get_list("Customer")` returns the whole chain-wide client DB (name, `maison_client_number`, `mobile_no`, `email_id`). Any associate can enumerate all `User` rows (staff names/emails). `api_secret` **is** correctly stripped. `t_generic.py` | **LOW-MEDIUM** |
| A- | **D3 re-verify** — manager lists other-store invoices/returns/blank-stamp | **PASS (fixed)** | manager@OK-MINGO: other-store invoices 0, other-store returns 0, any-return chain-wide 0 leaked, blank-stamp 0. v0.6 D3 closed. `t_generic.py` | — |
| A- | Boutique-arg `maison_pos.api.*` as manager-A → store B | **PASS** | **33/34** endpoints → 403 (`catalog`, `inventory.*`, `shipping.*`, `dashboard.*`, `crm.*`, `hr.*`, `insights.*`, `promotions.*`, `recognition.templates`, `sales.list`, `salon.pairing_code`, `reports.period_comparison`, `campaigns.performance`, `session.associates`, …). The one 200 = `age.settings` (global config, no store data). `t_sweep.py` | — |
| A- | Guest reaches authed API / generic reads | **PASS** | Guest → 403 on `dashboard.live_summary`, `catalog.bootstrap`, `sales.*`, `customers.search`, `inventory.alerts`, `shipping.wall`, and `frappe.client.get_list` for Customer / Sales Invoice / Maison Associate / User. `t_guest_auth.py` | — |
| A- | `/r/<token>` guest receipt PII | **PASS** | Real token: no customer name, client number masked `MC•••NNN` only, associate name null on walk-in; `/r/` HTML carries no PII. Token = 16-char CSPRNG (unguessable); bad token → 404. `t_a4.py` | — |
| A- | `webshop.loyalty_lookup` enumeration | **PASS** | Requires **both** client_number AND email to match; wrong pair → empty (no oracle). `t_guest_auth.py` | — |
| A- | CSRF on mutating POST; expired sid; logout | **PASS** | Cookie POST without CSRF token → **400 CSRFTokenError** (generic + maison api). Bogus/expired sid → 403 `session_expired`. `logout` invalidates the sid (subsequent call 403). `t_guest_auth.py` | — |
| A- | Associate void / manager self-approve replenishment / age-check tamper | **PASS** | Associate `sales.void` → 403 (manager-only). Manager self-approve own `shipping.approve` → 403 ("Warehouse admin role required"). Age Check + Biometric Consent are read/create-only for store staff (no `write`) → no tampering. `t_a4.py` | — |
| A- | **D5 re-verify** — Walk-in Customer is a rewards member | **PASS (fixed)** | `Walk-in Customer.loyalty_program = null`, `maison_client_number = null`. `t_a4.py` | — |

**Void has no amount threshold / dual-control** (manager voids any amount) — control gap for a cash-heavy
vertical, not a technical hole. **POS Settings read as manager → 403 with a full Python Traceback in the
JSON `exc`** (verbose internal-path disclosure to an authenticated user hitting the raw API).

---

## B. White-label, branding, accessibility & cross-device UX

| # | Test | Result | Evidence | Severity |
|---|------|--------|----------|----------|
| U1 | **"Powered by Futonix" credit in the website footer** | **MISSING** | Present on `/start`, `/maison-dashboard`, `/salon`, desk About (JS). **Absent from the whole customer-facing website**: `/`, `/login`, `/shop`, `/rewards`, `/r/<token>` — server HTML contains no "Powered by" and no "Futonix" at all. Storefront's own footer never renders `developer_credit`. `ux_crawl.mjs`, requests grep | **MEDIUM** |
| U2 | **POS focus visibility** (WCAG 2.4.7/2.4.11) | **FAIL** | Keyboard-Tab ring = browser default `outline: auto 1px rgb(16,16,16)` on ground `rgb(11,11,10)` → ~1:1, invisible. Primary controls `.search input`/`.tile`/`.pay button` compute `outline:none`, no box-shadow ring. `ux_pos.mjs`, `ux_errors.mjs`; `a11y-pos-focus.png` | **MEDIUM** |
| U3 | Dashboard text/UI contrast | **FAIL (AA)** | Inactive nav tabs Stores/Products/Clients/Insights/Reports = `rgb(125,118,104)` on black = **4.37:1** (need 4.5; 11px/500). Leftover Bootstrap navbar-toggler (aria "Toggle navigation") = `rgba(0,0,0,.5)` on black = **1.07:1** (invisible framework artifact). `ux_pos.mjs`, `dashctx.mjs` | **LOW-MEDIUM** |
| U4 | Horizontal overflow across 5 viewports | **MINOR** | 360×740 (small Android): `/` 17px, `/shop` 17px, `/rewards` 17px, `/start` 31px (1px @390). No overflow ≥390 for storefront; POS unlock/sell and dashboard 0px at every viewport. `ux_crawl.mjs` | **LOW** |
| U5 | aria gaps / non-POS tap targets | **MINOR** | Rewards signup form has 2 inputs without programmatic label. Non-POS tap targets <44px: dashboard 9 (desktop controls), shop/rewards 1 each. `ux_pos.mjs` | **LOW** |
| B- | **Forbidden visible text** (Frappe/ERPNext/frappe.io/erpnext.com) on every route | **PASS** | **Zero** rendered-text hits on `/`, `/login`, `/start`, `/pos`, `/maison-dashboard`, `/warehouse`, `/warehouse-wall`, `/shop`, `/rewards`, `/salon`, `/r/`, 404, `/app`. Only allow-listed `/assets/frappe|erpnext/…` identifiers in source. `ux_crawl.mjs` | — |
| B- | **v0.6 D1 re-verify** — dashboard branded "Maison" | **PASS (fixed)** | `/maison-dashboard` wordmark = **CLOUDCHASERZ**, scope = **Today · All Stores**, tabs = **STORES** (TopBar.vue now reads `brand.wordmark`). `wl-dashboard-1920.png` | — |
| B- | **v0.6 D2 re-verify** — unlock overflow @1366×1024 | **PASS (fixed)** | scrollWidth−clientWidth = **0px** (was 147px); CLOUDCHASERZ fits, picker/LOAD/keypad all visible. `a11y-unlock-1366.png` | — |
| B- | **v0.6 D4 re-verify** — HOU-WH shown as a 12th store | **PASS (fixed)** | Dashboard Live shows exactly **11 stores**, HOU-WH excluded. `wl-dashboard-1920.png` | — |
| B- | POS contrast + tap targets + aria | **PASS** | Gold-on-black 8.3–8.8:1, body 15–16:1, buttons 7.6:1 — all ≥ AA. Tap targets: tiles 192×249, pay 159×64, topbar 48–79×56, search 280×48 — all ≥44px. 200 buttons all named, 2 inputs labeled, `lang=en`. `a11y-pos-sell-1366.png` | — |
| B- | Error-handling UX (route 9): expired session, permission denial | **PASS** | Expired sid & associate-on-HQ-dashboard both render **"CLOUDCHASERZ – NOT PERMITTED · Please log in to view the dashboard · LOGIN"** — branded, human, no raw framework strings. `err-expired-dashboard.png`, `err-assoc-dashboard.png` | — |
| B- | Storefront/shop/rewards contrast; 404 branding | **PASS** | `/shop` 13/13, `/rewards` 8/8 sampled elements pass AA. 404 correctly branded (CloudChaserz + intentional "Maison POS" sub-mark). `a11y-shop.png`, `a11y-rewards.png`, `wl-404.png` | — |

**Raw/internal error strings reachable (JSON API only, not shown in UI):** `frappe.exceptions.PermissionError`
(+ full Traceback on POS-Settings read), `CSRFTokenError`/"Invalid Request", `DoesNotExistError`,
`frappe.exceptions.ValidationError`, `{"session_expired":1}`. In the browser UI these surface as human,
branded messages. Minor: the www error card is dark-themed on a light page background.

**Carried v0.6 observations** (not re-deep-audited): salon jewellery vocabulary on a smoke-shop tenant;
browser-local clocks on salon/dashboard; site timezone unset (falls back to Asia/Kolkata); today's seed has
returns only (11 negative/OFFLINE stores until a sale rings).

---

## Cleanup / site state (left clean)
- 13 `QA-SECUX` test Customers → **disabled** (0 enabled remain). `MRR-2026-00059` (QA replenishment) → **Rejected**.
- All escalation writes reverted: manager/associate User-roles and `Maison Associate.boutique/role/full_name`
  re-verified at baseline; `hq@`/`warehouse@` untouched; Walk-in Customer untouched.
- One under-21 `Maison Age Check` (initials "QA") left as an immutable audit record (no PII). No app source modified.
