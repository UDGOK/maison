"""v1.0 "Procurement" — vendors, item ↔ vendor catalogue, the demand engine, purchase orders
(freight, drop-ship, send), receiving at the warehouse and at a store, moving-average valuation,
scoping and the four buying reports.

The headline test is :meth:`TestMovingAverage.test_two_vendors_two_costs_then_freight`: two
receipts of the same item from two vendors at different costs must produce the weighted average,
and freight on a third receipt must raise it. That is the whole point of the costing decision.
"""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, cint, flt, nowdate

from maison_pos.api import inventory, purchasing, reports, shipping
from maison_pos.purchasing import FREIGHT_DESCRIPTION, freight_account, main_warehouse, round_up_to_case_pack
from maison_pos.purchasing import orders as po_lib
from maison_pos.purchasing import vendors as vendor_lib
from maison_pos.purchasing import receiving as receiving_lib
from maison_pos.purchasing.demand import SOURCE_LOW_STOCK, SOURCE_STORE_DEMAND, SOURCE_TRENDING, merge_needs, suggest_qty
from maison_pos.purchasing.receiving import postable_qty
from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v0_6_warehouse import WH_ADMIN, ensure_warehouse_admin

STORE = "NYC-5AV"  # a shop, never the main warehouse (CHI-OAK on the demo profile)
OTHER_STORE = "MIA-DD"  # a second enabled shop, so a drop-ship destination can be *changed*
VENDOR_A = "AWANZ Test Distro A"
VENDOR_B = "AWANZ Test Distro B"


def _manager(boutique: str = STORE) -> str:
	return frappe.db.get_value("AWANZ Associate", {"boutique": boutique, "role": "Manager", "enabled": 1}, "user")


def _bin(item: str, warehouse: str, field: str = "actual_qty") -> float:
	return flt(frappe.db.get_value("Bin", {"item_code": item, "warehouse": warehouse}, field))


