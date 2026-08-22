"""Customer document events: auto-assign the printed client number, stamp face consent."""

from __future__ import annotations

import frappe
from frappe.utils import now_datetime

from maison_pos.identifiers import new_client_number


def before_insert(doc, method: str | None = None) -> None:
	if not doc.get("maison_client_number"):
		doc.maison_client_number = new_client_number()
	_stamp_consent(doc)


def validate(doc, method: str | None = None) -> None:
	if doc.get("maison_client_number"):
		doc.maison_client_number = str(doc.maison_client_number).strip().upper()
	_stamp_consent(doc)


def _stamp_consent(doc) -> None:
	"""Record when consent was granted; clear the timestamp (and any face id) when withdrawn."""
	if doc.get("maison_face_consent"):
		if not doc.get("maison_face_consent_on"):
			doc.maison_face_consent_on = now_datetime()
	else:
		doc.maison_face_consent_on = None
		doc.maison_face_id = None
