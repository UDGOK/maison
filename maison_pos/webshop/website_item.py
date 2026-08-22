"""``Website Item`` override: Monolith Gold product page + Maison context (web mode, availability).

Registered through ``override_doctype_class`` in hooks (only effective when ``webshop`` is
installed — otherwise the import of the base class fails and the hook is skipped by Frappe).
"""

from __future__ import annotations

import frappe
from frappe.utils import flt

try:  # pragma: no cover - import guard for sites without webshop
	from webshop.webshop.doctype.website_item.website_item import WebsiteItem as _Base
except Exception:  # noqa: BLE001
	from frappe.website.website_generator import WebsiteGenerator as _Base  # type: ignore

from maison_pos.webshop import core


class MaisonWebsiteItem(_Base):
	"""Same data model, Maison template + extra context."""

	website = frappe._dict(
		page_title_field="web_item_name",
		condition_field="published",
		template="maison_pos/templates/webshop/item.html",
		no_cache=1,
	)

	def make_thumbnail(self):
		"""SVG visuals (the demo seed) cannot be rasterised by Pillow: use them as their own thumbnail."""
		if (self.website_image or "").lower().endswith(".svg"):
			self.thumbnail = self.website_image
			return
		super().make_thumbnail()

	def get_context(self, context):
		context = super().get_context(context)
		context.update(maison_item_context(self, context))
		context.body_class = "mw-shop product-page"
		context.mw_nav = "collection"
		return context


def maison_item_context(doc, context=None) -> dict:
	"""Everything the Maison product page needs beyond webshop's own context."""
	item = frappe.db.get_value(
		"Item",
		doc.item_code,
		[
			"item_code",
			"item_name",
			"item_group",
			"has_serial_no",
			"is_stock_item",
			"maison_web_mode",
			"maison_deposit_percent",
			"maison_metal",
			"maison_carat",
			"maison_stones",
			"maison_certificate_no",
			"maison_department",
		],
		as_dict=True,
	) or frappe._dict()
	avail = core.availability(doc.item_code)
	chain_qty = sum(flt(a["qty"]) for a in avail)
	mode = core.effective_web_mode(item, chain_qty)

	rate = 0.0
	if context and context.get("shopping_cart"):
		price = (context.shopping_cart.get("product_info") or {}).get("price") or {}
		rate = flt(price.get("price_list_rate"))
	if not rate:
		price_list = frappe.db.get_single_value("Webshop Settings", "price_list") or "Standard Selling"
		rate = flt(frappe.db.get_value("Item Price", {"item_code": doc.item_code, "price_list": price_list}, "price_list_rate"))
	deposit = core.deposit_for(doc.item_code, rate) if mode == "Reserve-with-deposit" else 0.0

	return {
		"maison": frappe._dict(
			{
				"web_mode": mode,
				"availability": avail,
				"chain_qty": chain_qty,
				"one_off": bool(item.get("has_serial_no")) and chain_qty <= 1,
				"available_at": core.city_label(avail),
				"deposit": deposit,
				"deposit_percent": flt(item.get("maison_deposit_percent")) or core.DEFAULT_DEPOSIT_PERCENT,
				"metal": item.get("maison_metal"),
				"carat": flt(item.get("maison_carat")),
				"stones": item.get("maison_stones"),
				"certificate_no": item.get("maison_certificate_no"),
				"department": item.get("maison_department"),
				"boutiques": core.boutiques(),
				"rate": rate,
				"related": related_items(doc),
			}
		),
	}


def related_items(doc, limit: int = 4) -> list[dict]:
	"""Other published pieces of the same collection, for the "Also from …" strip."""
	rows = frappe.get_all(
		"Website Item",
		filters={"published": 1, "item_group": doc.item_group, "name": ("!=", doc.name)},
		fields=["name", "item_code", "web_item_name", "route", "website_image", "thumbnail", "item_group"],
		order_by="ranking desc, web_item_name asc",
		limit=limit,
	)
	from erpnext.utilities.product import get_price
	from webshop.webshop.doctype.webshop_settings.webshop_settings import get_shopping_cart_settings

	settings = get_shopping_cart_settings()
	out = []
	for r in rows:
		price = get_price(r.item_code, settings.price_list, settings.default_customer_group, settings.company) or {}
		out.append(
			{
				"item_code": r.item_code,
				"item_name": r.web_item_name,
				"route": "/" + r.route if r.route and not r.route.startswith("/") else r.route,
				"image": r.website_image or r.thumbnail,
				"item_group": r.item_group,
				"rate": flt(price.get("price_list_rate")),
				"currency": price.get("currency") or "USD",
			}
		)
	return out
