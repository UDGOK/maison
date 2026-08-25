"""v1.1.1 — every ``AWANZ *`` role carries the doctype access the app needs on its own.

The live report was a regional manager opening the store **Receive** screen and getting, in red,
*"User regional.tx@… does not have doctype access via role permission for document Item"*. The
missing row was real, but the **pattern** is the bug: no AWANZ role held ``read`` on Item, and the
app only worked because of the ERPNext role the seed happens to attach beside it — ``Sales User``
for an associate, ``Stock User`` for a store manager, both of which read Item. A regional is seeded
with ``Sales Manager``, which does not, and so is any user a client makes by hand.

What these tests pin down:

* every AWANZ role reads Item **through its own role**, with no ERPNext stock or selling role
  attached (:class:`TestRoleOnlyUsersCanRunTheStoreScreens`);
* the grant is ``read`` and nothing else — no write on the catalogue, no write/create/submit on any
  ERPNext stock document, and the negotiated vendor costs stay shut
  (:class:`TestTheGrantIsReadOnly`);
* row-level scoping is exactly where it was. Opening a *doctype* for a role must not open another
  region's *documents*: a regional fenced to one region by User Permissions still cannot read the
  other region's requests, shipments, sales or store record
  (:class:`TestRegionScopingSurvivesTheGrant`).

The same ground is covered over the wire in ``test_v1_1_role_permissions_http``; this file runs
whether or not the bench is being served.
"""

from __future__ import annotations

import os

import frappe
import frappe.client
from frappe.tests.utils import FrappeTestCase

from maison_pos import scoping
from maison_pos.api import inventory
from maison_pos.api import shipping as shipping_api
from maison_pos.setup import install
from maison_pos.tests.helpers import ensure_demo_data

PATCH = "maison_pos.patches.v1_1.awanz_role_item_access"
ITEM = "AC-012"
#: Two regions, one store each. The live shape is a Texas regional over the Houston stores and an
#: Oklahoma regional over the Tulsa ones; the suite's demo world has these two, and the mechanism
#: under test (a User Permission fencing a regional to their region) is identical.
REGION_A_STORE, REGION_B_STORE = "NYC-5AV", "CHI-OAK"

#: ERPNext roles that read Item. A user in these tests must hold **none** of them, or the test
#: would pass on the borrowed permission that this whole change is about removing the need for.
ITEM_READING_ERPNEXT_ROLES = ("Stock User", "Stock Manager", "Sales User", "Purchase User", "Item Manager", "Accounts User", "Maintenance User", "Manufacturing User")


def role_only_user(email: str, awanz_role: str, boutique: str | None = None) -> str:
	"""A System User holding exactly one ``AWANZ *`` role — the hand-made user of a real deployment.

	Created inside the caller's test transaction and rolled back with it. The role list is set
	*after* the ``AWANZ Associate`` row, because that doctype syncs the Frappe role itself and
	would otherwise be the thing granting access rather than the table under test.
	"""
	if not frappe.db.exists("User", email):
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": email,
				"first_name": "V11",
				"last_name": awanz_role.replace("AWANZ ", ""),
				"send_welcome_email": 0,
				"enabled": 1,
				"new_password": "maison123",
				"user_type": "System User",
			}
		)
		user.flags.ignore_permissions = True
		user.flags.no_welcome_mail = True
		user.flags.ignore_password_policy = True
		user.insert()
	if boutique is not None and not frappe.db.exists("AWANZ Associate", email):
		assoc = frappe.get_doc(
			{
				"doctype": "AWANZ Associate",
				"user": email,
				"boutique": boutique,
				"role": {"AWANZ Manager": "Manager", "AWANZ Associate": "Associate", "AWANZ Regional": "Regional", "AWANZ Head Office": "HeadOffice"}[awanz_role],
				"enabled": 1,
				"pin": "9137",
			}
		)
		assoc.flags.ignore_permissions = True
		assoc.insert()
	user = frappe.get_doc("User", email)
	user.set("roles", [])
	user.append("roles", {"role": awanz_role})
	user.flags.ignore_permissions = True
	user.save()
	frappe.clear_cache(user=email)
	return email


