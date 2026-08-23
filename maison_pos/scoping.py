"""Boutique scoping helpers.

Rules (see SPEC "Store model"):

* ``System Manager``, ``Administrator``, ``Maison Head Office`` and ``Maison Regional``
  are unrestricted.
* ``Maison Manager`` / ``Maison Associate`` may only act on the boutique their
  ``Maison Associate`` record points to.
"""

from __future__ import annotations

from typing import Optional

import frappe
from frappe import _

UNRESTRICTED_ROLES = frozenset({"Administrator", "System Manager", "Maison Head Office", "Maison Regional"})
SCOPED_ROLES = frozenset({"Maison Manager", "Maison Associate"})
ALL_MAISON_ROLES = ("Maison Associate", "Maison Manager", "Maison Regional", "Maison Head Office")
APPROVER_ROLES = frozenset({"Administrator", "System Manager", "Maison Head Office", "Maison Regional"})


def _user(user: Optional[str] = None) -> str:
	return user or frappe.session.user


def is_unrestricted(user: Optional[str] = None) -> bool:
	"""Return True when *user* may act on any boutique."""
	user = _user(user)
	if user == "Administrator":
		return True
	return bool(UNRESTRICTED_ROLES & set(frappe.get_roles(user)))


def get_associate(user: Optional[str] = None) -> Optional[dict]:
	"""Return the enabled ``Maison Associate`` row for *user* (or ``None``)."""
	user = _user(user)
	rows = frappe.get_all(
		"Maison Associate",
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
		return frappe.get_all("Maison Boutique", filters={"enabled": 1}, pluck="name", order_by="name")
	boutique = get_user_boutique(user)
	return [boutique] if boutique else []


def _meta_has(doctype: str, fieldname: str) -> bool:
	try:
		return frappe.get_meta(doctype).has_field(fieldname)
	except Exception:  # pragma: no cover — doctype missing on an old site
		return False


def warehouse_boutiques() -> set[str]:
	"""Codes of the ``Maison Boutique`` rows that are warehouses, not shops.

	Mirrors ``maison_pos.api.rewards`` (the only place that got this right in v0.6): a row counts
	as a warehouse when ``is_warehouse = 1`` **or** ``boutique_type = "Warehouse"``. Both fields
	are v0.6 custom fields, so they are feature-detected for sites seeded before v0.6.
	"""
	names: set[str] = set()
	for field, value in (("is_warehouse", 1), ("boutique_type", "Warehouse")):
		if _meta_has("Maison Boutique", field):
			names.update(frappe.get_all("Maison Boutique", filters={field: value}, pluck="name"))
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
		if not frappe.db.exists("Maison Boutique", boutique):
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
	return bool(roles & (UNRESTRICTED_ROLES | {"Maison Manager"}))


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
	who holds no Maison store role at all (a portal shopper, an accountant, a plain Stock User):
	their access is whatever core Frappe permissions say. Only ``Maison Manager`` /
	``Maison Associate`` are pinned to ``Maison Associate.boutique``.
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
	return _boutique_condition("Maison Price Change Request", user)


def heartbeat_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Device Heartbeat", user)


def sync_log_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Sync Log", user)


def price_change_request_has_permission(doc, ptype: str = "read", user: Optional[str] = None) -> bool:
	if is_unrestricted(user):
		return True
	return bool(doc.get("boutique")) and doc.get("boutique") == get_user_boutique(user)


def biometric_consent_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Biometric Consent", user)


def recognition_event_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Recognition Event", user)


# v0.4 B/C/I
def client_interaction_query(user: Optional[str] = None) -> str:
	if is_unrestricted(user):
		return ""
	boutique = get_user_boutique(user)
	if not boutique:
		return "1=0"
	b = frappe.db.escape(boutique)
	return f"(`tabMaison Client Interaction`.`boutique` = {b} or `tabMaison Client Interaction`.`boutique` is null or `tabMaison Client Interaction`.`boutique` = '')"


def commission_entry_query(user: Optional[str] = None) -> str:
	if is_unrestricted(user):
		return ""
	if is_manager_or_above(user):
		return _boutique_condition("Maison Commission Entry", user)
	assoc = get_associate(user)
	return f"`tabMaison Commission Entry`.`associate` = {frappe.db.escape(assoc['name'])}" if assoc else "1=0"


def shift_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Shift", user)


def feedback_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Feedback", user)


def coupon_redemption_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Coupon Redemption", user)


# v0.4 D — inventory
def stock_alert_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Stock Alert", user)


def cycle_count_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Cycle Count", user)


# --- v0.4 H insights ---
def client_signal_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Client Signal", user)


def client_recommendation_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Client Recommendation", user)
# --- end v0.4 H ---


# --- v0.5 M campaigns ---
def campaign_attribution_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Campaign Attribution", user)
# --- end v0.5 M ---


# ---------------------------------------------------------------------------
# v0.5 K — Maison Salon Session
# ---------------------------------------------------------------------------
def salon_session_query(user: Optional[str] = None) -> str:
	"""Guests never list sessions (the token is the secret); scoped roles see their boutique."""
	user = _user(user)
	if user == "Guest":
		return "1=0"
	return _boutique_condition("Maison Salon Session", user)


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
WAREHOUSE_ADMIN_ROLE = "Maison Warehouse Admin"


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
	a user whose only Maison role is Warehouse Admin may not sell at all."""
	user = _user(user)
	boutique = assert_boutique_access(boutique, user)
	roles = set(frappe.get_roles(user))
	if user != "Administrator" and WAREHOUSE_ADMIN_ROLE in roles and not roles & (set(ALL_MAISON_ROLES) | {"System Manager"}):
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
	row = frappe.db.get_value("Maison Boutique", boutique, ["warehouse", "damaged_warehouse"], as_dict=True) or {}
	names = [w for w in (row.get("warehouse"), row.get("damaged_warehouse")) if w]
	try:
		transit = frappe.db.get_value("Maison Boutique", boutique, "transit_warehouse")
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
	return _supply_condition("Maison Replenishment Request", user)


def shipment_query(user: Optional[str] = None) -> str:
	return _supply_condition("Maison Shipment", user)


def receiving_discrepancy_query(user: Optional[str] = None) -> str:
	return _supply_condition("Maison Receiving Discrepancy", user)


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
	return _boutique_condition("Maison Age Check", user)


def giveaway_entry_query(user: Optional[str] = None) -> str:
	return _boutique_condition("Maison Giveaway Entry", user)
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
