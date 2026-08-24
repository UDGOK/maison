"""/shop/checkout — boutique choice + payment choice → Sales Order."""

from __future__ import annotations

import frappe

from maison_pos.www.shop._common import base_context, require_login

no_cache = 1
sitemap = 0


def get_context(context):
	base_context(context, nav="cart", title="Checkout — AWANZ")
	context.cart = None
	if not context.enabled:
		return
	require_login(context)
	from maison_pos.api.webshop import cart

	context.cart = cart()
	if not context.cart["items"]:
		frappe.local.flags.redirect_location = "/cart"
		raise frappe.Redirect
