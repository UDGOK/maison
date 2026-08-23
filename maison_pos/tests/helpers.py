"""Shared test helpers: seed demo data once per class, build POSInvoice payloads."""

from __future__ import annotations

import uuid
from typing import Any

import frappe

from maison_pos.setup import demo

SEEDED_FLAG = "_maison_demo_seeded"


def ensure_demo_data() -> None:
	"""Run the demo seed inside the current test transaction (idempotent)."""
	if getattr(frappe.local, SEEDED_FLAG, False):
		return
	frappe.set_user("Administrator")
	demo.seed(commit=False, vertical="Jewellery")  # v0.6 N: the suites seed the jewellery world explicitly
	setattr(frappe.local, SEEDED_FLAG, True)


def ensure_stock(item_code: str, boutique: str, qty: float = 25) -> float:
	"""Guarantee at least *qty* free units of a non-serialized item at *boutique*.

	The suites run on a shared bench that e2e runs also sell through, so a test that rings up a
	stock item cannot assume the demo opening stock is still there (see INTEGRATION_NOTES v0.4 #13).
	The receipt is posted inside the caller's test transaction and rolled back with it.
	"""
	warehouse = frappe.db.get_value("Maison Boutique", boutique, ["warehouse", "company"], as_dict=True)
	if not warehouse:
		return 0.0
	have = frappe.utils.flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse.warehouse}, "actual_qty"))
	if have >= qty:
		return have
	se = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Receipt",
			"purpose": "Material Receipt",
			"company": warehouse.company,
			"to_warehouse": warehouse.warehouse,
			"posting_date": frappe.utils.nowdate(),
			"posting_time": frappe.utils.nowtime(),
			"set_posting_time": 1,
			"items": [{"item_code": item_code, "qty": qty, "t_warehouse": warehouse.warehouse, "basic_rate": 10, "allow_zero_valuation_rate": 1}],
		}
	)
	se.flags.ignore_permissions = True
	se.insert()
	se.submit()
	return have + qty


def first_serial(item_code: str, boutique: str) -> str | None:
	warehouse = frappe.db.get_value("Maison Boutique", boutique, "warehouse")
	return frappe.db.get_value("Serial No", {"item_code": item_code, "warehouse": warehouse, "status": "Active"}, "name", order_by="name")


def pos_invoice(
	boutique: str = "NYC-5AV",
	items: list[dict[str, Any]] | None = None,
	payments: list[dict[str, Any]] | None = None,
	customer: str | None = None,
	**extra: Any,
) -> dict[str, Any]:
	items = items or [{"item_code": "AC-012", "qty": 1, "rate": 160}]
	if payments is None:
		net = sum(float(i["rate"]) * float(i.get("qty", 1)) for i in items)
		tax_rate = 8.875 if boutique == "NYC-5AV" else 10.25 if boutique == "CHI-OAK" else 7.0
		payments = [{"mode_of_payment": "Card", "amount": round(net * (1 + tax_rate / 100), 2)}]
	payload = {
		"offline_uuid": str(uuid.uuid4()),
		"boutique": boutique,
		"associate": frappe.db.get_value("Maison Associate", {"boutique": boutique, "role": "Associate"}, "name"),
		"device_id": "TEST-IPAD-1",
		"customer": customer,
		"posting_datetime": frappe.utils.now_datetime().isoformat(),
		"items": items,
		"payments": payments,
	}
	payload.update(extra)
	return payload
