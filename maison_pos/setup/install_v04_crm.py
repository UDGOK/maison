"""v0.4 (CRM / HR / promotions / feedback) install glue — idempotent, called from
``setup.install.after_install`` / ``after_migrate`` and the v0.4 patch.

Kept in its own module so the custom fields and settings of this section do not collide
with the other v0.4 sections (inventory, webshop, insights).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS: dict[str, list[dict[str, Any]]] = {
	"Sales Invoice": [
		{"fieldname": "maison_coupon", "label": "Maison Coupon", "fieldtype": "Link", "options": "Maison Coupon", "insert_after": "maison_notes", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_coupon_discount", "label": "Coupon Discount", "fieldtype": "Currency", "insert_after": "maison_coupon", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_promotions", "label": "Promotions Applied (JSON)", "fieldtype": "Small Text", "insert_after": "maison_coupon_discount", "read_only": 1, "no_copy": 1, "hidden": 1},
	],
	"Sales Invoice Item": [
		{"fieldname": "maison_coupon_discount", "label": "Coupon Discount", "fieldtype": "Currency", "insert_after": "discount_amount", "read_only": 1, "no_copy": 1},
	],
	# v0.4 switches for this section live as custom fields on the Single so the JSON stays untouched
	"Maison POS Settings": [
		{"fieldname": "section_v04_crm", "label": "Promotions, feedback & loyalty (v0.4)", "fieldtype": "Section Break", "insert_after": "consent_text"},
		{"fieldname": "promotions_enabled", "label": "Promotions & coupons in POS", "fieldtype": "Check", "default": "1", "insert_after": "section_v04_crm"},
		{"fieldname": "birthday_bonus_points", "label": "Birthday bonus points", "fieldtype": "Int", "default": "0", "insert_after": "promotions_enabled", "description": "Loyalty points credited on the client's birthday (0 = off). Needs a birthday on the Maison Client Profile."},
		{"fieldname": "column_break_v04_crm", "fieldtype": "Column Break", "insert_after": "birthday_bonus_points"},
		{"fieldname": "feedback_enabled", "label": "Private feedback on receipt page", "fieldtype": "Check", "default": "1", "insert_after": "column_break_v04_crm"},
		{"fieldname": "feedback_alert_threshold", "label": "Alert manager when rating ≤", "fieldtype": "Int", "default": "2", "insert_after": "feedback_enabled"},
	],
}

SETTINGS_DEFAULTS: dict[str, Any] = {
	"promotions_enabled": 1,
	"feedback_enabled": 1,
	"feedback_alert_threshold": 2,
	"birthday_bonus_points": 0,
}

# Loyalty tiers are mirrored as Customer Groups so Pricing Rules can target a tier
TIER_GROUP_PARENT = "All Customer Groups"


def create_v04_custom_fields() -> None:
	fields = {dt: rows for dt, rows in CUSTOM_FIELDS.items() if frappe.db.exists("DocType", dt)}
	if fields:
		create_custom_fields(fields, ignore_validate=frappe.flags.in_install, update=True)


def ensure_v04_settings_defaults() -> None:
	if not frappe.db.exists("DocType", "Maison POS Settings"):
		return
	stored = frappe.db.get_singles_dict("Maison POS Settings")
	for key, value in SETTINGS_DEFAULTS.items():
		if stored.get(key) in (None, ""):
			try:
				frappe.db.set_single_value("Maison POS Settings", key, value)
			except Exception:
				pass
	frappe.clear_cache(doctype="Maison POS Settings")


def ensure_tier_customer_groups() -> list[str]:
	"""One Customer Group per loyalty tier (blank when no Loyalty Program exists yet)."""
	created = []
	if not frappe.db.exists("DocType", "Loyalty Program Collection"):
		return created
	parent = TIER_GROUP_PARENT if frappe.db.exists("Customer Group", TIER_GROUP_PARENT) else frappe.db.get_value("Customer Group", {"is_group": 1}, "name")
	for tier in set(frappe.get_all("Loyalty Program Collection", pluck="tier_name")):
		if tier and not frappe.db.exists("Customer Group", tier):
			frappe.get_doc({"doctype": "Customer Group", "customer_group_name": tier, "parent_customer_group": parent, "is_group": 0}).insert(ignore_permissions=True)
			created.append(tier)
	return created


def setup_v04_crm() -> None:
	"""Entry point for after_install / after_migrate / patch."""
	create_v04_custom_fields()
	ensure_v04_settings_defaults()
	try:
		ensure_tier_customer_groups()
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison tier customer groups")
