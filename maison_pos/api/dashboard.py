"""Head-office dashboard endpoints — v0.5 "Command".

* :func:`live_summary`   today's per-boutique aggregates (one grouped SQL, cached 5 s) with
                         ``vs_last_week_pct`` and a ``last_sale`` summary per boutique
* :func:`heartbeat`      POS devices ping every 60 s
* :func:`recent_sales` / :func:`ticker`   latest chain-wide sales (feed / ticker initial fill)
* :func:`boutique_feed` / :func:`boutique_detail`   store-level drill-in
* :func:`boutiques_table`  sortable Boutiques tab (today / WTD / MTD, vs LW, conversion, stock …)
* :func:`product_trends` / :func:`top_products`   read the precomputed ``Maison Product Trend`` table
* :func:`clients_overview`  churn-risk list, follow-up rates, upcoming dates, recognition stats

Every endpoint is boutique-scoped through :mod:`maison_pos.scoping` — scoped users (Manager /
Associate) only ever see their own boutique.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Count, Sum
from frappe.utils import add_days, add_to_date, cint, flt, get_datetime, getdate, now_datetime, nowdate

from maison_pos.api.recognition import recognition_counts
from maison_pos.maison_pos.doctype.maison_device_heartbeat.maison_device_heartbeat import upsert_heartbeat
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, get_allowed_boutiques, is_unrestricted
from maison_pos.tasks import STALE_AFTER_SECONDS
from maison_pos.utils import iso_with_tz, publish_heartbeat

LIVE_CACHE_SECONDS = 5
LIVE_CACHE_PREFIX = "maison_live_summary"
TRENDS_CACHE_PREFIX = "maison_product_trends"
TRENDS_CACHE_SECONDS = 60

# US state → region for the "Region" filter; boutiques outside the map show their state / country code.
_REGIONS = {
	"NY": "East", "NJ": "East", "CT": "East", "MA": "East", "PA": "East", "DC": "East", "MD": "East",
	"IL": "Midwest", "OH": "Midwest", "MI": "Midwest", "MN": "Midwest", "MO": "Midwest", "WI": "Midwest",
	"FL": "South", "TX": "South", "GA": "South", "NC": "South", "TN": "South", "LA": "South",
	"CA": "West", "WA": "West", "NV": "West", "AZ": "West", "CO": "West", "OR": "West", "HI": "West",
}


def _region_of(meta: dict[str, Any]) -> str:
	explicit = meta.get("region")
	if explicit:
		return explicit
	city = meta.get("city") or ""
	parts = [p.strip() for p in city.split(",")]
	if len(parts) >= 2:
		state = parts[1].split(" ")[0].upper()
		return _REGIONS.get(state, state or "—")
	return "—"


def _boutique_meta(boutiques: list[str]) -> dict[str, dict[str, Any]]:
	if not boutiques:
		return {}
	fields = ["name", "boutique_name", "city", "enabled", "warehouse"]
	if frappe.get_meta("Maison Boutique").has_field("region"):
		fields.append("region")
	return {b.name: b for b in frappe.get_all("Maison Boutique", filters={"name": ("in", boutiques)}, fields=fields)}


def _time_to_seconds(t: Any) -> int:
	if t is None:
		return 0
	if hasattr(t, "total_seconds"):
		return int(t.total_seconds())
	if isinstance(t, _dt.time):
		return t.hour * 3600 + t.minute * 60 + t.second
	parts = str(t).split(".")[0].split(":")
	return cint(parts[0]) * 3600 + cint(parts[1] if len(parts) > 1 else 0) * 60 + cint(parts[2] if len(parts) > 2 else 0)


def _walk_ins() -> tuple[str, ...]:
	"""POS Profile default customers ("Walk-in") never count as an identified client."""
	return tuple(c for c in frappe.get_all("POS Profile", pluck="customer") if c) or ("__none__",)


def _scope_key() -> str:
	return frappe.session.user if not is_unrestricted() else "all"


# ---------------------------------------------------------------------------
# live summary
# ---------------------------------------------------------------------------
@frappe.whitelist()
def live_summary(date: Optional[str] = None, nocache: int = 0) -> dict[str, Any]:
	"""Today's chain picture. Cached for 5 s per (user scope, date); a submitted sale clears the cache."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	day = getdate(date or nowdate())
	key = f"{LIVE_CACHE_PREFIX}:{_scope_key()}:{day}"
	if not cint(nocache):
		cached = frappe.cache.get_value(key, expires=True)
		if cached:
			cached["cached"] = True
			return cached
	out = _live_summary(day)
	frappe.cache.set_value(key, out, expires_in_sec=LIVE_CACHE_SECONDS)
	return out


