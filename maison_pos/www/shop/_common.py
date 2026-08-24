"""Shared context helpers for the storefront pages (not a page itself)."""

from __future__ import annotations

import frappe

from maison_pos.webshop import is_webshop_installed


def base_context(context, nav: str = "", title: str = "AWANZ") -> None:
	# --- v0.6 N — "… — AWANZ" titles take the brand from the settings ---
	from maison_pos.brand import get_brand, get_rewards_settings

	brand = get_brand()
	if title == "AWANZ":
		title = brand["brand_name"]
	title = title.replace("AWANZ Collectors", get_rewards_settings()["rewards_program_name"]).replace("— AWANZ", f"— {brand['brand_name']}")
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
	"""Send a guest to the storefront's own sign-in wall (v0.8 QA A1).

	It used to be Frappe's ``/login``, which on a site with sign-up disabled (and no outgoing
	e-mail account to verify a sign-up with) is a dead end for a new customer: the bag and the
	checkout are both behind this, so the whole shop was browse-only. ``/shop/register`` offers
	both halves — create an account, or sign in — and carries ``redirect-to`` through either.
	"""
	if frappe.session.user == "Guest":
		target = frappe.local.request.path + ("?" + frappe.local.request.query_string.decode() if frappe.local.request.query_string else "")
		frappe.local.flags.redirect_location = "/shop/register?redirect-to=" + frappe.utils.quote(target)
		raise frappe.Redirect
	return True
