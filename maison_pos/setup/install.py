"""after_install / after_migrate: roles, custom fields, modes of payment, workflow.

Everything here is idempotent so it can run on every migrate.
"""

from __future__ import annotations

import json
import os

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

ROLES = ("Maison Associate", "Maison Manager", "Maison Regional", "Maison Head Office")
MODES_OF_PAYMENT = (("Cash", "Cash"), ("Card", "Bank"))


def _fixture_path(name: str) -> str:
	return os.path.join(frappe.get_app_path("maison_pos"), "fixtures", name)


def _load_fixture(name: str) -> list[dict]:
	path = _fixture_path(name)
	if not os.path.exists(path):
		return []
	with open(path, encoding="utf-8") as f:
		return json.load(f)


def create_roles() -> None:
	for role in ROLES:
		if not frappe.db.exists("Role", role):
			frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": 1, "is_custom": 1}).insert(ignore_permissions=True)


def create_custom_fields_from_fixture() -> None:
	"""Apply fixtures/custom_field.json via create_custom_fields (update=True keeps it idempotent)."""
	rows = _load_fixture("custom_field.json")
	grouped: dict[str, list[dict]] = {}
	for row in rows:
		field = {
			k: v
			for k, v in row.items()
			if k
			not in ("doctype", "name", "dt", "owner", "modified_by", "creation", "modified", "docstatus", "module", "is_system_generated")
		}
		grouped.setdefault(row["dt"], []).append(field)
	if grouped:
		create_custom_fields(grouped, ignore_validate=frappe.flags.in_install, update=True)


# (doctype, role) -> granted ptypes. Data scoping comes from the Warehouse User Permission
# created per associate/manager by the seed / admin; role perms only open the doctype.
ROLE_DOCPERMS: dict[tuple[str, str], tuple[str, ...]] = {
	("Sales Invoice", "Maison Associate"): ("read", "create", "submit", "print", "email"),
	("Sales Invoice", "Maison Manager"): ("read", "write", "create", "submit", "cancel", "amend", "print", "email"),
	("Sales Invoice", "Maison Regional"): ("read", "print", "email"),
	("Sales Invoice", "Maison Head Office"): ("read", "write", "create", "submit", "cancel", "amend", "print", "email"),
	("Customer", "Maison Associate"): ("read", "write", "create"),
	("Customer", "Maison Manager"): ("read", "write", "create"),
	("Customer", "Maison Regional"): ("read",),
	("Customer", "Maison Head Office"): ("read", "write", "create"),
	# ERPNext v15 creates a Serial and Batch Bundle (with permission checks) when a Sales Invoice
	# with serial numbers is submitted; Sales User alone cannot create it, so serialized POS sales
	# by associates failed with "No permission for Serial and Batch Bundle".
	("Serial and Batch Bundle", "Maison Associate"): ("read", "write", "create", "submit", "cancel"),
	("Serial and Batch Bundle", "Maison Manager"): ("read", "write", "create", "submit", "cancel", "amend"),
	("Serial and Batch Bundle", "Maison Head Office"): ("read", "write", "create", "submit", "cancel", "amend"),
}


def create_role_permissions() -> None:
	"""Grant the Maison roles access to Sales Invoice / Customer (Custom DocPerm, idempotent)."""
	from frappe.permissions import add_permission, update_permission_property

	for (doctype, role), ptypes in ROLE_DOCPERMS.items():
		if not frappe.db.exists("Role", role) or not frappe.db.exists("DocType", doctype):
			continue
		if not frappe.db.exists("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}):
			add_permission(doctype, role, 0)
		for ptype in ptypes:
			if not frappe.db.get_value("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}, ptype):
				update_permission_property(doctype, role, 0, ptype, 1, validate=False)


def create_modes_of_payment() -> None:
	for name, mop_type in MODES_OF_PAYMENT:
		if not frappe.db.exists("Mode of Payment", name):
			frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": name, "type": mop_type, "enabled": 1}).insert(
				ignore_permissions=True
			)


def create_workflow() -> None:
	"""Import workflow states/actions/workflow from fixtures if missing."""
	for fixture in ("workflow_state.json", "workflow_action_master.json", "workflow.json"):
		for row in _load_fixture(fixture):
			doctype = row["doctype"]
			if frappe.db.exists(doctype, row["name"]):
				continue
			if doctype == "Workflow" and not frappe.db.exists("DocType", row["document_type"]):
				continue
			doc = frappe.get_doc(row)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_if_duplicate=True)


def create_print_format() -> None:
	"""Insert the receipt print format, or refresh its HTML when the fixture changed."""
	for row in _load_fixture("print_format.json"):
		if frappe.db.exists("Print Format", row["name"]):
			if frappe.db.get_value("Print Format", row["name"], "html") != row.get("html"):
				frappe.db.set_value("Print Format", row["name"], "html", row.get("html"))
			continue
		doc = frappe.get_doc(row)
		doc.flags.ignore_permissions = True
		doc.insert(ignore_if_duplicate=True)


def ensure_settings_defaults() -> None:
	"""Fill v0.3 recognition defaults (consent text, threshold, retention) on existing sites."""
	from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import ensure_recognition_defaults

	ensure_recognition_defaults()
	ensure_rounding_method()


