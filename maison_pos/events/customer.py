"""Customer document events: auto-assign the printed client number, keep face-consent fields in sync.

Consent fields on Customer (``maison_face_consent`` Check, ``maison_face_consent_at`` Datetime,
``maison_face_consent_on`` legacy mirror) are *derived* from the ``Maison Biometric Consent``
records written by ``maison_pos.api.recognition``. Unticking the box in the desk is treated
as a withdrawal: templates are dropped from the document and the Active consent is revoked.
"""

from __future__ import annotations

import frappe
from frappe.utils import now_datetime

from maison_pos.identifiers import new_client_number


def _is_walk_in(doc) -> bool:
	from maison_pos.api.rewards import is_walk_in

	return is_walk_in(doc.get("name"), customer_name=doc.get("customer_name"))


def _never_enrol_walk_in(doc) -> None:
	"""v0.6 D5 — the POS-Profile default customer is a placeholder, not a rewards member.

	``Customer.validate`` calls ERPNext's ``set_loyalty_program()``, which silently enrols any
	customer into a programme flagged ``auto_opt_in`` — including "Walk-in Customer", which then
	accrued a point per dollar on every anonymous basket (61,045 points across the seeded
	history) and printed as ``Member · MC…`` on anonymous receipts. Clearing it here runs on the
	seed as well, so the situation cannot be re-created.
	"""
	if not _is_walk_in(doc):
		return
	doc.loyalty_program = None
	doc.loyalty_program_tier = None
	doc.maison_client_number = None


def before_insert(doc, method: str | None = None) -> None:
	if not doc.get("maison_client_number") and not _is_walk_in(doc):
		doc.maison_client_number = new_client_number()
	_never_enrol_walk_in(doc)
	_stamp_consent(doc)


def validate(doc, method: str | None = None) -> None:
	if doc.get("maison_client_number"):
		doc.maison_client_number = str(doc.maison_client_number).strip().upper()
	_never_enrol_walk_in(doc)
	_stamp_consent(doc)


def on_update(doc, method: str | None = None) -> None:
	"""Invalidate the match cache when the template table changed; revoke consent when unticked."""
	from maison_pos.api import recognition

	before = doc.get_doc_before_save()
	templates_before = _template_keys(before) if before else set()
	templates_now = _template_keys(doc)
	if templates_before != templates_now:
		recognition.invalidate_template_cache()

	if before and before.get("maison_face_consent") and not doc.get("maison_face_consent"):
		recognition.revoke_consent_records(doc.name, reason="Consent unticked on the Customer record")


def _template_keys(doc) -> set[tuple]:
	return {(t.get("name"), t.get("consent"), t.get("model")) for t in (doc.get("maison_face_templates") or [])}


def _stamp_consent(doc) -> None:
	"""Record when consent was granted; clear timestamps, face id and templates when withdrawn."""
	if doc.get("maison_face_consent"):
		at = doc.get("maison_face_consent_at") or doc.get("maison_face_consent_on") or now_datetime()
		doc.maison_face_consent_at = at
		doc.maison_face_consent_on = at
	else:
		doc.maison_face_consent_at = None
		doc.maison_face_consent_on = None
		doc.maison_face_id = None
		if doc.get("maison_face_templates"):
			doc.set("maison_face_templates", [])
