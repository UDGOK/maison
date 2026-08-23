"""v0.6 D3 — backfill the store stamp on POS documents that were created without one.

``erpnext.controllers.sales_and_purchase_return.make_return_doc`` blanks ``set_warehouse`` on a
credit note, so every return created before the fix carries no warehouse. Store scoping for
``Sales Invoice`` rested on the per-user *Warehouse* User Permission, which therefore never
matched a return: any store manager could list every other store's credit notes through
``frappe.client.get_list`` / ``/api/resource/Sales Invoice``.

The list query is now scoped on ``maison_boutique`` (``maison_pos.scoping.sales_invoice_query``),
so the leak is closed regardless of the stamp — but the stamp is what the *desk* User Permission
uses, so put it back on the existing rows:

* ``maison_boutique`` inherited from ``return_against`` when it is missing;
* ``set_warehouse`` = the store's selling warehouse when it is missing.

Submitted documents are updated with ``db.set_value(..., update_modified=False)``: neither field
takes part in any calculation (``set_warehouse`` is a header default, the rows already carry
their own warehouse), so no ledger is touched. Idempotent.
"""

from __future__ import annotations

import frappe


def execute() -> None:
	if not frappe.db.has_column("Sales Invoice", "maison_boutique"):
		return

	# 1. returns that lost the boutique stamp -> inherit it from the invoice they reverse
	orphans = frappe.db.sql(
		"""select si.name, src.maison_boutique
		from `tabSales Invoice` si
		join `tabSales Invoice` src on src.name = si.return_against
		where si.is_return = 1
			and (si.maison_boutique is null or si.maison_boutique = '')
			and src.maison_boutique is not null and src.maison_boutique <> ''""",
		as_dict=True,
	)
	for row in orphans:
		frappe.db.set_value("Sales Invoice", row.name, "maison_boutique", row.maison_boutique, update_modified=False)

	# 2. anything stamped with a store but no warehouse -> the store's selling warehouse
	warehouses = {
		b.name: b.warehouse
		for b in frappe.get_all("Maison Boutique", fields=["name", "warehouse"])
		if b.warehouse
	}
	if not warehouses:
		if not frappe.flags.in_test:
			frappe.db.commit()
		return
	missing = frappe.get_all(
		"Sales Invoice",
		filters={
			"maison_boutique": ("in", list(warehouses)),
			"set_warehouse": ("in", ("", None)),
		},
		fields=["name", "maison_boutique"],
		limit_page_length=0,
	)
	for row in missing:
		frappe.db.set_value("Sales Invoice", row.name, "set_warehouse", warehouses[row.maison_boutique], update_modified=False)

	if not frappe.flags.in_test:
		frappe.db.commit()
	print(f"maison_pos: stamped {len(orphans)} return(s) with their store and {len(missing)} invoice(s) with their warehouse")
