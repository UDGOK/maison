"""Identifier helpers: client numbers, receipt tokens, barcodes.

* Client number: ``MC`` + 6 digits (8 chars), unique on ``Customer.maison_client_number``.
* Receipt token: 16-char url-safe string stored on ``Sales Invoice.maison_receipt_token``
  at submit time; the public receipt lives at ``/r/<token>``.
* EAN-13: deterministic code derived from an item code (demo seed) with a valid check digit.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from typing import Optional

import frappe

CLIENT_NUMBER_PREFIX = "MC"
CLIENT_NUMBER_DIGITS = 6
RECEIPT_TOKEN_LENGTH = 16
CUSTOMER_QR_PREFIX = "MC:"
INVOICE_QR_PREFIX = "INV:"

_CLIENT_NUMBER_RE = re.compile(r"^MC\d{6}$")
_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"


def is_client_number(value: Optional[str]) -> bool:
	"""True when *value* looks like ``MC123456`` (case-insensitive, whitespace tolerant)."""
	return bool(value) and bool(_CLIENT_NUMBER_RE.match(str(value).strip().upper()))


def normalize_client_number(value: str) -> str:
	return str(value or "").strip().upper().replace(" ", "")


# --- v0.8 QA C1 — a client number typed on a digits-only keypad ---------------------------------
# The Salon (and the POS client keypad) offer digits only, but the printed number is `MC######`,
# so a client keying the six digits on their card was told "We could not find you". Six digits are
# unambiguous here: a phone lookup needs at least seven.
# ------------------------------------------------------------------------------------------------
def coerce_client_number(value: Optional[str]) -> Optional[str]:
	"""``"MC123456"`` / ``"mc 123456"`` / ``"123456"`` -> ``"MC123456"``; anything else ``None``."""
	raw = normalize_client_number(value or "")
	if not raw:
		return None
	if is_client_number(raw):
		return raw
	if raw.isdigit() and len(raw) == CLIENT_NUMBER_DIGITS:
		return f"{CLIENT_NUMBER_PREFIX}{raw}"
	return None
# --- end v0.8 QA C1 ---


def new_client_number() -> str:
	"""Return an unused ``MC`` + 6-digit client number."""
	for _ in range(100):
		candidate = f"{CLIENT_NUMBER_PREFIX}{secrets.randbelow(10**CLIENT_NUMBER_DIGITS):0{CLIENT_NUMBER_DIGITS}d}"
		if not frappe.db.exists("Customer", {"maison_client_number": candidate}):
			return candidate
	frappe.throw("Could not allocate a unique client number")  # pragma: no cover


def assign_client_number(customer: str) -> Optional[str]:
	"""Set ``maison_client_number`` on an existing Customer if empty; returns the number."""
	current = frappe.db.get_value("Customer", customer, "maison_client_number")
	if current:
		return current
	number = new_client_number()
	frappe.db.set_value("Customer", customer, "maison_client_number", number, update_modified=False)
	return number


def new_receipt_token() -> str:
	"""16-char url-safe token that is not yet used by any Sales Invoice."""
	for _ in range(100):
		token = "".join(secrets.choice(_TOKEN_ALPHABET) for _ in range(RECEIPT_TOKEN_LENGTH))
		if not frappe.db.exists("Sales Invoice", {"maison_receipt_token": token}):
			return token
	frappe.throw("Could not allocate a unique receipt token")  # pragma: no cover


def digits_only(value: Optional[str]) -> str:
	"""Strip everything but digits (phone matching)."""
	return re.sub(r"\D", "", str(value or ""))


def ean13_check_digit(twelve: str) -> str:
	total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(twelve))
	return str((10 - total % 10) % 10)


def is_valid_ean13(code: str) -> bool:
	code = str(code or "")
	return len(code) == 13 and code.isdigit() and ean13_check_digit(code[:12]) == code[12]


def ean13_for(seed: str, prefix: str = "200") -> str:
	"""Deterministic EAN-13 for *seed* using the ``200`` restricted-circulation prefix."""
	digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
	body = str(int(digest[:12], 16)).rjust(12 - len(prefix), "0")[-(12 - len(prefix)):]
	twelve = prefix + body
	return twelve + ean13_check_digit(twelve)
