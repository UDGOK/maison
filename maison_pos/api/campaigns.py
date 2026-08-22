"""Campaign attribution endpoints (SPEC v0.5 §M) — ``/api/method/maison_pos.api.campaigns.*``.

| Endpoint | Who | Returns |
|---|---|---|
| ``list_campaigns(status?, channel?)`` | Manager+ | campaign rows with counters |
| ``get(campaign)`` | Manager+ | campaign + featured items + segment preview count |
| ``performance(campaign?, from_date?, to_date?, boutique?)`` | Manager+ (boutique-scoped) | sends / opens / clicks / attributed revenue / ROI per campaign + totals |
| ``attributed_sales(campaign, limit)`` | Manager+ | attribution rows (invoice level) |
| ``segment(campaign, limit?)`` | HQ / Regional | segment preview rows |
| ``export_segment(campaign, format="csv"|"email_group")`` | HQ | CSV download or a Frappe ``Email Group`` |
| ``record_touch(campaign, customer, event, ts?)`` | HQ / Regional | manual touch (Event / Private viewing guest lists) |
| ``sync_email_campaign(campaign)`` | HQ | touches from the linked Frappe Email Campaign's Email Queue |
| ``run_attribution(from_date?, to_date?, campaign?)`` | HQ / System Manager | runs the nightly job now |
| ``webhook_klaviyo`` / ``webhook_brevo`` | guest, **signed** | provider events → touches |
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, nowdate

from maison_pos.campaigns import attribution, segments, webhooks
from maison_pos.scoping import assert_boutique_access, assert_roles, get_allowed_boutiques, is_unrestricted

MANAGER_PLUS = ("Maison Manager", "Maison Regional", "Maison Head Office", "System Manager")
HQ = ("Maison Head Office", "System Manager")
HQ_REGIONAL = ("Maison Regional", "Maison Head Office", "System Manager")
CAMPAIGN_FIELDS = [
	"name", "title", "campaign_code", "channel", "status", "send_date", "content_link", "coupon", "cost",
	"segment_tier", "segment_boutique", "segment_signal_type", "segment_item", "segment_item_group", "segment_size",
	"direct_window_days", "assisted_window_days", "sends", "opens", "clicks", "attributed_direct", "attributed_assisted", "buyers", "last_attributed_at",
]


def _campaign_or_throw(campaign: str) -> str:
	if not campaign or not frappe.db.exists("Maison Campaign", campaign):
		frappe.throw(_("Campaign {0} does not exist").format(campaign), frappe.DoesNotExistError)
	return campaign


def _row(r: dict[str, Any]) -> dict[str, Any]:
	r = dict(r)
	sends = cint(r.get("sends"))
	r["open_rate"] = flt(cint(r.get("opens")) / sends, 4) if sends else 0.0
	r["click_rate"] = flt(cint(r.get("clicks")) / sends, 4) if sends else 0.0
	r["attributed_revenue"] = flt(flt(r.get("attributed_direct")) + flt(r.get("attributed_assisted")), 2)
	cost = flt(r.get("cost"))
	r["roi"] = flt((flt(r.get("attributed_direct")) - cost) / cost, 3) if cost else None
	return r


# ---------------------------------------------------------------------------
# campaigns
# ---------------------------------------------------------------------------
@frappe.whitelist()
def list_campaigns(status: Optional[str] = None, channel: Optional[str] = None, limit: int = 100) -> list[dict[str, Any]]:
	assert_roles(*MANAGER_PLUS)
	filters: dict[str, Any] = {}
	if status:
		filters["status"] = status
	if channel:
		filters["channel"] = channel
	rows = frappe.get_all("Maison Campaign", filters=filters, fields=CAMPAIGN_FIELDS, order_by="send_date desc, modified desc", limit=min(max(cint(limit) or 100, 1), 500))
	return [_row(r) for r in rows]


@frappe.whitelist()
def get(campaign: str) -> dict[str, Any]:
	assert_roles(*MANAGER_PLUS)
	doc = frappe.get_doc("Maison Campaign", _campaign_or_throw(campaign))
	out = _row({k: doc.get(k) for k in CAMPAIGN_FIELDS})
	out["featured_items"] = [{"item_code": r.item_code, "item_name": r.item_name} for r in doc.featured_items]
	out["notes"] = doc.notes
	out["klaviyo_campaign_id"] = doc.klaviyo_campaign_id
	out["brevo_campaign_id"] = doc.brevo_campaign_id
	out["email_campaign"] = doc.email_campaign
	return out


# ---------------------------------------------------------------------------
# performance
# ---------------------------------------------------------------------------
@frappe.whitelist()
def performance(campaign: Optional[str] = None, from_date: Optional[str] = None, to_date: Optional[str] = None, boutique: Optional[str] = None, channel: Optional[str] = None) -> dict[str, Any]:
	"""Campaign performance (dashboard Clients/Insights card + report source).

	Sends/opens/clicks are campaign-wide (touches have no boutique); attributed revenue and buyers
	are filtered by the sale's ``posting_date`` window and boutique. Scoped managers only see
	their boutique's attributed sales.
	"""
	assert_roles(*MANAGER_PLUS)
	if boutique or not is_unrestricted():
		boutique = assert_boutique_access(boutique or (get_allowed_boutiques() or [None])[0])
	filters: dict[str, Any] = {}
	if campaign:
		filters["name"] = _campaign_or_throw(campaign)
	if channel:
		filters["channel"] = channel
	campaigns = frappe.get_all("Maison Campaign", filters=filters, fields=CAMPAIGN_FIELDS, order_by="send_date desc, modified desc")
	if not campaigns:
		return {"from_date": from_date, "to_date": to_date, "boutique": boutique, "campaigns": [], "totals": _totals([]), "last_run": None}

	attr_filters: dict[str, Any] = {"campaign": ("in", [c.name for c in campaigns])}
	if from_date or to_date:
		attr_filters["posting_date"] = ("between", (getdate(from_date or "2000-01-01"), getdate(to_date or nowdate())))
	if boutique:
		attr_filters["boutique"] = boutique
	attr = frappe.get_all(
		"Maison Campaign Attribution",
		filters=attr_filters,
		fields=["campaign", "type", "count(name) as invoices", "sum(amount) as amount", "sum(item_level) as item_level_rows"],
		group_by="campaign, type",
	)
	by_campaign: dict[str, dict[str, Any]] = {}
	for a in attr:
		c = by_campaign.setdefault(a.campaign, {"direct": 0.0, "assisted": 0.0, "invoices_direct": 0, "invoices_assisted": 0, "buyers": set(), "item_level_rows": 0})
		key = "direct" if a.type == "Direct" else "assisted"
		c[key] = flt(a.amount, 2)
		c[f"invoices_{key}"] = cint(a.invoices)
		c["item_level_rows"] += cint(a.item_level_rows)
	buyers = frappe.get_all("Maison Campaign Attribution", filters=attr_filters, fields=["campaign", "customer"], distinct=True) if attr else []
	for b in buyers:
		by_campaign.setdefault(b.campaign, {"direct": 0.0, "assisted": 0.0, "invoices_direct": 0, "invoices_assisted": 0, "buyers": set(), "item_level_rows": 0})["buyers"].add(b.customer)

	rows = []
	for c in campaigns:
		a = by_campaign.get(c.name, {})
		r = dict(c)
		r["attributed_direct"] = flt(a.get("direct"), 2)
		r["attributed_assisted"] = flt(a.get("assisted"), 2)
		r["invoices_direct"] = cint(a.get("invoices_direct"))
		r["invoices_assisted"] = cint(a.get("invoices_assisted"))
		r["item_level_rows"] = cint(a.get("item_level_rows"))
		r["buyers"] = len(a.get("buyers") or ())
		r = _row(r)
		r["conversion"] = flt(r["buyers"] / cint(r.get("sends")), 4) if cint(r.get("sends")) else 0.0
		r["revenue_per_send"] = flt(r["attributed_direct"] / cint(r.get("sends")), 2) if cint(r.get("sends")) else 0.0
		rows.append(r)
	last_run = frappe.db.get_value("Maison Campaign", {"last_attributed_at": ("is", "set")}, "max(last_attributed_at)")
	return {"from_date": from_date, "to_date": to_date, "boutique": boutique, "campaigns": rows, "totals": _totals(rows), "last_run": last_run}


def _totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
	t = {"campaigns": len(rows), "sends": 0, "opens": 0, "clicks": 0, "buyers": 0, "attributed_direct": 0.0, "attributed_assisted": 0.0, "attributed_revenue": 0.0, "cost": 0.0, "invoices_direct": 0, "invoices_assisted": 0}
	for r in rows:
		for k in ("sends", "opens", "clicks", "buyers", "invoices_direct", "invoices_assisted"):
			t[k] += cint(r.get(k))
		for k in ("attributed_direct", "attributed_assisted", "attributed_revenue", "cost"):
			t[k] = flt(t[k] + flt(r.get(k)), 2)
	t["open_rate"] = flt(t["opens"] / t["sends"], 4) if t["sends"] else 0.0
	t["click_rate"] = flt(t["clicks"] / t["sends"], 4) if t["sends"] else 0.0
	t["roi"] = flt((t["attributed_direct"] - t["cost"]) / t["cost"], 3) if t["cost"] else None
	return t


@frappe.whitelist()
def attributed_sales(campaign: str, limit: int = 100, boutique: Optional[str] = None) -> list[dict[str, Any]]:
	"""Invoice-level attribution rows for a campaign (drill-down)."""
	assert_roles(*MANAGER_PLUS)
	_campaign_or_throw(campaign)
	if boutique or not is_unrestricted():
		boutique = assert_boutique_access(boutique or (get_allowed_boutiques() or [None])[0])
	filters: dict[str, Any] = {"campaign": campaign}
	if boutique:
		filters["boutique"] = boutique
	return frappe.get_all(
		"Maison Campaign Attribution",
		filters=filters,
		fields=["name", "sales_invoice", "customer", "type", "amount", "invoice_total", "item_level", "item_codes", "posting_date", "boutique", "associate", "touch_at", "days_to_sale"],
		order_by="posting_date desc",
		limit=min(max(cint(limit) or 100, 1), 1000),
	)


# ---------------------------------------------------------------------------
# segments
# ---------------------------------------------------------------------------
@frappe.whitelist()
def segment(campaign: str, limit: Optional[int] = None) -> dict[str, Any]:
	assert_roles(*HQ_REGIONAL)
	rows = segments.build_segment(_campaign_or_throw(campaign))
	frappe.db.set_value("Maison Campaign", campaign, "segment_size", len(rows), update_modified=False)
	return {"campaign": campaign, "count": len(rows), "customers": rows[: cint(limit)] if limit else rows}


@frappe.whitelist()
def export_segment(campaign: str, format: str = "csv"):  # noqa: A002
	"""CSV download (``format=csv``) or a Frappe ``Email Group`` named after the campaign (``format=email_group``)."""
	assert_roles(*HQ)
	_campaign_or_throw(campaign)
	doc = frappe.get_doc("Maison Campaign", campaign)
	rows = segments.build_segment(doc.as_dict())
	frappe.db.set_value("Maison Campaign", campaign, "segment_size", len(rows), update_modified=False)
	if format == "email_group":
		group_name = f"Campaign {doc.campaign_code}"
		if not frappe.db.exists("Email Group", group_name):
			frappe.get_doc({"doctype": "Email Group", "title": group_name}).insert(ignore_permissions=True)
		added = 0
		for r in rows:
			if not r["email"] or frappe.db.exists("Email Group Member", {"email_group": group_name, "email": r["email"]}):
				continue
			frappe.get_doc({"doctype": "Email Group Member", "email_group": group_name, "email": r["email"], "email_group_member_name": r["customer_name"]}).insert(ignore_permissions=True)
			added += 1
		total = frappe.db.count("Email Group Member", {"email_group": group_name})
		frappe.db.set_value("Email Group", group_name, "total_subscribers", total, update_modified=False)
		return {"campaign": campaign, "email_group": group_name, "added": added, "members": total, "segment": len(rows)}
	if format != "csv":
		frappe.throw(_("format must be csv or email_group"), frappe.ValidationError)
	buf = io.StringIO()
	w = csv.writer(buf)
	w.writerow(["client_number", "customer_name", "email", "mobile", "tier", "boutique", "preferred_associate", "utm_campaign", "coupon"])
	for r in rows:
		w.writerow([r["client_number"], r["customer_name"], r["email"], r["mobile"], r["tier"], r["boutique"], r["preferred_associate"], doc.campaign_code, doc.coupon])
	frappe.response["filename"] = f"{doc.campaign_code}-segment.csv"
	frappe.response["filecontent"] = buf.getvalue()
	frappe.response["type"] = "download"
	frappe.response["content_type"] = "text/csv"


# ---------------------------------------------------------------------------
# touches
# ---------------------------------------------------------------------------
@frappe.whitelist()
def record_touch(campaign: str, customer: str, event: str = "sent", ts: Optional[str] = None, source: str = "Manual") -> dict[str, Any]:
	"""Manual touch — guest lists for Events / Private viewings, or tests of the loop."""
	assert_roles(*HQ_REGIONAL)
	_campaign_or_throw(campaign)
	if not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} does not exist").format(customer), frappe.DoesNotExistError)
	if event not in webhooks.EVENT_FIELD:
		frappe.throw(_("event must be sent, opened or clicked"), frappe.ValidationError)
	if source not in ("Manual", "Frappe Email Campaign", "Seed"):
		source = "Manual"
	name = webhooks.record_touch(campaign, customer, event, ts, source=source)
	return {"touch": name, "campaign": campaign, "customer": customer, "event": event}


@frappe.whitelist()
def sync_email_campaign(campaign: str) -> dict[str, Any]:
	"""Touches from the linked Frappe *Email Campaign* (Email Queue recipients: sent / opened)."""
	assert_roles(*HQ)
	doc = frappe.get_doc("Maison Campaign", _campaign_or_throw(campaign))
	if not doc.email_campaign or not frappe.db.exists("DocType", "Email Queue"):
		return {"campaign": campaign, "recorded": 0, "unmatched": []}
	queue = frappe.get_all("Email Queue", filters={"reference_doctype": "Email Campaign", "reference_name": doc.email_campaign, "status": ("in", ("Sent", "Partially Sent"))}, fields=["name", "creation"])
	events = []
	for q in queue:
		for r in frappe.get_all("Email Queue Recipient", filters={"parent": q.name}, fields=["recipient", "status"]):
			email = (r.recipient or "").strip().lower()
			events.append({"event": "sent", "email": email, "campaign_ref": campaign, "external_id": q.name, "ts": q.creation, "channel": "Email"})
			if r.status == "Opened":
				events.append({"event": "opened", "email": email, "campaign_ref": campaign, "external_id": q.name, "ts": q.creation, "channel": "Email"})
	res = webhooks.ingest(events, "frappe", default_campaign=campaign)
	frappe.db.sql("update `tabMaison Campaign Touch` set source = 'Frappe Email Campaign' where campaign = %s and source = 'Manual'", campaign)
	return {"campaign": campaign, **res}


@frappe.whitelist()
def run_attribution(from_date: Optional[str] = None, to_date: Optional[str] = None, campaign: Optional[str] = None) -> dict[str, Any]:
	"""Run the nightly attribution job now (HQ)."""
	assert_roles(*HQ)
	return attribution.run_attribution(from_date, to_date, campaign)


# ---------------------------------------------------------------------------
# inbound webhooks (guest, signed)
# ---------------------------------------------------------------------------
def _raw_body() -> bytes:
	req = getattr(frappe, "request", None)
	if req is None:
		return b""
	return req.get_data() if hasattr(req, "get_data") else (req.data or b"")


def _header(*names: str) -> Optional[str]:
	req = getattr(frappe, "request", None)
	if req is None:
		return None
	for n in names:
		v = req.headers.get(n)
		if v:
			return v
	return None


def _payload(body: bytes) -> Any:
	if not body:
		return {}
	try:
		return json.loads(body.decode("utf-8"))
	except (ValueError, UnicodeDecodeError):
		frappe.throw(_("Invalid JSON body"), frappe.ValidationError)


def _reject() -> None:
	frappe.local.response["http_status_code"] = 403
	frappe.throw(_("Invalid webhook signature"), frappe.PermissionError)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def webhook_klaviyo(campaign: Optional[str] = None) -> dict[str, Any]:
	"""Klaviyo webhook: HMAC-SHA256(body, ``klaviyo_webhook_secret``) in ``Klaviyo-Signature``."""
	body = _raw_body()
	secret = frappe.conf.get("klaviyo_webhook_secret")
	if not webhooks.verify_signature(secret, body, _header("Klaviyo-Signature", "X-Klaviyo-Signature"), _header("Klaviyo-Timestamp", "X-Klaviyo-Timestamp")):
		_reject()
	frappe.set_user("Administrator")
	res = webhooks.ingest(webhooks.parse_klaviyo(_payload(body)), "klaviyo", default_campaign=campaign if campaign and frappe.db.exists("Maison Campaign", campaign) else None)
	return {"ok": True, "provider": "klaviyo", **res}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def webhook_brevo(campaign: Optional[str] = None, token: Optional[str] = None) -> dict[str, Any]:
	"""Brevo webhook: HMAC in ``X-Brevo-Signature`` **or** the shared secret in ``X-Brevo-Token`` / ``?token=``."""
	body = _raw_body()
	secret = frappe.conf.get("brevo_webhook_secret")
	ok = webhooks.verify_signature(secret, body, _header("X-Brevo-Signature", "X-Sib-Signature")) or webhooks.verify_shared_token(secret, _header("X-Brevo-Token", "X-Sib-Token") or token)
	if not ok:
		_reject()
	frappe.set_user("Administrator")
	res = webhooks.ingest(webhooks.parse_brevo(_payload(body)), "brevo", default_campaign=campaign if campaign and frappe.db.exists("Maison Campaign", campaign) else None)
	return {"ok": True, "provider": "brevo", **res}
