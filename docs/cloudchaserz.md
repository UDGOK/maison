# CloudChaserz (v0.6 N/O)

CloudChaserz is a smoke-shop chain — vape, disposables, e-liquid, glass, hookah, kratom, CBD and
accessories — with head office and main warehouse in Houston, Texas and eleven stores across
Houston and Oklahoma. This release makes the platform **tenant-branded**: everything a customer or
an associate reads comes from brand settings, while the internal doctype and module names stay
`Maison *` / `maison_pos` (renaming doctypes buys nothing and breaks every integration).

> The product name is **"Maison POS by CloudChaserz"**: CLOUDCHASERZ is the wordmark, "Maison POS"
> the sub-mark under it.

Related: `docs/shipping.md` (warehouse), `docs/rewards.md` (loyalty), `SPEC_v0.6.md`.

---

## 1. Brand settings

**Maison POS Settings** carries the tenant's identity. `catalog.bootstrap` returns it as `brand{…}`
and the POS, Salon, dashboard, web shop, receipts, e-mails and print formats all read from there —
there are no hard-coded "Maison" strings in user-facing copy.

| Field | CloudChaserz value |
|---|---|
| `brand_name` | `CloudChaserz` |
| `product_name` | `Maison POS by CloudChaserz` |
| `tagline` | `Elevate Your Smoking Experience` |
| `wordmark_text` | `CLOUDCHASERZ` |
| `sub_mark` | `Maison POS` |
| `legal_name` | `CloudChaserz World LLC` |
| `support_email` | `support@cloudchaserzworld.com` |
| `brand_website` | `https://cloudchaserzworld.com` |
| `brand_logo` | Attach (optional; the wordmark is used when empty) |
| `vertical` | `Smoke Shop` — drives which product attributes show |
| `head_office_boutique` | `HOU-MTR` |
| `main_warehouse` | `HOU-WH - CCZ` |

`vertical` also decides the noun: **Smoke Shop** and **General** say "Store", **Jewellery** says
"Boutique". The jewellery world is still a first-class profile (`vertical="Jewellery"`), which is
what the regression suites seed.

### Product attributes by vertical

| Vertical | Item fields shown |
|---|---|
| Smoke Shop | `maison_brand`, `maison_flavor`, `maison_nicotine_mg`, `maison_volume_ml`, `maison_puffs`, `maison_age_restricted`, `maison_msrp` |
| Jewellery | `maison_metal`, `maison_carat`, `maison_stones`, `maison_certificate_no`, `maison_appraisal_value` |
| General | `maison_brand`, `maison_msrp`, `maison_age_restricted` |

Item Groups seeded for the vertical: Disposables, E-Liquid, Devices & Mods, Pods & Coils,
Glass & Rigs, Hookah & Shisha, Kratom, CBD & Hemp, Rolling & Papers, Accessories, Services.
Roughly 120 items with MSRP/cost, EAN-13 barcodes and generated SVG artwork. These are quantity
items, not serialized — serial support remains available for high-value glass if wanted.

---

## 2. The stores

Eleven stores plus the head-office warehouse. All are `America/Chicago`.

| Code | Store | Address | Phone | Region | Hours | Tax |
|---|---|---|---|---|---|---|
| `HOU-MTR` | CloudChaserz Montrose *(HQ store)* | 2037 W Alabama St, Houston TX 77098 | (281) 974-3712 | Houston | 9–24 | TX 8.25% |
| `OK-SAP` | CloudChaserz Sapulpa | 515 N Mission St, Sapulpa OK 74066 | (918) 347-8062 | Oklahoma | 9–22 | 9.5% |
| `OK-BA` | CloudChaserz Broken Arrow | 6420 S Elm Pl, Broken Arrow OK 74011 | (539) 367-1226 | Tulsa Metro | 9–22 | 8.417% |
| `OK-BIX` | CloudChaserz Bixby | 11063-B S Memorial Dr, Tulsa OK 74133 | (918) 364-8300 | Tulsa Metro | Sun–Thu 9–22, Fri–Sat 9–24 | 8.917% |
| `OK-STUL` | CloudChaserz South Tulsa | 2606 S Sheridan Rd Suite H, Tulsa OK 74129 | (918) 764-8161 | Tulsa Metro | 9–22 | 8.517% |
| `OK-OWA` | CloudChaserz Owasso | 8351 N Owasso Expy, Owasso OK 74055 | (918) 554-5217 | Tulsa Metro | 9–22 | 8.917% |
| `OK-MUS` | CloudChaserz Muskogee | 102 S 24th St W, Muskogee OK 74401 | (918) 685-0433 | Oklahoma | 8–02 | 9.15% |
| `OK-MINGO` | CloudChaserz Mingo | 8033 S Mingo Rd, Tulsa OK 74133 | (539) 367-3892 | Tulsa Metro | 8–24 | 8.517% |
| `OK-ETUL` | CloudChaserz East Tulsa | 1660 E 71st St STE E, Tulsa OK 74136 | (918) 574-2521 | Tulsa Metro | 9–22 | 8.517% |
| `OK-YALE` | CloudChaserz Yale | 3205 S Yale Ave Suite C, Tulsa OK 74135 | (918) 393-8201 | Tulsa Metro | 9–22 | 8.517% |
| `OK-JENKS` | CloudChaserz Jenks | 541 W Main St, Jenks OK 74037 | (918) 228-7009 | Tulsa Metro | Sun–Thu 9–22, Fri–Sat 9–24 | 8.917% |
| `HOU-WH` | **Main Warehouse / HQ** *(not a store)* | Houston TX | — | Houston | — | — |

