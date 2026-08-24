"""Purchasing API (v1.0 "Procurement") — ``maison_pos.api.purchasing.*``.

Buying is centralised in Houston: **AWANZ Warehouse Admin** and **AWANZ Head Office** only.
Stores never raise a purchase order; a store manager may *read* a Purchase Order addressed to
their own store (so the Receive screen works) and nothing else.

Sections follow ``SPEC_v1.0.md``:

===========================  =========================================================
§A vendors                   ``vendors`` ``vendor`` ``save_vendor`` ``set_vendor_active``
§B item ↔ vendor catalogue   ``item_vendors`` ``save_item_vendor`` ``remove_item_vendor``
                             ``set_preferred_vendor``
§C what to buy               ``suggestions`` ``dismiss_suggestion`` ``create_orders``
§D purchase orders           ``orders`` ``order`` ``create_order`` ``update_order``
                             ``submit_order`` ``send_order`` ``close_order``
                             ``delete_order`` (a draft's terminal action — Close needs a
                             submitted order)
§E receiving at HOU-WH       ``inbound`` ``receive`` (the store side stays
                             ``maison_pos.api.inventory.receive_po``)
store selling price          ``price_change_requests`` ``request_price_change``
                             ``approve_price_change`` — thin wrappers over the **existing**
                             ``AWANZ Price Change Request`` + ``AWANZ Price Approval`` workflow
===========================  =========================================================
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, getdate, now_datetime, nowdate

from maison_pos.purchasing import assert_item, main_warehouse
from maison_pos.purchasing import orders as po_lib
from maison_pos.purchasing import receiving as receiving_lib
from maison_pos.purchasing import vendors as vendor_lib
from maison_pos.purchasing.demand import cached as cached_suggestions
from maison_pos.purchasing.demand import run as run_suggestions
from maison_pos.scoping import (
	assert_boutique_access,
	assert_purchase_order_read,
	assert_purchasing_admin,
	is_purchasing_admin,
)

VENDOR_FIELDS = vendor_lib.VENDOR_FIELDS


def _loads(value: Any, default: Any) -> Any:
	if value in (None, ""):
		return default
	if isinstance(value, str):
		try:
			return json.loads(value)
		except ValueError:
			return default
	return value


# ===========================================================================
# §A — vendors
# ===========================================================================
def vendor_dict(supplier: Any, with_stats: bool = False, stats: Optional[dict[str, Any]] = None) -> dict[str, Any]:
	row = {
		"name": supplier.name,
		"supplier_name": supplier.supplier_name,
		"supplier_group": supplier.get("supplier_group"),
		"disabled": cint(supplier.get("disabled")),
		"price_list": vendor_lib.price_list_name(supplier.name),
		"lead_time_days": cint(supplier.get("maison_lead_time_days")),
		"min_order_value": flt(supplier.get("maison_min_order_value")),
		"dropship_capable": bool(cint(supplier.get("maison_dropship_capable"))),
		"order_method": supplier.get("maison_order_method") or "Email",
		"portal_url": supplier.get("maison_portal_url"),
		"account_number": supplier.get("maison_account_number"),
		"rep_name": supplier.get("maison_rep_name"),
		"rep_phone": supplier.get("maison_rep_phone"),
		"rep_email": supplier.get("maison_rep_email"),
		"notes": supplier.get("maison_notes"),
		"active": bool(cint(supplier.get("maison_active"))) and not cint(supplier.get("disabled")),
	}
	if with_stats:
		row.update(stats or {})
	return row


def vendor_performance(since: str, suppliers: Optional[list[str]] = None) -> dict[str, dict[str, Any]]:
	"""Spend / orders / units / average lead time / on-time % per vendor since *since*.

	Shared by the Vendors screen and the ``AWANZ Purchase by Vendor`` report so the two never
	disagree. "Spend" is what actually arrived (submitted Purchase Receipts), lead time and
	on-time are measured against each order's promised ``schedule_date``.
	"""
	cond, params = "", [since]
	if suppliers:
		cond = " and po.supplier in (" + ", ".join(["%s"] * len(suppliers)) + ")"
		params += list(suppliers)
	orders = frappe.db.sql(
		f"""
		select po.supplier as supplier, count(distinct po.name) as orders,
		       sum(po.base_net_total) as ordered_value,
		       sum(coalesce(po.maison_freight_amount, 0)) as freight
		from `tabPurchase Order` po
		where po.docstatus = 1 and po.transaction_date >= %s {cond}
		group by po.supplier
		""",  # nosec B608 — placeholders only
		params,
		as_dict=True,
	)
	cond_r, params_r = "", [since]
	if suppliers:
		cond_r = " and pr.supplier in (" + ", ".join(["%s"] * len(suppliers)) + ")"
		params_r += list(suppliers)
	receipts = frappe.db.sql(
		f"""
		select pr.supplier as supplier, count(distinct pr.name) as receipts,
		       sum(pri.qty) as units, sum(pri.base_net_amount) as spend
		from `tabPurchase Receipt Item` pri
		join `tabPurchase Receipt` pr on pr.name = pri.parent
		where pr.docstatus = 1 and pr.posting_date >= %s {cond_r}
		group by pr.supplier
		""",  # nosec B608 — placeholders only
		params_r,
		as_dict=True,
	)
	timing = frappe.db.sql(
		f"""
		select po.supplier as supplier, po.name as po, po.transaction_date as ordered_on,
		       po.schedule_date as promised_on, min(pr.posting_date) as received_on
		from `tabPurchase Receipt Item` pri
		join `tabPurchase Receipt` pr on pr.name = pri.parent
		join `tabPurchase Order` po on po.name = pri.purchase_order
		where pr.docstatus = 1 and pr.posting_date >= %s {cond_r.replace('pr.supplier', 'po.supplier')}
		group by po.supplier, po.name, po.transaction_date, po.schedule_date
		""",  # nosec B608 — placeholders only
		params_r,
		as_dict=True,
	)
	out: dict[str, dict[str, Any]] = {}
	for r in orders:
		out.setdefault(r.supplier, {})["orders"] = cint(r.orders)
		out[r.supplier]["ordered_value"] = flt(r.ordered_value)
		out[r.supplier]["freight"] = flt(r.freight)
	for r in receipts:
		acc = out.setdefault(r.supplier, {})
		acc["receipts"] = cint(r.receipts)
		acc["units"] = flt(r.units)
		acc["spend"] = round(flt(r.spend), 2)
	tally: dict[str, list[tuple[int, bool]]] = {}
	for r in timing:
		if not r.received_on:
			continue
		lead = (getdate(r.received_on) - getdate(r.ordered_on)).days if r.ordered_on else 0
		on_time = bool(r.promised_on) and getdate(r.received_on) <= getdate(r.promised_on)
		tally.setdefault(r.supplier, []).append((lead, on_time))
	for supplier, rows in tally.items():
		acc = out.setdefault(supplier, {})
		acc["avg_lead_time_days"] = round(sum(days for days, _ok in rows) / len(rows), 1)
		acc["on_time_pct"] = round(100.0 * sum(1 for _days, ok in rows if ok) / len(rows), 1)
		acc["deliveries"] = len(rows)
	for acc in out.values():
		acc.setdefault("orders", 0)
		acc.setdefault("spend", 0.0)
		acc.setdefault("units", 0.0)
		acc.setdefault("receipts", 0)
		acc.setdefault("avg_lead_time_days", None)
		acc.setdefault("on_time_pct", None)
	return out


@frappe.whitelist()
def vendors(search: Optional[str] = None, active_only: Any = 1) -> dict[str, Any]:
	"""The vendor list with 12-month spend and on-time % (Vendors screen)."""
	assert_purchasing_admin()
	filters: dict[str, Any] = {}
	if cint(active_only):
		filters["disabled"] = 0
	names = frappe.get_all("Supplier", filters=filters, pluck="name", order_by="supplier_name asc", limit=2000)
	if cint(active_only):
		names = [n for n in names if cint(frappe.db.get_value("Supplier", n, "maison_active"))]
	needle = (search or "").strip().lower()
	docs = []
	for name in names:
		doc = frappe.get_cached_doc("Supplier", name)
		hay = f"{doc.name} {doc.supplier_name} {doc.get('maison_account_number') or ''} {doc.get('maison_rep_name') or ''}".lower()
		if needle and needle not in hay:
			continue
		docs.append(doc)
	since = add_months(nowdate(), -12)
	stats = vendor_performance(since, [d.name for d in docs]) if docs else {}
	rows = [vendor_dict(d, with_stats=True, stats=stats.get(d.name, {})) for d in docs]
	rows.sort(key=lambda r: -flt(r.get("spend")))
	return {"vendors": rows, "count": len(rows), "since": since}


@frappe.whitelist()
def vendor(name: str) -> dict[str, Any]:
	"""One vendor: profile, catalogue, open POs, last 10 receipts and 12-month spend."""
	assert_purchasing_admin()
	if not frappe.db.exists("Supplier", name):
		frappe.throw(_("Vendor {0} does not exist").format(name), frappe.DoesNotExistError)
	doc = frappe.get_doc("Supplier", name)
	since = add_months(nowdate(), -12)
	stats = vendor_performance(since, [name]).get(name, {})
	catalogue = [
		{
			# the `AWANZ Item Vendor` row name, so the Vendors screen can hand it straight to
			# `remove_item_vendor(item_code, row_name)` without an `item_vendors()` round trip
			"name": r.name,
			"item_code": r.parent,
			"item_name": frappe.db.get_value("Item", r.parent, "item_name"),
			"item_group": frappe.db.get_value("Item", r.parent, "item_group"),
			"vendor_sku": r.vendor_sku,
			"cost": flt(r.cost),
			"case_pack": cint(r.case_pack) or 1,
			"moq": cint(r.moq),
			"lead_time_days": cint(r.lead_time_days),
			"is_preferred": bool(cint(r.is_preferred)),
			"last_purchase_date": str(r.last_purchase_date) if r.last_purchase_date else None,
			"last_purchase_rate": flt(r.last_purchase_rate),
		}
		for r in frappe.get_all(
			"AWANZ Item Vendor",
			filters={"supplier": name, "parenttype": "Item"},
			fields=["name", "parent", "vendor_sku", "cost", "case_pack", "moq", "lead_time_days", "is_preferred", "last_purchase_date", "last_purchase_rate"],
			order_by="parent asc",
			limit=2000,
		)
	]
	open_names = frappe.get_all(
		"Purchase Order",
		filters={"supplier": name, "docstatus": ("<", 2), "status": ("not in", ("Closed", "Completed", "Cancelled"))},
		pluck="name",
		order_by="transaction_date desc",
		limit=50,
	)
	receipts = frappe.get_all(
		"Purchase Receipt",
		filters={"supplier": name, "docstatus": 1},
		fields=["name", "posting_date", "set_warehouse", "base_net_total", "grand_total", "total_qty"],
		order_by="posting_date desc, creation desc",
		limit=10,
	)
	return {
		"vendor": vendor_dict(doc, with_stats=True, stats=stats),
		"catalogue": catalogue,
		"open_orders": [receiving_lib.order_dict(frappe.get_doc("Purchase Order", n), with_items=False) for n in open_names],
		"receipts": [
			{
				"name": r.name,
				"posting_date": str(r.posting_date),
				"warehouse": r.set_warehouse,
				"net_total": flt(r.base_net_total),
				"grand_total": flt(r.grand_total),
				"units": flt(r.total_qty),
			}
			for r in receipts
		],
		"spend": {"since": since, **stats},
	}


@frappe.whitelist()
def save_vendor(payload: Any) -> dict[str, Any]:
	"""Create or update a vendor; the ``<Supplier> Buying`` price list follows automatically."""
	assert_purchasing_admin()
	data = _loads(payload, {}) or {}
	name = (data.get("name") or "").strip()
	supplier_name = (data.get("supplier_name") or name).strip()
	if not supplier_name:
		frappe.throw(_("A vendor needs a name"), frappe.ValidationError)
	if name and frappe.db.exists("Supplier", name):
		doc = frappe.get_doc("Supplier", name)
	else:
		doc = frappe.new_doc("Supplier")
		doc.supplier_name = supplier_name
		doc.supplier_group = data.get("supplier_group") or frappe.db.get_value("Supplier Group", {"is_group": 0}, "name") or "All Supplier Groups"
		doc.supplier_type = data.get("supplier_type") or "Company"
	doc.supplier_name = supplier_name
	if data.get("supplier_group"):
		doc.supplier_group = data["supplier_group"]
	mapping = {
		"lead_time_days": "maison_lead_time_days",
		"min_order_value": "maison_min_order_value",
		"dropship_capable": "maison_dropship_capable",
		"order_method": "maison_order_method",
		"portal_url": "maison_portal_url",
		"account_number": "maison_account_number",
		"rep_name": "maison_rep_name",
		"rep_phone": "maison_rep_phone",
		"rep_email": "maison_rep_email",
		"notes": "maison_notes",
		"active": "maison_active",
	}
	for key, field in mapping.items():
		if key in data:
			doc.set(field, data[key])
		elif field in data:
			doc.set(field, data[field])
	if doc.get("maison_active") in (None, ""):
		doc.maison_active = 1
	doc.disabled = 0 if cint(doc.get("maison_active")) else 1
	doc.flags.ignore_permissions = True
	doc.save()
	price_list = vendor_lib.ensure_price_list(doc.name)
	return {"vendor": vendor_dict(frappe.get_doc("Supplier", doc.name)), "price_list": price_list}


@frappe.whitelist()
def set_vendor_active(name: str, active: Any = 1) -> dict[str, Any]:
	"""Deactivate rather than delete: the vendor keeps its history and drops off the buying lists."""
	assert_purchasing_admin()
	if not frappe.db.exists("Supplier", name):
		frappe.throw(_("Vendor {0} does not exist").format(name), frappe.DoesNotExistError)
	active = 1 if cint(active) else 0
	doc = frappe.get_doc("Supplier", name)
	doc.maison_active = active
	doc.disabled = 0 if active else 1
	doc.flags.ignore_permissions = True
	doc.save()
	return {"vendor": vendor_dict(doc), "active": bool(active)}


# ===========================================================================
# §B — item ↔ vendor catalogue
# ===========================================================================
def _vendor_row_dict(row: dict[str, Any]) -> dict[str, Any]:
	return {
		"name": row.get("name"),
		"supplier": row.get("supplier"),
		"supplier_name": frappe.db.get_value("Supplier", row["supplier"], "supplier_name") if row.get("supplier") else None,
		"vendor_sku": row.get("vendor_sku"),
		"cost": flt(row.get("cost")),
		"case_pack": cint(row.get("case_pack")) or 1,
		"moq": cint(row.get("moq")),
		"lead_time_days": cint(row.get("lead_time_days")),
		"is_preferred": bool(cint(row.get("is_preferred"))),
		"last_purchase_date": str(row["last_purchase_date"]) if row.get("last_purchase_date") else None,
		"last_purchase_rate": flt(row.get("last_purchase_rate")),
		"notes": row.get("notes"),
	}


@frappe.whitelist()
def item_vendors(item_code: str) -> dict[str, Any]:
	assert_purchasing_admin()
	assert_item(item_code)
	rows = [_vendor_row_dict(r) for r in vendor_lib.item_vendor_rows(item_code)]
	return {
		"item_code": item_code,
		"item_name": frappe.db.get_value("Item", item_code, "item_name"),
		"vendors": rows,
		"preferred": next((r["supplier"] for r in rows if r["is_preferred"]), None),
	}


@frappe.whitelist()
def save_item_vendor(item_code: str, row: Any) -> dict[str, Any]:
	"""Add or edit one vendor row on an item; ``cost`` writes through to their price list."""
	assert_purchasing_admin()
	assert_item(item_code)
	vendor_lib.add_or_update_row(item_code, _loads(row, {}) or {})
	return item_vendors(item_code)


@frappe.whitelist()
def remove_item_vendor(item_code: str, row_name: str) -> dict[str, Any]:
	assert_purchasing_admin()
	assert_item(item_code)
	item = frappe.get_doc("Item", item_code)
	keep = [r for r in item.get("maison_vendors") or [] if r.name != row_name]
	if len(keep) == len(item.get("maison_vendors") or []):
		frappe.throw(_("Vendor row {0} is not on {1}").format(row_name, item_code), frappe.DoesNotExistError)
	item.set("maison_vendors", keep)
	item.flags.ignore_permissions = True
	item.save()
	return item_vendors(item_code)


@frappe.whitelist()
def set_preferred_vendor(item_code: str, supplier: str) -> dict[str, Any]:
	"""Exactly one preferred vendor per item — ticking a new one clears the rest."""
	assert_purchasing_admin()
	assert_item(item_code)
	item = frappe.get_doc("Item", item_code)
	if supplier not in {r.supplier for r in item.get("maison_vendors") or []}:
		frappe.throw(_("{0} is not a vendor of {1}").format(supplier, item_code), frappe.ValidationError)
	item._awanz_preferred_supplier = supplier
	for r in item.get("maison_vendors") or []:
		r.is_preferred = 1 if r.supplier == supplier else 0
	item.flags.ignore_permissions = True
	item.save()
	return item_vendors(item_code)


# ===========================================================================
# §C — what to buy
# ===========================================================================
@frappe.whitelist()
def suggestions(refresh: Any = 0) -> dict[str, Any]:
	"""The buying list. ``refresh=1`` recomputes and re-caches it; otherwise the last run is served."""
	assert_purchasing_admin()
	if cint(refresh):
		return run_suggestions()
	out = cached_suggestions()
	if not out["suggestions"]:
		return run_suggestions()
	return out


@frappe.whitelist()
def dismiss_suggestion(name: str, reason: Optional[str] = None) -> dict[str, Any]:
	assert_purchasing_admin()
	doc = frappe.get_doc("AWANZ Purchase Suggestion", name)
	doc.status = "Dismissed"
	doc.dismiss_reason = reason
	doc.flags.ignore_permissions = True
	doc.save()
	return {"name": doc.name, "status": doc.status, "item_code": doc.item_code}


@frappe.whitelist()
def create_orders(lines: Any) -> dict[str, Any]:
	"""Group the chosen suggestion lines by vendor into one **draft** Purchase Order each.

	``lines = [{item_code, qty, supplier, rate?, suggestion?, dropship_store?, freight?}]``
	"""
	assert_purchasing_admin()
	rows = _loads(lines, []) or []
	grouped: dict[tuple[str, Optional[str]], list[dict[str, Any]]] = {}
	for raw in rows:
		supplier = (raw.get("supplier") or "").strip()
		item_code = (raw.get("item_code") or raw.get("item") or "").strip()
		qty = flt(raw.get("qty", raw.get("suggested_qty")))
		if not supplier or not item_code or qty <= 0:
			continue
		grouped.setdefault((supplier, raw.get("dropship_store") or None), []).append(
			{"item_code": item_code, "qty": qty, "rate": raw.get("rate"), "suggestion": raw.get("suggestion") or raw.get("name")}
		)
	if not grouped:
		frappe.throw(_("Nothing to order"), frappe.ValidationError)
	created: list[dict[str, Any]] = []
	for (supplier, dropship_store), group in grouped.items():
		po = po_lib.create_order(supplier, group, dropship_store=dropship_store)
		for line in group:
			if line.get("suggestion") and frappe.db.exists("AWANZ Purchase Suggestion", line["suggestion"]):
				frappe.db.set_value(
					"AWANZ Purchase Suggestion",
					line["suggestion"],
					{"status": "Ordered", "purchase_order": po.name, "supplier": supplier, "suggested_qty": line["qty"]},
					update_modified=False,
				)
		created.append({"name": po.name, "supplier": supplier, "units": sum(row["qty"] for row in group), "dropship_store": dropship_store})
	return {"orders": [c["name"] for c in created], "created": created, "count": len(created)}


# ===========================================================================
# §D — purchase orders
# ===========================================================================
def _order_payload(po, with_extras: bool = True) -> dict[str, Any]:
	out = receiving_lib.order_dict(po)
	if not with_extras:
		return out
	out["supplier_profile"] = vendor_dict(frappe.get_cached_doc("Supplier", po.supplier))
	out["receipts"] = frappe.get_all(
		"Purchase Receipt Item",
		filters={"purchase_order": po.name, "docstatus": 1},
		fields=["parent as purchase_receipt", "item_code", "qty", "rejected_qty", "rate", "warehouse"],
		limit=500,
	)
	out["discrepancies"] = frappe.get_all(
		"AWANZ Receiving Discrepancy",
		filters={"purchase_order": po.name},
		fields=["name", "item_code", "type", "status", "short_qty", "over_qty", "damaged_qty", "boutique"],
		limit=200,
	)
	out["can_edit"] = po.docstatus == 0 and is_purchasing_admin()
	return out


@frappe.whitelist()
def orders(
	status: Optional[str] = None,
	supplier: Optional[str] = None,
	store: Optional[str] = None,
	from_date: Optional[str] = None,
	to_date: Optional[str] = None,
	limit: int = 200,
	**kwargs: Any,
) -> dict[str, Any]:
	"""Purchase orders, newest first. ``from`` / ``to`` filter on the order date.

	(``from`` is a Python keyword, so the HTTP parameter is read out of ``kwargs``; ``from_date``
	and ``to_date`` work too.)
	"""
	assert_purchasing_admin()
	from_date = from_date or kwargs.get("from")
	to_date = to_date or kwargs.get("to")
	filters: dict[str, Any] = {"docstatus": ("<", 2)}
	if status and status not in ("all", "any"):
		if status == "Draft":
			filters["docstatus"] = 0
		elif status == "Open":
			filters["status"] = ("in", ("To Receive and Bill", "To Receive", "To Bill"))
		else:
			filters["status"] = status
	if supplier:
		filters["supplier"] = supplier
	if store:
		filters["maison_dropship_store"] = store
	if from_date:
		filters["transaction_date"] = (">=", from_date)
	if to_date:
		filters["transaction_date"] = ("<=", to_date) if not from_date else ("between", [from_date, to_date])
	names = frappe.get_all("Purchase Order", filters=filters, pluck="name", order_by="transaction_date desc, creation desc", limit=cint(limit) or 200)
	rows = [receiving_lib.order_dict(frappe.get_doc("Purchase Order", n), with_items=False) for n in names]
	return {"orders": rows, "count": len(rows)}


@frappe.whitelist()
def order(name: str) -> dict[str, Any]:
	"""One order in full. A store manager may read an order addressed to their own store."""
	assert_purchase_order_read(name)
	return _order_payload(frappe.get_doc("Purchase Order", name))


@frappe.whitelist()
def create_order(
	supplier: str,
	lines: Any,
	dropship_store: Optional[str] = None,
	freight: Any = 0,
	source_request: Optional[str] = None,
) -> dict[str, Any]:
	"""Draft order. Line rates default from the vendor's price list and stay editable."""
	assert_purchasing_admin()
	po = po_lib.create_order(
		supplier,
		_loads(lines, []) or [],
		dropship_store=dropship_store,
		freight=flt(freight),
		source_request=source_request,
	)
	return _order_payload(po)


