"""Custom fields + install hooks for the webshop integration (idempotent).

Kept out of ``fixtures/custom_field.json`` on purpose: that file is shared by every v0.4
work-stream, and these fields only matter when ``webshop`` is installed.
"""

from __future__ import annotations

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

from maison_pos.webshop import FULFILMENTS, WEB_MODES, WEB_STATUSES

SIMULATED_GATEWAY = "Maison Simulated"
WEB_MODE_OF_PAYMENT = "Web Payment"

WEBSHOP_CUSTOM_FIELDS: dict[str, list[dict]] = {
	"Item": [
		{
			"fieldname": "maison_web_section",
			"fieldtype": "Section Break",
			"label": "Maison Web",
			"insert_after": "maison_taxable",
			"collapsible": 1,
		},
		{
			"fieldname": "maison_web_mode",
			"fieldtype": "Select",
			"label": "Web Mode",
			"options": "\n".join(WEB_MODES),
			"default": "Buy",
			"insert_after": "maison_web_section",
			"description": "Buy = add to cart · Enquire = contact the boutique (one-of-a-kind pieces) · Reserve-with-deposit = pay a deposit online, balance at the boutique",
		},
		{
			"fieldname": "maison_deposit_percent",
			"fieldtype": "Percent",
			"label": "Deposit %",
			"default": "10",
			"insert_after": "maison_web_mode",
			"depends_on": "eval:doc.maison_web_mode=='Reserve-with-deposit'",
		},
	],
	"Quotation": [
		{
			"fieldname": "maison_web_section",
			"fieldtype": "Section Break",
			"label": "Maison Web",
			"insert_after": "order_type",
			"collapsible": 1,
		},
		{
			"fieldname": "maison_boutique",
			"fieldtype": "Link",
			"label": "Boutique (collect at)",
			"options": "Maison Boutique",
			"insert_after": "maison_web_section",
		},
		{
			"fieldname": "maison_fulfilment",
			"fieldtype": "Select",
			"label": "Fulfilment",
			"options": "\n" + "\n".join(FULFILMENTS),
			"insert_after": "maison_boutique",
		},
	],
	"Sales Order": [
		{
			"fieldname": "maison_web_section",
			"fieldtype": "Section Break",
			"label": "Maison Web",
			"insert_after": "order_type",
			"collapsible": 1,
		},
		{
			"fieldname": "maison_web_order",
			"fieldtype": "Check",
			"label": "Web Order",
			"insert_after": "maison_web_section",
			"read_only": 1,
			"in_standard_filter": 1,
		},
		{
			"fieldname": "maison_boutique",
			"fieldtype": "Link",
			"label": "Boutique (collect at)",
			"options": "Maison Boutique",
			"insert_after": "maison_web_order",
			"in_standard_filter": 1,
			"search_index": 1,
		},
		{
			"fieldname": "maison_fulfilment",
			"fieldtype": "Select",
			"label": "Fulfilment",
			"options": "\n" + "\n".join(FULFILMENTS),
			"insert_after": "maison_boutique",
		},
		{
			"fieldname": "maison_web_mode",
			"fieldtype": "Select",
			"label": "Web Mode",
			"options": "\nBuy\nReserve-with-deposit",
			"insert_after": "maison_fulfilment",
		},
		{
			"fieldname": "maison_web_column",
			"fieldtype": "Column Break",
			"insert_after": "maison_web_mode",
		},
		{
			"fieldname": "maison_web_status",
			"fieldtype": "Select",
			"label": "Web Status",
			"options": "\n" + "\n".join(WEB_STATUSES),
			"insert_after": "maison_web_column",
			"allow_on_submit": 1,
			"in_standard_filter": 1,
			"in_list_view": 1,
		},
		{
			"fieldname": "maison_deposit_amount",
			"fieldtype": "Currency",
			"label": "Deposit Due Online",
			"options": "currency",
			"insert_after": "maison_web_status",
		},
		{
			"fieldname": "maison_prepaid_amount",
			"fieldtype": "Currency",
			"label": "Paid Online",
			"options": "currency",
			"insert_after": "maison_deposit_amount",
			"allow_on_submit": 1,
			"read_only": 1,
		},
		{
			"fieldname": "maison_sales_invoice",
			"fieldtype": "Link",
			"label": "Collected on Invoice",
			"options": "Sales Invoice",
			"insert_after": "maison_prepaid_amount",
			"allow_on_submit": 1,
			"read_only": 1,
		},
		{
			"fieldname": "maison_collected_at",
			"fieldtype": "Datetime",
			"label": "Collected At",
			"insert_after": "maison_sales_invoice",
			"allow_on_submit": 1,
			"read_only": 1,
		},
		{
			"fieldname": "maison_web_note",
			"fieldtype": "Small Text",
			"label": "Pick Note",
			"insert_after": "maison_collected_at",
			"allow_on_submit": 1,
		},
	],
	"Sales Invoice": [
		{
			"fieldname": "maison_sales_order",
			"fieldtype": "Link",
			"label": "Web Order (Sales Order)",
			"options": "Sales Order",
			"insert_after": "maison_notes",
			"read_only": 1,
			"no_copy": 1,
		},
	],
}


