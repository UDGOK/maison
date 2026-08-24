"""Warehouse & shipping API (v0.6 P) — ``maison_pos.api.shipping.*``.

Flow: store **Replenishment Request** → warehouse admin *approve / edit quantities / reject*
(workflow ``Maison Replenishment Approval``) → ``Maison Shipment`` Pending → Picking → Packed →
(rates → buy label) → **Shipped** (Material Transfer ``warehouse → <store> In Transit``) →
Received at the store (``maison_pos.api.inventory.receive_shipment``).

Scoping: warehouse admins / Head Office see every store; a store manager only their own
(``maison_pos.scoping``). Every mutation publishes ``maison_wall`` to the ``doctype:Maison Shipment``
room so the 55" wall and the admin desk update live.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.model.workflow import apply_workflow
from frappe.utils import cint, flt, get_datetime, get_system_timezone, now_datetime, nowdate, nowtime

from maison_pos.scoping import (
	assert_boutique_access,
	assert_supply_admin,
	get_user_boutique,
	is_supply_unrestricted,
	is_warehouse_admin,
)
from maison_pos.shipping import (
	ensure_transit_warehouse,
	get_main_warehouse,
	get_provider,
	provider_name,
	settings as shipping_settings,
	ship_from_address,
	ship_to_address,
	store_boutiques,
	warehouse_boutique,
)
from maison_pos.shipping.providers import ShippingError, pick_rate

WALL_ROOM = "doctype:Maison Shipment"
WALL_EVENT = "maison_wall"
OPEN_SHIPMENT_STATUSES = ("Pending", "Picking", "Packed", "Shipped")
SHIPMENT_ORDER = ["Pending", "Picking", "Packed", "Shipped", "Received", "Cancelled"]


# ---------------------------------------------------------------------------
# serialisation
# ---------------------------------------------------------------------------
def _loads(value: Any, default: Any) -> Any:
	if value in (None, ""):
		return default
	if isinstance(value, str):
		try:
			return json.loads(value)
		except ValueError:
			return default
	return value


def _iso(value: Any) -> Optional[str]:
	return get_datetime(value).isoformat() if value else None


def request_dict(doc) -> dict[str, Any]:
	return {
		"name": doc.name,
		"boutique": doc.boutique,
		"boutique_name": doc.boutique_name,
		"to_warehouse": doc.to_warehouse,
		"from_warehouse": doc.from_warehouse,
		"status": doc.status,
		"priority": doc.priority,
		"reason": doc.reason,
		"rejection_reason": doc.rejection_reason,
		"requested_by": doc.requested_by,
		"requested_at": _iso(doc.requested_at),
		# v0.8 QA W-D2 — the desk used to age a request from the zone-less `requested_at` string in
		# the *browser's* zone, so every new request rendered amber off-zone. The server's own age
		# is authoritative (the wall and the Shipments tab already use it).
		"age_seconds": int((now_datetime() - get_datetime(doc.requested_at)).total_seconds()) if doc.requested_at else 0,
		"approved_by": doc.approved_by,
		"approved_at": _iso(doc.approved_at),
		"material_request": doc.material_request,
		"shipment": doc.shipment,
		"units": sum(flt(l.qty) for l in doc.lines),
		"units_approved": sum(flt(l.approved_qty) for l in doc.lines),
		"items": len(doc.lines),
		"lines": [
			{
				"item_code": l.item_code,
				"item_name": l.item_name,
				"qty": flt(l.qty),
				"approved_qty": flt(l.approved_qty),
				"on_hand_store": flt(l.on_hand_store),
				"on_hand_warehouse": flt(l.on_hand_warehouse),
				"stock_alert": l.stock_alert,
				"barcode": l.barcode,
			}
			for l in doc.lines
		],
	}


def shipment_dict(doc, with_lines: bool = True) -> dict[str, Any]:
	age = doc.age_seconds() if hasattr(doc, "age_seconds") else 0
	out = {
		"name": doc.name,
		"boutique": doc.boutique,
		"boutique_name": doc.boutique_name,
		"from_warehouse": doc.from_warehouse,
		"transit_warehouse": doc.transit_warehouse,
		"to_warehouse": doc.to_warehouse,
		"status": doc.status,
		"priority": doc.priority,
		"replenishment_request": doc.replenishment_request,
		"material_request": doc.material_request,
		"created_by": doc.created_by,
		"items": len(doc.lines),
		"units": sum(flt(l.qty) for l in doc.lines),
		"units_picked": sum(flt(l.picked_qty) for l in doc.lines),
		"units_received": sum(flt(l.received_qty) for l in doc.lines),
		"parcels": doc.get_parcels() if hasattr(doc, "get_parcels") else _loads(doc.parcels, []),
		"packages": cint(doc.packages),
		"total_weight": flt(doc.total_weight),
		"est_weight": flt(doc.est_weight),
		"est_dims": [flt(doc.est_length), flt(doc.est_width), flt(doc.est_height)],
		"provider": doc.provider,
		"carrier": doc.carrier,
		"service": doc.service,
		"rate_amount": flt(doc.rate_amount),
		"rate_days": cint(doc.rate_days) if doc.rate_days is not None else None,
		"provider_rate_id": doc.provider_rate_id,
		"label_url": doc.label_url,
		"tracking_no": doc.tracking_no,
		"tracking_url": doc.tracking_url,
		"tracking_status": doc.tracking_status,
		"tracking_updated_at": _iso(doc.tracking_updated_at),
		"stock_entry_ship": doc.stock_entry_ship,
		"stock_entry_receive": doc.stock_entry_receive,
		"stock_entry_damaged": doc.stock_entry_damaged,
		# v0.8 QA W-N2 — every receiving leg, not just the first
		"receipt_entries": [n for n in (doc.get("receipt_entries") or "").split("\n") if n.strip()],
		"received_by": doc.received_by,
		"created_at": _iso(doc.creation),
		"approved_at": _iso(doc.approved_at),
		"picking_at": _iso(doc.picking_at),
		"packed_at": _iso(doc.packed_at),
		"label_at": _iso(doc.label_at),
		"shipped_at": _iso(doc.shipped_at),
		"received_at": _iso(doc.received_at),
		"age_seconds": int(age),
		"notes": doc.notes,
		"packing_list_url": f"/printview?doctype=Maison%20Shipment&name={doc.name}&format=Maison%20Packing%20List&no_letterhead=1",
	}
	if with_lines:
		out["lines"] = [
			{
				"item_code": l.item_code,
				"item_name": l.item_name,
				"barcode": l.barcode,
				"qty": flt(l.qty),
				"picked_qty": flt(l.picked_qty),
				"shipped_qty": flt(l.shipped_qty),
				"received_qty": flt(l.received_qty),
				"damaged_qty": flt(l.damaged_qty),
				"short_qty": flt(l.short_qty),
				"over_qty": flt(l.over_qty),
				"bin_location": l.bin_location,
				"weight_per_unit": flt(l.weight_per_unit),
				"uom": l.uom,
			}
			for l in doc.lines
		]
	return out


def publish_wall(event: str, shipment: Optional[str] = None, **extra: Any) -> None:
	"""``maison_wall`` realtime event for the wall / admin desk (document room of Maison Shipment)."""
	payload = {"event": event, "shipment": shipment, "ts": now_datetime().isoformat(), **extra}
	try:
		frappe.publish_realtime(WALL_EVENT, payload, room=WALL_ROOM, after_commit=True)
	except Exception:  # pragma: no cover - realtime must never break a transaction
		pass


def _notify(user: Optional[str], subject: str, doctype: str, name: str, body: str = "") -> None:
	if not user or user in ("Administrator", "Guest"):
		return
	try:
		frappe.get_doc(
			{"doctype": "Notification Log", "for_user": user, "type": "Alert", "document_type": doctype, "document_name": name, "subject": subject, "email_content": body}
		).insert(ignore_permissions=True)
	except Exception:  # pragma: no cover
		frappe.log_error(frappe.get_traceback(), "Maison shipping notification")


def _store_managers(boutique: str) -> list[str]:
	return frappe.get_all("Maison Associate", filters={"boutique": boutique, "role": "Manager", "enabled": 1}, pluck="user")


def _assert_doc_access(doc) -> None:
	"""Warehouse admin / HO: anything; store manager: own store only."""
	if is_supply_unrestricted():
		return
	assert_boutique_access(doc.boutique)


# ---------------------------------------------------------------------------
# replenishment requests
# ---------------------------------------------------------------------------
def _bin_qty(item_code: str, warehouse: Optional[str]) -> float:
	if not warehouse:
		return 0.0
	return flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty"))


def create_request(boutique: str, lines: list[dict], reason: Optional[str] = None, priority: Optional[str] = None, from_warehouse: Optional[str] = None) -> Any:
	"""Insert a ``Maison Replenishment Request`` + its draft Material Request. Caller has scoped *boutique*."""
	b = frappe.get_cached_doc("Maison Boutique", boutique)
	# v0.6 P — the source must belong to the store's own company (ERPNext forbids cross-company transfers).
	source = from_warehouse or get_main_warehouse(exclude=b.warehouse, company=b.company)
	rows = []
	for raw in lines:
		item = (raw.get("item_code") or raw.get("item") or "").strip()
		qty = flt(raw.get("qty"))
		if not item or qty <= 0:
			continue
		if not frappe.db.exists("Item", item):
			frappe.throw(_("Item {0} does not exist").format(item), frappe.DoesNotExistError)
		rows.append(
			{
				"item_code": item,
				"qty": qty,
				"approved_qty": qty,
				"stock_alert": raw.get("alert") or raw.get("stock_alert"),
				"on_hand_store": _bin_qty(item, b.warehouse),
				"on_hand_warehouse": _bin_qty(item, source),
				"barcode": frappe.db.get_value("Item", item, "maison_barcode") or item,
			}
		)
	if not rows:
		frappe.throw(_("No valid lines"), frappe.ValidationError)
	if not priority:
		priority = "Low stock" if any(r.get("stock_alert") for r in rows) else "Normal"
	req = frappe.get_doc(
		{
			"doctype": "Maison Replenishment Request",
			"boutique": boutique,
			"to_warehouse": b.warehouse,
			"from_warehouse": source,
			"status": "Pending Approval",
			"priority": priority,
			"reason": reason,
			"requested_by": frappe.session.user,
			"requested_at": now_datetime(),
			"lines": rows,
		}
	)
	req.flags.ignore_permissions = True
	req.insert()
	mr = frappe.get_doc(
		{
			"doctype": "Material Request",
			"material_request_type": "Material Transfer",
			"company": b.company,
			"transaction_date": nowdate(),
			"schedule_date": nowdate(),
			"set_from_warehouse": source,
			"set_warehouse": b.warehouse,
			"title": _("Replenish {0} ({1})").format(boutique, req.name),
			"items": [
				{"item_code": r["item_code"], "qty": r["qty"], "schedule_date": nowdate(), "warehouse": b.warehouse, "from_warehouse": source}
				for r in rows
			],
		}
	)
	mr.flags.ignore_permissions = True
	mr.insert()
	req.db_set("material_request", mr.name, update_modified=False)
	req.material_request = mr.name
	for r in rows:
		if r.get("stock_alert") and frappe.db.exists("Maison Stock Alert", r["stock_alert"]):
			frappe.db.set_value("Maison Stock Alert", r["stock_alert"], {"material_request": mr.name, "status": "Acknowledged"}, update_modified=False)
	publish_wall("request", request=req.name, boutique=boutique, priority=priority)
	for admin in frappe.get_all("Has Role", filters={"role": "Maison Warehouse Admin", "parenttype": "User"}, pluck="parent"):
		_notify(admin, _("{0} requests {1} unit(s) from the warehouse").format(boutique, int(req.units_requested)), "Maison Replenishment Request", req.name)
	return req


@frappe.whitelist()
def requests_list(status: Optional[str] = "open", boutique: Optional[str] = None, limit: int = 200) -> dict[str, Any]:
	"""Replenishment requests: ``status`` open (Pending Approval), all, or an exact status."""
	if frappe.session.user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)
	filters: dict[str, Any] = {}
	if is_supply_unrestricted():
		if boutique:
			filters["boutique"] = boutique
	else:
		filters["boutique"] = assert_boutique_access(boutique)
	if status == "open":
		filters["status"] = "Pending Approval"
	elif status and status != "all":
		filters["status"] = status
	names = frappe.get_all("Maison Replenishment Request", filters=filters, pluck="name", order_by="requested_at desc", limit=cint(limit) or 200)
	rows = [request_dict(frappe.get_doc("Maison Replenishment Request", n)) for n in names]
	return {"requests": rows, "count": len(rows), "scope": "all" if is_supply_unrestricted() else filters.get("boutique")}


@frappe.whitelist()
def request_detail(request: str) -> dict[str, Any]:
	doc = frappe.get_doc("Maison Replenishment Request", request)
	_assert_doc_access(doc)
	return request_dict(doc)


def _approved_lines(req, lines: Any) -> dict[str, float]:
	edits = {}
	for raw in _loads(lines, []) or []:
		item = raw.get("item_code") or raw.get("item")
		if item:
			edits[item] = flt(raw.get("approved_qty", raw.get("qty")))
	out = {}
	for line in req.lines:
		qty = edits.get(line.item_code, flt(line.approved_qty) if line.approved_qty is not None else flt(line.qty))
		if qty < 0:
			frappe.throw(_("Approved quantity cannot be negative ({0})").format(line.item_code), frappe.ValidationError)
		out[line.item_code] = qty
	return out


def _transition(req, action: str, state: str):
	"""Run the ``Maison Replenishment Approval`` workflow action (plain state change when the workflow is absent)."""
	from frappe.model.workflow import WorkflowTransitionError

	if frappe.db.exists("Workflow", {"document_type": "Maison Replenishment Request", "is_active": 1}):
		try:
			doc = apply_workflow(req, action)
		except WorkflowTransitionError:
			frappe.throw(_("You are not allowed to {0} replenishment requests").format(action.lower()), frappe.PermissionError)
		doc.flags.ignore_permissions = True
		return doc
	req.status = state
	req.save()
	return req


def _create_shipment_from_request(req, approved: dict[str, float]) -> Any:
	transit = ensure_transit_warehouse(req.boutique)
	doc = frappe.get_doc(
		{
			"doctype": "Maison Shipment",
			"boutique": req.boutique,
			"from_warehouse": req.from_warehouse,
			"transit_warehouse": transit,
			"to_warehouse": req.to_warehouse,
			"status": "Pending",
			"priority": req.priority,
			"replenishment_request": req.name,
			"material_request": req.material_request,
			"created_by": frappe.session.user,
			"approved_at": now_datetime(),
			"lines": [{"item_code": item, "qty": qty} for item, qty in approved.items() if qty > 0],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc


@frappe.whitelist()
def approve(request: str, lines: Any = None, notes: Optional[str] = None) -> dict[str, Any]:
	"""Warehouse admin: approve (optionally with edited quantities) → submits the Material Request and creates the shipment."""
	assert_supply_admin()
	req = frappe.get_doc("Maison Replenishment Request", request)
	if req.status != "Pending Approval":
		frappe.throw(_("Request {0} is {1}").format(request, req.status), frappe.ValidationError)
	approved = _approved_lines(req, lines)
	if not any(q > 0 for q in approved.values()):
		frappe.throw(_("Approve at least one unit, or reject the request"), frappe.ValidationError)
	for line in req.lines:
		line.approved_qty = approved[line.item_code]
	req.approved_by = frappe.session.user
	req.approved_at = now_datetime()
	if notes:
		req.reason = (req.reason or "") + f"\n[{frappe.session.user}] {notes}"
	req.flags.ignore_permissions = True
	req.save()  # apply_workflow reloads from the DB: persist the edited quantities first
	req = _transition(req, "Approve", "Approved")
	# material request: quantities → approved, submit
	if req.material_request and frappe.db.exists("Material Request", req.material_request):
		mr = frappe.get_doc("Material Request", req.material_request)
		if mr.docstatus == 0:
			keep = []
			for row in mr.items:
				qty = approved.get(row.item_code, 0)
				if qty > 0:
					row.qty = qty
					row.stock_qty = qty
					keep.append(row)
			mr.items = keep
			mr.flags.ignore_permissions = True
			mr.save()
			mr.submit()
	shipment = _create_shipment_from_request(req, approved)
	req.db_set("shipment", shipment.name, update_modified=False)
	for line in req.lines:
		if line.stock_alert and frappe.db.exists("Maison Stock Alert", line.stock_alert):
			frappe.db.set_value("Maison Stock Alert", line.stock_alert, "status", "Acknowledged", update_modified=False)
	publish_wall("approved", shipment.name, boutique=req.boutique, request=req.name, priority=req.priority, print_packing_list=bool(shipping_settings()["auto_print_packing_list"]))
	for user in {req.requested_by, *_store_managers(req.boutique)}:
		_notify(user, _("Replenishment {0} approved — shipment {1}").format(req.name, shipment.name), "Maison Shipment", shipment.name)
	return {"request": request_dict(req), "shipment": shipment_dict(shipment)}


@frappe.whitelist()
def reject(request: str, reason: str) -> dict[str, Any]:
	"""Warehouse admin: reject with a reason (the store manager is notified)."""
	assert_supply_admin()
	if not (reason or "").strip():
		frappe.throw(_("A rejection reason is required"), frappe.ValidationError)
	req = frappe.get_doc("Maison Replenishment Request", request)
	if req.status != "Pending Approval":
		frappe.throw(_("Request {0} is {1}").format(request, req.status), frappe.ValidationError)
	req.rejection_reason = reason.strip()
	req.approved_by = frappe.session.user
	req.approved_at = now_datetime()
	req.flags.ignore_permissions = True
	req.save()
	req = _transition(req, "Reject", "Rejected")
	# --- v0.8 QA W-D1 — a request raised from a low-stock alert could never be rejected ---
	# `inventory.replenish` links the alert to the draft Material Request
	# (`Maison Stock Alert.material_request`). Deleting the MR before clearing that link made
	# ERPNext's link check fire (`LinkExistsError`) and rolled the whole rejection back, so the
	# request sat on the wall for ever with no way out. Every link to the MR goes first.
	for line in req.lines:
		if line.stock_alert and frappe.db.exists("Maison Stock Alert", line.stock_alert):
			frappe.db.set_value("Maison Stock Alert", line.stock_alert, "material_request", None, update_modified=False)
	if req.material_request and frappe.db.exists("Material Request", req.material_request):
		mr_name = req.material_request
		mr = frappe.get_doc("Material Request", mr_name)
		req.db_set("material_request", None, update_modified=False)
		req.material_request = None
		# any other alert that points at this MR (a second request for the same item) must let go too
		for alert in frappe.get_all("Maison Stock Alert", filters={"material_request": mr_name}, pluck="name"):
			frappe.db.set_value("Maison Stock Alert", alert, "material_request", None, update_modified=False)
		mr.flags.ignore_permissions = True
		if mr.docstatus == 0:
			mr.delete()
		elif mr.docstatus == 1:
			mr.cancel()
	# --- end v0.8 QA W-D1 ---
	publish_wall("rejected", request=req.name, boutique=req.boutique)
	for user in {req.requested_by, *_store_managers(req.boutique)}:
		_notify(user, _("Replenishment {0} rejected: {1}").format(req.name, req.rejection_reason), "Maison Replenishment Request", req.name, req.rejection_reason)
	return {"request": request_dict(req)}


# ---------------------------------------------------------------------------
# shipments
# ---------------------------------------------------------------------------
@frappe.whitelist()
def shipments(status: Optional[str] = "open", boutique: Optional[str] = None, limit: int = 200, with_lines: int = 0) -> dict[str, Any]:
	"""Shipments (``status``: open = not Received/Cancelled, all, or exact). Store managers: own store only."""
	if frappe.session.user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)
	filters: dict[str, Any] = {}
	if is_supply_unrestricted():
		if boutique:
			filters["boutique"] = boutique
	else:
		filters["boutique"] = assert_boutique_access(boutique)
	if status == "open":
		filters["status"] = ("in", OPEN_SHIPMENT_STATUSES)
	elif status == "inbound":
		filters["status"] = "Shipped"
	elif status and status != "all":
		filters["status"] = status
	names = frappe.get_all("Maison Shipment", filters=filters, pluck="name", order_by="creation desc", limit=cint(limit) or 200)
	rows = [shipment_dict(frappe.get_doc("Maison Shipment", n), with_lines=bool(cint(with_lines))) for n in names]
	return {"shipments": rows, "count": len(rows)}


@frappe.whitelist()
def shipment(shipment: str) -> dict[str, Any]:
	doc = frappe.get_doc("Maison Shipment", shipment)
	_assert_doc_access(doc)
	out = shipment_dict(doc)
	out["ship_to"] = ship_to_address(doc.boutique)
	out["ship_from"] = ship_from_address()
	out["rate_options"] = _loads(doc.rate_options, [])
	return out


def _set_status(doc, status: str) -> None:
	if status not in SHIPMENT_ORDER:
		frappe.throw(_("Unknown status {0}").format(status), frappe.ValidationError)
	doc.status = status
	stamp = {"Picking": "picking_at", "Packed": "packed_at", "Shipped": "shipped_at", "Received": "received_at"}.get(status)
	if stamp and not doc.get(stamp):
		doc.set(stamp, now_datetime())


@frappe.whitelist()
def pick(shipment: str, lines: Any = None) -> dict[str, Any]:
	"""Start / update picking. ``lines = [{item_code, picked_qty}]``; absent lines default to the full qty."""
	assert_supply_admin()
	doc = frappe.get_doc("Maison Shipment", shipment)
	if doc.status not in ("Pending", "Picking"):
		frappe.throw(_("Shipment {0} is {1}").format(shipment, doc.status), frappe.ValidationError)
	picked = {r.get("item_code"): flt(r.get("picked_qty", r.get("qty"))) for r in (_loads(lines, []) or [])}
	for line in doc.lines:
		qty = picked.get(line.item_code, flt(line.picked_qty) or flt(line.qty))
		if qty > flt(line.qty):
			frappe.throw(_("Picked more than approved for {0}").format(line.item_code), frappe.ValidationError)
		line.picked_qty = qty
	_set_status(doc, "Picking")
	doc.flags.ignore_permissions = True
	doc.save()
	publish_wall("picking", doc.name, boutique=doc.boutique)
	return shipment_dict(doc)


@frappe.whitelist()
def pick_list(shipment: str) -> dict[str, Any]:
	"""Pick list with bin locations, sorted by aisle / bay (what the picker walks)."""
	doc = frappe.get_doc("Maison Shipment", shipment)
	_assert_doc_access(doc)
	lines = sorted(
		(
			{
				"item_code": l.item_code,
				"item_name": l.item_name,
				"barcode": l.barcode,
				"qty": flt(l.qty),
				"picked_qty": flt(l.picked_qty),
				"bin_location": l.bin_location,
				"on_hand": _bin_qty(l.item_code, doc.from_warehouse),
				"image": frappe.db.get_value("Item", l.item_code, "image"),
			}
			for l in doc.lines
		),
		key=lambda r: (r["bin_location"] or "", r["item_code"]),
	)
	return {"shipment": doc.name, "boutique": doc.boutique, "boutique_name": doc.boutique_name, "from_warehouse": doc.from_warehouse, "status": doc.status, "lines": lines}


@frappe.whitelist()
def pack(shipment: str, lines: Any = None, parcels: Any = None) -> dict[str, Any]:
	"""Mark Packed with the parcels ``[{length, width, height, weight}]`` (default: the estimate)."""
	assert_supply_admin()
	doc = frappe.get_doc("Maison Shipment", shipment)
	if doc.status not in ("Pending", "Picking", "Packed"):
		frappe.throw(_("Shipment {0} is {1}").format(shipment, doc.status), frappe.ValidationError)
	picked = {r.get("item_code"): flt(r.get("picked_qty", r.get("qty"))) for r in (_loads(lines, []) or [])}
	for line in doc.lines:
		line.picked_qty = picked.get(line.item_code, flt(line.picked_qty) or flt(line.qty))
	parcels_list = _loads(parcels, None)
	if parcels_list:
		clean = []
		for p in parcels_list:
			clean.append({k: flt(p.get(k)) for k in ("length", "width", "height", "weight")})
			if clean[-1]["weight"] <= 0:
				frappe.throw(_("Parcel weight must be positive"), frappe.ValidationError)
		doc.parcels = json.dumps(clean)
	elif not doc.get_parcels():
		doc.parcels = json.dumps(doc.default_parcels())
	if not doc.picking_at:
		doc.picking_at = now_datetime()
	_set_status(doc, "Packed")
	doc.flags.ignore_permissions = True
	doc.save()
	publish_wall("packed", doc.name, boutique=doc.boutique)
	return shipment_dict(doc)


def _parcels_for(doc) -> list[dict]:
	return doc.get_parcels() or doc.default_parcels()


@frappe.whitelist()
def rates(shipment: str, prefer: str = "cheapest", provider: Optional[str] = None) -> dict[str, Any]:
	"""Quote the configured provider; cheapest auto-selected (``prefer=fastest`` picks the quickest)."""
	assert_supply_admin()
	doc = frappe.get_doc("Maison Shipment", shipment)
	if doc.status in ("Shipped", "Received", "Cancelled"):
		frappe.throw(_("Shipment {0} is already {1}").format(shipment, doc.status), frappe.ValidationError)
	try:
		prov = get_provider(provider)
		quotes = prov.rates(ship_from_address(), ship_to_address(doc.boutique), _parcels_for(doc))
	except ShippingError as e:
		frappe.throw(str(e), frappe.ValidationError)
	except NotImplementedError as e:
		frappe.throw(str(e), frappe.ValidationError)
	selected = pick_rate(quotes, prefer if prefer in ("cheapest", "fastest") else "cheapest")
	cheapest = pick_rate(quotes, "cheapest")
	fastest = pick_rate(quotes, "fastest")
	rows = [r.as_dict() for r in quotes]
	doc.db_set("rate_options", json.dumps(rows), update_modified=False)
	return {
		"shipment": doc.name,
		"provider": prov.name,
		"test_mode": bool(getattr(prov, "test_mode", False)),
		"prefer": prefer,
		"rates": rows,
		"selected": selected.as_dict() if selected else None,
		"cheapest": cheapest.provider_rate_id if cheapest else None,
		"fastest": fastest.provider_rate_id if fastest else None,
		"parcels": _parcels_for(doc),
		"ship_to": ship_to_address(doc.boutique),
		"ship_from": ship_from_address(),
	}


@frappe.whitelist()
def buy(shipment: str, rate_id: Optional[str] = None, prefer: str = "cheapest", replace: int = 0) -> dict[str, Any]:
	"""Buy the label for *rate_id* (from the last quote) or the auto-selected rate. Stores label / tracking.

	Refuses when a label has already been bought unless ``replace=1`` (v0.8 QA W-D4).
	"""
	assert_supply_admin()
	doc = frappe.get_doc("Maison Shipment", shipment)
	if doc.status in ("Shipped", "Received", "Cancelled"):
		frappe.throw(_("Shipment {0} is already {1}").format(shipment, doc.status), frappe.ValidationError)
	# --- v0.8 QA W-D4 — buying twice silently orphaned the first label ---
	# A second call overwrote carrier / service / rate / label_url / tracking_no, and on a real
	# carrier that first label has already been bought and billed — with its tracking number then
	# unrecoverable from the app. The wall's one-tap "Buy label" makes a double press plausible.
	if doc.label_url and not cint(replace):
		frappe.throw(
			_("Shipment {0} already has a {1} {2} label ({3}). Pass replace=1 to void it and buy another — the first label stays billed by the carrier.").format(
				shipment, doc.carrier or "", doc.service or "", doc.tracking_no or "-"
			),
			frappe.ValidationError,
		)
	voided = None
	if doc.label_url and cint(replace):
		voided = {"carrier": doc.carrier, "service": doc.service, "tracking_no": doc.tracking_no, "label_url": doc.label_url, "amount": flt(doc.rate_amount)}
		doc.notes = ((doc.notes or "") + "\n" + _("Label replaced by {0}: {1} {2} {3} voided").format(frappe.session.user, voided["carrier"] or "", voided["service"] or "", voided["tracking_no"] or "")).strip()
	# --- end v0.8 QA W-D4 ---
	options = _loads(doc.rate_options, [])
	if not options:
		options = rates(shipment, prefer=prefer)["rates"]
	chosen = None
	if rate_id:
		chosen = next((r for r in options if r.get("provider_rate_id") == rate_id), None)
		if not chosen:
			frappe.throw(_("Rate {0} is not in the last quote — fetch rates again").format(rate_id), frappe.ValidationError)
	else:
		from maison_pos.shipping.providers.base import BaseProvider

		picked = pick_rate([BaseProvider.to_rate(r) for r in options], prefer)
		chosen = picked.as_dict() if picked else None
	if not chosen:
		frappe.throw(_("No rate available"), frappe.ValidationError)
	try:
		prov = get_provider(chosen.get("provider"))
		label = prov.buy(chosen)
	except (ShippingError, NotImplementedError) as e:
		frappe.throw(str(e), frappe.ValidationError)
	if doc.status in ("Pending", "Picking"):
		for line in doc.lines:
			line.picked_qty = flt(line.picked_qty) or flt(line.qty)
		if not doc.get_parcels():
			doc.parcels = json.dumps(doc.default_parcels())
		_set_status(doc, "Packed")
	doc.provider = label.provider
	doc.carrier = label.carrier
	doc.service = label.service
	doc.rate_amount = flt(label.amount)
	doc.rate_days = chosen.get("days")
	doc.provider_rate_id = chosen.get("provider_rate_id")
	doc.label_url = label.label_url
	doc.tracking_no = label.tracking_no
	doc.tracking_url = label.tracking_url
	doc.tracking_status = "PRE_TRANSIT"
	doc.tracking_updated_at = now_datetime()
	doc.label_at = now_datetime()
	doc.flags.ignore_permissions = True
	doc.save()
	publish_wall("label", doc.name, boutique=doc.boutique, label_url=doc.label_url, print_label=bool(shipping_settings()["auto_print_label"]))
	out = shipment_dict(doc)
	out["label"] = label.as_dict()
	if voided:
		out["voided_label"] = voided  # v0.8 QA W-D4
	return out


def _post_ship_transfer(doc) -> str:
	"""Material Transfer ``from_warehouse → transit`` for the picked quantities (linked to the Material Request)."""
	transit = doc.transit_warehouse or ensure_transit_warehouse(doc.boutique)
	company = frappe.db.get_value("Warehouse", doc.from_warehouse, "company")
	mr_items: dict[str, str] = {}
	mr_ok = False
	if doc.material_request and frappe.db.get_value("Material Request", doc.material_request, "docstatus") == 1:
		mr_ok = True
		for row in frappe.get_all("Material Request Item", filters={"parent": doc.material_request}, fields=["name", "item_code", "qty", "ordered_qty"]):
			mr_items[row.item_code] = row
	rows = []
	for line in doc.lines:
		qty = flt(line.shipped_qty)
		if qty <= 0:
			continue
		row = {"item_code": line.item_code, "qty": qty, "s_warehouse": doc.from_warehouse, "t_warehouse": transit}
		mri = mr_items.get(line.item_code)
		if mr_ok and mri and flt(mri.qty) - flt(mri.ordered_qty) >= qty:
			row["material_request"] = doc.material_request
			row["material_request_item"] = mri.name
		rows.append(row)
	se = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Transfer",
			"purpose": "Material Transfer",
			"company": company,
			"from_warehouse": doc.from_warehouse,
			"to_warehouse": transit,
			"posting_date": nowdate(),
			"posting_time": nowtime(),
			"set_posting_time": 1,
			"remarks": f"Maison Shipment {doc.name} → {doc.boutique} (in transit)",
			"items": rows,
		}
	)
	se.flags.ignore_permissions = True
	se.insert()
	se.submit()
	return se.name


@frappe.whitelist()
def ship(shipment: str) -> dict[str, Any]:
	"""Mark **Shipped**: posts the Material Transfer to the store's in-transit warehouse."""
	assert_supply_admin()
	doc = frappe.get_doc("Maison Shipment", shipment)
	if doc.status in ("Shipped", "Received", "Cancelled"):
		frappe.throw(_("Shipment {0} is already {1}").format(shipment, doc.status), frappe.ValidationError)
	if not doc.transit_warehouse:
		doc.transit_warehouse = ensure_transit_warehouse(doc.boutique)
	for line in doc.lines:
		line.shipped_qty = flt(line.picked_qty) or flt(line.qty)
	if not any(flt(l.shipped_qty) > 0 for l in doc.lines):
		frappe.throw(_("Nothing picked to ship"), frappe.ValidationError)
	if not doc.get_parcels():
		doc.parcels = json.dumps(doc.default_parcels())
	for stamp in ("picking_at", "packed_at"):
		if not doc.get(stamp):
			doc.set(stamp, now_datetime())
	doc.stock_entry_ship = _post_ship_transfer(doc)
	_set_status(doc, "Shipped")
	if not doc.tracking_status:
		doc.tracking_status = "PRE_TRANSIT"
	doc.flags.ignore_permissions = True
	doc.save()
	publish_wall("shipped", doc.name, boutique=doc.boutique)
	for user in _store_managers(doc.boutique):
		_notify(user, _("Shipment {0} is on its way ({1} {2})").format(doc.name, doc.carrier or "", doc.service or "").strip(), "Maison Shipment", doc.name)
	return shipment_dict(doc)