ROUNDING_METHOD = "Commercial Rounding"


def ensure_rounding_method() -> None:
	"""Retail rounding: half away from zero, everywhere.

	The POS computes its totals on the device (`frontend/src/utils/money.ts: round`, half away from
	zero) and tenders exactly that amount; the server must land on the same cent or a card sale is
	refused as PAYMENT_MISMATCH. Frappe's default is banker's rounding (half to even), which differs
	from the device whenever a tax amount lands exactly on a half cent (e.g. 10.25 % of 22 050.00 =
	2 260.125 → 2 260.12 vs 2 260.13). System Settings `rounding_method` is therefore pinned to
	Commercial Rounding (also what receipts, price tags and tax filings expect).
	"""
	if frappe.db.get_single_value("System Settings", "rounding_method") != ROUNDING_METHOD:
		frappe.db.set_single_value("System Settings", "rounding_method", ROUNDING_METHOD)
		frappe.clear_cache()


def ensure_launcher_home_page() -> None:
	"""Point the website home page at the branded ``/start`` launcher. Idempotent.

	Frappe sends System Users to ``/app`` after login, so staff who sign in land on the
	ERPNext desk instead of the till. ``/start`` lists the screens their roles allow;
	making it the site home page means one URL gets anyone to the right place.
	Only set when the home page is still Frappe's default, so a client that has chosen
	its own landing page is never overridden.
	"""
	try:
		settings = frappe.get_single("Website Settings")
	except Exception:
		return
	current = (settings.home_page or "").strip("/")
	if current in ("", "home", "index", "login"):
		settings.home_page = "start"
		settings.flags.ignore_permissions = True
		settings.save(ignore_permissions=True)

	# Post-login destination for System Users. Frappe reads it from the apps screen
	# (see hooks.add_to_apps_screen), so with default_app set an associate signing in
	# lands on /start instead of the ERPNext desk. Only set when unset, so a client
	# that has chosen its own default app is never overridden.
	try:
		system_settings = frappe.get_single("System Settings")
		if not (system_settings.get("default_app") or "").strip():
			system_settings.default_app = "maison_pos"
			system_settings.flags.ignore_permissions = True
			system_settings.save(ignore_permissions=True)
	except Exception:
		# `default_app` was added in a later v15 patch level; harmless when missing
		pass


def after_install() -> None:
	create_roles()
	create_custom_fields_from_fixture()
	create_role_permissions()
	create_modes_of_payment()
	create_workflow()
	create_print_format()
	ensure_settings_defaults()
	# v0.4 D/E — Exchange Credit tender + Damaged warehouses (own module, idempotent)
	from maison_pos.setup.install_v04_inventory import setup_v04_inventory

	setup_v04_inventory()
	# v0.4 CRM / HR / promotions / feedback glue (own module, idempotent)
	from maison_pos.setup.install_v04_crm import setup_v04_crm

	setup_v04_crm()
	# v0.4 G — webshop glue: Item web mode, Quotation/Sales Order boutique fields, Web Payment tender
	from maison_pos.webshop.setup import after_migrate as webshop_after_migrate

	webshop_after_migrate()
	# --- v0.6 N/Q — brand settings, vertical attributes, age verification, rewards (own module) ---
	from maison_pos.setup.install_v06 import setup_v06

	setup_v06()
	# --- end v0.6 N/Q ---
	# --- v0.6 O/P — warehouse admin role, shipping fields, replenishment workflow, packing list, in-transit warehouses ---
	from maison_pos.setup.install_v06_shipping import setup_v06_shipping

	setup_v06_shipping()
	# --- end v0.6 O/P ---
	# v0.6 — one URL that gets staff to their screen
	ensure_launcher_home_page()
	frappe.db.commit()


def after_migrate() -> None:
	# fixtures are synced by bench migrate; keep roles/fields/mops current for fresh sites
	create_roles()
	create_custom_fields_from_fixture()
	create_role_permissions()
	create_modes_of_payment()
	create_print_format()
	ensure_settings_defaults()
	# v0.4 D/E — Exchange Credit tender + Damaged warehouses (own module, idempotent)
	from maison_pos.setup.install_v04_inventory import setup_v04_inventory

	setup_v04_inventory()
	# v0.4 CRM / HR / promotions / feedback glue (own module, idempotent)
	from maison_pos.setup.install_v04_crm import setup_v04_crm

	setup_v04_crm()
	# v0.4 G — webshop glue: Item web mode, Quotation/Sales Order boutique fields, Web Payment tender
	from maison_pos.webshop.setup import after_migrate as webshop_after_migrate

	webshop_after_migrate()
	# --- v0.6 N/Q — brand settings, vertical attributes, age verification, rewards (own module) ---
	from maison_pos.setup.install_v06 import setup_v06

	setup_v06()
	# --- end v0.6 N/Q ---
	# --- v0.6 O/P — warehouse admin role, shipping fields, replenishment workflow, packing list, in-transit warehouses ---
	from maison_pos.setup.install_v06_shipping import setup_v06_shipping

	setup_v06_shipping()
	# --- end v0.6 O/P ---
	# v0.6 — one URL that gets staff to their screen
	ensure_launcher_home_page()
	frappe.db.commit()
