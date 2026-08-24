# AWANZ POS — frontend

Offline-first Vue 3 PWA for the AWANZ boutique point of sale. Builds into
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
In mock mode, Settings has a "Simulate offline" switch (sets `window.__awanzOffline = true`),
or toggle it from the devtools console. Mock calls take 120–400 ms.

Optional env:

| var | effect |
| --- | --- |
| `VITE_MOCK=1` | use `src/api/mock.ts` instead of Frappe |
| `VITE_STRIPE_PUBLISHABLE_KEY` | load `@stripe/terminal-js`; without it the in-app simulated reader is used |
| `VITE_E2E=1` | v0.3 — expose `window.__awanzRecognitionTest` (`emit`, `setTemplates`, `samples`, `state`) so e2e can inject embeddings; `localStorage.awanzE2E = '1'` does the same at runtime |

## Layout

```
src/
  api/         types.ts (API CONTRACT), frappe.ts (real client), mock.ts + seed.ts (VITE_MOCK=1)
  db/          Dexie schema: catalog, prices, pricing_rules, serials, stock, customers, queue, settings, barcodes, uploads,
               face_templates, pending_enrolments (v0.3)
  stores/      Pinia: session, catalog, cart, sync, printer, scan, layout, recognition (v0.3)
  scan/        keyboard-wedge parser, camera driver (BarcodeDetector / zxing), QR payloads, resolver
  images/      client-side resize + offline upload queue
  recognition/ v0.3 — faceapi.ts (lazy loader, WebGL→WASM→CPU), provider.ts (FaceApiProvider), quality.ts (gate),
               stability.ts (liveness-lite state machine), math.ts (euclidean rule), matcher.ts (Dexie cache + server), enrolments.ts
               (offline queue), consent.ts (hold-to-agree / signature)
  sync/        QueueReplayer (FIFO, exponential backoff, structured errors)
  printer/     ePOS-Print XML builder + LAN POST
  payments/    Stripe Terminal driver + SimulatedReader
  views/       /unlock /sell /client /pay /receipt/:uuid /queue /shift /settings
  components/  TopBar, BasketPanel, ItemTile, Receipt80 (80 mm receipt), Modal, Keypad, NoticeStack, ScannerSheet, ImageSheet,
               RecognitionTile, EnrolSheet, ConsentScreen (v0.3)
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
NetworkFirst (`awanz-shell`, single cache key) and fall back to the precached Vite
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

## v0.3 — Client recognition (camera)

Everything runs **on the device**; the server only ever sees 128-float embeddings, and only for clients who agreed.

- **Model**: `@vladmandic/face-api` (TF.js) — `tinyFaceDetector` → `faceLandmark68Tiny` → `faceRecognitionNet` (128-d).
  Weights live in `public/models/` (copied from the package with `npm run models`: 6.74 MB of weights + 1.17 MB of TF.js
  WASM binaries = **7.9 MB**, plus the 1.33 MB / 340 KB-gzip library chunk). They are precached by the service worker
  (`vite.config.ts`: `models/**` glob, `maximumFileSizeToCacheInBytes` raised to 8 MB) and **lazy-loaded** only when the
  boutique has `face_recognition_enabled` and the device has not switched recognition off. Backend order
  WebGL → WASM (SIMD / threads when available) → CPU; the active backend is shown in Settings.
- **Loop** (`src/recognition/provider.ts`): one detection every ~250 ms (≈4 fps target; ~200 ms per detection on WASM in
  headless Chromium), scheduled through `requestIdleCallback` so the POS stays responsive. The descriptor is computed only
  for frames that pass the **quality gate** (`quality.ts`: detector score ≥ 0.8, face ≥ 120 px, eye-line tilt < 15°, nose
  centred between the eyes, fully in frame, Laplacian-variance sharpness). A Web Worker was not used: face-api's input
  pipeline is DOM-bound (`HTMLVideoElement` → canvas) and WebGL-in-worker is still uneven on iPad Safari; `detectOnce()` is
  the single seam to move later.
- **Liveness-lite** (`stability.ts`, unit-tested with synthetic sequences): a candidate is emitted only after 3 consecutive
  gated frames whose embeddings agree (euclidean distance < 0.5) **and** a blink (eye-aspect-ratio open→closed→open) or a small head
  motion (nose moved ≥ 6 % of the face width) inside the last 3 s. A still photo held up to the camera never produces a
  candidate. **This is not certified liveness / presentation-attack detection** — it only defeats the naive replay; the
  legal basis for recognising anyone is the stored consent.
- **Matching** (`matcher.ts`): local first against Dexie `face_templates` (filled from `recognition.templates`, consented
  clients only, **raw** descriptors, refreshed on every heartbeat when `recognition_offline_cache` is on), then
  `recognition.match` when online; if they disagree the smaller distance wins. **One rule on both sides**
  (`math.ts` ≡ `maison_pos/biometrics.py`): **euclidean distance between the raw face-api descriptors `< match_threshold`**
  (default **0.6**, face-api's published operating point). Cosine is *not* used: face-api descriptors are not unit vectors
  (‖d‖ ≈ 1.4–1.6), so cosine is compressed towards 1 and different people score 0.85–0.90 — calibration on four
  public-domain portraits gave same-person distance ≤ 0.25 across flip / brightness / 8° rotation / scale and
  different-people distance ≥ 0.7. The API returns `distance` per candidate plus a display-only
  `score = clamp(1 − distance/1.2, 0, 1)` ("Recognised · 94 %", capped at 99 %) and `threshold_distance`. The server's
  threshold is authoritative; the manager slider in Settings can only **tighten** it (lower distance) on a device.
- **Flow**: `RecognitionTile` (Sell client panel; on phones inside the basket sheet, which now opens even when empty)
  shows the preview + gold viewfinder + state chip (Looking / Recognised · nn % / New client / Off). A match attaches the
  client with a "Recognised · 94 % · Undo" toast (5 s; Undo logs `Undone`). No match shows "New client? Enrol" →
  `EnrolSheet` (phone **or** email required, optional name, lookup + link to an existing client) → `ConsentScreen`
  (client-facing, large Jost type, versioned text from settings, **hold-to-agree 600 ms** gold ring or **signature pad**,
  "No thanks" creates/links the client **without** biometrics via `recognition.decline`) → 3 captures spaced ≥ 600 ms
  (≈ 2 s) → `recognition.enroll`. Offline, enrolments and declines queue in Dexie `pending_enrolments` and the sync store
  replays them FIFO on the next heartbeat (a provisional client is attached meanwhile).
- **Client screen**: "Face recognition: enrolled 22 Aug 2026 · Delete" — Delete (managers only) calls
  `recognition.revoke`, purges the local cache and flags the record; non-managers see the status only.
- **Settings**: follow-boutique / on / off per device, camera selection, preview on/off (off = blurred, detection still
  runs), manager threshold slider, cache + queue counters, consent version / retention, and **Test recognition** — runs
  the tile with a debug readout (backend, fps, ms, quality reasons, tracker state, candidate log) without attaching anyone.
- **Mock API** (`src/api/mock.ts`): in-memory templates / consents / events, the same euclidean rule and threshold,
  enrol-by-phone/email, decline, templates (with `deleted`), revoke, `log_event`; persisted in `localStorage` like the
  rest of the mock. `__mockRecognition.setTemplates()` seeds consented templates for tests.
- **E2E** (`scripts/shots-v03.mjs`, `npm run shots:v03`): launches Chromium with
  `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=e2e-assets/face_a.mjpeg` (a 640×480 MJPEG made
  with ffmpeg from a public-domain StyleGAN portrait, panned slowly so the head-motion liveness rule is satisfied).
  **Real on-device detection is exercised**: New client → enrol → reload → Recognised (distance ≈ 0.1) → Undo → revoke; a
  second portrait (`face_b.mjpeg`) is verified **not** to match; the decline path and the signature consent are covered
  on the iPhone profile. When the detector sees no face the script falls back to the test hook. Screenshots →
  `screenshots/v03/`. Unit tests: `src/tests/recognition.test.ts` (euclidean rule / threshold / cross-person regression, quality gate, stability/liveness
  state machine, enrolment queue replay, template cache + matcher, hold timing + signature, mock contract).

## Facial recognition: legal notice

Client recognition is implemented (v0.3) but **off by default for every boutique**; only Head Office can switch it on
(`AWANZ POS Settings.face_recognition_enabled` / `AWANZ Store.face_recognition_enabled`). The provider only runs for
customers who gave consent through the in-app `ConsentScreen`, and the following remain legal requirements, not options
(full policy: `docs/biometrics-policy.md`):

- **Opt-in per client with stored consent.** Recognition may only consider customers whose record carries
  `maison_face_consent = 1` with an Active `AWANZ Biometric Consent` (`maison_face_consent_at`). Consent is informed,
  written (hold-to-agree or signature, versioned text snapshot), specific to facial geometry, and revocable; revocation
  (`recognition.revoke`) deletes every template. No consent → no match, and no frame is ever retained or uploaded.
- **Illinois BIPA (740 ILCS 14)**: written release before collecting a face geometry; a public retention-and-destruction
  schedule (the daily purge after `biometric_retention_months`, default 36, or on request — whichever is first); no
  selling/leasing of biometric data; reasonable security. BIPA carries a private right of action with statutory damages
  per violation, so CHI-OAK (Chicago) and any Illinois boutique is the highest-risk deployment.
- **California CCPA/CPRA**: biometric data is "sensitive personal information" — notice at collection, a
  "Limit the Use of My Sensitive Personal Information" right, access/deletion rights, and a purpose limitation.
  Similar biometric laws exist in Texas (CUBI) and Washington, and the EU AI Act / GDPR restrict it further.
- **In-store notice**: a visible sign at the entrance and at the point of sale whenever a camera is used for
  recognition, plus a privacy-policy section describing purpose, retention and the consent mechanism.
- **Data handling**: only embeddings (float32[128]) travel; the POS never stores or uploads images or thumbnails;
  `AWANZ Face Template` / `AWANZ Biometric Consent` access is restricted and every outcome is logged as a
  `AWANZ Recognition Event`.
- **Liveness-lite is not certified** presentation-attack detection; do not market the feature as such.

Until legal sign-off exists for each jurisdiction, keep the boutique switch off.

## v0.5 K — AWANZ Salon (client-facing screen)

`/salon` runs the same bundle with its own layout for the client-facing iPad (a guest device paired by a 6-digit
code from Settings → **Client display**). Code lives in `src/salon/` (reducer, masking, pairing helpers, socket +
polling transport, the "light on metal" canvas, the screens) and `src/stores/salon.ts` (POS side: pairing, the
debounced mirror, Salon → POS messages). In mock mode Settings offers **Show virtual salon**, an iPad-mini pane
running the real `/salon` app against the in-memory server shared through `localStorage`. Full notes:
`docs/salon.md`. Tests: `src/tests/salon.test.ts`; e2e `e2e/salon.e2e.mjs` (two browser contexts).
