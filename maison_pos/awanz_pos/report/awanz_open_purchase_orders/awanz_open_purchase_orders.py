"""AWANZ Open Purchase Orders (v1.0 §G) — what is outstanding, how old it is, when it is due."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import cint, date_diff, flt, getdate, nowdate

from maison_pos.reports import col, money_col


def execute(filters=None):
	f = dict(filters or {})
	supplier = f.get("supplier")
	store = f.get("store")
	include_drafts = cint(f.get("include_drafts", 1))

	po_filters: dict[str, Any] = {
		"docstatus": ("in", (0, 1)) if include_drafts else 1,
		"status": ("not in", ("Closed", "Completed", "Cancelled")),
	}
	if supplier:
		po_filters["supplier"] = supplier
	if store:
		po_filters["maison_dropship_store"] = store
	names = frappe.get_all("Purchase Order", filters=po_filters, pluck="name", order_by="transaction_date asc", limit=5000)
	if not names:
		return _columns(), []
	rows = frappe.get_all(
		"Purchase Order",
		filters={"name": ("in", names)},
		fields=[
			"name", "supplier", "supplier_name", "transaction_date", "schedule_date", "status", "docstatus",
			"per_received", "base_net_total", "maison_freight_amount", "maison_dropship_store",
			"set_warehouse", "maison_sent_on", "maison_sent_method",
		],
		limit=5000,
	)
	lines = frappe.db.sql(
		"""
		select parent, sum(qty) as qty, sum(received_qty) as received_qty,
		       sum(greatest(qty - received_qty, 0)) as pending_qty
		from `tabPurchase Order Item`
		where parent in %(names)s
		group by parent
		""",
		{"names": names},
		as_dict=True,
	)
	by_po = {r.parent: r for r in lines}
	today = getdate(nowdate())
	data = []
	for r in rows:
		agg = by_po.get(r.name)
		pending = flt(agg.pending_qty) if agg else 0.0
		if flt(r.per_received) >= 100 and pending <= 0:
			continue
		age = date_diff(today, getdate(r.transaction_date)) if r.transaction_date else 0
		due_in = date_diff(getdate(r.schedule_date), today) if r.schedule_date else None
		data.append(
			{
				"name": r.name,
				"status": "Draft" if r.docstatus == 0 else r.status,
				"supplier": r.supplier,
				"supplier_name": r.supplier_name,
				"transaction_date": r.transaction_date,
				"schedule_date": r.schedule_date,
				"age_days": age,
				"due_in_days": due_in,
				"overdue": bool(due_in is not None and due_in < 0),
				"ordered_qty": flt(agg.qty) if agg else 0.0,
				"received_qty": flt(agg.received_qty) if agg else 0.0,
				"pending_qty": pending,
				"per_received": round(flt(r.per_received), 1),
				"net_total": flt(r.base_net_total),
				"freight": flt(r.maison_freight_amount),
				"dropship_store": r.maison_dropship_store,
				"warehouse": r.set_warehouse,
				"sent_on": r.maison_sent_on,
				"sent_method": r.maison_sent_method,
			}
		)
	data.sort(key=lambda r: (r["due_in_days"] if r["due_in_days"] is not None else 9999, -r["age_days"]))
	return _columns(), data


def _columns():
	return [
		col("Order", "name", "Link", 150, "Purchase Order"),
		col("Status", "status", "Data", 110),
		col("Vendor", "supplier", "Link", 140, "Supplier"),
		col("Vendor Name", "supplier_name", "Data", 180),
		col("Ordered", "transaction_date", "Date", 95),
		col("Expected", "schedule_date", "Date", 95),
		col("Age (d)", "age_days", "Int", 75),
		col("Due In (d)", "due_in_days", "Int", 85),
		col("Overdue", "overdue", "Check", 75),
		col("Ordered Qty", "ordered_qty", "Float", 100),
		col("Received", "received_qty", "Float", 90),
		col("Pending", "pending_qty", "Float", 90),
		col("Received %", "per_received", "Percent", 95),
		money_col("Net Total", "net_total"),
		money_col("Freight", "freight", 100),
		col("Drop-ship Store", "dropship_store", "Link", 120, "AWANZ Store"),
		col("Warehouse", "warehouse", "Link", 150, "Warehouse"),
		col("Sent", "sent_on", "Datetime", 150),
		col("By", "sent_method", "Data", 80),
	]
