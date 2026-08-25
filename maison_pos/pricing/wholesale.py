"""What a store pays Houston for a unit of stock (SPEC_v1.2 §A and §B).

The rule, in one sentence: **a chain-wide markup on what Houston actually paid, unless somebody
has typed a price on the item, in which case that wins.**

* the rule — ``AWANZ POS Settings.wholesale_markup_pct`` (Percent, 50 by default);
* the override — ``Item.maison_wholesale_rate`` (Currency). Blank means "use the rule";
* the cost it marks up — the item's **moving-average valuation at the main warehouse**
  (``Bin.valuation_rate`` at ``HOU-WH``), because that is what Houston actually paid for the
  units it is sending. Deliberately *not* a price list: a buying price list says what a vendor
  charges today, not what the stock on the shelf cost, and freight is capitalised into the
  moving average but not into any price list.

One wholesale price for every store (client decision 1) — Sapulpa and Montrose pay the same.
Per-partner terms are a multi-company concern and are out of scope for v1.2.

§B — **stamping.** :func:`stamp_shipment` writes ``cost_rate`` and ``wholesale_rate`` onto every
shipment line, and the two totals onto the shipment, at the moment it ships and never again. A
shipment sent in March must still say what it was worth in March after April's buying has moved
the moving average: a statement whose numbers change after the client has billed from it is worse
than no statement at all.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import flt, now_datetime

#: chain-wide rule when the setting has never been filled in
DEFAULT_MARKUP_PCT = 50.0
#: the rule, on the AWANZ POS Settings single
MARKUP_FIELD = "wholesale_markup_pct"
#: the per-item override, on Item (an ERPNext doctype, hence the `maison_` prefix)
OVERRIDE_FIELD = "maison_wholesale_rate"
#: currency precision every wholesale figure is rounded to
PRECISION = 2


# ---------------------------------------------------------------------------
# the rule
# ---------------------------------------------------------------------------
def markup_pct() -> float:
	"""``AWANZ POS Settings.wholesale_markup_pct``, or 50 when the single was never filled in.

	Zero is a legitimate answer (ship at cost), so "never set" has to mean *absent*, not falsy.
	"""
	try:
		value = frappe.db.get_single_value("AWANZ POS Settings", MARKUP_FIELD)
	except Exception:  # pragma: no cover — the field is missing on a site that has not migrated
		return DEFAULT_MARKUP_PCT
	return DEFAULT_MARKUP_PCT if value is None else flt(value)


def set_markup_pct(pct: Any) -> float:
	"""Set the chain-wide markup. Refuses a negative percentage — that is a discount, not a markup."""
	value = flt(pct)
	if value < 0:
		frappe.throw(_("The wholesale markup cannot be negative"), frappe.ValidationError)
	if value > 1000:
		frappe.throw(_("A wholesale markup above 1000% is almost certainly a typing slip"), frappe.ValidationError)
	frappe.db.set_single_value("AWANZ POS Settings", MARKUP_FIELD, value)
	frappe.clear_document_cache("AWANZ POS Settings", "AWANZ POS Settings")
	return value


# ---------------------------------------------------------------------------
# what Houston paid
# ---------------------------------------------------------------------------
def cost_for(item_codes: list[str], warehouse: Optional[str] = None) -> dict[str, float]:
	"""``{item_code: moving-average cost}`` at the main warehouse, in one query.

	Order of preference: the ``Bin`` valuation at HOU-WH (the moving average of the units actually
	standing there), then the item's own ``valuation_rate``, then its ``last_purchase_rate``. The
	fallbacks only ever answer for an item the warehouse has never held — an item it *does* hold
	always has a bin.
	"""
	codes = [c for c in dict.fromkeys(item_codes or []) if c]
	if not codes:
		return {}
	from maison_pos.purchasing import main_warehouse

	warehouse = warehouse or main_warehouse()
	out: dict[str, float] = {}
	if warehouse:
		for row in frappe.get_all(
			"Bin",
			filters={"warehouse": warehouse, "item_code": ("in", codes)},
			fields=["item_code", "valuation_rate"],
			limit=len(codes) + 10,
		):
			if flt(row.valuation_rate) > 0:
				out[row.item_code] = flt(row.valuation_rate)
	missing = [c for c in codes if c not in out]
	if missing:
		for row in frappe.get_all(
			"Item",
			filters={"name": ("in", missing)},
			fields=["name", "valuation_rate", "last_purchase_rate"],
			limit=len(missing) + 10,
		):
			out[row.name] = flt(row.valuation_rate) or flt(row.last_purchase_rate) or 0.0
	return {code: flt(out.get(code) or 0.0) for code in codes}


def cost_rate(item_code: str, warehouse: Optional[str] = None) -> float:
	"""One item's moving-average cost at the main warehouse."""
	return cost_for([item_code], warehouse).get(item_code, 0.0)


def override_for(item_codes: list[str]) -> dict[str, float]:
	"""``{item_code: typed wholesale price}`` for the items that carry one (blank / 0 = no override)."""
	codes = [c for c in dict.fromkeys(item_codes or []) if c]
	if not codes or not _has_override_field():
		return {}
	rows = frappe.get_all(
		"Item",
		filters={"name": ("in", codes)},
		fields=["name", OVERRIDE_FIELD],
		limit=len(codes) + 10,
	)
	return {r["name"]: flt(r[OVERRIDE_FIELD]) for r in rows if flt(r[OVERRIDE_FIELD]) > 0}


