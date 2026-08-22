"""v0.4 D/E install glue (idempotent, run from after_install / after_migrate).

* ``Exchange Credit`` mode of payment + clearing account for every company with a boutique.
* ``<code> Damaged`` warehouse per boutique (returns in Damaged condition land there).
"""

from __future__ import annotations

import frappe


def ensure_damaged_warehouse(boutique: str) -> str | None:
	row = frappe.db.get_value("Maison Boutique", boutique, ["company", "damaged_warehouse", "warehouse"], as_dict=True)
	if not row or not row.company:
		return None
	if row.damaged_warehouse and frappe.db.exists("Warehouse", row.damaged_warehouse):
		return row.damaged_warehouse
	abbr = frappe.get_cached_value("Company", row.company, "abbr")
	name = f"{boutique} Damaged - {abbr}"
	if not frappe.db.exists("Warehouse", name):
		parent = frappe.db.get_value("Warehouse", row.warehouse, "parent_warehouse") or f"All Warehouses - {abbr}"
		doc = frappe.get_doc({"doctype": "Warehouse", "warehouse_name": f"{boutique} Damaged", "company": row.company, "parent_warehouse": parent})
		doc.flags.ignore_permissions = True
		doc.insert(ignore_if_duplicate=True)
		name = doc.name
	frappe.db.set_value("Maison Boutique", boutique, "damaged_warehouse", name, update_modified=False)
	frappe.clear_document_cache("Maison Boutique", boutique)
	return name


def setup_v04_inventory() -> None:
	if not frappe.db.exists("DocType", "Maison Boutique") or not frappe.db.table_exists("Maison Boutique"):
		return
	if not frappe.db.has_column("Maison Boutique", "damaged_warehouse"):
		return
	from maison_pos.api.returns import ensure_exchange_mode_of_payment

	for company in {r.company for r in frappe.get_all("Maison Boutique", fields=["company"]) if r.company}:
		if frappe.db.exists("Company", company):
			ensure_exchange_mode_of_payment(company)
	for b in frappe.get_all("Maison Boutique", pluck="name"):
		ensure_damaged_warehouse(b)
