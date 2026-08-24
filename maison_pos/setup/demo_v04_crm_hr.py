"""v0.4 B/C/I demo seed — called from ``maison_pos.setup.demo.seed()`` (guarded, idempotent).

Creates: Employees for every demo associate (+ `AWANZ Associate.employee`), commission rules,
2 promotions (Pricing Rules), 3 coupons, 10 client profiles with wishlists / preferences,
a few follow-ups, 5 private feedback rows, and the tier Customer Groups.
"""

from __future__ import annotations

import random
from typing import Any, Optional

import frappe
from frappe.utils import add_days, getdate, now_datetime, nowdate

from maison_pos.setup.install_v04_crm import ensure_tier_customer_groups, setup_v04_crm

COMPANY = "AWANZ"

COMMISSION_RULES = [
	# title, rate, boutique, role, item_group, department, priority
	("Base commission 2%", 2.0, None, "Any", None, None, 1),
	("Timepieces 3%", 3.0, None, "Any", "Timepieces", None, 5),
	("High Jewellery 4%", 4.0, None, "Any", "High Jewellery", None, 5),
	("Bridal 2.5%", 2.5, None, "Any", "Bridal", None, 5),
	("NYC associates bridal push 3.5%", 3.5, "NYC-5AV", "Associate", "Bridal", None, 10),
]

COUPONS = [
	# code, title, type, value, usage, max_uses, min_basket, item_group, customer_index
	("WELCOME10", "Welcome 10% off", "Percent", 10, "Multi-use", 0, 0, None, None),
	("BRIDAL500", "$500 off bridal", "Amount", 500, "Multi-use", 50, 5000, "Bridal", None),
	("VIP-ISABELLA", "Private 15% for Isabella", "Percent", 15, "Single-use", 1, 0, None, 0),
]

PROFILES: list[dict[str, Any]] = [
	{"customer": "Isabella Marchetti", "ring_size": "6.5", "wrist_size": "15.5", "metal_preference": "Platinum", "birthday": "1981-03-14", "anniversary": "2009-06-21", "spouse_name": "Marco Marchetti", "style_notes": "Loves clean lines, no yellow gold. Collects Regatta chronographs for Marco.", "preferred_boutique": "NYC-5AV", "wishlist": ["HJ-001", "BR-009"]},
	{"customer": "Jonathan Whitfield", "wrist_size": "18", "metal_preference": "White Gold", "birthday": "1974-11-02", "style_notes": "Watch collector; asks for sapphire crystal and bracelet sizing on the spot.", "preferred_boutique": "NYC-5AV", "wishlist": ["TP-001"]},
	{"customer": "Amara Okonkwo", "ring_size": "7", "metal_preference": "Yellow Gold", "birthday": "1990-08-25", "style_notes": "Bold statement pieces; shops before galas.", "preferred_boutique": "NYC-5AV", "do_not_sms": 1, "wishlist": ["HJ-002", "AC-007"]},
	{"customer": "Mei-Lin Chen", "ring_size": "5.5", "wrist_size": "14.5", "metal_preference": "Rose Gold", "birthday": "1987-08-30", "anniversary": "2016-09-10", "spouse_name": "David Chen", "style_notes": "Prefers delicate stacking rings; anniversary gift every September.", "preferred_boutique": "CHI-OAK", "wishlist": ["BR-004", "AC-003"]},
	{"customer": "Alexander Petrov", "wrist_size": "19", "metal_preference": "Platinum", "birthday": "1969-01-19", "style_notes": "Buys one significant timepiece a year, usually in Q4.", "preferred_boutique": "CHI-OAK", "do_not_phone": 1, "wishlist": ["TP-003"]},
	{"customer": "Charlotte Beaumont", "ring_size": "6", "metal_preference": "White Gold", "birthday": "1992-05-07", "style_notes": "Engaged — shopping wedding bands with partner.", "preferred_boutique": "CHI-OAK", "wishlist": ["BR-006", "BR-008"]},
	{"customer": "Rafael Oliveira", "wrist_size": "17.5", "metal_preference": "Yellow Gold", "birthday": "1983-12-12", "style_notes": "Gifts for family in Brazil; likes engraving.", "preferred_boutique": "MIA-DD", "wishlist": ["AC-009"]},
	{"customer": "Sofia Andersson", "ring_size": "6.5", "metal_preference": "Mixed", "birthday": "1996-02-29", "style_notes": "Art-deco inspired pieces; follows the brand on social.", "preferred_boutique": "MIA-DD", "do_not_email": 1, "wishlist": ["HJ-007", "HJ-004"]},
	{"customer": "Daniel Goldberg", "ring_size": "10", "metal_preference": "Platinum", "birthday": "1978-07-04", "anniversary": "2004-05-15", "spouse_name": "Rachel Goldberg", "style_notes": "Anniversary and birthday buyer; wants discreet delivery.", "preferred_boutique": "MIA-DD", "wishlist": ["BR-003"]},
	{"customer": "Priya Raghavan", "ring_size": "5", "wrist_size": "14", "metal_preference": "Yellow Gold", "birthday": "1989-10-10", "style_notes": "Bridal set completed 2025; now building everyday fine jewellery.", "preferred_boutique": "NYC-5AV", "vip_tier_override": "Connoisseur", "wishlist": ["AC-005", "AC-001"]},
]

