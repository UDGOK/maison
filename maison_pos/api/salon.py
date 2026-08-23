"""Maison Salon — client-facing screen (v0.5 section K).

Two devices share a ``Maison Salon Session``:

* the **POS** (an authenticated Maison associate) asks for a 6-digit pairing code
  (``pairing_code``), then publishes the screen it wants the client to see
  (``publish``: idle / identify / basket / pay / receipt / consent / concierge …) and reads the
  Salon's messages (``pos_poll``);
* the **Salon** (an iPad facing the client — a *guest* session) pairs with the code
  (``pair``) and from then on presents the session token (= the document name, 32 random chars)
  on every call: ``state`` (poll), ``identify``, ``signup``, ``consent``, ``ask``, ``feedback``,
  ``preferences``, ``invite``, ``email_receipt``.

Transport: every state change / message is also published to the document's realtime room
(``frappe.publish_realtime(doctype=…, docname=token)``); the Salon joins it with
``doc_subscribe`` (Guest has *read* on the doctype — but never *list*, see
``maison_pos.scoping.salon_session_query``) and both sides poll every 2 s as a fallback.

Privacy: the Salon only ever receives the client's first name, masked contact details, tier
and points; the POS payload is sanitised server-side (``sanitize_state``) before it is stored
or broadcast, and ``identify`` returns the same masked shape. Sessions expire after
``SESSION_HOURS`` (12) or on unpair.
"""

from __future__ import annotations

import json
import re
import secrets
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, flt, get_datetime, now_datetime

from maison_pos.identifiers import digits_only
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, get_associate

DOCTYPE = "Maison Salon Session"
PAIR_CODE_TTL_SECONDS = 10 * 60
SESSION_HOURS = 12
MAX_INBOX = 50
MAX_QUESTION = 500
MAX_COMMENT = 2000
SCREENS = ("idle", "identify", "client", "basket", "pay", "approved", "receipt", "consent", "feedback", "concierge")
PRIVATE_KEYS = {"mobile_no", "email_id", "phone", "email", "address", "address_line", "birthday", "anniversary", "spouse_name"}
STATE_EVENT = "salon_state"
MESSAGE_EVENT = "salon_message"
PAIRED_EVENT = "salon_paired"


# ---------------------------------------------------------------------------
# masking (mirrored in frontend/src/salon/mask.ts)
# ---------------------------------------------------------------------------
def mask_phone(phone: Optional[str]) -> Optional[str]:
	"""``+1 312 555 0105`` → ``•••• 0105`` (last 4 digits only; ``None`` when absent)."""
	digits = digits_only(phone)
	if not digits:
		return None
	return "•••• " + digits[-4:] if len(digits) >= 4 else "••••"


def mask_email(email: Optional[str]) -> Optional[str]:
	"""``mei-lin.chen@example.com`` → ``m•••@example.com``."""
	email = (email or "").strip()
	if "@" not in email:
		return None
	local, domain = email.rsplit("@", 1)
	return f"{local[:1]}•••@{domain}" if local else f"•••@{domain}"


def mask_client_number(number: Optional[str]) -> Optional[str]:
	"""``MC595284`` → ``MC •• 284``."""
	if not number:
		return None
	number = str(number).strip()
	return f"{number[:2]} •• {number[-3:]}" if len(number) > 5 else number


def first_name(full: Optional[str]) -> str:
	return (full or "").strip().split(" ")[0] if full else ""


def client_summary(customer: str) -> dict[str, Any]:
	"""The only client shape the Salon ever sees (masked contact, first name, tier, points)."""
	from maison_pos.api.customers import _loyalty

	row = frappe.db.get_value("Customer", customer, ["name", "customer_name", "mobile_no", "email_id", "maison_client_number", "maison_face_consent"], as_dict=True)
	if not row:
		frappe.throw(_("Client not found"), frappe.DoesNotExistError)
	points, tier, points_value = _loyalty(row.name)
	progress: dict[str, Any] = {}
	try:
		from maison_pos.api.promotions import tier_progress

		tp = tier_progress(row.name)
		progress = {"next_tier": tp.get("next_tier"), "to_next_tier": tp.get("to_next_tier"), "progress": tp.get("progress"), "tier": tp.get("tier") or tier}
	except Exception:
		progress = {}
	return {
		"customer": row.name,
		"first_name": first_name(row.customer_name),
		"customer_name": row.customer_name,
		"client_number_masked": mask_client_number(row.maison_client_number),
		"phone_masked": mask_phone(row.mobile_no),
		"email_masked": mask_email(row.email_id),
		"has_email": bool(row.email_id),
		"tier": progress.get("tier") or tier,
		"loyalty_points": points,
		"points_value": points_value,
		"face_consent": cint(row.maison_face_consent),
		"next_tier": progress.get("next_tier"),
		"to_next_tier": progress.get("to_next_tier"),
		"tier_progress": progress.get("progress"),
	}


