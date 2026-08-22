"""Maison Sync Log: idempotency ledger keyed by the POS client's offline_uuid."""

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe.model.document import Document


class MaisonSyncLog(Document):
	def validate(self) -> None:
		if isinstance(self.payload, (dict, list)):
			self.payload = json.dumps(self.payload, default=str)


def get_log(offline_uuid: str) -> dict[str, Any] | None:
	"""Return ``{name, status, invoice, error, error_code}`` for *offline_uuid* or None."""
	rows = frappe.get_all(
		"Maison Sync Log",
		filters={"offline_uuid": offline_uuid},
		fields=["name", "status", "invoice", "error", "error_code", "attempts"],
		limit=1,
	)
	return rows[0] if rows else None


def record(
	offline_uuid: str,
	status: str,
	*,
	boutique: str | None = None,
	device_id: str | None = None,
	payload: Any = None,
	invoice: str | None = None,
	error: str | None = None,
	error_code: str | None = None,
) -> str:
	"""Insert or update the log row for *offline_uuid* (never raises on duplicates)."""
	values = {
		"status": status,
		"invoice": invoice,
		"error": error,
		"error_code": error_code,
	}
	if boutique:
		values["boutique"] = boutique
	if device_id:
		values["device_id"] = device_id
	if payload is not None:
		values["payload"] = json.dumps(payload, default=str) if not isinstance(payload, str) else payload

	existing = frappe.db.get_value("Maison Sync Log", {"offline_uuid": offline_uuid}, ["name", "attempts"], as_dict=True)
	if existing:
		values["attempts"] = (existing.attempts or 0) + 1
		frappe.db.set_value("Maison Sync Log", existing.name, values, update_modified=True)
		return existing.name

	doc = frappe.new_doc("Maison Sync Log")
	doc.update({"offline_uuid": offline_uuid, "attempts": 1, **values})
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name