def ensure_vendor(name: str, **values) -> str:
	if not frappe.db.exists("Supplier", name):
		doc = frappe.get_doc(
			{
				"doctype": "Supplier",
				"supplier_name": name,
				"supplier_group": frappe.db.get_value("Supplier Group", {"is_group": 0}, "name") or "All Supplier Groups",
				"maison_active": 1,
				"maison_order_method": "Email",
				"maison_rep_email": f"{frappe.scrub(name)}@vendor.example",
				"maison_lead_time_days": 5,
				**values,
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
	vendor_lib.ensure_price_list(name)
	return name


def ensure_item(code: str, rate: float = 20.0) -> str:
	"""A fresh stock item with no history, pinned to Moving Average."""
	if frappe.db.exists("Item", code):
		return code
	doc = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": code,
			"item_name": code,
			"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
			"stock_uom": "Nos",
			"is_stock_item": 1,
			"valuation_method": "Moving Average",
			"include_item_in_manufacturing": 0,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


class PurchasingCase(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		ensure_warehouse_admin()

	def setUp(self):
		frappe.set_user("Administrator")
		self.sp = f"awanz_v10_{frappe.generate_hash(length=6)}"
		frappe.db.savepoint(self.sp)
		self.warehouse = main_warehouse()
		self.company = frappe.db.get_value("Warehouse", self.warehouse, "company")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point=self.sp)

	# ------------------------------------------------------------------ helpers
	def _order(self, supplier: str, item: str, qty: float, rate: float, freight: float = 0, dropship_store: str | None = None, submit: bool = True):
		po = po_lib.create_order(
			supplier,
			[{"item_code": item, "qty": qty, "rate": rate}],
			dropship_store=dropship_store,
			freight=freight,
			company=self.company,
		)
		if submit:
			po = po_lib.submit_order(po.name)
		return po


class TestMovingAverage(PurchasingCase):
	def test_valuation_is_pinned_to_moving_average(self):
		self.assertEqual(frappe.db.get_single_value("Stock Settings", "valuation_method"), "Moving Average")
		self.assertFalse(
			frappe.get_all("Item", filters={"is_stock_item": 1, "valuation_method": ("!=", "Moving Average")}, limit=1),
			"every stock item must be pinned to Moving Average by install_v10_purchasing",
		)

	def test_two_vendors_two_costs_then_freight(self):
		"""10 @ 10.00 from A, then 10 @ 14.00 from B → 12.00; then 10 @ 12.00 + 30 freight → 13.00."""
		item = ensure_item("V10-MA-1")
		a, b = ensure_vendor(VENDOR_A), ensure_vendor(VENDOR_B)
		self.assertEqual(_bin(item, self.warehouse), 0.0)

		po_a = self._order(a, item, 10, 10.00)
		shipping.receive_vendor_po(po_a.name, lines=[{"item_code": item, "qty": 10}])
		self.assertAlmostEqual(_bin(item, self.warehouse, "valuation_rate"), 10.00, places=2)

		po_b = self._order(b, item, 10, 14.00)
		shipping.receive_vendor_po(po_b.name, lines=[{"item_code": item, "qty": 10}])
		self.assertAlmostEqual(_bin(item, self.warehouse), 20.0)
		# (10 × 10.00 + 10 × 14.00) / 20 = 12.00 — the weighted average of the two vendors
		self.assertAlmostEqual(_bin(item, self.warehouse, "valuation_rate"), 12.00, places=2)

		# a third receipt at 12.00 with 30.00 freight lands at 15.00/unit, so the average rises
		po_c = self._order(a, item, 10, 12.00, freight=30.0)
		out = shipping.receive_vendor_po(po_c.name, lines=[{"item_code": item, "qty": 10}])
		self.assertAlmostEqual(flt(out["freight"]), 30.0)
		self.assertAlmostEqual(_bin(item, self.warehouse), 30.0)
		# (20 × 12.00 + 10 × 15.00) / 30 = 13.00
		self.assertAlmostEqual(_bin(item, self.warehouse, "valuation_rate"), 13.00, places=2)
		self.assertAlmostEqual(_bin(item, self.warehouse, "stock_value"), 390.0, places=2)

	def test_freight_raises_the_receipt_valuation_rate(self):
		"""Freight is in valuation, not in the payable total — that is what makes it landed cost."""
		item = ensure_item("V10-MA-2")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 20, 5.00, freight=40.0)
		self.assertAlmostEqual(flt(po.net_total), 100.0)
		out = shipping.receive_vendor_po(po.name, lines=[{"item_code": item, "qty": 20}])
		pr = frappe.get_doc("Purchase Receipt", out["purchase_receipt"])
		self.assertAlmostEqual(flt(pr.items[0].valuation_rate), 7.00, places=2)  # 5.00 + 40/20
		self.assertAlmostEqual(_bin(item, self.warehouse, "valuation_rate"), 7.00, places=2)


class TestVendors(PurchasingCase):
	def test_saving_a_vendor_creates_its_buying_price_list(self):
		frappe.set_user(WH_ADMIN)
		out = purchasing.save_vendor(
			{"supplier_name": "AWANZ Test Glassworks", "lead_time_days": 9, "dropship_capable": 1, "rep_email": "rep@glass.example", "account_number": "CCZ-7781"}
		)
		self.assertEqual(out["price_list"], "AWANZ Test Glassworks Buying")
		self.assertTrue(frappe.db.get_value("Price List", out["price_list"], "buying"))
		self.assertEqual(out["vendor"]["lead_time_days"], 9)
		self.assertEqual(out["vendor"]["account_number"], "CCZ-7781")
		self.assertTrue(out["vendor"]["active"])
		# idempotent
		purchasing.save_vendor({"name": "AWANZ Test Glassworks", "supplier_name": "AWANZ Test Glassworks", "lead_time_days": 4})
		self.assertEqual(cint(frappe.db.get_value("Supplier", "AWANZ Test Glassworks", "maison_lead_time_days")), 4)

	def test_deactivate_rather_than_delete(self):
		v = ensure_vendor(VENDOR_A)
		frappe.set_user(WH_ADMIN)
		purchasing.set_vendor_active(v, 0)
		self.assertTrue(cint(frappe.db.get_value("Supplier", v, "disabled")))
		self.assertNotIn(v, [r["name"] for r in purchasing.vendors(active_only=1)["vendors"]])
		self.assertIn(v, [r["name"] for r in purchasing.vendors(active_only=0)["vendors"]])
		purchasing.set_vendor_active(v, 1)
		self.assertIn(v, [r["name"] for r in purchasing.vendors(active_only=1)["vendors"]])

	def test_cost_writes_through_to_the_vendor_price_list(self):
		item = ensure_item("V10-CAT-1")
		a, b = ensure_vendor(VENDOR_A), ensure_vendor(VENDOR_B)
		frappe.set_user(WH_ADMIN)
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 4.25, "case_pack": 6, "moq": 12, "vendor_sku": "A-1", "is_preferred": 1})
		out = purchasing.save_item_vendor(item, {"supplier": b, "cost": 4.60, "case_pack": 10, "vendor_sku": "B-9"})
		self.assertEqual(out["preferred"], a)
		self.assertEqual(len(out["vendors"]), 2)
		self.assertAlmostEqual(
			flt(frappe.db.get_value("Item Price", {"item_code": item, "price_list": f"{a} Buying", "supplier": a}, "price_list_rate")), 4.25
		)
		self.assertAlmostEqual(
			flt(frappe.db.get_value("Item Price", {"item_code": item, "price_list": f"{b} Buying", "supplier": b}, "price_list_rate")), 4.60
		)
		# a PO for B defaults to B's rate; a PO for A to A's
		self.assertAlmostEqual(vendor_lib.vendor_rate(item, b), 4.60)
		po = po_lib.create_order(b, [{"item_code": item, "qty": 10}], company=self.company)
		self.assertAlmostEqual(flt(po.items[0].rate), 4.60)

	def test_exactly_one_preferred_vendor(self):
		item = ensure_item("V10-CAT-2")
		a, b = ensure_vendor(VENDOR_A), ensure_vendor(VENDOR_B)
		frappe.set_user(WH_ADMIN)
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 3.0, "is_preferred": 1})
		purchasing.save_item_vendor(item, {"supplier": b, "cost": 3.5, "is_preferred": 1})
		rows = purchasing.item_vendors(item)
		self.assertEqual([r["supplier"] for r in rows["vendors"] if r["is_preferred"]], [b])
		out = purchasing.set_preferred_vendor(item, a)
		self.assertEqual([r["supplier"] for r in out["vendors"] if r["is_preferred"]], [a])
		# removing a row leaves exactly one preferred behind
		row_b = next(r for r in out["vendors"] if r["supplier"] == b)
		left = purchasing.remove_item_vendor(item, row_b["name"])
		self.assertEqual([r["supplier"] for r in left["vendors"]], [a])
		self.assertEqual(len([r for r in left["vendors"] if r["is_preferred"]]), 1)

	def test_a_vendor_row_may_carry_no_cost(self):
		item = ensure_item("V10-CAT-3")
		a = ensure_vendor(VENDOR_A)
		frappe.set_user(WH_ADMIN)
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 0, "vendor_sku": "ASK"})
		self.assertFalse(frappe.db.exists("Item Price", {"item_code": item, "price_list": f"{a} Buying"}))
		self.assertEqual(purchasing.item_vendors(item)["vendors"][0]["cost"], 0.0)

	def test_the_vendor_catalogue_carries_the_row_name_that_removes_it(self):
		"""The Vendors screen removes a catalogue line without a second round trip per row."""
		item = ensure_item("V10-CAT-4")
		a, b = ensure_vendor(VENDOR_A), ensure_vendor(VENDOR_B)
		frappe.set_user(WH_ADMIN)
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 4.0, "is_preferred": 1})
		purchasing.save_item_vendor(item, {"supplier": b, "cost": 4.4, "vendor_sku": "B-4400"})

		row = next(r for r in purchasing.vendor(b)["catalogue"] if r["item_code"] == item)
		self.assertTrue(row["name"], "every catalogue row carries its AWANZ Item Vendor row name")
		self.assertEqual(row["name"], next(v["name"] for v in purchasing.item_vendors(item)["vendors"] if v["supplier"] == b))

		# and that name is exactly what remove_item_vendor takes
		left = purchasing.remove_item_vendor(item, row["name"])
		self.assertEqual([v["supplier"] for v in left["vendors"]], [a])
		self.assertFalse([r for r in purchasing.vendor(b)["catalogue"] if r["item_code"] == item])


