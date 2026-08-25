"""v1.2 "What each store owes, and what each store charges" — §A wholesale, §B the stamp,
§C the month-end statement, §D the price board's reads and §E the Buying board's blocked rows.

The headline test is
:meth:`TestShipmentStamp.test_a_stamped_value_never_moves_when_the_valuation_moves`. Everything
else in this release is reporting; that one is the promise the client is billing on. A consignment
sent in March has to go on saying what it was worth in March after April's buying has moved the
moving average — a statement whose numbers change after somebody has invoiced from it by hand is
worse than no statement at all.

The second thing these tests defend is that **none of this is a receivable**. The eleven stores
are separately-owned LLCs; the proper answer is twelve companies with real intercompany invoices
and that is a re-platform. Until then the statement is an internal report, it says so in its own
payload, and nothing here posts to a ledger.
"""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, flt, nowdate, nowtime

from maison_pos import distribution as dist_lib
from maison_pos.api import distribution, inventory, pricing, purchasing, reports as reports_api, shipping
from maison_pos.awanz_pos.doctype.awanz_price_change_request.awanz_price_change_request import (
	STATE_APPROVED,
	pricing_rule_title,
)
from maison_pos.pricing import wholesale as wholesale_lib
from maison_pos.purchasing import demand as demand_lib
from maison_pos.purchasing import main_warehouse
from maison_pos.reports import store_statement
from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v0_6_warehouse import WH_ADMIN, ensure_warehouse_admin, stock_main_warehouse
from maison_pos.tests.test_v1_0_purchasing import ensure_item, ensure_vendor

#: what `stock_main_warehouse` posts stock in at
SEED_COST = 10.0
VENDOR = "AWANZ Test Wholesale A"


def _manager(boutique: str) -> str:
	return frappe.db.get_value("AWANZ Associate", {"boutique": boutique, "role": "Manager", "enabled": 1}, "user")


