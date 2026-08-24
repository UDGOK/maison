"""Employee management (v0.4 section C): clock-in/out, shifts, commissions, payroll exports.

HRMS is optional. When the ``hrms`` app is installed the clock-in/out creates ``Employee
Checkin`` rows (IN / OUT, ``device_id`` = boutique) and commissions can be pushed to
``Additional Salary``; without it everything still works on the ``AWANZ Shift`` /
``AWANZ Commission Entry`` doctypes (feature detection via :func:`hrms_installed`).
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, date_diff, flt, get_datetime, getdate, now_datetime, nowdate, time_diff_in_seconds

from maison_pos.awanz_pos.doctype.awanz_commission_rule.awanz_commission_rule import active_rules, match_rule
from maison_pos.scoping import (
	ALL_AWANZ_ROLES,
	assert_boutique_access,
	assert_roles,
	get_associate,
	get_user_boutique,
	is_manager_or_above,
	is_unrestricted,
)

PAYROLL_FORMATS = ("gusto", "adp", "quickbooks", "hrms")
COMMISSION_COMPONENT = "AWANZ Commission"


# ---------------------------------------------------------------------------
# feature detection
# ---------------------------------------------------------------------------
def hrms_installed() -> bool:
	"""True when the Frappe HRMS app is installed on this site."""
	return "hrms" in frappe.get_installed_apps() and bool(frappe.db.exists("DocType", "Employee Checkin"))


def employee_for_associate(associate: str) -> Optional[str]:
	"""Employee linked to the AWANZ Associate (explicit link, else match by user_id)."""
	emp = frappe.db.get_value("AWANZ Associate", associate, "employee")
	if emp and frappe.db.exists("Employee", emp):
		return emp
	if frappe.db.exists("DocType", "Employee"):
		return frappe.db.get_value("Employee", {"user_id": associate, "status": "Active"}, "name")
	return None


# ---------------------------------------------------------------------------
# shifts / clock-in
# ---------------------------------------------------------------------------
def _open_shift(associate: str) -> Optional[dict[str, Any]]:
	rows = frappe.get_all(
		"AWANZ Shift",
		filters={"associate": associate, "status": ("in", ("On shift", "On break"))},
		fields=["name", "boutique", "clock_in", "status", "break_started", "break_minutes", "device_id", "employee"],
		order_by="clock_in desc",
		limit=1,
	)
	return rows[0] if rows else None


def _assert_self_or_manager(associate: str) -> None:
	user = frappe.session.user
	if user == associate or is_manager_or_above(user):
		return
	frappe.throw(_("You may only clock in or out for yourself"), frappe.PermissionError)


def _hrms_checkin(employee: Optional[str], log_type: str, boutique: str, device_id: Optional[str], ts) -> Optional[str]:
	if not employee or not hrms_installed():
		return None
	try:
		doc = frappe.get_doc(
			{
				"doctype": "Employee Checkin",
				"employee": employee,
				"log_type": log_type,
				"time": ts,
				"device_id": f"{boutique}:{device_id or 'POS'}",
				"skip_auto_attendance": 0,
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		return doc.name
	except Exception:
		frappe.log_error(frappe.get_traceback(), "awanz hrms checkin")
		return None


def _shift_payload(shift: Optional[dict[str, Any]]) -> dict[str, Any]:
	if not shift:
		return {"on_shift": False, "shift": None}
	worked = int(time_diff_in_seconds(now_datetime(), get_datetime(shift["clock_in"])) // 60) - cint(shift.get("break_minutes"))
	return {
		"on_shift": True,
		"shift": {
			"name": shift["name"],
			"boutique": shift["boutique"],
			"clock_in": str(shift["clock_in"]),
			"status": shift["status"],
			"break_started": str(shift["break_started"]) if shift.get("break_started") else None,
			"break_minutes": cint(shift.get("break_minutes")),
			"worked_minutes": max(worked, 0),
			"employee": shift.get("employee"),
		},
	}


@frappe.whitelist()
def clock_in(associate: str, boutique: str, device_id: Optional[str] = None) -> dict[str, Any]:
	"""Start a shift for *associate* at *boutique* (idempotent: returns the open shift if any)."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	_assert_self_or_manager(associate)
	boutique = assert_boutique_access(boutique)
	if not frappe.db.exists("AWANZ Associate", {"name": associate, "enabled": 1}):
		frappe.throw(_("Associate {0} not found").format(associate), frappe.DoesNotExistError)
	existing = _open_shift(associate)
	if existing:
		return {**_shift_payload(existing), "created": False, "hrms": hrms_installed()}
	ts = now_datetime()
	employee = employee_for_associate(associate)
	doc = frappe.get_doc(
		{
			"doctype": "AWANZ Shift",
			"associate": associate,
			"employee": employee,
			"boutique": boutique,
			"clock_in": ts,
			"status": "On shift",
			"device_id": device_id,
			"checkin_in": _hrms_checkin(employee, "IN", boutique, device_id, ts),
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	frappe.publish_realtime("awanz_shift", {"associate": associate, "boutique": boutique, "status": "On shift"}, room="awanz_dashboard")
	return {**_shift_payload(doc.as_dict()), "created": True, "hrms": hrms_installed()}


@frappe.whitelist()
def clock_out(associate: str, device_id: Optional[str] = None) -> dict[str, Any]:
	"""End the open shift (closes an open break first). No-op when not clocked in."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	_assert_self_or_manager(associate)
	shift = _open_shift(associate)
	if not shift:
		return {"on_shift": False, "shift": None, "closed": False}
	doc = frappe.get_doc("AWANZ Shift", shift["name"])
	ts = now_datetime()
	if doc.status == "On break" and doc.break_started:
		doc.break_minutes = cint(doc.break_minutes) + int(time_diff_in_seconds(ts, get_datetime(doc.break_started)) // 60)
		doc.break_started = None
	doc.clock_out = ts
	doc.worked_minutes = max(int(time_diff_in_seconds(ts, get_datetime(doc.clock_in)) // 60) - cint(doc.break_minutes), 0)
	doc.status = "Off shift"
	doc.checkin_out = _hrms_checkin(doc.employee, "OUT", doc.boutique, device_id or doc.device_id, ts)
	doc.flags.ignore_permissions = True
	doc.save()
	frappe.publish_realtime("awanz_shift", {"associate": associate, "boutique": doc.boutique, "status": "Off shift"}, room="awanz_dashboard")
	return {
		"on_shift": False,
		"closed": True,
		"shift": {"name": doc.name, "clock_in": str(doc.clock_in), "clock_out": str(doc.clock_out), "worked_minutes": doc.worked_minutes, "break_minutes": doc.break_minutes},
	}


@frappe.whitelist()
def toggle_break(associate: str) -> dict[str, Any]:
	"""Start or end a break on the open shift."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	_assert_self_or_manager(associate)
	shift = _open_shift(associate)
	if not shift:
		frappe.throw(_("Not clocked in"), frappe.ValidationError)
	doc = frappe.get_doc("AWANZ Shift", shift["name"])
	ts = now_datetime()
	if doc.status == "On break":
		doc.break_minutes = cint(doc.break_minutes) + int(time_diff_in_seconds(ts, get_datetime(doc.break_started)) // 60)
		doc.break_started = None
		doc.status = "On shift"
	else:
		doc.break_started = ts
		doc.status = "On break"
	doc.flags.ignore_permissions = True
	doc.save()
	return _shift_payload(doc.as_dict())


@frappe.whitelist()
def shift_status(associate: Optional[str] = None) -> dict[str, Any]:
	"""Open shift for *associate* (default: the caller's associate record)."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	associate = associate or (get_associate() or {}).get("name")
	if not associate:
		return {"on_shift": False, "shift": None, "hrms": hrms_installed()}
	_assert_self_or_manager(associate)
	return {**_shift_payload(_open_shift(associate)), "hrms": hrms_installed()}


@frappe.whitelist()
def on_shift(boutique: str) -> list[dict[str, Any]]:
	"""Manager view: who is clocked in at *boutique* right now."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	rows = frappe.get_all(
		"AWANZ Shift",
		filters={"boutique": boutique, "status": ("in", ("On shift", "On break"))},
		fields=["name", "associate", "associate_name", "boutique", "clock_in", "status", "break_minutes", "break_started", "device_id", "employee"],
		order_by="clock_in asc",
	)
	return [_shift_payload(r)["shift"] | {"associate": r.associate, "associate_name": r.associate_name} for r in rows]


@frappe.whitelist()
def shifts(boutique: str, from_date: Optional[str] = None, to_date: Optional[str] = None) -> list[dict[str, Any]]:
	"""Manager+: shift history for a boutique and period (timesheet)."""
	assert_roles("AWANZ Manager", "AWANZ Regional", "AWANZ Head Office", "System Manager")
	boutique = assert_boutique_access(boutique)
	to_date = getdate(to_date or nowdate())
	from_date = getdate(from_date) if from_date else add_days(to_date, -14)
	return frappe.get_all(
		"AWANZ Shift",
		filters={"boutique": boutique, "clock_in": ("between", (f"{from_date} 00:00:00", f"{to_date} 23:59:59"))},
		fields=["name", "associate", "associate_name", "employee", "clock_in", "clock_out", "status", "break_minutes", "worked_minutes"],
		order_by="clock_in desc",
	)


# ---------------------------------------------------------------------------
# commissions
# ---------------------------------------------------------------------------
def _line_base(row) -> float:
	"""Net (after line discount) amount, in company currency. Negative on returns."""
	return flt(row.get("base_net_amount") or row.get("net_amount") or row.get("amount"))


def create_commission_entries(doc) -> list[str]:
	"""Create ``AWANZ Commission Entry`` rows for every line of a submitted POS invoice.

	Returns the created names. Returns (``is_return``) produce reversal rows (negative
	amounts, ``is_reversal=1``). Idempotent per invoice.
	"""
	if not doc.get("is_pos") or not doc.get("maison_associate"):
		return []
	if frappe.db.exists("AWANZ Commission Entry", {"sales_invoice": doc.name, "reversal_of": ("is", "not set")}):
		return []
	associate = doc.maison_associate
	if doc.get("is_return") and doc.get("return_against"):
		# a return reverses the commission of whoever made the original sale, not of the manager voiding it
		associate = frappe.db.get_value("Sales Invoice", doc.return_against, "maison_associate") or associate
	assoc = frappe.db.get_value("AWANZ Associate", associate, ["name", "role", "boutique", "employee"], as_dict=True)
	if not assoc:
		return []
	rules = active_rules(doc.posting_date)
	if not rules:
		return []
	employee = assoc.employee or employee_for_associate(assoc.name)
	created: list[str] = []
	for row in doc.items:
		item = frappe.db.get_value("Item", row.item_code, ["item_group", "maison_department"], as_dict=True) or {}
		rule = match_rule(rules, boutique=doc.get("maison_boutique"), role=assoc.role, item_group=item.get("item_group"), department=item.get("maison_department"))
		if not rule or flt(rule["rate_percent"]) <= 0:
			continue
		base = _line_base(row)
		if not base:
			continue
		amount = flt(base * flt(rule["rate_percent"]) / 100.0, 2)
		entry = frappe.get_doc(
			{
				"doctype": "AWANZ Commission Entry",
				"sales_invoice": doc.name,
				"posting_date": doc.posting_date,
				"associate": assoc.name,
				"employee": employee,
				"boutique": doc.get("maison_boutique"),
				"item_code": row.item_code,
				"item_group": item.get("item_group"),
				"department": item.get("maison_department"),
				"rule": rule["name"],
				"base_amount": base,
				"rate_percent": flt(rule["rate_percent"]),
				"commission_amount": amount,
				"is_reversal": 1 if doc.get("is_return") else 0,
				"status": "Open",
			}
		)
		entry.flags.ignore_permissions = True
		entry.insert()
		created.append(entry.name)
	return created


def reverse_commission_entries(doc) -> list[str]:
	"""On cancel: add a mirror (negative) row for every entry of the invoice not yet reversed."""
	entries = frappe.get_all(
		"AWANZ Commission Entry",
		filters={"sales_invoice": doc.name, "reversal_of": ("is", "not set")},
		fields=["name", "associate", "employee", "boutique", "item_code", "item_group", "department", "rule", "base_amount", "rate_percent", "commission_amount"],
	)
	created = []
	for e in entries:
		if frappe.db.exists("AWANZ Commission Entry", {"reversal_of": e.name}):
			continue
		rev = frappe.get_doc(
			{
				"doctype": "AWANZ Commission Entry",
				"sales_invoice": doc.name,
				"posting_date": nowdate(),
				"associate": e.associate,
				"employee": e.employee,
				"boutique": e.boutique,
				"item_code": e.item_code,
				"item_group": e.item_group,
				"department": e.department,
				"rule": e.rule,
				"base_amount": -flt(e.base_amount),
				"rate_percent": e.rate_percent,
				"commission_amount": -flt(e.commission_amount),
				"is_reversal": 1,
				"reversal_of": e.name,
				"status": "Open",
			}
		)
		rev.flags.ignore_permissions = True
		rev.insert()
		created.append(rev.name)
	return created


def on_invoice_submit(doc, method: Optional[str] = None) -> None:
	"""hooks.doc_events Sales Invoice on_submit (grouped with the v0.4 HR glue)."""
	if not doc.get("is_pos"):
		return
	try:
		create_commission_entries(doc)
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"awanz commission {doc.name}")


def on_invoice_cancel(doc, method: Optional[str] = None) -> None:
	if not doc.get("is_pos"):
		return
	try:
		reverse_commission_entries(doc)
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"awanz commission reversal {doc.name}")


