"""Warehouse & shipping helpers (v0.6 P): main warehouse, in-transit warehouses, addresses, provider.

Feature detection: the v0.6 N seed marks the head-office warehouse with ``Maison Boutique.is_warehouse``
and ``Maison POS Settings.main_warehouse`` / ``head_office_boutique``; on an older seed neither field
exists and the first enabled boutique's warehouse acts as the source.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint

WAREHOUSE_ADMIN_ROLE = "Maison Warehouse Admin"
SETTINGS_FIELDS = {
	"shipping_provider": "Simulated",
	"ship_from_name": "CloudChaserz Main Warehouse",
	"ship_from_company": "CloudChaserz",
	"ship_from_street1": "2037 W Alabama St",
	"ship_from_street2": "",
	"ship_from_city": "Houston",
	"ship_from_state": "TX",
	"ship_from_zip": "77098",
	"ship_from_country": "US",
	"ship_from_phone": "(281) 974-3712",
	"ship_from_email": "warehouse@cloudchaserz.example",
	"wall_sound_enabled": 1,
	"wall_warn_hours": 4,
	"wall_crit_hours": 24,
	"auto_print_packing_list": 1,
	"auto_print_label": 1,
}


def _meta_has(doctype: str, fieldname: str) -> bool:
	try:
		return frappe.get_meta(doctype).has_field(fieldname)
	except Exception:
		return False


def settings() -> dict[str, Any]:
	"""Shipping-related settings with defaults for fields that do not exist yet."""
	stored: dict[str, Any] = {}
	try:
		stored = frappe.db.get_singles_dict("Maison POS Settings") or {}
	except Exception:
		stored = {}
	out = dict(SETTINGS_FIELDS)
	for key in SETTINGS_FIELDS:
		value = stored.get(key)
		if value not in (None, ""):
			out[key] = value
	for k in ("wall_sound_enabled", "wall_warn_hours", "wall_crit_hours", "auto_print_packing_list", "auto_print_label"):
		out[k] = cint(out[k])
	return out


def warehouse_boutique() -> Optional[str]:
	"""The ``Maison Boutique`` row that represents the main warehouse (``is_warehouse=1``), if any."""
	if _meta_has("Maison Boutique", "is_warehouse"):
		name = frappe.db.get_value("Maison Boutique", {"is_warehouse": 1, "enabled": 1}, "name")
		if name:
			return name
	if _meta_has("Maison POS Settings", "head_office_boutique"):
		name = frappe.db.get_single_value("Maison POS Settings", "head_office_boutique")
		if name and frappe.db.exists("Maison Boutique", name):
			return name
	return None


def get_main_warehouse(exclude: Optional[str] = None) -> str:
	"""Source warehouse for replenishment: settings ``main_warehouse`` → ``is_warehouse`` boutique → first boutique."""
	if _meta_has("Maison POS Settings", "main_warehouse"):
		wh = frappe.db.get_single_value("Maison POS Settings", "main_warehouse")
		if wh and frappe.db.exists("Warehouse", wh) and wh != exclude:
			return wh
	wb = warehouse_boutique()
	if wb:
		wh = frappe.db.get_value("Maison Boutique", wb, "warehouse")
		if wh and wh != exclude:
			return wh
	for wh in frappe.get_all("Maison Boutique", filters={"enabled": 1}, pluck="warehouse", order_by="name"):
		if wh and wh != exclude:
			return wh
	frappe.throw(_("No main warehouse configured (Maison POS Settings → main_warehouse)"), frappe.ValidationError)


def is_warehouse_boutique(boutique: str) -> bool:
	if not boutique or not _meta_has("Maison Boutique", "is_warehouse"):
		return False
	return bool(cint(frappe.db.get_value("Maison Boutique", boutique, "is_warehouse")))


def store_boutiques() -> list[str]:
	"""Enabled boutiques that are stores (the warehouse row excluded when the field exists)."""
	filters: dict[str, Any] = {"enabled": 1}
	if _meta_has("Maison Boutique", "is_warehouse"):
		filters["is_warehouse"] = 0
	return frappe.get_all("Maison Boutique", filters=filters, pluck="name", order_by="name")


def ensure_transit_warehouse(boutique: str) -> str:
	"""``<code> In Transit - <abbr>`` (Warehouse Type *Transit*), created on demand and remembered on the boutique."""
	b = frappe.db.get_value("Maison Boutique", boutique, ["name", "company", "warehouse", "transit_warehouse"], as_dict=True)
	if not b:
		frappe.throw(_("Boutique {0} does not exist").format(boutique), frappe.DoesNotExistError)
	if b.get("transit_warehouse") and frappe.db.exists("Warehouse", b.transit_warehouse):
		return b.transit_warehouse
	abbr = frappe.get_cached_value("Company", b.company, "abbr")
	name = f"{boutique} In Transit - {abbr}"
	if not frappe.db.exists("Warehouse", name):
		parent = frappe.db.get_value("Warehouse", b.warehouse, "parent_warehouse") or frappe.db.get_value("Warehouse", {"company": b.company, "is_group": 1, "parent_warehouse": ("in", ("", None))}, "name")
		doc = frappe.get_doc(
			{
				"doctype": "Warehouse",
				"warehouse_name": f"{boutique} In Transit",
				"company": b.company,
				"parent_warehouse": parent,
				"warehouse_type": "Transit" if frappe.db.exists("Warehouse Type", "Transit") else None,
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		name = doc.name
	if _meta_has("Maison Boutique", "transit_warehouse"):
		frappe.db.set_value("Maison Boutique", boutique, "transit_warehouse", name, update_modified=False)
		frappe.clear_document_cache("Maison Boutique", boutique)
	grant_transit_permissions(boutique, name)
	return name


def grant_transit_permissions(boutique: str, transit: str) -> int:
	"""The in-transit warehouse belongs to the store: every user with a Warehouse User Permission on the
	store warehouse also gets one on ``<store> In Transit`` (so the receipt Stock Entry is readable in the desk)."""
	store_wh = frappe.db.get_value("Maison Boutique", boutique, "warehouse")
	if not store_wh:
		return 0
	users = frappe.get_all("User Permission", filters={"allow": "Warehouse", "for_value": store_wh}, pluck="user")
	added = 0
	for user in set(users):
		if not frappe.db.exists("User Permission", {"user": user, "allow": "Warehouse", "for_value": transit}):
			doc = frappe.get_doc({"doctype": "User Permission", "user": user, "allow": "Warehouse", "for_value": transit, "apply_to_all_doctypes": 1})
			doc.flags.ignore_permissions = True
			doc.insert()
			added += 1
	return added


def ship_from_address() -> dict[str, Any]:
	s = settings()
	return {
		"name": s["ship_from_name"],
		"company": s["ship_from_company"],
		"street1": s["ship_from_street1"],
		"street2": s["ship_from_street2"],
		"city": s["ship_from_city"],
		"state": s["ship_from_state"],
		"zip": str(s["ship_from_zip"]),
		"country": s["ship_from_country"] or "US",
		"phone": s["ship_from_phone"],
		"email": s["ship_from_email"],
	}


def ship_to_address(boutique: str) -> dict[str, Any]:
	"""Store address from Maison Boutique (v0.6 ship-to fields with fallbacks to the v0.1 address line / city)."""
	doc = frappe.get_cached_doc("Maison Boutique", boutique)
	city = doc.get("city") or ""
	state = doc.get("ship_state") or doc.get("state") or ""
	postal = doc.get("ship_postal_code") or doc.get("postal_code") or doc.get("zip") or doc.get("pincode") or ""
	if (not state or not postal) and city:
		# "Houston TX 77098" / "Tulsa, OK 74133" style city lines
		parts = city.replace(",", " ").split()
		if len(parts) >= 3 and parts[-1].isdigit() and len(parts[-2]) == 2:
			state = state or parts[-2].upper()
			postal = postal or parts[-1]
			city = " ".join(parts[:-2])
	return {
		"name": doc.get("ship_contact_name") or doc.get("boutique_name") or boutique,
		"company": doc.get("boutique_name") or boutique,
		"street1": doc.get("address_line") or "",
		"street2": doc.get("ship_address_line2") or "",
		"city": city,
		"state": state,
		"zip": str(postal),
		"country": doc.get("ship_country") or doc.get("country") or "US",
		"phone": doc.get("phone") or "",
		"email": doc.get("email") or "",
	}


def provider_name() -> str:
	return str(settings().get("shipping_provider") or "Simulated").strip().lower()


def get_provider(name: Optional[str] = None):
	from maison_pos.shipping.providers import PROVIDERS, ShippingError

	key = (name or provider_name()).lower()
	cls = PROVIDERS.get(key)
	if not cls:
		raise ShippingError(f"Unknown shipping provider {key!r}")
	return cls()


def is_warehouse_admin(user: Optional[str] = None) -> bool:
	user = user or frappe.session.user
	if user == "Administrator":
		return True
	return WAREHOUSE_ADMIN_ROLE in frappe.get_roles(user)
