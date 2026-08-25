"""v1.1.1 — give every ``AWANZ *`` role its own ``read`` on Item.

The live report: a regional manager opened the store **Receive** screen, asked the warehouse for
stock, and got in red across the top

    User regional.tx@… does not have doctype access via role permission for document Item

Not one missing row — a pattern. **No** AWANZ role carried ``read`` on Item. It never showed
because of what the seed happens to attach *next to* the AWANZ role: an associate also gets
ERPNext's ``Sales User`` and a store manager ``Stock User``, and both of those read Item, so the
app was quietly borrowing the permission. ``AWANZ Regional`` is seeded with ``Sales Manager``,
which does not — and so is every regional a client creates by hand.

ERPNext is what insists on the permission: ``erpnext.stock.get_item_details.get_item_details``
calls ``item.check_permission()`` while a Material Request validates, and no ``ignore_permissions``
flag on the *parent* document waves that through. So ``inventory.replenish`` and
``inventory.request_transfer`` — the two endpoints behind "ask the warehouse for stock", open to
all four roles — were broken for any user holding only an AWANZ role.

``bench migrate`` would in fact pick the new rows up through ``after_migrate`` →
``install.create_role_permissions``. This patch exists anyway so the change to a **live retail
site's permissions** is a named, ordered, reported step that runs before the rest of the migrate
and says out loud what it had to add, rather than a silent side effect of a table growing.

Read only, and nothing else moves:

* no ``write`` / ``create`` / ``submit`` anywhere — the catalogue is still writable only by
  ``AWANZ Warehouse Admin`` (``install_v10_purchasing``);
* row-level scoping is untouched. It comes from User Permissions and the
  ``permission_query_conditions`` in ``maison_pos.scoping``, neither of which this patch reads or
  writes, and Item carries no store dimension to widen in the first place;
* the negotiated vendor costs stay shut. ``AWANZ Item Vendor`` (a child table *of Item*, so it is
  listable through ``frappe.client.get_list`` once Item is readable) and
  ``AWANZ Purchase Suggestion`` are closed by ``scoping.item_vendor_query`` /
  ``scoping.purchase_suggestion_query`` regardless of how Item is permitted — which is exactly the
  case v1.0 anticipated when it wrote those conditions ("whatever DocPerms a site has grown").

Idempotent: re-running adds nothing and prints "already current".
"""

from __future__ import annotations

import frappe

#: the ERPNext roles the app has been leaning on for Item read
BORROWED_FROM = ("Stock User", "Stock Manager", "Sales User", "Purchase User", "Item Manager", "Accounts User", "Maintenance User", "Manufacturing User")


def execute() -> None:
	from maison_pos.setup.install import ROLE_DOCPERMS, create_role_permissions

	item_rows = {key: ptypes for key, ptypes in ROLE_DOCPERMS.items() if key[0] == "Item"}
	if not item_rows:  # pragma: no cover — the table is the source of truth for this patch
		return
	granted = create_role_permissions(item_rows)
	frappe.clear_cache()
	frappe.db.commit()
	if granted:
		print(f"maison_pos: v1.1.1 Item access — granted {', '.join(sorted(granted))}")
	else:
		print("maison_pos: v1.1.1 Item access — already current")
	report_users_that_were_broken()


def report_users_that_were_broken() -> list[str]:
	"""Name the users this actually unblocks: an AWANZ role and no ERPNext role that reads Item.

	Purely informational — an operator seeing their regional managers listed here has the
	confirmation that the red banner they were shown is the thing that just got fixed.
	"""
	from maison_pos.setup.install import ROLES

	# the four store-facing roles only: `AWANZ Warehouse Admin` has read on Item of its own since
	# v0.6 (`install_v06_shipping.ROLE_DOCPERMS`) and was never one of the seats this broke.
	awanz_roles = [role for role in ROLES if frappe.db.exists("Role", role)]
	if not awanz_roles:
		return []
	holders = set(frappe.get_all("Has Role", filters={"parenttype": "User", "role": ("in", awanz_roles)}, pluck="parent"))
	borrowed = set(
		frappe.get_all("Has Role", filters={"parenttype": "User", "role": ("in", list(BORROWED_FROM))}, pluck="parent")
	)
	unblocked = sorted(u for u in holders - borrowed if u and u not in ("Administrator", "Guest"))
	if unblocked:
		shown = ", ".join(unblocked[:8]) + (" …" if len(unblocked) > 8 else "")
		print(
			f"maison_pos: v1.1.1 Item access — {len(unblocked)} user(s) hold an AWANZ role and no "
			f"ERPNext role that reads Item, so they are the ones this grant carries: {shown}"
		)
	return unblocked
