"""Maison Client Profile (v0.4): clienteling data linked 1:1 to a Customer."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class MaisonClientProfile(Document):
	def validate(self) -> None:
		seen: set[str] = set()
		for w in self.wishlist:
			if not w.added_on:
				w.added_on = now_datetime()
			if not w.added_by:
				w.added_by = frappe.session.user
			key = f"{w.item_code}:{int(w.fulfilled or 0)}"
			if key in seen and not w.fulfilled:
				frappe.throw(_("Item {0} is already on the wishlist").format(w.item_code), frappe.ValidationError)
			seen.add(key)
		if self.preferred_associate and self.preferred_boutique:
			assoc_boutique = frappe.db.get_value("Maison Associate", self.preferred_associate, "boutique")
			if assoc_boutique and assoc_boutique != self.preferred_boutique:
				# not an error (clients move) — just keep both; the POS shows the associate's own boutique
				pass

	def after_insert(self) -> None:
		self._sync_contact()

	def on_update(self) -> None:
		if not self.crm_contact:
			self._sync_contact()

	def _sync_contact(self) -> None:
		"""Link the standard Contact (what Frappe CRM lists as people) — never fails the save."""
		if frappe.flags.in_install or frappe.flags.in_migrate:
			return
		try:
			from maison_pos.api.crm import ensure_contact

			contact = ensure_contact(self.customer)
			if contact and contact != self.crm_contact:
				self.db_set("crm_contact", contact, update_modified=False)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "maison profile contact sync")
