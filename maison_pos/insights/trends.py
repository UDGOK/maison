"""v0.5 L — product trends precomputed into ``Maison Product Trend``.

The dashboard "Products" tab must load in well under 300 ms with 100 boutiques, so nothing
is aggregated at request time: every 15 minutes (``hooks.scheduler_events``) — or on demand via
:func:`compute_trends` — this module folds the last 112 days of POS invoice lines into one row
per ``item × (boutique | ALL) × period``.

Periods
-------
``7d``   current = last 7 days (today included), previous = the 7 days before, baseline = the
         last 28 days divided by 4 (average 7-day window).
``28d``  current = last 28 days, previous = the 28 before, baseline = last 112 days / 4.

Per row: ``units``, ``units_prev``, ``units_baseline``, ``net``, ``net_prev``, ``velocity``
(units / week), ``delta_pct`` (vs previous period; ``None`` when the previous period sold
nothing), ``baseline_delta_pct``, ``rank`` (by net within boutique × period), ``rank_units``,
``share_pct`` (share of the boutique's net in the period), ``store_count`` (boutiques with units
in the period — on the ALL row), ``on_hand`` / ``sell_through`` / ``days_on_hand`` (from Bin),
and a ``badge``:

* **New**          sold this period, nothing in the previous period nor in the rest of the baseline
* **Trending up**  ≥ ``TREND_UP_PCT`` above the previous period *and* above the baseline (or no
                   previous period but ≥ 2 units and above baseline)
* **Cooling**      ≤ ``COOLING_PCT`` below the previous period (previous period sold ≥ 2 units)
* **Steady**       everything else

The math lives in :func:`trend_metrics` / :func:`badge_for` (pure python — unit-tested without a
site); :func:`build_rows` folds raw sales buckets into rows (also pure), :func:`compute_trends`
loads + writes.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any, Iterable, Optional

import frappe
from frappe.utils import add_days, cint, flt, getdate, now_datetime, nowdate

PERIODS: dict[str, int] = {"7d": 7, "28d": 28}
ALL = "ALL"
TREND_UP_PCT = 25.0
COOLING_PCT = -25.0
MIN_UNITS = 2.0
CACHE_PREFIX = "maison_product_trends"
LAST_RUN_KEY = "maison_trends_last_run"

FIELDS = [
	"name", "creation", "modified", "modified_by", "owner", "docstatus",
	"item_code", "item_name", "item_group", "boutique", "period", "badge", "rank", "rank_units", "store_count",
	"units", "units_prev", "units_baseline", "net", "net_prev", "velocity", "delta_pct", "baseline_delta_pct", "share_pct",
	"has_prev", "on_hand", "sell_through", "days_on_hand", "period_from", "period_to", "computed_at",
]


# ---------------------------------------------------------------------------
# pure math
# ---------------------------------------------------------------------------
def pct_change(current: float, previous: float) -> Optional[float]:
	"""Percent change, ``None`` when there is no previous value to compare against."""
	if previous <= 0:
		return None
	return round((current - previous) / previous * 100.0, 1)


def badge_for(units: float, units_prev: float, units_baseline: float, units_outside: float) -> str:
	"""Classify a row. *units_outside* = units sold in the baseline window but outside the current period."""
	if units > 0 and units_prev == 0 and units_outside == 0:
		return "New"
	d_prev = pct_change(units, units_prev)
	d_base = pct_change(units, units_baseline)
	if d_prev is not None:
		if d_prev >= TREND_UP_PCT and units >= MIN_UNITS and (d_base is None or d_base >= TREND_UP_PCT):
			return "Trending up"
		if d_prev <= COOLING_PCT and units_prev >= MIN_UNITS:
			return "Cooling"
	elif units >= MIN_UNITS and d_base is not None and d_base >= TREND_UP_PCT:
		return "Trending up"
	if units == 0 and units_prev >= MIN_UNITS:
		return "Cooling"
	return "Steady"


def trend_metrics(units: float, units_prev: float, units_4p: float, on_hand: float, days: int) -> dict[str, Any]:
	"""Velocity / deltas / badge / stock cover for one item × boutique × period.

	*units_4p* = units over the whole baseline window (4 × *days*, current period included).
	"""
	days = max(1, cint(days))
	units, units_prev, units_4p, on_hand = flt(units), flt(units_prev), flt(units_4p), flt(on_hand)
	baseline = round(units_4p / 4.0, 3)
	per_day = units / days
	velocity = round(per_day * 7, 3)
	doh = round(on_hand / per_day, 1) if per_day > 0 else None
	sell_through = round(units / (units + on_hand), 4) if (units + on_hand) > 0 else 0.0
	return {
		"units": units,
		"units_prev": units_prev,
		"units_baseline": baseline,
		"velocity": velocity,
		"delta_pct": pct_change(units, units_prev),
		"baseline_delta_pct": pct_change(units, baseline),
		"badge": badge_for(units, units_prev, baseline, max(0.0, units_4p - units)),
		"on_hand": on_hand,
		"sell_through": sell_through,
		"days_on_hand": doh,
	}


def rank_rows(rows: list[dict[str, Any]]) -> None:
	"""Assign ``rank`` (by net, then units) and ``rank_units`` within each (boutique, period) group, in place."""
	groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
	for r in rows:
		groups[(r["boutique"], r["period"])].append(r)
	for group in groups.values():
		total_net = sum(max(0.0, flt(r["net"])) for r in group)
		for i, r in enumerate(sorted(group, key=lambda r: (-flt(r["net"]), -flt(r["units"]), r["item_code"])), start=1):
			r["rank"] = i
			r["share_pct"] = round(flt(r["net"]) / total_net * 100.0, 2) if total_net > 0 else 0.0
		for i, r in enumerate(sorted(group, key=lambda r: (-flt(r["units"]), -flt(r["net"]), r["item_code"])), start=1):
			r["rank_units"] = i


def build_rows(
	sales: Iterable[dict[str, Any]],
	stock: dict[tuple[str, str], float],
	meta: dict[str, dict[str, Any]],
	today: Any = None,
) -> list[dict[str, Any]]:
	"""Fold bucketed sales into trend rows (per boutique and chain-wide ``ALL``), ranked.

	*sales* rows: ``{item_code, boutique, u7, n7, u7p, n7p, u28, n28, u28p, n28p, u112}`` (units / net
	in the current 7 d, previous 7 d, current 28 d, previous 28 d and the 112-day baseline window).
	"""
	today = getdate(today or nowdate())
	per_key: dict[tuple[str, str], dict[str, float]] = {}
	for s in sales:
		k = (s["item_code"], s["boutique"])
		acc = per_key.setdefault(k, defaultdict(float))
		for f in ("u7", "n7", "u7p", "n7p", "u28", "n28", "u28p", "n28p", "u112"):
			acc[f] += flt(s.get(f))
	# chain-wide buckets + store counts
	chain: dict[str, dict[str, float]] = {}
	stores_7: dict[str, set[str]] = defaultdict(set)
	stores_28: dict[str, set[str]] = defaultdict(set)
	chain_stock: dict[str, float] = defaultdict(float)
	for (code, b), acc in per_key.items():
		c = chain.setdefault(code, defaultdict(float))
		for f, v in acc.items():
			c[f] += v
		if acc["u7"] > 0:
			stores_7[code].add(b)
		if acc["u28"] > 0:
			stores_28[code].add(b)
	for (code, b), qty in stock.items():
		chain_stock[code] += flt(qty)

	rows: list[dict[str, Any]] = []

	def emit(code: str, boutique: str, acc: dict[str, float], on_hand: float, store_count: Optional[int]) -> None:
		m = meta.get(code) or {}
		for period, days in PERIODS.items():
			if period == "7d":
				u, n, up, np_, u4 = acc["u7"], acc["n7"], acc["u7p"], acc["n7p"], acc["u28"]
			else:
				u, n, up, np_, u4 = acc["u28"], acc["n28"], acc["u28p"], acc["n28p"], acc["u112"]
			if u == 0 and up == 0 and u4 == 0:
				continue
			tm = trend_metrics(u, up, u4, on_hand, days)
			tm.update(
				{
					"item_code": code,
					"item_name": m.get("item_name") or code,
					"item_group": m.get("item_group"),
					"boutique": boutique,
					"period": period,
					"net": round(n, 2),
					"net_prev": round(np_, 2),
					"store_count": store_count if store_count is not None else (1 if u > 0 else 0),
					"period_from": add_days(today, -days + 1),
					"period_to": today,
				}
			)
			rows.append(tm)

	for (code, b), acc in sorted(per_key.items()):
		emit(code, b, acc, stock.get((code, b), 0.0), None)
	for code, acc in sorted(chain.items()):
		# store_count for the ALL row is period-specific; patch after emit
		before = len(rows)
		emit(code, ALL, acc, chain_stock.get(code, 0.0), 0)
		for r in rows[before:]:
			r["store_count"] = len(stores_7[code] if r["period"] == "7d" else stores_28[code])
	rank_rows(rows)
	return rows


# ---------------------------------------------------------------------------
# loaders + writer
# ---------------------------------------------------------------------------
def load_sales_buckets(boutiques: list[str], today: Any = None) -> list[dict[str, Any]]:
	"""One grouped SQL over the last 112 days: units / net per item × boutique in each window."""
	if not boutiques:
		return []
	today = getdate(today or nowdate())
	d = {k: add_days(today, -v) for k, v in {"c7": 6, "p7": 13, "c28": 27, "p28": 55, "b112": 111}.items()}
	return frappe.db.sql(
		"""
		select sii.item_code, si.maison_boutique as boutique,
			sum(case when si.posting_date >= %(c7)s then sii.qty else 0 end) as u7,
			sum(case when si.posting_date >= %(c7)s then sii.amount else 0 end) as n7,
			sum(case when si.posting_date >= %(p7)s and si.posting_date < %(c7)s then sii.qty else 0 end) as u7p,
			sum(case when si.posting_date >= %(p7)s and si.posting_date < %(c7)s then sii.amount else 0 end) as n7p,
			sum(case when si.posting_date >= %(c28)s then sii.qty else 0 end) as u28,
			sum(case when si.posting_date >= %(c28)s then sii.amount else 0 end) as n28,
			sum(case when si.posting_date >= %(p28)s and si.posting_date < %(c28)s then sii.qty else 0 end) as u28p,
			sum(case when si.posting_date >= %(p28)s and si.posting_date < %(c28)s then sii.amount else 0 end) as n28p,
			sum(sii.qty) as u112
		from `tabSales Invoice Item` sii
		join `tabSales Invoice` si on si.name = sii.parent
		where si.docstatus = 1 and si.is_pos = 1 and si.posting_date >= %(b112)s and si.posting_date <= %(today)s
			and si.maison_boutique in %(boutiques)s
		group by sii.item_code, si.maison_boutique
		""",
		{**d, "today": today, "boutiques": tuple(boutiques)},
		as_dict=True,
	)


def load_stock(boutiques: list[str]) -> dict[tuple[str, str], float]:
	wh = {b.name: b.warehouse for b in frappe.get_all("Maison Boutique", filters={"name": ("in", boutiques)}, fields=["name", "warehouse"])}
	by_wh = {v: k for k, v in wh.items() if v}
	out: dict[tuple[str, str], float] = {}
	if by_wh:
		for r in frappe.get_all("Bin", filters={"warehouse": ("in", list(by_wh))}, fields=["item_code", "warehouse", "actual_qty"]):
			out[(r.item_code, by_wh[r.warehouse])] = flt(r.actual_qty)
	return out


def load_item_meta(codes: list[str]) -> dict[str, dict[str, Any]]:
	if not codes:
		return {}
	return {r.name: r for r in frappe.get_all("Item", filters={"name": ("in", codes)}, fields=["name", "item_name", "item_group"])}


def clear_cache() -> None:
	frappe.cache.delete_keys(CACHE_PREFIX)


def compute_trends(commit: bool = True, today: Any = None) -> dict[str, Any]:
	"""Recompute every ``Maison Product Trend`` row (idempotent; replaces the table).

	``bench --site X execute maison_pos.insights.trends.compute_trends``
	"""
	started = time.time()
	from maison_pos.scoping import warehouse_boutiques

	# v0.6 D4 — the head-office warehouse is not a shop and must not get a trend column
	_warehouses = warehouse_boutiques()
	boutiques = [b for b in frappe.get_all("Maison Boutique", filters={"enabled": 1}, pluck="name", order_by="name") if b not in _warehouses]
	sales = load_sales_buckets(boutiques, today)
	stock = load_stock(boutiques)
	codes = sorted({s["item_code"] for s in sales} | {k[0] for k in stock})
	rows = build_rows(sales, stock, load_item_meta(codes), today)
	now = now_datetime()
	frappe.db.delete("Maison Product Trend")
	values = []
	for i, r in enumerate(rows):
		values.append(
			[
				frappe.generate_hash(length=10), now, now, "Administrator", "Administrator", 0,
				r["item_code"], r["item_name"], r.get("item_group"), r["boutique"], r["period"], r["badge"], r["rank"], r["rank_units"], r["store_count"],
				r["units"], r["units_prev"], r["units_baseline"], r["net"], r["net_prev"], r["velocity"],
				r["delta_pct"] if r["delta_pct"] is not None else 0.0, r["baseline_delta_pct"] if r["baseline_delta_pct"] is not None else 0.0, r["share_pct"],
				1 if r["delta_pct"] is not None else 0,
				r["on_hand"], r["sell_through"], r["days_on_hand"] if r["days_on_hand"] is not None else 0.0, r["period_from"], r["period_to"], now,
			]
		)
	if values:
		frappe.db.bulk_insert("Maison Product Trend", FIELDS, values, chunk_size=2000)
	out = {"rows": len(rows), "items": len(codes), "boutiques": len(boutiques), "seconds": round(time.time() - started, 2), "computed_at": str(now)}
	frappe.db.set_default(LAST_RUN_KEY, frappe.as_json(out))
	clear_cache()
	if commit and not frappe.flags.in_test:
		frappe.db.commit()
	return out


def last_run() -> Optional[dict[str, Any]]:
	raw = frappe.db.get_default(LAST_RUN_KEY)
	if not raw:
		return None
	try:
		return frappe.parse_json(raw)
	except Exception:
		return None
