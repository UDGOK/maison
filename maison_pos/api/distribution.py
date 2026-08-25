"""Distribution API (v1.1 §A) — ``maison_pos.api.distribution.*``.

Houston pushes stock **out** to the stores. Everything here is a thin, permission-checked wrapper
over :mod:`maison_pos.distribution`; the documents themselves are still created by the existing
``maison_pos.api.shipping.create_request`` / ``approve`` pair, so a pushed shipment is an ordinary
shipment on the wall, in the pick list and on the store's Receive screen.

======================  ==========================================================================
``plan``                what Houston holds, what is committed, and every store's position
``suggest_split``       ``even`` / ``velocity`` / ``topup`` allocation helpers
``send``                create + approve one shipment per store, all or nothing
``stores``              the enabled shops a push may address (the sheet's row list)
======================  ==========================================================================

Permissions: **AWANZ Warehouse Admin** and **AWANZ Head Office** only (client decision 1 — buying
and distribution are both centralised in Houston). A store manager calling :func:`send` for their
own store is refused: pushing is Houston's act, not the store's.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe

from maison_pos import distribution as dist_lib

__all__ = ["plan", "suggest_split", "send", "stores"]


@frappe.whitelist()
def stores() -> dict[str, Any]:
	"""The enabled shops a distribution may address, in store-code order.

	The head-office warehouse row is never one of them — Houston cannot push to itself.
	"""
	dist_lib.assert_distribution_admin()
	rows = dist_lib.store_rows()
	return {"stores": rows, "count": len(rows), "warehouse": dist_lib.main_warehouse()}


@frappe.whitelist()
def plan(item_codes: Any = None, boutiques: Any = None, days: Any = dist_lib.VELOCITY_DAYS) -> dict[str, Any]:
	"""Per item: HOU-WH on hand / committed / available, plus a row per store.

	``item_codes`` accepts a list, a JSON array or a comma-separated string. Each store row
	carries its on-hand, its 28-day velocity, its days of cover and whether it has ever sold the
	item — which is what makes an allocation a decision rather than a guess.
	"""
	dist_lib.assert_distribution_admin()
	return dist_lib.plan(item_codes, boutiques=boutiques, days=days)


@frappe.whitelist()
def suggest_split(item_code: str, qty: Any, mode: str = "even", boutiques: Any = None, cover_days: Any = None) -> dict[str, Any]:
	"""Allocation helper: ``even``, ``velocity`` or ``topup`` (see :mod:`maison_pos.distribution`).

	Returns a row for **every** candidate store, allocated or not, so the sheet fills all of its
	quantity boxes from one call, plus ``left_at_warehouse`` for the running footer.
	"""
	dist_lib.assert_distribution_admin()
	return dist_lib.suggest_split(item_code, qty, mode=mode, boutiques=boutiques, cover_days=cover_days)


# POST only: this one creates shipments, and a state-changing endpoint reachable by GET is a
# link away from being triggered by someone else's page (Frappe only checks CSRF on non-GET).
@frappe.whitelist(methods=["POST"])
def send(lines: Any, reason: Optional[str] = None, priority: str = "Normal") -> dict[str, Any]:
	"""Send it: one ``AWANZ Replenishment Request`` + one ``AWANZ Shipment`` per store.

	``lines = [{boutique, item_code, qty}]``. Validated in full before anything is written — a
	store that is disabled, an item that is not stock, a quantity at or below zero, or a total
	beyond what Houston actually has all refuse the **whole** distribution with the shortfall
	named per item. Nothing is left half-sent.
	"""
	dist_lib.assert_distribution_admin()
	return dist_lib.send(lines, reason=reason, priority=priority)
