"""Private post-visit feedback (v0.4 section I).

The public receipt page ``/r/<token>`` shows "How was your visit?" — a 1–5 rating and an
optional comment. The only secret is the receipt token:

* ``submit(token, rating, comment)`` — **guest, POST only**, one feedback per invoice;
* ``status(token)`` — guest GET, returns only whether feedback exists (so the page can say
  "thank you"), never the rating or comment;
* everything else (``list``, ``summary``, ``respond``) needs an AWANZ role. The doctype has no
  Guest permission, so ``frappe.client.get*`` cannot read it either.

A rating ≤ ``feedback_alert_threshold`` (default 2) alerts the boutique manager(s) and Head
Office via Notification Log (+ e-mail when configured) and ``awanz_feedback_alert`` realtime.
"""

from __future__ import annotations

import builtins
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, now_datetime, nowdate

from maison_pos.scoping import ALL_AWANZ_ROLES, assert_boutique_access, assert_roles, get_user_boutique, is_unrestricted

MAX_COMMENT = 2000


def _setting(key: str, default: Any) -> Any:
	try:
		value = frappe.db.get_single_value("AWANZ POS Settings", key)
	except Exception:
		return default
	return default if value in (None, "") else value


def feedback_enabled() -> bool:
	return bool(cint(_setting("feedback_enabled", 1)))


def alert_threshold() -> int:
	return cint(_setting("feedback_alert_threshold", 2)) or 2


def _invoice_for_token(token: str):
	from maison_pos.api.sales import get_invoice_by_token

	token = (token or "").strip()
	if not token or len(token) > 64:
		frappe.throw(_("Receipt not found"), frappe.DoesNotExistError)
	doc = get_invoice_by_token(token)
	if not doc.get("is_pos") or doc.docstatus != 1:
		frappe.throw(_("Receipt not found"), frappe.DoesNotExistError)
	return doc


@frappe.whitelist(allow_guest=True, methods=["GET"])
def status(token: str) -> dict[str, Any]:
	"""Guest: ``{enabled, submitted}`` — nothing else leaves the server."""
	from maison_pos.ratelimit import guard

	guard("feedback.status", 60, 60, global_limit=1200)
	if not feedback_enabled():
		return {"enabled": False, "submitted": False}
	try:
		doc = _invoice_for_token(token)
	except frappe.DoesNotExistError:
		return {"enabled": True, "submitted": False, "valid": False}
	return {"enabled": True, "valid": True, "submitted": bool(frappe.db.exists("AWANZ Feedback", {"sales_invoice": doc.name}))}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def submit(token: str, rating: Any, comment: Optional[str] = None) -> dict[str, Any]:
	"""Guest POST: store one feedback for the invoice behind *token*. Returns ``{ok, thanks}`` only."""
	from maison_pos.ratelimit import guard

	# v0.7 S4 — was an ad-hoc counter on `frappe.local.request_ip` (spoofable, no global ceiling)
	guard("feedback.submit", 20, 3600, global_limit=600, global_seconds=3600)
	if not feedback_enabled():
		frappe.throw(_("Feedback is not enabled"), frappe.ValidationError)
	doc = _invoice_for_token(token)
	rating = cint(rating)
	if rating < 1 or rating > 5:
		frappe.throw(_("Rating must be between 1 and 5"), frappe.ValidationError)
	comment = (comment or "").strip()[:MAX_COMMENT] or None
	if frappe.db.exists("AWANZ Feedback", {"sales_invoice": doc.name}):
		return {"ok": True, "duplicate": True, "thanks": _("Thank you — we already have your feedback for this visit.")}
	fb = frappe.get_doc(
		{
			"doctype": "AWANZ Feedback",
			"sales_invoice": doc.name,
			"boutique": doc.get("maison_boutique"),
			"associate": doc.get("maison_associate") if frappe.db.exists("AWANZ Associate", doc.get("maison_associate") or "") else None,
			"customer": doc.customer,
			"rating": rating,
			"comment": comment,
			"submitted_at": now_datetime(),
			"status": "New",
		}
	)
	fb.flags.ignore_permissions = True
	fb.insert()
	if rating <= alert_threshold():
		_alert_low_rating(fb)
	frappe.publish_realtime("awanz_feedback", {"boutique": fb.boutique, "rating": rating, "name": fb.name}, room="awanz_dashboard")
	return {"ok": True, "thanks": _("Thank you for your feedback.")}


