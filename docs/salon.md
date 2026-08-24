# AWANZ Salon — the client-facing screen (v0.5 K)

A second iPad (an iPad mini at the counter, facing the client) runs the **Salon**: an ambient screen while
the boutique is quiet, "Are you a client of the house?" when a sale starts, a mirror of the basket as pieces
are set aside, the payment and the approval, and a thank-you with points, the receipt QR, private feedback and
the private-viewing invitation. Between sales the associate can switch it to **Concierge** mode, a guided
Q&A that turns waiting time into clienteling data (ring size on an on-screen sizer, wrist size, metal, style
cards, occasions → AWANZ Client Profile).

It is the same PWA bundle as the POS, served at `/salon` with its own layout, and it runs as a **guest**: the
Salon never holds an associate login — it holds a pairing session token.

## Pairing

1. POS → **Settings → Client display → Pair a client display**. The POS shows a 6-digit code, its QR
   (`MS:<code>`) and a 10-minute countdown (`salon.pairing_code`).
2. On the client-facing iPad open `https://<site>/salon` (add it to the Home Screen in guided access) and type
   the code on the keypad — or scan the QR — or open the deep link `https://<site>/salon?code=<code>`.
3. `salon.pair(code)` promotes the *Pending* `AWANZ Salon Session` to *Paired* and returns the session token
   (the document name, 32 random characters) plus the playlist and the boutique settings. The Salon stores the
   token in `localStorage` (`awanz.salon.session`) and survives reloads; the POS stores the session in Dexie.
4. A new code for the same POS device ends its previous session. Sessions expire after **12 h**
   (`salon.expire_sessions`, hourly) or on **Unpair** from either side.

Pairing codes live on the session row (`pairing_code`, `code_expires_at`), not in the cache — a
`clear_cache` (which a document save may trigger) cannot invalidate a code the associate is reading out.

## Transport

- **Realtime**: every state change / message is published to the session's document room
  (`frappe.publish_realtime(doctype="AWANZ Salon Session", docname=<token>)`). Both devices join it with
  `doc_subscribe`. Guest has *read* permission on the doctype so a Salon can subscribe to **exactly the one
  document whose token it holds**; `permission_query_conditions` returns `1=0` for Guest so sessions can never be
  listed (`/api/resource/AWANZ Salon Session` → `[]`), and `has_permission` denies anything but `read` of a
  named document. The POS also receives `salon_paired` in its user room when the Salon redeems the code.
- **Polling fallback**: the Salon calls `salon.state(token, since=seq)` every **2 s** (cheap: no payload when
  `seq` is unchanged); the POS calls `salon.pos_poll(session, since=inbox_seq)` every 2 s. The socket only makes
  it instant; nothing depends on it. On `bench serve` (port 8000) the clients talk to the socket.io process on
  port 9000 directly, as the dashboard does.
- The POS publishes with `salon.publish(session, event, payload)` — **debounced 150 ms**, coalesced, and skipped
  when the sanitised payload equals the last one sent. Events = screens: `idle · identify · client · basket · pay
  · approved · receipt · consent · feedback · concierge`.

## Screens (what the client sees)

| POS state | Salon view |
|---|---|
| locked, or nothing in the basket and no client | **Ambient** — wordmark, the hour, "Welcome to Oak Street", curated pieces floating in and out (`AWANZ Salon Playlist`, HQ-managed, per boutique or global) over the generative "light on metal" canvas |
| first piece added, no client · or the associate taps **Ask to identify** | **Identify** — phone / client № on a large keypad (digits masked while typing), e-mail, scan the client QR, **Join AWANZ**; "Meanwhile, your associate has set aside …" with *Not now — show my pieces* |
| client attached | **Welcome back, Mei-Lin** — tier, points, progress to the next tier, masked contact line |
| pieces in the basket | **Basket mirror** — the newest piece large (image or generated visual), name, metal/stones, serial №, certificate, price; the last four lines; subtotal / compliments / tax / total; points to be earned; **Ask about this piece** (→ CRM note + POS notice) |
| Pay screen | **Payment** — the amount; card: "Please present your card to the terminal" (reader animation) |
| sale finalised | **Approved** — gold pulse, 1.4 s before the receipt |
| Receipt screen | **Thank-you** — name, points earned, new balance / tier progress, receipt QR (as soon as the server issues the token), *Email my receipt* (e-mail on file, masked, or typed), **How was your visit?** (1–5 + note → `AWANZ Feedback`, HQ only), **private viewing invitation** (→ `AWANZ Client Profile.private_viewing_invite`), back to ambient after 20 s of quiet |
| Concierge toggle (client attached) | **Concierge** — ring sizer (true-size circle, 5.2 px/mm on iPad glass, US sizes 3–13), wrist chips, metal swatches, style cards (up to three), occasions + date → `crm` profile fields and a dated `style_notes` line |
| Join AWANZ on a boutique with recognition **On** | **Consent** — the v0.3 `ConsentScreen` (hold-to-agree 600 ms or signature, versioned text) shown on the Salon; the POS, which owns the camera, captures the three samples and enrols; without a running camera the Salon says "We will finish this at the counter" |

