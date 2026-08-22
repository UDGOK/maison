# Maison POS — Biometric Data Policy (client recognition, v0.3)

Template policy for the optional camera-based client recognition feature of Maison POS.
Head Office legal must review and adapt it before the feature is switched on in any
boutique. Text in `[brackets]` is to be completed per company / jurisdiction.

## 1. Scope and default state

- Recognition is **off by default** for every boutique. `Maison POS Settings →
  Client recognition (camera)` is the master switch and only **Head Office** can change it;
  each `Maison Boutique` carries an override (`Inherit` / `On` / `Off`) so a single store can
  be excluded (e.g. a jurisdiction where the legal review is not complete).
- Only **consented clients** are ever enrolled or matched. A walk-in client who is not
  enrolled is never identified, scored or logged by name — a "no match" event carries no
  biometric data and no identity.
- The feature identifies a client for personalised service (client card, loyalty tier and
  points at the Sell screen). It is **never** used for security, surveillance, marketing to
  third parties, age or emotion estimation, or any automated decision with legal effect.

## 2. What is collected and what is not

| Stored | Not stored |
| --- | --- |
| A face **template**: a 128‑ or 512‑dimensional float vector produced on the device by the model named in `recognition_model` (default `face-api/faceRecognitionNet@1`), 3 captures per enrolment | Photographs or video frames — the camera stream never leaves the device and is never written to disk, not even as a thumbnail |
| The **consent record**: text version + snapshot of the wording shown, method (hold‑to‑agree / signature stroke), boutique, associate, device, timestamp, IP | Signature images are optional; when used they are stored as a private file attached to the consent record |
| **Recognition events**: outcome (Matched / NoMatch / Enrolled / Undone / Declined / Revoked / Purged), score, boutique, device, linked invoice | Templates of anyone who declined (`Declined` creates/links the client record *without* biometrics) |

Templates live as `Maison Face Template` rows on the Customer; they are linked to exactly
one `Maison Biometric Consent` and are deleted together with it.

## 3. Retention and destruction schedule (BIPA §15(a))

Maison permanently destroys a client's face templates at the **earliest** of:

1. the client withdrawing consent (any boutique manager can do this from the Client screen
   — "Delete biometric data" — or Head Office from the Customer record);
2. **[36] months** without a visit (`biometric_retention_months`; "visit" = a submitted POS
   sale for that client; a client who enrolled but never purchased ages from the consent
   date). A scheduled job (`maison_pos.tasks.purge_expired_biometrics`) runs **daily** and
   destroys expired templates, revokes the consent with reason "Retention policy" and logs a
   `Purged` event;
3. the purpose for collection being satisfied or the feature being discontinued at the
   company, in which case all templates are destroyed within 30 days;
4. any shorter period required by law.

Destruction means deletion of the template rows from the production database; backups
expire on the normal rotation (**[30] days**). Consent records and event logs are retained
(without biometric data) for **[3] years** as evidence of compliance, then deleted.

This schedule is published on `[maison.example/privacy/biometrics]` and displayed at every
boutique where the feature is active.

## 4. Consent wording

Consent must be obtained **before** the first capture. The POS shows the text below
full‑screen to the client, who agrees with a deliberate 600 ms press‑and‑hold or a signature
stroke; "No thanks" is equally prominent and still creates the client record so the sale is
never blocked. Every consent stores the `consent_text_version` — bump the version in
settings whenever the wording changes; the POS refuses enrolments made with an outdated
version.

### English (`consent_text_version` 2026-08-1)

> I agree that Maison may create and store a mathematical template of my facial features (a
> "face template") so that this boutique can recognise me and offer personalised service
> when I visit. No photograph or video of my face is kept; only the template. Maison will
> not sell, lease or trade my face template, will not use it for any purpose other than
> identifying me as a client, and will permanently destroy it when I withdraw my consent,
> when I have not visited a Maison boutique for 36 months, or sooner if required by law —
> whichever comes first. I may withdraw this consent at any time by asking any boutique
> manager or by writing to privacy@maison.example. Maison's Biometric Data Retention and
> Destruction Policy is available at every boutique and on maison.example/privacy/biometrics.

### Español (misma versión 2026-08-1)

> Acepto que Maison cree y conserve una plantilla matemática de mis rasgos faciales (una
> "plantilla facial") para que esta boutique pueda reconocerme y ofrecerme un servicio
> personalizado cuando la visite. No se conserva ninguna fotografía ni vídeo de mi rostro;
> únicamente la plantilla. Maison no venderá, alquilará ni intercambiará mi plantilla
> facial, no la utilizará para ningún fin distinto de identificarme como cliente y la
> destruirá de forma permanente cuando retire mi consentimiento, cuando no haya visitado
> una boutique Maison durante 36 meses o antes si la ley lo exige, lo que ocurra primero.
> Puedo retirar este consentimiento en cualquier momento dirigiéndome a cualquier gerente
> de boutique o escribiendo a privacy@maison.example. La Política de Conservación y
> Destrucción de Datos Biométricos de Maison está disponible en todas las boutiques y en
> maison.example/privacy/biometrics.

## 5. Boutique entrance signage

Post at every public entrance of a boutique where recognition is on (≥ A5, eye level; NYC
requires "clear and conspicuous" signage near every entrance):