def create_webshop_custom_fields() -> None:
	"""Create / refresh the v0.4 webshop custom fields (safe to run on every migrate)."""
	existing = {dt: fields for dt, fields in WEBSHOP_CUSTOM_FIELDS.items() if frappe.db.exists("DocType", dt)}
	if existing:
		create_custom_fields(existing, ignore_validate=frappe.flags.in_install, update=True)


def create_web_mode_of_payment() -> None:
	"""``Web Payment`` mode of payment: used by the POS when a web order was (part-)paid online."""
	if not frappe.db.exists("Mode of Payment", WEB_MODE_OF_PAYMENT):
		frappe.get_doc(
			{"doctype": "Mode of Payment", "mode_of_payment": WEB_MODE_OF_PAYMENT, "type": "Bank", "enabled": 1}
		).insert(ignore_permissions=True)


# ERPNext ≥ 15.7x calls ``Item.check_permission()`` inside ``get_item_details``; portal shoppers
# (role Customer, a Website User) have no Item permission out of the box, so webshop's
# ``update_cart`` fails with PermissionError. Grant read on the doctypes the cart touches.
PORTAL_DOCPERMS: dict[tuple[str, str], tuple[str, ...]] = {
	("Item", "Customer"): ("read",),
	("Item Price", "Customer"): ("read",),
	("Website Item", "Customer"): ("read",),
	# ERPNext's party-account lookup (``get_party_account``) runs a strict select/read check
	("Account", "Customer"): ("select",),
	("Sales Taxes and Charges Template", "Customer"): ("read",),
	("Price List", "Customer"): ("read",),
	# collecting a prepaid web order reconciles the advance Payment Entry onto the POS invoice
	# (ERPNext checks read on Payment Entry while re-saving it)
	("Payment Entry", "Maison Associate"): ("read",),
	("Payment Entry", "Maison Manager"): ("read",),
	("Payment Entry", "Maison Regional"): ("read",),
	("Payment Entry", "Maison Head Office"): ("read", "write", "create", "submit", "cancel"),
}


def create_portal_permissions() -> None:
	from frappe.permissions import add_permission, update_permission_property

	for (doctype, role), ptypes in PORTAL_DOCPERMS.items():
		if not frappe.db.exists("Role", role) or not frappe.db.exists("DocType", doctype):
			continue
		if not frappe.db.exists("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}):
			add_permission(doctype, role, 0)
		for ptype in ptypes:
			if not frappe.db.get_value("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}, ptype):
				update_permission_property(doctype, role, 0, ptype, 1, validate=False)


# --- v0.8 QA A1 — a new customer must be able to register and check out --------------------------
#
# The bag and the checkout require a login (`www/shop/_common.py::require_login`), so a storefront
# whose sign-up is closed is browse-only: on the live CloudChaserz site `Website Settings.
# disable_signup` was 1, `Portal Settings.default_role` was unset and there was not a single
# Website User, and `sign_up` answered "Sign Up is disabled". Both settings are part of the shop
# working at all, so they are asserted wherever the webshop glue runs (install, migrate, seed)
# rather than left to whoever remembers to tick them.
#
# `default_role` is what gives a self-registered shopper the Customer role, which is what
# webshop's cart needs to read Items and write its Quotation.
# -------------------------------------------------------------------------------------------
PORTAL_DEFAULT_ROLE = "Customer"


def ensure_portal_signup(enable_signup: bool = True) -> dict[str, object]:
	"""Portal sign-up on, with the Customer role for whoever registers. Idempotent."""
	changed: dict[str, object] = {}
	if frappe.db.exists("DocType", "Portal Settings"):
		if frappe.db.exists("Role", PORTAL_DEFAULT_ROLE) and frappe.db.get_single_value("Portal Settings", "default_role") != PORTAL_DEFAULT_ROLE:
			frappe.db.set_single_value("Portal Settings", "default_role", PORTAL_DEFAULT_ROLE)
			changed["default_role"] = PORTAL_DEFAULT_ROLE
	if enable_signup and frappe.utils.cint(frappe.db.get_single_value("Website Settings", "disable_signup")):
		frappe.db.set_single_value("Website Settings", "disable_signup", 0)
		frappe.clear_cache()
		changed["disable_signup"] = 0
	return changed
# --- end v0.8 QA A1 ---


def after_install() -> None:
	create_webshop_custom_fields()
	create_web_mode_of_payment()
	create_portal_permissions()
	ensure_portal_signup()
	frappe.db.commit()


def after_migrate() -> None:
	create_webshop_custom_fields()
	create_web_mode_of_payment()
	create_portal_permissions()
	ensure_portal_signup()
	frappe.db.commit()
