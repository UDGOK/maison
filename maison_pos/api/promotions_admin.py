"""v1.5 — **Promotions from the warehouse desk**: rewards, coupons, giveaways, sale rules and the
monthly calendar, edited by head office / the warehouse admin without the Frappe desk.

Nothing new is stored. Every screen here edits what the chain already runs on:

* rewards → the custom fields on ``AWANZ POS Settings`` (`setup/install_v06.py`) and the
  ``Loyalty Program`` earn rate; tiers are ``AWANZ Reward Tier`` rows;
* coupons → ``AWANZ Coupon``; giveaways → ``AWANZ Giveaway`` (the draw stays in
  ``rewards.draw`` — seeded, auditable);
* sales → ``Pricing Rule`` rows the POS already reads through ``promotions.active``;
* the calendar → ``AWANZ Promotion Calendar`` (sent by the daily job on the 1st, or now).

Who: ``assert_supply_admin`` — System Manager, head office, the warehouse admin. The warehouse
admin has no desk permission on these doctypes, so writes go through with
``ignore_permissions`` after that check; the record still carries their name.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, getdate, now_datetime, nowdate

from maison_pos.scoping import assert_supply_admin

REWARDS_KEYS = (
	"rewards_program_name",
	"reward_allow_stacking",
	"birthday_coupon_enabled",
	"birthday_coupon_type",
	"birthday_coupon_value",
	"birthday_coupon_lead_days",
	"birthday_coupon_valid_days",
	"giveaway_entries_per_amount",
	"new_arrivals_days",
	"promotions_enabled",
	"birthday_bonus_points",
)

PROMO_KINDS = {"percent": "Discount Percentage", "amount": "Discount Amount", "rate": "Rate"}
APPLY_ON = {"Item Code": ("Pricing Rule Item Code", "item_code", "Item"), "Item Group": ("Pricing Rule Item Group", "item_group", "Item Group"), "Brand": ("Pricing Rule Brand", "brand", "Brand"), "Transaction": (None, None, None)}
#: a Pricing Rule with this title shape is a store shelf price (`AWANZ Price Change Request`),
#: never a promotion
STORE_PRICE_PREFIX = "AWANZ "


def _payload(payload: Any) -> dict[str, Any]:
	if isinstance(payload, str):
		payload = json.loads(payload or "{}")
	if not isinstance(payload, dict):
		frappe.throw(_("Payload must be an object"), frappe.ValidationError)
	return payload


def _store_name(boutique: Optional[str]) -> Optional[str]:
	return frappe.db.get_value("AWANZ Store", boutique, "boutique_name") if boutique else None


def _stores() -> list[dict[str, Any]]:
	return frappe.get_all("AWANZ Store", filters={"enabled": 1}, fields=["name as code", "boutique_name", "warehouse", "is_warehouse"], order_by="is_warehouse desc, boutique_name asc")


def _save(doc) -> None:
	doc.flags.ignore_permissions = True
	doc.save()


# ---------------------------------------------------------------------------------------------
# overview
# ---------------------------------------------------------------------------------------------
def _program() -> Optional[dict[str, Any]]:
	from maison_pos.api.rewards import collection_factor, default_program

	lp = default_program()
	if not lp:
		return None
	factor = collection_factor(lp["name"])
	return {
		"name": lp["name"],
		"title": lp.get("loyalty_program_name") or lp["name"],
		"company": lp.get("company"),
		# ERPNext stores "$ per point"; the desk speaks in points per dollar
		"points_per_dollar": round(1.0 / factor, 4) if factor else 1.0,
		"expiry_days": cint(lp.get("expiry_duration")),
		"members": frappe.db.count("Customer", {"loyalty_program": lp["name"]}),
	}


def _rewards_settings() -> dict[str, Any]:
	from maison_pos.brand import get_rewards_settings

	out = dict(get_rewards_settings())
	stored = frappe.db.get_singles_dict("AWANZ POS Settings")
	out["promotions_enabled"] = cint(stored.get("promotions_enabled", 1) if stored.get("promotions_enabled") not in (None, "") else 1)
	out["birthday_bonus_points"] = cint(stored.get("birthday_bonus_points") or 0)
	return out


def _tiers(program: Optional[str]) -> list[dict[str, Any]]:
	if not program:
		return []
	rows = frappe.get_all("AWANZ Reward Tier", filters={"loyalty_program": program}, fields=["name", "title", "points", "amount", "enabled", "sort_order", "description"], order_by="points asc, sort_order asc")
	return [{"name": r.name, "title": r.title, "points": cint(r.points), "amount": flt(r.amount), "enabled": cint(r.enabled), "description": r.description} for r in rows]


def _coupon_shape(r) -> dict[str, Any]:
	today = getdate(nowdate())
	expired = bool(r.valid_upto and getdate(r.valid_upto) < today)
	exhausted = bool(cint(r.max_uses) and cint(r.used_count) >= cint(r.max_uses))
	return {
		"code": r.name,
		"title": r.title,
		"enabled": cint(r.enabled),
		"discount_type": r.discount_type,
		"value": flt(r.value),
		"min_basket": flt(r.min_basket),
		"usage": r.usage,
		"max_uses": cint(r.max_uses),
		"used_count": cint(r.used_count),
		"customer": r.customer,
		"boutique": r.boutique,
		"boutique_name": _store_name(r.boutique),
		"item_group": r.item_group,
		"valid_from": str(r.valid_from) if r.valid_from else None,
		"valid_upto": str(r.valid_upto) if r.valid_upto else None,
		"state": "off" if not cint(r.enabled) else "expired" if expired else "used up" if exhausted else "live",
		"is_birthday": bool(r.customer) and r.name.startswith("BDAY"),
	}


def _coupons(include_birthday: bool = False, limit: int = 200) -> list[dict[str, Any]]:
	filters: dict[str, Any] = {}
	if not include_birthday:
		filters["customer"] = ("is", "not set")
	rows = frappe.get_all("AWANZ Coupon", filters=filters, fields=["name", "title", "enabled", "discount_type", "value", "min_basket", "usage", "max_uses", "used_count", "customer", "boutique", "item_group", "valid_from", "valid_upto"], order_by="enabled desc, modified desc", limit=cint(limit) or 200)
	return [_coupon_shape(r) for r in rows]


def _giveaway_shape(r, entries: dict[str, tuple[int, int]]) -> dict[str, Any]:
	total, people = entries.get(r.name, (0, 0))
	return {
		"name": r.name,
		"title": r.title,
		"status": r.status,
		"prize_item": r.prize_item,
		"prize_description": r.prize_description,
		"start_date": str(r.start_date) if r.start_date else None,
		"end_date": str(r.end_date) if r.end_date else None,
		"boutique": r.boutique,
		"boutique_name": _store_name(r.boutique),
		"entry_rule": r.entry_rule,
		"amount_per_entry": flt(r.amount_per_entry),
		"max_entries_per_invoice": cint(r.max_entries_per_invoice),
		"requires_member": cint(r.requires_member),
		"description": r.description,
		"entries": cint(r.total_entries) if r.status == "Drawn" else total,
		"participants": cint(r.participants) if r.status == "Drawn" else people,
		"winner": r.winner,
		"winner_name": frappe.db.get_value("Customer", r.winner, "customer_name") if r.winner else None,
		"drawn_on": str(r.drawn_on) if r.drawn_on else None,
	}


def _giveaways(limit: int = 100) -> list[dict[str, Any]]:
	rows = frappe.get_all("AWANZ Giveaway", fields=["name", "title", "status", "prize_item", "prize_description", "start_date", "end_date", "boutique", "entry_rule", "amount_per_entry", "max_entries_per_invoice", "requires_member", "description", "total_entries", "participants", "winner", "drawn_on"], order_by="end_date desc", limit=cint(limit) or 100)
	entries: dict[str, tuple[int, int]] = {}
	if rows:
		for g, total, people in frappe.db.sql("select giveaway, sum(entries), count(distinct customer) from `tabAWANZ Giveaway Entry` where reversed = 0 and giveaway in %s group by giveaway", (tuple(r.name for r in rows),)):
			entries[g] = (cint(total), cint(people))
	return [_giveaway_shape(r, entries) for r in rows]


def _promotion_shape(r) -> dict[str, Any]:
	from maison_pos.api.promotions import _rule_targets

	kind = "rate" if r.rate_or_discount == "Rate" else "percent" if r.rate_or_discount == "Discount Percentage" else "amount"
	today = getdate(nowdate())
	boutique = frappe.db.get_value("AWANZ Store", {"warehouse": r.warehouse}, "name") if r.warehouse else None
	live = not cint(r.disable) and not (r.valid_from and getdate(r.valid_from) > today) and not (r.valid_upto and getdate(r.valid_upto) < today)
	return {
		"name": r.name,
		"title": r.title or r.name,
		"enabled": 0 if cint(r.disable) else 1,
		"apply_on": r.apply_on,
		"targets": _rule_targets(r.name, r.apply_on) if r.apply_on != "Transaction" else [],
		"kind": kind,
		"value": flt(r.rate) if kind == "rate" else flt(r.discount_percentage) if kind == "percent" else flt(r.discount_amount),
		"min_qty": flt(r.min_qty),
		"min_amt": flt(r.min_amt),
		"valid_from": str(r.valid_from) if r.valid_from else None,
		"valid_upto": str(r.valid_upto) if r.valid_upto else None,
		"boutique": boutique,
		"boutique_name": _store_name(boutique),
		"priority": cint(r.priority),
		"state": "off" if cint(r.disable) else "live" if live else "scheduled" if (r.valid_from and getdate(r.valid_from) > today) else "ended",
		"coupon_code_based": cint(r.coupon_code_based),
	}


def _promotions(limit: int = 200) -> list[dict[str, Any]]:
	rows = frappe.get_all(
		"Pricing Rule",
		filters={"selling": 1, "price_or_product_discount": "Price"},
		fields=["name", "title", "disable", "apply_on", "rate_or_discount", "rate", "discount_percentage", "discount_amount", "min_qty", "min_amt", "valid_from", "valid_upto", "warehouse", "priority", "coupon_code_based", "promotional_scheme"],
		order_by="disable asc, valid_upto desc, modified desc",
		limit=cint(limit) or 200,
	)
	out = []
	for r in rows:
		title = (r.title or "").strip()
		# a store's shelf price is not a promotion, and neither is an unnamed rule
		if not title or (title.startswith(STORE_PRICE_PREFIX) and r.rate_or_discount == "Rate" and not r.promotional_scheme):
			continue
		out.append(_promotion_shape(r))
	return out


def _calendar_shape(doc) -> dict[str, Any]:
	return {
		"name": doc.name,
		"month": str(getdate(doc.month).replace(day=1)),
		"title": doc.title,
		"status": doc.status,
		"headline": doc.headline,
		"body": doc.body,
		"coupon": doc.coupon,
		"pricing_rules": [{"name": r.pricing_rule, "title": r.title or frappe.db.get_value("Pricing Rule", r.pricing_rule, "title")} for r in doc.pricing_rules],
		"featured_items": [{"item_code": r.item_code, "item_name": r.item_name or frappe.db.get_value("Item", r.item_code, "item_name"), "blurb": r.blurb} for r in doc.featured_items],
		"sent_on": str(doc.sent_on) if doc.sent_on else None,
		"audience_size": cint(doc.audience_size),
		"notes": doc.notes,
	}


def _calendars(months_back: int = 3, limit: int = 24) -> list[dict[str, Any]]:
	since = add_months(getdate(nowdate()).replace(day=1), -abs(cint(months_back)))
	names = frappe.get_all("AWANZ Promotion Calendar", filters={"month": (">=", since)}, pluck="name", order_by="month desc", limit=cint(limit) or 24)
	return [_calendar_shape(frappe.get_doc("AWANZ Promotion Calendar", n)) for n in names]


@frappe.whitelist()
def overview() -> dict[str, Any]:
	"""Everything the Promotions section shows, in one read."""
	assert_supply_admin()
	program = _program()
	return {
		"program": program,
		"settings": _rewards_settings(),
		"tiers": _tiers(program["name"] if program else None),
		"coupons": _coupons(),
		"giveaways": _giveaways(),
		"promotions": _promotions(),
		"calendar": _calendars(),
		"stores": _stores(),
		"item_groups": frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name", order_by="name asc", limit=500),
		"brands": frappe.get_all("Brand", pluck="name", order_by="name asc", limit=500) if frappe.db.exists("DocType", "Brand") else [],
		"as_of": now_datetime().isoformat(),
	}


# ---------------------------------------------------------------------------------------------
# rewards — the programme and its tiers
# ---------------------------------------------------------------------------------------------
@frappe.whitelist()
def save_rewards_settings(payload: Any) -> dict[str, Any]:
	"""Programme name, points per dollar, stacking, the birthday coupon, promotions on/off."""
	assert_supply_admin()
	p = _payload(payload)
	changed: list[str] = []
	meta = frappe.get_meta("AWANZ POS Settings")
	for key in REWARDS_KEYS:
		if key not in p or not meta.has_field(key):
			continue
		value = p[key]
		field = meta.get_field(key)
		if field.fieldtype == "Check":
			value = 1 if cint(value) else 0
		elif field.fieldtype in ("Int",):
			value = cint(value)
		elif field.fieldtype in ("Float", "Currency", "Percent"):
			value = flt(value)
		elif field.fieldtype == "Select" and value not in (field.options or "").split("\n"):
			frappe.throw(_("{0} must be one of {1}").format(field.label, ", ".join(o for o in (field.options or "").split("\n") if o)), frappe.ValidationError)
		elif field.fieldtype == "Data":
			value = (value or "").strip()
			if key == "rewards_program_name" and not value:
				frappe.throw(_("The programme needs a name — it is printed on every receipt"), frappe.ValidationError)
		if key == "birthday_coupon_value":
			kind = p.get("birthday_coupon_type") or frappe.db.get_single_value("AWANZ POS Settings", "birthday_coupon_type") or "Percent"
			if kind == "Percent" and not (0 <= value <= 100):
				frappe.throw(_("A percent discount is between 0 and 100"), frappe.ValidationError)
			if value < 0:
				frappe.throw(_("The birthday discount cannot be negative"), frappe.ValidationError)
		current = frappe.db.get_single_value("AWANZ POS Settings", key)
		if field.fieldtype in ("Check", "Int"):
			same = cint(current) == value
		elif field.fieldtype in ("Float", "Currency", "Percent"):
			same = abs(flt(current) - value) < 0.000001
		else:
			same = (current or "") == value
		if not same:
			frappe.db.set_single_value("AWANZ POS Settings", key, value)
			changed.append(key)
	# earn rate lives on the Loyalty Program
	if "points_per_dollar" in p:
		from maison_pos.api.rewards import default_program

		lp = default_program()
		ppd = flt(p["points_per_dollar"])
		if not lp:
			frappe.throw(_("No loyalty programme exists yet"), frappe.ValidationError)
		if ppd <= 0 or ppd > 100:
			frappe.throw(_("Points per dollar must be between 0.01 and 100"), frappe.ValidationError)
		factor = round(1.0 / ppd, 6)
		doc = frappe.get_doc("Loyalty Program", lp["name"])
		if not doc.collection_rules:
			doc.append("collection_rules", {"tier_name": "Member", "collection_factor": factor, "min_spent": 0})
			changed.append("points_per_dollar")
		elif abs(flt(doc.collection_rules[0].collection_factor) - factor) > 0.000001:
			doc.collection_rules[0].collection_factor = factor
			changed.append("points_per_dollar")
		if "points_per_dollar" in changed:
			_save(doc)
	if changed:
		frappe.clear_cache(doctype="AWANZ POS Settings")
		frappe.clear_document_cache("AWANZ POS Settings", "AWANZ POS Settings")
	return {"changed": changed, "settings": _rewards_settings(), "program": _program()}


@frappe.whitelist()
def save_tier(payload: Any) -> dict[str, Any]:
	"""Create or update one reward tier (``name`` present → update)."""
	from maison_pos.api.rewards import default_program

	assert_supply_admin()
	p = _payload(payload)
	points = cint(p.get("points"))
	amount = flt(p.get("amount"))
	if points <= 0:
		frappe.throw(_("A tier needs a points figure above zero"), frappe.ValidationError)
	if amount <= 0:
		frappe.throw(_("A tier needs a dollar value above zero"), frappe.ValidationError)
	title = (p.get("title") or "").strip() or f"${amount:g} off at {points} points"
	if p.get("name"):
		doc = frappe.get_doc("AWANZ Reward Tier", p["name"])
	else:
		lp = default_program()
		if not lp:
			frappe.throw(_("No loyalty programme exists yet"), frappe.ValidationError)
		if frappe.db.exists("AWANZ Reward Tier", {"loyalty_program": lp["name"], "points": points}):
			frappe.throw(_("There is already a tier at {0} points — edit that one").format(points), frappe.DuplicateEntryError)
		doc = frappe.new_doc("AWANZ Reward Tier")
		doc.loyalty_program = lp["name"]
	doc.update({"title": title, "points": points, "amount": amount, "enabled": 1 if cint(p.get("enabled", 1)) else 0, "sort_order": points, "description": (p.get("description") or "").strip() or None})
	_save(doc)
	return {"tier": {"name": doc.name, "title": doc.title, "points": cint(doc.points), "amount": flt(doc.amount), "enabled": cint(doc.enabled), "description": doc.description}, "tiers": _tiers(doc.loyalty_program)}


# ---------------------------------------------------------------------------------------------
# coupons
# ---------------------------------------------------------------------------------------------
@frappe.whitelist()
def save_coupon(payload: Any) -> dict[str, Any]:
	"""Create (``code`` new) or update a coupon. The code cannot change once printed on
	anything, so an existing code updates that coupon."""
	from maison_pos.awanz_pos.doctype.awanz_coupon.awanz_coupon import normalize_code

	assert_supply_admin()
	p = _payload(payload)
	code = normalize_code(p.get("code"))
	if not code or len(code) < 3 or len(code) > 24:
		frappe.throw(_("A coupon code is 3 to 24 letters or digits"), frappe.ValidationError)
	if not (p.get("title") or "").strip():
		frappe.throw(_("Give the coupon a title — it is what the receipt says"), frappe.ValidationError)
	existing = frappe.db.exists("AWANZ Coupon", code)
	doc = frappe.get_doc("AWANZ Coupon", code) if existing else frappe.new_doc("AWANZ Coupon")
	if not existing:
		doc.code = code
	boutique = p.get("boutique") or None
	if boutique and not frappe.db.exists("AWANZ Store", boutique):
		frappe.throw(_("Store {0} does not exist").format(boutique), frappe.DoesNotExistError)
	item_group = p.get("item_group") or None
	if item_group and not frappe.db.exists("Item Group", item_group):
		frappe.throw(_("Item group {0} does not exist").format(item_group), frappe.DoesNotExistError)
	doc.update(
		{
			"title": p["title"].strip(),
			"enabled": 1 if cint(p.get("enabled", 1)) else 0,
			"discount_type": p.get("discount_type") or "Percent",
			"value": flt(p.get("value")),
			"min_basket": flt(p.get("min_basket")),
			"usage": p.get("usage") or "Multi-use",
			"max_uses": cint(p.get("max_uses")),
			"boutique": boutique,
			"item_group": item_group,
			"valid_from": p.get("valid_from") or None,
			"valid_upto": p.get("valid_upto") or None,
		}
	)
	if doc.discount_type not in ("Percent", "Amount"):
		frappe.throw(_("Discount type is Percent or Amount"), frappe.ValidationError)
	if doc.usage not in ("Single-use", "Multi-use"):
		frappe.throw(_("Usage is Single-use or Multi-use"), frappe.ValidationError)
	if existing:
		_save(doc)
	else:
		doc.flags.ignore_permissions = True
		doc.insert()
	row = frappe.get_all("AWANZ Coupon", filters={"name": doc.name}, fields=["name", "title", "enabled", "discount_type", "value", "min_basket", "usage", "max_uses", "used_count", "customer", "boutique", "item_group", "valid_from", "valid_upto"])[0]
	return {"coupon": _coupon_shape(row), "created": not existing}


@frappe.whitelist()
def set_coupon_enabled(code: str, enabled: int = 0) -> dict[str, Any]:
	assert_supply_admin()
	if not frappe.db.exists("AWANZ Coupon", code):
		frappe.throw(_("Coupon {0} does not exist").format(code), frappe.DoesNotExistError)
	frappe.db.set_value("AWANZ Coupon", code, "enabled", 1 if cint(enabled) else 0)
	row = frappe.get_all("AWANZ Coupon", filters={"name": code}, fields=["name", "title", "enabled", "discount_type", "value", "min_basket", "usage", "max_uses", "used_count", "customer", "boutique", "item_group", "valid_from", "valid_upto"])[0]
	return {"coupon": _coupon_shape(row)}


# ---------------------------------------------------------------------------------------------
# giveaways
# ---------------------------------------------------------------------------------------------
@frappe.whitelist()
def save_giveaway(payload: Any) -> dict[str, Any]:
	"""Create or update a giveaway. Status moves Draft → Open → Closed here; *Drawn* only
	through ``draw_giveaway``."""
	assert_supply_admin()
	p = _payload(payload)
	if not (p.get("title") or "").strip():
		frappe.throw(_("Give the giveaway a title"), frappe.ValidationError)
	if not p.get("start_date") or not p.get("end_date"):
		frappe.throw(_("A giveaway runs between two dates"), frappe.ValidationError)
	status = p.get("status") or "Draft"
	if status not in ("Draft", "Open", "Closed"):
		frappe.throw(_("Status is Draft, Open or Closed — a winner is picked with Draw"), frappe.ValidationError)
	doc = frappe.get_doc("AWANZ Giveaway", p["name"]) if p.get("name") else frappe.new_doc("AWANZ Giveaway")
	if doc.get("status") == "Drawn":
		frappe.throw(_("{0} has been drawn and can no longer change").format(doc.name), frappe.ValidationError)
	boutique = p.get("boutique") or None
	if boutique and not frappe.db.exists("AWANZ Store", boutique):
		frappe.throw(_("Store {0} does not exist").format(boutique), frappe.DoesNotExistError)
	prize_item = p.get("prize_item") or None
	if prize_item and not frappe.db.exists("Item", prize_item):
		frappe.throw(_("Item {0} does not exist").format(prize_item), frappe.DoesNotExistError)
	doc.update(
		{
			"title": p["title"].strip(),
			"status": status,
			"prize_item": prize_item,
			"prize_description": (p.get("prize_description") or "").strip() or (frappe.db.get_value("Item", prize_item, "item_name") if prize_item else None),
			"start_date": p["start_date"],
			"end_date": p["end_date"],
			"boutique": boutique,
			"entry_rule": p.get("entry_rule") or "Per amount",
			"amount_per_entry": flt(p.get("amount_per_entry") or frappe.db.get_single_value("AWANZ POS Settings", "giveaway_entries_per_amount") or 25),
			"max_entries_per_invoice": cint(p.get("max_entries_per_invoice", 10)),
			"requires_member": 1 if cint(p.get("requires_member", 1)) else 0,
			"description": (p.get("description") or "").strip() or None,
		}
	)
	if doc.entry_rule not in ("Per amount", "Per visit"):
		frappe.throw(_("Entry rule is Per amount or Per visit"), frappe.ValidationError)
	if doc.is_new():
		doc.flags.ignore_permissions = True
		doc.insert()
	else:
		_save(doc)
	return {"giveaway": [g for g in _giveaways() if g["name"] == doc.name][0], "created": not p.get("name")}


@frappe.whitelist()
def draw_giveaway(name: str) -> dict[str, Any]:
	"""Pick the winner — ``rewards.draw`` (seeded, auditable), opened to the warehouse admin."""
	from maison_pos.api.rewards import draw

	assert_supply_admin()
	out = draw(name, notify=1)
	return {"draw": out, "giveaway": [g for g in _giveaways() if g["name"] == name][0]}


# ---------------------------------------------------------------------------------------------
# sales — Pricing Rules the POS applies automatically
# ---------------------------------------------------------------------------------------------
@frappe.whitelist()
def save_promotion(payload: Any) -> dict[str, Any]:
	"""Create or update a sale: *N% off / $N off / a fixed price* on items, a group, a brand or
	the whole basket, at one store or every store, between two dates."""
	assert_supply_admin()
	p = _payload(payload)
	title = (p.get("title") or "").strip()
	if not title:
		frappe.throw(_("Give the sale a name — the till shows it on the line"), frappe.ValidationError)
	if title.startswith(STORE_PRICE_PREFIX):
		frappe.throw(_("A sale's name may not start with 'AWANZ ' — that shape is reserved for store shelf prices"), frappe.ValidationError)
	apply_on = p.get("apply_on") or "Item Code"
	if apply_on not in APPLY_ON:
		frappe.throw(_("Apply on is Item Code, Item Group, Brand or Transaction"), frappe.ValidationError)
	kind = p.get("kind") or "percent"
	if kind not in PROMO_KINDS:
		frappe.throw(_("Kind is percent, amount or rate"), frappe.ValidationError)
	value = flt(p.get("value"))
	if value <= 0:
		frappe.throw(_("The discount must be above zero"), frappe.ValidationError)
	if kind == "percent" and value > 100:
		frappe.throw(_("A percent discount is at most 100"), frappe.ValidationError)
	if apply_on == "Transaction" and kind == "rate":
		frappe.throw(_("A fixed price applies to items, not to the whole basket"), frappe.ValidationError)
	targets = p.get("targets") or []
	if isinstance(targets, str):
		targets = [t.strip() for t in targets.split(",") if t.strip()]
	child_dt, child_field, link_dt = APPLY_ON[apply_on]
	if apply_on != "Transaction":
		if not targets:
			frappe.throw(_("Pick at least one {0}").format(link_dt.lower()), frappe.ValidationError)
		for t in targets:
			if not frappe.db.exists(link_dt, t):
				frappe.throw(_("{0} {1} does not exist").format(link_dt, t), frappe.DoesNotExistError)
	boutique = p.get("boutique") or None
	warehouse = None
	if boutique:
		warehouse = frappe.db.get_value("AWANZ Store", boutique, "warehouse")
		if not warehouse:
			frappe.throw(_("Store {0} does not exist").format(boutique), frappe.DoesNotExistError)
	valid_from = p.get("valid_from") or nowdate()
	valid_upto = p.get("valid_upto") or None
	if valid_upto and getdate(valid_upto) < getdate(valid_from):
		frappe.throw(_("The sale cannot end before it starts"), frappe.ValidationError)
	if p.get("name"):
		rule = frappe.get_doc("Pricing Rule", p["name"])
		if (rule.title or "").startswith(STORE_PRICE_PREFIX) and rule.rate_or_discount == "Rate" and not rule.promotional_scheme:
			frappe.throw(_("{0} is a store shelf price, not a sale").format(rule.name), frappe.ValidationError)
	else:
		rule = frappe.new_doc("Pricing Rule")
	company = frappe.db.get_value("AWANZ Store", boutique, "company") if boutique else (frappe.defaults.get_global_default("company") or frappe.db.get_value("Company", {}, "name"))
	rule.update(
		{
			"title": title,
			"apply_on": apply_on,
			"price_or_product_discount": "Price",
			"selling": 1,
			"buying": 0,
			"rate_or_discount": PROMO_KINDS[kind],
			"rate": value if kind == "rate" else 0,
			"discount_percentage": value if kind == "percent" else 0,
			"discount_amount": value if kind == "amount" else 0,
			"min_qty": flt(p.get("min_qty")),
			"max_qty": 0,
			"min_amt": flt(p.get("min_amt")),
			"max_amt": 0,
			"valid_from": valid_from,
			"valid_upto": valid_upto,
			"warehouse": warehouse,
			"company": company,
			"currency": frappe.get_cached_value("Company", company, "default_currency") if company else None,
			"priority": str(cint(p.get("priority") or 5)),
			"disable": 0 if cint(p.get("enabled", 1)) else 1,
			"coupon_code_based": 0,
			"apply_multiple_pricing_rules": 0,
		}
	)
	for table in ("items", "item_groups", "brands"):
		rule.set(table, [])
	if apply_on == "Item Code":
		for t in targets:
			rule.append("items", {"item_code": t, "uom": frappe.db.get_value("Item", t, "stock_uom")})
	elif apply_on == "Item Group":
		for t in targets:
			rule.append("item_groups", {"item_group": t})
	elif apply_on == "Brand":
		for t in targets:
			rule.append("brands", {"brand": t})
	if rule.is_new():
		rule.flags.ignore_permissions = True
		rule.insert()
	else:
		_save(rule)
	row = frappe.get_all("Pricing Rule", filters={"name": rule.name}, fields=["name", "title", "disable", "apply_on", "rate_or_discount", "rate", "discount_percentage", "discount_amount", "min_qty", "min_amt", "valid_from", "valid_upto", "warehouse", "priority", "coupon_code_based", "promotional_scheme"])[0]
	return {"promotion": _promotion_shape(row), "created": not p.get("name")}


@frappe.whitelist()
def set_promotion_enabled(name: str, enabled: int = 0) -> dict[str, Any]:
	assert_supply_admin()
	row = frappe.db.get_value("Pricing Rule", name, ["title", "rate_or_discount", "promotional_scheme"], as_dict=True)
	if not row:
		frappe.throw(_("Sale {0} does not exist").format(name), frappe.DoesNotExistError)
	if (row.title or "").startswith(STORE_PRICE_PREFIX) and row.rate_or_discount == "Rate" and not row.promotional_scheme:
		frappe.throw(_("{0} is a store shelf price — change it through Prices").format(name), frappe.ValidationError)
	frappe.db.set_value("Pricing Rule", name, "disable", 0 if cint(enabled) else 1)
	out = frappe.get_all("Pricing Rule", filters={"name": name}, fields=["name", "title", "disable", "apply_on", "rate_or_discount", "rate", "discount_percentage", "discount_amount", "min_qty", "min_amt", "valid_from", "valid_upto", "warehouse", "priority", "coupon_code_based", "promotional_scheme"])[0]
	return {"promotion": _promotion_shape(out)}


# ---------------------------------------------------------------------------------------------
# the monthly calendar
# ---------------------------------------------------------------------------------------------
@frappe.whitelist()
def save_calendar(payload: Any) -> dict[str, Any]:
	"""One row per month: headline, copy, the coupon, the sales to switch on, featured items.
	The daily job sends it on the 1st; ``send_calendar`` sends it now."""
	assert_supply_admin()
	p = _payload(payload)
	if not p.get("month"):
		frappe.throw(_("Which month?"), frappe.ValidationError)
	month = getdate(p["month"]).replace(day=1)
	name = f"PROMO-{month.strftime('%Y-%m')}"
	existed = bool(frappe.db.exists("AWANZ Promotion Calendar", name))
	doc = frappe.get_doc("AWANZ Promotion Calendar", name) if existed else frappe.new_doc("AWANZ Promotion Calendar")
	if doc.get("status") == "Sent" and p.get("status") not in (None, "Sent", "Closed"):
		frappe.throw(_("{0} has been sent; it can only be closed now").format(name), frappe.ValidationError)
	coupon = p.get("coupon") or None
	if coupon and not frappe.db.exists("AWANZ Coupon", coupon):
		frappe.throw(_("Coupon {0} does not exist").format(coupon), frappe.DoesNotExistError)
	status = p.get("status") or doc.get("status") or "Planned"
	if status not in ("Planned", "Active", "Sent", "Closed"):
		frappe.throw(_("Status is Planned, Active or Closed"), frappe.ValidationError)
	doc.update({"month": month, "title": (p.get("title") or "").strip() or f"{month.strftime('%B %Y')} promotions", "status": status, "headline": (p.get("headline") or "").strip() or None, "body": p.get("body") or None, "coupon": coupon, "notes": (p.get("notes") or "").strip() or None})
	if "pricing_rules" in p:
		doc.set("pricing_rules", [])
		for r in p.get("pricing_rules") or []:
			rn = r.get("name") if isinstance(r, dict) else r
			if not frappe.db.exists("Pricing Rule", rn):
				frappe.throw(_("Sale {0} does not exist").format(rn), frappe.DoesNotExistError)
			doc.append("pricing_rules", {"pricing_rule": rn})
	if "featured_items" in p:
		doc.set("featured_items", [])
		for r in p.get("featured_items") or []:
			code = r.get("item_code") if isinstance(r, dict) else r
			if not frappe.db.exists("Item", code):
				frappe.throw(_("Item {0} does not exist").format(code), frappe.DoesNotExistError)
			doc.append("featured_items", {"item_code": code, "blurb": (r.get("blurb") if isinstance(r, dict) else None) or None})
	if doc.is_new():
		doc.flags.ignore_permissions = True
		doc.insert()
	else:
		_save(doc)
	return {"calendar": _calendar_shape(doc), "created": not existed}


@frappe.whitelist()
def send_calendar(name: str) -> dict[str, Any]:
	"""Send this month's promotions to members now rather than on the 1st."""
	from maison_pos.api.rewards import send_monthly_promotions

	assert_supply_admin()
	doc = frappe.get_doc("AWANZ Promotion Calendar", name)
	if doc.status == "Sent":
		frappe.throw(_("{0} has already been sent").format(name), frappe.ValidationError)
	if doc.status == "Closed":
		frappe.throw(_("{0} is closed").format(name), frappe.ValidationError)
	out = send_monthly_promotions(today=getdate(doc.month).replace(day=1), force=1)
	return {"sent": out, "calendar": _calendar_shape(frappe.get_doc("AWANZ Promotion Calendar", name))}
