"""Customer endpoints: search, upsert, purchase history."""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Max
from frappe.utils import cint, flt

from maison_pos.identifiers import CUSTOMER_QR_PREFIX, digits_only, is_client_number, normalize_client_number
from maison_pos.scoping import assert_roles, get_user_boutique, is_unrestricted
from maison_pos.scoping import ALL_MAISON_ROLES

CUSTOMER_FIELDS = [
	"name",
	"customer_name",
	"mobile_no",
	"email_id",
	"customer_group",
	"territory",
	"loyalty_program",
	"maison_client_number",
	"maison_face_consent",
	"maison_face_consent_at",
	"modified",
]
UPSERT_ALLOWED = {
	"customer_name",
	"mobile_no",
	"email_id",
	"customer_group",
	"territory",
	"loyalty_program",
	"gender",
	"customer_type",
	"maison_face_consent",
}
MIN_PHONE_DIGITS = 4


def _loyalty(customer: str, company: Optional[str] = None) -> tuple[float, Optional[str], float]:
	"""(points, tier_name, points_value) for a customer; tolerant of no loyalty program.

	``points_value`` is the redeemable currency value: points × conversion factor.
	"""
	loyalty_program = frappe.db.get_value("Customer", customer, "loyalty_program")
	if not loyalty_program:
		return 0.0, None, 0.0
	try:
		from erpnext.accounts.doctype.loyalty_program.loyalty_program import get_loyalty_program_details_with_points

		d = get_loyalty_program_details_with_points(customer, loyalty_program=loyalty_program, company=company, silent=True)
		points = flt(d.get("loyalty_points"))
		factor = flt(d.get("conversion_factor"))
		return points, d.get("tier_name"), flt(points * factor, 2)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "maison loyalty lookup")
		return 0.0, None, 0.0


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


def _template_counts(customers: list[str]) -> dict[str, int]:
	"""customer -> number of stored face templates (v0.3 Client screen status line)."""
	if not customers or not frappe.db.exists("DocType", "Maison Face Template"):
		return {}
	rows = frappe.get_all(
		"Maison Face Template",
		filters={"parent": ("in", customers), "parenttype": "Customer"},
		fields=["parent", "count(name) as n"],
		group_by="parent",
	)
	return {r.parent: cint(r.n) for r in rows}


def _serialize(rows: list[dict[str, Any]], company: Optional[str] = None) -> list[dict[str, Any]]:
	visits = _last_visits([r["name"] for r in rows])
	templates = _template_counts([r["name"] for r in rows])
	result = []
	for r in rows:
		points, tier, points_value = _loyalty(r["name"], company)
		v = visits.get(r["name"], {})
		consent_at = r.get("maison_face_consent_at")
		result.append(
			{
				"name": r["name"],
				"customer_name": r["customer_name"],
				"mobile_no": r.get("mobile_no"),
				"email_id": r.get("email_id"),
				"customer_group": r.get("customer_group"),
				"loyalty_program": r.get("loyalty_program"),
				"client_number": r.get("maison_client_number"),
				# v0.3 contract fields read by the POS (`Customer.maison_face_consent*`, `face_templates`)
				"maison_face_consent": cint(r.get("maison_face_consent")),
				"maison_face_consent_at": str(consent_at) if consent_at else None,
				"face_templates": templates.get(r["name"], 0),
				"face_consent": cint(r.get("maison_face_consent")),  # legacy alias
				"loyalty_points": points,
				"points_value": points_value,
				"tier": tier,
				"last_visit": v.get("last_visit"),
				"last_boutique": v.get("last_boutique"),
				"modified": str(r.get("modified")) if r.get("modified") else None,
			}
		)
	return result


def _phone_regexp(digits: str) -> str:
	"""REGEXP matching *digits* in ``mobile_no`` regardless of formatting (``+1 (212) 555-0100``)."""
	return "[^0-9]*".join(digits)


def _customer_rows(criterion, limit: int) -> list[dict[str, Any]]:
	C = DocType("Customer")
	q = (
		frappe.qb.from_(C)
		.select(*[C[f] for f in CUSTOMER_FIELDS])
		.where(C.disabled == 0)
		.orderby(C.modified, order=frappe.qb.desc)
		.limit(limit)
	)
	if criterion is not None:
		q = q.where(criterion)
	return q.run(as_dict=True)


@frappe.whitelist()
def search(q: str = "", limit: int = 20) -> list[dict[str, Any]]:
	"""Search customers by client number, phone (digits only, 4+), email or name (min 2 chars).

	Empty *q* returns the most recently modified customers. Returns rows with
	``client_number``, ``loyalty_points``, ``points_value``, ``tier`` and last visit.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	limit = min(max(cint(limit) or 20, 1), 100)
	q = (q or "").strip()
	if q.upper().startswith(CUSTOMER_QR_PREFIX):
		q = q[len(CUSTOMER_QR_PREFIX) :].strip()
	if q and len(q) < 2:
		return []
	criterion = None
	if q:
		C = DocType("Customer")
		like = f"%{q}%"
		criterion = (
			C.customer_name.like(like)
			| C.email_id.like(like)
			| C.name.like(like)
			| C.maison_client_number.like(f"%{normalize_client_number(q)}%")
		)
		digits = digits_only(q)
		# "phone-like" input: mostly digits (allow + ( ) - . and spaces) and at least 4 digits
		if digits and len(digits) >= MIN_PHONE_DIGITS and len(digits) >= len(q) - 6:
			criterion = criterion | C.mobile_no.regexp(_phone_regexp(digits))
		else:
			criterion = criterion | C.mobile_no.like(like)
	return _serialize(_customer_rows(criterion, limit))


@frappe.whitelist()
def lookup(code: str) -> Optional[dict[str, Any]]:
	"""Exact-match lookup for a scanned / typed code.

	Accepts a client number (``MC123456``), a client QR payload (``MC:<customer_id>`` or
	``MC:MC123456``), a full phone number (formatting ignored) or an email. Returns the same
	row shape as ``search`` or ``None`` when nothing matches exactly.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	code = (code or "").strip()
	if not code:
		return None
	name: Optional[str] = None
	if code.upper().startswith(CUSTOMER_QR_PREFIX):
		payload = code[len(CUSTOMER_QR_PREFIX) :].strip()
		if frappe.db.exists("Customer", payload):
			name = payload
		else:
			code = payload
	if not name and is_client_number(code):
		name = frappe.db.get_value("Customer", {"maison_client_number": normalize_client_number(code), "disabled": 0}, "name")
	if not name and "@" in code:
		name = frappe.db.get_value("Customer", {"email_id": code, "disabled": 0}, "name")
	if not name:
		digits = digits_only(code)
		if digits and len(digits) >= 7:
			C = DocType("Customer")
			rows = _customer_rows(C.mobile_no.regexp(_phone_regexp(digits)), 5)
			exact = [r["name"] for r in rows if digits_only(r.get("mobile_no")).endswith(digits)]
			if len(exact) == 1:
				name = exact[0]
	if not name and frappe.db.exists("Customer", {"name": code, "disabled": 0}):
		name = code
	if not name:
		return None
	row = frappe.db.get_value("Customer", name, CUSTOMER_FIELDS, as_dict=True)
	return _serialize([row])[0] if row else None


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
