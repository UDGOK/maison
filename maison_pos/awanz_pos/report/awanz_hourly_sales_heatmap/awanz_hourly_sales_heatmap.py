"""AWANZ Hourly Sales Heatmap — weekday × hour matrix of net sales (returns netted), one block per boutique."""

from __future__ import annotations

from typing import Any

from frappe.utils import flt, get_datetime, getdate

from maison_pos.reports import boutique_names, col, invoice_rows, normalize_filters

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
# --- v0.8 QA D-3 — trade outside these hours used to be clamped into the edge columns ----------
# `HOURS = range(8, 22)` plus `hour = min(max(hour, 8), 21)` reported $813 of sales at 08:00 on a
# day when the 33 invoices behind that number were rung at 04:36, and folded every sale after
# 21:59 into the 21:00 column. The report exists to plan staffing, so an invented peak is the
# worst thing it can do. The default window is still what a shop day looks like, but every hour
# that actually traded gets its own column — nothing is moved to a neighbouring hour.
# ------------------------------------------------------------------------------------------------
DEFAULT_HOURS = list(range(8, 22))


def execute(filters=None):
	f = normalize_filters(filters)
	names = boutique_names()
	grid: dict[tuple[str, int], dict[int, float]] = {}
	counts: dict[tuple[str, int], dict[int, int]] = {}
	seen_hours: set[int] = set()
	for inv in invoice_rows(f):
		wd = getdate(inv.posting_date).weekday()
		hour = get_datetime(f"{inv.posting_date} {inv.posting_time}").hour
		hour = min(max(int(hour), 0), 23)
		seen_hours.add(hour)
		key = (inv.boutique or "", wd)
		grid.setdefault(key, {})[hour] = grid.get(key, {}).get(hour, 0.0) + flt(inv.net_total)
		if not inv.is_return:
			counts.setdefault(key, {})[hour] = counts.get(key, {}).get(hour, 0) + 1
	hours = sorted(set(DEFAULT_HOURS) | seen_hours)
	data = []
	for (boutique, wd) in sorted(grid):
		row: dict[str, Any] = {"boutique": boutique, "boutique_name": names.get(boutique, boutique), "weekday": WEEKDAYS[wd], "total": 0.0}
		for h in hours:
			v = round(grid[(boutique, wd)].get(h, 0.0), 2)
			row[f"h{h:02d}"] = v
			row[f"n{h:02d}"] = counts.get((boutique, wd), {}).get(h, 0)
			row["total"] += v
		row["total"] = round(row["total"], 2)
		data.append(row)
	columns = [col("Boutique", "boutique", "Link", 100, "AWANZ Store"), col("Weekday", "weekday", "Data", 70)]
	columns += [{"label": f"{h:02d}:00", "fieldname": f"h{h:02d}", "fieldtype": "Currency", "width": 95} for h in hours]
	columns.append({"label": "Total", "fieldname": "total", "fieldtype": "Currency", "width": 110})
	chart = None
	if data:
		by_hour = [round(sum(r[f"h{h:02d}"] for r in data), 2) for h in hours]
		chart = {"data": {"labels": [f"{h:02d}" for h in hours], "datasets": [{"name": "Net sales", "values": by_hour}]}, "type": "bar", "colors": ["#C9A96E"]}
	return columns, data, None, chart
