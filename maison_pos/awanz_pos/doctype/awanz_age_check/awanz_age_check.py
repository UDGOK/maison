"""AWANZ Age Check (v0.6 N) — audit row for a 21+ verification. Holds no PII beyond initials,
DOB year and the outcome; the raw barcode payload is never stored."""

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class AWANZAgeCheck(Document):
	def before_insert(self) -> None:
		if not self.ts:
			self.ts = now_datetime()
		# defensive: initials only, two letters max
		self.initials = "".join(ch for ch in (self.initials or "") if ch.isalpha())[:2].upper() or None
		if not self.device_id:
			self.device_id = frappe.local.request_ip if getattr(frappe.local, "request_ip", None) else None
