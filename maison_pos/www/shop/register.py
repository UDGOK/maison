"""/shop/register — v0.8 QA A1: the storefront's own sign-in wall.

A guest who taps the bag or the checkout lands here: create an account (one form, no e-mail
round-trip — see ``maison_pos.api.webshop.register``) or sign in with the account they already
have. ``redirect-to`` carries them back to what they were doing.
"""

from __future__ import annotations

import frappe

from maison_pos.www.shop._common import base_context

no_cache = 1
sitemap = 0


def _safe_redirect(value: str | None) -> str:
	value = (value or "").strip()
	if not value.startswith("/") or value.startswith("//"):
		return "/shop/account"
	return value


def get_context(context):
	base_context(context, nav="account", title="Create an account — Maison")
	context.redirect_to = _safe_redirect(frappe.form_dict.get("redirect-to") or frappe.form_dict.get("redirect_to"))
	context.signed_in = frappe.session.user != "Guest"
	context.signup_enabled = not frappe.utils.cint(frappe.db.get_single_value("Website Settings", "disable_signup"))
	context.csrf_token = frappe.sessions.get_csrf_token() if context.signed_in else ""
	context.login_url = "/login?redirect-to=" + frappe.utils.quote(context.redirect_to)
	return context
