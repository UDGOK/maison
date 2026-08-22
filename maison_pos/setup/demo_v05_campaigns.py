"""v0.5 §M demo seed — called from ``maison_pos.setup.demo.seed()`` (guarded, idempotent).

Three campaigns whose touches line up with the seeded history invoices (``seed_history``), so the
nightly attribution shows real numbers:

| code | channel | segment | send date | attribution |
|---|---|---|---|---|
| ``SUMMER-TIMEPIECES`` | Email | Timepieces buyers (24 m) | today − 40 d | featured TP-001/005/006 → item-level |
| ``PATRON-VIEWING`` | Private viewing | tier Patron | today − 21 d | last-touch (14 d) + assisted |
| ``BRIDAL-SMS`` | SMS | Bridal buyers, Oak Street | today − 9 d | coupon BRIDAL500, direct |

Touches: a deterministic share (``buyer_share``) of the clients with a POS sale inside
[send, send + assisted window] gets a *sent* touch at the send date (some opened / clicked, deterministic), plus segment members who did not buy (so
conversion < 100 %). Re-running rebuilds the ``Seed`` touches and re-runs attribution for the
last 45 days.
"""

from __future__ import annotations

import random
from typing import Any, Optional

import frappe
from frappe.utils import add_days, get_datetime, getdate, nowdate

from maison_pos.campaigns import attribution, segments

SEED_SOURCE = "Seed"
MAX_TOUCHES = 80

CAMPAIGNS: list[dict[str, Any]] = [
	{
		"campaign_code": "SUMMER-TIMEPIECES",
		"title": "Summer Timepieces — Meridian & Corsaire",
		"channel": "Email",
		"status": "Sent",
		"days_ago": 40,
		"content_link": "https://maison.example/journal/summer-timepieces",
		"cost": 4_500,
		"segment_item_group": "Timepieces",
		"segment_months": 24,
		"featured_items": ["TP-001", "TP-005", "TP-006"],
		"buyer_share": 0.4,
		"max_touches": 80,
		"klaviyo_campaign_id": "01J5KLV-SUMMER-TP",
		"notes": "Klaviyo send; UTM utm_campaign=SUMMER-TIMEPIECES.",
	},
	{
		"campaign_code": "PATRON-VIEWING",
		"title": "Patron private viewing — Atelier collection",
		"channel": "Private viewing",
		"status": "Sent",
		"days_ago": 21,
		"content_link": "https://maison.example/private/atelier",
		"cost": 12_000,
		"segment_tier": "Patron",
		"buyer_share": 0.2,
		"max_touches": 30,
		"notes": "Invitation-only evening; guest list recorded as manual touches.",
	},
	{
		"campaign_code": "BRIDAL-SMS",
		"title": "Bridal bands — $500 off (SMS)",
		"channel": "SMS",
		"status": "Sent",
		"days_ago": 9,
		"cost": 600,
		"segment_item_group": "Bridal",
		"segment_boutique": "CHI-OAK",
		"coupon": "BRIDAL500",
		"brevo_campaign_id": "brevo-bridal-0925",
		"buyer_share": 0.6,
		"max_touches": 40,
		"notes": "Brevo SMS; coupon BRIDAL500 at the counter.",
	},
]


def _walk_ins() -> set[str]:
	return {c for c in frappe.get_all("POS Profile", pluck="customer") if c}


def ensure_campaign(spec: dict[str, Any], today) -> str:
	values = {k: v for k, v in spec.items() if k not in ("days_ago", "featured_items", "buyer_share", "max_touches")}
	values["send_date"] = add_days(today, -spec["days_ago"])
	if values.get("coupon") and not frappe.db.exists("Maison Coupon", values["coupon"]):
		values.pop("coupon")
	if frappe.db.exists("Maison Campaign", spec["campaign_code"]):
		doc = frappe.get_doc("Maison Campaign", spec["campaign_code"])
		doc.update(values)
	else:
		doc = frappe.get_doc({"doctype": "Maison Campaign", **values})
	doc.set("featured_items", [])
	for code in spec.get("featured_items", []):
		if frappe.db.exists("Item", code):
			doc.append("featured_items", {"item_code": code})
	doc.flags.ignore_permissions = True
	if doc.is_new():
		doc.insert()
	else:
		doc.save()
	return doc.name


