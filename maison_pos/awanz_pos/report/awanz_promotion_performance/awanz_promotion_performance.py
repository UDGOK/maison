"""AWANZ Promotion Performance — one row per coupon / promotion: redemptions, discount given, net revenue carried."""

from __future__ import annotations

import frappe
from frappe import _

from maison_pos.api.promotions import performance


def execute(filters=None):
	filters = frappe._dict(filters or {})
	data = performance(filters.get("from_date"), filters.get("to_date"), filters.get("boutique"))
	columns = [
		{"label": _("Type"), "fieldname": "kind", "fieldtype": "Data", "width": 100},
		{"label": _("Promotion / Coupon"), "fieldname": "key", "fieldtype": "Data", "width": 200},
		{"label": _("Title"), "fieldname": "title", "fieldtype": "Data", "width": 240},
		{"label": _("Redemptions"), "fieldname": "redemptions", "fieldtype": "Int", "width": 110},
		{"label": _("Discount given"), "fieldname": "discount", "fieldtype": "Currency", "width": 140},
		{"label": _("Net revenue carried"), "fieldname": "revenue", "fieldtype": "Currency", "width": 160},
		{"label": _("Discount %"), "fieldname": "pct", "fieldtype": "Percent", "width": 100},
	]
	rows = []
	for c in data["coupons"]:
		rows.append({"kind": "Coupon", "key": c["coupon"], "title": c["title"], "redemptions": c["redemptions"], "discount": c["discount"], "revenue": c["revenue"], "pct": (c["discount"] / (c["revenue"] + c["discount"]) * 100) if (c["revenue"] + c["discount"]) else 0})
	for p in data["promotions"]:
		rows.append({"kind": "Promotion", "key": p["promotion"], "title": p["title"], "redemptions": p["invoices"], "discount": p["discount"], "revenue": p["revenue"], "pct": (p["discount"] / (p["revenue"] + p["discount"]) * 100) if (p["revenue"] + p["discount"]) else 0})
	return columns, rows
