# Scanners — v0.4 section J

The POS resolves scanned codes in two ways (v0.2): a **keyboard-wedge** listener (any HID
scanner that types the code and ends with Enter/Tab) and the **camera** scanner
(`BarcodeDetector` / ZXing fallback). The Verifone V660p / Stripe S710 readers have **no**
barcode camera — use the phone/iPad camera or a Bluetooth scanner.

## Supported Bluetooth HID scanners (tested with the wedge parser)

| Scanner | Mode to use | Notes |
| --- | --- | --- |
| Socket Mobile S740 / S720 / S700 | **Basic mode (HID)** — scan the "Basic Mode" command barcode from the Socket guide, *not* Application Mode (SocketCam/Capture SDK). | iPad / iPhone pair from Settings → Bluetooth. Default suffix = Enter (CR). Inter-character delay is fine (< 20 ms). To keep the on-screen keyboard available on iOS, enable "HID soft keyboard toggle" (double-press the power button). |
| Zebra CS6080 / CS4070 | **HID keyboard (Bluetooth HID profile)** — scan the "HID Bluetooth Classic" pairing barcode from the Product Reference Guide. | Default terminator = Enter; can be programmed to Tab (*"Scan Data Transmission Format / Suffix 1 = Tab"*) — set **Terminator = Tab** or *both* in Settings. For long Code-128 serial labels, set the CS6080 "Inter-character delay" to 0–10 ms. |
| Inateck BCST-70 / BCST-60 / P6 | **HID** (default). | Default suffix CR; supports adding a prefix (e.g. `~`) via the manual's setup barcodes. Set the same prefix in Settings so it is stripped. Some firmware sends `CR LF` — trailing CR/LF are ignored automatically. |
| Any USB / Lightning HID scanner (e.g. Honeywell Voyager 1202g, Zebra DS2208) | Keyboard wedge. | Works through the iPad camera connection kit; same configuration. |

Label symbologies used by Maison: **EAN-13** on item tickets (`Item.maison_barcode`),
**Code-128** on serial labels (value = serial number), **QR** on client cards (`MC:<id>`),
receipts (`/r/<token>` URL) and coupons (`CPN:<code>` or the bare code).

## How the wedge listener works (`src/scan/wedge.ts`, `src/scan/affixes.ts`)

1. Key events are collected while focus is **not** in a text field. A burst is accepted as a
   scan when characters arrive ≤ 50 ms apart (humans are slower), the code is ≥ 4 chars and
   the burst ends with the configured **terminator** within 1.5 s.
2. The configured **prefix** and **suffix** are stripped (`stripAffixes`), plus any stray
   `\r`, `\n`, `\t`. Escapes accepted in Settings: `\r`, `\n`, `\t`, `<CR>`, `<LF>`, `<TAB>`;
   `<STX>`/`<ETX>` are ignored (they never reach the browser as characters).
3. The code is resolved (barcode → item, serial → item + serial, `MC:` → client, `/r/` URL →
   receipt, `CPN:` → coupon when the Promotions sheet is open).

Settings → **Scanner** (device-level, stored in Dexie `settings.scanner`):

- **Prefix / Suffix / Terminator** (Enter, Tab, or both — default both).
- **Scanner test** field: tap it and scan any label; it shows the decoded code, what it
  resolves to, the raw string, character count, burst duration, maximum inter-character gap
  and the terminator key. If the max gap is > 50 ms the wedge will treat the scan as typing —
  lower the scanner's inter-character delay.

The same device setting is honoured by the Returns lookup and Cycle count screens because all
raw scans flow through `useScanStore().handle()`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Scan types into the search box instead of adding the item | Focus is in a text field; tap outside it (the wedge deliberately ignores text inputs) or use the camera button. |
| "Not in catalogue" although the label is correct | Check the Scanner test: a leading/trailing character means a prefix/suffix is configured on the scanner — enter it in Settings. |
| Nothing happens on scan | Terminator mismatch (scanner sends Tab, Settings = Enter only) or the burst is slower than 50 ms/char. |
| iPad keyboard disappears when the scanner is paired | iOS hides the soft keyboard for HID devices — use the scanner's keyboard-toggle barcode, or the Maison numeric keypads (client №, PIN) which are on-screen buttons. |
| Camera scanner not available | Safari < 17 lacks `BarcodeDetector`; the ZXing fallback needs camera permission (Settings → Safari → Camera). |
