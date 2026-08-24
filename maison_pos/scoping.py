"""Boutique scoping helpers.

Rules (see SPEC "Store model"):

* ``System Manager``, ``Administrator``, ``AWANZ Head Office`` and ``AWANZ Regional``
  are unrestricted.
* ``AWANZ Manager`` / ``AWANZ Associate`` may only act on the boutique their
  ``AWANZ Associate`` record points to.
"""

from __future__ import annotations

from typing import Optional

import frappe
from frappe import _

UNRESTRICTED_ROLES = frozenset({"Administrator", "System Manager", "AWANZ Head Office", "AWANZ Regional"})
SCOPED_ROLES = frozenset({"AWANZ Manager", "AWANZ Associate"})
ALL_AWANZ_ROLES = ("AWANZ Associate", "AWANZ Manager", "AWANZ Regional", "AWANZ Head Office")
APPROVER_ROLES = frozenset({"Administrator", "System Manager", "AWANZ Head Office", "AWANZ Regional"})

# --- v0.7 S1/S5 — the fields that decide *who someone is* on this chain ---------------------
#: changing any of these grants access: ``role`` drives the Frappe role sync, ``boutique`` moves
#: the user's whole data scope to another store, ``user`` re-points the record at somebody else.
PRIVILEGED_ASSOCIATE_FIELDS = ("user", "boutique", "role")
#: ``AWANZ Associate.role`` → seniority. A caller may never grant a rank above their own.
ASSOCIATE_ROLE_RANK = {"Associate": 1, "Manager": 2, "Regional": 3, "HeadOffice": 4}
#: Frappe role → the same seniority, for the ``_sync_user_role`` guard
FRAPPE_ROLE_RANK = {
	"AWANZ Associate": 1,
	"AWANZ Manager": 2,
	"AWANZ Regional": 3,
	"AWANZ Head Office": 4,
	"System Manager": 4,
	"Administrator": 4,
}


def _user(user: Optional[str] = None) -> str:
	return user or frappe.session.user


def is_unrestricted(user: Optional[str] = None) -> bool:
	"""Return True when *user* may act on any boutique."""
	user = _user(user)
	if user == "Administrator":
		return True
	return bool(UNRESTRICTED_ROLES & set(frappe.get_roles(user)))


def get_associate(user: Optional[str] = None) -> Optional[dict]:
	"""Return the enabled ``AWANZ Associate`` row for *user* (or ``None``)."""
	user = _user(user)
	rows = frappe.get_all(
		"AWANZ Associate",
		filters={"user": user, "enabled": 1},
		fields=["name", "user", "boutique", "role", "full_name"],
		limit=1,
	)
	return rows[0] if rows else None


def get_user_boutique(user: Optional[str] = None) -> Optional[str]:
	"""Boutique code the user is attached to, if any."""
	assoc = get_associate(user)
	return assoc["boutique"] if assoc else None


def get_allowed_boutiques(user: Optional[str] = None) -> list[str]:
	"""List of boutique codes the user can see (all enabled boutiques when unrestricted).

	This is the **access** list: it deliberately still contains the head-office warehouse row
	(``is_warehouse = 1``) because a Head Office user may act on it. Anything that presents a
	list of *shops* to a human — dashboard boards, store columns, reports — must use
	:func:`get_retail_boutiques` instead (v0.6 defect D4).
	"""
	if is_unrestricted(user):
		return frappe.get_all("AWANZ Store", filters={"enabled": 1}, pluck="name", order_by="name")
	boutique = get_user_boutique(user)
	return [boutique] if boutique else []


def _meta_has(doctype: str, fieldname: str) -> bool:
	try:
		return frappe.get_meta(doctype).has_field(fieldname)
	except Exception:  # pragma: no cover — doctype missing on an old site
		return False


