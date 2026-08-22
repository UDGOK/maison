"""Client recognition endpoints (SPEC_v0.3): match, enroll, decline, templates, revoke, log_event.

Privacy rules enforced here (see docs/biometrics-policy.md):

* only embeddings are stored (``Maison Face Template`` rows on the Customer) — never images;
* nothing is enrolled without a ``Maison Biometric Consent`` record, and matching only ever
  considers templates whose consent is **Active** and whose Customer still carries
  ``maison_face_consent = 1``;
* revocation and the retention purge destroy the templates and revoke the consent;
* every outcome is written to ``Maison Recognition Event``.

Matching is **euclidean distance on the raw embeddings** (``distance < threshold`` ⇒ same
person, default 0.6 — face-api's published rule). ``score = clamp(1 − distance/1.2, 0, 1)`` is
returned for display only. See ``maison_pos.biometrics``.

Match cache
-----------
Templates are loaded once per worker process into ``_TEMPLATE_CACHE`` as raw float lists. A version token in ``frappe.cache`` (shared across web/worker processes) is bumped
by :func:`invalidate_template_cache` whenever templates are inserted or deleted — from the
Customer ``on_update`` hook and explicitly from ``enroll`` / ``revoke`` / the purge — so every
process reloads lazily on its next ``match``.
"""

from __future__ import annotations

import base64
import json
import re
import uuid
from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Lower
from frappe.utils import cint, flt, get_datetime, now_datetime

from maison_pos import biometrics
from maison_pos.api.customers import _customer_rows, _loyalty, _phone_regexp
from maison_pos.identifiers import digits_only
from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import (
	get_recognition_settings,
	is_recognition_enabled,
)
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, is_unrestricted

MANAGER_ROLES = ("Maison Manager", "Maison Regional", "Maison Head Office", "System Manager")
CACHE_VERSION_KEY = "maison_face_templates_version"
MAX_MATCHES = 3
OUTCOMES = ("Matched", "NoMatch", "Enrolled", "Undone", "Declined", "Revoked", "Purged")
CLIENT_LOGGABLE_OUTCOMES = ("Undone", "Matched", "NoMatch")
MIN_PHONE_DIGITS = 7

_TEMPLATE_CACHE: dict[str, Any] = {"version": None, "rows": []}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _loads(value: Any, default: Any) -> Any:
	if value is None:
		return default
	if isinstance(value, str):
		value = value.strip()
		if not value:
			return default
		return json.loads(value)
	return value


def _request_ip() -> Optional[str]:
	try:
		return frappe.local.request_ip
	except Exception:  # pragma: no cover - outside a request
		return None


def _settings(boutique: str) -> dict[str, Any]:
	return get_recognition_settings(boutique)


def _assert_enabled(boutique: str) -> None:
	if not is_recognition_enabled(boutique):
		frappe.throw(_("Client recognition is not enabled for boutique {0}").format(boutique), frappe.ValidationError)


def _parse_embedding(value: Any, expected_dims: Optional[int] = None) -> list[float]:
	try:
		vec = biometrics.parse_vector(value)
	except (ValueError, TypeError, json.JSONDecodeError) as e:
		frappe.throw(_("Invalid embedding: {0}").format(e), frappe.ValidationError)
	if expected_dims and len(vec) != expected_dims:
		frappe.throw(_("Embedding has {0} dimensions, expected {1}").format(len(vec), expected_dims), frappe.ValidationError)
	if len(vec) not in biometrics.ALLOWED_DIMS:
		frappe.throw(_("Unsupported embedding size {0}; expected one of {1}").format(len(vec), biometrics.ALLOWED_DIMS), frappe.ValidationError)
	return vec


