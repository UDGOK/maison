"""Clienteling (v0.4 section B): client profiles, wishlists, owned pieces, follow-ups, interactions.

Frappe CRM is optional glue: when the ``crm`` app is installed, follow-ups are mirrored as
``CRM Task`` rows and every profile is linked to a standard ``Contact`` (the doctype Frappe CRM
uses for people). Without it the same data lives on ``Maison Client Profile`` /
``Maison Client Interaction`` and nothing degrades (feature detection: :func:`crm_installed`).
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, now_datetime, nowdate

from maison_pos.scoping import ALL_MAISON_ROLES, assert_roles, get_associate, get_user_boutique, is_manager_or_above, is_unrestricted

PROFILE_FIELDS = (
	"ring_size",
	"wrist_size",
	"metal_preference",
	"birthday",
	"anniversary",
	"spouse_name",
	"style_notes",
	"preferred_associate",
	"preferred_boutique",
	"do_not_email",
	"do_not_sms",
	"do_not_phone",
)
MANAGER_ONLY_FIELDS = ("vip_tier_override",)
INTERACTION_TYPES = ("Note", "Call", "Email", "SMS", "Visit", "Follow-up", "Wishlist match", "Birthday")
WISHLIST_ALERT_COOLDOWN_DAYS = 30


# ---------------------------------------------------------------------------
# feature detection / CRM glue
# ---------------------------------------------------------------------------
def crm_installed() -> bool:
	"""True when Frappe CRM (``crm``) is installed on this site."""
	return "crm" in frappe.get_installed_apps() and bool(frappe.db.exists("DocType", "CRM Task"))


def ensure_contact(customer: str) -> Optional[str]:
	"""Find or create the standard ``Contact`` linked to *customer* (what Frappe CRM shows as a person)."""
	existing = frappe.db.get_value("Dynamic Link", {"link_doctype": "Customer", "link_name": customer, "parenttype": "Contact"}, "parent")
	if existing:
		return existing
	cust = frappe.db.get_value("Customer", customer, ["customer_name", "email_id", "mobile_no"], as_dict=True)
	if not cust:
		return None
	parts = (cust.customer_name or customer).split(" ", 1)
	try:
		contact = frappe.get_doc(
			{
				"doctype": "Contact",
				"first_name": parts[0],
				"last_name": parts[1] if len(parts) > 1 else None,
				"is_primary_contact": 1,
				"links": [{"link_doctype": "Customer", "link_name": customer}],
			}
		)
		if cust.email_id:
			contact.append("email_ids", {"email_id": cust.email_id, "is_primary": 1})
		if cust.mobile_no:
			contact.append("phone_nos", {"phone": cust.mobile_no, "is_primary_mobile_no": 1})
		contact.flags.ignore_permissions = True
		contact.insert()
		return contact.name
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"maison ensure_contact {customer}")
		return None


def _crm_task_upsert(interaction) -> Optional[str]:
	"""Mirror an open follow-up as a Frappe CRM Task (no-op without the app)."""
	if not crm_installed():
		return None
	try:
		assignee = interaction.associate or frappe.session.user
		status = "Todo" if interaction.status == "Open" else "Done" if interaction.status == "Done" else "Canceled"
		if interaction.crm_task and frappe.db.exists("CRM Task", interaction.crm_task):
			frappe.db.set_value("CRM Task", interaction.crm_task, {"status": status, "due_date": interaction.follow_up_date}, update_modified=True)
			return interaction.crm_task
		task = frappe.get_doc(
			{
				"doctype": "CRM Task",
				"title": f"{interaction.type}: {interaction.customer_name or interaction.customer}",
				"description": interaction.note,
				"status": status,
				"priority": "Medium",
				"due_date": interaction.follow_up_date,
				"assigned_to": assignee if frappe.db.exists("User", assignee) else None,
				"reference_doctype": "Customer",
				"reference_docname": interaction.customer,
			}
		)
		task.flags.ignore_permissions = True
		task.insert()
		return task.name
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison crm task")
		return None


# ---------------------------------------------------------------------------
# profile
# ---------------------------------------------------------------------------
def _assert_customer(customer: str) -> None:
	if not customer or not frappe.db.exists("Customer", customer):
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)


def get_or_create_profile(customer: str):
	"""``Maison Client Profile`` for *customer*, created on first access."""
	_assert_customer(customer)
	if frappe.db.exists("Maison Client Profile", customer):
		return frappe.get_doc("Maison Client Profile", customer)
	doc = frappe.get_doc({"doctype": "Maison Client Profile", "customer": customer})
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc


def owned_pieces(customer: str, limit: int = 50) -> list[dict[str, Any]]:
	"""Serialized pieces the client bought (net of returns), newest first."""
	rows = frappe.get_all(
		"Sales Invoice Item",
		filters={"parent": ("in", frappe.get_all("Sales Invoice", filters={"customer": customer, "docstatus": 1}, pluck="name") or ["__none__"]), "serial_no": ("is", "set")},
		fields=["parent", "item_code", "item_name", "serial_no", "qty", "rate"],
		order_by="creation desc",
	)
	owned: dict[str, dict[str, Any]] = {}
	for r in rows:
		for serial in (r.serial_no or "").replace(",", "\n").split("\n"):
			serial = serial.strip()
			if not serial:
				continue
			if flt(r.qty) < 0:  # return: no longer owned
				owned.pop(serial, None)
				continue
			inv = frappe.db.get_value("Sales Invoice", r.parent, ["posting_date", "maison_boutique"], as_dict=True) or {}
			item = frappe.db.get_value("Item", r.item_code, ["maison_metal", "maison_certificate_no", "image"], as_dict=True) or {}
			owned[serial] = {
				"serial_no": serial,
				"item_code": r.item_code,
				"item_name": r.item_name,
				"invoice": r.parent,
				"date": str(inv.get("posting_date")) if inv.get("posting_date") else None,
				"boutique": inv.get("maison_boutique"),
				"rate": flt(r.rate),
				"metal": item.get("maison_metal"),
				"certificate_no": item.get("maison_certificate_no"),
			}
	return sorted(owned.values(), key=lambda x: x["date"] or "", reverse=True)[:limit]


def _wishlist_rows(doc) -> list[dict[str, Any]]:
	out = []
	for w in doc.wishlist:
		out.append(
			{
				"name": w.name,
				"item_code": w.item_code,
				"item_name": w.item_name or frappe.db.get_value("Item", w.item_code, "item_name"),
				"notes": w.notes,
				"added_by": w.added_by,
				"added_on": str(w.added_on) if w.added_on else None,
				"fulfilled": cint(w.fulfilled),
				"fulfilled_on": str(w.fulfilled_on) if w.fulfilled_on else None,
				"fulfilled_invoice": w.fulfilled_invoice,
			}
		)
	return out


def _next_best_offer(customer: str, n: int = 3) -> list[dict[str, Any]]:
	"""Section H glue: use insights.recommend_for_client when present, else empty."""
	try:
		from maison_pos.insights import affinity  # type: ignore

		if hasattr(affinity, "recommend_for_client"):
			return affinity.recommend_for_client(customer, n) or []
	except Exception:
		pass
	return []


def profile_payload(customer: str, include_history: bool = True) -> dict[str, Any]:
	from maison_pos.api.customers import get as customer_get
	from maison_pos.api.promotions import tier_progress

	doc = get_or_create_profile(customer)
	summary = customer_get(customer)
	profile = {k: doc.get(k) for k in PROFILE_FIELDS + MANAGER_ONLY_FIELDS}
	for k in ("birthday", "anniversary"):
		profile[k] = str(profile[k]) if profile[k] else None
	for k in ("do_not_email", "do_not_sms", "do_not_phone"):
		profile[k] = cint(profile[k])
	if doc.preferred_associate:
		profile["preferred_associate_name"] = frappe.db.get_value("Maison Associate", doc.preferred_associate, "full_name")
	loyalty = tier_progress(customer)
	if loyalty.get("tier"):
		summary["tier"] = loyalty["tier"]
	return {
		"customer": summary,
		"profile": profile,
		"wishlist": _wishlist_rows(doc),
		"owned_pieces": owned_pieces(customer) if include_history else [],
		"follow_ups": tasks(customer, _internal=True),
		"interactions": interactions(customer, limit=20, _internal=True) if include_history else [],
		"loyalty": loyalty,
		"next_best_offer": _next_best_offer(customer),
		"crm": {"installed": crm_installed(), "contact": doc.crm_contact},
		"can_edit_tier": is_manager_or_above(),
	}


@frappe.whitelist()
def profile(customer: str) -> dict[str, Any]:
	"""Full clienteling view for the POS Client screen."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	return profile_payload(customer)


