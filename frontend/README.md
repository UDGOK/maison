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
  db/          Dexie schema: catalog, prices, pricing_rules, serials, stock, customers, queue, settings
  stores/      Pinia: session, catalog, cart, sync, printer
  sync/        QueueReplayer (FIFO, exponential backoff, structured errors)
  printer/     ePOS-Print XML builder + LAN POST
  payments/    Stripe Terminal driver + SimulatedReader
  views/       /unlock /sell /client /pay /receipt/:uuid /queue /shift /settings
  components/  TopBar, BasketPanel, ItemTile, Receipt80 (80 mm receipt), Modal, Keypad, NoticeStack
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

Service worker scope is `/pos` while `sw.js` is served from `/assets/maison_pos/pos/`; add to nginx:

```
location = /assets/maison_pos/pos/sw.js { add_header Service-Worker-Allowed /; }
```

For `npm run dev` against a bench, add a proxy in `vite.config.ts`:

```ts
server: { proxy: { '/api': 'http://maison.localhost:8000' } }
```