`HOU-WH` is a `Maison Boutique` with `is_warehouse = 1`: it owns a warehouse and appears in the
supply flows, but it is excluded from store lists, sales league tables and the storefront.

Each `Maison Boutique` also carries `hours` (JSON), `timezone` and `region`.

> ### ⚠️ Tax rates — verify with the CPA
> The rates above are **approximate combined state + local sales-tax rates** entered so the demo
> totals look right. Before going live, have the CPA confirm the exact combined rate for each
> store's taxing jurisdiction (they change, and city/county/special-district components differ by
> address, not by city name).
>
> **Not modelled at all:** Oklahoma and Texas **vapor and tobacco excise taxes**, which are levied
> separately from sales tax and may apply at wholesale or retail depending on the product class
> (nicotine e-liquid, closed-system pods, cigars, smokeless). Kratom and hemp-derived products have
> their own state treatment. Model these with the CPA before the first live sale.

---

## 3. Roles and store scoping

| Role | Sees | Can do |
|---|---|---|
| **Maison Associate** | own store | sell, returns within policy, cycle count, clock in/out |
| **Maison Manager** | **own store only** | everything an associate can, plus approve discounts / out-of-policy returns, request replenishment, confirm receipts, view their store's reports and staff |
| **Maison Warehouse Admin** | all stores' supply documents, `HOU-WH` stock | approve / edit / reject replenishment requests, pick, pack, buy labels, ship, resolve discrepancies, receive vendor POs at HQ. **Cannot sell.** |
| **Maison Regional** | the stores in their region | read-only across their region plus manager actions where granted |
| **Maison Head Office** | everything | full chain view, Command dashboard, price approvals, campaigns |

Store scoping for managers and associates is enforced in **three** places, and all three matter:

1. **User Permission** on the store's Warehouse plus `Maison Associate.boutique`.
2. **Server-side in every endpoint** — `maison_pos/scoping.py` (`assert_boutique_access`,
   `get_allowed_boutiques`); an endpoint that takes a `boutique` argument raises
   `frappe.PermissionError` (HTTP 403) for anyone else's store.
3. **Desk list views** — `permission_query_conditions` / `has_permission` hooks, so a manager
   opening Stock Entry, Purchase Receipt, Material Request, Sales Invoice, Employee or
   `Maison Shipment` in the Frappe desk sees only their own store's rows.

`maison_pos/tests/test_v0_6_scoping_http.py` and `e2e/cloudchaserz.e2e.mjs` both prove this over
real HTTP, not just in-process: manager A gets 403 on store B's bootstrap, inbound shipments,
replenishment requests and shipments, and the live dashboard shows them only their own store.

### Scoping matrix

| Document | Associate | Manager | Warehouse Admin | Regional | Head Office |
|---|---|---|---|---|---|
| Sales Invoice | own store | own store | — | region | all |
| Stock Entry / Purchase Receipt | own store | own store | HQ + all transfers | region | all |
| Material Request / Replenishment Request | create (own) | create + view (own) | **approve / reject (all)** | region | all |
| Maison Shipment | own store (inbound) | own store (inbound) | **all** | region | all |
| Receiving Discrepancy | — | own store | **all** | region | all |
| Maison Associate / Employee / Shift | self | own store | — | region | all |
| Reports | — | own store | supply only | region | all |

---

## 4. Demo users

Password for every demo account: **`cloud123`**. PINs unlock the POS after login.

| User | Role | PIN |
|---|---|---|
| `<code>.manager@cloudchaserz.example` | Maison Manager | unique per store (see below) |
| `<code>.a1@cloudchaserz.example` | Maison Associate | `2580` |
| `<code>.a2@cloudchaserz.example` | Maison Associate | `1357` |
| `hq@cloudchaserz.example` | Maison Head Office | — |
| `warehouse@cloudchaserz.example` | Maison Warehouse Admin | — |
| `regional.ok@cloudchaserz.example` | Maison Regional (Oklahoma + Tulsa Metro) | — |
| `regional.tx@cloudchaserz.example` | Maison Regional (Houston) | — |

