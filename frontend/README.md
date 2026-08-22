# Maison POS — frontend

Offline-first Vue 3 PWA for the Maison boutique point of sale. Builds into
`../maison_pos/public/pos/` and is served by Frappe at `/pos` (`maison_pos/www/pos.html`).

Stack: Vue 3 + TypeScript + Vite + Pinia + vue-router + vite-plugin-pwa + Dexie + vitest.

## Commands

```bash
npm i                      # install
VITE_MOCK=1 npm run dev    # run against the in-memory mock API (no bench needed)
npm run dev                # run against a local bench (proxy /api to your site, see below)
npm run build              # vue-tsc typecheck + vite build -> ../maison_pos/public/pos
npm test                   # vitest: totals/tax/rounding, sync queue replay, ePOS XML, mock API
npm run typecheck          # vue-tsc --noEmit
npm run lint               # eslint
```

Mock mode credentials: pick any boutique, then PIN `1234` (manager) or `1111` (associate).
In mock mode, Settings has a "Simulate offline" switch (sets `window.__maisonOffline = true`),
or toggle it from the devtools console. Mock calls take 120–400 ms.

Optional env:

| var | effect |
| --- | --- |
| `VITE_MOCK=1` | use `src/api/mock.ts` instead of Frappe |
| `VITE_STRIPE_PUBLISHABLE_KEY` | load `@stripe/terminal-js`; without it the in-app simulated reader is used |

## Layout

```
src/
  api/         types.ts (API CONTRACT), frappe.ts (real client), mock.ts + seed.ts (VITE_MOCK=1)
  db/          Dexie schema: catalog, prices, pricing_rules, serials, stock, customers, queue, settings, barcodes, uploads
  stores/      Pinia: session, catalog, cart, sync, printer, scan, layout
  scan/        keyboard-wedge parser, camera driver (BarcodeDetector / zxing), QR payloads, resolver
  images/      client-side resize + offline upload queue
  recognition/ provider.ts — NullProvider scaffold only (see legal notice)
  sync/        QueueReplayer (FIFO, exponential backoff, structured errors)
  printer/     ePOS-Print XML builder + LAN POST
  payments/    Stripe Terminal driver + SimulatedReader
  views/       /unlock /sell /client /pay /receipt/:uuid /queue /shift /settings
  components/  TopBar, BasketPanel, ItemTile, Receipt80 (80 mm receipt), Modal, Keypad, NoticeStack, ScannerSheet, ImageSheet
  styles/      tokens.css (Monolith design tokens), base.css
  tests/       vitest
```

## How it works

- **Unlock**: choose boutique → `catalog.bootstrap` is cached in Dexie (items, prices, pricing
  rules, serials, stock, taxes, loyalty program, associates with hashed PINs). PIN unlock compares
  SHA-256 locally, so unlocking works with no network.
- **Sell**: category rail (Item Groups), department chips, search; serialized items prompt for a
  serial. Cart computes per-line tax (`maison_taxable`), discounts, loyalty redemption; totals
  rounding in `src/utils/totals.ts` (shared with the mock server so it "recomputes" like Frappe).
- **Pay**: cash (tendered/change) or card. Card uses Stripe Terminal when a publishable key is
  set, otherwise `SimulatedReader` walks discover → connect → collect → process with ~2 s steps,
  calling `stripe_terminal.connection_token / create_payment_intent / capture`.
- **Queue**: every sale is written to Dexie with a `offline_uuid` (uuid v4) and replayed FIFO by
  `sales.submit_batch` when online. Transient failures back off exponentially (2 s … 5 min).
  Structured server errors (`SerialConflict`, `StockShort`, …) are shown on the row, in a toast,
  and on the receipt; associates can Retry, managers can Discard.
- **Online detection**: `navigator.onLine` AND a successful `dashboard.heartbeat` every 60 s.
  Coming back online triggers a replay and a `catalog.delta` refresh.
- **Printing**: `buildReceiptXml` produces ePOS-Print XML POSTed to
  `http://<printer_ip>/cgi-bin/epos/service.cgi`; if no IP or the printer is unreachable it falls
  back to `window.print()` of the 80 mm `Receipt80` component.
- **PWA**: shell is precached; `catalog.*` API calls use NetworkFirst; `sales.*` is NetworkOnly.

## Serving under Frappe

`maison_pos/www/pos.py` reads the built `public/pos/index.html`, extracts its `<link>` / `<script>`
tags and injects them into `pos.html` along with `window.csrf_token`. After `npm run build` run
`bench build --app maison_pos` (or just restart in dev) and open `https://<site>/pos`.

Service worker scope is `/pos/` while the built `sw.js` lives under `/assets/maison_pos/pos/`.
Browsers only accept that scope if the script response carries `Service-Worker-Allowed`, which
managed hosts (Frappe Cloud) do not add for `/assets`. The app therefore registers
`/api/method/maison_pos.api.pwa.service_worker` (`maison_pos/api/pwa.py`), a guest-readable
endpoint that returns the built `sw.js` with `Service-Worker-Allowed: /pos/` and
`Cache-Control: no-cache`; no nginx configuration is needed. `sw.js` is built with the workbox
runtime inlined and absolute `/assets/maison_pos/pos/` precache URLs (`vite.config.ts`), so it
does not depend on the URL it is served from. Navigations to `/pos` and `/pos/*` are cached
NetworkFirst (`maison-shell`, single cache key) and fall back to the precached Vite
`index.html`, so reloading any `/pos/*` route offline still renders the shell.
The legacy nginx rule (`docker/`) `location = /assets/maison_pos/pos/sw.js { add_header
Service-Worker-Allowed /; }` is harmless but no longer required.

