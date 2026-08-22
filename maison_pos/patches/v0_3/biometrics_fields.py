"""v0.3: Customer ``maison_face_consent_at`` + ``maison_face_templates`` and recognition settings defaults.

Copies the legacy ``maison_face_consent_on`` timestamp into ``maison_face_consent_at`` and fills
the new Maison POS Settings fields (consent text EN, version, model, threshold, retention).
Idempotent.
"""

from __future__ import annotations

import frappe

from maison_pos.setup.install import create_custom_fields_from_fixture, ensure_settings_defaults


def execute() -> None:
	if not frappe.db.exists("DocType", "Customer"):
		return
	frappe.reload_doc("maison_pos", "doctype", "maison_biometric_consent")
	frappe.reload_doc("maison_pos", "doctype", "maison_face_template")
	frappe.reload_doc("maison_pos", "doctype", "maison_recognition_event")
	frappe.reload_doc("maison_pos", "doctype", "maison_pos_settings")
	create_custom_fields_from_fixture()
	frappe.reload_doctype("Customer")
	if frappe.db.has_column("Customer", "maison_face_consent_at") and frappe.db.has_column("Customer", "maison_face_consent_on"):
		C = frappe.qb.DocType("Customer")
		frappe.qb.update(C).set(C.maison_face_consent_at, C.maison_face_consent_on).where(
			C.maison_face_consent_at.isnull() & C.maison_face_consent_on.isnotnull()
		).run()
	ensure_settings_defaults()
	frappe.db.commit()
