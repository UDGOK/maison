"""AWANZ Drop-ship Deliveries (v1.0 §G) — vendor orders shipped straight to a store.

One row per drop-ship Purchase Order, by store: what was ordered, what the store has actually
received on its Receive screen, and any ``AWANZ Receiving Discrepancy`` raised against the vendor.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import add_months, cint, date_diff, flt, getdate, nowdate

from maison_pos.reports import col, money_col


def execute(filters=None):
	f = dict(filters or {})
	from_date = f.get("from_date") or add_months(nowdate(), -6)
	to_date = f.get("to_date") or nowdate()
	store = f.get("store")
	supplier = f.get("supplier")
	only_open = cint(f.get("only_open", 0))

	po_filters: dict[str, Any] = {
		"docstatus": ("<", 2),
		"maison_dropship_store": ("is", "set"),
		"transaction_date": ("between", [from_date, to_date]),
	}
	if store:
		po_filters["maison_dropship_store"] = store
	if supplier:
		po_filters["supplier"] = supplier
	rows = frappe.get_all(
		"Purchase Order",
		filters=po_filters,
		fields=[
			"name", "supplier", "supplier_name", "transaction_date", "schedule_date", "status", "docstatus",
			"per_received", "base_net_total", "maison_freight_amount", "maison_dropship_store", "set_warehouse",
		],
		order_by="transaction_date desc",
		limit=5000,
	)
	if not rows:
		return _columns(), []
	names = [r.name for r in rows]
	qty = {
		r.parent: r
		for r in frappe.db.sql(
			"""
			select parent, sum(qty) as qty, sum(received_qty) as received_qty
			from `tabPurchase Order Item` where parent in %(names)s group by parent
			""",
			{"names": names},
			as_dict=True,
		)
	}
	receipts: dict[str, list[str]] = {}
	first_receipt: dict[str, Any] = {}
	for r in frappe.db.sql(
		"""
		select pri.purchase_order as po, pr.name as receipt, pr.posting_date as posting_date
		from `tabPurchase Receipt Item` pri join `tabPurchase Receipt` pr on pr.name = pri.parent
		where pr.docstatus = 1 and pri.purchase_order in %(names)s
		group by pri.purchase_order, pr.name, pr.posting_date
		""",
		{"names": names},
		as_dict=True,
	):
		receipts.setdefault(r.po, []).append(r.receipt)
		if r.po not in first_receipt or getdate(r.posting_date) < getdate(first_receipt[r.po]):
			first_receipt[r.po] = r.posting_date
	disc: dict[str, dict[str, Any]] = {}
	for d in frappe.get_all(
		"AWANZ Receiving Discrepancy",
		filters={"purchase_order": ("in", names)},
		fields=["purchase_order", "name", "type", "status", "short_qty", "over_qty", "damaged_qty"],
		limit=5000,
	):
		acc = disc.setdefault(d.purchase_order, {"count": 0, "open": 0, "short": 0.0, "over": 0.0, "damaged": 0.0, "types": set()})
		acc["count"] += 1
		acc["open"] += 1 if d.status == "Open" else 0
		acc["short"] += flt(d.short_qty)
		acc["over"] += flt(d.over_qty)
		acc["damaged"] += flt(d.damaged_qty)
		acc["types"].add(d.type)

	data = []
	for r in rows:
		agg = qty.get(r.name)
		ordered = flt(agg.qty) if agg else 0.0
		received = flt(agg.received_qty) if agg else 0.0
		d = disc.get(r.name, {})
		receipt_status = (
			"Draft" if r.docstatus == 0
			else "Received" if flt(r.per_received) >= 100
			else "Part received" if received > 0
			else "Awaiting delivery"
		)
		if only_open and receipt_status == "Received":
			continue
		data.append(
			{
				"store": r.maison_dropship_store,
				"store_name": frappe.db.get_value("AWANZ Store", r.maison_dropship_store, "boutique_name"),
				"name": r.name,
				"supplier": r.supplier,
				"supplier_name": r.supplier_name,
				"transaction_date": r.transaction_date,
				"schedule_date": r.schedule_date,
				"received_on": first_receipt.get(r.name),
				"days_late": (
					date_diff(getdate(first_receipt[r.name]), getdate(r.schedule_date))
					if r.name in first_receipt and r.schedule_date
					else None
				),
				"receipt_status": receipt_status,
				"ordered_qty": ordered,
				"received_qty": received,
				"pending_qty": max(0.0, ordered - received),
				"per_received": round(flt(r.per_received), 1),
				"net_total": flt(r.base_net_total),
				"freight": flt(r.maison_freight_amount),
				"receipts": ", ".join(receipts.get(r.name, ())),
				"discrepancies": cint(d.get("count")),
				"open_discrepancies": cint(d.get("open")),
				"short_qty": flt(d.get("short")),
				"over_qty": flt(d.get("over")),
				"damaged_qty": flt(d.get("damaged")),
			}
		)
	data.sort(key=lambda r: (r["store"] or "", str(r["transaction_date"])))
	return _columns(), data


def _columns():
	return [
		col("Store", "store", "Link", 110, "AWANZ Store"),
		col("Store Name", "store_name", "Data", 160),
		col("Order", "name", "Link", 150, "Purchase Order"),
		col("Vendor", "supplier", "Link", 140, "Supplier"),
		col("Vendor Name", "supplier_name", "Data", 170),
		col("Ordered", "transaction_date", "Date", 95),
		col("Expected", "schedule_date", "Date", 95),
		col("Received On", "received_on", "Date", 100),
		col("Days Late", "days_late", "Int", 85),
		col("Receipt Status", "receipt_status", "Data", 130),
		col("Ordered Qty", "ordered_qty", "Float", 100),
		col("Received", "received_qty", "Float", 90),
		col("Pending", "pending_qty", "Float", 90),
		money_col("Net Total", "net_total"),
		money_col("Freight", "freight", 100),
		col("Discrepancies", "discrepancies", "Int", 110),
		col("Open", "open_discrepancies", "Int", 70),
		col("Short", "short_qty", "Float", 80),
		col("Over", "over_qty", "Float", 80),
		col("Damaged", "damaged_qty", "Float", 90),
		col("Receipts", "receipts", "Data", 200),
	]
