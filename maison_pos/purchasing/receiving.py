"""Receiving a vendor order (SPEC_v1.0 §E) — **one** Purchase Receipt path.

The warehouse Inbound screen and the store Receive screen both land here:

* ``maison_pos.api.shipping.receive_vendor_po`` — HOU-WH receives from a vendor;
* ``maison_pos.api.inventory.receive_po`` — a store receives a **drop-ship** order.

The store path is the one that already existed in v0.6, and drop-ship deliberately reuses it
rather than growing a second receiving flow. What v1.0 adds, for both: an editable unit cost per
line (the manual override, defaulting to the PO rate), an optional freight adjustment at receipt,
damaged units into the Damaged warehouse, ``AWANZ Receiving Discrepancy`` rows raised **against
the vendor**, and ``last_purchase_date`` / ``last_purchase_rate`` stamped on the item-vendor row.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime, nowdate

from maison_pos.purchasing import damaged_warehouse_for, store_for_warehouse
from maison_pos.purchasing.orders import freight_of, sync_freight_row
from maison_pos.purchasing.vendors import stamp_last_purchase


def _loads(value: Any, default: Any) -> Any:
	if value in (None, ""):
		return default
	if isinstance(value, str):
		try:
			return json.loads(value)
		except ValueError:
			return default
	return value


def before_validate(doc, method: Optional[str] = None) -> None:
	"""``Purchase Receipt.before_validate`` — keep the maintained freight row in step."""
	sync_freight_row(doc)


def on_submit(doc, method: Optional[str] = None) -> None:
	"""``Purchase Receipt.on_submit`` — stamp the item-vendor rows with what we actually paid."""
	if not doc.supplier:
		return
	for row in doc.get("items") or []:
		try:
			stamp_last_purchase(row.item_code, doc.supplier, flt(row.rate), doc.posting_date)
		except Exception:  # pragma: no cover — never block a receipt on a catalogue stamp
			frappe.log_error(frappe.get_traceback(), f"awanz last purchase {row.item_code}")


def over_receipt_allowance(item_code: str) -> float:
	allowance = flt(frappe.get_cached_value("Item", item_code, "over_delivery_receipt_allowance"))
	if not allowance:
		allowance = flt(frappe.db.get_single_value("Stock Settings", "over_delivery_receipt_allowance"))
	return allowance


def postable_qty(ordered: float, already: float, wanted: float, allowance: float) -> float:
	"""How much of *wanted* ERPNext will let us book against the order line.

	ERPNext refuses a receipt that takes the line past ``qty × (1 + allowance %)``
	(``erpnext.controllers.status_updater.validate_qty``). Anything above that is still real —
	it is recorded as an *Over* discrepancy for the warehouse admin to settle with the vendor —
	but it is not silently forced into stock.
	"""
	ceiling = flt(ordered) * (1.0 + flt(allowance) / 100.0)
	return max(0.0, min(flt(wanted), ceiling - flt(already)))


def receive_purchase_order(
	po_name: str,
	lines: Any,
	warehouse: Optional[str] = None,
	freight: Any = None,
	final: Any = 0,
	notes: Optional[str] = None,
	boutique: Optional[str] = None,
	posting_date: Optional[str] = None,
) -> dict[str, Any]:
	"""Post a Purchase Receipt against *po_name*.

	``lines = [{item_code | name, qty | received_qty, damaged_qty?, rate?}]``

	* ``rate`` is the **manual unit-cost override**; omitted, the PO rate stands.
	* ``damaged_qty`` is booked into the receiving store's Damaged warehouse (PR *rejected* qty).
	* ``final = 1`` says "this is the whole delivery", which turns anything still outstanding on
	  the ordered lines into a *Short* discrepancy. Vendor orders arrive in parts, so the default
	  is a partial receipt that raises nothing.
	* ``freight`` (optional) replaces the freight carried over from the order on this receipt.
	* ``posting_date`` back-dates the receipt (seeding only; the screens never pass it).
	"""
	from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_receipt

	po = frappe.get_doc("Purchase Order", po_name)
	if po.docstatus != 1:
		frappe.throw(_("Purchase Order {0} is not submitted").format(po_name), frappe.ValidationError)
	wanted: dict[str, dict[str, Any]] = {}
	for raw in _loads(lines, []) or []:
		key = raw.get("name") or raw.get("item_code") or raw.get("item")
		if not key:
			continue
		wanted[key] = {
			"received": flt(raw.get("qty", raw.get("received_qty"))),
			"damaged": flt(raw.get("damaged_qty")),
			"rate": raw.get("rate"),
		}
	if not wanted and not cint(final):
		frappe.throw(_("Nothing to receive"), frappe.ValidationError)
	warehouse = warehouse or po.set_warehouse
	damaged_warehouse = damaged_warehouse_for(warehouse)
	boutique = boutique or store_for_warehouse(warehouse)
	user = frappe.session.user
	plan: list[dict[str, Any]] = []
	for row in po.items:
		ask = wanted.get(row.name, wanted.get(row.item_code))
		pending = max(0.0, flt(row.qty) - flt(row.received_qty))
		if ask is None:
			if not cint(final) or pending <= 0:
				continue
			ask = {"received": 0.0, "damaged": 0.0, "rate": None}
		received = flt(ask["received"])
		damaged = min(flt(ask["damaged"]), received)
		if received < 0 or damaged < 0:
			frappe.throw(_("Negative quantity for {0}").format(row.item_code), frappe.ValidationError)
		allowance = over_receipt_allowance(row.item_code)
		postable = postable_qty(flt(row.qty), flt(row.received_qty), received, allowance)
		over = max(0.0, received - postable)
		short = max(0.0, pending - received) if cint(final) else 0.0
		post_damaged = min(damaged, postable) if damaged_warehouse else 0.0
		plan.append(
			{
				"po_item": row.name,
				"item_code": row.item_code,
				"item_name": row.item_name,
				"ordered_qty": flt(row.qty),
				"pending_qty": pending,
				"received_qty": received,
				"posted_qty": postable,
				"accepted_qty": max(0.0, postable - post_damaged),
				"damaged_qty": damaged,
				"posted_damaged_qty": post_damaged,
				"short_qty": short,
				"over_qty": over,
				"rate": flt(ask["rate"]) if ask["rate"] not in (None, "") else flt(row.rate),
				"po_rate": flt(row.rate),
			}
		)
	if not plan:
		frappe.throw(_("No matching Purchase Order lines"), frappe.ValidationError)
	postable_lines = [p for p in plan if p["posted_qty"] > 0]
	pr = None
	if postable_lines:
		frappe.set_user("Administrator")
		try:
			pr = make_purchase_receipt(po_name)
			keep = []
			by_key = {p["po_item"]: p for p in postable_lines}
			for row in pr.items:
				p = by_key.get(row.purchase_order_item) or next(
					(x for x in postable_lines if x["item_code"] == row.item_code and x["po_item"] not in by_key), None
				)
				if not p:
					continue
				row.received_qty = p["posted_qty"]
				row.qty = p["accepted_qty"]
				row.rejected_qty = p["posted_damaged_qty"]
				if p["posted_damaged_qty"] > 0:
					row.rejected_warehouse = damaged_warehouse
				row.rate = p["rate"]
				row.price_list_rate = p["rate"]
				row.discount_percentage = 0
				row.discount_amount = 0
				row.margin_rate_or_amount = 0
				row.stock_qty = row.qty * flt(row.conversion_factor or 1)
				if warehouse:
					row.warehouse = warehouse
				keep.append(row)
			if not keep:
				frappe.throw(_("No matching Purchase Order lines"), frappe.ValidationError)
			pr.items = keep
			for i, row in enumerate(pr.items, start=1):
				row.idx = i
			if warehouse:
				pr.set_warehouse = warehouse
			if freight not in (None, ""):
				pr.maison_freight_amount = flt(freight)
			if posting_date:
				pr.posting_date = posting_date
				pr.set_posting_time = 1
			pr.owner = user
			pr.flags.ignore_permissions = True
			pr.insert()
			pr.submit()
		finally:
			frappe.set_user(user)
	discrepancies = _raise_discrepancies(po, plan, boutique, pr.name if pr else None, notes)
	if pr:
		_notify_discrepancies(po, discrepancies, boutique)
	closed = _close_if_final(po_name, final)
	return {
		"purchase_receipt": pr.name if pr else None,
		"purchase_order": po_name,
		"supplier": po.supplier,
		"warehouse": warehouse,
		"boutique": boutique,
		"freight": freight_of(pr) if pr else flt(po.get("maison_freight_amount")),
		"final": bool(cint(final)),
		"closed": closed,
		"lines": [
			{
				"item_code": p["item_code"],
				"item_name": p["item_name"],
				"received_qty": p["received_qty"],
				"posted_qty": p["posted_qty"],
				"accepted_qty": p["accepted_qty"],
				"damaged_qty": p["damaged_qty"],
				"short_qty": p["short_qty"],
				"over_qty": p["over_qty"],
				"rate": p["rate"],
				"po_rate": p["po_rate"],
				"warehouse": warehouse,
			}
			for p in plan
		],
		"discrepancies": discrepancies,
	}


def _close_if_final(po_name: str, final: Any) -> bool:
	"""``final=1`` means "that was the whole delivery" — so the order stops expecting more.

	Without this the shorts were raised against the vendor *and* the order stayed *To Receive*, so
	it sat on the Inbound expected list forever with units that had already been settled with the
	vendor. Both the receive sheet's toggle copy and ``receiveOutcome`` promise the order closes;
	this is what makes that true.

	A **fully received** order is closed here too. ERPNext only reaches *Completed* when an order
	is fully received *and* fully billed (``status_updater``: ``per_received >= 100`` and
	``per_billed == 100``), and v1.0 deliberately leaves purchase invoices in the client's
	accounting package — so ``per_billed`` never moves and the order would otherwise rest at
	*To Bill* on the Inbound list for ever. Only an order already *Closed* / *Completed* /
	*Cancelled* is left alone.
	"""
	if not cint(final):
		return False
	po = frappe.get_doc("Purchase Order", po_name)
	if po.docstatus != 1 or po.status in ("Closed", "Completed", "Cancelled"):
		return False
	user = frappe.session.user
	frappe.set_user("Administrator")
	try:
		po.update_status("Closed")
		return True
	except Exception:  # pragma: no cover — a receipt must never fail because closing did
		frappe.log_error(frappe.get_traceback(), f"awanz close purchase order {po_name}")
		return False
	finally:
		frappe.set_user(user)


def _raise_discrepancies(po, plan: list[dict[str, Any]], boutique: Optional[str], receipt: Optional[str], notes: Optional[str]) -> list[str]:
	"""One ``AWANZ Receiving Discrepancy`` per short / over / damaged line, against the vendor."""
	out: list[str] = []
	for p in plan:
		for kind, qty in (("Short", p["short_qty"]), ("Damaged", p["damaged_qty"]), ("Over", p["over_qty"])):
			if flt(qty) <= 0:
				continue
			if frappe.db.exists(
				"AWANZ Receiving Discrepancy",
				{"purchase_order": po.name, "item_code": p["item_code"], "type": kind, "status": "Open"},
			):
				continue
			doc = frappe.get_doc(
				{
					"doctype": "AWANZ Receiving Discrepancy",
					"boutique": boutique,
					"supplier": po.supplier,
					"purchase_order": po.name,
					"purchase_receipt": receipt,
					"item_code": p["item_code"],
					"type": kind,
					"status": "Open",
					"shipped_qty": p["ordered_qty"],
					"received_qty": p["received_qty"],
					"damaged_qty": p["damaged_qty"],
					"short_qty": p["short_qty"],
					"over_qty": p["over_qty"],
					"reported_by": frappe.session.user,
					"reported_at": now_datetime(),
					"notes": notes,
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert()
			out.append(doc.name)
	return out


def _notify_discrepancies(po, discrepancies: list[str], boutique: Optional[str]) -> None:
	if not discrepancies:
		return
	subject = _("{0}: {1} receiving discrepancy(ies) on {2}").format(
		po.supplier, len(discrepancies), po.name
	)
	for admin in frappe.get_all("Has Role", filters={"role": "AWANZ Warehouse Admin", "parenttype": "User"}, pluck="parent"):
		try:
			frappe.get_doc(
				{
					"doctype": "Notification Log",
					"for_user": admin,
					"type": "Alert",
					"document_type": "AWANZ Receiving Discrepancy",
					"document_name": discrepancies[0],
					"subject": subject,
				}
			).insert(ignore_permissions=True)
		except Exception:  # pragma: no cover
			pass


# ---------------------------------------------------------------------------
# what is on its way in (the /warehouse Inbound area)
# ---------------------------------------------------------------------------
def expected_orders(warehouse: str, limit: int = 200) -> list[dict[str, Any]]:
	"""Submitted, not fully received vendor orders addressed to *warehouse*, with their ETA."""
	names = frappe.get_all(
		"Purchase Order",
		filters={
			"docstatus": 1,
			"set_warehouse": warehouse,
			"per_received": ("<", 100),
			"status": ("not in", ("Closed", "Completed", "Cancelled")),
		},
		pluck="name",
		order_by="schedule_date asc",
		limit=cint(limit) or 200,
	)
	return [order_dict(frappe.get_doc("Purchase Order", n)) for n in names]


def order_dict(po, with_items: bool = True) -> dict[str, Any]:
	"""Serialisation shared by the Inbound screen, the Buying screens and the store Receive."""
	out: dict[str, Any] = {
		"name": po.name,
		"supplier": po.supplier,
		"supplier_name": po.supplier_name,
		"status": po.status,
		"docstatus": po.docstatus,
		"transaction_date": str(po.transaction_date) if po.transaction_date else None,
		"schedule_date": str(po.schedule_date) if po.schedule_date else None,
		"set_warehouse": po.set_warehouse,
		"per_received": flt(po.per_received),
		"currency": po.currency,
		"net_total": flt(po.net_total or po.total),
		"grand_total": flt(po.grand_total),
		"freight": flt(po.get("maison_freight_amount")),
		"dropship_store": po.get("maison_dropship_store"),
		"source_request": po.get("maison_source_request"),
		"sent_on": str(po.get("maison_sent_on")) if po.get("maison_sent_on") else None,
		"sent_by": po.get("maison_sent_by"),
		"sent_method": po.get("maison_sent_method"),
	}
	out["landed_total"] = out["net_total"] + out["freight"]
	# `units` is on **every** row, list or detail: the order list prints a units column, and it
	# would be wasteful to build the whole line serialisation just to count them. The child rows
	# come with the document, so this costs nothing beyond the addition.
	out["units"] = sum(flt(r.qty) for r in po.get("items") or [])
	if with_items:
		out["items"] = [
			{
				"name": r.name,
				"item_code": r.item_code,
				"item_name": r.item_name,
				"qty": flt(r.qty),
				"rate": flt(r.rate),
				"amount": flt(r.amount),
				"received_qty": flt(r.received_qty),
				"pending_qty": max(0.0, flt(r.qty) - flt(r.received_qty)),
				"warehouse": r.warehouse,
				"uom": r.uom,
				"schedule_date": str(r.schedule_date) if r.schedule_date else None,
				"barcode": frappe.db.get_value("Item", r.item_code, "maison_barcode") or r.item_code,
			}
			for r in po.items
		]
	return out


def eta_for(po: dict[str, Any]) -> Optional[str]:
	return po.get("schedule_date") or nowdate()