def _period(from_date: Optional[str], to_date: Optional[str]) -> tuple[Any, Any]:
	to_date = getdate(to_date or nowdate())
	from_date = getdate(from_date) if from_date else getdate(to_date.replace(day=1))
	if date_diff(to_date, from_date) < 0:
		frappe.throw(_("from_date must be before to_date"), frappe.ValidationError)
	return from_date, to_date


def _commission_filters(from_date, to_date, boutique: Optional[str], associate: Optional[str], status: Optional[str]) -> dict[str, Any]:
	filters: dict[str, Any] = {"posting_date": ("between", (from_date, to_date))}
	if boutique:
		filters["boutique"] = boutique
	if associate:
		filters["associate"] = associate
	if status:
		filters["status"] = status
	return filters


@frappe.whitelist()
def commission_statement(
	from_date: Optional[str] = None,
	to_date: Optional[str] = None,
	boutique: Optional[str] = None,
	associate: Optional[str] = None,
	status: Optional[str] = None,
) -> dict[str, Any]:
	"""Commission statement per associate for a period (default: month to date).

	Associates see only their own rows; managers their boutique; HQ/Regional everything.
	"""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	from_date, to_date = _period(from_date, to_date)
	user = frappe.session.user
	if not is_unrestricted(user):
		if is_manager_or_above(user):
			boutique = assert_boutique_access(boutique or get_user_boutique(user))
		else:
			associate = (get_associate(user) or {}).get("name") or "__none__"
			boutique = None
	rows = frappe.get_all(
		"AWANZ Commission Entry",
		filters=_commission_filters(from_date, to_date, boutique, associate, status),
		fields=["name", "sales_invoice", "posting_date", "associate", "associate_name", "employee", "boutique", "item_code", "item_group", "department", "rule", "base_amount", "rate_percent", "commission_amount", "is_reversal", "status"],
		order_by="associate asc, posting_date asc, name asc",
	)
	by_assoc: dict[str, dict[str, Any]] = {}
	for r in rows:
		a = by_assoc.setdefault(
			r.associate,
			{"associate": r.associate, "associate_name": r.associate_name, "employee": r.employee, "boutique": r.boutique, "sales": 0.0, "commission": 0.0, "entries": 0, "reversals": 0},
		)
		a["sales"] = flt(a["sales"] + flt(r.base_amount), 2)
		a["commission"] = flt(a["commission"] + flt(r.commission_amount), 2)
		a["entries"] += 1
		if r.is_reversal:
			a["reversals"] += 1
	return {
		"from_date": str(from_date),
		"to_date": str(to_date),
		"boutique": boutique,
		"associates": sorted(by_assoc.values(), key=lambda x: x["associate"]),
		"entries": rows,
		"total_commission": flt(sum(flt(r.commission_amount) for r in rows), 2),
		"hrms": hrms_installed(),
	}


