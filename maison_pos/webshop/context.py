"""Jinja helpers for the storefront templates (registered in hooks.jinja.methods)."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import cint, flt, fmt_money

from maison_pos.webshop import core, is_webshop_installed


def shop_money(value: Any, currency: str | None = None) -> str:
	"""``$ 6,900`` without cents for whole amounts (luxury price style), cents otherwise."""
	value = flt(value)
	currency = currency or "USD"
	if abs(value - round(value)) < 0.005:
		return fmt_money(value, currency=currency, precision=0)
	return fmt_money(value, currency=currency, precision=2)


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
	return {
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