@frappe.whitelist()
def update_profile(customer: str, values: Any) -> dict[str, Any]:
	"""Update profile fields. ``vip_tier_override`` needs Maison Manager+. Returns the profile."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	data = json.loads(values) if isinstance(values, str) else dict(values or {})
	doc = get_or_create_profile(customer)
	unknown = set(data) - set(PROFILE_FIELDS) - set(MANAGER_ONLY_FIELDS)
	if unknown:
		frappe.throw(_("Unknown profile fields: {0}").format(", ".join(sorted(unknown))), frappe.ValidationError)
	if set(data) & set(MANAGER_ONLY_FIELDS) and not is_manager_or_above():
		frappe.throw(_("Only managers may change the VIP tier"), frappe.PermissionError)
	for k, v in data.items():
		if k in ("do_not_email", "do_not_sms", "do_not_phone"):
			v = cint(v)
		elif k in ("birthday", "anniversary"):
			v = getdate(v) if v else None
		elif k == "preferred_associate" and v and not frappe.db.exists("Maison Associate", v):
			frappe.throw(_("Associate {0} not found").format(v), frappe.DoesNotExistError)
		elif k == "preferred_boutique" and v and not frappe.db.exists("Maison Boutique", v):
			frappe.throw(_("Boutique {0} not found").format(v), frappe.DoesNotExistError)
		doc.set(k, v)
	doc.flags.ignore_permissions = True
	doc.save()
	return profile_payload(customer, include_history=False)


# ---------------------------------------------------------------------------
# wishlist
# ---------------------------------------------------------------------------
@frappe.whitelist()
def wishlist_add(customer: str, item_code: str, notes: Optional[str] = None) -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if not frappe.db.exists("Item", item_code):
		frappe.throw(_("Item {0} not found").format(item_code), frappe.DoesNotExistError)
	doc = get_or_create_profile(customer)
	row = next((w for w in doc.wishlist if w.item_code == item_code and not cint(w.fulfilled)), None)
	if row:
		if notes:
			row.notes = notes
	else:
		row = doc.append("wishlist", {"item_code": item_code, "notes": notes, "added_by": frappe.session.user, "added_on": now_datetime()})
	doc.flags.ignore_permissions = True
	doc.save()
	return {"customer": customer, "row": row.name, "wishlist": _wishlist_rows(doc)}


@frappe.whitelist()
def wishlist_remove(customer: str, item_code: Optional[str] = None, row: Optional[str] = None) -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	doc = get_or_create_profile(customer)
	keep = [w for w in doc.wishlist if not ((row and w.name == row) or (item_code and w.item_code == item_code and not row))]
	if len(keep) == len(doc.wishlist):
		frappe.throw(_("Wishlist row not found"), frappe.DoesNotExistError)
	doc.set("wishlist", keep)
	doc.flags.ignore_permissions = True
	doc.save()
	return {"customer": customer, "wishlist": _wishlist_rows(doc)}


def fulfil_wishlist_on_sale(doc, method: Optional[str] = None) -> None:
	"""Sales Invoice on_submit: tick wishlist rows for the items the client just bought."""
	if not doc.get("is_pos") or doc.get("is_return") or not doc.customer:
		return
	if not frappe.db.exists("Maison Client Profile", doc.customer):
		return
	bought = {r.item_code for r in doc.items}
	profile_doc = frappe.get_doc("Maison Client Profile", doc.customer)
	changed = False
	for w in profile_doc.wishlist:
		if w.item_code in bought and not cint(w.fulfilled):
			w.fulfilled = 1
			w.fulfilled_on = now_datetime()
			w.fulfilled_invoice = doc.name
			changed = True
	if changed:
		profile_doc.flags.ignore_permissions = True
		profile_doc.save()


def _notify(users: list[str], subject: str, doctype: str, name: str, email_content: Optional[str] = None) -> int:
	sent = 0
	for user in {u for u in users if u and frappe.db.exists("User", {"name": u, "enabled": 1})}:
		try:
			frappe.get_doc(
				{"doctype": "Notification Log", "for_user": user, "type": "Alert", "subject": subject, "document_type": doctype, "document_name": name, "email_content": email_content or subject, "from_user": frappe.session.user}
			).insert(ignore_permissions=True)
			sent += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(), "maison notify")
	return sent


def boutique_manager_users(boutique: Optional[str]) -> list[str]:
	if not boutique:
		return []
	return frappe.get_all("Maison Associate", filters={"boutique": boutique, "role": "Manager", "enabled": 1}, pluck="user")


def wishlist_matches_for(item_code: str, warehouse: Optional[str] = None, serial_no: Optional[str] = None) -> list[dict[str, Any]]:
	"""Alert every client wishing for *item_code* (cooldown 30 days). Returns the alerts created."""
	rows = frappe.get_all(
		"Maison Wishlist Item",
		filters={"item_code": item_code, "fulfilled": 0, "parenttype": "Maison Client Profile"},
		fields=["name", "parent", "alerted_on"],
	)
	if not rows:
		return []
	boutique = frappe.db.get_value("Maison Boutique", {"warehouse": warehouse}, "name") if warehouse else None
	item_name = frappe.db.get_value("Item", item_code, "item_name") or item_code
	created = []
	for w in rows:
		if w.alerted_on and getdate(w.alerted_on) > add_days(getdate(), -WISHLIST_ALERT_COOLDOWN_DAYS):
			continue
		prof = frappe.db.get_value("Maison Client Profile", w.parent, ["preferred_associate", "preferred_boutique", "customer_name"], as_dict=True)
		target_boutique = boutique or prof.preferred_boutique
		users = [prof.preferred_associate] if prof.preferred_associate else boutique_manager_users(target_boutique)
		note = _("{0} wished for {1}{2}: now available{3}").format(prof.customer_name or w.parent, item_name, f" ({serial_no})" if serial_no else "", f" at {target_boutique}" if target_boutique else "")
		inter = frappe.get_doc(
			{
				"doctype": "Maison Client Interaction",
				"customer": w.parent,
				"type": "Wishlist match",
				"note": note,
				"boutique": target_boutique,
				"associate": prof.preferred_associate,
				"ts": now_datetime(),
				"follow_up_date": nowdate(),
				"status": "Open",
			}
		)
		inter.flags.ignore_permissions = True
		inter.insert()
		_notify(users, note, "Maison Client Profile", w.parent)
		frappe.db.set_value("Maison Wishlist Item", w.name, "alerted_on", now_datetime(), update_modified=False)
		created.append({"customer": w.parent, "interaction": inter.name, "users": users})
	if created:
		frappe.publish_realtime("maison_wishlist_match", {"item_code": item_code, "matches": len(created), "boutique": boutique}, room="maison_dashboard")
	return created


def on_stock_entry_submit(doc, method: Optional[str] = None) -> None:
	"""Stock Entry on_submit: items received into a boutique warehouse → wishlist alerts."""
	if not frappe.db.exists("DocType", "Maison Client Profile"):
		return
	seen: set[tuple[str, str]] = set()
	for row in doc.items:
		if not row.t_warehouse:
			continue
		key = (row.item_code, row.t_warehouse)
		if key in seen:
			continue
		seen.add(key)
		try:
			serial = (row.get("serial_no") or "").split("\n")[0].strip() or None
			wishlist_matches_for(row.item_code, row.t_warehouse, serial)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "maison wishlist alert")


@frappe.whitelist()
def wishlist_matches(boutique: Optional[str] = None, limit: int = 20) -> dict[str, Any]:
	"""Dashboard tile: open 'Wishlist match' follow-ups (last 30 days)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	filters: dict[str, Any] = {"type": "Wishlist match", "status": "Open", "ts": (">=", add_days(nowdate(), -30))}
	if boutique or not is_unrestricted():
		from maison_pos.scoping import assert_boutique_access

		filters["boutique"] = assert_boutique_access(boutique or get_user_boutique())
	rows = frappe.get_all("Maison Client Interaction", filters=filters, fields=["name", "customer", "customer_name", "note", "boutique", "associate", "ts"], order_by="ts desc", limit=cint(limit) or 20)
	return {"count": frappe.db.count("Maison Client Interaction", filters), "matches": rows}


