"""Scheduled jobs (see hooks.scheduler_events)."""

from __future__ import annotations

import frappe
from frappe.utils import add_days, add_to_date, now_datetime

from maison_pos.utils import iso_with_tz, publish_heartbeat

STALE_AFTER_SECONDS = 180  # 3 missed 60s pings


def check_heartbeat_staleness() -> None:
	"""Flip devices whose last ping is older than ``STALE_AFTER_SECONDS`` to Offline.

	Publishes one ``maison_heartbeat`` event per device that changed state so the
	head-office wall updates without polling.
	"""
	cutoff = add_to_date(now_datetime(), seconds=-STALE_AFTER_SECONDS)
	# Query builder on purpose: frappe.get_all strips ``last_seen`` from both fields and
	# filters (substring match on the optional ``_seen`` column), which would have marked
	# every Online device Offline on each run.
	HB = frappe.qb.DocType("Maison Device Heartbeat")
	stale = (
		frappe.qb.from_(HB)
		.select(HB.name, HB.boutique, HB.device_id, HB.last_seen, HB.queued)
		.where((HB.status == "Online") & (HB.last_seen < cutoff))
	).run(as_dict=True)
	for row in stale:
		frappe.db.set_value("Maison Device Heartbeat", row.name, "status", "Offline", update_modified=False)
		publish_heartbeat(
			{
				"boutique": row.boutique,
				"device_id": row.device_id,
				"status": "Offline",
				"last_seen": iso_with_tz(row.last_seen),
				"queued": row.queued,
			}
		)
	if stale:
		frappe.db.commit()


def purge_old_sync_logs(days: int = 90) -> None:
	"""Delete successful sync log rows older than *days* (errors are kept)."""
	cutoff = add_days(now_datetime(), -days)
	frappe.db.delete("Maison Sync Log", {"status": ("in", ["Success", "Duplicate"]), "creation": ("<", cutoff)})
	frappe.db.commit()