For `npm run dev` against a bench, add a proxy in `vite.config.ts`:

```ts
server: { proxy: { '/api': 'http://maison.localhost:8000' } }
```

## v0.2 — Monolith Gold, images, scanning, phones, receipt QR, client numbers

- **Palette**: `src/styles/tokens.css` is onyx + champagne gold (`--accent`); `--platinum` is kept as an alias so v0.1
  components render in gold without changes. Primary buttons are gold fill / onyx text; the Online pill is a gold outline.
- **Product images**: `Item.image` (absolute URL or null) from `catalog.bootstrap`. Tiles show the photo block when
  `settings.show_product_images` is on (boutique/global) — Settings has a per-device override, and the Sell toolbar has a
  quick toggle. Managers get an "Edit tile" button / long-press → `ImageSheet` (camera or file picker, resized client-side
  to ≤ 1200 px JPEG in `src/images/resize.ts`, uploaded with `catalog.upload_item_image`; offline it is queued in Dexie
  `uploads` and replayed on the next heartbeat — `src/images/uploads.ts`).
- **Scanning** (`src/scan/`): `wedge.ts` — global keyboard-wedge burst parser (fast keystrokes + Enter outside text
  inputs); `camera.ts` — `BarcodeDetector` with `@zxing/browser` fallback, shown in `ScannerSheet` (gold viewfinder);
  `payloads.ts` — `MC:<customer>`, `INV:<name>`, `<base>/r/<token>`; `resolve.ts` — barcode → item, serial label → item +
  serial, client QR → attach, invoice QR → receipt, unknown → "Not in catalogue" notice with a Search action. `bootstrap.barcodes`
  (`code → item_code`, including every serial) is cached in Dexie `barcodes`.
- **Phones**: `src/stores/layout.ts` (≤ 767 px = phone). Top bar collapses to wordmark + status + menu drawer; the category
  rail becomes horizontal chips; the basket is a bottom sheet with a summary bar (items · total · CHARGE); Pay / Receipt /
  Client are single-column; safe-area insets via `env(safe-area-inset-*)`; manifest `orientation: any`;
  `apple-touch-icon` generated by `scripts/make-icons.mjs` (gold "M" on onyx, rasterised with Playwright).
- **Receipt QR**: `submit_batch` returns `receipt_token`; it is stored on the queue row, rendered by `Receipt80` (`qrcode`)
  and emitted by the ePOS builder as `<symbol type="qrcode_model_2" level="M" width="5">`. Content is
  `${settings.receipt_qr_base_url}/r/${token}`; the receipt screen shows the same link with Copy.
- **Client number**: `Customer.client_number` (`MC` + 6 digits). The Sell client card and the Client screen have a
  CLIENT № field with numeric keypad, scan button and `customers.lookup`; the card shows tier, points balance + value,
  last visit and a "Redeem points" toggle. Receipts print the client number and points earned/balance.
- **Screenshots**: `VITE_MOCK=1 npm run dev` then `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/shots-v02.mjs`
  → `screenshots/v02/` (1366×1024 and iPhone 390×844 @3x).

## Facial recognition: legal notice

Client recognition is **not implemented**. `src/recognition/provider.ts` only defines the interface
(`identify(frame) → { customer?, confidence }`) and a `NullProvider` that never matches; the Settings toggle is greyed
out. Before any real provider is wired in, the following must be in place — they are legal requirements, not options:

- **Opt-in per client with stored consent.** Recognition may only run for customers whose record carries
  `maison_face_consent = 1` together with `maison_face_consent_on` (date/time of consent). Consent must be informed,
  written (or electronically signed), specific to facial geometry, and revocable; revocation must delete the stored
  template (`maison_face_id`). No consent → the provider must return no match, and no frame may be retained.
- **Illinois BIPA (740 ILCS 14)**: written release before collecting a face geometry; a public retention-and-destruction
  schedule (destroy when the purpose is satisfied or within 3 years of the last interaction, whichever is first); no
  selling/leasing of biometric data; reasonable security. BIPA carries a private right of action with statutory damages
  per violation, so CHI-OAK (Chicago) and any Illinois boutique is the highest-risk deployment.
- **California CCPA/CPRA**: biometric data is "sensitive personal information" — notice at collection, a
  "Limit the Use of My Sensitive Personal Information" right, access/deletion rights, and a purpose limitation.
  Similar biometric laws exist in Texas (CUBI) and Washington, and the EU AI Act / GDPR restrict it further.
- **In-store notice**: a visible sign at the entrance and at the point of sale whenever a camera is used for
  recognition, plus a privacy-policy section describing purpose, retention and the consent mechanism.
- **Data handling**: templates never leave the consented enrolment flow; the POS never uploads frames by itself;
  access to `maison_face_id` is restricted to the recognition service account and audited.

Until legal sign-off exists for each jurisdiction, keep the feature off and do not replace `NullProvider`.
