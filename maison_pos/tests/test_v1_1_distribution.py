"""v1.1 "Onboarding a product" — §A distribution (Houston pushes stock out), §B ``create_product``
and §C the vendor catalogue.

The headline test is :meth:`TestDistributionRefusals.test_over_allocation_is_refused_and_nothing_is_written`:
a distribution that half-succeeds leaves phantom shipments the floor will pick and ship, so an
over-allocation must be refused with the shortfall named **and nothing written at all** — no
request, no shipment, no material request.

Everything else follows SPEC_v1.1 §E: a push is an ordinary shipment the store can receive,
``warehouse_push`` tells a push from a store's own pull for ever, a disabled store is refused,
the three split modes, and ``create_product`` builds item + vendor row + price list + reorder
atomically or leaves nothing behind.
"""

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import cint, flt

from maison_pos import distribution as dist_lib
from maison_pos.api import distribution, inventory, purchasing, shipping
from maison_pos.purchasing import main_warehouse
from maison_pos.purchasing import vendors as vendor_lib
from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v0_6_warehouse import WH_ADMIN, ensure_warehouse_admin, stock_main_warehouse
from maison_pos.tests.test_v1_0_purchasing import ensure_item, ensure_vendor

STORE = "NYC-5AV"
VENDOR = "AWANZ Test Distro A"


def _manager(boutique: str) -> str:
	return frappe.db.get_value("AWANZ Associate", {"boutique": boutique, "role": "Manager", "enabled": 1}, "user")


def _bin(item: str, warehouse: str) -> float:
	return flt(frappe.db.get_value("Bin", {"item_code": item, "warehouse": warehouse}, "actual_qty"))


