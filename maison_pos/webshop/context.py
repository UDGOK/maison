"""Jinja helpers for the storefront templates (registered in hooks.jinja.methods)."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import cint, flt, fmt_money

from maison_pos.utils import tighten_currency_symbol  # v0.6 R
from maison_pos.webshop import core, is_webshop_installed


def shop_money(value: Any, currency: str | None = None) -> str:
	"""``$6,900`` without cents for whole amounts (luxury price style), cents otherwise.

	v0.6 R — the space ``fmt_money`` puts after a symbol prefix ("$ 69.99") is closed by
	``maison_pos.utils.tighten_currency_symbol``; it read as a typo on every price on the storefront.
	"""
	value = flt(value)
	currency = currency or "USD"
	precision = 0 if abs(value - round(value)) < 0.005 else 2
	return tighten_currency_symbol(fmt_money(value, currency=currency, precision=precision))


def shop_store_name(store_name: Any, brand_name: Any = None) -> str:
	"""v0.6 R — a store's display name without the brand prefix every store repeats.

	"CloudChaserz Broken Arrow · Broken Arrow" in a four-column footer wrapped with "Arrow" alone on
	the next line; the brand word it spent that width on is on the same page four times already.
	Returns "Broken Arrow". Falls back to the full name when the prefix is all there is.
	"""
	name = str(store_name or "").strip()
	brand = str(brand_name or "").strip()
	if not brand:
		from maison_pos.brand import brand_name as _brand_name

		brand = _brand_name()
	if not name or not brand or not name.lower().startswith(brand.lower()):
		return name
	rest = name[len(brand) :].lstrip(" \u2014\u2013-").strip()
	return rest or name


def shop_context() -> dict[str, Any]:
	"""Header/footer context: cart count, sign-in state, boutiques, feature flags."""
	user = frappe.session.user
	signed_in = user and user != "Guest"
	if signed_in:
		# base.html injects frappe.csrf_token from the session; make sure one exists (API logins have none yet)
		try:
			frappe.sessions.get_csrf_token()
		except Exception:  # noqa: BLE001
			pass
	cart_count = 0
	enabled = False
	if is_webshop_installed():
		enabled = bool(frappe.db.get_single_value("Webshop Settings", "enabled"))
		if signed_in and enabled:
			try:
				cart_count = cint(frappe.request.cookies.get("cart_count")) if getattr(frappe, "request", None) else 0
			except Exception:  # noqa: BLE001
				cart_count = 0
			if not cart_count:
				try:
					from webshop.webshop.shopping_cart.cart import get_party

					party = get_party(user)
					if party:
						q = frappe.db.get_value(
							"Quotation",
							{"party_name": party.name, "order_type": "Shopping Cart", "docstatus": 0},
							"name",
						)
						if q:
							cart_count = cint(frappe.db.count("Quotation Item", {"parent": q}))
				except Exception:  # noqa: BLE001
					cart_count = 0
	full_name = frappe.db.get_value("User", user, "full_name") if signed_in else ""
	# --- v0.6 N — brand tokens for the storefront shell ---
	from maison_pos.brand import get_brand, get_rewards_settings

	brand = get_brand()
	rewards_name = get_rewards_settings()["rewards_program_name"]
	# --- end v0.6 N ---
	return {
		"brand": brand,
		"brand_name": brand["brand_name"],
		"wordmark": brand["wordmark_text"],
		"tagline": brand["tagline"],
		"store_noun": brand["store_noun"],
		"rewards_name": rewards_name,
		"vertical": brand["vertical"],
		"enabled": enabled,
		"signed_in": bool(signed_in),
		"user": user if signed_in else None,
		"full_name": full_name or "",
		"cart_count": cart_count,
		"boutiques": core.boutiques() if frappe.db.exists("DocType", "Maison Boutique") else [],
		"groups": frappe.get_all(
			"Item Group", filters={"show_in_website": 1, "is_group": 0}, fields=["name", "route"], order_by="weightage desc, name asc"
		)
		if enabled
		else [],
	}
