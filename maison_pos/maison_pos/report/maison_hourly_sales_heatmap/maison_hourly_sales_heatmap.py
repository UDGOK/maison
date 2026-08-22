"""Maison Hourly Sales Heatmap — weekday × hour matrix of net sales (returns netted), one block per boutique."""

from __future__ import annotations

from typing import Any

from frappe.utils import flt, get_datetime, getdate

from maison_pos.reports import boutique_names, col, invoice_rows, normalize_filters

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
HOURS = list(range(8, 22))  # boutique hours 08:00-21:59; anything outside is folded into the edges


def execute(filters=None):
	f = normalize_filters(filters)
	names = boutique_names()
	grid: dict[tuple[str, int], dict[int, float]] = {}
	counts: dict[tuple[str, int], dict[int, int]] = {}
	for inv in invoice_rows(f):
		wd = getdate(inv.posting_date).weekday()
		hour = get_datetime(f"{inv.posting_date} {inv.posting_time}").hour
		hour = min(max(hour, HOURS[0]), HOURS[-1])
		key = (inv.boutique or "", wd)
		grid.setdefault(key, {})[hour] = grid.get(key, {}).get(hour, 0.0) + flt(inv.net_total)
		if not inv.is_return:
			counts.setdefault(key, {})[hour] = counts.get(key, {}).get(hour, 0) + 1
	data = []
	for (boutique, wd) in sorted(grid):
		row: dict[str, Any] = {"boutique": boutique, "boutique_name": names.get(boutique, boutique), "weekday": WEEKDAYS[wd], "total": 0.0}
		for h in HOURS:
			v = round(grid[(boutique, wd)].get(h, 0.0), 2)
			row[f"h{h:02d}"] = v
			row[f"n{h:02d}"] = counts.get((boutique, wd), {}).get(h, 0)
			row["total"] += v
		row["total"] = round(row["total"], 2)
		data.append(row)
	columns = [col("Boutique", "boutique", "Link", 100, "Maison Boutique"), col("Weekday", "weekday", "Data", 70)]
	columns += [{"label": f"{h:02d}:00", "fieldname": f"h{h:02d}", "fieldtype": "Currency", "width": 95} for h in HOURS]
	columns.append({"label": "Total", "fieldname": "total", "fieldtype": "Currency", "width": 110})
	chart = None
	if data:
		by_hour = [round(sum(r[f"h{h:02d}"] for r in data), 2) for h in HOURS]
		chart = {"data": {"labels": [f"{h:02d}" for h in HOURS], "datasets": [{"name": "Net sales", "values": by_hour}]}, "type": "bar", "colors": ["#C9A96E"]}
	return columns, data, None, chart
