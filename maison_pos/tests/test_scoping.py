"""Boutique scoping: Manager/Associate are confined to their boutique; HQ/Regional are not."""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from maison_pos import scoping
from maison_pos.api import catalog, dashboard, sales
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice

NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_MANAGER = "nyc.5av.manager@maison.example"
CHI_ASSOCIATE = "chi.oak.a1@maison.example"
HQ = "hq@maison.example"
REGIONAL = "regional@maison.example"


class TestScoping(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def tearDown(self):
		frappe.set_user("Administrator")

	def test_unrestricted_roles(self):
		self.assertTrue(scoping.is_unrestricted("Administrator"))
		self.assertTrue(scoping.is_unrestricted(HQ))
		self.assertTrue(scoping.is_unrestricted(REGIONAL))
		self.assertFalse(scoping.is_unrestricted(NYC_ASSOCIATE))
		self.assertFalse(scoping.is_unrestricted(NYC_MANAGER))

	def test_associate_resolves_own_boutique(self):
		self.assertEqual(scoping.get_user_boutique(NYC_ASSOCIATE), "NYC-5AV")
		self.assertEqual(scoping.get_allowed_boutiques(NYC_ASSOCIATE), ["NYC-5AV"])
		self.assertEqual(set(scoping.get_allowed_boutiques(HQ)), {"NYC-5AV", "CHI-OAK", "MIA-DD"})

	def test_associate_cannot_touch_other_boutique(self):
		frappe.set_user(NYC_ASSOCIATE)
		self.assertEqual(scoping.assert_boutique_access("NYC-5AV"), "NYC-5AV")
		self.assertEqual(scoping.assert_boutique_access(None), "NYC-5AV")  # defaults to own
		with self.assertRaises(frappe.PermissionError):
			scoping.assert_boutique_access("CHI-OAK")

	def test_hq_requires_explicit_boutique(self):
		frappe.set_user(HQ)
		self.assertEqual(scoping.assert_boutique_access("CHI-OAK"), "CHI-OAK")
		with self.assertRaises(frappe.ValidationError):
			scoping.assert_boutique_access(None)

	def test_catalog_bootstrap_scoped(self):
		frappe.set_user(CHI_ASSOCIATE)
		data = catalog.bootstrap("CHI-OAK")
		self.assertEqual(data["boutique"]["name"], "CHI-OAK")
		with self.assertRaises(frappe.PermissionError):
			catalog.bootstrap("NYC-5AV")

	def test_submit_batch_rejects_foreign_boutique_per_row(self):
		frappe.set_user(NYC_ASSOCIATE)
		foreign = pos_invoice(boutique="CHI-OAK")
		own = pos_invoice(boutique="NYC-5AV")
		results = sales.submit_batch([foreign, own])["results"]
		self.assertEqual(results[0]["status"], "error")
		self.assertEqual(results[0]["error_code"], sales.ERR_PERMISSION)
		self.assertEqual(results[1]["status"], "ok", results[1])

	def test_associate_cannot_void(self):
		frappe.set_user("Administrator")
		result = sales.submit_batch([pos_invoice()])["results"][0]
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(frappe.PermissionError):
			sales.void(result["invoice_name"], "nope")

	def test_manager_can_void_own_boutique_only(self):
		frappe.set_user("Administrator")
		nyc = sales.submit_batch([pos_invoice(boutique="NYC-5AV")])["results"][0]
		chi = sales.submit_batch([pos_invoice(boutique="CHI-OAK")])["results"][0]
		frappe.set_user(NYC_MANAGER)
		with self.assertRaises(frappe.PermissionError):
			sales.void(chi["invoice_name"], "foreign")
		out = sales.void(nyc["invoice_name"], "own boutique")
		self.assertTrue(out["credit_note"])

	def test_dashboard_scoped_to_own_boutique(self):
		frappe.set_user(NYC_MANAGER)
		summary = dashboard.live_summary()
		self.assertEqual([b["boutique"] for b in summary["by_boutique"]], ["NYC-5AV"])
		frappe.set_user(HQ)
		summary = dashboard.live_summary()
		self.assertEqual(len(summary["by_boutique"]), 3)

	def test_heartbeat_scoped(self):
		frappe.set_user(CHI_ASSOCIATE)
		self.assertTrue(dashboard.heartbeat("CHI-OAK", "IPAD-7", queued=2)["ok"])
		hb = frappe.db.get_value("Maison Device Heartbeat", {"boutique": "CHI-OAK", "device_id": "IPAD-7"}, ["status", "queued"], as_dict=True)
		self.assertEqual((hb.status, hb.queued), ("Online", 2))
		with self.assertRaises(frappe.PermissionError):
			dashboard.heartbeat("MIA-DD", "IPAD-7", queued=0)

	def test_price_change_request_scoped(self):
		frappe.set_user(NYC_MANAGER)
		with self.assertRaises(frappe.PermissionError):
			frappe.get_doc(
				{
					"doctype": "Maison Price Change Request",
					"item_code": "AC-001",
					"boutique": "CHI-OAK",
					"proposed_rate": 2_000,
					"reason": "x",
					"valid_from": frappe.utils.nowdate(),
				}
			).insert()

	def test_pin_verify(self):
		from maison_pos.maison_pos.doctype.maison_associate.maison_associate import verify_pin

		frappe.set_user(NYC_ASSOCIATE)
		self.assertTrue(verify_pin(NYC_ASSOCIATE, "2580")["ok"])
		self.assertFalse(verify_pin(NYC_ASSOCIATE, "0000")["ok"])
		with self.assertRaises(frappe.PermissionError):
			verify_pin(CHI_ASSOCIATE, "2580")
		self.assertFalse(frappe.db.get_value("Maison Associate", NYC_ASSOCIATE, "pin"))
		# v0.7 S2 — the hash lives in `__Auth` (Password fieldtype); the column holds only asterisks
		column = frappe.db.get_value("Maison Associate", NYC_ASSOCIATE, "pin_hash")
		self.assertEqual(set(column), {"*"})
		self.assertTrue(frappe.get_doc("Maison Associate", NYC_ASSOCIATE).get_pin_hash().startswith("pbkdf2_sha256$"))