def _live_summary(day: _dt.date) -> dict[str, Any]:
	boutiques = get_allowed_boutiques()
	meta = _boutique_meta(boutiques)
	b_tuple = tuple(boutiques) or ("__none__",)
	last_week = add_days(day, -7)

	# ONE grouped query: per boutique × hour — invoices, returns, net, cash/card tenders, change.
	rows = frappe.db.sql(
		"""
		select si.maison_boutique as boutique, hour(si.posting_time) as hr,
			sum(case when si.is_return = 0 then 1 else 0 end) as invoices,
			sum(case when si.is_return = 1 then 1 else 0 end) as returns,
			sum(si.grand_total) as net,
			sum(case when si.is_return = 1 then si.grand_total else 0 end) as returns_value,
			sum(case when si.is_return = 0 then si.change_amount else 0 end) as change_amt,
			sum((select coalesce(sum(p.amount), 0) from `tabSales Invoice Payment` p where p.parent = si.name and lower(p.mode_of_payment) = 'cash')) as cash,
			sum((select coalesce(sum(p.amount), 0) from `tabSales Invoice Payment` p where p.parent = si.name and lower(p.mode_of_payment) <> 'cash')) as card,
			sum(case when si.customer is not null and si.customer <> '' and si.customer not in %(walkins)s and si.is_return = 0 then 1 else 0 end) as with_customer
		from `tabSales Invoice` si
		where si.docstatus = 1 and si.is_pos = 1 and si.posting_date = %(day)s and si.maison_boutique in %(b)s
		group by si.maison_boutique, hour(si.posting_time)
		""",
		{"day": day, "b": b_tuple, "walkins": _walk_ins()},
		as_dict=True,
	)
	# same weekday last week, per boutique (for vs_last_week_pct)
	lw_rows = frappe.db.sql(
		"""
		select si.maison_boutique as boutique, sum(si.grand_total) as net
		from `tabSales Invoice` si
		where si.docstatus = 1 and si.is_pos = 1 and si.posting_date = %(day)s and si.maison_boutique in %(b)s
		group by si.maison_boutique
		""",
		{"day": last_week, "b": b_tuple},
		as_dict=True,
	)
	# last sale per boutique (item, amount, ts) — window function, MariaDB ≥ 10.2
	last_rows = frappe.db.sql(
		"""
		select boutique, name, grand_total, posting_date, posting_time, customer, is_return from (
			select si.maison_boutique as boutique, si.name, si.grand_total, si.posting_date, si.posting_time, si.customer, si.is_return,
				row_number() over (partition by si.maison_boutique order by si.creation desc) as rn
			from `tabSales Invoice` si
			where si.docstatus = 1 and si.is_pos = 1 and si.posting_date = %(day)s and si.maison_boutique in %(b)s
		) t where rn = 1
		""",
		{"day": day, "b": b_tuple},
		as_dict=True,
	)
	top_items = _top_items_for([r.name for r in last_rows])

	HB = DocType("Maison Device Heartbeat")
	hb_rows = (
		frappe.qb.from_(HB)
		.select(HB.boutique, HB.device_id, HB.status, HB.last_seen, HB.queued, HB.app_version)
		.where(HB.boutique.isin(boutiques) if boutiques else HB.boutique == "__none__")
	).run(as_dict=True)
	pending_by_boutique = {
		r.boutique: r.n
		for r in frappe.get_all(
			"Maison Price Change Request",
			filters={"workflow_state": "Pending Approval", "docstatus": 1, "boutique": ("in", boutiques or ["__none__"])},
			fields=["boutique", "count(name) as n"],
			group_by="boutique",
		)
	}
	low_stock = _low_stock_block(boutiques)
	feedback_open = _open_feedback_counts(boutiques)

	per_b: dict[str, dict[str, Any]] = {}
	for code in boutiques:
		m = meta.get(code, {})
		per_b[code] = {
			"boutique": code,
			"name": m.get("boutique_name") or code,
			"city": m.get("city"),
			"region": _region_of(m),
			"net": 0.0,
			"cash": 0.0,
			"card": 0.0,
			"invoices": 0,
			"returns": 0,
			"returns_value": 0.0,
			"with_customer": 0,
			"status": "offline",
			"last_seen": None,
			"queued": 0,
			"devices": 0,
			"pending_approvals": cint(pending_by_boutique.get(code, 0)),
			"low_stock": cint(low_stock["by_boutique"].get(code, 0)),
			"feedback_open": cint(feedback_open.get(code, 0)),
			"last_week_net": 0.0,
			"vs_last_week_pct": None,
			"last_sale": None,
			"by_hour": [0.0] * 24,
		}
	by_hour = {h: {"hour": h, "net": 0.0, "invoices": 0} for h in range(24)}
	for r in rows:
		b = per_b.get(r.boutique)
		if not b:
			continue
		b["invoices"] += cint(r.invoices)
		b["returns"] += cint(r.returns)
		b["net"] += flt(r.net)
		b["returns_value"] += abs(flt(r.returns_value))
		b["cash"] += flt(r.cash) - flt(r.change_amt)  # change handed back reduces cash in drawer
		b["card"] += flt(r.card)
		b["with_customer"] += cint(r.with_customer)
		h = cint(r.hr)
		if 0 <= h < 24:
			b["by_hour"][h] += flt(r.net)
			by_hour[h]["net"] += flt(r.net)
			by_hour[h]["invoices"] += cint(r.invoices)
	for r in lw_rows:
		b = per_b.get(r.boutique)
		if b:
			b["last_week_net"] = flt(r.net)
	for r in last_rows:
		b = per_b.get(r.boutique)
		if not b:
			continue
		ts = iso_with_tz(f"{r.posting_date} {r.posting_time}")
		b["last_sale"] = {"invoice": r.name, "item": top_items.get(r.name), "amount": flt(r.grand_total), "ts": ts, "is_return": cint(r.is_return)}
		b["last_sale_ts"] = ts
	for b in per_b.values():
		b["avg_ticket"] = (b["net"] / b["invoices"]) if b["invoices"] else 0.0
		b["vs_last_week_pct"] = round((b["net"] - b["last_week_net"]) / b["last_week_net"] * 100.0, 1) if b["last_week_net"] > 0 else None
		b["conversion"] = round(b["with_customer"] / b["invoices"], 3) if b["invoices"] else 0.0

	cutoff = add_to_date(now_datetime(), seconds=-STALE_AFTER_SECONDS)
	newest_seen: dict[str, Any] = {}
	for hb in hb_rows:
		b = per_b.get(hb.boutique)
		if not b:
			continue
		b["devices"] += 1
		last_seen = get_datetime(hb.last_seen) if hb.last_seen else None
		is_live = hb.status == "Online" and last_seen and last_seen >= cutoff
		if is_live:
			b["queued"] += cint(hb.queued)
			b["status"] = "online"
		if last_seen and (hb.boutique not in newest_seen or last_seen > newest_seen[hb.boutique]):
			newest_seen[hb.boutique] = last_seen
	for code, seen in newest_seen.items():
		per_b[code]["last_seen"] = iso_with_tz(seen)
	for b in per_b.values():
		if b["pending_approvals"] and b["status"] != "online":
			b["status"] = "pending_approval"
		if b["queued"] and b["status"] == "online":
			b["status"] = "queued"

	totals_net = sum(b["net"] for b in per_b.values())
	totals_inv = sum(b["invoices"] for b in per_b.values())
	lw_net = sum(b["last_week_net"] for b in per_b.values())
	pending_total = cint(sum(pending_by_boutique.values()))
	returns_count = sum(b["returns"] for b in per_b.values())
	returns_value = sum(b["returns_value"] for b in per_b.values())

	return {
		"date": str(day),
		"generated_at": now_datetime().isoformat(),
		"cached": False,
		"totals": {
			"net": totals_net,
			"invoices": totals_inv,
			"returns": returns_count,
			"returns_value": returns_value,
			"cash": sum(b["cash"] for b in per_b.values()),
			"card": sum(b["card"] for b in per_b.values()),
			"avg_ticket": (totals_net / totals_inv) if totals_inv else 0.0,
			"online": sum(1 for b in per_b.values() if b["status"] in ("online", "queued")),
			"boutiques": len(per_b),
			"last_week_net": lw_net,
			"vs_last_week_pct": round((totals_net - lw_net) / lw_net * 100.0, 1) if lw_net > 0 else None,
			"low_stock": cint(low_stock["open"]),
			"feedback_open": sum(b["feedback_open"] for b in per_b.values()),
			"pending_approvals": pending_total,
		},
		"regions": sorted({b["region"] for b in per_b.values()}),
		"by_boutique": sorted(per_b.values(), key=lambda b: (-b["net"], b["boutique"])),
		"by_hour": [by_hour[h] for h in range(24)],
		"pending_approvals": pending_total,
		"pending_approvals_list": _pending_list(boutiques) if is_unrestricted() else [],
		"recognition": recognition_counts(boutiques, day),
		"low_stock": low_stock,
		"returns": {"count": returns_count, "value": returns_value},
	}


