"""v1.4 — **Staff from the warehouse desk**: the people who work the chain, managed by head office
or the Houston warehouse manager from one screen — add an employee to a store with a login and a
till PIN, move them, change their role, reset a PIN or a password, suspend and restore a login.

What a member of staff *is*, to this platform: a Frappe **User** (the login: e-mail, name,
enabled, roles) plus one **AWANZ Associate** row (the till identity: store, role, PIN) plus, for
store staff, a **User Permission** on the store's warehouse (the fence that scopes everything
they can see to that store — `docs/security.md` §2). This module writes all three together, in
the order the associate controller needs (the row first, then the roles — its ``on_update``
syncs the ``AWANZ *`` role from ``role`` and would strip a role granted first).

Rules:

* **Rank.** ``role`` maps to a seniority and a caller may never grant above their own
  (``scoping.max_grantable_rank``): a warehouse admin hands out Associate and Manager; Regional
  and Head Office come from head office. Nobody edits their own row here.
* **Secrets are shown once.** A generated password or PIN is in the response of the call that
  made it and nowhere else — the operator hands it over and the person changes it. Nothing here
  e-mails (the site may have no outgoing account) and nothing logs the value.
* **Suspend, never delete.** A login is disabled (which ends its sessions) and the associate row
  with it; the sales, shifts and audit lines that name the person stay readable. ``restore``
  reverses it.
"""

from __future__ import annotations

import re
import secrets
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint

from maison_pos.scoping import ASSOCIATE_ROLE_RANK, assert_supply_admin, is_supply_unrestricted, max_grantable_rank

#: the till roles, what they mean, the Frappe roles each carries, and the rank needed to grant it
ROLES: dict[str, dict[str, Any]] = {
	"Associate": {"label": "Associate", "frappe_roles": ["AWANZ Associate", "Sales User"], "rank": 1, "needs_store": True},
	"Manager": {"label": "Store manager", "frappe_roles": ["AWANZ Manager", "Sales User", "Stock User"], "rank": 2, "needs_store": True},
	"Regional": {"label": "Regional", "frappe_roles": ["AWANZ Regional", "Sales Manager"], "rank": 3, "needs_store": False},
	"HeadOffice": {"label": "Head office", "frappe_roles": ["AWANZ Head Office", "Sales Manager", "Accounts Manager", "Stock Manager"], "rank": 4, "needs_store": False},
	# the warehouse seat: an associate row at the warehouse "store" with the Manager role, plus the
	# Warehouse Admin Frappe role — granted by head office only (rank 3)
	"Warehouse": {"label": "Warehouse admin", "frappe_roles": ["AWANZ Warehouse Admin", "Stock User", "Stock Manager", "Purchase User"], "rank": 3, "needs_store": True, "associate_role": "Manager"},
}
#: every Frappe role this module ever grants — what an update takes back before re-granting
MANAGED_FRAPPE_ROLES = sorted({r for spec in ROLES.values() for r in spec["frappe_roles"]})
PIN_RE = re.compile(r"^\d{4,6}$")
PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _gen_password() -> str:
	return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(12))


def _gen_pin() -> str:
	return f"{secrets.randbelow(1_000_000):06d}"


def _grantable() -> int:
	return max_grantable_rank()


def _assert_rank(role: str) -> None:
	spec = ROLES.get(role)
	if not spec:
		frappe.throw(_("Unknown role {0}").format(role), frappe.ValidationError)
	if spec["rank"] > _grantable():
		frappe.throw(_("You may not grant the {0} role").format(spec["label"]), frappe.PermissionError)


def _assert_not_self(email: str) -> None:
	if email == frappe.session.user:
		frappe.throw(_("Your own seat is changed by head office, not from here"), frappe.PermissionError)


def _store_row(code: Optional[str]) -> Optional[frappe._dict]:
	if not code:
		return None
	row = frappe.db.get_value("AWANZ Store", code, ["name", "boutique_name", "warehouse", "enabled", "company"], as_dict=True)
	if not row:
		frappe.throw(_("Store {0} does not exist").format(code), frappe.DoesNotExistError)
	return row


