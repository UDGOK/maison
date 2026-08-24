"""v1.0 "Procurement" install glue — idempotent, called from ``after_install`` / ``after_migrate``.

* **Moving Average** pinned site-wide and on every stock Item (client decision 1).
* Custom fields: vendor terms on ``Supplier``, the vendor catalogue table on ``Item``, drop-ship /
  freight / sent-stamps on ``Purchase Order`` and ``Purchase Receipt``, the buying horizon on
  ``AWANZ POS Settings``.
* The freight / valuation account for every company that owns a store.
* ``Custom DocPerm`` so a warehouse admin can actually raise and submit orders, and a store
  manager keeps read-only access to a Purchase Order addressed to their store.
* Print format ``AWANZ Purchase Order`` (Jinja, ``templates/print/purchase_order.html``).
"""

from __future__ import annotations

import os
from typing import Any

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
from frappe.utils import cint

WAREHOUSE_ADMIN_ROLE = "AWANZ Warehouse Admin"
PURCHASE_ORDER_FORMAT = "AWANZ Purchase Order"

CUSTOM_FIELDS: dict[str, list[dict[str, Any]]] = {
	"Supplier": [
		{"fieldname": "maison_vendor_section", "fieldtype": "Section Break", "label": "AWANZ Vendor Terms", "insert_after": "supplier_group", "collapsible": 0},
		{"fieldname": "maison_lead_time_days", "fieldtype": "Int", "label": "Lead Time (days)", "insert_after": "maison_vendor_section"},
		{"fieldname": "maison_min_order_value", "fieldtype": "Currency", "label": "Minimum Order Value", "insert_after": "maison_lead_time_days"},
		{"fieldname": "maison_dropship_capable", "fieldtype": "Check", "label": "Can Drop-ship to a Store", "insert_after": "maison_min_order_value"},
		{"fieldname": "maison_order_method", "fieldtype": "Select", "label": "Order Method", "options": "Email\nPortal\nPhone\nEDI", "default": "Email", "insert_after": "maison_dropship_capable"},
		{"fieldname": "maison_portal_url", "fieldtype": "Data", "label": "Portal URL", "insert_after": "maison_order_method"},
		{"fieldname": "maison_account_number", "fieldtype": "Data", "label": "Our Account Number", "description": "The number the vendor knows us by", "insert_after": "maison_portal_url"},
		{"default": "1", "fieldname": "maison_active", "fieldtype": "Check", "label": "Active Vendor", "insert_after": "maison_account_number"},
		{"fieldname": "maison_rep_column", "fieldtype": "Column Break", "insert_after": "maison_active"},
		{"fieldname": "maison_rep_name", "fieldtype": "Data", "label": "Rep Name", "insert_after": "maison_rep_column"},
		{"fieldname": "maison_rep_phone", "fieldtype": "Data", "label": "Rep Phone", "insert_after": "maison_rep_name"},
		{"fieldname": "maison_rep_email", "fieldtype": "Data", "label": "Rep Email", "options": "Email", "insert_after": "maison_rep_phone"},
		{"fieldname": "maison_notes", "fieldtype": "Small Text", "label": "Notes", "insert_after": "maison_rep_email"},
	],
	"Item": [
		{"fieldname": "maison_vendors_section", "fieldtype": "Section Break", "label": "Vendors", "insert_after": "item_group", "collapsible": 1},
		{"fieldname": "maison_vendors", "fieldtype": "Table", "label": "Vendors", "options": "AWANZ Item Vendor", "insert_after": "maison_vendors_section"},
	],
	"Purchase Order": [
		{"fieldname": "maison_purchasing_section", "fieldtype": "Section Break", "label": "AWANZ Purchasing", "insert_after": "set_warehouse", "collapsible": 1},
		{"fieldname": "maison_dropship_store", "fieldtype": "Link", "label": "Drop-ship to Store", "options": "AWANZ Store", "insert_after": "maison_purchasing_section", "description": "Ships direct from the vendor to this store; the store's Receive screen posts the receipt."},
		{"fieldname": "maison_freight_amount", "fieldtype": "Currency", "label": "Freight", "insert_after": "maison_dropship_store", "description": "Manually entered; maintained as one Actual / Valuation charge so it lands in moving-average cost."},
		{"fieldname": "maison_source_request", "fieldtype": "Link", "label": "Source Replenishment Request", "options": "AWANZ Replenishment Request", "insert_after": "maison_freight_amount"},
		{"fieldname": "maison_sent_column", "fieldtype": "Column Break", "insert_after": "maison_source_request"},
		{"fieldname": "maison_sent_on", "fieldtype": "Datetime", "label": "Sent to Vendor On", "read_only": 1, "insert_after": "maison_sent_column"},
		{"fieldname": "maison_sent_by", "fieldtype": "Link", "label": "Sent By", "options": "User", "read_only": 1, "insert_after": "maison_sent_on"},
		{"fieldname": "maison_sent_method", "fieldtype": "Select", "label": "Sent By Method", "options": "\nEmail\nPortal\nPhone\nEDI", "read_only": 1, "insert_after": "maison_sent_by"},
	],
	"Purchase Receipt": [
		{"fieldname": "maison_purchasing_section", "fieldtype": "Section Break", "label": "AWANZ Purchasing", "insert_after": "set_warehouse", "collapsible": 1},
		{"fieldname": "maison_dropship_store", "fieldtype": "Link", "label": "Drop-ship Store", "options": "AWANZ Store", "insert_after": "maison_purchasing_section"},
		{"fieldname": "maison_freight_amount", "fieldtype": "Currency", "label": "Freight", "insert_after": "maison_dropship_store"},
	],
	"AWANZ POS Settings": [
		{"fieldname": "purchasing_section", "fieldtype": "Section Break", "label": "Purchasing", "insert_after": "wall_crit_hours", "collapsible": 1},
		{"fieldname": "purchase_cover_days", "fieldtype": "Int", "label": "Buying horizon (days of cover)", "default": "21", "insert_after": "purchasing_section", "description": "A trending item is suggested when the warehouse holds less than this many days of cover."},
	],
}

