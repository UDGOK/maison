"""Maison Sales by Item / Item Group / Department (filter ``group_by``), returns netted."""

from __future__ import annotations

from typing import Any

from frappe.utils import flt

from maison_pos.reports import col, item_rows, money_col, normalize_filters


def execute(filters=None):
	f = normalize_filters(filters)
	group_by = (f.get("group_by") or "Item").strip()
	rows = item_rows(f)
	agg: dict[str, dict[str, Any]] = {}
	tickets: dict[str, set] = {}
	for r in rows:
		if group_by == "Item Group":
			key, label = r.item_group or "", r.item_group
		elif group_by == "Department":
			key, label = r.department or "", r.department or "—"
		else:
			key, label = r.item_code, r.item_name
		a = agg.setdefault(key, {"key": key, "label": label, "item_group": r.item_group, "department": r.department, "units_sold": 0.0, "units_returned": 0.0, "net_units": 0.0, "gross": 0.0, "returns_value": 0.0, "net_sales": 0.0, "discounts": 0.0})
		q = abs(flt(r.qty))
		net = flt(r.net_amount if r.net_amount is not None else r.amount)
		if r.is_return:
			a["units_returned"] += q
			a["returns_value"] += abs(net)
		else:
			a["units_sold"] += q
			a["gross"] += net
			a["discounts"] += flt(r.discount_amount) * q
			tickets.setdefault(key, set()).add(r.invoice)
		a["net_sales"] += net
		a["net_units"] += flt(r.qty)
	data = []
	for a in sorted(agg.values(), key=lambda x: -x["net_sales"]):
		a["tickets"] = len(tickets.get(a["key"], ()))
		a["avg_rate"] = round(a["gross"] / a["units_sold"], 2) if a["units_sold"] else 0.0
		for k in ("gross", "returns_value", "net_sales", "discounts"):
			a[k] = round(a[k], 2)
		data.append(a)
	first = {"Item": col("Item", "key", "Link", 120, "Item"), "Item Group": col("Item Group", "key", "Link", 160, "Item Group"), "Department": col("Department", "key", "Data", 160)}[group_by if group_by in ("Item Group", "Department") else "Item"]
	columns = [first]
	if group_by not in ("Item Group", "Department"):
		columns += [col("Item Name", "label", "Data", 220), col("Item Group", "item_group", "Link", 120, "Item Group"), col("Department", "department", "Data", 110)]
	columns += [
		col("Tickets", "tickets", "Int", 70),
		col("Units Sold", "units_sold", "Float", 90),
		col("Units Returned", "units_returned", "Float", 100),
		col("Net Units", "net_units", "Float", 90),
		money_col("Gross", "gross"),
		money_col("Discounts", "discounts", 110),
		money_col("Returns Value", "returns_value"),
		money_col("Net Sales", "net_sales"),
		money_col("Avg Rate", "avg_rate", 110),
	]
	return columns, data
