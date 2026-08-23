"""v0.6 cloud-run defects D3 / D4 / D5 + the time-zone repair.

In-process cover for the fixes whose HTTP behaviour is proven in ``test_v0_6_scoping_http``:

* **D3** — a return credit note carries its store *and* its warehouse, and the
  ``permission_query_conditions`` narrow ``Sales Invoice`` for a store manager.
* **D4** — no dashboard / report aggregation counts the head-office warehouse row as a store.
* **D5** — the walk-in placeholder never becomes a rewards member, and
  ``maison_pos.setup.repair.reset_walk_in_loyalty`` cleans up a site where it already did.
* time zone — ``maison_pos.setup.repair.set_site_timezone`` moves a seeded site and proves that
  nothing is left dated in the future.
"""

from __future__ import annotations

import datetime

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, now_datetime

from maison_pos import scoping
from maison_pos.api import customers as customers_api
from maison_pos.api import dashboard as dashboard_api
from maison_pos.api import returns as returns_api
from maison_pos.api import rewards as rewards_api
from maison_pos.api import sales as sales_api
from maison_pos.setup import demo, repair
from maison_pos.tests.helpers import ensure_demo_data, ensure_stock, pos_invoice

NYC, CHI = "NYC-5AV", "CHI-OAK"
NYC_MANAGER = "nyc.5av.manager@maison.example"
ITEM = "AC-012"


def _sell(boutique: str = NYC, customer: str | None = None):
	ensure_stock(ITEM, boutique, 4)
	res = sales_api.submit_batch([pos_invoice(boutique=boutique, items=[{"item_code": ITEM, "qty": 1, "rate": 160}], customer=customer)])["results"][0]
	assert res["status"] == "ok", res
	return frappe.get_doc("Sales Invoice", res["invoice_name"])


def _return(invoice: str) -> str:
	return returns_api.return_items(
		invoice,
		[{"item_code": ITEM, "qty": 1, "reason": "Change of mind", "condition": "Sellable"}],
		refund_method="cash",
		reason="Change of mind",
	)["credit_note"]


class TestD3ReturnStoreStamp(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v06_d3")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="v06_d3")

	def test_credit_note_carries_store_and_warehouse(self):
		si = _sell(NYC)
		cn = frappe.get_doc("Sales Invoice", _return(si.name))
		warehouse = frappe.db.get_value("Maison Boutique", NYC, "warehouse")
		self.assertEqual(cn.is_return, 1)
		self.assertEqual(cn.maison_boutique, NYC, "the credit note lost its store")
		self.assertEqual(cn.set_warehouse, warehouse, "the credit note has no warehouse — the User Permission would miss it")

	def test_voided_invoice_credit_note_is_stamped_too(self):
		si = _sell(NYC)
		cn = frappe.get_doc("Sales Invoice", sales_api.void(si.name, "test void")["credit_note"])
		self.assertEqual(cn.maison_boutique, NYC)
		self.assertEqual(cn.set_warehouse, frappe.db.get_value("Maison Boutique", NYC, "warehouse"))

	def test_query_condition_narrows_sales_invoice_to_the_managers_store(self):
		other = _sell(CHI)
		other_cn = _return(other.name)
		mine = _sell(NYC)
		frappe.set_user(NYC_MANAGER)
		self.assertTrue(scoping.is_store_scoped())
		cond = scoping.sales_invoice_query()
		self.assertIn(NYC, cond)
		# `frappe.get_all` deliberately ignores permissions; `get_list` is the one the REST layer uses
		names = [r["name"] for r in frappe.get_list("Sales Invoice", filters={"is_return": 1}, fields=["name"], limit_page_length=0)]
		self.assertNotIn(other_cn, names)
		mine_names = [r["name"] for r in frappe.get_list("Sales Invoice", filters={"is_return": 0}, fields=["name"], limit_page_length=0)]
		self.assertIn(mine.name, mine_names)
		self.assertFalse(scoping.sales_invoice_has_permission(frappe.get_doc("Sales Invoice", other_cn)))
		self.assertTrue(scoping.sales_invoice_has_permission(frappe.get_doc("Sales Invoice", mine.name)))

	def test_head_office_and_unscoped_users_are_untouched(self):
		frappe.set_user("hq@maison.example")
		self.assertFalse(scoping.is_store_scoped())
		self.assertEqual(scoping.sales_invoice_query(), "")
		self.assertEqual(scoping.delivery_note_query(), "")
		frappe.set_user("Administrator")
		self.assertEqual(scoping.sales_invoice_query(), "")

	def test_backfill_patch_restores_a_stripped_stamp(self):
		from maison_pos.patches.v0_6 import backfill_return_store_stamp

		si = _sell(NYC)
		cn = _return(si.name)
		frappe.db.set_value("Sales Invoice", cn, {"maison_boutique": None, "set_warehouse": None}, update_modified=False)
		backfill_return_store_stamp.execute()
		row = frappe.db.get_value("Sales Invoice", cn, ["maison_boutique", "set_warehouse"], as_dict=True)
		self.assertEqual(row.maison_boutique, NYC)
		self.assertEqual(row.set_warehouse, frappe.db.get_value("Maison Boutique", NYC, "warehouse"))


class TestD4WarehouseIsNotAStore(FrappeTestCase):
	WH = "TST-WH"

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v06_d4")
		if not frappe.db.exists("Maison Boutique", self.WH):
			doc = frappe.get_doc(
				{
					"doctype": "Maison Boutique",
					"boutique_code": self.WH,
					"boutique_name": "Test Warehouse",
					"enabled": 1,
					"company": demo.COMPANY,
					"warehouse": frappe.db.get_value("Maison Boutique", NYC, "warehouse"),
					"cost_center": frappe.db.get_value("Maison Boutique", NYC, "cost_center"),
					"pos_profile": frappe.db.get_value("Maison Boutique", NYC, "pos_profile"),
					"city": "Houston",
				}
			)
			if doc.meta.has_field("is_warehouse"):
				doc.is_warehouse = 1
			if doc.meta.has_field("boutique_type"):
				doc.boutique_type = "Warehouse"
			doc.flags.ignore_permissions = True
			doc.insert()

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="v06_d4")

	def test_warehouse_row_is_excluded_from_the_retail_list(self):
		self.assertIn(self.WH, scoping.get_allowed_boutiques())
		self.assertIn(self.WH, scoping.warehouse_boutiques())
		self.assertNotIn(self.WH, scoping.get_retail_boutiques())
		# every real store survives
		self.assertIn(NYC, scoping.get_retail_boutiques())

	def test_live_summary_has_no_warehouse_card(self):
		frappe.cache.delete_keys(dashboard_api.LIVE_CACHE_PREFIX)
		out = dashboard_api.live_summary(nocache=1)
		codes = [b["boutique"] for b in out["by_boutique"]]
		self.assertNotIn(self.WH, codes)
		self.assertIn(NYC, codes)

	def test_boutiques_table_and_top_products_have_no_warehouse_column(self):
		self.assertNotIn(self.WH, [r["boutique"] for r in dashboard_api.boutiques_table()["rows"]])
		self.assertNotIn(self.WH, dashboard_api.top_products(period="7d")["boutiques"])


