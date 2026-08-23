"""v0.2: receipt token + guest endpoint, client numbers + lookup, barcode map, image upload permission."""

from __future__ import annotations

import base64
import io

import frappe
from frappe.tests.utils import FrappeTestCase
from werkzeug.test import EnvironBuilder
from werkzeug.wrappers import Request

from maison_pos import identifiers
from maison_pos.api import catalog, customers, sales
from maison_pos.tests.helpers import ensure_demo_data, first_serial, pos_invoice
from maison_pos.utils import receipt_payload, receipt_qr_svg, receipt_url

NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_MANAGER = "nyc.5av.manager@maison.example"

# 1x1 PNG
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


class TestReceiptToken(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")

	def _submit(self, **kw):
		result = sales.submit_batch([pos_invoice(**kw)])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		return frappe.get_doc("Sales Invoice", result["invoice_name"])

	def test_token_set_on_submit_and_unique(self):
		a = self._submit()
		b = self._submit()
		self.assertEqual(len(a.maison_receipt_token), identifiers.RECEIPT_TOKEN_LENGTH)
		self.assertNotEqual(a.maison_receipt_token, b.maison_receipt_token)
		self.assertTrue(receipt_url(a.maison_receipt_token).endswith(f"/r/{a.maison_receipt_token}"))

	def test_submit_batch_returns_token_for_ok_and_duplicate(self):
		payload = pos_invoice()
		first = sales.submit_batch([payload])["results"][0]
		self.assertEqual(first["status"], "ok", first)
		self.assertEqual(len(first.get("receipt_token") or ""), identifiers.RECEIPT_TOKEN_LENGTH)
		again = sales.submit_batch([payload])["results"][0]
		self.assertEqual(again["status"], "duplicate", again)
		self.assertEqual(again["invoice_name"], first["invoice_name"])
		self.assertEqual(again["receipt_token"], first["receipt_token"])

	def test_guest_receipt_endpoint_returns_printed_data_only(self):
		customer = frappe.db.get_value("Customer", {"customer_name": "Mei-Lin Chen"}, "name")
		si = self._submit(customer=customer, items=[{"item_code": "AC-012", "qty": 2, "rate": 160}])
		frappe.set_user("Guest")
		try:
			data = sales.receipt(si.maison_receipt_token)
		finally:
			frappe.set_user("Administrator")
		self.assertEqual(data["invoice"], si.name)
		self.assertEqual(data["boutique"]["code"], "NYC-5AV")
		self.assertEqual(data["totals"]["grand_total"], float(si.grand_total))
		self.assertEqual(len(data["lines"]), 1)
		self.assertEqual(data["lines"][0]["qty"], 2.0)
		self.assertEqual(data["payments"][0]["mode_of_payment"], "Card")
		self.assertTrue(data["client"]["present"])
		self.assertTrue(data["client"]["client_number_masked"].startswith("MC•••"))
		blob = frappe.as_json(data)
		self.assertNotIn("Mei-Lin", blob)
		self.assertNotIn(customer, blob.replace(si.name, ""))
		self.assertNotIn("mobile", blob)

	def test_guest_receipt_unknown_token_404(self):
		frappe.set_user("Guest")
		try:
			with self.assertRaises(frappe.DoesNotExistError):
				sales.receipt("nope-nope-nope-1")
			with self.assertRaises(frappe.DoesNotExistError):
				sales.receipt("")
		finally:
			frappe.set_user("Administrator")

	def test_receipt_qr_svg_and_print_format(self):
		si = self._submit()
		svg = receipt_qr_svg(si)
		self.assertTrue(svg.startswith("data:image/svg+xml;base64,"))
		self.assertIn("<svg", base64.b64decode(svg.split(",", 1)[1]).decode())
		html = frappe.get_print("Sales Invoice", si.name, print_format="Maison Receipt", no_letterhead=1)
		self.assertIn("data:image/svg+xml;base64,", html)
		self.assertIn("Scan for your receipt", html)
		# draft invoice has no token -> no QR
		draft = frappe.new_doc("Sales Invoice")
		self.assertEqual(receipt_qr_svg(draft), "")

	def test_receipt_qr_respects_setting(self):
		si = self._submit()
		settings = frappe.get_doc("Maison POS Settings")
		settings.receipt_qr_enabled = 0
		settings.save()
		try:
			self.assertEqual(receipt_qr_svg(si), "")
			self.assertEqual(receipt_payload(si)["token"], si.maison_receipt_token)
		finally:
			settings.receipt_qr_enabled = 1
			settings.save()


class TestClientNumber(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")

	def test_seeded_customers_have_numbers(self):
		rows = frappe.get_all("Customer", filters={"disabled": 0}, fields=["name", "maison_client_number"])
		# every customer (demo + walk-in) gets one; all unique
		numbers = [r.maison_client_number for r in rows]
		self.assertTrue(all(identifiers.is_client_number(n) for n in numbers), numbers)
		self.assertEqual(len(numbers), len(set(numbers)))

	def test_new_customer_gets_number_on_insert(self):
		name = customers.upsert({"customer_name": "Test Number Client", "mobile_no": "+1 (415) 555-0199", "email_id": "number@example.com"})["name"]
		number = frappe.db.get_value("Customer", name, "maison_client_number")
		self.assertTrue(identifiers.is_client_number(number))
		self.assertEqual(len(number), 8)

	def test_lookup_by_number_phone_email_and_qr(self):
		name = customers.upsert({"customer_name": "Lookup Client", "mobile_no": "+1 (646) 555-0177", "email_id": "lookup@example.com"})["name"]
		number = frappe.db.get_value("Customer", name, "maison_client_number")
		for code in (number, number.lower(), f"MC:{name}", f"MC:{number}", "6465550177", "(646) 555-0177", "lookup@example.com"):
			row = customers.lookup(code)
			self.assertIsNotNone(row, code)
			self.assertEqual(row["name"], name, code)
			self.assertEqual(row["client_number"], number)
			self.assertIn("loyalty_points", row)
			self.assertIn("points_value", row)
		self.assertIsNone(customers.lookup("MC000000X"))
		self.assertIsNone(customers.lookup("nobody@example.com"))

	def test_search_matches_number_phone_last4_email_name(self):
		name = customers.upsert({"customer_name": "Searchable Client", "mobile_no": "+1 917 555 0123", "email_id": "searchme@example.com"})["name"]
		number = frappe.db.get_value("Customer", name, "maison_client_number")
		for q in (number, number[2:], "0123", "917 555", "searchme@", "Searchable"):
			names = [r["name"] for r in customers.search(q)]
			self.assertIn(name, names, q)
		row = next(r for r in customers.search(number) if r["name"] == name)
		self.assertEqual(row["client_number"], number)
		self.assertIn("loyalty_points", row)
		self.assertIn("points_value", row)
		self.assertIn("tier", row)

	def test_face_consent_stamped_and_cleared(self):
		name = customers.upsert({"customer_name": "Consent Client", "email_id": "consent@example.com"})["name"]
		doc = frappe.get_doc("Customer", name)
		self.assertFalse(doc.maison_face_consent)
		self.assertIsNone(doc.maison_face_consent_on)
		doc.maison_face_consent = 1
		doc.save()
		self.assertIsNotNone(doc.maison_face_consent_on)
		doc.maison_face_consent = 0
		doc.maison_face_id = "x"
		doc.save()
		self.assertIsNone(doc.maison_face_consent_on)
		self.assertFalse(doc.maison_face_id)


class TestBarcodes(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")

	def test_ean13_is_deterministic_and_valid(self):
		a, b = identifiers.ean13_for("TP-001"), identifiers.ean13_for("TP-001")
		self.assertEqual(a, b)
		self.assertTrue(identifiers.is_valid_ean13(a))
		self.assertNotEqual(a, identifiers.ean13_for("TP-002"))

	def test_bootstrap_barcodes_settings_image(self):
		data = catalog.bootstrap("NYC-5AV")
		self.assertIn("barcodes", data)
		self.assertIn("settings", data)
		ean = frappe.db.get_value("Item", "AC-012", "maison_barcode")
		self.assertTrue(ean)
		self.assertEqual(data["barcodes"][ean], "AC-012")
		serial = first_serial("TP-001", "NYC-5AV")
		self.assertEqual(data["barcodes"][serial], "TP-001")
		self.assertIn(serial, data["serials"]["TP-001"])
		item = next(i for i in data["items"] if i["item_code"] == "AC-012")
		self.assertIn("image", item)
		self.assertNotIn("maison_image_url", item)
		self.assertEqual(item["maison_barcode"], ean)
		s = data["settings"]
		for key in ("show_product_images", "scan_enabled", "receipt_qr_enabled", "receipt_qr_base_url", "loyalty_lookup_enabled", "face_recognition_enabled"):
			self.assertIn(key, s)
		self.assertEqual(s["face_recognition_enabled"], 0)
		self.assertTrue(s["receipt_qr_base_url"].startswith("http"))
		self.assertIn("show_product_images", data["boutique"])

	def test_boutique_overrides_show_images(self):
		frappe.db.set_value("Maison Boutique", "MIA-DD", "show_product_images", 1)
		try:
			self.assertEqual(catalog.bootstrap("MIA-DD")["settings"]["show_product_images"], 1)
			self.assertEqual(catalog.bootstrap("NYC-5AV")["settings"]["show_product_images"], 0)
		finally:
			frappe.db.set_value("Maison Boutique", "MIA-DD", "show_product_images", 0)

	def test_delta_has_barcodes(self):
		data = catalog.delta("NYC-5AV", "2000-01-01T00:00:00")
		self.assertIn("barcodes", data)
		self.assertIn("settings", data)
		self.assertTrue(data["barcodes"])


class TestUploadItemImage(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def tearDown(self):
		frappe.set_user("Administrator")
		# `frappe.request` is a werkzeug LocalProxy onto `frappe.local.request`: assigning to the
		# module attribute would REBIND the name and replace the proxy with a plain value for the
		# rest of the process, so every later test in the run would see that stale value instead of
		# its own request (this broke the v0.5 campaign webhook tests). Always go through frappe.local.
		frappe.local.request = None

	def _with_upload(self, content: bytes = PNG, content_type: str = "image/png", filename: str = "tile.png"):
		builder = EnvironBuilder(method="POST", data={"file": (io.BytesIO(content), filename, content_type)})
		frappe.local.request = Request(builder.get_environ())

	def test_associate_is_denied(self):
		frappe.set_user(NYC_ASSOCIATE)
		self._with_upload()
		with self.assertRaises(frappe.PermissionError):
			catalog.upload_item_image("AC-012")

	def test_manager_can_upload_and_image_is_set(self):
		frappe.set_user(NYC_MANAGER)
		self._with_upload()
		out = catalog.upload_item_image("AC-012")
		self.assertEqual(out["item_code"], "AC-012")
		self.assertTrue(out["image"].startswith("http"))
		self.assertTrue(out["file_url"].startswith("/files/"))
		self.assertEqual(frappe.db.get_value("Item", "AC-012", "image"), out["file_url"])
		frappe.set_user("Administrator")
		item = next(i for i in catalog.bootstrap("NYC-5AV")["items"] if i["item_code"] == "AC-012")
		self.assertEqual(item["image"], out["image"])

	def test_rejects_non_image_and_unknown_item(self):
		frappe.set_user(NYC_MANAGER)
		self._with_upload(b"hello", "text/plain", "x.txt")
		with self.assertRaises(frappe.ValidationError):
			catalog.upload_item_image("AC-012")
		self._with_upload()
		with self.assertRaises(frappe.DoesNotExistError):
			catalog.upload_item_image("NOPE-999")
