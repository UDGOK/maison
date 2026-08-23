"""/shop/boutiques — the boutiques (address, phone, hours)."""

from __future__ import annotations

from maison_pos.webshop import core
from maison_pos.www.shop._common import base_context

no_cache = 1


def get_context(context):
	from maison_pos.brand import get_brand  # v0.6 N

	brand = get_brand()
	base_context(context, nav="boutiques", title=f"{brand['store_noun']}s — {brand['brand_name']}")
	context.boutiques = core.boutiques()
