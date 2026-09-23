"""v1.5 — **a store's own inventory**, two ways:

* the till's **Stock** screen (``store_stock``): what this store holds, item by item, with the
  shelf price in force here, what sold in the last 7 and 28 days, the reorder level and a
  low-stock flag — for the manager who runs the store. Costs and other stores' figures are not in
  it: what Houston paid is not shop-floor information (`docs/security.md`);
* the warehouse desk's store filter (the same read, any store, for head office / the warehouse
  admin) and **``adjust_store_stock``** — set the true quantity of one item at one store with a
  reason. It posts a submitted Stock Reconciliation with the reason on it, so the correction sits
  in the stock ledger under the name of whoever made it.

Counting belongs at the store (the till's Count screen — the person with the shelf in front of
them); the remote adjustment is for corrections, and every one is logged as such.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, nowdate

from maison_pos.scoping import as_administrator, assert_boutique_access, assert_supply_admin, is_supply_unrestricted


def _store(boutique: Optional[str]) -> frappe._dict:
	"""Resolve and authorise: store staff see their own store; supply admins any store."""
	if is_supply_unrestricted():
		if not boutique:
			frappe.throw(_("Store is required"), frappe.ValidationError)
	else:
		boutique = assert_boutique_access(boutique)
	row = frappe.db.get_value("AWANZ Store", boutique, ["name", "boutique_name", "warehouse", "company", "enabled"], as_dict=True)
	if not row:
		frappe.throw(_("Store {0} does not exist").format(boutique), frappe.DoesNotExistError)
	return row


def _sold(warehouse: str, days: int) -> dict[str, float]:
	rows = frappe.db.sql(
		"""select sii.item_code, sum(sii.qty) from `tabSales Invoice Item` sii
		   join `tabSales Invoice` si on si.name = sii.parent
		   where si.docstatus = 1 and si.is_return = 0 and sii.warehouse = %s and si.posting_date >= %s
		   group by sii.item_code""",
		(warehouse, add_days(nowdate(), -days)),
	)
	return {r[0]: flt(r[1]) for r in rows}


def _store_rates(item_codes: list[str], boutique: str, price_list: str) -> dict[str, dict[str, Any]]:
	"""The shelf price in force at this store per item: a live store override, else the chain
	price. One query for the overrides, whatever the size of the catalogue."""
	from frappe.utils import getdate
	from maison_pos.awanz_pos.doctype.awanz_price_change_request.awanz_price_change_request import pricing_rule_title

	chain = {r.item_code: flt(r.price_list_rate) for r in frappe.get_all("Item Price", filters={"item_code": ("in", item_codes or ["__none__"]), "price_list": price_list, "selling": 1}, fields=["item_code", "price_list_rate"])}
	titles = {pricing_rule_title(boutique, code): code for code in item_codes}
	live: dict[str, float] = {}
	today = getdate(nowdate())
	if titles:
		for rule in frappe.get_all("Pricing Rule", filters=[["title", "in", list(titles)], ["disable", "=", 0]], fields=["title", "rate", "valid_from", "valid_upto"], limit=len(titles) + 10):
			code = titles.get(rule.title)
			if not code:
				continue
			if rule.valid_from and getdate(rule.valid_from) > today:
				continue
			if rule.valid_upto and getdate(rule.valid_upto) < today:
				continue
			live[code] = flt(rule.rate)
	return {code: ({"rate": live[code], "source": "Store override"} if code in live else {"rate": chain.get(code, 0.0), "source": "Chain default"}) for code in item_codes}


@frappe.whitelist()
def store_stock(boutique: Optional[str] = None, q: Optional[str] = None, limit: int = 1000) -> dict[str, Any]:
	"""Every stock item at the store with on hand, the shelf price here, sold 7 / 28 days, the
	reorder level and a low-stock flag. Never a cost."""
	store = _store(boutique)
	warehouse = store.warehouse
	pos_profile = frappe.db.get_value("AWANZ Store", store.name, "pos_profile")
	price_list = (frappe.db.get_value("POS Profile", pos_profile, "selling_price_list") if pos_profile else None) or "Standard Selling"
	bins = {r.item_code: flt(r.actual_qty) for r in frappe.get_all("Bin", filters={"warehouse": warehouse}, fields=["item_code", "actual_qty"])}
	filters: dict[str, Any] = {"disabled": 0, "is_stock_item": 1, "is_sales_item": 1}
	if q:
		filters["item_name"] = ("like", f"%{q}%")
	meta = frappe.get_meta("Item")
	fields = ["name", "item_name", "item_group", "stock_uom", "image"] + [f for f in ("maison_brand", "maison_barcode", "maison_image_url", "maison_concentration", "maison_size", "maison_department") if meta.has_field(f)]
	items = frappe.get_all("Item", filters=filters, fields=fields, order_by="item_name asc", limit=cint(limit) or 1000)
	if q:
		# a code or barcode typed into the search box matches too
		extra = frappe.get_all("Item", filters={"disabled": 0, "is_stock_item": 1, "name": ("like", f"%{q}%")}, fields=fields, limit=50)
		seen = {i.name for i in items}
		items += [i for i in extra if i.name not in seen]
		if meta.has_field("maison_barcode"):
			extra = frappe.get_all("Item", filters={"disabled": 0, "is_stock_item": 1, "maison_barcode": ("like", f"%{q}%")}, fields=fields, limit=50)
			seen = {i.name for i in items}
			items += [i for i in extra if i.name not in seen]
	codes = [i.name for i in items]
	sold7 = _sold(warehouse, 7)
	sold28 = _sold(warehouse, 28)
	reorder = {r.parent: flt(r.warehouse_reorder_level) for r in frappe.get_all("Item Reorder", filters={"parent": ("in", codes or ["__none__"]), "warehouse": warehouse}, fields=["parent", "warehouse_reorder_level"])}
	rates = _store_rates(codes, store.name, price_list)
	in_transit: dict[str, float] = {}
	if frappe.db.exists("DocType", "AWANZ Shipment"):
		rows = frappe.db.sql(
			"""select l.item_code, sum(l.qty) from `tabAWANZ Shipment Line` l join `tabAWANZ Shipment` s on s.name = l.parent
			   where s.boutique = %s and s.status = 'Shipped' group by l.item_code""",
			(store.name,),
		)
		in_transit = {r[0]: flt(r[1]) for r in rows}
	out = []
	for i in items:
		on_hand = bins.get(i.name, 0.0)
		level = reorder.get(i.name, 0.0)
		row = {
			"item_code": i.name,
			"item_name": i.item_name,
			"item_group": i.item_group,
			"uom": i.stock_uom,
			"image": i.get("maison_image_url") or i.get("image"),
			"brand": i.get("maison_brand"),
			"barcode": i.get("maison_barcode"),
			"concentration": i.get("maison_concentration"),
			"size": i.get("maison_size"),
			"on_hand": on_hand,
			"in_transit": in_transit.get(i.name, 0.0),
			"sold_7": sold7.get(i.name, 0.0),
			"sold_28": sold28.get(i.name, 0.0),
			"reorder_level": level,
			"low": bool(level and on_hand <= level),
			"out": on_hand <= 0,
			"rate": rates[i.name]["rate"],
			"rate_source": rates[i.name]["source"],
		}
		# days of cover at the 28-day pace; None when nothing has sold
		row["cover_days"] = round(on_hand / (row["sold_28"] / 28.0), 1) if row["sold_28"] > 0 else None
		out.append(row)
	return {
		"boutique": store.name,
		"boutique_name": store.boutique_name,
		"warehouse": warehouse,
		"price_list": price_list,
		"items": out,
		"count": len(out),
		"units": sum(r["on_hand"] for r in out),
		"low_count": sum(1 for r in out if r["low"]),
		"out_count": sum(1 for r in out if r["out"] and r["sold_28"] > 0),
		"as_of": frappe.utils.now_datetime().isoformat(),
	}


def _posting_after_last_entry(item_code: str, warehouse: str):
	"""When to post a correction: now — unless the ledger already holds an entry for this item at
	this store *later* than now (a document posted on another clock, a seed dated ahead), in which
	case one second after it. A reconciliation "sets the quantity as of its time", so one posted
	*before* a later receipt would set the quantity and then have the receipt re-added on top —
	the desk would ask for 3 and read 5."""
	from datetime import timedelta

	posting = frappe.utils.now_datetime().replace(microsecond=0)
	last = frappe.db.sql(
		"select max(timestamp(posting_date, posting_time)) from `tabStock Ledger Entry` where item_code = %s and warehouse = %s and is_cancelled = 0",
		(item_code, warehouse),
	)[0][0]
	if last:
		last = frappe.utils.get_datetime(last)
		if last >= posting:
			posting = last.replace(microsecond=0) + timedelta(seconds=1)
	return posting


@frappe.whitelist()
def adjust_store_stock(boutique: str, item_code: str, qty: float, reason: str) -> dict[str, Any]:
	"""Set the true on-hand quantity of one item at one store, with a reason. Head office /
	warehouse admin only. Posts and submits a Stock Reconciliation in the operator's name, with
	the reason as a comment on it. Serialised items are refused — those are corrected on the desk,
	serial by serial."""
	assert_supply_admin()
	store = _store(boutique)
	if not frappe.db.exists("Item", item_code):
		frappe.throw(_("Item {0} does not exist").format(item_code), frappe.DoesNotExistError)
	item = frappe.db.get_value("Item", item_code, ["item_name", "is_stock_item", "has_serial_no", "has_batch_no", "valuation_rate"], as_dict=True)
	if not cint(item.is_stock_item):
		frappe.throw(_("{0} is not a stock item").format(item.item_name), frappe.ValidationError)
	if cint(item.has_serial_no) or cint(item.has_batch_no):
		frappe.throw(_("{0} is tracked by serial / batch — correct it on the admin desk").format(item.item_name), frappe.ValidationError)
	if not (reason or "").strip():
		frappe.throw(_("Say why the quantity is being corrected — it goes on the stock ledger"), frappe.MandatoryError)
	qty = flt(qty)
	if qty < 0:
		frappe.throw(_("Quantity cannot be negative"), frappe.ValidationError)
	before = flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": store.warehouse}, "actual_qty"))
	if abs(before - qty) < 0.000001:
		return {"boutique": store.name, "item_code": item_code, "before": before, "after": before, "changed": False}
	# the valuation the store already carries for the item, else the item's own — never zero when
	# stock is being added, or ERPNext refuses the entry
	valuation = flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": store.warehouse}, "valuation_rate")) or flt(item.valuation_rate) or flt(frappe.db.get_value("Stock Ledger Entry", {"item_code": item_code, "is_cancelled": 0}, "valuation_rate", order_by="posting_date desc, posting_time desc, creation desc"))
	line: dict[str, Any] = {"item_code": item_code, "warehouse": store.warehouse, "qty": qty}
	if qty > before:
		line["valuation_rate"] = valuation or 0.01
	posting = _posting_after_last_entry(item_code, store.warehouse)
	sr = frappe.get_doc(
		{
			"doctype": "Stock Reconciliation",
			"purpose": "Stock Reconciliation",
			"company": store.company,
			"set_warehouse": store.warehouse,
			"posting_date": posting.date(),
			"posting_time": posting.time().strftime("%H:%M:%S"),
			"set_posting_time": 1,
			"items": [line],
		}
	)
	sr.flags.ignore_permissions = True
	user = frappe.session.user
	# ERPNext's balance lookup checks write permission on Stock Reconciliation explicitly; the
	# operator has been authorised above, so post as Administrator and keep their name on it
	with as_administrator():
		try:
			sr.insert()
		except Exception as e:
			# ERPNext drops a line whose quantity equals the ledger's at that moment and refuses an
			# empty reconciliation — that is "nothing to correct", not an error
			if e.__class__.__name__ == "EmptyStockReconciliationItemsError":
				return {"boutique": store.name, "item_code": item_code, "item_name": item.item_name, "before": before, "after": before, "changed": False}
			raise
		sr.submit()
		frappe.db.set_value("Stock Reconciliation", sr.name, {"owner": user, "modified_by": user}, update_modified=False)
		frappe.get_doc(
			{
				"doctype": "Comment",
				"comment_type": "Info",
				"reference_doctype": "Stock Reconciliation",
				"reference_name": sr.name,
				"content": _("AWANZ stock correction at {0} by {1}: {2} → {3}. Reason: {4}").format(store.boutique_name, user, flt(before), qty, reason.strip()),
			}
		).insert(ignore_permissions=True)
	after = flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": store.warehouse}, "actual_qty"))
	return {"boutique": store.name, "item_code": item_code, "item_name": item.item_name, "before": before, "after": after, "changed": True, "stock_reconciliation": sr.name}
