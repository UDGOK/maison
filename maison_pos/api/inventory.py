"""Inventory (v0.4 section D): low-stock alerts, transfer requests, cycle counts.

* ``low_stock_scan`` (hourly scheduler job) compares every ``Item Reorder`` row against the
  warehouse ``Bin`` and keeps exactly one open ``AWANZ Stock Alert`` per (item, warehouse) —
  re-running never duplicates, and alerts auto-resolve once stock is back above the level.
* ``alerts`` / ``acknowledge`` / ``resolve`` drive the POS Shift/Settings badge and the
  dashboard "Low stock" tile.
* ``request_transfer`` raises a Material Request (Material Transfer) between boutiques.
* ``cycle_count_expected`` / ``submit_cycle_count`` back the POS Cycle count screen: serials
  scanned on the device are compared with the warehouse and a draft Stock Reconciliation is
  created for the qty items so a manager can review and submit it in the desk.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, get_url_to_form, now_datetime, nowdate, nowtime

from maison_pos.scoping import (
	ALL_AWANZ_ROLES,
	assert_boutique_access,
	assert_roles,
	get_allowed_boutiques,
	get_associate,
	is_manager_or_above,
	is_unrestricted,
)

ALERT_FIELDS = [
	"name", "item_code", "item_name", "warehouse", "boutique", "status", "qty", "reorder_level", "reorder_qty",
	"first_seen", "last_seen", "acknowledged_by", "acknowledged_at", "resolved_at", "material_request",
]


# --- v0.8 QA W-D6 — `first_seen` / `last_seen` never reached any client -------------------------
#
# `frappe.get_all` drops them silently: `DatabaseQuery.set_optional_columns` removes any field
# whose *name contains* one of the optional columns (`_user_tags`, `_comments`, `_assign`,
# `_liked_by`, **`_seen`**) when the table has no such column — and "first_seen" / "last_seen"
# both contain "_seen". The columns exist and hold the right values (filters and `order_by` on
# them work, which is why nothing else looked wrong); only the SELECT list lost them, so no
# screen could ever say "this has been low for three days". `tasks.check_heartbeat_staleness`
# already had to work around the same thing for `AWANZ Device Heartbeat.last_seen`.
#
# The query builder is not affected, so alert rows are read through it.
# ------------------------------------------------------------------------------------------------
def alert_rows(filters: dict[str, Any], order_by: Optional[str] = None, limit: Optional[int] = None) -> list[Any]:
	"""``AWANZ Stock Alert`` rows with every field in ``ALERT_FIELDS`` actually populated."""
	SA = frappe.qb.DocType("AWANZ Stock Alert")
	query = frappe.qb.from_(SA).select(*[SA[f] for f in ALERT_FIELDS])
	for field, value in (filters or {}).items():
		column = SA[field]
		if isinstance(value, (list, tuple)) and len(value) == 2:
			operator, operand = value[0], value[1]
			if str(operator).lower() == "in":
				query = query.where(column.isin(list(operand) or ["__none__"]))
			elif str(operator).lower() == "not in":
				query = query.where(column.notin(list(operand) or ["__none__"]))
			elif operator == "!=":
				query = query.where(column != operand)
			elif operator == ">":
				query = query.where(column > operand)
			elif operator == "<":
				query = query.where(column < operand)
			else:
				query = query.where(column == operand)
		else:
			query = query.where(column == value)
	for part in (order_by or "").split(","):
		part = part.strip()
		if not part:
			continue
		field, _, direction = part.partition(" ")
		column = SA[field]
		query = query.orderby(column, order=frappe.qb.desc if direction.strip().lower() == "desc" else frappe.qb.asc)
	if limit:
		query = query.limit(cint(limit))
	return query.run(as_dict=True)
# --- end v0.8 QA W-D6 ---


def _boutique_for_warehouse(warehouse: str) -> Optional[str]:
	return frappe.db.get_value("AWANZ Store", {"warehouse": warehouse}, "name")


def _actual_qty(item_code: str, warehouse: str) -> float:
	return flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty"))


# ---------------------------------------------------------------------------
# scan (scheduler, hourly) — idempotent
# ---------------------------------------------------------------------------
def low_stock_scan(notify: bool = True) -> dict[str, Any]:
	"""Create / refresh / resolve ``AWANZ Stock Alert`` rows from ``Item Reorder`` levels.

	Returns ``{checked, created: [name], updated: n, resolved: [name]}``. Only warehouses that
	belong to an enabled boutique are considered (plus any warehouse with a reorder level, so
	head-office stock rooms also alert).
	"""
	levels = frappe.get_all(
		"Item Reorder",
		fields=["parent as item_code", "warehouse", "warehouse_reorder_level", "warehouse_reorder_qty"],
		filters={"parenttype": "Item"},
	)
	disabled = set(frappe.get_all("Item", filters={"disabled": 1}, pluck="name")) if levels else set()
	created: list[str] = []
	resolved: list[str] = []
	updated = 0
	now = now_datetime()
	seen: set[tuple[str, str]] = set()
	for lv in levels:
		if lv.item_code in disabled or flt(lv.warehouse_reorder_level) <= 0:
			continue
		key = (lv.item_code, lv.warehouse)
		if key in seen:
			continue
		seen.add(key)
		qty = _actual_qty(lv.item_code, lv.warehouse)
		open_alert = frappe.db.get_value(
			"AWANZ Stock Alert",
			{"item_code": lv.item_code, "warehouse": lv.warehouse, "status": ("in", ("Open", "Acknowledged"))},
			["name", "qty"],
			as_dict=True,
		)
		if qty <= flt(lv.warehouse_reorder_level):
			if open_alert:
				if flt(open_alert.qty) != qty:
					frappe.db.set_value("AWANZ Stock Alert", open_alert.name, {"qty": qty, "last_seen": now, "reorder_level": flt(lv.warehouse_reorder_level)}, update_modified=False)
					updated += 1
				else:
					frappe.db.set_value("AWANZ Stock Alert", open_alert.name, "last_seen", now, update_modified=False)
				continue
			alert = frappe.get_doc(
				{
					"doctype": "AWANZ Stock Alert",
					"item_code": lv.item_code,
					"warehouse": lv.warehouse,
					"boutique": _boutique_for_warehouse(lv.warehouse),
					"status": "Open",
					"qty": qty,
					"reorder_level": flt(lv.warehouse_reorder_level),
					"reorder_qty": flt(lv.warehouse_reorder_qty),
					"first_seen": now,
					"last_seen": now,
				}
			)
			alert.flags.ignore_permissions = True
			alert.insert()
			created.append(alert.name)
		elif open_alert:
			frappe.db.set_value("AWANZ Stock Alert", open_alert.name, {"status": "Resolved", "resolved_at": now, "qty": qty}, update_modified=False)
			resolved.append(open_alert.name)

	# alerts whose reorder level was removed are resolved too
	stale = frappe.get_all("AWANZ Stock Alert", filters={"status": ("in", ("Open", "Acknowledged"))}, fields=["name", "item_code", "warehouse"])
	for row in stale:
		if (row.item_code, row.warehouse) not in seen:
			frappe.db.set_value("AWANZ Stock Alert", row.name, {"status": "Resolved", "resolved_at": now}, update_modified=False)
			resolved.append(row.name)

	if created and notify:
		_notify_new_alerts(created)
	if not frappe.flags.in_test:
		frappe.db.commit()
	_publish_alert_counts()
	return {"checked": len(seen), "created": created, "updated": updated, "resolved": resolved}


def _recipients_for(boutique: Optional[str]) -> list[str]:
	"""Managers of the boutique + every Head Office user (+ Regional when enabled)."""
	from maison_pos.awanz_pos.doctype.awanz_pos_settings.awanz_pos_settings import get_operations_settings

	users: set[str] = set()
	if boutique:
		users.update(frappe.get_all("AWANZ Associate", filters={"boutique": boutique, "role": "Manager", "enabled": 1}, pluck="user"))
	roles = ["AWANZ Head Office"]
	if get_operations_settings()["low_stock_notify_regional"]:
		roles.append("AWANZ Regional")
	users.update(frappe.get_all("Has Role", filters={"role": ("in", roles), "parenttype": "User"}, pluck="parent"))
	enabled = set(frappe.get_all("User", filters={"name": ("in", list(users)), "enabled": 1, "user_type": "System User"}, pluck="name")) if users else set()
	return sorted(u for u in enabled if u not in ("Administrator", "Guest"))


def _notify_new_alerts(names: list[str]) -> None:
	"""One Notification Log per user per boutique batch (desk bell), no e-mail (the digest does that)."""
	rows = frappe.get_all("AWANZ Stock Alert", filters={"name": ("in", names)}, fields=ALERT_FIELDS)
	by_boutique: dict[Optional[str], list] = {}
	for r in rows:
		by_boutique.setdefault(r.boutique, []).append(r)
	for boutique, alerts in by_boutique.items():
		subject = _("Low stock at {0}: {1} item(s)").format(boutique or _("Head office"), len(alerts))
		lines = [f"{a.item_name or a.item_code} ({a.item_code}): {flt(a.qty):g} left, level {flt(a.reorder_level):g}" for a in alerts[:12]]
		body = "<br>".join(lines)
		for user in _recipients_for(boutique):
			try:
				frappe.get_doc(
					{
						"doctype": "Notification Log",
						"for_user": user,
						"type": "Alert",
						"document_type": "AWANZ Stock Alert",
						"document_name": alerts[0].name,
						"subject": subject,
						"email_content": body,
					}
				).insert(ignore_permissions=True)
			except Exception:  # pragma: no cover - notifications must not break the scan
				frappe.log_error(frappe.get_traceback(), "AWANZ low stock notification")
		for a in alerts:
			frappe.db.set_value("AWANZ Stock Alert", a.name, "notified", 1, update_modified=False)


def _publish_alert_counts() -> None:
	try:
		from maison_pos.utils import DASHBOARD_ROOM

		frappe.publish_realtime("awanz_stock_alerts", {"open": open_alert_counts()}, room=DASHBOARD_ROOM, after_commit=True)
	except Exception:  # pragma: no cover
		pass


def open_alert_counts(boutiques: Optional[list[str]] = None) -> dict[str, int]:
	"""``{boutique: open+acknowledged alerts}`` for the dashboard tile / POS badge."""
	filters: dict[str, Any] = {"status": ("in", ("Open", "Acknowledged"))}
	if boutiques is not None:
		filters["boutique"] = ("in", boutiques or ["__none__"])
	rows = frappe.get_all("AWANZ Stock Alert", filters=filters, fields=["boutique", "count(name) as n"], group_by="boutique")
	return {(r.boutique or ""): cint(r.n) for r in rows}


def low_stock_digest() -> dict[str, Any]:
	"""Daily e-mail digest of open alerts to Head Office (and boutique managers for their store)."""
	from maison_pos.awanz_pos.doctype.awanz_pos_settings.awanz_pos_settings import get_operations_settings

	if not get_operations_settings()["low_stock_digest_enabled"]:
		return {"sent": 0, "skipped": "disabled"}
	rows = alert_rows({"status": ("in", ("Open", "Acknowledged"))}, order_by="boutique asc, item_code asc")  # v0.8 QA W-D6
	if not rows:
		return {"sent": 0}
	by_boutique: dict[Optional[str], list] = {}
	for r in rows:
		by_boutique.setdefault(r.boutique, []).append(r)
	# --- v0.8 QA W-D3 — one bad recipient used to kill every store's digest ---
	# `_send_digest` was called unguarded, so a site with no outgoing Email Account (which is how
	# this deployment ships) failed the head-office send with `OutgoingEmailError` and the whole
	# scheduled job was recorded Failed — no store manager got theirs either. Each send is now its
	# own attempt, and with no outgoing account configured the job reports that instead of raising
	# (there is nothing to retry until someone sets one up). `_notify_new_alerts` has always
	# guarded its inserts this way.
	if not _has_outgoing_email():
		return {"sent": 0, "alerts": len(rows), "skipped": "no outgoing email account", "boutiques": len([b for b in by_boutique if b])}
	sent = 0
	failed: list[str] = []
	ho = _recipients_for(None)
	if ho and _try_send_digest(ho, rows, _("AWANZ low stock digest — {0} open alert(s)").format(len(rows)), failed):
		sent += len(ho)
	for boutique, alerts in by_boutique.items():
		if not boutique:
			continue
		managers = [u for u in _recipients_for(boutique) if u not in ho]
		if managers and _try_send_digest(managers, alerts, _("{0}: {1} low-stock alert(s)").format(boutique, len(alerts)), failed, boutique):
			sent += len(managers)
	out: dict[str, Any] = {"sent": sent, "alerts": len(rows)}
	if failed:
		out["failed"] = failed
	return out


def _has_outgoing_email() -> bool:
	"""True when something on this site can actually send (an Email Account or a site-config SMTP)."""
	if frappe.db.exists("Email Account", {"enable_outgoing": 1}):
		return True
	return bool(frappe.conf.get("mail_server") or frappe.conf.get("mail_login"))


def _try_send_digest(recipients: list[str], rows: list, subject: str, failed: list[str], label: Optional[str] = None) -> bool:
	try:
		_send_digest(recipients, rows, subject)
		return True
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"AWANZ low stock digest ({label or 'head office'})")
		failed.append(label or "head office")
		return False
	# --- end v0.8 QA W-D3 ---


def _send_digest(recipients: list[str], rows: list, subject: str) -> None:
	table = "".join(
		f"<tr><td>{r.boutique or ''}</td><td>{r.item_code}</td><td>{r.item_name or ''}</td><td style='text-align:right'>{flt(r.qty):g}</td>"
		f"<td style='text-align:right'>{flt(r.reorder_level):g}</td><td>{r.status}</td></tr>"
		for r in rows
	)
	html = (
		f"<p>{subject}</p><table border='1' cellpadding='4' style='border-collapse:collapse'>"
		"<tr><th>Boutique</th><th>Item</th><th>Name</th><th>Qty</th><th>Level</th><th>Status</th></tr>"
		f"{table}</table><p><a href='{get_url_to_form('AWANZ Stock Alert', rows[0].name)}'>Open in desk</a></p>"
	)
	frappe.sendmail(recipients=recipients, subject=subject, message=html, delayed=True)


# ---------------------------------------------------------------------------
# POS / dashboard endpoints
# ---------------------------------------------------------------------------
@frappe.whitelist()
def alerts(boutique: Optional[str] = None, status: str = "open", limit: int = 200) -> dict[str, Any]:
	"""Alerts of *boutique* (scoped users: their own; unrestricted + empty boutique: every boutique).

	``status``: ``open`` (Open + Acknowledged), ``all`` or an exact status.
	"""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	if boutique or not is_unrestricted():
		boutiques = [assert_boutique_access(boutique)]
	else:
		boutiques = get_allowed_boutiques()
	filters: dict[str, Any] = {"boutique": ("in", boutiques or ["__none__"])}
	if status == "open":
		filters["status"] = ("in", ("Open", "Acknowledged"))
	elif status != "all":
		filters["status"] = status
	rows = alert_rows(filters, order_by="status asc, qty asc, item_code asc", limit=cint(limit) or 200)  # v0.8 QA W-D6
	return {
		"boutiques": boutiques,
		"alerts": rows,
		"open": sum(1 for r in rows if r.status in ("Open", "Acknowledged")),
		"counts": open_alert_counts(boutiques),
	}


@frappe.whitelist()
def acknowledge(alert: str) -> dict[str, Any]:
	"""Mark an alert Acknowledged (manager of the boutique or unrestricted)."""
	doc = frappe.get_doc("AWANZ Stock Alert", alert)
	assert_boutique_access(doc.boutique)
	if doc.status == "Open":
		doc.status = "Acknowledged"
		doc.acknowledged_by = frappe.session.user
		doc.acknowledged_at = now_datetime()
		doc.flags.ignore_permissions = True
		doc.save()
	_publish_alert_counts()
	return {"name": doc.name, "status": doc.status}


@frappe.whitelist()
def resolve(alert: str) -> dict[str, Any]:
	"""Manager+: close an alert by hand (the scan also resolves it automatically when stock returns)."""
	if not is_manager_or_above():
		frappe.throw(_("Only managers may resolve stock alerts"), frappe.PermissionError)
	doc = frappe.get_doc("AWANZ Stock Alert", alert)
	assert_boutique_access(doc.boutique)
	if doc.status != "Resolved":
		doc.status = "Resolved"
		doc.resolved_at = now_datetime()
		doc.flags.ignore_permissions = True
		doc.save()
	_publish_alert_counts()
	return {"name": doc.name, "status": doc.status}


@frappe.whitelist()
def request_transfer(item: str, to: str, qty: float, from_warehouse: Optional[str] = None, alert: Optional[str] = None, reason: Optional[str] = None) -> dict[str, Any]:
	"""Raise a Material Request (Material Transfer) of *qty* × *item* into boutique *to*.

	``from_warehouse`` is optional — a boutique code or a warehouse name (Head Office picks the
	source when approving). Associates may only request into their own boutique. Links the
	request to *alert* when given.
	"""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	to_boutique = assert_boutique_access(to)
	qty = flt(qty)
	if qty <= 0:
		frappe.throw(_("Quantity must be positive"), frappe.ValidationError)
	if not frappe.db.exists("Item", item):
		frappe.throw(_("Item {0} does not exist").format(item), frappe.DoesNotExistError)
	b = frappe.get_cached_doc("AWANZ Store", to_boutique)
	source = None
	if from_warehouse:
		if frappe.db.exists("AWANZ Store", from_warehouse):
			source = frappe.db.get_value("AWANZ Store", from_warehouse, "warehouse")
		elif frappe.db.exists("Warehouse", from_warehouse):
			source = from_warehouse
		else:
			frappe.throw(_("Unknown source {0}").format(from_warehouse), frappe.DoesNotExistError)
		if source == b.warehouse:
			frappe.throw(_("Source and destination warehouse are the same"), frappe.ValidationError)
	mr = frappe.get_doc(
		{
			"doctype": "Material Request",
			"material_request_type": "Material Transfer",
			"company": b.company,
			"transaction_date": nowdate(),
			"schedule_date": nowdate(),
			"set_from_warehouse": source,
			"set_warehouse": b.warehouse,
			"title": _("Transfer {0} to {1}").format(item, to_boutique),
			"items": [
				{
					"item_code": item,
					"qty": qty,
					"schedule_date": nowdate(),
					"warehouse": b.warehouse,
					"from_warehouse": source,
					"description": (reason or "")[:140] or None,
				}
			],
		}
	)
	mr.flags.ignore_permissions = True
	mr.insert()
	if alert and frappe.db.exists("AWANZ Stock Alert", alert):
		frappe.db.set_value("AWANZ Stock Alert", alert, "material_request", mr.name, update_modified=False)
	return {"material_request": mr.name, "status": mr.status, "item": item, "qty": qty, "to_warehouse": b.warehouse, "from_warehouse": source}


# ---------------------------------------------------------------------------
# cycle count
# ---------------------------------------------------------------------------
def _expected(boutique: str) -> dict[str, Any]:
	warehouse = frappe.db.get_value("AWANZ Store", boutique, "warehouse")
	serial_rows = frappe.get_all("Serial No", filters={"warehouse": warehouse, "status": "Active"}, fields=["name", "item_code"], order_by="item_code, name")
	serials: dict[str, list[str]] = {}
	for r in serial_rows:
		serials.setdefault(r.item_code, []).append(r.name)
	bins = frappe.get_all("Bin", filters={"warehouse": warehouse, "actual_qty": (">", 0)}, fields=["item_code", "actual_qty"])
	qty = {b.item_code: flt(b.actual_qty) for b in bins if b.item_code not in serials}
	return {"warehouse": warehouse, "serials": serials, "qty": qty}


@frappe.whitelist()
def cycle_count_expected(boutique: Optional[str] = None) -> dict[str, Any]:
	"""What the warehouse should contain: ``{warehouse, serials: {item: [serial]}, qty: {item: n}, items: {...}}``."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	exp = _expected(boutique)
	codes = sorted(set(exp["serials"]) | set(exp["qty"]))
	names = {r.name: r.item_name for r in frappe.get_all("Item", filters={"name": ("in", codes or ["__none__"])}, fields=["name", "item_name"])}
	return {"boutique": boutique, **exp, "items": names, "as_of": now_datetime().isoformat()}


