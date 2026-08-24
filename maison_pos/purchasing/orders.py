"""Purchase Orders (SPEC_v1.0 §D) — native ERPNext ``Purchase Order`` plus three behaviours.

**Freight** (``maison_freight_amount``) maintains exactly one row in ``taxes``:
``charge_type = Actual``, ``category = Valuation``, ``add_deduct_tax = Add``, posted to the
company's freight/valuation account. That is what puts freight into moving-average cost without
a Landed Cost Voucher. Setting the amount to 0 removes the row again. ERPNext distributes an
*Actual* valuation charge across the lines **in proportion to net amount**
(``erpnext.controllers.taxes_and_totals.get_current_tax_amount``), which is the
"distributed on Amount" the contract asks for — ``distribute_charges_based_on`` itself is a
Landed Cost Voucher field and does not exist on ``Purchase Taxes and Charges``.

**Drop-ship** (``maison_dropship_store``) points the header and every line at that store's
warehouse; the store's existing Receive screen then lists the PO and posts the Purchase Receipt
(``maison_pos.api.inventory.receive_po``). Submitting is refused unless every line really does
point at that one enabled store's warehouse. The destination is chosen on ``create_order`` and
changed — or cleared back to Houston — on a **draft** with ``update_order(dropship_store=…)``;
both go through :func:`destination_warehouse` so they cannot drift apart.

**Send** stamps ``maison_sent_on`` / ``maison_sent_by`` / ``maison_sent_method`` and, for
*Email*, mails the ``AWANZ Purchase Order`` PDF to the vendor's rep.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, get_url_to_form, now_datetime, nowdate

from maison_pos.purchasing import (
	FREIGHT_DESCRIPTION,
	ORDER_METHODS,
	freight_account,
	main_warehouse,
)
from maison_pos.purchasing.vendors import price_list_name, vendor_rate

OPEN_PO_STATUSES = ("Draft", "To Receive and Bill", "To Receive", "To Bill")

#: "the caller did not mention this argument". Distinct from ``None`` / ``""``, which on
#: :func:`update_order`'s ``dropship_store`` mean *clear the drop-ship and ship to Houston*.
UNSET = object()


# ---------------------------------------------------------------------------
# freight
# ---------------------------------------------------------------------------
def sync_freight_row(doc) -> Optional[Any]:
	"""Keep ``taxes`` holding exactly one freight row worth ``maison_freight_amount``.

	Runs from ``before_validate`` so ERPNext's own ``calculate_taxes_and_totals`` (which runs
	inside ``validate``) sees the row and distributes it over the lines.
	"""
	if not doc.meta.has_field("maison_freight_amount"):
		return None
	amount = flt(doc.get("maison_freight_amount"))
	rows = list(doc.get("taxes") or [])
	ours = [r for r in rows if (r.get("description") or "").strip() == FREIGHT_DESCRIPTION]
	if amount <= 0:
		if ours:
			doc.set("taxes", [r for r in rows if r not in ours])
			_reindex(doc)
		return None
	account = freight_account(doc.company)
	if not account:
		frappe.throw(
			_("No freight / valuation account found for {0} — set 'Expenses Included In Valuation' on the company").format(doc.company),
			frappe.ValidationError,
		)
	row = ours[0] if ours else doc.append("taxes", {})
	if len(ours) > 1:  # a duplicate crept in (hand-edited in the desk): keep the first
		doc.set("taxes", [r for r in doc.get("taxes") if r is row or r not in ours])
		_reindex(doc)
	row.update(
		{
			"charge_type": "Actual",
			"category": "Valuation",
			"add_deduct_tax": "Add",
			"account_head": account,
			"description": FREIGHT_DESCRIPTION,
			"tax_amount": amount,
			"rate": 0,
			"row_id": None,
			"included_in_print_rate": 0,
		}
	)
	row.cost_center = row.get("cost_center") or frappe.get_cached_value("Company", doc.company, "cost_center")
	# ERPNext's Landed Cost Voucher is the only place this field exists; set it when a site has
	# added it as a custom field so the intent is visible on the document too.
	try:
		if frappe.get_meta(row.doctype).has_field("distribute_charges_based_on"):
			row.distribute_charges_based_on = "Amount"
	except Exception:  # pragma: no cover
		pass
	return row


def _reindex(doc) -> None:
	for i, row in enumerate(doc.get("taxes") or [], start=1):
		row.idx = i


def freight_of(doc) -> float:
	"""The freight actually sitting on *doc* (Purchase Order or Purchase Receipt)."""
	for row in doc.get("taxes") or []:
		if (row.get("description") or "").strip() == FREIGHT_DESCRIPTION:
			return flt(row.tax_amount)
	return flt(doc.get("maison_freight_amount"))


def set_freight(doc, amount: float) -> None:
	doc.maison_freight_amount = flt(amount)
	sync_freight_row(doc)


# ---------------------------------------------------------------------------
# drop-ship
# ---------------------------------------------------------------------------
def dropship_warehouse(store: str) -> str:
	row = frappe.db.get_value("AWANZ Store", store, ["warehouse", "enabled"], as_dict=True)
	if not row:
		frappe.throw(_("Store {0} does not exist").format(store), frappe.DoesNotExistError)
	if not cint(row.enabled):
		frappe.throw(_("Store {0} is disabled — it cannot receive a drop-ship order").format(store), frappe.ValidationError)
	if not row.warehouse:
		frappe.throw(_("Store {0} has no warehouse").format(store), frappe.ValidationError)
	return row.warehouse


def destination_warehouse(dropship_store: Optional[str] = None, company: Optional[str] = None) -> str:
	"""Where an order ships: the store's warehouse for a drop-ship, else main Houston.

	The one place that decision is made — :func:`create_order` and :func:`set_dropship_store` both
	go through it, so "drop-ship" means exactly the same thing whether the destination is chosen
	when the order is raised or changed afterwards on the Buying screen.
	"""
	return dropship_warehouse(dropship_store) if dropship_store else main_warehouse(company)


def set_dropship_store(doc, store: Optional[str]) -> Optional[str]:
	"""Point a **draft** order at *store*'s warehouse — or, with ``None`` / ``""``, back at Houston.

	Same rules as :func:`create_order`: the store must exist and be enabled, and the header
	``set_warehouse`` *and* every line's ``warehouse`` follow it. Clearing the stamp also has to
	move the warehouses back, or :func:`normalise_dropship` would simply re-stamp the order on the
	next save because it still ships to a store.

	Refused on a submitted order: the destination is on a document the vendor has already been
	sent, and ERPNext has booked the ordered quantity against that warehouse.
	"""
	if doc.docstatus != 0:
		frappe.throw(
			_("Purchase Order {0} is submitted — its drop-ship destination can no longer be changed. Close it and raise a new order.").format(doc.name),
			frappe.ValidationError,
		)
	store = (store or "").strip() or None
	warehouse = destination_warehouse(store, doc.get("company"))
	doc.maison_dropship_store = store
	doc.set_warehouse = warehouse
	for row in doc.get("items") or []:
		row.warehouse = warehouse
	return store


def normalise_dropship(doc) -> None:
	"""``before_validate``: a drop-ship PO points header + every line at the store's warehouse.

	Also works the other way round: a PO whose ``set_warehouse`` *is* a store warehouse (raised in
	the desk by hand) is stamped with that store, so the store's Receive screen lists it.
	"""
	if not doc.meta.has_field("maison_dropship_store"):
		return
	store = doc.get("maison_dropship_store")
	if store:
		warehouse = dropship_warehouse(store)
		doc.set_warehouse = warehouse
		for row in doc.get("items") or []:
			row.warehouse = warehouse
		return
	warehouse = doc.get("set_warehouse")
	if not warehouse:
		warehouses = {r.warehouse for r in doc.get("items") or [] if r.warehouse}
		warehouse = warehouses.pop() if len(warehouses) == 1 else None
	if not warehouse or warehouse == main_warehouse(doc.company):
		return
	store = frappe.db.get_value("AWANZ Store", {"warehouse": warehouse, "enabled": 1}, "name")
	if store and store not in _warehouse_rows():
		doc.maison_dropship_store = store


def _warehouse_rows() -> set:
	"""The ``AWANZ Store`` rows that are warehouses, not shops (feature-detected, v0.6 D4)."""
	from maison_pos.scoping import warehouse_boutiques

	try:
		return warehouse_boutiques()
	except Exception:  # pragma: no cover
		return set()


def validate_dropship(doc) -> None:
	"""``before_submit``: every line of a drop-ship PO points at one enabled store's warehouse."""
	if not doc.meta.has_field("maison_dropship_store"):
		return
	store = doc.get("maison_dropship_store")
	if not store:
		return
	warehouse = dropship_warehouse(store)
	if doc.get("set_warehouse") and doc.set_warehouse != warehouse:
		frappe.throw(
			_("Drop-ship order for {0} must ship to {1}, not {2}").format(store, warehouse, doc.set_warehouse),
			frappe.ValidationError,
		)
	wrong = sorted({row.warehouse for row in doc.get("items") or [] if row.warehouse != warehouse})
	if wrong:
		frappe.throw(
			_("Every line of a drop-ship order for {0} must ship to {1}; found {2}").format(store, warehouse, ", ".join(wrong)),
			frappe.ValidationError,
		)


