"""Scheduled jobs (see hooks.scheduler_events)."""

from __future__ import annotations

import frappe
from frappe.utils import add_days, add_to_date, get_datetime, now_datetime

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


def purge_expired_biometrics(retention_months: int | None = None) -> dict:
	"""Daily (BIPA retention policy): destroy face templates of clients with no visit in N months.

	"Last visit" is the newest submitted POS invoice of the customer; a client who never
	bought anything ages from the consent ``captured_at``. Each purge revokes the consent
	(reason "Retention policy"), clears the Customer flags and logs a ``Purged`` event.
	Returns ``{checked, purged: [customer...]}``.
	"""
	from frappe.utils import add_months
	from frappe.query_builder import DocType
	from frappe.query_builder.functions import Max

	from maison_pos.api.recognition import purge_customer_biometrics
	from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import get_recognition_settings

	months = int(retention_months or get_recognition_settings()["biometric_retention_months"])
	cutoff = add_months(now_datetime(), -months)
	consents = frappe.get_all(
		"Maison Biometric Consent", filters={"status": "Active"}, fields=["name", "customer", "captured_at"]
	)
	if not consents:
		return {"checked": 0, "purged": []}
	customers = sorted({c.customer for c in consents})
	SI = DocType("Sales Invoice")
	visits = {
		r.customer: r.last_visit
		for r in (
			frappe.qb.from_(SI)
			.select(SI.customer, Max(SI.posting_date).as_("last_visit"))
			.where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.customer.isin(customers)))
			.groupby(SI.customer)
		).run(as_dict=True)
	}
	purged: list[str] = []
	for c in consents:
		last = visits.get(c.customer)
		last_dt = get_datetime(str(last)) if last else get_datetime(c.captured_at)
		if last_dt and last_dt < cutoff:
			purge_customer_biometrics(
				c.customer,
				reason=f"Retention policy: no visit in {months} months (last activity {last_dt.date()})",
				outcome="Purged",
				boutique=frappe.db.get_value("Maison Biometric Consent", c.name, "boutique"),
			)
			purged.append(c.customer)
	if purged and not frappe.flags.in_test:
		frappe.db.commit()
	return {"checked": len(consents), "purged": purged}
