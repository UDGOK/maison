"""Customer endpoints: search, upsert, purchase history."""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Max
from frappe.utils import cint, flt

from maison_pos.identifiers import CUSTOMER_QR_PREFIX, coerce_client_number, digits_only, normalize_client_number
from maison_pos.scoping import assert_roles, get_user_boutique, is_unrestricted, is_store_scoped
from maison_pos.scoping import ALL_AWANZ_ROLES

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
#: v0.7 S6 — a store user searching the chain-wide client book gets an exact-ish match and a
#: short page of it. Bulk reading the book is closed off at the list-query level
#: (``maison_pos.scoping.customer_query``); this is the service counter, not a data export.
SCOPED_SEARCH_LIMIT = 25
SCOPED_SEARCH_MIN_CHARS = 3


def _loyalty(customer: str, company: Optional[str] = None) -> tuple[float, Optional[str], float]:
	"""(points, tier_name, points_value) for a customer; tolerant of no loyalty program.

	``points_value`` is the redeemable currency value: points × conversion factor.
	"""
	from maison_pos.api.rewards import is_walk_in

	# v0.6 D5 — the walk-in placeholder never carries a member card
	if is_walk_in(customer):
		return 0.0, None, 0.0
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
		frappe.log_error(frappe.get_traceback(), "awanz loyalty lookup")
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
	if not customers or not frappe.db.exists("DocType", "AWANZ Face Template"):
		return {}
	rows = frappe.get_all(
		"AWANZ Face Template",
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


def _walk_in_customers() -> list[str]:
	"""POS-Profile default customers — placeholders that must not appear in a client list (D5)."""
	return [c for c in frappe.get_all("POS Profile", pluck="customer") if c]


def _customer_rows(criterion, limit: int) -> list[dict[str, Any]]:
	C = DocType("Customer")
	q = (
		frappe.qb.from_(C)
		.select(*[C[f] for f in CUSTOMER_FIELDS])
		.where(C.disabled == 0)
		.orderby(C.modified, order=frappe.qb.desc)
		.limit(limit)
	)
	# v0.6 D5 — "Walk-in Customer" used to head the default POS client list
	walk_ins = _walk_in_customers()
	if walk_ins:
		q = q.where(C.name.notin(walk_ins))
	if criterion is not None:
		q = q.where(criterion)
	rows = q.run(as_dict=True)
	return [r for r in rows if not str(r.get("customer_name") or "").lower().startswith("walk-in")]


def store_customer_criterion(boutique: str):
	"""Query-builder form of :func:`maison_pos.scoping.customer_query` — *this store's* clients."""
	C = DocType("Customer")
	SI = DocType("Sales Invoice")
	A = DocType("AWANZ Associate")
	criterion = C.name.isin(frappe.qb.from_(SI).select(SI.customer).where(SI.maison_boutique == boutique)) | C.owner.isin(
		frappe.qb.from_(A).select(A.user).where(A.boutique == boutique)
	)
	if frappe.get_meta("Sales Order").has_field("maison_boutique"):
		SO = DocType("Sales Order")
		criterion = criterion | C.name.isin(frappe.qb.from_(SO).select(SO.customer).where(SO.maison_boutique == boutique))
	if frappe.db.exists("DocType", "AWANZ Client Profile"):
		P = DocType("AWANZ Client Profile")
		criterion = criterion | C.name.isin(frappe.qb.from_(P).select(P.name).where(P.preferred_boutique == boutique))
	return criterion


def _search_criterion(q: str, exact_ish: bool):
	"""Match *q* against client number / phone / e-mail / name.

	*exact_ish* (store staff, v0.7 S6) anchors the text matches to the start of a name or word
	instead of ``%q%`` anywhere, so the search stays a search and does not double as a way of
	walking the client book one letter at a time.
	"""
	C = DocType("Customer")
	like = f"%{q}%"
	number = normalize_client_number(q)
	if exact_ish:
		criterion = (
			C.customer_name.like(f"{q}%")
			| C.customer_name.like(f"% {q}%")
			| C.email_id.like(f"{q}%")
			| C.name.like(f"{q}%")
			| C.maison_client_number.like(f"{number}%")
		)
	else:
		criterion = C.customer_name.like(like) | C.email_id.like(like) | C.name.like(like) | C.maison_client_number.like(f"%{number}%")
	digits = digits_only(q)
	# "phone-like" input: mostly digits (allow + ( ) - . and spaces) and at least 4 digits
	if digits and len(digits) >= MIN_PHONE_DIGITS and len(digits) >= len(q) - 6:
		return criterion | C.mobile_no.regexp(_phone_regexp(digits))
	return criterion | C.mobile_no.like(like if not exact_ish else f"{q}%")


@frappe.whitelist()
def search(q: str = "", limit: int = 20) -> list[dict[str, Any]]:
	"""Search customers by client number, phone (digits only, 4+), email or name.

	A client may shop in any store, so staff keep searching the whole chain — but v0.7 S6 makes
	that a *lookup*: store users need 3 characters, get prefix (not substring) matching, at most
	:data:`SCOPED_SEARCH_LIMIT` rows, and every cross-store hit is written to the security log.
	With no query at all they see their own store's clients, not the chain's most recent.
	"""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	scoped = is_store_scoped()
	limit = min(max(cint(limit) or 20, 1), SCOPED_SEARCH_LIMIT if scoped else 100)
	q = (q or "").strip()
	if q.upper().startswith(CUSTOMER_QR_PREFIX):
		q = q[len(CUSTOMER_QR_PREFIX) :].strip()
	if q and len(q) < (SCOPED_SEARCH_MIN_CHARS if scoped else 2):
		return []
	boutique = get_user_boutique() if scoped else None
	if not q:
		# the default list is "my store's clients", never the whole chain's newest rows
		criterion = store_customer_criterion(boutique) if scoped else None
		if scoped and not boutique:
			return []
		return _serialize(_customer_rows(criterion, limit))
	rows = _customer_rows(_search_criterion(q, exact_ish=scoped), limit)
	if scoped:
		_audit_lookup("customers.search", q, rows, boutique)
	return _serialize(rows)


def _audit_lookup(event: str, needle: str, rows: list[dict[str, Any]], boutique: Optional[str]) -> None:
	"""Record a store user reading client records — how many, and how many from other stores."""
	from maison_pos.audit import log
	from maison_pos.scoping import customer_is_known_to_store

	if not rows:
		return
	foreign = [r["name"] for r in rows if not customer_is_known_to_store(r["name"])]
	log(
		event,
		boutique=boutique,
		query=(needle or "")[:64],
		results=len(rows),
		other_store_results=len(foreign) or None,
		customers=foreign[:10] or None,
	)


@frappe.whitelist()
def lookup(code: str) -> Optional[dict[str, Any]]:
	"""Exact-match lookup for a scanned / typed code.

	Accepts a client number (``MC123456``), a client QR payload (``MC:<customer_id>`` or
	``MC:MC123456``), a full phone number (formatting ignored) or an email. Returns the same
	row shape as ``search`` or ``None`` when nothing matches exactly.
	"""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
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
	# v0.8 QA C1 — a bare six-digit client number (digits-only keypads) resolves like `MC######`
	client_number = coerce_client_number(code)
	if not name and client_number:
		name = frappe.db.get_value("Customer", {"maison_client_number": client_number, "disabled": 0}, "name")
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
	if row and is_store_scoped():
		_audit_lookup("customers.lookup", code, [row], get_user_boutique())
	return _serialize([row])[0] if row else None


@frappe.whitelist()
def get(customer: str) -> dict[str, Any]:
	"""Single customer with loyalty + last visit."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	row = frappe.db.get_value("Customer", customer, CUSTOMER_FIELDS, as_dict=True)
	if not row:
		frappe.throw(_("Customer {0} not found").format(customer), frappe.DoesNotExistError)
	if is_store_scoped():
		_audit_lookup("customers.get", customer, [row], get_user_boutique())
	return _serialize([row])[0]


@frappe.whitelist()
def upsert(customer: Any) -> dict[str, str]:
	"""Create or update a Customer. Input: ``{name?, customer_name, mobile_no?, email_id?, ...}``.

	Without ``name`` we match an existing customer by mobile or email to avoid duplicates.
	"""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
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

	# v0.7 — a key that was not sent must not blank the stored value ("" still clears it)
	values = {k: v for k, v in data.items() if k in UPSERT_ALLOWED and v is not None}
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
				"customer_group": _default_customer_group(),
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


def _default_customer_group() -> Optional[str]:
	"""Selling Settings default unless it is a *group* node (e.g. "All Customer Groups", which
	ERPNext rejects on a Customer); prefer "Individual", else the first leaf group."""
	configured = frappe.db.get_single_value("Selling Settings", "customer_group")
	if configured and not frappe.db.get_value("Customer Group", configured, "is_group"):
		return configured
	if frappe.db.exists("Customer Group", {"name": "Individual", "is_group": 0}):
		return "Individual"
	return _default("Customer Group")


@frappe.whitelist()
def history(customer: str, limit: int = 20) -> list[dict[str, Any]]:
	"""Submitted POS invoices for *customer*, newest first. Scoped users see only their boutique."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
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
