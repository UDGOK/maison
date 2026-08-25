"""Pricing API (v1.2) — ``maison_pos.api.pricing.*``.

Two prices, one module:

===========================  =========================================================
§A the wholesale price       ``wholesale`` ``set_wholesale`` ``wholesale_settings``
                             ``set_wholesale_markup`` — what a **store** pays Houston
§C the month-end statement   ``statement`` — what each store owes for a period
§D retail, per store         ``store_prices`` — every store's current shelf price for an
                             item, where it comes from, and the margin it makes. The
                             raising and approving of a new shelf price stays where it has
                             been since v0.1: ``maison_pos.api.purchasing``.
===========================  =========================================================

**Head office and the warehouse only.** Every endpoint here is behind
``assert_purchasing_admin`` — the same gate the buying screens use — because every one of them
either shows or is derived from what AWANZ Houston paid for its stock. A store manager is refused
all of it, including the statement for their own store.

**None of this is accounting.** No invoice, no receivable, no ageing, no payment. Stock still
moves at cost; the wholesale figure rides alongside for reporting (SPEC_v1.2 client decision 6).
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from maison_pos.pricing import wholesale as wholesale_lib
from maison_pos.purchasing import assert_item, main_warehouse
from maison_pos.reports import store_statement
from maison_pos.scoping import assert_purchasing_admin

#: the selling price list the chain default lives on
DEFAULT_PRICE_LIST = "Standard Selling"


def _loads(value: Any, default: Any) -> Any:
	if value in (None, ""):
		return default
	if isinstance(value, str):
		try:
			return json.loads(value)
		except ValueError:
			return [v.strip() for v in value.split(",") if v.strip()] if default == [] else default
	return value


# ===========================================================================
# §A — the wholesale price
# ===========================================================================
@frappe.whitelist()
def wholesale_settings() -> dict[str, Any]:
	"""The chain-wide rule and what it is applied to.

	``{markup_pct, default_markup_pct, warehouse, currency, internal, notice}``
	"""
	assert_purchasing_admin()
	return {
		"markup_pct": wholesale_lib.markup_pct(),
		"default_markup_pct": wholesale_lib.DEFAULT_MARKUP_PCT,
		"warehouse": main_warehouse(),
		"currency": store_statement._currency(),
		"cost_basis": "Moving average valuation at the main warehouse",
		# one price for every store — per-partner terms are a multi-company concern (decision 1)
		"per_store_terms": False,
		"internal": True,
		"notice": store_statement.INTERNAL_NOTICE,
	}


@frappe.whitelist()
def set_wholesale_markup(pct: Any) -> dict[str, Any]:
	"""Set the chain-wide markup (percent of cost). Returns :func:`wholesale_settings`."""
	assert_purchasing_admin()
	wholesale_lib.set_markup_pct(pct)
	return wholesale_settings()


@frappe.whitelist()
def wholesale(item_codes: Any) -> dict[str, Any]:
	"""Resolve the wholesale price of many items at once — the price board lists 160 at a time.

	``item_codes`` may be a list or a JSON / comma-separated string. Returns
	``{markup_pct, currency, items: [{item_code, item_name, cost, override, wholesale, source,
	markup_pct, margin, margin_pct}], count}`` in the order asked for.
	"""
	assert_purchasing_admin()
	codes = [str(c).strip() for c in (_loads(item_codes, []) or []) if str(c).strip()]
	resolved = wholesale_lib.wholesale_for(codes)
	names = (
		{r.name: r.item_name for r in frappe.get_all("Item", filters={"name": ("in", codes)}, fields=["name", "item_name"], limit=len(codes) + 10)}
		if codes
		else {}
	)
	items = [{**resolved[c], "item_name": names.get(c) or c} for c in codes if c in resolved]
	return {
		"markup_pct": wholesale_lib.markup_pct(),
		"currency": store_statement._currency(),
		"warehouse": main_warehouse(),
		"items": items,
		"count": len(items),
	}


@frappe.whitelist()
def set_wholesale(item_code: str, rate: Any = None) -> dict[str, Any]:
	"""Type a wholesale price on one item; ``null`` clears it and returns the item to the rule.

	Returns the resolved row for that item — the same shape ``wholesale`` returns, so the screen
	can drop it straight back into the list.
	"""
	assert_purchasing_admin()
	row = wholesale_lib.set_override(item_code, rate)
	row["item_name"] = frappe.db.get_value("Item", item_code, "item_name") or item_code
	return {"item": row, "markup_pct": wholesale_lib.markup_pct(), "currency": store_statement._currency()}


# ===========================================================================
# §C — the month-end statement
# ===========================================================================
@frappe.whitelist()
def statement(from_date: Optional[str] = None, to_date: Optional[str] = None, boutique: Optional[str] = None) -> dict[str, Any]:
	"""What each store owes for the period — **a report, not an invoice**.

	One row per store (client decision 5), netted of shortages and damage (decision 4), showing
	cost and margin because it is an internal document (decision 3). Every store appears, with
	zeros when nothing was sent. Each store row carries a ``lines`` breakdown per item that the
	screen does not render and the CSV export does.

	The payload carries ``internal`` / ``is_invoice`` / ``creates_receivable`` / ``notice``: this
	must never be mistakable for a receivable, and the screen is expected to say so in words.
	"""
	assert_purchasing_admin()
	return store_statement.build(from_date, to_date, boutique)


# ===========================================================================
# §D — retail, per store: what the price board reads
# ===========================================================================
def _chain_price(item_code: str, price_list: str = DEFAULT_PRICE_LIST) -> float:
	return flt(
		frappe.db.get_value(
			"Item Price",
			{"item_code": item_code, "price_list": price_list, "selling": 1},
			"price_list_rate",
		)
	)


def _store_overrides(item_code: str, boutiques: list[str]) -> dict[str, dict[str, Any]]:
	"""The live store-scoped Pricing Rule per boutique, if any.

	The rule is the one ``AWANZ Price Change Request.apply_pricing_rule`` writes on approval —
	titled ``AWANZ <boutique> <item_code>``. Read, never written, from here: approving a request
	is what creates it, and that behaviour is v0.1's.
	"""
	from maison_pos.awanz_pos.doctype.awanz_price_change_request.awanz_price_change_request import pricing_rule_title

	titles = {pricing_rule_title(b, item_code): b for b in boutiques}
	if not titles:
		return {}
	today = getdate(nowdate())
	out: dict[str, dict[str, Any]] = {}
	for rule in frappe.get_all(
		"Pricing Rule",
		filters=[["title", "in", list(titles)]],
		fields=["name", "title", "rate", "disable", "valid_from", "valid_upto", "warehouse"],
		limit=len(titles) + 10,
	):
		boutique = titles.get(rule.title)
		if not boutique:
			continue
		live = not cint(rule.disable)
		if live and rule.valid_from and getdate(rule.valid_from) > today:
			live = False
		if live and rule.valid_upto and getdate(rule.valid_upto) < today:
			live = False
		out[boutique] = {
			"pricing_rule": rule.name,
			"rate": flt(rule.rate),
			"live": live,
			"valid_from": str(rule.valid_from) if rule.valid_from else None,
			"valid_upto": str(rule.valid_upto) if rule.valid_upto else None,
		}
	return out


def _pending_requests(item_code: str) -> dict[str, dict[str, Any]]:
	rows = frappe.get_all(
		"AWANZ Price Change Request",
		filters={"item_code": item_code, "workflow_state": "Pending Approval", "docstatus": 1},
		fields=["name", "boutique", "current_rate", "proposed_rate", "reason", "requested_by", "valid_from", "valid_upto"],
		order_by="modified desc",
		limit=200,
	)
	out: dict[str, dict[str, Any]] = {}
	for r in rows:
		out.setdefault(
			r.boutique,
			{
				"name": r.name,
				"current_rate": flt(r.current_rate),
				"proposed_rate": flt(r.proposed_rate),
				"reason": r.reason,
				"requested_by": r.requested_by,
				"valid_from": str(r.valid_from) if r.valid_from else None,
				"valid_upto": str(r.valid_upto) if r.valid_upto else None,
			},
		)
	return out


def margin_at(rate: Any, wholesale_rate: Any) -> dict[str, Any]:
	"""What a store makes selling at *rate* having paid *wholesale_rate*. The price board's maths.

	``margin_pct`` is ``None`` when there is no price to take a percentage of — an item the chain
	has never priced is not a 0 % margin, and a board that says 0 % is the sort of thing somebody
	prices against.
	"""
	rate = flt(rate)
	cost = flt(wholesale_rate)
	margin = flt(rate - cost, 2)
	return {"margin": margin, "margin_pct": flt(100.0 * margin / rate, 1) if rate else None, "has_price": bool(rate)}


@frappe.whitelist()
def store_prices(item_code: str, price_list: str = DEFAULT_PRICE_LIST) -> dict[str, Any]:
	"""Every enabled store's current shelf price for one item — the **Prices** board (§D).

	Per store: the price in force, where it comes from (a store override or the chain default),
	what the store pays Houston for the item, and the margin that price makes. Plus any request
	already waiting for approval, so the board does not invite a second one for the same row.

	Read only. Typing a new price raises ``purchasing.request_price_change``; approving it is
	``purchasing.approve_price_change``, and approval is what creates the store's Pricing Rule.
	"""
	assert_purchasing_admin()
	assert_item(item_code)
	from maison_pos.shipping import store_boutiques

	codes = store_boutiques()
	stores = frappe.get_all(
		"AWANZ Store", filters={"name": ("in", codes or ["__none__"])}, fields=["name", "boutique_name", "warehouse"], order_by="name"
	)
	resolved = wholesale_lib.wholesale_for([item_code])[item_code]
	default_rate = _chain_price(item_code, price_list)
	overrides = _store_overrides(item_code, [s.name for s in stores])
	pending = _pending_requests(item_code)

	rows = []
	for s in stores:
		override = overrides.get(s.name)
		if override and override["live"]:
			rate, source = override["rate"], "Store override"
		else:
			rate, source = default_rate, "Chain default"
		row = {
			"boutique": s.name,
			"boutique_name": s.boutique_name or s.name,
			"warehouse": s.warehouse,
			"rate": flt(rate),
			"source": source,
			"is_override": source == "Store override",
			"pricing_rule": (override or {}).get("pricing_rule"),
			"valid_from": (override or {}).get("valid_from"),
			"valid_upto": (override or {}).get("valid_upto"),
			"wholesale": resolved["wholesale"],
			"pending": pending.get(s.name),
		}
		row.update(margin_at(rate, resolved["wholesale"]))
		rows.append(row)

	item = frappe.db.get_value("Item", item_code, ["item_name", "stock_uom", "maison_barcode", "image", "item_group"], as_dict=True) or {}
	return {
		"item_code": item_code,
		"item_name": item.get("item_name") or item_code,
		"item_group": item.get("item_group"),
		"uom": item.get("stock_uom"),
		"barcode": item.get("maison_barcode"),
		"image": item.get("image"),
		"price_list": price_list,
		"default_rate": default_rate,
		"currency": store_statement._currency(),
		# what the store pays us — the same figure for every store (client decision 1)
		"wholesale": resolved["wholesale"],
		"wholesale_source": resolved["source"],
		"cost": resolved["cost"],
		"markup_pct": resolved["markup_pct"],
		"stores": rows,
		"count": len(rows),
		"internal": True,
		"notice": _("Cost and wholesale are internal AWANZ figures — do not put them in front of a store."),
	}