Design: Monolith Gold, quieter — Unbounded 300/400 for titles and numerals (tabular), Jost 300 body, 900 ms
gold cross-fades (`prefers-reduced-motion` → 200 ms, no drift, still ambient frame), no clutter, both 4:3
portrait (1024×1366) and landscape (1366×1024). Everything is ≥ 56 px to touch.

## Privacy

- The Salon only ever receives `first_name`, `client_number_masked` (`MC •• 284`), `phone_masked`
  (`•••• 0105`), `email_masked` (`m•••@example.com`), tier and points. `sanitize_state` strips `mobile_no`,
  `email_id`, `phone`, `email`, `address`, `birthday`, `anniversary`, `spouse_name` recursively from anything
  the POS publishes; `client_summary` is the only client shape on the wire. The same rules live in
  `frontend/src/salon/mask.ts` and are unit-tested on both sides.
- `identify` answers `{found: false}` without hints. Unknown tokens get a 403 with no detail.
- Rate limits per IP on the guest endpoints (pair 12/min, identify 30/min, sign-up 10/min, …).
- Nothing biometric is ever stored by the Salon: consent is handed to the POS (`consent_agreed`, with the
  signature fetched once by the POS through `salon.pending_consent`); "No thanks" logs a `Declined` event only.
- Sessions: 12 h, single POS ↔ single Salon, `Unpaired` / `Expired` rows are purged by the demo seed.

## API (`maison_pos.api.salon`)

| Caller | Method | Purpose |
|---|---|---|
| POS | `pairing_code(boutique, pos_device_id)` | 6-digit code, 10 min, QR `MS:<code>`, deep link |
| POS | `pos_status(boutique, pos_device_id, since)` | active session for this device + inbox |
| POS | `pos_poll(session, since)` | Salon → POS messages after `since` |
| POS | `publish(session, event, payload)` | set the Salon screen (sanitised, client summary injected) |
| POS | `pending_consent(session)` | the full consent (incl. signature) captured on the Salon, cleared on read |
| POS | `unpair_pos(session \| boutique+pos_device_id)` | end the session |
| Salon | `pair(code, salon_device_id)` | redeem a code → token, playlist, settings |
| Salon | `state(token, since)` | the mirror (`changed: false` when nothing moved) |
| Salon | `playlist(token)` | curated pieces + settings |
| Salon | `identify(token, code)` | phone / e-mail / client № / `MC:` QR → attaches the client on the POS |
| Salon | `signup(token, name, phone?, email?, birthday?, marketing_email, marketing_sms)` | create / link the Customer, marketing flags on the profile, attach |
| Salon | `consent(token, method, text_version, signature_data_url?)` / `consent_decline(token)` | recognition consent hand-off |
| Salon | `ask(token, question, item_code?)` | CRM interaction (Note) + POS notice |
| Salon | `feedback(token, rating, comment?)` | `AWANZ Feedback` for the mirrored receipt (one per invoice, low ratings alert the manager) |
| Salon | `invite(token, wants_invitation)` | profile flag + CRM note |
| Salon | `email_receipt(token, email?)` | e-mail the public receipt link (best-effort) |
| Salon | `preferences(token, answers)` | Concierge answers → Client Profile |
| Salon | `unpair(token)` | end the session from the Salon |

Salon → POS messages (`inbox`): `client_attached {customer, how: identify|signup, created, client}`,
`consent_agreed {customer, consent{method,text_version}, has_signature}`, `consent_declined`, `question
{question, item_code, item_name, interaction}`, `feedback {rating}`, `invite {wants_invitation}`,
`email_receipt {email_masked}`, `preferences {fields, styles, occasions}`.

## Doctypes

- **AWANZ Salon Session** — `boutique`, `pos_device_id`, `salon_device_id`, `status` (Pending / Paired /
  Unpaired / Expired), `pairing_code`, `code_expires_at`, `paired_by`, `paired_at`, `expires_at`, `last_*_seen`,
  `screen`, `state_seq`, `state` (JSON), `inbox_seq`, `inbox` (JSON), `pending_consent`, `customer`,
  `sales_invoice`. Name = token (hash, 32).
