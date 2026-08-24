"""Promotions, coupons and loyalty polish (v0.4 section I).

* **Promotions** are native ERPNext Pricing Rules / Promotional Schemes. ``active(boutique)``
  returns the ones the POS can apply (selling, valid today, warehouse = boutique or blank)
  in a compact shape; the POS applies percent / amount rules client-side and shows them as a
  promo line. Tier scoping uses the Pricing Rule ``customer_group`` = tier name
  (``AWANZ Collectors`` tiers are mirrored as Customer Groups by the seed).
* **Coupons** are ``AWANZ Coupon`` rows. ``validate_coupon`` is used both by the POS preview
  (``check_coupon``) and by ``sales.submit_batch`` (``apply_coupon_to_invoice``): the POS sends
  ``coupon_code`` plus the per-line ``coupon_discount`` it displayed, the server recomputes
  the discount from the same rules and rejects a mismatch with ``COUPON_INVALID``.
* **Loyalty polish**: ``tier_progress(customer)`` (progress to the next tier, expiring points)
  and the daily ``birthday_bonus`` job.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, now_datetime, nowdate

from maison_pos.api.sales import AwanzPOSError  # sales imports this module lazily: no cycle
from maison_pos.awanz_pos.doctype.awanz_coupon.awanz_coupon import normalize_code
from maison_pos.scoping import ALL_AWANZ_ROLES, assert_boutique_access, assert_roles

ERR_COUPON_INVALID = "COUPON_INVALID"


class CouponError(AwanzPOSError):
	"""Raised when a coupon cannot be applied; ``reason`` is machine readable (``details.reason`` in submit_batch)."""

	error_code = ERR_COUPON_INVALID

	def __init__(self, message: str, reason: str):
		super().__init__(message, ERR_COUPON_INVALID, reason=reason)
		self.reason = reason


# ---------------------------------------------------------------------------
# settings (custom fields on AWANZ POS Settings, see setup/install_v04_crm.py)
# ---------------------------------------------------------------------------
def _setting(key: str, default: Any) -> Any:
	try:
		value = frappe.db.get_single_value("AWANZ POS Settings", key)
	except Exception:
		return default
	return default if value in (None, "") else value


def promotions_enabled() -> bool:
	return bool(cint(_setting("promotions_enabled", 1)))


# ---------------------------------------------------------------------------
# promotions (Pricing Rules)
# ---------------------------------------------------------------------------
PRICING_RULE_FIELDS = [
	"name",
	"title",
	"apply_on",
	"price_or_product_discount",
	"rate_or_discount",
	"rate",
	"discount_percentage",
	"discount_amount",
	"min_qty",
	"max_qty",
	"min_amt",
	"max_amt",
	"valid_from",
	"valid_upto",
	"warehouse",
	"customer_group",
	"priority",
	"promotional_scheme",
	"coupon_code_based",
	"free_item",
	"free_qty",
	"same_item",
	"apply_multiple_pricing_rules",
]


def _rule_targets(rule_name: str, apply_on: str) -> list[str]:
	table = {"Item Code": ("Pricing Rule Item Code", "item_code"), "Item Group": ("Pricing Rule Item Group", "item_group"), "Brand": ("Pricing Rule Brand", "brand")}.get(apply_on)
	if not table:
		return []
	return frappe.get_all(table[0], filters={"parent": rule_name}, pluck=table[1])


def _promo_shape(r: dict[str, Any]) -> dict[str, Any]:
	kind = "rate" if r.rate_or_discount == "Rate" else "percent" if r.rate_or_discount == "Discount Percentage" else "amount"
	if r.price_or_product_discount == "Product":
		kind = "free_item"
	return {
		"name": r.name,
		"title": r.title or r.name,
		"apply_on": r.apply_on,
		"targets": _rule_targets(r.name, r.apply_on) if r.apply_on != "Transaction" else [],
		"kind": kind,
		"rate": flt(r.rate),
		"discount_percentage": flt(r.discount_percentage),
		"discount_amount": flt(r.discount_amount),
		"min_qty": flt(r.min_qty),
		"max_qty": flt(r.max_qty),
		"min_amt": flt(r.min_amt),
		"max_amt": flt(r.max_amt),
		"valid_from": str(r.valid_from) if r.valid_from else None,
		"valid_upto": str(r.valid_upto) if r.valid_upto else None,
		"warehouse": r.warehouse,
		"tier": r.customer_group if r.customer_group and frappe.db.exists("Customer Group", {"name": r.customer_group, "is_group": 0}) and _is_tier_group(r.customer_group) else None,
		"customer_group": r.customer_group,
		"priority": cint(r.priority),
		"promotional_scheme": r.promotional_scheme,
		"free_item": r.free_item,
		"free_qty": flt(r.free_qty),
		"same_item": cint(r.same_item),
	}


def _tier_names() -> set[str]:
	return set(frappe.get_all("Loyalty Program Collection", fields=["tier_name"], pluck="tier_name"))


def _is_tier_group(group: str) -> bool:
	return group in _tier_names()


@frappe.whitelist()
def active(boutique: str, date: Optional[str] = None) -> dict[str, Any]:
	"""Promotions the POS may apply at *boutique* today + coupon availability flags."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	warehouse = frappe.db.get_value("AWANZ Store", boutique, "warehouse")
	today = getdate(date or nowdate())
	rows = frappe.get_all(
		"Pricing Rule",
		filters={"disable": 0, "selling": 1, "coupon_code_based": 0},
		fields=PRICING_RULE_FIELDS,
		order_by="priority desc, name asc",
	)
	promos = []
	for r in rows:
		if r.warehouse and r.warehouse != warehouse:
			continue
		if r.valid_from and getdate(r.valid_from) > today:
			continue
		if r.valid_upto and getdate(r.valid_upto) < today:
			continue
		if r.rate_or_discount == "Rate" and not r.promotional_scheme and not (r.title or "").strip():
			# plain store price overrides (AWANZ Price Change Request) are already in bootstrap.pricing_rules
			continue
		promos.append(_promo_shape(r))
	return {
		"boutique": boutique,
		"date": str(today),
		"enabled": promotions_enabled(),
		"promotions": promos,
		"coupons_available": frappe.db.count("AWANZ Coupon", {"enabled": 1}) > 0,
		"version": now_datetime().isoformat(),
	}