def _top_items_for(invoices: list[str]) -> dict[str, str]:
	"""invoice → name of its highest-value line."""
	if not invoices:
		return {}
	rows = frappe.get_all("Sales Invoice Item", filters={"parent": ("in", invoices)}, fields=["parent", "item_name", "item_code", "amount"], order_by="amount desc")
	out: dict[str, str] = {}
	for r in rows:
		out.setdefault(r.parent, r.item_name or r.item_code)
	return out


def _open_feedback_counts(boutiques: list[str], max_rating: int = 2) -> dict[str, int]:
	"""Open ``Maison Feedback`` with rating ≤ *max_rating* per boutique (feature-detected)."""
	if not boutiques or not frappe.db.exists("DocType", "Maison Feedback"):
		return {}
	try:
		rows = frappe.get_all(
			"Maison Feedback",
			filters={"boutique": ("in", boutiques), "rating": ("<=", max_rating), "status": ("in", ("New", "Reviewed"))},
			fields=["boutique", "count(name) as n"],
			group_by="boutique",
		)
		return {r.boutique: cint(r.n) for r in rows}
	except Exception:
		return {}


def _pending_list(boutiques: list[str]) -> list[dict[str, Any]]:
	if not boutiques:
		return []
	return frappe.get_all(
		"Maison Price Change Request",
		filters={"workflow_state": "Pending Approval", "docstatus": 1, "boutique": ("in", boutiques)},
		fields=["name", "boutique", "item_code", "item_name", "current_rate", "proposed_rate", "requested_by", "modified"],
		order_by="modified asc",
		limit=50,
	)


# ---------------------------------------------------------------------------
# heartbeat
# ---------------------------------------------------------------------------
@frappe.whitelist()
def heartbeat(boutique: str, device_id: str, queued: int = 0, app_version: Optional[str] = None) -> dict[str, Any]:
	"""POS devices call this every 60 s. Upserts the heartbeat row and publishes ``maison_heartbeat``."""
	boutique = assert_boutique_access(boutique)
	device_id = (device_id or "").strip()
	if not device_id:
		frappe.throw(_("device_id is required"), frappe.ValidationError)
	ip = None
	try:
		ip = frappe.local.request_ip
	except Exception:  # pragma: no cover - not in a request
		pass
	row = upsert_heartbeat(boutique, device_id, queued=cint(queued), app_version=app_version, ip_address=ip)
	publish_heartbeat(row)
	return {"ok": True, "server_time": now_datetime().isoformat(), "status": "Online"}


