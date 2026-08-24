"""CloudChaserz demo users + customers (v0.6 N).

Password ``cloud123`` for every demo login:

    hq@cloudchaserz.example              AWANZ Head Office (+ System-level sales/stock roles)
    warehouse@cloudchaserz.example       AWANZ Warehouse Admin (HOU-WH)
    regional.ok@cloudchaserz.example     AWANZ Regional (Oklahoma)
    regional.tx@cloudchaserz.example     AWANZ Regional (Texas)
    <code>.manager@cloudchaserz.example  AWANZ Manager   PIN unique per store (see MANAGER_PINS)
    <code>.a1@cloudchaserz.example       AWANZ Associate PIN 2580
    <code>.a2@cloudchaserz.example       AWANZ Associate PIN 1357
"""

from __future__ import annotations

import random
from typing import Any, Optional

import frappe
from frappe.utils import add_days, nowdate

from maison_pos.setup.cloudchaserz import ABBR, COMPANY, DEMO_PASSWORD, LOYALTY_PROGRAM

DOMAIN = "cloudchaserz.example"

# manager PIN per store (unique)
MANAGER_PINS: dict[str, str] = {
	"HOU-MTR": "1101", "OK-SAP": "2202", "OK-BA": "3303", "OK-BIX": "4404", "OK-STUL": "5505", "OK-OWA": "6606",
	"OK-MUS": "7707", "OK-MINGO": "8808", "OK-ETUL": "9909", "OK-YALE": "1212", "OK-JENKS": "1313",
}

STAFF: dict[str, list[tuple[str, str, str]]] = {
	"HOU-MTR": [("Mgr", "Marisol", "Vega"), ("A1", "Dante", "Ruiz"), ("A2", "Keisha", "Brown")],
	"OK-SAP": [("Mgr", "Travis", "Holt"), ("A1", "Amber", "Lee"), ("A2", "Cody", "Pratt")],
	"OK-BA": [("Mgr", "Lena", "Gonzalez"), ("A1", "Tyler", "Moss"), ("A2", "Jada", "Carter")],
	"OK-BIX": [("Mgr", "Omar", "Haddad"), ("A1", "Brianna", "Cole"), ("A2", "Luis", "Ortega")],
	"OK-STUL": [("Mgr", "Priya", "Natarajan"), ("A1", "Ethan", "Reed"), ("A2", "Sierra", "Blackfox")],
	"OK-OWA": [("Mgr", "Derrick", "Hale"), ("A1", "Mia", "Tran"), ("A2", "Jordan", "Pike")],
	"OK-MUS": [("Mgr", "Tasha", "Bigpond"), ("A1", "Caleb", "Wolf"), ("A2", "Nina", "Ramos")],
	"OK-MINGO": [("Mgr", "Andre", "Fields"), ("A1", "Hannah", "Yu"), ("A2", "Marcus", "Dill")],
	"OK-ETUL": [("Mgr", "Sofia", "Mendez"), ("A1", "Blake", "Owens"), ("A2", "Rhea", "Patel")],
	"OK-YALE": [("Mgr", "Grant", "Foster"), ("A1", "Lily", "Nguyen"), ("A2", "Isaac", "Tiger")],
	"OK-JENKS": [("Mgr", "Chloe", "Barnes"), ("A1", "Mason", "Kirk"), ("A2", "Aaliyah", "Scott")],
}

