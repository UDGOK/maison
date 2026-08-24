"""CloudChaserz stores (v0.6 N): Houston Montrose HQ store, the 10 Oklahoma stores and the
``HOU-WH`` main warehouse (a Warehouse + a ``AWANZ Store`` row of type *Warehouse*).

Tax rates are approximate combined state + local sales-tax rates — **verify with the CPA**
before going live (see docs/cloudchaserz.md; Texas / Oklahoma vapor & tobacco excise taxes are
not modelled here)."""

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe.utils import nowdate

from maison_pos.setup.cloudchaserz import ABBR, COMPANY, COUNTRY, CURRENCY, PRICE_LIST, TIMEZONE

HQ_STORE = "HOU-MTR"
WAREHOUSE_CODE = "HOU-WH"
WAREHOUSE_NAME = "Main Warehouse"

# hours: {"default": "9:00-22:00", "fri": ..., "sat": ...} (24h strings)
STORES: list[dict[str, Any]] = [
	{"code": "HOU-MTR", "name": "CloudChaserz Montrose", "address_line": "2037 W Alabama St", "city": "Houston, TX 77098", "state": "TX", "zip": "77098", "phone": "(281) 974-3712", "region": "Houston", "tax_title": "TX Sales Tax (Houston)", "tax_rate": 8.25, "hours": {"default": "9:00-24:00"}, "printer_ip": "10.20.1.50"},
	{"code": "OK-SAP", "name": "CloudChaserz Sapulpa", "address_line": "515 N Mission St", "city": "Sapulpa, OK 74066", "state": "OK", "zip": "74066", "phone": "(918) 347-8062", "region": "Oklahoma", "tax_title": "OK Sales Tax (Sapulpa)", "tax_rate": 9.5, "hours": {"default": "9:00-22:00"}, "printer_ip": "10.21.1.50"},
	{"code": "OK-BA", "name": "CloudChaserz Broken Arrow", "address_line": "6420 S Elm Pl", "city": "Broken Arrow, OK 74011", "state": "OK", "zip": "74011", "phone": "(539) 367-1226", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Broken Arrow)", "tax_rate": 8.417, "hours": {"default": "9:00-22:00"}, "printer_ip": "10.21.2.50"},
	{"code": "OK-BIX", "name": "CloudChaserz Bixby", "address_line": "11063-B S Memorial Dr", "city": "Tulsa, OK 74133", "state": "OK", "zip": "74133", "phone": "(918) 364-8300", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Bixby)", "tax_rate": 8.917, "hours": {"default": "9:00-22:00", "fri": "9:00-24:00", "sat": "9:00-24:00"}, "printer_ip": "10.21.3.50"},
	{"code": "OK-STUL", "name": "CloudChaserz South Tulsa", "address_line": "2606 S Sheridan Rd Suite H", "city": "Tulsa, OK 74129", "state": "OK", "zip": "74129", "phone": "(918) 764-8161", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Tulsa)", "tax_rate": 8.517, "hours": {"default": "9:00-22:00"}, "printer_ip": "10.21.4.50"},
	{"code": "OK-OWA", "name": "CloudChaserz Owasso", "address_line": "8351 N Owasso Expy", "city": "Owasso, OK 74055", "state": "OK", "zip": "74055", "phone": "(918) 554-5217", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Owasso)", "tax_rate": 8.917, "hours": {"default": "9:00-22:00"}, "printer_ip": "10.21.5.50"},
	{"code": "OK-MUS", "name": "CloudChaserz Muskogee", "address_line": "102 S 24th St W", "city": "Muskogee, OK 74401", "state": "OK", "zip": "74401", "phone": "(918) 685-0433", "region": "Oklahoma", "tax_title": "OK Sales Tax (Muskogee)", "tax_rate": 9.15, "hours": {"default": "8:00-02:00"}, "printer_ip": "10.21.6.50"},
	{"code": "OK-MINGO", "name": "CloudChaserz Mingo", "address_line": "8033 S Mingo Rd", "city": "Tulsa, OK 74133", "state": "OK", "zip": "74133", "phone": "(539) 367-3892", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Tulsa)", "tax_rate": 8.517, "hours": {"default": "8:00-24:00"}, "printer_ip": "10.21.7.50"},
	{"code": "OK-ETUL", "name": "CloudChaserz East Tulsa", "address_line": "1660 E 71st St STE E", "city": "Tulsa, OK 74136", "state": "OK", "zip": "74136", "phone": "(918) 574-2521", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Tulsa)", "tax_rate": 8.517, "hours": {"default": "9:00-22:00"}, "printer_ip": "10.21.8.50"},
	{"code": "OK-YALE", "name": "CloudChaserz Yale", "address_line": "3205 S Yale Ave Suite C", "city": "Tulsa, OK 74135", "state": "OK", "zip": "74135", "phone": "(918) 393-8201", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Tulsa)", "tax_rate": 8.517, "hours": {"default": "9:00-22:00"}, "printer_ip": "10.21.9.50"},
	{"code": "OK-JENKS", "name": "CloudChaserz Jenks", "address_line": "541 W Main St", "city": "Jenks, OK 74037", "state": "OK", "zip": "74037", "phone": "(918) 228-7009", "region": "Tulsa Metro", "tax_title": "OK Sales Tax (Jenks)", "tax_rate": 8.917, "hours": {"default": "9:00-22:00", "fri": "9:00-24:00", "sat": "9:00-24:00"}, "printer_ip": "10.21.10.50"},
]

