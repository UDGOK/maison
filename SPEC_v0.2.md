# Maison POS — v0.2 additions (contract for backend + frontend agents)

Read SPEC.md first. These are additive changes; keep all v0.1 behaviour and tests green.

## 1. Palette: green → onyx + champagne gold ("Monolith Gold")
Keep Unbounded + Jost and all layout. Replace tokens in frontend/src/styles/tokens.css and dashboard equivalents:
ground `#0B0B0A`, surface `#141311`, surface-2 `#1B1916`, line `#26231F`, line-strong `#36322C`,
text `#EFE8DA`, muted `#B3AA99`, dim `#7D7668`, accent (buttons, active states, big numerals) champagne gold `#C9A96E`, accent-deep `#A8884E`, accent-soft `rgba(201,169,110,.14)`; semantic good `#7FA98A` warn `#D3A55B` crit `#C4736A`. Primary buttons: gold fill, onyx text. Online pill: gold outline. Charts: gold fills. Receipt print stays black on white.

## 2. Product images on tiles (optional, boutique-level toggle)
Backend: Item already has `image` (ERPNext standard attach field) — use it; drop `maison_image_url` usage if any. `catalog.bootstrap/delta` return `image` (absolute URL or null) per item. New field on Maison Boutique: `show_product_images` (Check, default 0). Also a POS Settings single doctype `Maison POS Settings` with `show_product_images_default`, `scan_enabled`, `receipt_qr_enabled` (default 1), `receipt_qr_base_url` (default site url), `loyalty_lookup_enabled` (default 1). bootstrap returns `settings: {...}` merged (boutique overrides global).
Upload from the POS: whitelisted endpoint `catalog.upload_item_image(item_code, file)` (multipart; Maison Manager+ only) that saves via `frappe.get_doc({"doctype":"File", ...})` attached to the Item, sets `Item.image`, and returns the URL. Frontend: long-press / "Edit tile" action on a tile for Manager role opens a sheet with camera/file picker (`<input type=file accept=image/* capture=environment>`), client-side resize to ≤1200px JPEG before upload, queued if offline. Tiles show the image as the upper block with the name/price below when `show_product_images` is on; when off, tiles are exactly as today.

## 3. Barcode / QR scanning
Backend: custom field on Item `maison_barcode` (Data, unique, indexed) in addition to standard ERPNext `Item Barcode` child table; bootstrap returns `barcodes: {code: item_code}` including serial numbers (`serials` map) so scanning a serial label selects that exact serial. Seed: give every demo item an EAN-13 (deterministic) and every serial a Code-128 value = serial no.
Frontend: (a) keyboard-wedge scanner support: global key listener that captures fast bursts ending in Enter when focus is not in a text input → lookup in Dexie (barcode → item, serial → item+serial, customer QR `MC:<customer_id>` → attach client, invoice QR `INV:<name>` → open receipt) ; (b) camera scanning button in the Sell top bar and in Client lookup: use `BarcodeDetector` when available (Safari 17+/Chrome) with `@zxing/browser` fallback; full-screen scanner sheet with gold viewfinder. Unknown code → toast "Not in catalogue" with option to search.

## 4. iPhone-friendly layout
The PWA must work in portrait on phones ≥ 375px wide: top bar collapses to wordmark + status; category rail becomes horizontal chips; basket becomes a bottom sheet with a summary bar (items · total · "CHARGE") that expands; Pay/Receipt/Client screens single-column; touch targets ≥48px; safe-area insets (`env(safe-area-inset-*)`); manifest `orientation: any`; `apple-mobile-web-app-capable`, `apple-touch-icon` (generate a 180px gold "M" PNG), status bar style black-translucent. Test at 390×844 and 1366×1024.

## 5. Receipt QR
Backend: Sales Invoice custom field `maison_receipt_token` (Data, unique, set on submit: 16-char urlsafe). Whitelisted **guest** endpoint `sales.receipt(token)` → JSON of the receipt (no PII beyond what's printed; boutique, datetime, lines, totals, last4) and a guest web page `/r/<token>` (www route) rendering it in Monolith Gold style with a "Save to Apple Wallet / Add to contacts" free-text footer only if trivial — otherwise plain page. QR content = `<receipt_qr_base_url>/r/<token>`. Print Format `Maison Receipt` adds the QR (generate server-side as SVG data URI with `qrcode` lib or `pyqrcode` — add to pyproject deps, or pure-python `segno`). Frontend ePOS builder: emit `<symbol type="qrcode_model_2" level="M" width="5">` ESC/POS QR; the 80mm HTML receipt renders the QR via a small inline QR lib (e.g. `qrcode` npm) — same content.

## 6. Loyalty / client lookup in POS
Customer custom fields: `maison_client_number` (Data, unique, auto-assigned on insert as 8-digit, e.g. `MC` + 6 digits → the printed loyalty number), `maison_face_id` (Data, hidden — reserved). Seed assigns numbers. `customers.search(q)` matches client number, phone (digits-only, last 4 or more), email, name. `customers.lookup(code)` exact match on client number / phone / QR payload. Frontend: in Sell, the client card has a prominent "CLIENT №" input with numeric keypad on touch, scan button (client QR), and search; shows name, tier, points balance, points value, last visit, "redeem points" toggle; attach/detach. Receipt prints client number and points earned/balance. Dashboard feed shows client name when present.

## 7. Face recognition — scaffold only
Do NOT build recognition. Add `maison_face_id` field and an empty, clearly documented interface `frontend/src/recognition/provider.ts` (`identify(frame): Promise<{customer?: string, confidence}>`) with a `NullProvider`, plus a Settings toggle greyed out "Client recognition (camera) — coming soon". README section "Facial recognition: legal notice" covering BIPA (Illinois), CCPA, consent capture requirement; the feature must be opt-in per client with stored consent (`maison_face_consent` Check + datetime on Customer — add the fields now).

## Quality
Backend tests for: receipt token + guest endpoint, client number assignment + lookup, barcode map in bootstrap, upload_item_image permission. Frontend vitest for: scanner burst parser, barcode resolution, QR payload builders, phone-layout store logic. Playwright shots at 1366×1024 and 390×844 for Sell / Client / Pay / Receipt. Run the full existing suites.
