"""Scents of Arabia staff seats (v1.3) — placeholders until the client names real people.

    hq@scentsofarabia.example              AWANZ Head Office
    warehouse@scentsofarabia.example       AWANZ Warehouse Admin (HOU-WH — Houston buys and ships)
    ok.owa.manager@…                       AWANZ Manager, Owasso        PIN 6606
    ok.owa.a1@…                            AWANZ Associate, Owasso      PIN 2580
    ok.etul.manager@…                      AWANZ Manager, East Tulsa    PIN 9909
    ok.etul.a1@…                           AWANZ Associate, East Tulsa  PIN 2580

The initial password is generated per seed run and printed once by ``seed()``; it is never in
this repository. The owner seat (a named account that opens every screen) is created separately
and deliberately — ``maison_pos.setup.owner.create_owner`` — with the real owner's e-mail.
Re-credential every placeholder (``maison_associate.reset_pin``, new passwords) before a real
associate uses a till: see docs/security.md.
"""

from __future__ import annotations

from typing import Any

import frappe

from maison_pos.setup.scentsofarabia import DOMAIN

MANAGER_PINS: dict[str, str] = {"OK-OWA": "6606", "OK-ETUL": "9909"}
ASSOCIATE_PIN = "2580"

STAFF: dict[str, list[tuple[str, str, str]]] = {
	"OK-OWA": [("Mgr", "Owasso", "Manager"), ("A1", "Owasso", "Associate")],
	"OK-ETUL": [("Mgr", "East Tulsa", "Manager"), ("A1", "East Tulsa", "Associate")],
}


def _exists(doctype: str, name: str) -> bool:
	return bool(frappe.db.exists(doctype, name))


def ensure_users() -> dict[str, Any]:
	from maison_pos.setup import demo
	from maison_pos.setup.scentsofarabia import stores

	before = set(frappe.get_all("User", filters={"name": ("like", f"%@{DOMAIN}")}, pluck="name"))

	demo.ensure_user(f"hq@{DOMAIN}", "Head", "Office", ["AWANZ Head Office", "Sales Manager", "Accounts Manager", "Stock Manager"])
	demo.ensure_associate(f"hq@{DOMAIN}", None, "HeadOffice", "0000")

	wh_roles = ["AWANZ Warehouse Admin", "Stock User", "Stock Manager", "Purchase User"]
	demo.ensure_user(f"warehouse@{DOMAIN}", "Houston", "Warehouse", [r for r in wh_roles if _exists("Role", r)])
	if _exists("AWANZ Store", stores.WAREHOUSE_CODE):
		try:
			demo.ensure_associate(f"warehouse@{DOMAIN}", stores.WAREHOUSE_CODE, "Manager", "0000")
			demo.ensure_user_permission(f"warehouse@{DOMAIN}", stores.warehouse_name(stores.WAREHOUSE_CODE))
		except Exception:
			frappe.log_error(frappe.get_traceback(), "scentsofarabia warehouse associate")

	for spec in stores.STORES:
		code = spec["code"]
		prefix = code.lower().replace("-", ".")
		warehouse = stores.warehouse_name(code)
		for kind, first, last in STAFF[code]:
			if kind == "Mgr":
				email = f"{prefix}.manager@{DOMAIN}"
				demo.ensure_user(email, first, last, ["AWANZ Manager", "Sales User", "Stock User"])
				demo.ensure_associate(email, code, "Manager", MANAGER_PINS[code])
			else:
				email = f"{prefix}.{kind.lower()}@{DOMAIN}"
				demo.ensure_user(email, first, last, ["AWANZ Associate", "Sales User"])
				demo.ensure_associate(email, code, "Associate", ASSOCIATE_PIN)
			demo.ensure_user_permission(email, warehouse)

	after = set(frappe.get_all("User", filters={"name": ("like", f"%@{DOMAIN}")}, pluck="name"))
	# the stores' clock, whatever System Settings said when the user row was created
	from maison_pos.setup.scentsofarabia import TIMEZONE

	for email in after:
		if frappe.db.get_value("User", email, "time_zone") != TIMEZONE:
			frappe.db.set_value("User", email, "time_zone", TIMEZONE, update_modified=False)
	return {"created": sorted(after - before), "total": len(after)}
