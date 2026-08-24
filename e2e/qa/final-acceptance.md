# AWANZ POS — final acceptance on the live site

**Site:** `https://cloudchaserz.frappe.cloud` (CloudChaserz tenant — 11 stores + `HOU-WH`, 160 items,
3,002 history invoices) after the **Maison → AWANZ rename (v0.9)** and the **v0.8 fix batch** were
deployed and migrated.
**When:** 2026-08-24, 10:15 – 11:35 America/Chicago (site time; the harness browser runs UTC).
**Verdict: PASS — 124 / 124 checks green across the ten areas of the brief. No blocking defect.**
Three low-severity product defects and a handful of cosmetic observations are listed below; the site
is left clean and demo-ready.

Playwright 1.56 / Chromium 1194, every browser context wired through the sandbox transport bridge
(`e2e/cloud-bridge.mjs`, and `e2e/qa/fa-bridge.mjs` for the storefront lane — see *Harness notes*).
No file under `maison_pos/`, `frontend/` or `dashboard/` was touched.

| Script | Checks | Log | Raw results |
|---|---|---|---|
| `e2e/cloudchaserz.cloud.e2e.mjs` (areas 2–8, existing script) | **72 / 72** | `qa/final-main.log` | `qa/results.final-main.json` |
| `e2e/qa/fa-pos.mjs` (POS, the two v0.8 critical fixes, returns) | **23 / 23** | `qa/fa-pos.log` | `qa/results.fa-pos.json` |
| `e2e/qa/fa-launch.mjs` (logins/launcher, branding audit, security) | **19 / 19** | `qa/fa-launch.log` | `qa/results.fa-launch.json` |
| `e2e/qa/fa-shop.mjs` (shop registration + click & collect, dashboard) | **10 / 10** | `qa/fa-shop.log` | `qa/results.fa-shop.json` |

Console errors / page errors: **0** in every run that instruments them — the main script (11 browser
contexts) and `fa-pos.mjs` both report `console issues: 0`, and `fa-shop.mjs` recorded no page error on
the storefront, the POS or the dashboard.

Re-run:

```bash
# fresh Administrator sid
curl -s -X POST https://cloud.frappe.io/api/method/press.api.site.login \
  -H "Authorization: Token <press-token>" -H 'Content-Type: application/json' \
  -d '{"name":"cloudchaserz.frappe.cloud","reason":"acceptance"}' \
  | python3 -c "import sys,json;open('/tmp/ccsid','w').write(json.load(sys.stdin)['message']['sid'])"

cd /home/claude/maison/e2e
export BRIDGE=1 NODE_USE_ENV_PROXY=1 PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 \
       BASE=https://cloudchaserz.frappe.cloud ADMIN_SID=$(cat /tmp/ccsid) \
       PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
SHOTS_DIR=qa/shots-final RESULTS=qa/results.final-main.json node cloudchaserz.cloud.e2e.mjs
node qa/fa-pos.mjs ; node qa/fa-launch.mjs ; node qa/fa-shop.mjs
python3 qa/fa-cleanup.py     # cancels everything the run created
```

---

## Results by area

### 1. Logins and the launcher — **PASS** (11/11)

Each demo user signed in through the real `/login` form; the framework's post-login destination is
`/start` for all five (`add_to_apps_screen` + `System Settings.default_app`), and the launcher's card
list matches the roles the site actually holds (expectation derived per user from `Has Role`, compared
with `maison_pos/www/start.py::SCREENS`).

| User | Roles (AWANZ) | Landed | Screens listed |
|---|---|---|---|
| `hq@` (Hunter Quinn) | Head Office | `/start` | `/pos /awanz-dashboard /warehouse /warehouse-wall /salon /shop /rewards /app` |
| `warehouse@` (Walter Hines) | Warehouse Admin, Manager | `/start` | `/pos /warehouse /warehouse-wall /salon /shop /rewards` |
| `hou.mtr.manager@` (Marisol Vega) | Manager | `/start` | `/pos /salon /shop /rewards` |
| `hou.mtr.a1@` (Dante Ruiz) | Associate | `/start` | `/pos /salon /shop /rewards` |
| `regional.ok@` (Rosa Kingfisher) | Regional | `/start` | `/pos /awanz-dashboard /salon /shop /rewards` |

