"""AWANZ Campaign Performance — Script Report (SPEC v0.5 §M).

One row per campaign: sends, opens, clicks, rates, buyers, direct / assisted attributed revenue,
cost and ROI. Same numbers as ``maison_pos.api.campaigns.performance``.
"""

from __future__ import annotations

from typing import Any

import frappe

from maison_pos.api.campaigns import performance


def execute(filters: dict[str, Any] | None = None):
	filters = frappe._dict(filters or {})
	data = performance(campaign=filters.get("campaign"), from_date=filters.get("from_date"), to_date=filters.get("to_date"), boutique=filters.get("boutique"), channel=filters.get("channel"))
	columns = [
		{"label": "Campaign", "fieldname": "name", "fieldtype": "Link", "options": "AWANZ Campaign", "width": 150},
		{"label": "Title", "fieldname": "title", "fieldtype": "Data", "width": 220},
		{"label": "Channel", "fieldname": "channel", "fieldtype": "Data", "width": 110},
		{"label": "Send Date", "fieldname": "send_date", "fieldtype": "Date", "width": 100},
		{"label": "Sends", "fieldname": "sends", "fieldtype": "Int", "width": 80},
		{"label": "Opens", "fieldname": "opens", "fieldtype": "Int", "width": 80},
		{"label": "Clicks", "fieldname": "clicks", "fieldtype": "Int", "width": 80},
		{"label": "Open %", "fieldname": "open_pct", "fieldtype": "Percent", "width": 80},
		{"label": "Click %", "fieldname": "click_pct", "fieldtype": "Percent", "width": 80},
		{"label": "Buyers", "fieldname": "buyers", "fieldtype": "Int", "width": 80},
		{"label": "Direct sales", "fieldname": "invoices_direct", "fieldtype": "Int", "width": 90},
		{"label": "Attributed (direct)", "fieldname": "attributed_direct", "fieldtype": "Currency", "width": 140},
		{"label": "Attributed (assisted)", "fieldname": "attributed_assisted", "fieldtype": "Currency", "width": 140},
		{"label": "Revenue / send", "fieldname": "revenue_per_send", "fieldtype": "Currency", "width": 110},
		{"label": "Cost", "fieldname": "cost", "fieldtype": "Currency", "width": 100},
		{"label": "ROI", "fieldname": "roi_pct", "fieldtype": "Percent", "width": 80},
	]
	rows = []
	for r in data["campaigns"]:
		rows.append(
			{
				**r,
				"open_pct": round(r["open_rate"] * 100, 1),
				"click_pct": round(r["click_rate"] * 100, 1),
				"roi_pct": round(r["roi"] * 100, 1) if r.get("roi") is not None else None,
			}
		)
	chart = {
		"data": {"labels": [r["name"] for r in rows], "datasets": [{"name": "Direct", "values": [r["attributed_direct"] for r in rows]}, {"name": "Assisted", "values": [r["attributed_assisted"] for r in rows]}]},
		"type": "bar",
		"colors": ["#C9A96E", "#7D7668"],
	}
	t = data["totals"]
	summary = [
		{"label": "Sends", "value": t["sends"], "datatype": "Int"},
		{"label": "Open rate", "value": round(t["open_rate"] * 100, 1), "datatype": "Percent"},
		{"label": "Attributed (direct)", "value": t["attributed_direct"], "datatype": "Currency"},
		{"label": "Attributed (assisted)", "value": t["attributed_assisted"], "datatype": "Currency"},
	]
	return columns, rows, None, chart, summary
