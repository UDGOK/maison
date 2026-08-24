"""AWANZ Sales by Associate — tickets, net sales (returns netted), avg ticket, clients attached."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import flt

from maison_pos.reports import associate_names, boutique_names, col, invoice_rows, item_rows, money_col, normalize_filters


def execute(filters=None):
	f = normalize_filters(filters)
	anames = associate_names()
	bnames = boutique_names()
	walk_in = set(frappe.get_all("POS Profile", pluck="customer"))
	agg: dict[str, dict[str, Any]] = {}
	for inv in invoice_rows(f):
		key = inv.associate or "—"
		a = agg.setdefault(key, {"associate": inv.associate, "associate_name": anames.get(inv.associate, inv.associate or "—"), "boutique": inv.boutique, "boutique_name": bnames.get(inv.boutique, inv.boutique), "tickets": 0, "returns": 0, "gross": 0.0, "returns_value": 0.0, "net_sales": 0.0, "units": 0.0, "with_client": 0})
		if inv.is_return:
			a["returns"] += 1
			a["returns_value"] += abs(flt(inv.grand_total))
		else:
			a["tickets"] += 1
			a["gross"] += flt(inv.grand_total)
			if inv.customer and inv.customer not in walk_in:
				a["with_client"] += 1
		a["net_sales"] += flt(inv.net_total)
	for it in item_rows(f):
		if not it.is_return and (it.associate or "—") in agg:
			agg[it.associate or "—"]["units"] += flt(it.qty)
	data = []
	for a in sorted(agg.values(), key=lambda x: -x["net_sales"]):
		a["avg_ticket"] = round(a["gross"] / a["tickets"], 2) if a["tickets"] else 0.0
		a["items_per_ticket"] = round(a["units"] / a["tickets"], 2) if a["tickets"] else 0.0
		a["client_rate"] = round(100.0 * a["with_client"] / a["tickets"], 1) if a["tickets"] else 0.0
		for k in ("gross", "returns_value", "net_sales"):
			a[k] = round(a[k], 2)
		data.append(a)
	columns = [
		col("Associate", "associate", "Link", 200, "AWANZ Associate"),
		col("Name", "associate_name", "Data", 160),
		col("Boutique", "boutique", "Link", 100, "AWANZ Store"),
		col("Tickets", "tickets", "Int", 70),
		col("Returns", "returns", "Int", 70),
		col("Units", "units", "Float", 70),
		money_col("Gross (incl. tax)", "gross", 140),
		money_col("Returns Value", "returns_value"),
		money_col("Net Sales", "net_sales"),
		money_col("Avg Ticket", "avg_ticket", 110),
		col("Items / Ticket", "items_per_ticket", "Float", 100),
		col("Clients Attached", "with_client", "Int", 110),
		col("Client Rate %", "client_rate", "Percent", 100),
	]
	return columns, data
