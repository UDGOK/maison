"""Maison Associate: links a User to a boutique, with a hashed POS unlock PIN."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime

PIN_RE = re.compile(r"^\d{4,6}$")
PBKDF2_ITERATIONS = 120_000
MAX_FAILED_ATTEMPTS = 5

ROLE_MAP = {
	"Associate": "Maison Associate",
	"Manager": "Maison Manager",
	"Regional": "Maison Regional",
	"HeadOffice": "Maison Head Office",
}


def hash_pin(pin: str, salt: str | None = None, iterations: int = PBKDF2_ITERATIONS) -> str:
	"""Return ``pbkdf2_sha256$<iter>$<salt>$<hexdigest>`` for *pin*."""
	salt = salt or secrets.token_hex(16)
	digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt.encode("utf-8"), iterations).hex()
	return f"pbkdf2_sha256${iterations}${salt}${digest}"


def check_pin(pin: str, stored: str | None) -> bool:
	"""Constant-time comparison of *pin* against a stored hash string."""
	if not stored or not pin:
		return False
	try:
		algo, iterations, salt, digest = stored.split("$", 3)
	except ValueError:
		return False
	if algo != "pbkdf2_sha256":
		return False
	candidate = hash_pin(pin, salt=salt, iterations=int(iterations)).split("$", 3)[3]
	return hmac.compare_digest(candidate, digest)


class MaisonAssociate(Document):
	def validate(self) -> None:
		self._validate_boutique_for_role()
		self._hash_new_pin()

	def on_update(self) -> None:
		self._sync_user_role()

	# -- validation -------------------------------------------------------
	def _validate_boutique_for_role(self) -> None:
		if self.role in ("Associate", "Manager") and not self.boutique:
			frappe.throw(_("Boutique is required for Associates and Managers"), frappe.ValidationError)

	def _hash_new_pin(self) -> None:
		if not self.pin:
			return
		if not PIN_RE.match(str(self.pin)):
			frappe.throw(_("PIN must be 4 to 6 digits"), frappe.ValidationError)
		self.pin_hash = hash_pin(str(self.pin))
		self.pin_set_on = now_datetime()
		self.failed_pin_attempts = 0
		self.pin = None  # never persist the clear-text PIN

	def _sync_user_role(self) -> None:
		"""Ensure the linked User carries the matching ``Maison *`` role."""
		role = ROLE_MAP.get(self.role)
		if not role or not frappe.db.exists("Role", role):
			return
		if not frappe.db.exists("Has Role", {"parent": self.user, "role": role, "parenttype": "User"}):
			user = frappe.get_doc("User", self.user)
			user.append("roles", {"role": role})
			user.flags.ignore_permissions = True
			user.save()

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
		ok = check_pin(str(pin or ""), self.pin_hash)
		if ok:
			if self.failed_pin_attempts:
				frappe.db.set_value(self.doctype, self.name, "failed_pin_attempts", 0, update_modified=False)
		else:
			frappe.db.set_value(
				self.doctype,
				self.name,
				"failed_pin_attempts",
				(self.failed_pin_attempts or 0) + 1,
				update_modified=False,
			)
		return ok


@frappe.whitelist()
def verify_pin(associate: str, pin: str) -> dict:
	"""POS unlock: verify *pin* for *associate* (must belong to the caller's boutique).

	Returns ``{ok: bool, associate, full_name, boutique, role}``.
	"""
	from maison_pos.scoping import assert_boutique_access

	doc = frappe.get_doc("Maison Associate", associate)
	assert_boutique_access(doc.boutique)
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
	from maison_pos.scoping import assert_boutique_access, is_manager_or_above

	if not is_manager_or_above():
		frappe.throw(_("Only managers can reset PINs"), frappe.PermissionError)
	doc = frappe.get_doc("Maison Associate", associate)
	assert_boutique_access(doc.boutique)
	doc.set_pin(pin)
	return {"ok": True}
