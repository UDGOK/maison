"""Public receipt page ``/r/<token>`` (website_route_rules -> ``r``).

Guest-accessible: the token is the only secret. Renders ``www/r.html`` in the
Monolith Gold style with the same payload as ``maison_pos.api.sales.receipt``.
"""

from __future__ import annotations

import frappe
from frappe import _

from maison_pos.api.sales import get_invoice_by_token
from maison_pos.utils import format_money, qr_svg_data_uri, receipt_payload, receipt_qr_enabled

no_cache = 1
sitemap = 0


def get_context(context: dict) -> dict:
	context.no_cache = 1
	context.no_breadcrumbs = 1
	context.show_sidebar = False
	token = frappe.form_dict.get("token") or ""
	try:
		doc = get_invoice_by_token(token)
		if not doc.get("is_pos"):
			raise frappe.DoesNotExistError
	except frappe.DoesNotExistError:
		context.http_status_code = 404
		context.title = _("Receipt not found")
		context.receipt = None
		return context

	receipt = receipt_payload(doc)
	context.title = f"Maison · {receipt['invoice']}"
	context.receipt = receipt
	context.qr = qr_svg_data_uri(receipt["url"], scale=5, dark="#C9A96E") if receipt_qr_enabled() and receipt.get("url") else ""
	context.money = lambda v: format_money(v, receipt["currency"])
	context.posting_label = frappe.utils.format_datetime(f"{doc.posting_date} {doc.posting_time}", "dd MMM yyyy HH:mm")
	return context
