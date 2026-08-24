"""AWANZ Associate: links a User to a boutique, with a hashed POS unlock PIN.

Security model (v0.7 — see ``docs/security.md``):

* ``user`` / ``boutique`` / ``role`` are **permlevel 1**. They decide who somebody is on this
  chain, so only Head Office / Regional / System Manager may write them. A store manager who
  ``set_value``s their own ``role`` to ``HeadOffice`` is refused by
  :func:`maison_pos.scoping.associate_has_permission` *before* the save, by the framework's
  permlevel reset during it, and by :meth:`AWANZAssociate._guard_privileged_fields` inside it.
* ``pin`` / ``pin_hash`` / ``pin_set_on`` / ``failed_pin_attempts`` are **permlevel 2** — no
  AWANZ role can read them — and ``pin_hash`` is a ``Password`` field, so the value physically
  lives in ``__Auth`` (encrypted) and the doctype column only ever holds ``*****``. A leaked
  hash is an offline attack on a 4–6 digit secret that walks straight past the 5-attempt online
  lockout, which is why it is kept out of every query surface rather than merely hidden.
* the ``AWANZ *`` Frappe role is synced from ``role``, but never above the granting user's own
  rank (:func:`maison_pos.scoping.max_grantable_rank`), and a demotion now takes the old role
  back off the User.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from typing import Any, Optional

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, now_datetime

PIN_RE = re.compile(r"^\d{4,6}$")
#: v0.7 S2 — was 120_000. A 4–6 digit PIN has at most 10^6 candidates, so iterations are the only
#: cost an attacker who ever gets the hash has to pay; ~0.5 s per verify is invisible at the till.
PBKDF2_ITERATIONS = 600_000
MAX_FAILED_ATTEMPTS = 5

ROLE_MAP = {
	"Associate": "AWANZ Associate",
	"Manager": "AWANZ Manager",
	"Regional": "AWANZ Regional",
	"HeadOffice": "AWANZ Head Office",
}


def hash_pin(pin: str, salt: str | None = None, iterations: int = PBKDF2_ITERATIONS) -> str:
	"""Return ``pbkdf2_sha256$<iter>$<salt>$<hexdigest>`` for *pin*."""
	salt = salt or secrets.token_hex(16)
	digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), iterations).hex()
	return f"pbkdf2_sha256${iterations}${salt}${digest}"


def is_dummy(value: Optional[str]) -> bool:
	"""True for the ``*****`` placeholder a ``Password`` field leaves in the doctype column."""
	return bool(value) and set(str(value)) == {"*"}


def check_pin(pin: str, stored: str | None) -> bool:
	"""Constant-time comparison of *pin* against a stored hash string."""
	if not stored or not pin or is_dummy(stored):
		return False
	try:
		algo, iterations, salt, digest = stored.split("$", 3)
	except ValueError:
		return False
	if algo != "pbkdf2_sha256":
		return False
	try:
		rounds = int(iterations)
	except ValueError:
		return False
	candidate = hash_pin(pin, salt=salt, iterations=rounds).split("$", 3)[3]
	return hmac.compare_digest(candidate, digest)


def stored_iterations(stored: str | None) -> int:
	try:
		return int(str(stored).split("$", 3)[1])
	except (AttributeError, IndexError, ValueError):
		return 0


class AWANZAssociate(Document):
	def validate(self) -> None:
		self._guard_privileged_fields()
		self._validate_boutique_for_role()
		self._hash_new_pin()

	def on_update(self) -> None:
		self._sync_user_role()

	# -- validation -------------------------------------------------------
	def _guard_privileged_fields(self) -> None:
		"""v0.7 S1/S5 — a store user may never change ``user`` / ``boutique`` / ``role``.

		The framework's permlevel reset (``validate_higher_perm_levels``) runs before this and
		silently puts the old values back, and ``associate_has_permission`` refuses the write
		outright — this is the third, cheapest line: it also covers a site whose Custom DocPerms
		were hand-edited, and it is the only one that survives ``frappe.flags.in_install``.
		"""
		from maison_pos.scoping import ASSOCIATE_ROLE_RANK, PRIVILEGED_ASSOCIATE_FIELDS, get_user_boutique, is_unrestricted, max_grantable_rank

		if self.flags.ignore_permissions or frappe.session.user == "Administrator":
			return
		if is_unrestricted():
			return
		if ASSOCIATE_ROLE_RANK.get(self.role or "", 0) > max_grantable_rank():
			frappe.throw(
				_("You may not give an associate the {0} role").format(self.role),
				frappe.PermissionError,
			)
		if self.is_new():
			if self.boutique != get_user_boutique():
				frappe.throw(_("You may only add associates to your own boutique"), frappe.PermissionError)
			return
		before = self.get_doc_before_save()
		if before is None:
			return
		for field in PRIVILEGED_ASSOCIATE_FIELDS:
			if (self.get(field) or None) != (before.get(field) or None):
				frappe.throw(
					_("Only Head Office may change {0} on an associate").format(_(self.meta.get_label(field))),
					frappe.PermissionError,
				)

	def _validate_boutique_for_role(self) -> None:
		if self.role in ("Associate", "Manager") and not self.boutique:
			frappe.throw(_("Boutique is required for Associates and Managers"), frappe.ValidationError)

	def _hash_new_pin(self) -> None:
		if not self.pin or is_dummy(self.pin):
			return
		if not PIN_RE.match(str(self.pin)):
			frappe.throw(_("PIN must be 4 to 6 digits"), frappe.ValidationError)
		self.pin_hash = hash_pin(str(self.pin))
		self.pin_set_on = now_datetime()
		self.failed_pin_attempts = 0
		self.pin = None  # never persist the clear-text PIN

	def _sync_user_role(self) -> None:
		"""Ensure the linked User carries the matching ``AWANZ *`` role — and only that one.

		v0.7 S1/S5: the sync used to be add-only and ran with ``ignore_permissions``, so whoever
		could write ``role`` could hand themselves any Frappe role in the system. It now refuses
		to grant a rank above the *granting* user's own, and takes back the AWANZ role a
		demotion left behind.
		"""
		from maison_pos.scoping import ASSOCIATE_ROLE_RANK, FRAPPE_ROLE_RANK, max_grantable_rank

		want = ROLE_MAP.get(self.role)
		if not want or not self.user or not frappe.db.exists("User", self.user):
			return
		actor_rank = max_grantable_rank()
		if ASSOCIATE_ROLE_RANK.get(self.role, 0) > actor_rank:
			frappe.throw(
				_("You may not grant the {0} role").format(want),
				frappe.PermissionError,
			)
		stale = [
			role
			for role in ROLE_MAP.values()
			if role != want and FRAPPE_ROLE_RANK.get(role, 0) <= actor_rank and frappe.db.exists("Has Role", {"parent": self.user, "role": role, "parenttype": "User"})
		]
		grant = frappe.db.exists("Role", want) and not frappe.db.exists(
			"Has Role", {"parent": self.user, "role": want, "parenttype": "User"}
		)
		if not stale and not grant:
			return
		user = frappe.get_doc("User", self.user)
		if stale:
			user.set("roles", [r for r in user.roles if r.role not in stale])
		if grant:
			user.append("roles", {"role": want})
		user.flags.ignore_permissions = True
		user.save()

	# -- PIN storage ------------------------------------------------------
	def get_pin_hash(self) -> Optional[str]:
		"""The real PBKDF2 string, from ``__Auth`` (or the legacy column on an un-migrated site)."""
		value = self.get("pin_hash")
		if value and not is_dummy(value):
			return value  # legacy row: still in the doctype column, migrated on the next verify
		if not self.name:
			return None
		try:
			return self.get_password("pin_hash", raise_exception=False)
		except Exception:  # pragma: no cover — missing encryption key / __Auth row
			return None

	def _store_pin_hash(self, value: str) -> None:
		"""Write *value* into ``__Auth`` and leave asterisks in the column (no save needed)."""
		from frappe.utils.password import set_encrypted_password

		set_encrypted_password(self.doctype, self.name, value, "pin_hash")
		frappe.db.set_value(self.doctype, self.name, "pin_hash", "*" * len(value), update_modified=False)
		self.pin_hash = "*" * len(value)

	# -- public API -------------------------------------------------------
	def set_pin(self, pin: str) -> None:
		"""Set a new PIN and save (used by demo seed and the settings screen)."""
		self.pin = pin
		self.save(ignore_permissions=True)

	def verify_pin(self, pin: str) -> bool:
		"""Return True when *pin* matches; tracks failed attempts and locks after 5."""
		if not self.enabled:
			return False
		if (self.failed_pin_attempts or 0) >= MAX_FAILED_ATTEMPTS:
			frappe.throw(_("PIN locked after too many failed attempts; ask a manager to reset it"), frappe.AuthenticationError)
		stored = self.get_pin_hash()
		ok = check_pin(str(pin or ""), stored)
		if ok:
			if self.failed_pin_attempts:
				frappe.db.set_value(self.doctype, self.name, "failed_pin_attempts", 0, update_modified=False)
			self._upgrade_hash(str(pin), stored)
		else:
			frappe.db.set_value(
				self.doctype,
				self.name,
				"failed_pin_attempts",
				(self.failed_pin_attempts or 0) + 1,
				update_modified=False,
			)
		return ok

	def _upgrade_hash(self, pin: str, stored: Optional[str]) -> None:
		"""Re-hash on a successful unlock when the stored hash is weaker than today's setting,
		and move a legacy hash that still sits in the doctype column into ``__Auth``."""
		try:
			if stored_iterations(stored) < PBKDF2_ITERATIONS:
				self._store_pin_hash(hash_pin(pin))
			elif self.get("pin_hash") and not is_dummy(self.get("pin_hash")):
				self._store_pin_hash(stored)
		except Exception:  # pragma: no cover — never fail an unlock because of housekeeping
			frappe.log_error(frappe.get_traceback(), "awanz pin hash upgrade")


@frappe.whitelist()
def verify_pin(associate: str, pin: str) -> dict:
	"""POS unlock: verify *pin* for *associate* (must belong to the caller's boutique).

	Returns ``{ok: bool, associate, full_name, boutique, role}``.
	"""
	from maison_pos.ratelimit import guard
	from maison_pos.scoping import assert_boutique_access, is_unrestricted

	doc = frappe.get_doc("AWANZ Associate", associate)
	if doc.boutique:
		assert_boutique_access(doc.boutique)
	elif not is_unrestricted():
		# head-office / regional rows carry no boutique, and `assert_boutique_access(None)` would
		# happily fall back to the caller's own store — a store user has no business here
		frappe.throw(_("Associate {0} is not attached to your boutique").format(associate), frappe.PermissionError)
	# an authenticated device may still not sit there guessing a colleague's PIN
	guard("associate.verify_pin", 20, 300, identity=associate, global_limit=600)
	ok = doc.verify_pin(pin)
	return {
		"ok": ok,
		"associate": doc.name,
		"full_name": doc.full_name,
		"boutique": doc.boutique,
		"role": doc.role,
	}


@frappe.whitelist()
def reset_pin(associate: str, pin: str) -> dict:
	"""Manager+ resets a PIN for an associate in their own boutique."""
	from maison_pos.scoping import assert_boutique_access, get_user_boutique, is_manager_or_above, is_unrestricted

	if not is_manager_or_above():
		frappe.throw(_("Only managers can reset PINs"), frappe.PermissionError)
	doc = frappe.get_doc("AWANZ Associate", associate)
	if is_unrestricted():
		if doc.boutique:
			assert_boutique_access(doc.boutique)
	else:
		# a store manager: their own shop floor, and nobody senior to them (their own row aside)
		if not doc.boutique or doc.boutique != get_user_boutique():
			frappe.throw(_("You may only reset PINs in your own boutique"), frappe.PermissionError)
		if doc.role != "Associate" and doc.user != frappe.session.user:
			frappe.throw(_("Only Head Office may reset a {0}'s PIN").format(doc.role), frappe.PermissionError)
	doc.set_pin(pin)
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def upsert(
	user: str,
	boutique: Optional[str] = None,
	role: str = "Associate",
	enabled: Any = 1,
	pin: Optional[str] = None,
	employee: Optional[str] = None,
) -> dict:
	"""Create or update an associate — the supported way for a manager to run their shop floor.

	``user`` / ``boutique`` / ``role`` are permlevel 1, so the generic REST surface can no longer
	set them (v0.7 S1). This endpoint does it behind explicit checks instead: a store manager may
	only touch **their own** boutique and only at **Associate** level, and nobody may hand out a
	rank above their own. Head Office / Regional / System Manager keep the full range.
	"""
	from maison_pos.scoping import ASSOCIATE_ROLE_RANK, assert_boutique_access, is_manager_or_above, is_unrestricted, max_grantable_rank

	if not is_manager_or_above():
		frappe.throw(_("Only managers can manage associates"), frappe.PermissionError)
	user = (user or "").strip()
	if not user or not frappe.db.exists("User", user):
		frappe.throw(_("User {0} not found").format(user), frappe.DoesNotExistError)
	role = (role or "Associate").strip() or "Associate"
	if role not in ROLE_MAP:
		frappe.throw(_("Unknown role {0}").format(role), frappe.ValidationError)
	if ASSOCIATE_ROLE_RANK[role] > max_grantable_rank():
		frappe.throw(_("You may not give an associate the {0} role").format(role), frappe.PermissionError)
	if not is_unrestricted():
		if role != "Associate":
			frappe.throw(_("Only Head Office may appoint managers"), frappe.PermissionError)
		boutique = assert_boutique_access(boutique)
	elif role in ("Associate", "Manager"):
		boutique = assert_boutique_access(boutique)

	existing = frappe.db.exists("AWANZ Associate", {"user": user})
	if existing:
		doc = frappe.get_doc("AWANZ Associate", existing)
		if not is_unrestricted() and doc.boutique != boutique:
			frappe.throw(_("{0} belongs to another boutique").format(user), frappe.PermissionError)
		if not is_unrestricted() and doc.role != "Associate":
			frappe.throw(_("Only Head Office may edit a {0}").format(doc.role), frappe.PermissionError)
		doc.boutique = boutique
		doc.role = role
	else:
		doc = frappe.new_doc("AWANZ Associate")
		doc.user = user
		doc.boutique = boutique
		doc.role = role
	doc.enabled = cint(enabled)
	if employee is not None:
		doc.employee = employee or None
	if pin:
		doc.pin = str(pin).strip()
	doc.flags.ignore_permissions = True
	doc.save()
	return {"name": doc.name, "user": doc.user, "boutique": doc.boutique, "role": doc.role, "enabled": cint(doc.enabled)}