`/start` also names the store the user works in ("CloudChaserz Montrose") and carries **"POWERED BY
FUTONIX"**. Screenshot: `shots-final/fa-start.png`.

### 2. POS end to end — **PASS** (33/33: 12 in `fa-pos.mjs`, 21 in the main script incl. the nine-check age-gate battery)

`hou.mtr.a1@` → `/pos` → store picker → PIN `2580` → **160 tiles in 3.5 s**.

* **Age gate** — tapping the 21+ item `DSP-002` raised `CHECK ID · 21+` *before* the basket; a valid
  AAMVA PDF417 payload on the Scan-ID tab passed and rang the item up (`fa-pos-age-gate.png`).
  The under-21 / expired paths are covered again by the main script (9/9, area 2 below).
* **Client by client number** — `MC459222` typed on the basket keypad attached *Carlos Mendoza ·
  MEMBER · 311 points* (`fa-pos-sell.png`).
* **Cash sale** — device `$51.12` → invoice `$51.12` to the cent; receipt carries the PNG QR, the
  public link, `CLOUDCHASERZ REWARDS · POINTS EARNED 47 · BALANCE 358` and `ID checked · 21+ verified`
  (`fa-receipt.png`). Guest `GET /r/<token>` → **200** with the invoice rendered; `/r/<bad>` → 404.
* **Card sale on the simulated reader** — `Counter 1 · V660p`, `pi_sim_…`, invoice `$28.12`, and the
  tender carries brand / last four / approval (`Visa •••• 4242`) — the v0.8 POS D7 fix
  (`fa-pos-card-ready.png`).
* **Split tender (new in v0.8, D10)** — `$28.12` split into `$10.00` cash + `$18.12` card; the invoice
  books **two payment rows** that add up to the grand total (`fa-pos-split-tender.png`,
  `fa-receipt-split.png`).

### 3. The two critical v0.8 fixes — **PASS** (8/8), both confirmed fixed

**(a) POS D1 — the cent divergence.** Basket built to hit both halves of the old bug: four lines,
quantities 3/3/3/3, and a **$1.49 whole-line discount on `ACC-009` @ $6.99** (unit rate `6.4933`, which
does not divide into whole cents).

| | net | tax | total |
|---|---|---|---|
| ERPNext / fixed device | 106.38 | 8.78 | **115.16** |
| pre-v0.8 device model (per-line tax rounding + `amount − discount`) | 106.39 | 8.79 | 115.18 |

The device displayed **$115.16**, and the submitted invoice is
`net 106.38 + tax 8.78 = $115.16` — exact parity, sale accepted
(`fa-pos-multiline-discount.png`). The harness asserts the basket really is a divergent one before
asserting parity, so the check cannot pass vacuously.

**(b) POS D2 — offline sale of an age-restricted item.** Context offline (`setOffline` + bridge +
`window.__awanzOffline`): the age gate still ran **on the device**, the 21+ item rang up, the sale
queued (`Queued offline`, top bar `OFFLINE · 1 QUEUED`, `fa-pos-offline-queued.png`) and **nothing
reached the server**. Back online the queue drained into `ACC-SINV-2026-03130` `$22.99` (device
`$22.99`), top bar `ONLINE`, with `maison_age_verified = 1`,
`maison_age_checked_at = 2026-08-24 10:46:56` (a real Datetime, not the ISO string that used to be
rejected) and the audit row `AWANZ Age Check c2tgpb44ia · outcome Verified · method Scan · reason
offline · age 41 · initials DO` linked to the invoice (`fa-pos-offline-drained.png`).

