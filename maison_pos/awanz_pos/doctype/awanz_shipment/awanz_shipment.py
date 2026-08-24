"""AWANZ Shipment (v0.6 P): one warehouse → store consignment.

Lifecycle ``Pending → Picking → Packed → Shipped → Received`` (``Cancelled`` before Shipped).
Stock moves twice: at **Shipped** a Material Transfer posts ``from_warehouse → <store> In Transit``;
at **Received** (``maison_pos.api.inventory.receive_shipment``) ``In Transit → store`` for what
arrived intact, ``In Transit → Damaged`` for damaged units; short / over quantities raise a
``AWANZ Receiving Discrepancy`` for the warehouse admin. All transitions go through
``maison_pos.api.shipping`` — the document itself only validates and estimates weight / dims.
"""

from __future__ import annotations

import json

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt

STATUSES = ("Pending", "Picking", "Packed", "Shipped", "Received", "Cancelled")
STATUS_ORDER = {s: i for i, s in enumerate(STATUSES)}
DEFAULT_UNIT_WEIGHT_KG = 0.15
CARTON_CM = (40.0, 30.0, 25.0)
CARTON_TARE_KG = 0.35
CARTON_CAPACITY_KG = 12.0


class AWANZShipment(Document):
	def validate(self) -> None:
		if not self.lines:
			frappe.throw(_("A shipment needs at least one line"), frappe.ValidationError)
		for line in self.lines:
			if flt(line.qty) <= 0:
				frappe.throw(_("Quantity must be positive ({0})").format(line.item_code), frappe.ValidationError)
			if line.weight_per_unit is None or not flt(line.weight_per_unit):
				line.weight_per_unit = item_weight_kg(line.item_code)
			if not line.barcode:
				line.barcode = frappe.db.get_value("Item", line.item_code, "maison_barcode") or line.item_code
			if not line.bin_location:
				line.bin_location = bin_location_for(line.item_code)
			if not line.uom:
				line.uom = frappe.db.get_value("Item", line.item_code, "stock_uom") or "Nos"
		if self.from_warehouse == self.to_warehouse:
			frappe.throw(_("Source and destination warehouse are the same"), frappe.ValidationError)
		if not self.created_by:
			self.created_by = frappe.session.user
		self.estimate_parcel()
		self._sync_parcels()

	def estimate_parcel(self) -> None:
		"""Weight from ``weight_per_unit`` × qty, dims from the standard carton (several when heavy)."""
		weight = sum(flt(line.weight_per_unit or DEFAULT_UNIT_WEIGHT_KG) * flt(line.qty) for line in self.lines)
		cartons = max(1, int((weight + CARTON_CAPACITY_KG - 0.001) // CARTON_CAPACITY_KG))
		self.est_weight = round(weight + cartons * CARTON_TARE_KG, 3)
		self.est_length, self.est_width, self.est_height = CARTON_CM
		if cartons > 1:
			self.est_height = CARTON_CM[2] * cartons

	def _sync_parcels(self) -> None:
		parcels = self.get_parcels()
		if parcels:
			self.packages = len(parcels)
			self.total_weight = round(sum(flt(p.get("weight")) for p in parcels), 3)
		else:
			self.packages = self.packages or 0
			self.total_weight = self.total_weight or 0

	def get_parcels(self) -> list[dict]:
		raw = self.parcels
		if not raw:
			return []
		if isinstance(raw, str):
			try:
				raw = json.loads(raw)
			except ValueError:
				return []
		return [p for p in (raw or []) if isinstance(p, dict)]

	def default_parcels(self) -> list[dict]:
		"""Parcels derived from the estimate (used when the packer did not enter any)."""
		cartons = max(1, int(round(flt(self.est_height) / CARTON_CM[2])) if self.est_height else 1)
		each = round(flt(self.est_weight) / cartons, 3)
		return [{"length": CARTON_CM[0], "width": CARTON_CM[1], "height": CARTON_CM[2], "weight": each} for _ in range(cartons)]

	@property
	def units(self) -> float:
		return sum(flt(line.qty) for line in self.lines)

	def age_seconds(self) -> float:
		from frappe.utils import now_datetime, get_datetime

		start = self.approved_at or self.creation
		return (now_datetime() - get_datetime(start)).total_seconds() if start else 0.0


def item_weight_kg(item_code: str) -> float:
	"""``Item.weight_per_unit`` in kg (grams converted), else a sensible default."""
	row = frappe.db.get_value("Item", item_code, ["weight_per_unit", "weight_uom"], as_dict=True)
	if not row or not flt(row.weight_per_unit):
		return DEFAULT_UNIT_WEIGHT_KG
	w = flt(row.weight_per_unit)
	uom = (row.weight_uom or "").lower()
	if uom in ("g", "gram", "grams"):
		return round(w / 1000.0, 4)
	if uom in ("lb", "lbs", "pound"):
		return round(w * 0.4536, 4)
	if uom in ("oz", "ounce"):
		return round(w * 0.02835, 4)
	return w


def bin_location_for(item_code: str) -> str:
	"""Deterministic aisle / bay / shelf from the item group + code (no WMS bins in ERPNext by default)."""
	group = frappe.db.get_value("Item", item_code, "item_group") or "General"
	aisle = chr(ord("A") + (sum(ord(c) for c in group) % 6))
	h = sum(ord(c) * (i + 1) for i, c in enumerate(item_code))
	return f"{aisle}-{(h % 12) + 1:02d}-{(h // 12) % 4 + 1}"
