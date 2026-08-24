"""AWANZ Purchase by Vendor (v1.0 §G) — spend, orders, units, average lead time, on-time %.

Spend is what actually arrived (submitted Purchase Receipts); lead time and on-time are measured
against each order's promised ``schedule_date``. Shares its arithmetic with the Vendors screen
(``maison_pos.api.purchasing.vendor_performance``) so the two can never disagree.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import add_months, cint, flt, nowdate

from maison_pos.reports import col, money_col


def execute(filters=None):
	f = dict(filters or {})
	from_date = f.get("from_date") or add_months(nowdate(), -12)
	to_date = f.get("to_date") or nowdate()
	supplier = f.get("supplier")

	params: list[Any] = [from_date, to_date]
	cond = ""
	if supplier:
		cond = " and po.supplier = %s"
		params.append(supplier)
	orders = frappe.db.sql(
		f"""
		select po.supplier as supplier, po.supplier_name as supplier_name,
		       count(distinct po.name) as orders,
		       sum(po.base_net_total) as ordered_value,
		       sum(coalesce(po.maison_freight_amount, 0)) as freight
		from `tabPurchase Order` po
		where po.docstatus = 1 and po.transaction_date between %s and %s {cond}
		group by po.supplier, po.supplier_name
		""",  # nosec B608 — placeholders only
		params,
		as_dict=True,
	)
	params_r: list[Any] = [from_date, to_date]
	cond_r = ""
	if supplier:
		cond_r = " and pr.supplier = %s"
		params_r.append(supplier)
	receipts = frappe.db.sql(
		f"""
		select pr.supplier as supplier, count(distinct pr.name) as receipts,
		       sum(pri.qty) as units, sum(pri.base_net_amount) as spend
		from `tabPurchase Receipt Item` pri
		join `tabPurchase Receipt` pr on pr.name = pri.parent
		where pr.docstatus = 1 and pr.posting_date between %s and %s {cond_r}
		group by pr.supplier
		""",  # nosec B608 — placeholders only
		params_r,
		as_dict=True,
	)
	timing = frappe.db.sql(
		f"""
		select po.supplier as supplier, po.name as po, po.transaction_date as ordered_on,
		       po.schedule_date as promised_on, min(pr.posting_date) as received_on
		from `tabPurchase Receipt Item` pri
		join `tabPurchase Receipt` pr on pr.name = pri.parent
		join `tabPurchase Order` po on po.name = pri.purchase_order
		where pr.docstatus = 1 and pr.posting_date between %s and %s {cond_r.replace('pr.supplier', 'po.supplier')}
		group by po.supplier, po.name, po.transaction_date, po.schedule_date
		""",  # nosec B608 — placeholders only
		params_r,
		as_dict=True,
	)

	agg: dict[str, dict[str, Any]] = {}
	for r in orders:
		a = agg.setdefault(r.supplier, _blank(r.supplier, r.supplier_name))
		a["orders"] = cint(r.orders)
		a["ordered_value"] = round(flt(r.ordered_value), 2)
		a["freight"] = round(flt(r.freight), 2)
	for r in receipts:
		a = agg.setdefault(r.supplier, _blank(r.supplier))
		a["receipts"] = cint(r.receipts)
		a["units"] = flt(r.units)
		a["spend"] = round(flt(r.spend), 2)
	tally: dict[str, list[tuple[int, bool]]] = {}
	for r in timing:
		if not r.received_on:
			continue
		lead = (frappe.utils.getdate(r.received_on) - frappe.utils.getdate(r.ordered_on)).days if r.ordered_on else 0
		on_time = bool(r.promised_on) and frappe.utils.getdate(r.received_on) <= frappe.utils.getdate(r.promised_on)
		tally.setdefault(r.supplier, []).append((lead, on_time))
	for code, rows in tally.items():
		a = agg.setdefault(code, _blank(code))
		a["deliveries"] = len(rows)
		a["avg_lead_time_days"] = round(sum(days for days, _ok in rows) / len(rows), 1)
		a["on_time_pct"] = round(100.0 * sum(1 for _days, ok in rows if ok) / len(rows), 1)

	for code, a in agg.items():
		if not a["supplier_name"]:
			a["supplier_name"] = frappe.db.get_value("Supplier", code, "supplier_name") or code
		a["lead_time_days"] = cint(frappe.db.get_value("Supplier", code, "maison_lead_time_days"))
		a["avg_unit_cost"] = round(a["spend"] / a["units"], 4) if a["units"] else 0.0
	data = sorted(agg.values(), key=lambda r: -flt(r["spend"]))
	columns = [
		col("Vendor", "supplier", "Link", 160, "Supplier"),
		col("Vendor Name", "supplier_name", "Data", 200),
		col("Orders", "orders", "Int", 70),
		money_col("Ordered", "ordered_value"),
		col("Receipts", "receipts", "Int", 80),
		col("Units", "units", "Float", 80),
		money_col("Spend (received)", "spend"),
		money_col("Freight", "freight", 100),
		money_col("Avg Unit Cost", "avg_unit_cost", 120),
		col("Quoted Lead (d)", "lead_time_days", "Int", 110),
		col("Avg Lead (d)", "avg_lead_time_days", "Float", 100),
		col("On Time %", "on_time_pct", "Percent", 90),
		col("Deliveries", "deliveries", "Int", 90),
	]
	return columns, data


def _blank(supplier: str, supplier_name: str | None = None) -> dict[str, Any]:
	return {
		"supplier": supplier,
		"supplier_name": supplier_name,
		"orders": 0,
		"ordered_value": 0.0,
		"freight": 0.0,
		"receipts": 0,
		"units": 0.0,
		"spend": 0.0,
		"deliveries": 0,
		"avg_lead_time_days": None,
		"on_time_pct": None,
	}