def _scope_warehouses(code: str) -> list[str]:
	"""The warehouses a store's staff are fenced to: the store's, its in-transit and damaged."""
	row = frappe.db.get_value("AWANZ Store", code, ["warehouse", "transit_warehouse", "damaged_warehouse"], as_dict=True) or {}
	return [w for w in (row.get("warehouse"), row.get("transit_warehouse"), row.get("damaged_warehouse")) if w and frappe.db.exists("Warehouse", w)]


def _set_scope(email: str, code: Optional[str]) -> None:
	"""Replace the user's Warehouse permissions with the store's (none for chain-wide roles)."""
	wanted = set(_scope_warehouses(code)) if code else set()
	have = {r.for_value: r.name for r in frappe.get_all("User Permission", filters={"user": email, "allow": "Warehouse"}, fields=["name", "for_value"])}
	for wh, name in have.items():
		if wh not in wanted:
			frappe.delete_doc("User Permission", name, ignore_permissions=True, force=True)
	for wh in wanted - set(have):
		doc = frappe.get_doc({"doctype": "User Permission", "user": email, "allow": "Warehouse", "for_value": wh, "apply_to_all_doctypes": 1})
		doc.flags.ignore_permissions = True
		doc.insert()


def _set_frappe_roles(user, role: str) -> list[str]:
	"""The roles this module manages, replaced to match *role*; any other role the user carries
	(a head-office extra, an ERPNext role somebody added on the desk) is left alone."""
	wanted = [r for r in ROLES[role]["frappe_roles"] if frappe.db.exists("Role", r)]
	keep = [r for r in user.roles if r.role not in MANAGED_FRAPPE_ROLES]
	user.set("roles", keep)
	for r in wanted:
		user.append("roles", {"role": r})
	return wanted


def _associate_role(role: str) -> str:
	return ROLES[role].get("associate_role") or role


def _person(email: str) -> dict[str, Any]:
	u = frappe.db.get_value("User", email, ["name", "first_name", "last_name", "full_name", "enabled", "last_login", "last_active", "user_image", "creation"], as_dict=True)
	if not u:
		frappe.throw(_("User {0} does not exist").format(email), frappe.DoesNotExistError)
	a = frappe.db.get_value("AWANZ Associate", email, ["name", "boutique", "role", "enabled", "pin_set_on", "failed_pin_attempts", "employee"], as_dict=True)
	roles = set(frappe.get_all("Has Role", filters={"parent": email, "parenttype": "User"}, pluck="role"))
	role = None
	if a:
		if "AWANZ Warehouse Admin" in roles:
			role = "Warehouse"
		else:
			role = a.role
	elif "AWANZ Warehouse Admin" in roles:
		role = "Warehouse"
	elif "AWANZ Head Office" in roles:
		role = "HeadOffice"
	elif "AWANZ Regional" in roles:
		role = "Regional"
	store = frappe.db.get_value("AWANZ Store", a.boutique, "boutique_name") if a and a.boutique else None
	return {
		"user": email,
		"first_name": u.first_name or "",
		"last_name": u.last_name or "",
		"full_name": u.full_name or email,
		"login_enabled": cint(u.enabled),
		"last_login": u.last_login,
		"last_active": u.last_active,
		"since": u.creation,
		"boutique": a.boutique if a else None,
		"boutique_name": store,
		"role": role,
		"role_label": "Owner" if "System Manager" in roles else (ROLES[role]["label"] if role in ROLES else (role or "—")),
		"till_enabled": cint(a.enabled) if a else 0,
		"pin_set": bool(a and a.pin_set_on),
		"pin_locked": bool(a and cint(a.failed_pin_attempts) >= 5),
		"employee": a.employee if a else None,
		"frappe_roles": sorted(roles),
		"is_owner": "System Manager" in roles,
		"editable": ROLES.get(role, {}).get("rank", 99) <= _grantable() if role else False,
	}