class PricingCase(FrappeTestCase):
	"""Same shape as the v1.0 / v1.1 suites: seed once, savepoint per test, roll back in teardown."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		ensure_warehouse_admin()

	def setUp(self):
		frappe.set_user("Administrator")
		self.sp = f"awanz_v12_{frappe.generate_hash(length=6)}"
		frappe.db.savepoint(self.sp)
		self.warehouse = main_warehouse()
		self.stores = [row["boutique"] for row in dist_lib.store_rows()]
		self.assertTrue(len(self.stores) >= 2, "the demo seed must offer at least two pushable stores")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point=self.sp)

	# ------------------------------------------------------------------ helpers
	def _stocked(self, code: str, qty: float = 60) -> str:
		item = ensure_item(code)
		stock_main_warehouse(item, qty, self.warehouse)
		return item

	def _receipt(self, item: str, qty: float, rate: float) -> None:
		"""Another purchase at a different price — this is what moves the moving average."""
		se = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"purpose": "Material Receipt",
				"company": frappe.db.get_value("Warehouse", self.warehouse, "company"),
				"to_warehouse": self.warehouse,
				"posting_date": nowdate(),
				"posting_time": nowtime(),
				"set_posting_time": 1,
				"items": [{"item_code": item, "qty": qty, "t_warehouse": self.warehouse, "basic_rate": rate}],
			}
		)
		se.flags.ignore_permissions = True
		se.insert()
		se.submit()

	def _ship(self, item: str, boutique: str, qty: float = 5) -> dict:
		frappe.set_user(WH_ADMIN)
		out = distribution.send([{"boutique": boutique, "item_code": item, "qty": qty}])
		name = out["shipments"][0]["name"]
		shipped = shipping.ship(name)
		frappe.set_user("Administrator")
		return shipped

	def _receive(self, name: str, boutique: str, item: str, received: float, damaged: float = 0.0) -> None:
		frappe.set_user(_manager(boutique))
		inventory.receive_shipment(name, lines=[{"item_code": item, "received_qty": received, "damaged_qty": damaged}], final=1)
		frappe.set_user("Administrator")

	def _statement(self, **kw) -> dict:
		frappe.set_user(WH_ADMIN)
		out = pricing.statement(kw.pop("from_date", nowdate()), kw.pop("to_date", nowdate()), **kw)
		frappe.set_user("Administrator")
		return out

	@staticmethod
	def _store_row(payload: dict, boutique: str) -> dict:
		return next(r for r in payload["stores"] if r["boutique"] == boutique)

	@classmethod
	def _line(cls, payload: dict, boutique: str, item: str) -> dict:
		"""The statement line for one item at one store.

		Value assertions are made here rather than on the store row: the whole suite shares one
		site, and any other test that ships something today lands in the same period. The item
		under test is unique to the test; the store's monthly total is not.
		"""
		return next(line for line in cls._store_row(payload, boutique)["lines"] if line["item_code"] == item)


# ===========================================================================
# §A — the wholesale price
# ===========================================================================
class TestWholesaleRule(PricingCase):
	def test_the_markup_rule_prices_an_item_from_what_the_warehouse_paid(self):
		item = self._stocked("V12-RULE-1")
		wholesale_lib.set_markup_pct(50)
		row = wholesale_lib.wholesale_for([item])[item]
		self.assertEqual(row["cost"], SEED_COST)
		self.assertEqual(row["wholesale"], 15.0)
		self.assertEqual(row["source"], "markup")
		self.assertIsNone(row["override"])
		self.assertEqual(row["markup_pct"], 50.0)

	def test_a_different_markup_reprices_every_item_that_has_no_override(self):
		item = self._stocked("V12-RULE-2")
		wholesale_lib.set_markup_pct(25)
		self.assertEqual(wholesale_lib.wholesale_rate(item), 12.5)
		wholesale_lib.set_markup_pct(0)
		self.assertEqual(wholesale_lib.wholesale_rate(item), SEED_COST, "0% is a legitimate rule — ship at cost")

	def test_a_typed_price_on_the_item_wins_over_the_rule(self):
		item = self._stocked("V12-OVR-1")
		wholesale_lib.set_markup_pct(50)
		row = wholesale_lib.set_override(item, 12.34)
		self.assertEqual(row["wholesale"], 12.34)
		self.assertEqual(row["source"], "override")
		self.assertEqual(row["override"], 12.34)
		self.assertEqual(row["cost"], SEED_COST, "the cost is still reported — the override only sets the price")
		# and the rule no longer touches it
		wholesale_lib.set_markup_pct(200)
		self.assertEqual(wholesale_lib.wholesale_rate(item), 12.34)

	def test_clearing_the_override_returns_the_item_to_the_rule(self):
		item = self._stocked("V12-OVR-2")
		wholesale_lib.set_markup_pct(50)
		wholesale_lib.set_override(item, 99.0)
		self.assertEqual(wholesale_lib.wholesale_rate(item), 99.0)
		row = wholesale_lib.set_override(item, None)
		self.assertEqual(row["source"], "markup")
		self.assertIsNone(row["override"])
		self.assertEqual(row["wholesale"], 15.0)
		self.assertFalse(flt(frappe.db.get_value("Item", item, wholesale_lib.OVERRIDE_FIELD)))

	def test_the_cost_is_the_warehouse_moving_average_and_not_a_price_list(self):
		"""A price list says what a vendor charges today. The statement bills what the stock cost."""
		item = self._stocked("V12-COST-1")
		wholesale_lib.set_markup_pct(50)
		for price_list, selling in (("Standard Selling", 1), ("Standard Buying", 0)):
			doc = frappe.get_doc(
				{
					"doctype": "Item Price",
					"item_code": item,
					"price_list": price_list,
					"selling": selling,
					"buying": 0 if selling else 1,
					"price_list_rate": 999.0,
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert()
		self.assertEqual(wholesale_lib.cost_rate(item), SEED_COST)
		self.assertEqual(wholesale_lib.wholesale_rate(item), 15.0, "999.00 on two price lists must not reach the wholesale price")
		# buying more at a different price is what moves it
		self._receipt(item, 60, 20.0)
		self.assertEqual(wholesale_lib.cost_rate(item), 15.0)
		self.assertEqual(wholesale_lib.wholesale_rate(item), 22.5)

	def test_many_items_resolve_in_one_pass_in_the_order_asked_for(self):
		items = [self._stocked(f"V12-BULK-{n}") for n in range(1, 4)]
		wholesale_lib.set_markup_pct(50)
		wholesale_lib.set_override(items[1], 7.0)
		frappe.set_user(WH_ADMIN)
		out = pricing.wholesale(items)
		frappe.set_user("Administrator")
		self.assertEqual([r["item_code"] for r in out["items"]], items)
		self.assertEqual([r["source"] for r in out["items"]], ["markup", "override", "markup"])
		self.assertEqual(out["items"][1]["wholesale"], 7.0)
		self.assertEqual(out["markup_pct"], 50.0)

	def test_the_api_refuses_a_negative_markup_and_a_negative_price(self):
		item = self._stocked("V12-NEG-1")
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError):
			pricing.set_wholesale_markup(-5)
		with self.assertRaises(frappe.ValidationError):
			pricing.set_wholesale(item, -1)
		frappe.set_user("Administrator")


# ===========================================================================
# §B — stamping a shipment
# ===========================================================================
class TestShipmentStamp(PricingCase):
	def test_a_shipment_carries_no_value_until_it_ships(self):
		item = self._stocked("V12-STAMP-0")
		frappe.set_user(WH_ADMIN)
		out = distribution.send([{"boutique": self.stores[0], "item_code": item, "qty": 4}])
		frappe.set_user("Administrator")
		doc = frappe.get_doc("AWANZ Shipment", out["shipments"][0]["name"])
		self.assertFalse(doc.value_stamped_at)
		self.assertFalse(flt(doc.wholesale_total))
		self.assertFalse(shipping.shipment_dict(doc)["priced"])

	def test_a_shipment_is_valued_when_it_ships(self):
		item = self._stocked("V12-STAMP-1")
		wholesale_lib.set_markup_pct(50)
		shipped = self._ship(item, self.stores[0], qty=5)
		self.assertTrue(shipped["priced"])
		self.assertTrue(shipped["value_stamped_at"])
		self.assertEqual(shipped["cost_total"], 50.0)
		self.assertEqual(shipped["wholesale_total"], 75.0)
		self.assertEqual(shipped["margin"], 25.0)
		line = shipped["lines"][0]
		self.assertEqual(line["cost_rate"], SEED_COST)
		self.assertEqual(line["wholesale_rate"], 15.0)

	def test_a_stamped_value_never_moves_when_the_valuation_moves(self):
		"""The promise the client bills on: March's consignment still says March's numbers.

		Ship at a cost of 10, then buy the same item again at 50 so the moving average nearly
		triples. Everything the statement reads — the line rates, the shipment totals and the
		statement itself — must still be the figures of the moment it left the building.
		"""
		item = self._stocked("V12-STAMP-2")
		wholesale_lib.set_markup_pct(50)
		shipped = self._ship(item, self.stores[0], qty=5)
		self.assertEqual(shipped["wholesale_total"], 75.0)

		self._receipt(item, 100, 50.0)
		moved = wholesale_lib.cost_rate(item)
		self.assertGreater(moved, SEED_COST * 2, "the test is worthless unless the moving average really moved")

		fresh = shipping.shipment_dict(frappe.get_doc("AWANZ Shipment", shipped["name"]))
		self.assertEqual(fresh["cost_total"], 50.0)
		self.assertEqual(fresh["wholesale_total"], 75.0)
		self.assertEqual(fresh["lines"][0]["cost_rate"], SEED_COST)
		self.assertEqual(fresh["lines"][0]["wholesale_rate"], 15.0)

		line = self._line(self._statement(), self.stores[0], item)
		self.assertEqual(line["wholesale_value"], 75.0)
		self.assertEqual(line["cost_value"], 50.0)

	def test_changing_the_markup_afterwards_does_not_touch_a_shipped_consignment(self):
		item = self._stocked("V12-STAMP-3")
		wholesale_lib.set_markup_pct(50)
		shipped = self._ship(item, self.stores[0], qty=5)
		wholesale_lib.set_markup_pct(400)
		fresh = shipping.shipment_dict(frappe.get_doc("AWANZ Shipment", shipped["name"]))
		self.assertEqual(fresh["wholesale_total"], 75.0)

	def test_shipping_twice_is_refused_so_a_stamp_can_never_be_rewritten(self):
		item = self._stocked("V12-STAMP-4")
		shipped = self._ship(item, self.stores[0], qty=5)
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError):
			shipping.ship(shipped["name"])
		frappe.set_user("Administrator")

	def test_the_stamp_posts_no_ledger_entry_of_its_own(self):
		"""Client decision 6 — stock still moves at cost; the wholesale figure is reporting only."""
		item = self._stocked("V12-STAMP-5")
		wholesale_lib.set_markup_pct(50)
		shipped = self._ship(item, self.stores[0], qty=5)
		entry = shipped["stock_entry_ship"]
		self.assertTrue(entry)
		value = flt(frappe.db.get_value("Stock Entry", entry, "total_outgoing_value"))
		self.assertAlmostEqual(value, 50.0, places=2, msg="the transfer must post at cost, not at the wholesale price")
		self.assertFalse(frappe.db.exists("Sales Invoice", {"remarks": ("like", f"%{shipped['name']}%")}), "a consignment must never raise an invoice")
		self.assertFalse(frappe.db.exists("Journal Entry", {"user_remark": ("like", f"%{shipped['name']}%")}))


# ===========================================================================
# §C — the month-end statement
# ===========================================================================
class TestStatement(PricingCase):
	def test_a_short_and_a_damaged_discrepancy_come_off_billable_units(self):
		item = self._stocked("V12-NET-1", qty=120)
		wholesale_lib.set_markup_pct(50)
		short_store, whole_store = self.stores[0], self.stores[1]
		shipped = self._ship(item, short_store, qty=10)
		self._ship(item, whole_store, qty=10)
		# the store counts 7 good, 1 damaged — 2 never arrived at all
		self._receive(shipped["name"], short_store, item, received=7, damaged=1)

		types = {d.type: d for d in frappe.get_all("AWANZ Receiving Discrepancy", filters={"shipment": shipped["name"]}, fields=["type", "short_qty", "damaged_qty"])}
		self.assertIn("Short", types)
		self.assertIn("Damaged", types)

		payload = self._statement()
		netted = self._line(payload, short_store, item)
		self.assertEqual(netted["units"], 10.0)
		self.assertEqual(netted["short_units"], 2.0)
		self.assertEqual(netted["damaged_units"], 1.0)
		self.assertEqual(netted["billable_units"], 7.0, "bill for what the store actually received")
		self.assertEqual(netted["wholesale_value"], 105.0)
		self.assertEqual(netted["cost_value"], 70.0)
		self.assertEqual(netted["margin"], 35.0)
		self.assertEqual(netted["margin_pct"], 33.3)

		untouched = self._line(payload, whole_store, item)
		self.assertEqual(untouched["billable_units"], 10.0)
		self.assertEqual(untouched["wholesale_value"], 150.0)
		# and the store row carries at least what this consignment contributed
		self.assertGreaterEqual(self._store_row(payload, short_store)["short_units"], 2.0)

	def test_a_resolved_discrepancy_still_comes_off_the_bill(self):
		"""Resolving a shortage settles it with the warehouse. The store still never received it."""
		item = self._stocked("V12-NET-2", qty=60)
		wholesale_lib.set_markup_pct(50)
		store = self.stores[0]
		shipped = self._ship(item, store, qty=10)
		self._receive(shipped["name"], store, item, received=8)
		name = frappe.get_all("AWANZ Receiving Discrepancy", filters={"shipment": shipped["name"], "type": "Short"}, pluck="name")[0]
		frappe.set_user(WH_ADMIN)
		shipping.resolve_discrepancy(name, "Write off")
		frappe.set_user("Administrator")
		self.assertEqual(frappe.db.get_value("AWANZ Receiving Discrepancy", name, "status"), "Resolved")
		self.assertEqual(self._line(self._statement(), store, item)["billable_units"], 8.0)

	def test_a_store_with_nothing_shipped_appears_with_zeros(self):
		"""An absent row reads as an oversight, so a quiet month is a row of zeros, not a gap.

		Asked for a period the chain did not exist in, *every* store must answer with zeros —
		which is the same requirement without depending on which stores happen to be quiet today.
		"""
		item = self._stocked("V12-ZERO-1")
		self._ship(item, self.stores[0], qty=3)
		long_ago = add_days(nowdate(), -3650)
		payload = self._statement(from_date=long_ago, to_date=long_ago)
		from maison_pos.shipping import store_boutiques

		self.assertEqual({r["boutique"] for r in payload["stores"]}, set(store_boutiques()))
		self.assertTrue(payload["stores"])
		for row in payload["stores"]:
			self.assertEqual(row["shipments"], 0)
			self.assertEqual(row["units"], 0.0)
			self.assertEqual(row["billable_units"], 0.0)
			self.assertEqual(row["wholesale_value"], 0.0)
			self.assertEqual(row["margin_pct"], 0.0)
			self.assertEqual(row["lines"], [])
		self.assertEqual(payload["totals"]["wholesale_value"], 0.0)
		# and today the store that was sent something is not a row of zeros
		self.assertEqual(self._line(self._statement(), self.stores[0], item)["units"], 3.0)

	def test_the_statement_says_it_is_internal_and_not_an_invoice(self):
		payload = self._statement()
		self.assertTrue(payload["internal"])
		self.assertTrue(payload["shows_cost"])
		self.assertFalse(payload["is_invoice"])
		self.assertFalse(payload["creates_receivable"])
		self.assertIn("not an invoice", payload["notice"].lower())
		self.assertIn("receivable", payload["notice"].lower())

	def test_the_statement_creates_no_document_of_any_kind(self):
		item = self._stocked("V12-DOC-1")
		self._ship(item, self.stores[0], qty=3)
		before = {dt: frappe.db.count(dt) for dt in ("Sales Invoice", "Purchase Invoice", "Journal Entry", "GL Entry")}
		self._statement()
		self._statement()
		self.assertEqual({dt: frappe.db.count(dt) for dt in before}, before)

	def test_a_consignment_that_shipped_before_v1_2_is_reported_as_not_priced(self):
		"""Backfill is out of scope: an unstamped consignment is named, never valued at today's cost."""
		item = self._stocked("V12-OLD-1")
		store = self.stores[0]
		shipped = self._ship(item, store, qty=6)
		# exactly what a pre-v1.2 consignment looks like on the client's live site
		frappe.db.set_value("AWANZ Shipment", shipped["name"], {"value_stamped_at": None, "cost_total": 0, "wholesale_total": 0}, update_modified=False)
		frappe.db.sql("update `tabAWANZ Shipment Line` set cost_rate = 0, wholesale_rate = 0 where parent = %s", shipped["name"])

		payload = self._statement()
		line = self._line(payload, store, item)
		self.assertEqual(line["units"], 6.0)
		self.assertEqual(line["billable_units"], 6.0)
		self.assertEqual(line["unpriced_units"], 6.0)
		self.assertEqual(line["wholesale_value"], 0.0, "an unstamped consignment is never valued at today's numbers")
		self.assertEqual(line["cost_value"], 0.0)
		row = self._store_row(payload, store)
		self.assertGreaterEqual(row["unpriced_shipments"], 1)
		self.assertGreaterEqual(row["unpriced_units"], 6.0)

	def test_the_chain_total_is_the_sum_of_the_stores(self):
		item = self._stocked("V12-TOT-1", qty=120)
		wholesale_lib.set_markup_pct(50)
		before = self._statement()["totals"]
		self._ship(item, self.stores[0], qty=4)
		self._ship(item, self.stores[1], qty=6)
		payload = self._statement()
		totals = payload["totals"]
		for key in ("shipments", "units", "billable_units", "wholesale_value", "cost_value", "unpriced_units"):
			self.assertEqual(totals[key], round(sum(r[key] for r in payload["stores"]), 2), key)
		self.assertEqual(totals["margin"], round(totals["wholesale_value"] - totals["cost_value"], 2))
		# what this test itself put on the chain — the site is shared, the delta is not
		self.assertEqual(round(totals["wholesale_value"] - before["wholesale_value"], 2), 150.0)
		self.assertEqual(round(totals["cost_value"] - before["cost_value"], 2), 100.0)
		self.assertEqual(totals["shipments"] - before["shipments"], 2)

	def test_the_period_bounds_the_statement(self):
		item = self._stocked("V12-PER-1")
		store = self.stores[0]
		self._ship(item, store, qty=5)
		long_ago = add_days(nowdate(), -3650)
		self.assertEqual(self._store_row(self._statement(from_date=long_ago, to_date=long_ago), store)["shipments"], 0)
		self.assertEqual(self._line(self._statement(), store, item)["shipments"], 1)

	def test_one_store_can_be_asked_for_on_its_own(self):
		item = self._stocked("V12-ONE-1", qty=60)
		self._ship(item, self.stores[0], qty=5)
		payload = self._statement(boutique=self.stores[0])
		self.assertEqual([r["boutique"] for r in payload["stores"]], [self.stores[0]])

	def test_the_line_detail_is_in_the_payload_and_adds_up_to_the_store_row(self):
		a = self._stocked("V12-LINE-1", qty=60)
		b = self._stocked("V12-LINE-2", qty=60)
		wholesale_lib.set_markup_pct(50)
		store = self.stores[0]
		frappe.set_user(WH_ADMIN)
		out = distribution.send([{"boutique": store, "item_code": a, "qty": 4}, {"boutique": store, "item_code": b, "qty": 6}])
		shipping.ship(out["shipments"][0]["name"])
		frappe.set_user("Administrator")
		row = self._store_row(self._statement(), store)
		self.assertTrue({a, b} <= {line["item_code"] for line in row["lines"]})
		self.assertEqual(round(sum(line["wholesale_value"] for line in row["lines"]), 2), row["wholesale_value"])
		self.assertEqual(round(sum(self._line(self._statement(), store, code)["wholesale_value"] for code in (a, b)), 2), 150.0)

	def test_the_script_report_and_the_screen_agree(self):
		item = self._stocked("V12-RPT-1", qty=60)
		wholesale_lib.set_markup_pct(50)
		store = self.stores[0]
		self._ship(item, store, qty=5)
		payload = self._statement()
		columns, rows, message = store_statement.execute({"from_date": nowdate(), "to_date": nowdate()})
		self.assertIn("not an invoice", message.lower())
		self.assertEqual(len(rows), len(payload["stores"]) + 1, "one row per store plus the chain total")
		self.assertEqual(self._line(payload, store, item)["wholesale_value"], 75.0)
		reported = next(r for r in rows if r.get("boutique") == store)
		screen = self._store_row(payload, store)
		for key in ("units", "billable_units", "wholesale_value", "cost_value", "margin", "margin_pct"):
			self.assertEqual(reported[key], screen[key], key)
		self.assertIsNone(rows[-1]["boutique"])
		self.assertEqual(rows[-1]["wholesale_value"], payload["totals"]["wholesale_value"])
		self.assertNotIn("lines", reported)

	def test_the_report_asked_for_line_detail_returns_a_row_per_item(self):
		a = self._stocked("V12-RPT-2", qty=60)
		b = self._stocked("V12-RPT-3", qty=60)
		store = self.stores[0]
		frappe.set_user(WH_ADMIN)
		out = distribution.send([{"boutique": store, "item_code": a, "qty": 4}, {"boutique": store, "item_code": b, "qty": 6}])
		shipping.ship(out["shipments"][0]["name"])
		frappe.set_user("Administrator")
		columns, rows, _msg = store_statement.execute({"from_date": nowdate(), "to_date": nowdate(), "detail": 1})
		self.assertIn("item_code", [c["fieldname"] for c in columns])
		detail = [r for r in rows if r.get("boutique") == store and r.get("item_code")]
		self.assertEqual({r["item_code"] for r in detail}, {a, b})

	def test_the_report_is_registered_and_flagged_internal(self):
		meta = reports_api._report_meta("AWANZ Store Statement")
		self.assertTrue(meta.get("internal"))
		self.assertEqual(meta.get("roles"), reports_api.PURCHASING_REPORT_ROLES)
		self.assertTrue(frappe.db.exists("Report", "AWANZ Store Statement"))
		frappe.set_user(WH_ADMIN)
		listed = {r["name"] for r in reports_api.list_reports()["reports"]}
		self.assertIn("AWANZ Store Statement", listed)
		out = reports_api.run("AWANZ Store Statement", {"from_date": nowdate(), "to_date": nowdate()})
		self.assertTrue(out["internal"])
		self.assertIn("not an invoice", (out["message"] or "").lower())
		frappe.set_user("Administrator")