def fence_to_region(email: str, boutique: str) -> None:
	"""Fence *email* to one region with a User Permission — how a real deployment scopes a regional.

	``AWANZ Regional`` is unrestricted in :mod:`maison_pos.scoping` by design (it is a chain role);
	what keeps a Texas regional out of Oklahoma is Frappe's own row-level layer on the
	``AWANZ Store`` link every store document carries.
	"""
	if not frappe.db.exists("User Permission", {"user": email, "allow": "AWANZ Store", "for_value": boutique}):
		perm = frappe.get_doc(
			{"doctype": "User Permission", "user": email, "allow": "AWANZ Store", "for_value": boutique, "apply_to_all_doctypes": 1}
		)
		perm.flags.ignore_permissions = True
		perm.insert()
	frappe.clear_cache(user=email)


class RoleAccessCase(FrappeTestCase):
	"""Base: the demo world, and the Item grants applied exactly as ``bench migrate`` applies them."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		# `super().setUpClass()` has just flushed, so nothing else is pending: applying the grants
		# here commits only the permission rows, which are the state every site is meant to be in.
		install.create_role_permissions({key: value for key, value in install.ROLE_DOCPERMS.items() if key[0] == "Item"})
		frappe.clear_cache()
		frappe.db.commit()
		ensure_demo_data()

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()


# ---------------------------------------------------------------------------------------------
class TestTheTable(RoleAccessCase):
	"""The table itself, and the patch that carries it to a site that is already live."""

	def test_every_awanz_role_carries_read_on_item(self):
		for role in install.ROLES:
			self.assertEqual(
				install.ROLE_DOCPERMS.get(("Item", role)),
				("read",),
				f"{role} must carry read on Item on its own, and only read",
			)

	def test_the_docperm_rows_on_the_site_are_read_only(self):
		for role in install.ROLES:
			row = frappe.db.get_value(
				"Custom DocPerm",
				{"parent": "Item", "role": role, "permlevel": 0},
				["read", "write", "create", "delete", "submit", "cancel", "amend"],
				as_dict=True,
			)
			self.assertTrue(row, f"no Custom DocPerm row for Item / {role}")
			self.assertEqual(row.read, 1, f"{role} cannot read Item")
			for ptype in ("write", "create", "delete", "submit", "cancel", "amend"):
				self.assertFalse(row[ptype], f"{role} must not have {ptype} on Item")

	def test_applying_the_grants_again_changes_nothing(self):
		item_rows = {key: value for key, value in install.ROLE_DOCPERMS.items() if key[0] == "Item"}
		before = frappe.db.count("Custom DocPerm", {"parent": "Item"})
		self.assertEqual(install.create_role_permissions(item_rows), [])
		self.assertEqual(frappe.db.count("Custom DocPerm", {"parent": "Item"}), before)

	def test_the_patch_is_registered_so_a_live_site_picks_it_up(self):
		path = os.path.join(frappe.get_app_path("maison_pos"), "patches.txt")
		with open(path, encoding="utf-8") as handle:
			registered = [line.strip() for line in handle if line.strip() and not line.startswith(("#", "["))]
		self.assertIn(PATCH, registered)

	def test_the_patch_names_the_users_it_unblocks(self):
		from maison_pos.patches.v1_1 import awanz_role_item_access as patch

		user = role_only_user("v11.report@awanz.test", "AWANZ Regional")
		self.assertIn(user, patch.report_users_that_were_broken())
		# a user who also holds an ERPNext stock role was never blocked, so it is not reported
		holder = frappe.get_doc("User", user)
		holder.append("roles", {"role": "Stock User"})
		holder.flags.ignore_permissions = True
		holder.save()
		frappe.clear_cache(user=user)
		self.assertNotIn(user, patch.report_users_that_were_broken())


# ---------------------------------------------------------------------------------------------
class TestRoleOnlyUsersCanRunTheStoreScreens(RoleAccessCase):
	"""The regression: an AWANZ role has to work with **no** ERPNext stock or selling role beside it."""

	def test_a_role_only_user_holds_none_of_the_roles_the_app_used_to_borrow_from(self):
		user = role_only_user("v11.regional@awanz.test", "AWANZ Regional")
		held = set(frappe.get_roles(user))
		self.assertEqual(held & set(ITEM_READING_ERPNEXT_ROLES), set(), "the fixture must not lend the permission under test")
		self.assertIn("AWANZ Regional", held)

	def test_every_awanz_role_reads_item_without_an_erpnext_stock_role(self):
		for awanz_role, boutique in (
			("AWANZ Regional", None),
			("AWANZ Head Office", None),
			("AWANZ Manager", REGION_A_STORE),
			("AWANZ Associate", REGION_A_STORE),
		):
			slug = awanz_role.lower().replace(" ", ".")
			user = role_only_user(f"v11.{slug}@awanz.test", awanz_role, boutique)
			self.assertTrue(frappe.has_permission("Item", "read", user=user), f"{awanz_role} cannot read Item")

	def test_a_regional_can_run_the_receive_screen_and_ask_for_stock(self):
		"""``inbound`` / ``replenishment_requests`` / ``replenish`` — the three the screen makes."""
		user = role_only_user("v11.receive@awanz.test", "AWANZ Regional")
		frappe.set_user(user)
		inbound = inventory.inbound(boutique=REGION_A_STORE)
		self.assertEqual(inbound["boutique"], REGION_A_STORE)
		self.assertIn("purchase_orders", inbound)
		self.assertEqual(inventory.replenishment_requests(boutique=REGION_A_STORE)["scope"], "all")
		out = inventory.replenish(boutique=REGION_A_STORE, lines=[{"item_code": ITEM, "qty": 2}], reason="v1.1.1 regression")
		self.assertTrue(out["name"])
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", out["name"], "boutique"), REGION_A_STORE)
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", out["name"], "requested_by"), user)
		self.assertTrue(out["material_request"], "the draft Material Request is what needed Item read")

	def test_a_store_manager_can_ask_for_stock_without_stock_user(self):
		"""Same wall, one rank down: the seed's ``Stock User`` was carrying this, not the AWANZ role."""
		user = role_only_user("v11.mgr.ask@awanz.test", "AWANZ Manager", REGION_A_STORE)
		frappe.set_user(user)
		out = inventory.replenish(boutique=REGION_A_STORE, lines=[{"item_code": ITEM, "qty": 1}], reason="v1.1.1 regression")
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", out["name"], "boutique"), REGION_A_STORE)

	def test_a_regional_can_raise_a_transfer_request(self):
		"""``request_transfer`` writes a Material Request too, and hit the very same wall."""
		user = role_only_user("v11.transfer@awanz.test", "AWANZ Regional")
		frappe.set_user(user)
		out = inventory.request_transfer(item=ITEM, to=REGION_A_STORE, qty=1)
		self.assertTrue(out.get("material_request"))


