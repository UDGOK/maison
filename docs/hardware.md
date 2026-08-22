# Maison POS — handheld hardware (v0.4 A)

## Decision: Verifone V660p on Stripe Terminal

The primary handheld for boutiques is the **Verifone V660p** running **Stripe Terminal**:

| | V660p |
| --- | --- |
| Payments | Stripe Terminal (EMV chip, contactless, Apple/Google Pay, swipe); PCI-PTS 6 |
| Printer | **Built-in thermal printer, 58 mm paper, 384-dot head (~203 dpi)** |
| Display | 5.5" colour touch, 720×1440 |
| Battery | ≈ 10 h typical boutique day (hot-swappable) |
| Connectivity | Wi-Fi, optional 4G SKU, USB-C |
| Scanner | no camera/scanner — see *Scanning* |
| SDK | Stripe Terminal JS SDK (internet reader): `collectPaymentMethod` → `processPayment`, and `terminal.print(canvas)` for the printer |

Why the V660p and not a phone-only setup: the associate carries an iPhone running the Maison
PWA (the v0.2 phone layout) and the V660p is the **client-facing** device for the card tap and the
receipt, so the associate never hands their phone to the client. At a roaming station an iPad
drives the same reader.

### How the POS uses it

- **Charge**: `PayView` / `ExchangeView` call the shared driver from the printer store
  (`usePrinterStore().terminal()`), which discovers readers at the boutique's Stripe location,
  connects to the reader picked in Settings (`readers[].stripe_reader_id`) and runs
  `collectPaymentMethod(client_secret)` → `processPayment` → server `stripe_terminal.capture`.
- **Print**: the 80 mm receipt is re-laid out as a **384-px-wide monochrome canvas**
  (`frontend/src/printer/canvas.ts`: `buildReceiptLayout` → `renderReceiptCanvas`) and handed to
  `terminal.print(canvas)` when the connected reader is a `verifone_v660p` with `has_printer`.
  The layout is a pure model (positioned text runs, rules, QR) so it is unit-tested without a
  canvas; the bitmap is thresholded to pure black/white because thermal heads do not dither.
- **Route**: Settings → *Receipt route* is `auto` by default: reader printer → Epson ePOS over
  LAN (`printer_ip`) → browser print dialog. A failure on one route falls through to the next and
  `printer.lastError` explains why. Sales, credit notes (RETURN banner, CREDIT total, refund
  line, store credit, signature block) and exchanges use the same renderer.
- **Simulated reader**: without `VITE_STRIPE_PUBLISHABLE_KEY` the in-app `SimulatedReader` has
  a `has_printer` flag (driven by the boutique's reader row or `true` by default) and keeps the
  last bitmap in `window.__maisonLastReaderPrint` / `printer.lastReaderPreview` so the e2e run
  and the Settings "Test reader print" can inspect the canvas path.

## Alternative: Stripe Reader S710 + Epson TM-P20II

| | S710 | TM-P20II |
| --- | --- | --- |
| Role | card reader (no printer), 15 h battery, 6.1" touch, Wi-Fi / Ethernet dock | 58 mm belt printer, Wi-Fi, ePOS-Print XML |
| Pros | longest battery, bigger screen, cheaper than V660p when a printer already exists | uses the same `printer/epos.ts` builder as the counter TM-m30 |
| Cons | two devices on the belt; two batteries to charge | 58 mm paper width (ePOS 32 columns); extra Wi-Fi client |

Register an S710 as `device_type = stripe_s710`, `has_printer = 0`; the POS then routes receipts
to the TM-P20II through `printer_ip` automatically (the printer's IP can be overridden per device
in Settings).

## Why not Clover Flex

Clover Flex is **Fiserv-locked**: it only processes through Clover's own gateway/merchant
account, exposes no Stripe Terminal (or any third-party) SDK and its printer/scanner APIs are
only reachable from Clover-native Android apps. It cannot be paired to the Maison PWA / Stripe
account, so receipts, refunds (`PaymentIntent` refunds) and the card-present metadata the
backend stores (`maison_terminal_ref`, brand, last4) would not exist. Not compatible.

## Pairing steps (per reader)

1. In the Stripe dashboard create a **Location** per boutique and put its id in
   `Maison Boutique.stripe_location_id`.
2. Power the V660p, join it to the boutique Wi-Fi (WPA2-Enterprise supported) and generate the
   **pairing code** from its Settings screen; register it in Stripe → Terminal → Readers under
   the boutique location. Note the `tmr_…` reader id.
3. In the desk open the boutique → **Readers** table → add a row: label (e.g. *Counter 1*),
   Stripe reader id, device type `verifone_v660p`, *Built-in printer* ticked, serial number.
4. On each POS device: Settings → **Card reader** → pick the reader. The choice is stored per
   device (Dexie `reader_id`) and shown as "Reader prints" / "ePOS prints" / "Browser prints".
5. Tap **Test reader print** — a 384-px test receipt prints (or, with the simulated reader, a
   preview bitmap appears under the button).
6. Firmware/updates: Stripe pushes reader updates at the configured maintenance window; keep
   readers on the charger overnight.

`site_config.json` needs `stripe_secret_key` / `stripe_publishable_key` for live readers; without
them every Terminal endpoint (and refunds) is simulated.

## Multiple readers per boutique

`Maison Boutique.readers` (child table `Maison Boutique Reader`: label, stripe_reader_id,
device_type, has_printer, enabled, serial_number, notes) is the registry. `catalog.bootstrap`
ships it to the POS; the printer store offers the enabled rows, defaults to the first one, and
remembers the pick per device. Two associates can therefore each pair their iPhone to their own
V660p while the counter iPad uses a third. Disabled rows disappear from the picker without
losing history. The seed registers a V660p (*Counter 1*) and an S710 (*Roaming*) per boutique
with simulated ids so the flows are exercisable without hardware.

## Scanning

The V660p has no barcode camera. Scanning stays on the associate's phone camera
(`BarcodeDetector` / ZXing sheet) or a Bluetooth HID scanner (Socket Mobile S740, Zebra CS6080,
Inateck — see section J) through the keyboard-wedge parser; Returns and Cycle count register a
raw-code consumer (`scan.captureRaw`) so every scanned string lands in the active screen.