@frappe.whitelist()
def update_order(name: str, lines: Any = None, freight: Any = None, dropship_store: Any = po_lib.UNSET) -> dict[str, Any]:
	"""Edit a draft: quantities, **every rate**, the freight, and where the order ships.

	``dropship_store`` omitted leaves the destination alone; ``null`` / ``""`` clears the drop-ship
	and puts the order back on the main Houston warehouse. Draft only — the destination of a
	submitted order is on paperwork the vendor already has.
	"""
	assert_purchasing_admin()
	po = po_lib.update_order(name, _loads(lines, None), freight, dropship_store=dropship_store)
	return _order_payload(po)


@frappe.whitelist()
def submit_order(name: str) -> dict[str, Any]:
	assert_purchasing_admin()
	return _order_payload(po_lib.submit_order(name))


@frappe.whitelist()
def send_order(name: Optional[str] = None, method: str = "Email", recipient: Optional[str] = None, po: Optional[str] = None) -> dict[str, Any]:
	"""E-mail the ``AWANZ Purchase Order`` PDF to the rep, or record a phone / portal order.

	SPEC_v1.0 spells this ``send_order(po, method)`` in §D's prose and ``send_order(name, method)``
	in its API list, so both spellings of the first argument are accepted.
	"""
	assert_purchasing_admin()
	name = name or po
	if not name:
		frappe.throw(_("Which purchase order?"), frappe.ValidationError)
	out = po_lib.send_order(name, method, recipient)
	out["order"] = _order_payload(frappe.get_doc("Purchase Order", name), with_extras=False)
	return out