def sanitize_state(payload: Any) -> Any:
	"""Strip every private key (recursively) and mask whatever contact detail slipped through."""
	if isinstance(payload, dict):
		out: dict[str, Any] = {}
		for k, v in payload.items():
			key = str(k)
			if key in PRIVATE_KEYS:
				continue
			out[key] = sanitize_state(v)
		if "customer_name" in out and "first_name" not in out:
			out["first_name"] = first_name(out.get("customer_name"))
		if "client_number" in out:
			out["client_number_masked"] = mask_client_number(out.pop("client_number"))
		return out
	if isinstance(payload, list):
		return [sanitize_state(v) for v in payload]
	return payload


# ---------------------------------------------------------------------------
# session helpers
# ---------------------------------------------------------------------------
def _loads(value: Any, default: Any) -> Any:
	if value in (None, ""):
		return default
	if isinstance(value, (dict, list)):
		return value
	try:
		return json.loads(value)
	except Exception:
		return default


def _request_ip() -> Optional[str]:
	return getattr(frappe.local, "request_ip", None)


def _rate_limit(key: str, limit: int, window: int = 60) -> None:
	if frappe.flags.in_test:
		return
	ip = _request_ip() or "local"
	ck = f"maison_salon_rl:{key}:{ip}"
	count = cint(frappe.cache().get_value(ck) or 0)
	if count >= limit:
		frappe.throw(_("Too many attempts, please wait a moment"), frappe.ValidationError)
	frappe.cache().set_value(ck, count + 1, expires_in_sec=window)


def get_session(token: str, *, for_salon: bool = True):
	"""Active session for *token*; raises ``PermissionError`` on unknown / expired / unpaired."""
	token = (token or "").strip()
	if not token or len(token) > 64 or not re.match(r"^[A-Za-z0-9_-]+$", token):
		frappe.throw(_("Salon session not found"), frappe.PermissionError)
	if not frappe.db.exists(DOCTYPE, token):
		frappe.throw(_("Salon session not found"), frappe.PermissionError)
	doc = frappe.get_doc(DOCTYPE, token)
	if doc.status != "Paired":
		frappe.throw(_("Salon session ended"), frappe.PermissionError)
	if doc.expires_at and now_datetime() >= get_datetime(doc.expires_at):
		doc.db_set({"status": "Expired", "unpaired_at": now_datetime()}, update_modified=False)
		frappe.throw(_("Salon session expired"), frappe.PermissionError)
	doc.db_set("last_salon_seen" if for_salon else "last_pos_seen", now_datetime(), update_modified=False)
	return doc


def _active_session_for_pos(boutique: str, pos_device_id: str):
	name = frappe.db.get_value(DOCTYPE, {"boutique": boutique, "pos_device_id": pos_device_id, "status": "Paired"}, "name", order_by="paired_at desc")
	if not name:
		return None
	doc = frappe.get_doc(DOCTYPE, name)
	if doc.expires_at and now_datetime() >= get_datetime(doc.expires_at):
		doc.db_set({"status": "Expired", "unpaired_at": now_datetime()}, update_modified=False)
		return None
	return doc


def _session_public(doc, include_state: bool = True) -> dict[str, Any]:
	boutique = frappe.db.get_value("Maison Boutique", doc.boutique, ["boutique_name", "city"], as_dict=True) or {}
	out = {
		"token": doc.name,
		"boutique": doc.boutique,
		"boutique_name": boutique.get("boutique_name"),
		"city": boutique.get("city"),
		"status": doc.status,
		"paired_at": str(doc.paired_at) if doc.paired_at else None,
		"expires_at": str(doc.expires_at) if doc.expires_at else None,
		"pos_device_id": doc.pos_device_id,
		"salon_device_id": doc.salon_device_id,
		"seq": cint(doc.state_seq),
		"screen": doc.screen or "idle",
		"server_time": str(now_datetime()),
	}
	if include_state:
		out["state"] = _loads(doc.state, {}) or {"screen": "idle"}
	return out