# ---------------------------------------------------------------------------
# follow-ups & interactions
# ---------------------------------------------------------------------------
def _interaction_row(r: dict[str, Any]) -> dict[str, Any]:
	return {
		"name": r.name,
		"customer": r.customer,
		"customer_name": r.get("customer_name"),
		"type": r.type,
		"note": r.note,
		"boutique": r.boutique,
		"associate": r.associate,
		"ts": str(r.ts) if r.ts else None,
		"follow_up_date": str(r.follow_up_date) if r.follow_up_date else None,
		"status": r.status,
		"done_on": str(r.done_on) if r.get("done_on") else None,
		"crm_task": r.get("crm_task"),
		"sales_invoice": r.get("sales_invoice"),
	}


INTERACTION_LIST_FIELDS = ["name", "customer", "customer_name", "type", "note", "boutique", "associate", "ts", "follow_up_date", "status", "done_on", "crm_task", "sales_invoice"]


@frappe.whitelist()
def tasks(customer: Optional[str] = None, boutique: Optional[str] = None, associate: Optional[str] = None, include_done: int = 0, limit: int = 50, _internal: bool = False) -> list[dict[str, Any]]:
	"""Follow-ups (interactions with a ``follow_up_date``), open first, due date ascending.

	Without *customer*: the caller's boutique (managers) or own assignments (associates).
	"""
	if not _internal:
		assert_roles(*ALL_MAISON_ROLES, "System Manager")
	filters: dict[str, Any] = {"follow_up_date": ("is", "set")}
	if not cint(include_done):
		filters["status"] = "Open"
	if customer:
		filters["customer"] = customer
	else:
		if boutique or not is_unrestricted():
			from maison_pos.scoping import assert_boutique_access

			filters["boutique"] = assert_boutique_access(boutique or get_user_boutique())
		if associate:
			filters["associate"] = associate
		elif not is_manager_or_above():
			filters["associate"] = (get_associate() or {}).get("name") or "__none__"
	rows = frappe.get_all("Maison Client Interaction", filters=filters, fields=INTERACTION_LIST_FIELDS, order_by="status asc, follow_up_date asc", limit=min(cint(limit) or 50, 200))
	return [_interaction_row(r) for r in rows]