### 4. Returns — **PASS** (4/4: 3 in `fa-pos.mjs` + the main script's loyalty-reversal check)

`hou.mtr.manager@` on the POS Returns screen: found the card sale by invoice number, picked one line,
refunded **to the original card** → credit note `ACC-SINV-2026-03131` against `ACC-SINV-2026-03127`,
`$-14.06`, simulated Stripe refund `re_sim_…`, "Approved by hou.mtr.manager@cloudchaserz.example".
The **return receipt printed** on `Counter 1 · V660p` (`window.__awanzLastReaderPrint` holds the 384-px
PNG bitmap) and **points reversed**: Carlos Mendoza 383 → 370, never negative
(`fa-pos-return.png`, `fa-pos-return-receipt.png`).

### 5. Warehouse replenishment loop — **PASS** (19/19, main script)

`ok.sap.manager@` requested `ELQ-013 ×6` from the POS **Receive** screen → `MRR-2026-00068`
(Pending Approval, draft Material Transfer HOU-WH → OK-SAP) → `warehouse@` approved on `/warehouse`
with the quantity edited to **4** → `MSH-2026-00069`. The 1920×1080 **wall** showed the card over the
live transport and auto-printed the packing list (`window.__awanzLastWallPrint {kind: packing_list}`),
transport `POLLING → LIVE`. Eight simulated rates cheapest-first with the cheapest pre-selected, label
bought (`9400364280270779195508`), shipped (HQ −4, In Transit +4), and the store manager **received it
by scanning the EAN four times** — final balances HQ ↓4, In Transit 0, OK-SAP ↑4.
Screenshots `12`–`19`, `16-warehouse-wall-1920.png`.

### 6. Command dashboard `/awanz-dashboard` as `hq@` — **PASS** (9/9: 6 in the main script, 3 in `fa-shop.mjs`)

* **11 store cards, no warehouse row** — `HOU-MTR, OK-SAP, OK-BIX, OK-BA, OK-ETUL, OK-JENKS, OK-MINGO,
  OK-MUS, OK-OWA, OK-STUL, OK-YALE`; `HOU-WH` no longer appears (the v0.7 fix for the old D4 holds).
* Branding: wordmark `CLOUDCHASERZ` from `window.awanz_brand`, scope line `Today · All Stores`, tabs
  `Live · Stores · Products · Clients · Insights · Reports` — no "Boutique" anywhere.
* **A live sale moved the right card** 819 ms after the POS response (ticker + card + tickets).
* **Products → Trending** 60 rows from the precomputed table in 143 ms with real CloudChaserz SKUs;
  **Top by store** 11 columns / 121 matrix cells.
* **Hourly chart (v0.8 D-1) — fixed.** The chart names the real peak of the day: rendered
  `PEAK 10:00 · 1,419` against the API's own peak `10:00 $1419.28`, and the drawn window is
  `06:00 … 13:00` — i.e. *derived from the hours that traded (9, 10) plus the current hour, padded to
  eight columns*, exactly what `dashboard/src/lib/hourly.ts` computes, and **not** the old hard-coded
  `09:00–21:00`. (Supporting evidence that the old window really did hide money on this data set:
  `live_summary(date=2026-08-21)` has `$155.46` in the **23:00** bucket, which the old chart could not
  draw and could not have named as a peak.)
  Screenshots `fa-dashboard-live.png`, `20`–`23`.

### 7. Shop + rewards — **PASS** (18/18: 7 storefront/collect checks in `fa-shop.mjs`, 8 rewards checks and 3 storefront-brand checks in the main script)

* **Guest registration + click & collect (v0.8 A1 — completely broken before).** A guest opening the
  bag is sent to the storefront's own `/shop/register?redirect-to=/shop/cart` (not a framework dead
  end), created an account with their own password, was **signed straight in** as a Website User, put
  `HKA-012` in the bag, checked out **Click & Collect at HOU-MTR** and paid online through the
  simulated gateway → `SAL-ORD-2026-00007`, `$14.06` grand total, `$14.06` advance paid
  (`fa-shop-register.png`, `fa-shop-checkout.png`, `fa-shop-order-placed.png`).
