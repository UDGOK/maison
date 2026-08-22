"""Session helper for the PWA Unlock screen (not part of the core API contract)."""

from __future__ import annotations

from typing import Any

import frappe

from maison_pos import __version__
from maison_pos.scoping import get_allowed_boutiques, get_associate, is_unrestricted


@frappe.whitelist()
def me() -> dict[str, Any]:
	"""Who am I, which boutiques can I use, which associates can unlock on this device."""
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(frappe._("Authentication required"), frappe.AuthenticationError)
	assoc = get_associate(user)
	boutiques = get_allowed_boutiques(user)
	return {
		"user": user,
		"full_name": frappe.db.get_value("User", user, "full_name"),
		"roles": [r for r in frappe.get_roles(user) if r.startswith("Maison ") or r == "System Manager"],
		"unrestricted": is_unrestricted(user),
		"associate": assoc,
		"boutiques": frappe.get_all(
			"Maison Boutique",
			filters={"name": ("in", boutiques)} if boutiques else {"name": "__none__"},
			fields=["name", "boutique_name", "city", "warehouse", "pos_profile", "stripe_location_id", "printer_ip", "printer_model"],
			order_by="name",
		),
		"app_version": __version__,
	}


@frappe.whitelist()
def associates(boutique: str) -> list[dict[str, Any]]:
	"""Associates that may unlock the POS at *boutique* (no hashes returned)."""
	from maison_pos.scoping import assert_boutique_access

	boutique = assert_boutique_access(boutique)
	return frappe.get_all(
		"Maison Associate",
		filters={"boutique": boutique, "enabled": 1},
		fields=["name", "user", "full_name", "role"],
		order_by="full_name",
	)