FEEDBACK = [
	# boutique, rating, comment
	("NYC-5AV", 5, "Theo was wonderful — patient with all my questions about the bracelet sizing."),
	("NYC-5AV", 4, "Beautiful boutique. Wait for a fitting was a little long."),
	("CHI-OAK", 2, "Felt rushed at the counter and the engraving date was not confirmed."),
	("MIA-DD", 5, None),
	("MIA-DD", 3, "Lovely pieces, but the champagne was warm."),
]


def _exists(doctype: str, name: str) -> bool:
	return bool(frappe.db.exists(doctype, name))


def _customer(name: str) -> Optional[str]:
	return frappe.db.get_value("Customer", {"customer_name": name}, "name")


def _associate(boutique: str, kind: str = "Associate") -> Optional[str]:
	return frappe.db.get_value("AWANZ Associate", {"boutique": boutique, "role": kind, "enabled": 1}, "name", order_by="name")


# ---------------------------------------------------------------------------
# employees
# ---------------------------------------------------------------------------
def ensure_employees() -> int:
	"""An ERPNext Employee per demo associate (works with or without HRMS)."""
	if not frappe.db.exists("DocType", "Employee"):
		return 0
	created = 0
	for designation in ("Boutique Manager", "Sales Associate", "Regional Director", "Head Office"):
		if _exists("DocType", "Designation") and not _exists("Designation", designation):
			frappe.get_doc({"doctype": "Designation", "designation_name": designation}).insert(ignore_permissions=True)
	for assoc in frappe.get_all("AWANZ Associate", fields=["name", "user", "boutique", "role", "employee"]):
		if assoc.employee and _exists("Employee", assoc.employee):
			continue
		existing = frappe.db.get_value("Employee", {"user_id": assoc.user}, "name")
		if not existing:
			user = frappe.db.get_value("User", assoc.user, ["first_name", "last_name"], as_dict=True) or {}
			emp = frappe.get_doc(
				{
					"doctype": "Employee",
					"first_name": user.get("first_name") or assoc.user.split("@")[0],
					"last_name": user.get("last_name"),
					"gender": "Other" if _exists("Gender", "Other") else None,
					"date_of_birth": "1990-01-01",
					"date_of_joining": add_days(nowdate(), -400),
					"status": "Active",
					"company": COMPANY,
					"user_id": assoc.user,
					"create_user_permission": 0,
					"employment_type": "Full-time" if _exists("Employment Type", "Full-time") else None,
					"designation": {"Manager": "Boutique Manager", "Associate": "Sales Associate", "Regional": "Regional Director"}.get(assoc.role, "Head Office"),
				}
			)
			emp.flags.ignore_permissions = True
			emp.flags.ignore_mandatory = True
			emp.insert()
			existing = emp.name
			created += 1
		frappe.db.set_value("AWANZ Associate", assoc.name, "employee", existing, update_modified=False)
	return created