* **POS web-order queue** — the order appeared as `Final Acceptance F5S52 · NEW · SAL-ORD-2026-00007 ·
  1 piece · 0 min ago · Paid online $14.06`; picked → ready → **collected** at the counter with
  `Complete collection · paid online` ($0.00 due) → invoice `ACC-SINV-2026-03133`, order
  `Collected / Completed / 100 % billed` (`fa-pos-web-orders.png`,
  `fa-pos-web-order-collected.png`).
* **`/rewards` copy is exact** — "Earn 1 point for every $1 you spend", "$5 off at 100 points",
  "$10 off at 200 points", "$15 off at 300 points", plus all four member perks, the live giveaway and
  the join form (`25-rewards-1440.png`).
* **$5 / 100-point redemption at the POS** (main script) — the tier picker offered only the affordable
  tier, the basket went `$56.25 → $51.25`, the invoice carries `loyalty_amount = 5`,
  `loyalty_points = 100`, `maison_reward_tier = RT-100-00001`, the balance dropped by 100 and the
  return put it back without ever going negative (`10-pos-reward-picker.png`,
  `11-pos-reward-applied.png`).

### 8. Salon — **PASS** (4/4 + the unpair/clean-basket check, main script)

Paired from the six-digit code shown under Settings → Client display, mirrored the walk-in basket on
the identify screen ("Meanwhile, your associate has set aside CocoUrth Coconut Coals…"), then matched
the till exactly: **salon $28.12 = POS $28.12**, focus piece and lines identical; unpaired at the end.
The Salon clock renders **site time** (11:01 CDT while the harness browser was 16:01 UTC) — the old
"browser-local clock" observation is fixed there (`26`–`29-salon-*.png`).

### 9. Branding audit — **PASS** (3/3, plus the `/app` probe below)

Fifteen routes rendered and their **visible text** grepped for `Maison`, `Frappe`, `ERPNext`:

| Route | Status | Title | Hits |
|---|---|---|---|
| `/` · `/shop` | 200 | CloudChaserz — Elevate Your Smoking Experience | 0 |
| `/login` | 200 | CloudChaserz - Login | 0 |
| `/start` | 200 | AWANZ POS by CloudChaserz | 0 |
| `/shop/collection` · `/shop/register` · `/shop/boutiques` | 200 | … — CloudChaserz | 0 |
| `/rewards` | 200 | CloudChaserz Rewards — CloudChaserz | 0 |
| `/salon` | 200 | CloudChaserz Salon | 0 |
| `/r/<token>` | 200 | CloudChaserz · ACC-SINV-… | 0 |
| `/pos` | 200 | AWANZ POS by CloudChaserz | 0 |
| `/awanz-dashboard` | 200 | CLOUDCHASERZ · Command | 0 |
| `/warehouse` · `/warehouse-wall` | 200 | CloudChaserz - Warehouse / Wall | 0 |
| `/no-such-page-at-all` | 404 | CloudChaserz - Page not found | 0 |
| `/app` (as associate **and** as head office) | 200 | Home | 0 |

**Zero** occurrences of "Maison", "Frappe" or "ERPNext" in rendered text on any of them — including the
admin desk, which the `/start` footer links to. `/maison-dashboard` still 301s to `/awanz-dashboard`.
**"Powered by Futonix"** renders on `/start`, `/`, `/shop`, `/shop/collection`, `/shop/register`,
`/shop/boutiques`, `/rewards`, the public receipt and the 404 page, and
`Website Settings.footer_powered` holds
`AWANZ POS by CloudChaserz · Powered by Futonix` (what `/login` and every standard web page print).

### 10. Security spot-checks — **PASS** (11/11: 5 in `fa-launch.mjs` + the main script's 6 store-scoping checks)