@frappe.whitelist()
def mark(shipment: str, status: str, reason: Optional[str] = None) -> dict[str, Any]:
	"""Generic transition for the wall: Picking / Packed / Shipped / Cancelled (Received happens at the store)."""
	assert_supply_admin()
	if status == "Picking":
		return pick(shipment)
	if status == "Packed":
		return pack(shipment)
	if status == "Shipped":
		return ship(shipment)
	if status == "Cancelled":
		doc = frappe.get_doc("Maison Shipment", shipment)
		if doc.status in ("Shipped", "Received"):
			frappe.throw(_("A shipped consignment cannot be cancelled — receive it at the store"), frappe.ValidationError)
		doc.status = "Cancelled"
		if reason:
			doc.notes = ((doc.notes or "") + "\n" + _("Cancelled by {0}: {1}").format(frappe.session.user, reason)).strip()
		doc.flags.ignore_permissions = True
		doc.save()
		reopened = _reopen_request_after_cancel(doc, reason)  # v0.8 QA W-N1
		publish_wall("cancelled", doc.name, boutique=doc.boutique, request=doc.replenishment_request)
		out = shipment_dict(doc)
		out["request_reopened"] = reopened
		return out
	frappe.throw(_("Unsupported status {0}").format(status), frappe.ValidationError)