# ---------------------------------------------------------------------------
# feeds
# ---------------------------------------------------------------------------
def _sales_rows(boutiques: list[str], limit: int, with_items: bool = True, date: Optional[Any] = None) -> list[dict[str, Any]]:
	if not boutiques:
		return []
	filters: dict[str, Any] = {"docstatus": 1, "is_pos": 1, "maison_boutique": ("in", boutiques)}
	if date:
		filters["posting_date"] = date
	rows = frappe.get_all(
		"Sales Invoice",
		filters=filters,
		fields=["name as invoice", "maison_boutique as boutique", "customer", "customer_name", "grand_total", "posting_date", "posting_time", "maison_associate as associate", "is_return"],
		order_by="creation desc",
		limit=min(max(cint(limit) or 20, 1), 200),
	)
	items: dict[str, list[dict[str, Any]]] = {}
	if with_items and rows:
		for it in frappe.get_all("Sales Invoice Item", filters={"parent": ("in", [r.invoice for r in rows])}, fields=["parent", "item_code", "item_name", "qty", "amount", "serial_no"], order_by="amount desc"):
			items.setdefault(it.parent, []).append({"item_code": it.item_code, "item_name": it.item_name, "qty": flt(it.qty), "amount": flt(it.amount), "serial_no": it.serial_no})
	for r in rows:
		r["posting_datetime"] = iso_with_tz(f"{r.posting_date} {r.posting_time}")
		r["amount"] = flt(r.grand_total)
		r["items"] = items.get(r.invoice, [])
		r["top_item"] = r["items"][0]["item_name"] if r["items"] else None
		r["is_return"] = cint(r.is_return)
	return rows


@frappe.whitelist()
def recent_sales(limit: int = 20, boutique: Optional[str] = None) -> list[dict[str, Any]]:
	"""Latest submitted POS invoices (chain-wide or one boutique) — initial fill before socket events."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutiques = [assert_boutique_access(boutique)] if boutique else get_allowed_boutiques()
	return _sales_rows(boutiques, cint(limit) or 20)


@frappe.whitelist()
def ticker(limit: int = 10) -> list[dict[str, Any]]:
	"""Compact chain-wide ticker rows: boutique, amount, top item, tier, ts (no PII)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	rows = _sales_rows(get_allowed_boutiques(), min(cint(limit) or 10, 50))
	from maison_pos.utils import customer_tier

	return [
		{
			"invoice": r["invoice"],
			"boutique": r["boutique"],
			"amount": r["amount"],
			"top_item": r["top_item"],
			"items": len(r["items"]),
			"tier": customer_tier(r["customer"]),
			"ts": r["posting_datetime"],
			"is_return": r["is_return"],
		}
		for r in rows
	]


