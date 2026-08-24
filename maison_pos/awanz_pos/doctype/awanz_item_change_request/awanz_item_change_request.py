"""AWANZ Item Change Request (phase 2 scaffold).

Holds proposed Item field changes as JSON. Approval applies the changes to the
Item. No workflow is wired yet; ``approve()`` / ``reject()`` are callable by
Head Office / Regional users.
"""

from __future__ import annotations

import json

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime

ALLOWED_FIELDS = frozenset(
	{
		"item_name",
		"description",
		"maison_metal",
		"maison_carat",
		"maison_stones",
		"maison_certificate_no",
		"maison_appraisal_value",
		"maison_department",
		"maison_taxable",
		"image",
	}
)


class AWANZItemChangeRequest(Document):
	def validate(self) -> None:
		if not self.requested_by:
			self.requested_by = frappe.session.user
		changes = self.get_changes()
		if not changes:
			frappe.throw(_("Proposed changes cannot be empty"), frappe.ValidationError)
		unknown = set(changes) - ALLOWED_FIELDS
		if unknown:
			frappe.throw(_("Fields not allowed in a change request: {0}").format(", ".join(sorted(unknown))), frappe.ValidationError)
		from maison_pos.scoping import assert_boutique_access

		if not self.flags.ignore_permissions:
			assert_boutique_access(self.boutique)

	def get_changes(self) -> dict:
		raw = self.proposed_changes
		if isinstance(raw, dict):
			return raw
		try:
			return json.loads(raw or "{}")
		except ValueError:
			frappe.throw(_("Proposed changes must be valid JSON"), frappe.ValidationError)

	def _assert_approver(self) -> None:
		from maison_pos.scoping import APPROVER_ROLES

		if frappe.session.user != "Administrator" and not (APPROVER_ROLES & set(frappe.get_roles())):
			frappe.throw(_("Only Head Office or Regional users may decide item changes"), frappe.PermissionError)

	@frappe.whitelist()
	def approve(self) -> None:
		self._assert_approver()
		if self.docstatus != 1 or self.status != "Pending":
			frappe.throw(_("Only submitted, pending requests can be approved"), frappe.ValidationError)
		item = frappe.get_doc("Item", self.item_code)
		item.update(self.get_changes())
		item.flags.ignore_permissions = True
		item.save()
		self.db_set({"status": "Approved", "decided_by": frappe.session.user, "decided_on": now_datetime()})

	@frappe.whitelist()
	def reject(self) -> None:
		self._assert_approver()
		if self.docstatus != 1 or self.status != "Pending":
			frappe.throw(_("Only submitted, pending requests can be rejected"), frappe.ValidationError)
		self.db_set({"status": "Rejected", "decided_by": frappe.session.user, "decided_on": now_datetime()})
