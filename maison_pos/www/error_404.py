"""v0.7 white-label — brand tokens for the branded 404 page (``www/404.html``).

Frappe renders its own ``404`` template with a framework illustration; ours shadows it and reads
every string from ``AWANZ POS Settings`` so the tenant's name is what a lost visitor sees.
"""

from __future__ import annotations

import frappe
from frappe import _

no_cache = 1
sitemap = 0


def get_context(context):
	from maison_pos.brand import get_brand

	brand = get_brand()
	context.no_cache = 1
	context.no_breadcrumbs = 1
	context.no_header = 1
	context.brand = brand
	context.brand_name = brand["brand_name"]
	context.wordmark = brand.get("wordmark_text") or brand["brand_name"]
	context.support_email = brand.get("support_email")
	context.title = _("Page not found")
	context.links = [
		{"route": "/shop", "label": _("Online store")},
		{"route": "/rewards", "label": brand.get("rewards_program_name") or _("Rewards")},
	]
	return context