def _customer_summary(customer: str, distance: Optional[float] = None) -> dict[str, Any]:
	row = frappe.db.get_value("Customer", customer, ["name", "customer_name", "maison_client_number", "maison_face_consent", "maison_face_consent_at"], as_dict=True)
	points, tier, points_value = _loyalty(customer)
	out = {
		"customer": row.name,
		"customer_name": row.customer_name,
		"client_number": row.maison_client_number,
		"tier": tier,
		"loyalty_points": points,
		"points_value": points_value,
		"face_consent": cint(row.maison_face_consent),
		"face_consent_at": str(row.maison_face_consent_at) if row.maison_face_consent_at else None,
	}
	if distance is not None:
		out["distance"] = distance
		out["score"] = biometrics.distance_to_score(distance)
	return out


def find_customer(phone: Optional[str] = None, email: Optional[str] = None) -> Optional[str]:
	"""Existing, enabled Customer by e-mail (exact, case-insensitive) or phone (digits-normalised)."""
	email = (email or "").strip().lower()
	if email:
		C = DocType("Customer")
		rows = _customer_rows(Lower(C.email_id) == email, 1)
		if rows:
			return rows[0]["name"]
	digits = digits_only(phone)
	if digits and len(digits) >= MIN_PHONE_DIGITS:
		C = DocType("Customer")
		rows = _customer_rows(C.mobile_no.regexp(_phone_regexp(digits)), 10)
		exact = [r["name"] for r in rows if digits_only(r.get("mobile_no")).endswith(digits)]
		if exact:
			return exact[0]
	return None


def find_or_create_customer(phone: Optional[str], email: Optional[str], name: Optional[str]) -> tuple[str, bool]:
	"""Return ``(customer, created)``; creates an Individual customer when nothing matches."""
	phone = (phone or "").strip() or None
	email = (email or "").strip() or None
	if not phone and not email:
		frappe.throw(_("phone or email is required"), frappe.ValidationError)
	if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
		frappe.throw(_("Invalid email {0}").format(email), frappe.ValidationError)
	if phone and len(digits_only(phone)) < MIN_PHONE_DIGITS:
		frappe.throw(_("Phone number must contain at least {0} digits").format(MIN_PHONE_DIGITS), frappe.ValidationError)

	existing = find_customer(phone, email)
	if existing:
		return existing, False

	from maison_pos.api.customers import _default

	doc = frappe.new_doc("Customer")
	doc.update(
		{
			"customer_name": (name or "").strip() or phone or email,
			"customer_type": "Individual",
			"customer_group": frappe.db.get_single_value("Selling Settings", "customer_group") or _default("Customer Group"),
			"territory": frappe.db.get_single_value("Selling Settings", "territory") or _default("Territory"),
			"mobile_no": phone,
			"email_id": email,
			"loyalty_program": frappe.db.get_value("Loyalty Program", {"auto_opt_in": 1}, "name"),
		}
	)
	doc.flags.ignore_permissions = True
	try:
		doc.insert()
	except frappe.DuplicateEntryError:
		# two devices (or a replay racing its own retry) created the same client concurrently
		existing = find_customer(phone, email)
		if existing:
			return existing, False
		raise
	return doc.name, True


def _log(
	outcome: str,
	boutique: Optional[str],
	device_id: Optional[str] = None,
	customer: Optional[str] = None,
	score: Optional[float] = None,
	sales_invoice: Optional[str] = None,
	detail: Optional[str] = None,
) -> str:
	if outcome not in OUTCOMES:
		frappe.throw(_("Unknown outcome {0}").format(outcome), frappe.ValidationError)
	ev = frappe.get_doc(
		{
			"doctype": "Maison Recognition Event",
			"ts": now_datetime(),
			"outcome": outcome,
			"score": flt(score) if score is not None else None,
			"customer": customer,
			"boutique": boutique,
			"device_id": (device_id or "")[:140] or None,
			"sales_invoice": sales_invoice,
			"user": frappe.session.user,
			"detail": detail,
		}
	)
	ev.flags.ignore_permissions = True
	ev.insert()
	return ev.name


