"""v0.4 G — web shop: web-mode rules, web order → boutique mapping, loyalty lookup, collection at the counter.

Every test is skipped when the ``webshop`` app is not installed on the site.
"""

from __future__ import annotations

import unittest

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt

from maison_pos.tests.helpers import ensure_demo_data, pos_invoice
from maison_pos.webshop import core, is_webshop_installed

WEB_USER = "client@maison.example"
WEB_CUSTOMER = "Isabella Marchetti"


def _web_session(user: str = WEB_USER) -> None:
	frappe.set_user(user)
	frappe.local.session.user = user


@unittest.skipUnless(is_webshop_installed(), "webshop app not installed")
class TestWebshop(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()  # also runs seed_webshop() (guarded on the app)
		# the demo one-offs get sold / reserved by e2e runs on a shared site: receive one fresh serial of each
		# timepiece the tests rely on into Oak Street (rolled back with the class transaction)
		from maison_pos.setup.demo import _stock_entry_doc

		warehouse = frappe.db.get_value("Maison Boutique", "CHI-OAK", "warehouse")
		rows = []
		for code in ("TP-001", "TP-002"):
			serial = f"{code}-CHI-T{frappe.generate_hash(length=4).upper()}"
			rows.append({"item_code": code, "qty": 1, "t_warehouse": warehouse, "basic_rate": 1000, "use_serial_batch_fields": 1, "serial_no": serial})
		se = _stock_entry_doc(warehouse, rows, frappe.utils.nowdate(), "08:00:00")
		se.insert()
		se.submit()

	def setUp(self):
		frappe.set_user("Administrator")

	# ---------------------------------------------------------------- web mode rules
	def test_web_mode_rules(self):
		# explicit modes from the seed
		self.assertEqual(core.effective_web_mode(frappe.db.get_value("Item", "AC-012", ["item_code", "has_serial_no", "is_stock_item", "maison_web_mode"], as_dict=True)), "Buy")
		self.assertEqual(core.effective_web_mode(frappe.db.get_value("Item", "TP-002", ["item_code", "has_serial_no", "is_stock_item", "maison_web_mode"], as_dict=True)), "Reserve-with-deposit")
		self.assertEqual(core.effective_web_mode(frappe.db.get_value("Item", "HJ-001", ["item_code", "has_serial_no", "is_stock_item", "maison_web_mode"], as_dict=True)), "Enquire")
		# a serialized piece marked Buy with at most one unit in the chain is never sold blind
		one_off = {"item_code": "X", "has_serial_no": 1, "is_stock_item": 1, "maison_web_mode": "Buy"}
		self.assertEqual(core.effective_web_mode(one_off, available_qty=1), "Enquire")
		self.assertEqual(core.effective_web_mode(one_off, available_qty=0), "Enquire")
		self.assertEqual(core.effective_web_mode(one_off, available_qty=3), "Buy")
		# non-stock items (services) are never bought online
		self.assertEqual(core.effective_web_mode({"item_code": "SV-001", "has_serial_no": 0, "is_stock_item": 0, "maison_web_mode": "Buy"}), "Enquire")
		# unknown values fall back to Buy
		self.assertEqual(core.effective_web_mode({"item_code": "Y", "has_serial_no": 0, "is_stock_item": 1, "maison_web_mode": "Weird"}), "Buy")

	def test_availability_per_boutique_and_label(self):
		from maison_pos.api.webshop import availability

		data = availability("TP-001")
		self.assertEqual(len(data["boutiques"]), 3)
		self.assertTrue(all("qty" in b and "city" in b for b in data["boutiques"]))
		self.assertIn("Chicago", data["available_at"])
		self.assertGreater(data["chain_qty"], 0)

	def test_catalogue_lists_published_items_with_modes(self):
		from maison_pos.api.webshop import catalogue

		data = catalogue(limit=100)
		codes = {p["item_code"]: p for p in data["items"]}
		self.assertIn("TP-002", codes)
		self.assertNotIn("SV-001", codes)  # services are not published
		self.assertEqual(codes["HJ-001"]["web_mode"], "Enquire")
		self.assertEqual(codes["BR-006"]["web_mode"], "Buy")
		self.assertGreater(codes["BR-006"]["rate"], 0)
		self.assertTrue(codes["BR-006"]["image"])
		self.assertEqual(catalogue(mode="Reserve-with-deposit", limit=100)["items"][0]["web_mode"], "Reserve-with-deposit")

	# ---------------------------------------------------------------- enquiries
	def test_guest_enquiry_lands_in_boutique_queue(self):
		from maison_pos.api.webshop import enquire, web_orders

		frappe.set_user("Guest")
		out = enquire("HJ-001", "Test Guest", email="guest.test@example.com", phone=None, message="Viewing?", boutique="CHI-OAK")
		frappe.set_user("Administrator")
		doc = frappe.get_doc("Maison Web Enquiry", out["enquiry"])
		self.assertEqual(doc.boutique, "CHI-OAK")
		self.assertEqual(doc.status, "New")
		self.assertEqual(doc.item_name, "Cascade Diamond Riviere Necklace")
		queue = web_orders("CHI-OAK")
		self.assertIn(out["enquiry"], [e["name"] for e in queue["enquiries"]])
		# guests must leave a way to be reached
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			enquire("HJ-001", "Nobody")

	# ---------------------------------------------------------------- loyalty lookup
	def test_loyalty_lookup_requires_matching_client_number_and_email(self):
		from maison_pos.api.webshop import loyalty_lookup

		number, email = frappe.db.get_value("Customer", WEB_CUSTOMER, ["maison_client_number", "email_id"])
		frappe.set_user("Guest")
		self.assertIsNone(loyalty_lookup(number, "someone.else@example.com"))
		self.assertIsNone(loyalty_lookup("MC000000", email))
		with self.assertRaises(frappe.ValidationError):
			loyalty_lookup(number, None)
		data = loyalty_lookup(number.lower(), email.upper())
		self.assertIsNotNone(data)
		self.assertEqual(data["client_number"], number)
		self.assertEqual(data["customer_name"], WEB_CUSTOMER)
		self.assertIsNone(data["customer"])  # no internal id for guests
		self.assertIn("points", data)
		self.assertTrue(data["email_masked"].endswith("@maison.example"))

	# ---------------------------------------------------------------- orders → boutique
	def _place_order(self, boutique: str = "CHI-OAK", pay_now: int = 0):
		from maison_pos.api.webshop import place_order, update_cart

		_web_session()
		update_cart("AC-012", 2)
		out = place_order(boutique=boutique, fulfilment="Click & Collect", pay_now=pay_now)
		frappe.set_user("Administrator")
		return out

	def test_place_order_maps_to_boutique_and_queue(self):
		from maison_pos.api.webshop import web_orders

		out = self._place_order("CHI-OAK")
		so = frappe.get_doc("Sales Order", out["sales_order"])
		self.assertEqual(so.docstatus, 1)
		self.assertEqual(so.maison_boutique, "CHI-OAK")
		self.assertEqual(so.maison_web_order, 1)
		self.assertEqual(so.maison_web_status, "New")
		self.assertEqual(so.customer, WEB_CUSTOMER)
		self.assertEqual(so.order_type, "Sales")
		chi_wh = frappe.db.get_value("Maison Boutique", "CHI-OAK", "warehouse")
		self.assertTrue(all(i.warehouse == chi_wh for i in so.items))
		self.assertGreater(so.total_taxes_and_charges, 0)  # Illinois tax of the boutique of collection
		# in the Oak Street queue, not in the New York one
		self.assertIn(so.name, [o["name"] for o in web_orders("CHI-OAK")["orders"]])
		self.assertNotIn(so.name, [o["name"] for o in web_orders("NYC-5AV")["orders"]])
		self.assertIsNone(out["payment_url"])

	def test_place_order_refuses_enquire_pieces(self):
		from maison_pos.api.webshop import place_order, update_cart

		_web_session()
		update_cart("HJ-001", 1)
		with self.assertRaises(frappe.ValidationError):
			place_order(boutique="CHI-OAK")
		update_cart("HJ-001", 0)
		frappe.set_user("Administrator")

	def test_status_machine(self):
		from maison_pos.api.webshop import set_web_order_status

		out = self._place_order("CHI-OAK")
		with self.assertRaises(frappe.ValidationError):
			set_web_order_status(out["sales_order"], "Ready")  # no skipping
		set_web_order_status(out["sales_order"], "Picking", note="gift wrap")
		set_web_order_status(out["sales_order"], "Ready")
		so = frappe.db.get_value("Sales Order", out["sales_order"], ["maison_web_status", "maison_web_note"], as_dict=True)
		self.assertEqual(so.maison_web_status, "Ready")
		self.assertEqual(so.maison_web_note, "gift wrap")
		with self.assertRaises(frappe.ValidationError):
			set_web_order_status(out["sales_order"], "Collected")  # only through the sale

	def test_boutique_scoping_of_the_queue(self):
		from maison_pos.api.webshop import web_orders

		self._place_order("CHI-OAK")
		frappe.set_user("nyc.5av.a1@maison.example")
		with self.assertRaises(frappe.PermissionError):
			web_orders("CHI-OAK")
		frappe.set_user("chi.oak.a1@maison.example")
		self.assertEqual(web_orders("CHI-OAK")["boutique"], "CHI-OAK")

	def test_online_payment_then_collection_at_the_counter(self):
		from maison_pos.api import sales
		from maison_pos.api.webshop import set_web_order_status, simulate_payment

		out = self._place_order("CHI-OAK", pay_now=1)
		self.assertTrue(out["payment_url"])
		self.assertIn("/shop/pay?pr=", out["payment_url"])
		_web_session()
		paid = simulate_payment(out["payment_request"])
		frappe.set_user("Administrator")
		self.assertEqual(paid["status"], "Paid")
		so = frappe.get_doc("Sales Order", out["sales_order"])
		self.assertAlmostEqual(flt(so.maison_prepaid_amount), flt(so.rounded_total or so.grand_total), places=2)
		self.assertEqual(so.maison_web_status, "New")  # payment does not move the queue
		set_web_order_status(so.name, "Picking")
		set_web_order_status(so.name, "Ready")

		# collect: POS sale with the order's lines (at the web price — pricing rules may have applied), no tender
		lines = [{"item_code": i.item_code, "qty": i.qty, "rate": i.rate} for i in so.items]
		payload = pos_invoice(boutique="CHI-OAK", items=lines, payments=[], customer=WEB_CUSTOMER, sales_order=so.name)
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(si.maison_sales_order, so.name)
		self.assertAlmostEqual(flt(si.total_advance), flt(si.rounded_total or si.grand_total), places=2)
		self.assertAlmostEqual(flt(si.outstanding_amount), 0, places=2)
		self.assertTrue(si.maison_receipt_token)
		self.assertTrue(all(i.sales_order == so.name for i in si.items))
		so.reload()
		self.assertEqual(so.maison_web_status, "Collected")
		self.assertEqual(so.maison_sales_invoice, si.name)
		self.assertEqual(flt(so.per_billed), 100)

	def test_collection_with_balance_and_wrong_boutique(self):
		from maison_pos.api import sales
		from maison_pos.api.webshop import set_web_order_status

		out = self._place_order("CHI-OAK")
		set_web_order_status(out["sales_order"], "Picking")
		set_web_order_status(out["sales_order"], "Ready")
		so = frappe.get_doc("Sales Order", out["sales_order"])
		lines = [{"item_code": i.item_code, "qty": i.qty, "rate": i.rate} for i in so.items]
		# another boutique cannot collect it
		bad = pos_invoice(boutique="NYC-5AV", items=lines, customer=WEB_CUSTOMER, sales_order=so.name)
		self.assertEqual(sales.submit_batch([bad])["results"][0]["status"], "error")
		# nothing paid online: the whole amount is tendered at the counter
		good = pos_invoice(boutique="CHI-OAK", items=lines, customer=WEB_CUSTOMER, sales_order=so.name)
		result = sales.submit_batch([good])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(flt(si.total_advance), 0)
		self.assertAlmostEqual(flt(si.paid_amount), flt(si.rounded_total or si.grand_total), places=2)
		self.assertEqual(frappe.db.get_value("Sales Order", out["sales_order"], "maison_web_status"), "Collected")

	def test_reserve_with_deposit(self):
		from maison_pos.api.webshop import reserve

		_web_session()
		out = reserve("TP-002", "CHI-OAK")
		frappe.set_user("Administrator")
		so = frappe.get_doc("Sales Order", out["sales_order"])
		self.assertEqual(so.maison_web_mode, "Reserve-with-deposit")
		self.assertEqual(so.maison_boutique, "CHI-OAK")
		self.assertAlmostEqual(flt(so.maison_deposit_amount), 2450, places=2)  # 10 % of 24,500
		self.assertAlmostEqual(flt(out["amount"]), 2450, places=2)
		pr = frappe.get_doc("Payment Request", out["payment_request"])
		self.assertAlmostEqual(flt(pr.grand_total), 2450, places=2)
		# an Enquire piece cannot be reserved
		_web_session()
		with self.assertRaises(frappe.ValidationError):
			reserve("HJ-001", "CHI-OAK")
		frappe.set_user("Administrator")
