"""The month-end store statement (SPEC_v1.2 §C).

One row per store per period: how many consignments went out, how many units, how many of those
units the store **actually received**, what they were worth to the store, what they cost Houston,
and the margin between the two. Plus chain totals, and a row of zeros for a store that received
nothing — an absent row reads as an oversight, and somebody will ring up about it.

**What this is not.** It is not an invoice. It creates no receivable, it does not age, no payment
is tracked against it and nothing lands in a partner's books. The eleven stores are separately
owned LLCs and the correct long-term answer is twelve ERPNext companies with real intercompany
invoices; that is a re-platform. This is the stepping stone the client asked for instead: a figure
they can bill from by hand. Every payload this module produces carries :data:`INTERNAL_NOTICE`
saying so, because it also shows Houston's own buying cost and somebody will eventually e-mail it
to a partner (client decision 3).

The figures come from what was **stamped on the consignment when it shipped** — never from
today's moving average. A consignment that shipped before v1.2 carries no stamp and is reported
as *not priced*: its units are counted, its value is not guessed.

Netting (client decision 4 — bill for what a store actually received): shipped units less any
``AWANZ Receiving Discrepancy`` of type *Short* or *Damaged* raised against the consignment, open
or resolved alike. *Over* is not netted in the other direction — a store that was sent too much is
a warehouse problem, not a billing one.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import flt, getdate, now_datetime, nowdate

from maison_pos.reports import col, money_col

#: stamped on every payload and printed at the top of the report
INTERNAL_NOTICE = (
	"Internal AWANZ document — it shows the AWANZ warehouse's own cost and margin. "
	"It is not an invoice: no receivable is created, nothing ages, no payment is tracked "
	"and no partner's books are touched. Do not send it to a store."
)

#: the discrepancy types that come off a store's bill, and the field each one is counted in
NETTED_TYPES = {"Short": "short_qty", "Damaged": "damaged_qty"}

#: a consignment counts for the period once it has left the warehouse
STATEMENT_STATUSES = ("Shipped", "Received")

ZERO = {
	"shipments": 0,
	"units": 0.0,
	"short_units": 0.0,
	"damaged_units": 0.0,
	"billable_units": 0.0,
	"wholesale_value": 0.0,
	"cost_value": 0.0,
	"margin": 0.0,
	"margin_pct": 0.0,
	"unpriced_shipments": 0,
	"unpriced_units": 0.0,
}


# ---------------------------------------------------------------------------
# the figures
# ---------------------------------------------------------------------------
def _bounds(from_date: Any, to_date: Any) -> tuple[Any, Any]:
	today = getdate(nowdate())
	start = getdate(from_date) if from_date else today.replace(day=1)
	end = getdate(to_date) if to_date else today
	if start > end:
		frappe.throw(_("From Date must be on or before To Date"), frappe.ValidationError)
	return start, end


def _stores(boutique: Optional[str] = None) -> list[dict[str, str]]:
	"""Every enabled shop, warehouse row excluded — including the ones with nothing shipped."""
	from maison_pos.shipping import store_boutiques

	codes = store_boutiques()
	if boutique:
		if boutique not in codes:
			frappe.throw(_("{0} is not an enabled store").format(boutique), frappe.ValidationError)
		codes = [boutique]
	rows = frappe.get_all("AWANZ Store", filters={"name": ("in", codes or ["__none__"])}, fields=["name", "boutique_name"], order_by="name")
	return [{"boutique": r.name, "boutique_name": r.boutique_name or r.name} for r in rows]


def _shipments(start: Any, end: Any, codes: list[str]) -> list[Any]:
	if not codes:
		return []
	# `shipped_at` is the moment the consignment was valued, so it is the moment that decides
	# which period it belongs to — a list of conditions rather than a dict because the same
	# fieldname is bounded twice.
	return frappe.get_all(
		"AWANZ Shipment",
		filters=[
			["boutique", "in", codes],
			["status", "in", STATEMENT_STATUSES],
			["shipped_at", ">=", f"{start} 00:00:00"],
			["shipped_at", "<=", f"{end} 23:59:59"],
		],
		fields=["name", "boutique", "status", "shipped_at", "value_stamped_at", "cost_total", "wholesale_total"],
		order_by="shipped_at asc",
		limit=20000,
	)


def _netting(shipment_names: list[str]) -> dict[tuple[str, str], dict[str, float]]:
	"""``{(shipment, item): {short, damaged}}`` — what the store did not actually receive.

	A partial receipt can raise more than one discrepancy for the same line, and each one carries
	the *running* total off the shipment line rather than that receipt's slice, so the answer is
	the largest figure seen and never their sum.
	"""
	out: dict[tuple[str, str], dict[str, float]] = {}
	if not shipment_names:
		return out
	rows = frappe.get_all(
		"AWANZ Receiving Discrepancy",
		filters=[["shipment", "in", shipment_names], ["type", "in", list(NETTED_TYPES)]],
		fields=["shipment", "item_code", "type", "short_qty", "damaged_qty", "status"],
		limit=50000,
	)
	for r in rows:
		key = (r.shipment, r.item_code)
		bucket = out.setdefault(key, {"short": 0.0, "damaged": 0.0})
		slot = "short" if r.type == "Short" else "damaged"
		bucket[slot] = max(bucket[slot], flt(r.get(NETTED_TYPES[r.type])))
	return out


def _blank(**extra: Any) -> dict[str, Any]:
	row = dict(ZERO)
	row.update(extra)
	return row


def _finish(row: dict[str, Any]) -> dict[str, Any]:
	"""Round the money and derive the margin — the one place margin % is defined."""
	for key in ("units", "short_units", "damaged_units", "billable_units", "unpriced_units"):
		row[key] = flt(row[key], 2)
	row["wholesale_value"] = flt(row["wholesale_value"], 2)
	row["cost_value"] = flt(row["cost_value"], 2)
	row["margin"] = flt(row["wholesale_value"] - row["cost_value"], 2)
	# margin as a share of what the store is charged — the figure a buyer reads
	row["margin_pct"] = flt(100.0 * row["margin"] / row["wholesale_value"], 1) if row["wholesale_value"] else 0.0
	return row


def build(from_date: Any = None, to_date: Any = None, boutique: Optional[str] = None) -> dict[str, Any]:
	"""The statement, once, for both the screen and the Script Report.

	Returns ``{from_date, to_date, internal, notice, markup_pct, currency, stores: [...],
	totals: {...}, generated_at}`` where every store row carries a ``lines`` breakdown per item.
	The screen renders the store rows only (client decision 5 — store level, not line by line);
	the CSV export is where the line detail belongs.
	"""
	from maison_pos.pricing.wholesale import markup_pct

	start, end = _bounds(from_date, to_date)
	stores = _stores(boutique)
	codes = [s["boutique"] for s in stores]
	shipments = _shipments(start, end, codes)
	names = [s.name for s in shipments]
	netting = _netting(names)
	by_name = {s.name: s for s in shipments}

	lines = (
		frappe.get_all(
			"AWANZ Shipment Line",
			filters=[["parent", "in", names]],
			fields=["parent", "item_code", "item_name", "qty", "shipped_qty", "cost_rate", "wholesale_rate"],
			limit=200000,
		)
		if names
		else []
	)

	stores_by_code: dict[str, dict[str, Any]] = {
		s["boutique"]: _blank(boutique=s["boutique"], boutique_name=s["boutique_name"], lines=[]) for s in stores
	}
	items: dict[tuple[str, str], dict[str, Any]] = {}

	for line in lines:
		head = by_name.get(line.parent)
		if not head or head.boutique not in stores_by_code:
			continue
		store = stores_by_code[head.boutique]
		priced = bool(head.value_stamped_at)
		shipped = flt(line.shipped_qty) or flt(line.qty)
		net = netting.get((line.parent, line.item_code), {})
		short = min(flt(net.get("short")), shipped)
		damaged = min(flt(net.get("damaged")), max(0.0, shipped - short))
		billable = max(0.0, shipped - short - damaged)
		wholesale = flt(line.wholesale_rate) * billable if priced else 0.0
		cost = flt(line.cost_rate) * billable if priced else 0.0

		key = (head.boutique, line.item_code)
		row = items.get(key)
		if row is None:
			row = items[key] = _blank(
				boutique=head.boutique,
				boutique_name=store["boutique_name"],
				item_code=line.item_code,
				item_name=line.item_name or line.item_code,
				_shipments=set(),
			)
		row["_shipments"].add(line.parent)
		for target in (row, store):
			target["units"] += shipped
			target["short_units"] += short
			target["damaged_units"] += damaged
			target["billable_units"] += billable
			target["wholesale_value"] += wholesale
			target["cost_value"] += cost
			if not priced:
				target["unpriced_units"] += shipped

	for head in shipments:
		store = stores_by_code.get(head.boutique)
		if store is None:
			continue
		store["shipments"] += 1
		if not head.value_stamped_at:
			store["unpriced_shipments"] += 1

	for (code, _item), row in items.items():
		row["shipments"] = len(row.pop("_shipments"))
		# "how many consignments were not priced" is a store-level fact; on a line it would always
		# read 0 and invite the wrong reading. `unpriced_units` is the line's version of it.
		row.pop("unpriced_shipments", None)
		_finish(row)
		row["wholesale_rate"] = flt(row["wholesale_value"] / row["billable_units"], 2) if row["billable_units"] else 0.0
		row["cost_rate"] = flt(row["cost_value"] / row["billable_units"], 2) if row["billable_units"] else 0.0
		stores_by_code[code]["lines"].append(row)

	out_stores = []
	totals = _blank(boutique=None, boutique_name=_("Chain total"))
	for code in codes:
		store = _finish(stores_by_code[code])
		store["lines"].sort(key=lambda r: (-r["wholesale_value"], r["item_code"]))
		out_stores.append(store)
		for key in ("shipments", "units", "short_units", "damaged_units", "billable_units", "unpriced_shipments", "unpriced_units"):
			totals[key] += store[key]
		totals["wholesale_value"] += store["wholesale_value"]
		totals["cost_value"] += store["cost_value"]
	_finish(totals)

	return {
		"from_date": str(start),
		"to_date": str(end),
		# --- client decision 3: this must never be mistaken for a bill ---
		"internal": True,
		"shows_cost": True,
		"is_invoice": False,
		"creates_receivable": False,
		"notice": INTERNAL_NOTICE,
		# --- end client decision 3 ---
		"markup_pct": markup_pct(),
		"currency": _currency(),
		"stores": out_stores,
		"totals": totals,
		"shipments": len(shipments),
		"generated_at": now_datetime().isoformat(),
	}


def _currency() -> str:
	from maison_pos.purchasing import default_company

	company = default_company()
	return (frappe.get_cached_value("Company", company, "default_currency") if company else None) or "USD"


# ---------------------------------------------------------------------------
# the Script Report
# ---------------------------------------------------------------------------
def columns(detail: bool = False) -> list[dict[str, Any]]:
	out = [col("Store", "boutique", "Link", 110, "AWANZ Store"), col("Store Name", "boutique_name", "Data", 170)]
	if detail:
		out += [col("Item", "item_code", "Link", 140, "Item"), col("Item Name", "item_name", "Data", 200)]
	out += [
		col("Consignments", "shipments", "Int", 110),
		col("Units Shipped", "units", "Float", 110),
		col("Short", "short_units", "Float", 80),
		col("Damaged", "damaged_units", "Float", 90),
		col("Units Billable", "billable_units", "Float", 110),
	]
	if detail:
		out += [money_col("Wholesale / Unit", "wholesale_rate", 130), money_col("Cost / Unit", "cost_rate", 110)]
	out += [
		money_col("Wholesale Value", "wholesale_value", 140),
		money_col("Cost Value (internal)", "cost_value", 150),
		money_col("Margin", "margin", 120),
		col("Margin %", "margin_pct", "Percent", 90),
		col("Not Priced", "unpriced_shipments", "Int", 95) if not detail else col("Not Priced (units)", "unpriced_units", "Float", 120),
	]
	return out


def rows(payload: dict[str, Any], detail: bool = False) -> list[dict[str, Any]]:
	"""Flatten the payload into report rows, chain total last."""
	out: list[dict[str, Any]] = []
	for store in payload["stores"]:
		if detail:
			out.extend({k: v for k, v in line.items() if k != "lines"} for line in store["lines"])
			if not store["lines"]:
				out.append({k: v for k, v in store.items() if k != "lines"})
		else:
			out.append({k: v for k, v in store.items() if k != "lines"})
	total = dict(payload["totals"])
	total["boutique"] = None
	out.append(total)
	return out


def execute(filters: Any = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
	f = dict(filters or {})
	detail = bool(int(f.get("detail") or 0))
	payload = build(f.get("from_date"), f.get("to_date"), f.get("boutique"))
	message = (
		f"<b>{frappe.utils.escape_html(_('Internal AWANZ report — warehouse cost and margin. Not an invoice.'))}</b><br>"
		f"{frappe.utils.escape_html(INTERNAL_NOTICE)}"
	)
	return columns(detail), rows(payload, detail), message