@frappe.whitelist()
def interactions(customer: str, limit: int = 20, _internal: bool = False) -> list[dict[str, Any]]:
	"""Timeline of logged interactions for a client (newest first) — also mirrors Frappe Comments on the Customer."""
	if not _internal:
		assert_roles(*ALL_MAISON_ROLES, "System Manager")
	rows = frappe.get_all("Maison Client Interaction", filters={"customer": customer}, fields=INTERACTION_LIST_FIELDS, order_by="ts desc", limit=min(cint(limit) or 20, 200))
	return [_interaction_row(r) for r in rows]


@frappe.whitelist()
def log_interaction(customer: str, type: str, note: Optional[str] = None, follow_up_date: Optional[str] = None, boutique: Optional[str] = None, associate: Optional[str] = None, sales_invoice: Optional[str] = None) -> dict[str, Any]:  # noqa: A002
	"""Log a note / call / visit; with ``follow_up_date`` it becomes an open follow-up (and a CRM Task)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	_assert_customer(customer)
	if type not in INTERACTION_TYPES:
		frappe.throw(_("Unknown interaction type {0}").format(type), frappe.ValidationError)
	me = get_associate()
	doc = frappe.get_doc(
		{
			"doctype": "Maison Client Interaction",
			"customer": customer,
			"type": type,
			"note": note,
			"boutique": boutique or (me or {}).get("boutique") or get_user_boutique(),
			"associate": associate or (me or {}).get("name"),
			"ts": now_datetime(),
			"follow_up_date": getdate(follow_up_date) if follow_up_date else None,
			"status": "Open" if follow_up_date else "Done",
			"done_on": None if follow_up_date else now_datetime(),
			"done_by": None if follow_up_date else frappe.session.user,
			"sales_invoice": sales_invoice,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	if follow_up_date:
		task = _crm_task_upsert(doc)
		if task:
			frappe.db.set_value("Maison Client Interaction", doc.name, "crm_task", task, update_modified=False)
			doc.crm_task = task
	# keep the desk timeline in sync (Frappe Comment on the Customer)
	try:
		frappe.get_doc(
			{"doctype": "Comment", "comment_type": "Comment", "reference_doctype": "Customer", "reference_name": customer, "content": f"<b>{type}</b>: {frappe.utils.escape_html(note or '')}" + (f" · follow-up {follow_up_date}" if follow_up_date else "")}
		).insert(ignore_permissions=True)
	except Exception:
		pass
	get_or_create_profile(customer)
	return _interaction_row(frappe.db.get_value("Maison Client Interaction", doc.name, INTERACTION_LIST_FIELDS, as_dict=True))


@frappe.whitelist()
def complete_task(name: str, status: str = "Done") -> dict[str, Any]:
	"""Mark a follow-up Done / Cancelled (mirrors to the CRM Task)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if status not in ("Done", "Cancelled", "Open"):
		frappe.throw(_("Invalid status"), frappe.ValidationError)
	doc = frappe.get_doc("Maison Client Interaction", name)
	if not is_unrestricted() and doc.boutique and doc.boutique != get_user_boutique():
		frappe.throw(_("Not your boutique"), frappe.PermissionError)
	doc.status = status
	doc.done_on = now_datetime() if status == "Done" else None
	doc.done_by = frappe.session.user if status == "Done" else None
	doc.flags.ignore_permissions = True
	doc.save()
	_crm_task_upsert(doc)
	return _interaction_row(frappe.db.get_value("Maison Client Interaction", doc.name, INTERACTION_LIST_FIELDS, as_dict=True))


