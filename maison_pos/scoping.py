"""Boutique scoping helpers.

Rules (see SPEC "Store model"):

* ``System Manager``, ``Administrator``, ``Maison Head Office`` and ``Maison Regional``
  are unrestricted.
* ``Maison Manager`` / ``Maison Associate`` may only act on the boutique their
  ``Maison Associate`` record points to.
"""

from __future__ import annotations

from typing import Optional

import frappe
from frappe import _

UNRESTRICTED_ROLES = frozenset({"Administrator", "System Manager", "Maison Head Office", "Maison Regional"})
SCOPED_ROLES = frozenset({"Maison Manager", "Maison Associate"})
ALL_MAISON_ROLES = ("Maison Associate", "Maison Manager", "Maison Regional", "Maison Head Office")
APPROVER_ROLES = frozenset({"Administrator", "System Manager", "Maison Head Office", "Maison Regional"})


def _user(user: Optional[str] = None) -> str:
	return user or frappe.session.user


def is_unrestricted(user: Optional[str] = None) -> bool:
	"""Return True when *user* may act on any boutique."""
	user = _user(user)
	if user == "Administrator":
		return True
	return bool(UNRESTRICTED_ROLES & set(frappe.get_roles(user)))


def get_associate(user: Optional[str] = None) -> Optional[dict]:
	"""Return the enabled ``Maison Associate`` row for *user* (or ``None``)."""
	user = _user(user)
	rows = frappe.get_all(
		"Maison Associate",
		filters={"user": user, "enabled": 1},
		fields=["name", "user", "boutique", "role", "full_name"],
		limit=1,
	)
	return rows[0] if rows else None


def get_user_boutique(user: Optional[str] = None) -> Optional[str]:
	"""Boutique code the user is attached to, if any."""
	assoc = get_associate(user)
	return assoc["boutique"] if assoc else None


def get_allowed_boutiques(user: Optional[str] = None) -> list[str]:
	"""List of boutique codes the user can see (all enabled boutiques when unrestricted)."""
	if is_unrestricted(user):
		return frappe.get_all("Maison Boutique", filters={"enabled": 1}, pluck="name", order_by="name")
	boutique = get_user_boutique(user)
	return [boutique] if boutique else []


def assert_boutique_access(boutique: Optional[str], user: Optional[str] = None) -> str:
	"""Raise ``frappe.PermissionError`` unless *user* may act on *boutique*.

	Returns the resolved boutique code (falls back to the user's own boutique
	when *boutique* is empty and the user is scoped).
	"""
	user = _user(user)
	if user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)

	if is_unrestricted(user):
		if not boutique:
			frappe.throw(_("Boutique is required"), frappe.ValidationError)
		if not frappe.db.exists("Maison Boutique", boutique):
			frappe.throw(_("Boutique {0} does not exist").format(boutique), frappe.DoesNotExistError)
		return boutique

	own = get_user_boutique(user)
	if not own:
		frappe.throw(_("User {0} is not attached to any boutique").format(user), frappe.PermissionError)
	if boutique and boutique != own:
		frappe.throw(
			_("You are not permitted to act on boutique {0}").format(boutique),
			frappe.PermissionError,
		)
	return own


def assert_roles(*roles: str, user: Optional[str] = None) -> None:
	"""Raise unless the user holds at least one of *roles* (Administrator always passes)."""
	user = _user(user)
	if user == "Administrator":
		return
	if not set(roles) & set(frappe.get_roles(user)):
		frappe.throw(_("Insufficient role: requires one of {0}").format(", ".join(roles)), frappe.PermissionError)


def is_manager_or_above(user: Optional[str] = None) -> bool:
	user = _user(user)
	if user == "Administrator":
		return True
	roles = set(frappe.get_roles(user))
	return bool(roles & (UNRESTRICTED_ROLES | {"Maison Manager"}))


# ---------------------------------------------------------------------------
# permission_query_conditions / has_permission hooks
# ---------------------------------------------------------------------------
def _boutique_condition(doctype: str, user: Optional[str]) -> str:
	if is_unrestricted(user):
		return ""
	boutique = get_user_boutique(user)
	if not boutique:
		return "1=0"
	return f"`tab{doctype}`.`boutique` = {frappe.db.escape(boutique)}"


def price_change_request_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Price Change Request", user)


def heartbeat_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Device Heartbeat", user)


def sync_log_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Sync Log", user)


def price_change_request_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	if is_unrestricted(user):
		return True
	return bool(doc.get("boutique")) and doc.get("boutique") == get_user_boutique(user)


def biometric_consent_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Biometric Consent", user)


def recognition_event_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Recognition Event", user)
