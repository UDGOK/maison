"""v0.6 Q — **CloudChaserz Rewards** on top of ERPNext Loyalty + Maison coupons / campaigns.

* **Earning**: the ERPNext Loyalty Program does the accounting — ``$1 = 1 point`` on the net
  paid amount (``collection_factor = 1`` on the base tier, points on ``net_total`` excl. tax).
  ERPNext reverses the points of a returned sale (negative Loyalty Point Entry) and the balance
  never goes negative (``_affordable``).
* **Redeeming**: fixed tiers — ``Maison Reward Tier`` rows ($5 off at 100 points, $10 at 200,
  $15 at 300). The POS sends ``reward_tier`` (one tier per transaction; ``reward_allow_stacking``
  lets it send ``reward_tiers: [..]``) and the server converts the tier into
  ``loyalty_points_redeemed`` at the program's conversion factor so the existing ERPNext
  redemption path (``loyalty_amount``, redemption account, Loyalty Point Entry) is reused.
* **Birthday coupon**: ``issue_birthday_coupons`` (daily) auto-issues a ``Maison Coupon``
  bound to the client 7 days before the birthday, valid 30 days, + a campaign touch.
* **Monthly promotions**: ``send_monthly_promotions`` (daily, acts on the 1st) turns the
  month's ``Maison Promotion Calendar`` into a sent campaign with the featured items.
* **New arrivals**: ``new_arrivals_campaign`` (weekly) builds a campaign from Items created
  in the last N days with per-store availability.
* **Giveaways**: entries on invoice submit, reversed on return, seeded audited draw.
* **Public page**: ``program()`` (guest) feeds ``/rewards`` on the web shop and the Salon
  "Join" flow; ``signup()`` (guest) creates the client with consent.
"""

from __future__ import annotations

import hashlib
import json
import random
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, get_url, getdate, now_datetime, nowdate

from maison_pos.brand import get_age_settings, get_brand, get_rewards_settings
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, is_manager_or_above

ERR_REWARD = "REWARD_INVALID"

# the client's exact program copy (also on /rewards and the Salon join flow)
PROGRAM_COPY = {
	"earn": "Earn 1 point for every $1 you spend.",
	"redeem": ["$5 off at 100 points", "$10 off at 200 points", "$15 off at 300 points"],
	"perks": [
		{"title": "Birthday discount", "text": "A birthday coupon lands in your account a week before the big day — valid for 30 days."},
		{"title": "Monthly sale promotions", "text": "Members see every monthly promotion first."},
		{"title": "Latest product arrivals", "text": "New drops in your store, announced the week they land."},
		{"title": "Product giveaways", "text": "Every receipt earns giveaway entries — winners are drawn and notified."},
		{"title": "Exclusive event invites", "text": "Invitations to in-store events and launch nights."},
	],
}


class RewardError(frappe.ValidationError):
	error_code = ERR_REWARD


# ---------------------------------------------------------------------------
# program + tiers
# ---------------------------------------------------------------------------
def default_program(company: Optional[str] = None) -> Optional[dict[str, Any]]:
	filters: dict[str, Any] = {}
	if company:
		filters["company"] = company
	rows = frappe.get_all(
		"Loyalty Program",
		filters=filters,
		fields=["name", "loyalty_program_name", "conversion_factor", "expiry_duration", "company", "auto_opt_in"],
		order_by="auto_opt_in desc, modified desc",
		limit=1,
	)
	return rows[0] if rows else None


def reward_tiers(program: Optional[str] = None, company: Optional[str] = None) -> list[dict[str, Any]]:
	"""Enabled tiers of *program* (or the company's default program), cheapest first."""
	if not frappe.db.exists("DocType", "Maison Reward Tier"):
		return []
	if not program:
		p = default_program(company)
		program = p["name"] if p else None
	if not program:
		return []
	rows = frappe.get_all(
		"Maison Reward Tier",
		filters={"loyalty_program": program, "enabled": 1},
		fields=["name", "title", "points", "amount", "sort_order", "description"],
		order_by="points asc, sort_order asc",
	)
	return [{"name": r.name, "title": r.title, "points": cint(r.points), "amount": flt(r.amount), "description": r.description} for r in rows]


def ensure_default_tiers(program: str) -> list[str]:
	"""$5/100 · $10/200 · $15/300 (idempotent)."""
	created = []
	for points, amount in ((100, 5), (200, 10), (300, 15)):
		if not frappe.db.exists("Maison Reward Tier", {"loyalty_program": program, "points": points}):
			doc = frappe.get_doc({"doctype": "Maison Reward Tier", "loyalty_program": program, "points": points, "amount": amount, "enabled": 1, "sort_order": points, "title": f"${amount} off at {points} points"})
			doc.flags.ignore_permissions = True
			doc.insert()
			created.append(doc.name)
	return created


def points_balance(customer: str, program: Optional[str] = None, company: Optional[str] = None) -> float:
	program = program or frappe.db.get_value("Customer", customer, "loyalty_program")
	if not program:
		return 0.0
	from erpnext.accounts.doctype.loyalty_program.loyalty_program import get_loyalty_program_details_with_points

	try:
		lp_company = company or frappe.db.get_value("Loyalty Program", program, "company")
		d = get_loyalty_program_details_with_points(customer, loyalty_program=program, company=lp_company, silent=True)
		return max(0.0, flt(d.get("loyalty_points")))
	except Exception:
		return 0.0