class DistributionCase(FrappeTestCase):
	"""Same shape as the v1.0 suites: seed once, savepoint per test, roll back in teardown."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		ensure_warehouse_admin()

	def setUp(self):
		frappe.set_user("Administrator")
		self.sp = f"awanz_v11_{frappe.generate_hash(length=6)}"
		frappe.db.savepoint(self.sp)
		self.warehouse = main_warehouse()
		self.stores = [row["boutique"] for row in dist_lib.store_rows()]
		self.assertTrue(len(self.stores) >= 2, "the demo seed must offer at least two pushable stores")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point=self.sp)

	# ------------------------------------------------------------------ helpers
	def _stocked_item(self, code: str, qty: float = 60) -> str:
		item = ensure_item(code)
		stock_main_warehouse(item, qty, self.warehouse)
		return item

	def _push(self, item: str, per_store: float = 5, stores: list[str] | None = None, **kw):
		frappe.set_user(WH_ADMIN)
		lines = [{"boutique": b, "item_code": item, "qty": per_store} for b in (stores or self.stores)]
		return distribution.send(lines, **kw)


# ===========================================================================
# §A — the push itself
# ===========================================================================
class TestWarehousePush(DistributionCase):
	def test_a_push_creates_one_shipment_per_store_and_each_is_a_normal_shipment(self):
		"""Client decision 3: separate parcels, separate labels — never one batched shipment."""
		item = self._stocked_item("V11-PUSH-1", 60)
		out = self._push(item, per_store=5)

		self.assertEqual(out["stores"], len(self.stores))
		self.assertEqual(len(out["shipments"]), len(self.stores))
		self.assertEqual(len(out["requests"]), len(self.stores))
		self.assertEqual(out["units"], 5.0 * len(self.stores))
		self.assertEqual(sorted(s["boutique"] for s in out["shipments"]), sorted(self.stores))

		for shipment in out["shipments"]:
			# an ordinary shipment: Pending on the wall, from HOU-WH, through the in-transit bin
			self.assertEqual(shipment["status"], "Pending")
			self.assertEqual(shipment["from_warehouse"], self.warehouse)
			self.assertEqual(shipment["units"], 5.0)
			self.assertTrue(shipment["transit_warehouse"])
			self.assertTrue(shipment["warehouse_push"])
			doc = frappe.get_doc("AWANZ Shipment", shipment["name"])
			self.assertEqual([(line.item_code, flt(line.qty)) for line in doc.lines], [(item, 5.0)])
			# the request behind it is Approved with its Material Request submitted
			req = frappe.get_doc("AWANZ Replenishment Request", doc.replenishment_request)
			self.assertEqual(req.status, "Approved")
			self.assertEqual(req.approved_by, WH_ADMIN)
			self.assertEqual(frappe.db.get_value("Material Request", req.material_request, "docstatus"), 1)

	def test_the_store_receives_a_pushed_shipment_like_any_other(self):
		"""Pick → pack → ship → the store counts it in. Nothing about the flow knows it was a push."""
		item = self._stocked_item("V11-PUSH-2", 40)
		out = self._push(item, per_store=6, stores=[STORE])
		shipment = out["shipments"][0]["name"]
		store_warehouse = frappe.db.get_value("AWANZ Store", STORE, "warehouse")
		before_hou, before_store = _bin(item, self.warehouse), _bin(item, store_warehouse)

		frappe.set_user(WH_ADMIN)
		shipping.pick(shipment)
		shipping.pack(shipment)
		shipping.ship(shipment)
		self.assertEqual(frappe.db.get_value("AWANZ Shipment", shipment, "status"), "Shipped")
		self.assertEqual(_bin(item, self.warehouse), before_hou - 6)

		frappe.set_user(_manager(STORE))
		received = inventory.receive_shipment(shipment, lines=[{"item_code": item, "received_qty": 6}])
		self.assertEqual(received["status"], "Received")
		self.assertEqual(received["discrepancies"], [])
		self.assertEqual(_bin(item, store_warehouse), before_store + 6)
		# the store's Receive screen can still say who started it
		self.assertTrue(received["warehouse_push"])

	def test_warehouse_push_is_set_and_a_store_raised_request_is_unaffected(self):
		item = self._stocked_item("V11-PUSH-3", 40)
		pushed = self._push(item, per_store=4, stores=[STORE])["requests"][0]
		self.assertTrue(pushed["warehouse_push"])
		self.assertEqual(cint(frappe.db.get_value("AWANZ Replenishment Request", pushed["name"], "warehouse_push")), 1)
		self.assertEqual(pushed["requested_by"], WH_ADMIN)

		frappe.set_user(_manager(STORE))
		pulled = inventory.replenish(STORE, lines=[{"item_code": item, "qty": 3}])["request"]
		self.assertFalse(pulled["warehouse_push"])
		self.assertEqual(cint(frappe.db.get_value("AWANZ Replenishment Request", pulled["name"], "warehouse_push")), 0)
		self.assertEqual(pulled["status"], "Pending Approval")

		# and the two are told apart in the list every screen and report reads
		frappe.set_user(WH_ADMIN)
		rows = {r["name"]: r for r in shipping.requests_list(status="all", limit=500)["requests"]}
		self.assertTrue(rows[pushed["name"]]["warehouse_push"])
		self.assertFalse(rows[pulled["name"]]["warehouse_push"])

	def test_a_push_stamps_a_reason_that_says_houston_started_it(self):
		item = self._stocked_item("V11-PUSH-4", 20)
		out = self._push(item, per_store=2, stores=[STORE])
		self.assertIn("Houston", out["reason"])
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", out["requests"][0]["name"], "reason"), out["reason"])
		# a reason of the admin's own is kept verbatim
		out = self._push(item, per_store=2, stores=[STORE], reason="New product launch")
		self.assertEqual(out["reason"], "New product launch")

	def test_priority_reaches_the_shipment(self):
		item = self._stocked_item("V11-PUSH-5", 20)
		out = self._push(item, per_store=2, stores=[STORE], priority="Urgent")
		self.assertEqual(out["shipments"][0]["priority"], "Urgent")
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError):
			distribution.send([{"boutique": STORE, "item_code": item, "qty": 1}], priority="Whenever")


# ===========================================================================
# §A — the refusals (client decision 4)
# ===========================================================================
class TestDistributionRefusals(DistributionCase):
	def _nothing_written_for(self, item: str) -> None:
		"""No request, no shipment, no material request anywhere carries this item."""
		self.assertEqual(frappe.get_all("AWANZ Replenishment Line", filters={"item_code": item}, limit=1), [])
		self.assertEqual(frappe.get_all("AWANZ Shipment Line", filters={"item_code": item}, limit=1), [])
		self.assertEqual(frappe.get_all("Material Request Item", filters={"item_code": item}, limit=1), [])

	def test_over_allocation_is_refused_and_nothing_is_written(self):
		"""The one that matters: name the shortfall per item, write **nothing**.

		A half-sent distribution leaves phantom shipments the floor will pick and ship — worse
		than a refused one — so the whole thing is validated before a single row is inserted.
		"""
		item = self._stocked_item("V11-SHORT-1", 10)
		other = self._stocked_item("V11-SHORT-2", 4)
		self._nothing_written_for(item)

		frappe.set_user(WH_ADMIN)
		lines = []
		for boutique in self.stores:
			lines.append({"boutique": boutique, "item_code": item, "qty": 8})
			lines.append({"boutique": boutique, "item_code": other, "qty": 3})
		with self.assertRaises(frappe.ValidationError) as caught:
			distribution.send(lines)

		message = str(caught.exception)
		n = len(self.stores)
		self.assertIn(item, message)
		self.assertIn(other, message)
		self.assertIn(f"short {8 * n - 10}", message)  # named per item, not a bare "not enough"
		self.assertIn(f"short {3 * n - 4}", message)
		self.assertIn("Nothing was sent", message)

		# … and the refusal really did leave the database untouched
		self._nothing_written_for(item)
		self._nothing_written_for(other)
		self.assertEqual(_bin(item, self.warehouse), 10.0)
		self.assertEqual(_bin(other, self.warehouse), 4.0)

	def test_stock_already_committed_to_an_open_shipment_cannot_be_promised_twice(self):
		"""A Pending shipment has not moved any stock yet, so the Bin still counts those units."""
		item = self._stocked_item("V11-COMMIT-1", 10)
		self._push(item, per_store=8, stores=[STORE])
		frappe.set_user(WH_ADMIN)
		self.assertEqual(dist_lib.availability([item])[item], {"on_hand": 10.0, "committed": 8.0, "available": 2.0})
		with self.assertRaises(frappe.ValidationError) as caught:
			distribution.send([{"boutique": STORE, "item_code": item, "qty": 5}])
		self.assertIn("short 3", str(caught.exception))

	def test_a_disabled_store_is_refused_and_nothing_is_written(self):
		item = self._stocked_item("V11-DISABLED-1", 40)
		target = self.stores[0]
		frappe.db.set_value("AWANZ Store", target, "enabled", 0)
		frappe.clear_document_cache("AWANZ Store", target)
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError) as caught:
			distribution.send([{"boutique": target, "item_code": item, "qty": 4}])
		self.assertIn(target, str(caught.exception))
		self.assertIn("disabled", str(caught.exception).lower())
		self._nothing_written_for(item)

	def test_the_refusals_that_protect_the_floor(self):
		item = self._stocked_item("V11-REFUSE-1", 40)
		frappe.set_user(WH_ADMIN)
		for lines, needle in (
			([], "at least one store"),
			([{"boutique": "NOT-A-STORE", "item_code": item, "qty": 1}], "does not exist"),
			([{"boutique": self.stores[0], "item_code": "NOT-AN-ITEM", "qty": 1}], "does not exist"),
			([{"boutique": self.stores[0], "item_code": item, "qty": 0}], "more than zero"),
			([{"boutique": self.stores[0], "item_code": item, "qty": -3}], "more than zero"),
		):
			with self.assertRaises(frappe.ValidationError, msg=needle) as caught:
				distribution.send(lines)
			self.assertIn(needle, str(caught.exception))
		self._nothing_written_for(item)

	def test_a_non_stock_item_cannot_be_shipped(self):
		service = frappe.db.get_value("Item", {"is_stock_item": 0, "disabled": 0}, "name")
		if not service:
			self.skipTest("this seed has no non-stock item")
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError) as caught:
			distribution.send([{"boutique": self.stores[0], "item_code": service, "qty": 1}])
		self.assertIn("not a stock item", str(caught.exception))

	def test_a_store_manager_may_not_push(self):
		"""Client decision 1 — pushing is Houston's, even into the manager's own store."""
		item = self._stocked_item("V11-PERM-1", 20)
		frappe.set_user(_manager(STORE))
		for call in (
			lambda: distribution.send([{"boutique": STORE, "item_code": item, "qty": 1}]),
			lambda: distribution.plan([item]),
			lambda: distribution.suggest_split(item, 10, "even"),
			lambda: distribution.stores(),
		):
			with self.assertRaises(frappe.PermissionError):
				call()
		self._nothing_written_for(item)

	def test_two_lines_for_the_same_store_and_item_are_merged_not_refused(self):
		"""``AWANZ Replenishment Request`` refuses an item listed twice; the sheet may still send
		an even split plus a manual top-up, so the two rows are summed."""
		item = self._stocked_item("V11-MERGE-1", 20)
		frappe.set_user(WH_ADMIN)
		out = distribution.send(
			[{"boutique": STORE, "item_code": item, "qty": 3}, {"boutique": STORE, "item_code": item, "qty": 2}]
		)
		self.assertEqual(out["stores"], 1)
		self.assertEqual(out["units"], 5.0)
		self.assertEqual(out["shipments"][0]["units"], 5.0)


# ===========================================================================
# §A — plan
# ===========================================================================
class TestDistributionPlan(DistributionCase):
	def test_plan_carries_the_warehouse_position_and_a_row_per_store(self):
		item = self._stocked_item("V11-PLAN-1", 30)
		frappe.set_user(WH_ADMIN)
		out = distribution.plan([item])
		self.assertEqual(out["warehouse"], self.warehouse)
		self.assertEqual(out["velocity_days"], 28)
		row = out["items"][0]
		self.assertEqual(row["item_code"], item)
		self.assertEqual((row["on_hand"], row["committed"], row["available"]), (30.0, 0.0, 30.0))
		self.assertEqual(sorted(s["boutique"] for s in row["stores"]), sorted(self.stores))
		for store in row["stores"]:
			self.assertIn("on_hand", store)
			self.assertIn("velocity", store)
			self.assertIn("cover_days", store)
			self.assertIn("ever_sold", store)
			self.assertFalse(store["ever_sold"], "a brand-new item has never been sold anywhere")

	def test_plan_subtracts_what_is_already_committed(self):
		item = self._stocked_item("V11-PLAN-2", 30)
		self._push(item, per_store=4, stores=[STORE])
		frappe.set_user(WH_ADMIN)
		row = distribution.plan([item])["items"][0]
		self.assertEqual((row["on_hand"], row["committed"], row["available"]), (30.0, 4.0, 26.0))

	def test_plan_refuses_an_unknown_item(self):
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.DoesNotExistError):
			distribution.plan(["V11-NOPE"])
		with self.assertRaises(frappe.ValidationError):
			distribution.plan([])


# ===========================================================================
# §A — the three split modes (pure maths, then over the API)
# ===========================================================================
class TestSplitMaths(FrappeTestCase):
	"""No database: the allocation helpers are pure functions over plain rows."""

	ROWS = [
		{"boutique": "A", "velocity": 2.0, "on_hand": 10},
		{"boutique": "B", "velocity": 1.0, "on_hand": 4},
		{"boutique": "C", "velocity": 0.0, "on_hand": 0},
	]

	def test_even_splits_equally_and_gives_the_remainder_to_the_busiest(self):
		self.assertEqual(dist_lib.split_even(9, self.ROWS), {"A": 3, "B": 3, "C": 3})
		# 11 across 3 = 3 each, 2 over → the two busiest (A then B)
		self.assertEqual(dist_lib.split_even(11, self.ROWS), {"A": 4, "B": 4, "C": 3})
		self.assertEqual(sum(dist_lib.split_even(11, self.ROWS).values()), 11)
		self.assertEqual(dist_lib.split_even(0, self.ROWS), {"A": 0, "B": 0, "C": 0})
		self.assertEqual(dist_lib.split_even(5, []), {})

	def test_velocity_weights_by_sales_with_a_minimum_of_one_each(self):
		# 12 units: one each first (3), then 9 shared 2:1:0 → A 6, B 3, C 0
		self.assertEqual(dist_lib.split_by_velocity(12, self.ROWS), {"A": 7, "B": 4, "C": 1})
		self.assertEqual(sum(dist_lib.split_by_velocity(12, self.ROWS).values()), 12)
		# every store keeps its one even though C has never sold it
		self.assertTrue(all(qty >= 1 for qty in dist_lib.split_by_velocity(12, self.ROWS).values()))

	def test_velocity_handles_the_two_honest_edge_cases(self):
		# fewer units than stores: the busiest get what there is, nobody gets a fraction
		self.assertEqual(dist_lib.split_by_velocity(2, self.ROWS), {"A": 1, "B": 1, "C": 0})
		# a brand-new product nobody has sold: no signal to weight by, so fall back to even
		fresh = [{"boutique": k, "velocity": 0.0, "on_hand": 0} for k in ("A", "B", "C")]
		self.assertEqual(dist_lib.split_by_velocity(9, fresh), {"A": 3, "B": 3, "C": 3})

	def test_topup_brings_every_store_to_the_target_cover(self):
		rows = [
			{"boutique": "A", "velocity": 1.0, "on_hand": 4},  # wants 14 for 18 days
			{"boutique": "B", "velocity": 0.5, "on_hand": 0},  # wants 9
			{"boutique": "C", "velocity": 0.0, "on_hand": 0},  # sells none, wants none
		]
		self.assertEqual(dist_lib.split_topup(40, rows, 18), {"A": 14, "B": 9, "C": 0})
		# when there is not enough to go round, share it out by the size of the gap and never
		# hand a store more than it actually needs
		short = dist_lib.split_topup(12, rows, 18)
		self.assertEqual(sum(short.values()), 12)
		self.assertEqual(short["C"], 0)
		self.assertLessEqual(short["A"], 14)
		self.assertLessEqual(short["B"], 9)
		self.assertGreater(short["A"], short["B"])
		# everybody already covered → allocate nothing rather than guess
		covered = [{"boutique": "A", "velocity": 1.0, "on_hand": 100}]
		self.assertEqual(dist_lib.split_topup(10, covered, 18), {"A": 0})


class TestSuggestSplit(DistributionCase):
	def test_the_three_modes_over_the_api(self):
		item = self._stocked_item("V11-SPLIT-1", 60)
		frappe.set_user(WH_ADMIN)
		n = len(self.stores)
		for mode in ("even", "velocity", "topup"):
			out = distribution.suggest_split(item, 3 * n, mode)
			self.assertEqual(out["mode"], mode)
			self.assertEqual(sorted(line["boutique"] for line in out["lines"]), sorted(self.stores))
			self.assertEqual(out["allocated"], sum(line["qty"] for line in out["lines"]))
			self.assertEqual(out["remainder"], out["qty"] - out["allocated"])
			self.assertEqual(out["available"], 60.0)
			self.assertEqual(out["left_at_warehouse"], 60.0 - out["allocated"])
		# even and velocity spend the whole quantity; topup spends only what the cover needs, and
		# a brand-new product nobody sells needs nothing at all
		self.assertEqual(distribution.suggest_split(item, 3 * n, "even")["allocated"], 3 * n)
		self.assertEqual(distribution.suggest_split(item, 3 * n, "velocity")["allocated"], 3 * n)
		self.assertEqual(distribution.suggest_split(item, 3 * n, "topup")["allocated"], 0)

	def test_suggest_split_refuses_an_unknown_mode_or_item(self):
		item = self._stocked_item("V11-SPLIT-2", 10)
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError):
			distribution.suggest_split(item, 10, "by-vibes")
		with self.assertRaises(frappe.DoesNotExistError):
			distribution.suggest_split("V11-NOPE", 10, "even")

	def test_a_split_can_be_sent_straight_back_as_a_distribution(self):
		"""What the sheet actually does: split, then send the rows it was handed."""
		item = self._stocked_item("V11-SPLIT-3", 30)
		frappe.set_user(WH_ADMIN)
		split = distribution.suggest_split(item, 9, "even")
		lines = [{"boutique": line["boutique"], "item_code": item, "qty": line["qty"]} for line in split["lines"] if line["qty"]]
		out = distribution.send(lines)
		self.assertEqual(out["units"], split["allocated"])
		self.assertEqual(out["stores"], len(lines))


# ===========================================================================
# §B — a new product, from the warehouse
# ===========================================================================
class TestCreateProduct(DistributionCase):
	def _payload(self, code: str, **kw) -> dict:
		payload = {
			"item_code": code,
			"item_name": f"{code} Test Product",
			"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
			"uom": "Nos",
			"barcode": f"BC-{code}",
			"selling_rate": 24.99,
			"vendor": {"supplier": ensure_vendor(VENDOR), "vendor_sku": f"SKU-{code}", "cost": 11.5, "case_pack": 6, "moq": 12, "lead_time_days": 7},
			"reorder": {"level": 24, "qty": 48},
		}
		payload.update(kw)
		return payload

	def test_create_product_builds_item_vendor_row_price_list_and_reorder(self):
		code = "V11-NEW-1"
		frappe.set_user(WH_ADMIN)
		out = purchasing.create_product(self._payload(code))

		item = out["item"]
		self.assertEqual(item["item_code"], code)
		self.assertEqual(item["barcode"], f"BC-{code}")
		self.assertTrue(item["is_stock_item"])
		self.assertEqual(item["valuation_method"], "Moving Average")
		self.assertEqual(item["uom"], "Nos")
		self.assertEqual(item["warehouse"], self.warehouse)

		# the vendor row went through vendors.py, so the vendor's buying price list carries the cost
		self.assertEqual(item["preferred"], VENDOR, "the first vendor of an item is its preferred one")
		row = item["vendors"][0]
		self.assertEqual((row["supplier"], row["vendor_sku"], row["cost"], row["case_pack"], row["moq"]), (VENDOR, f"SKU-{code}", 11.5, 6, 12))
		price_list = vendor_lib.price_list_name(VENDOR)
		self.assertEqual(
			flt(frappe.db.get_value("Item Price", {"item_code": code, "price_list": price_list, "supplier": VENDOR}, "price_list_rate")),
			11.5,
		)
		self.assertEqual(vendor_lib.vendor_rate(code, VENDOR), 11.5)

		# the selling rate is a standard Item Price on the selling list the tills read
		self.assertEqual(item["selling_rate"], 24.99)
		self.assertEqual(
			flt(frappe.db.get_value("Item Price", {"item_code": code, "price_list": item["price_list"], "selling": 1}, "price_list_rate")),
			24.99,
		)

		# the reorder level is on the main warehouse, ready for the demand engine
		self.assertEqual(item["reorder"], {"warehouse": self.warehouse, "level": 24.0, "qty": 48.0})
		self.assertEqual(
			flt(frappe.db.get_value("Item Reorder", {"parent": code, "warehouse": self.warehouse}, "warehouse_reorder_level")), 24.0
		)

		# and the catalogue row the Buying screen orders from comes back with it
		self.assertEqual(out["catalogue_row"]["item_code"], code)
		self.assertEqual(out["catalogue_row"]["vendor_sku"], f"SKU-{code}")
		self.assertEqual(out["catalogue_row"]["default_qty"], 6)
		self.assertEqual(out["catalogue_row"]["rate"], 11.5)

	def test_a_new_product_can_be_ordered_and_then_pushed_to_the_stores(self):
		"""§B → §C → §A: the walk-through this whole release exists for."""
		code = "V11-NEW-2"
		frappe.set_user(WH_ADMIN)
		purchasing.create_product(self._payload(code))
		catalogue = purchasing.vendor_catalogue(VENDOR, search=f"SKU-{code}")
		self.assertEqual([row["item_code"] for row in catalogue["items"]], [code])
		order = purchasing.create_order(VENDOR, [{"item_code": code, "qty": catalogue["items"][0]["default_qty"], "rate": 11.5}])
		self.assertEqual(flt(order["items"][0]["qty"]), 6.0)

		stock_main_warehouse(code, 30, self.warehouse)
		out = distribution.send([{"boutique": b, "item_code": code, "qty": 5} for b in self.stores])
		self.assertEqual(out["stores"], len(self.stores))
		self.assertTrue(all(s["warehouse_push"] for s in out["shipments"]))

	def test_a_duplicate_item_code_is_refused(self):
		code = "V11-DUP-1"
		frappe.set_user(WH_ADMIN)
		purchasing.create_product(self._payload(code))
		with self.assertRaises(frappe.ValidationError) as caught:
			purchasing.create_product(self._payload(code, barcode="BC-V11-DUP-1-OTHER"))
		self.assertIn(code, str(caught.exception))

	def test_a_duplicate_barcode_is_refused_and_the_second_item_is_never_created(self):
		"""The real-money one: two products on one barcode means the till rings up the wrong item."""
		first, second = "V11-BC-1", "V11-BC-2"
		frappe.set_user(WH_ADMIN)
		purchasing.create_product(self._payload(first, barcode="0123456789012"))
		with self.assertRaises(frappe.ValidationError) as caught:
			purchasing.create_product(self._payload(second, barcode="0123456789012"))
		self.assertIn(first, str(caught.exception))
		self.assertFalse(frappe.db.exists("Item", second))
		# … including a barcode held only on the standard Item Barcode table
		self.assertEqual(purchasing.barcode_owner("0123456789012"), first)

	def test_nothing_is_left_behind_when_a_step_fails(self):
		"""All or nothing: a failure after the Item insert must not leave a half-built product."""
		code = "V11-ATOMIC-1"
		frappe.set_user(WH_ADMIN)
		with patch.object(vendor_lib, "add_or_update_row", side_effect=RuntimeError("vendor row exploded")):
			with self.assertRaises(RuntimeError):
				purchasing.create_product(self._payload(code))
		self.assertFalse(frappe.db.exists("Item", code))
		self.assertFalse(frappe.db.exists("Item Price", {"item_code": code}))
		self.assertEqual(frappe.get_all("Item Reorder", filters={"parent": code}, limit=1), [])
		self.assertEqual(frappe.get_all("AWANZ Item Vendor", filters={"parent": code}, limit=1), [])
		self.assertIsNone(purchasing.barcode_owner(f"BC-{code}"))
		# and the code is still free afterwards
		out = purchasing.create_product(self._payload(code))
		self.assertEqual(out["item"]["item_code"], code)

	def test_the_refusals_before_anything_is_written(self):
		group = frappe.db.get_value("Item Group", {"is_group": 0}, "name")
		frappe.set_user(WH_ADMIN)
		for payload, exc in (
			({"item_name": "No code", "item_group": group}, frappe.ValidationError),
			({"item_code": "V11-BAD-1"}, frappe.ValidationError),
			({"item_code": "V11-BAD-2", "item_group": "Not A Group"}, frappe.DoesNotExistError),
			({"item_code": "V11-BAD-3", "item_group": group, "uom": "Parsecs"}, frappe.DoesNotExistError),
			({"item_code": "V11-BAD-4", "item_group": group, "vendor": {"supplier": "Nobody Ltd"}}, frappe.DoesNotExistError),
			({"item_code": "V11-BAD-5", "item_group": group, "selling_rate": -1}, frappe.ValidationError),
		):
			with self.assertRaises(exc, msg=str(payload)):
				purchasing.create_product(payload)
			if payload.get("item_code"):
				self.assertFalse(frappe.db.exists("Item", payload["item_code"]))
		group_heading = frappe.db.get_value("Item Group", {"is_group": 1}, "name")
		if group_heading:
			with self.assertRaises(frappe.ValidationError):
				purchasing.create_product({"item_code": "V11-BAD-6", "item_group": group_heading})

	def test_a_product_can_be_created_without_a_vendor_or_a_price(self):
		"""A rep leaves a sample: name it now, price it later."""
		code = "V11-BARE-1"
		frappe.set_user(WH_ADMIN)
		out = purchasing.create_product({"item_code": code, "item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name")})
		self.assertEqual(out["item"]["item_name"], code)
		self.assertEqual(out["item"]["vendors"], [])
		self.assertIsNone(out["catalogue_row"])
		self.assertIsNone(out["item"]["reorder"])
		self.assertEqual(out["item"]["selling_rate"], 0.0)

	def test_a_store_manager_may_not_create_a_product(self):
		frappe.set_user(_manager(STORE))
		with self.assertRaises(frappe.PermissionError):
			purchasing.create_product(self._payload("V11-PERM-2"))
		with self.assertRaises(frappe.PermissionError):
			purchasing.item_groups()
		self.assertFalse(frappe.db.exists("Item", "V11-PERM-2"))

	def test_item_groups_lists_the_groups_a_product_can_be_filed_under(self):
		frappe.set_user(WH_ADMIN)
		out = purchasing.item_groups()
		self.assertTrue(out["groups"])
		self.assertTrue(all(g["name"] for g in out["groups"]))
		self.assertFalse(
			[g for g in out["groups"] if cint(frappe.db.get_value("Item Group", g["name"], "is_group"))],
			"a group heading is not somewhere a product can be filed",
		)
		self.assertIn(out["default"], [g["name"] for g in out["groups"]])


# ===========================================================================
# §C — the vendor catalogue (order from scratch)
# ===========================================================================
class TestVendorCatalogue(DistributionCase):
	def _catalogued(self, code: str, sku: str, cost: float = 9.0) -> str:
		item = ensure_item(code)
		vendor_lib.add_or_update_row(item, {"supplier": ensure_vendor(VENDOR), "vendor_sku": sku, "cost": cost, "case_pack": 4, "moq": 8})
		return item

	def test_the_catalogue_is_searchable_by_code_name_or_their_sku(self):
		code = "V11-CAT-1"
		self._catalogued(code, "ACME-99881")
		frappe.set_user(WH_ADMIN)
		self.assertIn(code, [r["item_code"] for r in purchasing.vendor_catalogue(VENDOR)["items"]])
		for needle in (code.lower(), "acme-998", "ACME-99881"):
			found = purchasing.vendor_catalogue(VENDOR, search=needle)["items"]
			self.assertEqual([r["item_code"] for r in found], [code], f"search {needle!r}")
		self.assertEqual(purchasing.vendor_catalogue(VENDOR, search="no such thing")["items"], [])

	def test_the_catalogue_carries_what_the_order_sheet_needs(self):
		code = "V11-CAT-2"
		self._catalogued(code, "ACME-424242", cost=13.25)
		frappe.set_user(WH_ADMIN)
		out = purchasing.vendor_catalogue(VENDOR, search=code)
		self.assertEqual(out["price_list"], vendor_lib.price_list_name(VENDOR))
		row = out["items"][0]
		self.assertEqual(row["vendor_sku"], "ACME-424242")
		self.assertEqual(row["cost"], 13.25)
		self.assertEqual(row["case_pack"], 4)
		self.assertEqual(row["moq"], 8)
		self.assertEqual(row["default_qty"], 4, "quantities default to a whole case")
		self.assertEqual(row["rate"], 13.25, "rates default from the vendor's own price list")
		self.assertIn("last_purchase_rate", row)
		self.assertIn("on_hand", row)

	def test_the_catalogue_is_refused_to_a_store_manager_and_for_an_unknown_vendor(self):
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.DoesNotExistError):
			purchasing.vendor_catalogue("Nobody Ltd")
		frappe.set_user(_manager(STORE))
		with self.assertRaises(frappe.PermissionError):
			purchasing.vendor_catalogue(VENDOR)