# Buying is centralised: the warehouse admin drives Purchase Orders and Receipts; a store manager
# keeps read-only access (the row-level narrowing is `maison_pos.scoping.purchase_order_query`).
ROLE_DOCPERMS: dict[tuple[str, str], tuple[str, ...]] = {
	("Purchase Order", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create", "submit", "cancel", "amend", "print", "email"),
	("Purchase Order", "AWANZ Head Office"): ("read", "write", "create", "submit", "cancel", "amend", "print", "email"),
	("Purchase Receipt", "AWANZ Head Office"): ("read", "write", "create", "submit", "cancel", "amend", "print"),
	("Supplier", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create", "print", "email"),
	("Supplier", "AWANZ Head Office"): ("read", "write", "create", "print", "email"),
	("Item Price", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create", "delete"),
	("Price List", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create"),
	("Item", WAREHOUSE_ADMIN_ROLE): ("read", "write"),
	("Item Reorder", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create"),
	("AWANZ Purchase Suggestion", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create", "delete"),
	("AWANZ Purchase Suggestion", "AWANZ Head Office"): ("read", "write", "create", "delete"),
	# ERPNext resolves the vendor's payable account while validating a Purchase Order and refuses
	# outright when the user cannot read it (`erpnext.accounts.party.get_party_account`), so a
	# buyer needs read on Account or they cannot raise an order at all. `add_permission` copies
	# the standard DocPerms into Custom DocPerms first, so nobody else loses access.
	("Account", WAREHOUSE_ADMIN_ROLE): ("read",),
	("Account", "AWANZ Head Office"): ("read",),
}


def create_fields() -> None:
	existing = {dt: fields for dt, fields in CUSTOM_FIELDS.items() if frappe.db.exists("DocType", dt)}
	if existing:
		create_custom_fields(existing, ignore_validate=frappe.flags.in_install, update=True)


def create_docperms() -> None:
	from frappe.permissions import add_permission, update_permission_property

	for (doctype, role), ptypes in ROLE_DOCPERMS.items():
		if not frappe.db.exists("Role", role) or not frappe.db.exists("DocType", doctype):
			continue
		if not frappe.db.exists("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}):
			add_permission(doctype, role, 0)
		for ptype in ptypes:
			if not frappe.db.get_value("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}, ptype):
				update_permission_property(doctype, role, 0, ptype, 1, validate=False)


def ensure_freight_accounts() -> list[str]:
	"""Resolve (and if need be create) the freight / valuation account of every store's company."""
	from maison_pos.purchasing import freight_account

	out: list[str] = []
	if not frappe.db.exists("DocType", "AWANZ Store") or not frappe.db.table_exists("AWANZ Store"):
		return out
	companies = {r.company for r in frappe.get_all("AWANZ Store", fields=["company"]) if r.company}
	for company in sorted(companies):
		if not frappe.db.exists("Company", company):
			continue
		try:
			account = freight_account(company)
			if account:
				out.append(account)
		except Exception:  # pragma: no cover
			frappe.log_error(frappe.get_traceback(), f"awanz freight account {company}")
	return out


def ensure_buying_settings() -> bool:
	"""Client decision 4: **every price is manually overridable**, the receipt cost included.

	ERPNext ships with *Maintain Same Rate Throughout the Purchase Cycle* on, which makes a
	Purchase Receipt refuse any unit cost that differs from the order
	(``erpnext.utilities.transaction_base.validate_rate_with_reference_doc``). That is precisely
	the override the warehouse manager is asked for when a vendor invoices a different price on
	the day, so it is turned off here — deliberately, idempotently, and documented in
	``docs/purchasing.md``. The drift itself is not lost: it lands in moving-average cost and is
	printed by ``AWANZ Item Purchase History``.
	"""
	try:
		if cint(frappe.db.get_single_value("Buying Settings", "maintain_same_rate")):
			frappe.db.set_single_value("Buying Settings", "maintain_same_rate", 0)
			frappe.clear_cache(doctype="Buying Settings")
			return True
	except Exception:  # pragma: no cover — erpnext not installed
		pass
	return False


def create_print_format() -> None:
	path = os.path.join(frappe.get_app_path("maison_pos"), "templates", "print", "purchase_order.html")
	if not os.path.exists(path) or not frappe.db.exists("DocType", "Purchase Order"):
		return
	with open(path, encoding="utf-8") as f:
		html = f.read()
	if frappe.db.exists("Print Format", PURCHASE_ORDER_FORMAT):
		if frappe.db.get_value("Print Format", PURCHASE_ORDER_FORMAT, "html") != html:
			frappe.db.set_value("Print Format", PURCHASE_ORDER_FORMAT, "html", html)
		return
	frappe.get_doc(
		{
			"doctype": "Print Format",
			"name": PURCHASE_ORDER_FORMAT,
			"doc_type": "Purchase Order",
			"module": "AWANZ POS",
			"standard": "No",
			"custom_format": 1,
			"print_format_type": "Jinja",
			"disabled": 0,
			"font_size": 10,
			"margin_top": 10.0,
			"margin_bottom": 10.0,
			"margin_left": 10.0,
			"margin_right": 10.0,
			"page_number": "Hide",
			"default_print_language": "en",
			"html": html,
		}
	).insert(ignore_permissions=True, ignore_if_duplicate=True)


def setup_v10_purchasing() -> dict[str, Any]:
	from maison_pos.purchasing import ensure_moving_average

	create_fields()
	create_docperms()
	valuation = ensure_moving_average()
	accounts = ensure_freight_accounts()
	same_rate = ensure_buying_settings()
	create_print_format()
	return {"valuation": valuation, "freight_accounts": accounts, "maintain_same_rate_disabled": same_rate}