WAREHOUSE_SPEC: dict[str, Any] = {
	"code": WAREHOUSE_CODE,
	"name": f"CloudChaserz {WAREHOUSE_NAME}",
	"address_line": "2037 W Alabama St (Head office)",
	"city": "Houston, TX 77098",
	"state": "TX",
	"zip": "77098",
	"phone": "(281) 974-3712",
	"region": "Houston",
	"tax_title": "TX Sales Tax (Houston)",
	"tax_rate": 8.25,
	"hours": {"default": "8:00-17:00", "sat": "closed", "sun": "closed"},
}

# relative daily traffic per store (history + demo)
STORE_WEIGHT: dict[str, float] = {
	"HOU-MTR": 0.14, "OK-SAP": 0.07, "OK-BA": 0.10, "OK-BIX": 0.11, "OK-STUL": 0.08, "OK-OWA": 0.09,
	"OK-MUS": 0.07, "OK-MINGO": 0.11, "OK-ETUL": 0.08, "OK-YALE": 0.07, "OK-JENKS": 0.08,
}


def store_codes() -> list[str]:
	return [s["code"] for s in STORES]


def warehouse_name(code: str) -> str:
	return f"{code} - {ABBR}"


def demo_boutique_specs() -> list[dict[str, Any]]:
	"""Shape expected by ``setup.demo`` helpers (``code``, ``tax_rate``, …) — stores only."""
	return [dict(s, email=f"{s['code'].lower().replace('-', '.')}@cloudchaserz.example") for s in STORES]


