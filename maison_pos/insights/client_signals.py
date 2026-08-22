"""Client patterns → ``Maison Client Signal`` rows ("Clients to contact this week").

Per client (from submitted, non-return POS invoices):

* visits            distinct visit dates
* cadence_days      mean gap between visits (≥ 2 visits), else the chain median cadence
* expected_next     last_visit + cadence
* churn_risk        0–1 from recency vs cadence — see :func:`churn_score`
* spend_trend       spend in the last 90 days vs the 90 days before (−1 … +1)
* preferred department / metal (by spend)
* birthday / anniversary within 30 days — read from ``Maison Client Profile`` (v0.4 B) when that
  doctype exists; silently skipped otherwise.

Each client gets at most one signal (the most urgent type) with a priority 0–100 so the list is
actionable; the reason text is what the associate sees.
"""

from __future__ import annotations

import datetime as _dt
import math
from collections import defaultdict
from typing import Any, Optional

import frappe
from frappe.utils import add_days, cint, date_diff, flt, getdate, nowdate

DEFAULT_CADENCE_DAYS = 60
SOON_WINDOW_DAYS = 7
OCCASION_WINDOW_DAYS = 30
VIP_SPEND = 50_000.0

SIGNAL_TYPES = ("Overdue visit", "Due this week", "Birthday", "Anniversary", "Spend drop", "VIP lapsing", "New client follow-up")


# ---------------------------------------------------------------------------
# pure math
# ---------------------------------------------------------------------------
def cadence_days(visit_dates: list[_dt.date], fallback: float = DEFAULT_CADENCE_DAYS) -> float:
	"""Mean gap between consecutive distinct visit dates; *fallback* with fewer than 2 visits."""
	ds = sorted({getdate(d) for d in visit_dates})
	if len(ds) < 2:
		return float(fallback)
	gaps = [(b - a).days for a, b in zip(ds, ds[1:])]
	return max(1.0, sum(gaps) / len(gaps))


def churn_score(days_since_last: float, cadence: float) -> float:
	"""Churn risk in [0, 1].

	``r = days_since / cadence``. Up to one cadence the risk grows slowly (0 → 0.2); beyond it the
	risk rises as ``1 − e^−(r − 1)`` scaled into the remaining 0.2 → 1 band, so a client at 3×
	their usual gap scores ≈ 0.9 and one at exactly their cadence ≈ 0.2.
	"""
	if cadence <= 0:
		return 0.0
	r = max(0.0, float(days_since_last)) / float(cadence)
	if r <= 1.0:
		return round(0.2 * r, 4)
	return round(min(1.0, 0.2 + 0.8 * (1.0 - math.exp(-(r - 1.0)))), 4)


def spend_trend(recent: float, previous: float) -> float:
	"""(recent − previous) / max(recent, previous) → −1 … +1; 0 when both are 0."""
	top = max(recent, previous)
	if top <= 0:
		return 0.0
	return round((recent - previous) / top, 4)


def days_until(occasion: Optional[_dt.date], today: _dt.date) -> Optional[int]:
	"""Days until the next anniversary of *occasion* (0 = today); None when unset."""
	if not occasion:
		return None
	occ = getdate(occasion)
	try:
		nxt = occ.replace(year=today.year)
	except ValueError:  # 29 Feb
		nxt = occ.replace(year=today.year, day=28)
	if nxt < today:
		try:
			nxt = occ.replace(year=today.year + 1)
		except ValueError:
			nxt = occ.replace(year=today.year + 1, day=28)
	return (nxt - today).days


# --- v0.5 M ---
def signal_owner(preferred_associate: Optional[str], boutique: Optional[str], signal_type: str) -> Optional[str]:
	"""Owner of a signal: the preferred associate when it exists; for *VIP lapsing* fall back to the
	boutique's manager (then any enabled associate of the boutique) so the churn list always has a name."""
	if preferred_associate and frappe.db.exists("Maison Associate", {"name": preferred_associate, "enabled": 1}):
		return preferred_associate
	if signal_type != "VIP lapsing" or not boutique:
		return None
	for role in ("Manager", "Associate"):
		owner = frappe.db.get_value("Maison Associate", {"boutique": boutique, "role": role, "enabled": 1}, "name", order_by="name")
		if owner:
			return owner
	return None
