"""Maison Returns — credit notes by reason / boutique / associate (or line detail): count, units, value, refund methods."""

from __future__ import annotations

from typing import Any

from frappe.utils import flt

from maison_pos.reports import associate_names, boutique_names, col, item_rows, money_col, normalize_filters


def execute(filters=None):
	f = normalize_filters(filters)
	group_by = (f.get("group_by") or "Reason").strip()
	bnames = boutique_names()
	anames = associate_names()
	rows = [r for r in item_rows(f) if r.is_return]
	if group_by == "Detail":
		data = [
			{
				"invoice": r.invoice, "date": r.posting_date, "boutique": r.boutique, "associate": anames.get(r.associate, r.associate), "customer_name": r.customer_name,
				"item_code": r.item_code, "item_name": r.item_name, "qty": abs(flt(r.qty)), "value": abs(flt(r.net_amount if r.net_amount is not None else r.amount)),
				"reason": r.maison_return_reason or "—", "condition": r.maison_return_condition or "—", "serial_no": (r.serial_no or "").replace("\n", ", "), "warehouse": r.warehouse,
			}
			for r in rows
		]
		columns = [
			col("Credit Note", "invoice", "Link", 160, "Sales Invoice"), col("Date", "date", "Date", 95), col("Boutique", "boutique", "Link", 95, "Maison Boutique"),
			col("Associate", "associate", "Data", 140), col("Client", "customer_name", "Data", 140), col("Item", "item_code", "Link", 90, "Item"), col("Item Name", "item_name", "Data", 200),
			col("Qty", "qty", "Float", 60), money_col("Value (net)", "value"), col("Reason", "reason", "Data", 120), col("Condition", "condition", "Data", 90), col("Serial", "serial_no", "Data", 150), col("Returned To", "warehouse", "Link", 150, "Warehouse"),
		]
		return columns, data
	agg: dict[str, dict[str, Any]] = {}
	notes: dict[str, set] = {}
	for r in rows:
		if group_by == "Boutique":
			key, label = r.boutique or "—", bnames.get(r.boutique, r.boutique or "—")
		elif group_by == "Associate":
			key, label = r.associate or "—", anames.get(r.associate, r.associate or "—")
		else:
			key, label = r.maison_return_reason or "—", r.maison_return_reason or "—"
		a = agg.setdefault(key, {"key": key, "label": label, "units": 0.0, "value": 0.0, "damaged_units": 0.0, "sellable_units": 0.0})
		q = abs(flt(r.qty))
		a["units"] += q
		a["value"] += abs(flt(r.net_amount if r.net_amount is not None else r.amount))
		if r.maison_return_condition == "Damaged":
			a["damaged_units"] += q
		else:
			a["sellable_units"] += q
		notes.setdefault(key, set()).add(r.invoice)
	total_value = sum(a["value"] for a in agg.values()) or 1.0
	data = []
	for a in sorted(agg.values(), key=lambda x: -x["value"]):
		a["credit_notes"] = len(notes.get(a["key"], ()))
		a["value"] = round(a["value"], 2)
		a["share"] = round(100.0 * a["value"] / total_value, 1)
		data.append(a)
	first = {"Boutique": col("Boutique", "key", "Link", 110, "Maison Boutique"), "Associate": col("Associate", "key", "Link", 200, "Maison Associate")}.get(group_by, col("Reason", "key", "Data", 140))
	columns = [first, col("Label", "label", "Data", 160), col("Credit Notes", "credit_notes", "Int", 100), col("Units", "units", "Float", 70), col("Sellable Units", "sellable_units", "Float", 100), col("Damaged Units", "damaged_units", "Float", 100), money_col("Value (net)", "value"), col("Share %", "share", "Percent", 80)]
	return columns, data
