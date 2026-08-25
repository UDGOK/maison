"""Distribution (SPEC_v1.1 §A) — Houston **pushes** stock out to the stores.

Every shipment before v1.1 began with a store raising an ``AWANZ Replenishment Request``. For a
brand-new product that is backwards: no store knows it exists, so none of them will ask. This
module gives the Houston warehouse the other direction — choose an item, choose quantities per
store, send — while reusing the **existing** machinery end to end:

    distribution.send()
        └─ maison_pos.api.shipping.create_request()   (request + draft Material Request)
        └─ maison_pos.api.shipping.approve()          (workflow, MR submit, AWANZ Shipment)

There is deliberately no second shipment-creation path. The wall, the pick list, the packing
step, the label purchase and the store's Receive screen see an ordinary shipment and behave
exactly as they do for a store-raised request. What tells the two apart for ever is
``AWANZ Replenishment Request.warehouse_push`` — set by this module and by nothing else.

Client decisions this module implements (SPEC_v1.1, locked):

* **2** — a push is created *and* approved in one action: the warehouse admin is both requester
  and approver, so a Pending step would be theatre. The record still says plainly that Houston
  initiated it (``warehouse_push`` + the stamped reason).
* **3** — one shipment per store. Separate parcels, separate labels; never batched.
* **4** — never allocate stock Houston does not have. :func:`send` validates **everything before
  writing anything** and refuses with the shortfall named per item. A half-sent distribution
  leaves phantom shipments the floor will pick and ship, which is worse than a refused one.

The split maths (:func:`split_even`, :func:`split_by_velocity`, :func:`split_topup`) are pure
functions over plain rows so they are unit-tested without a database and the sheet never has to
re-implement them.
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, now_datetime, nowdate

from maison_pos.scoping import is_purchasing_admin
from maison_pos.shipping import get_main_warehouse, store_boutiques

#: allocation helpers the distribution sheet may ask for
SPLIT_MODES = ("even", "velocity", "topup")
#: the window "28-day velocity" is measured over
VELOCITY_DAYS = 28
#: default target for the *topup* mode, in days of cover
DEFAULT_TARGET_COVER_DAYS = 21
#: shipments that have been raised but whose stock has **not** left HOU-WH yet — those units are
#: spoken for even though the Bin still counts them
COMMITTED_SHIPMENT_STATUSES = ("Pending", "Picking", "Packed")
#: ``AWANZ Replenishment Request.priority`` options
PRIORITIES = ("Normal", "Low stock", "Urgent")
#: stamped on a push that arrives without a reason of its own, so the desk reads plainly
DEFAULT_PUSH_REASON = "Warehouse push from Houston"


# ---------------------------------------------------------------------------
# permissions — SPEC_v1.1 §A: warehouse admin / head office only
# ---------------------------------------------------------------------------
def assert_distribution_admin(user: Optional[str] = None) -> None:
	"""Raise unless the user may push stock out of Houston.

	Same set as buying (``AWANZ Warehouse Admin`` / ``AWANZ Head Office`` / System Manager): a
	store manager calling :func:`send` for their **own** store is still refused, because pushing
	is Houston's act (client decision 1 — nothing here lets a store pull for itself or push to
	another store).
	"""
	user = user or frappe.session.user
	if user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)
	if not is_purchasing_admin(user):
		frappe.throw(_("Distribution is Houston's: warehouse admin or head office only"), frappe.PermissionError)


# ---------------------------------------------------------------------------
# pure allocation maths (no database — unit-tested on plain rows)
# ---------------------------------------------------------------------------
def _busiest_first(rows: Iterable[dict[str, Any]]) -> list[str]:
	"""Store codes, busiest first: highest velocity, then emptiest, then alphabetical.

	"Busiest" decides where an odd remainder lands, so it has to be a total order — two stores
	that sell the same amount must not swap places between two calls with the same input.
	"""
	return [
		r["boutique"]
		for r in sorted(rows, key=lambda r: (-flt(r.get("velocity")), flt(r.get("on_hand")), str(r.get("boutique"))))
	]


def _apportion(total: int, weights: dict[str, float], order: list[str], caps: Optional[dict[str, int]] = None) -> dict[str, int]:
	"""Share *total* whole units out in proportion to *weights* (largest-remainder method).

	*order* breaks ties (busiest first); *caps* is an optional per-store ceiling — a store that
	is already at its cap is skipped when the remainder is handed out.
	"""
	out = {key: 0 for key in weights}
	total = int(max(0, cint(total)))
	if total <= 0:
		return out
	positive = {key: max(0.0, flt(value)) for key, value in weights.items()}
	pool = sum(positive.values())
	if pool <= 0:
		return out
	position = {key: index for index, key in enumerate(order)}
	exact = {key: total * value / pool for key, value in positive.items()}
	for key, value in exact.items():
		whole = int(math.floor(value))
		out[key] = min(whole, caps[key]) if caps is not None else whole
	remaining = total - sum(out.values())
	ranked = sorted(positive, key=lambda k: (-(exact[k] - math.floor(exact[k])), position.get(k, len(position))))
	while remaining > 0:
		handed_out = False
		for key in ranked:
			if remaining <= 0:
				break
			if caps is not None and out[key] >= caps[key]:
				continue
			out[key] += 1
			remaining -= 1
			handed_out = True
		if not handed_out:  # everybody is at their cap — the rest stays in Houston
			break
	return out


def split_even(qty: Any, rows: list[dict[str, Any]]) -> dict[str, int]:
	"""Equal across the chosen stores; the remainder goes to the busiest."""
	qty = int(max(0, cint(qty)))
	out = {r["boutique"]: 0 for r in rows}
	if not rows or qty <= 0:
		return out
	base, remainder = divmod(qty, len(rows))
	for code in out:
		out[code] = base
	for code in _busiest_first(rows)[:remainder]:
		out[code] += 1
	return out


def split_by_velocity(qty: Any, rows: list[dict[str, Any]]) -> dict[str, int]:
	"""Weighted by 28-day velocity, **minimum one each**.

	Two honest edge cases the sheet would otherwise have to guess at:

	* fewer units than stores — one each is impossible, so the busiest stores get the units that
	  exist rather than everybody getting a fraction;
	* nobody has ever sold it (a brand-new product, every velocity 0) — there is no signal to
	  weight by, so it falls back to an even split rather than piling the lot on one store.
	"""
	qty = int(max(0, cint(qty)))
	out = {r["boutique"]: 0 for r in rows}
	if not rows or qty <= 0:
		return out
	order = _busiest_first(rows)
	if qty <= len(rows):
		for code in order[:qty]:
			out[code] = 1
		return out
	weights = {r["boutique"]: max(0.0, flt(r.get("velocity"))) for r in rows}
	if sum(weights.values()) <= 0:
		return split_even(qty, rows)
	for code in out:
		out[code] = 1  # the minimum, first
	for code, extra in _apportion(qty - len(rows), weights, order).items():
		out[code] += extra
	return out


def split_topup(qty: Any, rows: list[dict[str, Any]], cover_days: Any = DEFAULT_TARGET_COVER_DAYS) -> dict[str, int]:
	"""Bring every store up to *cover_days* days of cover at its own velocity.

	A store's gap is ``velocity × cover_days − on hand``, rounded up. When the gaps add up to
	less than *qty* every store gets exactly its gap and the rest stays in Houston (the caller
	reports it as ``remainder``); when they add up to more, what there is is shared in proportion
	to the gaps and no store is given more than it needs.
	"""
	qty = int(max(0, cint(qty)))
	out = {r["boutique"]: 0 for r in rows}
	if not rows or qty <= 0:
		return out
	target_days = max(1, cint(cover_days) or DEFAULT_TARGET_COVER_DAYS)
	gap: dict[str, int] = {}
	for row in rows:
		short = flt(row.get("velocity")) * target_days - flt(row.get("on_hand"))
		gap[row["boutique"]] = int(math.ceil(short)) if short > 0 else 0
	total_gap = sum(gap.values())
	if total_gap <= 0:
		return out  # every store is already covered — allocate nothing rather than guess
	if total_gap <= qty:
		return dict(gap)
	return _apportion(qty, {k: float(v) for k, v in gap.items()}, _busiest_first(rows), caps=gap)


SPLITTERS = {"even": split_even, "velocity": split_by_velocity, "topup": split_topup}


# ---------------------------------------------------------------------------
# database loaders
# ---------------------------------------------------------------------------
def _as_list(value: Any) -> list[str]:
	if value in (None, ""):
		return []
	if isinstance(value, str):
		value = value.strip()
		if value.startswith("["):
			import json

			try:
				value = json.loads(value)
			except ValueError:
				value = [value]
		else:
			value = [part.strip() for part in value.split(",")]
	out: list[str] = []
	for item in value or []:
		code = (item or "").strip() if isinstance(item, str) else str(item or "").strip()
		if code and code not in out:
			out.append(code)
	return out


def main_warehouse() -> str:
	"""HOU-WH — the warehouse a push leaves from."""
	from maison_pos.purchasing import main_warehouse as _main

	return _main()


def source_warehouse_for(boutique: str) -> str:
	"""The warehouse ``shipping.create_request`` will pick as the source for *boutique*.

	Resolved exactly as the request itself resolves it (the store's own company, never the store's
	own warehouse) so the availability we validate against is the stock the shipment will draw on.
	"""
	row = frappe.db.get_value("AWANZ Store", boutique, ["warehouse", "company"], as_dict=True) or {}
	return get_main_warehouse(exclude=row.get("warehouse"), company=row.get("company"))


def store_rows(boutiques: Optional[list[str]] = None) -> list[dict[str, Any]]:
	"""The enabled shops a push may address.

	The head-office warehouse row is never one of them (``store_boutiques`` already drops
	``is_warehouse``) — and neither is a store that happens to *be* the source warehouse on a
	seed with no dedicated warehouse row, because Houston cannot push to itself and a store →
	store transfer is explicitly out of scope for v1.1.
	"""
	source = main_warehouse()
	allowed = [b for b in store_boutiques() if frappe.db.get_value("AWANZ Store", b, "warehouse") != source]
	codes = [b for b in (boutiques or allowed) if b in allowed]
	if not codes:
		return []
	fields = ["name", "boutique_name", "warehouse", "company", "city"]
	if frappe.get_meta("AWANZ Store").has_field("region"):
		fields.append("region")
	rows = frappe.get_all("AWANZ Store", filters={"name": ("in", codes)}, fields=fields, order_by="name")
	return [
		{
			"boutique": r.name,
			"boutique_name": r.boutique_name or r.name,
			"warehouse": r.warehouse,
			"company": r.company,
			"city": r.get("city"),
			"region": r.get("region"),
		}
		for r in rows
	]


def _bin_qty(item_codes: list[str], warehouses: list[str]) -> dict[tuple[str, str], float]:
	if not item_codes or not warehouses:
		return {}
	rows = frappe.get_all(
		"Bin",
		filters={"item_code": ("in", item_codes), "warehouse": ("in", warehouses)},
		fields=["item_code", "warehouse", "actual_qty"],
		limit=100000,
	)
	return {(r.item_code, r.warehouse): flt(r.actual_qty) for r in rows}


def committed_qty(item_codes: list[str], warehouse: str) -> dict[str, float]:
	"""Units already promised to open shipments leaving *warehouse* but not yet shipped.

	A Pending / Picking / Packed shipment has not moved any stock yet — the Bin still counts
	those units — so a second distribution would happily promise them again. Once a shipment is
	*Shipped* its Material Transfer has left the warehouse and the Bin already knows.
	"""
	if not item_codes:
		return {}
	rows = frappe.db.sql(
		"""
		select line.item_code as item_code, sum(line.qty - line.shipped_qty) as qty
		from `tabAWANZ Shipment Line` line
		join `tabAWANZ Shipment` sh on sh.name = line.parent
		where sh.status in %(statuses)s and sh.from_warehouse = %(warehouse)s
		  and line.item_code in %(items)s and line.qty > line.shipped_qty
		group by line.item_code
		""",
		{"statuses": COMMITTED_SHIPMENT_STATUSES, "warehouse": warehouse, "items": item_codes},
		as_dict=True,
	)
	return {r.item_code: max(0.0, flt(r.qty)) for r in rows}


def availability(item_codes: list[str], warehouse: Optional[str] = None) -> dict[str, dict[str, float]]:
	"""``{item: {on_hand, committed, available}}`` at *warehouse* (HOU-WH by default)."""
	warehouse = warehouse or main_warehouse()
	on_hand = _bin_qty(item_codes, [warehouse])
	committed = committed_qty(item_codes, warehouse)
	out: dict[str, dict[str, float]] = {}
	for code in item_codes:
		have = flt(on_hand.get((code, warehouse)))
		spoken_for = flt(committed.get(code))
		out[code] = {"on_hand": have, "committed": spoken_for, "available": have - spoken_for}
	return out


def _sales_units(item_codes: list[str], boutiques: list[str], from_date: Optional[str] = None) -> dict[tuple[str, str], float]:
	"""Net POS units per (item, store); *from_date* bounds the window, ``None`` means all time."""
	if not item_codes or not boutiques:
		return {}
	from frappe.query_builder.functions import Sum

	SI = frappe.qb.DocType("Sales Invoice")
	SII = frappe.qb.DocType("Sales Invoice Item")
	query = (
		frappe.qb.from_(SII)
		.join(SI)
		.on(SII.parent == SI.name)
		.select(SII.item_code, SI.maison_boutique.as_("boutique"), Sum(SII.qty).as_("units"))
		.where((SI.docstatus == 1) & (SI.is_pos == 1) & SII.item_code.isin(item_codes) & SI.maison_boutique.isin(boutiques))
		.groupby(SII.item_code, SI.maison_boutique)
	)
	if from_date:
		query = query.where(SI.posting_date >= from_date)
	return {(r.item_code, r.boutique): flt(r.units) for r in query.run(as_dict=True)}


def velocity(item_codes: list[str], boutiques: list[str], days: int = VELOCITY_DAYS) -> dict[tuple[str, str], float]:
	"""Units **per day** per (item, store) over the last *days* of POS sales (returns net out)."""
	days = max(1, cint(days) or VELOCITY_DAYS)
	units = _sales_units(item_codes, boutiques, add_days(nowdate(), -days + 1))
	return {key: max(0.0, value) / days for key, value in units.items()}


def ever_sold(item_codes: list[str], boutiques: list[str]) -> set[tuple[str, str]]:
	"""(item, store) pairs where the store has ever rung the item up.

	"Has never sold it" is the single most useful thing on the sheet: it is what separates
	*restock what moves* from *introduce something new here*.
	"""
	return {key for key, units in _sales_units(item_codes, boutiques).items() if units > 0}


def _item_meta(item_codes: list[str]) -> dict[str, Any]:
	rows = frappe.get_all(
		"Item",
		filters={"name": ("in", item_codes)},
		fields=["name", "item_name", "item_group", "stock_uom", "maison_barcode", "image", "disabled", "is_stock_item"],
	)
	return {r.name: r for r in rows}


def store_context(item_codes: list[str], stores: list[dict[str, Any]], days: int = VELOCITY_DAYS) -> dict[str, list[dict[str, Any]]]:
	"""Per item, one row per store: on hand, 28-day velocity, days of cover, ever sold."""
	codes = [b["boutique"] for b in stores]
	warehouses = [b["warehouse"] for b in stores if b["warehouse"]]
	on_hand = _bin_qty(item_codes, warehouses)
	speed = velocity(item_codes, codes, days)
	sold = ever_sold(item_codes, codes)
	out: dict[str, list[dict[str, Any]]] = {}
	for code in item_codes:
		rows = []
		for store in stores:
			have = flt(on_hand.get((code, store["warehouse"])))
			per_day = flt(speed.get((code, store["boutique"])))
			rows.append(
				{
					"boutique": store["boutique"],
					"boutique_name": store["boutique_name"],
					"warehouse": store["warehouse"],
					"city": store.get("city"),
					"region": store.get("region"),
					"on_hand": have,
					"velocity": round(per_day, 3),
					"cover_days": round(have / per_day, 1) if per_day > 0 else None,
					"ever_sold": (code, store["boutique"]) in sold,
				}
			)
		out[code] = rows
	return out


# ---------------------------------------------------------------------------
# §A — plan
# ---------------------------------------------------------------------------
def plan(item_codes: Any, boutiques: Any = None, days: Any = VELOCITY_DAYS) -> dict[str, Any]:
	"""What the warehouse admin needs to turn an allocation into a decision rather than a guess.

	Per item: HOU-WH on hand, what is already committed to open shipments, what is therefore
	available — and a row per store carrying that store's on hand, its 28-day velocity, its days
	of cover and whether it has ever sold the item.
	"""
	codes = _as_list(item_codes)
	if not codes:
		frappe.throw(_("Choose at least one item to distribute"), frappe.ValidationError)
	meta = _item_meta(codes)
	missing = [code for code in codes if code not in meta]
	if missing:
		frappe.throw(_("Item {0} does not exist").format(", ".join(missing)), frappe.DoesNotExistError)
	warehouse = main_warehouse()
	stores = store_rows(_as_list(boutiques) or None)
	days = max(1, cint(days) or VELOCITY_DAYS)
	stock = availability(codes, warehouse)
	context = store_context(codes, stores, days)
	items = []
	for code in codes:
		row = meta[code]
		items.append(
			{
				"item_code": code,
				"item_name": row.item_name,
				"item_group": row.item_group,
				"uom": row.stock_uom,
				"barcode": row.maison_barcode,
				"image": row.image,
				"disabled": bool(cint(row.disabled)),
				"is_stock_item": bool(cint(row.is_stock_item)),
				"on_hand": stock[code]["on_hand"],
				"committed": stock[code]["committed"],
				"available": stock[code]["available"],
				"stores": context.get(code, []),
			}
		)
	return {
		"warehouse": warehouse,
		"velocity_days": days,
		"stores": stores,
		"items": items,
		"as_of": now_datetime().isoformat(),
	}


# ---------------------------------------------------------------------------
# §A — suggest_split
# ---------------------------------------------------------------------------
def suggest_split(item_code: str, qty: Any, mode: str = "even", boutiques: Any = None, cover_days: Any = None) -> dict[str, Any]:
	"""Server-side allocation helper so the maths is tested once, not re-implemented in the sheet.

	``even`` equal across the chosen stores, remainder to the busiest; ``velocity`` weighted by
	28-day velocity with a minimum of one each; ``topup`` brings every store up to *cover_days*
	days of cover. The rows come back whether or not they were given anything, so the sheet can
	fill every quantity box from one call.

	It is a calculator, not a gate: ``available`` comes back beside the allocation so the footer
	can turn red *before* the send, and :func:`send` refuses over-allocation for real.
	"""
	code = (item_code or "").strip()
	if not code or not frappe.db.exists("Item", code):
		frappe.throw(_("Item {0} does not exist").format(code or "?"), frappe.DoesNotExistError)
	mode = (mode or "even").strip().lower()
	if mode not in SPLIT_MODES:
		frappe.throw(_("Unknown split mode {0} — choose {1}").format(mode, ", ".join(SPLIT_MODES)), frappe.ValidationError)
	qty = int(max(0, cint(qty)))
	stores = store_rows(_as_list(boutiques) or None)
	rows = store_context([code], stores).get(code, [])
	target_days = max(1, cint(cover_days) or DEFAULT_TARGET_COVER_DAYS)
	if mode == "topup":
		allocation = split_topup(qty, rows, target_days)
	else:
		allocation = SPLITTERS[mode](qty, rows)
	lines = [{**row, "qty": int(allocation.get(row["boutique"], 0))} for row in rows]
	allocated = sum(line["qty"] for line in lines)
	stock = availability([code])[code]
	return {
		"item_code": code,
		"item_name": frappe.db.get_value("Item", code, "item_name") or code,
		"mode": mode,
		"qty": qty,
		"allocated": allocated,
		"remainder": qty - allocated,
		"cover_days": target_days,
		"velocity_days": VELOCITY_DAYS,
		"warehouse": main_warehouse(),
		"on_hand": stock["on_hand"],
		"committed": stock["committed"],
		"available": stock["available"],
		"left_at_warehouse": stock["available"] - allocated,
		"lines": lines,
	}


# ---------------------------------------------------------------------------
# §A — send
# ---------------------------------------------------------------------------
def _normalise_lines(lines: Any) -> list[dict[str, Any]]:
	"""``[{boutique, item_code, qty}]`` → merged rows, one per (store, item).

	Two rows for the same store and item are summed rather than refused: the sheet can legitimately
	send the same item from two places (an even split plus a manual top-up), and
	``AWANZ Replenishment Request.validate`` refuses an item listed twice on one request.
	"""
	if isinstance(lines, str):
		import json

		try:
			lines = json.loads(lines or "[]")
		except ValueError:
			frappe.throw(_("Distribution lines are not valid JSON"), frappe.ValidationError)
	merged: dict[tuple[str, str], dict[str, Any]] = {}
	order: list[tuple[str, str]] = []
	for raw in list(lines or []):
		if not isinstance(raw, dict):
			frappe.throw(_("Each distribution line must be an object with boutique, item_code and qty"), frappe.ValidationError)
		boutique = (raw.get("boutique") or raw.get("store") or "").strip()
		item = (raw.get("item_code") or raw.get("item") or "").strip()
		qty = flt(raw.get("qty"))
		key = (boutique, item)
		if key in merged:
			merged[key]["qty"] += qty
			continue
		merged[key] = {"boutique": boutique, "item_code": item, "qty": qty}
		order.append(key)
	return [merged[key] for key in order]


def _validate(rows: list[dict[str, Any]], priority: str) -> dict[str, Any]:
	"""Everything that can be refused, refused **before a single row is written**.

	Client decision 4: over-allocation is named per item, not silently trimmed. A distribution
	that half-succeeds leaves phantom shipments the floor will pick and ship, so nothing here may
	write — the caller only starts creating documents once this has returned cleanly.
	"""
	if not rows:
		frappe.throw(_("Nothing to send — choose at least one store and quantity"), frappe.ValidationError)
	if priority not in PRIORITIES:
		frappe.throw(_("Unknown priority {0} — choose {1}").format(priority, ", ".join(PRIORITIES)), frappe.ValidationError)

	shops = {row["boutique"] for row in store_rows()}
	problems: list[str] = []
	seen_stores: list[str] = []
	item_codes: list[str] = []
	for row in rows:
		boutique, item, qty = row["boutique"], row["item_code"], flt(row["qty"])
		if not boutique:
			problems.append(_("A line has no store"))
		elif not frappe.db.exists("AWANZ Store", boutique):
			problems.append(_("Store {0} does not exist").format(boutique))
		elif not cint(frappe.db.get_value("AWANZ Store", boutique, "enabled")):
			problems.append(_("Store {0} is disabled").format(boutique))
		elif boutique not in shops:
			problems.append(_("{0} is the warehouse, not a store").format(boutique))
		elif boutique not in seen_stores:
			seen_stores.append(boutique)
		if not item:
			problems.append(_("A line for {0} has no item").format(boutique or "?"))
		elif not frappe.db.exists("Item", item):
			problems.append(_("Item {0} does not exist").format(item))
		else:
			meta = frappe.db.get_value("Item", item, ["is_stock_item", "disabled"], as_dict=True)
			if not cint(meta.is_stock_item):
				problems.append(_("{0} is not a stock item and cannot be shipped").format(item))
			elif cint(meta.disabled):
				problems.append(_("Item {0} is disabled").format(item))
			elif item not in item_codes:
				item_codes.append(item)
		if qty <= 0:
			problems.append(_("Quantity for {0} at {1} must be more than zero").format(item or "?", boutique or "?"))
	if problems:
		frappe.throw(
			_("This distribution was not sent:") + "\n" + "\n".join(f"• {p}" for p in dict.fromkeys(problems)),
			frappe.ValidationError,
			title=_("Nothing was sent"),
		)

	# --- client decision 4: never allocate stock Houston does not have ------------------
	# grouped by the warehouse each store will actually draw on, because a bench that carries a
	# second company draws that company's stores from that company's own warehouse.
	sources = {boutique: source_warehouse_for(boutique) for boutique in seen_stores}
	wanted: dict[tuple[str, str], float] = {}
	for row in rows:
		key = (sources[row["boutique"]], row["item_code"])
		wanted[key] = flt(wanted.get(key)) + flt(row["qty"])
	shortfalls: list[str] = []
	stock: dict[tuple[str, str], dict[str, float]] = {}
	for warehouse in sorted({s for s in sources.values()}):
		codes = [item for (wh, item) in wanted if wh == warehouse]
		for code, figures in availability(codes, warehouse).items():
			stock[(warehouse, code)] = figures
	for (warehouse, code), qty in sorted(wanted.items()):
		figures = stock.get((warehouse, code), {"on_hand": 0.0, "committed": 0.0, "available": 0.0})
		if qty > figures["available"] + 1e-9:
			shortfalls.append(
				_("{0} — {1} requested, {2} available, short {3}").format(
					code, _n(qty), _n(figures["available"]), _n(qty - figures["available"])
				)
			)
	if shortfalls:
		frappe.throw(
			_("Houston does not hold enough stock to send this distribution:")
			+ "\n"
			+ "\n".join(f"• {s}" for s in shortfalls)
			+ "\n"
			+ _("Nothing was sent — lower the quantities or buy more first."),
			frappe.ValidationError,
			title=_("Nothing was sent"),
		)
	return {"stores": seen_stores, "items": item_codes, "sources": sources}


def _n(value: float) -> str:
	"""Whole numbers print whole — a shortfall of 15 reads better than 15.0."""
	value = flt(value)
	return str(int(value)) if abs(value - int(value)) < 1e-9 else f"{value:g}"


def send(lines: Any, reason: Optional[str] = None, priority: str = "Normal") -> dict[str, Any]:
	"""Push stock from Houston to the stores: one request + one shipment per store.

	``lines = [{boutique, item_code, qty}]``. Everything is validated first (:func:`_validate`);
	only then does anything get written, and the whole write is wrapped in a savepoint so an
	unexpected failure on the fourth store cannot leave the first three on the wall.
	"""
	from maison_pos.api.shipping import approve, create_request

	rows = _normalise_lines(lines)
	priority = (priority or "Normal").strip() or "Normal"
	checked = _validate(rows, priority)

	by_store: dict[str, list[dict[str, Any]]] = {}
	for row in rows:
		by_store.setdefault(row["boutique"], []).append({"item_code": row["item_code"], "qty": flt(row["qty"])})

	stamped = (reason or "").strip() or _(DEFAULT_PUSH_REASON)
	requests: list[dict[str, Any]] = []
	shipments: list[dict[str, Any]] = []
	save_point = f"awanz_push_{frappe.generate_hash(length=8)}"
	frappe.db.savepoint(save_point)
	try:
		# client decision 3 — one shipment per store, in store-code order so the confirmation and
		# the labels come out in the same order every time
		for boutique in sorted(checked["stores"]):
			request = create_request(boutique, by_store[boutique], reason=stamped, priority=priority, warehouse_push=True)
			# client decision 2 — the warehouse admin is requester and approver both; a Pending
			# step would be theatre, so the push is approved in the same action.
			out = approve(request.name)
			requests.append(out["request"])
			shipments.append(out["shipment"])
	except Exception:
		# a half-sent distribution is worse than a refused one — unwind everything
		frappe.db.rollback(save_point=save_point)
		raise

	return {
		"shipments": shipments,
		"requests": requests,
		"stores": len(shipments),
		"units": sum(flt(line["qty"]) for line in rows),
		"items": len(checked["items"]),
		"warehouse": main_warehouse(),
		"priority": priority,
		"reason": stamped,
	}