@frappe.whitelist()
def submit_cycle_count(boutique: str, serials: Any = None, qty: Any = None, device_id: Optional[str] = None, notes: Optional[str] = None) -> dict[str, Any]:
	"""Compare scanned *serials* (list) and counted *qty* (``{item_code: n}``) with the warehouse.

	Creates a ``AWANZ Cycle Count`` (Draft) and, when qty items differ, a **draft** Stock
	Reconciliation for a manager to review. Serialized discrepancies are reported as
	``missing`` (expected, not scanned = unaccounted) and ``unexpected`` (scanned but not in
	this warehouse) — serial corrections are deliberate manual actions in the desk.
	"""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	if isinstance(serials, str):
		serials = json.loads(serials or "[]")
	if isinstance(qty, str):
		qty = json.loads(qty or "{}")
	scanned = sorted({str(s).strip() for s in (serials or []) if str(s).strip()})
	counted = {str(k): flt(v) for k, v in (qty or {}).items()}
	exp = _expected(boutique)
	expected_serials = {s: item for item, lst in exp["serials"].items() for s in lst}
	missing = [{"serial_no": s, "item_code": item} for s, item in sorted(expected_serials.items()) if s not in scanned]
	unexpected = []
	for s in scanned:
		if s in expected_serials:
			continue
		info = frappe.db.get_value("Serial No", s, ["item_code", "warehouse", "status"], as_dict=True)
		unexpected.append({"serial_no": s, "item_code": info.item_code if info else None, "warehouse": info.warehouse if info else None, "status": info.status if info else "not_found"})
	diffs = []
	for item, expected_qty in sorted(exp["qty"].items()):
		if item in counted and flt(counted[item]) != expected_qty:
			diffs.append({"item_code": item, "expected": expected_qty, "counted": flt(counted[item]), "diff": flt(counted[item]) - expected_qty})
	for item, n in sorted(counted.items()):
		if item not in exp["qty"] and item not in exp["serials"] and n > 0 and frappe.db.exists("Item", item):
			diffs.append({"item_code": item, "expected": 0.0, "counted": n, "diff": n})

	assoc = get_associate()
	cc = frappe.get_doc(
		{
			"doctype": "AWANZ Cycle Count",
			"boutique": boutique,
			"warehouse": exp["warehouse"],
			"counted_at": now_datetime(),
			"associate": assoc["name"] if assoc else None,
			"device_id": device_id,
			"status": "Draft",
			"expected_serials": len(expected_serials),
			"scanned_serials": len(scanned),
			"missing_serials": json.dumps(missing),
			"unexpected_serials": json.dumps(unexpected),
			"qty_differences": json.dumps(diffs),
			"counts": json.dumps({"serials": scanned, "qty": counted}),
			"notes": notes,
		}
	)
	cc.flags.ignore_permissions = True
	cc.insert()

	recon = None
	if diffs:
		company = frappe.db.get_value("AWANZ Store", boutique, "company")
		sr = frappe.get_doc(
			{
				"doctype": "Stock Reconciliation",
				"purpose": "Stock Reconciliation",
				"company": company,
				"set_warehouse": exp["warehouse"],
				"posting_date": nowdate(),
				"posting_time": nowtime(),
				"set_posting_time": 1,
				"items": [{"item_code": d["item_code"], "warehouse": exp["warehouse"], "qty": d["counted"]} for d in diffs],
			}
		)
		sr.flags.ignore_permissions = True
		# ERPNext's get_stock_balance_for() checks write permission on Stock Reconciliation explicitly
		# (ignoring ignore_permissions); the draft is created on behalf of the associate by the system
		# and reviewed by a manager in the desk, so insert it as Administrator.
		user = frappe.session.user
		try:
			frappe.set_user("Administrator")
			sr.owner = user
			sr.insert()
			# v0.8 QA W-D5 — Frappe stamps `owner` with `frappe.session.user` on insert, which is
			# Administrator here (the draft is created on the associate's behalf, see above), so the
			# manager reviewing it saw "Administrator" as the counter. Put the real user back.
			frappe.db.set_value("Stock Reconciliation", sr.name, "owner", user, update_modified=False)
			sr.owner = user
			recon = sr.name
			# Stock Reconciliation has no remarks field: the provenance goes in a comment, where the
			# reviewing manager reads it on the document itself
			frappe.get_doc(
				{
					"doctype": "Comment",
					"comment_type": "Info",
					"reference_doctype": "Stock Reconciliation",
					"reference_name": sr.name,
					"content": _("AWANZ cycle count {0} at {1} — counted by {2}").format(cc.name, boutique, user),
				}
			).insert(ignore_permissions=True)
			cc.db_set("stock_reconciliation", recon, update_modified=False)
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"AWANZ cycle count {cc.name}: stock reconciliation draft")
		finally:
			frappe.set_user(user)
	return {
		"cycle_count": cc.name,
		"warehouse": exp["warehouse"],
		"expected_serials": len(expected_serials),
		"scanned_serials": len(scanned),
		"missing": missing,
		"unexpected": unexpected,
		"qty_differences": diffs,
		"stock_reconciliation": recon,
		"clean": not missing and not unexpected and not diffs,
	}