# (name, mobile, email, birthday, home store)
CUSTOMERS: list[tuple[str, str, str, str, str]] = [
	("Jake Morrison", "+1 918 555 0101", "jake.morrison@example.com", "1994-03-14", "OK-BIX"),
	("Destiny Williams", "+1 918 555 0102", "destiny.w@example.com", "1991-11-02", "OK-MINGO"),
	("Carlos Mendoza", "+1 281 555 0103", "carlos.mendoza@example.com", "1988-08-25", "HOU-MTR"),
	("Brittany Cole", "+1 539 555 0104", "brit.cole@example.com", "1996-06-30", "OK-BA"),
	("Tyrese Johnson", "+1 918 555 0105", "tyrese.j@example.com", "1985-01-19", "OK-STUL"),
	("Megan O'Neal", "+1 918 555 0106", "megan.oneal@example.com", "1993-05-07", "OK-OWA"),
	("Dakota Redcloud", "+1 918 555 0107", "dakota.rc@example.com", "1990-12-12", "OK-MUS"),
	("Alyssa Tran", "+1 713 555 0108", "alyssa.tran@example.com", "1997-02-28", "HOU-MTR"),
	("Kevin Patel", "+1 918 555 0109", "kevin.patel@example.com", "1982-07-04", "OK-ETUL"),
	("Shelby Hart", "+1 918 555 0110", "shelby.hart@example.com", "1995-10-10", "OK-YALE"),
	("Marcus Greene", "+1 918 555 0111", "marcus.greene@example.com", "1989-09-21", "OK-JENKS"),
	("Lauren Kim", "+1 918 555 0112", "lauren.kim@example.com", "1992-04-18", "OK-SAP"),
	("Andre Baptiste", "+1 832 555 0113", "andre.b@example.com", "1986-08-29", "HOU-MTR"),
	("Savannah Ross", "+1 918 555 0114", "sav.ross@example.com", "1998-03-03", "OK-BIX"),
	("Noah Castillo", "+1 539 555 0115", "noah.castillo@example.com", "1991-06-15", "OK-BA"),
	("Kiara Thompson", "+1 918 555 0116", "kiara.t@example.com", "1994-11-27", "OK-MINGO"),
	("Ethan Whitehorse", "+1 918 555 0117", "ethan.wh@example.com", "1987-02-08", "OK-MUS"),
	("Gabriela Santos", "+1 713 555 0118", "gabriela.santos@example.com", "1993-08-30", "HOU-MTR"),
	("Dylan Foster", "+1 918 555 0119", "dylan.foster@example.com", "1999-01-05", "OK-OWA"),
	("Renee Jackson", "+1 918 555 0120", "renee.jackson@example.com", "1984-05-22", "OK-STUL"),
]


def _exists(doctype: str, name: str) -> bool:
	return bool(frappe.db.exists(doctype, name))


# ---------------------------------------------------------------------------
def ensure_customers() -> None:
	from maison_pos.setup import demo

	for name, mobile, email, birthday, home in CUSTOMERS:
		customer = demo.ensure_customer(name, mobile, email)
		if frappe.db.get_value("Customer", customer, "loyalty_program") != LOYALTY_PROGRAM and _exists("Loyalty Program", LOYALTY_PROGRAM):
			frappe.db.set_value("Customer", customer, "loyalty_program", LOYALTY_PROGRAM, update_modified=False)
		ensure_profile(customer, birthday, home)
	demo.ensure_client_numbers()


def ensure_profile(customer: str, birthday: Optional[str], home: Optional[str]) -> None:
	if not frappe.db.exists("DocType", "AWANZ Client Profile"):
		return
	if not frappe.db.exists("AWANZ Client Profile", customer):
		frappe.get_doc({"doctype": "AWANZ Client Profile", "customer": customer}).insert(ignore_permissions=True)
	values: dict[str, Any] = {}
	if birthday and not frappe.db.get_value("AWANZ Client Profile", customer, "birthday"):
		values["birthday"] = birthday
	if home and frappe.db.exists("AWANZ Store", home) and not frappe.db.get_value("AWANZ Client Profile", customer, "preferred_boutique"):
		values["preferred_boutique"] = home
	if values:
		frappe.db.set_value("AWANZ Client Profile", customer, values, update_modified=False)