# ---------------------------------------------------------------------------
# doc events
# ---------------------------------------------------------------------------
def before_validate(doc, method: Optional[str] = None) -> None:
	for row in doc.get("items") or []:
		if not row.warehouse and doc.get("set_warehouse"):
			row.warehouse = doc.set_warehouse
	normalise_dropship(doc)
	sync_freight_row(doc)


def before_submit(doc, method: Optional[str] = None) -> None:
	validate_dropship(doc)


# ---------------------------------------------------------------------------
# creation / editing
# ---------------------------------------------------------------------------
def schedule_date_for(supplier: str, lines: list[dict[str, Any]]) -> str:
	days = cint(frappe.db.get_value("Supplier", supplier, "maison_lead_time_days"))
	for line in lines:
		item_lead = cint(
			frappe.db.get_value(
				"AWANZ Item Vendor", {"parent": line.get("item_code"), "parenttype": "Item", "supplier": supplier}, "lead_time_days"
			)
		)
		days = max(days, item_lead)
	return add_days(nowdate(), max(1, days or 7))


def create_order(
	supplier: str,
	lines: list[dict[str, Any]],
	dropship_store: Optional[str] = None,
	freight: float = 0,
	source_request: Optional[str] = None,
	company: Optional[str] = None,
) -> Any:
	"""Draft Purchase Order for *supplier*. Rates default from the vendor's list and stay editable."""
	if not supplier or not frappe.db.exists("Supplier", supplier):
		frappe.throw(_("Vendor {0} does not exist").format(supplier or "?"), frappe.DoesNotExistError)
	lines = [row for row in (lines or []) if row.get("item_code") and flt(row.get("qty")) > 0]
	if not lines:
		frappe.throw(_("A purchase order needs at least one line"), frappe.ValidationError)
	warehouse = destination_warehouse(dropship_store, company)
	company = company or frappe.db.get_value("Warehouse", warehouse, "company")
	schedule_date = schedule_date_for(supplier, lines)
	plist = price_list_name(supplier)
	po = frappe.new_doc("Purchase Order")
	po.supplier = supplier
	po.company = company
	po.transaction_date = nowdate()
	po.schedule_date = schedule_date
	po.set_warehouse = warehouse
	if frappe.db.exists("Price List", plist):
		po.buying_price_list = plist
	if dropship_store:
		po.maison_dropship_store = dropship_store
	if source_request and frappe.db.exists("AWANZ Replenishment Request", source_request):
		po.maison_source_request = source_request
	for line in lines:
		rate = flt(line.get("rate")) if line.get("rate") not in (None, "") else vendor_rate(line["item_code"], supplier)
		po.append(
			"items",
			{
				"item_code": line["item_code"],
				"qty": flt(line["qty"]),
				"rate": rate,
				"warehouse": warehouse,
				"schedule_date": line.get("schedule_date") or schedule_date,
			},
		)
	po.maison_freight_amount = flt(freight)
	po.flags.ignore_permissions = True
	po.insert()
	return po