def warehouse_boutiques() -> set[str]:
	"""Codes of the ``AWANZ Store`` rows that are warehouses, not shops.

	Mirrors ``maison_pos.api.rewards`` (the only place that got this right in v0.6): a row counts
	as a warehouse when ``is_warehouse = 1`` **or** ``boutique_type = "Warehouse"``. Both fields
	are v0.6 custom fields, so they are feature-detected for sites seeded before v0.6.
	"""
	names: set[str] = set()
	for field, value in (("is_warehouse", 1), ("boutique_type", "Warehouse")):
		if _meta_has("AWANZ Store", field):
			names.update(frappe.get_all("AWANZ Store", filters={field: value}, pluck="name"))
	return names


def get_retail_boutiques(user: Optional[str] = None) -> list[str]:
	"""Like :func:`get_allowed_boutiques`, minus the warehouse rows (v0.6 defect D4).

	Every retail aggregation — the Live board, the boutiques table, Top products by store, the
	period comparison, the trend/insight tables — lists shops, so ``HOU-WH`` must never appear
	as a twelfth store.
	"""
	warehouses = warehouse_boutiques()
	return [b for b in get_allowed_boutiques(user) if b not in warehouses]


def assert_boutique_access(boutique: Optional[str], user: Optional[str] = None) -> str:
	"""Raise ``frappe.PermissionError`` unless *user* may act on *boutique*.

	Returns the resolved boutique code (falls back to the user's own boutique
	when *boutique* is empty and the user is scoped).
	"""
	user = _user(user)
	if user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)

	if is_unrestricted(user):
		if not boutique:
			frappe.throw(_("Boutique is required"), frappe.ValidationError)
		if not frappe.db.exists("AWANZ Store", boutique):
			frappe.throw(_("Boutique {0} does not exist").format(boutique), frappe.DoesNotExistError)
		return boutique

	own = get_user_boutique(user)
	if not own:
		frappe.throw(_("User {0} is not attached to any boutique").format(user), frappe.PermissionError)
	if boutique and boutique != own:
		frappe.throw(
			_("You are not permitted to act on boutique {0}").format(boutique),
			frappe.PermissionError,
		)
	return own


def assert_roles(*roles: str, user: Optional[str] = None) -> None:
	"""Raise unless the user holds at least one of *roles* (Administrator always passes)."""
	user = _user(user)
	if user == "Administrator":
		return
	if not set(roles) & set(frappe.get_roles(user)):
		frappe.throw(_("Insufficient role: requires one of {0}").format(", ".join(roles)), frappe.PermissionError)


def is_manager_or_above(user: Optional[str] = None) -> bool:
	user = _user(user)
	if user == "Administrator":
		return True
	roles = set(frappe.get_roles(user))
	return bool(roles & (UNRESTRICTED_ROLES | {"AWANZ Manager"}))


# ---------------------------------------------------------------------------
# permission_query_conditions / has_permission hooks
# ---------------------------------------------------------------------------
def _boutique_condition(doctype: str, user: Optional[str]) -> str:
	if is_unrestricted(user):
		return ""
	boutique = get_user_boutique(user)
	if not boutique:
		return "1=0"
	return f"`tab{doctype}`.`boutique` = {frappe.db.escape(boutique)}"


def is_store_scoped(user: Optional[str] = None) -> bool:
	"""True when *user* is a store user whose lists must be narrowed to their own store.

	Head Office / Regional / System Manager / Administrator are unrestricted, and so is anybody
	who holds no AWANZ store role at all (a portal shopper, an accountant, a plain Stock User):
	their access is whatever core Frappe permissions say. Only ``AWANZ Manager`` /
	``AWANZ Associate`` are pinned to ``AWANZ Associate.boutique``.
	"""
	if is_unrestricted(user):
		return False
	return bool(SCOPED_ROLES & set(frappe.get_roles(_user(user))))