class TestDemand(PurchasingCase):
	def test_case_pack_rounding_and_moq(self):
		self.assertEqual(round_up_to_case_pack(1, 6), 6)
		self.assertEqual(round_up_to_case_pack(6, 6), 6)
		self.assertEqual(round_up_to_case_pack(7, 6), 12)
		self.assertEqual(round_up_to_case_pack(0, 6), 0)
		# MOQ lifts the answer, and is itself rounded to a whole case
		self.assertEqual(round_up_to_case_pack(4, 6, moq=20), 24)
		self.assertEqual(round_up_to_case_pack(30, 6, moq=20), 30)
		# what is already on order comes off the need first
		self.assertEqual(suggest_qty(need=20, on_order=8, case_pack=6), 12)
		self.assertEqual(suggest_qty(need=20, on_order=20, case_pack=6), 0)

	def test_dedup_keeps_the_largest_need_and_the_most_urgent_badge(self):
		merged = merge_needs(
			[
				{"item_code": "X", "source": SOURCE_TRENDING, "need": 5, "velocity": 1.2},
				{"item_code": "X", "source": SOURCE_STORE_DEMAND, "need": 18, "store_demand": 18},
				{"item_code": "X", "source": SOURCE_LOW_STOCK, "need": 9, "reorder_level": 20},
				{"item_code": "Y", "source": SOURCE_TRENDING, "need": 3},
			]
		)
		self.assertEqual(sorted(merged), ["X", "Y"])
		self.assertEqual(merged["X"]["need"], 18)
		self.assertEqual(merged["X"]["source"], SOURCE_LOW_STOCK)
		self.assertEqual(merged["X"]["sources"], [SOURCE_LOW_STOCK, SOURCE_STORE_DEMAND, SOURCE_TRENDING])
		self.assertEqual(merged["X"]["reorder_level"], 20)
		self.assertEqual(merged["X"]["velocity"], 1.2)

	def test_suggestions_pick_the_preferred_vendor_and_round_to_its_case_pack(self):
		item = ensure_item("V10-SUG-1")
		a, b = ensure_vendor(VENDOR_A), ensure_vendor(VENDOR_B)
		frappe.set_user("Administrator")
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 2.0, "case_pack": 12, "moq": 24, "is_preferred": 1})
		purchasing.save_item_vendor(item, {"supplier": b, "cost": 2.4, "case_pack": 10})
		doc = frappe.get_doc("Item", item)
		doc.append("reorder_levels", {"warehouse": self.warehouse, "warehouse_reorder_level": 30, "warehouse_reorder_qty": 30, "material_request_type": "Purchase"})
		doc.flags.ignore_permissions = True
		doc.save()

		frappe.set_user(WH_ADMIN)
		out = purchasing.suggestions(refresh=1)
		row = next((r for r in out["suggestions"] if r["item_code"] == item), None)
		self.assertIsNotNone(row, "a warehouse item under its reorder level must be suggested")
		self.assertEqual(row["source"], SOURCE_LOW_STOCK)
		self.assertEqual(row["supplier"], a)
		self.assertEqual(row["suggested_qty"], 36)  # need 30 → 3 cases of 12, above the MOQ of 24
		self.assertEqual([v["supplier"] for v in row["vendors"]], [a, b])
		self.assertTrue(frappe.db.exists("AWANZ Purchase Suggestion", {"item_code": item, "status": "Open"}))

		# create_orders groups by vendor and marks the suggestion Ordered
		created = purchasing.create_orders([{"item_code": item, "qty": 36, "supplier": a, "suggestion": row["name"], "rate": 1.95}])
		self.assertEqual(len(created["orders"]), 1)
		po = frappe.get_doc("Purchase Order", created["orders"][0])
		self.assertEqual(po.docstatus, 0)
		self.assertAlmostEqual(flt(po.items[0].rate), 1.95)  # the buyer's override, not the list price
		self.assertEqual(frappe.db.get_value("AWANZ Purchase Suggestion", row["name"], "status"), "Ordered")

		# dismissing an item keeps it off the next run
		out2 = purchasing.suggestions(refresh=1)
		row2 = next((r for r in out2["suggestions"] if r["item_code"] == item), None)
		if row2:
			purchasing.dismiss_suggestion(row2["name"], "seasonal, not now")
			out3 = purchasing.suggestions(refresh=1)
			self.assertNotIn(item, [r["item_code"] for r in out3["suggestions"]])

	def test_store_demand_only_counts_the_shortfall(self):
		from maison_pos.purchasing.demand import store_demand_needs

		item = ensure_item("V10-SUG-2")
		frappe.set_user("Administrator")
		req = frappe.get_doc(
			{
				"doctype": "AWANZ Replenishment Request",
				"boutique": STORE,
				"status": "Pending Approval",
				"to_warehouse": frappe.db.get_value("AWANZ Store", STORE, "warehouse"),
				"from_warehouse": self.warehouse,
				"lines": [{"item_code": item, "qty": 25}],
			}
		)
		req.flags.ignore_permissions = True
		req.insert()
		# 10 on hand at the warehouse → only 15 need buying
		needs = {r["item_code"]: r for r in store_demand_needs(self.warehouse, {item: 10.0})}
		self.assertAlmostEqual(needs[item]["need"], 15.0)
		self.assertAlmostEqual(needs[item]["store_demand"], 25.0)
		self.assertEqual(needs[item]["requests"], [req.name])
		# nothing to buy once the warehouse can fill it
		self.assertNotIn(item, {r["item_code"] for r in store_demand_needs(self.warehouse, {item: 40.0})})