class TestD5WalkInIsNotAMember(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v06_d5")
		self.walk_in = frappe.db.get_value("POS Profile", {"customer": ("is", "set")}, "customer")
		self.assertTrue(self.walk_in, "the demo POS Profiles have no default customer")
		self.program = frappe.db.get_value("Loyalty Program", {"auto_opt_in": 1}, "name")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="v06_d5")

	def test_is_walk_in_recognises_the_placeholder(self):
		self.assertTrue(rewards_api.is_walk_in(self.walk_in))
		self.assertTrue(rewards_api.is_walk_in(None))
		self.assertTrue(rewards_api.is_walk_in(None, customer_name="Walk-in Customer"))
		self.assertFalse(rewards_api.is_walk_in(None, customer_name="Amelia Rousseau"))

	def test_saving_the_walk_in_never_enrols_it(self):
		doc = frappe.get_doc("Customer", self.walk_in)
		doc.loyalty_program = self.program
		doc.maison_client_number = "MC999999"
		doc.flags.ignore_permissions = True
		doc.save()
		row = frappe.db.get_value("Customer", self.walk_in, ["loyalty_program", "maison_client_number"], as_dict=True)
		self.assertIsNone(row.loyalty_program)
		self.assertIsNone(row.maison_client_number)

	def test_an_anonymous_sale_accrues_no_points(self):
		frappe.db.set_value("Customer", self.walk_in, "loyalty_program", self.program, update_modified=False)
		si = _sell(NYC, customer=self.walk_in)
		self.assertFalse(frappe.db.exists("Loyalty Point Entry", {"invoice": si.name}), "the walk-in earned points")
		self.assertFalse(frappe.db.get_value("Sales Invoice", si.name, "loyalty_program"))
		self.assertEqual(rewards_api.tiers(customer=self.walk_in, boutique=NYC)["points"], 0)
		self.assertIsNone(rewards_api.tiers(customer=self.walk_in, boutique=NYC)["program"])
		self.assertEqual(rewards_api.receipt_extras(frappe.get_doc("Sales Invoice", si.name))["points_balance"], 0)

	def test_the_walk_in_cannot_redeem(self):
		frappe.db.set_value("Customer", self.walk_in, "loyalty_program", self.program, update_modified=False)
		tier = frappe.db.get_value("Maison Reward Tier", {"enabled": 1}, "name")
		if not tier:
			self.skipTest("no reward tiers on this site")
		si = frappe.get_doc({"doctype": "Sales Invoice", "customer": self.walk_in, "is_pos": 1})
		with self.assertRaises(rewards_api.RewardError):
			rewards_api.apply_to_invoice(si, {"reward_tier": tier})

	def test_the_walk_in_never_heads_the_client_list(self):
		names = [c["name"] for c in customers_api.search("", limit=100)]
		self.assertNotIn(self.walk_in, names)
		self.assertEqual(customers_api._loyalty(self.walk_in)[0], 0.0)

	def test_reset_walk_in_loyalty_repairs_an_existing_site(self):
		# simulate the seeded site: the placeholder is a member with a balance
		frappe.db.set_value("Customer", self.walk_in, {"loyalty_program": self.program, "maison_client_number": "MC990463"}, update_modified=False)
		si = _sell(NYC, customer=self.walk_in)
		frappe.db.set_value("Sales Invoice", si.name, "loyalty_program", self.program, update_modified=False)
		frappe.get_doc(
			{
				"doctype": "Loyalty Point Entry",
				"company": si.company,
				"loyalty_program": self.program,
				"customer": self.walk_in,
				"invoice_type": "Sales Invoice",
				"invoice": si.name,
				"loyalty_points": 61045,
				"purchase_amount": 61045,
				"posting_date": si.posting_date,
				"expiry_date": frappe.utils.add_days(si.posting_date, 365),
			}
		).insert(ignore_permissions=True)
		self.assertGreater(flt(rewards_api.points_balance(self.walk_in, self.program, si.company)), 0)

		out = repair.reset_walk_in_loyalty(commit=0)
		self.assertIn(self.walk_in, out["customers"])
		# the seeded site may already hold walk-in points from before the guard existed
		self.assertGreaterEqual(out["points_before"], 61045)
		self.assertGreaterEqual(out["entries_deleted"], 1)
		row = frappe.db.get_value("Customer", self.walk_in, ["loyalty_program", "maison_client_number"], as_dict=True)
		self.assertIsNone(row.loyalty_program)
		self.assertIsNone(row.maison_client_number)
		self.assertFalse(frappe.db.exists("Loyalty Point Entry", {"customer": self.walk_in}))
		self.assertFalse(frappe.db.get_value("Sales Invoice", si.name, "loyalty_program"))

		# idempotent: a second run finds nothing left to do
		again = repair.reset_walk_in_loyalty(commit=0)
		self.assertEqual(again["points_before"], 0)
		self.assertEqual(again["entries_deleted"], 0)
		self.assertEqual(again["programs_cleared"], 0)


