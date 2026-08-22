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
	demo.seed(commit=False)
	setattr(frappe.local, SEEDED_FLAG, True)


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