def _reopen_request_after_cancel(doc, reason: Optional[str] = None) -> Optional[str]:
	"""--- v0.8 QA W-N1 — cancelling a shipment used to leave its request stranded ---

	The replenishment request stayed **Approved** with its Material Request submitted, its
	shipment cancelled and nobody at the store told: the goods were never coming and the request
	could not be raised again. The request goes back to *Pending Approval* (so the warehouse can
	approve it into a new shipment, or reject it), the Material Request is cancelled, and the
	store is notified.
	"""
	name = doc.replenishment_request
	if not name or not frappe.db.exists("Maison Replenishment Request", name):
		return None
	req = frappe.get_doc("Maison Replenishment Request", name)
	if req.status != "Approved" or req.shipment != doc.name:
		return None
	if req.material_request and frappe.db.exists("Material Request", req.material_request):
		mr = frappe.get_doc("Material Request", req.material_request)
		mr.flags.ignore_permissions = True
		try:
			if mr.docstatus == 1:
				mr.cancel()
			elif mr.docstatus == 0:
				req.db_set("material_request", None, update_modified=False)
				mr.delete()
		except Exception:  # a partly-served MR stays as it is; the request still re-opens
			frappe.log_error(frappe.get_traceback(), f"Maison shipment cancel {doc.name}: material request")
	req.db_set("status", "Pending Approval", update_modified=False)
	req.db_set("shipment", None, update_modified=False)
	req.db_set("approved_by", None, update_modified=False)
	req.db_set("approved_at", None, update_modified=False)
	if reason:
		req.db_set("reason", ((req.reason or "") + f"\n[{frappe.session.user}] " + _("Shipment {0} cancelled: {1}").format(doc.name, reason)).strip(), update_modified=False)
	message = _("Shipment {0} was cancelled — replenishment {1} is back with the warehouse").format(doc.name, req.name)
	for user in {req.requested_by, *_store_managers(req.boutique)}:
		if user:
			_notify(user, message, "Maison Replenishment Request", req.name, reason)
	return req.name