@frappe.whitelist()
def boutique_feed(boutique: str, limit: int = 30) -> dict[str, Any]:
	"""Item-level feed + hourly bars for one boutique (today)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	day = getdate(nowdate())
	sales = _sales_rows([boutique], cint(limit) or 30, date=day)
	hours = [{"hour": h, "net": 0.0, "invoices": 0} for h in range(24)]
	for r in frappe.db.sql(
		"select hour(posting_time) as hr, sum(grand_total) as net, sum(case when is_return = 0 then 1 else 0 end) as n from `tabSales Invoice` where docstatus = 1 and is_pos = 1 and posting_date = %s and maison_boutique = %s group by hour(posting_time)",
		(day, boutique),
		as_dict=True,
	):
		h = cint(r.hr)
		if 0 <= h < 24:
			hours[h] = {"hour": h, "net": flt(r.net), "invoices": cint(r.n)}
	return {"boutique": boutique, "date": str(day), "sales": sales, "by_hour": hours}


# ---------------------------------------------------------------------------
# Boutiques tab
# ---------------------------------------------------------------------------
def _period_totals_by_boutique(boutiques: list[str], from_date: Any, to_date: Any) -> dict[str, dict[str, float]]:
	if not boutiques:
		return {}
	rows = frappe.db.sql(
		"""
		select maison_boutique as boutique, sum(grand_total) as net,
			sum(case when is_return = 0 then 1 else 0 end) as tickets,
			sum(case when is_return = 1 then 1 else 0 end) as returns,
			sum(case when is_return = 0 and customer is not null and customer <> '' and customer not in %(walkins)s then 1 else 0 end) as with_customer
		from `tabSales Invoice`
		where docstatus = 1 and is_pos = 1 and posting_date between %(f)s and %(t)s and maison_boutique in %(b)s
		group by maison_boutique
		""",
		{"f": from_date, "t": to_date, "b": tuple(boutiques), "walkins": _walk_ins()},
		as_dict=True,
	)
	return {r.boutique: {"net": flt(r.net), "tickets": cint(r.tickets), "returns": cint(r.returns), "with_customer": cint(r.with_customer)} for r in rows}


def _daily_series(boutiques: list[str], days: int, to_date: Any) -> dict[str, list[float]]:
	"""Net per day for the last *days* days, per boutique (sparkline)."""
	from_date = add_days(to_date, -days + 1)
	series = {b: [0.0] * days for b in boutiques}
	if not boutiques:
		return series
	for r in frappe.db.sql(
		"select maison_boutique as boutique, posting_date, sum(grand_total) as net from `tabSales Invoice` where docstatus = 1 and is_pos = 1 and posting_date between %(f)s and %(t)s and maison_boutique in %(b)s group by maison_boutique, posting_date",
		{"f": from_date, "t": to_date, "b": tuple(boutiques)},
		as_dict=True,
	):
		idx = (getdate(r.posting_date) - getdate(from_date)).days
		if r.boutique in series and 0 <= idx < days:
			series[r.boutique][idx] = flt(r.net)
	return series


def _stock_value(meta: dict[str, dict[str, Any]]) -> dict[str, float]:
	wh = {m["warehouse"]: code for code, m in meta.items() if m.get("warehouse")}
	out = {code: 0.0 for code in meta}
	if not wh:
		return out
	for r in frappe.get_all("Bin", filters={"warehouse": ("in", list(wh))}, fields=["warehouse", "sum(stock_value) as v"], group_by="warehouse"):
		out[wh[r.warehouse]] = flt(r.v)
	return out


def _on_shift(boutiques: list[str]) -> dict[str, int]:
	if not boutiques or not frappe.db.exists("DocType", "Maison Shift"):
		return {}
	try:
		rows = frappe.get_all("Maison Shift", filters={"boutique": ("in", boutiques), "status": ("in", ("On shift", "On break"))}, fields=["boutique", "count(name) as n"], group_by="boutique")
		return {r.boutique: cint(r.n) for r in rows}
	except Exception:
		return {}


@frappe.whitelist()
def boutiques_table(date: Optional[str] = None) -> dict[str, Any]:
	"""Rows for the sortable Boutiques table (today / WTD / MTD, vs LW, conversion, returns %, stock …)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	day = getdate(date or nowdate())
	live = live_summary(str(day))
	boutiques = [b["boutique"] for b in live["by_boutique"]]
	meta = _boutique_meta(boutiques)
	week_start = add_days(day, -day.weekday())
	month_start = day.replace(day=1)
	lw_start, lw_end = add_days(week_start, -7), add_days(day, -7)
	wtd = _period_totals_by_boutique(boutiques, week_start, day)
	lw = _period_totals_by_boutique(boutiques, lw_start, lw_end)
	mtd = _period_totals_by_boutique(boutiques, month_start, day)
	spark = _daily_series(boutiques, 14, day)
	stock_value = _stock_value(meta)
	on_shift = _on_shift(boutiques)
	rows = []
	for b in live["by_boutique"]:
		code = b["boutique"]
		w = wtd.get(code, {"net": 0.0, "tickets": 0, "returns": 0, "with_customer": 0})
		l = lw.get(code, {"net": 0.0, "tickets": 0, "returns": 0, "with_customer": 0})
		m = mtd.get(code, {"net": 0.0, "tickets": 0, "returns": 0, "with_customer": 0})
		rows.append(
			{
				**{k: b[k] for k in ("boutique", "name", "city", "region", "net", "invoices", "returns", "avg_ticket", "status", "last_seen", "queued", "pending_approvals", "low_stock", "vs_last_week_pct", "last_sale", "conversion")},
				"wtd_net": w["net"],
				"mtd_net": m["net"],
				"wtd_vs_lw_pct": round((w["net"] - l["net"]) / l["net"] * 100.0, 1) if l["net"] > 0 else None,
				"mtd_tickets": m["tickets"],
				"mtd_avg_ticket": (m["net"] / m["tickets"]) if m["tickets"] else 0.0,
				"mtd_conversion": round(m["with_customer"] / m["tickets"], 3) if m["tickets"] else 0.0,
				"returns_pct": round(m["returns"] / (m["tickets"] + m["returns"]) * 100.0, 1) if (m["tickets"] + m["returns"]) else 0.0,
				"stock_value": stock_value.get(code, 0.0),
				"on_shift": cint(on_shift.get(code, 0)),
				"sparkline": spark.get(code, []),
			}
		)
	return {"date": str(day), "rows": rows, "week_start": str(week_start), "month_start": str(month_start)}


