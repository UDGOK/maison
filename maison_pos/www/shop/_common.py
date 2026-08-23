"""Shared context helpers for the storefront pages (not a page itself)."""

from __future__ import annotations

import frappe

from maison_pos.webshop import is_webshop_installed


def base_context(context, nav: str = "", title: str = "Maison") -> None:
	# --- v0.6 N — "… — Maison" titles take the brand from the settings ---
	from maison_pos.brand import get_brand, get_rewards_settings

	brand = get_brand()
	if title == "Maison":
		title = brand["brand_name"]
	title = title.replace("Maison Collectors", get_rewards_settings()["rewards_program_name"]).replace("— Maison", f"— {brand['brand_name']}")
	if brand["vertical"] != "Jewellery":
		title = title.replace("All pieces", "All products")
	# --- end v0.6 N ---
	context.no_cache = 1
	context.body_class = "mw-shop"
	context.mw_nav = nav
	context.title = title
	context.show_sidebar = False
	context.webshop_installed = is_webshop_installed()
	context.enabled = bool(is_webshop_installed() and frappe.db.get_single_value("Webshop Settings", "enabled"))


def require_login(context) -> bool:
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=" + frappe.utils.quote(frappe.local.request.path + ("?" + frappe.local.request.query_string.decode() if frappe.local.request.query_string else ""))
		raise frappe.Redirect
	return True
