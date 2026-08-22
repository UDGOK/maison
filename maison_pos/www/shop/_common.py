"""Shared context helpers for the storefront pages (not a page itself)."""

from __future__ import annotations

import frappe

from maison_pos.webshop import is_webshop_installed


def base_context(context, nav: str = "", title: str = "Maison") -> None:
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
