# Maison web shop — Frappe Webshop + Monolith Gold (v0.4 G)

The online boutique runs on the official **Frappe Webshop** app (`webshop`, native to ERPNext v15)
with **Frappe Payments** (`payments`) for online card payment. Maison adds the glue that makes it a
*click & collect* shop for a jewellery chain: web modes per piece, availability per boutique,
orders routed to a boutique's POS queue, loyalty sign-in, and a Monolith Gold theme so the site
looks like the POS.

```
shopper ──► /shop (Maison storefront, gold theme)
              │  add to bag  ── webshop Quotation (cart)
              │  checkout    ── choose boutique + pay online / at counter
              ▼
        Sales Order  maison_web_order=1, maison_boutique=CHI-OAK, maison_web_status=New
              │  (Payment Request → Stripe / simulated → advance Payment Entry on the order)
              ▼
   POS "Web orders" queue of that boutique:  New → Picking → Ready → Collect
              ▼
        Sales Invoice (is_pos, update_stock) — same receipt, QR, points, commission as a counter sale;
        the online payment is allocated as an advance, only the balance is tendered.
```

## Install

```bash
cd frappe-bench
bench get-app payments --branch version-15      # https://github.com/frappe/payments
bench get-app webshop  --branch version-15      # https://github.com/frappe/webshop
bench --site <site> install-app payments
bench --site <site> install-app webshop
bench --site <site> migrate                     # maison_pos after_migrate creates the web fields + perms
bench --site <site> execute maison_pos.setup.demo.seed            # or only the web part:
bench --site <site> execute maison_pos.setup.demo_v04_webshop.seed_webshop --args "[True]"
bench build --app maison_pos
```

Versions verified on the reference bench (2026-08-22): Frappe `15.118.0`, ERPNext `15.119.3`,
`payments` `version-15` @ `9885a6e`, `webshop` `version-15` @ `6c8fd00` (both report `__version__ = 0.0.1`).

**Frappe Cloud**: add `payments` and `webshop` (branch `version-15`) to the release group *before*
`maison_pos`, deploy, then install the apps on the site in that order. Keep `maison_pos` last in the
app list: it overrides webshop's `Website Item` page template and chains on its `Payment Request`
class; with Frappe's "last app wins" rule for `override_doctype_class` the Maison override must be the
one that is loaded. (On the dev bench webshop was installed after maison_pos, so `simulate_payment`
elevates on its own and the chain is only needed for real gateways.)

Known v15 quirk: `install-app payments` may stop at *"Web Form: Options must be a valid DocType for
field Payment Gateway"* on a site that already has ERPNext — run
`bench --site <site> execute payments.utils.make_custom_fields` and carry on.

### Stripe

Put the keys in `site_config.json`:

```json
{ "stripe_secret_key": "sk_test_…", "stripe_publishable_key": "pk_test_…" }
```

and run the seed (or `maison_pos.setup.demo_v04_webshop.ensure_payment_gateway`). It creates the
**Stripe Settings** "Maison" document, the Payment Gateway `Stripe-Maison` and a **Payment Gateway
Account** (default, currency USD, account "Card Clearing"); `Webshop Settings.payment_gateway_account`
points to it. Checkout then redirects to the `payments` app's Stripe Checkout page; its callback
(`Payment Request.on_payment_authorized`) creates the advance Payment Entry against the Sales Order
and sends the shopper back to `/shop/order?name=…`.

Without keys the seed creates the **"Maison Simulated"** gateway: the checkout goes to `/shop/pay`,
a test-card page that marks the Payment Request paid through the same `on_payment_authorized`
path. Nothing else differs, so the POS collection flow is identical in both modes.

## What is native, what is Maison

