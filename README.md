# Maison POS

A luxury-retail point of sale and head-office platform built as a custom app on **Frappe Framework v15 + ERPNext v15**, for a boutique chain growing from 40 to 100+ stores.

| Part | Where | What |
|---|---|---|
| Backend app | `maison_pos/` | Doctypes (Boutique, Associate, Price Change Request, Device Heartbeat, Sync Log), REST API, Stripe Terminal, workflows, 80 mm receipt print format, demo seed, tests |
| POS PWA | `frontend/` → `maison_pos/public/pos` | Vue 3 offline-first iPad point of sale served at `/pos` |
| Head-office dashboard | `dashboard/` → `maison_pos/public/dashboard` | Live wall at `/maison-dashboard` over Frappe realtime |
| Dev environment | `docker/` | docker-compose stack (MariaDB, Redis, Frappe/ERPNext v15, nginx) |

Design system: **Monolith** — Unbounded + Jost on deep green `#0A1410`, platinum accent. See `SPEC.md`.

## Architecture in one paragraph
One central ERPNext site is the source of truth. Each boutique is a Warehouse + Cost Center + POS Profile, tied together by a `Maison Boutique` record that also holds the receipt address, printer and Stripe location. The POS is a PWA that caches the catalogue, prices, serials and clients in IndexedDB, sells while offline, and replays an idempotent queue (`maison_offline_uuid`) when the connection returns. Card payments go through Stripe Terminal (semi-integrated; card data never touches the platform). Every submitted POS Sales Invoice is published over socket.io to the head-office dashboard. Store price exceptions go through the `Maison Price Approval` workflow, which creates a warehouse-scoped Pricing Rule on approval.

## Quick start (existing bench)
```bash
bench get-app https://github.com/UDGOK/maison-pos
bench --site yoursite install-app maison_pos
bench --site yoursite execute maison_pos.setup.demo.seed     # demo company, 3 boutiques, 42 items, clients, PINs
bench build --app maison_pos
```
Then open `/pos` (associate login, PIN unlock) and `/maison-dashboard` (Head Office role).
Demo associate: `chi.oak.a1@maison.example` / `maison123`, PIN `2580` (see `maison_pos/setup/demo.py`).

Stripe: add `stripe_secret_key` / `stripe_publishable_key` to `site_config.json`; without them the POS uses a simulated reader.

## Quick start (docker)
```bash
cd docker && ./setup.sh        # see docker/README.md
```

## Develop
```bash
cd frontend  && npm i && VITE_MOCK=1 npm run dev   # POS with mock API
cd dashboard && npm i && VITE_MOCK=1 npm run dev   # dashboard with simulated sales stream
npm test            # in either folder
bench --site yoursite run-tests --app maison_pos
node e2e/pos.e2e.mjs   # Playwright end-to-end against a live bench
```

## Docs
`SPEC.md` (contract + design system) · `maison_pos/README_BACKEND.md` · `INTEGRATION_NOTES.md` · `e2e/REPORT.md` · `docker/README.md`