@frappe.whitelist()
def boutique_detail(boutique: str, days: int = 28) -> dict[str, Any]:
	"""Drill-in page: hourly (today), top items (period), associates, recent sales, alerts, feedback."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	day = getdate(nowdate())
	days = max(1, min(cint(days) or 28, 365))
	from_date = add_days(day, -days + 1)
	feed = boutique_feed(boutique, 20)
	top_items = frappe.db.sql(
		"""
		select sii.item_code, sii.item_name, sum(sii.qty) as units, sum(sii.amount) as net
		from `tabSales Invoice Item` sii join `tabSales Invoice` si on si.name = sii.parent
		where si.docstatus = 1 and si.is_pos = 1 and si.maison_boutique = %(b)s and si.posting_date between %(f)s and %(t)s
		group by sii.item_code, sii.item_name order by net desc limit 10
		""",
		{"b": boutique, "f": from_date, "t": day},
		as_dict=True,
	)
	associates = frappe.db.sql(
		"""
		select si.maison_associate as associate, a.full_name as associate_name,
			sum(case when si.is_return = 0 then 1 else 0 end) as tickets, sum(si.grand_total) as net,
			sum(case when si.is_return = 0 and si.customer is not null and si.customer <> '' and si.customer not in %(walkins)s then 1 else 0 end) as with_customer
		from `tabSales Invoice` si left join `tabMaison Associate` a on a.name = si.maison_associate
		where si.docstatus = 1 and si.is_pos = 1 and si.maison_boutique = %(b)s and si.posting_date between %(f)s and %(t)s
			and si.maison_associate is not null and si.maison_associate <> ''
		group by si.maison_associate, a.full_name order by net desc
		""",
		{"b": boutique, "f": from_date, "t": day, "walkins": _walk_ins()},
		as_dict=True,
	)
	for a in associates:
		a["avg_ticket"] = flt(a.net) / cint(a.tickets) if cint(a.tickets) else 0.0
		a["conversion"] = round(cint(a.with_customer) / cint(a.tickets), 3) if cint(a.tickets) else 0.0
	alerts = frappe.get_all(
		"Maison Stock Alert",
		filters={"boutique": boutique, "status": ("in", ("Open", "Acknowledged"))},
		fields=["name", "item_code", "item_name", "qty", "reorder_level", "status"],
		order_by="qty asc",
		limit=10,
	)
	feedback: list[dict[str, Any]] = []
	if frappe.db.exists("DocType", "Maison Feedback"):
		try:
			feedback = frappe.get_all("Maison Feedback", filters={"boutique": boutique}, fields=["name", "rating", "comment", "status", "creation"], order_by="creation desc", limit=8)
			for f in feedback:
				f["creation"] = iso_with_tz(f["creation"])
		except Exception:
			feedback = []
	live = live_summary(str(day))
	row = next((b for b in live["by_boutique"] if b["boutique"] == boutique), None)
	return {
		"boutique": boutique,
		"row": row,
		"period": {"from": str(from_date), "to": str(day), "days": days},
		"by_hour": feed["by_hour"],
		"recent_sales": feed["sales"],
		"top_items": top_items,
		"associates": associates,
		"alerts": alerts,
		"feedback": feedback,
		"sparkline": _daily_series([boutique], 14, day).get(boutique, []),
	}


# ---------------------------------------------------------------------------
# Products tab — precomputed trends
# ---------------------------------------------------------------------------
TREND_FIELDS = [
	"item_code", "item_name", "item_group", "boutique", "period", "badge", "rank", "rank_units", "store_count",
	"units", "units_prev", "units_baseline", "net", "net_prev", "velocity", "delta_pct", "baseline_delta_pct", "share_pct",
	"has_prev", "on_hand", "sell_through", "days_on_hand", "period_from", "period_to", "computed_at",
]


def _period_arg(period: Any) -> str:
	from maison_pos.insights.trends import PERIODS

	p = str(period or "7d").strip().lower()
	if p.isdigit():
		p = f"{p}d"
	if p not in PERIODS:
		frappe.throw(_("period must be one of {0}").format(", ".join(PERIODS)), frappe.ValidationError)
	return p


def _trend_rows(filters: dict[str, Any], order_by: str, limit: int) -> list[dict[str, Any]]:
	rows = frappe.get_all("Maison Product Trend", filters=filters, fields=TREND_FIELDS, order_by=order_by, limit=limit)
	for r in rows:
		for k in ("period_from", "period_to", "computed_at"):
			if r.get(k) is not None:
				r[k] = str(r[k])
		# Float columns are NOT NULL in Frappe; restore the "undefined" semantics
		if not cint(r.get("has_prev")):
			r["delta_pct"] = None
		if flt(r.get("units_baseline")) <= 0:
			r["baseline_delta_pct"] = None
		if flt(r.get("velocity")) <= 0:
			r["days_on_hand"] = None
	return rows


def _cached(key: str, build):
	cached = frappe.cache.get_value(key, expires=True)  # expires=True: never pinned in frappe.local.cache
	if cached:
		cached["cached"] = True
		return cached
	out = build()
	out["cached"] = False
	frappe.cache.set_value(key, out, expires_in_sec=TRENDS_CACHE_SECONDS)
	return out


@frappe.whitelist()
def product_trends(scope: str = "chain", boutique: Optional[str] = None, group: Optional[str] = None, period: Any = "7d", limit: int = 60, badge: Optional[str] = None) -> dict[str, Any]:
	"""Items ranked by velocity change (``delta_pct``), from the precomputed table.

	*scope* ``chain`` → the ``ALL`` rows; ``boutique`` → rows of *boutique*. *group* filters by item group.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	from maison_pos.insights import trends

	period = _period_arg(period)
	if scope == "boutique" or boutique:
		boutique = assert_boutique_access(boutique)
		scope = "boutique"
	else:
		if not is_unrestricted():
			boutique = assert_boutique_access(None)
			scope = "boutique"
		else:
			boutique = trends.ALL
	limit = min(max(cint(limit) or 60, 1), 500)
	key = f"{TRENDS_CACHE_PREFIX}:trends:{scope}:{boutique}:{group or 'any'}:{period}:{limit}:{badge or 'any'}"

	def build() -> dict[str, Any]:
		filters: dict[str, Any] = {"boutique": boutique, "period": period}
		if group:
			filters["item_group"] = group
		if badge:
			filters["badge"] = badge
		rows = _trend_rows(filters, "units desc, net desc", 2000)
		# velocity-change ranking: items with a previous period first (largest delta), then New, then steady/no-prev
		def sort_key(r: dict[str, Any]):
			d = r.get("delta_pct")
			return (0 if d is not None else 1, -(d if d is not None else 0), -flt(r.get("units")), -flt(r.get("net")))

		rows.sort(key=sort_key)
		badges: dict[str, int] = {}
		for r in rows:
			badges[r["badge"] or "Steady"] = badges.get(r["badge"] or "Steady", 0) + 1
		groups = sorted({r["item_group"] for r in frappe.get_all("Maison Product Trend", filters={"boutique": boutique, "period": period}, fields=["item_group"], distinct=True) if r.item_group})
		return {
			"scope": scope,
			"boutique": boutique,
			"period": period,
			"group": group,
			"rows": rows[:limit],
			"total": len(rows),
			"badges": badges,
			"groups": groups,
			"computed_at": rows[0]["computed_at"] if rows else None,
			"last_run": trends.last_run(),
		}

	return _cached(key, build)