@frappe.whitelist()
def track(shipment: str) -> dict[str, Any]:
	"""Refresh carrier tracking for one shipment (any user who may read it)."""
	doc = frappe.get_doc("Maison Shipment", shipment)
	_assert_doc_access(doc)
	if not doc.tracking_no:
		return {"shipment": doc.name, "tracking_no": None, "status": doc.tracking_status, "events": []}
	info = _track_doc(doc)
	return {"shipment": doc.name, **info}


def _track_doc(doc) -> dict[str, Any]:
	try:
		prov = get_provider(doc.provider)
		if prov.name == "simulated":
			t = prov.track(doc.tracking_no, doc.carrier, shipped_at=get_datetime(doc.shipped_at or doc.label_at) if (doc.shipped_at or doc.label_at) else None, days=cint(doc.rate_days) or 3)
		else:
			t = prov.track(doc.tracking_no, doc.carrier)
	except (ShippingError, NotImplementedError) as e:
		return {"tracking_no": doc.tracking_no, "status": doc.tracking_status, "error": str(e), "events": []}
	doc.db_set({"tracking_status": t.status, "tracking_updated_at": now_datetime()}, update_modified=False)
	if t.tracking_url and not doc.tracking_url:
		doc.db_set("tracking_url", t.tracking_url, update_modified=False)
	return t.as_dict()