def update_order(name: str, lines: Any = None, freight: Any = None, dropship_store: Any = UNSET) -> Any:
	"""Edit a **draft** order: quantities, the manually overridable rates, the freight — and where
	it ships.

	``dropship_store`` left out is "leave the destination alone"; ``None`` or ``""`` clears the
	drop-ship and puts the whole order back on the main Houston warehouse.
	"""
	po = frappe.get_doc("Purchase Order", name)
	if dropship_store is not UNSET:
		# before the generic draft check, so a submitted order gets the message that says why
		set_dropship_store(po, dropship_store)
	if po.docstatus != 0:
		frappe.throw(_("Purchase Order {0} is not a draft").format(name), frappe.ValidationError)
	if lines is not None:
		wanted = []
		for line in lines or []:
			if not line.get("item_code") or flt(line.get("qty")) <= 0:
				continue
			wanted.append(line)
		if not wanted:
			frappe.throw(_("A purchase order needs at least one line"), frappe.ValidationError)
		existing = {row.item_code: row for row in po.items}
		rows = []
		for line in wanted:
			row = existing.get(line["item_code"])
			if row is None:
				row = po.append(
					"items",
					{"item_code": line["item_code"], "warehouse": po.set_warehouse, "schedule_date": po.schedule_date},
				)
			row.qty = flt(line["qty"])
			if line.get("rate") not in (None, ""):
				row.rate = flt(line["rate"])
			if line.get("schedule_date"):
				row.schedule_date = line["schedule_date"]
			rows.append(row)
		po.set("items", rows)
		for i, row in enumerate(po.items, start=1):
			row.idx = i
	if freight is not None:
		po.maison_freight_amount = flt(freight)
	po.flags.ignore_permissions = True
	po.save()
	return po


