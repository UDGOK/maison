"""v0.4 E — itemized returns & exchanges: serialized sellable / damaged, cash / card / store credit,
partial qty + loyalty reversal, manager PIN threshold, exchange difference math."""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt

from maison_pos.api import returns, sales
from maison_pos.tests.helpers import ensure_demo_data, first_serial, pos_invoice

NYC = "NYC-5AV"
NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_MANAGER_USER = "nyc.5av.manager@maison.example"


def _sell(items, payments=None, customer=None, **extra):
	res = sales.submit_batch([pos_invoice(items=items, payments=payments, customer=customer, **extra)])["results"][0]
	assert res["status"] == "ok", res
	return frappe.get_doc("Sales Invoice", res["invoice_name"])


def _card_total(rate, qty=1):
	return round(rate * qty * 1.08875, 2)


class TestReturns(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		cls.warehouse = frappe.db.get_value("Maison Boutique", NYC, "warehouse")

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v04_returns")
		frappe.db.set_single_value("Maison POS Settings", "returns_manager_threshold", 2500)
		frappe.db.set_single_value("Maison POS Settings", "return_window_days", 30)
		frappe.clear_cache(doctype="Maison POS Settings")

	def tearDown(self):
		frappe.db.rollback(save_point="v04_returns")
		frappe.set_user("Administrator")

	# --- serialized ---------------------------------------------------------
	def test_serialized_sellable_returns_to_stock_cash(self):
		serial = first_serial("TP-001", NYC)
		si = _sell([{"item_code": "TP-001", "qty": 1, "rate": 6900, "serial_no": serial}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(6900)}])
		self.assertIsNone(frappe.db.get_value("Serial No", serial, "warehouse"))
		out = returns.return_items(si.name, [{"item_code": "TP-001", "qty": 1, "serial_no": serial, "reason": "Change of mind", "condition": "Sellable"}], refund_method="cash", reason="Change of mind")
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		self.assertEqual(cn.is_return, 1)
		self.assertEqual(cn.return_against, si.name)
		self.assertEqual(cn.docstatus, 1)
		self.assertEqual(cn.update_stock, 1)
		self.assertEqual(cn.items[0].warehouse, self.warehouse)
		self.assertEqual(frappe.db.get_value("Serial No", serial, "warehouse"), self.warehouse)
		self.assertAlmostEqual(flt(cn.grand_total), -_card_total(6900), places=2)
		self.assertEqual(cn.payments[0].mode_of_payment, "Cash")
		self.assertAlmostEqual(flt(cn.payments[0].amount), -_card_total(6900), places=2)
		self.assertEqual(cn.maison_refund_method, "Cash")
		self.assertEqual(cn.items[0].maison_return_condition, "Sellable")
		self.assertTrue(cn.maison_receipt_token)
		self.assertEqual(out["receipt"]["return_against"], si.name)
		# lookup now reports nothing returnable
		look = returns.lookup(invoice=si.name)["invoices"][0]
		self.assertTrue(look["fully_returned"])
		self.assertEqual(look["lines"][0]["returnable_serials"], [])
		# a second return of the same serial is refused
		with self.assertRaises(frappe.ValidationError):
			returns.return_items(si.name, [{"item_code": "TP-001", "qty": 1, "serial_no": serial}], refund_method="cash")

	def test_serialized_damaged_goes_to_damaged_warehouse(self):
		serial = first_serial("TP-006", NYC)
		si = _sell([{"item_code": "TP-006", "qty": 1, "rate": 9400, "serial_no": serial}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(9400)}])
		out = returns.return_items(si.name, [{"item_code": "TP-006", "qty": 1, "serial_no": serial, "reason": "Defect", "condition": "Damaged"}], refund_method="cash", reason="Defect")
		damaged = frappe.db.get_value("Maison Boutique", NYC, "damaged_warehouse")
		self.assertTrue(damaged and "Damaged" in damaged)
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		self.assertEqual(cn.items[0].warehouse, damaged)
		self.assertEqual(cn.items[0].maison_return_condition, "Damaged")
		self.assertEqual(frappe.db.get_value("Serial No", serial, "warehouse"), damaged)
		# not sellable from the POS any more: not in the boutique warehouse
		self.assertNotEqual(frappe.db.get_value("Serial No", serial, "warehouse"), self.warehouse)

	# --- refund methods -----------------------------------------------------
	def test_card_refund_simulated_via_payment_intent(self):
		si = _sell([{"item_code": "AC-012", "qty": 1, "rate": 160}], payments=[{"mode_of_payment": "Card", "amount": _card_total(160), "stripe_payment_intent": "pi_sim_test_1", "card_brand": "Visa", "last4": "4242"}])
		self.assertEqual(si.maison_terminal_ref, "pi_sim_test_1")
		out = returns.return_items(si.name, [{"item_code": "AC-012", "qty": 1, "reason": "Sizing"}], refund_method="card")
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		self.assertEqual(cn.maison_refund_method, "Card")
		self.assertTrue((cn.maison_refund_id or "").startswith("re_sim_"), cn.maison_refund_id)
		self.assertEqual(cn.payments[0].mode_of_payment, "Card")
		self.assertTrue(out["simulated_refund"])
		# card refund on a cash sale is refused
		cash = _sell([{"item_code": "AC-012", "qty": 1, "rate": 160}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(160)}])
		with self.assertRaises(frappe.ValidationError):
			returns.return_items(cash.name, [{"item_code": "AC-012", "qty": 1}], refund_method="card")

	def test_store_credit_leaves_credit_note_unallocated(self):
		si = _sell([{"item_code": "AC-011", "qty": 1, "rate": 380}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(380)}], customer="Isabella Marchetti")
		out = returns.return_items(si.name, [{"item_code": "AC-011", "qty": 1, "reason": "Gift return"}], refund_method="store_credit")
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		self.assertEqual(cn.is_pos, 0)
		self.assertEqual(len(cn.payments), 0)
		self.assertEqual(cn.maison_refund_method, "Store Credit")
		self.assertLess(flt(cn.outstanding_amount), 0)
		self.assertAlmostEqual(abs(flt(cn.outstanding_amount)), abs(flt(cn.rounded_total or cn.grand_total)), places=2)
		self.assertAlmostEqual(out["receipt"]["store_credit"], abs(flt(cn.outstanding_amount)), places=2)
		# stock came back
		self.assertEqual(cn.update_stock, 1)

	# --- partial + loyalty --------------------------------------------------
	def test_partial_qty_return_reverses_loyalty(self):
		customer = "Jonathan Whitfield"
		si = _sell([{"item_code": "AC-012", "qty": 3, "rate": 160}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(160, 3)}], customer=customer)
		before = flt(frappe.db.get_value("Loyalty Point Entry", {"invoice": si.name, "redeem_against": ("is", "not set")}, "loyalty_points"))
		self.assertGreater(before, 0)
		out = returns.return_items(si.name, [{"item_code": "AC-012", "qty": 1, "reason": "Other"}], refund_method="cash")
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		self.assertEqual(flt(cn.items[0].qty), -1)
		self.assertAlmostEqual(flt(cn.grand_total), -_card_total(160), places=2)
		after = flt(frappe.db.get_value("Loyalty Point Entry", {"invoice": si.name, "redeem_against": ("is", "not set")}, "loyalty_points"))
		self.assertLess(after, before)
		self.assertEqual(out["loyalty_points_reversed"], after)
		look = returns.lookup(invoice=si.name)["invoices"][0]
		self.assertEqual(look["lines"][0]["returned_qty"], 1)
		self.assertEqual(look["lines"][0]["returnable_qty"], 2)
		with self.assertRaises(frappe.ValidationError):
			returns.return_items(si.name, [{"item_code": "AC-012", "qty": 3}], refund_method="cash")

	# --- manager PIN --------------------------------------------------------
	def test_manager_pin_required_over_threshold(self):
		frappe.db.set_single_value("Maison POS Settings", "returns_manager_threshold", 100)
		frappe.clear_cache(doctype="Maison POS Settings")
		si = _sell([{"item_code": "AC-001", "qty": 1, "rate": 2400}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(2400)}])
		manager = frappe.db.get_value("Maison Associate", {"user": NYC_MANAGER_USER}, "name")
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(returns.ManagerRequiredError) as ctx:
			returns.return_items(si.name, [{"item_code": "AC-001", "qty": 1}], refund_method="cash")
		self.assertEqual(ctx.exception.error_code, returns.ERR_MANAGER_REQUIRED)
		with self.assertRaises(returns.ManagerRequiredError):
			returns.return_items(si.name, [{"item_code": "AC-001", "qty": 1}], refund_method="cash", manager=manager, manager_pin="0000")
		out = returns.return_items(si.name, [{"item_code": "AC-001", "qty": 1}], refund_method="cash", manager=manager, manager_pin="1234")
		self.assertEqual(out["manager_approved_by"], manager)
		self.assertEqual(frappe.db.get_value("Sales Invoice", out["credit_note"], "maison_manager_approved_by"), manager)

	def test_manager_approves_implicitly(self):
		frappe.db.set_single_value("Maison POS Settings", "returns_manager_threshold", 100)
		frappe.clear_cache(doctype="Maison POS Settings")
		si = _sell([{"item_code": "AC-001", "qty": 1, "rate": 2400}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(2400)}])
		frappe.set_user(NYC_MANAGER_USER)
		out = returns.return_items(si.name, [{"item_code": "AC-001", "qty": 1}], refund_method="cash")
		self.assertTrue(out["credit_note"])

	# --- exchange -----------------------------------------------------------
	def test_exchange_up_charges_difference(self):
		si = _sell([{"item_code": "AC-012", "qty": 1, "rate": 160}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(160)}])
		credit = _card_total(160)
		new_total = _card_total(2400)
		diff = round(new_total - credit, 2)
		with self.assertRaises(frappe.ValidationError):  # payments must cover the difference
			returns.exchange(si.name, [{"item_code": "AC-012", "qty": 1, "reason": "Sizing"}], [{"item_code": "AC-001", "qty": 1, "rate": 2400}], payments=[{"mode_of_payment": "Card", "amount": 1}])
		out = returns.exchange(si.name, [{"item_code": "AC-012", "qty": 1, "reason": "Sizing"}], [{"item_code": "AC-001", "qty": 1, "rate": 2400}], payments=[{"mode_of_payment": "Card", "amount": diff, "stripe_payment_intent": "pi_sim_x1"}])
		self.assertAlmostEqual(out["credit"], credit, places=2)
		self.assertAlmostEqual(out["new_grand_total"], new_total, places=2)
		self.assertAlmostEqual(out["difference"], diff, places=2)
		self.assertAlmostEqual(out["applied"], credit, places=2)
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		new = frappe.get_doc("Sales Invoice", out["new_invoice"])
		self.assertEqual(cn.docstatus, 1)
		self.assertEqual(new.docstatus, 1)
		self.assertEqual(new.is_pos, 1)
		# v0.8 POS D8 — one direction only: the mutual link deadlocked both documents against
		# `LinkExistsError`, so an exchange booked in error could never be cancelled. The new sale
		# records the pair in its notes instead (see `test_v0_8_pos_defects.TestPosDefectsV08`).
		self.assertEqual(cn.maison_exchange_invoice, new.name)
		self.assertFalse(new.maison_exchange_invoice)
		self.assertIn(cn.name, new.maison_notes or "")
		self.assertEqual({p.mode_of_payment: flt(p.amount) for p in cn.payments}, {"Exchange Credit": -credit})
		tenders = {p.mode_of_payment: round(flt(p.amount), 2) for p in new.payments}
		self.assertAlmostEqual(tenders["Exchange Credit"], credit, places=2)
		self.assertAlmostEqual(tenders["Card"], diff, places=2)
		self.assertEqual(new.maison_terminal_ref, "pi_sim_x1")
		self.assertEqual(cn.maison_refund_method, "Exchange")
		# Exchange Credit nets to zero across the two documents
		self.assertAlmostEqual(sum(flt(p.amount) for d in (cn, new) for p in d.payments if p.mode_of_payment == "Exchange Credit"), 0, places=2)

	def test_exchange_down_refunds_remainder(self):
		si = _sell([{"item_code": "AC-001", "qty": 1, "rate": 2400}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(2400)}])
		credit = _card_total(2400)
		new_total = _card_total(160)
		out = returns.exchange(si.name, [{"item_code": "AC-001", "qty": 1, "reason": "Change of mind"}], [{"item_code": "AC-012", "qty": 1, "rate": 160}], refund_method="cash")
		self.assertAlmostEqual(out["difference"], round(new_total - credit, 2), places=2)
		self.assertAlmostEqual(out["applied"], new_total, places=2)
		self.assertAlmostEqual(out["refund_remainder"], round(credit - new_total, 2), places=2)
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		new = frappe.get_doc("Sales Invoice", out["new_invoice"])
		tenders = {p.mode_of_payment: round(flt(p.amount), 2) for p in cn.payments}
		self.assertAlmostEqual(tenders["Exchange Credit"], -new_total, places=2)
		self.assertAlmostEqual(tenders["Cash"], -round(credit - new_total, 2), places=2)
		self.assertEqual([p.mode_of_payment for p in new.payments], ["Exchange Credit"])
		self.assertAlmostEqual(flt(new.payments[0].amount), new_total, places=2)
		self.assertEqual(cn.maison_refund_method, "Cash")

	def test_exchange_serialized_for_serialized(self):
		s1 = first_serial("TP-005", NYC)
		si = _sell([{"item_code": "TP-005", "qty": 1, "rate": 12800, "serial_no": s1}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(12800)}])
		s2 = first_serial("TP-006", NYC)
		out = returns.exchange(si.name, [{"item_code": "TP-005", "qty": 1, "serial_no": s1, "reason": "Change of mind"}], [{"item_code": "TP-006", "qty": 1, "rate": 9400, "serial_no": s2}], refund_method="store_credit")
		self.assertEqual(frappe.db.get_value("Serial No", s1, "warehouse"), self.warehouse)
		self.assertIsNone(frappe.db.get_value("Serial No", s2, "warehouse"))
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		# remainder kept as store credit: only the applied part is tendered, rest outstanding
		self.assertAlmostEqual(abs(flt(cn.outstanding_amount)), round(_card_total(12800) - _card_total(9400), 2), places=2)

	# --- lookup -------------------------------------------------------------
	def test_lookup_by_token_and_customer(self):
		si = _sell([{"item_code": "AC-012", "qty": 2, "rate": 160}], payments=[{"mode_of_payment": "Cash", "amount": _card_total(160, 2)}], customer="Amara Okonkwo")
		by_token = returns.lookup(token=f"https://example.com/r/{si.maison_receipt_token}")["invoices"]
		self.assertEqual(by_token[0]["name"], si.name)
		self.assertEqual(by_token[0]["lines"][0]["returnable_qty"], 2)
		self.assertTrue(by_token[0]["within_return_window"])
		by_customer = returns.lookup(customer="Amara Okonkwo")["invoices"]
		self.assertIn(si.name, [i["name"] for i in by_customer])
		pol = returns.policy()
		self.assertEqual(pol["return_window_days"], 30)
		self.assertIn("Sellable", pol["conditions"])
		rec = returns.recent(NYC)
		self.assertEqual(rec["boutique"], NYC)