class TestOrders(PurchasingCase):
	def test_freight_is_one_maintained_valuation_row_and_zero_removes_it(self):
		item = ensure_item("V10-PO-1")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 10, 6.0, freight=25.0, submit=False)
		rows = [t for t in po.taxes if (t.description or "").strip() == FREIGHT_DESCRIPTION]
		self.assertEqual(len(rows), 1)
		row = rows[0]
		self.assertEqual((row.charge_type, row.category, row.add_deduct_tax), ("Actual", "Valuation", "Add"))
		self.assertEqual(row.account_head, freight_account(self.company))
		self.assertAlmostEqual(flt(row.tax_amount), 25.0)
		# a Valuation charge never touches the payable total
		self.assertAlmostEqual(flt(po.grand_total), 60.0)

		po = po_lib.update_order(po.name, freight=40.0)
		self.assertEqual(len([t for t in po.taxes if (t.description or "").strip() == FREIGHT_DESCRIPTION]), 1)
		self.assertAlmostEqual(flt(po_lib.freight_of(po)), 40.0)

		po = po_lib.update_order(po.name, freight=0)
		self.assertEqual([t for t in po.taxes if (t.description or "").strip() == FREIGHT_DESCRIPTION], [])
		self.assertAlmostEqual(flt(po.maison_freight_amount), 0.0)

	def test_every_rate_is_overridable(self):
		item = ensure_item("V10-PO-2")
		a = ensure_vendor(VENDOR_A)
		frappe.set_user("Administrator")
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 8.0, "is_preferred": 1})
		po = po_lib.create_order(a, [{"item_code": item, "qty": 5}], company=self.company)
		self.assertAlmostEqual(flt(po.items[0].rate), 8.0)  # from the vendor's price list
		po = po_lib.update_order(po.name, lines=[{"item_code": item, "qty": 5, "rate": 7.25}])
		self.assertAlmostEqual(flt(po.items[0].rate), 7.25)  # the buyer's override survives the save
		self.assertAlmostEqual(flt(po.net_total), 36.25)

	def test_dropship_points_every_line_at_one_enabled_store(self):
		item = ensure_item("V10-PO-3")
		a = ensure_vendor(VENDOR_A, maison_dropship_capable=1)
		store_wh = frappe.db.get_value("AWANZ Store", STORE, "warehouse")
		po = self._order(a, item, 4, 9.0, dropship_store=STORE, submit=False)
		self.assertEqual(po.set_warehouse, store_wh)
		self.assertEqual({r.warehouse for r in po.items}, {store_wh})
		po_lib.submit_order(po.name)
		self.assertEqual(frappe.db.get_value("Purchase Order", po.name, "docstatus"), 1)

		# a line pointing somewhere else is refused on submit
		po2 = self._order(a, item, 4, 9.0, dropship_store=STORE, submit=False)
		frappe.db.set_value("Purchase Order Item", po2.items[0].name, "warehouse", self.warehouse, update_modified=False)
		doc = frappe.get_doc("Purchase Order", po2.name)
		doc.items[0].warehouse = self.warehouse
		doc.flags.ignore_permissions = True
		with self.assertRaises(frappe.ValidationError):
			po_lib.validate_dropship(doc)

		# a disabled store cannot be drop-shipped to
		frappe.db.set_value("AWANZ Store", STORE, "enabled", 0, update_modified=False)
		frappe.clear_document_cache("AWANZ Store", STORE)
		try:
			with self.assertRaises(frappe.ValidationError):
				po_lib.create_order(a, [{"item_code": item, "qty": 1, "rate": 1}], dropship_store=STORE, company=self.company)
		finally:
			frappe.db.set_value("AWANZ Store", STORE, "enabled", 1, update_modified=False)
			frappe.clear_document_cache("AWANZ Store", STORE)

	def test_the_order_list_row_carries_its_units(self):
		"""``order_dict(with_items=False)`` still counts the lines — the order list has a units column."""
		first, second = ensure_item("V10-PO-8"), ensure_item("V10-PO-9")
		a = ensure_vendor(VENDOR_A)
		po = po_lib.create_order(
			a, [{"item_code": first, "qty": 12, "rate": 4.0}, {"item_code": second, "qty": 30, "rate": 1.5}], company=self.company
		)
		row = receiving_lib.order_dict(frappe.get_doc("Purchase Order", po.name), with_items=False)
		self.assertNotIn("items", row)  # the list really is the cheap serialisation
		self.assertAlmostEqual(flt(row["units"]), 42.0)

		frappe.set_user(WH_ADMIN)
		listed = next(o for o in purchasing.orders(status="all", supplier=a)["orders"] if o["name"] == po.name)
		self.assertAlmostEqual(flt(listed["units"]), 42.0)
		# and the detail agrees with the list
		self.assertAlmostEqual(flt(purchasing.order(po.name)["units"]), 42.0)

	def test_dropship_is_set_changed_and_cleared_on_a_draft(self):
		item, extra = ensure_item("V10-PO-10"), ensure_item("V10-PO-11")
		a = ensure_vendor(VENDOR_A, maison_dropship_capable=1)
		here = frappe.db.get_value("AWANZ Store", STORE, "warehouse")
		there = frappe.db.get_value("AWANZ Store", OTHER_STORE, "warehouse")
		po = po_lib.create_order(a, [{"item_code": item, "qty": 6, "rate": 3.0}], company=self.company)
		self.assertFalse(po.maison_dropship_store)
		self.assertEqual(po.set_warehouse, self.warehouse)

		frappe.set_user(WH_ADMIN)
		out = purchasing.update_order(po.name, dropship_store=STORE)
		self.assertEqual(out["dropship_store"], STORE)
		self.assertEqual(out["set_warehouse"], here)
		self.assertEqual({line["warehouse"] for line in out["items"]}, {here})

		# changed to another store — the header and every line follow
		out = purchasing.update_order(po.name, dropship_store=OTHER_STORE)
		self.assertEqual(out["dropship_store"], OTHER_STORE)
		self.assertEqual(out["set_warehouse"], there)
		self.assertEqual({line["warehouse"] for line in out["items"]}, {there})

		# a line added in the same breath lands on the store warehouse too, and it submits
		out = purchasing.update_order(
			po.name, lines=[{"item_code": item, "qty": 6}, {"item_code": extra, "qty": 4}], dropship_store=OTHER_STORE
		)
		self.assertEqual({line["warehouse"] for line in out["items"]}, {there})
		self.assertAlmostEqual(flt(out["units"]), 10.0)
		doc = frappe.get_doc("Purchase Order", po.name)
		po_lib.validate_dropship(doc)  # what before_submit enforces

		# cleared — everything back on the main Houston warehouse, and nothing re-stamps it
		out = purchasing.update_order(po.name, dropship_store=None)
		self.assertFalse(out["dropship_store"])
		self.assertEqual(out["set_warehouse"], self.warehouse)
		self.assertEqual({line["warehouse"] for line in out["items"]}, {self.warehouse})
		self.assertFalse(frappe.db.get_value("Purchase Order", po.name, "maison_dropship_store"))

		# "" clears it too, and leaving the argument out leaves the destination alone
		purchasing.update_order(po.name, dropship_store=STORE)
		out = purchasing.update_order(po.name, freight=12)
		self.assertEqual(out["dropship_store"], STORE)
		self.assertAlmostEqual(flt(out["freight"]), 12.0)
		out = purchasing.update_order(po.name, dropship_store="")
		self.assertFalse(out["dropship_store"])
		self.assertEqual(out["set_warehouse"], self.warehouse)

	def test_the_dropship_destination_of_a_submitted_order_cannot_be_changed(self):
		item = ensure_item("V10-PO-12")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 4, 5.0)  # submitted, addressed to the warehouse
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError) as ctx:
			purchasing.update_order(po.name, dropship_store=STORE)
		self.assertIn("submitted", str(ctx.exception))
		row = frappe.db.get_value("Purchase Order", po.name, ["maison_dropship_store", "set_warehouse"], as_dict=True)
		self.assertFalse(row.maison_dropship_store)
		self.assertEqual(row.set_warehouse, self.warehouse)

	def test_a_disabled_store_cannot_be_made_the_dropship_destination(self):
		item = ensure_item("V10-PO-13")
		a = ensure_vendor(VENDOR_A)
		po = po_lib.create_order(a, [{"item_code": item, "qty": 2, "rate": 1.0}], company=self.company)
		frappe.db.set_value("AWANZ Store", STORE, "enabled", 0, update_modified=False)
		frappe.clear_document_cache("AWANZ Store", STORE)
		try:
			frappe.set_user(WH_ADMIN)
			with self.assertRaises(frappe.ValidationError):
				purchasing.update_order(po.name, dropship_store=STORE)
		finally:
			frappe.set_user("Administrator")
			frappe.db.set_value("AWANZ Store", STORE, "enabled", 1, update_modified=False)
			frappe.clear_document_cache("AWANZ Store", STORE)
		self.assertEqual(frappe.db.get_value("Purchase Order", po.name, "set_warehouse"), self.warehouse)

	def test_deleting_a_draft_puts_its_suggestions_back_on_the_buying_list(self):
		item = ensure_item("V10-PO-14")
		a = ensure_vendor(VENDOR_A)
		frappe.set_user("Administrator")
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 3.5, "case_pack": 6, "is_preferred": 1})
		suggestion = frappe.get_doc(
			{
				"doctype": "AWANZ Purchase Suggestion",
				"item_code": item,
				"item_name": item,
				"source": SOURCE_LOW_STOCK,
				"status": "Open",
				"supplier": a,
				"cost": 3.5,
				"suggested_qty": 12,
				"case_pack": 6,
				"run_id": "v10-delete-order",
			}
		)
		suggestion.flags.ignore_permissions = True
		suggestion.insert()

		frappe.set_user(WH_ADMIN)
		draft = purchasing.create_orders([{"item_code": item, "qty": 12, "supplier": a, "suggestion": suggestion.name}])["orders"][0]
		self.assertEqual(frappe.db.get_value("AWANZ Purchase Suggestion", suggestion.name, "purchase_order"), draft)

		out = purchasing.delete_order(draft, "the buyer changed their mind")
		self.assertEqual(out["deleted"], draft)
		self.assertEqual(out["suggestions_reopened"], [suggestion.name])
		self.assertFalse(frappe.db.exists("Purchase Order", draft))
		row = frappe.db.get_value("AWANZ Purchase Suggestion", suggestion.name, ["status", "purchase_order"], as_dict=True)
		self.assertEqual(row.status, "Open")
		self.assertFalse(row.purchase_order)
		# the item is back on the list the buyer works from
		self.assertIn(item, [r["item_code"] for r in purchasing.suggestions()["suggestions"]])

	def test_a_submitted_order_is_closed_not_deleted(self):
		item = ensure_item("V10-PO-15")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 3, 5.0)
		frappe.set_user(WH_ADMIN)
		with self.assertRaises(frappe.ValidationError) as ctx:
			purchasing.delete_order(po.name, "no longer needed")
		self.assertIn("close it", str(ctx.exception).lower())
		self.assertTrue(frappe.db.exists("Purchase Order", po.name))

	def test_a_desk_order_to_a_store_warehouse_is_stamped_as_dropship(self):
		item = ensure_item("V10-PO-4")
		a = ensure_vendor(VENDOR_A)
		store_wh = frappe.db.get_value("AWANZ Store", STORE, "warehouse")
		po = frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"supplier": a,
				"company": self.company,
				"transaction_date": nowdate(),
				"schedule_date": add_days(nowdate(), 3),
				"set_warehouse": store_wh,
				"items": [{"item_code": item, "qty": 2, "rate": 3, "warehouse": store_wh, "schedule_date": add_days(nowdate(), 3)}],
			}
		)
		po.flags.ignore_permissions = True
		po.insert()
		self.assertEqual(po.maison_dropship_store, STORE)

	def test_send_order_stamps_who_sent_it_and_how(self):
		item = ensure_item("V10-PO-5")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 3, 5.0)
		frappe.set_user(WH_ADMIN)
		out = purchasing.send_order(po.name, method="Phone")
		self.assertEqual(out["method"], "Phone")
		row = frappe.db.get_value("Purchase Order", po.name, ["maison_sent_method", "maison_sent_by", "maison_sent_on"], as_dict=True)
		self.assertEqual(row.maison_sent_method, "Phone")
		self.assertEqual(row.maison_sent_by, WH_ADMIN)
		self.assertTrue(row.maison_sent_on)
		with self.assertRaises(frappe.ValidationError):
			purchasing.send_order(po.name, method="Carrier Pigeon")

	def test_purchase_order_print_format_renders(self):
		item = ensure_item("V10-PO-6")
		a = ensure_vendor(VENDOR_A, maison_account_number="CCZ-4410")
		frappe.set_user("Administrator")
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 5.0, "vendor_sku": "SKU-4410", "is_preferred": 1})
		po = self._order(a, item, 6, 5.0, freight=12.0)
		html = frappe.get_print("Purchase Order", po.name, "AWANZ Purchase Order", no_letterhead=1)
		self.assertIn(po.name, html)
		self.assertIn("SKU-4410", html)
		self.assertIn("CCZ-4410", html)
		self.assertIn("Purchase order", html)

	def test_close_order(self):
		item = ensure_item("V10-PO-7")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 3, 5.0)
		frappe.set_user(WH_ADMIN)
		purchasing.close_order(po.name, "vendor discontinued the line")
		self.assertEqual(frappe.db.get_value("Purchase Order", po.name, "status"), "Closed")


