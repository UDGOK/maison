"""submit_batch: idempotency on offline_uuid, serial conflicts, per-invoice isolation."""

from __future__ import annotations

import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from maison_pos.api import sales
from maison_pos.tests.helpers import ensure_demo_data, first_serial, pos_invoice


class TestSubmitBatch(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")

	def test_submit_ok_creates_pos_invoice(self):
		payload = pos_invoice()
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(si.docstatus, 1)
		self.assertEqual(si.is_pos, 1)
		self.assertEqual(si.update_stock, 1)
		self.assertEqual(si.maison_offline_uuid, payload["offline_uuid"])
		self.assertEqual(si.maison_boutique, "NYC-5AV")
		self.assertEqual(si.set_warehouse, frappe.db.get_value("AWANZ Store", "NYC-5AV", "warehouse"))
		self.assertTrue(si.payments and si.payments[0].mode_of_payment == "Card")
		self.assertGreater(si.total_taxes_and_charges, 0)
		log = frappe.db.get_value("AWANZ Sync Log", payload["offline_uuid"], ["status", "invoice"], as_dict=True)
		self.assertEqual(log.status, "Success")
		self.assertEqual(log.invoice, si.name)

	def test_replay_is_duplicate(self):
		payload = pos_invoice()
		first = sales.submit_batch([payload])["results"][0]
		self.assertEqual(first["status"], "ok", first)
		second = sales.submit_batch([payload])["results"][0]
		self.assertEqual(second["status"], "duplicate")
		self.assertEqual(second["invoice_name"], first["invoice_name"])
		count = frappe.db.count("Sales Invoice", {"maison_offline_uuid": payload["offline_uuid"]})
		self.assertEqual(count, 1)

	def test_serial_conflict_is_structured_and_isolated(self):
		serial = first_serial("TP-001", "NYC-5AV")
		self.assertTrue(serial, "demo seed should create serialized stock for TP-001")

		watch = {"item_code": "TP-001", "qty": 1, "rate": 6900, "serial_no": serial}
		first = sales.submit_batch([pos_invoice(items=[watch])])["results"][0]
		self.assertEqual(first["status"], "ok", first)

		# Same serial again (sold while another device was offline) + an unrelated good invoice in the same batch
		conflict = pos_invoice(items=[watch])
		good = pos_invoice()
		results = sales.submit_batch([conflict, good])["results"]
		self.assertEqual(results[0]["status"], "error")
		self.assertEqual(results[0]["error_code"], sales.ERR_SERIAL_UNAVAILABLE)
		self.assertEqual(results[1]["status"], "ok", results[1])
		self.assertTrue(frappe.db.exists("Sales Invoice", results[1]["invoice_name"]))
		self.assertFalse(frappe.db.exists("Sales Invoice", {"maison_offline_uuid": conflict["offline_uuid"]}))
		log = frappe.db.get_value("AWANZ Sync Log", conflict["offline_uuid"], ["status", "error_code"], as_dict=True)
		self.assertEqual(log.status, "Error")
		self.assertEqual(log.error_code, sales.ERR_SERIAL_UNAVAILABLE)

	def test_missing_uuid_and_underpayment(self):
		bad = pos_invoice()
		bad["offline_uuid"] = ""
		short = pos_invoice(payments=[{"mode_of_payment": "Card", "amount": 1}])
		results = sales.submit_batch([bad, short])["results"]
		self.assertEqual(results[0]["status"], "error")
		self.assertEqual(results[0]["error_code"], sales.ERR_VALIDATION)
		self.assertEqual(results[1]["status"], "error")
		self.assertEqual(results[1]["error_code"], sales.ERR_PAYMENT)

	def test_cash_change_is_computed(self):
		payload = pos_invoice(payments=[{"mode_of_payment": "Cash", "amount": 200}])
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertGreater(si.change_amount, 0)

	def test_line_discount_is_whole_line_amount_off_the_list_rate(self):
		"""POSInvoice: `rate` = unit list rate, `discount_amount` = whole-line discount (manual + promotion).
		The device tenders qty * rate - discount (+ tax); the server must land on the same total."""
		# 2 × 160 list, $48 off the line (15 % promotion) → net 272, NYC tax 8.875 % → 296.14
		payload = pos_invoice(items=[{"item_code": "AC-012", "qty": 2, "rate": 160, "discount_amount": 48}], payments=[{"mode_of_payment": "Card", "amount": 296.14}])
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		row = si.items[0]
		self.assertEqual(row.price_list_rate, 160)
		self.assertEqual(row.rate, 136)
		self.assertEqual(row.discount_amount, 24)  # ERPNext keeps it per unit
		self.assertEqual(row.amount, 272)
		self.assertEqual(si.net_total, 272)
		self.assertAlmostEqual(si.grand_total, 296.14, places=2)

	def test_half_cent_tax_rounds_like_the_device(self):
		"""Commercial rounding (System Settings, pinned by the install): 10.25 % of 22 050 = 2 260.125 must
		become 2 260.13 like the device's half-away-from-zero `round`, not banker's 2 260.12."""
		self.assertEqual(frappe.get_system_settings("rounding_method"), "Commercial Rounding")
		payload = pos_invoice(boutique="CHI-OAK", items=[{"item_code": "AC-012", "qty": 1, "rate": 22050}], payments=[{"mode_of_payment": "Card", "amount": 24310.13}])
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertAlmostEqual(si.total_taxes_and_charges, 2260.13, places=2)
		self.assertAlmostEqual(si.grand_total, 24310.13, places=2)

	def test_void_creates_credit_note(self):
		result = sales.submit_batch([pos_invoice()])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		out = sales.void(result["invoice_name"], "client changed mind")
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		self.assertEqual(cn.is_return, 1)
		self.assertEqual(cn.return_against, result["invoice_name"])
		self.assertEqual(cn.docstatus, 1)
		# voiding twice returns the same credit note
		again = sales.void(result["invoice_name"], "again")
		self.assertEqual(again["credit_note"], out["credit_note"])

	def test_day_list_totals(self):
		sales.submit_batch([pos_invoice(), pos_invoice()])
		report = sales.list("NYC-5AV", frappe.utils.nowdate())
		self.assertGreaterEqual(report["totals"]["invoices"], 2)
		self.assertIn("Card", report["by_mode_of_payment"])
		self.assertTrue(all(i["name"] for i in report["invoices"]))

	def test_accepts_json_string(self):
		payload = pos_invoice()
		result = sales.submit_batch(frappe.as_json([payload]))["results"][0]
		self.assertEqual(result["status"], "ok", result)
		self.assertNotEqual(payload["offline_uuid"], str(uuid.uuid4()))
