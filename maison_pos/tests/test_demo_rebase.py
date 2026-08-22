"""Demo seed: opening stock is back-dated, and rebase_stock() repairs future-dated receipts."""

from __future__ import annotations

import datetime
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, flt, get_time, getdate, now_datetime, nowdate

from maison_pos.api import sales
from maison_pos.setup import demo
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice

TEST_CODE = "TRB"


def _posting(name: str) -> datetime.datetime:
	d, t = frappe.db.get_value("Stock Entry", name, ["posting_date", "posting_time"])
	return datetime.datetime.combine(getdate(d), get_time(t))


def _target() -> datetime.datetime:
	return datetime.datetime.combine(
		getdate(add_days(nowdate(), -demo.DEMO_STOCK_DAYS_BACK)), get_time(demo.DEMO_STOCK_POSTING_TIME)
	)


def _to_future(name: str, hours: int = 10) -> None:
	"""Simulate the timezone-shift symptom: the receipt sits after "now"."""
	later = now_datetime() + datetime.timedelta(hours=hours)
	demo._redate_in_place(name, later.strftime("%Y-%m-%d"), later.strftime("%H:%M:%S"))


class TestDemoStockRebase(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")

	def _seed_test_warehouse(self, code: str) -> str:
		"""Run ensure_stock() for an extra, empty boutique warehouse and return the receipt name."""
		warehouse = f"{code} - {demo.ABBR}"
		if not frappe.db.exists("Warehouse", warehouse):
			frappe.get_doc({"doctype": "Warehouse", "warehouse_name": code, "company": demo.COMPANY}).insert(ignore_permissions=True)
		with patch.object(demo, "BOUTIQUES", [{"code": code}]):
			demo.ensure_stock()
		name = frappe.db.get_value("Stock Entry", {"docstatus": 1, "to_warehouse": warehouse}, "name")
		self.assertTrue(name, "ensure_stock() should create a receipt for the empty warehouse")
		return name

	def test_seed_backdates_stock(self):
		name = self._seed_test_warehouse(TEST_CODE + "S")
		se = frappe.get_doc("Stock Entry", name)
		self.assertEqual(se.set_posting_time, 1)
		self.assertEqual(se.remarks, demo.DEMO_STOCK_REMARK)
		self.assertEqual(_posting(name), _target())
		self.assertIn(name, demo.demo_stock_entries())
		# running the seed again does not duplicate the receipt
		with patch.object(demo, "BOUTIQUES", [{"code": TEST_CODE + "S"}]):
			demo.ensure_stock()
		self.assertEqual(frappe.db.count("Stock Entry", {"docstatus": 1, "to_warehouse": se.to_warehouse}), 1)

	def test_rebase_requires_system_manager(self):
		frappe.set_user(frappe.db.get_value("Maison Associate", {"boutique": "NYC-5AV", "role": "Associate"}, "user"))
		with self.assertRaises(frappe.PermissionError):
			demo.rebase_stock()

	def test_rebase_recreates_future_dated_receipt(self):
		"""A future-dated receipt with nothing sold from it is cancelled and re-created back-dated."""
		name = self._seed_test_warehouse(TEST_CODE + "R")
		warehouse = frappe.db.get_value("Stock Entry", name, "to_warehouse")
		before = {
			b.item_code: flt(b.actual_qty) for b in frappe.get_all("Bin", {"warehouse": warehouse}, ["item_code", "actual_qty"])
		}
		serials_before = set(frappe.get_all("Serial No", {"warehouse": warehouse, "status": "Active"}, pluck="name"))
		self.assertTrue(before and serials_before)

		_to_future(name)
		self.assertGreater(_posting(name), now_datetime())

		out = demo.rebase_stock()
		rec = [r for r in out["recreated"] if r["old"] == name]
		self.assertEqual(len(rec), 1, out)
		new_name = rec[0]["new"]
		self.assertEqual(frappe.db.get_value("Stock Entry", name, "docstatus"), 2)
		self.assertEqual(frappe.db.get_value("Stock Entry", new_name, "docstatus"), 1)
		self.assertEqual(frappe.db.get_value("Stock Entry", new_name, "remarks"), demo.DEMO_STOCK_REMARK)
		self.assertEqual(_posting(new_name), _target())

		after = {
			b.item_code: flt(b.actual_qty) for b in frappe.get_all("Bin", {"warehouse": warehouse}, ["item_code", "actual_qty"])
		}
		self.assertEqual(after, before)
		serials_after = set(frappe.get_all("Serial No", {"warehouse": warehouse, "status": "Active"}, pluck="name"))
		self.assertEqual(serials_after, serials_before)
		self.assertEqual(frappe.db.get_single_value("Stock Settings", "allow_negative_stock"), 0)

		# idempotent
		again = demo.rebase_stock()
		self.assertIn(new_name, again["skipped"])
		self.assertEqual(again["recreated"], [])
		self.assertEqual(again["redated"], [])

	def test_rebase_redates_in_place_when_serials_were_sold(self):
		"""ERPNext refuses to cancel a receipt whose serials were delivered by a later transaction;
		the entry is re-dated in place, stock and serial statuses are untouched."""
		name = self._seed_test_warehouse(TEST_CODE + "F")
		warehouse = frappe.db.get_value("Stock Entry", name, "to_warehouse")
		# receipt after the target but in the past (e.g. seeded an hour ago)
		earlier = now_datetime() - datetime.timedelta(hours=1)
		demo._redate_in_place(name, earlier.strftime("%Y-%m-%d"), earlier.strftime("%H:%M:%S"))

		serial_row = frappe.db.get_value(
			"Serial No", {"warehouse": warehouse, "status": "Active"}, ["name", "item_code"], as_dict=True, order_by="name"
		)
		self.assertTrue(serial_row)
		issue = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Issue",
				"purpose": "Material Issue",
				"company": demo.COMPANY,
				"from_warehouse": warehouse,
				"items": [
					{
						"item_code": serial_row.item_code,
						"qty": 1,
						"s_warehouse": warehouse,
						"use_serial_batch_fields": 1,
						"serial_no": serial_row.name,
					}
				],
			}
		)
		issue.flags.ignore_permissions = True
		issue.insert()
		issue.submit()
		self.assertNotEqual(frappe.db.get_value("Serial No", serial_row.name, "status"), "Active")
		before = {
			b.item_code: flt(b.actual_qty) for b in frappe.get_all("Bin", {"warehouse": warehouse}, ["item_code", "actual_qty"])
		}

		out = demo.rebase_stock()
		red = [r for r in out["redated"] if r["name"] == name]
		self.assertEqual(len(red), 1, out)
		self.assertIn("SerialNoExistsInFutureTransactionError", red[0]["reason"])
		self.assertEqual(frappe.db.get_value("Stock Entry", name, "docstatus"), 1)
		self.assertEqual(_posting(name), _target())
		self.assertNotEqual(frappe.db.get_value("Serial No", serial_row.name, "status"), "Active")
		after = {
			b.item_code: flt(b.actual_qty) for b in frappe.get_all("Bin", {"warehouse": warehouse}, ["item_code", "actual_qty"])
		}
		self.assertEqual(after, before)
		self.assertEqual(frappe.db.get_single_value("Stock Settings", "allow_negative_stock"), 0)
		# ledger rows moved with the document
		sle_dates = frappe.get_all("Stock Ledger Entry", {"voucher_no": name, "is_cancelled": 0}, pluck="posting_date")
		self.assertTrue(sle_dates and all(str(d) == out["posting_date"] for d in sle_dates))
		self.assertIn(name, demo.rebase_stock()["skipped"])  # idempotent