def _own_boutique_condition(doctype: str, field: str, user: Optional[str], allow_blank: bool = True) -> str:
	"""``<doctype>.<field>`` must be the caller's own store (rows with no store stay visible).

	*allow_blank* keeps documents that carry no store stamp at all visible — those are not store
	data (head-office invoices, webshop orders not routed to a shop). Every row that **is**
	stamped is filtered, which is what closes the v0.6 D3 leak; the accompanying backfill patch
	(`maison_pos.patches.v0_6.backfill_return_store_stamp`) makes sure returns are stamped.
	"""
	if not is_store_scoped(user):
		return ""
	boutique = get_user_boutique(user)
	if not boutique:
		return "1=0"
	col = f"`tab{doctype}`.`{field}`"
	own = f"{col} = {frappe.db.escape(boutique)}"
	if not allow_blank:
		return own
	return f"({own} or {col} is null or {col} = '')"


def price_change_request_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Price Change Request", user)


def heartbeat_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Device Heartbeat", user)


def sync_log_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Sync Log", user)


def price_change_request_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	if is_unrestricted(user):
		return True
	return bool(doc.get("boutique")) and doc.get("boutique") == get_user_boutique(user)


def biometric_consent_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Biometric Consent", user)


def recognition_event_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Recognition Event", user)


# v0.4 B/C/I
def client_interaction_query(user: Optional[str] = None) -> str:
	if is_unrestricted(user):
		return ""
	boutique = get_user_boutique(user)
	if not boutique:
		return "1=0"
	b = frappe.db.escape(boutique)
	return f"(`tabAWANZ Client Interaction`.`boutique` = {b} or `tabAWANZ Client Interaction`.`boutique` is null or `tabAWANZ Client Interaction`.`boutique` = '')"


def commission_entry_query(user: Optional[str] = None) -> str:
	if is_unrestricted(user):
		return ""
	if is_manager_or_above(user):
		return _boutique_condition("AWANZ Commission Entry", user)
	assoc = get_associate(user)
	return f"`tabAWANZ Commission Entry`.`associate` = {frappe.db.escape(assoc['name'])}" if assoc else "1=0"


def shift_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Shift", user)


def feedback_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Feedback", user)


def coupon_redemption_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Coupon Redemption", user)


# v0.4 D — inventory
def stock_alert_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Stock Alert", user)


def cycle_count_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Cycle Count", user)


# --- v0.4 H insights ---
def client_signal_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Client Signal", user)


def client_recommendation_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Client Recommendation", user)
# --- end v0.4 H ---


# --- v0.5 M campaigns ---
def campaign_attribution_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Campaign Attribution", user)
# --- end v0.5 M ---


# ---------------------------------------------------------------------------
# v0.5 K — AWANZ Salon Session
# ---------------------------------------------------------------------------
def salon_session_query(user: Optional[str] = None) -> str:
	"""Guests never list sessions (the token is the secret); scoped roles see their boutique."""
	user = _user(user)
	if user == "Guest":
		return "1=0"
	return _boutique_condition("AWANZ Salon Session", user)


def salon_session_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	"""Guest: *read* on a specific document only (realtime ``doc_subscribe`` with the token)."""
	user = _user(user)
	if user == "Guest":
		return ptype == "read" and doc is not None and bool(getattr(doc, "name", None))
	if is_unrestricted(user):
		return True
	boutique = get_user_boutique(user)
	return bool(boutique) and getattr(doc, "boutique", None) == boutique


# ---------------------------------------------------------------------------
# v0.6 O/P — store-manager hardening + warehouse admin
# ---------------------------------------------------------------------------
WAREHOUSE_ADMIN_ROLE = "AWANZ Warehouse Admin"


def is_warehouse_admin(user: Optional[str] = None) -> bool:
	"""Head-office warehouse staff: sees every store's requests / shipments, never sells."""
	user = _user(user)
	if user == "Administrator":
		return True
	return WAREHOUSE_ADMIN_ROLE in frappe.get_roles(user)


def is_supply_unrestricted(user: Optional[str] = None) -> bool:
	return is_unrestricted(user) or is_warehouse_admin(user)


def assert_supply_admin(user: Optional[str] = None) -> None:
	"""Raise unless the user is a warehouse admin / Head Office / System Manager."""
	user = _user(user)
	if user == "Guest":
		frappe.throw(_("Authentication required"), frappe.AuthenticationError)
	if not is_supply_unrestricted(user):
		frappe.throw(_("Warehouse admin role required"), frappe.PermissionError)


