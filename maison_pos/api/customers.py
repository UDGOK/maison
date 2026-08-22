"""Customer endpoints: search, upsert, purchase history."""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Max
from frappe.utils import cint, flt

from maison_pos.scoping import assert_roles, get_user_boutique, is_unrestricted
from maison_pos.scoping import ALL_MAISON_ROLES

CUSTOMER_FIELDS = ["name", "customer_name", "mobile_no", "email_id", "customer_group", "territory", "loyalty_program", "modified"]
UPSERT_ALLOWED = {"customer_name", "mobile_no", "email_id", "customer_group", "territory", "loyalty_program", "gender", "customer_type"}


def _loyalty(customer: str, company: Optional[str] = None) -> tuple[float, Optional[str]]:
	"""(points, tier_name) for a customer; tolerant of no loyalty program."""
	loyalty_program = frappe.db.get_value("Customer", customer, "loyalty_program")
	if not loyalty_program:
		return 0.0, None
	try:
		from erpnext.accounts.doctype.loyalty_program.loyalty_program import get_loyalty_program_details_with_points

		d = get_loyalty_program_details_with_points(customer, loyalty_program=loyalty_program, company=company, silent=True)
		return flt(d.get("loyalty_points")), d.get("tier_name")
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison loyalty lookup")
		return 0.0, None


def _last_visits(customers: list[str]) -> dict[str, dict[str, Any]]:
	"""Map customer -> {last_visit, last_boutique} using the newest submitted POS invoice."""
	if not customers:
		return {}
	SI = DocType("Sales Invoice")
	latest = (
		frappe.qb.from_(SI)
		.select(SI.customer, Max(SI.posting_date).as_("last_visit"))
		.where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.customer.isin(customers)))
		.groupby(SI.customer)
	).run(as_dict=True)
	out: dict[str, dict[str, Any]] = {}
	for row in latest:
		boutique = frappe.db.get_value(
			"Sales Invoice",
			{"customer": row.customer, "docstatus": 1, "is_pos": 1, "posting_date": row.last_visit},
			"maison_boutique",
			order_by="posting_time desc",
		)
		out[row.customer] = {"last_visit": str(row.last_visit), "last_boutique": boutique}
	return out


def _serialize(rows: list[dict[str, Any]], company: Optional[str] = None) -> list[dict[str, Any]]:
	visits = _last_visits([r["name"] for r in rows])
	result = []
	for r in rows:
		points, tier = _loyalty(r["name"], company)
		v = visits.get(r["name"], {})
		result.append(
			{
				"name": r["name"],
				"customer_name": r["customer_name"],
				"mobile_no": r.get("mobile_no"),
				"email_id": r.get("email_id"),
				"customer_group": r.get("customer_group"),
				"loyalty_program": r.get("loyalty_program"),
				"loyalty_points": points,
				"tier": tier,
				"last_visit": v.get("last_visit"),
				"last_boutique": v.get("last_boutique"),
				"modified": str(r.get("modified")) if r.get("modified") else None,
			}
		)
	return result


@frappe.whitelist()
def search(q: str = "", limit: int = 20) -> list[dict[str, Any]]:
	"""Search customers by name / mobile / email (min 2 chars). Empty q returns recently modified."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	limit = min(max(cint(limit) or 20, 1), 100)
	q = (q or "").strip()
	if q and len(q) < 2:
		return []
	filters = {"disabled": 0}
	or_filters = None
	if q:
		like = f"%{q}%"
		or_filters = [["customer_name", "like", like], ["mobile_no", "like", like], ["email_id", "like", like], ["name", "like", like]]
	rows = frappe.get_all(
		"Customer",
		filters=filters,
		or_filters=or_filters,
		fields=CUSTOMER_FIELDS,
		order_by="modified desc",
		limit=limit,
	)
	return _serialize(rows)


@frappe.whitelist()
def get(customer: str) -> dict[str, Any]:
	"""Single customer with loyalty + last visit."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	row = frappe.db.get_value("Customer", customer, CUSTOMER_FIELDS, as_dict=True)
	if not row:
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	return _serialize([row])[0]


@frappe.whitelist()
def upsert(customer: Any) -> dict[str, str]:
	"""Create or update a Customer. Input: ``{name?, customer_name, mobile_no?, email_id?, ...}``.

	Without ``name`` we match an existing customer by mobile or email to avoid duplicates.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	data = json.loads(customer) if isinstance(customer, str) else dict(customer or {})
	if not data:
		frappe.throw(_("customer payload is required"), frappe.ValidationError)

	name = data.pop("name", None)
	if not name:
		for key in ("mobile_no", "email_id"):
			if data.get(key):
				name = frappe.db.get_value("Customer", {key: data[key], "disabled": 0}, "name")
				if name:
					break

	values = {k: v for k, v in data.items() if k in UPSERT_ALLOWED}
	if name and frappe.db.exists("Customer", name):
		doc = frappe.get_doc("Customer", name)
		doc.update(values)
		doc.flags.ignore_permissions = True
		doc.save()
	else:
		if not values.get("customer_name"):
			frappe.throw(_("customer_name is required"), frappe.ValidationError)
		doc = frappe.new_doc("Customer")
		doc.update(
			{
				"customer_type": "Individual",
				"customer_group": frappe.db.get_single_value("Selling Settings", "customer_group") or _default("Customer Group"),
				"territory": frappe.db.get_single_value("Selling Settings", "territory") or _default("Territory"),
			}
		)
		doc.update(values)
		if not doc.loyalty_program:
			doc.loyalty_program = frappe.db.get_value("Loyalty Program", {"auto_opt_in": 1}, "name")
		doc.flags.ignore_permissions = True
		doc.insert()
	return {"name": doc.name}


def _default(doctype: str) -> Optional[str]:
	return frappe.db.get_value(doctype, {"is_group": 0}, "name", order_by="creation asc")


@frappe.whitelist()
def history(customer: str, limit: int = 20) -> list[dict[str, Any]]:
	"""Submitted POS invoices for *customer*, newest first. Scoped users see only their boutique."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	limit = min(max(cint(limit) or 20, 1), 100)
	filters: dict[str, Any] = {"customer": customer, "docstatus": 1, "is_pos": 1}
	if not is_unrestricted():
		filters["maison_boutique"] = get_user_boutique() or "__none__"
	invoices = frappe.get_all(
		"Sales Invoice",
		filters=filters,
		fields=["name", "posting_date", "posting_time", "maison_boutique", "grand_total", "is_return", "currency"],
		order_by="posting_date desc, posting_time desc",
		limit=limit,
	)
	if not invoices:
		return []
	names = [i.name for i in invoices]
	items = frappe.get_all(
		"Sales Invoice Item",
		filters={"parent": ("in", names)},
		fields=["parent", "item_code", "item_name", "qty", "rate", "amount", "serial_no"],
		order_by="idx",
	)
	by_parent: dict[str, list[dict[str, Any]]] = {}
	for it in items:
		by_parent.setdefault(it.parent, []).append(
			{"item_code": it.item_code, "item_name": it.item_name, "qty": flt(it.qty), "rate": flt(it.rate), "amount": flt(it.amount), "serial_no": it.serial_no}
		)
	return [
		{
			"invoice": i.name,
			"date": f"{i.posting_date} {i.posting_time}",
			"boutique": i.maison_boutique,
			"items": by_parent.get(i.name, []),
			"grand_total": flt(i.grand_total),
			"is_return": int(i.is_return or 0),
			"currency": i.currency,
		}
		for i in invoices
	]