class TestReceiving(PurchasingCase):
	def test_over_receipt_is_capped_at_what_erpnext_allows(self):
		self.assertEqual(postable_qty(ordered=10, already=0, wanted=12, allowance=0), 10)
		self.assertEqual(postable_qty(ordered=10, already=0, wanted=12, allowance=25), 12)
		self.assertEqual(postable_qty(ordered=10, already=6, wanted=6, allowance=0), 4)

	def test_warehouse_receipt_overrides_the_cost_and_raises_a_vendor_discrepancy(self):
		item = ensure_item("V10-RCV-1")
		a = ensure_vendor(VENDOR_A)
		frappe.set_user("Administrator")
		purchasing.save_item_vendor(item, {"supplier": a, "cost": 10.0, "is_preferred": 1})
		po = self._order(a, item, 10, 10.0)
		frappe.set_user(WH_ADMIN)
		out = purchasing.receive(po.name, lines=[{"item_code": item, "qty": 8, "rate": 11.5}], final=1)
		self.assertEqual(_bin(item, self.warehouse), 8)
		self.assertAlmostEqual(_bin(item, self.warehouse, "valuation_rate"), 11.5, places=2)
		self.assertEqual(len(out["discrepancies"]), 1)
		d = frappe.get_doc("AWANZ Receiving Discrepancy", out["discrepancies"][0])
		self.assertEqual((d.type, d.supplier, d.purchase_order, flt(d.short_qty)), ("Short", a, po.name, 2.0))
		# the item-vendor row remembers what we actually paid
		row = frappe.db.get_value(
			"AWANZ Item Vendor", {"parent": item, "parenttype": "Item", "supplier": a}, ["last_purchase_rate", "last_purchase_date"], as_dict=True
		)
		self.assertAlmostEqual(flt(row.last_purchase_rate), 11.5)
		self.assertEqual(str(row.last_purchase_date), nowdate())
		# a vendor discrepancy resolves without touching stock
		res = shipping.resolve_discrepancy(d.name, "Accepted", notes="credit agreed with the rep")
		self.assertEqual(res["status"], "Resolved")
		self.assertIsNone(res["reship_request"])

	def test_final_closes_the_order_so_it_stops_expecting_more(self):
		"""``final=1`` means "that was the whole delivery".

		It used to raise the shorts against the vendor and leave the order *To Receive*, so it sat
		on the Inbound expected list forever with units already settled — while both the receive
		sheet's toggle copy and ``receiveOutcome`` promised it was closed. Caught by
		``e2e/purchasing.e2e.mjs``.
		"""
		item = ensure_item("V10-RCV-FINAL")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 10, 4.0)
		frappe.set_user(WH_ADMIN)
		out = purchasing.receive(po.name, lines=[{"item_code": item, "qty": 8}], final=1)
		self.assertTrue(out["closed"])
		self.assertEqual(frappe.db.get_value("Purchase Order", po.name, "status"), "Closed")
		# and it is off the Inbound expected list
		self.assertNotIn(po.name, [p["name"] for p in purchasing.inbound()["purchase_orders"]])

	def test_a_partial_receipt_leaves_the_order_open(self):
		"""The mirror of the above: without ``final`` the order must keep expecting the rest."""
		item = ensure_item("V10-RCV-OPEN")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 10, 4.0)
		frappe.set_user(WH_ADMIN)
		out = purchasing.receive(po.name, lines=[{"item_code": item, "qty": 6}])
		self.assertFalse(out.get("closed"))
		self.assertNotEqual(frappe.db.get_value("Purchase Order", po.name, "status"), "Closed")
		self.assertIn(po.name, [p["name"] for p in purchasing.inbound()["purchase_orders"]])

	def test_a_fully_received_final_receipt_closes_the_order_too(self):
		"""A complete delivery still needs closing here, because we do not bill in this system.

		ERPNext only reaches *Completed* when an order is fully received **and** fully billed.
		v1.0 deliberately leaves purchase invoices in the client's accounting package (see
		SPEC_v1.0 "out of scope"), so ``per_billed`` never moves and a fully-received order would
		otherwise sit at *To Bill* on the Inbound list for ever. ``final`` closes it.
		"""
		item = ensure_item("V10-RCV-FULL")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 10, 4.0)
		frappe.set_user(WH_ADMIN)
		out = purchasing.receive(po.name, lines=[{"item_code": item, "qty": 10}], final=1)
		self.assertTrue(out["closed"])
		self.assertEqual(frappe.db.get_value("Purchase Order", po.name, "status"), "Closed")
		self.assertAlmostEqual(flt(frappe.db.get_value("Purchase Order", po.name, "per_received")), 100.0)
		self.assertNotIn(po.name, [p["name"] for p in purchasing.inbound()["purchase_orders"]])

	def test_a_partial_receipt_raises_nothing(self):
		item = ensure_item("V10-RCV-2")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 10, 4.0)
		frappe.set_user(WH_ADMIN)
		out = purchasing.receive(po.name, lines=[{"item_code": item, "qty": 6}])
		self.assertEqual(out["discrepancies"], [])
		self.assertAlmostEqual(flt(frappe.db.get_value("Purchase Order", po.name, "per_received")), 60.0)

	def test_damaged_units_go_to_the_damaged_warehouse(self):
		from maison_pos.setup.install_v04_inventory import ensure_damaged_warehouse

		item = ensure_item("V10-RCV-3")
		a = ensure_vendor(VENDOR_A)
		store = frappe.db.get_value("AWANZ Store", {"warehouse": self.warehouse}, "name")
		damaged = ensure_damaged_warehouse(store) if store else None
		self.assertTrue(damaged, "the receiving warehouse needs a Damaged warehouse")
		po = self._order(a, item, 10, 4.0)
		frappe.set_user(WH_ADMIN)
		out = purchasing.receive(po.name, lines=[{"item_code": item, "qty": 10, "damaged_qty": 2}])
		self.assertEqual(_bin(item, self.warehouse), 8)
		self.assertEqual(_bin(item, damaged), 2)
		self.assertEqual([frappe.db.get_value("AWANZ Receiving Discrepancy", n, "type") for n in out["discrepancies"]], ["Damaged"])

	def test_store_receives_a_dropship_order_through_the_existing_receive_flow(self):
		item = ensure_item("V10-RCV-4")
		a = ensure_vendor(VENDOR_A, maison_dropship_capable=1)
		store_wh = frappe.db.get_value("AWANZ Store", STORE, "warehouse")
		po = self._order(a, item, 6, 7.0, dropship_store=STORE)
		manager = _manager(STORE)

		# it shows up on the store's own Receive screen, and not on another store's
		frappe.set_user(manager)
		inbound = inventory.inbound(STORE)
		self.assertIn(po.name, [p["name"] for p in inbound["purchase_orders"]])

		before = _bin(item, store_wh)
		out = inventory.receive_po(po.name, lines=[{"item_code": item, "qty": 5, "rate": 7.5}], boutique=STORE, final=1)
		self.assertEqual(_bin(item, store_wh), before + 5)
		self.assertEqual(frappe.db.get_value("Purchase Receipt", out["purchase_receipt"], "set_warehouse"), store_wh)
		self.assertEqual(len(out["discrepancies"]), 1)
		d = frappe.get_doc("AWANZ Receiving Discrepancy", out["discrepancies"][0])
		self.assertEqual((d.type, d.supplier, d.boutique), ("Short", a, STORE))

	def test_a_shipment_can_name_the_vendor_order_it_came_from(self):
		item = ensure_item("V10-RCV-5")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 4, 3.0)
		sh = frappe.get_doc(
			{
				"doctype": "AWANZ Shipment",
				"boutique": STORE,
				"from_warehouse": self.warehouse,
				"to_warehouse": frappe.db.get_value("AWANZ Store", STORE, "warehouse"),
				"status": "Pending",
				"source_purchase_order": po.name,
				"lines": [{"item_code": item, "qty": 2}],
			}
		)
		sh.flags.ignore_permissions = True
		sh.insert()
		self.assertEqual(frappe.db.get_value("AWANZ Shipment", sh.name, "source_purchase_order"), po.name)


