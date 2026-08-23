"""v0.6 N — 21+ age verification for age-restricted items.

The POS must verify age before an age-restricted item is rung up: the associate scans the
PDF417 barcode on the back of a US driver's licence / state ID (**AAMVA** DL/ID card design
standard) or enters the date of birth read from the ID by hand.

Privacy: the raw barcode payload is parsed on the device *and* re-checked here, but **nothing
but the outcome is stored** — ``Maison Age Check`` keeps method, outcome, age in years, DOB year,
initials (two letters) and whether the ID was expired. No name, licence number, address or
photo ever reaches the database; the Sales Invoice carries ``maison_age_verified / method /
dob_year_ok / checked_by / checked_at`` and a link to the audit row.

AAMVA payload (PDF417 text), version 1 … 10:

    @\\n\\x1e\\rANSI 636026080102DL00410278ZT03190024DLDAQ…\\nDCSDOE\\nDDEN\\nDACJOHN\\n…
    DBB05151990\\nDBA05152030\\nDAJTX\\nDCGUSA\\n…

Elements are three-letter tags at line starts: ``DBB`` date of birth, ``DBA`` expiry, ``DCS``
family name, ``DAC`` / ``DCT`` given name, ``DAJ`` jurisdiction, ``DCG`` country. Dates are
``MMDDCCYY`` for US cards (AAMVA ≥ 2) and ``CCYYMMDD`` for Canada and AAMVA version 1.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, getdate, now_datetime, nowdate

from maison_pos.brand import get_age_settings
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, get_associate

ERR_AGE = "AGE_VERIFICATION"

OUTCOME_VERIFIED = "Verified"
OUTCOME_UNDERAGE = "Underage"
OUTCOME_EXPIRED = "Expired"
OUTCOME_UNREADABLE = "Unreadable"
OUTCOME_DECLINED = "Declined"

_TAG_RE = re.compile(r"^(D[A-Z]{2}|Z[A-Z]{2})(.*)$")


class AgeVerificationError(frappe.ValidationError):
	"""Raised by ``sales.submit_batch`` when an invoice with restricted items lacks a valid check."""


# ---------------------------------------------------------------------------
# pure parsing (no DB)
# ---------------------------------------------------------------------------
def _parse_aamva_date(raw: str, country: str = "USA", version: int = 0) -> Optional[_dt.date]:
	digits = re.sub(r"\D", "", raw or "")
	if len(digits) != 8:
		return None
	year_first = country.upper().startswith("CAN") or version == 1
	if not year_first:
		# heuristic: a leading "19xx"/"20xx" that cannot be a month means CCYYMMDD anyway
		if digits[:2] in ("19", "20") and int(digits[4:6]) <= 12 and int(digits[:2] + digits[2:4]) > 1900:
			# ambiguous only when MMDD would also be valid (e.g. 2005 → month 20 invalid => year first)
			if int(digits[:2]) > 12:
				year_first = True
	try:
		if year_first:
			return _dt.date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
		return _dt.date(int(digits[4:8]), int(digits[:2]), int(digits[2:4]))
	except ValueError:
		return None


def parse_aamva(raw: str) -> dict[str, Any]:
	"""Parse an AAMVA PDF417 payload into the few fields the age gate needs.

	Returns ``{ok, dob, expiry, initials, jurisdiction, country, version, reason?}`` —
	``dob`` / ``expiry`` are ``datetime.date`` (or None). Never returns the name.
	"""
	text = (raw or "").replace("\r\n", "\n").replace("\r", "\n")
	if not text.strip():
		return {"ok": False, "reason": "empty"}
	version = 0
	m = re.search(r"ANSI\s?(\d{6})(\d{2})", text)
	if m:
		version = cint(m.group(2))
	elif "AAMVA" in text:
		version = 1
	fields: dict[str, str] = {}
	for line in re.split(r"[\n\x1e\x1d]", text):
		line = line.strip("\x1e\x1d\x0d ")
		if not line:
			continue
		# the first data line is glued to the header: "...DLDAQ12345"
		idx = line.find("DAQ")
		if idx > 0 and not _TAG_RE.match(line):
			line = line[idx:]
		mm = _TAG_RE.match(line)
		if not mm:
			continue
		tag, value = mm.group(1), mm.group(2).strip()
		fields.setdefault(tag, value)
	country = (fields.get("DCG") or "USA").upper()
	dob = _parse_aamva_date(fields.get("DBB", ""), country, version)
	expiry = _parse_aamva_date(fields.get("DBA", ""), country, version)
	family = fields.get("DCS") or ""
	given = fields.get("DAC") or fields.get("DCT") or ""
	if not family and not given and fields.get("DAA"):
		# AAMVA v1: "DAA" = LAST,FIRST,MIDDLE
		parts = [p for p in re.split(r"[,\s]+", fields["DAA"]) if p]
		family = parts[0] if parts else ""
		given = parts[1] if len(parts) > 1 else ""
	initials = ((given[:1] or "") + (family[:1] or "")).upper() or None
	out: dict[str, Any] = {
		"ok": dob is not None,
		"dob": dob,
		"expiry": expiry,
		"initials": initials,
		"jurisdiction": fields.get("DAJ") or None,
		"country": country,
		"version": version,
	}
	if dob is None:
		out["reason"] = "no_dob"
	return out


def age_on(dob: _dt.date, on: Optional[_dt.date] = None) -> int:
	on = on or getdate(nowdate())
	years = on.year - dob.year
	if (on.month, on.day) < (dob.month, dob.day):
		years -= 1
	return years


def evaluate(dob: Optional[_dt.date], expiry: Optional[_dt.date], minimum_age: int, today: Optional[_dt.date] = None) -> dict[str, Any]:
	"""Pure decision: ``{outcome, age, ok, dob_year_ok, expired}``."""
	today = today or getdate(nowdate())
	if dob is None:
		return {"outcome": OUTCOME_UNREADABLE, "age": None, "ok": False, "dob_year_ok": 0, "expired": 0}
	age = age_on(dob, today)
	expired = 1 if expiry is not None and expiry < today else 0
	dob_year_ok = 1 if (today.year - dob.year) >= minimum_age else 0
	if age < minimum_age:
		return {"outcome": OUTCOME_UNDERAGE, "age": age, "ok": False, "dob_year_ok": dob_year_ok, "expired": expired}
	if expired:
		return {"outcome": OUTCOME_EXPIRED, "age": age, "ok": False, "dob_year_ok": dob_year_ok, "expired": 1}
	return {"outcome": OUTCOME_VERIFIED, "age": age, "ok": True, "dob_year_ok": dob_year_ok, "expired": 0}


# ---------------------------------------------------------------------------
# settings / restricted items
# ---------------------------------------------------------------------------
def is_restricted_item(item_code: str) -> bool:
	return bool(cint(frappe.db.get_value("Item", item_code, "maison_age_restricted")))


def restricted_items_in(items: list[dict[str, Any]]) -> list[str]:
	codes = {str(r.get("item_code")) for r in items if r.get("item_code")}
	if not codes:
		return []
	rows = frappe.get_all("Item", filters={"name": ("in", list(codes)), "maison_age_restricted": 1}, pluck="name")
	return sorted(rows)


# ---------------------------------------------------------------------------
# whitelisted API
# ---------------------------------------------------------------------------
def _log(boutique: Optional[str], method: str, result: dict[str, Any], parsed: dict[str, Any], device_id: Optional[str], offline_uuid: Optional[str], reason: Optional[str] = None) -> str:
	assoc = None
	try:
		assoc = get_associate()
		assoc = assoc.name if assoc else None
	except Exception:
		assoc = None
	doc = frappe.get_doc(
		{
			"doctype": "Maison Age Check",
			"boutique": boutique,
			"associate": assoc,
			"device_id": device_id,
			"method": method,
			"outcome": result["outcome"],
			"ts": now_datetime(),
			"age_years": result.get("age"),
			"dob_year_ok": cint(result.get("dob_year_ok")),
			"minimum_age": cint(result.get("minimum_age")),
			"initials": parsed.get("initials"),
			"id_expired": cint(result.get("expired")),
			"issuer": parsed.get("jurisdiction"),
			"dob_year": parsed["dob"].year if parsed.get("dob") else None,
			"offline_uuid": offline_uuid,
			"reason": reason,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def _check(boutique: Optional[str], method: str, parsed: dict[str, Any], device_id: Optional[str], offline_uuid: Optional[str]) -> dict[str, Any]:
	settings = get_age_settings()
	minimum = settings["minimum_age"]
	result = evaluate(parsed.get("dob"), parsed.get("expiry"), minimum)
	result["minimum_age"] = minimum
	reason = parsed.get("reason")
	name = _log(boutique, method, result, parsed, device_id, offline_uuid, reason)
	return {
		"ok": bool(result["ok"]),
		"verified": 1 if result["ok"] else 0,
		"outcome": result["outcome"],
		"method": method,
		"age": result.get("age"),
		"minimum_age": minimum,
		"dob_year_ok": cint(result.get("dob_year_ok")),
		"expired": cint(result.get("expired")),
		"initials": parsed.get("initials"),
		"jurisdiction": parsed.get("jurisdiction"),
		"check": name,
		"checked_at": str(now_datetime()),
		"message": _outcome_message(result["outcome"], minimum, result.get("age")),
	}


def _outcome_message(outcome: str, minimum: int, age: Optional[int]) -> str:
	if outcome == OUTCOME_VERIFIED:
		return _("ID verified — {0}+").format(minimum)
	if outcome == OUTCOME_UNDERAGE:
		return _("Under {0} — sale of age-restricted items refused").format(minimum)
	if outcome == OUTCOME_EXPIRED:
		return _("ID expired — ask for a valid ID")
	if outcome == OUTCOME_UNREADABLE:
		return _("Could not read the date of birth — enter it manually")
	return _("Age verification declined")


@frappe.whitelist()
def settings() -> dict[str, Any]:
	"""Age-gate switches for the POS / Salon."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	return get_age_settings()