@frappe.whitelist()
def top_products(boutique: Optional[str] = "all", by: str = "net", period: Any = "7d", n: int = 10) -> dict[str, Any]:
	"""Per-boutique top *n* by net or units with share of boutique sales, plus the item-group × boutique matrix."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	from maison_pos.insights import trends

	period = _period_arg(period)
	by = "units" if str(by).lower() == "units" else "net"
	n = min(max(cint(n) or 10, 1), 50)
	if boutique and boutique.lower() != "all":
		boutiques = [assert_boutique_access(boutique)]
	else:
		boutiques = get_allowed_boutiques()
	key = f"{TRENDS_CACHE_PREFIX}:top:{','.join(boutiques)}:{by}:{period}:{n}"

	def build() -> dict[str, Any]:
		rank_field = "rank_units" if by == "units" else "rank"
		rows = _trend_rows({"boutique": ("in", boutiques or ["__none__"]), "period": period, rank_field: ("<=", n), "units": (">", 0)}, f"boutique asc, {rank_field} asc", 5000)
		per: dict[str, list[dict[str, Any]]] = {b: [] for b in boutiques}
		for r in rows:
			per.setdefault(r["boutique"], []).append(r)
		# matrix item_group × boutique (net + units) from the same table
		matrix_rows = frappe.get_all(
			"Maison Product Trend",
			filters={"boutique": ("in", boutiques or ["__none__"]), "period": period},
			fields=["item_group", "boutique", "sum(net) as revenue", "sum(units) as units", "sum(on_hand) as on_hand"],
			group_by="item_group, boutique",
		)
		groups = sorted({m.item_group for m in matrix_rows if m.item_group})
		n_b = max(1, len(boutiques))
		chain_avg = {g: sum(flt(m.revenue) for m in matrix_rows if m.item_group == g) / n_b for g in groups}
		matrix = [
			{
				"item_group": m.item_group,
				"boutique": m.boutique,
				"revenue": flt(m.revenue),
				"units": flt(m.units),
				"on_hand": flt(m.on_hand),
				"index": round(flt(m.revenue) / chain_avg[m.item_group], 2) if chain_avg.get(m.item_group) else None,
			}
			for m in matrix_rows
			if m.item_group
		]
		totals = {b: sum(flt(r["net"]) for r in frappe.get_all("Maison Product Trend", filters={"boutique": b, "period": period}, fields=["net"])) for b in boutiques}
		return {"period": period, "by": by, "n": n, "boutiques": boutiques, "top": per, "matrix": matrix, "groups": groups, "boutique_net": totals, "last_run": trends.last_run()}

	return _cached(key, build)


@frappe.whitelist()
def compute_trends() -> dict[str, Any]:
	"""On-demand recompute (Head Office / Regional / System Manager)."""
	assert_roles("Maison Head Office", "Maison Regional", "System Manager")
	from maison_pos.insights.trends import compute_trends as _compute

	return _compute(commit=not frappe.flags.in_test)


# ---------------------------------------------------------------------------
# Clients tab
# ---------------------------------------------------------------------------
@frappe.whitelist()
def clients_overview(boutique: Optional[str] = None, tiers: Any = None, limit: int = 40) -> dict[str, Any]:
	"""Churn-risk list for top tiers, follow-up rates per associate (30 d), upcoming dates, recognition,
	campaign performance (when ``campaigns.performance`` exists). Everything feature-detected."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if boutique or not is_unrestricted():
		boutique = assert_boutique_access(boutique)
	boutiques = [boutique] if boutique else get_allowed_boutiques()
	day = getdate(nowdate())
	from_30 = add_days(day, -30)
	tier_filter = [t for t in (tiers if isinstance(tiers, list) else (frappe.parse_json(tiers) if isinstance(tiers, str) and tiers.startswith("[") else (tiers or "").split(","))) if t]
	limit = min(max(cint(limit) or 40, 1), 200)

	# churn risk: Maison Client Signal rows, top tiers first
	churn: list[dict[str, Any]] = []
	upcoming: list[dict[str, Any]] = []
	if frappe.db.exists("DocType", "Maison Client Signal"):
		filters: dict[str, Any] = {"status": "Open"}
		if boutique:
			filters["boutique"] = boutique
		elif not is_unrestricted():
			filters["boutique"] = ("in", boutiques or ["__none__"])
		fields = ["name", "customer", "customer_name", "boutique", "preferred_associate", "signal_type", "priority", "reason", "churn_risk", "cadence_days", "expected_next_visit", "last_visit", "days_since_last_visit", "visits", "lifetime_spend", "spend_trend"]
		rows = frappe.get_all("Maison Client Signal", filters=filters, fields=fields, order_by="churn_risk desc, lifetime_spend desc", limit=500)
		tiers_by_customer = _tiers_for([r.customer for r in rows])
		for r in rows:
			r["tier"] = tiers_by_customer.get(r.customer)
			for k in ("expected_next_visit", "last_visit"):
				if r.get(k) is not None:
					r[k] = str(r[k])
		if tier_filter:
			rows = [r for r in rows if (r["tier"] or "") in tier_filter]
		churn = [r for r in rows if r.signal_type in ("VIP lapsing", "Overdue visit", "Spend drop") or flt(r.churn_risk) >= 0.5][:limit]
		upcoming = [r for r in rows if r.signal_type in ("Birthday", "Anniversary", "Due this week")][:limit]

	# follow-up rates per associate: CRM tasks (Maison Client Interaction) completed / assigned, 30 d
	follow_ups: list[dict[str, Any]] = []
	if frappe.db.exists("DocType", "Maison Client Interaction"):
		try:
			fu = frappe.db.sql(
				"""
				select i.associate, a.full_name as associate_name, a.boutique,
					count(i.name) as assigned,
					sum(case when i.status = 'Done' then 1 else 0 end) as completed
				from `tabMaison Client Interaction` i left join `tabMaison Associate` a on a.name = i.associate
				where i.creation >= %(f)s and i.associate is not null and i.associate <> '' and (a.boutique in %(b)s or a.boutique is null)
				group by i.associate, a.full_name, a.boutique order by completed desc
				""",
				{"f": f"{from_30} 00:00:00", "b": tuple(boutiques) or ("__none__",)},
				as_dict=True,
			)
			for r in fu:
				r["rate"] = round(cint(r.completed) / cint(r.assigned), 3) if cint(r.assigned) else 0.0
			follow_ups = fu
		except Exception:
			follow_ups = []

	# associate performance (hr.employee_performance) — feature-detected
	performance: list[dict[str, Any]] = []
	try:
		from maison_pos.api import hr

		if hasattr(hr, "employee_performance") and is_unrestricted():
			performance = hr.employee_performance(boutique=boutique, from_date=str(from_30), to_date=str(day))
	except Exception:
		performance = []

	# campaign performance — present only once section M lands
	campaigns: Optional[dict[str, Any]] = None
	try:
		from maison_pos.api import campaigns as _campaigns  # type: ignore

		if hasattr(_campaigns, "performance"):
			campaigns = _campaigns.performance()
	except Exception:
		campaigns = None

	recognition = recognition_counts(boutiques, day)
	enrolled_total = frappe.db.count("Customer", {"maison_face_consent": 1}) if frappe.get_meta("Customer").has_field("maison_face_consent") else 0
	return {
		"boutique": boutique,
		"tiers": tier_filter,
		"churn": churn,
		"upcoming": upcoming,
		"follow_ups": follow_ups,
		"performance": performance,
		"campaigns": campaigns,
		"recognition": {**(recognition or {}), "enrolled_total": enrolled_total},
		"as_of": str(day),
	}


