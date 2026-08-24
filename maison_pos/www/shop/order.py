"""/shop/order?name=SAL-ORD-… — confirmation + status for the shopper."""

from __future__ import annotations

import frappe

from maison_pos.www.shop._common import base_context, require_login

no_cache = 1
sitemap = 0

STEPS = ["New", "Picking", "Ready", "Collected"]


def get_context(context):
	base_context(context, nav="account", title="Your order — AWANZ")
	require_login(context)
	name = frappe.form_dict.get("name")
	if not name or not frappe.db.exists("Sales Order", name):
		frappe.throw("Order not found", frappe.DoesNotExistError)
	from maison_pos.api.webshop import order

	context.order = order(name)
	context.placed = bool(frappe.form_dict.get("placed"))
	context.steps = STEPS
	status = context.order["status"]
	context.step_index = STEPS.index(status) if status in STEPS else -1
	b = frappe.db.get_value("AWANZ Store", context.order["boutique"], ["boutique_name", "address_line", "city", "phone", "email"], as_dict=True) or {}
	context.boutique = b
	pr = frappe.db.get_value(
		"Payment Request",
		{"reference_doctype": "Sales Order", "reference_name": name, "docstatus": 1, "status": ("in", ("Initiated", "Requested"))},
		["name", "grand_total", "payment_gateway"],
		as_dict=True,
	)
	context.open_payment = None
	if pr:
		from maison_pos.api.webshop import _payment_url

		try:
			context.open_payment = {"name": pr.name, "amount": pr.grand_total, "url": _payment_url(frappe.get_doc("Payment Request", pr.name))}
		except Exception:  # noqa: BLE001
			context.open_payment = None