def refresh_tracking(limit: int = 200) -> dict[str, Any]:
	"""Hourly scheduler: poll the carrier for every *Shipped* consignment with a tracking number."""
	names = frappe.get_all("Maison Shipment", filters={"status": "Shipped", "tracking_no": ("!=", "")}, pluck="name", limit=cint(limit) or 200)
	out = {"checked": 0, "delivered": [], "errors": 0}
	for name in names:
		doc = frappe.get_doc("Maison Shipment", name)
		info = _track_doc(doc)
		out["checked"] += 1
		if info.get("error"):
			out["errors"] += 1
		elif info.get("status") == "DELIVERED":
			out["delivered"].append(name)
	if out["checked"] and not frappe.flags.in_test:
		frappe.db.commit()
	if out["delivered"]:
		publish_wall("tracking", delivered=out["delivered"])
	return out


# ---------------------------------------------------------------------------
# wall / admin desk data
# ---------------------------------------------------------------------------
WALL_COLUMNS = ("pending_approval", "to_pick", "packing", "ready", "shipped_today")


def _card(doc) -> dict[str, Any]:
	d = shipment_dict(doc, with_lines=False)
	d["kind"] = "shipment"
	return d


@frappe.whitelist()
def wall() -> dict[str, Any]:
	"""Board data for ``/warehouse-wall`` and ``/warehouse``: 5 columns + thresholds + counters."""
	assert_supply_admin()
	s = shipping_settings()
	pending = [
		{**request_dict(frappe.get_doc("Maison Replenishment Request", n)), "kind": "request"}
		for n in frappe.get_all("Maison Replenishment Request", filters={"status": "Pending Approval"}, pluck="name", order_by="requested_at asc")
	]
	open_docs = [frappe.get_doc("Maison Shipment", n) for n in frappe.get_all("Maison Shipment", filters={"status": ("in", OPEN_SHIPMENT_STATUSES)}, pluck="name", order_by="creation asc")]
	today = nowdate()
	cols = {k: [] for k in WALL_COLUMNS}
	cols["pending_approval"] = pending
	for d in open_docs:
		if d.status in ("Pending", "Picking"):
			cols["to_pick"].append(_card(d))
		elif d.status == "Packed" and not d.label_url:
			cols["packing"].append(_card(d))
		elif d.status == "Packed":
			cols["ready"].append(_card(d))
		elif d.status == "Shipped" and d.shipped_at and get_datetime(d.shipped_at).date() == get_datetime(today).date():
			cols["shipped_today"].append(_card(d))
	received_today = frappe.db.count("Maison Shipment", {"status": "Received", "received_at": (">=", today)})
	return {
		"columns": cols,
		"counts": {k: len(v) for k, v in cols.items()},
		"warn_seconds": cint(s["wall_warn_hours"]) * 3600,
		"crit_seconds": cint(s["wall_crit_hours"]) * 3600,
		"sound_enabled": bool(s["wall_sound_enabled"]),
		"auto_print_packing_list": bool(s["auto_print_packing_list"]),
		"auto_print_label": bool(s["auto_print_label"]),
		"provider": provider_name(),
		"in_transit": frappe.db.count("Maison Shipment", {"status": "Shipped"}),
		"received_today": received_today,
		"open_discrepancies": frappe.db.count("Maison Receiving Discrepancy", {"status": "Open"}),
		"server_time": now_datetime().isoformat(),
	}


