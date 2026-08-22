"""Sales Invoice document events (registered in hooks.doc_events)."""

from __future__ import annotations

import frappe
from frappe import _

from maison_pos.utils import publish_sale, touch_last_seen


def validate(doc, method: str | None = None) -> None:
	"""Guard POS invoices: boutique must be enabled and offline uuid unique."""
	if not doc.get("is_pos"):
		return

	if doc.get("maison_boutique"):
		enabled = frappe.db.get_value("Maison Boutique", doc.maison_boutique, "enabled")
		if enabled is None:
			frappe.throw(_("Boutique {0} does not exist").format(doc.maison_boutique), frappe.ValidationError)
		if not enabled:
			frappe.throw(_("Boutique {0} is disabled").format(doc.maison_boutique), frappe.ValidationError)

	if doc.get("maison_offline_uuid"):
		dup = frappe.db.get_value(
			"Sales Invoice",
			{"maison_offline_uuid": doc.maison_offline_uuid, "name": ("!=", doc.name), "docstatus": ("<", 2)},
			"name",
		)
		if dup:
			frappe.throw(
				_("Offline UUID {0} already used by {1}").format(doc.maison_offline_uuid, dup),
				frappe.DuplicateEntryError,
			)


def on_submit(doc, method: str | None = None) -> None:
	"""Publish the sale to the live wall and refresh device last_seen."""
	if not doc.get("is_pos"):
		return
	touch_last_seen(doc.get("maison_boutique"), doc.get("maison_device_id"))
	publish_sale(doc, "maison_sale")


def on_cancel(doc, method: str | None = None) -> None:
	"""Publish the cancellation so dashboard totals re-aggregate."""
	if not doc.get("is_pos"):
		return
	publish_sale(doc, "maison_sale_cancelled")