As `hou.mtr.manager@` (HOU-MTR) over plain HTTP:

* `frappe.client.get_list("Sales Invoice", maison_boutique != "HOU-MTR")` → **200 with 0 rows** (the
  v0.7 credit-note leak is closed), while their own store's invoices still list.
* `frappe.client.set_value("AWANZ Associate", <own row>, "role", "HeadOffice")` → **403
  PermissionError**; the record still says `Manager` and the user's Frappe roles are unchanged
  (`AWANZ Manager` only).
* `pin_hash` is unreadable: `get_list(fields=[… "pin_hash"])` returns rows **without the field**,
  `get_value(fieldname=["pin_hash"])` returns only `name`, and the `like`-filter oracle
  (`[["pin_hash","like","%a%"]]`) returns **0 rows**.
* The `AWANZ Associate` list a manager can read is scoped to their own store (3 rows, all HOU-MTR);
  `/api/resource/AWANZ Associate/<another store's row>` → **403**.
* Every `maison_pos.api.*` endpoint refuses another store (6/6 → 403), the mirror holds for the
  OK-SAP manager, and `dashboard.live_summary` narrows to the caller's own store.

---

## Defects

Nothing blocking. Three genuine product defects, all low severity, plus cosmetic observations.

### P1 — `/shop` home page category tiles are wrong (low, but the first thing a shopper sees)

The storefront home lists a **phantom "Products — 0 products"** category (the ERPNext default
`Item Group "Products"` carries `show_in_website = 1`), and the per-category counts are computed from
the first page of the catalogue only, so they badly understate the real catalogue:

| Category | Home page says | Published website items |
|---|---|---|
| Kratom | 1 products | **10** |
| Pods & Coils | 1 products | **13** |
| Devices & Mods | 3 products | **17** |
| Accessories | 11 products | **17** |
| Products | 0 products | **0** (should not be listed at all) |

Cause: `maison_pos/www/shop/index.py` builds `group_cards` by bucketing `catalogue(limit=60)` — 60 of
155 items — instead of counting per group, and `api/webshop.catalogue` lists every
`Item Group` with `show_in_website = 1`. Fix: count per group server-side and exclude groups with no
published items (or clear `show_in_website` on the default "Products" group in the seed).
Evidence: `24-shop-1440.png`, and the rendered tile strip
`Accessories|11 products … Kratom|1 products … Products|0 products`.

### P2 — the hourly chart's "current hour" is the viewer's browser hour, not the store's (low)

`dashboard/src/components/live/LiveView.vue:21` computes `new Date(d.now).getHours()` where
`d.now = Date.now()`, so the right-hand edge of the window and the highlighted "current" column follow
the *viewer's* timezone while the clock printed beside them is the **site's**
(`dashboard/src/lib/time.ts`, v0.6 R). On the same board and the same data: a browser in
America/Chicago drew `06:00 … 13:00`, one in UTC drew `08:00 … 15:00` — the UTC viewer sees five empty
"future" columns and the wrong bar highlighted, next to a header reading `10:57 CDT`.
Same pattern in `boutiques/BoutiquePage.vue:40` and `live/BoutiqueDrillIn.vue:46`. It does not affect
the peak label (computed over the whole series). Fix: derive the hour in the site zone, as every other
clock on the page already does.

### P3 — `/start` offers "Admin desk" to every signed-in user (low)

The role-gated card grid correctly hides `/app` from an associate and a store manager, but the footer
link row in `maison_pos/www/start.html` is rendered unconditionally, so the same page that withholds
the card offers the link two rows below it (`fa-start.png`: *Online store · Rewards · Admin desk*).
Not a branding leak — the desk renders zero framework strings for an associate (area 9) — but the two
halves of the launcher disagree about who may open the desk. Fix: gate the footer row on the same
roles.

### Cosmetic observations (not failures)

