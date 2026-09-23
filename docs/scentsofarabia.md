# Scents of Arabia (v1.3) — the Perfume vertical

Scents of Arabia is a fragrance retailer: designer houses (Coach, Jimmy Choo, Versace, D&G,
Viktor & Rolf …), Arabian oud and attar houses (Swiss Arabian, Lattafa, Armaf, Arabiyat Prestige),
gift sets, body sprays and counter displays of roll-on perfume oils. Head office and the main
warehouse are in Houston — **Markhor Wholesale**, 5700 Hartsdale Dr Suite C, the entity the vendor
invoices — and the stores are in the Tulsa metro: **Owasso** (8351 N Owasso Expy) and **East Tulsa**
(1660 E 71st St). Same shape as CloudChaserz, on its own Frappe Cloud bench and site.

This release adds the **Perfume** vertical to the platform and a seed that builds the tenant from
the client's real paperwork. Related: `docs/cloudchaserz.md` (the tenant model this follows),
`docs/purchasing.md` (the rails the invoices ride on), `docs/pricing.md` (the price board).

---

## 1. The vertical

`AWANZ POS Settings.vertical` gains **Perfume** (`install_v06.VERTICALS`). It decides:

| Surface | Perfume |
|---|---|
| Product attributes (`brand.item_attribute_fields`) | `maison_brand`, `maison_concentration`, `maison_size`, `maison_gender`, `maison_fragrance_origin`, `maison_fragrance_family`, `maison_notes`, `maison_tester`, `maison_msrp` |
| POS tile meta line | *EDP · 3.4 oz · Women · Tester* (was the jewellery *metal / carat*) |
| POS search | also matches concentration, fragrance family and notes |
| Store noun | "Store" |
| Receipt footer | *Exchanges within 14 days with receipt on sealed, unopened items. Opened fragrances, oils and testers are final sale.* |
| Web shop copy | hero, "how it works", footer and the product assurance block have a perfume branch — no "21+", no vape |
| `/rewards` | the age-restricted-products paragraph is dropped; the consent line reads the tenant's `minimum_age` (18) |
| Age gate | off (`age_verification_required = 0`, `id_scan_enabled = 0`); nothing in the catalogue is age-restricted |

New custom fields on **Item** (section *Fragrance*, `install_v06.CUSTOM_FIELDS`):

| Field | Type | Meaning |
|---|---|---|
| `maison_concentration` | Select | EDP · EDT · Parfum · Extrait de Parfum · Cologne · Perfume Oil · Body Spray · Body Mist · Gift Set · Other |
| `maison_size` | Data | as sold — *3.4 oz*, *1.0 oz + 3.3 oz* for a set |
| `maison_gender` | Select | Men · Women · Unisex |
| `maison_fragrance_origin` | Select | **Designer · Arabian** · Niche · House — the markup rule reads this |
| `maison_fragrance_family` | Data | Oud, Floral, Woody, Fresh, Oriental, Gourmand … |
| `maison_notes` | Small Text | top / heart / base |
| `maison_tester` | Check | a tester bottle (no retail box) — printed on the tile |