@frappe.whitelist()
def close_order(name: str, reason: Optional[str] = None) -> dict[str, Any]:
	assert_purchasing_admin()
	return _order_payload(po_lib.close_order(name, reason))


@frappe.whitelist()
def delete_order(name: str, reason: Optional[str] = None) -> dict[str, Any]:
	"""Delete a **draft** order — the terminal action a draft has, since Close needs a submitted one.

	Its buying suggestions go back to *Open* with the order cleared off them, so the items return
	to the buying list. A submitted order is refused: close it instead.
	"""
	assert_purchasing_admin()
	return po_lib.delete_order(name, reason)


# ===========================================================================
# §E — receiving at the warehouse (the store side is inventory.receive_po)
# ===========================================================================
@frappe.whitelist()
def inbound(warehouse: Optional[str] = None) -> dict[str, Any]:
	"""The /warehouse **Inbound** area: expected vendor orders + open vendor discrepancies."""
	assert_purchasing_admin()
	warehouse = warehouse or main_warehouse()
	expected = receiving_lib.expected_orders(warehouse)
	discrepancies = frappe.get_all(
		"AWANZ Receiving Discrepancy",
		filters={"status": "Open", "supplier": ("is", "set")},
		fields=["name", "supplier", "purchase_order", "boutique", "item_code", "item_name", "type", "short_qty", "over_qty", "damaged_qty", "reported_at"],
		order_by="reported_at desc",
		limit=100,
	)
	return {
		"warehouse": warehouse,
		"purchase_orders": expected,
		"expected": expected,
		"units": sum(flt(p.get("units")) for p in expected),
		"discrepancies": discrepancies,
		"as_of": now_datetime().isoformat(),
	}


