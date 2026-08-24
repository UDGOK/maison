"""v0.6 O/P install glue — idempotent, called from ``after_install`` / ``after_migrate``.

* Role ``AWANZ Warehouse Admin`` (+ Custom DocPerms on the ERPNext stock documents it drives).
* Custom fields: Item dims (``maison_length/width/height``), AWANZ Store ship-to + in-transit
  warehouse, AWANZ POS Settings shipping / wall options (kept as Custom Fields so the v0.6 N
  stream's edits to the doctype JSONs never collide).
* Workflow ``AWANZ Replenishment Approval`` on AWANZ Replenishment Request.
* Print format ``AWANZ Packing List`` (Jinja, ``templates/print/packing_list.html``).
* ``<store> In Transit`` warehouses for every existing store.
"""

from __future__ import annotations

import os

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

WAREHOUSE_ADMIN_ROLE = "AWANZ Warehouse Admin"
WORKFLOW_NAME = "AWANZ Replenishment Approval"
PACKING_LIST_FORMAT = "AWANZ Packing List"

CUSTOM_FIELDS = {
	"Item": [
		{"fieldname": "maison_dims_section", "fieldtype": "Section Break", "label": "Shipping Dimensions", "insert_after": "weight_uom", "collapsible": 1},
		{"fieldname": "maison_length", "fieldtype": "Float", "label": "Length (cm)", "insert_after": "maison_dims_section"},
		{"fieldname": "maison_width", "fieldtype": "Float", "label": "Width (cm)", "insert_after": "maison_length"},
		{"fieldname": "maison_height", "fieldtype": "Float", "label": "Height (cm)", "insert_after": "maison_width"},
	],
	"AWANZ Store": [
		{"fieldname": "ship_to_section", "fieldtype": "Section Break", "label": "Ship-to (warehouse shipments)", "insert_after": "damaged_warehouse", "collapsible": 1},
		{"fieldname": "ship_contact_name", "fieldtype": "Data", "label": "Ship-to Contact", "insert_after": "ship_to_section"},
		{"fieldname": "ship_address_line2", "fieldtype": "Data", "label": "Address Line 2", "insert_after": "ship_contact_name"},
		{"fieldname": "ship_state", "fieldtype": "Data", "label": "State", "insert_after": "ship_address_line2", "length": 2},
		{"fieldname": "ship_postal_code", "fieldtype": "Data", "label": "ZIP", "insert_after": "ship_state"},
		{"fieldname": "ship_country", "fieldtype": "Data", "label": "Country", "insert_after": "ship_postal_code", "default": "US"},
		{"fieldname": "transit_warehouse", "fieldtype": "Link", "label": "In-Transit Warehouse", "options": "Warehouse", "insert_after": "ship_country", "read_only": 1},
	],
	"AWANZ POS Settings": [
		{"fieldname": "shipping_section", "fieldtype": "Section Break", "label": "Warehouse & Shipping", "insert_after": "consent_text_version", "collapsible": 1},
		{"fieldname": "shipping_provider", "fieldtype": "Select", "label": "Rate Provider", "options": "Simulated\nShippo\nEasyPost", "default": "Simulated", "insert_after": "shipping_section"},
		{"fieldname": "auto_print_packing_list", "fieldtype": "Check", "label": "Wall auto-prints packing list", "default": "1", "insert_after": "shipping_provider"},
		{"fieldname": "auto_print_label", "fieldtype": "Check", "label": "Wall auto-prints label", "default": "1", "insert_after": "auto_print_packing_list"},
		{"fieldname": "wall_sound_enabled", "fieldtype": "Check", "label": "Wall sound on new shipment", "default": "1", "insert_after": "auto_print_label"},
		{"fieldname": "wall_warn_hours", "fieldtype": "Int", "label": "Wall: warn after (h)", "default": "4", "insert_after": "wall_sound_enabled"},
		{"fieldname": "wall_crit_hours", "fieldtype": "Int", "label": "Wall: critical after (h)", "default": "24", "insert_after": "wall_warn_hours"},
		{"fieldname": "ship_from_column", "fieldtype": "Column Break", "insert_after": "wall_crit_hours"},
		{"fieldname": "ship_from_name", "fieldtype": "Data", "label": "Ship-from Name", "insert_after": "ship_from_column"},
		{"fieldname": "ship_from_company", "fieldtype": "Data", "label": "Ship-from Company", "insert_after": "ship_from_name"},
		{"fieldname": "ship_from_street1", "fieldtype": "Data", "label": "Ship-from Street", "insert_after": "ship_from_company"},
		{"fieldname": "ship_from_street2", "fieldtype": "Data", "label": "Ship-from Street 2", "insert_after": "ship_from_street1"},
		{"fieldname": "ship_from_city", "fieldtype": "Data", "label": "Ship-from City", "insert_after": "ship_from_street2"},
		{"fieldname": "ship_from_state", "fieldtype": "Data", "label": "Ship-from State", "insert_after": "ship_from_city", "length": 2},
		{"fieldname": "ship_from_zip", "fieldtype": "Data", "label": "Ship-from ZIP", "insert_after": "ship_from_state"},
		{"fieldname": "ship_from_country", "fieldtype": "Data", "label": "Ship-from Country", "default": "US", "insert_after": "ship_from_zip"},
		{"fieldname": "ship_from_phone", "fieldtype": "Data", "label": "Ship-from Phone", "insert_after": "ship_from_country"},
		{"fieldname": "ship_from_email", "fieldtype": "Data", "label": "Ship-from Email", "insert_after": "ship_from_phone"},
	],
}

