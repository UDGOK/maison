from __future__ import annotations

from frappe.model.document import Document
from frappe.utils import now_datetime


class AWANZGiveawayEntry(Document):
	def before_insert(self) -> None:
		if not self.ts:
			self.ts = now_datetime()