def ensure_users() -> None:
	from maison_pos.setup import demo
	from maison_pos.setup.cloudchaserz import stores

	demo.ensure_user(f"hq@{DOMAIN}", "Hunter", "Quinn", ["AWANZ Head Office", "Sales Manager", "Accounts Manager", "Stock Manager"])
	demo.ensure_associate(f"hq@{DOMAIN}", None, "HeadOffice", "0000")
	demo.ensure_user(f"regional.ok@{DOMAIN}", "Rosa", "Kingfisher", ["AWANZ Regional", "Sales Manager"])
	demo.ensure_associate(f"regional.ok@{DOMAIN}", None, "Regional", "0000")
	demo.ensure_user(f"regional.tx@{DOMAIN}", "Ray", "Torres", ["AWANZ Regional", "Sales Manager"])
	demo.ensure_associate(f"regional.tx@{DOMAIN}", None, "Regional", "0000")
	# warehouse admin (role owned by section P; created by install_v06 when absent)
	wh_roles = ["AWANZ Warehouse Admin", "Stock User", "Stock Manager", "Purchase User"]
	demo.ensure_user(f"warehouse@{DOMAIN}", "Walter", "Hines", [r for r in wh_roles if _exists("Role", r)])
	if _exists("AWANZ Store", stores.WAREHOUSE_CODE):
		try:
			demo.ensure_associate(f"warehouse@{DOMAIN}", stores.WAREHOUSE_CODE, "Manager", "0000")
			demo.ensure_user_permission(f"warehouse@{DOMAIN}", stores.warehouse_name(stores.WAREHOUSE_CODE))
		except Exception:
			frappe.log_error(frappe.get_traceback(), "cloudchaserz warehouse associate")

	for spec in stores.STORES:
		code = spec["code"]
		prefix = code.lower().replace("-", ".")
		warehouse = stores.warehouse_name(code)
		for kind, first, last in STAFF[code]:
			if kind == "Mgr":
				email = f"{prefix}.manager@{DOMAIN}"
				demo.ensure_user(email, first, last, ["AWANZ Manager", "Sales User", "Stock User"])
				demo.ensure_associate(email, code, "Manager", MANAGER_PINS[code])
			else:
				email = f"{prefix}.{kind.lower()}@{DOMAIN}"
				demo.ensure_user(email, first, last, ["AWANZ Associate", "Sales User"])
				demo.ensure_associate(email, code, "Associate", "2580" if kind == "A1" else "1357")
			demo.ensure_user_permission(email, warehouse)


# ---------------------------------------------------------------------------
# operations: reorder levels, damaged warehouses, readers, employees, commission rules, feedback
# ---------------------------------------------------------------------------
REORDER: dict[str, tuple[int, int]] = {
	"DSP-001": (8, 24), "DSP-002": (8, 24), "DSP-003": (6, 20), "DSP-008": (6, 20), "DSP-013": (6, 20), "DSP-017": (6, 18),
	"ELQ-004": (4, 10), "ELQ-005": (4, 10), "POD-001": (6, 12), "POD-002": (6, 12), "POD-007": (6, 12),
	"ROL-001": (15, 40), "ROL-002": (15, 40), "ROL-006": (15, 40), "ACC-001": (15, 40), "ACC-002": (15, 40),
	"KRT-001": (3, 8), "KRT-009": (4, 12), "HKA-004": (4, 10), "HKA-012": (4, 12),
}


def ensure_reorder_levels() -> int:
	from maison_pos.setup.cloudchaserz import stores

	n = 0
	warehouses = [(s["code"], stores.warehouse_name(s["code"])) for s in stores.STORES]
	for code, (level, qty) in REORDER.items():
		if not _exists("Item", code):
			continue
		item = frappe.get_doc("Item", code)
		existing = {r.warehouse for r in item.reorder_levels}
		changed = False
		for _b, wh in warehouses:
			if wh in existing:
				continue
			item.append("reorder_levels", {"warehouse_group": wh, "warehouse": wh, "warehouse_reorder_level": level, "warehouse_reorder_qty": qty, "material_request_type": "Transfer"})
			changed = True
			n += 1
		if changed:
			item.flags.ignore_permissions = True
			item.flags.ignore_version = True
			item.save()
	return n


def ensure_readers() -> int:
	from maison_pos.setup.cloudchaserz import stores

	n = 0
	for s in stores.STORES:
		doc = frappe.get_doc("AWANZ Store", s["code"])
		if doc.get("readers"):
			continue
		doc.append("readers", {"label": "Counter 1 · V660p", "device_type": "verifone_v660p", "has_printer": 1, "enabled": 1, "stripe_reader_id": f"tmr_sim_{s['code'].lower().replace('-', '')}_1"})
		doc.append("readers", {"label": "Counter 2 · S710", "device_type": "stripe_s710", "has_printer": 0, "enabled": 1, "stripe_reader_id": f"tmr_sim_{s['code'].lower().replace('-', '')}_2"})
		doc.flags.ignore_permissions = True
		doc.save()
		n += 1
	return n