# ---------------------------------------------------------------------------
@frappe.whitelist()
def staff(store: Optional[str] = None, include_suspended: int = 1) -> dict[str, Any]:
	"""Everyone with a till identity or a chain role, with their store, role and login state."""
	assert_supply_admin()
	rows = frappe.get_all("AWANZ Associate", filters={"boutique": store} if store else {}, fields=["name", "user"], order_by="boutique asc, full_name asc")
	emails = {r.user for r in rows if r.user}
	if not store:
		for role in ("AWANZ Head Office", "AWANZ Regional", "AWANZ Warehouse Admin"):
			emails |= set(frappe.get_all("Has Role", filters={"role": role, "parenttype": "User"}, pluck="parent"))
	emails.discard("Administrator")
	emails.discard("Guest")
	people = []
	for email in sorted(emails):
		if not frappe.db.exists("User", email):
			continue
		p = _person(email)
		if not cint(include_suspended) and not p["login_enabled"]:
			continue
		people.append(p)
	people.sort(key=lambda p: (p["boutique_name"] or "~", -ROLES.get(p["role"] or "", {}).get("rank", 0), p["full_name"].lower()))
	stores = frappe.get_all("AWANZ Store", filters={"enabled": 1}, fields=["name", "boutique_name", "is_warehouse", "boutique_type"], order_by="boutique_name asc")
	grantable = _grantable()
	return {
		"staff": people,
		"count": len(people),
		"stores": [{"code": s.name, "name": s.boutique_name, "is_warehouse": cint(s.get("is_warehouse")) or s.get("boutique_type") == "Warehouse"} for s in stores],
		"roles": [{"key": k, "label": v["label"], "needs_store": v["needs_store"], "grantable": v["rank"] <= grantable} for k, v in ROLES.items()],
		"grantable_rank": grantable,
	}


def _clean(payload: Any) -> dict[str, Any]:
	if isinstance(payload, str):
		payload = frappe.parse_json(payload)
	if not isinstance(payload, dict):
		frappe.throw(_("A staff payload is required"), frappe.ValidationError)
	return payload


@frappe.whitelist()
def create_staff(payload: Any) -> dict[str, Any]:
	"""Add a person: ``first_name``, ``last_name``, ``email``, ``role`` (Associate / Manager /
	Regional / HeadOffice / Warehouse), ``boutique`` (required for store roles), optional ``pin``
	(4–6 digits) and ``password``; either is generated when blank and returned **once**."""
	assert_supply_admin()
	p = _clean(payload)
	email = (p.get("email") or "").strip().lower()
	if not email or "@" not in email or " " in email:
		frappe.throw(_("A working e-mail address is the login — it is required"), frappe.ValidationError)
	first = (p.get("first_name") or "").strip()
	last = (p.get("last_name") or "").strip()
	if not first:
		frappe.throw(_("A first name is required"), frappe.ValidationError)
	role = (p.get("role") or "Associate").strip()
	_assert_rank(role)
	spec = ROLES[role]
	store = _store_row((p.get("boutique") or "").strip() or None)
	if spec["needs_store"] and not store:
		frappe.throw(_("{0} needs a store").format(spec["label"]), frappe.ValidationError)
	if store and role == "Warehouse" and not (frappe.db.get_value("AWANZ Store", store.name, "is_warehouse") or frappe.db.get_value("AWANZ Store", store.name, "boutique_type") == "Warehouse"):
		frappe.throw(_("A warehouse admin belongs to the warehouse row, not a store"), frappe.ValidationError)
	if store and not cint(store.enabled):
		frappe.throw(_("{0} is closed").format(store.boutique_name), frappe.ValidationError)
	if frappe.db.exists("User", email):
		frappe.throw(_("{0} already has a login — edit that person instead").format(email), frappe.DuplicateEntryError)
	pin = (str(p.get("pin") or "")).strip()
	if pin and not PIN_RE.match(pin):
		frappe.throw(_("PIN must be 4 to 6 digits"), frappe.ValidationError)
	generated_pin = None
	if not pin:
		pin = generated_pin = _gen_pin()
	password = (p.get("password") or "").strip()
	generated_password = None
	if not password:
		password = generated_password = _gen_password()

	user = frappe.get_doc(
		{
			"doctype": "User",
			"email": email,
			"first_name": first,
			"last_name": last,
			"enabled": 1,
			"user_type": "System User",
			"send_welcome_email": 0,
			"new_password": password,
			"time_zone": frappe.db.get_single_value("System Settings", "time_zone"),
		}
	)
	user.flags.ignore_permissions = True
	user.flags.no_welcome_mail = True
	user.insert()

	# the till identity first — its on_update syncs the AWANZ role and strips the others
	assoc = frappe.get_doc(
		{
			"doctype": "AWANZ Associate",
			"user": email,
			"boutique": store.name if store else None,
			"role": _associate_role(role),
			"enabled": 1,
			"pin": pin,
		}
	)
	assoc.flags.ignore_permissions = True
	assoc.insert()

	user = frappe.get_doc("User", email)
	granted = _set_frappe_roles(user, role)
	user.flags.ignore_permissions = True
	user.save()
	_set_scope(email, store.name if store and spec["needs_store"] else None)
	frappe.clear_cache(user=email)
	return {
		"person": _person(email),
		"roles_granted": granted,
		# shown once — never stored, never logged
		"initial_password": generated_password,
		"pin": generated_pin,
		"password_was_supplied": not generated_password,
		"pin_was_supplied": not generated_pin,
	}