# ---------------------------------------------------------------------------
# template cache
# ---------------------------------------------------------------------------
def invalidate_template_cache() -> None:
	"""Bump the shared version token so every process reloads templates on its next match."""
	frappe.cache().set_value(CACHE_VERSION_KEY, uuid.uuid4().hex)
	_TEMPLATE_CACHE["version"] = None
	_TEMPLATE_CACHE["rows"] = []


def _cache_version() -> str:
	version = frappe.cache().get_value(CACHE_VERSION_KEY)
	if not version:
		version = uuid.uuid4().hex
		frappe.cache().set_value(CACHE_VERSION_KEY, version)
	return version


def _load_template_rows() -> list[dict[str, Any]]:
	"""All matchable templates: Active consent, consent flag on the Customer, customer enabled."""
	T = DocType("Maison Face Template")
	C = DocType("Customer")
	K = DocType("Maison Biometric Consent")
	rows = (
		frappe.qb.from_(T)
		.join(C)
		.on((T.parent == C.name) & (T.parenttype == "Customer"))
		.join(K)
		.on(T.consent == K.name)
		.select(T.name.as_("template"), T.parent.as_("customer"), T.model, T.dims, T.embedding, T.captured_at, C.customer_name, C.maison_client_number)
		.where((K.status == "Active") & (K.customer == C.name) & (C.maison_face_consent == 1) & (C.disabled == 0))
	).run(as_dict=True)
	out: list[dict[str, Any]] = []
	for r in rows:
		try:
			vec = biometrics.parse_vector(r.embedding)
		except (ValueError, TypeError, json.JSONDecodeError):
			continue
		out.append(
			{
				"template": r.template,
				"customer": r.customer,
				"customer_name": r.customer_name,
				"client_number": r.maison_client_number,
				"model": r.model,
				"dims": len(vec),
				"vec": vec,
				"captured_at": r.captured_at,
			}
		)
	return out


