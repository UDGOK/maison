"""Shared helpers: realtime summaries, receipt context, money formatting."""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe.utils import flt, get_datetime, now_datetime

# Frappe's socket.io server only lets clients join the rooms it manages (site, user,
# doctype, doc, task). A custom room name would never have subscribers, so the dashboard
# listens on the Sales Invoice doctype room (client emits ``doctype_subscribe``).
DASHBOARD_ROOM = "doctype:Sales Invoice"
SIGNATURE_THRESHOLD = 10_000.0


def iso_with_tz(value: Any) -> Optional[str]:
	"""ISO-8601 with the site's UTC offset for naive site-local datetimes.

	Frappe stores naive datetimes in the system timezone; browsers parse a naive ISO
	string as *their* local time, so dashboard clients in another zone (or a UTC
	container) would show heartbeats hours old and mark boutiques offline.
	"""
	if not value:
		return None
	from zoneinfo import ZoneInfo

	from frappe.utils import get_system_timezone

	dt = get_datetime(value)
	if dt.tzinfo is None:
		dt = dt.replace(tzinfo=ZoneInfo(get_system_timezone()))
	return dt.isoformat()


def format_money(value: float, currency: Optional[str] = None) -> str:
	"""Format a number as a currency string for receipts (``$12,345.00``)."""
	from frappe.utils import fmt_money

	return fmt_money(flt(value), currency=currency or frappe.defaults.get_global_default("currency") or "USD")


def invoice_summary(doc) -> dict[str, Any]:
	"""Compact summary of a POS Sales Invoice for the live feed."""
	cash = card = 0.0
	card_meta: dict[str, Any] = {}
	for p in doc.get("payments") or []:
		if (p.mode_of_payment or "").lower() == "cash":
			cash += flt(p.amount)
		else:
			card += flt(p.amount)
	if doc.get("maison_card_brand") or doc.get("maison_card_last4"):
		card_meta = {"brand": doc.get("maison_card_brand"), "last4": doc.get("maison_card_last4")}

	return {
		"invoice": doc.name,
		"boutique": doc.get("maison_boutique"),
		"associate": doc.get("maison_associate"),
		"device_id": doc.get("maison_device_id"),
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"posting_datetime": iso_with_tz(f"{doc.posting_date} {doc.posting_time}"),
		"net_total": flt(doc.net_total),
		"grand_total": flt(doc.grand_total),
		"total_taxes": flt(doc.total_taxes_and_charges),
		"cash": cash,
		"card": card,
		"card_meta": card_meta,
		"items": [
			{"item_code": i.item_code, "item_name": i.item_name, "qty": flt(i.qty), "rate": flt(i.rate), "serial_no": i.get("serial_no")}
			for i in doc.items
		],
		"docstatus": doc.docstatus,
		"ts": iso_with_tz(now_datetime()),
	}


def publish_sale(doc, event: str = "maison_sale") -> None:
	"""Push a sale (or cancellation) to the head-office dashboard room."""
	payload = invoice_summary(doc)
	payload["event"] = event
	frappe.publish_realtime(event, payload, room=DASHBOARD_ROOM, after_commit=True)


def publish_heartbeat(payload: dict[str, Any]) -> None:
	frappe.publish_realtime("maison_heartbeat", payload, room=DASHBOARD_ROOM, after_commit=True)


def touch_last_seen(boutique: Optional[str], device_id: Optional[str]) -> None:
	"""Update (or create) the heartbeat row for a device when a sale lands."""
	if not boutique or not device_id:
		return
	name = frappe.db.get_value("Maison Device Heartbeat", {"boutique": boutique, "device_id": device_id}, "name")
	now = now_datetime()
	if name:
		frappe.db.set_value(
			"Maison Device Heartbeat",
			name,
			{"last_seen": now, "status": "Online"},
			update_modified=False,
		)
	else:
		hb = frappe.new_doc("Maison Device Heartbeat")
		hb.update({"boutique": boutique, "device_id": device_id, "last_seen": now, "queued": 0, "status": "Online"})
		hb.flags.ignore_permissions = True
		hb.insert()


def get_receipt_context(doc) -> dict[str, Any]:
	"""Jinja helper: everything the 80 mm receipt needs beyond the invoice itself."""
	boutique = None
	if doc.get("maison_boutique") and frappe.db.exists("Maison Boutique", doc.maison_boutique):
		boutique = frappe.get_doc("Maison Boutique", doc.maison_boutique)

	associate_name = None
	if doc.get("maison_associate") and frappe.db.exists("Maison Associate", doc.maison_associate):
		associate_name = frappe.db.get_value("Maison Associate", doc.maison_associate, "full_name")

	tier = None
	points_balance = 0.0
	if doc.customer:
		try:
			from erpnext.accounts.doctype.loyalty_program.loyalty_program import get_loyalty_program_details_with_points

			details = get_loyalty_program_details_with_points(doc.customer, company=doc.company, silent=True)
			if details:
				tier = details.get("tier_name")
				points_balance = flt(details.get("loyalty_points"))
		except Exception:  # pragma: no cover - loyalty is optional
			frappe.log_error(frappe.get_traceback(), "Maison receipt loyalty lookup")

	points_earned = 0.0
	if doc.docstatus == 1:
		points_earned = flt(
			frappe.db.get_value(
				"Loyalty Point Entry",
				{"invoice_type": "Sales Invoice", "invoice": doc.name, "redeem_against": ("is", "not set")},
				"loyalty_points",
			)
		)

	certificates = {}
	for row in doc.items:
		cert = frappe.db.get_value("Item", row.item_code, "maison_certificate_no")
		if cert:
			certificates[row.item_code] = cert

	return {
		"boutique": boutique,
		"associate_name": associate_name,
		"tier": tier,
		"points_balance": points_balance,
		"points_earned": points_earned,
		"certificates": certificates,
		"requires_signature": flt(doc.grand_total) >= SIGNATURE_THRESHOLD,
		"printed_at": now_datetime(),
	}


def parse_datetime(value: Any):
	"""Tolerant datetime parser (ISO strings with ``T`` / ``Z`` accepted)."""
	if not value:
		return now_datetime()
	if isinstance(value, str):
		raw = value.strip()
		# Timezone-aware ISO strings (the PWA sends ``Date.toISOString()``: UTC with ``Z``):
		# convert to the site's timezone instead of dropping the offset, otherwise the
		# posting time lands N hours off and sales fall into the wrong day/hour bucket.
		try:
			from datetime import datetime
			from zoneinfo import ZoneInfo

			from frappe.utils import get_system_timezone

			parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
			if parsed.tzinfo is not None:
				return parsed.astimezone(ZoneInfo(get_system_timezone())).replace(tzinfo=None)
		except (ValueError, TypeError):
			pass
		value = raw.replace("T", " ")
		if "+" in value[10:]:
			value = value[: value.index("+", 10)]
	return get_datetime(value)