def _tiers_for(customers: list[str]) -> dict[str, Optional[str]]:
	"""Tier per customer from the loyalty programme's spend thresholds — one grouped query, no per-row calls."""
	out: dict[str, Optional[str]] = {c: None for c in customers}
	if not customers:
		return out
	tiers = frappe.get_all("Loyalty Program Collection", fields=["parent", "tier_name", "min_spent"], order_by="min_spent asc")
	if not tiers:
		return out
	programs = frappe.get_all("Customer", filters={"name": ("in", customers)}, fields=["name", "loyalty_program"])
	spend = {
		r.customer: flt(r.total)
		for r in frappe.get_all("Sales Invoice", filters={"docstatus": 1, "customer": ("in", customers)}, fields=["customer", "sum(base_grand_total) as total"], group_by="customer")
	}
	by_prog: dict[str, list[dict[str, Any]]] = {}
	for t in tiers:
		by_prog.setdefault(t.parent, []).append(t)
	for p in programs:
		if not p.loyalty_program or p.loyalty_program not in by_prog:
			continue
		s = spend.get(p.name, 0.0)
		tier = None
		for t in by_prog[p.loyalty_program]:
			if s >= flt(t.min_spent):
				tier = t.tier_name
		out[p.name] = tier
	return out


# ---------------------------------------------------------------------------
# v0.4 D/E — dashboard tiles
# ---------------------------------------------------------------------------
def _low_stock_block(boutiques: list[str]) -> dict[str, Any]:
	"""``{open, by_boutique: {code: n}, top: [...]}`` for the "Low stock" tile (drill-down = inventory.alerts)."""
	from maison_pos.api.inventory import open_alert_counts

	counts = open_alert_counts(boutiques)
	top = frappe.get_all(
		"Maison Stock Alert",
		filters={"status": ("in", ("Open", "Acknowledged")), "boutique": ("in", boutiques or ["__none__"])},
		fields=["name", "item_code", "item_name", "boutique", "qty", "reorder_level", "status"],
		order_by="qty asc, first_seen asc",
		limit=8,
	)
	return {"open": sum(counts.values()), "by_boutique": counts, "top": top}


def _returns_block(boutiques: list[str], day) -> dict[str, Any]:
	"""Today's credit notes (count + value) — kept for callers of the v0.4 helper."""
	SI = DocType("Sales Invoice")
	rows = (
		frappe.qb.from_(SI)
		.select(Count(SI.name).as_("n"), Sum(SI.grand_total).as_("value"))
		.where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.is_return == 1) & (SI.posting_date == day) & (SI.maison_boutique.isin(boutiques or ["__none__"])))
	).run(as_dict=True)
	r = rows[0] if rows else {}
	return {"count": cint(r.get("n")), "value": abs(flt(r.get("value")))}