# ===========================================================================
# §A / §C / §D — who may see any of this
# ===========================================================================
class TestPricingPermissions(PricingCase):
	def setUp(self):
		super().setUp()
		self.store = self.stores[0]
		self.other = self.stores[1]
		self.manager = _manager(self.store)
		self.assertTrue(self.manager, "the demo seed must carry a manager for the store under test")
		self.item = self._stocked("V12-PERM-1")

	def test_a_store_manager_is_refused_every_pricing_endpoint(self):
		frappe.set_user(self.manager)
		for call in (
			lambda: pricing.wholesale([self.item]),
			lambda: pricing.set_wholesale(self.item, 5),
			lambda: pricing.wholesale_settings(),
			lambda: pricing.set_wholesale_markup(10),
			lambda: pricing.statement(nowdate(), nowdate()),
			lambda: pricing.statement(nowdate(), nowdate(), self.store),
			lambda: pricing.store_prices(self.item),
		):
			with self.assertRaises(frappe.PermissionError):
				call()
		frappe.set_user("Administrator")

	def test_a_store_manager_is_refused_the_statement_even_for_their_own_store(self):
		"""It shows what the warehouse paid. That is not a figure a partner's manager may read."""
		frappe.set_user(self.manager)
		with self.assertRaises(frappe.PermissionError):
			pricing.statement(nowdate(), nowdate(), self.store)
		frappe.set_user("Administrator")

	def test_a_warehouse_admin_is_allowed_all_of_it(self):
		frappe.set_user(WH_ADMIN)
		self.assertEqual(pricing.wholesale_settings()["markup_pct"], wholesale_lib.markup_pct())
		self.assertTrue(pricing.wholesale([self.item])["items"])
		self.assertTrue(pricing.store_prices(self.item)["stores"])
		self.assertTrue(pricing.statement(nowdate(), nowdate())["internal"])
		frappe.set_user("Administrator")

	def test_a_store_manager_may_raise_a_price_change_for_their_own_store(self):
		frappe.set_user(self.manager)
		out = purchasing.request_price_change(self.item, self.store, 44.0, reason="Local promotion")
		frappe.set_user("Administrator")
		self.assertEqual(out["boutique"], self.store)
		self.assertEqual(out["workflow_state"], "Pending Approval")

	def test_a_store_manager_may_not_raise_a_price_change_for_another_store(self):
		frappe.set_user(self.manager)
		with self.assertRaises(frappe.PermissionError):
			purchasing.request_price_change(self.item, self.other, 44.0, reason="Local promotion")
		frappe.set_user("Administrator")

	def test_a_store_manager_may_not_approve_their_own_request(self):
		frappe.set_user(self.manager)
		out = purchasing.request_price_change(self.item, self.store, 44.0, reason="Local promotion")
		with self.assertRaises(Exception) as caught:
			purchasing.approve_price_change(out["name"])
		frappe.set_user("Administrator")
		self.assertNotEqual(frappe.db.get_value("AWANZ Price Change Request", out["name"], "workflow_state"), STATE_APPROVED)
		self.assertIsInstance(caught.exception, Exception)

	def test_approval_is_what_creates_the_store_scoped_pricing_rule(self):
		"""Existing v0.1 behaviour, re-proved here because the price board depends on it."""
		frappe.set_user(self.manager)
		out = purchasing.request_price_change(self.item, self.store, 44.0, reason="Local promotion")
		frappe.set_user("Administrator")
		title = pricing_rule_title(self.store, self.item)
		self.assertFalse(frappe.db.exists("Pricing Rule", {"title": title}))
		approved = purchasing.approve_price_change(out["name"], "Approve")
		self.assertEqual(approved["workflow_state"], STATE_APPROVED)
		self.assertTrue(approved["pricing_rule"])
		rule = frappe.get_doc("Pricing Rule", approved["pricing_rule"])
		self.assertEqual(flt(rule.rate), 44.0)
		self.assertEqual(rule.warehouse, frappe.db.get_value("AWANZ Store", self.store, "warehouse"))
		# and the board now reads it back as this store's own price
		frappe.set_user(WH_ADMIN)
		board = pricing.store_prices(self.item)
		frappe.set_user("Administrator")
		row = next(r for r in board["stores"] if r["boutique"] == self.store)
		self.assertEqual(row["rate"], 44.0)
		self.assertEqual(row["source"], "Store override")


