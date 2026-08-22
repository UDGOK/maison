"""Head-office live dashboard endpoints: ``live_summary`` and ``heartbeat``."""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Count, Max, Sum
from frappe.utils import add_to_date, cint, flt, get_datetime, getdate, now_datetime, nowdate

from maison_pos.api.recognition import recognition_counts
from maison_pos.maison_pos.doctype.maison_device_heartbeat.maison_device_heartbeat import upsert_heartbeat
from maison_pos.scoping import assert_boutique_access, get_allowed_boutiques, is_unrestricted, assert_roles, ALL_MAISON_ROLES
from maison_pos.tasks import STALE_AFTER_SECONDS
from maison_pos.utils import iso_with_tz, publish_heartbeat


def _cash_card(payment_rows: list[dict[str, Any]]) -> tuple[float, float]:
	cash = card = 0.0
	for p in payment_rows:
		if (p["mode_of_payment"] or "").lower() == "cash":
			cash += flt(p["amount"])
		else:
			card += flt(p["amount"])
	return cash, card


@frappe.whitelist()
def live_summary(date: Optional[str] = None) -> dict[str, Any]:
	"""Aggregate today's submitted POS Sales Invoices by boutique and by hour.

	Scoped users (Manager/Associate) only get their own boutique.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	day = getdate(date or nowdate())
	boutiques = get_allowed_boutiques()
	boutique_meta = {
		b.name: b
		for b in frappe.get_all("Maison Boutique", filters={"name": ("in", boutiques)} if boutiques else {"name": "__none__"}, fields=["name", "boutique_name", "city", "enabled"])
	}

	SI = DocType("Sales Invoice")
	SIP = DocType("Sales Invoice Payment")

	base_filter = (SI.docstatus == 1) & (SI.is_pos == 1) & (SI.posting_date == day)
	if boutiques:
		base_filter &= SI.maison_boutique.isin(boutiques)
	else:
		base_filter &= SI.maison_boutique == "__none__"

	# per-boutique invoice totals
	inv_rows = (
		frappe.qb.from_(SI)
		.select(
			SI.maison_boutique.as_("boutique"),
			Count(SI.name).as_("invoices"),
			Sum(SI.grand_total).as_("net"),
			Sum(SI.change_amount).as_("change"),
			Max(SI.posting_time).as_("last_time"),
		)
		.where(base_filter & (SI.is_return == 0))
		.groupby(SI.maison_boutique)
	).run(as_dict=True)
	ret_rows = (
		frappe.qb.from_(SI)
		.select(SI.maison_boutique.as_("boutique"), Count(SI.name).as_("returns"), Sum(SI.grand_total).as_("net"))
		.where(base_filter & (SI.is_return == 1))
		.groupby(SI.maison_boutique)
	).run(as_dict=True)

	# per-boutique tenders
	pay_rows = (
		frappe.qb.from_(SIP)
		.join(SI)
		.on(SIP.parent == SI.name)
		.select(SI.maison_boutique.as_("boutique"), SIP.mode_of_payment, Sum(SIP.amount).as_("amount"))
		.where(base_filter)
		.groupby(SI.maison_boutique, SIP.mode_of_payment)
	).run(as_dict=True)

	# hourly series (Python-side bucketing of a single day's rows)
	hour_rows = (
		frappe.qb.from_(SI)
		.select(SI.maison_boutique.as_("boutique"), SI.posting_time, SI.grand_total)
		.where(base_filter)
	).run(as_dict=True)

	# device heartbeats
	# NB: query builder, not frappe.get_all — DatabaseQuery silently drops any field whose
	# name contains "_seen" (it treats it as the optional ``_seen`` column), so ``last_seen``
	# never came back and every boutique rendered offline.
	HB = DocType("Maison Device Heartbeat")
	hb_rows = (
		frappe.qb.from_(HB)
		.select(HB.boutique, HB.device_id, HB.status, HB.last_seen, HB.queued, HB.app_version)
		.where(HB.boutique.isin(boutiques) if boutiques else HB.boutique == "__none__")
	).run(as_dict=True)
	pending_by_boutique = {
		r.boutique: r.n
		for r in frappe.get_all(
			"Maison Price Change Request",
			filters={"workflow_state": "Pending Approval", "docstatus": 1, "boutique": ("in", boutiques or ["__none__"])},
			fields=["boutique", "count(name) as n"],
			group_by="boutique",
		)
	}

	cutoff = add_to_date(now_datetime(), seconds=-STALE_AFTER_SECONDS)
	per_b: dict[str, dict[str, Any]] = {}
	for code in boutiques:
		meta = boutique_meta.get(code, {})
		per_b[code] = {
			"boutique": code,
			"name": meta.get("boutique_name") or code,
			"city": meta.get("city"),
			"net": 0.0,
			"cash": 0.0,
			"card": 0.0,
			"invoices": 0,
			"returns": 0,
			"status": "offline",
			"last_seen": None,
			"queued": 0,
			"devices": 0,
			"pending_approvals": cint(pending_by_boutique.get(code, 0)),
		}
	for r in inv_rows:
		b = per_b.setdefault(r.boutique, {"boutique": r.boutique, "name": r.boutique, "net": 0.0, "cash": 0.0, "card": 0.0, "invoices": 0, "returns": 0, "status": "offline", "last_seen": None, "queued": 0, "devices": 0, "pending_approvals": 0})
		b["invoices"] = cint(r.invoices)
		b["net"] += flt(r.net)
		b["cash"] -= flt(r.change)  # change handed back reduces cash in drawer
		if r.last_time is not None:
			secs = int(r.last_time.total_seconds()) if hasattr(r.last_time, "total_seconds") else cint(str(r.last_time).split(":")[0]) * 3600
			b["last_sale"] = iso_with_tz(f"{day} {secs // 3600:02d}:{secs % 3600 // 60:02d}:{secs % 60:02d}")
	for r in ret_rows:
		b = per_b.get(r.boutique)
		if b:
			b["returns"] = cint(r.returns)
			b["net"] += flt(r.net)  # returns carry negative grand_total
	for r in pay_rows:
		b = per_b.get(r.boutique)
		if not b:
			continue
		if (r.mode_of_payment or "").lower() == "cash":
			b["cash"] += flt(r.amount)
		else:
			b["card"] += flt(r.amount)
	newest_seen: dict[str, Any] = {}
	for hb in hb_rows:
		b = per_b.get(hb.boutique)
		if not b:
			continue
		b["devices"] += 1
		last_seen = get_datetime(hb.last_seen) if hb.last_seen else None
		is_live = hb.status == "Online" and last_seen and last_seen >= cutoff
		# Only devices that are currently live contribute to the queued count; a stale
		# device that went away with items queued would otherwise show forever.
		if is_live:
			b["queued"] += cint(hb.queued)
			b["status"] = "online"
		if last_seen and (hb.boutique not in newest_seen or last_seen > newest_seen[hb.boutique]):
			newest_seen[hb.boutique] = last_seen
	for code, seen in newest_seen.items():
		per_b[code]["last_seen"] = iso_with_tz(seen)
	for b in per_b.values():
		if b["pending_approvals"] and b["status"] != "online":
			b["status"] = "pending_approval"
		elif b["pending_approvals"]:
			b["status"] = "online"  # online wins; pending shown via the count

	by_hour: dict[int, dict[str, Any]] = {h: {"hour": h, "net": 0.0, "invoices": 0} for h in range(24)}
	for r in hour_rows:
		t = r.posting_time
		hour = getattr(t, "hour", None)
		if hour is None:
			hour = cint(str(t).split(":")[0])
		if hour in by_hour:
			by_hour[hour]["net"] += flt(r.grand_total)
			by_hour[hour]["invoices"] += 1

	totals_net = sum(b["net"] for b in per_b.values())
	totals_inv = sum(b["invoices"] for b in per_b.values())
	pending_total = cint(sum(pending_by_boutique.values()))

	return {
		"date": str(day),
		"generated_at": now_datetime().isoformat(),
		"totals": {
			"net": totals_net,
			"invoices": totals_inv,
			"returns": sum(b["returns"] for b in per_b.values()),
			"cash": sum(b["cash"] for b in per_b.values()),
			"card": sum(b["card"] for b in per_b.values()),
			"avg_ticket": (totals_net / totals_inv) if totals_inv else 0.0,
			"online": sum(1 for b in per_b.values() if b["status"] == "online"),
			"boutiques": len(per_b),
		},
		"by_boutique": sorted(per_b.values(), key=lambda b: (-b["net"], b["boutique"])),
		"by_hour": [by_hour[h] for h in range(24)],
		"pending_approvals": pending_total,
		"pending_approvals_list": _pending_list(boutiques) if is_unrestricted() else [],
		"recognition": recognition_counts(boutiques, day),
	}


def _pending_list(boutiques: list[str]) -> list[dict[str, Any]]:
	if not boutiques:
		return []
	return frappe.get_all(
		"Maison Price Change Request",
		filters={"workflow_state": "Pending Approval", "docstatus": 1, "boutique": ("in", boutiques)},
		fields=["name", "boutique", "item_code", "item_name", "current_rate", "proposed_rate", "requested_by", "modified"],
		order_by="modified asc",
		limit=50,
	)


@frappe.whitelist()
def heartbeat(boutique: str, device_id: str, queued: int = 0, app_version: Optional[str] = None) -> dict[str, Any]:
	"""POS devices call this every 60 s. Upserts the heartbeat row and publishes ``maison_heartbeat``."""
	boutique = assert_boutique_access(boutique)
	device_id = (device_id or "").strip()
	if not device_id:
		frappe.throw(_("device_id is required"), frappe.ValidationError)
	ip = None
	try:
		ip = frappe.local.request_ip
	except Exception:  # pragma: no cover - not in a request
		pass
	row = upsert_heartbeat(boutique, device_id, queued=cint(queued), app_version=app_version, ip_address=ip)
	publish_heartbeat(row)
	return {"ok": True, "server_time": now_datetime().isoformat(), "status": "Online"}


@frappe.whitelist()
def recent_sales(limit: int = 20, boutique: Optional[str] = None) -> list[dict[str, Any]]:
	"""Latest submitted POS invoices for the live feed (initial fill before socket events)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutiques = [assert_boutique_access(boutique)] if boutique else get_allowed_boutiques()
	if not boutiques:
		return []
	return frappe.get_all(
		"Sales Invoice",
		filters={"docstatus": 1, "is_pos": 1, "maison_boutique": ("in", boutiques)},
		fields=["name", "maison_boutique as boutique", "customer_name", "grand_total", "posting_date", "posting_time", "maison_associate as associate", "is_return"],
		order_by="posting_date desc, posting_time desc",
		limit=min(max(cint(limit) or 20, 1), 100),
	)