@frappe.whitelist()
def upcoming_dates(boutique: Optional[str] = None, days: int = 30) -> list[dict[str, Any]]:
	"""Clients with a birthday / anniversary within *days* (clienteling reminders)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	today = getdate()
	horizon = cint(days) or 30
	filters: dict[str, Any] = {}
	if boutique or not is_unrestricted():
		from maison_pos.scoping import assert_boutique_access

		filters["preferred_boutique"] = assert_boutique_access(boutique or get_user_boutique())
	rows = frappe.get_all("Maison Client Profile", filters=filters, fields=["customer", "customer_name", "birthday", "anniversary", "preferred_associate", "preferred_boutique"])
	out = []
	for r in rows:
		for kind in ("birthday", "anniversary"):
			d = r.get(kind)
			if not d:
				continue
			d = getdate(d)
			try:
				nxt = d.replace(year=today.year)
			except ValueError:  # 29 Feb
				nxt = d.replace(year=today.year, day=28)
			if nxt < today:
				nxt = nxt.replace(year=today.year + 1)
			delta = (nxt - today).days
			if delta <= horizon:
				out.append({"customer": r.customer, "customer_name": r.customer_name, "kind": kind, "date": str(nxt), "in_days": delta, "preferred_associate": r.preferred_associate, "preferred_boutique": r.preferred_boutique})
	return sorted(out, key=lambda x: x["in_days"])