def ensure_salary_structures() -> int:
	"""HRMS only: a base Salary Structure assigned to every demo employee so commissions can flow into payroll."""
	if "hrms" not in frappe.get_installed_apps() or not frappe.db.exists("DocType", "Salary Structure"):
		return 0
	payable = frappe.db.get_value("Company", COMPANY, "default_payroll_payable_account")
	if not payable:
		payable = frappe.db.get_value("Account", {"company": COMPANY, "account_name": "Payroll Payable"}, "name")
		if payable:
			frappe.db.set_value("Company", COMPANY, "default_payroll_payable_account", payable)
	if not payable:
		return 0
	if not _exists("Salary Component", "Basic"):
		frappe.get_doc({"doctype": "Salary Component", "salary_component": "Basic", "salary_component_abbr": "B", "type": "Earning"}).insert(ignore_permissions=True)
	name = "AWANZ Base"
	if not _exists("Salary Structure", name):
		ss = frappe.get_doc(
			{
				"doctype": "Salary Structure",
				"name": name,
				"company": COMPANY,
				"payroll_frequency": "Monthly",
				"currency": "USD",
				"is_active": "Yes",
				"payment_account": payable,
				"earnings": [{"salary_component": "Basic", "amount_based_on_formula": 1, "formula": "base"}],
			}
		)
		ss.flags.ignore_permissions = True
		ss.insert()
		ss.submit()
	n = 0
	for emp in frappe.get_all("Employee", filters={"company": COMPANY, "status": "Active"}, fields=["name", "date_of_joining"]):
		if frappe.db.exists("Salary Structure Assignment", {"employee": emp.name, "docstatus": 1}):
			continue
		try:
			ssa = frappe.get_doc(
				{
					"doctype": "Salary Structure Assignment",
					"employee": emp.name,
					"salary_structure": name,
					"company": COMPANY,
					"currency": "USD",
					"from_date": emp.date_of_joining or add_days(nowdate(), -400),
					"base": 4000,
					"payroll_payable_account": payable,
				}
			)
			ssa.flags.ignore_permissions = True
			ssa.insert()
			ssa.submit()
			n += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(), "awanz demo salary structure assignment")
	return n


# ---------------------------------------------------------------------------
# commissions / promotions / coupons
# ---------------------------------------------------------------------------
def ensure_commission_rules() -> int:
	n = 0
	for title, rate, boutique, role, group, dept, prio in COMMISSION_RULES:
		if _exists("AWANZ Commission Rule", title):
			continue
		frappe.get_doc({"doctype": "AWANZ Commission Rule", "title": title, "rate_percent": rate, "boutique": boutique, "role": role, "item_group": group, "department": dept, "priority": prio, "enabled": 1}).insert(ignore_permissions=True)
		n += 1
	return n


def ensure_promotions() -> list[str]:
	"""Two ERPNext Pricing Rules the POS shows in the Promotions chip."""
	ensure_tier_customer_groups()
	names = []
	specs = [
		{
			"title": "Accessories week −15%",
			"apply_on": "Item Group",
			"item_groups": [{"item_group": "Accessories"}],
			"rate_or_discount": "Discount Percentage",
			"discount_percentage": 15,
			"valid_from": add_days(nowdate(), -3),
			"valid_upto": add_days(nowdate(), 30),
		},
		{
			"title": "Patron privilege −5% on Bridal",
			"apply_on": "Item Group",
			"item_groups": [{"item_group": "Bridal"}],
			"rate_or_discount": "Discount Percentage",
			"discount_percentage": 5,
			"applicable_for": "Customer Group",
			"customer_group": "Patron",
			"valid_from": add_days(nowdate(), -30),
		},
	]
	for spec in specs:
		existing = frappe.db.get_value("Pricing Rule", {"title": spec["title"]}, "name")
		if existing:
			names.append(existing)
			continue
		if spec.get("customer_group") and not _exists("Customer Group", spec["customer_group"]):
			continue
		doc = frappe.get_doc({"doctype": "Pricing Rule", "selling": 1, "price_or_product_discount": "Price", "currency": "USD", "company": COMPANY, "priority": 1, **spec})
		doc.flags.ignore_permissions = True
		doc.insert()
		names.append(doc.name)
	return names


def ensure_coupons() -> int:
	n = 0
	from maison_pos.setup.demo import CUSTOMERS

	for code, title, dtype, value, usage, max_uses, min_basket, group, cust_idx in COUPONS:
		if _exists("AWANZ Coupon", code):
			continue
		frappe.get_doc(
			{
				"doctype": "AWANZ Coupon",
				"code": code,
				"title": title,
				"discount_type": dtype,
				"value": value,
				"usage": usage,
				"max_uses": max_uses,
				"min_basket": min_basket,
				"item_group": group,
				"customer": _customer(CUSTOMERS[cust_idx][0]) if cust_idx is not None else None,
				"valid_upto": add_days(nowdate(), 90),
				"enabled": 1,
			}
		).insert(ignore_permissions=True)
		n += 1
	return n


