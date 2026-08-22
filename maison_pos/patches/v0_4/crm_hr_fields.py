"""v0.4 B/C/I: CRM / HR / promotions / feedback doctypes, Sales Invoice coupon fields,
POS Settings switches, Maison Associate.employee, tier Customer Groups. Idempotent."""

from __future__ import annotations

import frappe


def execute() -> None:
	for dt in (
		"maison_wishlist_item",
		"maison_client_profile",
		"maison_client_interaction",
		"maison_commission_rule",
		"maison_commission_entry",
		"maison_shift",
		"maison_coupon",
		"maison_coupon_redemption",
		"maison_feedback",
		"maison_associate",
	):
		frappe.reload_doc("maison_pos", "doctype", dt)
	from maison_pos.setup.install_v04_crm import setup_v04_crm

	setup_v04_crm()
	frappe.db.commit()
