# Maison POS — v0.3: Client Recognition (camera) — contract for backend + frontend agents

Read SPEC.md, SPEC_v0.2.md first. Additive; keep all suites green.

## Behaviour (product)
At the Sell screen a small "Recognition" tile (camera preview, gold frame) runs when `face_recognition_enabled` is on for the boutique and the device has a camera permission. The app detects the most prominent face, waits for a stable, good-quality capture (frontal, sharp, ≥120px face), computes an embedding ON DEVICE, and:
- **Match** (score ≥ threshold, consented client): the client card auto-populates with "Recognised · 94%" and a 5-second Undo; points/tier shown as usual. Recognition event logged.
- **No match**: a subtle "New client? Enrol" prompt appears. Tapping it opens the **Enrolment sheet**: phone OR email (required, used to find/create the Customer; if the phone/email already matches a Customer, link to it), optional name, then the **Consent screen** shown to the client (large type): one-paragraph consent text (versioned), "Agree" button requiring a deliberate press-and-hold 600ms or signature stroke, and "No thanks" (creates/links the Customer WITHOUT biometrics, so the sale still gets the client). On Agree → 3 embeddings captured over ~2s → enrolled → client attached.
- **Never** store face images; only embeddings (float32[128] or [512]) + a 64px thumbnail is NOT stored either. Store consent record. Never enrol without consent; never match against non-consented clients.
- Revocation: from Client screen (manager) "Delete biometric data" → purge templates, mark consent revoked, log. Retention: scheduled daily job purges templates for clients with no visit in `biometric_retention_months` (default 36) — BIPA requires a written retention policy; README includes the template policy.
- Works offline: the device caches embeddings ONLY for consented clients of its own boutique's company scope when `recognition_offline_cache` is on (default on). Enrolments made offline queue like sales and sync.

## Backend (maison_pos)
Doctypes:
- `Maison Face Template` (child of Customer, table field `maison_face_templates`): `embedding` (Long Text JSON float array), `model` (Data, e.g. "face-api/faceRecognitionNet@1"), `dims` (Int), `quality` (Float), `captured_at`, `boutique`, `device_id`, `consent` (Link → Maison Biometric Consent).
- `Maison Biometric Consent`: `customer`, `status` (Active/Revoked), `consent_text_version`, `consent_text` (snapshot), `method` (Hold-to-agree / Signature), `signature` (Attach Image, optional), `boutique`, `associate`, `device_id`, `captured_at`, `revoked_at`, `revoked_by`, `ip`. Customer fields already exist: `maison_face_consent` (Check) + add `maison_face_consent_at`; keep them in sync.
- `Maison Recognition Event`: `customer` (nullable), `boutique`, `device_id`, `score`, `outcome` (Matched/NoMatch/Enrolled/Undone/Declined), `sales_invoice` (nullable), `ts`. Used for audit + dashboard tile.
- `Maison POS Settings` additions: `face_recognition_enabled` (exists), `recognition_model` (Data), `match_threshold` (Float default 0.55 for euclidean-distance models — define clearly: the API accepts `score` 0–1 where higher is better; backend converts), `biometric_retention_months` (Int 36), `consent_text` (Text, default provided), `consent_text_version` (Data "2026-08-1"), `recognition_offline_cache` (Check 1). Maison Boutique: `face_recognition_enabled` override (Select: Inherit/On/Off).
API (`maison_pos.api.recognition`):
- `match(embedding: list[float], model: str, boutique: str) -> {matches: [{customer, customer_name, client_number, score, tier, loyalty_points}], threshold}` — server-side cosine similarity across Active-consent templates of same model; uses a process-level cache of (customer, vector) refreshed on template change (frappe.cache). Also logs a Recognition Event (outcome Matched/NoMatch).
- `enroll(embeddings: list[list[float]], model, quality: list[float], boutique, device_id, consent: {method, text_version, signature_data_url?}, customer?: str, phone?: str, email?: str, name?: str) -> {customer, client_number, consent, templates}` — finds Customer by `customer` or by phone/email (digits-normalised), else creates one; creates Consent + templates; sets customer flags; logs Enrolled.
- `decline(boutique, device_id, phone?, email?, name?) -> {customer}` — creates/links the Customer without biometrics; logs Declined.
- `templates(boutique, since?) -> {templates: [{customer, customer_name, client_number, embedding, model}], deleted: [customer...]}` — for offline cache; only if `recognition_offline_cache`; permission Maison Associate+.
- `revoke(customer, reason) -> {ok}` — Maison Manager+; purges templates, revokes consent, logs.
- `log_event(customer?, outcome, score?, sales_invoice?)` for Undone.
Scheduler: `maison_pos.tasks.purge_expired_biometrics` daily. Dashboard `live_summary` adds `recognition: {matched_today, enrolled_today}`.
Tests: match math + threshold, enroll creates customer by phone, decline path, revoke purges, retention purge, permissions.
Seed: no face templates (obviously); consent text default.