def get_cached_templates(model: Optional[str] = None) -> list[dict[str, Any]]:
	"""Process-level cache of ``{customer, model, vec}`` rows, reloaded when the version token moved."""
	version = _cache_version()
	if _TEMPLATE_CACHE["version"] != version:
		_TEMPLATE_CACHE["rows"] = _load_template_rows()
		_TEMPLATE_CACHE["version"] = version
	rows = _TEMPLATE_CACHE["rows"]
	if model:
		rows = [r for r in rows if r["model"] == model]
	return rows


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------
@frappe.whitelist()
def match(embedding: Any, model: str, boutique: str, device_id: Optional[str] = None) -> dict[str, Any]:
	"""Identify a client from one embedding.

	Returns ``{matches: [{customer, customer_name, client_number, distance, score, tier,
	loyalty_points, points_value}], threshold_distance, threshold, best_distance, best_score,
	model, candidates, event}`` — ``matches`` holds only candidates with
	``distance < threshold_distance`` (closest first, max 3); ``best_distance`` / ``best_score``
	describe the closest candidate even when nothing passed (``best_distance`` is ``None`` with
	no candidates). ``threshold`` is an alias of ``threshold_distance``. Logs ``Matched`` / ``NoMatch``.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	_assert_enabled(boutique)
	settings = _settings(boutique)
	model = (model or "").strip() or settings["recognition_model"]
	vec = _parse_embedding(embedding)
	threshold = settings["match_threshold"]

	rows = [r for r in get_cached_templates(model) if r["dims"] == len(vec)]
	best = biometrics.best_distances(vec, rows)
	ranked = sorted(best.items(), key=lambda kv: kv[1])
	best_distance = ranked[0][1] if ranked else None
	best_score = biometrics.distance_to_score(best_distance) if best_distance is not None else 0.0
	matches = [_customer_summary(c, d) for c, d in ranked[:MAX_MATCHES] if biometrics.is_match(d, threshold)]

	outcome = "Matched" if matches else "NoMatch"
	event = _log(
		outcome,
		boutique,
		device_id,
		customer=matches[0]["customer"] if matches else None,
		score=best_score,
		detail=f"distance {best_distance:.4f} / threshold {threshold}" if best_distance is not None else None,
	)
	return {
		"matches": matches,
		"threshold_distance": threshold,
		"threshold": threshold,
		"best_distance": best_distance,
		"best_score": best_score,
		"model": model,
		"candidates": len(rows),
		"event": event,
	}


@frappe.whitelist()
def enroll(
	embeddings: Any,
	model: str,
	boutique: str,
	device_id: str,
	consent: Any,
	quality: Any = None,
	customer: Optional[str] = None,
	phone: Optional[str] = None,
	email: Optional[str] = None,
	name: Optional[str] = None,
	offline_uuid: Optional[str] = None,
) -> dict[str, Any]:
	"""Enrol a client: consent record + face templates + customer flags.

	``consent`` = ``{method: "Hold-to-agree"|"Signature", text_version, signature_data_url?}``.
	The customer is resolved from ``customer`` (must exist), else by phone/email
	(digits-normalised), else created. Returns
	``{customer, customer_name, client_number, consent, templates: [row names],
	template_count, created, consent_text_version, event}``. ``offline_uuid`` makes replays idempotent.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	_assert_enabled(boutique)
	settings = _settings(boutique)
	device_id = (device_id or "").strip()
	if not device_id:
		frappe.throw(_("device_id is required"), frappe.ValidationError)

	offline_uuid = (offline_uuid or "").strip() or None
	if offline_uuid:
		existing = frappe.db.get_value("Maison Biometric Consent", {"offline_uuid": offline_uuid}, ["name", "customer"], as_dict=True)
		if existing:
			templates = frappe.get_all("Maison Face Template", filters={"parent": existing.customer, "consent": existing.name}, pluck="name")
			out = _customer_summary(existing.customer)
			out.update({"consent": existing.name, "templates": templates, "template_count": len(templates), "created": False, "duplicate": True, "consent_text_version": None, "event": None})
			return out

	# --- validate embeddings ---------------------------------------------------
	model = (model or "").strip() or settings["recognition_model"]
	raw_list = _loads(embeddings, [])
	if not isinstance(raw_list, list) or not raw_list:
		frappe.throw(_("embeddings must be a non-empty list of vectors"), frappe.ValidationError)
	if len(raw_list) > biometrics.MAX_TEMPLATES_PER_CUSTOMER:
		frappe.throw(_("At most {0} embeddings per enrolment").format(biometrics.MAX_TEMPLATES_PER_CUSTOMER), frappe.ValidationError)
	vectors: list[list[float]] = []
	for item in raw_list:
		vectors.append(_parse_embedding(item, expected_dims=len(vectors[0]) if vectors else None))
	qualities = _loads(quality, []) or []
	if not isinstance(qualities, list):
		frappe.throw(_("quality must be a list of floats"), frappe.ValidationError)
	qualities = [flt(q) for q in qualities] + [0.0] * (len(vectors) - len(qualities))

	# --- validate consent ------------------------------------------------------
	consent_in = _loads(consent, {})
	if not isinstance(consent_in, dict):
		frappe.throw(_("consent must be an object"), frappe.ValidationError)
	method = (consent_in.get("method") or "").strip()
	if method not in biometrics.CONSENT_METHODS:
		frappe.throw(_("consent.method must be one of {0}").format(", ".join(biometrics.CONSENT_METHODS)), frappe.ValidationError)
	text_version = (consent_in.get("text_version") or "").strip()
	if not text_version:
		frappe.throw(_("consent.text_version is required"), frappe.ValidationError)
	if text_version != settings["consent_text_version"]:
		frappe.throw(
			_("Consent text version {0} is outdated; current version is {1}. Reload settings and show the new text.").format(
				text_version, settings["consent_text_version"]
			),
			frappe.ValidationError,
		)
	signature_data_url = consent_in.get("signature_data_url")
	if method == "Signature" and not signature_data_url:
		frappe.throw(_("A signature image is required for the Signature consent method"), frappe.ValidationError)

	# --- resolve customer ------------------------------------------------------
	created = False
	if customer:
		if not frappe.db.exists("Customer", customer):
			frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	else:
		customer, created = find_or_create_customer(phone, email, name)

	# --- consent record (previous Active one is superseded) --------------------
	for old in frappe.get_all("Maison Biometric Consent", filters={"customer": customer, "status": "Active"}, pluck="name"):
		frappe.db.set_value("Maison Biometric Consent", old, "status", "Superseded")
	now = now_datetime()
	consent_doc = frappe.get_doc(
		{
			"doctype": "Maison Biometric Consent",
			"customer": customer,
			"status": "Active",
			"consent_text_version": text_version,
			"consent_text": settings["consent_text"],
			"method": method,
			"boutique": boutique,
			"associate": frappe.db.get_value("Maison Associate", {"user": frappe.session.user, "enabled": 1}, "name"),
			"device_id": device_id,
			"captured_at": now,
			"ip": _request_ip(),
			"offline_uuid": offline_uuid,
		}
	)
	consent_doc.flags.ignore_permissions = True
	consent_doc.insert()
	if signature_data_url:
		consent_doc.db_set("signature", _save_signature(consent_doc, signature_data_url), update_modified=False)

	# --- templates on the Customer --------------------------------------------
	cust = frappe.get_doc("Customer", customer)
	cust.set("maison_face_templates", [])  # superseded consents' templates go away with them
	for vec, q in zip(vectors, qualities):
		cust.append(
			"maison_face_templates",
			{
				"embedding": json.dumps([round(x, 7) for x in vec]),
				"model": model,
				"dims": len(vec),
				"quality": q,
				"captured_at": now,
				"boutique": boutique,
				"device_id": device_id,
				"consent": consent_doc.name,
			},
		)
	cust.maison_face_consent = 1
	cust.maison_face_consent_at = now
	cust.flags.ignore_permissions = True
	cust.save()
	invalidate_template_cache()

	event = _log("Enrolled", boutique, device_id, customer=customer, detail=f"{len(vectors)} × {model}")
	out = _customer_summary(customer)
	out.update(
		{
			"consent": consent_doc.name,
			"templates": [t.name for t in cust.maison_face_templates],
			"template_count": len(cust.maison_face_templates),
			"created": created,
			"consent_text_version": text_version,
			"event": event,
		}
	)
	return out


