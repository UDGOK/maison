"""Sales Invoice document events (registered in hooks.doc_events)."""

from __future__ import annotations

import frappe
from frappe import _

from maison_pos.identifiers import new_receipt_token
from maison_pos.utils import publish_sale, touch_last_seen


def stamp_store(doc) -> None:
	"""Make sure a POS document carries its store — on the header **and** on ``set_warehouse``.

	v0.6 D3: ``erpnext...make_sales_return`` blanks ``set_warehouse`` on a credit note, and store
	scoping for ``Sales Invoice`` used to rest entirely on the per-user *Warehouse* User
	Permission, which then matched nothing — every store's returns were listable by any store
	manager. Both halves are repaired here so that *every* path that creates a return (the POS
	returns/exchange API, ``sales.void``, the history seed, a desk credit note) is stamped:

	* ``maison_boutique`` is inherited from the invoice being returned when it is missing;
	* ``set_warehouse`` falls back to the store's selling warehouse — the same warehouse the
	  User Permission carries. ERPNext's ``reset_default_field_value`` clears the header field
	  again whenever the item rows disagree (a mixed Sellable / Damaged return), which is why
	  this runs in ``before_submit``, after validation.
	"""
	if not doc.get("maison_boutique") and doc.get("is_return") and doc.get("return_against"):
		doc.maison_boutique = frappe.db.get_value("Sales Invoice", doc.return_against, "maison_boutique")
	if doc.get("maison_boutique") and not doc.get("set_warehouse"):
		warehouse = frappe.db.get_value("Maison Boutique", doc.maison_boutique, "warehouse")
		if warehouse:
			doc.set_warehouse = warehouse


def _strip_walk_in_loyalty(doc) -> None:
	"""v0.6 D5: the POS-Profile default customer is a placeholder, never a rewards member.

	``Sales Invoice.loyalty_program`` is ``fetch_from: customer.loyalty_program``, so a walk-in
	that a loyalty programme with ``auto_opt_in`` had quietly enrolled would accrue points on
	every anonymous basket (61,045 of them on the seeded CloudChaserz site).
	"""
	if not doc.get("is_pos") or not doc.get("customer"):
		return
	from maison_pos.api.rewards import is_walk_in

	if not is_walk_in(doc.customer):
		return
	if doc.get("redeem_loyalty_points") or doc.get("maison_reward_tier"):
		frappe.throw(_("{0} is not a rewards member").format(doc.customer), frappe.ValidationError)
	doc.loyalty_program = None
	doc.loyalty_points = 0
	doc.loyalty_amount = 0
	doc.redeem_loyalty_points = 0


def validate(doc, method: str | None = None) -> None:
	"""Guard POS invoices: boutique must be enabled and offline uuid unique."""
	if not doc.get("is_pos"):
		return

	_strip_walk_in_loyalty(doc)

	if doc.get("maison_boutique"):
		enabled = frappe.db.get_value("Maison Boutique", doc.maison_boutique, "enabled")
		if enabled is None:
			frappe.throw(_("Boutique {0} does not exist").format(doc.maison_boutique), frappe.ValidationError)
		if not enabled:
			frappe.throw(_("Boutique {0} is disabled").format(doc.maison_boutique), frappe.ValidationError)

	if doc.get("maison_offline_uuid"):
		dup = frappe.db.get_value(
			"Sales Invoice",
			{"maison_offline_uuid": doc.maison_offline_uuid, "name": ("!=", doc.name), "docstatus": ("<", 2)},
			"name",
		)
		if dup:
			frappe.throw(
				_("Offline UUID {0} already used by {1}").format(doc.maison_offline_uuid, dup),
				frappe.DuplicateEntryError,
			)


def before_submit(doc, method: str | None = None) -> None:
	"""Allocate the public receipt token (``/r/<token>``) and stamp the store for POS invoices."""
	# a store-credit return is not `is_pos`, but it is still store data and must be stamped
	stamp_store(doc)
	if not doc.get("is_pos"):
		return
	if not doc.get("maison_receipt_token"):
		doc.maison_receipt_token = new_receipt_token()


def on_submit(doc, method: str | None = None) -> None:
	"""Publish the sale to the live wall and refresh device last_seen."""
	if not doc.get("is_pos"):
		return
	touch_last_seen(doc.get("maison_boutique"), doc.get("maison_device_id"))
	publish_sale(doc, "maison_sale")


def on_cancel(doc, method: str | None = None) -> None:
	"""Publish the cancellation so dashboard totals re-aggregate."""
	if not doc.get("is_pos"):
		return
	publish_sale(doc, "maison_sale_cancelled")