# ===========================================================================
# §D — what the price board reads
# ===========================================================================
class TestPriceBoard(PricingCase):
	def setUp(self):
		super().setUp()
		self.store = self.stores[0]
		self.item = self._stocked("V12-BOARD-1")
		wholesale_lib.set_markup_pct(50)

	def _price(self, rate: float) -> None:
		doc = frappe.get_doc({"doctype": "Item Price", "item_code": self.item, "price_list": "Standard Selling", "selling": 1, "price_list_rate": rate})
		doc.flags.ignore_permissions = True
		doc.insert()

	def test_every_enabled_store_is_a_row_saying_where_its_price_comes_from(self):
		self._price(30.0)
		frappe.set_user(WH_ADMIN)
		board = pricing.store_prices(self.item)
		frappe.set_user("Administrator")
		from maison_pos.shipping import store_boutiques

		self.assertEqual({r["boutique"] for r in board["stores"]}, set(store_boutiques()))
		self.assertEqual(board["default_rate"], 30.0)
		for row in board["stores"]:
			self.assertEqual(row["source"], "Chain default")
			self.assertEqual(row["rate"], 30.0)
			self.assertFalse(row["is_override"])

	def test_the_margin_a_store_makes_is_the_shelf_price_less_the_wholesale_price(self):
		self._price(30.0)
		frappe.set_user(WH_ADMIN)
		board = pricing.store_prices(self.item)
		frappe.set_user("Administrator")
		self.assertEqual(board["wholesale"], 15.0)
		row = board["stores"][0]
		self.assertEqual(row["wholesale"], 15.0)
		self.assertEqual(row["margin"], 15.0)
		self.assertEqual(row["margin_pct"], 50.0)

	def test_a_pending_request_is_carried_on_the_row_so_the_board_does_not_invite_a_second(self):
		self._price(30.0)
		manager = _manager(self.store)
		frappe.set_user(manager)
		raised = purchasing.request_price_change(self.item, self.store, 36.0, reason="Weekend")
		frappe.set_user(WH_ADMIN)
		board = pricing.store_prices(self.item)
		frappe.set_user("Administrator")
		row = next(r for r in board["stores"] if r["boutique"] == self.store)
		self.assertEqual(row["pending"]["name"], raised["name"])
		self.assertEqual(row["pending"]["proposed_rate"], 36.0)
		self.assertEqual(row["rate"], 30.0, "the price in force does not change until the request is approved")

	def test_the_approvals_queue_carries_the_margin_a_proposal_implies(self):
		self._price(30.0)
		frappe.set_user(_manager(self.store))
		purchasing.request_price_change(self.item, self.store, 36.0, reason="Weekend")
		frappe.set_user(WH_ADMIN)
		queue = purchasing.price_change_requests(item_code=self.item)
		frappe.set_user("Administrator")
		row = queue["requests"][0]
		self.assertEqual(row["wholesale"], 15.0)
		self.assertEqual(row["margin_now"]["margin"], 15.0)
		self.assertEqual(row["margin_proposed"]["margin"], 21.0)
		self.assertEqual(row["margin_proposed"]["margin_pct"], 58.3)

	def test_a_store_user_reading_their_own_queue_is_told_no_internal_figures(self):
		"""What we pay for the stock is not shop-floor information — decision 3, in the payload."""
		self._price(30.0)
		manager = _manager(self.store)
		frappe.set_user(manager)
		purchasing.request_price_change(self.item, self.store, 36.0, reason="Weekend")
		queue = purchasing.price_change_requests(item_code=self.item)
		frappe.set_user("Administrator")
		row = queue["requests"][0]
		self.assertNotIn("wholesale", row)
		self.assertNotIn("margin_proposed", row)