def _save_signature(consent_doc, data_url: str) -> str:
	"""Store the signature stroke as a private File attached to the consent; returns file_url."""
	m = re.match(r"^data:(image/(png|jpeg|webp|svg\+xml));base64,(.+)$", data_url.strip(), re.S)
	if not m:
		frappe.throw(_("signature_data_url must be a base64 data URL of an image"), frappe.ValidationError)
	ext = {"png": "png", "jpeg": "jpg", "webp": "webp", "svg+xml": "svg"}[m.group(2)]
	content = base64.b64decode(m.group(3))
	if len(content) > 2 * 1024 * 1024:
		frappe.throw(_("Signature image is too large"), frappe.ValidationError)
	f = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": f"consent-signature-{consent_doc.name}.{ext}",
			"attached_to_doctype": consent_doc.doctype,
			"attached_to_name": consent_doc.name,
			"attached_to_field": "signature",
			"is_private": 1,
			"content": content,
		}
	)
	f.flags.ignore_permissions = True
	f.insert()
	return f.file_url


@frappe.whitelist()
def decline(
	boutique: str,
	device_id: str,
	phone: Optional[str] = None,
	email: Optional[str] = None,
	name: Optional[str] = None,
	customer: Optional[str] = None,
) -> dict[str, Any]:
	"""Client said "No thanks": create/link the Customer *without* biometrics; logs ``Declined``."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	created = False
	if customer:
		if not frappe.db.exists("Customer", customer):
			frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	else:
		customer, created = find_or_create_customer(phone, email, name)
	event = _log("Declined", boutique, device_id, customer=customer)
	out = _customer_summary(customer)
	out.update({"created": created, "event": event})
	return out


@frappe.whitelist()
def templates(boutique: str, since: Optional[str] = None) -> dict[str, Any]:
	"""Consented templates for the device's offline cache.

	``{templates: [{customer, customer_name, client_number, embedding (RAW floats), model, dims,
	template, captured_at}], deleted: [customer...], enabled, model, threshold_distance, threshold,
	version}``.
	With ``since`` (ISO datetime) only templates captured at/after it are returned and
	``deleted`` lists customers whose consent was revoked / purged since then. Empty (with
	``enabled: 0``) when ``recognition_offline_cache`` is off.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	settings = _settings(boutique)
	version = now_datetime().isoformat()
	if not settings["recognition_offline_cache"] or not settings["face_recognition_enabled"]:
		return {"templates": [], "deleted": [], "enabled": 0, "model": settings["recognition_model"], "threshold_distance": settings["match_threshold"], "threshold": settings["match_threshold"], "version": version}

	rows = get_cached_templates()
	since_dt = get_datetime(since) if since else None
	out_rows = []
	for r in rows:
		if since_dt and r["captured_at"] and get_datetime(r["captured_at"]) < since_dt:
			continue
		out_rows.append(
			{
				"template": r["template"],
				"customer": r["customer"],
				"customer_name": r["customer_name"],
				"client_number": r["client_number"],
				"embedding": r["vec"],
				"model": r["model"],
				"dims": r["dims"],
				"captured_at": str(r["captured_at"]) if r["captured_at"] else None,
			}
		)
	deleted: list[str] = []
	if since_dt:
		deleted = sorted(
			set(
				frappe.get_all(
					"Maison Biometric Consent",
					filters={"status": "Revoked", "revoked_at": (">=", since_dt)},
					pluck="customer",
				)
			)
		)
	return {
		"templates": out_rows,
		"deleted": deleted,
		"enabled": 1,
		"model": settings["recognition_model"],
		"threshold_distance": settings["match_threshold"],
		"threshold": settings["match_threshold"],
		"version": version,
	}


