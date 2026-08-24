"""What to buy (SPEC_v1.0 §C) — the demand engine behind the Buying screen.

Three independent sources, deduped by item:

1. **Low stock** — HOU-WH quantity at or below its ``Item Reorder`` level for the main warehouse.
2. **Store demand** — open store replenishment requests the warehouse *cannot* fill from HOU-WH
   stock; only the shortfall is bought.
3. **Trending** — items ``insights/trends.py`` flags *Trending up* chain-wide whose HOU-WH cover
   (on hand ÷ daily velocity) is under a configurable horizon
   (``AWANZ POS Settings.purchase_cover_days``, default 21 days).

An item that appears in more than one source is bought **once**, for the largest of the three
needs, less what is already on order, rounded **up** to the preferred vendor's case pack and
never below their MOQ. Everything stays editable before the buyer commits.

A run is cached in ``AWANZ Purchase Suggestion`` so a buyer can work the list across a session;
``maison_pos.purchasing.demand.daily_run`` refreshes it every morning at 06:00 site time.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

import frappe
from frappe.utils import add_days, cint, flt, nowdate

from maison_pos.purchasing import main_warehouse, round_up_to_case_pack
from maison_pos.purchasing.vendors import item_vendor_rows

SOURCE_LOW_STOCK = "Low stock"
SOURCE_STORE_DEMAND = "Store demand"
SOURCE_TRENDING = "Trending"
#: most urgent first — the badge the Buying screen shows for a deduped row
SOURCE_ORDER = (SOURCE_LOW_STOCK, SOURCE_STORE_DEMAND, SOURCE_TRENDING)
DEFAULT_COVER_DAYS = 21
#: an item dismissed by the buyer stays off the list for this long
DISMISS_DAYS = 14
OPEN_REQUEST_STATUSES = ("Pending Approval",)


# ---------------------------------------------------------------------------
# pure maths (unit-tested without a database)
# ---------------------------------------------------------------------------
def merge_needs(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
	"""Fold per-source needs into one row per item.

	*rows*: ``{item_code, source, need, ...}``. The merged row keeps the **largest** need (buying
	the biggest of the three demands covers the other two), the union of the sources, and the
	most urgent source as the primary badge.
	"""
	merged: dict[str, dict[str, Any]] = {}
	for row in rows:
		code = row["item_code"]
		acc = merged.get(code)
		if acc is None:
			acc = {k: v for k, v in row.items() if k != "source"}
			acc["sources"] = []
			acc["need"] = 0.0
			merged[code] = acc
		else:
			for key, value in row.items():
				if key in ("item_code", "source", "need"):
					continue
				if acc.get(key) in (None, 0, 0.0, "", []) and value not in (None, "", []):
					acc[key] = value
				elif key in ("store_demand", "requests") and value:
					if key == "requests":
						acc[key] = sorted(set((acc.get(key) or []) + list(value)))
					else:
						acc[key] = flt(acc.get(key)) + flt(value)
		if row.get("source") and row["source"] not in acc["sources"]:
			acc["sources"].append(row["source"])
		acc["need"] = max(flt(acc["need"]), flt(row.get("need")))
	for acc in merged.values():
		acc["sources"].sort(key=lambda s: SOURCE_ORDER.index(s) if s in SOURCE_ORDER else 99)
		acc["source"] = acc["sources"][0] if acc["sources"] else SOURCE_LOW_STOCK
	return merged


def suggest_qty(need: float, on_order: float = 0, case_pack: int = 1, moq: int = 0) -> float:
	"""Need minus what is already on order, rounded up to a case, lifted to the MOQ."""
	outstanding = max(0.0, flt(need) - flt(on_order))
	if outstanding <= 0:
		return 0.0
	return round_up_to_case_pack(outstanding, case_pack, moq)


# ---------------------------------------------------------------------------
# database loaders
# ---------------------------------------------------------------------------
def cover_days_horizon() -> int:
	try:
		value = cint(frappe.db.get_single_value("AWANZ POS Settings", "purchase_cover_days"))
	except Exception:  # pragma: no cover — field missing on an old site
		value = 0
	return value or DEFAULT_COVER_DAYS


def _bins(warehouse: str) -> dict[str, float]:
	return {
		r.item_code: flt(r.actual_qty)
		for r in frappe.get_all("Bin", filters={"warehouse": warehouse}, fields=["item_code", "actual_qty"], limit=100000)
	}


def on_order_qty(warehouse: str) -> dict[str, float]:
	"""Units on submitted, not yet received Purchase Orders addressed to *warehouse*."""
	rows = frappe.db.sql(
		"""
		select poi.item_code as item_code, sum(poi.qty - poi.received_qty) as qty
		from `tabPurchase Order Item` poi
		join `tabPurchase Order` po on po.name = poi.parent
		where po.docstatus = 1 and po.status not in ('Closed', 'Completed', 'Cancelled')
		  and poi.warehouse = %s and poi.qty > poi.received_qty
		group by poi.item_code
		""",
		(warehouse,),
		as_dict=True,
	)
	return {r.item_code: flt(r.qty) for r in rows}


def low_stock_needs(warehouse: str, bins: dict[str, float]) -> list[dict[str, Any]]:
	rows = frappe.get_all(
		"Item Reorder",
		filters={"warehouse": warehouse},
		fields=["parent", "warehouse_reorder_level", "warehouse_reorder_qty"],
		limit=100000,
	)
	out = []
	for r in rows:
		level = flt(r.warehouse_reorder_level)
		if level <= 0:
			continue
		on_hand = flt(bins.get(r.parent))
		if on_hand > level:
			continue
		need = max(flt(r.warehouse_reorder_qty), level - on_hand)
		if need <= 0:
			continue
		out.append(
			{
				"item_code": r.parent,
				"source": SOURCE_LOW_STOCK,
				"need": need,
				"on_hand": on_hand,
				"reorder_level": level,
			}
		)
	return out


def store_demand_needs(warehouse: str, bins: dict[str, float]) -> list[dict[str, Any]]:
	"""Open store requests the warehouse cannot fill from stock — the shortfall only."""
	requests = frappe.get_all(
		"AWANZ Replenishment Request",
		filters={"status": ("in", OPEN_REQUEST_STATUSES)},
		fields=["name", "boutique"],
		limit=5000,
	)
	if not requests:
		return []
	names = [r.name for r in requests]
	lines = frappe.get_all(
		"AWANZ Replenishment Line",
		filters={"parent": ("in", names), "parenttype": "AWANZ Replenishment Request"},
		fields=["parent", "item_code", "qty", "approved_qty"],
		limit=100000,
	)
	demand: dict[str, float] = {}
	sources: dict[str, set] = {}
	for line in lines:
		qty = flt(line.approved_qty) or flt(line.qty)
		if qty <= 0:
			continue
		demand[line.item_code] = flt(demand.get(line.item_code)) + qty
		sources.setdefault(line.item_code, set()).add(line.parent)
	out = []
	for code, qty in demand.items():
		shortfall = qty - flt(bins.get(code))
		if shortfall <= 0:
			continue
		out.append(
			{
				"item_code": code,
				"source": SOURCE_STORE_DEMAND,
				"need": shortfall,
				"on_hand": flt(bins.get(code)),
				"store_demand": qty,
				"requests": sorted(sources.get(code, ())),
			}
		)
	return out


def trending_needs(warehouse: str, bins: dict[str, float], horizon: Optional[int] = None) -> list[dict[str, Any]]:
	"""Chain-wide *Trending up* items whose HOU-WH cover is under the horizon."""
	horizon = cint(horizon) or cover_days_horizon()
	try:
		rows = frappe.get_all(
			"AWANZ Product Trend",
			filters={"badge": "Trending up", "boutique": "ALL", "period": "28d"},
			fields=["item_code", "velocity", "units"],
			limit=2000,
		)
	except Exception:  # pragma: no cover — doctype missing
		return []
	out = []
	for r in rows:
		velocity = flt(r.velocity)
		if velocity <= 0:
			continue
		on_hand = flt(bins.get(r.item_code))
		cover = on_hand / velocity if velocity else 0.0
		if cover >= horizon:
			continue
		need = velocity * horizon - on_hand
		if need <= 0:
			continue
		out.append(
			{
				"item_code": r.item_code,
				"source": SOURCE_TRENDING,
				"need": need,
				"on_hand": on_hand,
				"velocity": round(velocity, 3),
				"cover_days": round(cover, 1),
			}
		)
	return out


def dismissed_items(days: int = DISMISS_DAYS) -> set[str]:
	since = add_days(nowdate(), -abs(cint(days)))
	return set(
		frappe.get_all(
			"AWANZ Purchase Suggestion",
			filters={"status": "Dismissed", "modified": (">=", since)},
			pluck="item_code",
			limit=5000,
		)
	)


# ---------------------------------------------------------------------------
# the suggestion list
# ---------------------------------------------------------------------------
def build(warehouse: Optional[str] = None, horizon: Optional[int] = None, skip_dismissed: bool = True) -> list[dict[str, Any]]:
	"""The deduped, vendor-priced suggestion list (no database writes)."""
	warehouse = warehouse or main_warehouse()
	bins = _bins(warehouse)
	merged = merge_needs(
		low_stock_needs(warehouse, bins) + store_demand_needs(warehouse, bins) + trending_needs(warehouse, bins, horizon)
	)
	if skip_dismissed:
		for code in dismissed_items():
			merged.pop(code, None)
	if not merged:
		return []
	on_order = on_order_qty(warehouse)
	meta = {
		r.name: r
		for r in frappe.get_all(
			"Item",
			filters={"name": ("in", list(merged))},
			fields=["name", "item_name", "item_group", "image", "maison_barcode", "disabled", "is_stock_item"],
		)
	}
	levels = {
		r.parent: flt(r.warehouse_reorder_level)
		for r in frappe.get_all(
			"Item Reorder", filters={"parent": ("in", list(merged)), "warehouse": warehouse}, fields=["parent", "warehouse_reorder_level"]
		)
	}
	out: list[dict[str, Any]] = []
	for code, row in merged.items():
		item = meta.get(code)
		if not item or cint(item.disabled) or not cint(item.is_stock_item):
			continue
		vendors = item_vendor_rows(code)
		preferred = next((v for v in vendors if cint(v.get("is_preferred"))), vendors[0] if vendors else None)
		case_pack = cint(preferred.get("case_pack")) if preferred else 1
		moq = cint(preferred.get("moq")) if preferred else 0
		already = flt(on_order.get(code))
		qty = suggest_qty(row["need"], already, case_pack, moq)
		if qty <= 0:
			continue
		out.append(
			{
				"item_code": code,
				"item": code,  # the contract calls this field "item"
				"item_name": item.item_name,
				"item_group": item.item_group,
				"image": item.image,
				"barcode": item.maison_barcode,
				"source": row["source"],
				"sources": row["sources"],
				"on_hand": flt(row.get("on_hand")),
				"on_order": already,
				"store_demand": flt(row.get("store_demand")),
				"reorder_level": flt(row.get("reorder_level") or levels.get(code)),
				"velocity": flt(row.get("velocity")),
				"cover_days": flt(row.get("cover_days")),
				"need": round(flt(row["need"]), 2),
				"suggested_qty": qty,
				"qty": qty,
				"case_pack": case_pack or 1,
				"moq": moq,
				"supplier": preferred.get("supplier") if preferred else None,
				"supplier_name": frappe.db.get_value("Supplier", preferred["supplier"], "supplier_name") if preferred and preferred.get("supplier") else None,
				"cost": flt(preferred.get("cost")) if preferred else 0.0,
				"lead_time_days": cint(preferred.get("lead_time_days")) if preferred else 0,
				"requests": row.get("requests") or [],
				"vendors": [
					{
						"supplier": v["supplier"],
						"supplier_name": frappe.db.get_value("Supplier", v["supplier"], "supplier_name"),
						"cost": flt(v.get("cost")),
						"case_pack": cint(v.get("case_pack")) or 1,
						"moq": cint(v.get("moq")),
						"lead_time_days": cint(v.get("lead_time_days")),
						"vendor_sku": v.get("vendor_sku"),
						"is_preferred": bool(cint(v.get("is_preferred"))),
						"last_purchase_rate": flt(v.get("last_purchase_rate")),
					}
					for v in vendors
				],
			}
		)
	out.sort(key=lambda r: (SOURCE_ORDER.index(r["source"]) if r["source"] in SOURCE_ORDER else 99, -flt(r["suggested_qty"])))
	return out


def run(warehouse: Optional[str] = None, horizon: Optional[int] = None, commit: bool = False) -> dict[str, Any]:
	"""Recompute and cache a run in ``AWANZ Purchase Suggestion``. Open rows are replaced."""
	rows = build(warehouse=warehouse, horizon=horizon)
	run_id = frappe.generate_hash(length=10)
	frappe.db.delete("AWANZ Purchase Suggestion", {"status": "Open"})
	for row in rows:
		doc = frappe.get_doc(
			{
				"doctype": "AWANZ Purchase Suggestion",
				"item_code": row["item_code"],
				"item_name": row["item_name"],
				"source": row["source"],
				"sources": ", ".join(row["sources"]),
				"suggested_qty": row["suggested_qty"],
				"supplier": row["supplier"],
				"cost": row["cost"],
				"status": "Open",
				"run_id": run_id,
				"on_hand": row["on_hand"],
				"on_order": row["on_order"],
				"store_demand": row["store_demand"],
				"reorder_level": row["reorder_level"],
				"cover_days": row["cover_days"],
				"case_pack": row["case_pack"],
				"moq": row["moq"],
				"lead_time_days": row["lead_time_days"],
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		row["name"] = doc.name
		row["status"] = "Open"
		row["run_id"] = run_id
	if commit:
		frappe.db.commit()
	return {"run_id": run_id, "suggestions": rows, "count": len(rows), "as_of": frappe.utils.now()}


def cached(run_id: Optional[str] = None) -> dict[str, Any]:
	"""The last cached run, re-priced with the live vendor catalogue (no recompute)."""
	filters: dict[str, Any] = {"status": "Open"}
	if run_id:
		filters["run_id"] = run_id
	names = frappe.get_all("AWANZ Purchase Suggestion", filters=filters, pluck="name", order_by="creation asc", limit=2000)
	if not names:
		return {"run_id": None, "suggestions": [], "count": 0}
	rows = []
	for name in names:
		doc = frappe.get_doc("AWANZ Purchase Suggestion", name)
		vendors = item_vendor_rows(doc.item_code)
		rows.append(
			{
				"name": doc.name,
				"item_code": doc.item_code,
				"item": doc.item_code,
				"item_name": doc.item_name,
				"item_group": frappe.db.get_value("Item", doc.item_code, "item_group"),
				"barcode": frappe.db.get_value("Item", doc.item_code, "maison_barcode"),
				"source": doc.source,
				"sources": [s.strip() for s in (doc.sources or doc.source or "").split(",") if s.strip()],
				"on_hand": flt(doc.on_hand),
				"on_order": flt(doc.on_order),
				"store_demand": flt(doc.store_demand),
				"reorder_level": flt(doc.reorder_level),
				"cover_days": flt(doc.cover_days),
				"suggested_qty": flt(doc.suggested_qty),
				"qty": flt(doc.suggested_qty),
				"case_pack": cint(doc.case_pack) or 1,
				"moq": cint(doc.moq),
				"lead_time_days": cint(doc.lead_time_days),
				"supplier": doc.supplier,
				"supplier_name": frappe.db.get_value("Supplier", doc.supplier, "supplier_name") if doc.supplier else None,
				"cost": flt(doc.cost),
				"status": doc.status,
				"run_id": doc.run_id,
				"vendors": [
					{
						"supplier": v["supplier"],
						"supplier_name": frappe.db.get_value("Supplier", v["supplier"], "supplier_name"),
						"cost": flt(v.get("cost")),
						"case_pack": cint(v.get("case_pack")) or 1,
						"moq": cint(v.get("moq")),
						"lead_time_days": cint(v.get("lead_time_days")),
						"vendor_sku": v.get("vendor_sku"),
						"is_preferred": bool(cint(v.get("is_preferred"))),
						"last_purchase_rate": flt(v.get("last_purchase_rate")),
					}
					for v in vendors
				],
			}
		)
	return {"run_id": rows[0]["run_id"] if rows else None, "suggestions": rows, "count": len(rows)}


def daily_run() -> dict[str, Any]:
	"""Scheduler: refresh the buying list every morning (06:00 site time, see ``hooks.py``)."""
	try:
		return run(commit=True)
	except Exception:  # pragma: no cover
		frappe.log_error(frappe.get_traceback(), "awanz purchase suggestions")
		return {"error": True}