def _has_override_field() -> bool:
	try:
		return frappe.get_meta("Item").has_field(OVERRIDE_FIELD)
	except Exception:  # pragma: no cover — a site that has not migrated yet
		return False


# ---------------------------------------------------------------------------
# the answer
# ---------------------------------------------------------------------------
def apply_markup(cost: Any, pct: Optional[float] = None) -> float:
	"""``cost × (1 + pct/100)``, rounded to 2. Pure — the price board's maths, testable on its own."""
	pct = markup_pct() if pct is None else flt(pct)
	return flt(flt(cost) * (1.0 + pct / 100.0), PRECISION)


def wholesale_rate(item_code: str, cost: Optional[float] = None) -> float:
	"""What a store pays for one unit of *item_code*: the override when set, else the rule.

	*cost* lets a caller that already knows the moving average skip the lookup (the stamping loop
	and the price board both do); it is ignored when the item carries an override.
	"""
	override = override_for([item_code]).get(item_code)
	if override:
		return flt(override, PRECISION)
	if cost is None:
		cost = cost_rate(item_code)
	return apply_markup(cost)


def wholesale_for(item_codes: list[str], warehouse: Optional[str] = None) -> dict[str, dict[str, Any]]:
	"""Resolve many items in one pass — the screens list 160 at a time.

	``{item_code: {item_code, cost, override, wholesale, source, markup_pct}}`` where *source* is
	``"override"`` (somebody typed this price on the item) or ``"markup"`` (the chain-wide rule).
	"""
	codes = [c for c in dict.fromkeys(item_codes or []) if c]
	if not codes:
		return {}
	pct = markup_pct()
	costs = cost_for(codes, warehouse)
	overrides = override_for(codes)
	out: dict[str, dict[str, Any]] = {}
	for code in codes:
		cost = flt(costs.get(code) or 0.0, PRECISION)
		override = flt(overrides.get(code) or 0.0, PRECISION)
		rate = override if override else apply_markup(cost, pct)
		out[code] = {
			"item_code": code,
			"cost": cost,
			"override": override or None,
			"wholesale": flt(rate, PRECISION),
			"source": "override" if override else "markup",
			"markup_pct": pct,
			"margin": flt(rate - cost, PRECISION),
			"margin_pct": flt(100.0 * (rate - cost) / rate, 1) if rate else 0.0,
		}
	return out


def set_override(item_code: str, rate: Any) -> dict[str, Any]:
	"""Type a wholesale price on one item; ``None`` clears it and returns the item to the rule."""
	from maison_pos.purchasing import assert_item

	assert_item(item_code)
	if not _has_override_field():  # pragma: no cover — migrate has not run
		frappe.throw(_("Item {0} does not carry a wholesale override field yet — run bench migrate").format(item_code), frappe.ValidationError)
	if rate in (None, "", "null"):
		value = 0.0
	else:
		value = flt(rate, PRECISION)
		if value < 0:
			frappe.throw(_("A wholesale price cannot be negative"), frappe.ValidationError)
	# "blank means use the rule", and zero is how a Currency column spells blank — Frappe declares
	# them NOT NULL, so clearing an override writes 0 rather than a NULL that the table refuses.
	frappe.db.set_value("Item", item_code, OVERRIDE_FIELD, value, update_modified=False)
	frappe.clear_document_cache("Item", item_code)
	return wholesale_for([item_code])[item_code]


# ---------------------------------------------------------------------------
# §B — stamping a shipment
# ---------------------------------------------------------------------------
def is_stamped(doc) -> bool:
	"""Has this shipment already been valued? (Shipments that shipped before v1.2 never were.)"""
	return bool(doc.get("value_stamped_at"))


def stamp_shipment(doc, force: bool = False) -> dict[str, Any]:
	"""Write today's cost and wholesale onto every line, and the totals onto the shipment.

	Called once, from ``maison_pos.api.shipping.ship``, at the moment the consignment leaves —
	never on read, and never a second time. The caller saves; this only mutates the document in
	memory so the stamp lands in the same write as the status change.
	"""
	if is_stamped(doc) and not force:
		return {
			"stamped": False,
			"cost_total": flt(doc.get("cost_total")),
			"wholesale_total": flt(doc.get("wholesale_total")),
			"value_stamped_at": doc.get("value_stamped_at"),
		}
	resolved = wholesale_for([line.item_code for line in doc.lines])
	cost_total = 0.0
	wholesale_total = 0.0
	for line in doc.lines:
		row = resolved.get(line.item_code) or {}
		qty = flt(line.get("shipped_qty")) or flt(line.qty)
		line.cost_rate = flt(row.get("cost") or 0.0, PRECISION)
		line.wholesale_rate = flt(row.get("wholesale") or 0.0, PRECISION)
		cost_total += flt(line.cost_rate) * qty
		wholesale_total += flt(line.wholesale_rate) * qty
	doc.cost_total = flt(cost_total, PRECISION)
	doc.wholesale_total = flt(wholesale_total, PRECISION)
	doc.value_stamped_at = now_datetime()
	return {
		"stamped": True,
		"cost_total": flt(doc.cost_total),
		"wholesale_total": flt(doc.wholesale_total),
		"margin": flt(flt(doc.wholesale_total) - flt(doc.cost_total), PRECISION),
		"value_stamped_at": doc.value_stamped_at,
	}
