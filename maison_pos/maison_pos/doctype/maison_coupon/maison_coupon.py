"""Maison Coupon (v0.4) — promo codes redeemed at the POS.

Validation for a basket lives in ``maison_pos.api.promotions.validate_coupon`` so the
same rules run for the POS preview and for the invoice on submit.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt, getdate


class MaisonCoupon(Document):
	def autoname(self) -> None:
		self.code = normalize_code(self.code)
		self.name = self.code

	def validate(self) -> None:
		self.code = normalize_code(self.code)
		if not self.code:
			frappe.throw(_("Coupon code is required"), frappe.ValidationError)
		if self.discount_type == "Percent" and not (0 < flt(self.value) <= 100):
			frappe.throw(_("Percent value must be between 0 and 100"), frappe.ValidationError)
		if self.discount_type == "Amount" and flt(self.value) <= 0:
			frappe.throw(_("Amount must be positive"), frappe.ValidationError)
		if self.usage == "Single-use":
			self.max_uses = 1
		if self.valid_from and self.valid_upto and getdate(self.valid_from) > getdate(self.valid_upto):
			frappe.throw(_("Valid From must be before Valid Upto"), frappe.ValidationError)
		if cint(self.max_uses) < 0:
			self.max_uses = 0


def normalize_code(code: str | None) -> str:
	"""Upper-case, trimmed, no internal whitespace."""
	return "".join((code or "").split()).upper()