# ---------------------------------------------------------------------------
# v0.6 O — replenishment requests + receiving at the store
# ---------------------------------------------------------------------------
@frappe.whitelist()
def replenish(boutique: Optional[str] = None, lines: Any = None, reason: Optional[str] = None, priority: Optional[str] = None, alert: Optional[str] = None, item: Optional[str] = None, qty: Optional[float] = None) -> dict[str, Any]:
	"""Create a **Replenishment Request** (AWANZ Replenishment Request + draft Material Request,
	type Material Transfer, from the main warehouse) for *boutique*.

	``lines = [{item_code, qty, alert?}]`` — or the one-tap form ``item`` + ``qty`` (+ ``alert``) from
	the low-stock list. Managers / associates may only request into their own store.
	"""
	from maison_pos.api.shipping import create_request, request_dict

	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	if isinstance(lines, str):
		lines = json.loads(lines or "[]")
	lines = list(lines or [])
	if item:
		lines.append({"item_code": item, "qty": flt(qty) or flt(frappe.db.get_value("AWANZ Stock Alert", alert, "reorder_qty") if alert else 0) or 1, "alert": alert})
	req = create_request(boutique, lines, reason=reason, priority=priority)
	return {"request": request_dict(req), "material_request": req.material_request, "name": req.name}


