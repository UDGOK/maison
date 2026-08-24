"""v0.6 N — brand tokens read from ``AWANZ POS Settings``.

Internal names stay ``AWANZ *``; every user-facing string (wordmark, product name, receipt
header, Salon welcome, e-mails, the shop header) reads the brand from here. Cached per request.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe.utils import cint, flt

from maison_pos.setup.install_v06 import AGE_DEFAULTS, BRAND_DEFAULTS, REWARDS_DEFAULTS, VERTICALS

BRAND_KEYS = tuple(BRAND_DEFAULTS) + ("brand_logo", "head_office_boutique", "main_warehouse")
AGE_KEYS = tuple(AGE_DEFAULTS)
REWARDS_KEYS = tuple(REWARDS_DEFAULTS)


def _stored() -> dict[str, Any]:
	key = "awanz_brand_settings"
	cached = getattr(frappe.local, key, None)
	if cached is not None:
		return cached
	stored: dict[str, Any] = {}
	if frappe.db.exists("DocType", "AWANZ POS Settings"):
		try:
			stored = frappe.db.get_singles_dict("AWANZ POS Settings", cast=True) or {}
		except Exception:
			stored = {}
	setattr(frappe.local, key, stored)
	return stored


def clear_brand_cache() -> None:
	if hasattr(frappe.local, "awanz_brand_settings"):
		delattr(frappe.local, "awanz_brand_settings")


def _value(stored: dict[str, Any], key: str, default: Any) -> Any:
	value = stored.get(key)
	return default if value in (None, "") else value


def get_brand() -> dict[str, Any]:
	"""``brand{...}`` as returned by ``catalog.bootstrap`` and used by every template."""
	stored = _stored()
	out: dict[str, Any] = {k: _value(stored, k, v) for k, v in BRAND_DEFAULTS.items()}
	if out["vertical"] not in VERTICALS:
		out["vertical"] = BRAND_DEFAULTS["vertical"]
	logo = stored.get("brand_logo")
	out["brand_logo"] = frappe.utils.get_url(logo) if logo and str(logo).startswith("/") else (logo or None)
	out["head_office_boutique"] = stored.get("head_office_boutique") or None
	out["main_warehouse"] = stored.get("main_warehouse") or None
	out["store_noun"] = "Store" if out["vertical"] != "Jewellery" else "Boutique"
	out["rewards_program_name"] = _value(stored, "rewards_program_name", REWARDS_DEFAULTS["rewards_program_name"])
	return out


def get_age_settings() -> dict[str, Any]:
	stored = _stored()
	return {
		"age_verification_required": cint(_value(stored, "age_verification_required", AGE_DEFAULTS["age_verification_required"])),
		"minimum_age": cint(_value(stored, "minimum_age", AGE_DEFAULTS["minimum_age"])) or AGE_DEFAULTS["minimum_age"],
		"id_scan_enabled": cint(_value(stored, "id_scan_enabled", AGE_DEFAULTS["id_scan_enabled"])),
		"webshop_age_restricted_sales": cint(_value(stored, "webshop_age_restricted_sales", 0)),
	}


def get_rewards_settings() -> dict[str, Any]:
	stored = _stored()
	return {
		"rewards_program_name": _value(stored, "rewards_program_name", REWARDS_DEFAULTS["rewards_program_name"]),
		"reward_allow_stacking": cint(_value(stored, "reward_allow_stacking", 0)),
		"birthday_coupon_enabled": cint(_value(stored, "birthday_coupon_enabled", 1)),
		"birthday_coupon_type": _value(stored, "birthday_coupon_type", "Percent"),
		"birthday_coupon_value": flt(_value(stored, "birthday_coupon_value", REWARDS_DEFAULTS["birthday_coupon_value"])),
		"birthday_coupon_lead_days": cint(_value(stored, "birthday_coupon_lead_days", 7)),
		"birthday_coupon_valid_days": cint(_value(stored, "birthday_coupon_valid_days", 30)),
		"new_arrivals_days": cint(_value(stored, "new_arrivals_days", 14)),
		"giveaway_entries_per_amount": flt(_value(stored, "giveaway_entries_per_amount", 25)),
	}


def brand_name() -> str:
	return str(get_brand()["brand_name"])


def product_name() -> str:
	return str(get_brand()["product_name"])


def vertical() -> str:
	return str(get_brand()["vertical"])


def welcome_line(boutique_name: Optional[str] = None) -> str:
	"""Salon ambient: "Welcome to CloudChaserz Montrose"."""
	b = get_brand()
	store = (boutique_name or "").strip()
	if store and store.lower().startswith(str(b["brand_name"]).lower()):
		return f"Welcome to {store}"
	return f"Welcome to {b['brand_name']} {store}".strip()


def item_attribute_fields(vert: Optional[str] = None) -> list[str]:
	"""Which ``maison_*`` custom fields (internal fieldnames, kept — see docs/white-label.md)
	the POS / shop show as product attributes for a vertical."""
	v = vert or vertical()
	if v == "Smoke Shop":
		return ["maison_brand", "maison_flavor", "maison_nicotine_mg", "maison_volume_ml", "maison_puffs", "maison_age_restricted", "maison_msrp"]
	if v == "Jewellery":
		return ["maison_metal", "maison_carat", "maison_stones", "maison_certificate_no", "maison_appraisal_value"]
	return ["maison_brand", "maison_msrp", "maison_age_restricted"]
