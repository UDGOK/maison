"""Inbound e-mail/SMS provider webhooks → ``AWANZ Campaign Touch`` (SPEC v0.5 §M).

Signature verification (both providers):

* **Klaviyo** — HMAC-SHA256 of the raw request body with ``site_config.klaviyo_webhook_secret``;
  the digest comes in the ``Klaviyo-Signature`` header (base64 or hex accepted; a
  ``t=<ts>,v1=<sig>``-style value is also understood). Optional replay protection with
  ``Klaviyo-Timestamp`` (5 minutes).
* **Brevo** — Brevo does not sign payloads itself; we accept either an HMAC-SHA256 of the raw
  body in ``X-Brevo-Signature`` (same rule as above) **or** the shared secret itself in
  ``X-Brevo-Token`` / ``?token=`` (configure the header in the Brevo webhook UI). Secret in
  ``site_config.brevo_webhook_secret``.

Without a configured secret the endpoint refuses every call (403) — never "open by default".

Event mapping (lenient, both JSON-API style and flat payloads):

| provider | sent | opened | clicked |
|---|---|---|---|
| Klaviyo metric | ``Received Email`` / ``Received SMS`` / ``sent`` | ``Opened Email`` | ``Clicked Email`` / ``Clicked SMS`` |
| Brevo ``event`` | ``delivered`` / ``request`` / ``sent`` | ``opened`` / ``unique_opened`` | ``click`` / ``clicked`` |

The campaign is resolved from (in order) ``campaign_code`` / ``utm_campaign`` / ``campaign_id``
(matched to ``AWANZ Campaign.campaign_code``, ``klaviyo_campaign_id`` or ``brevo_campaign_id``);
the customer from the e-mail (``Customer.email_id``, then a linked Contact e-mail) or phone.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from typing import Any, Optional

import frappe
from frappe.utils import get_datetime, now_datetime

SENT = "sent"
OPENED = "opened"
CLICKED = "clicked"
EVENT_FIELD = {SENT: "sent_at", OPENED: "opened_at", CLICKED: "clicked_at"}

KLAVIYO_EVENTS = {
	"received email": SENT, "received sms": SENT, "sent": SENT, "sent email": SENT, "delivered": SENT, "delivered email": SENT,
	"opened email": OPENED, "opened": OPENED, "open": OPENED,
	"clicked email": CLICKED, "clicked sms": CLICKED, "clicked": CLICKED, "click": CLICKED,
}
BREVO_EVENTS = {
	"delivered": SENT, "request": SENT, "sent": SENT,
	"opened": OPENED, "unique_opened": OPENED, "open": OPENED, "proxy_open": OPENED,
	"click": CLICKED, "clicked": CLICKED,
}
MAX_SKEW_SECONDS = 300


# ---------------------------------------------------------------------------
# signatures
# ---------------------------------------------------------------------------
def hmac_sha256(secret: str, body: bytes) -> bytes:
	return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()


def _decode_signature(value: str) -> list[bytes]:
	"""Possible raw digests encoded in a header value (hex, base64, ``v1=…`` lists)."""
	out: list[bytes] = []
	value = (value or "").strip()
	parts = [value]
	if "=" in value and "," in value or value.startswith("v1="):
		parts = [p.split("=", 1)[1] for p in value.split(",") if p.strip().startswith("v1=")] or [value]
	for p in parts:
		p = p.strip()
		if re.fullmatch(r"[0-9a-fA-F]{64}", p):
			out.append(bytes.fromhex(p))
		try:
			out.append(base64.b64decode(p + "=" * (-len(p) % 4), validate=False))
		except Exception:
			pass
	return out


def verify_signature(secret: Optional[str], body: bytes, signature: Optional[str], timestamp: Optional[str] = None, now: Optional[float] = None) -> bool:
	"""Constant-time check of ``signature`` (hex/base64 HMAC-SHA256 of *body*) — False when unset."""
	if not secret or not signature:
		return False
	if timestamp:
		try:
			if abs((now or time.time()) - float(timestamp)) > MAX_SKEW_SECONDS:
				return False
		except ValueError:
			return False
	expected = hmac_sha256(secret, body)
	return any(hmac.compare_digest(expected, candidate) for candidate in _decode_signature(signature))


def verify_shared_token(secret: Optional[str], token: Optional[str]) -> bool:
	if not secret or not token:
		return False
	return hmac.compare_digest(secret.encode("utf-8"), token.strip().encode("utf-8"))


# ---------------------------------------------------------------------------
# payload parsing (pure)
# ---------------------------------------------------------------------------
def _first(d: dict[str, Any], *keys: str) -> Any:
	for k in keys:
		if k in d and d[k] not in (None, ""):
			return d[k]
	return None


def _dig(obj: Any, *path: str) -> Any:
	for p in path:
		if not isinstance(obj, dict):
			return None
		obj = obj.get(p)
	return obj


def _events_list(payload: Any) -> list[dict[str, Any]]:
	if isinstance(payload, list):
		return [p for p in payload if isinstance(p, dict)]
	if isinstance(payload, dict):
		for key in ("data", "events", "items"):
			v = payload.get(key)
			if isinstance(v, list):
				return [p for p in v if isinstance(p, dict)]
		return [payload]
	return []


def parse_klaviyo(payload: Any) -> list[dict[str, Any]]:
	"""→ ``[{event, email, phone, campaign_ref, external_id, ts, channel}]``."""
	out = []
	for ev in _events_list(payload):
		attrs = ev.get("attributes") if isinstance(ev.get("attributes"), dict) else ev
		metric = _dig(attrs, "metric", "name") or _dig(attrs, "metric", "data", "attributes", "name") or _dig(ev, "metric", "name") or _first(attrs, "metric", "event", "name", "type")
		props = attrs.get("event_properties") or attrs.get("properties") or {}
		profile = attrs.get("profile") or ev.get("profile") or {}
		if isinstance(profile, dict) and isinstance(profile.get("attributes"), dict):
			profile = profile["attributes"]
		kind = KLAVIYO_EVENTS.get(str(metric or "").strip().lower())
		if not kind:
			continue
		out.append(
			{
				"event": kind,
				"email": (_first(profile, "email", "$email") or _first(attrs, "email") or _first(props, "email") or "").strip().lower() or None,
				"phone": _first(profile, "phone_number", "$phone_number") or _first(attrs, "phone_number"),
				"campaign_ref": _first(props, "campaign_code", "utm_campaign", "Campaign Name", "$message", "campaign_id", "Campaign ID") or _first(attrs, "campaign_code", "utm_campaign", "campaign_id"),
				"external_id": _first(ev, "id") or _first(attrs, "uuid", "id", "event_id"),
				"ts": _first(attrs, "datetime", "timestamp", "time") or _first(ev, "datetime", "timestamp"),
				"channel": "SMS" if "sms" in str(metric).lower() else "Email",
			}
		)
	return out


def parse_brevo(payload: Any) -> list[dict[str, Any]]:
	out = []
	for ev in _events_list(payload):
		kind = BREVO_EVENTS.get(str(_first(ev, "event", "type") or "").strip().lower())
		if not kind:
			continue
		tags = ev.get("tags") or ev.get("tag") or []
		if isinstance(tags, str):
			tags = [tags]
		ts = _first(ev, "date", "ts_event", "ts_epoch", "ts")
		if isinstance(ts, (int, float)) and ts > 10_000_000_000:
			ts = ts / 1000.0
		out.append(
			{
				"event": kind,
				"email": (_first(ev, "email") or "").strip().lower() or None,
				"phone": _first(ev, "phone", "to", "msisdn") if not _first(ev, "email") else None,
				"campaign_ref": _first(ev, "campaign_code", "utm_campaign", "camp_id", "campaign_id", "X-Mailin-custom") or (tags[0] if tags else None),
				"external_id": _first(ev, "message-id", "message_id", "id", "event_id"),
				"ts": ts,
				"channel": "SMS" if _first(ev, "msisdn", "sms") else "Email",
			}
		)
	return out


# ---------------------------------------------------------------------------
# resolution + upsert (I/O)
# ---------------------------------------------------------------------------
def resolve_campaign(ref: Any, provider: str) -> Optional[str]:
	if ref in (None, ""):
		return None
	ref = str(ref).strip()
	if frappe.db.exists("AWANZ Campaign", ref):
		return ref
	field = {"klaviyo": "klaviyo_campaign_id", "brevo": "brevo_campaign_id"}.get(provider)
	if field:
		found = frappe.db.get_value("AWANZ Campaign", {field: ref}, "name")
		if found:
			return found
	return frappe.db.get_value("AWANZ Campaign", {"campaign_code": ref}, "name")


def resolve_customer(email: Optional[str], phone: Optional[str] = None) -> Optional[str]:
	if email:
		found = frappe.db.get_value("Customer", {"email_id": email}, "name")
		if found:
			return found
		contact = frappe.db.get_value("Contact Email", {"email_id": email}, "parent")
		if contact:
			found = frappe.db.get_value("Dynamic Link", {"parent": contact, "parenttype": "Contact", "link_doctype": "Customer"}, "link_name")
			if found:
				return found
	if phone:
		digits = re.sub(r"\D", "", str(phone))
		if len(digits) >= 7:
			found = frappe.db.sql("select name from `tabCustomer` where regexp_replace(ifnull(mobile_no,''), '[^0-9]', '') like %s limit 1", f"%{digits[-10:]}", pluck="name")
			if found:
				return found[0]
	return None


def _ts(value: Any):
	if value in (None, ""):
		return now_datetime()
	if isinstance(value, (int, float)):
		import datetime as _dt

		return _dt.datetime.fromtimestamp(float(value))
	try:
		return get_datetime(str(value).replace("T", " ").replace("Z", ""))
	except Exception:
		return now_datetime()


def record_touch(campaign: str, customer: str, event: str, ts=None, source: str = "Manual", external_id: Optional[str] = None, email: Optional[str] = None, channel: Optional[str] = None) -> str:
	"""Upsert one (campaign, customer) touch and stamp ``sent_at`` / ``opened_at`` / ``clicked_at``.

	A later event implies the earlier ones (a click fills ``sent_at`` when missing). Returns the touch name.
	"""
	ts = _ts(ts)
	field = EVENT_FIELD[event]
	name = frappe.db.get_value("AWANZ Campaign Touch", {"campaign": campaign, "customer": customer}, "name")
	if name:
		doc = frappe.get_doc("AWANZ Campaign Touch", name)
	else:
		doc = frappe.get_doc({"doctype": "AWANZ Campaign Touch", "campaign": campaign, "customer": customer, "source": source, "channel": channel or frappe.db.get_value("AWANZ Campaign", campaign, "channel"), "email": email, "external_id": external_id})
	current = doc.get(field)
	if not current or ts < get_datetime(current):
		doc.set(field, ts)
	if event in (OPENED, CLICKED) and not doc.sent_at:
		doc.sent_at = ts
	if event == CLICKED and not doc.opened_at:
		doc.opened_at = ts
	if external_id and not doc.external_id:
		doc.external_id = external_id
	if email and not doc.email:
		doc.email = email
	doc.flags.ignore_permissions = True
	doc.save() if doc.name else doc.insert()
	return doc.name


def ingest(events: list[dict[str, Any]], provider: str, default_campaign: Optional[str] = None) -> dict[str, Any]:
	"""Store parsed events; returns ``{received, recorded, unmatched: [...]}``."""
	source = {"klaviyo": "Klaviyo", "brevo": "Brevo"}.get(provider, "Manual")
	result: dict[str, Any] = {"received": len(events), "recorded": 0, "unmatched": []}
	for ev in events:
		campaign = resolve_campaign(ev.get("campaign_ref"), provider) or default_campaign
		customer = resolve_customer(ev.get("email"), ev.get("phone"))
		if not campaign or not customer:
			result["unmatched"].append({"event": ev.get("event"), "email": ev.get("email"), "campaign_ref": ev.get("campaign_ref"), "reason": "campaign" if not campaign else "customer"})
			continue
		record_touch(campaign, customer, ev["event"], ev.get("ts"), source=source, external_id=ev.get("external_id"), email=ev.get("email"), channel=ev.get("channel"))
		result["recorded"] += 1
	return result