def _alert_low_rating(fb) -> None:
	from maison_pos.api.crm import _notify, boutique_manager_users

	users = boutique_manager_users(fb.boutique) + frappe.get_all("Has Role", filters={"role": "AWANZ Head Office", "parenttype": "User"}, pluck="parent")
	subject = _("Low rating ({0}/5) at {1} — {2}").format(fb.rating, fb.boutique or "?", fb.sales_invoice)
	body = f"{subject}<br>{frappe.utils.escape_html(fb.comment or '')}"
	_notify(users, subject, "AWANZ Feedback", fb.name, body)
	try:
		emails = [e for e in (frappe.db.get_value("User", u, "email") for u in set(users)) if e]
		from frappe.email.doctype.email_account.email_account import EmailAccount

		can_send = bool(EmailAccount.find_outgoing(_raise_error=False)) if hasattr(EmailAccount, "find_outgoing") else False
		if emails and can_send and not frappe.flags.in_test:
			frappe.sendmail(recipients=emails, subject=subject, message=body, reference_doctype="AWANZ Feedback", reference_name=fb.name, delayed=True)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "awanz feedback alert mail")
	finally:
		frappe.clear_messages()  # never leak desk messages (e.g. "setup outgoing email") to the guest page
	frappe.publish_realtime("awanz_feedback_alert", {"boutique": fb.boutique, "rating": fb.rating, "name": fb.name}, room="awanz_dashboard")
	fb.db_set("alerted", 1, update_modified=False)


# ---------------------------------------------------------------------------
# HQ / manager side
# ---------------------------------------------------------------------------
FIELDS = ["name", "sales_invoice", "boutique", "associate", "rating", "comment", "submitted_at", "status", "hq_response", "responded_by", "responded_on"]


def _scope_filters(boutique: Optional[str]) -> dict[str, Any]:
	filters: dict[str, Any] = {}
	if boutique or not is_unrestricted():
		filters["boutique"] = assert_boutique_access(boutique or get_user_boutique())
	return filters


@frappe.whitelist()
def list(boutique: Optional[str] = None, from_date: Optional[str] = None, to_date: Optional[str] = None, status: Optional[str] = None, limit: int = 50) -> builtins.list[dict[str, Any]]:  # noqa: A001 - API name
	"""Managers (own boutique) / HQ: feedback rows. Customer identity is never included."""
	assert_roles("AWANZ Manager", "AWANZ Regional", "AWANZ Head Office", "System Manager")
	filters = _scope_filters(boutique)
	if from_date or to_date:
		filters["submitted_at"] = ("between", (f"{getdate(from_date or add_days(nowdate(), -30))} 00:00:00", f"{getdate(to_date or nowdate())} 23:59:59"))
	if status:
		filters["status"] = status
	rows = frappe.get_all("AWANZ Feedback", filters=filters, fields=FIELDS, order_by="submitted_at desc", limit=min(cint(limit) or 50, 500))
	for r in rows:
		r["associate_name"] = frappe.db.get_value("AWANZ Associate", r.associate, "full_name") if r.associate else None
		r["submitted_at"] = str(r.submitted_at) if r.submitted_at else None
	return rows



@frappe.whitelist()
def summary(days: int = 30) -> dict[str, Any]:
	"""Dashboard tile: avg rating + count per boutique, recent comments, low-rating count."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	since = f"{add_days(nowdate(), -(cint(days) or 30))} 00:00:00"
	filters: dict[str, Any] = {"submitted_at": (">=", since)}
	if not is_unrestricted():
		filters["boutique"] = get_user_boutique() or "__none__"
	rows = frappe.get_all("AWANZ Feedback", filters=filters, fields=["boutique", "rating", "comment", "submitted_at", "name", "status"], order_by="submitted_at desc")
	by_b: dict[str, dict[str, Any]] = {}
	for r in rows:
		b = by_b.setdefault(r.boutique or "?", {"boutique": r.boutique, "count": 0, "sum": 0, "low": 0})
		b["count"] += 1
		b["sum"] += cint(r.rating)
		if cint(r.rating) <= alert_threshold():
			b["low"] += 1
	for b in by_b.values():
		b["avg_rating"] = flt(b["sum"] / b["count"], 2) if b["count"] else 0.0
		b.pop("sum")
	total = len(rows)
	return {
		"days": cint(days) or 30,
		"count": total,
		"avg_rating": flt(sum(cint(r.rating) for r in rows) / total, 2) if total else 0.0,
		"low_count": sum(1 for r in rows if cint(r.rating) <= alert_threshold()),
		"by_boutique": sorted(by_b.values(), key=lambda x: x["boutique"] or ""),
		"recent": [{"name": r.name, "boutique": r.boutique, "rating": r.rating, "comment": r.comment, "submitted_at": str(r.submitted_at), "status": r.status} for r in rows if r.comment][:10],
		"threshold": alert_threshold(),
	}


@frappe.whitelist()
def respond(name: str, response: str, status: str = "Responded") -> dict[str, Any]:
	"""HQ / Regional / manager: record the internal response (never shown publicly)."""
	assert_roles("AWANZ Manager", "AWANZ Regional", "AWANZ Head Office", "System Manager")
	doc = frappe.get_doc("AWANZ Feedback", name)
	if not is_unrestricted() and doc.boutique != get_user_boutique():
		frappe.throw(_("Not your boutique"), frappe.PermissionError)
	if status not in ("Reviewed", "Responded", "New"):
		frappe.throw(_("Invalid status"), frappe.ValidationError)
	doc.hq_response = (response or "").strip()
	doc.status = status
	doc.responded_by = frappe.session.user
	doc.responded_on = now_datetime()
	doc.flags.ignore_permissions = True
	doc.save()
	return {"ok": True, "name": doc.name, "status": doc.status}