# ---------------------------------------------------------------------------
# coupons
# ---------------------------------------------------------------------------
def _line_net(line: dict[str, Any]) -> float:
	return flt(flt(line.get("qty") or 1) * flt(line.get("rate")) - flt(line.get("discount_amount")), 2)


def eligible_lines(coupon: dict[str, Any], lines: list[dict[str, Any]]) -> list[int]:
	"""Indexes of lines the coupon applies to (item_group scope)."""
	if not coupon.get("item_group"):
		return list(range(len(lines)))
	out = []
	for i, line in enumerate(lines):
		group = line.get("item_group") or frappe.db.get_value("Item", line.get("item_code"), "item_group")
		if group == coupon["item_group"]:
			out.append(i)
	return out


def distribute_discount(total: float, nets: list[float]) -> list[float]:
	"""Split *total* across lines proportionally to *nets* (cents, remainder on the last line)."""
	base = sum(nets)
	if base <= 0 or total <= 0:
		return [0.0 for _ in nets]
	out = []
	acc = 0.0
	for i, n in enumerate(nets):
		if i == len(nets) - 1:
			out.append(flt(total - acc, 2))
		else:
			share = flt(total * n / base, 2)
			out.append(share)
			acc = flt(acc + share, 2)
	return out


def compute_coupon_discount(coupon: dict[str, Any], lines: list[dict[str, Any]]) -> tuple[float, list[float]]:
	"""(total_discount, per_line_discount) for *coupon* over POSInvoice-style *lines*."""
	idx = eligible_lines(coupon, lines)
	nets = [_line_net(lines[i]) for i in idx]
	base = flt(sum(nets), 2)
	if base <= 0:
		return 0.0, [0.0 for _ in lines]
	if coupon["discount_type"] == "Percent":
		total = flt(base * flt(coupon["value"]) / 100.0, 2)
	else:
		total = min(flt(coupon["value"]), base)
	split = distribute_discount(total, nets)
	per_line = [0.0 for _ in lines]
	for j, i in enumerate(idx):
		per_line[i] = split[j]
	return total, per_line


