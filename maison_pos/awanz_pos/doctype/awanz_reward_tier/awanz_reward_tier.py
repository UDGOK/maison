"""AWANZ Reward Tier (v0.6 Q) — a fixed redemption step of the rewards program
($5 off at 100 points, $10 at 200, $15 at 300)."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt


class AWANZRewardTier(Document):
	def validate(self) -> None:
		if cint(self.points) <= 0:
			frappe.throw(_("Points required must be positive"), frappe.ValidationError)
		if flt(self.amount) <= 0:
			frappe.throw(_("Discount amount must be positive"), frappe.ValidationError)
		if not self.title:
			self.title = f"${flt(self.amount):g} off at {cint(self.points)} points"
		dup = frappe.db.get_value(
			"AWANZ Reward Tier",
			{"loyalty_program": self.loyalty_program, "points": cint(self.points), "name": ("!=", self.name or "")},
			"name",
		)
		if dup:
			frappe.throw(_("A tier at {0} points already exists for this program ({1})").format(self.points, dup), frappe.ValidationError)
