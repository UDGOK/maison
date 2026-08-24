"""v0.4 B/C/I: CRM / HR / promotions / feedback doctypes, Sales Invoice coupon fields,
POS Settings switches, AWANZ Associate.employee, tier Customer Groups. Idempotent."""

from __future__ import annotations

import frappe


def execute() -> None:
	for dt in (
		"awanz_wishlist_item",
		"awanz_client_profile",
		"awanz_client_interaction",
		"awanz_commission_rule",
		"awanz_commission_entry",
		"awanz_shift",
		"maison_coupon",
		"awanz_coupon_redemption",
		"awanz_feedback",
		"maison_associate",
	):
		frappe.reload_doc("awanz_pos", "doctype", dt)
	from maison_pos.setup.install_v04_crm import setup_v04_crm

	setup_v04_crm()
	frappe.db.commit()