# ---------------------------------------------------------------------------------------------
class TestTheGrantIsReadOnly(RoleAccessCase):
	"""Widening is the failure mode: prove the new row buys nothing but reading the catalogue."""

	def setUp(self):
		super().setUp()
		self.regional = role_only_user("v11.readonly@awanz.test", "AWANZ Regional")

	def test_a_regional_cannot_write_the_catalogue(self):
		for ptype in ("write", "create", "delete", "submit"):
			self.assertFalse(frappe.has_permission("Item", ptype, user=self.regional), f"Item {ptype} must stay closed")

	def test_a_regional_cannot_write_or_submit_erpnext_stock_documents(self):
		for doctype in ("Stock Entry", "Material Request", "Purchase Receipt", "Purchase Order", "Stock Reconciliation", "Delivery Note"):
			for ptype in ("write", "create", "submit", "cancel", "delete"):
				self.assertFalse(
					frappe.has_permission(doctype, ptype, user=self.regional),
					f"a regional must not be able to {ptype} a {doctype}",
				)

	def test_a_regional_posting_a_stock_entry_by_hand_is_refused(self):
		frappe.set_user(self.regional)
		warehouse = frappe.db.get_value("AWANZ Store", REGION_A_STORE, ["warehouse", "company"], as_dict=True)
		entry = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"purpose": "Material Receipt",
				"company": warehouse.company,
				"to_warehouse": warehouse.warehouse,
				"items": [{"item_code": ITEM, "qty": 1, "t_warehouse": warehouse.warehouse, "basic_rate": 1, "allow_zero_valuation_rate": 1}],
			}
		)
		with self.assertRaises(frappe.PermissionError):
			entry.insert()

	def test_a_regional_editing_an_item_by_hand_is_refused(self):
		frappe.set_user(self.regional)
		item = frappe.get_doc("Item", ITEM)
		item.item_name = "tampered"
		with self.assertRaises(frappe.PermissionError):
			item.save()

	def test_item_read_does_not_open_the_negotiated_vendor_costs(self):
		"""v1.0 anticipated this: the costs are closed by a query condition, not by Item's DocPerm.

		``AWANZ Item Vendor`` is a child table *of Item*, so it becomes listable through
		``frappe.client.get_list(parent="Item")`` the moment Item is readable — which is exactly
		why ``scoping.item_vendor_query`` exists.
		"""
		frappe.set_user(self.regional)
		self.assertEqual(scoping.item_vendor_query(self.regional), "1=0")
		self.assertEqual(scoping.purchase_suggestion_query(self.regional), "1=0")
		# the REST surface v1.0 was defending: a child table is listable through the parent
		self.assertEqual(
			frappe.client.get_list(doctype="AWANZ Item Vendor", parent="Item", fields=["name"], limit_page_length=0), []
		)
		# buying prices are a separate doctype and no AWANZ role is granted it
		self.assertFalse(frappe.has_permission("Item Price", "read", user=self.regional))

	def test_an_associate_gained_nothing_but_the_read_they_already_had_through_sales_user(self):
		associate = role_only_user("v11.assoc.narrow@awanz.test", "AWANZ Associate", REGION_A_STORE)
		self.assertTrue(frappe.has_permission("Item", "read", user=associate))
		for ptype in ("write", "create", "delete"):
			self.assertFalse(frappe.has_permission("Item", ptype, user=associate))
		for doctype in ("Stock Entry", "Purchase Order", "Purchase Receipt", "Item Price", "Supplier", "AWANZ Purchase Suggestion"):
			self.assertFalse(frappe.has_permission(doctype, "write", user=associate), f"an associate must not write {doctype}")