@frappe.whitelist()
def me() -> dict[str, Any]:
	"""Who am I for the /warehouse screens (role gate + brand for the header)."""
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)
	brand = {"brand_name": "CloudChaserz", "wordmark_text": "CLOUDCHASERZ", "product_name": "Maison POS by CloudChaserz"}
	try:
		from maison_pos.brand import get_brand  # v0.6 N (feature-detected)

		brand = {**brand, **get_brand()}
	except Exception:
		pass
	wb = warehouse_boutique()
	return {
		"user": user,
		"full_name": frappe.db.get_value("User", user, "full_name"),
		"roles": frappe.get_roles(user),
		"warehouse_admin": is_warehouse_admin(user),
		"supply_unrestricted": is_supply_unrestricted(user),
		"boutique": get_user_boutique(user),
		"main_warehouse": get_main_warehouse() if frappe.db.exists("Maison Boutique", {"enabled": 1}) else None,
		"warehouse_boutique": wb,
		"brand": brand,
		"provider": provider_name(),
		"stores": store_boutiques(),
		# v0.6 R — the desk and the 55" wall render every timestamp in the site zone
		"time_zone": get_system_timezone(),
	}


# ---------------------------------------------------------------------------
# discrepancies
# ---------------------------------------------------------------------------
def discrepancy_dict(doc) -> dict[str, Any]:
	return {
		"name": doc.name,
		"shipment": doc.shipment,
		"boutique": doc.boutique,
		"item_code": doc.item_code,
		"item_name": doc.item_name,
		"type": doc.type,
		"status": doc.status,
		"shipped_qty": flt(doc.shipped_qty),
		"received_qty": flt(doc.received_qty),
		"damaged_qty": flt(doc.damaged_qty),
		"short_qty": flt(doc.short_qty),
		"over_qty": flt(doc.over_qty),
		"reported_by": doc.reported_by,
		"reported_at": _iso(doc.reported_at),
		"resolution": doc.resolution,
		"resolved_by": doc.resolved_by,
		"resolved_at": _iso(doc.resolved_at),
		"stock_entry": doc.stock_entry,
		"notes": doc.notes,
	}


