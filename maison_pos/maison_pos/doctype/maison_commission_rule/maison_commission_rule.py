"""Maison Commission Rule (v0.4): % of net line amount per boutique / role / item group / department."""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt, getdate


class MaisonCommissionRule(Document):
	def validate(self) -> None:
		if flt(self.rate_percent) < 0 or flt(self.rate_percent) > 100:
			frappe.throw(_("Commission % must be between 0 and 100"), frappe.ValidationError)
		if self.valid_from and self.valid_upto and getdate(self.valid_from) > getdate(self.valid_upto):
			frappe.throw(_("Valid From must be before Valid Upto"), frappe.ValidationError)
		if not self.role:
			self.role = "Any"


def active_rules(posting_date: Any = None) -> list[dict[str, Any]]:
	"""Enabled rules valid on *posting_date*, most specific / highest priority first."""
	date = getdate(posting_date) if posting_date else getdate()
	rows = frappe.get_all(
		"Maison Commission Rule",
		filters={"enabled": 1},
		fields=["name", "rate_percent", "priority", "boutique", "role", "item_group", "department", "valid_from", "valid_upto"],
	)
	out = []
	for r in rows:
		if r.valid_from and getdate(r.valid_from) > date:
			continue
		if r.valid_upto and getdate(r.valid_upto) < date:
			continue
		out.append(r)
	return out


def specificity(rule: dict[str, Any]) -> int:
	return sum(1 for k in ("boutique", "role", "item_group", "department") if rule.get(k) and rule.get(k) != "Any")


def match_rule(
	rules: list[dict[str, Any]], *, boutique: Optional[str], role: Optional[str], item_group: Optional[str], department: Optional[str]
) -> Optional[dict[str, Any]]:
	"""Pick the best rule for a line: all set scopes must match; highest priority, then most specific."""
	role_key = "Manager" if role in ("Manager", "Regional", "HeadOffice") else "Associate"
	candidates = []
	for r in rules:
		if r.get("boutique") and r["boutique"] != boutique:
			continue
		if r.get("role") and r["role"] != "Any" and r["role"] != role_key:
			continue
		if r.get("item_group") and r["item_group"] != item_group:
			continue
		if r.get("department") and r["department"] != department:
			continue
		candidates.append(r)
	if not candidates:
		return None
	candidates.sort(key=lambda r: (cint(r.get("priority")), specificity(r)), reverse=True)
	return candidates[0]
