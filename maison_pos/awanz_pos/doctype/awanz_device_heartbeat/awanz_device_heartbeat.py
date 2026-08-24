"""AWANZ Device Heartbeat: one row per (boutique, device) updated every 60s by the PWA."""

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from maison_pos.utils import iso_with_tz


class AWANZDeviceHeartbeat(Document):
	def validate(self) -> None:
		self.device_id = (self.device_id or "").strip()
		if not self.last_seen:
			self.last_seen = now_datetime()
		if not self.status:
			self.status = "Online"


def upsert_heartbeat(
	boutique: str, device_id: str, queued: int = 0, app_version: str | None = None, ip_address: str | None = None
) -> dict:
	"""Create or update the heartbeat row; returns the row as a plain dict."""
	now = now_datetime()
	values = {
		"last_seen": now,
		"queued": int(queued or 0),
		"status": "Online",
	}
	if app_version:
		values["app_version"] = app_version
	if ip_address:
		values["ip_address"] = ip_address

	name = frappe.db.get_value("AWANZ Device Heartbeat", {"boutique": boutique, "device_id": device_id}, "name")
	if name:
		frappe.db.set_value("AWANZ Device Heartbeat", name, values, update_modified=False)
	else:
		doc = frappe.new_doc("AWANZ Device Heartbeat")
		doc.update({"boutique": boutique, "device_id": device_id, **values})
		doc.flags.ignore_permissions = True
		doc.insert()
		name = doc.name

	return {
		"name": name,
		"boutique": boutique,
		"device_id": device_id,
		"status": "Online",
		"last_seen": iso_with_tz(now),
		"queued": int(queued or 0),
		"app_version": app_version,
	}