@frappe.whitelist()
def discrepancies(status: str = "Open", boutique: Optional[str] = None, limit: int = 200) -> dict[str, Any]:
	if frappe.session.user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)
	filters: dict[str, Any] = {}
	if is_supply_unrestricted():
		if boutique:
			filters["boutique"] = boutique
	else:
		filters["boutique"] = assert_boutique_access(boutique)
	if status and status != "all":
		filters["status"] = status
	names = frappe.get_all("Maison Receiving Discrepancy", filters=filters, pluck="name", order_by="reported_at desc", limit=cint(limit) or 200)
	rows = [discrepancy_dict(frappe.get_doc("Maison Receiving Discrepancy", n)) for n in names]
	return {"discrepancies": rows, "count": len(rows)}


@frappe.whitelist()
def resolve_discrepancy(discrepancy: str, resolution: str, notes: Optional[str] = None) -> dict[str, Any]:
	"""Warehouse admin closes a discrepancy. *Short* units still sit in the store's in-transit
	warehouse: ``Write off`` issues them, ``Returned to warehouse`` transfers them back; ``Re-ship``
	raises a new request for the store; ``Accepted`` just closes it (e.g. an *Over* that the store keeps)."""
	assert_supply_admin()
	doc = frappe.get_doc("Maison Receiving Discrepancy", discrepancy)
	if doc.status == "Resolved":
		frappe.throw(_("Already resolved"), frappe.ValidationError)
	if resolution not in ("Write off", "Returned to warehouse", "Re-ship", "Accepted"):
		frappe.throw(_("Unknown resolution {0}").format(resolution), frappe.ValidationError)
	sh = frappe.get_doc("Maison Shipment", doc.shipment)
	qty = flt(doc.short_qty) if doc.type == "Short" else flt(doc.damaged_qty) if doc.type == "Damaged" else flt(doc.over_qty)
	se_name = None
	if doc.type == "Short" and qty > 0 and resolution in ("Write off", "Returned to warehouse"):
		company = frappe.db.get_value("Warehouse", sh.from_warehouse, "company")
		if resolution == "Write off":
			payload = {"stock_entry_type": "Material Issue", "purpose": "Material Issue", "from_warehouse": sh.transit_warehouse, "items": [{"item_code": doc.item_code, "qty": qty, "s_warehouse": sh.transit_warehouse}]}
		else:
			payload = {"stock_entry_type": "Material Transfer", "purpose": "Material Transfer", "from_warehouse": sh.transit_warehouse, "to_warehouse": sh.from_warehouse, "items": [{"item_code": doc.item_code, "qty": qty, "s_warehouse": sh.transit_warehouse, "t_warehouse": sh.from_warehouse}]}
		se = frappe.get_doc({"doctype": "Stock Entry", "company": company, "posting_date": nowdate(), "posting_time": nowtime(), "set_posting_time": 1, "remarks": f"Discrepancy {doc.name} ({doc.shipment})", **payload})
		se.flags.ignore_permissions = True
		se.insert()
		se.submit()
		se_name = se.name
	reship = None
	if resolution == "Re-ship" and qty > 0:
		req = create_request(doc.boutique, [{"item_code": doc.item_code, "qty": qty}], reason=f"Re-ship for discrepancy {doc.name}", priority="Urgent", from_warehouse=sh.from_warehouse)
		reship = req.name
	doc.resolution = resolution
	doc.status = "Resolved"
	doc.resolved_by = frappe.session.user
	doc.resolved_at = now_datetime()
	doc.stock_entry = se_name
	if notes:
		doc.notes = ((doc.notes or "") + "\n" + notes).strip()
	if reship:
		doc.notes = ((doc.notes or "") + f"\nRe-ship request {reship}").strip()
	doc.flags.ignore_permissions = True
	doc.save()
	publish_wall("discrepancy", doc.shipment, boutique=doc.boutique)
	out = discrepancy_dict(doc)
	out["reship_request"] = reship
	return out


# ---------------------------------------------------------------------------
# warehouse stock / vendor POs (admin desk)
# ---------------------------------------------------------------------------
@frappe.whitelist()
def warehouse_stock(q: Optional[str] = None, limit: int = 300) -> dict[str, Any]:
	"""Stock on hand at the main warehouse (+ reorder level when set)."""
	assert_supply_admin()
	wh = get_main_warehouse()
	filters: dict[str, Any] = {"warehouse": wh}
	bins = frappe.get_all("Bin", filters=filters, fields=["item_code", "actual_qty", "reserved_qty", "projected_qty"], order_by="item_code", limit=5000)
	codes = [b.item_code for b in bins]
	items = {r.name: r for r in frappe.get_all("Item", filters={"name": ("in", codes or ["__none__"])}, fields=["name", "item_name", "item_group", "maison_barcode", "image"])}
	levels = {r.parent: flt(r.warehouse_reorder_level) for r in frappe.get_all("Item Reorder", filters={"parent": ("in", codes or ["__none__"]), "warehouse": wh}, fields=["parent", "warehouse_reorder_level"])}
	rows = []
	needle = (q or "").strip().lower()
	for b in bins:
		it = items.get(b.item_code)
		if not it:
			continue
		if needle and needle not in f"{b.item_code} {it.item_name} {it.item_group} {it.maison_barcode or ''}".lower():
			continue
		rows.append({"item_code": b.item_code, "item_name": it.item_name, "item_group": it.item_group, "barcode": it.maison_barcode, "image": it.image, "actual_qty": flt(b.actual_qty), "reserved_qty": flt(b.reserved_qty), "projected_qty": flt(b.projected_qty), "reorder_level": levels.get(b.item_code, 0.0), "low": bool(levels.get(b.item_code)) and flt(b.actual_qty) <= levels.get(b.item_code, 0.0)})
	rows.sort(key=lambda r: (not r["low"], r["item_group"] or "", r["item_code"]))
	return {"warehouse": wh, "rows": rows[: cint(limit) or 300], "total": len(rows), "low": sum(1 for r in rows if r["low"])}


@frappe.whitelist()
def warehouse_low_stock() -> dict[str, Any]:
	assert_supply_admin()
	data = warehouse_stock(limit=5000)
	return {"warehouse": data["warehouse"], "rows": [r for r in data["rows"] if r["low"]]}


def _po_dict(po) -> dict[str, Any]:
	return {
		"name": po.name,
		"supplier": po.supplier,
		"supplier_name": po.supplier_name,
		"transaction_date": str(po.transaction_date) if po.transaction_date else None,
		"schedule_date": str(po.schedule_date) if po.schedule_date else None,
		"set_warehouse": po.set_warehouse,
		"status": po.status,
		"per_received": flt(po.per_received),
		"items": [
			{"name": r.name, "item_code": r.item_code, "item_name": r.item_name, "qty": flt(r.qty), "received_qty": flt(r.received_qty), "pending_qty": max(0.0, flt(r.qty) - flt(r.received_qty)), "warehouse": r.warehouse, "barcode": frappe.db.get_value("Item", r.item_code, "maison_barcode") or r.item_code}
			for r in po.items
		],
	}