@frappe.whitelist()
def employee_performance(boutique: Optional[str] = None, from_date: Optional[str] = None, to_date: Optional[str] = None, follow_up_days: int = 30) -> list[dict[str, Any]]:
	"""Dashboard tile (SPEC v0.4 §C, finalised in v0.5 §M): per associate —

	``sales`` (net, returns netted), ``tickets``, ``avg_ticket``, ``boutique_avg_ticket``,
	``avg_ticket_vs_boutique`` (ratio, 1.0 = boutique average), ``with_client`` /
	``clients_identified_per_sale`` (= ``conversion``), ``returns`` / ``returns_amount`` /
	``returns_rate`` (returns ÷ tickets), ``follow_ups_assigned`` / ``follow_ups_done`` /
	``follow_up_rate`` (CRM follow-ups completed ÷ assigned in the last *follow_up_days*, default 30),
	``recognition_enrolments`` (biometric consents captured by the associate in the period),
	``commission``. Sorted by sales desc.
	"""
	assert_roles("AWANZ Manager", "AWANZ Regional", "AWANZ Head Office", "System Manager")
	from_date, to_date = _period(from_date, to_date)
	if boutique or not is_unrestricted():
		boutique = assert_boutique_access(boutique or get_user_boutique())
	filters: dict[str, Any] = {"docstatus": 1, "is_pos": 1, "posting_date": ("between", (from_date, to_date))}
	if boutique:
		filters["maison_boutique"] = boutique
	invoices = frappe.get_all("Sales Invoice", filters=filters, fields=["name", "maison_associate", "customer", "base_net_total", "is_return", "maison_boutique", "return_against"])
	walk_ins = set(frappe.get_all("POS Profile", fields=["customer"], pluck="customer"))
	# a return counts against the associate who made the original sale (not whoever processed it)
	originals = [i.return_against for i in invoices if i.is_return and i.return_against]
	seller_of = {r.name: r.maison_associate for r in frappe.get_all("Sales Invoice", filters={"name": ("in", originals)}, fields=["name", "maison_associate"])} if originals else {}
	stats: dict[str, dict[str, Any]] = {}
	boutique_totals: dict[str, dict[str, float]] = {}
	for inv in invoices:
		if inv.is_return and seller_of.get(inv.return_against):
			inv.maison_associate = seller_of[inv.return_against]
		# --- v0.8 QA D-2 — one basis on both sides of `avg_ticket_vs_boutique` ---
		# The associate's `avg_ticket` is `gross_sales / tickets` (returns excluded from both), but
		# the store's average divided a *net-of-returns* numerator by the same sales-only ticket
		# count, so every ratio was inflated — by 5.0 % at HOU-MTR over 30 days, enough to report
		# the top associate as above the store average when he was below it.
		bt = boutique_totals.setdefault(inv.maison_boutique or "", {"sales": 0.0, "returns": 0.0, "tickets": 0})
		if inv.is_return:
			bt["returns"] += abs(flt(inv.base_net_total))
		else:
			bt["sales"] += flt(inv.base_net_total)
			bt["tickets"] += 1
		# --- end v0.8 QA D-2 ---
		if not inv.maison_associate:
			continue
		s = stats.setdefault(
			inv.maison_associate,
			{"associate": inv.maison_associate, "boutique": inv.maison_boutique, "sales": 0.0, "gross_sales": 0.0, "tickets": 0, "returns": 0, "returns_amount": 0.0, "with_client": 0, "follow_ups_done": 0, "follow_ups_assigned": 0, "recognition_enrolments": 0, "commission": 0.0},
		)
		s["sales"] = flt(s["sales"] + flt(inv.base_net_total), 2)
		if inv.is_return:
			s["returns"] += 1
			s["returns_amount"] = flt(s["returns_amount"] + abs(flt(inv.base_net_total)), 2)
		else:
			s["gross_sales"] = flt(s["gross_sales"] + flt(inv.base_net_total), 2)
			s["tickets"] += 1
			if inv.customer and inv.customer not in walk_ins:
				s["with_client"] += 1
	# --- v0.5 M: clienteling follow-up rate, avg ticket vs boutique, returns rate, recognition enrolments ---
	fu_from = add_days(nowdate(), -(cint(follow_up_days) or 30))
	fu_filters_base: dict[str, Any] = {"follow_up_date": ("is", "set"), "creation": (">=", f"{fu_from} 00:00:00")}
	for name, s in stats.items():
		s["associate_name"] = frappe.db.get_value("AWANZ Associate", name, "full_name")
		s["avg_ticket"] = flt(s["gross_sales"] / s["tickets"], 2) if s["tickets"] else 0.0
		bt = boutique_totals.get(s["boutique"] or "", {"sales": 0.0, "returns": 0.0, "tickets": 0})
		# same basis as `avg_ticket` above: sales only, returns excluded (v0.8 QA D-2)
		s["boutique_avg_ticket"] = flt(bt["sales"] / bt["tickets"], 2) if bt["tickets"] else 0.0
		s["avg_ticket_basis"] = "sale (net of tax, returns excluded)"
		s["avg_ticket_vs_boutique"] = flt(s["avg_ticket"] / s["boutique_avg_ticket"], 3) if s["boutique_avg_ticket"] else None
		s["conversion"] = flt(s["with_client"] / s["tickets"], 3) if s["tickets"] else 0.0
		s["clients_identified_per_sale"] = s["conversion"]
		s["returns_rate"] = flt(s["returns"] / s["tickets"], 3) if s["tickets"] else 0.0
		s["commission"] = flt(
			frappe.db.get_value("AWANZ Commission Entry", {"associate": name, "posting_date": ("between", (from_date, to_date))}, "sum(commission_amount)") or 0, 2
		)
		s["follow_ups_assigned"] = frappe.db.count("AWANZ Client Interaction", {**fu_filters_base, "associate": name, "status": ("!=", "Cancelled")})
		s["follow_ups_done"] = frappe.db.count("AWANZ Client Interaction", {**fu_filters_base, "associate": name, "status": "Done"})
		s["follow_up_rate"] = flt(s["follow_ups_done"] / s["follow_ups_assigned"], 3) if s["follow_ups_assigned"] else None
		s["recognition_enrolments"] = (
			frappe.db.count("AWANZ Biometric Consent", {"associate": name, "captured_at": ("between", (f"{from_date} 00:00:00", f"{to_date} 23:59:59"))})
			if frappe.db.exists("DocType", "AWANZ Biometric Consent")
			else 0
		)
	# --- end v0.5 M ---
	return sorted(stats.values(), key=lambda x: -x["sales"])