# ---------------------------------------------------------------------------
def ensure_erpnext_setup() -> None:
	"""Headless ERPNext setup wizard with the CloudChaserz company on a fresh site."""
	if frappe.db.sql("select name from tabCompany limit 1"):
		return
	from erpnext.setup.setup_wizard.setup_wizard import setup_complete as erpnext_setup_complete
	from frappe.utils import getdate

	today = getdate(nowdate())
	args = frappe._dict(
		{
			"language": "English",
			"country": COUNTRY,
			"currency": CURRENCY,
			"timezone": TIMEZONE,
			"time_zone": TIMEZONE,
			"company_name": COMPANY,
			"company_abbr": ABBR,
			"chart_of_accounts": "Standard",
			"fy_start_date": f"{today.year}-01-01",
			"fy_end_date": f"{today.year}-12-31",
			"full_name": "Administrator",
			"email": "admin@cloudchaserz.example",
			"bank_account": "Main Bank",
			"setup_demo": 0,
		}
	)
	frappe.flags.in_setup_wizard = True
	try:
		erpnext_setup_complete(args)
	finally:
		frappe.flags.in_setup_wizard = False
	for app in ("frappe", "erpnext", "maison_pos"):
		if frappe.db.exists("Installed Application", {"app_name": app}):
			frappe.db.set_value("Installed Application", {"app_name": app}, "is_setup_complete", 1)
	frappe.db.set_single_value("System Settings", "setup_complete", 1)
	frappe.db.set_single_value("System Settings", "country", COUNTRY)
	frappe.db.set_single_value("System Settings", "currency", CURRENCY)
	frappe.db.set_single_value("System Settings", "time_zone", TIMEZONE)
	frappe.clear_cache()


def ensure_store(spec: dict[str, Any], accounts: dict[str, str], walk_in: str, is_warehouse: bool = False) -> str:
	"""Warehouse + Cost Center + POS Profile + AWANZ Store for one store (or the warehouse row)."""
	from maison_pos.setup import demo

	code = spec["code"]
	spec = dict(spec, email=spec.get("email") or f"{code.lower().replace('-', '.')}@cloudchaserz.example")
	# reuse the jewellery helper (company/abbr come from profile_globals())
	demo.ensure_boutique(spec, accounts, walk_in)
	doc = frappe.get_doc("AWANZ Store", code)
	values: dict[str, Any] = {
		"boutique_name": spec["name"],
		"region": spec.get("region"),
		"timezone": TIMEZONE,
		"hours": json.dumps(spec.get("hours") or {}),
		"state": spec.get("state"),
		"zip": spec.get("zip"),
		"boutique_type": "Warehouse" if is_warehouse else "Store",
		"is_warehouse": 1 if is_warehouse else 0,
		"printer_model": "TM-m30III",
		"show_product_images": 1,
	}
	changed = False
	for k, v in values.items():
		if doc.get(k) != v and doc.meta.has_field(k):
			doc.set(k, v)
			changed = True
	if changed:
		doc.flags.ignore_permissions = True
		doc.save()
	return code


def ensure_stores(accounts: dict[str, str], walk_in: str) -> list[str]:
	codes = [ensure_store(s, accounts, walk_in) for s in STORES]
	ensure_store(WAREHOUSE_SPEC, accounts, walk_in, is_warehouse=True)
	# the warehouse's ERPNext Warehouse carries the nicer name as well
	wh = warehouse_name(WAREHOUSE_CODE)
	if frappe.db.exists("Warehouse", wh):
		frappe.db.set_value("Warehouse", wh, {"warehouse_type": frappe.db.get_value("Warehouse Type", "Stores", "name")}, update_modified=False)
	return codes


def ensure_brand_settings() -> None:
	"""Point the brand settings at the HQ store / main warehouse (+ smoke-shop vertical)."""
	from maison_pos.setup.install_v06 import BRAND_DEFAULTS

	values = dict(BRAND_DEFAULTS)
	values.update({"head_office_boutique": HQ_STORE, "main_warehouse": warehouse_name(WAREHOUSE_CODE), "show_product_images_default": 1})
	stored = frappe.db.get_singles_dict("AWANZ POS Settings")
	for key, value in values.items():
		if stored.get(key) in (None, "") or key in ("head_office_boutique", "main_warehouse", "vertical"):
			try:
				frappe.db.set_single_value("AWANZ POS Settings", key, value)
			except Exception:
				pass
	frappe.clear_cache(doctype="AWANZ POS Settings")
	try:
		from maison_pos.brand import clear_brand_cache

		clear_brand_cache()
	except Exception:
		pass
