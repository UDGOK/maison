# Campaign attribution & associate KPIs — v0.5 section M

Closes the loop between marketing sends (any tool) and POS sales. Nothing here depends on a
specific e-mail/SMS provider: touches arrive through signed webhooks (Klaviyo, Brevo), from a
Frappe *Email Campaign*, from a CSV export round-trip, or by hand (event guest lists).

## Data model

| Doctype | Purpose |
| --- | --- |
| `Maison Campaign` (name = `campaign_code`, the UTM code) | title, channel (Email / SMS / Event / Private viewing), status, send_date, content_link, coupon (→ `Maison Coupon`), cost; **segment**: `segment_tier`, `segment_boutique`, `segment_signal_type`, `segment_item`, `segment_item_group`, `segment_months` (AND-ed; blank = everyone); **featured pieces** child table (`Maison Campaign Item`) → item-level attribution; **rule**: `direct_window_days` (14), `assisted_window_days` (30); provider ids `klaviyo_campaign_id`, `brevo_campaign_id`, `email_campaign`; nightly counters `sends / opens / clicks / attributed_direct / attributed_assisted / buyers / last_attributed_at`. |
| `Maison Campaign Touch` | one row per (campaign, customer): channel, `sent_at`, `opened_at`, `clicked_at`, source (Frappe Email Campaign / Klaviyo / Brevo / Manual / Seed), `external_id`, email. Upserted — a click back-fills open + send. |
| `Maison Campaign Attribution` | one row per (invoice, campaign) written by the nightly job: `type` Direct / Assisted, `amount`, `invoice_total`, `item_level`, `item_codes`, `touch`, `touch_at`, `days_to_sale`, `posting_date`, `boutique`, `associate`, `customer`. Boutique-scoped for managers (`permission_query_conditions`). |

## Attribution rule (`maison_pos/campaigns/attribution.py`)

Per sale (submitted POS invoice, not a return, identified client):

1. **Candidates** = the client's touches whose *touch time* (latest of click / open / send that is
   not after the sale) is within the campaign's **assisted window** (30 d). One candidate per
   campaign (its latest touch).
2. **Direct** (last-touch) = the most recent candidate inside its **direct window** (14 d) — the
   full invoice net.
3. **Item-level rule** — a candidate whose campaign *featured* a piece in the basket beats rule 2
   (most recent such candidate wins anywhere inside the assisted window) and is credited only for
   the featured lines (`item_level = 1`, `amount` = net of those lines).
4. Every other candidate is **Assisted** (full invoice net, or the featured lines when it featured a
   basket item). No candidate → nothing.

Windows are per campaign (defaults 14 / 30, validated `1 ≤ direct ≤ assisted`). The job is
idempotent: it replaces rows for the invoices in its window (default = longest assisted window +
1 day, rolling) and drops rows whose invoice was cancelled. `attribute_invoice()` is pure and
unit-tested (`tests/test_v0_5_campaigns.py`).

Scheduler: `daily` → `maison_pos.campaigns.attribution.nightly`. On demand:
`bench --site X execute maison_pos.campaigns.attribution.run_attribution --kwargs '{"from_date": "2026-07-01"}'`
or `POST campaigns.run_attribution`.

## Endpoints — `/api/method/maison_pos.api.campaigns.*`