# --- end v0.5 M ---


def classify(stats: dict[str, Any], today: _dt.date) -> Optional[dict[str, Any]]:
	"""Pick the single most urgent signal for a client; None when nothing is worth a call."""
	cad = flt(stats["cadence_days"])
	since = date_diff(today, stats["last_visit"]) if stats.get("last_visit") else None
	risk = churn_score(since, cad) if since is not None else 0.0
	expected = add_days(stats["last_visit"], int(round(cad))) if stats.get("last_visit") else None
	until_expected = date_diff(expected, today) if expected else None
	spend = flt(stats.get("lifetime_spend"))
	trend = flt(stats.get("spend_trend"))
	candidates: list[tuple[float, str, str]] = []

	bday = stats.get("days_to_birthday")
	if bday is not None and 0 <= bday <= OCCASION_WINDOW_DAYS:
		candidates.append((70 + (OCCASION_WINDOW_DAYS - bday), "Birthday", f"Birthday in {bday} day{'s' if bday != 1 else ''}"))
	ann = stats.get("days_to_anniversary")
	if ann is not None and 0 <= ann <= OCCASION_WINDOW_DAYS:
		candidates.append((65 + (OCCASION_WINDOW_DAYS - ann), "Anniversary", f"Anniversary in {ann} day{'s' if ann != 1 else ''}"))

	if since is not None and stats.get("visits", 0) >= 2:
		if risk >= 0.45:
			label = "VIP lapsing" if spend >= VIP_SPEND else "Overdue visit"
			base = 60 if label == "VIP lapsing" else 40
			candidates.append((base + 40 * risk, label, f"Usually visits every {int(round(cad))} days — last seen {since} days ago"))
		elif until_expected is not None and -SOON_WINDOW_DAYS <= until_expected <= SOON_WINDOW_DAYS:
			candidates.append((30 + 10 * min(1.0, spend / VIP_SPEND), "Due this week", f"Expected back around {expected} (every ~{int(round(cad))} days)"))
	if stats.get("visits", 0) >= 3 and trend <= -0.5 and flt(stats.get("spend_prev")) > 2_000:
		candidates.append((35 + 20 * min(1.0, spend / VIP_SPEND), "Spend drop", f"Spend down {abs(round(trend * 100))}% vs the previous 90 days"))
	if stats.get("visits", 0) == 1 and since is not None and 10 <= since <= 30 and spend >= 3_000:
		candidates.append((25 + 10 * min(1.0, spend / 20_000), "New client follow-up", f"First purchase {since} days ago ({frappe.utils.fmt_money(spend, currency='USD')}) — thank-you call"))

	if not candidates:
		return None
	prio, kind, reason = max(candidates, key=lambda c: c[0])
	return {
		"signal_type": kind,
		"priority": round(min(100.0, prio), 1),
		"reason": reason,
		"churn_risk": risk,
		"expected_next_visit": expected,
		"days_since_last_visit": since,
	}


# ---------------------------------------------------------------------------
# loaders
# ---------------------------------------------------------------------------
def _profile_occasions(customers: list[str]) -> dict[str, dict[str, Any]]:
	"""birthday / anniversary / preferred associate from Maison Client Profile (v0.4 B), if installed."""
	if not customers or not frappe.db.exists("DocType", "Maison Client Profile"):
		return {}
	meta = frappe.get_meta("Maison Client Profile")
	fields = ["customer"] + [
		f
		for f in ("birthday", "anniversary", "preferred_associate", "preferred_boutique", "do_not_phone", "do_not_email", "do_not_sms", "do_not_contact_phone", "do_not_contact_email")
		if meta.has_field(f)
	]
	if not meta.has_field("customer"):
		return {}
	try:
		rows = frappe.get_all("Maison Client Profile", filters={"customer": ("in", customers)}, fields=fields)
	except Exception:
		return {}
	return {r.customer: r for r in rows}