def assert_can_sell(boutique: Optional[str], user: Optional[str] = None) -> str:
	"""Selling = store scoping **plus**: the boutique must be a store (not the warehouse row) and
	a user whose only AWANZ role is Warehouse Admin may not sell at all."""
	user = _user(user)
	boutique = assert_boutique_access(boutique, user)
	roles = set(frappe.get_roles(user))
	if user != "Administrator" and WAREHOUSE_ADMIN_ROLE in roles and not roles & (set(ALL_AWANZ_ROLES) | {"System Manager"}):
		frappe.throw(_("Warehouse admins cannot sell"), frappe.PermissionError)
	try:
		from maison_pos.shipping import is_warehouse_boutique

		if is_warehouse_boutique(boutique):
			frappe.throw(_("{0} is the warehouse, not a store").format(boutique), frappe.PermissionError)
	except ImportError:  # pragma: no cover
		pass
	return boutique


def _store_warehouses(user: Optional[str]) -> list[str]:
	boutique = get_user_boutique(user)
	if not boutique:
		return []
	row = frappe.db.get_value("AWANZ Store", boutique, ["warehouse", "damaged_warehouse"], as_dict=True) or {}
	names = [w for w in (row.get("warehouse"), row.get("damaged_warehouse")) if w]
	try:
		transit = frappe.db.get_value("AWANZ Store", boutique, "transit_warehouse")
		if transit:
			names.append(transit)
	except Exception:
		pass
	return names


def _supply_condition(doctype: str, user: Optional[str]) -> str:
	if is_supply_unrestricted(user):
		return ""
	return _boutique_condition(doctype, user)


def replenishment_request_query(user: Optional[str] = None) -> str:
	return _supply_condition("AWANZ Replenishment Request", user)


def shipment_query(user: Optional[str] = None) -> str:
	return _supply_condition("AWANZ Shipment", user)


def receiving_discrepancy_query(user: Optional[str] = None) -> str:
	return _supply_condition("AWANZ Receiving Discrepancy", user)


def _supply_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	if is_supply_unrestricted(user):
		return True
	boutique = get_user_boutique(user)
	return bool(boutique) and doc.get("boutique") == boutique


def replenishment_request_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _supply_has_permission(doc, ptype, user)


def shipment_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _supply_has_permission(doc, ptype, user)


def receiving_discrepancy_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _supply_has_permission(doc, ptype, user)


def _warehouse_field_condition(doctype: str, fields: tuple[str, ...], user: Optional[str]) -> str:
	"""Desk lists of stock documents: a store manager only sees rows touching their own warehouses."""
	if is_supply_unrestricted(user) or not is_store_scoped(user):
		return ""
	names = _store_warehouses(user)
	if not names:
		return "1=0"
	inlist = ", ".join(frappe.db.escape(n) for n in names)
	return "(" + " or ".join(f"`tab{doctype}`.`{f}` in ({inlist})" for f in fields) + ")"


def stock_entry_query(user: Optional[str] = None) -> str:
	return _warehouse_field_condition("Stock Entry", ("from_warehouse", "to_warehouse"), user)


def material_request_query(user: Optional[str] = None) -> str:
	return _warehouse_field_condition("Material Request", ("set_warehouse", "set_from_warehouse"), user)


def purchase_receipt_query(user: Optional[str] = None) -> str:
	return _warehouse_field_condition("Purchase Receipt", ("set_warehouse",), user)


def purchase_order_query(user: Optional[str] = None) -> str:
	return _warehouse_field_condition("Purchase Order", ("set_warehouse",), user)


def _stock_doc_has_permission(doc, fields: tuple[str, ...], user: Optional[str]) -> bool:
	if is_supply_unrestricted(user) or not is_store_scoped(user):
		return True
	names = set(_store_warehouses(user))
	if not names:
		return False
	if any(doc.get(f) in names for f in fields):
		return True
	# header fields empty → look at the rows
	for row in doc.get("items") or []:
		for f in ("warehouse", "s_warehouse", "t_warehouse", "from_warehouse"):
			if row.get(f) in names:
				return True
	return False


