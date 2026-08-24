"""AWANZ Item Purchase History (v1.0 §G) — every receipt of an item, with its landed cost.

One row per Purchase Receipt line: date, vendor, qty, unit cost, **freight share** and **landed
cost**, plus the moving-average valuation the receipt produced. That is the cost drift moving
average is averaging, which is exactly what a buyer needs to see before agreeing next month's
price with a vendor.

The freight share is the maintained *Actual / Valuation* freight row of the receipt distributed
over its lines in proportion to net amount — the same rule ERPNext itself applies when it values
the stock (``erpnext.controllers.taxes_and_totals``).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import add_months, flt, nowdate

from maison_pos.purchasing import FREIGHT_DESCRIPTION
from maison_pos.reports import col, money_col


def execute(filters=None):
	f = dict(filters or {})
	from_date = f.get("from_date") or add_months(nowdate(), -12)
	to_date = f.get("to_date") or nowdate()
	item_code = f.get("item_code")
	supplier = f.get("supplier")

	cond, params = "", [from_date, to_date]
	if item_code:
		cond += " and pri.item_code = %s"
		params.append(item_code)
	if supplier:
		cond += " and pr.supplier = %s"
		params.append(supplier)
	rows = frappe.db.sql(
		f"""
		select pr.name as receipt, pr.posting_date as posting_date, pr.supplier as supplier,
		       pr.supplier_name as supplier_name, pri.purchase_order as purchase_order,
		       pri.item_code as item_code, pri.item_name as item_name, pri.qty as qty,
		       pri.rejected_qty as rejected_qty, pri.rate as rate,
		       pri.base_net_amount as net_amount, pri.valuation_rate as valuation_rate,
		       pri.warehouse as warehouse, pr.maison_dropship_store as dropship_store
		from `tabPurchase Receipt Item` pri
		join `tabPurchase Receipt` pr on pr.name = pri.parent
		where pr.docstatus = 1 and pr.posting_date between %s and %s {cond}
		order by pri.item_code asc, pr.posting_date asc, pr.creation asc
		""",  # nosec B608 — placeholders only
		params,
		as_dict=True,
	)
	receipts = sorted({r.receipt for r in rows})
	freight = _freight_by_receipt(receipts)
	net_by_receipt: dict[str, float] = {}
	for r in rows:
		net_by_receipt[r.receipt] = flt(net_by_receipt.get(r.receipt)) + flt(r.net_amount)

	data: list[dict[str, Any]] = []
	running: dict[str, dict[str, float]] = {}
	for r in rows:
		total_net = flt(net_by_receipt.get(r.receipt))
		share = flt(freight.get(r.receipt)) * (flt(r.net_amount) / total_net) if total_net else 0.0
		qty = flt(r.qty)
		landed = (flt(r.net_amount) + share) / qty if qty else 0.0
		acc = running.setdefault(r.item_code, {"qty": 0.0, "value": 0.0})
		acc["qty"] += qty
		acc["value"] += flt(r.net_amount) + share
		data.append(
			{
				"posting_date": r.posting_date,
				"item_code": r.item_code,
				"item_name": r.item_name,
				"supplier": r.supplier,
				"supplier_name": r.supplier_name,
				"receipt": r.receipt,
				"purchase_order": r.purchase_order,
				"warehouse": r.warehouse,
				"dropship_store": r.dropship_store,
				"qty": qty,
				"rejected_qty": flt(r.rejected_qty),
				"rate": flt(r.rate),
				"freight_share": round(share, 2),
				"freight_per_unit": round(share / qty, 4) if qty else 0.0,
				"landed_cost": round(landed, 4),
				"valuation_rate": round(flt(r.valuation_rate), 4),
				"running_avg": round(acc["value"] / acc["qty"], 4) if acc["qty"] else 0.0,
			}
		)
	columns = [
		col("Date", "posting_date", "Date", 95),
		col("Item", "item_code", "Link", 110, "Item"),
		col("Item Name", "item_name", "Data", 220),
		col("Vendor", "supplier", "Link", 140, "Supplier"),
		col("Receipt", "receipt", "Link", 150, "Purchase Receipt"),
		col("Order", "purchase_order", "Link", 150, "Purchase Order"),
		col("Qty", "qty", "Float", 70),
		col("Damaged", "rejected_qty", "Float", 80),
		money_col("Unit Cost", "rate", 110),
		money_col("Freight Share", "freight_share", 120),
		money_col("Freight / Unit", "freight_per_unit", 120),
		money_col("Landed Cost", "landed_cost", 120),
		money_col("Valuation After", "valuation_rate", 120),
		money_col("Running Avg", "running_avg", 120),
		col("Warehouse", "warehouse", "Link", 150, "Warehouse"),
		col("Drop-ship Store", "dropship_store", "Link", 120, "AWANZ Store"),
	]
	return columns, data


def _freight_by_receipt(receipts: list[str]) -> dict[str, float]:
	"""The maintained freight row (Actual / Valuation) of each receipt."""
	if not receipts:
		return {}
	rows = frappe.get_all(
		"Purchase Taxes and Charges",
		filters={"parenttype": "Purchase Receipt", "parent": ("in", receipts), "category": ("in", ("Valuation", "Valuation and Total"))},
		fields=["parent", "description", "tax_amount", "add_deduct_tax"],
		limit=10000,
	)
	out: dict[str, float] = {}
	for r in rows:
		amount = flt(r.tax_amount) * (-1 if r.add_deduct_tax == "Deduct" else 1)
		if (r.description or "").strip() != FREIGHT_DESCRIPTION:
			# another valuation charge (a site may add its own) still lands in stock value
			amount = amount
		out[r.parent] = flt(out.get(r.parent)) + amount
	return out