@frappe.whitelist()
def replenishment_requests(boutique: Optional[str] = None, status: str = "all", limit: int = 50) -> dict[str, Any]:
	"""Requests of the store (any status by default) for the POS Receive screen."""
	from maison_pos.api.shipping import requests_list

	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	return requests_list(status=status, boutique=boutique, limit=limit)


@frappe.whitelist()
def inbound(boutique: Optional[str] = None) -> dict[str, Any]:
	"""Everything on its way to the store: warehouse shipments (Shipped) + vendor POs shipped direct."""
	from maison_pos.api.shipping import open_purchase_orders, shipment_dict

	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	b = frappe.get_cached_doc("AWANZ Store", boutique)
	names = frappe.get_all("AWANZ Shipment", filters={"boutique": boutique, "status": "Shipped"}, pluck="name", order_by="shipped_at asc")
	shipments = [shipment_dict(frappe.get_doc("AWANZ Shipment", n)) for n in names]
	recent_names = frappe.get_all("AWANZ Shipment", filters={"boutique": boutique, "status": "Received"}, pluck="name", order_by="received_at desc", limit=10)
	recent = [shipment_dict(frappe.get_doc("AWANZ Shipment", n), with_lines=False) for n in recent_names]
	pending = frappe.get_all("AWANZ Shipment", filters={"boutique": boutique, "status": ("in", ("Pending", "Picking", "Packed"))}, fields=["name", "status", "priority", "creation", "carrier", "service"], order_by="creation asc")
	return {
		"boutique": boutique,
		"warehouse": b.warehouse,
		"shipments": shipments,
		"preparing": pending,
		"purchase_orders": open_purchase_orders(b.warehouse),
		"recent": recent,
		"open_requests": frappe.db.count("AWANZ Replenishment Request", {"boutique": boutique, "status": "Pending Approval"}),
		"as_of": now_datetime().isoformat(),
	}


