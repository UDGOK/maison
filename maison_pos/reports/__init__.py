"""Shared query helpers for the AWANZ Script Reports (``maison_pos/awanz_pos/report/*``).

This was a single module until v1.2 turned it into a package so that
``maison_pos/reports/store_statement.py`` could sit beside it; every ``from maison_pos.reports
import col, money_col, normalize_filters, …`` in the report modules is unchanged.

Everything below works on submitted ``Sales Invoice`` rows with ``is_pos = 1``; credit notes
(``is_return = 1``) carry negative amounts so "net" figures are automatically netted of
returns. Filters are the same everywhere: ``company``, ``boutique``, ``from_date``, ``to_date``.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Count, Sum
from frappe.utils import add_days, cint, flt, getdate, nowdate

from maison_pos.scoping import get_allowed_boutiques, is_unrestricted

COMMON_FILTERS = [
	{"fieldname": "company", "label": "Company", "fieldtype": "Link", "options": "Company", "default": None},
	{"fieldname": "boutique", "label": "Boutique", "fieldtype": "Link", "options": "AWANZ Store"},
	{"fieldname": "from_date", "label": "From Date", "fieldtype": "Date", "reqd": 1, "default": "month_start"},
	{"fieldname": "to_date", "label": "To Date", "fieldtype": "Date", "reqd": 1, "default": "today"},
]


def normalize_filters(filters: Any) -> dict[str, Any]:
	"""Fill defaults (this month) and restrict scoped users to their own boutique."""
	f = dict(filters or {})
	if isinstance(filters, str):
		f = frappe.parse_json(filters) or {}
	today = getdate(nowdate())
	f["from_date"] = getdate(f.get("from_date") or today.replace(day=1))
	f["to_date"] = getdate(f.get("to_date") or today)
	if f["from_date"] > f["to_date"]:
		frappe.throw(_("From Date must be before To Date"), frappe.ValidationError)
	allowed = get_allowed_boutiques()
	if not is_unrestricted():
		if f.get("boutique") and f["boutique"] not in allowed:
			frappe.throw(_("You are not permitted to report on boutique {0}").format(f["boutique"]), frappe.PermissionError)
		f["boutique"] = allowed[0] if allowed else "__none__"
	f["_boutiques"] = [f["boutique"]] if f.get("boutique") else allowed
	return f


def invoice_conditions(f: dict[str, Any], SI=None):
	"""Query-builder condition on ``Sales Invoice`` for the normalized filters."""
	SI = SI or DocType("Sales Invoice")
	cond = (SI.docstatus == 1) & (SI.is_pos == 1) & (SI.posting_date >= f["from_date"]) & (SI.posting_date <= f["to_date"])
	if f.get("company"):
		cond &= SI.company == f["company"]
	if f.get("_boutiques") is not None:
		cond &= SI.maison_boutique.isin(f["_boutiques"] or ["__none__"])
	return cond


def invoice_rows(f: dict[str, Any], extra_fields: Optional[list[str]] = None) -> list[dict[str, Any]]:
	"""Header-level rows (sales + returns) in the period."""
	SI = DocType("Sales Invoice")
	fields = [
		SI.name, SI.posting_date, SI.posting_time, SI.maison_boutique.as_("boutique"), SI.maison_associate.as_("associate"),
		SI.customer, SI.customer_name, SI.is_return, SI.return_against, SI.net_total, SI.total, SI.discount_amount,
		SI.total_taxes_and_charges.as_("tax"), SI.grand_total, SI.rounded_total, SI.change_amount, SI.loyalty_amount,
		SI.taxes_and_charges.as_("tax_template"), SI.maison_refund_method, SI.maison_return_reason, SI.company, SI.currency,
	]
	for extra in extra_fields or []:
		fields.append(getattr(SI, extra))
	return (frappe.qb.from_(SI).select(*fields).where(invoice_conditions(f, SI)).orderby(SI.posting_date).orderby(SI.posting_time)).run(as_dict=True)


def payment_rows(f: dict[str, Any]) -> list[dict[str, Any]]:
	SI = DocType("Sales Invoice")
	SIP = DocType("Sales Invoice Payment")
	return (
		frappe.qb.from_(SIP)
		.join(SI)
		.on(SIP.parent == SI.name)
		.select(SI.name.as_("invoice"), SI.maison_boutique.as_("boutique"), SI.posting_date, SI.is_return, SIP.mode_of_payment, SIP.amount, SI.change_amount)
		.where(invoice_conditions(f, SI))
	).run(as_dict=True)


def item_rows(f: dict[str, Any]) -> list[dict[str, Any]]:
	"""Line-level rows joined with the Item's department / group / taxable flag."""
	SI = DocType("Sales Invoice")
	SII = DocType("Sales Invoice Item")
	IT = DocType("Item")
	return (
		frappe.qb.from_(SII)
		.join(SI)
		.on(SII.parent == SI.name)
		.left_join(IT)
		.on(IT.name == SII.item_code)
		.select(
			SI.name.as_("invoice"), SI.posting_date, SI.posting_time, SI.maison_boutique.as_("boutique"), SI.maison_associate.as_("associate"),
			SI.customer, SI.customer_name, SI.is_return, SI.taxes_and_charges.as_("tax_template"),
			SII.item_code, SII.item_name, SII.item_group, SII.qty, SII.rate, SII.amount, SII.net_amount, SII.discount_amount, SII.serial_no, SII.warehouse,
			SII.maison_return_reason, SII.maison_return_condition,
			IT.maison_department.as_("department"), IT.maison_taxable.as_("taxable"), IT.has_serial_no,
		)
		.where(invoice_conditions(f, SI))
		.orderby(SI.posting_date)
		.orderby(SI.posting_time)
	).run(as_dict=True)