# ---------------------------------------------------------------------------
# payroll exports
# ---------------------------------------------------------------------------
def _employee_meta(employee: Optional[str]) -> dict[str, Any]:
	if not employee or not frappe.db.exists("DocType", "Employee"):
		return {}
	return frappe.db.get_value("Employee", employee, ["employee_name", "employee_number", "company", "department"], as_dict=True) or {}


def build_payroll_rows(from_date, to_date, boutique: Optional[str] = None, only_open: bool = True) -> list[dict[str, Any]]:
	"""One row per associate: commission total for the period (+ employee identifiers)."""
	filters = _commission_filters(from_date, to_date, boutique, None, "Open" if only_open else None)
	rows = frappe.get_all("AWANZ Commission Entry", filters=filters, fields=["name", "associate", "associate_name", "employee", "boutique", "commission_amount"])
	out: dict[str, dict[str, Any]] = {}
	for r in rows:
		o = out.setdefault(r.associate, {"associate": r.associate, "associate_name": r.associate_name, "employee": r.employee, "boutique": r.boutique, "amount": 0.0, "entries": []})
		o["amount"] = flt(o["amount"] + flt(r.commission_amount), 2)
		o["entries"].append(r.name)
	result = []
	for o in out.values():
		meta = _employee_meta(o["employee"])
		o["employee_name"] = meta.get("employee_name") or o["associate_name"]
		o["employee_number"] = meta.get("employee_number") or ""
		o["company"] = meta.get("company") or ""
		result.append(o)
	return sorted(result, key=lambda x: x["associate"])