Manager PINs: `HOU-MTR` 1101 · `OK-SAP` 2202 · `OK-BA` 3303 · `OK-BIX` 4404 · `OK-STUL` 5505 ·
`OK-OWA` 6606 · `OK-MUS` 7707 · `OK-MINGO` 8808 · `OK-ETUL` 9909 · `OK-YALE` 1212 ·
`OK-JENKS` 1313.

`<code>` is the store code lower-cased with the dash replaced by a dot — `OK-SAP` →
`ok.sap.manager@cloudchaserz.example`.

---

## 5. Age verification (21+)

Every item in a 21+ group carries `maison_age_restricted = 1`. Ringing one up raises the age gate
before it reaches the basket; nothing is sold until it passes.

Two paths, both ending in a `Maison Age Check`:

* **Scan** — the PDF417 barcode on the back of a US driver's licence or state ID. The AAMVA payload
  is parsed **on the device** (`frontend/src/scan/aamva.ts`) for date of birth, expiry, initials and
  issuing jurisdiction.
* **Manual** — the associate reads the date of birth (and optionally the expiry) off the ID.

Outcomes: **Verified** · **Underage** (under `minimum_age`, default 21) · **Expired** ·
**Unreadable** · **Declined**. The Salon client display shows "Please present your ID" while the
gate is open, and the receipt prints `ID CHECKED · 21+ VERIFIED`.

### What is stored — and what is not

`Maison Age Check` keeps only the **outcome**: verified yes/no, the reason, the method
(Scan / Manual), the two initials, the issuing state, the store, who checked and when. The
barcode payload, the full name, the licence number, the address and the exact date of birth are
**never written to the database**. The screen says so, in those words, under the scan box.

Settings: `age_verification_required` (default on), `minimum_age` (21), `id_scan_enabled`.

> ### ⚠️ Compliance — verify with counsel
> The notes below are a starting point for a conversation with the company's attorney, **not legal
> advice**, and nothing here has been reviewed by counsel.
>
> * **Federal minimum age is 21** for tobacco and nicotine products (Tobacco 21, 2019). The app
>   defaults to 21 and refuses anything younger regardless of state law.
> * **PACT Act.** The Act's registration, reporting, delivery-sale and shipping rules apply to
>   *consumer* deliveries of ENDS products. **Warehouse → store transfers are B2B** and are not
>   consumer delivery sales, but the PACT Act's registration and state reporting obligations may
>   still attach to the business. Confirm registration, monthly state reports, and carrier
>   eligibility with counsel before shipping anything to a consumer.
> * **The web shop does not sell age-restricted items by default.** `webshop_age_restricted_sales`
>   is **off**; restricted products show "Available in store". Turning it on requires an
>   age-verification and adult-signature delivery process that this release does not implement —
>   do not enable it without counsel and a compliant carrier programme.
> * **Texas** and **Oklahoma** each license retail tobacco/vapor sellers and have their own
>   signage, ID-check and product-registry rules. Kratom is regulated separately again (some
>   Oklahoma municipalities restrict it), and hemp-derived cannabinoid rules change frequently.
> * **Biometrics.** If face recognition is enabled at a store, the v0.3 consent and retention
>   regime applies — see `docs/biometrics-policy.md`.
> * **Record retention.** The age-check log is deliberately minimal. Confirm with counsel how long
>   it must be kept and whether any additional record is required at point of sale.

---

## 6. Seeding a CloudChaserz site

One documented path:

```bash
bench new-site cc.localhost --admin-password admin --db-root-password admin
for a in erpnext payments webshop hrms crm maison_pos; do bench --site cc.localhost install-app $a; done

bench --site cc.localhost execute maison_pos.setup.cloudchaserz.seed
bench --site cc.localhost execute maison_pos.setup.cloudchaserz.seed_history --kwargs '{"months":3}'
bench --site cc.localhost execute maison_pos.insights.jobs.compute_weekly
bench build --app maison_pos
```

`seed` is idempotent and creates: the CloudChaserz company (abbr `CCZ`), the brand settings above,
the 11 stores + `HOU-WH` with their POS Profiles, warehouses, cost centres and tax templates, the
~120-item catalogue with EAN-13 barcodes and generated art, opening stock and reorder levels, the
demo users and PINs, the CloudChaserz Rewards programme (tiers, birthday coupon, promotion
calendar, giveaway, events campaign) and the web shop.

On a managed host without shell access, the same thing over the API as a System Manager:

```
POST /api/method/maison_pos.setup.cloudchaserz.seed_remote
POST /api/method/maison_pos.setup.cloudchaserz.seed_history_remote   {"months": 3}
GET  /api/method/maison_pos.setup.cloudchaserz.status
POST /api/method/maison_pos.api.insights.compute                     {"narrative": 1}
```

`seed_history_remote` enqueues on the `long` queue; poll `status` for the marker.

Then: `/pos` · `/warehouse` · `/warehouse-wall` · `/maison-dashboard` · `/shop` · `/rewards` ·
`/salon`.