def purge_templates(customer: str, consent: Optional[str] = None) -> int:
	"""Delete face template rows for *customer* (optionally only those of one consent). Returns count."""
	filters: dict[str, Any] = {"parent": customer, "parenttype": "Customer"}
	if consent:
		filters["consent"] = consent
	names = frappe.get_all("Maison Face Template", filters=filters, pluck="name")
	if names:
		frappe.db.delete("Maison Face Template", {"name": ("in", names)})
		invalidate_template_cache()
	return len(names)


def revoke_consent_records(customer: str, reason: str, revoked_by: Optional[str] = None) -> list[str]:
	"""Flip every Active/Superseded consent of *customer* to Revoked (no template handling)."""
	names = frappe.get_all("Maison Biometric Consent", filters={"customer": customer, "status": ("in", ["Active", "Superseded"])}, pluck="name")
	now = now_datetime()
	for n in names:
		frappe.db.set_value(
			"Maison Biometric Consent",
			n,
			{"status": "Revoked", "revoked_at": now, "revoked_by": revoked_by or frappe.session.user, "revoke_reason": (reason or "")[:500]},
		)
	return names


def purge_customer_biometrics(customer: str, reason: str, outcome: str = "Revoked", boutique: Optional[str] = None, device_id: Optional[str] = None) -> dict[str, Any]:
	"""Shared by ``revoke`` and the retention purge: templates gone, consent revoked, flags cleared, event logged."""
	purged = purge_templates(customer)
	consents = revoke_consent_records(customer, reason)
	frappe.db.set_value(
		"Customer",
		customer,
		{"maison_face_consent": 0, "maison_face_consent_at": None, "maison_face_consent_on": None, "maison_face_id": None},
		update_modified=True,
	)
	frappe.clear_document_cache("Customer", customer)
	event = _log(outcome, boutique, device_id, customer=customer, detail=reason)
	invalidate_template_cache()
	return {"ok": True, "customer": customer, "purged_templates": purged, "revoked_consents": consents, "event": event}


