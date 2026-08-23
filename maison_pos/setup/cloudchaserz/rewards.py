"""CloudChaserz Rewards demo data (v0.6 Q): the ERPNext Loyalty Program ($1 = 1 point on the net
paid amount), the fixed ``Maison Reward Tier`` rows ($5/100 · $10/200 · $15/300), this month's and
next month's ``Maison Promotion Calendar``, an open ``Maison Giveaway`` and an "Events" campaign
(the v0.5 "Private viewing" channel generalised for the smoke-shop brand)."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import add_days, add_months, get_first_day, get_last_day, getdate, nowdate

from maison_pos.setup.cloudchaserz import COMPANY, LOYALTY_PROGRAM

GIVEAWAY_TITLE = "Geek Bar Pulse X giveaway"
EVENTS_CAMPAIGN_CODE = "EVENTS-LAUNCH"


def _exists(doctype: str, name: Any) -> bool:
	return bool(frappe.db.exists(doctype, name))


POINTS_EXPIRY_DAYS = 3650  # "points never expire while your account is active" (see PROGRAM_COPY)
POINT_VALUE = 0.05  # redemption value of one point: $5 / 100 pts, $10 / 200, $15 / 300


def ensure_loyalty_program(accounts: dict[str, str]) -> str:
	"""Single-tier program: 1 point per $1 net, 1 point = $1 on redemption (tiers give the fixed rewards)."""
	from maison_pos.setup import demo

	if _exists("Loyalty Program", LOYALTY_PROGRAM):
		return LOYALTY_PROGRAM
	doc = frappe.get_doc(
		{
			"doctype": "Loyalty Program",
			"loyalty_program_name": LOYALTY_PROGRAM,
			"loyalty_program_type": "Single Tier Program",
			"company": COMPANY,
			"from_date": add_days(nowdate(), -365),
			# ERPNext splits the two rates: `collection_rules[].collection_factor` is the EARNING rate
			# (currency per point — $1 = 1 point) and `conversion_factor` is the REDEMPTION value
			# (currency per point). Every tier is $5 / 100 pts = $10 / 200 = $15 / 300 = $0.05 a point,
			# so 1.0 here made ERPNext value 100 points at $100 and refuse the redemption
			# ("You can't redeem Loyalty Points having more value than the Total Amount").
			"conversion_factor": POINT_VALUE,
			# ERPNext stamps `expiry_date = add_days(posting_date, expiry_duration)` on every Loyalty
			# Point Entry, so 0 would expire the points the day they are earned and the balance would
			# always read 0. The programme copy promises points that do not expire while the account
			# is active — a 10-year window is the closest ERPNext allows.
			"expiry_duration": POINTS_EXPIRY_DAYS,
			"expense_account": accounts["Loyalty Redemption"],
			"cost_center": demo._account("Main"),
			"auto_opt_in": 1,
			"customer_group": frappe.db.get_value("Customer Group", {"is_group": 1, "parent_customer_group": ("in", ("", None))}, "name"),
			"customer_territory": frappe.db.get_value("Territory", {"is_group": 1, "parent_territory": ("in", ("", None))}, "name"),
			"collection_rules": [{"tier_name": "Member", "min_spent": 0, "collection_factor": 1.0}],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return LOYALTY_PROGRAM


def ensure_tiers() -> list[str]:
	from maison_pos.api.rewards import ensure_default_tiers

	return ensure_default_tiers(LOYALTY_PROGRAM)


def _coupon(code: str, title: str, discount_type: str, value: float, valid_from, valid_upto) -> str | None:
	if not frappe.db.exists("DocType", "Maison Coupon"):
		return None
	if _exists("Maison Coupon", code):
		return code
	doc = frappe.get_doc({"doctype": "Maison Coupon", "code": code, "title": title, "enabled": 1, "discount_type": discount_type, "value": value, "usage": "Multi-use", "max_uses": 0, "valid_from": valid_from, "valid_upto": valid_upto})
	doc.flags.ignore_permissions = True
	doc.insert()
	return code


def _pricing_rule(title: str, item_group: str, discount_pct: float, valid_from, valid_upto) -> str | None:
	name = frappe.db.get_value("Pricing Rule", {"title": title, "company": COMPANY}, "name")
	if name:
		return name
	if not _exists("Item Group", item_group):
		return None
	doc = frappe.get_doc(
		{
			"doctype": "Pricing Rule",
			"title": title,
			"apply_on": "Item Group",
			"item_groups": [{"item_group": item_group}],
			"selling": 1,
			"company": COMPANY,
			"currency": "USD",
			"rate_or_discount": "Discount Percentage",
			"discount_percentage": discount_pct,
			"valid_from": valid_from,
			"valid_upto": valid_upto,
			"priority": 5,
			"disable": 0,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


PROMOS = [
	# (month offset, title, headline, item group on sale, %, featured items)
	(0, "Disposables month", "15% off every disposable all month", "Disposables", 15, ["DSP-001", "DSP-002", "DSP-006", "DSP-008"]),
	(1, "Glass & hookah month", "20% off glass and hookahs", "Glass & Rigs", 20, ["GLS-001", "GLS-003", "HKA-001", "HKA-002"]),
]


def ensure_promotion_calendar() -> list[str]:
	if not frappe.db.exists("DocType", "Maison Promotion Calendar"):
		return []
	out = []
	today = getdate(nowdate())
	for offset, title, headline, group, pct, featured in PROMOS:
		month = get_first_day(add_months(today, offset))
		name = frappe.db.get_value("Maison Promotion Calendar", {"month": month}, "name")
		if name:
			out.append(name)
			continue
		first, last = month, get_last_day(month)
		code = f"PROMO{month.strftime('%y%m')}"
		coupon = _coupon(code, f"{title} — {pct}% off", "Percent", pct, first, last)
		rule = _pricing_rule(f"{title} {month.strftime('%b %Y')}", group, pct, first, last)
		doc = frappe.get_doc(
			{
				"doctype": "Maison Promotion Calendar",
				"title": f"{title} — {month.strftime('%B %Y')}",
				"month": month,
				"status": "Planned",
				"headline": headline,
				"body": f"{headline}. Members get the e-mail on the 1st with code {code}.",
				"coupon": coupon,
				"pricing_rules": [{"pricing_rule": rule}] if rule else [],
				"featured_items": [{"item_code": i} for i in featured if _exists("Item", i)],
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		out.append(doc.name)
	return out


def ensure_giveaway() -> str | None:
	if not frappe.db.exists("DocType", "Maison Giveaway"):
		return None
	name = frappe.db.get_value("Maison Giveaway", {"title": GIVEAWAY_TITLE}, "name")
	if name:
		return name
	today = getdate(nowdate())
	doc = frappe.get_doc(
		{
			"doctype": "Maison Giveaway",
			"title": GIVEAWAY_TITLE,
			"status": "Open",
			"prize_item": "DSP-006" if _exists("Item", "DSP-006") else None,
			"prize_description": "A Geek Bar Pulse X 25K in the flavor of your choice",
			"start_date": add_days(today, -14),
			"end_date": add_days(today, 30),
			"entry_rule": "Per amount",
			"amount_per_entry": 25,
			"max_entries_per_invoice": 10,
			"requires_member": 1,
			"description": "Every $25 spent = 1 entry. Members only. Winner drawn at head office and notified by e-mail.",
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def ensure_events_campaign() -> str | None:
	"""The v0.5 'Private viewing' invitation becomes a generic **Events** campaign with an RSVP link."""
	if not frappe.db.exists("DocType", "Maison Campaign"):
		return None
	name = frappe.db.get_value("Maison Campaign", {"campaign_code": EVENTS_CAMPAIGN_CODE}, "name")
	if name:
		return name
	from maison_pos.brand import get_brand

	brand = get_brand()
	try:
		doc = frappe.get_doc(
			{
				"doctype": "Maison Campaign",
				"title": f"{brand['brand_name']} launch night — new drops + giveaways",
				"campaign_code": EVENTS_CAMPAIGN_CODE,
				"channel": "Event",
				"status": "Scheduled",
				"send_date": add_days(nowdate(), 10),
				"content_link": f"{brand.get('brand_website') or ''}/events",
				"notes": "Events channel (v0.6): RSVP from the receipt / Salon 'Invite me' button.",
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		return doc.name
	except Exception:
		frappe.log_error(frappe.get_traceback(), "cloudchaserz events campaign")
		return None


def seed_rewards() -> dict[str, Any]:
	out: dict[str, Any] = {"program": LOYALTY_PROGRAM}
	for key, fn in (("tiers", ensure_tiers), ("promotion_calendar", ensure_promotion_calendar), ("giveaway", ensure_giveaway), ("events_campaign", ensure_events_campaign)):
		try:
			out[key] = fn()
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"cloudchaserz rewards {key}")
			out[key] = "error"
	return out
