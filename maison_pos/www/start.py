"""Branded launcher at ``/start`` — the one URL staff need to remember.

The framework sends every System User to ``/app`` after login, so an associate who signs in
lands on the admin desk rather than the till. This page lists exactly the screens
the signed-in user may open, driven by their AWANZ roles, in the tenant's brand.
Guests get the sign-in prompt instead of a dead end.
"""

from __future__ import annotations

import frappe
from frappe import _

no_cache = 1


# (route, title, blurb, roles that may see it — empty = everyone signed in)
SCREENS: list[tuple[str, str, str, tuple[str, ...]]] = [
	("/pos", "Point of sale", "Ring sales, returns, receiving and cycle counts on the till.",
		("AWANZ Associate", "AWANZ Manager", "AWANZ Regional", "AWANZ Head Office", "System Manager")),
	("/awanz-dashboard", "Command dashboard", "Live sales across every store, products, clients and insights.",
		("AWANZ Regional", "AWANZ Head Office", "System Manager")),
	("/warehouse", "Warehouse desk", "Approve store replenishment, pick, buy labels and ship.",
		("AWANZ Warehouse Admin", "AWANZ Head Office", "System Manager")),
	("/warehouse-wall", "Shipping wall", "The 55-inch board for the packing floor.",
		("AWANZ Warehouse Admin", "AWANZ Head Office", "System Manager")),
	("/salon", "Client display", "The customer-facing second screen. Pair it from the till.", ()),
	("/shop", "Online store", "The public storefront with click and collect.", ()),
	("/rewards", "Rewards", "The public rewards programme page.", ()),
	("/app", "Admin desk", "Accounting, stock, reports and settings for head office.",
		("AWANZ Head Office", "System Manager")),
]


def get_context(context):
	context.no_cache = 1
	context.no_breadcrumbs = 1

	try:
		from maison_pos.brand import get_brand

		brand = get_brand() or {}
	except Exception:
		brand = {}
	context.wordmark = brand.get("wordmark_text") or "AWANZ"
	context.product_name = brand.get("product_name") or "AWANZ POS"
	context.tagline = brand.get("tagline") or ""
	context.developer_name = brand.get("developer_name") or ""
	context.developer_website = brand.get("developer_website") or ""

	context.is_guest = frappe.session.user == "Guest"
	context.user_name = "" if context.is_guest else (frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user)

	roles = set(frappe.get_roles())
	screens = []
	for route, title, blurb, allowed in SCREENS:
		if context.is_guest:
			# only the two public pages are worth offering to a signed-out visitor
			if route not in ("/shop", "/rewards"):
				continue
		elif allowed and not roles.intersection(allowed):
			continue
		screens.append({"route": route, "title": _(title), "blurb": _(blurb)})
	context.screens = screens

	# the store this user works in, so the launcher confirms who they are
	context.store = ""
	if not context.is_guest and frappe.db.exists("DocType", "AWANZ Associate"):
		row = frappe.get_all(
			"AWANZ Associate",
			filters={"user": frappe.session.user},
			fields=["boutique"],
			limit=1,
		)
		if row and row[0].boutique:
			context.store = frappe.db.get_value("AWANZ Store", row[0].boutique, "boutique_name") or row[0].boutique
	return context
