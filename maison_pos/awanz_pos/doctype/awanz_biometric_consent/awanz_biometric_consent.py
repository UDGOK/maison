"""AWANZ Biometric Consent — the written consent record behind every face template.

One Active consent per customer at a time (re-enrolment supersedes the previous one);
``revoke`` / the retention purge flip it to Revoked and purge the templates. The
``consent_text`` snapshot is what the client saw, identified by ``consent_text_version``.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document


class AWANZBiometricConsent(Document):
	def validate(self) -> None:
		if self.status == "Revoked" and not self.revoked_at:
			self.revoked_at = frappe.utils.now_datetime()
			self.revoked_by = self.revoked_by or frappe.session.user
		if self.status == "Active" and self.revoked_at:
			frappe.throw(_("A revoked consent cannot be reactivated; enrol the client again."), frappe.ValidationError)

	def on_trash(self) -> None:
		# templates must never outlive their consent record
		from maison_pos.api.recognition import purge_templates

		purge_templates(self.customer, consent=self.name)