# ===========================================================================
# §E — the Buying board tells the truth about a row it cannot order
# ===========================================================================
class TestBuyingBoardBlockedRows(PricingCase):
	def _suggestion(self, item: str) -> dict:
		doc = frappe.get_doc(
			{
				"doctype": "AWANZ Purchase Suggestion",
				"item_code": item,
				"item_name": item,
				"source": "Low stock",
				"sources": "Low stock",
				"suggested_qty": 5,
				"status": "Open",
				"run_id": frappe.generate_hash(length=10),
				"on_hand": 0,
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		return demand_lib.cached_row(doc)

	def test_a_row_with_no_vendor_says_why_it_cannot_be_ordered(self):
		item = ensure_item("V12-NOVENDOR-1")
		row = self._suggestion(item)
		self.assertFalse(row["orderable"])
		self.assertIn("no vendor", row["blocked_reason"].lower())
		self.assertIsNone(row["supplier"])
		frappe.set_user(WH_ADMIN)
		listed = next(r for r in purchasing.suggestions()["suggestions"] if r["item_code"] == item)
		frappe.set_user("Administrator")
		self.assertFalse(listed["orderable"])
		self.assertTrue(listed["blocked_reason"])

	def test_adding_a_vendor_inline_unblocks_the_row_the_buyer_is_looking_at(self):
		item = ensure_item("V12-NOVENDOR-2")
		self._suggestion(item)
		vendor = ensure_vendor(VENDOR)
		frappe.set_user(WH_ADMIN)
		out = purchasing.save_item_vendor(item, {"supplier": vendor, "cost": 4.0, "case_pack": 12, "moq": 24, "is_preferred": 1})
		frappe.set_user("Administrator")
		self.assertEqual(out["preferred"], vendor)
		refreshed = out["suggestion"]
		self.assertIsNotNone(refreshed, "the row on screen must be answered, not left to the overnight run")
		self.assertTrue(refreshed["orderable"])
		self.assertIsNone(refreshed["blocked_reason"])
		self.assertEqual(refreshed["supplier"], vendor)
		self.assertEqual(refreshed["case_pack"], 12)
		self.assertEqual(refreshed["suggested_qty"], 24.0, "re-rounded to the new vendor's case pack and MOQ")

	def test_an_orderable_row_is_left_alone(self):
		item = ensure_item("V12-VENDOR-3")
		vendor = ensure_vendor(VENDOR)
		frappe.set_user(WH_ADMIN)
		purchasing.save_item_vendor(item, {"supplier": vendor, "cost": 4.0, "case_pack": 1, "is_preferred": 1})
		frappe.set_user("Administrator")
		row = self._suggestion(item)
		frappe.db.set_value("AWANZ Purchase Suggestion", row["name"], "supplier", vendor, update_modified=False)
		refreshed = demand_lib.refresh_item(item)
		self.assertTrue(refreshed["orderable"])

	def test_add_items_puts_a_sheet_of_items_on_one_vendor(self):
		vendor = ensure_vendor(VENDOR)
		a, b = ensure_item("V12-ADD-1"), ensure_item("V12-ADD-2")
		frappe.set_user(WH_ADMIN)
		out = purchasing.add_vendor_items(vendor, [{"item_code": a, "cost": 3.5, "case_pack": 6}, {"item_code": b, "cost": 9.0, "moq": 10}])
		catalogue = {r["item_code"] for r in purchasing.vendor_catalogue(vendor)["items"]}
		frappe.set_user("Administrator")
		self.assertEqual(out["count"], 2)
		self.assertTrue({a, b} <= catalogue)
		self.assertEqual(flt(frappe.db.get_value("AWANZ Item Vendor", {"parent": a, "supplier": vendor}, "cost")), 3.5)

	def test_add_items_refuses_a_sheet_with_the_same_item_twice(self):
		vendor = ensure_vendor(VENDOR)
		a = ensure_item("V12-ADD-3")
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError):
			purchasing.add_vendor_items(vendor, [{"item_code": a, "cost": 1}, {"item_code": a, "cost": 2}])
		frappe.set_user("Administrator")
		self.assertFalse(frappe.db.exists("AWANZ Item Vendor", {"parent": a, "supplier": vendor}))

	def test_the_candidate_list_excludes_what_the_vendor_already_sells_and_flags_the_orphans(self):
		vendor = ensure_vendor(VENDOR)
		attached, orphan = ensure_item("V12-CAND-1"), ensure_item("V12-CAND-2")
		frappe.set_user(WH_ADMIN)
		purchasing.save_item_vendor(attached, {"supplier": vendor, "cost": 2.0})
		out = purchasing.vendor_catalogue_candidates(vendor, search="V12-CAND", limit=50)
		frappe.set_user("Administrator")
		codes = [r["item_code"] for r in out["items"]]
		self.assertNotIn(attached, codes)
		self.assertIn(orphan, codes)
		self.assertTrue(next(r for r in out["items"] if r["item_code"] == orphan)["unorderable"])

	def test_a_store_manager_may_not_add_items_to_a_vendor(self):
		vendor = ensure_vendor(VENDOR)
		item = ensure_item("V12-CAND-3")
		frappe.set_user(_manager(self.stores[0]))
		for call in (
			lambda: purchasing.vendor_catalogue_candidates(vendor),
			lambda: purchasing.add_vendor_items(vendor, [{"item_code": item, "cost": 1}]),
		):
			with self.assertRaises(frappe.PermissionError):
				call()
		frappe.set_user("Administrator")