| Endpoint | Who | Returns |
| --- | --- | --- |
| `list_campaigns(status?, channel?, limit=100)` | Manager+ | `[CampaignRow]` |
| `get(campaign)` | Manager+ | `CampaignRow + {featured_items: [{item_code, item_name}], notes, klaviyo_campaign_id, brevo_campaign_id, email_campaign}` |
| `performance(campaign?, from_date?, to_date?, boutique?, channel?)` | Manager+ (scoped managers see only their boutique's attributed sales) | `{from_date, to_date, boutique, campaigns: [PerfRow], totals: Totals, last_run}` |
| `attributed_sales(campaign, limit=100, boutique?)` | Manager+ (scoped) | `[{name, sales_invoice, customer, type, amount, invoice_total, item_level, item_codes, posting_date, boutique, associate, touch_at, days_to_sale}]` |
| `segment(campaign, limit?)` | HQ / Regional | `{campaign, count, customers: [SegmentRow]}` (also stores `segment_size`) |
| `export_segment(campaign, format="csv"\|"email_group")` | HQ | CSV download (`client_number, customer_name, email, mobile, tier, boutique, preferred_associate, utm_campaign, coupon`) or `{email_group: "Campaign <code>", added, members, segment}` (Frappe *Email Group* usable by Newsletter / Email Campaign) |
| `record_touch(campaign, customer, event="sent"\|"opened"\|"clicked", ts?, source?)` | HQ / Regional | `{touch, campaign, customer, event}` — event / private-viewing guest lists |
| `sync_email_campaign(campaign)` | HQ | touches from the linked Frappe Email Campaign's Email Queue (`{campaign, received, recorded, unmatched}`) |
| `run_attribution(from_date?, to_date?, campaign?)` | HQ / System Manager | job summary `{from_date, to_date, invoices, attributed_invoices, rows, direct, assisted, campaigns: {code: {direct, assisted, rows}}}` |
| `webhook_klaviyo(campaign?)` / `webhook_brevo(campaign?, token?)` | **guest, signed** (POST) | `{ok, provider, received, recorded, unmatched: [{event, email, campaign_ref, reason}]}`; 403 on a bad / missing signature or when no secret is configured |

Shapes:

```
CampaignRow = {name, title, campaign_code, channel, status, send_date, content_link, coupon, cost,
               segment_tier, segment_boutique, segment_signal_type, segment_item, segment_item_group, segment_size,
               direct_window_days, assisted_window_days,
               sends, opens, clicks, open_rate, click_rate,            # rates 0–1
               attributed_direct, attributed_assisted, attributed_revenue, buyers, roi | null, last_attributed_at}
PerfRow     = CampaignRow + {invoices_direct, invoices_assisted, item_level_rows, conversion (buyers/sends), revenue_per_send}
               # attributed_* / buyers / invoices_* honour the from/to/boutique filters; sends/opens/clicks are campaign-wide
Totals      = {campaigns, sends, opens, clicks, buyers, attributed_direct, attributed_assisted, attributed_revenue, cost,
               invoices_direct, invoices_assisted, open_rate, click_rate, roi | null}
SegmentRow  = {customer, customer_name, email, mobile, client_number, tier, boutique, preferred_associate}
roi         = (attributed_direct − cost) / cost   (null when no cost)
```

Dashboard "Campaign performance" card (Clients / Insights tab): call `performance()` (optionally
`from_date`/`to_date` = the tab's period) and render `campaigns[]` with `totals`; drill-down with
`attributed_sales(campaign)`. Desk report: **Maison Campaign Performance** (Script Report, same
numbers, bar chart direct vs assisted, filters sales from/to, boutique, channel, campaign).

## Segment builder (`maison_pos/campaigns/segments.py`)

`build_segment(campaign)` AND-s: tier (effective loyalty tier from spend within the program window,
profile `vip_tier_override` wins), boutique (profile `preferred_boutique` **or** boutique of the last
POS sale), item affinity (bought `segment_item` / from `segment_item_group` in the last
`segment_months`, default 24), signal type (open `Maison Client Signal`). Always excludes walk-in
customers, disabled customers, clients without an e-mail (Email) / mobile (SMS), and clients who
opted out of the channel (`do_not_email` / `do_not_sms` / `do_not_phone` for Event & Private viewing).

## Webhooks (`maison_pos/campaigns/webhooks.py`)

Secrets live in `site_config.json`: `klaviyo_webhook_secret`, `brevo_webhook_secret`.

* **Klaviyo** — point the webhook at `/api/method/maison_pos.api.campaigns.webhook_klaviyo`; the
  endpoint verifies `Klaviyo-Signature` = HMAC-SHA256(raw body, secret) (hex or base64; a
  `t=…,v1=…` value and `Klaviyo-Timestamp` replay check ±5 min are understood). Events
  `Received Email|SMS`, `Opened Email`, `Clicked Email|SMS`; campaign from
  `event_properties.utm_campaign | campaign_code | campaign_id | $message` matched to
  `campaign_code` or `klaviyo_campaign_id`; profile by e-mail / phone.
* **Brevo** — Brevo does not sign payloads; send either `X-Brevo-Signature` (HMAC as above) **or**
  the secret as a custom header `X-Brevo-Token` (or `?token=`). Events `delivered|request|sent`,
  `opened|unique_opened`, `click`; campaign from `camp_id | tags[0] | X-Mailin-custom` matched to
  `brevo_campaign_id` / `campaign_code`.
* Both accept `?campaign=<code>` as a default when the payload carries no campaign reference.
* Unmatched events are reported back (`unmatched[]`) and not stored.

Closing the loop from any other tool: `export_segment(csv)` → import the list into the tool with
`utm_campaign` = the campaign code → after the send, POST the provider's events (or
`record_touch` from a CSV of recipients) → nightly attribution.

## Associate performance — `hr.employee_performance(boutique?, from_date?, to_date?, follow_up_days=30)`

Manager+ (managers: own boutique). One row per associate, sorted by net sales:

```
{associate, associate_name, boutique,
 sales (net of returns), gross_sales, tickets, avg_ticket, boutique_avg_ticket, avg_ticket_vs_boutique (ratio | null),
 with_client, clients_identified_per_sale (= conversion, 0–1),
 returns, returns_amount, returns_rate (returns ÷ tickets; a return counts against the original seller),
 follow_ups_assigned, follow_ups_done, follow_up_rate (done ÷ assigned, follow-ups created in the last follow_up_days | null),
 recognition_enrolments (biometric consents captured by the associate in the period), commission}
```

## "Assign call" — `insights.assign_call(signal, associate?, due_date?, note?)`

Every **VIP lapsing** signal now has an owner: `preferred_associate`, else the boutique manager
(`insights.client_signals.signal_owner`). `assign_call` creates a *Call* follow-up
(`Maison Client Interaction`, due in 2 days by default) mirrored to a **CRM Task** assigned to the
associate, and stamps `assigned_associate / assigned_at / call_task / crm_task` on the signal
(returned by `insights.client_signals`). Returns
`{ok, signal, customer, associate, associate_name, task, crm_task, due_date}`. Permissions: any
Maison role; scoped users only for their boutique's signals and its associates; associates only to
themselves; re-assigning cancels the previous open call.

## Seed

`maison_pos.setup.demo_v05_campaigns.seed_v05_campaigns()` (called from `demo.seed()`): campaigns
`SUMMER-TIMEPIECES` (Email, featured TP-001/005/006, today − 40 d), `PATRON-VIEWING` (Private
viewing, tier Patron, today − 21 d), `BRIDAL-SMS` (SMS, Bridal buyers at Oak Street, coupon
BRIDAL500, today − 9 d). Touches are created for a deterministic share of the clients who bought
inside each campaign's window (so they line up with `seed_history` invoices) plus segment members
who did not, then attribution runs for the last 45 days. Re-runnable.
