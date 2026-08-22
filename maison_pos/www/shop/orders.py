"""/shop/orders — the shopper's web orders."""

from __future__ import annotations

from maison_pos.www.shop._common import base_context, require_login

no_cache = 1
sitemap = 0


def get_context(context):
	base_context(context, nav="account", title="Your orders — Maison")
	require_login(context)
	from maison_pos.api.webshop import my_orders

	context.orders = my_orders()
