"""AWANZ Sales Tax Summary — by boutique / tax template (jurisdiction): taxable vs non-taxable
sales, tax collected, returns netted. Export as CSV for state filings (``reports.export``)."""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import flt

from maison_pos.reports import boutique_names, col, item_rows, money_col, normalize_filters, tax_rate_of


def get_columns() -> list[dict[str, Any]]:
	return [
		col("Boutique", "boutique", "Link", 110, "AWANZ Store"),
		col("Boutique Name", "boutique_name", "Data", 160),
		col("Jurisdiction / Tax Template", "tax_template", "Link", 200, "Sales Taxes and Charges Template"),
		col("Rate %", "tax_rate", "Percent", 80),
		col("Tickets", "tickets", "Int", 80),
		col("Returns", "returns", "Int", 80),
		money_col("Gross Sales", "gross_sales"),
		money_col("Returns Value", "returns_value"),
		money_col("Taxable Sales (net)", "taxable_sales", 150),
		money_col("Non-taxable Sales (net)", "non_taxable_sales", 160),
		money_col("Net Sales", "net_sales"),
		money_col("Tax on Sales", "tax_sales"),
		money_col("Tax Refunded", "tax_returns"),
		money_col("Tax Collected (net)", "tax_collected", 150),
	]


def execute(filters=None):
	f = normalize_filters(filters)
	rows = item_rows(f)
	names = boutique_names()
	cache: dict[str, float] = {}
	agg: dict[tuple[str, str], dict[str, Any]] = {}
	tickets: dict[tuple[str, str], set] = {}
	returns: dict[tuple[str, str], set] = {}
	for r in rows:
		key = (r.boutique or "", r.tax_template or "")
		a = agg.setdefault(key, {"boutique": r.boutique, "boutique_name": names.get(r.boutique, r.boutique), "tax_template": r.tax_template, "tax_rate": tax_rate_of(r.tax_template, cache), "gross_sales": 0.0, "returns_value": 0.0, "taxable_sales": 0.0, "non_taxable_sales": 0.0, "net_sales": 0.0, "tax_sales": 0.0, "tax_returns": 0.0, "tax_collected": 0.0})
		net = flt(r.net_amount if r.net_amount is not None else r.amount)
		taxable = int(r.taxable) if r.taxable is not None else 1
		tax = round(net * a["tax_rate"] / 100, 2) if taxable else 0.0
		if r.is_return:
			returns.setdefault(key, set()).add(r.invoice)
			a["returns_value"] += abs(net)
			a["tax_returns"] += abs(tax)
		else:
			tickets.setdefault(key, set()).add(r.invoice)
			a["gross_sales"] += net
			a["tax_sales"] += tax
		if taxable:
			a["taxable_sales"] += net
		else:
			a["non_taxable_sales"] += net
		a["net_sales"] += net
		a["tax_collected"] += tax
	data = []
	for key, a in sorted(agg.items()):
		a["tickets"] = len(tickets.get(key, ()))
		a["returns"] = len(returns.get(key, ()))
		for k in ("gross_sales", "returns_value", "taxable_sales", "non_taxable_sales", "net_sales", "tax_sales", "tax_returns", "tax_collected"):
			a[k] = round(a[k], 2)
		data.append(a)
	return get_columns(), data