def ensure_damaged_warehouses() -> list[str]:
	try:
		from maison_pos.setup.install_v04_inventory import ensure_damaged_warehouse
	except Exception:
		return []
	out = []
	for b in frappe.get_all("AWANZ Store", filters={"company": COMPANY}, pluck="name"):
		try:
			out.append(ensure_damaged_warehouse(b))
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"cloudchaserz damaged warehouse {b}")
	return out


COMMISSION_RULES = [
	("Base commission 2%", 2.0, None, None, None, None, 1),
	("Devices & Mods 4%", 4.0, None, None, "Devices & Mods", None, 5),
	("Glass & Rigs 5%", 5.0, None, None, "Glass & Rigs", None, 5),
	("Hookah 4%", 4.0, None, None, "Hookah & Shisha", None, 5),
	("Managers 1% on everything", 1.0, None, "Manager", None, None, 2),
]


def ensure_commission_rules() -> int:
	if not frappe.db.exists("DocType", "AWANZ Commission Rule"):
		return 0
	n = 0
	for title, rate, boutique, role, group, dept, prio in COMMISSION_RULES:
		if frappe.db.exists("AWANZ Commission Rule", title):
			continue
		frappe.get_doc({"doctype": "AWANZ Commission Rule", "title": title, "rate_percent": rate, "boutique": boutique, "role": role, "item_group": group, "department": dept, "priority": prio, "enabled": 1}).insert(ignore_permissions=True)
		n += 1
	return n


def ensure_employees() -> int:
	"""Employees for every associate (reuses the v0.4 seed with the CloudChaserz company)."""
	try:
		from maison_pos.setup import demo_v04_crm_hr as crm
	except Exception:
		return 0
	saved = crm.COMPANY
	crm.COMPANY = COMPANY
	try:
		created = crm.ensure_employees()
		try:
			crm.ensure_salary_structures()
		except Exception:
			frappe.log_error(frappe.get_traceback(), "cloudchaserz salary structures")
	finally:
		crm.COMPANY = saved
	return created


FEEDBACK = [
	("OK-BIX", 5, "Brianna knew exactly which coil I needed. In and out in five minutes."),
	("HOU-MTR", 4, "Great glass selection, wish the dab rigs were priced on the shelf."),
	("OK-MUS", 2, "Waited a while at the counter and the Geek Bar flavour I wanted was out."),
	("OK-MINGO", 5, None),
	("OK-JENKS", 3, "Good prices, card reader was slow."),
]


def ensure_feedback() -> int:
	if not frappe.db.exists("DocType", "AWANZ Feedback"):
		return 0
	n = 0
	for boutique, rating, comment in FEEDBACK:
		invoice = frappe.db.get_value("Sales Invoice", {"maison_boutique": boutique, "docstatus": 1, "is_return": 0}, "name", order_by="posting_date desc")
		if not invoice or frappe.db.exists("AWANZ Feedback", {"sales_invoice": invoice}):
			continue
		frappe.get_doc({"doctype": "AWANZ Feedback", "sales_invoice": invoice, "boutique": boutique, "associate": frappe.db.get_value("Sales Invoice", invoice, "maison_associate"), "rating": rating, "comment": comment, "submitted_at": frappe.utils.now_datetime(), "status": "New"}).insert(ignore_permissions=True)
		n += 1
	return n


def seed_operations() -> dict[str, Any]:
	random.seed(606)
	out: dict[str, Any] = {}
	for key, fn in (("reorder_levels", ensure_reorder_levels), ("readers", ensure_readers), ("damaged", ensure_damaged_warehouses), ("commission_rules", ensure_commission_rules), ("employees", ensure_employees), ("feedback", ensure_feedback)):
		try:
			out[key] = fn()
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"cloudchaserz operations {key}")
			out[key] = "error"
	return out
