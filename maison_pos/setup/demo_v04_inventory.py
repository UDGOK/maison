"""v0.4 D/E demo seed — called from ``maison_pos.setup.demo.seed`` (idempotent).

* Item Reorder levels per boutique warehouse for accessories and bridal bands.
* ``<code> Damaged`` warehouse per boutique (+ ``Exchange Credit`` tender).
* Two readers per boutique (Verifone V660p with printer, Stripe S710 without), simulated ids.
* Two sample open stock alerts (run the scan afterwards to refresh them from real bins).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import flt, now_datetime

from maison_pos.setup.install_v04_inventory import ensure_damaged_warehouse

# item_code -> (reorder_level, reorder_qty)
REORDER_LEVELS: dict[str, tuple[int, int]] = {
	"AC-001": (5, 10), "AC-002": (4, 8), "AC-003": (6, 12), "AC-004": (4, 8), "AC-005": (4, 8), "AC-006": (3, 6),
	"AC-007": (2, 4), "AC-008": (8, 15), "AC-009": (5, 10), "AC-010": (10, 20), "AC-011": (10, 20), "AC-012": (12, 24),
	"BR-006": (4, 8), "BR-007": (4, 8), "BR-008": (3, 6), "BR-009": (2, 4),
}

# two sample alerts: items whose level is deliberately above demo stock in one boutique
SAMPLE_ALERTS: list[tuple[str, str]] = [("AC-007", "MIA-DD"), ("BR-009", "CHI-OAK")]

READERS: list[dict[str, Any]] = [
	{"label": "Counter 1 · V660p", "device_type": "verifone_v660p", "has_printer": 1},
	{"label": "Roaming · S710", "device_type": "stripe_s710", "has_printer": 0},
]


def ensure_reorder_levels() -> int:
	n = 0
	warehouses = [(b.name, b.warehouse) for b in frappe.get_all("AWANZ Store", fields=["name", "warehouse"])]
	for code, (level, qty) in REORDER_LEVELS.items():
		if not frappe.db.exists("Item", code):
			continue
		item = frappe.get_doc("Item", code)
		changed = False
		existing = {r.warehouse for r in item.reorder_levels}
		for boutique, wh in warehouses:
			if wh in existing:
				continue
			lv, rq = level, qty
			if (code, boutique) in SAMPLE_ALERTS:
				# make sure the sample is below its level regardless of demo sales
				actual = flt(frappe.db.get_value("Bin", {"item_code": code, "warehouse": wh}, "actual_qty"))
				lv = int(max(level, actual + 2))
			item.append("reorder_levels", {"warehouse_group": wh, "warehouse": wh, "warehouse_reorder_level": lv, "warehouse_reorder_qty": rq, "material_request_type": "Transfer"})
			changed = True
			n += 1
		if changed:
			item.flags.ignore_permissions = True
			item.flags.ignore_version = True
			item.save()
	return n


def ensure_readers() -> int:
	n = 0
	for b in frappe.get_all("AWANZ Store", pluck="name"):
		doc = frappe.get_doc("AWANZ Store", b)
		if doc.get("readers"):
			continue
		for i, spec in enumerate(READERS, start=1):
			doc.append("readers", {**spec, "stripe_reader_id": f"tmr_sim_{b.lower().replace('-', '')}_{i}", "enabled": 1, "serial_number": f"SIM-{b}-{i:02d}"})
			n += 1
		doc.flags.ignore_permissions = True
		doc.save()
	return n


def ensure_sample_alerts() -> list[str]:
	created = []
	for code, boutique in SAMPLE_ALERTS:
		wh = frappe.db.get_value("AWANZ Store", boutique, "warehouse")
		if not wh or not frappe.db.exists("Item", code):
			continue
		if frappe.db.exists("AWANZ Stock Alert", {"item_code": code, "warehouse": wh, "status": ("in", ("Open", "Acknowledged"))}):
			continue
		level = frappe.db.get_value("Item Reorder", {"parent": code, "warehouse": wh}, ["warehouse_reorder_level", "warehouse_reorder_qty"], as_dict=True) or {}
		qty = flt(frappe.db.get_value("Bin", {"item_code": code, "warehouse": wh}, "actual_qty"))
		doc = frappe.get_doc(
			{
				"doctype": "AWANZ Stock Alert",
				"item_code": code,
				"warehouse": wh,
				"boutique": boutique,
				"status": "Open",
				"qty": qty,
				"reorder_level": flt(level.get("warehouse_reorder_level")),
				"reorder_qty": flt(level.get("warehouse_reorder_qty")),
				"first_seen": now_datetime(),
				"last_seen": now_datetime(),
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		created.append(doc.name)
	return created


def seed_inventory_v04() -> dict[str, Any]:
	from maison_pos.api.returns import ensure_exchange_mode_of_payment

	for company in {r.company for r in frappe.get_all("AWANZ Store", fields=["company"]) if r.company}:
		ensure_exchange_mode_of_payment(company)
	damaged = [ensure_damaged_warehouse(b) for b in frappe.get_all("AWANZ Store", pluck="name")]
	levels = ensure_reorder_levels()
	readers = ensure_readers()
	alerts = ensure_sample_alerts()
	return {"damaged_warehouses": damaged, "reorder_levels_added": levels, "readers_added": readers, "sample_alerts": alerts}
