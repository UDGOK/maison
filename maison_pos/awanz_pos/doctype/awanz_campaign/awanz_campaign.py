"""AWANZ Campaign — SPEC v0.5 §M campaign attribution."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint

DEFAULT_DIRECT_WINDOW_DAYS = 14
DEFAULT_ASSISTED_WINDOW_DAYS = 30


class AWANZCampaign(Document):
	def validate(self) -> None:
		self.campaign_code = (self.campaign_code or "").strip()
		if not self.campaign_code:
			frappe.throw(_("Campaign code is required"), frappe.ValidationError)
		if " " in self.campaign_code:
			frappe.throw(_("Campaign code must not contain spaces (it is used as utm_campaign)"), frappe.ValidationError)
		self.direct_window_days = cint(self.direct_window_days) or DEFAULT_DIRECT_WINDOW_DAYS
		self.assisted_window_days = cint(self.assisted_window_days) or DEFAULT_ASSISTED_WINDOW_DAYS
		if self.direct_window_days < 1 or self.assisted_window_days < self.direct_window_days:
			frappe.throw(_("Assisted window must be at least the last-touch window (both ≥ 1 day)"), frappe.ValidationError)
		seen: set[str] = set()
		for row in list(self.featured_items or []):
			if row.item_code in seen:
				self.remove(row)
			seen.add(row.item_code)

	def featured_item_codes(self) -> set[str]:
		return {r.item_code for r in (self.featured_items or []) if r.item_code}