## Frontend (frontend/)
- Model: use `@vladmandic/face-api` (TF.js, WebGL/WASM) with `tinyFaceDetector` + `faceLandmark68Tiny` + `faceRecognitionNet` (128-d). Ship model weights under `frontend/public/models/` → built into `maison_pos/public/pos/models/` and precached by the service worker (they're ~6–7 MB total; OK). Lazy-load only when recognition is enabled. Must run on iPad Safari (WebGL) with a WASM fallback; detect at ~4 fps to keep the POS responsive; run in a Web Worker if feasible (OffscreenCanvas) — otherwise main thread with requestIdleCallback throttling.
- `src/recognition/provider.ts`: replace NullProvider with `FaceApiProvider` implementing `start(video) / stop() / on('candidate', {embedding, quality, bbox})`. Quality gate: detection score ≥0.8, face width ≥120px, landmarks roughly frontal (eye-line tilt < 15°, nose centred), and **liveness-lite**: require the embedding to be stable across 3 consecutive frames AND at least one blink or small head motion within 3s (basic anti-photo). Document that this is not certified liveness.
- Matching: local first against Dexie `face_templates` (cosine; threshold from settings), then server `recognition.match` when online; prefer server result if it disagrees with a higher score.
- UI: `RecognitionTile.vue` in the Sell client panel (camera preview 160px tall, gold viewfinder, state chip: Looking / Recognised / New client / Off); attaches client with toast "Recognised · 94% · Undo"; `EnrolSheet.vue` (phone/email/name, lookup existing), `ConsentScreen.vue` (full-screen, client-facing, large Jost text, hold-to-agree ring animation in gold, signature pad option, Decline); capture progress (3 samples); enrolment queued offline in Dexie `pending_enrolments` and replayed by sync.
- Client screen: biometric status line ("Face recognition: enrolled 12 Aug 2026 · Delete") with manager-only revoke.
- Settings: enable/disable per device, camera selection, show/hide preview, threshold slider (manager), and a "Test recognition" mode.
- Mock API supports match/enroll/decline/templates/revoke with in-memory vectors.
- Tests: cosine/threshold logic, quality gate, stability/liveness state machine (unit with synthetic sequences), enrolment queue replay, consent hold timing.
- E2E: Chromium fake camera: launch with `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file.y4m or .mjpeg>` using a synthetic face video generated from a public-domain portrait (e.g. fetch a CC0 portrait from Wikimedia/Unsplash source if network allows; else render a simple synthetic face with canvas — may not pass the detector; then fall back to injecting embeddings via a test hook `window.__maisonRecognitionTest.emit({...})`). Verify: enrol flow creates the customer + consent server-side; re-running with the same face/embedding auto-attaches; Undo; Decline path; revoke purges.

## Legal/ops deliverables (docs/)
`docs/biometrics-policy.md`: retention & destruction policy template, consent text (EN + ES), signage text for the boutique entrance ("This boutique uses facial recognition for client service with your consent"), BIPA/CCPA/TX/WA notes, DPIA-style risk list, and the rule that recognition is off by default per boutique and must be switched on by Head Office.