def client_stats(today: Optional[_dt.date] = None, customers: Optional[list[str]] = None) -> dict[str, dict[str, Any]]:
	"""Per-client aggregates from the invoice history."""
	today = today or getdate(nowdate())
	walk_in = set(frappe.get_all("POS Profile", pluck="customer"))
	filters: dict[str, Any] = {"docstatus": 1, "is_pos": 1, "is_return": 0}
	if customers:
		filters["customer"] = ("in", customers)
	invoices = frappe.get_all(
		"Sales Invoice",
		filters=filters,
		fields=["name", "customer", "customer_name", "posting_date", "grand_total", "net_total", "maison_boutique", "maison_associate"],
		order_by="posting_date asc",
	)
	invoices = [i for i in invoices if i.customer and i.customer not in walk_in]
	if not invoices:
		return {}
	names = [i.name for i in invoices]
	lines = frappe.get_all("Sales Invoice Item", filters={"parent": ("in", names)}, fields=["parent", "item_code", "amount"])
	item_codes = list({l.item_code for l in lines})
	meta = {r.name: r for r in frappe.get_all("Item", filters={"name": ("in", item_codes)}, fields=["name", "item_group", "maison_department", "maison_metal"])} if item_codes else {}
	by_inv_lines: dict[str, list] = defaultdict(list)
	for l in lines:
		by_inv_lines[l.parent].append(l)

	recent_from = add_days(today, -90)
	prev_from = add_days(today, -180)
	stats: dict[str, dict[str, Any]] = {}
	for i in invoices:
		s = stats.setdefault(
			i.customer,
			{
				"customer": i.customer,
				"customer_name": i.customer_name,
				"visit_dates": [],
				"lifetime_spend": 0.0,
				"spend_recent": 0.0,
				"spend_prev": 0.0,
				"boutiques": defaultdict(int),
				"associates": defaultdict(int),
				"departments": defaultdict(float),
				"metals": defaultdict(float),
				"last_items": [],
			},
		)
		d = getdate(i.posting_date)
		s["visit_dates"].append(d)
		s["lifetime_spend"] += flt(i.grand_total)
		if d >= recent_from:
			s["spend_recent"] += flt(i.grand_total)
		elif d >= prev_from:
			s["spend_prev"] += flt(i.grand_total)
		if i.maison_boutique:
			s["boutiques"][i.maison_boutique] += 1
		if i.maison_associate:
			s["associates"][i.maison_associate] += 1
		for l in by_inv_lines.get(i.name, []):
			m = meta.get(l.item_code)
			if m:
				if m.maison_department:
					s["departments"][m.maison_department] += flt(l.amount)
				if m.maison_metal:
					s["metals"][m.maison_metal] += flt(l.amount)
		s["last_items"] = [l.item_code for l in by_inv_lines.get(i.name, [])]

	all_cadences = [cadence_days(s["visit_dates"], fallback=0) for s in stats.values() if len(set(s["visit_dates"])) >= 2]
	median_cadence = sorted(all_cadences)[len(all_cadences) // 2] if all_cadences else DEFAULT_CADENCE_DAYS
	occasions = _profile_occasions(list(stats.keys()))

	for c, s in stats.items():
		dates = sorted(set(s["visit_dates"]))
		s["visits"] = len(dates)
		s["first_visit"] = dates[0]
		s["last_visit"] = dates[-1]
		s["cadence_days"] = round(cadence_days(dates, fallback=median_cadence), 1)
		s["cadence_is_estimate"] = len(dates) < 2
		s["spend_trend"] = spend_trend(s["spend_recent"], s["spend_prev"])
		s["preferred_boutique"] = max(s["boutiques"].items(), key=lambda kv: kv[1])[0] if s["boutiques"] else None
		s["preferred_associate"] = max(s["associates"].items(), key=lambda kv: kv[1])[0] if s["associates"] else None
		s["preferred_department"] = max(s["departments"].items(), key=lambda kv: kv[1])[0] if s["departments"] else None
		s["preferred_metal"] = max(s["metals"].items(), key=lambda kv: kv[1])[0] if s["metals"] else None
		s["avg_ticket"] = round(s["lifetime_spend"] / max(1, len(s["visit_dates"])), 2)
		p = occasions.get(c)
		s["days_to_birthday"] = days_until(p.get("birthday"), today) if p and p.get("birthday") else None
		s["days_to_anniversary"] = days_until(p.get("anniversary"), today) if p and p.get("anniversary") else None
		if p and p.get("preferred_associate"):
			s["preferred_associate"] = p.get("preferred_associate")
		if p and p.get("preferred_boutique"):
			s["preferred_boutique"] = p.get("preferred_boutique")
		# unreachable = no phone AND no e-mail allowed (a client who only declined SMS can still be called)
		no_phone = bool(p and (p.get("do_not_phone") or p.get("do_not_contact_phone")))
		no_email = bool(p and (p.get("do_not_email") or p.get("do_not_contact_email")))
		s["do_not_contact"] = no_phone and no_email
		for k in ("boutiques", "associates", "departments", "metals", "visit_dates"):
			s.pop(k, None)
	return stats


def iso_week(day: _dt.date) -> str:
	y, w, _ = getdate(day).isocalendar()
	return f"{y}-W{w:02d}"


def compute_client_signals(today: Optional[_dt.date] = None) -> dict[str, Any]:
	"""Weekly job: rebuild the open signals (keeps Contacted / Dismissed rows of the current week)."""
	today = getdate(today or nowdate())
	week = iso_week(today)
	stats = client_stats(today)
	# recommendations computed earlier in the same job give the "next best offer" per client:
	# the best-ranked *piece* (a service such as an appraisal is a weak reason to call)
	recs: dict[str, Any] = {}
	for r in frappe.get_all("Maison Client Recommendation", fields=["customer", "item_code", "item_name", "item_group", "rank"], order_by="customer, `rank` asc"):
		cur = recs.get(r.customer)
		if cur is None or (cur.item_group == "Services" and r.item_group != "Services"):
			recs[r.customer] = r
	handled = {
		r.customer: r.status
		for r in frappe.get_all("Maison Client Signal", filters={"week": week, "status": ("in", ("Contacted", "Dismissed"))}, fields=["customer", "status"])
	}
	frappe.db.delete("Maison Client Signal", {"status": "Open"})
	frappe.db.delete("Maison Client Signal", {"week": ("!=", week), "status": ("in", ("Contacted", "Dismissed"))})
	computed_at = frappe.utils.now_datetime()
	created = 0
	by_type: dict[str, int] = defaultdict(int)
	for customer, s in stats.items():
		if customer in handled or s.get("do_not_contact"):
			continue
		sig = classify(s, today)
		if not sig:
			continue
		rec = recs.get(customer)
		frappe.get_doc(
			{
				"doctype": "Maison Client Signal",
				"customer": customer,
				"customer_name": s["customer_name"],
				"boutique": s.get("preferred_boutique"),
				# --- v0.5 M: every VIP-lapsing signal has an owner (preferred associate, else the boutique manager) ---
				"preferred_associate": signal_owner(s.get("preferred_associate"), s.get("preferred_boutique"), sig["signal_type"]),
				# --- end v0.5 M ---
				"signal_type": sig["signal_type"],
				"priority": sig["priority"],
				"reason": sig["reason"],
				"churn_risk": sig["churn_risk"],
				"cadence_days": s["cadence_days"],
				"expected_next_visit": sig["expected_next_visit"],
				"last_visit": s["last_visit"],
				"days_since_last_visit": sig["days_since_last_visit"],
				"visits": s["visits"],
				"lifetime_spend": round(s["lifetime_spend"], 2),
				"spend_trend": s["spend_trend"],
				"preferred_department": s.get("preferred_department"),
				"preferred_metal": s.get("preferred_metal"),
				"recommended_item": rec.item_code if rec else None,
				"recommended_item_name": rec.item_name if rec else None,
				"status": "Open",
				"week": week,
				"computed_at": computed_at,
			}
		).insert(ignore_permissions=True)
		created += 1
		by_type[sig["signal_type"]] += 1
	return {"week": week, "clients": len(stats), "signals": created, "by_type": dict(by_type)}
