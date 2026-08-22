"""/shop/collection (and /all-products) — listing with filters."""

from __future__ import annotations

import frappe

from maison_pos.www.shop._common import base_context


def get_context(context):
	args = frappe.form_dict
	group = args.get("item_group") or None
	mode = args.get("mode") or None
	q = args.get("q") or None
	base_context(context, nav="collection", title=f"{group or 'All pieces'} — Maison")
	context.mw_group = group
	context.mode = mode
	context.q = q
	context.items = []
	context.groups = []
	if context.enabled:
		from maison_pos.api.webshop import catalogue

		data = catalogue(item_group=group, mode=mode, q=q, limit=96)
		context.items = data["items"]
		context.groups = data["item_groups"]
	context.modes = [("Buy", "Order & collect"), ("Reserve-with-deposit", "Reserve"), ("Enquire", "Enquire")]
