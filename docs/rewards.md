# CloudChaserz Rewards (v0.6 Q)

The loyalty programme the client asked for, built on ERPNext's Loyalty Program plus the v0.4
coupon / campaign machinery. Public page: **`/rewards`**. The Salon "Join" flow and the POS
"Redeem" sheet use the same copy, so the customer reads the same words on the web, on the client
display and on the receipt.

Related: `docs/campaigns.md`, `docs/webshop.md`, `docs/cloudchaserz.md`, `SPEC_v0.6.md` section Q.

---

## 1. The programme

> **Earn 1 point for every $1 you spend.** Redeem your points for money off at the counter, get a
> birthday gift, hear about every monthly promotion and new arrival first, enter product giveaways
> and receive exclusive event invites.

| | |
|---|---|
| Earning | **$1 = 1 point** |
| Redemption | **$5 off at 100 points · $10 off at 200 · $15 off at 300** |
| Stacking | one reward per transaction (setting `reward_allow_stacking` allows more) |
| Balance | never negative; reversed when a sale is returned |
| Expiry | points do not expire while the account is active |

### The two ERPNext rates — do not mix them up

ERPNext splits earning and redemption across two different fields, and they mean opposite things:

| Field | Meaning | CloudChaserz |
|---|---|---|
| `Loyalty Program Collection.collection_factor` | **currency per point earned** | `1.0` → $1 = 1 point |
| `Loyalty Program.conversion_factor` | **currency value of one point when redeemed** | `0.05` → 100 points = $5 |

Every tier is worth $0.05 a point ($5/100 = $10/200 = $15/300), so a single `conversion_factor` of
`0.05` keeps the general ledger consistent with the tier table. Setting it to `1.0` makes ERPNext
value 100 points at $100 and refuse the redemption with *"You can't redeem Loyalty Points having
more value than the Total Amount."*

### Points are earned on the net amount

ERPNext accrues on `grand_total - loyalty_amount` — i.e. **including** sales tax. The programme (and
the copy on `/rewards`) promises $1 = 1 point on what the client spends on goods, so
`rewards.rebase_points_on_net` re-prices the accrual entry onto `net_total` in the Sales Invoice
`on_submit` hook, after ERPNext has written it. Without it a Houston sale would hand out 8.25% more
points than advertised, and a Sapulpa one 9.5%. Only the accrual row is touched — a redeeming
invoice also carries a negative redemption entry (`redeem_against`), which is left alone.

`expiry_duration` is in **days** and is stamped onto every Loyalty Point Entry as
`expiry_date = posting_date + expiry_duration`. A `0` there expires points the day they are earned
and every balance reads zero; the seed uses 3650 days (ten years) as the closest ERPNext allows to
"never expires".

### Fixed tiers

The three redemption levels are `Maison Reward Tier` rows under the programme, not free-form point
spending. `catalog.bootstrap` returns them as `reward_tiers`, and the POS Redeem sheet shows
**only the tiers the client can afford**, plus how far away the next one is.

```
maison_pos.api.rewards.tiers(customer, boutique)
  → { program, program_name, points, tiers[], affordable[], next_reward{…, points_needed}, copy }
```

Redeeming: the POS sends `reward_tier` (or `reward_tiers` when stacking is on) on the invoice
payload. `rewards.apply_to_invoice` checks the client can afford it, refuses more than one tier
unless stacking is enabled, and writes ERPNext's redemption fields. The reward comes off the
**grand total** (after tax), the way ERPNext models a loyalty redemption.

Returns reverse the points, and the balance never goes below zero.

---

## 2. Member perks

| Perk | How it works |
|---|---|
| **Birthday discount** | `issue_birthday_coupons` (daily) issues a `Maison Coupon` to every member whose birthday is `birthday_coupon_lead_days` away (default 7), valid `birthday_coupon_valid_days` (default 30). Percent or fixed amount — `birthday_coupon_type` / `birthday_coupon_value` (default 15%). Logged as a campaign touch. |
| **Monthly sale promotions** | `Maison Promotion Calendar` — one row per month with its Pricing Rules and featured items. `send_monthly_promotion` runs on the 1st and sends the month's calendar as a campaign. |
| **Latest product arrivals** | `new_arrivals_campaign` (weekly) builds a segment from Items / Website Items created in the last `new_arrivals_days` (default 14), per store availability. |
| **Product giveaways** | `Maison Giveaway` (+ `Maison Giveaway Entry`): prize item, entry rule (1 entry per $X spent — `giveaway_entries_per_amount`, default 25 — or per visit), start/end. Entries accrue on the sale; the receipt and the Salon show "N entries". `rewards.draw(giveaway, seed)` picks a winner **randomly from a recorded seed** so the draw can be audited and reproduced, and notifies them. |
| **Exclusive event invites** | campaign channel *Events*, with an RSVP link on the public receipt and the Salon ("Invite me"). |

---

## 3. Sign-up

`/rewards#join` and the Salon Join flow both call:

```
maison_pos.api.rewards.signup(name, phone, email, birthday, consent, boutique)
  → { ok, customer_name, client_number, program_name }
```

which creates the Customer with a `MC######` client number, attaches the loyalty programme,
creates the `Maison Client Profile` (birthday, preferred store) and records the marketing consents
(`do_not_email` / `do_not_sms` are set from `consent_email` / `consent_sms`). Look the member up
afterwards by client number or phone at the POS.

Points are tied to the member, not to a card — there is nothing to lose.

---

## 4. On the receipt

Every receipt for a member prints:

```
POINTS EARNED            173
POINTS BALANCE           423
NEXT REWARD    $10 AT 200 PTS
GIVEAWAY ENTRIES           6
```

and, when a reward was redeemed, the tier title. `rewards.receipt_extras(invoice)` produces this
block for the 80 mm printer, the V660p canvas receipt, the public `/r/<token>` page and the Salon.

---

## 5. Settings

All on **Maison POS Settings**:

| Setting | Default | What |
|---|---|---|
| `rewards_program_name` | `CloudChaserz Rewards` | shown everywhere the programme is named |
| `reward_allow_stacking` | off | more than one tier per transaction |
| `birthday_coupon_enabled` | on | the daily birthday job |
| `birthday_coupon_type` / `birthday_coupon_value` | Percent / 15 | the coupon |
| `birthday_coupon_lead_days` / `_valid_days` | 7 / 30 | when it is issued and how long it lasts |
| `new_arrivals_days` | 14 | the "new" window |
| `giveaway_entries_per_amount` | 25 | $ per giveaway entry |

Scheduled jobs (the site's scheduler must be enabled): daily birthday coupons, daily
promotion-calendar send (acts on the 1st), weekly new-arrivals campaign.

---

## 6. Operating notes

**A member says their points are wrong.** Check the `Loyalty Point Entry` rows for the customer:
each one carries the invoice, the points and the expiry date. A balance of 0 with entries present
almost always means the programme's `expiry_duration` or the entry's `posting_date` is wrong (a
device posting UTC timestamps to a site running in `America/Chicago` can date an entry *tomorrow*,
and ERPNext excludes future entries from the balance).

**A redemption is refused.** Either the client cannot afford the tier, or `conversion_factor` does
not match the tier table (see §1), or the bill is smaller than the reward.

**A giveaway draw is challenged.** `Maison Giveaway` stores the seed used for the draw; re-running
with the same seed reproduces the same winner from the same entry list. Do not re-draw with a new
seed without recording why.

**Do not change the tier amounts mid-month** without telling the stores — the POS shows the tiers
from `bootstrap`, so a change is live at the next catalogue refresh and associates will be asked
about it at the counter.
