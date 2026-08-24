"""Reports API (v0.4 section F): run the Maison Script Reports as JSON, export CSV, period comparison.

The dashboard's Reports section links to the desk (``/app/query-report/<name>``) and uses
``run`` / ``period_comparison`` for the gold-styled widgets; ``export`` streams the same rows
as CSV (state tax filings, accountants).
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, nowdate

from maison_pos.reports import normalize_filters, period_bounds, period_totals
from maison_pos.scoping import ALL_MAISON_ROLES, assert_roles, get_retail_boutiques, is_unrestricted

REPORTS: list[dict[str, str]] = [
	{"name": "Maison Sales Tax Summary", "group": "Tax", "description": "Taxable vs non-taxable sales, tax collected, returns netted — by boutique / jurisdiction. CSV for filings."},
	{"name": "Maison Daily Sales", "group": "Sales", "description": "Per boutique per day: gross, discounts, returns, net, tax, cash, card, tickets, avg ticket, items/ticket."},
	{"name": "Maison Sales by Item", "group": "Sales", "description": "By item, item group or department (group_by filter); returns netted."},
	{"name": "Maison Sales by Associate", "group": "Sales", "description": "Tickets, net sales, avg ticket, clients attached per associate."},
	{"name": "Maison Hourly Sales Heatmap", "group": "Sales", "description": "Weekday × hour net sales per boutique."},
	{"name": "Maison Client Purchases", "group": "Clients", "description": "RFM per client: recency, frequency, monetary, tier, lifetime."},
	{"name": "Maison Serial Ledger", "group": "Inventory", "description": "Every serial: received → sold / returned / transferred, current location."},
	{"name": "Maison Returns", "group": "Returns", "description": "Credit notes by reason / boutique / associate, or line detail."},
	# --- v0.8 QA D-6 — three reports existed but were unreachable from the dashboard ---
	# They were missing from this list, so the Reports tab never linked them and
	# `reports.export?report=Maison Commission Statement` answered 404 (`_check` gates on
	# `REPORT_NAMES`) — no CSV of commissions, promotions or campaigns for head office.
	{"name": "Maison Commission Statement", "group": "Employees", "description": "Commission per associate: entries, rate, base amount and commission, reversals netted. CSV for payroll."},
	{"name": "Maison Promotion Performance", "group": "Marketing", "description": "Pricing rules and coupons: redemptions, discount given, revenue and discount rate."},
	{"name": "Maison Campaign Performance", "group": "Marketing", "description": "Campaigns: sends, opens, clicks, direct and assisted attributed revenue."},
	# --- end v0.8 QA D-6 ---
]
REPORT_NAMES = {r["name"] for r in REPORTS}


def _check(report: str) -> str:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if report not in REPORT_NAMES:
		frappe.throw(_("Unknown report {0}").format(report), frappe.DoesNotExistError)
	if not frappe.db.exists("Report", report):
		frappe.throw(_("Report {0} is not installed (run bench migrate)").format(report), frappe.DoesNotExistError)
	return report


def _run(report: str, filters: dict[str, Any]) -> dict[str, Any]:
	# Access is gated by assert_roles + boutique scoping (normalize_filters), not by the Report's
	# desk roles, so associates can read their own boutique's figures from the POS.
	doc = frappe.get_cached_doc("Report", report)
	module = frappe.get_attr(f"{frappe.local.module_app[frappe.scrub(doc.module)]}.{frappe.scrub(doc.module)}.report.{frappe.scrub(doc.name)}.{frappe.scrub(doc.name)}.execute")
	res = module(frappe._dict(filters))
	columns, data = res[0], res[1]
	chart = res[3] if len(res) > 3 else None
	return {"report": report, "columns": columns, "rows": data, "chart": chart, "filters": {k: (str(v) if hasattr(v, "isoformat") else v) for k, v in filters.items() if not k.startswith("_")}}


@frappe.whitelist()
def list_reports() -> dict[str, Any]:
	"""Catalogue of Maison reports with desk links (for the dashboard Reports section)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	return {
		"reports": [
			{**r, "installed": bool(frappe.db.exists("Report", r["name"])), "url": f"/app/query-report/{r['name'].replace(' ', '%20')}", "csv": f"/api/method/maison_pos.api.reports.export?report={r['name'].replace(' ', '%20')}"}
			for r in REPORTS
		]
	}


@frappe.whitelist()
def run(report: str, filters: Any = None) -> dict[str, Any]:
	"""Execute a Maison report → ``{columns, rows, chart, filters}``. Scoped users are limited to their boutique."""
	report = _check(report)
	if isinstance(filters, str):
		filters = json.loads(filters or "{}")
	return _run(report, dict(filters or {}))


@frappe.whitelist()
def export(report: str, filters: Any = None, filename: Optional[str] = None) -> None:
	"""Download the report as CSV (``Content-Disposition: attachment``)."""
	report = _check(report)
	if isinstance(filters, str):
		filters = json.loads(filters or "{}")
	res = _run(report, dict(filters or {}))
	buf = io.StringIO()
	w = csv.writer(buf)
	cols = res["columns"]
	w.writerow([c.get("label", c.get("fieldname")) for c in cols])
	for row in res["rows"]:
		w.writerow([_cell(row.get(c["fieldname"]) if isinstance(row, dict) else row[i]) for i, c in enumerate(cols)])
	frappe.response["filename"] = filename or f"{frappe.scrub(report)}_{nowdate()}.csv"
	frappe.response["filecontent"] = buf.getvalue()
	frappe.response["type"] = "download"


def _cell(v: Any) -> Any:
	if v is None:
		return ""
	if hasattr(v, "isoformat"):
		return v.isoformat()
	return v


@frappe.whitelist()
def period_comparison(boutique: Optional[str] = None, company: Optional[str] = None, date: Optional[str] = None) -> dict[str, Any]:
	"""Dashboard widget: today vs same weekday last week, WTD, MTD vs last month, YTD vs LY.

	Each block: ``{label, current: {net, gross, tax, tickets, returns, avg_ticket}, previous: {...},
	delta: {net, tickets, avg_ticket} (absolute), pct: {...} (percent, null when previous is 0)}``.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if boutique or not is_unrestricted():
		from maison_pos.scoping import assert_boutique_access

		boutiques = [assert_boutique_access(boutique)]
	else:
		boutiques = get_retail_boutiques()  # v0.6 D4 — the warehouse row is not a shop
	out = {}
	for kind in ("today_vs_same_weekday", "wtd", "mtd", "ytd"):
		cf, ct, pf, pt, label = period_bounds(kind, date)
		cur = period_totals(cf, ct, boutiques, company)
		prev = period_totals(pf, pt, boutiques, company)
		delta = {k: round(cur[k] - prev[k], 2) for k in ("net", "gross", "tickets", "avg_ticket", "returns_value")}
		pct = {k: (round(100.0 * (cur[k] - prev[k]) / prev[k], 1) if prev[k] else None) for k in ("net", "gross", "tickets", "avg_ticket")}
		out[kind] = {"label": label, "current": cur, "previous": prev, "delta": delta, "pct": pct, "range": {"from": str(cf), "to": str(ct)}, "previous_range": {"from": str(pf), "to": str(pt)}}
	return {"boutiques": boutiques, "periods": out, "as_of": date or nowdate()}
