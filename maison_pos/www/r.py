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
		from maison_pos.utils import get_brand_context

		context.brand = get_brand_context()
		return context

	receipt = receipt_payload(doc)
	context.brand = receipt.get("brand") or {}
	context.title = f"{context.brand.get('brand_name', 'AWANZ')} · {receipt['invoice']}"
	context.receipt = receipt
	context.qr = qr_svg_data_uri(receipt["url"], scale=5, dark="#C9A96E") if receipt_qr_enabled() and receipt.get("url") else ""
	context.money = lambda v: format_money(v, receipt["currency"])
	context.posting_label = frappe.utils.format_datetime(f"{doc.posting_date} {doc.posting_time}", "dd MMM yyyy HH:mm")
	# v0.4 I — private feedback form + points statement (client number stays masked; no names)
	context.feedback = _feedback_context(doc, token)
	context.loyalty = _loyalty_statement(doc)
	context.coupon = {"code": doc.get("maison_coupon"), "discount": doc.get("maison_coupon_discount")} if doc.get("maison_coupon") else None
	return context


def _feedback_context(doc, token: str) -> dict:
	from maison_pos.api.feedback import feedback_enabled

	enabled = bool(feedback_enabled() and doc.docstatus == 1 and not doc.get("is_return"))
	return {
		"enabled": enabled,
		"submitted": bool(enabled and frappe.db.exists("AWANZ Feedback", {"sales_invoice": doc.name})),
		"token": token,
	}


def _loyalty_statement(doc) -> dict | None:
	"""Tier / progress / expiring points for the client on the invoice (tier + numbers only)."""
	if not doc.customer or doc.get("is_return"):
		return None
	try:
		if frappe.db.get_value("POS Profile", doc.pos_profile, "customer") == doc.customer:
			return None  # walk-in
		from maison_pos.api.promotions import tier_progress

		lp = tier_progress(doc.customer, doc.company)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "awanz receipt loyalty statement")
		return None
	if not lp.get("program"):
		return None
	return {
		"tier": lp.get("tier"),
		"next_tier": lp.get("next_tier"),
		"to_next_tier": lp.get("to_next_tier"),
		"progress_pct": int(round(float(lp.get("progress") or 0) * 100)),
		"points": lp.get("points"),
		"points_value": lp.get("points_value"),
		"points_expiring_90d": lp.get("points_expiring_90d"),
		"expiry_duration_days": lp.get("expiry_duration_days"),
	}