# ---------------------------------------------------------------------------------------------
class TestRegionScopingSurvivesTheGrant(RoleAccessCase):
	"""Opening a doctype for a role must not open another region's documents."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		cls.request_a = shipping_api.create_request(REGION_A_STORE, [{"item_code": ITEM, "qty": 1}], reason="v1.1.1 region A").name
		cls.request_b = shipping_api.create_request(REGION_B_STORE, [{"item_code": ITEM, "qty": 1}], reason="v1.1.1 region B").name

	def setUp(self):
		super().setUp()
		self.regional_a = role_only_user("v11.region.a@awanz.test", "AWANZ Regional")
		fence_to_region(self.regional_a, REGION_A_STORE)

	def test_the_fenced_regional_reads_their_own_region(self):
		frappe.set_user(self.regional_a)
		self.assertTrue(frappe.has_permission("Item", "read"))
		self.assertIn(self.request_a, frappe.get_list("AWANZ Replenishment Request", pluck="name", limit_page_length=0))
		self.assertTrue(frappe.has_permission("AWANZ Store", "read", doc=REGION_A_STORE))

	def test_the_fenced_regional_cannot_read_the_other_regions_documents(self):
		frappe.set_user(self.regional_a)
		listed = frappe.get_list("AWANZ Replenishment Request", pluck="name", limit_page_length=0)
		self.assertNotIn(self.request_b, listed, "the other region's request must not be listable")
		self.assertFalse(
			frappe.has_permission("AWANZ Replenishment Request", "read", doc=frappe.get_doc("AWANZ Replenishment Request", self.request_b))
		)
		self.assertFalse(frappe.has_permission("AWANZ Store", "read", doc=REGION_B_STORE))

	def test_reading_the_catalogue_is_chain_wide_and_that_is_the_point(self):
		"""Item carries no store, so the grant has no region to leak — say so out loud."""
		frappe.set_user(self.regional_a)
		self.assertTrue(frappe.get_list("Item", pluck="name", limit_page_length=5))
		self.assertFalse(frappe.get_meta("Item").has_field("boutique"))

	def test_the_scoping_contract_is_unchanged(self):
		self.assertTrue(scoping.is_unrestricted(self.regional_a))
		self.assertFalse(scoping.is_store_scoped(self.regional_a))
		# the row-level fence is Frappe's User Permission layer, not something this change touched
		self.assertTrue(frappe.db.exists("User Permission", {"user": self.regional_a, "allow": "AWANZ Store", "for_value": REGION_A_STORE}))
