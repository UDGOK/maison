# Clienteling (CRM) — v0.4 section B

AWANZ keeps the jewelry-specific client data on its own doctype and uses **Frappe CRM**
(`crm` app, v1.81 on Frappe v15) for the people/tasks layer. Nothing here requires CRM to be
installed: the glue feature-detects it (`maison_pos.api.crm.crm_installed()`) and degrades to the
AWANZ doctypes alone.

## Data model

| Doctype | Purpose |
| --- | --- |
| `AWANZ Client Profile` (name = Customer) | ring_size, wrist_size, metal_preference, birthday, anniversary, spouse_name, style_notes, preferred_associate, preferred_boutique, `vip_tier_override` (Manager+), do_not_email / do_not_sms / do_not_phone, `crm_contact` (standard Contact linked to the Customer — what Frappe CRM lists), child table **wishlist** (`AWANZ Wishlist Item`: item_code, notes, added_by/on, fulfilled, fulfilled_on, fulfilled_invoice, hidden `alerted_on`). Created lazily on first `crm.profile` call. |
| `AWANZ Client Interaction` | timeline row: type (Note / Call / Email / SMS / Visit / Follow-up / Wishlist match / Birthday), note, boutique, associate, ts; with a `follow_up_date` it is an open **follow-up** (status Open / Done / Cancelled). Mirrored to `CRM Task` (`crm_task`) when the CRM app is installed and to a Frappe Comment on the Customer (desk timeline). |
| Owned pieces | computed from submitted Sales Invoices with serial numbers (returns remove the piece) — `crm.owned_pieces`. |

Loyalty tiers are also mirrored as **Customer Groups** (`Collector`, `Connoisseur`, `Patron`)
by `setup.install_v04_crm.ensure_tier_customer_groups()` so Pricing Rules can target a tier.

## Endpoints (`/api/method/maison_pos.api.crm.*`, AWANZ roles)

| Endpoint | Notes |
| --- | --- |
| `profile(customer)` | `{customer (search row shape + effective tier), profile{…}, wishlist[], owned_pieces[], follow_ups[], interactions[], loyalty (tier progress, see promotions), next_best_offer[] (section H when present), crm{installed, contact}, can_edit_tier}` |
| `update_profile(customer, values)` | Any profile field; `vip_tier_override` needs AWANZ Manager+ (`PermissionError` otherwise); unknown keys → `ValidationError`. |
| `wishlist_add(customer, item_code, notes?)` / `wishlist_remove(customer, item_code? \| row?)` | Returns the wishlist. |
| `tasks(customer?, boutique?, associate?, include_done?)` | Open follow-ups. Without `customer`: managers see their boutique, associates their own assignments, HQ everything. |
| `interactions(customer, limit)` | Timeline, newest first. |
| `log_interaction(customer, type, note?, follow_up_date?, sales_invoice?)` | Creates the row (+ CRM Task + Comment). |
| `complete_task(name, status=Done)` | Also updates the CRM Task. |
| `wishlist_matches(boutique?, limit)` | Dashboard tile: open "Wishlist match" follow-ups of the last 30 days. |
| `upcoming_dates(boutique?, days=30)` | Birthdays / anniversaries coming up (clienteling reminders). |

Hooks: Sales Invoice `on_submit` → `crm.fulfil_wishlist_on_sale` (ticks wishlist rows for
items bought); Stock Entry `on_submit` → `crm.on_stock_entry_submit` → `wishlist_matches_for`
creates a *Wishlist match* follow-up for the preferred associate (else the boutique managers),
a Notification Log, publishes `maison_wishlist_match` on the dashboard room, 30-day cooldown per row.

## POS

Client screen → **Clienteling** tab (`ClientProfilePanel.vue`): tier progress, profile facts,
style notes, edit form (contact flags, manager-only VIP tier), wishlist (add from catalogue,
"Basket" adds the piece — first free serial for serialized items, remove), owned pieces
(serial, certificate, boutique, date), follow-ups (mark done, new follow-up), log interaction.
The last payload is cached in Dexie (`settings["profile:<customer>"]`) so the panel renders
read-only offline. The basket client card shows the tier progress bar (`TierProgress.vue`).

Mock mode (`VITE_MOCK=1`): `src/api/v04.ts` ships profiles for CUST-0001/0002/0006/0007 with
wishlists and two owned pieces; everything persists in `localStorage["awanz.mock.v04"]`.

## Frappe CRM notes

- Install: `bench get-app crm --branch main` (README compatibility table: main/v1.x supports
  Frappe v15 and v16); `bench --site <site> install-app crm`. Installed here: **crm 1.81.2**.
- We do **not** create CRM Leads/Deals for retail clients; CRM shows them as Contacts
  (linked to the Customer) and the follow-ups as CRM Tasks (`reference_doctype = Customer`).
- `/crm` (the CRM UI) is available to users with the *Sales User* role; AWANZ managers get
  it through the seed roles.