> **This boutique uses facial recognition for client service — only with your consent.**
> Enrolled clients are recognised so we can greet them and show their loyalty benefits. We
> do not keep photographs or video; only a mathematical template, and only if you opt in.
> Nothing is collected from visitors who have not enrolled. You can withdraw at any time.
> Policy: maison.example/privacy/biometrics · privacy@maison.example

> **Esta boutique utiliza reconocimiento facial para la atención al cliente — solo con su
> consentimiento.** … (same text in Spanish where appropriate)

## 6. Jurisdiction notes (not legal advice)

| Jurisdiction | Key obligations | How Maison POS supports them |
| --- | --- | --- |
| **Illinois — BIPA** (740 ILCS 14) — e.g. `CHI-OAK` | Written informed consent before collection; public written retention/destruction policy; no sale/lease/trade; no profit; reasonable security; statutory damages per violation (private right of action) | Consent record with text snapshot + method; this policy; daily purge; templates never leave Maison systems; `revoke` available to managers |
| **California — CCPA/CPRA** | Biometric data is *sensitive personal information*: notice at collection, "Limit the use of my sensitive PI" right, right to delete, right to know | Signage + consent text = notice; `revoke` = delete; consent/events exportable from the desk for access requests |
| **Texas — CUBI** (Bus. & Com. Code §503.001) | Notice + consent before capture; no sale except narrow exceptions; destroy within a reasonable time, max 1 year after the purpose expires; AG enforcement | Same flow; retention ≤ 36 months with inactivity rule — legal to confirm the "purpose expires" reading |
| **Washington — RCW 19.375** | Notice, consent, or mechanism to prevent commercial use; retention no longer than reasonably necessary; reasonable care | Same flow; retention policy |
| **New York City — Admin. Code §22-1201** | Conspicuous signage at commercial establishments collecting biometric identifier information; no sale/sharing | Signage text above (§5) |
| **Portland OR, Baltimore** | Municipal bans on private use of facial recognition in places of public accommodation | Keep those boutiques on `Off` — do not enable |
| **EU/UK GDPR** (if ever deployed there) | Special-category data (Art. 9): explicit consent, DPIA mandatory, DPO consultation | DPIA section below; explicit consent flow |

## 7. DPIA-style risk register

| # | Risk | Likelihood / impact | Mitigation |
| --- | --- | --- | --- |
| 1 | Enrolment without valid consent (associate pressure, client misunderstanding) | Med / High | Client-facing full-screen consent in large type; hold-to-agree or signature; "No thanks" equally prominent and never blocks the sale; consent text version enforced server-side; associate identity stored on the consent |
| 2 | Matching against non-consented people | Low / High | Server matches only templates with an **Active** consent and `maison_face_consent = 1`; offline cache receives the same subset; no image is stored so nothing else can be matched |
| 3 | False match attaches the wrong client (privacy leak of loyalty balance / history) | Med / Med | Euclidean distance on raw descriptors < 0.6 (the model's published operating point; cosine is not used because face-api descriptors are not unit vectors); top match only; 5‑second Undo logged as `Undone`; tile shows the score; managers can tighten (lower) the threshold |
| 4 | Spoofing with a photo | Med / Low (service benefit only) | Liveness‑lite on device (stability + blink/motion) — **not certified liveness**; no payment, discount or security decision relies on recognition |
| 5 | Template theft (database breach, device loss) | Low / High | Templates are non-reversible vectors tied to one model; private DB; HTTPS only; device cache only for consented clients when `recognition_offline_cache` is on — disable it for high-risk sites; templates can be wiped fleet-wide by turning the cache off |
| 6 | Retention beyond purpose | Low / High | Daily purge; inactivity window; purge events logged |
| 7 | Bias / unequal accuracy across demographics | Med / Med | Feature is assistive only; associates can always search manually; monitor `NoMatch` vs `Matched` ratios per boutique on the dashboard; revisit model choice |
| 8 | Signage missing in a new boutique | Med / High (NYC, BIPA) | Recognition stays `Off` per boutique until Head Office confirms signage + legal review (checklist below) |
| 9 | Model change invalidates templates or alters the threshold | Low / Med | Templates store `model` + `dims`; matching is per model; changing `recognition_model` means re-enrolling everyone (old templates are never matched) |
| 10 | Consent text changed without versioning | Low / Med | `consent_text_version` required and checked; each record snapshots the text |

## 8. Switch-on checklist (per boutique, Head Office)

1. Legal review for the boutique's state / city complete (§6); not in a banned municipality.
2. Signage installed at every entrance (§5) and photographed for the compliance file.
3. This policy published and linked from the receipt footer / website.
4. Associates trained: consent is the client's choice, never a condition of service.
5. `Maison POS Settings → Client recognition` on (global) and boutique override set to
   `On` (or `Inherit`), threshold left at 0.55 unless tested otherwise.
6. Record the switch-on date in the compliance file; review yearly.

## 9. Handling requests

- **Withdrawal / deletion**: manager opens the Client screen → "Delete biometric data"
  (`recognition.revoke`). Confirms: templates deleted, consent `Revoked`, Customer flag
  cleared, `Revoked` event logged. Devices drop the client from their offline cache on the
  next `templates` sync. Confirm to the client in writing within 30 days.
- **Access request**: export the `Maison Biometric Consent` and `Maison Recognition Event`
  records for the customer from the desk; the template vector itself is not meaningful to a
  person but can be provided on request.
- **Breach**: follow the company incident plan; biometric data breaches are notifiable in
  most US states — revoke and purge affected templates and force re-enrolment.