@frappe.whitelist()
def receive(po: str, lines: Any, freight: Any = None, final: Any = 0, notes: Optional[str] = None) -> dict[str, Any]:
	"""Receive a vendor order at the main warehouse — scan / count, with an editable unit cost.

	Same code path as the store's drop-ship Receive (``maison_pos.api.inventory.receive_po``).
	"""
	assert_purchasing_admin()
	return receiving_lib.receive_purchase_order(
		po, lines, warehouse=main_warehouse(), freight=freight, final=final, notes=notes
	)


# ===========================================================================
# store selling price — the EXISTING AWANZ Price Change Request workflow
#
# v1.0 adds no second mechanism for store pricing. These three endpoints simply expose the
# doctype + `AWANZ Price Approval` workflow that has existed since v0.2 so the new screens can
# raise and approve a store override without going to the desk.
# ===========================================================================
@frappe.whitelist()
def price_change_requests(boutique: Optional[str] = None, status: Optional[str] = "Pending Approval", item_code: Optional[str] = None, limit: int = 100) -> dict[str, Any]:
	"""List price change requests (store users: their own store only — ``scoping.py`` enforces)."""
	from maison_pos.scoping import ALL_AWANZ_ROLES, assert_roles, is_unrestricted

	assert_roles(*ALL_AWANZ_ROLES, "System Manager", "AWANZ Warehouse Admin")
	filters: dict[str, Any] = {}
	if boutique or not (is_unrestricted() or is_purchasing_admin()):
		filters["boutique"] = assert_boutique_access(boutique)
	if status and status not in ("all", "any"):
		filters["workflow_state"] = status
	if item_code:
		filters["item_code"] = item_code
	rows = frappe.get_all(
		"AWANZ Price Change Request",
		filters=filters,
		fields=["name", "boutique", "item_code", "item_name", "current_rate", "proposed_rate", "reason", "workflow_state", "docstatus", "requested_by", "valid_from", "valid_upto", "pricing_rule", "approved_by", "approved_on"],
		order_by="modified desc",
		limit=cint(limit) or 100,
	)
	return {"requests": rows, "count": len(rows)}