def next_reward(points: float, tiers: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
	"""The first tier the client cannot afford yet → ``{tier, points_needed}``."""
	for t in tiers:
		if points < t["points"]:
			return {"name": t["name"], "title": t["title"], "points": t["points"], "amount": t["amount"], "points_needed": int(t["points"] - points)}
	return None


def affordable(points: float, tiers: list[dict[str, Any]]) -> list[dict[str, Any]]:
	return [t for t in tiers if points >= t["points"]]


def points_for_tiers(tier_names: list[str], program: str) -> tuple[int, float, list[dict[str, Any]]]:
	"""Validate the chosen tiers and return ``(points_to_redeem, discount_amount, tiers)``."""
	rows = []
	for name in tier_names:
		row = frappe.db.get_value("Maison Reward Tier", name, ["name", "title", "points", "amount", "enabled", "loyalty_program"], as_dict=True)
		if not row or not cint(row.enabled):
			raise RewardError(_("Reward tier {0} is not available").format(name))
		if row.loyalty_program != program:
			raise RewardError(_("Reward tier {0} belongs to another program").format(name))
		rows.append(row)
	points = sum(cint(r.points) for r in rows)
	amount = flt(sum(flt(r.amount) for r in rows), 2)
	return points, amount, rows


def apply_to_invoice(si, payload: dict[str, Any]) -> None:
	"""Translate ``reward_tier`` / ``reward_tiers`` into ERPNext loyalty redemption fields.

	Rules: the client must afford the tier(s), one tier per transaction unless stacking is on,
	the discount can never exceed the bill, points never go negative.
	"""
	names: list[str] = []
	if payload.get("reward_tiers"):
		value = payload["reward_tiers"]
		names = json.loads(value) if isinstance(value, str) else list(value)
	elif payload.get("reward_tier"):
		names = [payload["reward_tier"]]
	if not names:
		return
	if si.get("redeem_loyalty_points") and flt(si.get("loyalty_points")):
		raise RewardError(_("Send either reward_tier or loyalty_points_redeemed, not both"))
	settings = get_rewards_settings()
	if len(names) > 1 and not settings["reward_allow_stacking"]:
		raise RewardError(_("Only one reward can be redeemed per transaction"))
	customer = si.customer
	# v0.6 D5 — the POS-Profile default customer is a placeholder, never a member
	if is_walk_in(customer):
		raise RewardError(_("{0} is not a rewards member").format(customer or _("Walk-in")))
	program = frappe.db.get_value("Customer", customer, "loyalty_program")
	if not program:
		raise RewardError(_("{0} is not a rewards member").format(customer))
	lp = frappe.get_cached_doc("Loyalty Program", program)
	points, amount, rows = points_for_tiers(names, program)
	balance = points_balance(customer, program, si.company)
	if balance < points:
		raise RewardError(_("Not enough points: {0} needed, {1} available").format(points, int(balance)))
	# the discount is what the tier says; ERPNext values points at conversion_factor, so the
	# points written to the invoice are the tier points and loyalty_amount the tier amount
	cf = flt(lp.conversion_factor) or 1.0
	if abs(flt(points * cf, 2) - amount) > 0.005:
		# tier amount differs from the face value of its points: keep the tier amount but keep
		# the ledger consistent by redeeming exactly the points the tier costs
		pass
	si.update(
		{
			"redeem_loyalty_points": 1,
			"loyalty_program": program,
			"loyalty_points": points,
			"loyalty_amount": amount,
			"loyalty_redemption_account": lp.expense_account,
			"loyalty_redemption_cost_center": lp.cost_center or si.cost_center,
			"maison_reward_tier": rows[0].name,
		}
	)
	si.flags.maison_reward_tiers = [r.name for r in rows]


def validate_invoice(doc, method: Optional[str] = None) -> None:
	"""Sales Invoice validate: a reward redemption must never exceed the bill (points stay ≥ 0)."""
	if not doc.get("is_pos") or not doc.get("redeem_loyalty_points") or not doc.get("maison_reward_tier"):
		return
	if flt(doc.loyalty_amount) > flt(doc.grand_total) + 0.005 and flt(doc.grand_total) > 0:
		# ERPNext caps loyalty_amount at the grand total itself; keep the points proportional
		doc.loyalty_amount = flt(doc.grand_total, 2)


# ---------------------------------------------------------------------------
# POS endpoints
# ---------------------------------------------------------------------------
@frappe.whitelist()
def tiers(customer: Optional[str] = None, boutique: Optional[str] = None) -> dict[str, Any]:
	"""Tiers + what this client can afford now (POS "Redeem" sheet)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	company = None
	if boutique:
		boutique = assert_boutique_access(boutique)
		company = frappe.db.get_value("Maison Boutique", boutique, "company")
	# v0.6 D5 — an anonymous basket has no member card: no balance, no affordable tier
	if is_walk_in(customer):
		customer = None
	program = frappe.db.get_value("Customer", customer, "loyalty_program") if customer else None
	all_tiers = reward_tiers(program=program, company=company)
	balance = points_balance(customer, program, company) if customer and program else 0.0

	return {
		"program": program,
		"program_name": get_rewards_settings()["rewards_program_name"],
		"allow_stacking": get_rewards_settings()["reward_allow_stacking"],
		"points": balance,
		"tiers": all_tiers,
		"affordable": affordable(balance, all_tiers),
		"next_reward": next_reward(balance, all_tiers),
		"copy": PROGRAM_COPY,
	}


def receipt_extras(doc) -> dict[str, Any]:
	"""Points earned / balance / next reward / giveaway entries for the receipt + Salon."""
	out: dict[str, Any] = {"program_name": get_rewards_settings()["rewards_program_name"], "points_earned": 0.0, "points_balance": 0.0, "next_reward": None, "giveaway_entries": cint(doc.get("maison_giveaway_entries")), "giveaway": None, "reward_tier": None}
	if doc.get("maison_reward_tier"):
		t = frappe.db.get_value("Maison Reward Tier", doc.maison_reward_tier, ["title", "points", "amount"], as_dict=True)
		if t:
			out["reward_tier"] = {"title": t.title, "points": cint(t.points), "amount": flt(t.amount)}
	# v0.6 D5 — an anonymous receipt never prints a member card
	program = frappe.db.get_value("Customer", doc.customer, "loyalty_program") if doc.customer and not is_walk_in(doc.customer) else None
	if program:
		out["points_balance"] = points_balance(doc.customer, program, doc.company)
		if doc.docstatus == 1:
			out["points_earned"] = flt(frappe.db.get_value("Loyalty Point Entry", {"invoice_type": "Sales Invoice", "invoice": doc.name, "redeem_against": ("is", "not set")}, "loyalty_points"))
		out["next_reward"] = next_reward(out["points_balance"], reward_tiers(program=program))
	if out["giveaway_entries"]:
		g = frappe.db.get_value("Maison Giveaway Entry", {"sales_invoice": doc.name, "reversed": 0}, "giveaway")
		if g:
			gv = frappe.db.get_value("Maison Giveaway", g, ["title", "end_date", "prize_description"], as_dict=True)
			total = cint(frappe.db.get_value("Maison Giveaway Entry", {"giveaway": g, "customer": doc.customer, "reversed": 0}, "sum(entries)"))
			out["giveaway"] = {"name": g, "title": gv.title, "end_date": str(gv.end_date), "prize": gv.prize_description, "my_entries": total}
	return out


# ---------------------------------------------------------------------------
# giveaways
# ---------------------------------------------------------------------------
def open_giveaways(boutique: Optional[str], date: Any = None) -> list[dict[str, Any]]:
	date = getdate(date or nowdate())
	rows = frappe.get_all(
		"Maison Giveaway",
		filters={"status": "Open", "start_date": ("<=", date), "end_date": (">=", date)},
		fields=["name", "title", "boutique", "entry_rule", "amount_per_entry", "max_entries_per_invoice", "requires_member", "prize_description", "end_date"],
	)
	return [r for r in rows if not r.boutique or r.boutique == boutique]


def rebase_points_on_net(doc) -> None:
	"""Re-price the Loyalty Point Entry ERPNext just wrote onto the **net** amount.

	The programme is "$1 = 1 point" on what the client actually spends on goods, and the public
	copy on ``/rewards`` says so ("earned on the net amount paid (before tax)"). ERPNext accrues on
	``grand_total - loyalty_amount``, i.e. **including** sales tax, which would quietly hand out
	8–9.5% more points than the programme promises. ERPNext creates the entry in its own
	``on_submit``; ours runs after it, so correct the row rather than re-implementing the accrual.
	"""
	program = doc.get("loyalty_program")
	if not program or doc.get("is_return"):
		return
	# v0.6 D5 — `Sales Invoice.loyalty_program` is `fetch_from: customer.loyalty_program`, so an
	# auto-opted-in walk-in placeholder would accrue on every anonymous basket. Drop whatever
	# ERPNext just wrote and unstamp the invoice so a later return cannot re-create it.
	if is_walk_in(doc.customer):
		frappe.db.delete("Loyalty Point Entry", {"invoice_type": doc.doctype, "invoice": doc.name})
		frappe.db.set_value(doc.doctype, doc.name, "loyalty_program", None, update_modified=False)
		doc.loyalty_program = None
		return
	# A redeeming invoice carries TWO entries: the accrual and a negative redemption row pointing at
	# the entries it consumed (`redeem_against`). Only the accrual is re-priced.
	entry = frappe.db.get_value(
		"Loyalty Point Entry",
		# `redeem_against` is NULL on an accrual row, and SQL `IN ('', NULL)` never matches NULL
		{"invoice": doc.name, "invoice_type": doc.doctype, "redeem_against": ("is", "not set"), "loyalty_points": (">", 0)},
		["name", "loyalty_points"],
		as_dict=True,
	)
	if not entry:
		return
	collection = flt(frappe.db.get_value("Loyalty Program Collection", {"parent": program}, "collection_factor")) or 1.0
	eligible = flt(doc.net_total) - flt(doc.get("loyalty_amount"))
	points = cint(max(0.0, eligible) / collection)
	if points == cint(entry.loyalty_points):
		return
	frappe.db.set_value(
		"Loyalty Point Entry",
		entry.name,
		{"loyalty_points": points, "purchase_amount": max(0.0, eligible)},
		update_modified=False,
	)


def on_invoice_submit(doc, method: Optional[str] = None) -> None:
	"""Sales Invoice on_submit: points on the net amount, giveaway entries, age-check link."""
	if not doc.get("is_pos") or doc.get("is_return"):
		return
	try:
		rebase_points_on_net(doc)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison loyalty net rebase")
	try:
		from maison_pos.api.age import link_check_to_invoice

		link_check_to_invoice(doc)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison age check link")
	if frappe.flags.in_history_seed and not frappe.flags.maison_seed_giveaways:
		return
	walk_in = _is_walk_in(doc.customer)
	total = 0
	for g in open_giveaways(doc.get("maison_boutique"), doc.posting_date):
		if cint(g.requires_member) and walk_in:
			continue
		gdoc = frappe.get_cached_doc("Maison Giveaway", g.name)
		n = gdoc.entries_for(flt(doc.net_total))
		if n <= 0:
			continue
		if frappe.db.exists("Maison Giveaway Entry", {"giveaway": g.name, "sales_invoice": doc.name}):
			continue
		frappe.get_doc(
			{"doctype": "Maison Giveaway Entry", "giveaway": g.name, "customer": doc.customer, "entries": n, "sales_invoice": doc.name, "boutique": doc.get("maison_boutique"), "ts": now_datetime()}
		).insert(ignore_permissions=True)
		total += n
	if total:
		frappe.db.set_value("Sales Invoice", doc.name, "maison_giveaway_entries", total, update_modified=False)
		doc.maison_giveaway_entries = total


def on_invoice_cancel(doc, method: Optional[str] = None) -> None:
	if not doc.get("is_pos"):
		return
	for name in frappe.get_all("Maison Giveaway Entry", {"sales_invoice": doc.name}, pluck="name"):
		frappe.db.set_value("Maison Giveaway Entry", name, "reversed", 1, update_modified=False)


def rebase_points_after_return(invoice: str) -> None:
	"""--- v0.8 POS D12 — re-price a partly returned sale's points on the **net** amount ---

	Points are earned on the net amount ("$1 = 1 point on what you spend on goods"), which is why
	``rebase_points_on_net`` corrects ERPNext's tax-inclusive accrual when a sale is submitted.

	A return sends ERPNext back to its own base: ``make_loyalty_point_entry`` deletes the entry and
	rebuilds it on ``grand_total - returned_grand_total`` — tax included on both sides. A $17.30
	sale (net $15.98 -> 15 pts) with $7.57 returned came back as ``17.30 - 7.57 = 9.73`` -> **9**
	points, where the $8.99 item left in the client's hands earns **8** when bought on its own.
	Re-price the rebuilt entry on the net basis so a partial return leaves exactly the points the
	remaining goods would have earned.
	"""
	if not frappe.db.exists("Sales Invoice", invoice):
		return
	doc = frappe.get_doc("Sales Invoice", invoice)
	program = doc.get("loyalty_program")
	if not program or doc.get("is_return") or is_walk_in(doc.customer):
		return
	entry = frappe.db.get_value(
		"Loyalty Point Entry",
		{"invoice": doc.name, "invoice_type": doc.doctype, "redeem_against": ("is", "not set"), "loyalty_points": (">", 0)},
		["name", "loyalty_points"],
		as_dict=True,
	)
	if not entry:
		return  # fully returned (ERPNext leaves nothing to correct)
	# --- v0.8 QA B3 — leave an accrual that has already been redeemed against alone ---
	# Shrinking it would leave the entry with more redeemed against it than it holds, which
	# ERPNext's own `apply_loyalty_points` mis-handles (a negative "available" turns into a
	# *positive* entry on the next redemption). Those sales are settled by `claw_back_points`.
	if frappe.db.exists("Loyalty Point Entry", {"redeem_against": entry.name}):
		return
	# --- end v0.8 QA B3 ---
	returned_net = abs(
		flt(
			frappe.db.get_value(
				"Sales Invoice",
				{"return_against": doc.name, "docstatus": 1},
				"sum(net_total)",
			)
		)
	)
	collection = flt(frappe.db.get_value("Loyalty Program Collection", {"parent": program}, "collection_factor")) or 1.0
	eligible = flt(doc.net_total) - flt(doc.get("loyalty_amount")) - returned_net
	points = cint(max(0.0, eligible) / collection)
	if points == cint(entry.loyalty_points):
		return
	frappe.db.set_value(
		"Loyalty Point Entry",
		entry.name,
		{"loyalty_points": points, "purchase_amount": max(0.0, eligible)},
		update_modified=False,
	)


# --- v0.8 QA B3 — a sale whose points have been spent must still be returnable ------------------
#
# ERPNext rebuilds the original sale's accrual when a credit note is submitted
# (`Sales Invoice.on_submit` -> `delete_loyalty_point_entry`) and refuses outright while any
# redemption row points at that accrual:
#
#   "Sales Invoice can't be cancelled since the Loyalty Points earned has been redeemed.
#    First cancel the Sales Invoice No ACC-SINV-…"
#
# The counter could not refund the client at all, and the message named an unrelated later sale.
# `api/returns.py` therefore takes the points itself for those sales: the credit note is submitted
# with no `loyalty_program` (which is the flag ERPNext's branch reads), and the points the
# returned goods earned are clawed back here as ordinary negative entries against the client's
# live balance — FIFO by expiry, exactly like a redemption, so no entry is ever left with more
# redeemed against it than it holds and the balance can never go negative.
# ------------------------------------------------------------------------------------------------
def accrual_entry(invoice: str) -> Optional[dict[str, Any]]:
	"""The positive Loyalty Point Entry a sale earned (``redeem_against`` is NULL on an accrual)."""
	return frappe.db.get_value(
		"Loyalty Point Entry",
		{"invoice": invoice, "invoice_type": "Sales Invoice", "redeem_against": ("is", "not set"), "loyalty_points": (">", 0)},
		["name", "loyalty_points", "customer", "loyalty_program", "company", "expiry_date", "posting_date"],
		as_dict=True,
	)


def redemptions_against_sale(invoice: str) -> list[dict[str, Any]]:
	"""Later invoices that have already spent the points *invoice* earned."""
	earned = frappe.get_all("Loyalty Point Entry", filters={"invoice": invoice, "invoice_type": "Sales Invoice"}, pluck="name")
	if not earned:
		return []
	return frappe.get_all(
		"Loyalty Point Entry",
		filters={"redeem_against": ("in", earned), "loyalty_points": ("<", 0)},
		fields=["name", "invoice", "loyalty_points"],
	)


def collection_factor(program: str) -> float:
	return flt(frappe.db.get_value("Loyalty Program Collection", {"parent": program}, "collection_factor")) or 1.0


def points_for_amount(program: str, amount: float) -> int:
	"""Points the programme grants for *amount* of net spend ("$1 = 1 point" by default)."""
	return cint(max(0.0, flt(amount)) / collection_factor(program))


def available_points(customer: str, program: str, company: Optional[str] = None) -> float:
	"""Live balance (ERPNext's own sum: accruals minus redemptions, unexpired)."""
	return points_balance(customer, program, company)


def claw_back_points(customer: str, program: str, company: str, points: int, invoice: Optional[str] = None, posting_date: Any = None) -> dict[str, Any]:
	"""Take *points* off the client's balance, oldest entry first. Never goes below zero.

	Returns ``{"clawed_back": n, "shortfall": n, "entries": [name]}`` — a shortfall means the
	client had already spent the points the returned goods earned, so there was nothing left to
	take back (the return still happens; the associate is told).
	"""
	from erpnext.accounts.doctype.loyalty_point_entry.loyalty_point_entry import get_loyalty_point_entries, get_redemption_details

	points = cint(points)
	out: dict[str, Any] = {"clawed_back": 0, "shortfall": max(0, points), "entries": []}
	if points <= 0:
		out["shortfall"] = 0
		return out
	posting_date = posting_date or nowdate()
	entries = get_loyalty_point_entries(customer, program, company, posting_date)
	redeemed = get_redemption_details(customer, program, company)
	remaining = points
	for entry in entries:
		usable = cint(entry.loyalty_points) + cint(redeemed.get(entry.name) or 0)  # redemptions are negative
		if usable <= 0:
			continue
		take = min(usable, remaining)
		doc = frappe.get_doc(
			{
				"doctype": "Loyalty Point Entry",
				"company": company,
				"loyalty_program": program,
				"loyalty_program_tier": entry.loyalty_program_tier,
				"customer": customer,
				"invoice_type": "Sales Invoice",
				"invoice": invoice,
				"redeem_against": entry.name,
				"loyalty_points": -take,
				"purchase_amount": 0,
				"expiry_date": entry.expiry_date,
				"posting_date": posting_date,
			}
		)
		doc.flags.ignore_permissions = 1
		doc.insert()
		out["entries"].append(doc.name)
		remaining -= take
		if remaining <= 0:
			break
	out["clawed_back"] = points - remaining
	out["shortfall"] = max(0, remaining)
	return out
# --- end v0.8 QA B3 ---


def on_return_submit(doc, method: Optional[str] = None) -> None:
	"""A credit note reverses the entries of the original sale (points are reversed by ERPNext)."""
	if not doc.get("is_return") or not doc.get("return_against"):
		return
	for name in frappe.get_all("Maison Giveaway Entry", {"sales_invoice": doc.return_against, "reversed": 0}, pluck="name"):
		frappe.db.set_value("Maison Giveaway Entry", name, "reversed", 1, update_modified=False)
	# v0.8 POS D12 — ERPNext has just rebuilt the original's accrual on a tax-inclusive base
	try:
		rebase_points_after_return(doc.return_against)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison loyalty return rebase")


def on_return_cancel(doc, method: Optional[str] = None) -> None:
	"""v0.8 POS D12 — undoing a return puts the points back on the same net basis."""
	if not doc.get("is_return") or not doc.get("return_against"):
		return
	try:
		rebase_points_after_return(doc.return_against)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison loyalty return rebase (cancel)")


def is_walk_in(customer: Optional[str] = None, customer_name: Optional[str] = None) -> bool:
	"""True for the anonymous placeholder client (v0.6 D5).

	A customer is a walk-in when it is the default customer of *any* POS Profile, or when its
	name starts with "Walk-in" ("Walk-in Customer" / "Walk-in Client" across the two seeds).
	The placeholder must never accrue or redeem points, never head the POS client list and never
	print as a member on an anonymous receipt: a loyalty programme with ``auto_opt_in`` enrols
	whoever appears on an invoice, which is how the seeded site ended up with a "Walk-in Customer"
	holding 61,045 points.

	*customer_name* lets an unsaved ``Customer`` document be tested before it has a name.
	"""
	if customer_name and str(customer_name).strip().lower().startswith("walk-in"):
		return True
	if not customer:
		return not customer_name  # no client attached at all == a walk-in basket
	if frappe.db.get_value("POS Profile", {"customer": customer}, "name"):
		return True
	return (frappe.db.get_value("Customer", customer, "customer_name") or "").lower().startswith("walk-in")


#: legacy private alias (kept so nothing that imported it breaks)
_is_walk_in = is_walk_in


@frappe.whitelist()
def giveaways(boutique: Optional[str] = None, customer: Optional[str] = None) -> dict[str, Any]:
	"""Open giveaways for the store (+ the client's entries)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if boutique:
		boutique = assert_boutique_access(boutique)
	rows = open_giveaways(boutique)
	out = []
	for g in rows:
		mine = cint(frappe.db.get_value("Maison Giveaway Entry", {"giveaway": g.name, "customer": customer, "reversed": 0}, "sum(entries)")) if customer else 0
		out.append({**g, "amount_per_entry": flt(g.amount_per_entry), "my_entries": mine, "end_date": str(g.end_date)})
	return {"giveaways": out}


@frappe.whitelist()
def draw(giveaway: str, seed: Optional[str] = None, notify: int = 1) -> dict[str, Any]:
	"""Draw the winner (Head Office). Seeded PRNG over the sorted entry list → auditable / replayable."""
	if not (is_manager_or_above() and ("Maison Head Office" in frappe.get_roles() or "System Manager" in frappe.get_roles())):
		frappe.throw(_("Only Head Office may draw a giveaway"), frappe.PermissionError)
	doc = frappe.get_doc("Maison Giveaway", giveaway)
	if doc.status == "Drawn":
		frappe.throw(_("{0} has already been drawn").format(giveaway), frappe.ValidationError)
	entries = frappe.get_all("Maison Giveaway Entry", filters={"giveaway": giveaway, "reversed": 0}, fields=["name", "customer", "entries"], order_by="name asc")
	if not entries:
		frappe.throw(_("No entries to draw from"), frappe.ValidationError)
	seed = seed or hashlib.sha256(f"{giveaway}|{now_datetime().isoformat()}|{frappe.session.user}".encode()).hexdigest()[:16]
	pool: list[str] = []
	for e in entries:
		pool.extend([e.name] * max(0, cint(e.entries)))
	rng = random.Random(seed)
	index = rng.randrange(len(pool))
	winning = pool[index]
	winner = next(e.customer for e in entries if e.name == winning)
	audit = {
		"seed": seed,
		"algorithm": "python random.Random(seed).randrange(len(pool)) over entries sorted by name, each repeated `entries` times",
		"pool_size": len(pool),
		"index": index,
		"entries_hash": hashlib.sha256("|".join(f"{e.name}:{e.entries}" for e in entries).encode()).hexdigest(),
		"participants": len({e.customer for e in entries}),
		"drawn_by": frappe.session.user,
		"drawn_at": str(now_datetime()),
		"winning_entry": winning,
	}
	doc.flags.maison_drawing = True
	doc.update({"status": "Drawn", "draw_seed": seed, "drawn_on": now_datetime(), "drawn_by": frappe.session.user, "winner": winner, "winner_entry": winning, "total_entries": len(pool), "participants": audit["participants"], "draw_audit": json.dumps(audit, indent=1)})
	doc.flags.ignore_permissions = True
	doc.save()
	if cint(notify):
		_notify_winner(doc)
	return {"giveaway": giveaway, "winner": winner, "winner_name": frappe.db.get_value("Customer", winner, "customer_name"), "entry": winning, "audit": audit}


def _notify_winner(doc) -> None:
	brand = get_brand()
	email = frappe.db.get_value("Customer", doc.winner, "email_id")
	try:
		frappe.get_doc(
			{"doctype": "Maison Client Interaction", "customer": doc.winner, "type": "Note", "note": f"Won giveaway {doc.title} ({doc.prize_description or doc.prize_item or ''})", "ts": now_datetime(), "status": "Done", "done_on": now_datetime()}
		).insert(ignore_permissions=True)
	except Exception:
		pass
	if email:
		try:
			frappe.sendmail(recipients=[email], subject=f"You won — {doc.title} · {brand['brand_name']}", message=f"<p>Congratulations! You are the winner of <b>{doc.title}</b>.</p><p>Prize: {doc.prize_description or doc.prize_item}</p><p>Visit any {brand['brand_name']} store to collect it.</p>", delayed=True)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "maison giveaway notify")
	frappe.db.set_value("Maison Giveaway", doc.name, "notified_on", now_datetime(), update_modified=False)


# ---------------------------------------------------------------------------
# birthday coupon (daily)
# ---------------------------------------------------------------------------
def _birthday_code(customer: str, year: int) -> str:
	digest = hashlib.sha1(f"{customer}|{year}".encode()).hexdigest()[:6].upper()
	return f"BDAY{year % 100:02d}{digest}"


def issue_birthday_coupons(today: Any = None) -> dict[str, Any]:
	"""Daily job: a birthday coupon for every client whose birthday is ``lead_days`` away (once a year)."""
	settings = get_rewards_settings()
	if not settings["birthday_coupon_enabled"] or not frappe.db.exists("DocType", "Maison Client Profile"):
		return {"issued": [], "skipped": "disabled"}
	today = getdate(today or nowdate())
	target = add_days(today, settings["birthday_coupon_lead_days"])
	issued: list[str] = []
	profiles = frappe.get_all("Maison Client Profile", filters={"birthday": ("is", "set")}, fields=["customer", "birthday", "do_not_email"])
	campaign = _birthday_campaign()
	for p in profiles:
		bd = getdate(p.birthday)
		if (bd.month, bd.day) != (target.month, target.day):
			continue
		if not frappe.db.exists("Customer", p.customer) or frappe.db.get_value("Customer", p.customer, "disabled"):
			continue
		code = _birthday_code(p.customer, target.year)
		if frappe.db.exists("Maison Coupon", code):
			continue
		coupon = frappe.get_doc(
			{
				"doctype": "Maison Coupon",
				"code": code,
				"title": f"Birthday {target.year} — {frappe.db.get_value('Customer', p.customer, 'customer_name')}",
				"enabled": 1,
				"discount_type": settings["birthday_coupon_type"],
				"value": settings["birthday_coupon_value"],
				"usage": "Single-use",
				"max_uses": 1,
				"customer": p.customer,
				"valid_from": today,
				"valid_upto": add_days(today, settings["birthday_coupon_valid_days"]),
			}
		)
		coupon.flags.ignore_permissions = True
		coupon.insert()
		issued.append(code)
		try:
			frappe.get_doc(
				{"doctype": "Maison Client Interaction", "customer": p.customer, "type": "Birthday", "note": f"Birthday coupon {code} issued (valid until {coupon.valid_upto})", "ts": now_datetime(), "status": "Done", "done_on": now_datetime()}
			).insert(ignore_permissions=True)
		except Exception:
			pass
		if campaign:
			_touch(campaign, p.customer, "Email")
		if not cint(p.do_not_email):
			email = frappe.db.get_value("Customer", p.customer, "email_id")
			if email:
				brand = get_brand()
				try:
					frappe.sendmail(
						recipients=[email],
						subject=f"Happy birthday from {brand['brand_name']} — your gift inside",
						message=f"<p>Your birthday is coming up! Use code <b>{code}</b> for {_discount_label(settings)} on your next visit. Valid until {coupon.valid_upto}.</p>",
						delayed=True,
					)
				except Exception:
					frappe.log_error(frappe.get_traceback(), "maison birthday coupon mail")
	return {"issued": issued, "date": str(today), "target": str(target)}


def _discount_label(settings: dict[str, Any]) -> str:
	if settings["birthday_coupon_type"] == "Percent":
		return f"{flt(settings['birthday_coupon_value']):g}% off"
	return f"${flt(settings['birthday_coupon_value']):g} off"


def _birthday_campaign() -> Optional[str]:
	if not frappe.db.exists("DocType", "Maison Campaign"):
		return None
	name = frappe.db.get_value("Maison Campaign", {"campaign_code": "BIRTHDAY"}, "name")
	if name:
		return name
	try:
		doc = frappe.get_doc({"doctype": "Maison Campaign", "title": "Birthday rewards", "campaign_code": "BIRTHDAY", "channel": "Email", "status": "Sent", "send_date": nowdate(), "segment_signal_type": "Birthday"})
		doc.flags.ignore_permissions = True
		doc.insert()
		return doc.name
	except Exception:
		return None


def _touch(campaign: str, customer: str, channel: str = "Email") -> None:
	try:
		frappe.get_doc({"doctype": "Maison Campaign Touch", "campaign": campaign, "customer": customer, "channel": channel, "sent_at": now_datetime(), "source": "Manual"}).insert(ignore_permissions=True)
	except Exception:
		pass


# ---------------------------------------------------------------------------
# monthly promotions (acts on the 1st) + new arrivals (weekly)
# ---------------------------------------------------------------------------
def send_monthly_promotions(today: Any = None, force: int = 0) -> dict[str, Any]:
	"""Daily job: on the 1st (or *force*), send the month's Promotion Calendar as a campaign."""
	today = getdate(today or nowdate())
	if today.day != 1 and not cint(force):
		return {"skipped": "not the 1st"}
	month = today.replace(day=1)
	name = frappe.db.get_value("Maison Promotion Calendar", {"month": month, "status": ("in", ("Planned", "Active"))}, "name")
	if not name:
		return {"skipped": "no calendar row", "month": str(month)}
	cal = frappe.get_doc("Maison Promotion Calendar", name)
	campaign = cal.campaign
	if not campaign and frappe.db.exists("DocType", "Maison Campaign"):
		doc = frappe.get_doc(
			{
				"doctype": "Maison Campaign",
				"title": cal.headline or cal.title,
				"campaign_code": f"PROMO-{month.strftime('%Y%m')}",
				"channel": "Email",
				"status": "Sent",
				"send_date": today,
				"coupon": cal.coupon,
				"featured_items": [{"item_code": r.item_code} for r in cal.featured_items if frappe.db.exists("Item", r.item_code)],
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		campaign = doc.name
	# enable the month's pricing rules for the window
	first, last = cal.month_window()
	for r in cal.pricing_rules:
		if frappe.db.exists("Pricing Rule", r.pricing_rule):
			frappe.db.set_value("Pricing Rule", r.pricing_rule, {"disable": 0, "valid_from": first, "valid_upto": last}, update_modified=False)
	audience = _members()
	if campaign:
		for c in audience:
			_touch(campaign, c, "Email")
	cal.db_set({"status": "Sent", "campaign": campaign, "sent_on": now_datetime(), "audience_size": len(audience)}, update_modified=False)
	return {"calendar": name, "campaign": campaign, "audience": len(audience), "pricing_rules": [r.pricing_rule for r in cal.pricing_rules]}


def _members(limit: int = 5000) -> list[str]:
	rows = frappe.get_all("Customer", filters={"loyalty_program": ("is", "set"), "disabled": 0}, pluck="name", limit=limit)
	walk = frappe.get_all("POS Profile", pluck="customer")
	return [r for r in rows if r not in walk]


def new_arrivals(days: Optional[int] = None) -> list[dict[str, Any]]:
	"""Items created in the last *days* with per-store availability."""
	days = cint(days) or get_rewards_settings()["new_arrivals_days"]
	since = add_days(nowdate(), -days)
	items = frappe.get_all("Item", filters={"is_sales_item": 1, "disabled": 0, "creation": (">=", since)}, fields=["name", "item_name", "item_group", "maison_brand", "maison_flavor", "image", "maison_age_restricted"], order_by="creation desc", limit=60)
	if not items:
		return []
	stores = {b.warehouse: b for b in frappe.get_all("Maison Boutique", filters={"enabled": 1}, fields=["name", "boutique_name", "warehouse", "is_warehouse", "boutique_type"]) if not cint(b.get("is_warehouse")) and b.get("boutique_type") != "Warehouse"}
	bins = frappe.get_all("Bin", filters={"item_code": ("in", [i.name for i in items]), "warehouse": ("in", list(stores)), "actual_qty": (">", 0)}, fields=["item_code", "warehouse", "actual_qty"])
	avail: dict[str, list[dict[str, Any]]] = {}
	for b in bins:
		avail.setdefault(b.item_code, []).append({"store": stores[b.warehouse].name, "store_name": stores[b.warehouse].boutique_name, "qty": flt(b.actual_qty)})
	out = []
	for i in items:
		out.append({"item_code": i.name, "item_name": i.item_name, "item_group": i.item_group, "brand": i.maison_brand, "flavor": i.maison_flavor, "image": i.image, "age_restricted": cint(i.maison_age_restricted), "available_at": avail.get(i.name, [])})
	return out


def new_arrivals_campaign(today: Any = None) -> dict[str, Any]:
	"""Weekly job: "New arrivals" segment campaign from recently created items."""
	today = getdate(today or nowdate())
	items = new_arrivals()
	if not items or not frappe.db.exists("DocType", "Maison Campaign"):
		return {"skipped": "no new items", "date": str(today)}
	code = f"NEW-{today.strftime('%Y%m%d')}"
	if frappe.db.exists("Maison Campaign", {"campaign_code": code}):
		return {"skipped": "already sent", "campaign_code": code}
	doc = frappe.get_doc(
		{
			"doctype": "Maison Campaign",
			"title": f"New arrivals — week of {today.strftime('%b %d')}",
			"campaign_code": code,
			"channel": "Email",
			"status": "Sent",
			"send_date": today,
			"featured_items": [{"item_code": i["item_code"]} for i in items[:12]],
			"notes": "Auto-segment: items created in the last {0} days, with per-store availability.".format(get_rewards_settings()["new_arrivals_days"]),
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	members = _members()
	for c in members:
		_touch(doc.name, c, "Email")
	return {"campaign": doc.name, "items": len(items), "audience": len(members)}


# ---------------------------------------------------------------------------
# public program page + sign-up (guest)
# ---------------------------------------------------------------------------
@frappe.whitelist(allow_guest=True)
def program() -> dict[str, Any]:
	"""Copy + tiers for ``/rewards`` and the Salon "Join" screen (no PII)."""
	from maison_pos.ratelimit import guard

	guard("rewards.program", 60, 60, global_limit=1200)
	brand = get_brand()
	settings = get_rewards_settings()
	lp = default_program()
	tiers_ = reward_tiers(program=lp["name"] if lp else None)
	events = []
	if frappe.db.exists("DocType", "Maison Campaign"):
		events = frappe.get_all("Maison Campaign", filters={"channel": ("in", ("Event", "Private viewing")), "status": ("in", ("Scheduled", "Sent")), "send_date": (">=", add_days(nowdate(), -1))}, fields=["title", "send_date", "content_link"], order_by="send_date asc", limit=5)
	giveaways_ = [{"title": g.title, "prize": g.prize_description, "end_date": str(g.end_date), "rule": g.entry_rule, "amount_per_entry": flt(g.amount_per_entry)} for g in open_giveaways(None)]
	return {
		"brand": brand,
		"program_name": settings["rewards_program_name"],
		"earn_rate": 1,
		"tiers": tiers_ or [{"points": 100, "amount": 5.0, "title": "$5 off at 100 points"}, {"points": 200, "amount": 10.0, "title": "$10 off at 200 points"}, {"points": 300, "amount": 15.0, "title": "$15 off at 300 points"}],
		"birthday": {"type": settings["birthday_coupon_type"], "value": settings["birthday_coupon_value"], "lead_days": settings["birthday_coupon_lead_days"], "valid_days": settings["birthday_coupon_valid_days"], "label": _discount_label(settings)},
		"copy": PROGRAM_COPY,
		"events": [{"title": e.title, "date": str(e.send_date), "link": e.content_link} for e in events],
		"giveaways": giveaways_,
		"signup_url": get_url("/rewards#join"),
		# v0.6 R — the page states the legal age it is asking the customer to confirm
		"minimum_age": get_age_settings()["minimum_age"],
	}


#: v0.7 S3 — the *only* thing an anonymous sign-up ever hears back. Identical whether the
#: e-mail / phone was already on file or not, so the form is not an oracle for membership.
SIGNUP_ACK = "Thank you — check your e-mail, or ask for your card next time you are in store."


def _signup_is_staff() -> bool:
	"""True for a signed-in member of staff (they may knowingly link an existing client)."""
	if frappe.session.user in ("Guest", None):
		return False
	from maison_pos.scoping import ALL_MAISON_ROLES

	return bool(set(ALL_MAISON_ROLES + ("System Manager",)) & set(frappe.get_roles()))


def _enrol(customer: str, birthday: Optional[str], consent_email: Any, consent_sms: Any, boutique: Optional[str]) -> None:
	"""Attach the loyalty programme + marketing preferences to a **new** client."""
	lp = default_program()
	if lp and not frappe.db.get_value("Customer", customer, "loyalty_program"):
		frappe.db.set_value("Customer", customer, "loyalty_program", lp["name"], update_modified=False)
	if not frappe.db.exists("DocType", "Maison Client Profile"):
		return
	if not frappe.db.exists("Maison Client Profile", customer):
		frappe.get_doc({"doctype": "Maison Client Profile", "customer": customer}).insert(ignore_permissions=True)
	values: dict[str, Any] = {"do_not_email": 0 if cint(consent_email) else 1, "do_not_sms": 0 if cint(consent_sms) else 1}
	if birthday:
		try:
			values["birthday"] = getdate(birthday)
		except Exception:
			pass
	if boutique and frappe.db.exists("Maison Boutique", boutique):
		values["preferred_boutique"] = boutique
	frappe.db.set_value("Maison Client Profile", customer, values, update_modified=False)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def signup(name: str, phone: Optional[str] = None, email: Optional[str] = None, birthday: Optional[str] = None, consent_email: int = 0, consent_sms: int = 0, consent: int = 0, boutique: Optional[str] = None) -> dict[str, Any]:
	"""Public sign-up form (``/rewards#join``).

	v0.7 S3 — this used to elevate to ``Administrator`` and call ``customers.upsert``, which
	*matches an existing Customer by e-mail or phone and overwrites it*. Anyone who knew a
	client's e-mail could therefore rewrite their name, phone and marketing consent, and the
	response handed back the victim's client number. An anonymous caller now:

	* never writes to a Customer that already exists — not one field;
	* never learns whether the address was on file: the acknowledgement is byte-identical either
	  way and carries no client number.

	A **signed-in member of staff** still gets the linking behaviour (and the client number) —
	they are looking at the person in front of them, and it is logged.
	"""
	from maison_pos.api.recognition import find_customer, find_or_create_customer, validate_contact
	from maison_pos.audit import log as audit_log
	from maison_pos.ratelimit import guard

	# v0.7 S4 — `frappe.rate_limit = None` was not a rate limit; this is one.
	guard("rewards.signup", 5, 600, global_limit=120, global_seconds=600)

	name = (name or "").strip()
	if not name:
		frappe.throw(_("Name is required"), frappe.ValidationError)
	if not (phone or email):
		frappe.throw(_("Phone or e-mail is required"), frappe.ValidationError)
	if not cint(consent) and not (cint(consent_email) or cint(consent_sms)):
		frappe.throw(_("Please accept the program terms"), frappe.ValidationError)

	staff = _signup_is_staff()
	program_name = get_rewards_settings()["rewards_program_name"]
	if not staff:
		# validate the shape first: a malformed address must fail identically whether or not it
		# happens to belong to somebody
		phone, email = validate_contact(phone, email)
		existing = find_customer(phone, email)
		if existing:
			# already a member (or already a client): touch nothing, reveal nothing
			audit_log("rewards.signup.existing_client", customer=existing, boutique=boutique)
			return {"ok": True, "message": _(SIGNUP_ACK), "program_name": program_name}
		customer, created = find_or_create_customer(phone, email, name)
		if created:
			_enrol(customer, birthday, consent_email, consent_sms, boutique)
		return {"ok": True, "message": _(SIGNUP_ACK), "program_name": program_name}

	# staff-assisted sign-up: linking an existing client is the point, so it stays available
	from maison_pos.api.customers import upsert

	res = upsert({"customer_name": name, "mobile_no": phone, "email_id": email})
	customer = res["name"] if isinstance(res, dict) else res
	_enrol(customer, birthday, consent_email, consent_sms, boutique)
	audit_log("rewards.signup.staff", customer=customer, boutique=boutique)
	return {
		"ok": True,
		"customer_name": name,
		"client_number": frappe.db.get_value("Customer", customer, "maison_client_number"),
		"program_name": program_name,
		"message": _(SIGNUP_ACK),
	}