def _csv(header: list[str], lines: list[list[Any]]) -> str:
	buf = io.StringIO()
	w = csv.writer(buf)
	w.writerow(header)
	for line in lines:
		w.writerow(line)
	return buf.getvalue()


def render_export(fmt: str, rows: list[dict[str, Any]], from_date, to_date) -> tuple[str, str]:
	"""(filename, csv_text) for gusto / adp / quickbooks; see docs/payroll.md for the column contracts."""
	period = f"{from_date}_{to_date}"
	if fmt == "gusto":
		# Gusto "Import hours and earnings" template: Employee name, Employee ID, Commission
		return f"gusto_commissions_{period}.csv", _csv(
			["Last name", "First name", "Employee ID", "Commission"],
			[[*_split_name(r["employee_name"]), r["employee_number"] or r["associate"], f"{r['amount']:.2f}"] for r in rows],
		)
	if fmt == "adp":
		# ADP Workforce Now "Paydata" import: Co Code, Batch ID, File #, Earnings 3 Code, Earnings 3 Amount
		return f"adp_paydata_{period}.csv", _csv(
			["Co Code", "Batch ID", "File #", "Earnings 3 Code", "Earnings 3 Amount"],
			[[r["company"][:3].upper() or "MSN", f"COMM{str(to_date).replace('-', '')}", r["employee_number"] or r["associate"], "C", f"{r['amount']:.2f}"] for r in rows],
		)
	if fmt == "quickbooks":
		# QuickBooks Online Payroll timesheet/earnings CSV: Employee, Pay Item, Amount, Period Start, Period End
		return f"quickbooks_payroll_{period}.csv", _csv(
			["Employee", "Pay Item", "Amount", "Period Start", "Period End"],
			[[r["employee_name"], "Commission", f"{r['amount']:.2f}", str(from_date), str(to_date)] for r in rows],
		)
	frappe.throw(_("Unknown payroll format {0}; use one of {1}").format(fmt, ", ".join(PAYROLL_FORMATS)), frappe.ValidationError)
	return "", ""  # pragma: no cover