def _post_receipt_transfer(sh, rows: list[dict], to_warehouse: str, remark: str) -> Optional[str]:
	if not rows:
		return None
	company = frappe.db.get_value("Warehouse", to_warehouse, "company")
	se = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Transfer",
			"purpose": "Material Transfer",
			"company": company,
			"from_warehouse": sh.transit_warehouse,
			"to_warehouse": to_warehouse,
			"posting_date": nowdate(),
			"posting_time": nowtime(),
			"set_posting_time": 1,
			"remarks": remark,
			"items": [{"item_code": r["item_code"], "qty": r["qty"], "s_warehouse": sh.transit_warehouse, "t_warehouse": to_warehouse} for r in rows],
		}
	)
	se.flags.ignore_permissions = True
	se.insert()
	se.submit()
	return se.name


@frappe.whitelist()
def receive_shipment(shipment: str, lines: Any = None, final: int = 1, device_id: Optional[str] = None, notes: Optional[str] = None) -> dict[str, Any]:
	"""Confirm receipt of a warehouse shipment at the store (scan / count).

	``lines = [{item_code, received_qty, damaged_qty?}]`` — absent lines count as received in full
	when ``final`` (default), untouched otherwise (partial receipt; call again later). Posts
	``In Transit → store`` for intact units and ``In Transit → Damaged`` for damaged ones; short /
	over / damaged quantities are written on the shipment lines and raise one
	``AWANZ Receiving Discrepancy`` per line for the warehouse admin.
	"""
	from maison_pos.api.shipping import publish_wall, shipment_dict

	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	sh = frappe.get_doc("AWANZ Shipment", shipment)
	assert_boutique_access(sh.boutique)
	if sh.status != "Shipped":
		frappe.throw(_("Shipment {0} is {1}, not in transit").format(shipment, sh.status), frappe.ValidationError)
	if isinstance(lines, str):
		lines = json.loads(lines or "[]")
	counted: dict[str, dict[str, float]] = {}
	for raw in lines or []:
		code = raw.get("item_code") or raw.get("item")
		if not code:
			continue
		counted[code] = {"received": flt(raw.get("received_qty", raw.get("qty"))), "damaged": flt(raw.get("damaged_qty"))}
	final = cint(final)
	b = frappe.get_cached_doc("AWANZ Store", sh.boutique)
	damaged_wh = b.get("damaged_warehouse")
	good_rows: list[dict] = []
	damaged_rows: list[dict] = []
	discrepancies: list[str] = []
	for line in sh.lines:
		shipped = flt(line.shipped_qty) or flt(line.qty)
		already = flt(line.received_qty) + flt(line.damaged_qty)
		if line.item_code in counted:
			got = counted[line.item_code]["received"]
			dmg = counted[line.item_code]["damaged"]
		elif final:
			got, dmg = max(0.0, shipped - already), 0.0
		else:
			continue
		if got < 0 or dmg < 0:
			frappe.throw(_("Negative quantity for {0}").format(line.item_code), frappe.ValidationError)
		remaining_in_transit = max(0.0, shipped - already)
		# what can physically leave the transit warehouse
		from_transit_good = min(got, remaining_in_transit)
		from_transit_dmg = min(dmg, max(0.0, remaining_in_transit - from_transit_good))
		if from_transit_good > 0:
			good_rows.append({"item_code": line.item_code, "qty": from_transit_good})
		if from_transit_dmg > 0:
			damaged_rows.append({"item_code": line.item_code, "qty": from_transit_dmg})
		line.received_qty = flt(line.received_qty) + got
		line.damaged_qty = flt(line.damaged_qty) + dmg
		total = flt(line.received_qty) + flt(line.damaged_qty)
		line.over_qty = max(0.0, total - shipped)
		line.short_qty = max(0.0, shipped - total) if final else 0.0
		if final or got or dmg:
			for kind, qty in (("Short", line.short_qty if final else 0.0), ("Damaged", dmg), ("Over", line.over_qty)):
				if flt(qty) > 0 and not (kind == "Over" and frappe.db.exists("AWANZ Receiving Discrepancy", {"shipment": sh.name, "item_code": line.item_code, "type": "Over", "status": "Open"})):
					d = frappe.get_doc(
						{
							"doctype": "AWANZ Receiving Discrepancy",
							"shipment": sh.name,
							"boutique": sh.boutique,
							"item_code": line.item_code,
							"type": kind,
							"status": "Open",
							"shipped_qty": shipped,
							"received_qty": flt(line.received_qty),
							"damaged_qty": flt(line.damaged_qty),
							"short_qty": flt(line.short_qty),
							"over_qty": flt(line.over_qty),
							"reported_by": frappe.session.user,
							"reported_at": now_datetime(),
							"notes": notes,
						}
					)
					d.flags.ignore_permissions = True
					d.insert()
					discrepancies.append(d.name)
	se_good = _post_receipt_transfer(sh, good_rows, sh.to_warehouse, f"AWANZ Shipment {sh.name} received at {sh.boutique}")
	se_dmg = None
	if damaged_rows:
		if damaged_wh:
			se_dmg = _post_receipt_transfer(sh, damaged_rows, damaged_wh, f"AWANZ Shipment {sh.name} damaged on arrival at {sh.boutique}")
		else:
			# no Damaged warehouse on this boutique: leave the units in transit, the discrepancy tracks them
			pass
	# --- v0.8 QA W-N2 — every leg of a multi-leg receipt is linked ---
	# The Link field can only hold one Stock Entry, so a partial receipt followed by the final one
	# left the later legs findable only through the Stock Entry remark. The Link keeps the first
	# leg (what every existing caller reads); `receipt_entries` lists them all, in order.
	legs = [n for n in (sh.receipt_entries or "").split("\n") if n.strip()]
	for entry in (se_good, se_dmg):
		if entry and entry not in legs:
			legs.append(entry)
	sh.receipt_entries = "\n".join(legs)
	if se_good and not sh.stock_entry_receive:
		sh.stock_entry_receive = se_good
	if se_dmg:
		sh.stock_entry_damaged = se_dmg
	# --- end v0.8 QA W-N2 ---
	if final:
		sh.status = "Received"
		sh.received_at = now_datetime()
		sh.received_by = frappe.session.user
	if notes:
		sh.notes = ((sh.notes or "") + "\n" + notes).strip()
	sh.flags.ignore_permissions = True
	sh.save()
	if sh.replenishment_request and final:
		frappe.db.set_value("AWANZ Replenishment Request", sh.replenishment_request, "status", "Approved", update_modified=False)
	publish_wall("received" if final else "partial", sh.name, boutique=sh.boutique, discrepancies=discrepancies)
	if discrepancies:
		for admin in frappe.get_all("Has Role", filters={"role": "AWANZ Warehouse Admin", "parenttype": "User"}, pluck="parent"):
			try:
				frappe.get_doc({"doctype": "Notification Log", "for_user": admin, "type": "Alert", "document_type": "AWANZ Receiving Discrepancy", "document_name": discrepancies[0], "subject": _("{0}: {1} receiving discrepancy(ies) on {2}").format(sh.boutique, len(discrepancies), sh.name)}).insert(ignore_permissions=True)
			except Exception:
				pass
	out = shipment_dict(sh)
	out.update({"stock_entry_receive": se_good, "stock_entry_damaged": se_dmg, "receipt_entries": legs, "discrepancies": discrepancies, "final": bool(final)})
	return out


@frappe.whitelist()
def receive_po(po: str, lines: Any = None, boutique: Optional[str] = None) -> dict[str, Any]:
	"""Vendor-direct delivery at the store: Purchase Receipt against the PO (``lines = [{item_code, qty}]``)."""
	from maison_pos.api.shipping import receive_purchase_order

	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	warehouse = frappe.db.get_value("AWANZ Store", boutique, "warehouse")
	if frappe.db.get_value("Purchase Order", po, "set_warehouse") != warehouse:
		frappe.throw(_("Purchase Order {0} is not addressed to {1}").format(po, boutique), frappe.PermissionError)
	return receive_purchase_order(po, lines, warehouse=warehouse)
