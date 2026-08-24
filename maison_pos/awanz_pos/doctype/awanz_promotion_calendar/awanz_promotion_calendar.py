"""AWANZ Promotion Calendar (v0.6 Q) — one row per month: the Pricing Rules that run, the
featured items, and the campaign that is sent automatically on the 1st (``rewards.send_monthly_promotions``)."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class AWANZPromotionCalendar(Document):
	def autoname(self) -> None:
		self.month = getdate(self.month).replace(day=1)
		self.name = f"PROMO-{self.month.strftime('%Y-%m')}"

	def validate(self) -> None:
		self.month = getdate(self.month).replace(day=1)
		if not self.title:
			self.title = f"{self.month.strftime('%B %Y')} promotions"
		seen = set()
		for row in self.featured_items:
			if row.item_code in seen:
				frappe.throw(_("Item {0} is featured twice").format(row.item_code), frappe.ValidationError)
			seen.add(row.item_code)

	def month_window(self):
		"""(first day, last day) of the month."""
		from frappe.utils import add_months, add_days

		first = getdate(self.month).replace(day=1)
		return first, add_days(add_months(first, 1), -1)
