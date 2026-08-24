"""Maison Daily Sales — one row per boutique per day: gross, discounts, returns, net, tax,
cash, card, tickets, avg ticket, items/ticket. Returns are netted everywhere."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import flt

from maison_pos.reports import boutique_names, col, invoice_rows, item_rows, money_col, normalize_filters, payment_rows


def get_columns() -> list[dict[str, Any]]:
	return [
		col("Date", "date", "Date", 100),
		col("Boutique", "boutique", "Link", 100, "Maison Boutique"),
		col("Boutique Name", "boutique_name", "Data", 160),
		col("Tickets", "tickets", "Int", 70),
		col("Returns", "returns", "Int", 70),
		col("Units", "units", "Float", 70),
		money_col("Gross", "gross"),
		money_col("Discounts", "discounts"),
		money_col("Returns Value", "returns_value"),
		money_col("Net Sales", "net"),
		money_col("Tax", "tax", 100),
		money_col("Total (incl. tax)", "total", 140),
		money_col("Cash", "cash", 110),
		money_col("Card", "card", 110),
		money_col("Other Tenders", "other", 110),
		money_col("Avg Ticket", "avg_ticket", 110),
		col("Items / Ticket", "items_per_ticket", "Float", 100),
	]


def execute(filters=None):
	f = normalize_filters(filters)
	names = boutique_names()
	agg: dict[tuple, dict[str, Any]] = {}

	def bucket(date, boutique):
		key = (str(date), boutique or "")
		return agg.setdefault(key, {"date": date, "boutique": boutique, "boutique_name": names.get(boutique, boutique), "tickets": 0, "returns": 0, "units": 0.0, "gross": 0.0, "discounts": 0.0, "returns_value": 0.0, "net": 0.0, "tax": 0.0, "total": 0.0, "cash": 0.0, "card": 0.0, "other": 0.0, "sales_total": 0.0, "_sale_units": 0.0})

	for inv in invoice_rows(f):
		b = bucket(inv.posting_date, inv.boutique)
		if inv.is_return:
			b["returns"] += 1
			b["returns_value"] += abs(flt(inv.net_total))
		else:
			b["tickets"] += 1
			b["gross"] += flt(inv.total)
			b["discounts"] += flt(inv.discount_amount)
			b["sales_total"] += flt(inv.rounded_total or inv.grand_total)  # v0.8 QA D-4
		b["net"] += flt(inv.net_total)
		b["tax"] += flt(inv.tax)
		b["total"] += flt(inv.rounded_total or inv.grand_total)
	for it in item_rows(f):
		b = bucket(it.posting_date, it.boutique)
		b["units"] += flt(it.qty)
		if not it.is_return:
			b["_sale_units"] += flt(it.qty)
			b["discounts"] += flt(it.discount_amount) * flt(it.qty)
	for p in payment_rows(f):
		b = bucket(p.posting_date, p.boutique)
		mop = (p.mode_of_payment or "").lower()
		amt = flt(p.amount)
		if mop == "cash":
			b["cash"] += amt
		elif mop == "card":
			b["card"] += amt
		else:
			b["other"] += amt
	# change given is not cash in the drawer
	for inv in invoice_rows(f):
		if flt(inv.change_amount):
			bucket(inv.posting_date, inv.boutique)["cash"] -= flt(inv.change_amount)
	data = []
	for key in sorted(agg):
		b = agg[key]
		# v0.8 QA D-4 — the average *sale*: sales only on both sides (was net-of-returns / sales)
		b["avg_ticket"] = round(b["sales_total"] / b["tickets"], 2) if b["tickets"] else 0.0
		b["items_per_ticket"] = round(b["_sale_units"] / b["tickets"], 2) if b["tickets"] else 0.0
		del b["_sale_units"]
		for k in ("gross", "discounts", "returns_value", "net", "tax", "total", "cash", "card", "other", "sales_total"):
			b[k] = round(b[k], 2)
		data.append(b)
	return get_columns(), data
