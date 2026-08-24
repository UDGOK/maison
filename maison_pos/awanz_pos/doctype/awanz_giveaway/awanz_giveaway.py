"""AWANZ Giveaway (v0.6 Q) — product giveaways with entries earned at the counter.

Entries are ``AWANZ Giveaway Entry`` rows created on Sales Invoice submit (1 entry per $X of net
paid or 1 per visit), reversed on return. The winner is drawn with a seeded PRNG over the entry
list so the draw can be audited / replayed (``draw_audit``)."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt, getdate


class AWANZGiveaway(Document):
	def validate(self) -> None:
		if getdate(self.start_date) > getdate(self.end_date):
			frappe.throw(_("Start must be before End"), frappe.ValidationError)
		if self.entry_rule == "Per amount" and flt(self.amount_per_entry) <= 0:
			frappe.throw(_("$ per entry must be positive for the 'Per amount' rule"), frappe.ValidationError)
		if cint(self.max_entries_per_invoice) < 0:
			self.max_entries_per_invoice = 0
		if self.status == "Drawn" and not self.winner and not self.flags.maison_drawing:
			frappe.throw(_("Use the Draw action to pick a winner"), frappe.ValidationError)

	def is_open_on(self, date) -> bool:
		return self.status == "Open" and getdate(self.start_date) <= getdate(date) <= getdate(self.end_date)

	def entries_for(self, net_amount: float) -> int:
		"""Entries a receipt of *net_amount* earns under this giveaway's rule."""
		if self.entry_rule == "Per visit":
			n = 1
		else:
			n = int(flt(net_amount) // flt(self.amount_per_entry)) if flt(self.amount_per_entry) > 0 else 0
		cap = cint(self.max_entries_per_invoice)
		if cap > 0:
			n = min(n, cap)
		return max(0, n)