def open_purchase_orders(warehouse: Optional[str]) -> list[dict[str, Any]]:
	if not warehouse:
		return []
	names = frappe.get_all("Purchase Order", filters={"docstatus": 1, "set_warehouse": warehouse, "per_received": ("<", 100), "status": ("not in", ("Closed", "Completed", "Cancelled"))}, pluck="name", order_by="schedule_date asc")
	return [_po_dict(frappe.get_doc("Purchase Order", n)) for n in names]


@frappe.whitelist()
def vendor_pos() -> dict[str, Any]:
	"""Inbound vendor Purchase Orders shipped to the main warehouse."""
	assert_supply_admin()
	wh = get_main_warehouse()
	return {"warehouse": wh, "purchase_orders": open_purchase_orders(wh)}


def receive_purchase_order(po_name: str, lines: Any, warehouse: Optional[str] = None) -> dict[str, Any]:
	"""Purchase Receipt against *po_name* for ``lines = [{item_code|name, qty}]`` (submitted as Administrator, owner = caller)."""
	from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_receipt

	po = frappe.get_doc("Purchase Order", po_name)
	if po.docstatus != 1:
		frappe.throw(_("Purchase Order {0} is not submitted").format(po_name), frappe.ValidationError)
	wanted: dict[str, float] = {}
	for raw in _loads(lines, []) or []:
		key = raw.get("name") or raw.get("item_code") or raw.get("item")
		if key:
			wanted[key] = flt(raw.get("qty", raw.get("received_qty")))
	if not wanted:
		frappe.throw(_("Nothing to receive"), frappe.ValidationError)
	user = frappe.session.user
	frappe.set_user("Administrator")
	try:
		pr = make_purchase_receipt(po_name)
		keep = []
		for row in pr.items:
			qty = wanted.get(row.purchase_order_item, wanted.get(row.item_code))
			if qty is None or qty <= 0:
				continue
			row.qty = qty
			row.received_qty = qty
			row.stock_qty = qty * flt(row.conversion_factor or 1)
			if warehouse:
				row.warehouse = warehouse
			keep.append(row)
		if not keep:
			frappe.throw(_("No matching Purchase Order lines"), frappe.ValidationError)
		pr.items = keep
		if warehouse:
			pr.set_warehouse = warehouse
		pr.owner = user
		pr.flags.ignore_permissions = True
		pr.insert()
		pr.submit()
	finally:
		frappe.set_user(user)
	return {"purchase_receipt": pr.name, "purchase_order": po_name, "lines": [{"item_code": r.item_code, "qty": flt(r.qty), "warehouse": r.warehouse} for r in pr.items]}


@frappe.whitelist()
def receive_vendor_po(po: str, lines: Any) -> dict[str, Any]:
	"""Warehouse admin receives a vendor PO at the main warehouse (scan / count)."""
	assert_supply_admin()
	return receive_purchase_order(po, lines, warehouse=get_main_warehouse())


# ---------------------------------------------------------------------------
# dashboard + print format
# ---------------------------------------------------------------------------
def supply_summary() -> dict[str, Any]:
	"""Command dashboard "Supply" tile: open requests, in transit, avg approve→ship hours, discrepancies."""
	open_requests = frappe.db.count("Maison Replenishment Request", {"status": "Pending Approval"})
	in_transit = frappe.db.count("Maison Shipment", {"status": "Shipped"})
	to_ship = frappe.db.count("Maison Shipment", {"status": ("in", ("Pending", "Picking", "Packed"))})
	rows = frappe.get_all("Maison Shipment", filters={"status": ("in", ("Shipped", "Received")), "approved_at": ("is", "set"), "shipped_at": ("is", "set")}, fields=["approved_at", "shipped_at"], order_by="shipped_at desc", limit=100)
	hours = [(get_datetime(r.shipped_at) - get_datetime(r.approved_at)).total_seconds() / 3600.0 for r in rows]
	avg = round(sum(hours) / len(hours), 1) if hours else None
	latest = frappe.get_all("Maison Shipment", filters={"status": ("in", OPEN_SHIPMENT_STATUSES)}, fields=["name", "boutique", "status", "carrier", "service", "tracking_status", "priority"], order_by="modified desc", limit=6)
	return {
		"open_requests": open_requests,
		"to_ship": to_ship,
		"in_transit": in_transit,
		"avg_approve_to_ship_hours": avg,
		"open_discrepancies": frappe.db.count("Maison Receiving Discrepancy", {"status": "Open"}),
		"received_today": frappe.db.count("Maison Shipment", {"status": "Received", "received_at": (">=", nowdate())}),
		"latest": latest,
	}


def packing_list_context(doc) -> dict[str, Any]:
	"""Jinja helper for ``Maison Packing List``: addresses, QR of the shipment, line barcodes (SVG data URIs)."""
	from maison_pos.utils import qr_svg_data_uri

	brand = {"brand_name": "CloudChaserz", "legal_name": "CloudChaserz"}
	try:
		from maison_pos.brand import get_brand

		brand = {**brand, **get_brand()}
	except Exception:
		pass
	site = frappe.utils.get_url()
	try:
		parcels = doc.get_parcels() or doc.default_parcels()
	except Exception:
		parcels = []
	lines = []
	for l in doc.get("lines") or []:
		code = l.barcode or l.item_code
		lines.append({"item_code": l.item_code, "item_name": l.item_name, "barcode": code, "barcode_svg": code128_svg(code), "qty": flt(l.picked_qty) or flt(l.qty), "bin_location": l.bin_location, "weight": round(flt(l.weight_per_unit) * (flt(l.picked_qty) or flt(l.qty)), 3)})
	return {
		"brand": brand,
		"ship_from": ship_from_address(),
		"ship_to": ship_to_address(doc.boutique),
		"qr": qr_svg_data_uri(f"{site}/warehouse/shipment/{doc.name}", scale=4),
		"qr_payload": f"MSH:{doc.name}",
		"qr_code_svg": qr_svg_data_uri(f"MSH:{doc.name}", scale=3),
		"parcels": parcels,
		"lines": lines,
		"units": sum(l["qty"] for l in lines),
		"weight": round(sum(flt(p.get("weight")) for p in parcels), 2) or flt(doc.est_weight),
	}


_CODE128_PATTERNS = None


def code128_svg(text: str, height: int = 40, module: int = 2) -> str:
	"""Minimal Code 128-B encoder → SVG data URI (pure python; enough for a packing list)."""
	import base64

	global _CODE128_PATTERNS
	if _CODE128_PATTERNS is None:
		_CODE128_PATTERNS = _load_code128()
	chars = [c if 32 <= ord(c) <= 126 else "?" for c in str(text)]
	values = [104] + [ord(c) - 32 for c in chars]
	check = (values[0] + sum(i * v for i, v in enumerate(values[1:], start=1))) % 103
	seq = values + [check, 106]
	bars = "".join(_CODE128_PATTERNS[v] for v in seq) + "11"  # stop pattern is 2331112 incl. the final bar pair
	x = 0
	rects = []
	for i, w in enumerate(bars):
		w = int(w)
		if i % 2 == 0:
			rects.append(f'<rect x="{x}" y="0" width="{w * module}" height="{height}"/>')
		x += w * module
	svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{x}" height="{height}" viewBox="0 0 {x} {height}" fill="#000">{"".join(rects)}</svg>'
	return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode("ascii")


def _load_code128() -> list[str]:
	raw = (
		"212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 "
		"123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 "
		"232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 "
		"313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 "
		"111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 "
		"111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 "
		"114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112"
	)
	return raw.split()