class TestPurchasingScoping(PurchasingCase):
	def test_a_store_manager_may_not_buy(self):
		item = ensure_item("V10-SEC-1")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 2, 5.0, dropship_store=STORE)
		frappe.set_user(_manager(STORE))
		for call in (
			lambda: purchasing.vendors(),
			lambda: purchasing.vendor(a),
			lambda: purchasing.save_vendor({"supplier_name": "Sneaky Vendor"}),
			lambda: purchasing.set_vendor_active(a, 0),
			lambda: purchasing.item_vendors(item),
			lambda: purchasing.save_item_vendor(item, {"supplier": a, "cost": 1}),
			lambda: purchasing.set_preferred_vendor(item, a),
			lambda: purchasing.suggestions(),
			lambda: purchasing.create_orders([{"item_code": item, "qty": 1, "supplier": a}]),
			lambda: purchasing.orders(),
			lambda: purchasing.create_order(a, [{"item_code": item, "qty": 1}]),
			lambda: purchasing.update_order(po.name, freight=5),
			lambda: purchasing.update_order(po.name, dropship_store=OTHER_STORE),
			lambda: purchasing.submit_order(po.name),
			lambda: purchasing.send_order(po.name, "Email"),
			lambda: purchasing.close_order(po.name, "no"),
			lambda: purchasing.delete_order(po.name, "no"),
			lambda: purchasing.inbound(),
			lambda: purchasing.receive(po.name, [{"item_code": item, "qty": 1}]),
			lambda: purchasing.stock(),
		):
			with self.assertRaises(frappe.PermissionError):
				call()
		self.assertFalse(frappe.db.exists("Supplier", "Sneaky Vendor"))

	def test_a_store_manager_may_read_only_their_own_store_order(self):
		item = ensure_item("V10-SEC-2")
		a = ensure_vendor(VENDOR_A)
		mine = self._order(a, item, 2, 5.0, dropship_store=STORE)
		theirs = self._order(a, item, 2, 5.0, dropship_store="MIA-DD")
		warehouse_order = self._order(a, item, 2, 5.0)
		frappe.set_user(_manager(STORE))
		self.assertEqual(purchasing.order(mine.name)["name"], mine.name)
		with self.assertRaises(frappe.PermissionError):
			purchasing.order(theirs.name)
		with self.assertRaises(frappe.PermissionError):
			purchasing.order(warehouse_order.name)
		# and they cannot receive another store's delivery
		with self.assertRaises(frappe.PermissionError):
			inventory.receive_po(theirs.name, lines=[{"item_code": item, "qty": 1}], boutique="MIA-DD")

	def test_warehouse_admin_and_head_office_may_buy_regional_may_not(self):
		frappe.set_user(WH_ADMIN)
		self.assertIsInstance(purchasing.vendors()["vendors"], list)
		regional = frappe.db.get_value("AWANZ Associate", {"role": "Regional", "enabled": 1}, "user")
		if regional:
			frappe.set_user(regional)
			with self.assertRaises(frappe.PermissionError):
				purchasing.vendors()


