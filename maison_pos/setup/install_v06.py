"""v0.6 N/Q install glue — brand settings, vertical product attributes, age verification,
rewards program switches. Idempotent; called from ``setup.install.after_install`` /
``after_migrate``.

Everything of this section lives as **Custom Fields** (on the Single, on Item / Sales Invoice /
Maison Boutique) so the shared doctype JSONs stay untouched while other sections are built in
parallel. Internal doctype names stay ``Maison *``; the user-facing brand comes from the
settings (``maison_pos.brand.get_brand``).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

VERTICALS = ("Smoke Shop", "Jewellery", "General")

# Item groups whose items are age-restricted by default (smoke-shop vertical)
AGE_RESTRICTED_GROUPS = ("Disposables", "E-Liquid", "Devices & Mods", "Pods & Coils", "Hookah & Shisha", "Kratom", "Rolling & Papers", "Glass & Rigs")

BRAND_DEFAULTS: dict[str, Any] = {
	"brand_name": "CloudChaserz",
	"product_name": "Maison POS by CloudChaserz",
	"tagline": "Elevate Your Smoking Experience",
	"wordmark_text": "CLOUDCHASERZ",
	"sub_mark": "Maison POS",
	"legal_name": "CloudChaserz World LLC",
	"support_email": "support@cloudchaserzworld.com",
	"brand_website": "https://cloudchaserzworld.com",
	"vertical": "Smoke Shop",
	"store_noun": "Store",
}

AGE_DEFAULTS: dict[str, Any] = {
	"age_verification_required": 1,
	"minimum_age": 21,
	"id_scan_enabled": 1,
	"webshop_age_restricted_sales": 0,
}

REWARDS_DEFAULTS: dict[str, Any] = {
	"rewards_program_name": "CloudChaserz Rewards",
	"reward_allow_stacking": 0,
	"birthday_coupon_enabled": 1,
	"birthday_coupon_type": "Percent",
	"birthday_coupon_value": 15,
	"birthday_coupon_lead_days": 7,
	"birthday_coupon_valid_days": 30,
	"new_arrivals_days": 14,
	"giveaway_entries_per_amount": 25,
}

SETTINGS_DEFAULTS: dict[str, Any] = {**BRAND_DEFAULTS, **AGE_DEFAULTS, **REWARDS_DEFAULTS}

CUSTOM_FIELDS: dict[str, list[dict[str, Any]]] = {
	"Maison POS Settings": [
		{"fieldname": "section_v06_brand", "label": "Brand (v0.6)", "fieldtype": "Section Break", "insert_after": "low_stock_notify_regional", "collapsible": 0},
		{"fieldname": "brand_name", "label": "Brand name", "fieldtype": "Data", "default": BRAND_DEFAULTS["brand_name"], "insert_after": "section_v06_brand"},
		{"fieldname": "product_name", "label": "Product name", "fieldtype": "Data", "default": BRAND_DEFAULTS["product_name"], "insert_after": "brand_name"},
		{"fieldname": "tagline", "label": "Tagline", "fieldtype": "Data", "default": BRAND_DEFAULTS["tagline"], "insert_after": "product_name"},
		{"fieldname": "wordmark_text", "label": "Wordmark text", "fieldtype": "Data", "default": BRAND_DEFAULTS["wordmark_text"], "insert_after": "tagline", "description": "Rendered in Unbounded 900 on the POS, Salon, receipts and the shop header."},
		{"fieldname": "sub_mark", "label": "Sub-mark", "fieldtype": "Data", "default": BRAND_DEFAULTS["sub_mark"], "insert_after": "wordmark_text"},
		{"fieldname": "column_break_v06_brand", "fieldtype": "Column Break", "insert_after": "sub_mark"},
		{"fieldname": "legal_name", "label": "Legal name", "fieldtype": "Data", "default": BRAND_DEFAULTS["legal_name"], "insert_after": "column_break_v06_brand"},
		{"fieldname": "support_email", "label": "Support e-mail", "fieldtype": "Data", "options": "Email", "default": BRAND_DEFAULTS["support_email"], "insert_after": "legal_name"},
		{"fieldname": "brand_website", "label": "Website", "fieldtype": "Data", "default": BRAND_DEFAULTS["brand_website"], "insert_after": "support_email"},
		{"fieldname": "brand_logo", "label": "Brand logo", "fieldtype": "Attach Image", "insert_after": "brand_website"},
		{"fieldname": "head_office_boutique", "label": "Head office store", "fieldtype": "Link", "options": "Maison Boutique", "insert_after": "brand_logo"},
		{"fieldname": "main_warehouse", "label": "Main warehouse", "fieldtype": "Link", "options": "Warehouse", "insert_after": "head_office_boutique"},
		{"fieldname": "vertical", "label": "Vertical", "fieldtype": "Select", "options": "\n".join(VERTICALS), "default": BRAND_DEFAULTS["vertical"], "insert_after": "main_warehouse", "description": "Controls which product attribute fields the POS / shop show."},
		{"fieldname": "section_v06_age", "label": "Age verification (v0.6)", "fieldtype": "Section Break", "insert_after": "vertical"},
		{"fieldname": "age_verification_required", "label": "Require age verification for restricted items", "fieldtype": "Check", "default": "1", "insert_after": "section_v06_age"},
		{"fieldname": "minimum_age", "label": "Minimum age", "fieldtype": "Int", "default": "21", "insert_after": "age_verification_required"},
		{"fieldname": "column_break_v06_age", "fieldtype": "Column Break", "insert_after": "minimum_age"},
		{"fieldname": "id_scan_enabled", "label": "ID scan (PDF417 / AAMVA) enabled", "fieldtype": "Check", "default": "1", "insert_after": "column_break_v06_age"},
		{"fieldname": "webshop_age_restricted_sales", "label": "Sell age-restricted items online", "fieldtype": "Check", "default": "0", "insert_after": "id_scan_enabled", "description": "Off: age-restricted items show 'Available in store' on the web shop (PACT Act / state rules)."},
		{"fieldname": "section_v06_rewards", "label": "Rewards program (v0.6)", "fieldtype": "Section Break", "insert_after": "webshop_age_restricted_sales"},
		{"fieldname": "rewards_program_name", "label": "Program name", "fieldtype": "Data", "default": REWARDS_DEFAULTS["rewards_program_name"], "insert_after": "section_v06_rewards"},
		{"fieldname": "reward_allow_stacking", "label": "Allow more than one reward tier per transaction", "fieldtype": "Check", "default": "0", "insert_after": "rewards_program_name"},
		{"fieldname": "giveaway_entries_per_amount", "label": "Giveaway: $ per entry (default rule)", "fieldtype": "Currency", "default": "25", "insert_after": "reward_allow_stacking"},
		{"fieldname": "new_arrivals_days", "label": "New arrivals window (days)", "fieldtype": "Int", "default": "14", "insert_after": "giveaway_entries_per_amount"},
		{"fieldname": "column_break_v06_rewards", "fieldtype": "Column Break", "insert_after": "new_arrivals_days"},
		{"fieldname": "birthday_coupon_enabled", "label": "Birthday coupon", "fieldtype": "Check", "default": "1", "insert_after": "column_break_v06_rewards"},
		{"fieldname": "birthday_coupon_type", "label": "Birthday discount type", "fieldtype": "Select", "options": "Percent\nAmount", "default": "Percent", "insert_after": "birthday_coupon_enabled"},
		{"fieldname": "birthday_coupon_value", "label": "Birthday discount value", "fieldtype": "Float", "default": "15", "insert_after": "birthday_coupon_type"},
		{"fieldname": "birthday_coupon_lead_days", "label": "Issue N days before birthday", "fieldtype": "Int", "default": "7", "insert_after": "birthday_coupon_value"},
		{"fieldname": "birthday_coupon_valid_days", "label": "Birthday coupon valid (days)", "fieldtype": "Int", "default": "30", "insert_after": "birthday_coupon_lead_days"},
	],
	"Item": [
		{"fieldname": "maison_vertical_section", "label": "Product attributes", "fieldtype": "Section Break", "insert_after": "maison_image_url", "collapsible": 0},
		{"fieldname": "maison_brand", "label": "Brand", "fieldtype": "Data", "insert_after": "maison_vertical_section", "in_standard_filter": 1},
		{"fieldname": "maison_flavor", "label": "Flavor", "fieldtype": "Data", "insert_after": "maison_brand"},
		{"fieldname": "maison_nicotine_mg", "label": "Nicotine (mg/ml)", "fieldtype": "Float", "insert_after": "maison_flavor"},
		{"fieldname": "maison_volume_ml", "label": "Volume (ml)", "fieldtype": "Float", "insert_after": "maison_nicotine_mg"},
		{"fieldname": "maison_vertical_column", "fieldtype": "Column Break", "insert_after": "maison_volume_ml"},
		{"fieldname": "maison_puffs", "label": "Puffs", "fieldtype": "Int", "insert_after": "maison_vertical_column"},
		{"fieldname": "maison_age_restricted", "label": "Age restricted (21+)", "fieldtype": "Check", "default": "0", "insert_after": "maison_puffs", "in_standard_filter": 1},
		{"fieldname": "maison_msrp", "label": "MSRP", "fieldtype": "Currency", "insert_after": "maison_age_restricted"},
	],
	"Sales Invoice": [
		{"fieldname": "maison_age_section", "label": "Age verification", "fieldtype": "Section Break", "insert_after": "maison_manager_approved_by", "collapsible": 1},
		{"fieldname": "maison_age_verified", "label": "Age verified", "fieldtype": "Check", "default": "0", "insert_after": "maison_age_section", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_age_method", "label": "Method", "fieldtype": "Select", "options": "\nScan\nManual", "insert_after": "maison_age_verified", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_age_dob_year_ok", "label": "DOB year OK", "fieldtype": "Check", "default": "0", "insert_after": "maison_age_method", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_age_column", "fieldtype": "Column Break", "insert_after": "maison_age_dob_year_ok"},
		{"fieldname": "maison_age_checked_by", "label": "Checked by", "fieldtype": "Link", "options": "Maison Associate", "insert_after": "maison_age_column", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_age_checked_at", "label": "Checked at", "fieldtype": "Datetime", "insert_after": "maison_age_checked_by", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_age_check", "label": "Age check log", "fieldtype": "Link", "options": "Maison Age Check", "insert_after": "maison_age_checked_at", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_reward_tier", "label": "Reward tier redeemed", "fieldtype": "Link", "options": "Maison Reward Tier", "insert_after": "maison_age_check", "read_only": 1, "no_copy": 1},
		{"fieldname": "maison_giveaway_entries", "label": "Giveaway entries", "fieldtype": "Int", "default": "0", "insert_after": "maison_reward_tier", "read_only": 1, "no_copy": 1},
	],
	"Maison Boutique": [
		{"fieldname": "section_v06_store", "label": "Store (v0.6)", "fieldtype": "Section Break", "insert_after": "damaged_warehouse"},
		{"fieldname": "boutique_type", "label": "Type", "fieldtype": "Select", "options": "Store\nWarehouse", "default": "Store", "insert_after": "section_v06_store", "in_standard_filter": 1},
		{"fieldname": "is_warehouse", "label": "Is warehouse (not a store)", "fieldtype": "Check", "default": "0", "insert_after": "boutique_type"},
		{"fieldname": "region", "label": "Region", "fieldtype": "Select", "options": "\nHouston\nTulsa Metro\nOklahoma", "insert_after": "is_warehouse", "in_standard_filter": 1},
		{"fieldname": "column_break_v06_store", "fieldtype": "Column Break", "insert_after": "region"},
		{"fieldname": "timezone", "label": "Time zone", "fieldtype": "Data", "default": "America/Chicago", "insert_after": "column_break_v06_store"},
		{"fieldname": "hours", "label": "Opening hours (JSON)", "fieldtype": "Small Text", "insert_after": "timezone", "description": '{"mon":"9:00-22:00", …} or {"default":"9:00-24:00","fri":"9:00-24:00"}'},
		{"fieldname": "state", "label": "State", "fieldtype": "Data", "insert_after": "hours"},
		{"fieldname": "zip", "label": "ZIP", "fieldtype": "Data", "insert_after": "state"},
	],
	"Loyalty Program": [
		{"fieldname": "maison_rewards_section", "label": "CloudChaserz Rewards", "fieldtype": "Section Break", "insert_after": "collection_rules"},
		{"fieldname": "maison_reward_tiers_note", "fieldtype": "HTML", "options": "<p>Fixed redemption tiers are <b>Maison Reward Tier</b> rows linked to this program ($5 off at 100 points, …).</p>", "insert_after": "maison_rewards_section"},
	],
}


DEPARTMENT_OPTIONS = ["", "Timepieces", "High Jewellery", "Bridal", "Accessories", "Services", "Vape", "Glass", "Hookah", "Kratom & CBD"]


def create_v06_custom_fields() -> None:
	fields = {dt: rows for dt, rows in CUSTOM_FIELDS.items() if frappe.db.exists("DocType", dt)}
	if fields:
		create_custom_fields(fields, ignore_validate=frappe.flags.in_install, update=True)
	# Item.maison_department (v0.1 fixture Select) gains the smoke-shop departments
	name = frappe.db.get_value("Custom Field", {"dt": "Item", "fieldname": "maison_department"}, "name")
	if name:
		current = frappe.db.get_value("Custom Field", name, "options") or ""
		have = [o for o in current.split("\n")]
		missing = [o for o in DEPARTMENT_OPTIONS if o not in have]
		if missing:
			frappe.db.set_value("Custom Field", name, "options", "\n".join(have + missing), update_modified=False)
			frappe.clear_cache(doctype="Item")


def ensure_v06_settings_defaults() -> None:
	"""Persist the defaults on the Single (Frappe does not apply defaults to an existing Single row)."""
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


def ensure_warehouse_admin_role() -> None:
	"""``Maison Warehouse Admin`` is owned by section P; create it here only if still absent so the
	v0.6 demo users can be seeded in any order."""
	if not frappe.db.exists("Role", "Maison Warehouse Admin"):
		frappe.get_doc({"doctype": "Role", "role_name": "Maison Warehouse Admin", "desk_access": 1, "is_custom": 1}).insert(ignore_permissions=True)


def ensure_rewards_role_perms() -> None:
	"""Maison roles may read the rewards / age doctypes (row scoping through queries)."""
	from frappe.permissions import add_permission, update_permission_property

	grants = {
		("Maison Age Check", "Maison Associate"): ("read", "create"),
		("Maison Age Check", "Maison Manager"): ("read", "create"),
		("Maison Giveaway Entry", "Maison Manager"): ("read",),
		("Maison Giveaway", "Maison Associate"): ("read",),
		("Maison Giveaway", "Maison Manager"): ("read",),
		("Maison Reward Tier", "Maison Associate"): ("read",),
		("Maison Reward Tier", "Maison Manager"): ("read",),
		("Maison Promotion Calendar", "Maison Manager"): ("read",),
	}
	for (doctype, role), ptypes in grants.items():
		if not (frappe.db.exists("DocType", doctype) and frappe.db.exists("Role", role)):
			continue
		if not frappe.db.exists("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}):
			add_permission(doctype, role, 0)
		for ptype in ptypes:
			if not frappe.db.get_value("Custom DocPerm", {"parent": doctype, "role": role, "permlevel": 0}, ptype):
				update_permission_property(doctype, role, 0, ptype, 1, validate=False)


def setup_v06() -> None:
	"""Entry point for after_install / after_migrate."""
	create_v06_custom_fields()
	ensure_v06_settings_defaults()
	try:
		ensure_warehouse_admin_role()
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison v0.6 warehouse admin role")
	try:
		ensure_rewards_role_perms()
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison v0.6 role perms")