@frappe.whitelist()
def request_price_change(
	item_code: str,
	boutique: str,
	proposed_rate: float,
	reason: Optional[str] = None,
	valid_from: Optional[str] = None,
	valid_upto: Optional[str] = None,
) -> dict[str, Any]:
	"""Raise the **existing** ``AWANZ Price Change Request`` (submitted → *Pending Approval*)."""
	from maison_pos.scoping import ALL_AWANZ_ROLES, assert_roles

	assert_roles(*ALL_AWANZ_ROLES, "System Manager", "AWANZ Warehouse Admin")
	assert_item(item_code)
	boutique = assert_boutique_access(boutique) if not is_purchasing_admin() else boutique
	doc = frappe.get_doc(
		{
			"doctype": "AWANZ Price Change Request",
			"boutique": boutique,
			"item_code": item_code,
			"proposed_rate": flt(proposed_rate),
			"reason": reason,
			"valid_from": valid_from or nowdate(),
			"valid_upto": valid_upto,
			"requested_by": frappe.session.user,
		}
	)
	doc.insert()
	doc.submit()
	return {"name": doc.name, "workflow_state": doc.workflow_state, "boutique": doc.boutique, "item_code": doc.item_code, "proposed_rate": flt(doc.proposed_rate)}


@frappe.whitelist()
def approve_price_change(name: str, action: str = "Approve", reason: Optional[str] = None) -> dict[str, Any]:
	"""Drive the existing ``AWANZ Price Approval`` workflow (Approve / Reject)."""
	from frappe.model.workflow import apply_workflow

	doc = frappe.get_doc("AWANZ Price Change Request", name)
	if action not in ("Approve", "Reject"):
		frappe.throw(_("Unknown action {0}").format(action), frappe.ValidationError)
	if reason:
		doc.db_set("reason", ((doc.reason or "") + "\n" + reason).strip(), update_modified=False)
		doc.reload()
	apply_workflow(doc, action)
	doc.reload()
	return {"name": doc.name, "workflow_state": doc.workflow_state, "pricing_rule": doc.pricing_rule}