def _push_inbox(doc, kind: str, payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
	"""Append a Salon → POS message and broadcast it (``salon_message``)."""
	inbox = _loads(doc.inbox, [])
	seq = cint(doc.inbox_seq) + 1
	msg = {"seq": seq, "type": kind, "ts": str(now_datetime()), **(payload or {})}
	inbox = (inbox + [msg])[-MAX_INBOX:]
	doc.db_set({"inbox": json.dumps(inbox), "inbox_seq": seq}, update_modified=False)
	frappe.publish_realtime(MESSAGE_EVENT, {"token": doc.name, "message": msg}, doctype=DOCTYPE, docname=doc.name, after_commit=True)
	return msg


def _set_state(doc, screen: str, payload: dict[str, Any]) -> dict[str, Any]:
	seq = cint(doc.state_seq) + 1
	state = {"screen": screen, "seq": seq, "ts": str(now_datetime()), **payload}
	doc.db_set({"state": json.dumps(state), "state_seq": seq, "screen": screen}, update_modified=False)
	frappe.publish_realtime(STATE_EVENT, {"token": doc.name, "state": state}, doctype=DOCTYPE, docname=doc.name, after_commit=True)
	return state


def _attach_customer(doc, customer: str, how: str, created: bool = False) -> dict[str, Any]:
	"""Record the client on the session and tell the POS to attach it to the sale."""
	summary = client_summary(customer)
	doc.db_set("customer", customer, update_modified=False)
	msg = _push_inbox(doc, "client_attached", {"customer": customer, "how": how, "created": created, "client": summary})
	# optimistic mirror so a Salon that polls sees itself attached even before the POS republishes
	state = _loads(doc.state, {}) or {}
	_set_state(doc, "client", {**{k: v for k, v in state.items() if k not in ("seq", "ts", "screen")}, "client": summary, "pending_pos": True})
	return {"ok": True, "client": summary, "created": created, "message_seq": msg["seq"]}


# ---------------------------------------------------------------------------
# POS side (authenticated)
# ---------------------------------------------------------------------------
@frappe.whitelist()
def pairing_code(boutique: str, pos_device_id: str) -> dict[str, Any]:
	"""Associate: a fresh 6-digit code (10 min TTL) the Salon enters or scans (``MS:<code>``).

	The code lives on a *Pending* ``Maison Salon Session`` row (not in the cache, which any
	``clear_cache`` would wipe); ``pair`` promotes that row to *Paired*.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	pos_device_id = (pos_device_id or "").strip()
	if not pos_device_id:
		frappe.throw(_("pos_device_id is required"), frappe.ValidationError)
	now = now_datetime()
	# one pending code per POS device
	for old in frappe.get_all(DOCTYPE, filters={"pos_device_id": pos_device_id, "status": "Pending"}, pluck="name"):
		frappe.db.set_value(DOCTYPE, old, {"status": "Expired", "unpaired_at": now}, update_modified=False)
	code = None
	for _attempt in range(10):
		candidate = f"{secrets.randbelow(1_000_000):06d}"
		if not frappe.db.exists(DOCTYPE, {"pairing_code": candidate, "status": "Pending"}):
			code = candidate
			break
	if not code:
		frappe.throw(_("Could not allocate a pairing code"), frappe.ValidationError)
	expires_at = add_to_date(now, seconds=PAIR_CODE_TTL_SECONDS)
	doc = frappe.get_doc(
		{
			"doctype": DOCTYPE,
			"boutique": boutique,
			"pos_device_id": pos_device_id,
			"status": "Pending",
			"pairing_code": code,
			"code_expires_at": expires_at,
			"paired_by": frappe.session.user,
			"state": json.dumps({"screen": "idle", "seq": 1}),
			"state_seq": 1,
			"screen": "idle",
			"inbox": "[]",
			"inbox_seq": 0,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	base = frappe.utils.get_url()
	return {
		"code": code,
		"expires_at": str(expires_at),
		"ttl_seconds": PAIR_CODE_TTL_SECONDS,
		"qr": f"MS:{code}",
		"salon_url": f"{base}/salon?code={code}",
		"boutique": boutique,
		"pos_device_id": pos_device_id,
	}


@frappe.whitelist()
def pos_status(boutique: str, pos_device_id: str, since: int = 0) -> dict[str, Any]:
	"""Associate: the active session for this POS device (+ inbox messages after ``since``)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	doc = _active_session_for_pos(boutique, pos_device_id)
	if not doc:
		return {"paired": False, "session": None, "messages": [], "inbox_seq": 0}
	doc.db_set("last_pos_seen", now_datetime(), update_modified=False)
	messages = [m for m in _loads(doc.inbox, []) if cint(m.get("seq")) > cint(since)]
	return {"paired": True, "session": _session_public(doc), "messages": messages, "inbox_seq": cint(doc.inbox_seq)}


@frappe.whitelist()
def pos_poll(session: str, since: int = 0) -> dict[str, Any]:
	"""Associate: Salon → POS messages with ``seq > since`` (2 s fallback polling)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	doc = get_session(session, for_salon=False)
	assert_boutique_access(doc.boutique)
	messages = [m for m in _loads(doc.inbox, []) if cint(m.get("seq")) > cint(since)]
	return {"ok": True, "status": doc.status, "inbox_seq": cint(doc.inbox_seq), "messages": messages, "seq": cint(doc.state_seq), "screen": doc.screen or "idle"}


@frappe.whitelist()
def publish(session: str, event: str, payload: Any = None) -> dict[str, Any]:
	"""Associate: set the Salon screen. ``event`` ∈ SCREENS; ``payload`` is sanitised and re-broadcast."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	doc = get_session(session, for_salon=False)
	assert_boutique_access(doc.boutique)
	event = (event or "").strip()
	if event not in SCREENS:
		frappe.throw(_("Unknown salon event {0}").format(event), frappe.ValidationError)
	data = _loads(payload, {}) or {}
	if not isinstance(data, dict):
		frappe.throw(_("payload must be an object"), frappe.ValidationError)
	data = sanitize_state(data)
	# the server is the source of truth for the client shape
	customer = data.get("customer")
	if isinstance(customer, str) and frappe.db.exists("Customer", customer):
		data["client"] = client_summary(customer)
		doc.db_set("customer", customer, update_modified=False)
	elif customer is None and "client" in data:
		data.pop("client", None)
	data.pop("customer", None)
	if event == "receipt" and data.get("sales_invoice") and frappe.db.exists("Sales Invoice", data["sales_invoice"]):
		doc.db_set("sales_invoice", data["sales_invoice"], update_modified=False)
	if event == "idle":
		doc.db_set({"customer": None, "sales_invoice": None, "pending_consent": None}, update_modified=False)
	state = _set_state(doc, event, data)
	return {"ok": True, "seq": state["seq"], "screen": event}


@frappe.whitelist()
def unpair_pos(session: Optional[str] = None, boutique: Optional[str] = None, pos_device_id: Optional[str] = None) -> dict[str, Any]:
	"""Associate: end the session (by token, or the active one for this POS device)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	doc = None
	if session and frappe.db.exists(DOCTYPE, session):
		doc = frappe.get_doc(DOCTYPE, session)
	elif boutique and pos_device_id:
		doc = _active_session_for_pos(assert_boutique_access(boutique), pos_device_id)
	if not doc:
		return {"ok": True, "unpaired": False}
	assert_boutique_access(doc.boutique)
	return {"ok": True, "unpaired": _end(doc)}


def _end(doc) -> bool:
	if doc.status != "Paired":
		return False
	doc.db_set({"status": "Unpaired", "unpaired_at": now_datetime()}, update_modified=False)
	frappe.publish_realtime(STATE_EVENT, {"token": doc.name, "state": {"screen": "unpaired", "seq": cint(doc.state_seq) + 1}}, doctype=DOCTYPE, docname=doc.name, after_commit=True)
	return True


# ---------------------------------------------------------------------------
# Salon side (guest + token)
# ---------------------------------------------------------------------------
@frappe.whitelist(allow_guest=True, methods=["POST"])
def pair(code: str, salon_device_id: Optional[str] = None) -> dict[str, Any]:
	"""Guest: redeem a pairing code → session token. Older sessions of the same POS are ended."""
	_rate_limit("pair", 12)
	code = digits_only(str(code or "").upper().replace("MS:", ""))
	if len(code) != 6:
		frappe.throw(_("Enter the 6-digit code shown on the point of sale"), frappe.ValidationError)
	now = now_datetime()
	name = frappe.db.get_value(DOCTYPE, {"pairing_code": code, "status": "Pending"}, "name", order_by="creation desc")
	if not name or now >= get_datetime(frappe.db.get_value(DOCTYPE, name, "code_expires_at")):
		if name:
			frappe.db.set_value(DOCTYPE, name, {"status": "Expired", "unpaired_at": now}, update_modified=False)
		frappe.throw(_("That code is not valid any more — ask the associate for a new one"), frappe.ValidationError)
	doc = frappe.get_doc(DOCTYPE, name)
	for old in frappe.get_all(DOCTYPE, filters={"boutique": doc.boutique, "pos_device_id": doc.pos_device_id, "status": "Paired"}, pluck="name"):
		_end(frappe.get_doc(DOCTYPE, old))
	doc.db_set(
		{
			"status": "Paired",
			"salon_device_id": (salon_device_id or "").strip()[:140] or None,
			"paired_at": now,
			"expires_at": add_to_date(now, hours=SESSION_HOURS),
			"last_salon_seen": now,
			"pairing_code": None,
			"code_expires_at": None,
		},
		update_modified=False,
	)
	doc.reload()
	# tell the POS (its user room) so the Settings card flips to "Paired" without polling
	if doc.paired_by:
		frappe.publish_realtime(PAIRED_EVENT, {"token": doc.name, "pos_device_id": doc.pos_device_id, "boutique": doc.boutique}, user=doc.paired_by, after_commit=True)
	out = _session_public(doc)
	out["playlist"] = playlist_for(doc.boutique)
	out["settings"] = salon_settings(doc.boutique)
	return out


@frappe.whitelist(allow_guest=True, methods=["GET"])
def state(token: str, since: int = 0) -> dict[str, Any]:
	"""Guest: the current mirror. ``changed`` is False when ``seq`` == ``since`` (cheap 2 s poll)."""
	doc = get_session(token)
	seq = cint(doc.state_seq)
	out = _session_public(doc, include_state=seq != cint(since))
	out["changed"] = seq != cint(since)
	out["pending_consent"] = bool(doc.pending_consent)
	return out


@frappe.whitelist(allow_guest=True, methods=["GET"])
def playlist(token: str) -> dict[str, Any]:
	doc = get_session(token)
	return {"boutique": doc.boutique, "playlist": playlist_for(doc.boutique), "settings": salon_settings(doc.boutique)}


def salon_settings(boutique: str) -> dict[str, Any]:
	from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import get_pos_settings

	s = get_pos_settings()
	b = frappe.db.get_value("Maison Boutique", boutique, ["boutique_name", "city", "face_recognition_enabled"], as_dict=True) or {}
	enabled = s.get("face_recognition_enabled")
	override = (b.get("face_recognition_enabled") or "Inherit")
	if override == "On":
		enabled = 1
	elif override == "Off":
		enabled = 0
	return {
		"boutique_name": b.get("boutique_name"),
		"city": b.get("city"),
		"consent_text": s.get("consent_text"),
		"consent_text_version": s.get("consent_text_version"),
		"face_recognition_enabled": cint(enabled),
		"feedback_enabled": cint(s.get("feedback_enabled", 1) if "feedback_enabled" in s else 1),
		"receipt_qr_base_url": s.get("receipt_qr_base_url"),
		"currency": frappe.get_cached_value("Company", frappe.db.get_value("Maison Boutique", boutique, "company"), "default_currency"),
		# --- v0.6 N/Q — brand tokens, welcome line, rewards copy + age gate for the "Please present your ID" state ---
		"brand": s.get("brand"),
		"welcome_line": _welcome_line(b.get("boutique_name")),
		"rewards_program_name": s.get("rewards_program_name"),
		"rewards_copy": _rewards_copy(),
		"minimum_age": s.get("minimum_age"),
		# --- end v0.6 N/Q ---
	}


def _welcome_line(boutique_name: Optional[str]) -> str:
	from maison_pos.brand import welcome_line

	return welcome_line(boutique_name)


def _rewards_copy() -> dict[str, Any]:
	try:
		from maison_pos.api.rewards import PROGRAM_COPY

		return PROGRAM_COPY
	except Exception:
		return {}


def playlist_for(boutique: str) -> list[dict[str, Any]]:
	"""Enabled playlist pieces: boutique-specific first, then global; image from the override or the Item."""
	today = frappe.utils.nowdate()
	rows = frappe.get_all(
		"Maison Salon Playlist",
		filters={"enabled": 1},
		fields=["name", "title", "boutique", "welcome_line", "valid_from", "valid_upto"],
		order_by="boutique desc, modified desc",
	)
	rows = [
		r
		for r in rows
		if (r.boutique or "") in (boutique, "") and (not r.valid_from or str(r.valid_from) <= today) and (not r.valid_upto or str(r.valid_upto) >= today)
	]
	out: list[dict[str, Any]] = []
	seen: set[str] = set()
	for pl in rows:
		items = frappe.get_all(
			"Maison Salon Playlist Item",
			filters={"parent": pl.name, "parenttype": "Maison Salon Playlist", "enabled": 1},
			fields=["item_code", "item_name", "caption", "image", "seconds", "idx"],
			order_by="idx asc",
		)
		for it in items:
			if it.item_code in seen:
				continue
			seen.add(it.item_code)
			item = frappe.db.get_value("Item", it.item_code, ["item_name", "image", "maison_metal", "maison_stones", "maison_carat"], as_dict=True) or {}
			image = it.image or item.get("image")
			out.append(
				{
					"item_code": it.item_code,
					"item_name": it.item_name or item.get("item_name"),
					"caption": it.caption,
					"image": frappe.utils.get_url(image) if image and not str(image).startswith("http") else image,
					"seconds": cint(it.seconds) or 12,
					"metal": item.get("maison_metal"),
					"stones": item.get("maison_stones"),
					"carat": item.get("maison_carat"),
					"playlist": pl.title,
					"welcome_line": pl.welcome_line,
				}
			)
	return out


@frappe.whitelist(allow_guest=True, methods=["POST"])
def identify(token: str, code: str) -> dict[str, Any]:
	"""Guest: phone / e-mail / client № / client QR → attaches the client to the POS sale.

	Returns only the masked client summary; an unknown code returns ``{found: False}`` with no hint.
	"""
	_rate_limit("identify", 30)
	doc = get_session(token)
	code = (code or "").strip()[:120]
	if not code:
		return {"found": False}
	customer = _resolve_code(code)
	if not customer:
		return {"found": False}
	return {"found": True, **_attach_customer(doc, customer, "identify")}


def _resolve_code(code: str) -> Optional[str]:
	from maison_pos.api.customers import _customer_rows, _phone_regexp
	from maison_pos.identifiers import CUSTOMER_QR_PREFIX, is_client_number, normalize_client_number

	if code.upper().startswith(CUSTOMER_QR_PREFIX):
		payload = code[len(CUSTOMER_QR_PREFIX) :].strip()
		if frappe.db.exists("Customer", {"name": payload, "disabled": 0}):
			return payload
		code = payload
	if is_client_number(code):
		return frappe.db.get_value("Customer", {"maison_client_number": normalize_client_number(code), "disabled": 0}, "name")
	if "@" in code:
		from frappe.query_builder import DocType
		from frappe.query_builder.functions import Lower

		C = DocType("Customer")
		rows = _customer_rows(Lower(C.email_id) == code.lower(), 1)
		return rows[0]["name"] if rows else None
	digits = digits_only(code)
	if digits and len(digits) >= 7:
		from frappe.query_builder import DocType

		C = DocType("Customer")
		rows = _customer_rows(C.mobile_no.regexp(_phone_regexp(digits)), 5)
		exact = [r["name"] for r in rows if digits_only(r.get("mobile_no")).endswith(digits)]
		if len(exact) == 1:
			return exact[0]
	return None


@frappe.whitelist(allow_guest=True, methods=["POST"])
def signup(
	token: str,
	name: str,
	phone: Optional[str] = None,
	email: Optional[str] = None,
	birthday: Optional[str] = None,
	marketing_email: Any = 0,
	marketing_sms: Any = 0,
) -> dict[str, Any]:
	"""Guest: "Join Maison" — creates (or links by phone/e-mail) the Customer, stores the marketing
	preferences on the Client Profile and attaches the client to the POS sale."""
	_rate_limit("signup", 10)
	doc = get_session(token)
	name = re.sub(r"\s+", " ", (name or "").strip())[:140]
	if len(name) < 2:
		frappe.throw(_("Please tell us your name"), frappe.ValidationError)
	phone = (phone or "").strip()[:40] or None
	email = (email or "").strip().lower()[:140] or None
	if not phone and not email:
		frappe.throw(_("A phone number or an e-mail is needed to find you again"), frappe.ValidationError)
	from maison_pos.api.recognition import find_or_create_customer

	customer, created = find_or_create_customer(phone, email, name)
	if created or not frappe.db.get_value("Customer", customer, "customer_name"):
		pass
	else:
		# complete an existing record that only had a phone/email as its name
		cur = frappe.db.get_value("Customer", customer, ["customer_name", "mobile_no", "email_id"], as_dict=True)
		updates: dict[str, Any] = {}
		if cur.customer_name in (cur.mobile_no, cur.email_id):
			updates["customer_name"] = name
		if phone and not cur.mobile_no:
			updates["mobile_no"] = phone
		if email and not cur.email_id:
			updates["email_id"] = email
		if updates:
			c = frappe.get_doc("Customer", customer)
			c.update(updates)
			c.flags.ignore_permissions = True
			c.save()
	_save_profile(customer, {"do_not_email": 0 if cint(marketing_email) else 1, "do_not_sms": 0 if cint(marketing_sms) else 1, "birthday": birthday or None})
	_log_interaction(doc, customer, "Visit", f"Joined {_brand_name()} Rewards from the Salon at {doc.boutique}" if created else f"Salon sign-up linked existing client at {doc.boutique}")
	out = _attach_customer(doc, customer, "signup", created)
	out["face_recognition_enabled"] = salon_settings(doc.boutique)["face_recognition_enabled"]
	return out


def _save_profile(customer: str, values: dict[str, Any]) -> None:
	from maison_pos.api.crm import get_or_create_profile

	prof = get_or_create_profile(customer)
	for k, v in values.items():
		if k in ("birthday", "anniversary"):
			try:
				v = frappe.utils.getdate(v) if v else None
			except Exception:
				v = None
			if v is None and prof.get(k):
				continue
		if prof.meta.has_field(k):
			prof.set(k, v)
	prof.flags.ignore_permissions = True
	prof.save()


def _log_interaction(doc, customer: str, kind: str, note: str) -> Optional[str]:
	"""Salon → CRM timeline (the Salon is a guest, so this bypasses ``crm.log_interaction``'s role check)."""
	if not frappe.db.exists("DocType", "Maison Client Interaction"):
		return None
	associate = None
	if doc.paired_by:
		a = get_associate(doc.paired_by)
		associate = a["name"] if a else None
	row = frappe.get_doc(
		{
			"doctype": "Maison Client Interaction",
			"customer": customer,
			"type": kind,
			"note": note[:2000],
			"boutique": doc.boutique,
			"associate": associate,
			"ts": now_datetime(),
			"status": "Done",
			"done_on": now_datetime(),
			"done_by": doc.paired_by or "Guest",
			"sales_invoice": doc.sales_invoice if doc.sales_invoice and frappe.db.exists("Sales Invoice", doc.sales_invoice) else None,
		}
	)
	row.flags.ignore_permissions = True
	row.insert()
	try:
		frappe.get_doc(
			{"doctype": "Comment", "comment_type": "Comment", "reference_doctype": "Customer", "reference_name": customer, "content": f"<b>Salon · {kind}</b>: {frappe.utils.escape_html(note)}"}
		).insert(ignore_permissions=True)
	except Exception:
		pass
	return row.name


@frappe.whitelist(allow_guest=True, methods=["POST"])
def consent(token: str, method: str, text_version: Optional[str] = None, signature_data_url: Optional[str] = None) -> dict[str, Any]:
	"""Guest: the client agreed (hold-to-agree / signature) on the Salon. The POS, which owns the
	camera, completes the enrolment (3 captures → ``recognition.enroll`` with this consent)."""
	_rate_limit("consent", 10)
	doc = get_session(token)
	if not doc.customer:
		frappe.throw(_("Identify or join first"), frappe.ValidationError)
	if method not in ("Hold-to-agree", "Signature"):
		frappe.throw(_("Unknown consent method"), frappe.ValidationError)
	settings = salon_settings(doc.boutique)
	payload = {"method": method, "text_version": text_version or settings["consent_text_version"], "captured_at": str(now_datetime()), "customer": doc.customer}
	if signature_data_url and str(signature_data_url).startswith("data:image/png;base64,") and len(signature_data_url) < 400_000:
		payload["signature_data_url"] = signature_data_url
	doc.db_set("pending_consent", json.dumps(payload), update_modified=False)
	msg = _push_inbox(doc, "consent_agreed", {"customer": doc.customer, "consent": {k: v for k, v in payload.items() if k != "signature_data_url"}, "has_signature": "signature_data_url" in payload})
	_set_state(doc, "consent", {"client": client_summary(doc.customer), "step": "capture", "camera": settings["face_recognition_enabled"]})
	return {"ok": True, "message_seq": msg["seq"], "camera": settings["face_recognition_enabled"]}


@frappe.whitelist()
def pending_consent(session: str) -> dict[str, Any]:
	"""Associate: the full consent payload (incl. signature) the Salon captured, then cleared."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	doc = get_session(session, for_salon=False)
	payload = _loads(doc.pending_consent, None)
	doc.db_set("pending_consent", None, update_modified=False)
	return {"consent": payload}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def consent_decline(token: str) -> dict[str, Any]:
	"""Guest: "No thanks" — the client stays attached, nothing biometric is stored; logged as Declined."""
	doc = get_session(token)
	if doc.customer:
		try:
			from maison_pos.api.recognition import _log

			_log("Declined", doc.boutique, doc.salon_device_id, customer=doc.customer)
		except Exception:
			pass
	doc.db_set("pending_consent", None, update_modified=False)
	msg = _push_inbox(doc, "consent_declined", {"customer": doc.customer})
	return {"ok": True, "message_seq": msg["seq"]}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def ask(token: str, question: str, item_code: Optional[str] = None) -> dict[str, Any]:
	"""Guest: "Ask about this piece" — a note in the client's CRM timeline + a nudge to the POS."""
	_rate_limit("ask", 20)
	doc = get_session(token)
	question = re.sub(r"\s+", " ", (question or "").strip())[:MAX_QUESTION]
	if not question:
		frappe.throw(_("Please type a question"), frappe.ValidationError)
	item_name = frappe.db.get_value("Item", item_code, "item_name") if item_code and frappe.db.exists("Item", item_code) else None
	note = f"Client asked about {item_name or item_code}: {question}" if item_code else f"Client asked: {question}"
	interaction = _log_interaction(doc, doc.customer, "Note", note) if doc.customer else None
	msg = _push_inbox(doc, "question", {"question": question, "item_code": item_code, "item_name": item_name, "interaction": interaction})
	return {"ok": True, "interaction": interaction, "message_seq": msg["seq"]}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def feedback(token: str, rating: Any, comment: Optional[str] = None) -> dict[str, Any]:
	"""Guest: private 1–5 feedback for the sale just mirrored (→ ``Maison Feedback``, HQ only)."""
	_rate_limit("feedback", 10)
	doc = get_session(token)
	rating = cint(rating)
	if rating < 1 or rating > 5:
		frappe.throw(_("Rating must be between 1 and 5"), frappe.ValidationError)
	state = _loads(doc.state, {}) or {}
	receipt_token = state.get("receipt_token")
	invoice = doc.sales_invoice
	if not invoice and receipt_token:
		invoice = frappe.db.get_value("Sales Invoice", {"maison_receipt_token": receipt_token, "docstatus": 1}, "name")
	if not invoice:
		frappe.throw(_("The receipt is still being issued — one moment"), frappe.ValidationError)
	si = frappe.db.get_value("Sales Invoice", invoice, ["name", "maison_boutique", "maison_associate", "customer", "maison_receipt_token"], as_dict=True)
	if frappe.db.exists("Maison Feedback", {"sales_invoice": si.name}):
		return {"ok": True, "duplicate": True}
	from maison_pos.api.feedback import _alert_low_rating, alert_threshold

	fb = frappe.get_doc(
		{
			"doctype": "Maison Feedback",
			"sales_invoice": si.name,
			"boutique": si.maison_boutique or doc.boutique,
			"associate": si.maison_associate if frappe.db.exists("Maison Associate", si.maison_associate or "") else None,
			"customer": si.customer,
			"rating": rating,
			"comment": (comment or "").strip()[:MAX_COMMENT] or None,
			"submitted_at": now_datetime(),
			"status": "New",
		}
	)
	fb.flags.ignore_permissions = True
	fb.insert()
	if rating <= alert_threshold():
		_alert_low_rating(fb)
	frappe.publish_realtime("maison_feedback", {"boutique": fb.boutique, "rating": rating, "name": fb.name, "source": "salon"}, room="maison_dashboard")
	_push_inbox(doc, "feedback", {"rating": rating, "feedback": fb.name})
	return {"ok": True, "feedback": fb.name}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def invite(token: str, wants_invitation: Any = 1) -> dict[str, Any]:
	"""Guest: "Would you like an invitation to our next private viewing?" → Client Profile flag."""
	doc = get_session(token)
	if not doc.customer:
		frappe.throw(_("Identify or join first"), frappe.ValidationError)
	wants = cint(wants_invitation)
	_save_profile(doc.customer, {"private_viewing_invite": wants, "private_viewing_invite_on": now_datetime() if wants else None})
	if wants:
		_log_interaction(doc, doc.customer, "Note", "Asked to be invited to the next private viewing (Salon)")
	_push_inbox(doc, "invite", {"customer": doc.customer, "wants_invitation": wants})
	return {"ok": True, "wants_invitation": wants}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def email_receipt(token: str, email: Optional[str] = None) -> dict[str, Any]:
	"""Guest: e-mail the public receipt link. Uses the client's e-mail on file when none is typed
	(and stores a typed one if the record had none). Mail is best-effort (no outgoing account → queued note)."""
	_rate_limit("email_receipt", 10)
	doc = get_session(token)
	email = (email or "").strip().lower()[:140]
	if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
		frappe.throw(_("That e-mail does not look right"), frappe.ValidationError)
	if not email and doc.customer:
		email = frappe.db.get_value("Customer", doc.customer, "email_id") or ""
	if not email:
		frappe.throw(_("Please enter an e-mail"), frappe.ValidationError)
	if doc.customer and not frappe.db.get_value("Customer", doc.customer, "email_id"):
		frappe.db.set_value("Customer", doc.customer, "email_id", email, update_modified=False)
	state = _loads(doc.state, {}) or {}
	receipt_token = state.get("receipt_token")
	if not receipt_token and doc.sales_invoice:
		receipt_token = frappe.db.get_value("Sales Invoice", doc.sales_invoice, "maison_receipt_token")
	sent = False
	if receipt_token:
		from maison_pos.utils import receipt_url

		url = receipt_url(receipt_token)
		try:
			frappe.sendmail(recipients=[email], subject=_("Your {0} receipt").format(_brand_name()), message=f"<p>Thank you for your visit.</p><p><a href='{url}'>{url}</a></p>", delayed=True)
			sent = True
		except Exception:
			frappe.log_error(frappe.get_traceback(), "maison salon email receipt")
		finally:
			frappe.clear_messages()
	_push_inbox(doc, "email_receipt", {"email_masked": mask_email(email), "sent": sent})
	return {"ok": True, "email_masked": mask_email(email), "sent": sent, "queued": bool(receipt_token)}


PREFERENCE_FIELDS = ("ring_size", "wrist_size", "metal_preference")
STYLE_CARDS = ("Minimal", "Statement", "Heritage", "Modern", "Everyday", "Bridal", "Colour", "Stacking")
OCCASIONS = ("Anniversary", "Birthday", "Engagement", "Wedding", "Gift", "Milestone", "Just because")


@frappe.whitelist(allow_guest=True, methods=["POST"])
def preferences(token: str, answers: Any) -> dict[str, Any]:
	"""Guest (Concierge mode): ring / wrist size, metal, style cards, occasions → Maison Client Profile."""
	_rate_limit("preferences", 20)
	doc = get_session(token)
	if not doc.customer:
		frappe.throw(_("Identify or join first"), frappe.ValidationError)
	data = _loads(answers, {}) or {}
	if not isinstance(data, dict):
		frappe.throw(_("answers must be an object"), frappe.ValidationError)
	values: dict[str, Any] = {}
	for k in PREFERENCE_FIELDS:
		if data.get(k) not in (None, ""):
			values[k] = str(data[k]).strip()[:40]
	if values.get("metal_preference") and values["metal_preference"] not in ("Yellow Gold", "White Gold", "Rose Gold", "Platinum", "Mixed"):
		values.pop("metal_preference")
	styles = [s for s in (data.get("styles") or []) if s in STYLE_CARDS][:6]
	occasions = [o for o in (data.get("occasions") or []) if isinstance(o, str) and o.strip()][:6]
	for k in ("birthday", "anniversary"):
		if data.get(k):
			values[k] = data[k]
	note_bits = []
	if styles:
		note_bits.append("Style: " + ", ".join(styles))
	if occasions:
		note_bits.append("Occasions: " + ", ".join(o.strip()[:60] for o in occasions))
	if data.get("notes"):
		note_bits.append(str(data["notes"]).strip()[:300])
	if note_bits:
		from maison_pos.api.crm import get_or_create_profile

		prof = get_or_create_profile(doc.customer)
		stamp = now_datetime().strftime("%Y-%m-%d")
		line = f"[Salon {stamp}] " + " · ".join(note_bits)
		existing = (prof.style_notes or "").strip()
		values["style_notes"] = (existing + "\n" + line).strip()[:4000] if existing else line
	_save_profile(doc.customer, values)
	_log_interaction(doc, doc.customer, "Note", "Concierge: " + (" · ".join(note_bits) if note_bits else ", ".join(f"{k} {v}" for k, v in values.items())))
	_push_inbox(doc, "preferences", {"customer": doc.customer, "fields": sorted(values), "styles": styles, "occasions": occasions})
	return {"ok": True, "saved": sorted(values), "styles": styles, "occasions": occasions}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def unpair(token: str) -> dict[str, Any]:
	"""Guest: the Salon ends its own session."""
	try:
		doc = get_session(token)
	except frappe.PermissionError:
		return {"ok": True, "unpaired": False}
	return {"ok": True, "unpaired": _end(doc)}


# ---------------------------------------------------------------------------
# scheduler
# ---------------------------------------------------------------------------
def expire_sessions() -> dict[str, Any]:
	"""Hourly: mark paired sessions past ``expires_at`` (12 h) as Expired."""
	names = frappe.get_all(DOCTYPE, filters={"status": "Paired", "expires_at": ("<", now_datetime())}, pluck="name")
	names += frappe.get_all(DOCTYPE, filters={"status": "Pending", "code_expires_at": ("<", now_datetime())}, pluck="name")
	for n in names:
		frappe.db.set_value(DOCTYPE, n, {"status": "Expired", "unpaired_at": now_datetime()}, update_modified=False)
	return {"expired": len(names)}


def _brand_name() -> str:
	"""v0.6 N"""
	from maison_pos.brand import brand_name

	return brand_name()
