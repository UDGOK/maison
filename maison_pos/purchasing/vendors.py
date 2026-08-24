"""Vendors (SPEC_v1.0 §A) and the item ↔ vendor catalogue (§B).

* the vendor master is ERPNext **Supplier** plus ``maison_*`` custom fields;
* every vendor owns a buying **Price List** named ``<Supplier> Buying``, created on first save;
* negotiated rates are ``Item Price`` rows on that list (``buying = 1``, ``supplier`` set), written
  through from the ``AWANZ Item Vendor`` child table on the Item so a Purchase Order for that
  vendor picks the rate up by itself — and every rate stays editable on the PO line.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, nowdate

PRICE_LIST_SUFFIX = " Buying"
VENDOR_FIELDS = (
	"maison_lead_time_days",
	"maison_min_order_value",
	"maison_dropship_capable",
	"maison_order_method",
	"maison_portal_url",
	"maison_account_number",
	"maison_rep_name",
	"maison_rep_phone",
	"maison_rep_email",
	"maison_notes",
	"maison_active",
)
ITEM_VENDOR_FIELDS = (
	"supplier",
	"vendor_sku",
	"case_pack",
	"moq",
	"cost",
	"lead_time_days",
	"is_preferred",
	"notes",
)


# ---------------------------------------------------------------------------
# buying price list
# ---------------------------------------------------------------------------
def price_list_name(supplier: str) -> str:
	"""``<Supplier> Buying`` — trimmed to the 140-char Price List name limit."""
	return (supplier or "")[: 140 - len(PRICE_LIST_SUFFIX)] + PRICE_LIST_SUFFIX


def ensure_price_list(supplier: str, currency: Optional[str] = None) -> str:
	"""Create (idempotently) the vendor's own buying price list and return its name."""
	name = price_list_name(supplier)
	if frappe.db.exists("Price List", name):
		if not frappe.db.get_value("Price List", name, "enabled"):
			frappe.db.set_value("Price List", name, "enabled", 1, update_modified=False)
		return name
	from maison_pos.purchasing import default_company

	currency = currency or frappe.get_cached_value("Company", default_company(), "default_currency") or "USD"
	doc = frappe.get_doc(
		{
			"doctype": "Price List",
			"price_list_name": name,
			"currency": currency,
			"buying": 1,
			"selling": 0,
			"enabled": 1,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_if_duplicate=True)
	return doc.name


def on_supplier_update(doc, method: Optional[str] = None) -> None:
	"""``Supplier.after_insert`` / ``on_update`` hook — every vendor has its own buying list."""
	if frappe.flags.in_install or frappe.flags.in_migrate:
		return
	try:
		ensure_price_list(doc.name)
	except Exception:  # pragma: no cover — never block a Supplier save on the price list
		frappe.log_error(frappe.get_traceback(), f"awanz buying price list {doc.name}")


# ---------------------------------------------------------------------------
# Item Price write-through
# ---------------------------------------------------------------------------
def set_vendor_price(item_code: str, supplier: str, cost: float, lead_time_days: int = 0, currency: Optional[str] = None) -> Optional[str]:
	"""Create / update the ``Item Price`` for (*item_code*, *supplier*) on the vendor's list.

	A vendor row may legitimately carry **no** cost ("buy at whatever they quote that day"): the
	price row is then removed so the PO falls back to the item's last purchase rate.
	"""
	plist = ensure_price_list(supplier, currency)
	existing = frappe.db.get_value(
		"Item Price", {"item_code": item_code, "price_list": plist, "supplier": supplier}, "name"
	)
	if flt(cost) <= 0:
		if existing:
			frappe.delete_doc("Item Price", existing, ignore_permissions=True, force=True)
		return None
	currency = currency or frappe.db.get_value("Price List", plist, "currency") or "USD"
	if existing:
		doc = frappe.get_doc("Item Price", existing)
	else:
		doc = frappe.new_doc("Item Price")
		doc.item_code = item_code
		doc.price_list = plist
		doc.supplier = supplier
	doc.buying = 1
	doc.selling = 0
	doc.currency = currency
	doc.price_list_rate = flt(cost)
	if cint(lead_time_days):
		doc.lead_time_days = cint(lead_time_days)
	doc.flags.ignore_permissions = True
	doc.save()
	return doc.name


def vendor_rate(item_code: str, supplier: str) -> float:
	"""Negotiated rate for (*item*, *vendor*): the item-vendor row, else the vendor price list."""
	row = frappe.db.get_value(
		"AWANZ Item Vendor", {"parent": item_code, "parenttype": "Item", "supplier": supplier}, "cost"
	)
	if flt(row):
		return flt(row)
	rate = frappe.db.get_value(
		"Item Price", {"item_code": item_code, "price_list": price_list_name(supplier), "supplier": supplier}, "price_list_rate"
	)
	return flt(rate)


# ---------------------------------------------------------------------------
# AWANZ Item Vendor (child table on Item)
# ---------------------------------------------------------------------------
def item_vendor_rows(item_code: str) -> list[Any]:
	if not frappe.db.exists("Item", item_code):
		return []
	return frappe.get_all(
		"AWANZ Item Vendor",
		filters={"parent": item_code, "parenttype": "Item"},
		fields=[
			"name",
			"supplier",
			"vendor_sku",
			"case_pack",
			"moq",
			"cost",
			"lead_time_days",
			"is_preferred",
			"last_purchase_date",
			"last_purchase_rate",
			"notes",
			"idx",
		],
		order_by="is_preferred desc, idx asc",
	)


def preferred_vendor(item_code: str) -> Optional[dict[str, Any]]:
	rows = item_vendor_rows(item_code)
	for r in rows:
		if cint(r.get("is_preferred")):
			return r
	return rows[0] if rows else None


def validate_item_vendors(doc, method: Optional[str] = None) -> None:
	"""``Item.validate`` hook — exactly one preferred vendor, no duplicate vendor rows.

	Setting a new ``is_preferred`` clears the rest (the row the user just ticked wins); if no row
	is ticked at all the first one becomes the preferred vendor, so "the preferred vendor" is
	never ambiguous for the demand engine.
	"""
	rows = doc.get("maison_vendors") or []
	if not rows:
		return
	seen: set[str] = set()
	for row in rows:
		if not row.supplier:
			frappe.throw(_("Vendor row {0} has no supplier").format(row.idx), frappe.ValidationError)
		if row.supplier in seen:
			frappe.throw(_("Vendor {0} is listed twice on {1}").format(row.supplier, doc.name), frappe.ValidationError)
		seen.add(row.supplier)
		if cint(row.case_pack) < 1:
			row.case_pack = 1
	# `_preferred_hint` is set by api.purchasing.set_preferred_vendor / save_item_vendor so the
	# row the caller just ticked wins even when another row was already ticked in the database.
	hint = doc.get("_awanz_preferred_supplier") or None
	ticked = [r for r in rows if cint(r.is_preferred)]
	if hint:
		winner = next((r for r in rows if r.supplier == hint), None)
	elif len(ticked) == 1:
		winner = ticked[0]
	elif ticked:
		winner = ticked[-1]
	else:
		winner = rows[0]
	for row in rows:
		row.is_preferred = 1 if row is winner else 0


def sync_item_vendor_prices(doc, method: Optional[str] = None) -> None:
	"""``Item.on_update`` hook — the negotiated ``cost`` writes through to the vendor's Item Price."""
	if frappe.flags.in_install or frappe.flags.in_migrate:
		return
	for row in doc.get("maison_vendors") or []:
		if not row.supplier:
			continue
		try:
			set_vendor_price(doc.name, row.supplier, flt(row.cost), cint(row.lead_time_days))
		except Exception:  # pragma: no cover — a bad price row must never block the Item save
			frappe.log_error(frappe.get_traceback(), f"awanz vendor price {doc.name}/{row.supplier}")


def stamp_last_purchase(item_code: str, supplier: str, rate: float, date: Optional[str] = None) -> None:
	"""Stamp ``last_purchase_date`` / ``last_purchase_rate`` on the item-vendor row (receipt submit)."""
	name = frappe.db.get_value(
		"AWANZ Item Vendor", {"parent": item_code, "parenttype": "Item", "supplier": supplier}, "name"
	)
	if not name:
		return
	frappe.db.set_value(
		"AWANZ Item Vendor",
		name,
		{"last_purchase_date": date or nowdate(), "last_purchase_rate": flt(rate)},
		update_modified=False,
	)
	frappe.clear_document_cache("Item", item_code)


def add_or_update_row(item_code: str, row: dict[str, Any]) -> dict[str, Any]:
	"""Insert or update one ``AWANZ Item Vendor`` row on *item_code* and return it."""
	item = frappe.get_doc("Item", item_code)
	supplier = (row.get("supplier") or "").strip()
	if not supplier or not frappe.db.exists("Supplier", supplier):
		frappe.throw(_("Vendor {0} does not exist").format(supplier or "?"), frappe.DoesNotExistError)
	target = None
	for existing in item.get("maison_vendors") or []:
		if existing.name == row.get("name") or existing.supplier == supplier:
			target = existing
			break
	if target is None:
		target = item.append("maison_vendors", {"supplier": supplier})
	for field in ITEM_VENDOR_FIELDS:
		if field in row:
			target.set(field, row.get(field))
	target.supplier = supplier
	if cint(target.case_pack) < 1:
		target.case_pack = 1
	if cint(row.get("is_preferred")):
		item._awanz_preferred_supplier = supplier
	item.flags.ignore_permissions = True
	item.save()
	return {r["supplier"]: r for r in item_vendor_rows(item_code)}.get(supplier, {})