1. **Receipt prints the same promotion twice** — `SUBTOTAL 50.97 / DISCOUNT −3.75 / INCL. PROMOTIONS
   −3.75 / TAX 8.25% 3.90`. Arithmetically right (the second line is the "of which promotions"
   breakdown) but it reads as a double deduction when the only discount *is* the promotion
   (`fa-receipt.png`).
2. **Jewellery vocabulary survives on the Salon** — "ASK ABOUT THIS PIECE", "YOUR SELECTION",
   "show my pieces" on a smoke-shop tenant (`29-salon-basket-mirror-1024.png`). The brand system
   carries `store_noun` but no item noun. Pre-existing, unchanged since v0.6.
3. **The demo day starts empty.** The seeded history ends 2026-08-22, so with the acceptance run's
   test sales cancelled (below) the Live board shows one store trading and ten at `$0 · NO SALE YET ·
   OFFLINE`. Ringing one sale fixes the board instantly; a partial day of seeded "today" sales would
   make a cold demo open better. Pre-existing seed limitation, unchanged.
4. The POS still shows a **`SERVICES` department** (gift cards, coil install, hookah setup) — that is
   seeded on purpose, unlike the `Products` group in P1.

---

## Harness changes (staleness, not product bugs)

Four assertions in `e2e/cloudchaserz.cloud.e2e.mjs` still expected pre-rename / pre-polish behaviour.
All four were updated; the file is the only tracked file this run modified.

| # | Was | Now | Why |
|---|---|---|---|
| 1 | unlock store option must match `/CloudChaserz Montrose/` | `/Montrose/` | the v0.7 "distinct store names" polish prints `Montrose — Houston, TX 77098` in the picker |
| 2 | `window.maison_brand` | `window.awanz_brand` | renamed by v0.9 (`www/awanz-dashboard.html`, `dashboard/src/stores/brand.ts`) |
| 3 | live store card must contain `CloudChaserz Montrose` | `Montrose` | `BoutiqueCard.vue` renders `storeShortName(row.name, brand.name)`; the full name is the `title` attribute |
| 4 | unconditional note "the Salon clock is browser-local", comparing against an arbitrary `AWANZ Age Check.ts` row | compares the Salon clock with `live_summary.generated_at` and **records a pass** when it matches | the clock is fixed (site time); the old note compared against a stale row and always fired |

The 72/72 tally above comes from the run made after changes 1–3; change 4 turns the (stale) note into
a check, which the captured evidence passes — the Salon showed `11:01` against a site clock of
`11:01 CDT` and a browser clock of `16:01 UTC` (`29-salon-basket-mirror-1024.png`).

New test files, all under `e2e/qa/` (no application source touched): `fa-pos.mjs`, `fa-launch.mjs`,
`fa-shop.mjs`, `fa-cleanup.py`, and `fa-bridge.mjs` — a copy of the sandbox transport bridge that
converts a **document** 3xx into a one-line HTML hop, because Chromium follows a redirect fulfilled
through `route.fulfill` on a connection the bridge cannot intercept (the egress proxy then resets it),
which made `/shop/cart → /shop/register` unreachable. Sandbox plumbing only.

Two environment notes: the service-worker registration warning that appears without
`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` is a bridge artefact — the worker endpoint itself
returns `200 application/javascript` with `Service-Worker-Allowed: /pos/`, and with the flag set the
run is console-clean. The site timezone is now `America/Chicago` (it was unset at v0.6): every server
stamp, the dashboard clock, the wall and the Salon agree.

---

## Screenshots

`e2e/qa/shots-final/` — 49 PNGs, all reviewed.

