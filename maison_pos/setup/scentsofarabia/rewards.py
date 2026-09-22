"""Scents of Arabia Rewards (v1.3): the ERPNext Loyalty Program ($1 = 1 point on the net paid
amount) and the fixed ``AWANZ Reward Tier`` rows ($5/100 · $10/200 · $15/300) — the same
mechanics as CloudChaserz Rewards, under the tenant's own name. No giveaway, no promotion
calendar: those are the client's to run."""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import add_days, nowdate

from maison_pos.setup.scentsofarabia import COMPANY, LOYALTY_PROGRAM

POINTS_EXPIRY_DAYS = 3650
POINT_VALUE = 0.05


def ensure_loyalty_program(accounts: dict[str, str]) -> str:
	from maison_pos.setup import demo

	if frappe.db.exists("Loyalty Program", LOYALTY_PROGRAM):
		return LOYALTY_PROGRAM
	doc = frappe.get_doc(
		{
			"doctype": "Loyalty Program",
			"loyalty_program_name": LOYALTY_PROGRAM,
			"loyalty_program_type": "Single Tier Program",
			"company": COMPANY,
			"from_date": add_days(nowdate(), -30),
			"conversion_factor": POINT_VALUE,
			"expiry_duration": POINTS_EXPIRY_DAYS,
			"expense_account": accounts["Loyalty Redemption"],
			"cost_center": demo._account("Main"),
			"auto_opt_in": 1,
			"customer_group": frappe.db.get_value("Customer Group", {"is_group": 1, "parent_customer_group": ("in", ("", None))}, "name"),
			"customer_territory": frappe.db.get_value("Territory", {"is_group": 1, "parent_territory": ("in", ("", None))}, "name"),
			"collection_rules": [{"tier_name": "Member", "min_spent": 0, "collection_factor": 1.0}],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return LOYALTY_PROGRAM


def ensure_tiers() -> dict[str, Any]:
	from maison_pos.api.rewards import ensure_default_tiers

	tiers = ensure_default_tiers(LOYALTY_PROGRAM)
	return {"program": LOYALTY_PROGRAM, "tiers": tiers}