@frappe.whitelist()
def verify_scan(raw: str, boutique: Optional[str] = None, device_id: Optional[str] = None, offline_uuid: Optional[str] = None) -> dict[str, Any]:
	"""Scan path: AAMVA PDF417 payload in, masked outcome out (+ audit row). The payload is not stored."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if boutique:
		boutique = assert_boutique_access(boutique)
	if not get_age_settings()["id_scan_enabled"]:
		frappe.throw(_("ID scanning is disabled by Head Office"), frappe.ValidationError)
	parsed = parse_aamva(raw or "")
	return _check(boutique, "Scan", parsed, device_id, offline_uuid)


@frappe.whitelist()
def verify_manual(dob: str, boutique: Optional[str] = None, expiry: Optional[str] = None, initials: Optional[str] = None, device_id: Optional[str] = None, offline_uuid: Optional[str] = None) -> dict[str, Any]:
	"""Manual path: the associate read the DOB (and optionally the expiry) off the ID."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if boutique:
		boutique = assert_boutique_access(boutique)
	try:
		dob_d = getdate(dob) if dob else None
	except Exception:
		dob_d = None
	try:
		exp_d = getdate(expiry) if expiry else None
	except Exception:
		exp_d = None
	parsed: dict[str, Any] = {"ok": dob_d is not None, "dob": dob_d, "expiry": exp_d, "initials": (initials or "")[:2].upper() or None, "jurisdiction": None}
	if dob_d is None:
		parsed["reason"] = "no_dob"
	return _check(boutique, "Manual", parsed, device_id, offline_uuid)