class TestPurchasingReports(PurchasingCase):
	def test_the_four_reports_are_registered_and_run(self):
		names = ["AWANZ Purchase by Vendor", "AWANZ Item Purchase History", "AWANZ Open Purchase Orders", "AWANZ Drop-ship Deliveries"]
		self.assertTrue(set(names) <= reports.REPORT_NAMES)
		item = ensure_item("V10-RPT-1")
		a = ensure_vendor(VENDOR_A)
		po = self._order(a, item, 10, 6.0, freight=20.0)
		frappe.set_user(WH_ADMIN)
		purchasing.receive(po.name, lines=[{"item_code": item, "qty": 10}], final=1)
		dropship = self._order(a, item, 3, 6.0, dropship_store=STORE)
		self.assertTrue(dropship.name)
		for name in names:
			out = reports.run(name, {"from_date": add_days(nowdate(), -30), "to_date": nowdate()})
			self.assertTrue(out["columns"], name)
		history = reports.run("AWANZ Item Purchase History", {"item_code": item})
		row = next(r for r in history["rows"] if r["item_code"] == item)
		self.assertAlmostEqual(row["freight_share"], 20.0)
		self.assertAlmostEqual(row["landed_cost"], 8.0)  # (60 + 20) / 10
		open_pos = reports.run("AWANZ Open Purchase Orders", {})
		self.assertIn(dropship.name, [r["name"] for r in open_pos["rows"]])
		drop = reports.run("AWANZ Drop-ship Deliveries", {})
		self.assertIn(dropship.name, [r["name"] for r in drop["rows"]])

	def test_a_store_manager_cannot_run_a_buying_report(self):
		frappe.set_user(_manager(STORE))
		with self.assertRaises(frappe.PermissionError):
			reports.run("AWANZ Purchase by Vendor", {})
		listed = [r["name"] for r in reports.list_reports()["reports"]]
		self.assertNotIn("AWANZ Purchase by Vendor", listed)
		self.assertIn("AWANZ Daily Sales", listed)


class TestStorePriceOverride(PurchasingCase):
	def test_the_store_price_override_uses_the_existing_workflow(self):
		"""No second mechanism: the endpoint drives ``AWANZ Price Change Request`` as it stands."""
		item = "AC-012"
		manager = _manager(STORE)
		frappe.set_user(manager)
		current = flt(frappe.db.get_value("Item Price", {"item_code": item, "price_list": "Standard Selling", "selling": 1}, "price_list_rate"))
		out = purchasing.request_price_change(item, STORE, proposed_rate=current + 15, reason="local competition")
		self.assertEqual(out["workflow_state"], "Pending Approval")
		self.assertIn(out["name"], [r["name"] for r in purchasing.price_change_requests(boutique=STORE)["requests"]])
		frappe.set_user("Administrator")
		approved = purchasing.approve_price_change(out["name"], "Approve")
		self.assertEqual(approved["workflow_state"], "Approved")
		self.assertTrue(approved["pricing_rule"])
		rule = frappe.get_doc("Pricing Rule", approved["pricing_rule"])
		self.assertEqual(rule.warehouse, frappe.db.get_value("AWANZ Store", STORE, "warehouse"))
		self.assertAlmostEqual(flt(rule.rate), current + 15)