| Area | Native (webshop / ERPNext / payments) | Maison (`maison_pos/webshop`, `api/webshop.py`, `www/shop`, `templates/webshop`) |
| --- | --- | --- |
| Catalogue | `Website Item` (publish, route, image, description), `Item Group.show_in_website`, `Webshop Settings` (price list, company, checkout on/off, stock display) | `Item.maison_web_mode` (Buy / Enquire / Reserve-with-deposit) + `maison_deposit_percent`; rule: a serialized piece with ≤ 1 unit in the chain is always *Enquire*; availability per boutique from `Bin` per boutique warehouse ("Available at: Miami, New York") |
| Product page | data model, price (`get_product_info_for_website`), slideshow, reviews/wishlist (off) | template `templates/webshop/item.html` through `override_doctype_class["Website Item"]`; Enquire sheet, Reserve sheet, availability box, related pieces |
| Cart | `Quotation` (order type Shopping Cart) via `webshop.shopping_cart.cart.update_cart`, cart count cookie | `/cart` and `/all-products` are re-routed (`website_route_rules`) to the Maison pages; `api.webshop.update_cart` (clean removal of the last line); `Quotation.maison_boutique` |
| Checkout | `_make_sales_order` from the cart, `Payment Request`, Payment Gateway Account | `api.webshop.place_order(boutique, fulfilment, pay_now)`: no shipping address, stock check in the chosen boutique for serialized pieces, boutique tax template, `order_type = Sales` (a *Shopping Cart* order would be auto-invoiced by ERPNext on payment — Maison invoices at collection), Sales Order fields `maison_web_order / maison_boutique / maison_web_status / maison_deposit_amount / maison_prepaid_amount` |
| Reserve | — | `api.webshop.reserve(item_code, boutique)`: Sales Order at full price + Payment Request for the deposit (default 10 %) |
| Enquire | ERPNext `Lead` (best effort) | doctype **Maison Web Enquiry** (boutique, piece, client, message, response) in the POS queue |
| Payment | Stripe Checkout page, `Payment Request.set_as_paid` → Payment Entry | `MaisonPaymentRequest` (elevated rights for the Payment Entry, redirect to the Maison order page, `maison_prepaid_amount` refresh); simulated gateway page |
| Account | `/login`, `/me`, `/orders` (skinned by the global CSS) | `/shop/account` loyalty sign-in by **client number + e-mail** (both must match), tier, points, value, next tier, recent purchases; `/shop/orders`, `/shop/order` with a collection timeline |
| POS | — | "Web orders" screen (`frontend/src/views/WebOrdersView.vue`): queue + enquiries, pick / ready / cancel, **Collect** loads the order into the cart (serials picked from the boutique stock, web prices kept) and goes to Pay with only the balance; `sales.submit_batch` accepts `sales_order` → Sales Invoice lines linked to the order, advances allocated (`Sales Invoice.maison_sales_order`), order marked *Collected* |
| Theme | Website Theme / Standard Navbar & Footer | `templates/webshop/base.html` (header, footer, fonts), `public/css/maison-web.css` (`web_include_css`: global gold skin + storefront classes), `public/js/maison-web.js` |

Custom fields live in `maison_pos/webshop/setup.py` (not in the shared fixtures file) and are
created on `after_install` / `after_migrate`, together with:

* Mode of Payment **Web Payment** (bank type, account "Card Clearing", added to every POS Profile) —
  a zero "Web Payment" row keeps a fully prepaid collection a valid POS invoice and prints
  *Paid online* on the receipt;
* role permissions the stock apps lack on ERPNext ≥ 15.7x: `Customer` (portal shoppers) read on
  Item / Item Price / Website Item / Price List / Sales Taxes and Charges Template and *select* on
  Account (otherwise `update_cart` raises PermissionError); Maison roles read on Payment Entry
  (advance reconciliation on collection).

## Web modes

| `Item.maison_web_mode` | Storefront | Result |
| --- | --- | --- |
| Buy | *Add to bag* → bag → boutique + payment choice | Sales Order in the boutique queue, paid online or at the counter |
| Reserve-with-deposit | *Reserve · $ X deposit* → choose a boutique holding the piece | Sales Order (full price) + Payment Request for `maison_deposit_percent` (10 %); balance at collection |
| Enquire | *Enquire about this piece* (name, e-mail/phone, boutique, message) | Maison Web Enquiry (+ Lead) in the queue; advisor calls back |

`core.effective_web_mode()` also forces *Enquire* for non-stock items and for serialized pieces with
at most one unit across the boutiques (one-of-a-kind high jewellery is never sold blind). The demo
seed sets Timepieces and solitaires to Reserve, High Jewellery and Services to Enquire, everything else
to Buy.

## Storefront routes

| Route | Page |
| --- | --- |
| `/shop` | home (hero, collections, featured, three ways to acquire, boutiques, loyalty band) |
| `/shop/collection?item_group=…&mode=…&q=…` (also `/all-products`) | listing with filters |
| `/<item-group>/<item-route>` | product page (webshop `Website Item` route, Maison template) |
| `/cart` (also `/shop/cart`) | bag (sign-in required, as in webshop) |
| `/shop/checkout` | boutique picker (stock status per boutique) + pay online / at the counter |
| `/shop/pay?pr=…` | simulated payment (Stripe mode goes to the `payments` checkout instead) |
| `/shop/order?name=…`, `/shop/orders` | order status timeline, order list |
| `/shop/account` | Maison Collectors (loyalty sign-in) |
| `/shop/boutiques` | boutiques |

The seed sets `Website Settings.home_page = shop`, so the site root is the storefront for guests
(`/pos`, `/app`, `/maison-dashboard` are unaffected).

## API (`maison_pos.api.webshop.*`)

Guest: `boutiques()`, `availability(item_code)`, `catalogue(item_group, department, q, mode, start, limit)`,
`enquire(item_code, name, email, phone, message, boutique, serial_no)`, `loyalty_lookup(client_number, email)`,
`loyalty_card_html(...)`, `status()`.

