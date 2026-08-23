"""Maison Replenishment Request (v0.6 O/P): a store asks the main warehouse for stock.

The request carries its own lines (requested / approved qty) and a draft ERPNext Material
Request (type *Material Transfer*) so demand is visible in stock planning. The workflow
``Maison Replenishment Approval`` moves it Pending Approval → Approved / Rejected; on Approved
``maison_pos.api.shipping.approve`` submits the Material Request and creates the
``Maison Shipment``.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime


class MaisonReplenishmentRequest(Document):
	def validate(self) -> None:
		if not self.lines:
			frappe.throw(_("At least one line is required"), frappe.ValidationError)
		seen: set[str] = set()
		for line in self.lines:
			if flt(line.qty) <= 0:
				frappe.throw(_("Quantity must be positive ({0})").format(line.item_code), frappe.ValidationError)
			if line.item_code in seen:
				frappe.throw(_("Item {0} appears twice").format(line.item_code), frappe.ValidationError)
			seen.add(line.item_code)
			if line.approved_qty is None:
				line.approved_qty = flt(line.qty)
		if not self.to_warehouse:
			self.to_warehouse = frappe.db.get_value("Maison Boutique", self.boutique, "warehouse")
		if not self.from_warehouse:
			from maison_pos.shipping import get_main_warehouse

			self.from_warehouse = get_main_warehouse(exclude=self.to_warehouse)
		if self.from_warehouse == self.to_warehouse:
			frappe.throw(_("Source and destination warehouse are the same"), frappe.ValidationError)
		if not self.requested_by:
			self.requested_by = frappe.session.user
		if not self.requested_at:
			self.requested_at = now_datetime()

	@property
	def units_requested(self) -> float:
		return sum(flt(line.qty) for line in self.lines)

	@property
	def units_approved(self) -> float:
		return sum(flt(line.approved_qty) for line in self.lines)
