"""/shop — storefront home."""

from __future__ import annotations

import frappe

from maison_pos.webshop import core
from maison_pos.www.shop._common import base_context


def get_context(context):
	from maison_pos.brand import get_brand  # v0.6 N

	brand = get_brand()
	base_context(context, nav="home", title=f"{brand['brand_name']} — {brand['tagline']}")
	context.featured = []
	context.groups = []
	context.hero = None
	if context.enabled:
		from maison_pos.api.webshop import catalogue

		data = catalogue(limit=60)
		items = data["items"]
		featured = sorted(items, key=lambda p: -(p.get("rate") or 0))
		context.featured = [p for p in items][:8]
		context.hero = next((p for p in items if p["item_code"] in ("TP-002", "DEV-003")), None) or (featured[0] if featured else None)
		context.groups = data["item_groups"]
		by_group = {}
		for p in items:
			by_group.setdefault(p["item_group"], []).append(p)
		context.group_cards = [
			{"name": g.name, "count": len(by_group.get(g.name, [])), "image": (by_group.get(g.name) or [{}])[0].get("image")}
			for g in data["item_groups"]
		]
	context.boutiques = core.boutiques()
