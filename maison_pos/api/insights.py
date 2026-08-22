"""AI & insights endpoints (SPEC v0.4 §H) — ``/api/method/maison_pos.api.insights.*``.

| Endpoint | Who | Returns |
|---|---|---|
| ``recommend_for_client(customer, n=3, boutique?)`` | any Maison role | "Suggested for this client" tiles (cached weekly table, live fallback); never an owned item |
| ``recommend_for_basket(items, n=3, boutique?, customer?)`` | any Maison role | "Pairs well with" for the basket lines |
| ``client_signals(boutique?, limit=50, status="Open")`` | any Maison role (scoped) | "Clients to contact this week" |
| ``mark_signal(signal, status, note?)`` | any Maison role (scoped) | Contacted / Dismissed / Open |
| ``product_performance(period=90, boutique?)`` | Manager+ | items × boutiques, heatmap, top / slow movers, rebalance list |
| ``rebalance_suggestions(status="Open")`` | Manager+ | stored suggestions |
| ``create_transfer(suggestion)`` | Manager of either boutique / HQ | submits a Stock Entry (Material Transfer) |
| ``dismiss_suggestion(suggestion)`` | Manager+ | |
| ``narrative(period_end?, generate=0)`` | Manager+ (generate: HQ) | latest weekly ``Maison Insight Report`` |
| ``compute(narrative=0)`` | HQ / System Manager | runs the weekly job now |
| ``summary()`` | any Maison role | counts for dashboard tiles + last run |
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate

from maison_pos.insights import affinity, client_signals, jobs, narrative as narrative_mod, product_performance as perf
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, get_allowed_boutiques, get_user_boutique, is_manager_or_above, is_unrestricted


def _list(value: Any) -> list:
	if isinstance(value, str):
		try:
			value = json.loads(value)
		except ValueError:
			value = [v.strip() for v in value.split(",") if v.strip()]
	return list(value or [])


def _scoped_boutique(boutique: Optional[str]) -> Optional[str]:
	"""Unrestricted users may pass any boutique (or none = all); scoped users get their own."""
	if is_unrestricted():
		if boutique:
			assert_boutique_access(boutique)
		return boutique or None
	return assert_boutique_access(boutique)


# ---------------------------------------------------------------------------
# recommendations
# ---------------------------------------------------------------------------
@frappe.whitelist()
def recommend_for_client(customer: str, n: int = 3, boutique: Optional[str] = None) -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	n = min(max(cint(n) or 3, 1), 10)
	if not customer or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} does not exist").format(customer), frappe.DoesNotExistError)
	boutique = boutique or get_user_boutique()
	owned = affinity.owned_items(customer)
	rows = affinity.cached_recommendations(customer, n, boutique)
	source = "cache"
	if rows is None or len(rows) < min(n, 1):
		rows = affinity.recommend_for_client(customer, n, boutique, owned=owned)
		source = "live"
	rows = [r for r in rows if r["item_code"] not in owned][:n]
	return {"customer": customer, "items": rows, "owned": sorted(owned), "source": source}


@frappe.whitelist()
def recommend_for_basket(items: Any, n: int = 3, boutique: Optional[str] = None, customer: Optional[str] = None) -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	n = min(max(cint(n) or 3, 1), 10)
	codes = [str(c) for c in _list(items) if c]
	if not codes:
		return {"items": [], "basket": []}
	exclude = affinity.owned_items(customer) if customer and frappe.db.exists("Customer", customer) else set()
	boutique = boutique or get_user_boutique()
	return {"basket": codes, "items": affinity.recommend_for_basket(codes, n, boutique, exclude=exclude)}


# ---------------------------------------------------------------------------
# client signals
# ---------------------------------------------------------------------------
SIGNAL_FIELDS = [
	"name", "customer", "customer_name", "boutique", "preferred_associate", "signal_type", "priority", "status", "week", "reason",
	"recommended_item", "recommended_item_name", "churn_risk", "cadence_days", "expected_next_visit", "last_visit",
	"days_since_last_visit", "visits", "lifetime_spend", "spend_trend", "preferred_department", "preferred_metal",
	"contacted_by", "contacted_at", "note", "computed_at",
	# v0.5 M — call owner
	"assigned_associate", "assigned_at", "call_task", "crm_task",
]


@frappe.whitelist()
def client_signals(boutique: Optional[str] = None, limit: int = 50, status: str = "Open") -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = _scoped_boutique(boutique)
	filters: dict[str, Any] = {}
	if status and status != "All":
		filters["status"] = status
	if boutique:
		filters["boutique"] = boutique
	elif not is_unrestricted():
		filters["boutique"] = ("in", get_allowed_boutiques() or ["__none__"])
	rows = frappe.get_all("Maison Client Signal", filters=filters, fields=SIGNAL_FIELDS, order_by="priority desc, lifetime_spend desc", limit=min(max(cint(limit) or 50, 1), 500))
	phones = {c.name: c for c in frappe.get_all("Customer", filters={"name": ("in", [r.customer for r in rows])}, fields=["name", "mobile_no", "email_id", "maison_client_number"])} if rows else {}
	for r in rows:
		c = phones.get(r.customer)
		r["mobile_no"] = c.mobile_no if c else None
		r["email_id"] = c.email_id if c else None
		r["client_number"] = c.maison_client_number if c else None
	by_type: dict[str, int] = {}
	for r in rows:
		by_type[r.signal_type] = by_type.get(r.signal_type, 0) + 1
	return {"boutique": boutique, "signals": rows, "by_type": by_type, "week": rows[0].week if rows else client_signals.iso_week(getdate()), "last_run": jobs.last_run()}


@frappe.whitelist()
def mark_signal(signal: str, status: str, note: Optional[str] = None) -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if status not in ("Open", "Contacted", "Dismissed"):
		frappe.throw(_("status must be Open, Contacted or Dismissed"), frappe.ValidationError)
	doc = frappe.get_doc("Maison Client Signal", signal)
	if doc.boutique:
		assert_boutique_access(doc.boutique)
	doc.status = status
	if note is not None:
		doc.note = note
	if status == "Contacted":
		doc.contacted_by = frappe.session.user
		doc.contacted_at = frappe.utils.now_datetime()
	doc.flags.ignore_permissions = True
	doc.save()
	return {"ok": True, "signal": doc.name, "status": doc.status}


# --- v0.5 M — "Assign call" on a client signal (VIP lapsing churn list) ---
@frappe.whitelist()
def assign_call(signal: str, associate: Optional[str] = None, due_date: Optional[str] = None, note: Optional[str] = None) -> dict[str, Any]:
	"""One-tap "Assign call": creates a *Call* follow-up (``Maison Client Interaction`` + CRM Task)
	for the signal's preferred associate (or *associate*) and records the owner on the signal.

	Permissions: any Maison role; scoped users (Manager / Associate) only for signals of their own
	boutique and may only assign to associates of that boutique. Associates may only assign to
	themselves. Re-assigning cancels the previous open call follow-up.
	Returns ``{signal, associate, associate_name, task (interaction), crm_task, due_date}``.
	"""
	from maison_pos.api import crm as crm_api
	from maison_pos.scoping import get_associate, is_manager_or_above

	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	doc = frappe.get_doc("Maison Client Signal", signal)
	if doc.boutique:
		assert_boutique_access(doc.boutique)
	elif not is_unrestricted():
		frappe.throw(_("This signal has no boutique; only Head Office may assign it"), frappe.PermissionError)
	me = get_associate()
	target = associate or doc.assigned_associate or doc.preferred_associate
	if not target:
		from maison_pos.insights.client_signals import signal_owner

		target = signal_owner(None, doc.boutique, "VIP lapsing")
	if not target:
		frappe.throw(_("No associate to assign the call to — set a preferred associate on the client profile"), frappe.ValidationError)
	assoc = frappe.db.get_value("Maison Associate", target, ["name", "boutique", "full_name", "enabled"], as_dict=True)
	if not assoc or not assoc.enabled:
		frappe.throw(_("Associate {0} does not exist or is disabled").format(target), frappe.DoesNotExistError)
	if not is_unrestricted():
		if not is_manager_or_above() and (not me or me["name"] != assoc.name):
			frappe.throw(_("Associates may only assign calls to themselves"), frappe.PermissionError)
		if assoc.boutique != get_user_boutique():
			frappe.throw(_("You may only assign calls to associates of your boutique"), frappe.PermissionError)
	due = getdate(due_date) if due_date else frappe.utils.add_days(frappe.utils.nowdate(), 2)
	# cancel a previous open call follow-up when re-assigning
	if doc.call_task and frappe.db.exists("Maison Client Interaction", doc.call_task):
		prev = frappe.get_doc("Maison Client Interaction", doc.call_task)
		if prev.status == "Open" and prev.associate != assoc.name:
			prev.status = "Cancelled"
			prev.flags.ignore_permissions = True
			prev.save()
			crm_api._crm_task_upsert(prev)
	interaction = frappe.get_doc(
		{
			"doctype": "Maison Client Interaction",
			"customer": doc.customer,
			"customer_name": doc.customer_name,
			"type": "Call",
			"note": note or f"{doc.signal_type}: {doc.reason or ''}".strip(": "),
			"boutique": doc.boutique or assoc.boutique,
			"associate": assoc.name,
			"ts": frappe.utils.now_datetime(),
			"follow_up_date": due,
			"status": "Open",
		}
	)
	interaction.flags.ignore_permissions = True
	interaction.insert()
	crm_task = crm_api._crm_task_upsert(interaction)
	if crm_task:
		frappe.db.set_value("Maison Client Interaction", interaction.name, "crm_task", crm_task, update_modified=False)
	doc.assigned_associate = assoc.name
	doc.assigned_at = frappe.utils.now_datetime()
	doc.call_task = interaction.name
	doc.crm_task = crm_task
	if not doc.preferred_associate:
		doc.preferred_associate = assoc.name
	doc.flags.ignore_permissions = True
	doc.save()
	return {
		"ok": True,
		"signal": doc.name,
		"customer": doc.customer,
		"associate": assoc.name,
		"associate_name": assoc.full_name,
		"task": interaction.name,
		"crm_task": crm_task,
		"due_date": str(due),
	}
# --- end v0.5 M ---


# ---------------------------------------------------------------------------
# product performance + rebalancing
# ---------------------------------------------------------------------------
def _days(period: Any) -> int:
	if isinstance(period, str) and period.strip().lower().endswith("d"):
		period = period.strip()[:-1]
	return max(7, min(cint(period) or perf.DEFAULT_DAYS, 730))


@frappe.whitelist()
def product_performance(period: Any = None, boutique: Optional[str] = None) -> dict[str, Any]:
	"""Manager+ see the whole chain (the comparison is the point); the rows can be filtered by *boutique*."""
	if not is_manager_or_above():
		frappe.throw(_("Managers only"), frappe.PermissionError)
	data = perf.product_performance(_days(period))
	if boutique:
		assert_boutique_access(boutique) if not is_unrestricted() else None
		data["items"] = [r for r in data["items"] if r["boutique"] == boutique]
		data["top_movers"] = {boutique: data["top_movers"].get(boutique, [])}
		data["slow_movers"] = {boutique: data["slow_movers"].get(boutique, [])}
	return data


REBALANCE_FIELDS = [
	"name", "item_code", "item_name", "item_group", "has_serial_no", "from_boutique", "to_boutique", "qty", "value", "status", "reason",
	"period_days", "from_on_hand", "from_velocity", "from_days_on_hand", "to_on_hand", "to_velocity", "to_days_on_hand",
	"material_transfer", "transferred_by", "transferred_at", "serial_nos", "computed_at",
]


@frappe.whitelist()
def rebalance_suggestions(status: str = "Open", limit: int = 100) -> dict[str, Any]:
	if not is_manager_or_above():
		frappe.throw(_("Managers only"), frappe.PermissionError)
	filters: dict[str, Any] = {}
	if status and status != "All":
		filters["status"] = status
	rows = frappe.get_all("Maison Rebalance Suggestion", filters=filters, fields=REBALANCE_FIELDS, order_by="value desc", limit=min(max(cint(limit) or 100, 1), 500))
	if not is_unrestricted():
		own = get_user_boutique()
		rows = [r for r in rows if own in (r.from_boutique, r.to_boutique)]
	for r in rows:
		r["can_transfer"] = r.status == "Open" and _may_transfer(r.from_boutique, r.to_boutique)
	return {"suggestions": rows, "last_run": jobs.last_run()}


def _may_transfer(from_boutique: str, to_boutique: str) -> bool:
	if is_unrestricted():
		return True
	if not is_manager_or_above():
		return False
	return get_user_boutique() in (from_boutique, to_boutique)


def _pick_serials(item_code: str, warehouse: str, qty: int) -> list[str]:
	rows = frappe.get_all("Serial No", filters={"item_code": item_code, "warehouse": warehouse, "status": "Active"}, pluck="name", order_by="creation asc", limit=qty)
	if len(rows) < qty:
		frappe.throw(_("Only {0} serial(s) of {1} are in stock at {2}").format(len(rows), item_code, warehouse), frappe.ValidationError)
	return rows


@frappe.whitelist()
def create_transfer(suggestion: str, qty: Optional[int] = None) -> dict[str, Any]:
	"""One-click Material Transfer for an Open suggestion (submitted Stock Entry)."""
	doc = frappe.get_doc("Maison Rebalance Suggestion", suggestion)
	if doc.status != "Open":
		frappe.throw(_("Suggestion {0} is {1}").format(suggestion, doc.status), frappe.ValidationError)
	if not _may_transfer(doc.from_boutique, doc.to_boutique):
		frappe.throw(_("Only a manager of {0} or {1} (or Head Office) may transfer").format(doc.from_boutique, doc.to_boutique), frappe.PermissionError)
	qty = cint(qty) or cint(doc.qty)
	if qty <= 0 or qty > cint(doc.qty):
		frappe.throw(_("qty must be between 1 and {0}").format(doc.qty), frappe.ValidationError)
	src = frappe.get_cached_doc("Maison Boutique", doc.from_boutique)
	dst = frappe.get_cached_doc("Maison Boutique", doc.to_boutique)
	on_hand = flt(frappe.db.get_value("Bin", {"item_code": doc.item_code, "warehouse": src.warehouse}, "actual_qty"))
	if on_hand < qty:
		frappe.throw(_("Only {0} of {1} on hand at {2}").format(on_hand, doc.item_code, doc.from_boutique), frappe.ValidationError)
	row: dict[str, Any] = {"item_code": doc.item_code, "qty": qty, "s_warehouse": src.warehouse, "t_warehouse": dst.warehouse}
	serials: list[str] = []
	if cint(doc.has_serial_no):
		serials = _pick_serials(doc.item_code, src.warehouse, qty)
		row["use_serial_batch_fields"] = 1
		row["serial_no"] = "\n".join(serials)
	se = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Transfer",
			"purpose": "Material Transfer",
			"company": src.company,
			"from_warehouse": src.warehouse,
			"to_warehouse": dst.warehouse,
			"remarks": _("Maison rebalance {0}: {1}").format(doc.name, doc.reason or ""),
			"items": [row],
		}
	)
	se.flags.ignore_permissions = True
	se.insert()
	se.submit()
	doc.db_set({"status": "Transferred", "material_transfer": se.name, "transferred_by": frappe.session.user, "transferred_at": frappe.utils.now_datetime(), "serial_nos": "\n".join(serials) or None, "qty": qty}, update_modified=True)
	frappe.publish_realtime("maison_rebalance", {"suggestion": doc.name, "stock_entry": se.name, "item_code": doc.item_code, "from": doc.from_boutique, "to": doc.to_boutique, "qty": qty}, room="maison_dashboard", after_commit=True)
	return {"ok": True, "suggestion": doc.name, "stock_entry": se.name, "qty": qty, "serial_nos": serials}


@frappe.whitelist()
def dismiss_suggestion(suggestion: str, note: Optional[str] = None) -> dict[str, Any]:
	doc = frappe.get_doc("Maison Rebalance Suggestion", suggestion)
	if not _may_transfer(doc.from_boutique, doc.to_boutique):
		frappe.throw(_("Managers of the boutiques involved only"), frappe.PermissionError)
	if doc.status != "Open":
		frappe.throw(_("Suggestion {0} is {1}").format(suggestion, doc.status), frappe.ValidationError)
	doc.db_set({"status": "Dismissed", "reason": (doc.reason or "") + (f"\nDismissed: {note}" if note else "")})
	return {"ok": True, "suggestion": doc.name, "status": "Dismissed"}


# ---------------------------------------------------------------------------
# narrative / jobs
# ---------------------------------------------------------------------------
REPORT_FIELDS = ["name", "title", "kind", "period_start", "period_end", "generator", "model", "generated_at", "net", "invoices", "change_pct", "narrative", "emailed_to", "emailed_at", "error"]


@frappe.whitelist()
def narrative(period_end: Optional[str] = None, generate: int = 0) -> dict[str, Any]:
	"""Latest weekly report (or the one ending *period_end*); ``generate=1`` (HQ) builds it now."""
	if not is_manager_or_above():
		frappe.throw(_("Managers only"), frappe.PermissionError)
	if cint(generate):
		assert_roles("Maison Head Office", "System Manager")
		res = jobs.weekly_narrative(period_end=period_end, send=False)
		doc = frappe.get_doc("Maison Insight Report", res["report"])
		out = {k: doc.get(k) for k in REPORT_FIELDS}
		out["numbers"] = frappe.parse_json(doc.numbers) if doc.numbers else None
		return out
	filters: dict[str, Any] = {"kind": "Weekly"}
	if period_end:
		filters["period_end"] = getdate(period_end)
	rows = frappe.get_all("Maison Insight Report", filters=filters, fields=REPORT_FIELDS + ["numbers"], order_by="period_end desc", limit=1)
	if not rows:
		return {"report": None}
	r = rows[0]
	r["numbers"] = frappe.parse_json(r.numbers) if r.numbers else None
	return r


@frappe.whitelist()
def compute(narrative: int = 0, send: int = 0) -> dict[str, Any]:
	"""Run the weekly insight job on demand (Head Office / System Manager)."""
	assert_roles("Maison Head Office", "System Manager")
	out = jobs.compute_weekly(commit=not frappe.flags.in_test)
	if cint(narrative):
		out["narrative"] = jobs.weekly_narrative(send=bool(cint(send)), commit=not frappe.flags.in_test)
	return out


@frappe.whitelist()
def summary() -> dict[str, Any]:
	"""Counts for the dashboard tiles."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutiques = get_allowed_boutiques()
	sig_filters: dict[str, Any] = {"status": "Open"}

	if not is_unrestricted():
		sig_filters["boutique"] = ("in", boutiques or ["__none__"])
	latest = frappe.get_all("Maison Insight Report", filters={"kind": "Weekly"}, fields=["name", "title", "period_end", "generator", "generated_at"], order_by="period_end desc", limit=1)
	return {
		"open_signals": frappe.db.count("Maison Client Signal", sig_filters),
		"open_rebalances": frappe.db.count("Maison Rebalance Suggestion", {"status": "Open"}),
		"recommended_clients": cint(frappe.db.sql("select count(distinct customer) from `tabMaison Client Recommendation`")[0][0]),
		"latest_report": latest[0] if latest else None,
		"last_run": jobs.last_run(),
		"llm": bool(narrative_mod.llm_config()),
	}