@frappe.whitelist()
def decline(boutique: Optional[str] = None, device_id: Optional[str] = None, offline_uuid: Optional[str] = None) -> dict[str, Any]:
	"""The client could not / would not show an ID — logged, sale of restricted items refused."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if boutique:
		boutique = assert_boutique_access(boutique)
	result = {"outcome": OUTCOME_DECLINED, "age": None, "ok": False, "dob_year_ok": 0, "expired": 0, "minimum_age": get_age_settings()["minimum_age"]}
	name = _log(boutique, "Manual", result, {}, device_id, offline_uuid, "declined")
	return {"ok": False, "verified": 0, "outcome": OUTCOME_DECLINED, "check": name, "message": _outcome_message(OUTCOME_DECLINED, result["minimum_age"], None)}


# ---------------------------------------------------------------------------
# invoice gate (called from sales.build_sales_invoice)
# ---------------------------------------------------------------------------
def apply_to_invoice(si, payload: dict[str, Any]) -> None:
	"""Refuse a POS invoice with age-restricted lines unless the payload carries a valid check.

	``payload["age_check"]`` = ``{verified, method, dob_year_ok, check, checked_at}`` as returned
	by ``verify_scan`` / ``verify_manual`` (offline devices may send ``{verified:1, method:"Manual",
	offline:1, dob_year_ok}`` — the check row is then created on submit with ``reason = offline``).
	"""
	settings = get_age_settings()
	restricted = restricted_items_in([{"item_code": r.item_code} for r in si.items])
	if not restricted or not settings["age_verification_required"] or frappe.flags.in_history_seed:
		return
	check = payload.get("age_check") or {}
	if isinstance(check, str):
		import json

		try:
			check = json.loads(check)
		except Exception:
			check = {}
	if not cint(check.get("verified")):
		raise AgeVerificationError(
			_("Age verification ({0}+) is required for: {1}").format(settings["minimum_age"], ", ".join(restricted))
		)
	method = "Scan" if str(check.get("method", "")).lower().startswith("s") else "Manual"
	name = check.get("check")
	if name and frappe.db.exists("Maison Age Check", name):
		row = frappe.db.get_value("Maison Age Check", name, ["outcome", "dob_year_ok", "method"], as_dict=True)
		if row.outcome != OUTCOME_VERIFIED:
			raise AgeVerificationError(_("Age check {0} did not pass ({1})").format(name, row.outcome))
		method = row.method or method
		dob_year_ok = cint(row.dob_year_ok)
	else:
		# offline verification: create the audit row now (masked fields only)
		result = {"outcome": OUTCOME_VERIFIED, "age": cint(check.get("age")) or None, "ok": True, "dob_year_ok": cint(check.get("dob_year_ok")), "expired": 0, "minimum_age": settings["minimum_age"]}
		name = _log(si.get("maison_boutique"), method, result, {"initials": check.get("initials"), "jurisdiction": check.get("jurisdiction")}, si.get("maison_device_id"), payload.get("offline_uuid"), "offline" if cint(check.get("offline")) else None)
		dob_year_ok = cint(check.get("dob_year_ok"))
	si.maison_age_verified = 1
	si.maison_age_method = method
	si.maison_age_dob_year_ok = dob_year_ok
	si.maison_age_checked_by = si.get("maison_associate")
	si.maison_age_checked_at = check.get("checked_at") or now_datetime()
	si.maison_age_check = name


def link_check_to_invoice(doc, method: Optional[str] = None) -> None:
	"""Sales Invoice on_submit: stamp the invoice name on the audit row."""
	if doc.get("maison_age_check") and frappe.db.exists("Maison Age Check", doc.maison_age_check):
		frappe.db.set_value("Maison Age Check", doc.maison_age_check, "sales_invoice", doc.name, update_modified=False)


@frappe.whitelist()
def recent(boutique: Optional[str] = None, limit: int = 50) -> list[dict[str, Any]]:
	"""Recent checks (managers: own store)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	filters: dict[str, Any] = {}
	if boutique:
		filters["boutique"] = assert_boutique_access(boutique)
	return frappe.get_all(
		"Maison Age Check",
		filters=filters,
		fields=["name", "boutique", "associate", "method", "outcome", "ts", "age_years", "dob_year_ok", "id_expired", "issuer", "sales_invoice"],
		order_by="ts desc",
		limit=cint(limit) or 50,
	)