def validate_coupon(code: str, lines: list[dict[str, Any]], boutique: Optional[str] = None, customer: Optional[str] = None, date: Any = None) -> dict[str, Any]:
	"""Load and check a coupon for the basket. Raises :class:`CouponError`; returns the discount."""
	code = normalize_code(code)
	if not code:
		raise CouponError(_("Coupon code is required"), "missing")
	coupon = frappe.db.get_value(
		"AWANZ Coupon",
		code,
		["name", "code", "title", "enabled", "discount_type", "value", "min_basket", "usage", "max_uses", "used_count", "customer", "boutique", "item_group", "valid_from", "valid_upto"],
		as_dict=True,
	)
	if not coupon:
		raise CouponError(_("Unknown coupon {0}").format(code), "unknown")
	if not cint(coupon.enabled):
		raise CouponError(_("Coupon {0} is disabled").format(code), "disabled")
	today = getdate(date or nowdate())
	if coupon.valid_from and getdate(coupon.valid_from) > today:
		raise CouponError(_("Coupon {0} is not valid yet").format(code), "not_started")
	if coupon.valid_upto and getdate(coupon.valid_upto) < today:
		raise CouponError(_("Coupon {0} has expired").format(code), "expired")
	if coupon.boutique and boutique and coupon.boutique != boutique:
		raise CouponError(_("Coupon {0} is only valid at {1}").format(code, coupon.boutique), "wrong_boutique")
	if coupon.customer and coupon.customer != customer:
		raise CouponError(_("Coupon {0} is reserved for another client").format(code), "wrong_customer")
	limit = 1 if coupon.usage == "Single-use" else cint(coupon.max_uses)
	if limit and cint(coupon.used_count) >= limit:
		raise CouponError(_("Coupon {0} has already been used").format(code), "exhausted")
	total, per_line = compute_coupon_discount(coupon, lines)
	basket_net = flt(sum(_line_net(line) for line in lines), 2)
	if flt(coupon.min_basket) and basket_net < flt(coupon.min_basket):
		raise CouponError(_("Coupon {0} needs a basket of at least {1}").format(code, flt(coupon.min_basket)), "min_basket")
	if total <= 0:
		raise CouponError(_("Coupon {0} does not apply to anything in this basket").format(code), "not_applicable")
	return {
		"code": coupon.code,
		"title": coupon.title,
		"discount_type": coupon.discount_type,
		"value": flt(coupon.value),
		"item_group": coupon.item_group,
		"customer": coupon.customer,
		"discount": total,
		"per_line": per_line,
		"uses_left": (limit - cint(coupon.used_count)) if limit else None,
	}


def _parse_lines(lines: Any) -> list[dict[str, Any]]:
	if isinstance(lines, str):
		lines = json.loads(lines or "[]")
	return [dict(line) for line in (lines or [])]