def stock_entry_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _stock_doc_has_permission(doc, ("from_warehouse", "to_warehouse"), user)


def material_request_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _stock_doc_has_permission(doc, ("set_warehouse", "set_from_warehouse"), user)


def purchase_receipt_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _stock_doc_has_permission(doc, ("set_warehouse",), user)


def purchase_order_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _stock_doc_has_permission(doc, ("set_warehouse",), user)
# --- end v0.6 O/P ---


# --- v0.6 N/Q — age checks / giveaway entries: managers + associates see their own store only ---
def age_check_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Age Check", user)


def giveaway_entry_query(user: Optional[str] = None) -> str:
	return _boutique_condition("AWANZ Giveaway Entry", user)
# --- end v0.6 N/Q ---


# ---------------------------------------------------------------------------
# v0.6 D3 — the generic REST surface (`frappe.client.get_list`, `/api/resource/...`)
#
# Store scoping for sales used to rely *only* on the per-user Warehouse User Permission, which
# matches a Sales Invoice through `set_warehouse`. Credit notes are created by
# `erpnext...make_sales_return`, which clears `set_warehouse` (a return may put lines back into
# more than one warehouse), so every store's **return** invoices were listable by any store
# manager. Two independent fixes: returns are now stamped (`maison_pos.events.sales_invoice`,
# `maison_pos.api.returns`, backfill patch v0_6.backfill_return_store_stamp) *and* the list
# query itself is narrowed here, which no longer depends on the stamp at all.
# ---------------------------------------------------------------------------
def sales_invoice_query(user: Optional[str] = None) -> str:
	"""A store user lists only their own store's invoices — sales *and* credit notes."""
	return _own_boutique_condition("Sales Invoice", "maison_boutique", user)


def sales_invoice_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	if not is_store_scoped(user):
		return True
	boutique = get_user_boutique(user)
	if not boutique:
		return False
	own = doc.get("maison_boutique")
	return not own or own == boutique


def sales_order_query(user: Optional[str] = None) -> str:
	"""Webshop / click-and-collect orders carry the same ``maison_boutique`` stamp."""
	return _own_boutique_condition("Sales Order", "maison_boutique", user)


def sales_order_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return sales_invoice_has_permission(doc, ptype, user)


def delivery_note_query(user: Optional[str] = None) -> str:
	"""Delivery Notes have no ``maison_boutique``; scope them by the store's own warehouses."""
	return _warehouse_field_condition("Delivery Note", ("set_warehouse",), user)


def delivery_note_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	return _stock_doc_has_permission(doc, ("set_warehouse",), user)
# --- end v0.6 D3 ---


# ---------------------------------------------------------------------------
# v0.7 S1 / S2 / S5 — AWANZ Associate is the credential store of this chain
#
# Before v0.7 every AWANZ role could list **every** associate of **every** store through the
# generic REST surface, PIN hashes included, and a store manager could ``set_value`` their own
# ``role`` to ``HeadOffice`` (the ``on_update`` role sync then granted the matching Frappe role
# with ``ignore_permissions``). Three independent fixes: the secret fields moved out of reach
# (permlevel 2 + ``Password`` fieldtype, see the doctype), the identity fields became permlevel 1,
# and the rows themselves are scoped to the caller's own store here.
# ---------------------------------------------------------------------------
def associate_query(user: Optional[str] = None) -> str:
	"""A store user only ever lists the associates of their own boutique."""
	if not is_store_scoped(user):
		return ""
	boutique = get_user_boutique(user)
	if not boutique:
		return "1=0"
	return f"`tabAWANZ Associate`.`boutique` = {frappe.db.escape(boutique)}"


