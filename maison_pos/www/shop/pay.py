"""/shop/pay?pr=… — simulated card payment page (used when no Stripe key is configured)."""

from __future__ import annotations

import frappe

from maison_pos.www.shop._common import base_context, require_login

no_cache = 1
sitemap = 0


def get_context(context):
	base_context(context, nav="cart", title="Payment — AWANZ")
	require_login(context)
	name = frappe.form_dict.get("pr")
	if not name or not frappe.db.exists("Payment Request", name):
		frappe.throw("Payment request not found", frappe.DoesNotExistError)
	pr = frappe.db.get_value("Payment Request", name, ["name", "grand_total", "currency", "status", "reference_name", "payment_gateway", "party_name"], as_dict=True)
	context.pr = pr
	context.order_name = pr.reference_name
	context.mode = frappe.db.get_value("Sales Order", pr.reference_name, "maison_web_mode")