def tax_rate_of(template: Optional[str], cache: dict[str, float]) -> float:
	if not template:
		return 0.0
	if template not in cache:
		cache[template] = sum(flt(r.rate) for r in frappe.get_all("Sales Taxes and Charges", filters={"parent": template, "parenttype": "Sales Taxes and Charges Template", "charge_type": "On Net Total"}, fields=["rate"]))
	return cache[template]


def boutique_names() -> dict[str, str]:
	return {r.name: r.boutique_name for r in frappe.get_all("AWANZ Store", fields=["name", "boutique_name"])}


def associate_names() -> dict[str, str]:
	return {r.name: r.full_name for r in frappe.get_all("AWANZ Associate", fields=["name", "full_name"])}


def money_col(label: str, fieldname: str, width: int = 130) -> dict[str, Any]:
	return {"label": _(label), "fieldname": fieldname, "fieldtype": "Currency", "width": width}


def col(label: str, fieldname: str, fieldtype: str = "Data", width: int = 120, options: Optional[str] = None) -> dict[str, Any]:
	c: dict[str, Any] = {"label": _(label), "fieldname": fieldname, "fieldtype": fieldtype, "width": width}
	if options:
		c["options"] = options
	return c


def period_bounds(kind: str, today=None) -> tuple[Any, Any, Any, Any, str]:
	"""(cur_from, cur_to, prev_from, prev_to, label) for the dashboard period comparison."""
	today = getdate(today or nowdate())
	if kind == "today_vs_same_weekday":
		return today, today, add_days(today, -7), add_days(today, -7), "Today vs same weekday last week"
	if kind == "wtd":
		start = add_days(today, -today.weekday())
		return start, today, add_days(start, -7), add_days(today, -7), "Week to date vs last week"
	if kind == "mtd":
		start = today.replace(day=1)
		prev_end = add_days(start, -1)
		prev_start = prev_end.replace(day=1)
		prev_to = min(prev_end, prev_start.replace(day=min(today.day, prev_end.day)))
		return start, today, prev_start, prev_to, "Month to date vs last month"
	if kind == "ytd":
		start = today.replace(month=1, day=1)
		ly = today.replace(year=today.year - 1)
		return start, today, start.replace(year=today.year - 1), ly, "Year to date vs last year"
	frappe.throw(_("Unknown period {0}").format(kind), frappe.ValidationError)
	return None  # pragma: no cover


def period_totals(frm, to, boutiques: Optional[list[str]], company: Optional[str] = None) -> dict[str, float]:
	SI = DocType("Sales Invoice")
	cond = (SI.docstatus == 1) & (SI.is_pos == 1) & (SI.posting_date >= frm) & (SI.posting_date <= to)
	if company:
		cond &= SI.company == company
	if boutiques is not None:
		cond &= SI.maison_boutique.isin(boutiques or ["__none__"])
	rows = (
		frappe.qb.from_(SI)
		.select(SI.is_return, Count(SI.name).as_("n"), Sum(SI.grand_total).as_("gross"), Sum(SI.net_total).as_("net"), Sum(SI.total_taxes_and_charges).as_("tax"))
		.where(cond)
		.groupby(SI.is_return)
	).run(as_dict=True)
	# --- v0.8 QA D-7 / D-4 — one definition of "net sales", one of "avg ticket" ---
	# "Net sales" on the Live and Stores tabs is `sum(grand_total)`, returns netted, tax included
	# (`api/dashboard.py`). This widget reported `sum(net_total)` under the same words, so the same
	# day showed $597.38 on one tab and $553.25 on the other — exactly the day's sales tax — with
	# nothing to explain the gap. It follows the rest of the dashboard now; the pre-tax figure is
	# still returned as `net_of_tax` (and the Daily Sales report prints both, labelled).
	# `avg_ticket` is the average *sale*: sales only on both sides of the division.
	out = {"net": 0.0, "net_of_tax": 0.0, "gross": 0.0, "tax": 0.0, "tickets": 0, "returns": 0, "returns_value": 0.0, "sales_total": 0.0}
	for r in rows:
		if cint(r.is_return):
			out["returns"] = cint(r.n)
			out["returns_value"] = abs(flt(r.gross))
		else:
			out["tickets"] = cint(r.n)
			out["sales_total"] += flt(r.gross)
		out["net"] += flt(r.gross)
		out["net_of_tax"] += flt(r.net)
		out["gross"] += flt(r.gross)
		out["tax"] += flt(r.tax)
	out["avg_ticket"] = round(out["sales_total"] / out["tickets"], 2) if out["tickets"] else 0.0
	for k in ("net", "net_of_tax", "gross", "tax", "returns_value", "sales_total"):
		out[k] = round(out[k], 2)
	return out
	# --- end v0.8 QA D-7 / D-4 ---
