"""v0.4 D — low-stock scan (idempotent), acknowledge/resolve, transfer request, cycle count."""

from __future__ import annotations

import json

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt

from maison_pos.api import inventory
from maison_pos.tests.helpers import ensure_demo_data, first_serial

NYC = "NYC-5AV"
NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_MANAGER = "nyc.5av.manager@maison.example"


def _set_level(item: str, warehouse: str, level: float, qty: float = 5) -> None:
	doc = frappe.get_doc("Item", item)
	row = next((r for r in doc.reorder_levels if r.warehouse == warehouse), None)
	if level <= 0:
		if row:
			doc.remove(row)
	elif row:
		row.warehouse_reorder_level = level
		row.warehouse_reorder_qty = qty
	else:
		doc.append("reorder_levels", {"warehouse_group": warehouse, "warehouse": warehouse, "warehouse_reorder_level": level, "warehouse_reorder_qty": qty, "material_request_type": "Transfer"})
	doc.flags.ignore_permissions = True
	doc.save()


class TestInventory(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		cls.warehouse = frappe.db.get_value("AWANZ Store", NYC, "warehouse")

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v04_inv")

	def tearDown(self):
		frappe.db.rollback(save_point="v04_inv")
		frappe.set_user("Administrator")

	def test_scan_creates_alert_once_and_resolves(self):
		actual = flt(frappe.db.get_value("Bin", {"item_code": "AC-010", "warehouse": self.warehouse}, "actual_qty"))
		self.assertGreater(actual, 0)
		_set_level("AC-010", self.warehouse, actual + 5)
		first = inventory.low_stock_scan(notify=True)
		names = [n for n in first["created"] if frappe.db.get_value("AWANZ Stock Alert", n, "item_code") == "AC-010"]
		self.assertEqual(len(names), 1, first)
		alert = frappe.get_doc("AWANZ Stock Alert", names[0])
		self.assertEqual(alert.status, "Open")
		self.assertEqual(alert.boutique, NYC)
		self.assertEqual(flt(alert.qty), actual)
		self.assertEqual(flt(alert.reorder_level), actual + 5)
		# idempotent: second scan creates nothing new for this item
		second = inventory.low_stock_scan(notify=False)
		self.assertFalse([n for n in second["created"] if frappe.db.get_value("AWANZ Stock Alert", n, "item_code") == "AC-010"])
		self.assertEqual(frappe.db.count("AWANZ Stock Alert", {"item_code": "AC-010", "warehouse": self.warehouse, "status": ("in", ("Open", "Acknowledged"))}), 1)
		# notification reached the boutique manager
		self.assertTrue(frappe.db.exists("Notification Log", {"for_user": NYC_MANAGER, "document_type": "AWANZ Stock Alert"}))
		# acknowledge (manager) then level removed -> resolved by the scan
		frappe.set_user(NYC_MANAGER)
		out = inventory.acknowledge(alert.name)
		self.assertEqual(out["status"], "Acknowledged")
		listed = inventory.alerts(NYC)
		self.assertIn(alert.name, [a["name"] for a in listed["alerts"]])
		self.assertGreaterEqual(listed["counts"].get(NYC, 0), 1)
		frappe.set_user("Administrator")
		_set_level("AC-010", self.warehouse, 0)
		third = inventory.low_stock_scan(notify=False)
		self.assertIn(alert.name, third["resolved"])
		self.assertEqual(frappe.db.get_value("AWANZ Stock Alert", alert.name, "status"), "Resolved")

	def test_associate_cannot_resolve_but_can_request_transfer(self):
		_set_level("AC-009", self.warehouse, 999)
		created = inventory.low_stock_scan(notify=False)["created"]
		name = next(n for n in created if frappe.db.get_value("AWANZ Stock Alert", n, "item_code") == "AC-009")
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(frappe.PermissionError):
			inventory.resolve(name)
		with self.assertRaises(frappe.PermissionError):
			inventory.alerts("CHI-OAK")
		out = inventory.request_transfer("AC-009", NYC, 4, from_warehouse="CHI-OAK", alert=name)
		mr = frappe.get_doc("Material Request", out["material_request"])
		self.assertEqual(mr.material_request_type, "Material Transfer")
		self.assertEqual(mr.items[0].warehouse, self.warehouse)
		self.assertEqual(mr.items[0].from_warehouse, frappe.db.get_value("AWANZ Store", "CHI-OAK", "warehouse"))
		self.assertEqual(flt(mr.items[0].qty), 4)
		self.assertEqual(frappe.db.get_value("AWANZ Stock Alert", name, "material_request"), mr.name)

	def test_cycle_count_reports_unaccounted_serials_and_drafts_reconciliation(self):
		frappe.set_user(NYC_ASSOCIATE)
		exp = inventory.cycle_count_expected(NYC)
		self.assertEqual(exp["warehouse"], self.warehouse)
		self.assertIn("TP-001", exp["serials"])
		all_serials = [s for lst in exp["serials"].values() for s in lst]
		missing = exp["serials"]["TP-001"][0]
		scanned = [s for s in all_serials if s != missing] + ["BOGUS-SERIAL-1"]
		qty = dict(exp["qty"])
		qty["AC-012"] = flt(qty.get("AC-012", 0)) - 2
		res = inventory.submit_cycle_count(NYC, serials=json.dumps(scanned), qty=json.dumps(qty), device_id="TEST-IPAD-1")
		self.assertFalse(res["clean"])
		self.assertEqual([m["serial_no"] for m in res["missing"]], [missing])
		self.assertEqual(res["unexpected"][0]["serial_no"], "BOGUS-SERIAL-1")
		self.assertEqual(res["unexpected"][0]["status"], "not_found")
		diff = next(d for d in res["qty_differences"] if d["item_code"] == "AC-012")
		self.assertEqual(diff["diff"], -2)
		self.assertTrue(res["stock_reconciliation"])
		sr = frappe.get_doc("Stock Reconciliation", res["stock_reconciliation"])
		self.assertEqual(sr.docstatus, 0)
		self.assertEqual(sr.items[0].item_code, "AC-012")
		self.assertEqual(flt(sr.items[0].qty), qty["AC-012"])
		cc = frappe.get_doc("AWANZ Cycle Count", res["cycle_count"])
		self.assertEqual(cc.status, "Draft")
		self.assertEqual(cc.stock_reconciliation, sr.name)
		self.assertEqual(json.loads(cc.missing_serials)[0]["serial_no"], missing)
		# a clean count produces no reconciliation
		clean = inventory.submit_cycle_count(NYC, serials=all_serials, qty=exp["qty"])
		self.assertTrue(clean["clean"])
		self.assertIsNone(clean["stock_reconciliation"])

	def test_seed_created_damaged_warehouses_readers_and_samples(self):
		for b in ("NYC-5AV", "CHI-OAK", "MIA-DD"):
			doc = frappe.get_doc("AWANZ Store", b)
			self.assertTrue(doc.damaged_warehouse and frappe.db.exists("Warehouse", doc.damaged_warehouse))
			self.assertEqual(len(doc.readers), 2)
			self.assertTrue(any(r.device_type == "verifone_v660p" and r.has_printer for r in doc.readers))
		self.assertGreaterEqual(frappe.db.count("AWANZ Stock Alert", {"status": ("in", ("Open", "Acknowledged"))}), 2)
		self.assertTrue(frappe.db.exists("Mode of Payment", "Exchange Credit"))
		# the POS reader picker / print route read the registry from catalog.bootstrap
		from maison_pos.api.catalog import bootstrap

		b = bootstrap("CHI-OAK")["boutique"]
		self.assertEqual(len(b["readers"]), 2)
		v660 = next(r for r in b["readers"] if r["device_type"] == "verifone_v660p")
		self.assertEqual(v660["has_printer"], 1)
		self.assertTrue(v660["stripe_reader_id"])
		self.assertTrue(b["damaged_warehouse"])
