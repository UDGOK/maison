"""AWANZ Web Enquiry: "Enquire" requests from the webshop for one-of-a-kind pieces.

Lands in the POS "Web orders" queue of the chosen boutique (or Head Office when none).
"""

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class AWANZWebEnquiry(Document):
	def before_insert(self) -> None:
		if not self.enquiry_date:
			self.enquiry_date = now_datetime()
		if not self.user and frappe.session.user != "Guest":
			self.user = frappe.session.user

	def validate(self) -> None:
		if self.status in ("Contacted", "Closed") and self.response and not self.responded_at:
			self.responded_at = now_datetime()
			self.responded_by = frappe.session.user
