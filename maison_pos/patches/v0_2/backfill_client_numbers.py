"""v0.2: assign ``maison_client_number`` to every existing Customer.

New customers receive their number in ``events.customer.before_insert``; this patch covers
customers created before the field existed. Runs after model sync (custom fields are
applied by fixtures / ``after_migrate``), and is idempotent.
"""

from __future__ import annotations

import frappe

from maison_pos.setup.install import create_custom_fields_from_fixture


def execute() -> None:
	if not frappe.db.exists("DocType", "Customer"):
		return
	create_custom_fields_from_fixture()
	frappe.reload_doctype("Customer")
	if not frappe.db.has_column("Customer", "maison_client_number"):
		return
	from maison_pos.identifiers import assign_client_number

	missing = frappe.get_all("Customer", filters={"maison_client_number": ("in", ("", None))}, pluck="name")
	for name in missing:
		assign_client_number(name)
	if missing:
		frappe.db.commit()
