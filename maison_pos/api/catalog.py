"""Catalog endpoints: full bootstrap and incremental delta for the offline PWA.

All methods are whitelisted under ``/api/method/maison_pos.api.catalog.*``.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Sum
from frappe.utils import flt, get_datetime, now_datetime

from maison_pos.scoping import assert_boutique_access
from maison_pos.utils import parse_datetime

ITEM_FIELDS = [
	"name",
	"item_code",
	"item_name",
	"item_group",
	"description",
	"stock_uom",
	"has_serial_no",
	"image",
	"disabled",
	"is_sales_item",
	"is_stock_item",
	"maison_department",
	"maison_metal",
	"maison_carat",
	"maison_stones",
	"maison_certificate_no",
	"maison_appraisal_value",
	"maison_taxable",
	"maison_image_url",
	"modified",
]

DEPARTMENTS = ["Timepieces", "High Jewellery", "Bridal", "Accessories", "Services"]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _boutique_dict(boutique: str) -> dict[str, Any]:
	doc = frappe.get_cached_doc("Maison Boutique", boutique)
	return {
		"name": doc.name,
		"boutique_code": doc.boutique_code,
		"boutique_name": doc.boutique_name,
		"company": doc.company,
		"warehouse": doc.warehouse,
		"cost_center": doc.cost_center,
		"pos_profile": doc.pos_profile,
		"tax_template": doc.get_tax_template(),
		"address_line": doc.address_line,
		"city": doc.city,
		"phone": doc.phone,
		"email": doc.email,
		"stripe_location_id": doc.stripe_location_id,
		"printer_ip": doc.printer_ip,
		"printer_model": doc.printer_model,
		"currency": frappe.get_cached_value("Company", doc.company, "default_currency"),
	}


def _pos_profile_dict(pos_profile: str) -> dict[str, Any]:
	doc = frappe.get_cached_doc("POS Profile", pos_profile)
	return {
		"name": doc.name,
		"company": doc.company,
		"currency": doc.currency,
		"warehouse": doc.warehouse,
		"selling_price_list": doc.selling_price_list,
		"taxes_and_charges": doc.taxes_and_charges,
		"cost_center": doc.cost_center,
		"customer": doc.customer,
		"write_off_account": doc.write_off_account,
		"payments": [
			{"mode_of_payment": p.mode_of_payment, "default": int(p.default or 0)} for p in doc.payments
		],
	}


def _taxes(template: Optional[str]) -> list[dict[str, Any]]:
	if not template:
		return []
	doc = frappe.get_cached_doc("Sales Taxes and Charges Template", template)
	return [
		{
			"charge_type": t.charge_type,
			"account_head": t.account_head,
			"description": t.description,
			"rate": flt(t.rate),
			"included_in_print_rate": int(t.included_in_print_rate or 0),
		}
		for t in doc.taxes
	]


def _modes_of_payment(pos_profile: dict[str, Any]) -> list[dict[str, Any]]:
	names = [p["mode_of_payment"] for p in pos_profile["payments"]] or ["Cash", "Card"]
	rows = frappe.get_all("Mode of Payment", filters={"name": ("in", names), "enabled": 1}, fields=["name", "type"])
	return [{"name": r.name, "type": r.type} for r in rows]


def _item_groups() -> list[str]:
	"""Leaf Item Group names that actually hold sales items (the POS category rail).

	The PWA contract is ``item_groups: string[]``; returning the full ERPNext group list
	(Consumable, Raw Material, ...) as dicts rendered JSON blobs in the rail.
	"""
	used = {
		r.item_group
		for r in frappe.get_all("Item", filters={"is_sales_item": 1, "disabled": 0}, fields=["item_group"], distinct=True)
	}
	rows = frappe.get_all("Item Group", filters={"is_group": 0, "name": ("in", list(used))}, fields=["name"], order_by="name")
	return [r.name for r in rows]


def _items(since: Optional[str] = None) -> list[dict[str, Any]]:
	filters: dict[str, Any] = {"is_sales_item": 1}
	if since:
		filters["modified"] = (">=", since)
	else:
		filters["disabled"] = 0
	return frappe.get_all("Item", filters=filters, fields=ITEM_FIELDS, order_by="item_name")


def _prices(price_list: str, since: Optional[str] = None) -> dict[str, float]:
	filters: dict[str, Any] = {"price_list": price_list, "selling": 1}
	if since:
		filters["modified"] = (">=", since)
	rows = frappe.get_all("Item Price", filters=filters, fields=["item_code", "price_list_rate"])
	return {r.item_code: flt(r.price_list_rate) for r in rows}


def _pricing_rules(warehouse: str, since: Optional[str] = None) -> list[dict[str, Any]]:
	PR = DocType("Pricing Rule")
	PRI = DocType("Pricing Rule Item Code")
	q = (
		frappe.qb.from_(PR)
		.join(PRI)
		.on(PRI.parent == PR.name)
		.select(PR.name, PRI.item_code, PR.rate, PR.valid_from, PR.valid_upto, PR.disable, PR.priority, PR.modified)
		.where((PR.warehouse == warehouse) & (PR.selling == 1) & (PR.rate_or_discount == "Rate"))
	)
	if since:
		q = q.where(PR.modified >= since)
	else:
		q = q.where(PR.disable == 0)
	return [
		{
			"name": r.name,
			"item_code": r.item_code,
			"rate": flt(r.rate),
			"valid_from": str(r.valid_from) if r.valid_from else None,
			"valid_upto": str(r.valid_upto) if r.valid_upto else None,
			"disabled": int(r.disable or 0),
			"priority": r.priority,
		}
		for r in q.run(as_dict=True)
	]


def _serials(warehouse: str, since: Optional[str] = None) -> dict[str, list[str]]:
	filters: dict[str, Any] = {"warehouse": warehouse, "status": "Active"}
	if since:
		filters["modified"] = (">=", since)
	rows = frappe.get_all("Serial No", filters=filters, fields=["item_code", "name"], order_by="name")
	out: dict[str, list[str]] = {}
	for r in rows:
		out.setdefault(r.item_code, []).append(r.name)
	return out


def _stock(warehouse: str, since: Optional[str] = None) -> dict[str, float]:
	Bin = DocType("Bin")
	q = frappe.qb.from_(Bin).select(Bin.item_code, Sum(Bin.actual_qty).as_("qty")).where(Bin.warehouse == warehouse).groupby(Bin.item_code)
	if since:
		q = q.where(Bin.modified >= since)
	return {r.item_code: flt(r.qty) for r in q.run(as_dict=True)}


def _loyalty_program(company: str) -> Optional[dict[str, Any]]:
	programs = frappe.get_all(
		"Loyalty Program",
		filters={"company": company},
		fields=["name", "loyalty_program_name", "loyalty_program_type", "conversion_factor", "expiry_duration", "auto_opt_in"],
		order_by="auto_opt_in desc, modified desc",
		limit=1,
	)
	if not programs:
		return None
	program = programs[0]
	tiers = frappe.get_all(
		"Loyalty Program Collection",
		filters={"parent": program.name},
		fields=["tier_name", "min_spent", "collection_factor"],
		order_by="min_spent asc",
	)
	program["tiers"] = tiers
	return program


def _deleted_since(doctype: str, since: str) -> list[str]:
	return frappe.get_all(
		"Deleted Document",
		filters={"deleted_doctype": doctype, "creation": (">=", since)},
		pluck="deleted_name",
	)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
@frappe.whitelist()
def _associates(boutique: str) -> list[dict[str, Any]]:
	"""Associates that may unlock the POS at *boutique*.

	No PIN hashes leave the server: the PWA verifies PINs online via
	``maison_associate.verify_pin`` and caches a device-local digest for offline unlock.
	"""
	rows = frappe.get_all(
		"Maison Associate",
		filters={"boutique": boutique, "enabled": 1},
		fields=["name", "user", "full_name", "boutique", "role"],
		order_by="full_name",
	)
	for r in rows:
		r["pin_hash"] = ""
	return rows


@frappe.whitelist()
def bootstrap(boutique: str) -> dict[str, Any]:
	"""Full catalog snapshot for *boutique* (items, prices, overrides, serials, stock, associates)."""
	boutique = assert_boutique_access(boutique)
	b = _boutique_dict(boutique)
	pos_profile = _pos_profile_dict(b["pos_profile"])
	price_list = pos_profile["selling_price_list"] or "Standard Selling"
	version = now_datetime()

	return {
		"boutique": b,
		"associates": _associates(boutique),
		"pos_profile": pos_profile,
		"taxes": _taxes(b["tax_template"]),
		"modes_of_payment": _modes_of_payment(pos_profile),
		"item_groups": _item_groups(),
		"departments": DEPARTMENTS,
		"items": _items(),
		"prices": _prices(price_list),
		"pricing_rules": _pricing_rules(b["warehouse"]),
		"serials": _serials(b["warehouse"]),
		"stock": _stock(b["warehouse"]),
		"loyalty_program": _loyalty_program(b["company"]),
		"version": version.isoformat(),
	}


@frappe.whitelist()
def delta(boutique: str, since: str) -> dict[str, Any]:
	"""Rows changed since *since* (ISO timestamp) plus ``deleted`` item codes."""
	if not since:
		frappe.throw(_("'since' is required; call bootstrap for a full snapshot"), frappe.ValidationError)
	boutique = assert_boutique_access(boutique)
	since_dt = parse_datetime(since)
	since_s = get_datetime(since_dt).strftime("%Y-%m-%d %H:%M:%S")
	b = _boutique_dict(boutique)
	pos_profile = _pos_profile_dict(b["pos_profile"])
	price_list = pos_profile["selling_price_list"] or "Standard Selling"
	version = now_datetime()

	# Serial numbers: also report those that left the warehouse / were consumed so the client can drop them.
	sold_serials = frappe.get_all(
		"Serial No",
		filters={"modified": (">=", since_s), "item_code": ("is", "set")},
		or_filters=[["warehouse", "!=", b["warehouse"]], ["status", "!=", "Active"]],
		fields=["item_code", "name"],
	)
	removed: dict[str, list[str]] = {}
	for r in sold_serials:
		removed.setdefault(r.item_code, []).append(r.name)

	return {
		"boutique": b,
		"pos_profile": pos_profile,
		"taxes": _taxes(b["tax_template"]),
		"modes_of_payment": _modes_of_payment(pos_profile),
		"item_groups": _item_groups(),
		"departments": DEPARTMENTS,
		"items": _items(since_s),
		"prices": _prices(price_list, since_s),
		"pricing_rules": _pricing_rules(b["warehouse"], since_s),
		"serials": _serials(b["warehouse"], since_s),
		"serials_removed": removed,
		"stock": _stock(b["warehouse"], since_s),
		"loyalty_program": _loyalty_program(b["company"]),
		"deleted": _deleted_since("Item", since_s),
		"since": since_s,
		"version": version.isoformat(),
	}