- **AWANZ Salon Playlist** (+ child **AWANZ Salon Playlist Item**: item, caption, image override, seconds,
  enabled) — `boutique` blank = global, `welcome_line`, validity window. The demo seed creates
  *AWANZ · House Selection* (global) and *Oak Street · Autumn Edit* (CHI-OAK).
- **AWANZ Client Profile** gains `private_viewing_invite` / `private_viewing_invite_on`.

## Frontend

```
frontend/src/salon/
  mask.ts        masking + sanitizeState (mirror of the server)
  reducer.ts     pure screen state machine (remote state + local sub-steps + timers)
  pairing.ts     code normalisation, TTL countdown, QR / deep-link parsing
  transport.ts   socket.io doc_subscribe + mock storage events
  ambient.ts     "light on metal" Canvas 2D animation (30 fps, paused when hidden, reduced-motion still frame)
  store.ts       Pinia `salonDevice` (token, polling, client actions)
  salon.css      the Salon's own type scale / buttons / keypad / transitions
  views/Salon*.vue, components/{SalonKeypad,ScanSheet,PieceVisual,RingSizer}.vue
frontend/src/stores/salon.ts        POS side: pairing, mirror (snapshot → publish, debounced), inbox handling
frontend/src/api/salon.ts           typed client + in-memory mock (localStorage "server" shared across windows)
frontend/src/components/SalonSettingsCard.vue, SalonBar.vue (basket client card), VirtualSalon.vue (dev)
```

`ConsentScreen.vue` accepts an optional `controller` so the Salon reuses it verbatim without the recognition
store. `cart.pointsEarned` now reads the collection factor from the client's tier row (`tiers[]`), which is how
the bench returns it — the real POS receipt used to show 0 points.

Mock mode (`VITE_MOCK=1`): Settings → **Show virtual salon** opens an iPad-mini pane running the real `/salon`
app in an iframe; the mock "server" lives in `localStorage` (`awanz.mock.salon`) and every window sees changes
through `storage` events, exactly like a second device through Frappe.

## Tests

- Backend `maison_pos/tests/test_v0_5_salon.py` (23): masking / sanitising, pairing (6 digits, single use,
  TTL, foreign boutique refused, new pairing ends the old session, 12 h expiry, Guest cannot list but can read its
  own document), mirror (sanitised state, client summary injected, unknown screen / foreign boutique refused,
  idle clears), identify by phone / client № / QR, sign-up (+ marketing prefs, linking on repeat, validation),
  consent hand-off (+ signature fetched once, decline logs), ask → interaction, preferences → profile, invite →
  flag, feedback → `AWANZ Feedback` (+ low-rating alert, duplicate, HQ summary), e-mail receipt, token required
  everywhere.
- Frontend `frontend/src/tests/salon.test.ts` (19): masking, reducer (sale walk, stale seqs, local attach,
  sign-up offer, thank-you timers, dismiss, unpair, concierge), pairing TTL helpers, publish debouncer, mock
  contract.
- E2E `e2e/salon.e2e.mjs` — two contexts against the bench (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
  BASE=http://maison.localhost:8000 ADMIN_PWD=admin node e2e/salon.e2e.mjs`, 32 checks, shots in
  `e2e/shots-salon/`, iPad 1024×1366 portrait with landscape captures): pair → ambient → first piece → identify
  by phone (masked keypad) → client on the POS → basket mirror (3 lines, focus piece, total, points) → ask → CRM
  note → cash pay → approved → thank-you (points, QR) → feedback → HQ → invitation → ambient → sign-up creates +
  attaches a new client → recognition consent (hold-to-agree; short press rejected) handed to a POS without a
  camera → concierge → profile → unpair → Salon back to pairing; guest cannot list sessions.

## Operations

- Add `/salon` to the Home Screen of the client-facing iPad, enable Guided Access, keep the display awake.
- Recognition consent on the Salon needs the boutique switch (`AWANZ Store.face_recognition_enabled`) and a
  POS with a running camera; otherwise the Salon records the consent hand-off and the associate finishes the
  enrolment from the client panel.
- Feedback is private to Head Office (`feedback.summary` / dashboard tile); ratings ≤ 2 alert the boutique
  manager as before.
- Playlists are edited in the desk (AWANZ Salon Playlist); a boutique-specific playlist comes before the global one.