@frappe.whitelist()
def update_staff(user: str, payload: Any) -> dict[str, Any]:
	"""Rename, move to another store, or change the role. Store and role changes re-fence the
	login (warehouse permissions) and re-grant the roles to match."""
	assert_supply_admin()
	email = (user or "").strip().lower()
	_assert_not_self(email)
	current = _person(email)
	if current["is_owner"]:
		frappe.throw(_("The owner seat is not edited from here"), frappe.PermissionError)
	if current["role"] and not current["editable"]:
		frappe.throw(_("You may not change a {0}").format(current["role_label"]), frappe.PermissionError)
	p = _clean(payload)
	changed: list[str] = []
	udoc = frappe.get_doc("User", email)
	for k in ("first_name", "last_name"):
		if k in p and (p[k] or "").strip() != (udoc.get(k) or ""):
			if k == "first_name" and not (p[k] or "").strip():
				frappe.throw(_("A first name is required"), frappe.ValidationError)
			udoc.set(k, (p[k] or "").strip())
			changed.append(k)
	role = (p.get("role") or current["role"] or "Associate").strip()
	store_code = (p.get("boutique") if "boutique" in p else current["boutique"]) or None
	role_changed = role != current["role"]
	store_changed = (store_code or None) != (current["boutique"] or None)
	if role_changed:
		_assert_rank(role)
	spec = ROLES[role]
	store = _store_row(store_code) if store_code else None
	if spec["needs_store"] and not store:
		frappe.throw(_("{0} needs a store").format(spec["label"]), frappe.ValidationError)
	if store and not cint(store.enabled):
		frappe.throw(_("{0} is closed").format(store.boutique_name), frappe.ValidationError)
	if role_changed or store_changed:
		if frappe.db.exists("AWANZ Associate", email):
			assoc = frappe.get_doc("AWANZ Associate", email)
			assoc.boutique = store.name if store else None
			assoc.role = _associate_role(role)
			assoc.flags.ignore_permissions = True
			assoc.save()
		else:
			assoc = frappe.get_doc({"doctype": "AWANZ Associate", "user": email, "boutique": store.name if store else None, "role": _associate_role(role), "enabled": 1, "pin": _gen_pin()})
			assoc.flags.ignore_permissions = True
			assoc.insert()
		udoc = frappe.get_doc("User", email)  # the associate sync saved it
		for k in ("first_name", "last_name"):
			if k in changed:
				udoc.set(k, (p[k] or "").strip())
		_set_frappe_roles(udoc, role)
		changed.extend([k for k, c in (("role", role_changed), ("boutique", store_changed)) if c])
	if changed:
		udoc.flags.ignore_permissions = True
		udoc.save()
	if role_changed or store_changed:
		_set_scope(email, store.name if store and spec["needs_store"] else None)
	frappe.clear_cache(user=email)
	return {"person": _person(email), "changed": changed}