def submit_order(name: str) -> Any:
	po = frappe.get_doc("Purchase Order", name)
	if po.docstatus != 0:
		frappe.throw(_("Purchase Order {0} is already submitted").format(name), frappe.ValidationError)
	po.flags.ignore_permissions = True
	po.submit()
	return po


def close_order(name: str, reason: Optional[str] = None) -> Any:
	po = frappe.get_doc("Purchase Order", name)
	if po.docstatus != 1:
		frappe.throw(_("Only a submitted order can be closed"), frappe.ValidationError)
	po.flags.ignore_permissions = True
	po.update_status("Closed")
	if reason:
		po.add_comment("Comment", _("Closed: {0}").format(reason))
	return frappe.get_doc("Purchase Order", name)


def reopen_suggestions(order: str) -> list[str]:
	"""Put every buying suggestion *order* consumed back on the list (*Open*, no order).

	``create_orders`` flips a suggestion to *Ordered* and stamps the draft on it. If that draft
	goes away the item has to come back to the buying list, or it silently stops being bought.
	Clearing the link is also what lets the order be deleted at all — Frappe refuses to delete a
	document another row still links to.
	"""
	names = frappe.get_all("AWANZ Purchase Suggestion", filters={"purchase_order": order}, pluck="name")
	for name in names:
		frappe.db.set_value(
			"AWANZ Purchase Suggestion", name, {"status": "Open", "purchase_order": None}, update_modified=False
		)
		frappe.clear_document_cache("AWANZ Purchase Suggestion", name)
	return names


def delete_order(name: str, reason: Optional[str] = None) -> dict[str, Any]:
	"""Delete a **draft** order the buyer no longer wants — a draft's only terminal action.

	``close_order`` is ERPNext's terminal action and it needs ``docstatus == 1``
	(``update_status`` refuses a draft), so without this a draft nobody wants sits on the buying
	board for ever. A submitted order is never deleted: it has been sent to the vendor and it may
	already have receipts against it — that one is closed.

	Anything pointing at the order is released first (see :func:`reopen_suggestions`).
	"""
	po = frappe.get_doc("Purchase Order", name)
	if po.docstatus != 0:
		frappe.throw(
			_("Purchase Order {0} is submitted — close it instead of deleting it.").format(name), frappe.ValidationError
		)
	reopened = reopen_suggestions(name)
	supplier = po.supplier
	po.flags.ignore_permissions = True
	po.delete(ignore_permissions=True)
	try:
		from maison_pos.audit import log

		log("purchasing.delete_order", order=name, supplier=supplier, reason=reason, suggestions_reopened=reopened)
	except Exception:  # pragma: no cover — an audit line must never fail the delete
		pass
	return {"deleted": name, "suggestions_reopened": reopened}


# ---------------------------------------------------------------------------
# send
# ---------------------------------------------------------------------------
def _has_outgoing_email() -> bool:
	if frappe.db.exists("Email Account", {"enable_outgoing": 1}):
		return True
	return bool(frappe.conf.get("mail_server") or frappe.conf.get("mail_login"))


def vendor_email(supplier: str) -> Optional[str]:
	email = frappe.db.get_value("Supplier", supplier, "maison_rep_email")
	if email:
		return email
	contact = frappe.db.get_value("Supplier", supplier, "email_id") if frappe.get_meta("Supplier").has_field("email_id") else None
	return contact or None


