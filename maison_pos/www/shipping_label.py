"""Simulated 4×6 shipping label at ``/shipping-label/<tracking_no>`` (v0.6 P).

Real providers (Shippo / EasyPost) return a hosted PDF in ``label_url``; the simulated provider
points here so the wall's auto-print path (iframe → ``window.print()``) is exercised end-to-end.
Readable by anyone who may read the shipment.
"""

from __future__ import annotations

import frappe
from frappe import _

no_cache = 1


def get_context(context: dict) -> dict:
	tracking_no = frappe.form_dict.get("tracking_no")
	name = frappe.db.get_value("Maison Shipment", {"tracking_no": tracking_no}, "name") if tracking_no else None
	if not name:
		frappe.throw(_("Unknown tracking number"), frappe.DoesNotExistError)
	doc = frappe.get_doc("Maison Shipment", name)
	if not frappe.has_permission("Maison Shipment", "read", doc):
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	from maison_pos.api.shipping import code128_svg
	from maison_pos.shipping import ship_from_address, ship_to_address
	from maison_pos.utils import qr_svg_data_uri

	context.no_cache = 1
	context.no_breadcrumbs = 1
	context.title = f"Label {tracking_no}"
	context.doc = doc
	context.ship_from = ship_from_address()
	context.ship_to = ship_to_address(doc.boutique)
	context.barcode = code128_svg(tracking_no, height=70, module=3)
	context.qr = qr_svg_data_uri(f"MSH:{doc.name}", scale=3)
	context.parcels = doc.get_parcels() or doc.default_parcels()
	return context
