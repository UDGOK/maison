"""/shop/account — Maison Collectors: loyalty sign-in (client number + e-mail) and balance."""

from __future__ import annotations

import frappe

from maison_pos.www.shop._common import base_context

no_cache = 1
sitemap = 0


def get_context(context):
	base_context(context, nav="account", title="Maison Collectors — Maison")
	context.loyalty = None
	context.signed_in = frappe.session.user != "Guest"
	if context.signed_in:
		from maison_pos.api.webshop import loyalty_lookup, my_orders

		try:
			context.loyalty = loyalty_lookup()
		except Exception:  # noqa: BLE001
			context.loyalty = None
		context.orders = my_orders()[:5] if context.enabled else []
	else:
		context.orders = []
