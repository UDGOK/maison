"""Scents of Arabia locations (v1.3): the ``HOU-WH`` main warehouse in Houston (Markhor
Wholesale, the entity the vendor invoices) and the two Tulsa-metro stores, Owasso and East Tulsa.

Tax rates are the same approximate combined state + local sales-tax rates the CloudChaserz seed
uses for the same two addresses — **verify with the CPA** before going live. Store phone numbers
are left blank on purpose: they are the client's to fill in on the store form.
"""

from __future__ import annotations

import json
import os
from typing import Any

import frappe
from frappe.utils import nowdate

from maison_pos.setup.scentsofarabia import ABBR, COMPANY, COUNTRY, CURRENCY, DEFAULT_MARKUP_PCT, DOMAIN, LOYALTY_PROGRAM, TIMEZONE

WAREHOUSE_CODE = "HOU-WH"
HQ_STORE = "OK-OWA"  # the first store — the head-office seat until the client names another

STORES: list[dict[str, Any]] = [
	{
		"code": "OK-OWA",
		"name": "Scents of Arabia Owasso",
		"address_line": "8351 N Owasso Expy",
		"city": "Owasso, OK 74055",
		"state": "OK",
		"zip": "74055",
		"phone": "",
		"region": "Tulsa Metro",
		"tax_title": "OK Sales Tax (Owasso)",
		"tax_rate": 8.917,
		"hours": {"default": "10:00-21:00", "sun": "12:00-18:00"},
	},
	{
		"code": "OK-ETUL",
		"name": "Scents of Arabia East Tulsa",
		"address_line": "1660 E 71st St",
		"city": "Tulsa, OK 74136",
		"state": "OK",
		"zip": "74136",
		"phone": "",
		"region": "Tulsa Metro",
		"tax_title": "OK Sales Tax (Tulsa)",
		"tax_rate": 8.517,
		"hours": {"default": "10:00-21:00", "sun": "12:00-18:00"},
	},
]

WAREHOUSE_SPEC: dict[str, Any] = {
	"code": WAREHOUSE_CODE,
	"name": "Markhor Wholesale — Houston Warehouse",
	"address_line": "5700 Hartsdale Dr, Suite C",
	"city": "Houston, TX 77036",
	"state": "TX",
	"zip": "77036",
	"phone": "(832) 692-7807",
	"region": "Houston",
	"tax_title": "TX Sales Tax (Houston)",
	"tax_rate": 8.25,
	"hours": {"default": "9:00-18:00", "sat": "closed", "sun": "closed"},
}

BRAND: dict[str, Any] = {
	"brand_name": "Scents of Arabia",
	"product_name": "AWANZ POS by Scents of Arabia",
	"tagline": "Fine Oud & Perfumes",
	"wordmark_text": "SCENTS OF ARABIA",
	"sub_mark": "روائح العرب",
	"legal_name": "Scents of Arabia",
	# `brand.get_brand()` falls back to the CloudChaserz install defaults for an EMPTY key, so these
	# two must never be blank: the developer's monitored address and the site's own URL until the
	# client supplies theirs (docs/scentsofarabia.md §6).
	"support_email": "yasir@futonix.com",
	"brand_website": None,  # filled with the site URL at seed time
	"vertical": "Perfume",
	"store_noun": "Store",
	"developer_name": "Futonix",
	"developer_website": "https://futonix.com",
	"rewards_program_name": LOYALTY_PROGRAM,
	"show_product_images_default": 1,
	# perfume is not age-restricted; the rewards sign-up still asks for adults
	"age_verification_required": 0,
	"minimum_age": 18,
	"id_scan_enabled": 0,
	"webshop_age_restricted_sales": 0,
}

#: bundled brand assets → public File URLs
ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")
LOGO_FILES = {
	"mark": "scents-of-arabia-mark.png",  # 512×512 crescent + horse — app icon, favicon, navbar
	"logo": "scents-of-arabia-logo.png",  # full lockup (mark + wordmark + Arabic + tagline)
	"banner": "scents-of-arabia-banner.jpg",  # wide plaque, for the shop / e-mails
}


def store_codes() -> list[str]:
	return [s["code"] for s in STORES]


def warehouse_name(code: str) -> str:
	return f"{code} - {ABBR}"


def demo_boutique_specs() -> list[dict[str, Any]]:
	"""Shape expected by ``setup.demo`` helpers (``code``, ``tax_rate``, …) — stores only."""
	return [dict(s, email=f"{s['code'].lower().replace('-', '.')}@{DOMAIN}") for s in STORES]


# ---------------------------------------------------------------------------
#: what the desk's setup wizard would have written to System Settings for a US retailer
SYSTEM_SETTINGS: dict[str, Any] = {
	"setup_complete": 1,
	"country": COUNTRY,
	"currency": CURRENCY,
	"time_zone": TIMEZONE,
	"language": "en",
	"date_format": "mm-dd-yyyy",
	"time_format": "HH:mm:ss",
	"number_format": "#,###.##",
	"float_precision": 2,
	"first_day_of_the_week": "Sunday",
}


def ensure_erpnext_setup() -> None:
	"""Headless ERPNext setup wizard with the Scents of Arabia company on a fresh site.

	The wizard itself runs once (it commits the company as it goes, so a run that fails later
	leaves the company behind); the "setup complete" flags and the locale it would have written
	are ensured on **every** run, because they are part of the same transaction as the rest of
	the seed and roll back with it — the first production run of this seed left the site on the
	wizard screen in Asia/Kolkata for exactly that reason.
	"""
	if not frappe.db.sql("select name from tabCompany limit 1"):
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
				"email": f"admin@{DOMAIN}",
				"bank_account": "Main Bank",
				"setup_demo": 0,
			}
		)
		frappe.flags.in_setup_wizard = True
		try:
			erpnext_setup_complete(args)
		finally:
			frappe.flags.in_setup_wizard = False
	mark_setup_complete()