# ---------------------------------------------------------------------------
# client profiles / follow-ups / feedback
# ---------------------------------------------------------------------------
def ensure_profiles() -> int:
	n = 0
	for spec in PROFILES:
		customer = _customer(spec["customer"])
		if not customer:
			continue
		if _exists("AWANZ Client Profile", customer):
			continue
		boutique = spec.get("preferred_boutique")
		doc = frappe.get_doc(
			{
				"doctype": "AWANZ Client Profile",
				"customer": customer,
				"preferred_boutique": boutique,
				"preferred_associate": _associate(boutique) if boutique else None,
				**{k: v for k, v in spec.items() if k not in ("customer", "wishlist", "preferred_boutique")},
				"wishlist": [{"item_code": code, "notes": "Mentioned in boutique", "added_by": "Administrator", "added_on": now_datetime()} for code in spec.get("wishlist", []) if _exists("Item", code)],
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		n += 1
	return n


def ensure_follow_ups() -> int:
	if frappe.db.count("AWANZ Client Interaction", {"type": ("in", ("Follow-up", "Call"))}):
		return 0
	n = 0
	specs = [
		("Mei-Lin Chen", "Follow-up", "Anniversary in September — propose the Halo Cushion with rose-gold band.", 7),
		("Jonathan Whitfield", "Call", "Regatta Chronograph arriving next week; call to reserve.", 2),
		("Charlotte Beaumont", "Follow-up", "Send wedding band sizing kit; partner size 10.", 5),
		("Daniel Goldberg", "Follow-up", "Anniversary 15 May — discreet delivery to office.", 14),
		("Isabella Marchetti", "Visit", "Viewed the Cascade Riviere; wants to see it again with Marco.", None),
	]
	for name, kind, note, days in specs:
		customer = _customer(name)
		if not customer:
			continue
		boutique = frappe.db.get_value("AWANZ Client Profile", customer, "preferred_boutique")
		frappe.get_doc(
			{
				"doctype": "AWANZ Client Interaction",
				"customer": customer,
				"type": kind,
				"note": note,
				"boutique": boutique,
				"associate": _associate(boutique) if boutique else None,
				"ts": now_datetime(),
				"follow_up_date": add_days(nowdate(), days) if days is not None else None,
				"status": "Open" if days is not None else "Done",
				"done_on": None if days is not None else now_datetime(),
			}
		).insert(ignore_permissions=True)
		n += 1
	return n


def ensure_feedback() -> int:
	"""5 feedback rows attached to the newest submitted POS invoices per boutique (skips when none)."""
	from maison_pos.identifiers import new_receipt_token

	if frappe.db.count("AWANZ Feedback") >= len(FEEDBACK):
		return 0
	n = 0
	used = set(frappe.get_all("AWANZ Feedback", pluck="sales_invoice"))
	for boutique, rating, comment in FEEDBACK:
		invs = frappe.get_all("Sales Invoice", filters={"maison_boutique": boutique, "docstatus": 1, "is_pos": 1, "is_return": 0}, fields=["name", "maison_associate", "customer", "maison_receipt_token"], order_by="posting_date desc, posting_time desc", limit=10)
		inv = next((i for i in invs if i.name not in used), None)
		if not inv:
			continue
		if not inv.maison_receipt_token:
			frappe.db.set_value("Sales Invoice", inv.name, "maison_receipt_token", new_receipt_token(), update_modified=False)
		used.add(inv.name)
		frappe.get_doc(
			{
				"doctype": "AWANZ Feedback",
				"sales_invoice": inv.name,
				"boutique": boutique,
				"associate": inv.maison_associate if _exists("AWANZ Associate", inv.maison_associate or "") else None,
				"customer": inv.customer,
				"rating": rating,
				"comment": comment,
				"submitted_at": add_days(now_datetime(), -random.randint(0, 10)),
				"status": "New",
			}
		).insert(ignore_permissions=True)
		n += 1
	return n


def seed_v04_crm_hr() -> dict[str, Any]:
	"""Entry point (called at the end of ``demo.seed``). Safe to re-run."""
	if not frappe.db.exists("DocType", "AWANZ Client Profile"):
		return {"skipped": "v0.4 doctypes not migrated"}
	setup_v04_crm()
	random.seed(404)
	out = {
		"employees": ensure_employees(),
		"salary_assignments": ensure_salary_structures(),
		"commission_rules": ensure_commission_rules(),
		"promotions": ensure_promotions(),
		"coupons": ensure_coupons(),
		"profiles": ensure_profiles(),
		"follow_ups": ensure_follow_ups(),
		"feedback": ensure_feedback(),
		"hrms": "hrms" in frappe.get_installed_apps(),
		"crm": "crm" in frappe.get_installed_apps(),
	}
	return out