@frappe.whitelist()
def check_coupon(code: str, lines: Any, boutique: Optional[str] = None, customer: Optional[str] = None) -> dict[str, Any]:
	"""POS preview: ``{valid, code, title, discount, per_line, reason?}`` — never raises for a bad code."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	if boutique:
		boutique = assert_boutique_access(boutique)
	try:
		return {"valid": True, **validate_coupon(code, _parse_lines(lines), boutique, customer)}
	except CouponError as exc:
		return {"valid": False, "code": normalize_code(code), "reason": exc.reason, "message": str(exc)}


def apply_coupon_to_invoice(si, payload: dict[str, Any]) -> None:
	"""Called from ``sales.build_sales_invoice``: validate ``payload.coupon_code`` and fold the
	coupon discount into the line discounts (so taxes are computed on the discounted net).

	The device sends the per-line ``coupon_discount`` it showed the client; a mismatch with the
	server computation (> 1 cent in total) is rejected so the receipt always equals the server total.
	"""
	code = normalize_code(payload.get("coupon_code"))
	promos = payload.get("promotions")
	if promos:
		si.maison_promotions = json.dumps(promos) if not isinstance(promos, str) else promos
	if not code:
		return
	payload_items = payload.get("items") or []
	# POSInvoice semantics: `rate` = unit list rate, `discount_amount` = manual discount for the whole line
	lines = [
		{"item_code": line.get("item_code"), "qty": flt(line.get("qty") or 1), "rate": flt(line.get("rate")), "discount_amount": flt(line.get("discount_amount"))}
		for line in payload_items
	]
	info = validate_coupon(code, lines, si.maison_boutique, si.customer, si.posting_date)
	client_total = flt(sum(flt(line.get("coupon_discount")) for line in payload_items), 2)
	if client_total and abs(client_total - info["discount"]) > 0.011:
		raise CouponError(_("Coupon discount mismatch: device {0}, server {1}").format(client_total, info["discount"]), "mismatch")
	for row, line, extra in zip(si.items, lines, info["per_line"]):
		if not extra:
			continue
		qty = flt(line["qty"]) or 1
		line_discount = flt(line["discount_amount"] + extra, 2)
		row.price_list_rate = flt(line["rate"])
		row.discount_amount = flt(line_discount / qty, 4)  # ERPNext: per unit
		row.rate = flt(row.price_list_rate - row.discount_amount, 4)
		row.maison_coupon_discount = extra
	si.maison_coupon = info["code"]
	si.maison_coupon_discount = info["discount"]


def on_invoice_submit(doc, method: Optional[str] = None) -> None:
	"""Record the redemption and bump ``used_count`` (hooks.doc_events, grouped with v0.4)."""
	if not doc.get("is_pos") or not doc.get("maison_coupon") or doc.get("is_return"):
		return
	if frappe.db.exists("AWANZ Coupon Redemption", {"sales_invoice": doc.name}):
		return
	red = frappe.get_doc(
		{
			"doctype": "AWANZ Coupon Redemption",
			"coupon": doc.maison_coupon,
			"sales_invoice": doc.name,
			"customer": doc.customer,
			"boutique": doc.get("maison_boutique"),
			"amount": flt(doc.get("maison_coupon_discount")),
			"ts": now_datetime(),
		}
	)
	red.flags.ignore_permissions = True
	red.insert()
	frappe.db.set_value("AWANZ Coupon", doc.maison_coupon, "used_count", cint(frappe.db.get_value("AWANZ Coupon", doc.maison_coupon, "used_count")) + 1, update_modified=False)


def on_invoice_cancel(doc, method: Optional[str] = None) -> None:
	"""Give the use back when the invoice is cancelled."""
	if not doc.get("is_pos") or not doc.get("maison_coupon"):
		return
	name = frappe.db.get_value("AWANZ Coupon Redemption", {"sales_invoice": doc.name, "reversed": 0}, "name")
	if not name:
		return
	frappe.db.set_value("AWANZ Coupon Redemption", name, "reversed", 1, update_modified=False)
	used = cint(frappe.db.get_value("AWANZ Coupon", doc.maison_coupon, "used_count"))
	frappe.db.set_value("AWANZ Coupon", doc.maison_coupon, "used_count", max(used - 1, 0), update_modified=False)


@frappe.whitelist()
def performance(from_date: Optional[str] = None, to_date: Optional[str] = None, boutique: Optional[str] = None) -> dict[str, Any]:
	"""Promotion / coupon performance for a period (HQ & managers): redemptions, discount given, revenue carried."""
	assert_roles("AWANZ Manager", "AWANZ Regional", "AWANZ Head Office", "System Manager")
	to_date = getdate(to_date or nowdate())
	from_date = getdate(from_date) if from_date else add_days(to_date, -30)
	if boutique:
		boutique = assert_boutique_access(boutique)
	filters: dict[str, Any] = {"ts": ("between", (f"{from_date} 00:00:00", f"{to_date} 23:59:59")), "reversed": 0}
	if boutique:
		filters["boutique"] = boutique
	reds = frappe.get_all("AWANZ Coupon Redemption", filters=filters, fields=["coupon", "sales_invoice", "amount", "boutique"])
	by_coupon: dict[str, dict[str, Any]] = {}
	for r in reds:
		c = by_coupon.setdefault(r.coupon, {"coupon": r.coupon, "title": frappe.db.get_value("AWANZ Coupon", r.coupon, "title"), "redemptions": 0, "discount": 0.0, "revenue": 0.0})
		c["redemptions"] += 1
		c["discount"] = flt(c["discount"] + flt(r.amount), 2)
		c["revenue"] = flt(c["revenue"] + flt(frappe.db.get_value("Sales Invoice", r.sales_invoice, "base_net_total")), 2)
	inv_filters: dict[str, Any] = {"docstatus": 1, "is_pos": 1, "posting_date": ("between", (from_date, to_date)), "maison_promotions": ("is", "set")}
	if boutique:
		inv_filters["maison_boutique"] = boutique
	by_promo: dict[str, dict[str, Any]] = {}
	for inv in frappe.get_all("Sales Invoice", filters=inv_filters, fields=["name", "maison_promotions", "base_net_total"]):
		try:
			applied = json.loads(inv.maison_promotions or "[]")
		except Exception:
			continue
		for p in applied:
			key = p.get("name") or p.get("title") or "?"
			row = by_promo.setdefault(key, {"promotion": key, "title": p.get("title") or key, "invoices": 0, "discount": 0.0, "revenue": 0.0})
			row["invoices"] += 1
			row["discount"] = flt(row["discount"] + flt(p.get("discount")), 2)
			row["revenue"] = flt(row["revenue"] + flt(inv.base_net_total), 2)
	return {"from_date": str(from_date), "to_date": str(to_date), "coupons": sorted(by_coupon.values(), key=lambda x: -x["discount"]), "promotions": sorted(by_promo.values(), key=lambda x: -x["discount"])}


# ---------------------------------------------------------------------------
# loyalty polish
# ---------------------------------------------------------------------------
def tier_progress(customer: str, company: Optional[str] = None) -> dict[str, Any]:
	"""Tier ladder + progress to the next tier + points expiring within 90 days."""
	program = frappe.db.get_value("Customer", customer, "loyalty_program")
	if not program:
		return {"program": None, "tier": None, "points": 0.0, "tiers": [], "next_tier": None, "progress": 0.0}
	lp = frappe.get_cached_doc("Loyalty Program", program)
	tiers = sorted(
		[{"tier": r.tier_name, "min_spent": flt(r.min_spent), "collection_factor": flt(r.collection_factor)} for r in lp.collection_rules],
		key=lambda t: t["min_spent"],
	)
	from erpnext.accounts.doctype.loyalty_program.loyalty_program import get_loyalty_program_details_with_points

	try:
		d = get_loyalty_program_details_with_points(customer, loyalty_program=program, company=company or lp.company, silent=True)
	except Exception:
		d = frappe._dict()
	points = flt(d.get("loyalty_points"))
	override = frappe.db.get_value("AWANZ Client Profile", customer, "vip_tier_override") if frappe.db.exists("DocType", "AWANZ Client Profile") else None
	# total spent inside the program window (same rule ERPNext uses to pick the tier)
	window_from = lp.from_date
	spent = flt(
		frappe.db.get_value(
			"Sales Invoice",
			{"customer": customer, "docstatus": 1, "posting_date": (">=", window_from) if window_from else ("!=", None)},
			"sum(base_grand_total)",
		)
		or 0,
		2,
	)
	current = None
	for t in tiers:
		if spent >= t["min_spent"]:
			current = t
	nxt = next((t for t in tiers if current is None or t["min_spent"] > current["min_spent"]), None)
	if nxt:
		span = nxt["min_spent"] - (current["min_spent"] if current else 0)
		progress = flt((spent - (current["min_spent"] if current else 0)) / span, 3) if span > 0 else 1.0
	else:
		progress = 1.0
	expiring = 0.0
	if frappe.db.exists("DocType", "Loyalty Point Entry"):
		expiring = flt(
			frappe.db.get_value(
				"Loyalty Point Entry",
				{"customer": customer, "loyalty_program": program, "expiry_date": ("between", (nowdate(), add_days(nowdate(), 90))), "loyalty_points": (">", 0)},
				"sum(loyalty_points)",
			)
			or 0
		)
	return {
		"program": program,
		"tier": override or (current["tier"] if current else d.get("tier_name")),
		"tier_override": override or None,
		"points": points,
		"points_value": flt(points * flt(lp.conversion_factor), 2),
		"spent": spent,
		"tiers": tiers,
		"next_tier": nxt["tier"] if nxt else None,
		"next_tier_min_spent": nxt["min_spent"] if nxt else None,
		"to_next_tier": flt(nxt["min_spent"] - spent, 2) if nxt else 0.0,
		"progress": max(0.0, min(progress, 1.0)),
		"expiry_duration_days": cint(lp.expiry_duration),
		"points_expiring_90d": expiring,
		"birthday_bonus_points": cint(_setting("birthday_bonus_points", 0)),
	}


@frappe.whitelist()
def loyalty(customer: str) -> dict[str, Any]:
	"""Tier progress for the POS client card."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	return tier_progress(customer)


