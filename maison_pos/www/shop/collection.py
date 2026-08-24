"""/shop/collection (and /all-products) — listing with filters."""

from __future__ import annotations

from urllib.parse import urlencode

import frappe
from frappe.utils import cint

from maison_pos.www.shop._common import base_context


PAGE_SIZE = 96  # v0.8 QA A4


def get_context(context):
	args = frappe.form_dict
	group = args.get("item_group") or None
	mode = args.get("mode") or None
	q = args.get("q") or None
	# --- v0.8 QA A4 — the listing pages instead of silently stopping at the first 96 ---
	start = max(0, cint(args.get("start")))
	base_context(context, nav="collection", title=f"{group or 'All pieces'} — AWANZ")
	context.mw_group = group
	context.mode = mode
	context.q = q
	context.items = []
	context.groups = []
	context.start = start
	context.page_size = PAGE_SIZE
	context.total = 0
	context.has_more = False
	shown = 0
	if context.enabled:
		from maison_pos.api.webshop import catalogue

		data = catalogue(item_group=group, mode=mode, q=q, start=start, limit=PAGE_SIZE)
		context.items = data["items"]
		context.groups = data["item_groups"]
		shown = len(data["items"])
		context.total = data.get("total") or shown
		context.has_more = bool(data.get("has_more"))
	# the query string of this listing, without `start` — the Previous / Next links re-add it
	params = []
	if group:
		params.append(("item_group", group))
	if mode:
		params.append(("mode", mode))
	if q:
		params.append(("q", q))
	context.base_query = urlencode(params)
	# NB: `context.items` is the dict's own `items()` method — read the count separately
	context.page_from = start + 1 if shown else 0
	context.page_to = start + shown
	# --- end v0.8 QA A4 ---
	context.modes = [("Buy", "Order & collect"), ("Reserve-with-deposit", "Reserve"), ("Enquire", "Enquire")]
