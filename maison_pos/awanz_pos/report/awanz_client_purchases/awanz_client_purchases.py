"""AWANZ Client Purchases — RFM per client: recency (days), frequency (tickets), monetary (net
spend in the period, returns netted), lifetime spend, tier, last boutique."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.query_builder import DocType
from frappe.query_builder.functions import Max, Sum
from frappe.utils import date_diff, flt, nowdate

from maison_pos.reports import boutique_names, col, invoice_rows, money_col, normalize_filters


def execute(filters=None):
	f = normalize_filters(filters)
	walk_in = set(frappe.get_all("POS Profile", pluck="customer"))
	names = boutique_names()
	agg: dict[str, dict[str, Any]] = {}
	for inv in invoice_rows(f):
		if not inv.customer or inv.customer in walk_in:
			continue
		a = agg.setdefault(inv.customer, {"customer": inv.customer, "customer_name": inv.customer_name, "frequency": 0, "returns": 0, "monetary": 0.0, "returns_value": 0.0, "last_visit": None, "last_boutique": None, "first_visit": None})
		if inv.is_return:
			a["returns"] += 1
			a["returns_value"] += abs(flt(inv.grand_total))
		else:
			a["frequency"] += 1
		a["monetary"] += flt(inv.grand_total)
		if a["last_visit"] is None or inv.posting_date > a["last_visit"]:
			a["last_visit"] = inv.posting_date
			a["last_boutique"] = inv.boutique
		if a["first_visit"] is None or inv.posting_date < a["first_visit"]:
			a["first_visit"] = inv.posting_date
	if not agg:
		return get_columns(), []
	customers = list(agg)
	meta = {r.name: r for r in frappe.get_all("Customer", filters={"name": ("in", customers)}, fields=["name", "maison_client_number", "loyalty_program"])}
	SI = DocType("Sales Invoice")
	life = {
		r.customer: r
		for r in (frappe.qb.from_(SI).select(SI.customer, Sum(SI.grand_total).as_("lifetime"), Max(SI.posting_date).as_("last")).where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.customer.isin(customers))).groupby(SI.customer)).run(as_dict=True)
	}
	tiers: dict[str, str] = {}
	for c in customers:
		program = meta.get(c, {}).get("loyalty_program")
		if program:
			try:
				from erpnext.accounts.doctype.loyalty_program.loyalty_program import get_loyalty_program_details_with_points

				d = get_loyalty_program_details_with_points(c, loyalty_program=program, silent=True)
				tiers[c] = d.get("tier_name") if d else None
			except Exception:
				tiers[c] = None
	data = []
	for a in agg.values():
		c = a["customer"]
		a["client_number"] = meta.get(c, {}).get("maison_client_number")
		a["tier"] = tiers.get(c)
		a["recency"] = date_diff(nowdate(), a["last_visit"]) if a["last_visit"] else None
		a["lifetime"] = round(flt(life.get(c, {}).get("lifetime")), 2)
		a["avg_ticket"] = round(a["monetary"] / a["frequency"], 2) if a["frequency"] else 0.0
		a["last_boutique_name"] = names.get(a["last_boutique"], a["last_boutique"])
		a["monetary"] = round(a["monetary"], 2)
		a["returns_value"] = round(a["returns_value"], 2)
		# simple 1-5 RFM score on the period population
		data.append(a)
	if data:
		_score(data, "recency", reverse=True)
		_score(data, "frequency")
		_score(data, "monetary")
		for a in data:
			a["rfm"] = f"{a['r_score']}{a['f_score']}{a['m_score']}"
	data.sort(key=lambda x: -x["monetary"])
	return get_columns(), data


def _score(data: list[dict[str, Any]], key: str, reverse: bool = False) -> None:
	"""Quintile score 1..5 (5 = best). For recency lower is better (reverse)."""
	ordered = sorted(data, key=lambda x: (x[key] if x[key] is not None else 10**9), reverse=not reverse)
	n = len(ordered)
	field = {"recency": "r_score", "frequency": "f_score", "monetary": "m_score"}[key]
	for i, row in enumerate(ordered):
		row[field] = max(1, 5 - int(5 * i / n))


def get_columns() -> list[dict[str, Any]]:
	return [
		col("Client", "customer", "Link", 160, "Customer"),
		col("Name", "customer_name", "Data", 160),
		col("Client №", "client_number", "Data", 90),
		col("Tier", "tier", "Data", 100),
		col("Recency (days)", "recency", "Int", 100),
		col("Frequency", "frequency", "Int", 80),
		money_col("Monetary (period)", "monetary", 140),
		col("Returns", "returns", "Int", 70),
		money_col("Returns Value", "returns_value"),
		money_col("Avg Ticket", "avg_ticket", 110),
		money_col("Lifetime", "lifetime", 120),
		col("RFM", "rfm", "Data", 60),
		col("Last Visit", "last_visit", "Date", 100),
		col("Last Boutique", "last_boutique", "Link", 100, "AWANZ Store"),
	]