def send_order(name: str, method: str = "Email", recipient: Optional[str] = None) -> dict[str, Any]:
	"""Mail the PO PDF to the vendor's rep, or record that it was phoned / entered on their portal."""
	method = (method or "Email").strip().title()
	if method not in ORDER_METHODS:
		frappe.throw(_("Unknown order method {0}").format(method), frappe.ValidationError)
	po = frappe.get_doc("Purchase Order", name)
	if po.docstatus != 1:
		frappe.throw(_("Submit the order before sending it"), frappe.ValidationError)
	sent_to, emailed, error = None, False, None
	if method == "Email":
		sent_to = recipient or vendor_email(po.supplier)
		if not sent_to:
			frappe.throw(_("Vendor {0} has no rep e-mail — add one or send by phone/portal").format(po.supplier), frappe.ValidationError)
		if _has_outgoing_email():
			try:
				frappe.sendmail(
					recipients=[sent_to],
					subject=_("Purchase Order {0}").format(po.name),
					message=_("<p>Please find our purchase order {0} attached.</p><p>{1}</p>").format(
						po.name, get_url_to_form("Purchase Order", po.name)
					),
					attachments=[frappe.attach_print("Purchase Order", po.name, print_format="AWANZ Purchase Order")],
					delayed=True,
				)
				emailed = True
			except Exception:
				frappe.log_error(frappe.get_traceback(), f"awanz send PO {po.name}")
				error = _("The order was stamped as sent but the e-mail could not be queued")
		else:
			error = _("No outgoing e-mail account is configured — the order was stamped as sent")
	values = {
		"maison_sent_on": now_datetime(),
		"maison_sent_by": frappe.session.user,
		"maison_sent_method": method,
	}
	for field, value in values.items():
		if po.meta.has_field(field):
			po.db_set(field, value, update_modified=False)
	po.add_comment("Comment", _("Sent to vendor by {0}{1}").format(method, f" ({sent_to})" if sent_to else ""))
	return {
		"purchase_order": po.name,
		"method": method,
		"sent_on": str(values["maison_sent_on"]),
		"sent_by": frappe.session.user,
		"recipient": sent_to,
		"emailed": emailed,
		"warning": error,
	}


# ---------------------------------------------------------------------------
# print format context
# ---------------------------------------------------------------------------
def purchase_order_context(doc) -> dict[str, Any]:
	"""Jinja helper for the ``AWANZ Purchase Order`` print format."""
	from maison_pos.shipping import ship_from_address, ship_to_address

	brand: dict[str, Any] = {"brand_name": "CloudChaserz", "legal_name": "CloudChaserz"}
	try:
		from maison_pos.brand import get_brand

		brand = {**brand, **get_brand()}
	except Exception:  # pragma: no cover
		pass
	store = doc.get("maison_dropship_store")
	if store:
		ship_to = ship_to_address(store)
		ship_to["label"] = _("Drop-ship to {0}").format(frappe.db.get_value("AWANZ Store", store, "boutique_name") or store)
	else:
		ship_to = ship_from_address()
		ship_to["label"] = _("Deliver to warehouse")
	supplier = frappe.get_doc("Supplier", doc.supplier)
	lines = []
	for row in doc.get("items") or []:
		sku = frappe.db.get_value(
			"AWANZ Item Vendor", {"parent": row.item_code, "parenttype": "Item", "supplier": doc.supplier}, "vendor_sku"
		)
		lines.append(
			{
				"idx": row.idx,
				"item_code": row.item_code,
				"item_name": row.item_name,
				"vendor_sku": sku or "",
				"qty": flt(row.qty),
				"uom": row.uom,
				"rate": flt(row.rate),
				"amount": flt(row.amount),
				"schedule_date": row.schedule_date,
			}
		)
	freight = freight_of(doc)
	return {
		"brand": brand,
		"ship_from": ship_from_address(),
		"ship_to": ship_to,
		"vendor": {
			"name": supplier.name,
			"supplier_name": supplier.supplier_name,
			"account_number": supplier.get("maison_account_number"),
			"rep_name": supplier.get("maison_rep_name"),
			"rep_email": supplier.get("maison_rep_email"),
			"rep_phone": supplier.get("maison_rep_phone"),
			"order_method": supplier.get("maison_order_method"),
		},
		"lines": lines,
		"units": sum(row["qty"] for row in lines),
		"net_total": flt(doc.net_total or doc.total),
		"freight": freight,
		"landed_total": flt(doc.net_total or doc.total) + freight,
		"currency": doc.currency,
	}
