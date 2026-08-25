"""v1.2 — the wholesale fields and the chain-wide markup, on a site that is already live.

The client's site is running and will not be reinstalled, so every piece of v1.2's storage has to
arrive as a named, ordered, reported step rather than as a side effect of a table growing:

* ``AWANZ Shipment Line`` gains ``cost_rate`` and ``wholesale_rate``;
* ``AWANZ Shipment`` gains ``cost_total``, ``wholesale_total`` and ``value_stamped_at``;
* ``Item`` gains ``maison_wholesale_rate`` — the per-item override;
* ``AWANZ POS Settings`` gains ``wholesale_markup_pct``, and it is **filled in with 50** because a
  Custom Field default only fires when the single is saved through the form, and this site's
  settings were saved long before the field existed.

**Nothing is backfilled** (SPEC_v1.2 §B, deliberately). A consignment that shipped before this
patch ran carries no stamp, and the statement shows it as *not priced* rather than valuing March's
despatch at August's moving average. ``value_stamped_at`` is what tells the two apart: a Currency
column added to an existing table reads 0, not NULL, so the absence of a stamp had to be recorded
as a fact of its own.

Idempotent: re-running reloads the same doctypes, re-asserts the same custom fields and leaves an
already-set markup exactly where the client put it (0% is a legitimate answer — ship at cost — so
"already set" is tested for *absence*, not for falsiness).
"""

from __future__ import annotations

import frappe


def execute() -> None:
	for doctype in ("awanz_shipment_line", "awanz_shipment"):
		frappe.reload_doc("awanz_pos", "doctype", doctype)
	frappe.reload_doc("awanz_pos", "report", "awanz_store_statement")

	from maison_pos.setup.install_v12_pricing import create_fields, ensure_markup_default, stored_markup_pct

	had_markup = stored_markup_pct() is not None
	create_fields()
	pct = ensure_markup_default()
	frappe.clear_cache()
	frappe.db.commit()

	print(
		"maison_pos: v1.2 wholesale — AWANZ Shipment Line.cost_rate / .wholesale_rate, "
		"AWANZ Shipment.cost_total / .wholesale_total / .value_stamped_at, Item.maison_wholesale_rate"
	)
	print(
		f"maison_pos: v1.2 wholesale — chain markup {'already set at' if had_markup else 'defaulted to'} {pct:g}%"
	)
	report_unstamped()


def report_unstamped() -> int:
	"""Say out loud how many despatched consignments carry no value, so nobody is surprised.

	These are the ones the month-end statement will show as *not priced*. Backfilling them is out
	of scope for v1.2 by decision, not by omission: the only cost available today is today's
	moving average, and stamping a March consignment with it would put a number on a statement
	that the client could not reconcile to anything.
	"""
	if not frappe.db.table_exists("AWANZ Shipment"):  # pragma: no cover
		return 0
	count = frappe.db.count("AWANZ Shipment", {"status": ("in", ("Shipped", "Received")), "value_stamped_at": ("is", "not set")})
	if count:
		print(
			f"maison_pos: v1.2 wholesale — {count} consignment(s) shipped before this release carry no "
			"stamped value; the store statement reports them as 'not priced' and never guesses one"
		)
	return count