`catalog.bootstrap` ships the new fields to the POS; `api.catalog._item_fields()` drops any
`maison_*` column the site has not migrated yet, so a bench on "Update Site *Pull*" still boots.
`Item.maison_department` gains *Fragrance · Oud & Oils · Gift Sets · Body Sprays · Fixtures*.
Purchase Order and Purchase Receipt gain `maison_vendor_invoice_no` (the paper's number, and the
seed's idempotency key).

Nothing changes for the Smoke Shop or Jewellery tenants: the Select gains a member, Item gains a
collapsed section, the POS bundle carries one more branch in the tile meta.

---

## 2. The seed — `maison_pos.setup.scentsofarabia`

```bash
bench --site <site> execute maison_pos.setup.scentsofarabia.seed
# managed host (Frappe Cloud), as a System Manager:
POST /api/method/maison_pos.setup.scentsofarabia.seed_remote          {"push": 1}
GET  /api/method/maison_pos.setup.scentsofarabia.status               {"consume": 1}
```

**Not a demo.** No invented customers, no back-dated sales, no giveaway. Every step is idempotent.
`seed_remote` runs in the background; `status()` returns `seed_summary` once it has finished — the
run's summary (with the one-time initial password of any login it created) or its traceback —
kept in the site's global defaults until `consume=1` reads it.

| Step | What |
|---|---|
| `stores.ensure_erpnext_setup` | headless setup wizard — company **Scents of Arabia** (`SOA`), USD, America/Chicago |
| `demo.ensure_company / accounts / modes_of_payment / price_list` | the CloudChaserz helpers under `profile_globals()` |
| `catalog.ensure_item_groups` | Designer Fragrances · Arabian & Oud · Gift Sets · Body Sprays & Mists · Perfume Oils · Displays & Fixtures · Accessories · Services |
| `rewards.ensure_loyalty_program / ensure_tiers` | **Scents of Arabia Rewards** — $1 = 1 point, $5/100 · $10/200 · $15/300 |
| `stores.ensure_stores` | `OK-OWA`, `OK-ETUL` (Store) and `HOU-WH` (Warehouse) — Warehouse + Cost Center + POS Profile + tax template + `AWANZ Store` each, then the `<store> In Transit` warehouses (they must exist before the first stock entry — ERPNext caches its warehouse → account map per job) |
| `stores.ensure_brand_settings` | every brand key written (never inherited from the CloudChaserz defaults), vertical **Perfume**, HQ store `OK-OWA`, main warehouse `HOU-WH - SOA`, the logo, age gate off, chain markup 30 % (once), then `apply_whitelabel()` |
| `catalog.ensure_items` | 63 items — the manufacturer's UPC / EAN on `maison_barcode` + an `Item Barcode` row, invoice cost as `valuation_rate`, retail on *Standard Selling* per the rule, wholesale overrides on the Arabian lines |
| `catalog.ensure_images` | generated SVG art (`art.py`): flacon / gift box / spray / oil vials / display, a gold crescent on every Arabian piece |
| `users.ensure_users` | placeholder seats — see §5 |
| `catalog.seed_webshop` | the sale groups published on `/shop`; sign-up on `/shop/register` |
| `purchasing.seed_purchasing` | the vendor and the three invoices — §3 |
| `distribution.push_to_owasso` | everything at HOU-WH to Owasso — §4 |

### Brand

| Field | Value |
|---|---|
| `brand_name` / `wordmark_text` | Scents of Arabia / SCENTS OF ARABIA |
| `sub_mark` | روائح العرب |
| `tagline` | Fine Oud & Perfumes |
| `product_name` | AWANZ POS by Scents of Arabia |
| `brand_logo` | `/files/scents-of-arabia-mark.png` — the gold crescent-and-horse mark, 512 × 512, from `setup/scentsofarabia/assets/` (also uploaded: the full lockup and the wide plaque) |
| `legal_name`, `support_email`, `brand_website` | **open** — "Scents of Arabia", `yasir@futonix.com` and the site's own URL as placeholders until the client confirms them (an empty key would fall back to the CloudChaserz install defaults) |

---

## 3. The vendor and the invoices

**Sunshine Electronics & Perfumes** — 8000 Harwin Dr Suite 540, Houston TX 77036, (281) 888-4234,
reps Maya (832) 716-5624 and Roman (832) 860-5502, our account no. 2628, terms cash or debit.
Created as an ERPNext Supplier with the v1.0 vendor fields, a Billing address and its own buying
price list; every catalogue item carries one preferred `AWANZ Item Vendor` row at the invoice cost.

Each invoice becomes a submitted **Purchase Order** dated as the paper (`maison_vendor_invoice_no`
= the invoice number) and a **Purchase Receipt** at `HOU-WH - SOA` on the same date, every line
at the invoice cost, `final = 1`. Lines are checked against the printed subtotal before anything is
posted (`purchasing.check_totals`).

| Invoice | Date | Total | Lines |
|---|---|---|---|
| 99139 "Order 2" | 2026-08-04 | $3,277.25 | 57 lines: 18 designer bottles, 11 Arabian bottles, 26 gift sets, 2 body sprays |
| 99464 "Order 3" | 2026-08-11 | $3,031.20 | 2,448 oils @ $1.15 (12 × 144-vial + 20 × 36-vial displays) + 12 × 144-vial stands @ $18; the twenty 36-vial stands were free — a zero-value Material Receipt |
| 99595 | 2026-08-14 | $4,039.20 | 3,168 oils @ $1.15 + 22 × 144-vial stands @ $18 |

Total received: **5,910 units, $10,347.65 at cost** (5,616 perfume oils, 34 + 20 display stands,
240 bottles / sets / sprays).

> **Open:** the vendor's running balance shows **~$11,995 bought before invoice 99139** ("Order 1").
> That invoice was not provided. Add it to `purchasing.INVOICES` and re-run the seed; invoices
> already received are skipped.

The oils are one item — `OIL-001 Arabian Perfume Oil — Assorted Roll-On` — because the invoice
names no scents. Split it into named scents on the Stock screen when the client wants to count
them separately. Display stands are stock items that are **not for sale** (`is_sales_item = 0`):
they ship to the store with the oils and never appear on the till.

---

## 4. Pricing and the push to Owasso

The client's rule: *"big brands about 30 %, Arabic oud about 80–100 %"* markup on cost.

* **Retail** (`Standard Selling`, what the till charges): `cost × 1.30` for Designer, `cost × 2.00`
  for Arabian and House lines (`catalog.retail_rate`). Gift cards at face value. Examples: Viktor &
  Rolf Flowerbomb $70 → **$91**; Swiss Arabian Casablanca $49 → **$98**; Armaf Iconic set $40.50 →
  **$81**; a perfume oil $1.15 → **$2.30**. Change any of them on **Stock → item → Prices** (the
  v1.2 approval flow) — a price the client changed is never overwritten by a re-run.
* **Wholesale** (the v1.2 board — what Owasso owes Houston for what it received): the chain markup
  is **30 %** and every Arabian / House line carries an **override at cost × 2**, so the statement
  follows the same two-tier rule. The client described one markup — "Houston buys it, marks it up
  and sends it to Owasso" — so both boards start on the same figures; if the stores are meant to
  keep a margin of their own, lower the wholesale side on `/warehouse → Prices → Wholesale`.

`distribution.push_to_owasso` then sends **every unit at HOU-WH** to `OK-OWA` on the v1.1 rails —
one request, one shipment, approved in the same action, the wholesale value stamped when it ships
— and receives it at the store, so Owasso's shelves show the stock and Houston shows zero. East
Tulsa gets nothing (the client's instruction: "other locations show zero"). The wall, the packing
list and Owasso's Receive screen show the shipment exactly as a real push would; it is idempotent
on the request's reason.

---

## 5. Logins

Placeholder seats until the client names real people (`users.py`); the initial password is
generated per run and printed once by `seed()` — **never stored in the repository**.

| Login | Role | PIN |
|---|---|---|
| `hq@scentsofarabia.example` | AWANZ Head Office | 0000 |
| `warehouse@scentsofarabia.example` | AWANZ Warehouse Admin (HOU-WH) | 0000 |
| `ok.owa.manager@…` / `ok.owa.a1@…` | Manager / Associate, Owasso | 6606 / 2580 |
| `ok.etul.manager@…` / `ok.etul.a1@…` | Manager / Associate, East Tulsa | 9909 / 2580 |

The **owner seat** is created separately and deliberately — `maison_pos.setup.owner.create_owner`
with the real owner's e-mail (`docs/security.md`). Re-credential every placeholder before a real
associate touches a till.

---

## 6. Open questions for the client

1. **Order 1** — the ~$11,995 invoice before 99139.
2. **Legal entity, support e-mail, website** for the brand settings (receipts and e-mails print them).
3. **Store phone numbers** and opening hours (seeded 10–21, Sun 12–18 as a placeholder).
4. **Tax rates** — Owasso 8.917 % and Tulsa 8.517 % copied from the CloudChaserz seed; verify with the CPA.
5. **Wholesale vs retail** — keep both at the same markup, or give the stores a margin of their own?
6. **Oils** — one assorted item, or named scents?
7. **Real staff** — names and e-mails for the six placeholder seats, and the owner's e-mail.

---

## 7. What this release deliberately does not do

No second company for the stores, no intercompany invoicing (v1.2's stance stands). No photography
— the art is generated. No Stripe keys — the POS runs the simulated reader until
`stripe_secret_key` / `stripe_publishable_key` are set on the site. No custom domain. No e-mail
account (digests, feedback alerts and *Forgot password* need one).