class TestSiteTimezoneRepair(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")
		self.previous = frappe.db.get_single_value("System Settings", "time_zone")
		frappe.db.savepoint("v06_tz")

	def tearDown(self):
		frappe.db.rollback(save_point="v06_tz")
		frappe.db.set_single_value("System Settings", "time_zone", self.previous)
		frappe.clear_cache()
		frappe.set_user("Administrator")

	def test_unknown_timezone_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			repair.set_site_timezone("Mars/Olympus_Mons", commit=0)

	def test_moving_to_america_chicago_leaves_nothing_future_dated(self):
		# the symptom: a receipt posted "now" in a zone 11 h ahead lands in the future afterwards
		name = demo.demo_stock_entries()[0]
		later = now_datetime() + datetime.timedelta(hours=10)
		demo._redate_in_place(name, later.strftime("%Y-%m-%d"), later.strftime("%H:%M:%S"))
		self.assertTrue(repair._future_documents(now_datetime())["Stock Entry"])

		out = repair.set_site_timezone("America/Chicago", commit=0)
		self.assertEqual(out["time_zone"], "America/Chicago")
		self.assertEqual(frappe.db.get_single_value("System Settings", "time_zone"), "America/Chicago")
		self.assertEqual(out["future"], {}, f"still future-dated: {out['future']}")
		self.assertTrue(out["ok"])
		self.assertIsNotNone(out["rebase"])

		# and the till works again: a sale posts against the re-based stock
		si = _sell(NYC)
		self.assertEqual(si.docstatus, 1)

	def test_status_helper_reports_the_zone_and_a_clean_bill(self):
		repair.set_site_timezone("America/Chicago", commit=0)
		status = repair.site_timezone_status()
		self.assertEqual(status["time_zone"], "America/Chicago")
		self.assertEqual(status["future"]["Stock Entry"], 0)
