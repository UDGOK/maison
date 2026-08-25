"""v1.2 "What each store owes" install glue — idempotent, called from ``after_install`` / ``after_migrate``.

Two custom fields and one default, and that is the whole of §A's storage:

* ``Item.maison_wholesale_rate`` (Currency) — the per-item override. Blank means "use the rule".
  ``Item`` is an ERPNext doctype, so the fieldname carries the app's ``maison_`` prefix.
* ``AWANZ POS Settings.wholesale_markup_pct`` (Percent, 50) — the chain-wide rule. Our own
  doctype, so no prefix, exactly like ``purchase_cover_days`` in v1.0.

Nothing here touches accounting: no account, no ledger, no receivable. The wholesale figure is
reporting only (SPEC_v1.2 client decision 6).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
from frappe.utils import flt

from maison_pos.pricing.wholesale import DEFAULT_MARKUP_PCT, MARKUP_FIELD, OVERRIDE_FIELD

CUSTOM_FIELDS: dict[str, list[dict[str, Any]]] = {
	"Item": [
		{
			"fieldname": OVERRIDE_FIELD,
			"fieldtype": "Currency",
			"label": "Wholesale Price (to stores)",
			"insert_after": "maison_taxable",
			"description": "What a store pays Houston for one unit. Leave blank to use the chain-wide markup in AWANZ POS Settings.",
		},
	],
	"AWANZ POS Settings": [
		{
			"fieldname": "wholesale_section",
			"fieldtype": "Section Break",
			"label": "Wholesale (stock priced to the stores)",
			"insert_after": "purchase_cover_days",
			"collapsible": 1,
		},
		{
			"fieldname": MARKUP_FIELD,
			"fieldtype": "Percent",
			"label": "Wholesale markup on cost (%)",
			"default": str(int(DEFAULT_MARKUP_PCT)),
			"insert_after": "wholesale_section",
			"description": "One price for every store. A shipment is valued at the warehouse's moving-average cost plus this percentage, unless the item carries its own wholesale price. Reporting only — it creates no invoice and no receivable.",
		},
	],
}


def create_fields() -> None:
	existing = {dt: fields for dt, fields in CUSTOM_FIELDS.items() if frappe.db.exists("DocType", dt)}
	if existing:
		create_custom_fields(existing, ignore_validate=frappe.flags.in_install, update=True)
		for doctype in existing:
			frappe.clear_cache(doctype=doctype)


def stored_markup_pct() -> float | None:
	"""What the site has actually stored for the markup, or ``None`` when it has never been set.

	Read straight out of ``tabSingles`` rather than through ``frappe.db.get_single_value``, which
	raises for a field the doctype's meta does not carry yet — and the whole point of asking is to
	be able to ask *before* the custom field exists.
	"""
	try:
		rows = frappe.db.sql("select value from `tabSingles` where doctype = %s and field = %s", ("AWANZ POS Settings", MARKUP_FIELD))
	except Exception:  # pragma: no cover — no database yet
		return None
	if not rows or rows[0][0] in (None, ""):
		return None
	return flt(rows[0][0])


def ensure_markup_default() -> float:
	"""Fill the chain-wide markup on a site whose settings single predates v1.2.

	A Custom Field's ``default`` only fires when the single is saved through the form, and a live
	site's settings were saved long before this field existed — so the stored value stays *absent*
	until somebody opens the page. Zero is a legitimate markup (ship at cost), so "absent" has to
	mean absent rather than falsy: only a missing value is filled in.
	"""
	if not frappe.db.exists("DocType", "AWANZ POS Settings"):  # pragma: no cover
		return DEFAULT_MARKUP_PCT
	current = stored_markup_pct()
	if current is None:
		frappe.db.set_single_value("AWANZ POS Settings", MARKUP_FIELD, DEFAULT_MARKUP_PCT)
		frappe.clear_document_cache("AWANZ POS Settings", "AWANZ POS Settings")
		return DEFAULT_MARKUP_PCT
	return float(current)


def setup_v12_pricing(commit: bool = False) -> dict[str, Any]:
	create_fields()
	pct = ensure_markup_default()
	if commit:
		frappe.db.commit()
	return {"markup_pct": pct}