def mark_setup_complete() -> None:
	"""Every installed app's wizard stage marked done and the locale on System Settings — the
	desk sends any System Manager to ``/app/setup-wizard`` until both are true. Idempotent."""
	for row in frappe.get_all("Installed Application", fields=["name", "is_setup_complete"]):
		if not row.is_setup_complete:
			frappe.db.set_value("Installed Application", row.name, "is_setup_complete", 1, update_modified=False)
	meta = frappe.get_meta("System Settings")
	current = frappe.get_single("System Settings")
	for key, value in SYSTEM_SETTINGS.items():
		if meta.has_field(key) and current.get(key) != value:
			frappe.db.set_single_value("System Settings", key, value)
	frappe.clear_cache()


def ensure_store(spec: dict[str, Any], accounts: dict[str, str], walk_in: str, is_warehouse: bool = False) -> str:
	"""Warehouse + Cost Center + POS Profile + AWANZ Store for one location."""
	from maison_pos.setup import demo

	code = spec["code"]
	spec = dict(spec, email=spec.get("email") or f"{code.lower().replace('-', '.')}@{DOMAIN}")
	demo.ensure_boutique(spec, accounts, walk_in)  # company / abbr come from profile_globals()
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
	wh = warehouse_name(WAREHOUSE_CODE)
	if frappe.db.exists("Warehouse", wh):
		frappe.db.set_value("Warehouse", wh, {"warehouse_type": frappe.db.get_value("Warehouse Type", "Stores", "name")}, update_modified=False)
	# ``<store> In Transit`` for every store, exactly as the v0.6 install does for stores that already
	# exist: the stores are created AFTER ``after_install()`` here, and ERPNext caches its
	# warehouse → account map per job, so a transit warehouse created on demand by the first
	# shipment would be missing from a map built by the purchase receipts before it
	from maison_pos.setup.install_v06_shipping import ensure_transit_warehouses

	ensure_transit_warehouses()
	frappe.flags.pop("warehouse_account_map", None)
	return codes


# ---------------------------------------------------------------------------
def _public_file(key: str) -> str | None:
	"""Upload one bundled brand asset as a public File (idempotent) and return its URL.

	Idempotent on **content**, not on the file name: a re-run after the bundled asset changed
	(the mark lost its black background in 1.3.3) uploads the new bytes — Frappe suffixes the
	name — and the brand points at those, while a re-run with the same bytes finds the File that
	already holds them by its content hash.
	"""
	import hashlib

	name = LOGO_FILES[key]
	path = os.path.join(ASSETS_DIR, name)
	if not os.path.exists(path):
		return None
	with open(path, "rb") as fh:
		content = fh.read()
	digest = hashlib.md5(content).hexdigest()  # what Frappe stores in File.content_hash
	existing = frappe.db.get_value("File", {"content_hash": digest, "is_private": 0}, "file_url")
	if existing:
		return existing
	f = frappe.get_doc({"doctype": "File", "file_name": name, "is_private": 0, "content": content})
	f.flags.ignore_permissions = True
	f.insert()
	return f.file_url


def ensure_brand_assets() -> dict[str, str | None]:
	return {k: _public_file(k) for k in LOGO_FILES}


def ensure_brand_settings() -> dict[str, Any]:
	"""Write the Scents of Arabia brand, the Perfume vertical, HQ store / main warehouse, the
	logo, the age switches and the default wholesale markup on ``AWANZ POS Settings``.

	Unlike the CloudChaserz seed this writes **every** brand key, not only empty ones: the
	install defaults are CloudChaserz's, and a perfume shop must never inherit "Elevate Your
	Smoking Experience" because a key happened to be blank.
	"""
	from maison_pos.pricing.wholesale import MARKUP_FIELD

	assets = ensure_brand_assets()
	values: dict[str, Any] = dict(BRAND)
	values.update({"head_office_boutique": HQ_STORE, "main_warehouse": warehouse_name(WAREHOUSE_CODE)})
	if not values.get("brand_website"):
		values["brand_website"] = frappe.utils.get_url()
	if assets.get("mark"):
		values["brand_logo"] = assets["mark"]
	# the chain markup is written once: the install default (50 %) is CloudChaserz's placeholder,
	# and a figure the client has since typed on the price board is theirs
	if not frappe.db.get_default("scentsofarabia_markup_seeded"):
		values[MARKUP_FIELD] = DEFAULT_MARKUP_PCT
		frappe.db.set_default("scentsofarabia_markup_seeded", "1")
	meta = frappe.get_meta("AWANZ POS Settings")
	for key, value in values.items():
		if not meta.has_field(key):
			continue
		try:
			frappe.db.set_single_value("AWANZ POS Settings", key, value)
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"scentsofarabia brand setting {key}")
	frappe.clear_cache(doctype="AWANZ POS Settings")
	try:
		from maison_pos.brand import clear_brand_cache

		clear_brand_cache()
	except Exception:
		pass
	# the public website carries the brand too (the white-label pass re-reads these settings)
	try:
		from maison_pos.setup.whitelabel import apply_whitelabel

		apply_whitelabel()
	except Exception:
		frappe.log_error(frappe.get_traceback(), "scentsofarabia whitelabel")
	return {"assets": assets, "vertical": BRAND["vertical"]}