def associate_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	"""Read: own store only. Write / create: own store, Associate level, never a privileged field.

	This runs from ``Document.check_permission`` **before** the framework resets permlevel fields,
	so the caller gets an honest ``403`` instead of a silent no-op — and it holds even if the
	permlevels are lost (a hand-edited Custom DocPerm, an older site that has not migrated).
	"""
	user = _user(user)
	if is_unrestricted(user):
		return True
	if not is_store_scoped(user):
		return True  # not a store role: core Frappe permissions decide
	own = get_user_boutique(user)
	if not own:
		return False
	get = doc.get if hasattr(doc, "get") else (lambda field: None)
	if get("boutique") != own:
		return False
	if ptype in ("read", "select", "report", "print", "email", "export", "share"):
		return True
	# a manager may hire, edit and disable their own shop floor — nothing above it
	if (get("role") or "Associate") != "Associate":
		return False
	name = get("name")
	if name and frappe.db.exists("AWANZ Associate", name):
		before = frappe.db.get_value("AWANZ Associate", name, list(PRIVILEGED_ASSOCIATE_FIELDS), as_dict=True) or {}
		for field in PRIVILEGED_ASSOCIATE_FIELDS:
			if (get(field) or None) != (before.get(field) or None):
				return False
	return True


def max_grantable_rank(user: Optional[str] = None) -> int:
	"""The highest ``AWANZ Associate.role`` rank *user* may hand out (0 = none at all)."""
	user = _user(user)
	if user == "Administrator":
		return max(ASSOCIATE_ROLE_RANK.values())
	roles = set(frappe.get_roles(user))
	return max((FRAPPE_ROLE_RANK.get(r, 0) for r in roles), default=0)
# --- end v0.7 S1/S2/S5 ---


# ---------------------------------------------------------------------------
# v0.7 S6 — the client book is chain-wide, the client *list* is not
#
# A client shops wherever they like, so ``customers.search`` / ``customers.lookup`` deliberately
# still match across the chain (exact-ish, capped and audited — see ``maison_pos.api.customers``).
# What is closed here is bulk enumeration: ``frappe.client.get_list("Customer")`` and
# ``/api/resource/Customer`` used to hand any associate the whole chain's names, phone numbers,
# e-mail addresses and client numbers in one call.
# ---------------------------------------------------------------------------
def _customer_store_link_conditions(boutique: str) -> list[str]:
	b = frappe.db.escape(boutique)
	conditions = [
		f"`tabCustomer`.`name` in (select `customer` from `tabSales Invoice` where `maison_boutique` = {b} and `customer` is not null)",
		f"`tabCustomer`.`owner` in (select `user` from `tabAWANZ Associate` where `boutique` = {b} and `user` is not null)",
	]
	if _meta_has("Sales Order", "maison_boutique"):
		conditions.append(
			f"`tabCustomer`.`name` in (select `customer` from `tabSales Order` where `maison_boutique` = {b} and `customer` is not null)"
		)
	if _meta_has("AWANZ Client Profile", "preferred_boutique"):
		conditions.append(
			f"`tabCustomer`.`name` in (select `name` from `tabAWANZ Client Profile` where `preferred_boutique` = {b})"
		)
	return conditions


def customer_query(user: Optional[str] = None) -> str:
	"""Store users list the clients of *their* store: served there, created there, or homed there."""
	if not is_store_scoped(user):
		return ""
	boutique = get_user_boutique(user)
	if not boutique:
		return "1=0"
	return "(" + " or ".join(_customer_store_link_conditions(boutique)) + ")"


def customer_is_known_to_store(customer: str, user: Optional[str] = None) -> bool:
	"""True when *customer* is one of the caller's own store's clients (unrestricted → always)."""
	if not is_store_scoped(user):
		return True
	boutique = get_user_boutique(user)
	if not boutique or not customer:
		return False
	conditions = " or ".join(_customer_store_link_conditions(boutique))
	row = frappe.db.sql(
		f"select 1 from `tabCustomer` where `tabCustomer`.`name` = %s and ({conditions}) limit 1",  # nosec B608 — codes are escaped above
		(customer,),
	)
	return bool(row)
# --- end v0.7 S6 ---