def _split_name(full: str) -> list[str]:
	parts = (full or "").strip().split()
	if len(parts) < 2:
		return [full or "", ""]
	return [parts[-1], " ".join(parts[:-1])]


def ensure_commission_component() -> Optional[str]:
	"""Salary Component used for HRMS Additional Salary (created on first export)."""
	if not frappe.db.exists("DocType", "Salary Component"):
		return None
	if not frappe.db.exists("Salary Component", COMMISSION_COMPONENT):
		doc = frappe.get_doc({"doctype": "Salary Component", "salary_component": COMMISSION_COMPONENT, "salary_component_abbr": "MCOM", "type": "Earning", "is_additional_component": 1})
		doc.flags.ignore_permissions = True
		doc.insert()
	return COMMISSION_COMPONENT


def export_to_hrms(rows: list[dict[str, Any]], to_date) -> list[str]:
	"""Create one HRMS ``Additional Salary`` per associate (requires hrms + a linked Employee)."""
	if not hrms_installed():
		frappe.throw(_("HRMS is not installed on this site"), frappe.ValidationError)
	component = ensure_commission_component()
	created = []
	for r in rows:
		r["additional_salary"] = None
		r["skipped"] = None
		if not r["employee"]:
			r["skipped"] = "no Employee linked to the AWANZ Associate"
			continue
		if flt(r["amount"]) <= 0:
			r["skipped"] = "non-positive amount"
			continue
		company = r["company"] or frappe.db.get_value("Employee", r["employee"], "company")
		if not frappe.db.exists("Salary Structure Assignment", {"employee": r["employee"], "docstatus": 1}):
			r["skipped"] = "no Salary Structure assigned (HRMS requires one for Additional Salary)"
			continue
		doc = frappe.get_doc(
			{
				"doctype": "Additional Salary",
				"employee": r["employee"],
				"company": company,
				"salary_component": component,
				"amount": flt(r["amount"], 2),
				"payroll_date": to_date,
				"overwrite_salary_structure_amount": 0,
				"ref_doctype": "AWANZ Commission Entry",
				"ref_docname": r["entries"][0],
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		try:
			doc.submit()
		except Exception:
			frappe.log_error(frappe.get_traceback(), "awanz additional salary submit")
		created.append(doc.name)
		r["additional_salary"] = doc.name
		for entry in r["entries"]:
			frappe.db.set_value("AWANZ Commission Entry", entry, {"additional_salary": doc.name}, update_modified=False)
	return created


@frappe.whitelist()
def payroll_export(
	from_date: Optional[str] = None,
	to_date: Optional[str] = None,
	format: str = "gusto",  # noqa: A002 - API contract name
	boutique: Optional[str] = None,
	mark_exported: int = 0,
) -> dict[str, Any]:
	"""Head Office: export the period's Open commissions.

	``format`` ∈ gusto | adp | quickbooks (CSV text returned in ``csv``) | hrms (creates
	Additional Salary rows). ``mark_exported=1`` flips the entries to *Exported* with the
	export reference so they are not exported twice.
	"""
	assert_roles("AWANZ Head Office", "System Manager")
	fmt = (format or "gusto").lower()
	if fmt not in PAYROLL_FORMATS:
		frappe.throw(_("Unknown payroll format {0}").format(fmt), frappe.ValidationError)
	from_date, to_date = _period(from_date, to_date)
	rows = build_payroll_rows(from_date, to_date, boutique)
	ref = f"{fmt.upper()}-{from_date}-{to_date}-{frappe.generate_hash(length=6)}"
	result: dict[str, Any] = {"format": fmt, "from_date": str(from_date), "to_date": str(to_date), "rows": rows, "export_ref": ref, "total": flt(sum(r["amount"] for r in rows), 2)}
	if fmt == "hrms":
		result["additional_salaries"] = export_to_hrms(rows, to_date)
	else:
		filename, text = render_export(fmt, rows, from_date, to_date)
		result.update({"filename": filename, "csv": text})
	if cint(mark_exported):
		for r in rows:
			for entry in r["entries"]:
				frappe.db.set_value("AWANZ Commission Entry", entry, {"status": "Exported", "payroll_export": ref}, update_modified=False)
		result["marked"] = sum(len(r["entries"]) for r in rows)
	return result


@frappe.whitelist()
def payroll_export_download(from_date: Optional[str] = None, to_date: Optional[str] = None, format: str = "gusto", boutique: Optional[str] = None):  # noqa: A002
	"""Same as :func:`payroll_export` but streams the CSV as a file download (desk button)."""
	res = payroll_export(from_date, to_date, format, boutique)
	frappe.response["filename"] = res.get("filename") or "payroll.csv"
	frappe.response["filecontent"] = res.get("csv") or json.dumps(res.get("additional_salaries") or [])
	frappe.response["type"] = "download"