Required set: **POS sell** `fa-pos-sell.png` · **receipt** `fa-receipt.png` (+ `fa-receipt-split.png`,
`03-pos-receipt-qr.png`, `04-public-receipt-390.png`) · **dashboard Live** `fa-dashboard-live.png`
(+ `20`/`21-dashboard-live-*1920.png`) · **warehouse wall** `16-warehouse-wall-1920.png`
(+ `17-…-shipped-1920.png`) · **/shop** `24-shop-1440.png` (+ `fa-shop-register.png`,
`fa-shop-checkout.png`, `fa-shop-order-placed.png`) · **/rewards** `25-rewards-1440.png` ·
**/start** `fa-start.png` · **/salon** `26-salon-pair-1024.png`, `27-salon-ambient-1024.png`,
`28-salon-identify-1024.png`, `29-salon-basket-mirror-1024.png`.

Also: `fa-pos-age-gate.png`, `fa-pos-card-ready.png`, `fa-pos-split-tender.png`,
`fa-pos-multiline-discount.png`, `fa-pos-offline-queued.png`, `fa-pos-offline-drained.png`,
`fa-pos-return.png`, `fa-pos-return-receipt.png`, `fa-pos-web-orders.png`,
`fa-pos-web-order-collected.png`, `fa-desk-associate.png`, `fa-desk-head-office.png`, and the main
script's `01`–`23`.

Visual review found no rendering defects: the unlock screen fits 1366×1024 with the long wordmark,
the iPhone 390×844 POS has 0 px horizontal overflow, every surface carries the CloudChaserz wordmark
with the `AWANZ` sub-mark, and the typography (Unbounded / Jost) is intact on all of them. The two
layout items worth a second look are cosmetic and listed above (P1 tile counts, receipt discount
lines).

---

## Site state left behind — clean and demo-ready

Everything this acceptance run created was cancelled or disabled (`qa/fa-cleanup.py`,
`qa/cleanup-final.json`):

* **41 Sales Invoices cancelled** (`ACC-SINV-2026-03099` … `-03139`), credit notes first, including the
  four returns; **2 Sales Orders** (`SAL-ORD-2026-00006/00007`) cancelled together with their
  **2 Payment Entries** and **2 Payment Requests**.
* **Stock restored to the seeded levels.** The harness tops the shelf up so repeated runs do not
  exhaust it; those receipts were reversed with Material Issues `MAT-STE-2026-00085/00086`:
  `HKA-012 23`, `ACC-009 21`, `HKA-017 23`, `ACC-011 23`, `DSP-002 42` at HOU-MTR, `DEV-015 30`,
  `ELQ-013 60` at HOU-WH — exactly the quantities the run found. OK-SAP keeps the `+4 / +4` the two
  completed replenishments legitimately shipped.
* **Test identities disabled**: customers `CC Rewards DUQB1`, `CC Rewards F7CUS`,
  `Final Acceptance F0IF5`, `Final Acceptance F5S52`; storefront users `fa.shopper.f0if5@…`,
  `fa.shopper.f5s52@…`. They no longer appear in the POS client list or the shop.
* **14 giveaway entries** and **2 client-interaction notes** created by the cancelled sales were
  deleted; Carlos Mendoza's loyalty ledger is back to its pre-run two entries (24 points), i.e. every
  point earned today was reversed.
* **Verified empty**: 0 open shipments, 0 pending replenishment requests, 0 paired Salon sessions,
  no basket left on any till, warehouse desk and wall idle, `pending_approvals = 0`.
* **Left in place by design**: the two completed replenishment cycles (`MRR-2026-00066/00068` →
  `MSH-2026-00067/00069`, both **Received**, nothing in transit) as ordinary chain history, and the
  22 `AWANZ Age Check` audit rows from today (compliance records carrying only initials, issuer and
  age — deleting them would destroy an audit trail, and they surface on no demo screen).
* **Not touched**: the 11 stores, users, PINs, the 160-item catalogue, the 3,002 seeded history
  invoices, precomputed insights, brand settings and the site timezone.

Post-cleanup smoke check: `/`, `/start`, `/shop`, `/rewards`, `/salon`, `/pos`, `/awanz-dashboard`,
`/warehouse`, `/warehouse-wall` all **200**; `catalog.bootstrap` as an associate returns 160 items and
the CloudChaserz brand.