Signed-in shopper: `cart()`, `update_cart(item_code, qty)`, `set_boutique(boutique, fulfilment)`,
`place_order(boutique, fulfilment, pay_now)` → `{sales_order, payment_url, amount}`,
`reserve(item_code, boutique, serial_no, note)` → `{sales_order, deposit, payment_url}`,
`simulate_payment(payment_request)`, `my_orders()`, `order(name)`.

Boutique staff (Maison roles, boutique-scoped): `web_orders(boutique, status, include_done)` →
`{orders, enquiries, counts}`, `web_order(name)` (lines with stock + serials in the boutique, POS-shaped
customer), `set_web_order_status(name, status, note)` (New → Picking → Ready; Cancelled; *Collected* only
through the sale), `update_enquiry(name, status, response)`.

Collection: `sales.submit_batch([{…POSInvoice, "sales_order": "SAL-ORD-…", "payments": [...balance only]}])`.

## Linking the shop from a marketing site

The brand's marketing site (Webflow, WordPress, Squarespace…) stays where it is; the shop lives on
its own host.

1. **Sub-domain on Frappe Cloud** — in the site's *Domains* tab add `shop.brand.com`; create a DNS
   `CNAME shop.brand.com → <site>.frappe.cloud` (or the A record Frappe Cloud shows) and wait for the
   certificate (Let's Encrypt, automatic). Set `Website Settings → home page = shop` (the seed does)
   so `https://shop.brand.com/` opens the storefront. Self-hosted: add the domain with
   `bench setup add-domain shop.brand.com --site <site>` and reissue nginx + certbot.
2. **Links** — point the marketing site's *Shop* / *Collections* / *Timepieces* navigation to
   `https://shop.brand.com/shop/collection?item_group=Timepieces` etc., the *Client account* link to
   `https://shop.brand.com/shop/account`, boutique pages to `/shop/boutiques#CHI-OAK`. Product teasers
   on the marketing site link straight to the product routes (`/timepieces/meridian-…`).
3. **Embedding** — the pages can be iframed (`<iframe src="https://shop.brand.com/shop/collection?item_group=Bridal">`),
   but sign-in and checkout rely on first-party cookies, so an iframe on another domain will force
   the shopper to sign in again inside the frame on Safari/Firefox. Prefer links (or a sub-path
   reverse proxy `brand.com/shop → shop.brand.com` with `Host` rewriting) for the bag and checkout.
4. **Same look** — the storefront is dark onyx + champagne gold (Unbounded / Jost). If the marketing
   site is light, keep the handover explicit (a "Shop" button rather than a seamless iframe).
5. **SEO** — each Website Item has its own route, `<title>`, description and Open Graph tags
   (webshop's `set_metatags`); `/shop/collection` is server-rendered. Put the `shop.` host in the
   marketing site's sitemap or link it from the footer.

## Operating notes

* Webshop requires a signed-in Website User for the bag; `/login#signup` creates one and
  `Portal Settings.default_role = Customer` (set by the seed) gives it the portal role. The demo
  shopper is `client@maison.example` / `maison123` (Contact → Customer *Isabella Marchetti*,
  client № printed on her receipts).
* Stock shown on the site is the sum of the boutique warehouses (`Website Item.website_warehouse`
  = the company's root warehouse). The checkout shows per boutique whether every line is in that
  boutique ("Transfer · ~3 days" otherwise); serialized pieces must be in the chosen boutique.
* Unpaid web orders stay in the queue until cancelled by a manager (POS → Web orders → Cancel);
  the Sales Order is closed. A 14-day release job is a one-liner on `maison_web_status = New` +
  `creation` if the house wants it automated.
* Product photography: upload the image on the Item (`Item.image`) or on the Website Item
  (`website_image`); the seed ships generated SVG visuals so the storefront looks finished out of
  the box.
* `bench run-tests` (any app) wipes `tabItem Price` through ERPNext's `before_tests`; the
  `maison_pos.setup.demo.before_tests` hook puts the demo prices back — if the site shows *Price on
  request* after a test run, re-run `maison_pos.setup.demo.ensure_items`.

## Verification

* Backend: `bench --site <site> run-tests --module maison_pos.tests.test_webshop` (12 tests:
  web-mode rules, availability, catalogue, guest enquiry → boutique queue, loyalty lookup rules,
  order → boutique mapping + queue scoping, status machine, online payment → advance → collection
  with nothing outstanding, collection with balance / wrong boutique, reserve with deposit).
* Frontend: `npm test` (`src/tests/webOrders.test.ts`: mock status machine, collection into the
  cart, balance after a deposit).
* End to end (`e2e/webshop.e2e.mjs`, screenshots in `e2e/shots-webshop/`): guest pages, enquiry,
  loyalty lookup, signed-in bag → checkout (Oak Street, pay online) → Sales Order + advance →
  reservation with deposit → POS queue pick / ready / collect → Sales Invoice with receipt token,
  advance allocated, Sales Order *Collected*.