# Warehouse admin drives ERPNext stock documents from /warehouse; AWANZ Manager posts receipts at the store.
ROLE_DOCPERMS: dict[tuple[str, str], tuple[str, ...]] = {
	("Stock Entry", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create", "submit", "cancel", "print"),
	("Material Request", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create", "submit", "cancel", "print"),
	("Purchase Order", WAREHOUSE_ADMIN_ROLE): ("read", "print"),
	("Purchase Receipt", WAREHOUSE_ADMIN_ROLE): ("read", "write", "create", "submit", "cancel", "print"),
	("Item", WAREHOUSE_ADMIN_ROLE): ("read",),
	("Warehouse", WAREHOUSE_ADMIN_ROLE): ("read",),
	("Bin", WAREHOUSE_ADMIN_ROLE): ("read",),
	("AWANZ Store", WAREHOUSE_ADMIN_ROLE): ("read",),
	("AWANZ Stock Alert", WAREHOUSE_ADMIN_ROLE): ("read", "write"),
	("Stock Entry", "AWANZ Manager"): ("read", "print"),
	("Material Request", "AWANZ Manager"): ("read", "write", "create", "print"),
	("Purchase Order", "AWANZ Manager"): ("read", "print"),
	("Purchase Receipt", "AWANZ Manager"): ("read", "print"),
}


def create_role() -> None:
	if not frappe.db.exists("Role", WAREHOUSE_ADMIN_ROLE):
		frappe.get_doc({"doctype": "Role", "role_name": WAREHOUSE_ADMIN_ROLE, "desk_access": 1, "is_custom": 1}).insert(ignore_permissions=True)


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


def create_workflow() -> None:
	if not frappe.db.exists("DocType", "AWANZ Replenishment Request") or frappe.db.exists("Workflow", WORKFLOW_NAME):
		return
	for state in ("Pending Approval", "Approved", "Rejected"):
		if not frappe.db.exists("Workflow State", state):
			frappe.get_doc({"doctype": "Workflow State", "workflow_state_name": state, "style": {"Approved": "Success", "Rejected": "Danger"}.get(state, "Warning")}).insert(ignore_permissions=True)
	for action in ("Approve", "Reject"):
		if not frappe.db.exists("Workflow Action Master", action):
			frappe.get_doc({"doctype": "Workflow Action Master", "workflow_action_name": action}).insert(ignore_permissions=True)
	approvers = (WAREHOUSE_ADMIN_ROLE, "AWANZ Head Office")
	doc = frappe.get_doc(
		{
			"doctype": "Workflow",
			"workflow_name": WORKFLOW_NAME,
			"document_type": "AWANZ Replenishment Request",
			"is_active": 1,
			"override_status": 0,
			"send_email_alert": 0,
			"workflow_state_field": "status",
			"states": [
				{"state": "Pending Approval", "doc_status": "0", "allow_edit": WAREHOUSE_ADMIN_ROLE},
				{"state": "Approved", "doc_status": "0", "allow_edit": WAREHOUSE_ADMIN_ROLE},
				{"state": "Rejected", "doc_status": "0", "allow_edit": WAREHOUSE_ADMIN_ROLE},
			],
			"transitions": [
				{"state": "Pending Approval", "action": action, "next_state": nxt, "allowed": role, "allow_self_approval": 1}
				for action, nxt in (("Approve", "Approved"), ("Reject", "Rejected"))
				for role in approvers
			],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_if_duplicate=True)


def create_print_format() -> None:
	path = os.path.join(frappe.get_app_path("maison_pos"), "templates", "print", "packing_list.html")
	if not os.path.exists(path) or not frappe.db.exists("DocType", "AWANZ Shipment"):
		return
	with open(path, encoding="utf-8") as f:
		html = f.read()
	if frappe.db.exists("Print Format", PACKING_LIST_FORMAT):
		if frappe.db.get_value("Print Format", PACKING_LIST_FORMAT, "html") != html:
			frappe.db.set_value("Print Format", PACKING_LIST_FORMAT, "html", html)
		return
	frappe.get_doc(
		{
			"doctype": "Print Format",
			"name": PACKING_LIST_FORMAT,
			"doc_type": "AWANZ Shipment",
			"module": "AWANZ POS",
			"standard": "No",
			"custom_format": 1,
			"print_format_type": "Jinja",
			"disabled": 0,
			"font_size": 10,
			"margin_top": 0.0,
			"margin_bottom": 0.0,
			"margin_left": 0.0,
			"margin_right": 0.0,
			"page_number": "Hide",
			"default_print_language": "en",
			"html": html,
		}
	).insert(ignore_permissions=True, ignore_if_duplicate=True)


def ensure_transit_warehouses() -> list[str]:
	from maison_pos.shipping import ensure_transit_warehouse, grant_transit_permissions, store_boutiques

	out = []
	if not frappe.db.exists("DocType", "AWANZ Store") or not frappe.db.table_exists("AWANZ Store"):
		return out
	for code in store_boutiques():
		try:
			transit = ensure_transit_warehouse(code)
			grant_transit_permissions(code, transit)
			out.append(transit)
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"awanz transit warehouse {code}")
	return out


def setup_v06_shipping() -> None:
	create_role()
	create_fields()
	create_docperms()
	create_workflow()
	create_print_format()
	ensure_transit_warehouses()