# ---------------------------------------------------------------------------
# warehouse stock (the /warehouse **Stock** tab) — value at moving average
# ---------------------------------------------------------------------------
@frappe.whitelist()
def stock(q: Optional[str] = None, limit: int = 500) -> dict[str, Any]:
	"""HOU-WH on hand: qty, value at moving average, cover days, on order, reorder level."""
	assert_purchasing_admin()
	warehouse = main_warehouse()
	bins = frappe.get_all(
		"Bin",
		filters={"warehouse": warehouse},
		fields=["item_code", "actual_qty", "reserved_qty", "projected_qty", "valuation_rate", "stock_value"],
		limit=100000,
	)
	codes = [b.item_code for b in bins]
	items = {
		r.name: r
		for r in frappe.get_all(
			"Item",
			filters={"name": ("in", codes or ["__none__"])},
			fields=["name", "item_name", "item_group", "maison_barcode", "image", "valuation_method"],
		)
	}
	levels = {
		r.parent: flt(r.warehouse_reorder_level)
		for r in frappe.get_all(
			"Item Reorder", filters={"parent": ("in", codes or ["__none__"]), "warehouse": warehouse}, fields=["parent", "warehouse_reorder_level"]
		)
	}
	from maison_pos.purchasing.demand import on_order_qty

	on_order = on_order_qty(warehouse)
	velocity = _chain_velocity(codes)
	needle = (q or "").strip().lower()
	rows = []
	for b in bins:
		it = items.get(b.item_code)
		if not it:
			continue
		if needle and needle not in f"{b.item_code} {it.item_name} {it.item_group} {it.maison_barcode or ''}".lower():
			continue
		v = flt(velocity.get(b.item_code))
		level = levels.get(b.item_code, 0.0)
		rows.append(
			{
				"item_code": b.item_code,
				"item_name": it.item_name,
				"item_group": it.item_group,
				"barcode": it.maison_barcode,
				"image": it.image,
				"actual_qty": flt(b.actual_qty),
				"reserved_qty": flt(b.reserved_qty),
				"projected_qty": flt(b.projected_qty),
				"valuation_rate": flt(b.valuation_rate),
				"stock_value": flt(b.stock_value),
				"valuation_method": it.valuation_method or "Moving Average",
				"reorder_level": level,
				"on_order": flt(on_order.get(b.item_code)),
				"velocity": round(v, 3),
				"cover_days": round(flt(b.actual_qty) / v, 1) if v else None,
				"low": bool(level) and flt(b.actual_qty) <= level,
			}
		)
	rows.sort(key=lambda r: (not r["low"], r["item_group"] or "", r["item_code"]))
	return {
		"warehouse": warehouse,
		"rows": rows[: cint(limit) or 500],
		"total": len(rows),
		"low": sum(1 for r in rows if r["low"]),
		"stock_value": round(sum(r["stock_value"] for r in rows), 2),
	}


def _chain_velocity(codes: list[str]) -> dict[str, float]:
	"""Chain-wide units/day from the precomputed 28-day trend rows (0 when trends never ran)."""
	if not codes:
		return {}
	try:
		rows = frappe.get_all(
			"AWANZ Product Trend",
			filters={"boutique": "ALL", "period": "28d", "item_code": ("in", codes)},
			fields=["item_code", "velocity"],
			limit=10000,
		)
	except Exception:  # pragma: no cover
		return {}
	return {r.item_code: flt(r.velocity) for r in rows}
