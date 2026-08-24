# White-label (v0.7)

The client is buying a product, not a Frappe install. This release makes sure that nothing a
customer — or a member of the tenant's staff — reads anywhere in the product says **Frappe** or
**ERPNext**.

Everything is driven by the brand fields on **AWANZ POS Settings** (`brand_name`,
`product_name`, `tagline`, `wordmark_text`, `sub_mark`, `legal_name`, `support_email`,
`brand_website`, `brand_logo`) and read **at apply time**, so the CloudChaserz tenant, the
jewellery tenant and every future tenant come out right with no code change. There is no tenant
name anywhere in `maison_pos/setup/whitelabel.py`.

Related: `docs/cloudchaserz.md` (the brand fields themselves), `maison_pos/brand.py`.

---

## 1. How it is applied

```python
# maison_pos/setup/whitelabel.py
apply_whitelabel()     # System Manager only, whitelisted, idempotent
revert_whitelabel()    # puts back exactly what was there before the first apply
whitelabel_status()    # read-only: expected vs. current, plus the drift between them
attribution()          # the open-source components, versions and licences (see §5)
```

`setup_whitelabel()` runs from `after_install` **and** `after_migrate`
(`maison_pos/setup/install.py`), so a `bench migrate` re-asserts the branding — which matters,
because Frappe re-imports its standard workspaces and navbar items from each app's JSON on every
migrate and would otherwise put "Frappe CRM" back in the sidebar.

On a managed host without shell access, as a System Manager:

```
POST /api/method/maison_pos.setup.whitelabel.apply_whitelabel
GET  /api/method/maison_pos.setup.whitelabel.whitelabel_status
POST /api/method/maison_pos.setup.whitelabel.revert_whitelabel
```

**Idempotent**: only values that actually differ are written, and the pre-white-label snapshot is
taken exactly once (stored as the global `awanz_whitelabel_backup`) so a later revert restores
the site rather than the defaults.

Three layers do the work:

| Layer | What it covers | Why there |
|---|---|---|
| **Settings** | Website Settings, System Settings, Navbar Settings, Workspace titles | Supported fields; survives upgrades |
| **Templates** in `maison_pos/templates/` and `maison_pos/www/` | the footer's "Powered by ERPNext", ERPNext's newsletter block, the 404 page, the `/apps` picker | Frappe's Jinja and page routers search installed apps in **reverse install order**, so ours shadow upstream's without patching anything |
| **Hooks** (`hooks.py`, delimited `--- v0.7 white-label ---`) | the strings and headers that live outside any template block | The only place they can be reached |

---

## 2. What changed, surface by surface

### Public website / portal

