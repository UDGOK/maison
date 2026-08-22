"""Maison Stock Alert: one open row per (item, warehouse) below its reorder level."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class MaisonStockAlert(Document):
	def validate(self) -> None:
		if not self.boutique and self.warehouse:
			self.boutique = frappe.db.get_value("Maison Boutique", {"warehouse": self.warehouse}, "name")
		if not self.first_seen:
			self.first_seen = now_datetime()
		if self.status == "Open":
			dup = frappe.db.get_value(
				"Maison Stock Alert",
				{"item_code": self.item_code, "warehouse": self.warehouse, "status": ("in", ("Open", "Acknowledged")), "name": ("!=", self.name)},
				"name",
			)
			if dup:
				frappe.throw(_("An open alert already exists for {0} at {1}: {2}").format(self.item_code, self.warehouse, dup), frappe.DuplicateEntryError)
		if self.status == "Resolved" and not self.resolved_at:
			self.resolved_at = now_datetime()
