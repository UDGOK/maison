"""Maison Salon Session (v0.5 K) — one paired POS ↔ client-facing Salon device.

The document *name* is the Salon's bearer token (32 random chars): the Salon device is a
guest and only ever presents that token. State flows POS → Salon (``state`` / ``state_seq``),
messages flow Salon → POS (``inbox`` / ``inbox_seq``). Both sides receive realtime events in
the document room (``doc_subscribe``) and fall back to 2 s polling.
"""

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

TOKEN_LENGTH = 32


class MaisonSalonSession(Document):
	def autoname(self) -> None:
		self.name = frappe.generate_hash(length=TOKEN_LENGTH)

	def validate(self) -> None:
		if self.status == "Unpaired" and not self.unpaired_at:
			self.unpaired_at = now_datetime()

	@property
	def is_active(self) -> bool:
		if self.status != "Paired":
			return False
		return not self.expires_at or now_datetime() < frappe.utils.get_datetime(self.expires_at)
