"""Scents of Arabia opening distribution (v1.3): everything Houston received from the vendor goes
to **Owasso** — the client's instruction ("all this inventory will go to the Owasso store, nowhere
else yet; other locations show zero"). East Tulsa gets nothing.

On the v1.1 rails, end to end: ``distribution.send`` (one request + one shipment, approved in the
same action, the v1.2 wholesale value stamped when it ships) → pick → pack → ship (in-transit leg)
→ the store's ``receive_shipment`` (in transit → OK-OWA). The wall, the packing list and the
Owasso Receive screen show the same shipment a real push would.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import flt

from maison_pos.setup.scentsofarabia import COMPANY

DESTINATION = "OK-OWA"
REASON = "Opening stock — Scents of Arabia Owasso (vendor invoices 99139 / 99464 / 99595)"


def _on_hand(warehouse: str) -> list[dict[str, Any]]:
	rows = frappe.get_all("Bin", filters={"warehouse": warehouse, "actual_qty": (">", 0)}, fields=["item_code", "actual_qty"])
	return [r for r in rows if frappe.db.get_value("Item", r["item_code"], "is_stock_item")]


def push_to_owasso() -> dict[str, Any]:
	"""Send every unit at HOU-WH to Owasso and receive it there. Idempotent: a shipment carrying
	this reason that already exists is reported, not repeated."""
	from maison_pos import distribution
	from maison_pos.api import shipping
	from maison_pos.api.inventory import receive_shipment
	from maison_pos.setup.scentsofarabia.stores import WAREHOUSE_CODE, warehouse_name

	existing = frappe.get_all("AWANZ Shipment", filters={"boutique": DESTINATION, "status": ("!=", "Cancelled")}, fields=["name", "status"])
	req = frappe.get_all("AWANZ Replenishment Request", filters={"boutique": DESTINATION, "reason": REASON}, pluck="name")
	if req:
		return {"skipped": "opening push already made", "requests": req, "shipments": existing}
	source = warehouse_name(WAREHOUSE_CODE)
	stock = _on_hand(source)
	if not stock:
		return {"skipped": f"nothing on hand at {source}"}
	lines = [{"boutique": DESTINATION, "item_code": r["item_code"], "qty": flt(r["actual_qty"])} for r in stock]
	# ERPNext caches the warehouse → account map on ``frappe.flags`` for the life of the job; the
	# receipts above built it before the stores' transit warehouses existed, so drop it here
	frappe.flags.pop("warehouse_account_map", None)
	sent = distribution.send(lines, reason=REASON, priority="Normal")
	out: dict[str, Any] = {"sent": sent, "received": []}
	for sh in sent["shipments"]:
		name = sh["name"] if isinstance(sh, dict) else sh
		shipping.pick(name)
		shipping.pack(name)
		shipping.ship(name)
		rec = receive_shipment(name, lines=None, final=1, notes="Opening stock received at Owasso (seed)")
		out["received"].append({"shipment": name, "status": rec.get("status") if isinstance(rec, dict) else None})
	out["units"] = sum(flt(r["actual_qty"]) for r in stock)
	out["items"] = len(stock)
	out["owasso_on_hand"] = float(frappe.db.sql("select coalesce(sum(actual_qty),0) from tabBin where warehouse=%s", warehouse_name(DESTINATION))[0][0] or 0)
	out["houston_on_hand"] = float(frappe.db.sql("select coalesce(sum(actual_qty),0) from tabBin where warehouse=%s", source)[0][0] or 0)
	return out
