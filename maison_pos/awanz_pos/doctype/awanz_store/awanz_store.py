"""AWANZ Store: one row per store, linking Warehouse + Cost Center + POS Profile."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document


class AWANZStore(Document):
	def validate(self) -> None:
		self.boutique_code = (self.boutique_code or "").strip().upper()
		self._validate_company_links()

	def _validate_company_links(self) -> None:
		"""Warehouse, cost center and POS profile must belong to the boutique's company."""
		checks = (
			("Warehouse", self.warehouse),
			("Cost Center", self.cost_center),
			("POS Profile", self.pos_profile),
		)
		for doctype, value in checks:
			if not value:
				continue
			company = frappe.db.get_value(doctype, value, "company")
			if company and company != self.company:
				frappe.throw(
					_("{0} {1} belongs to company {2}, not {3}").format(doctype, value, company, self.company),
					frappe.ValidationError,
				)

	def get_receipt_address(self) -> str:
		"""Single-line address used by the receipt footer."""
		return ", ".join(p for p in (self.address_line, self.city) if p)

	def get_tax_template(self) -> str | None:
		"""Explicit template, else the one on the POS Profile."""
		if self.tax_template:
			return self.tax_template
		return frappe.db.get_value("POS Profile", self.pos_profile, "taxes_and_charges")


def get_boutique_for_warehouse(warehouse: str) -> str | None:
	"""Reverse lookup helper used when only the warehouse is known."""
	return frappe.db.get_value("AWANZ Store", {"warehouse": warehouse}, "name")