| Thing | Before | Now |
|---|---|---|
| `Website Settings.app_name` | site name / "Frappe" | `brand_name` |
| `title_prefix` | empty → `<title>Login</title>` | `brand_name` → `CloudChaserz - Login`, on every www page |
| `brand_html` | empty (framework navbar) | the tenant wordmark (`wordmark_text` + `sub_mark`), or `brand_logo` when set |
| `app_logo`, `favicon`, `splash_image`, `footer_logo` | `/assets/erpnext/images/erpnext-logo.svg`, `frappe-favicon.svg` | `brand_logo`, else a generated `/files/awanz-brand-mark.svg` (the wordmark's initial in Monolith Gold) |
| `copyright` | empty | `<year> <legal_name>` |
| `footer_powered` | *"Powered by **ERPNext**"* (erpnext's `footer_powered.html`) | `product_name`, linked to `brand_website` |
| `banner_html` | — | left alone when the client wrote it; cleared only when it is the framework's own banner |
| "Get Updates" footer block | ERPNext's newsletter box; its inline script calls `erpnext.subscribe_to_newsletter` | removed: `hide_footer_signup = 1` **and** an empty `templates/includes/footer/footer_extension.html` override |
| `/login` | ERPNext logo, *"Login to Frappe"*, "Login with **Frappe Cloud**" | brand mark, *"Login to CloudChaserz"*; the Frappe Cloud button is dropped by the `update_website_context` hook |
| `/rewards` sign-up | posted an `X-Frappe-CSRF-Token` header and read `window.frappe` | the CSRF token travels in the request body; the page ships no framework-named header |

The storefront (`/shop`, `/rewards`, `/r/<token>`) already had its own Monolith Gold header and
footer, so it never carried the framework's. Two hard-coded strings were fixed on the way:
`templates/webshop/item.html` hard-coded the product wordmark in the title and the breadcrumb, and `www/r.html`
printed the jewellery return policy verbatim (a smoke-shop receipt read *"engraved pieces are
final sale"*). Both read the brand now.

### Desk (`/app`)

| Thing | Before | Now |
|---|---|---|
| Browser tab | `ERPNext` (`System Settings.app_name`) | `brand_name` |
| Navbar logo, desk splash | ERPNext logo | brand mark |
| Help menu | Documentation → docs.erpnext.com · User Forum → discuss.frappe.io · Frappe School · Report an Issue → github.com/frappe/erpnext · Frappe Support | those five hidden **and** their routes blanked (a hidden row still ships its URL in `frappe.boot`); a `<brand> Support` item added, pointing at `support_email` |
| About dialog | "Frappe Framework", frappe.io / blog / forum / LinkedIn / X / YouTube / Instagram, "© Frappe Technologies" | the tenant's: product name, tagline, website, support address, version, `© <legal_name>` — plus a **Licences and notices** link (§5). `maison_pos/public/js/awanz-desk.js`, loaded through `app_include_js` |
| Sidebar workspaces | *Frappe CRM*, *ERPNext Settings*, *ERPNext Integrations* | *CloudChaserz CRM*, *Settings*, *CloudChaserz Integrations* — the framework word is dropped, and the tenant name qualifies it when the plain name is already taken |
| Getting-started widget | *"Let's begin your journey with ERPNext"* + ERPNext tutorial prose | off (`System Settings.enable_onboarding = 0`) |
| 2FA enrolment | authenticator app showed "Frappe Framework" (`otp_issuer_name`) | `brand_name` |
| `/apps` | the framework's *"Select an app to continue"* picker, listing **ERPNext**, **Frappe HR**, **Frappe CRM** | redirects to `/start`, the branded launcher that lists exactly the screens the user's roles allow (`maison_pos/www/apps.py`) |
| Login redirect | landed on that picker | `System Settings.default_app = maison_pos` → `/start` |

Two site-state repairs were needed to make the desk reachable at all, both in
`setup/install.ensure_launcher_home_page` (v0.7 block) and both only applied when the value is
still empty or still the installer's default:

* `default_app` was never actually being set. The old code saved the whole `System Settings`
  document, which fails with `MandatoryError: language` on a site created from the CLI (the setup
  wizard is what fills `language` in), and the exception was swallowed. It is written at the
  database level now.
* `desktop:home_page` is `"setup-wizard"` on a CLI-created site, so `/app` bounced through
  `/app/setup-wizard` to `/apps`. Once `frappe.is_setup_complete()` is true it becomes
  `"workspace"` — the same repair as frappe's own `patches/v13_0/reset_corrupt_defaults`.
* `System Settings.language` is filled with `en` when empty: the desk builds an `Intl` formatter
  from it and dies with *"RangeError: Incorrect locale information provided"* — a blank `/app`.

### E-mail

* `System Settings.disable_standard_email_footer = 1` removes ERPNext's `default_mail_footer`
  hook — *"Sent via **ERPNext**"* — from every outgoing message.
* `System Settings.email_footer_address` carries the tenant's `legal_name` and `support_email`
  instead, and is rendered by frappe's own `email_footer.html`.
* The `X-Frappe-Site` header frappe sets on every message becomes `X-AWANZ-Site`
  (`make_email_body_message` hook).
* Both values are also written to `tabDefaultValue`, because `get_footer()` reads them through
  `frappe.db.get_default`, not through the Singles row.
* Audited and clean: no **Email Template** or **Notification** on either site renders a framework
  name — the only matches are Jinja calls (`frappe.utils.get_link_to_form(...)`), which are code,
  not text.

### Print formats and PDFs

`AWANZ Receipt`, `AWANZ Return Receipt` and `AWANZ Packing List` already read the brand
(`maison_pos.utils.get_brand_context`) and carry nothing else; the only "frappe" in them is
`frappe.utils.format_datetime(...)` inside Jinja. Frappe's print view has no "powered by" line,
and neither Print Settings nor any Letter Head on either site carries one. Nothing to change.

### Error pages, PWA, manifest

* `maison_pos/www/404.html` + `error_404.py` replace frappe's 404 (which renders
  `/assets/frappe/images/ui-states/404.png`) with a branded page: wordmark, gold 404, links to the
  storefront, the rewards page and `support_email`.
* `manifest.webmanifest` is served by `maison_pos.api.pwa.manifest`, which builds `name`,
  `short_name`, `description` and the icons from the brand at request time; `www/pos.py` rewrites
  the `<link rel="manifest">` the Vite build emits. One build now serves every tenant instead of
  installing on a customer's home screen under the wrong name.
* `<meta name="generator" content="frappe">` and the `<!-- Built on Frappe … -->` comment in
  `frappe/templates/base.html` sit outside every Jinja block, so they are replaced on the response
  by the `after_request` hook (`whitelabel.scrub_response`) — two literal byte replacements,
  wrapped so a failure can never break a page.

### HTTP surface

* Any `X-Frappe-*` response header is renamed (`X-Frappe-Request-Id` → `X-Request-Id`).
* `Server` is set to `product_name`. The Werkzeug dev server appends its own token as well; in
  production the value the client sees is whatever nginx/gunicorn is configured to send, so set
  `server_tokens off;` and `proxy_hide_header Server;` there too (§7).

---

## 3. What a new tenant must set

Fill in **AWANZ POS Settings** and run `apply_whitelabel()` (or just `bench migrate`):

| Field | Used for |
|---|---|
| `brand_name` | Website Settings `app_name` + `title_prefix`, desk tab title, `otp_issuer_name`, the login heading, the workspace qualifier, the Help menu's support item |
| `product_name` | the footer line that replaces "Powered by ERPNext", the `Server` header, the `generator` meta, the About dialog title, the PWA manifest `name` |
| `wordmark_text`, `sub_mark` | `brand_html` (website navbar) and the generated brand mark's initial |
| `tagline` | About dialog, PWA manifest `description` |
| `legal_name` | the website footer copyright, the e-mail footer address |
| `support_email` | the Help menu item, the About dialog, the e-mail footer, the 404 page |
| `brand_website` | the footer link, the About dialog |
| `brand_logo` | **optional.** When set it is used verbatim for the favicon, the app logo, the splash and the footer logo, and as a manifest icon. When empty, a square SVG mark is generated from the wordmark's initial in Monolith Gold and stored as the public file `/files/awanz-brand-mark.svg` |

Nothing else is required. `whitelabel_status()` returns `ok: false` and a `drift` list if any
surface has fallen behind the settings.

---

## 4. Manual steps (not automatable)

1. **App icons for the home screen.** `apple-touch-icon.png`, `icon-192.png` and `icon-512.png`
   under `frontend/public/icons/` are PNG build assets and cannot be generated per tenant at
   request time. Replace them with the tenant's and re-run `npm run build && bench build --app
   maison_pos`, or upload a **PNG** `brand_logo`, which the manifest then offers as the install
   icon (iOS still uses the built `apple-touch-icon.png`).
2. **The `Server` and framework headers in production.** Our `after_request` hook sets the
   response header, but the front-end proxy has the last word. In nginx: `server_tokens off;` and
   `proxy_hide_header Server;`.
3. **Custom domain and e-mail sending domain.** A `@…frappe.cloud` host or `From:` address gives
   the game away regardless of what the pages say.
4. **Anything the tenant's own staff has already customised** — a Letter Head, a Web Page, an
   Email Template written on the site — is the tenant's content and is deliberately left alone.
5. **`bench` / server-side tooling.** The CLI, the log files, the Python package names and the
   `/api/method/frappe.*` endpoints are the platform, not the product surface. See §6.

---

## 5. What must stay — licences and attribution

**White-labelling removes upstream *marketing* from the UI. It does not, and must not, remove the
notices the licences require.** Frappe Framework is MIT; ERPNext, Frappe HR and Webshop are
GPLv3; Frappe CRM is AGPLv3. Those licences require the copyright notices and licence texts to
travel with the software — in the **source**, not in the product's chrome. GPLv3 §5(d) only
requires an interactive UI to display "Appropriate Legal Notices" if the original already did;
ERPNext's About dialog is a marketing panel, not such a notice, so replacing it is permitted.

Left untouched, deliberately:

* every app's `LICENSE` file and per-file copyright headers;
* the Python package metadata (`app_title`, `app_publisher`, `pyproject.toml`);
* `git` history, `bench` output and the framework's own log files;
* `/api/method/frappe.utils.change_log.get_versions` and the rest of the framework API;
* **`maison_pos.setup.whitelabel.attribution()`** —
  `/api/method/maison_pos.setup.whitelabel.attribution` — which lists every installed component,
  its version and its licence, and which the desk About dialog links to as
  *"Built on open-source components. Licences and notices"*.

Do not remove any of these to "finish the job". If a customer asks what the product is built on,
the honest answer is available in one click.

---

## 6. Known remaining leaks (and why)

Proven by `e2e/whitelabel.e2e.mjs`, which greps both the **rendered text** and the **rendered
HTML** of `/`, `/login`, `/shop`, `/rewards`, `/r/<token>`, a 404 URL, `/start`, `/apps` and
`/app` for `Frappe`, `ERPNext`, `frappe.io` and `erpnext.com`. Rendered **text** is zero on every
page, on both tenants. What is left appears only in the HTML source and is an identifier, never a
word anyone reads:

| Leak | Where | Why it stays |
|---|---|---|
| `/assets/frappe/…`, `/assets/erpnext/…`, `*.bundle.js` | every page's `<link>` / `<script>` | Frappe builds these URLs from the app name. Renaming them means patching the asset pipeline and rewriting every generated URL — the largest change with the least benefit. |
| `window.frappe`, `frappe.boot`, `frappe.ready`, `frappe.csrf_token` | inline script in `frappe/templates/base.html` | The framework's JavaScript namespace. Every bundle depends on it. |
| `frappe-session-status`, `id="frappe-symbols"`, `.frappe-checkbox`, `.frappe-timestamp` | DOM attribute and class names in base.html and the framework's components | Identifiers, like doctype names; the framework's own CSS and tests select on them. |
| `"frappe": …`, `"erpnext": …`, `module_app`, `assets_json` | `frappe.boot` JSON on every page | Package identifiers in a config payload. |
| `Workspace.label` (`Frappe CRM`) and the hidden Help items' labels | `frappe.boot`, `item-name=` attributes | `label` is the document name **and** the desk route (`/app/frappe-crm`). Renaming it breaks `parent_page` links and is undone by the next migrate, which re-imports the standard workspaces. The **title** — what the sidebar renders — is rebranded, and the Help items are hidden with their routes blanked. |
| `/* sfc-style:/…/apps/frappe/… */` | `<style>` blocks the framework's bundles inject at runtime | Inside upstream's compiled output. Live DOM only — never in view-source. |
| `/api/method/frappe.ping`, `/api/method/frappe.client.*` | the REST surface | The framework's method paths *are* the API. Changing them breaks every client, including ours. A customer who goes looking at `/api` will find the platform; that is not the same as the product telling them. |
| `Server: Werkzeug/…` | the dev server only | Set by the WSGI server, after our hook. Production: §4.2. |

The e2e's allow-list encodes exactly this table, with a comment per entry; anything outside it
fails the run.

---

## 7. The `maison_pos` package name (v0.9)

The product is **AWANZ**. v0.9 renamed everything a user can reach — the 47 doctypes
(`Maison Boutique` → `AWANZ Store`, `Maison Associate` → `AWANZ Associate`, …), the five roles,
the eleven Script Reports, the three print formats, the two workflows, the desk module
(`Maison POS` → `AWANZ POS`, so the module folder is now `maison_pos/awanz_pos/`), the app title,
the brand defaults and the dashboard route (`/maison-dashboard` → `/awanz-dashboard`, with a
redirect from the old path). `maison_pos/patches/v0_9/rename_to_awanz.py` carries an installed
site across; it runs in `[pre_model_sync]`, before `bench migrate` reads the JSON files, so
`frappe.rename_doc` moves the tables with `RENAME TABLE` instead of a second set of doctypes
appearing beside the old ones.

Three things deliberately kept their old name.

### 7.1 The python package / app name `maison_pos`

`app_name` is `maison_pos`, so the code lives in `maison_pos/`, the module path is
`maison_pos.api.*`, and every built asset is served from `/assets/maison_pos/…`. That is the
same category of leak as `/assets/frappe/…` in §6: an identifier in a URL, never a word in the
product. `app_title` is `AWANZ POS`, which is what the desk, the launcher and the About dialog
render.

Renaming it is not a code change, it is a **deployment** change:

1. rename the git repository and the app directory, because frappe derives the app name from the
   folder under `apps/`;
2. `bench remove-app maison_pos --no-backup` then `bench get-app` + `bench install-app awanz_pos`
   on **every** site — an app cannot be renamed in place, and the uninstall drops the app's
   doctypes with `force`;
3. rewrite `Module Def.app_name`, `Installed Application`, `Custom Field.module`,
   `Print Format.module` and every `maison_pos.*` string stored in the database (scheduler jobs,
   workflow transitions, notification method paths, `System Settings.default_app`);
4. rebuild and redeploy every client bundle, because `/assets/maison_pos/pos/*` is baked into the
   service worker's precache manifest — a POS that is offline when the asset path changes has no
   way to fetch the new one;
5. re-issue the docker image and the `apps.json` used to build it.

On a live chain that is a maintenance window with a real chance of a till not coming back, in
exchange for a string no cashier, manager or shopper ever sees. It is a separate, planned piece
of work, not part of a branding pass.

### 7.2 The `maison_*` custom fieldnames

`Sales Invoice.maison_boutique`, `Item.maison_metal`, `Customer.maison_client_number` and 83
others are **Custom Fields on ERPNext doctypes**, so the fieldname is a database **column** on
`tabSales Invoice`, `tabItem` and `tabCustomer` — tables with hundreds of thousands of rows on a
seeded chain. Renaming them means an `ALTER TABLE` per column plus a rewrite of every query,
report, print format, fixture filter, API payload key and offline IndexedDB record that names
them, and the POS PWA holds those keys in its local catalogue — an old bundle would write
`maison_offline_uuid` while the server expected `awanz_offline_uuid`, and idempotency on
resubmit would silently break.

Against that: a fieldname is visible only to someone who opens the field list in the desk
customisation screen. Their **labels** are not — those are rebranded, and v0.9's patch and the
`ensure_awanz_names()` re-assertion in `after_migrate` keep them that way, so no field a user can
open still reads "Maison".

### 7.3 The jewellery regression tenant's `@maison.example` addresses

The jewellery demo profile seeds its staff as `hq@maison.example`, `chi.oak.a1@maison.example`
and so on, with the shared password `maison123` (`docs/security.md`). Those are **User document
names** — frappe's `User.after_rename` rewrites `owner` and `modified_by` on *every* table in the
site — and they are login credentials on a regression profile that holds no real data. The
tenant's *brand* is AWANZ everywhere it is rendered; only the mailbox names are historical.

---

## 8. Reverting

```
POST /api/method/maison_pos.setup.whitelabel.revert_whitelabel
```

restores Website Settings, System Settings, the Navbar Settings help menu (labels, hidden flags
and routes) and the workspace titles to the values captured before the **first**
`apply_whitelabel()`, and removes the tenant support item that was added. The template overrides
are files, not settings: delete `maison_pos/www/{404,apps}.{html,py}` and
`maison_pos/templates/includes/footer/` to get the framework's pages back, and remove the
`--- v0.7 white-label ---` block from `hooks.py` for the request/response hooks.

Note that `after_migrate` re-applies. To keep a site un-white-labelled, revert **and** remove the
`setup_whitelabel()` call from `maison_pos/setup/install.py`.

---

## 9. Tests

| Suite | What it proves |
|---|---|
| `maison_pos/tests/test_v0_7_whitelabel.py` (25 tests) | every derived value follows the brand settings (including for a made-up third tenant), applying twice writes nothing the second time, free-form tenant content (`banner_html`) survives, `revert_whitelabel()` restores the captured values, only a System Manager may run either, the response/e-mail/boot hooks behave, the template overrides resolve to this app, the manifest is brand-driven, and `attribution()` still names the upstream projects |
| `e2e/whitelabel.e2e.mjs` | crawls the nine routes above on a live site, greps rendered text **and** HTML for the four strings, screenshots each to `e2e/shots-whitelabel/` and writes `report.json` |

```bash
bench --site <site> run-tests --app maison_pos --module maison_pos.tests.test_v0_7_whitelabel
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers BASE=http://cc.localhost:8001 ADMIN_PWD=admin \
  node e2e/whitelabel.e2e.mjs
```

> The e2e pins the browser locale (`E2E_LOCALE`, default `en-US`). A container whose `LANG` is the
> POSIX locale gives Chromium `en-US@posix`, which is not a valid BCP-47 tag; the desk builds
> `new Intl.Locale(navigator.language)` and throws before the workspace renders. That is the test
> environment, not the product.
