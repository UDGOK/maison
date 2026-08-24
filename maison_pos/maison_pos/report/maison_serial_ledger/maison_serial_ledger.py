"""Maison Serial Ledger — every serial number: received → sold / returned / transferred, and where it is now."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.query_builder import DocType
from frappe.utils import flt

from maison_pos.reports import boutique_names, col, money_col, normalize_filters


def execute(filters=None):
	# --- v0.8 QA D-14 — the only Maison report that skipped `normalize_filters` ---
	# It therefore ignored `from_date` / `to_date` entirely, never rejected an inverted range and
	# — the part that matters — applied no boutique restriction, so a store-scoped manager running
	# it in the desk would have seen every store's serial numbers. It behaves like every other
	# report now: defaults filled in, range validated, scope enforced.
	f = normalize_filters(filters)
	SN = DocType("Serial No")
	cond = SN.name.isnotnull()
	if f.get("item_code"):
		cond &= SN.item_code == f["item_code"]
	if f.get("serial_no"):
		cond &= SN.name.like(f"%{f['serial_no']}%")
	if f.get("company"):
		cond &= SN.company == f["company"]
	serials = (
		frappe.qb.from_(SN)
		.select(SN.name, SN.item_code, SN.item_name, SN.warehouse, SN.status, SN.purchase_document_no, SN.creation.as_("purchase_date"), SN.purchase_rate, SN.company)
		.where(cond)
		.orderby(SN.item_code)
		.orderby(SN.name)
		.limit(5000)
	).run(as_dict=True)
	if not serials:
		return get_columns(), []
	names = [s.name for s in serials]
	# every Serial and Batch Entry tells us the vouchers the serial moved through
	SBE = DocType("Serial and Batch Entry")
	SBB = DocType("Serial and Batch Bundle")
	moves = (
		frappe.qb.from_(SBE)
		.join(SBB)
		.on(SBE.parent == SBB.name)
		.select(SBE.serial_no, SBB.voucher_type, SBB.voucher_no, SBB.posting_datetime, SBB.type_of_transaction, SBB.warehouse, SBE.qty)
		.where(SBE.serial_no.isin(names) & (SBB.docstatus == 1) & (SBB.is_cancelled == 0))
		.orderby(SBB.posting_datetime)
	).run(as_dict=True)
	for m in moves:
		m["posting_date"] = m.posting_datetime.date() if hasattr(m.posting_datetime, "date") else m.posting_datetime
	by_serial: dict[str, list] = {}
	for m in moves:
		by_serial.setdefault(m.serial_no, []).append(m)
	bnames = boutique_names()
	wh_to_b = {r.warehouse: r.name for r in frappe.get_all("Maison Boutique", fields=["name", "warehouse"])}
	damaged = {r.damaged_warehouse: r.name for r in frappe.get_all("Maison Boutique", fields=["name", "damaged_warehouse"]) if r.damaged_warehouse}
	invoices = {m.voucher_no for m in moves if m.voucher_type == "Sales Invoice"}
	inv_meta = {r.name: r for r in frappe.get_all("Sales Invoice", filters={"name": ("in", list(invoices) or ["__none__"])}, fields=["name", "is_return", "customer_name", "maison_boutique", "posting_date", "maison_associate"])}
	data = []
	want = (f.get("status") or "").strip()
	allowed = f.get("_boutiques")
	from_date, to_date = f.get("from_date"), f.get("to_date")
	for s in serials:
		hist = by_serial.get(s.name, [])
		received = next((m for m in hist if m.type_of_transaction == "Inward" and m.voucher_type != "Sales Invoice"), None)
		sales = [m for m in hist if m.voucher_type == "Sales Invoice" and not inv_meta.get(m.voucher_no, {}).get("is_return")]
		returns = [m for m in hist if m.voucher_type == "Sales Invoice" and inv_meta.get(m.voucher_no, {}).get("is_return")]
		transfers = [m for m in hist if m.voucher_type == "Stock Entry" and m is not received]
		last_sale = sales[-1] if sales else None
		last_return = returns[-1] if returns else None
		if s.warehouse and s.warehouse in damaged:
			status = "Damaged"
		elif s.warehouse:
			status = "Returned" if last_return and (not last_sale or last_return.posting_date >= last_sale.posting_date) else ("Transferred" if transfers else "In stock")
		else:
			status = "Sold" if last_sale else (s.status or "—")
		if want and status != want:
			continue
		boutique = wh_to_b.get(s.warehouse) or damaged.get(s.warehouse) or (inv_meta.get(last_sale.voucher_no, {}).get("maison_boutique") if last_sale else None)
		# v0.8 QA D-14 — scope + date window (a serial belongs to a store, and the window is the
		# movement window: a serial with no movement inside it is not part of this report)
		if allowed is not None and boutique and boutique not in allowed:
			continue
		if from_date and to_date:
			dates = [m.posting_date for m in hist if m.posting_date]
			if dates and not any(from_date <= d <= to_date for d in dates):
				continue
		data.append(
			{
				"serial_no": s.name,
				"item_code": s.item_code,
				"item_name": s.item_name,
				"status": status,
				"warehouse": s.warehouse,
				"boutique": boutique,
				"boutique_name": bnames.get(boutique, boutique),
				"received_on": received.posting_date if received else s.purchase_date,
				"received_via": received.voucher_no if received else s.purchase_document_no,
				"sold_on": last_sale.posting_date if last_sale else None,
				"sold_via": last_sale.voucher_no if last_sale else None,
				"sold_to": inv_meta.get(last_sale.voucher_no, {}).get("customer_name") if last_sale else None,
				"returned_on": last_return.posting_date if last_return else None,
				"returned_via": last_return.voucher_no if last_return else None,
				"moves": len(hist),
				"cost": flt(s.purchase_rate),
			}
		)
	return get_columns(), data


def get_columns() -> list[dict[str, Any]]:
	return [
		col("Serial No", "serial_no", "Link", 170, "Serial No"),
		col("Item", "item_code", "Link", 100, "Item"),
		col("Item Name", "item_name", "Data", 220),
		col("Status", "status", "Data", 90),
		col("Current Location", "warehouse", "Link", 160, "Warehouse"),
		col("Boutique", "boutique", "Link", 100, "Maison Boutique"),
		col("Received On", "received_on", "Date", 100),
		col("Received Via", "received_via", "Dynamic Link", 150),
		col("Sold On", "sold_on", "Date", 100),
		col("Sold Via", "sold_via", "Link", 150, "Sales Invoice"),
		col("Sold To", "sold_to", "Data", 150),
		col("Returned On", "returned_on", "Date", 100),
		col("Returned Via", "returned_via", "Link", 150, "Sales Invoice"),
		col("Moves", "moves", "Int", 60),
		money_col("Cost", "cost", 110),
	]