def buyers_in_window(send_date, days: int, boutique: Optional[str] = None, item_group: Optional[str] = None) -> list[str]:
	"""Customers with a POS sale in [send_date, send_date + days] (optionally in a boutique / item group)."""
	conds = ["si.docstatus = 1", "si.is_pos = 1", "si.is_return = 0", "ifnull(si.customer, '') != ''", "si.posting_date between %(a)s and %(b)s"]
	values: dict[str, Any] = {"a": send_date, "b": add_days(send_date, days)}
	if boutique:
		conds.append("si.maison_boutique = %(boutique)s")
		values["boutique"] = boutique
	join = ""
	if item_group:
		join = "join `tabSales Invoice Item` sii on sii.parent = si.name"
		conds.append("sii.item_group = %(group)s")
		values["group"] = item_group
	rows = frappe.db.sql(f"select distinct si.customer from `tabSales Invoice` si {join} where {' and '.join(conds)} order by si.customer", values, pluck="customer")
	walk = _walk_ins()
	return [r for r in rows if r not in walk]


def seed_touches(campaign: str, spec: dict[str, Any], today, rng: random.Random) -> dict[str, int]:
	doc = frappe.get_doc("Maison Campaign", campaign)
	send_dt = get_datetime(f"{doc.send_date} 09:30:00")
	frappe.db.delete("Maison Campaign Touch", {"campaign": campaign, "source": SEED_SOURCE})
	# buyers first (these are the sales the attribution will credit), then segment filler
	buyers = buyers_in_window(doc.send_date, doc.assisted_window_days, boutique=spec.get("segment_boutique"), item_group=spec.get("segment_item_group") if spec.get("channel") != "Email" else None)
	if not buyers:  # e.g. no history yet: fall back to any buyer in the window
		buyers = buyers_in_window(doc.send_date, doc.assisted_window_days)
	# only a share of the buyers were actually touched (a campaign never reaches every client)
	buyers = sorted(rng.sample(buyers, max(1, round(len(buyers) * spec.get("buyer_share", 0.4))))) if buyers else []
	segment = [r["customer"] for r in segments.build_segment(doc.as_dict())]
	ordered: list[str] = []
	for c in buyers + segment:
		if c not in ordered:
			ordered.append(c)
	ordered = ordered[: spec.get("max_touches", MAX_TOUCHES)]
	emails = {r.name: r.email_id for r in frappe.get_all("Customer", filters={"name": ("in", ordered)}, fields=["name", "email_id"])} if ordered else {}
	created = opened = clicked = 0
	for idx, customer in enumerate(ordered):
		touch: dict[str, Any] = {
			"doctype": "Maison Campaign Touch",
			"campaign": campaign,
			"customer": customer,
			"channel": doc.channel,
			"source": SEED_SOURCE,
			"sent_at": send_dt,
			"external_id": f"seed-{doc.campaign_code}-{idx:03d}",
			"email": emails.get(customer),
		}
		r = rng.random()
		if doc.channel in ("Event", "Private viewing"):
			# guest list: "opened" = RSVP'd, "clicked" = attended
			if r < 0.7:
				touch["opened_at"] = add_days(send_dt, 1)
				opened += 1
			if r < 0.45:
				touch["clicked_at"] = add_days(send_dt, 3)
				clicked += 1
		else:
			if r < 0.55:
				touch["opened_at"] = get_datetime(add_days(send_dt, 0)).replace(hour=12 + idx % 8)
				opened += 1
			if r < 0.22:
				touch["clicked_at"] = get_datetime(add_days(send_dt, 1)).replace(hour=10 + idx % 9)
				clicked += 1
		frappe.get_doc(touch).insert(ignore_permissions=True)
		created += 1
	frappe.db.set_value("Maison Campaign", campaign, "segment_size", len(segment), update_modified=False)
	return {"touches": created, "buyers": len(buyers), "segment": len(segment), "opened": opened, "clicked": clicked}


def seed_v05_campaigns(today: Optional[str] = None) -> dict[str, Any]:
	"""Entry point (idempotent). Returns a summary with the attribution run."""
	today = getdate(today or nowdate())
	rng = random.Random(505)
	summary: dict[str, Any] = {"campaigns": {}}
	for spec in CAMPAIGNS:
		name = ensure_campaign(spec, today)
		summary["campaigns"][name] = seed_touches(name, spec, today, rng)
	summary["attribution"] = attribution.run_attribution(from_date=add_days(today, -45), to_date=today)
	return summary