@frappe.whitelist()
def revoke(customer: str, reason: str = "", boutique: Optional[str] = None, device_id: Optional[str] = None) -> dict[str, Any]:
	"""Manager+: delete the client's biometric data. Returns ``{ok, customer, purged_templates, revoked_consents, event}``."""
	assert_roles(*MANAGER_ROLES)
	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	boutique = assert_boutique_access(boutique) if (boutique or not is_unrestricted()) else None
	reason = (reason or "").strip() or "Client requested deletion"
	return purge_customer_biometrics(customer, reason, outcome="Revoked", boutique=boutique, device_id=device_id)


@frappe.whitelist()
def log_event(
	outcome: str,
	customer: Optional[str] = None,
	score: Optional[float] = None,
	sales_invoice: Optional[str] = None,
	boutique: Optional[str] = None,
	device_id: Optional[str] = None,
) -> dict[str, Any]:
	"""Client-side outcomes (``Undone``; also ``Matched`` / ``NoMatch`` decided offline). Returns ``{ok, event}``."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if outcome not in CLIENT_LOGGABLE_OUTCOMES:
		frappe.throw(_("outcome must be one of {0}").format(", ".join(CLIENT_LOGGABLE_OUTCOMES)), frappe.ValidationError)
	if boutique or not is_unrestricted():
		boutique = assert_boutique_access(boutique)
	if customer and not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	if sales_invoice and not frappe.db.exists("Sales Invoice", sales_invoice):
		frappe.throw(_("Sales Invoice {0} not found").format(sales_invoice), frappe.DoesNotExistError)
	event = _log(outcome, boutique, device_id, customer=customer, score=flt(score) if score not in (None, "") else None, sales_invoice=sales_invoice)
	return {"ok": True, "event": event}


@frappe.whitelist()
def status(customer: str) -> dict[str, Any]:
	"""Biometric status line for the Client screen: consent, enrolment date, template count."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	out = _customer_summary(customer)
	active = frappe.db.get_value(
		"Maison Biometric Consent",
		{"customer": customer, "status": "Active"},
		["name", "captured_at", "consent_text_version", "method", "boutique"],
		as_dict=True,
	)
	out["consent"] = active
	out["templates"] = frappe.db.count("Maison Face Template", {"parent": customer, "parenttype": "Customer"})
	out["can_revoke"] = bool(set(MANAGER_ROLES) & set(frappe.get_roles())) or frappe.session.user == "Administrator"
	return out


def recognition_counts(boutiques: list[str], day) -> dict[str, int]:
	"""Dashboard tile: counts of today's events per outcome for *boutiques*."""
	if not boutiques:
		return {"matched_today": 0, "enrolled_today": 0, "nomatch_today": 0, "declined_today": 0, "undone_today": 0}
	start = get_datetime(f"{day} 00:00:00")
	end = get_datetime(f"{day} 23:59:59")
	rows = frappe.get_all(
		"Maison Recognition Event",
		filters={"boutique": ("in", boutiques), "ts": ("between", [start, end])},
		fields=["outcome", "count(name) as n"],
		group_by="outcome",
	)
	by = {r.outcome: cint(r.n) for r in rows}
	return {
		"matched_today": by.get("Matched", 0),
		"enrolled_today": by.get("Enrolled", 0),
		"nomatch_today": by.get("NoMatch", 0),
		"declined_today": by.get("Declined", 0),
		"undone_today": by.get("Undone", 0),
	}
