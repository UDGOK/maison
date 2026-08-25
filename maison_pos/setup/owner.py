"""The **owner / developer seat** — one account that can open every screen on the platform.

Every other account in this system is deliberately fenced. A store manager sees one store; a
regional sees a region; the warehouse admin buys but does not sell. That is correct, and it is what
makes the audit trail worth reading — but somebody has to be able to open all of it: the person who
builds and supports the platform.

This module creates exactly one such account, and nothing else does.

    bench --site <site> execute maison_pos.setup.owner.create_owner \\
      --kwargs "{'email': 'you@example.com', 'password': '...', 'first_name': 'First', 'last_name': 'Last'}"

**The password is never stored in this repository, and it must not be.** It is passed at the
moment of creation and goes straight into Frappe's password hash. Pass ``password=None`` (the
default) and no password is set at all — use *Forgot password* on the login page, which is the
better habit for a production site.

Why not just use ``Administrator``? Because a shared, unnamed superuser makes every action in the
audit log anonymous. A named owner account does the same job and says who did it.
"""

from __future__ import annotations

import secrets
from typing import Any, Optional

import frappe
from frappe import _

#: System Manager plus every AWANZ role, so no screen in the platform is closed.
OWNER_ROLES: tuple[str, ...] = (
	"System Manager",
	"AWANZ Head Office",
	"AWANZ Warehouse Admin",
	"AWANZ Regional",
	"AWANZ Manager",
	"AWANZ Associate",
)

#: The ERPNext roles the AWANZ screens sit on top of. Missing ones are skipped, so this module
#: works on a site without ERPNext's buying or accounting modules installed.
ERPNEXT_ROLES: tuple[str, ...] = (
	"Sales Manager",
	"Sales User",
	"Stock Manager",
	"Stock User",
	"Purchase Manager",
	"Purchase User",
	"Accounts Manager",
	"Item Manager",
	"Maintenance Manager",
)


def _exists(doctype: str, name: str) -> bool:
	return bool(frappe.db.exists(doctype, name))


def create_owner(
	email: str,
	password: Optional[str] = None,
	first_name: str = "",
	last_name: str = "",
	pin: Optional[str] = None,
	commit: bool = False,
) -> dict[str, Any]:
	"""Create (or top up) the owner account. Idempotent — safe to run again.

	* every role in :data:`OWNER_ROLES` and whichever of :data:`ERPNEXT_ROLES` the site has
	* **no `User Permission`**, which is what makes it unrestricted: scoping in this app is applied
	  by User Permission rows, so an account with none of them sees every store
	* an ``AWANZ Associate`` row with the *HeadOffice* role and no store, so the same person can
	  unlock a till anywhere with a PIN
	* ``password`` is optional and is never written anywhere but the hash

	Returns what it did, never the password.
	"""
	email = (email or "").strip().lower()
	if not email or "@" not in email:
		frappe.throw(_("A real e-mail address is required for the owner account"), frappe.ValidationError)

	created = not _exists("User", email)
	if created:
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": email,
				"first_name": first_name or email.split("@")[0],
				"last_name": last_name or "",
				"enabled": 1,
				"user_type": "System User",
				"send_welcome_email": 0,
			}
		)
		user.flags.ignore_permissions = True
		user.flags.no_welcome_mail = True
		user.insert()

	# The ``AWANZ Associate`` row has to be settled **before** the roles are granted. Its
	# ``on_update`` syncs the user's ``AWANZ *`` role from its own ``role`` field and takes the
	# other three back off (v0.7 S5 — ``awanz_associate._sync_user_role``), so a row written
	# *after* the grant strips ``AWANZ Associate`` / ``AWANZ Manager`` / ``AWANZ Regional`` off
	# again, and only a second run would put them back.
	associate = None
	generated_pin = None
	if _exists("DocType", "AWANZ Associate"):
		if not pin and not _exists("AWANZ Associate", email):
			generated_pin = f"{secrets.randbelow(1_000_000):06d}"
		associate = _ensure_owner_associate(email, pin or generated_pin)

	# re-read: the role sync above saves the User document itself
	user = frappe.get_doc("User", email)
	user.enabled = 1
	user.user_type = "System User"
	if first_name:
		user.first_name = first_name
	if last_name:
		user.last_name = last_name

	wanted = [r for r in (*OWNER_ROLES, *ERPNEXT_ROLES) if _exists("Role", r)]
	have = {r.role for r in user.roles}
	added = [r for r in wanted if r not in have]
	for role in added:
		user.append("roles", {"role": role})

	if password:
		# `new_password` is hashed by the User controller on save; nothing keeps the plain text.
		user.new_password = password
		user.flags.ignore_password_policy = False
	user.flags.ignore_permissions = True
	user.flags.no_welcome_mail = True
	user.save()

	# Scoping in this app comes from User Permission rows — the owner must have none.
	restrictions = frappe.get_all("User Permission", filters={"user": email}, pluck="name")
	for name in restrictions:
		frappe.delete_doc("User Permission", name, ignore_permissions=True, force=True)

	if commit:
		frappe.db.commit()

	return {
		"user": email,
		"created": created,
		"roles_added": added,
		"roles": sorted({r.role for r in frappe.get_doc("User", email).roles}),
		"user_permissions_removed": len(restrictions),
		"associate": associate,
		# shown once, so the operator can write it down — a PIN is typed in front of customers,
		# so it is never defaulted to something guessable
		"till_pin": generated_pin,
		"password_set": bool(password),
		"unrestricted": True,
	}


def _ensure_owner_associate(email: str, pin: Optional[str]) -> Optional[str]:
	"""A till identity with no store, so the owner can unlock any till to look at it.

	When no PIN is given a random six-digit one is generated and handed back **once**, in
	``create_owner``'s payload. It used to fall back to ``0000``, which meant a seat created by the
	documented one-liner unlocked every till in the chain with four zeros — and unlike the account
	password, a till PIN is typed in front of customers.
	"""
	if _exists("AWANZ Associate", email):
		doc = frappe.get_doc("AWANZ Associate", email)
		changed = False
		if doc.role != "HeadOffice":
			doc.role = "HeadOffice"
			changed = True
		if not doc.enabled:
			doc.enabled = 1
			changed = True
		if pin:
			doc.set_pin(pin)
			changed = True
		if changed:
			doc.flags.ignore_permissions = True
			doc.save()
		return doc.name
	doc = frappe.get_doc(
		{
			"doctype": "AWANZ Associate",
			"user": email,
			"boutique": None,
			"role": "HeadOffice",
			"enabled": 1,
			"pin": pin,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def revoke_owner(email: str, commit: bool = False) -> dict[str, Any]:
	"""Disable an owner account — used when a developer hands the platform over.

	Deliberately **disables** rather than deletes: the audit trail refers to this user, and a
	deleted user turns every one of those references into a dangling name.
	"""
	email = (email or "").strip().lower()
	if not _exists("User", email):
		frappe.throw(_("{0} is not a user on this site").format(email), frappe.DoesNotExistError)
	user = frappe.get_doc("User", email)
	user.enabled = 0
	user.flags.ignore_permissions = True
	user.save()
	if _exists("AWANZ Associate", email):
		frappe.db.set_value("AWANZ Associate", email, "enabled", 0, update_modified=False)
	if commit:
		frappe.db.commit()
	return {"user": email, "enabled": False}
