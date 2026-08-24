"""/cart (route rule) and /shop/cart — the bag."""

from __future__ import annotations

import frappe

from maison_pos.www.shop._common import base_context, require_login

no_cache = 1
sitemap = 0


def get_context(context):
	base_context(context, nav="cart", title="Your bag — AWANZ")
	context.cart = None
	if not context.enabled:
		return
	require_login(context)
	from maison_pos.api.webshop import cart

	context.cart = cart()
