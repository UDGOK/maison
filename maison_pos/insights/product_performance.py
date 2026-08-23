"""Product performance per item × boutique, and rebalance suggestions.

Metrics over a *period* of ``days`` (default 90):

* units, revenue           sold (returns netted)
* velocity                 units per week
* on_hand                  current ``Bin.actual_qty`` (serialized pieces count 1 each)
* days_on_hand             on_hand / (units per day); ``None`` when nothing sold (∞)
* sell_through             units / (units + on_hand)
* chain_velocity           average velocity of the item across boutiques
* index                    velocity / chain_velocity (1 = chain average)
* stock_out_risk           on hand will not cover ``RISK_COVER_DAYS`` at the current velocity

Rebalance rule (:func:`suggest_rebalances`) — for each item, pair boutiques that are *slow*
(on hand and days_on_hand ≥ ``SLOW_DOH`` or zero velocity with stock) with boutiques that are
*fast* (stock-out risk with velocity > 0). Move ``qty = min(surplus, need)`` where
``surplus = on_hand_slow − keep`` (keep = what the slow store would sell in ``KEEP_DAYS``) and
``need = cover_units_fast − on_hand_fast``. Services / non-stock items are ignored.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Optional

import frappe
from frappe.utils import add_days, cint, flt, getdate, nowdate

DEFAULT_DAYS = 90
RISK_COVER_DAYS = 21
SLOW_DOH = 120.0
KEEP_DAYS = 45
MIN_MOVE_VALUE = 300.0


# ---------------------------------------------------------------------------
# pure math
# ---------------------------------------------------------------------------
def metrics(units: float, on_hand: float, days: int) -> dict[str, Any]:
	days = max(1, int(days))
	per_day = units / days
	velocity = round(per_day * 7, 3)
	doh = round(on_hand / per_day, 1) if per_day > 0 else None
	sell_through = round(units / (units + on_hand), 4) if (units + on_hand) > 0 else 0.0
	risk = bool(per_day > 0 and on_hand < per_day * RISK_COVER_DAYS)
	return {"units": units, "on_hand": on_hand, "velocity": velocity, "days_on_hand": doh, "sell_through": sell_through, "stock_out_risk": risk}


def suggest_rebalances(rows: list[dict[str, Any]], days: int = DEFAULT_DAYS) -> list[dict[str, Any]]:
	"""*rows*: one per item × boutique with item_code, boutique, units, on_hand (+ optional rate).

	Returns move suggestions sorted by value (largest first). Pure python for testability.
	"""
	days = max(1, int(days))
	by_item: dict[str, list[dict[str, Any]]] = defaultdict(list)
	for r in rows:
		by_item[r["item_code"]].append(r)
	out: list[dict[str, Any]] = []
	for item_code, stores in by_item.items():
		enriched = []
		for r in stores:
			m = metrics(flt(r.get("units")), flt(r.get("on_hand")), days)
			m.update({"boutique": r["boutique"], "item_code": item_code, "rate": flt(r.get("rate")), "per_day": flt(r.get("units")) / days})
			enriched.append(m)
		slow = [e for e in enriched if e["on_hand"] > 0 and (e["days_on_hand"] is None or e["days_on_hand"] >= SLOW_DOH)]
		fast = [e for e in enriched if e["stock_out_risk"]]
		if not slow or not fast:
			continue
		slow.sort(key=lambda e: -(e["days_on_hand"] if e["days_on_hand"] is not None else 1e9))
		fast.sort(key=lambda e: -e["per_day"])
		for f in fast:
			need = math.ceil(f["per_day"] * RISK_COVER_DAYS * 1.5) - f["on_hand"]
			if need <= 0:
				continue
			for s in slow:
				keep = math.ceil(s["per_day"] * KEEP_DAYS)
				surplus = int(s["on_hand"] - keep)
				if surplus <= 0:
					continue
				qty = int(min(surplus, need))
				if qty <= 0:
					continue
				value = qty * s["rate"]
				if s["rate"] and value < MIN_MOVE_VALUE:
					continue
				out.append(
					{
						"item_code": item_code,
						"from_boutique": s["boutique"],
						"to_boutique": f["boutique"],
						"qty": qty,
						"value": round(value, 2),
						"from_on_hand": s["on_hand"],
						"to_on_hand": f["on_hand"],
						"from_velocity": s["velocity"],
						"to_velocity": f["velocity"],
						"from_days_on_hand": s["days_on_hand"],
						"to_days_on_hand": f["days_on_hand"],
						"reason": (
							f"{f['boutique']} sells {f['velocity']:g}/wk and has {int(f['on_hand'])} on hand "
							f"({'~' + str(int(f['days_on_hand'])) + ' days' if f['days_on_hand'] is not None else 'no'} cover); "
							f"{s['boutique']} holds {int(s['on_hand'])} with "
							f"{'no sales' if s['days_on_hand'] is None else str(int(s['days_on_hand'])) + ' days of cover'} in the last {days} days"
						),
					}
				)
				s["on_hand"] -= qty
				need -= qty
				if need <= 0:
					break
	out.sort(key=lambda r: (-r["value"], r["item_code"]))
	return out


# ---------------------------------------------------------------------------
# loaders
# ---------------------------------------------------------------------------
def _period(days: Optional[int]) -> tuple[str, str, int]:
	days = max(7, cint(days) or DEFAULT_DAYS)
	to = nowdate()
	return add_days(to, -days + 1), to, days


def load_sales(from_date: str, to_date: str, boutiques: list[str]) -> list[dict[str, Any]]:
	"""Units / revenue per item × boutique (returns are negative rows and net out)."""
	if not boutiques:
		return []
	SI = frappe.qb.DocType("Sales Invoice")
	SII = frappe.qb.DocType("Sales Invoice Item")
	from frappe.query_builder.functions import Count, Sum

	return (
		frappe.qb.from_(SII)
		.join(SI)
		.on(SII.parent == SI.name)
		.select(SII.item_code, SI.maison_boutique.as_("boutique"), Sum(SII.qty).as_("units"), Sum(SII.amount).as_("revenue"), Count(SI.name).as_("lines"))
		.where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.posting_date >= from_date) & (SI.posting_date <= to_date) & SI.maison_boutique.isin(boutiques))
		.groupby(SII.item_code, SI.maison_boutique)
	).run(as_dict=True)


def load_stock(boutiques: list[str]) -> tuple[dict[tuple[str, str], float], dict[str, str]]:
	wh = {b.name: b.warehouse for b in frappe.get_all("Maison Boutique", filters={"name": ("in", boutiques)}, fields=["name", "warehouse"])}
	by_wh = {v: k for k, v in wh.items()}
	stock: dict[tuple[str, str], float] = {}
	if by_wh:
		for r in frappe.get_all("Bin", filters={"warehouse": ("in", list(by_wh.keys()))}, fields=["item_code", "warehouse", "actual_qty"]):
			stock[(r.item_code, by_wh[r.warehouse])] = flt(r.actual_qty)
	return stock, wh


def product_performance(days: Optional[int] = None, boutiques: Optional[list[str]] = None) -> dict[str, Any]:
	"""Full performance payload: items × boutiques, heatmap, top / slow movers, rebalance list."""
	from_date, to_date, days = _period(days)
	from maison_pos.scoping import warehouse_boutiques

	# v0.6 D4 — shops only; the head-office warehouse row is not a store
	_warehouses = warehouse_boutiques()
	boutiques = boutiques or [b for b in frappe.get_all("Maison Boutique", filters={"enabled": 1}, pluck="name", order_by="name") if b not in _warehouses]
	sales = load_sales(from_date, to_date, boutiques)
	stock, _wh = load_stock(boutiques)
	codes = sorted({r.item_code for r in sales} | {k[0] for k in stock.keys()})
	meta = {
		r.name: r
		for r in frappe.get_all("Item", filters={"name": ("in", codes)}, fields=["name", "item_name", "item_group", "is_stock_item", "has_serial_no", "standard_rate", "disabled"])
	} if codes else {}
	prices = {p.item_code: flt(p.price_list_rate) for p in frappe.get_all("Item Price", filters={"item_code": ("in", codes), "price_list": "Standard Selling", "selling": 1}, fields=["item_code", "price_list_rate"])} if codes else {}
	sold: dict[tuple[str, str], dict[str, float]] = {(r.item_code, r.boutique): {"units": flt(r.units), "revenue": flt(r.revenue)} for r in sales}

	rows: list[dict[str, Any]] = []
	chain_units: dict[str, float] = defaultdict(float)
	for code in codes:
		m = meta.get(code)
		if not m or m.disabled:
			continue
		for b in boutiques:
			s = sold.get((code, b), {"units": 0.0, "revenue": 0.0})
			on_hand = stock.get((code, b), 0.0) if cint(m.is_stock_item) else 0.0
			if s["units"] == 0 and on_hand <= 0:
				continue
			mt = metrics(s["units"], on_hand, days)
			mt.update(
				{
					"item_code": code,
					"item_name": m.item_name,
					"item_group": m.item_group,
					"boutique": b,
					"revenue": round(s["revenue"], 2),
					"rate": prices.get(code, flt(m.standard_rate)),
					"is_stock_item": cint(m.is_stock_item),
					"has_serial_no": cint(m.has_serial_no),
				}
			)
			rows.append(mt)
			chain_units[code] += s["units"]
	n_b = max(1, len(boutiques))
	for r in rows:
		chain_velocity = chain_units[r["item_code"]] / n_b / days * 7
		r["chain_velocity"] = round(chain_velocity, 3)
		r["index"] = round(r["velocity"] / chain_velocity, 2) if chain_velocity > 0 else None

	# heatmap item_group × boutique
	groups = sorted({r["item_group"] for r in rows})
	heat: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: {"revenue": 0.0, "units": 0.0, "on_hand": 0.0})
	for r in rows:
		h = heat[(r["item_group"], r["boutique"])]
		h["revenue"] += r["revenue"]
		h["units"] += r["units"]
		h["on_hand"] += r["on_hand"]
	group_chain = defaultdict(float)
	for (g, _b), h in heat.items():
		group_chain[g] += h["revenue"]
	heatmap = []
	for g in groups:
		for b in boutiques:
			h = heat.get((g, b), {"revenue": 0.0, "units": 0.0, "on_hand": 0.0})
			avg = group_chain[g] / n_b
			heatmap.append({"item_group": g, "boutique": b, "revenue": round(h["revenue"], 2), "units": h["units"], "on_hand": h["on_hand"], "index": round(h["revenue"] / avg, 2) if avg > 0 else None})

	top: dict[str, list] = {}
	slow: dict[str, list] = {}
	for b in boutiques:
		mine = [r for r in rows if r["boutique"] == b]
		top[b] = sorted([r for r in mine if r["units"] > 0], key=lambda r: (-r["revenue"], -r["units"]))[:5]
		slow[b] = sorted(
			[r for r in mine if r["on_hand"] > 0 and r["is_stock_item"]],
			key=lambda r: (-(r["days_on_hand"] if r["days_on_hand"] is not None else 1e9), -r["on_hand"] * r["rate"]),
		)[:5]

	rebalance = suggest_rebalances([r for r in rows if r["is_stock_item"]], days)
	names = {r["item_code"]: r["item_name"] for r in rows}
	for s in rebalance:
		s["item_name"] = names.get(s["item_code"])
	return {
		"period": {"from": from_date, "to": to_date, "days": days},
		"boutiques": boutiques,
		"item_groups": groups,
		"items": rows,
		"heatmap": heatmap,
		"top_movers": top,
		"slow_movers": slow,
		"rebalance": rebalance,
		"totals": {
			"revenue": round(sum(r["revenue"] for r in rows), 2),
			"units": sum(r["units"] for r in rows),
			"stock_out_risks": sum(1 for r in rows if r["stock_out_risk"]),
		},
	}


def compute_rebalance_suggestions(days: int = DEFAULT_DAYS) -> dict[str, Any]:
	"""Weekly job: refresh Open ``Maison Rebalance Suggestion`` rows (keeps Transferred / Dismissed)."""
	perf = product_performance(days)
	frappe.db.delete("Maison Rebalance Suggestion", {"status": "Open"})
	dismissed = {
		(r.item_code, r.from_boutique, r.to_boutique)
		for r in frappe.get_all("Maison Rebalance Suggestion", filters={"status": "Dismissed"}, fields=["item_code", "from_boutique", "to_boutique"])
	}
	computed_at = frappe.utils.now_datetime()
	created = 0
	for s in perf["rebalance"]:
		if (s["item_code"], s["from_boutique"], s["to_boutique"]) in dismissed:
			continue
		meta = frappe.db.get_value("Item", s["item_code"], ["item_name", "item_group", "has_serial_no"], as_dict=True)
		doc = frappe.get_doc(
			{
				"doctype": "Maison Rebalance Suggestion",
				"item_code": s["item_code"],
				"item_name": meta.item_name,
				"item_group": meta.item_group,
				"has_serial_no": cint(meta.has_serial_no),
				"from_boutique": s["from_boutique"],
				"to_boutique": s["to_boutique"],
				"qty": s["qty"],
				"value": s["value"],
				"from_on_hand": s["from_on_hand"],
				"to_on_hand": s["to_on_hand"],
				"from_velocity": s["from_velocity"],
				"to_velocity": s["to_velocity"],
				"from_days_on_hand": s["from_days_on_hand"],
				"to_days_on_hand": s["to_days_on_hand"],
				"reason": s["reason"],
				"period_days": days,
				"status": "Open",
				"computed_at": computed_at,
			}
		)
		doc.insert(ignore_permissions=True)
		created += 1
	return {"suggestions": created, "items": len(perf["items"])}