@frappe.whitelist()
def reset_pin(user: str, pin: Optional[str] = None) -> dict[str, Any]:
	"""A new till PIN (given, or generated and returned once); clears a lockout."""
	assert_supply_admin()
	email = (user or "").strip().lower()
	_assert_not_self(email)
	current = _person(email)
	if current["role"] and not current["editable"]:
		frappe.throw(_("You may not change a {0}").format(current["role_label"]), frappe.PermissionError)
	if not frappe.db.exists("AWANZ Associate", email):
		frappe.throw(_("{0} has no till identity").format(email), frappe.DoesNotExistError)
	pin = (pin or "").strip()
	generated = None
	if pin and not PIN_RE.match(pin):
		frappe.throw(_("PIN must be 4 to 6 digits"), frappe.ValidationError)
	if not pin:
		pin = generated = _gen_pin()
	assoc = frappe.get_doc("AWANZ Associate", email)
	assoc.set_pin(pin)
	if cint(assoc.failed_pin_attempts):
		frappe.db.set_value("AWANZ Associate", email, "failed_pin_attempts", 0, update_modified=False)
	return {"person": _person(email), "pin": generated, "pin_was_supplied": not generated}


@frappe.whitelist()
def reset_password(user: str) -> dict[str, Any]:
	"""A generated temporary password, returned once; the person changes it on first sign-in.
	Never takes a password — one typed by an operator would be known to two people."""
	assert_supply_admin()
	email = (user or "").strip().lower()
	_assert_not_self(email)
	current = _person(email)
	if current["is_owner"]:
		frappe.throw(_("The owner's password is not reset from here"), frappe.PermissionError)
	if current["role"] and not current["editable"]:
		frappe.throw(_("You may not change a {0}").format(current["role_label"]), frappe.PermissionError)
	password = _gen_password()
	udoc = frappe.get_doc("User", email)
	udoc.new_password = password
	udoc.flags.ignore_permissions = True
	udoc.flags.ignore_password_policy = False
	udoc.save()
	try:
		from frappe.sessions import clear_sessions

		clear_sessions(user=email, force=True)
	except Exception:
		pass
	return {"person": _person(email), "initial_password": password}


@frappe.whitelist()
def suspend(user: str, reason: Optional[str] = None) -> dict[str, Any]:
	"""Disable the login (its sessions end) and the till identity. Nothing is deleted."""
	assert_supply_admin()
	email = (user or "").strip().lower()
	_assert_not_self(email)
	current = _person(email)
	if current["is_owner"]:
		frappe.throw(_("The owner seat cannot be suspended from here"), frappe.PermissionError)
	if current["role"] and not current["editable"]:
		frappe.throw(_("You may not suspend a {0}").format(current["role_label"]), frappe.PermissionError)
	udoc = frappe.get_doc("User", email)
	if cint(udoc.enabled):
		udoc.enabled = 0
		udoc.flags.ignore_permissions = True
		udoc.save()
	if frappe.db.exists("AWANZ Associate", email):
		frappe.db.set_value("AWANZ Associate", email, "enabled", 0, update_modified=False)
	try:
		from frappe.sessions import clear_sessions

		clear_sessions(user=email, force=True)
	except Exception:
		pass
	udoc.add_comment("Comment", _("Suspended from the warehouse desk by {0}{1}").format(frappe.session.user, f": {reason.strip()}" if reason and reason.strip() else ""))
	frappe.clear_cache(user=email)
	return {"person": _person(email), "suspended": True}


@frappe.whitelist()
def restore(user: str) -> dict[str, Any]:
	assert_supply_admin()
	email = (user or "").strip().lower()
	_assert_not_self(email)
	current = _person(email)
	if current["role"] and not current["editable"]:
		frappe.throw(_("You may not restore a {0}").format(current["role_label"]), frappe.PermissionError)
	udoc = frappe.get_doc("User", email)
	if not cint(udoc.enabled):
		udoc.enabled = 1
		udoc.flags.ignore_permissions = True
		udoc.save()
	if frappe.db.exists("AWANZ Associate", email):
		frappe.db.set_value("AWANZ Associate", email, {"enabled": 1, "failed_pin_attempts": 0}, update_modified=False)
	udoc.add_comment("Comment", _("Restored from the warehouse desk by {0}").format(frappe.session.user))
	frappe.clear_cache(user=email)
	return {"person": _person(email), "restored": True}


def is_staff_admin(user: Optional[str] = None) -> bool:
	"""For the desk's ``me``: may this user open the Staff section?"""
	return is_supply_unrestricted(user)
