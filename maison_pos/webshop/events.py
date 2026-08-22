"""Sales Invoice hooks for web-order collection (registered in hooks.doc_events)."""

from __future__ import annotations

import frappe
from frappe.utils import flt

from maison_pos.webshop import core


def on_invoice_submit(doc, method: str | None = None) -> None:
	so = doc.get("maison_sales_order")
	if not so or doc.get("is_return"):
		return
	if not frappe.db.exists("Sales Order", so):
		return
	# ERPNext skips advance reconciliation for POS invoices (they are assumed fully tendered);
	# the online payment of a web order IS an advance → link it to this invoice now so the
	# Payment Entry moves from the Sales Order to the invoice and the outstanding drops to 0.
	if doc.get("is_pos") and doc.get("advances"):
		doc.update_against_document_in_jv()
		doc.reload()
		doc.set_status(update=True)
	core.mark_collected(so, doc.name)
	try:
		frappe.publish_realtime(
			"maison_web_order",
			{"name": so, "boutique": doc.get("maison_boutique"), "status": "Collected", "sales_invoice": doc.name, "grand_total": flt(doc.grand_total)},
			room="maison_dashboard",
		)
	except Exception:  # noqa: BLE001
		pass


def on_invoice_cancel(doc, method: str | None = None) -> None:
	so = doc.get("maison_sales_order")
	if not so or doc.get("is_return"):
		return
	if frappe.db.get_value("Sales Order", so, "maison_sales_invoice") == doc.name:
		core.unmark_collected(so)