def birthday_bonus(today: Any = None) -> dict[str, Any]:
	"""Daily job: credit ``birthday_bonus_points`` to clients whose birthday is today (once a year)."""
	points = cint(_setting("birthday_bonus_points", 0))
	if points <= 0 or not frappe.db.exists("DocType", "AWANZ Client Profile"):
		return {"credited": [], "points": 0}
	today = getdate(today or nowdate())
	profiles = frappe.get_all("AWANZ Client Profile", filters={"birthday": ("is", "set")}, fields=["customer", "birthday"])
	credited = []
	for p in profiles:
		bd = getdate(p.birthday)
		if (bd.month, bd.day) != (today.month, today.day):
			continue
		program = frappe.db.get_value("Customer", p.customer, "loyalty_program")
		if not program:
			continue
		remark = f"Birthday bonus {today.year}"
		if frappe.db.exists("Loyalty Point Entry", {"customer": p.customer, "invoice_type": "Sales Invoice", "purchase_amount": 0, "expiry_date": ("is", "set"), "loyalty_program": program, "invoice": ("is", "not set"), "posting_date": today}):
			continue
		lp = frappe.get_cached_doc("Loyalty Program", program)
		entry = frappe.get_doc(
			{
				"doctype": "Loyalty Point Entry",
				"company": lp.company,
				"loyalty_program": program,
				"loyalty_program_tier": None,
				"customer": p.customer,
				"invoice_type": "Sales Invoice",
				"loyalty_points": points,
				"purchase_amount": 0,
				"expiry_date": add_days(today, cint(lp.expiry_duration) or 365),
				"posting_date": today,
			}
		)
		entry.flags.ignore_permissions = True
		entry.insert()
		try:
			frappe.get_doc(
				{"doctype": "AWANZ Client Interaction", "customer": p.customer, "type": "Birthday", "note": f"{remark}: {points} points credited", "ts": now_datetime(), "status": "Done", "done_on": now_datetime()}
			).insert(ignore_permissions=True)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "awanz birthday interaction")
		credited.append(p.customer)
	return {"credited": credited, "points": points, "date": str(today)}
