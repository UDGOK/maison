"""v0.6 O — store-manager scoping proven over **HTTP** against the running bench.

Unit tests (``test_v0_6_warehouse``) call the endpoints in-process; these go through the web
server with real sessions (login → cookie → ``/api/method/...``), so the permission hooks,
``permission_query_conditions`` and the REST layer are all exercised. The fixtures are committed
(the web workers cannot see an uncommitted test transaction) and removed again in ``tearDownClass``.
Skipped when the site is not being served (e.g. CI without ``bench start``).
"""

from __future__ import annotations

import unittest

import frappe
import requests
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, nowdate, nowtime

from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v0_6_warehouse import ITEM, WH_ADMIN, ensure_warehouse_admin

PWD = "maison123"
STORE_A, STORE_B = "NYC-5AV", "CHI-OAK"


def _base_url() -> str:
	port = frappe.conf.get("webserver_port") or 8000
	return f"http://127.0.0.1:{port}"


def _alive(base: str) -> bool:
	try:
		r = requests.get(f"{base}/api/method/frappe.ping", headers={"Host": frappe.local.site}, timeout=3)
		return r.ok and r.json().get("message") == "pong"
	except Exception:
		return False


class Client:
	"""Minimal session client: login, then GET / POST ``/api/method/<m>`` with CSRF."""

	def __init__(self, base: str, site: str, user: str, pwd: str):
		self.s = requests.Session()
		self.s.headers["Host"] = site
		self.base = base
		r = self.s.post(f"{base}/api/method/login", json={"usr": user, "pwd": pwd}, timeout=15)
		assert r.ok, f"login {user}: {r.status_code} {r.text[:200]}"
		page = self.s.get(f"{base}/pos", timeout=15).text
		import re

		m = re.search(r'window\.csrf_token = "([^"]*)"', page)
		self.csrf = m.group(1) if m else ""

	def get(self, method: str, **params):
		return self.s.get(f"{self.base}/api/method/{method}", params=params, timeout=30)

	def post(self, method: str, **data):
		return self.s.post(f"{self.base}/api/method/{method}", json=data, headers={"X-Frappe-CSRF-Token": self.csrf}, timeout=30)


class TestScopingHTTP(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.base = _base_url()
		if not _alive(cls.base):
			raise unittest.SkipTest("web server not running — HTTP scoping tests need `bench start`")
		ensure_demo_data()
		ensure_warehouse_admin()
		frappe.set_user("Administrator")
		from maison_pos.api import shipping
		from maison_pos.shipping import ensure_transit_warehouse, get_main_warehouse

		wh_b = frappe.db.get_value("Maison Boutique", STORE_B, "warehouse")
		src = get_main_warehouse(exclude=wh_b, company=frappe.db.get_value("Maison Boutique", STORE_B, "company"))
		company = frappe.db.get_value("Warehouse", src, "company")
		se = frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "purpose": "Material Receipt", "company": company, "to_warehouse": src, "posting_date": nowdate(), "posting_time": nowtime(), "set_posting_time": 1, "items": [{"item_code": ITEM, "qty": 3, "t_warehouse": src, "basic_rate": 10}]})
		se.flags.ignore_permissions = True
		se.insert()
		se.submit()
		cls.created = [("Stock Entry", se.name)]
		# a pending request + a shipped consignment, both for store B
		req = shipping.create_request(STORE_B, [{"item_code": ITEM, "qty": 1}], reason="http scoping test")
		cls.request_b = req.name
		sh = frappe.get_doc({"doctype": "Maison Shipment", "boutique": STORE_B, "from_warehouse": src, "transit_warehouse": ensure_transit_warehouse(STORE_B), "to_warehouse": wh_b, "status": "Pending", "lines": [{"item_code": ITEM, "qty": 2}]})
		sh.flags.ignore_permissions = True
		sh.insert()
		cls.shipment_b = sh.name
		frappe.set_user(WH_ADMIN)
		shipping.ship(sh.name)
		frappe.set_user("Administrator")
		frappe.db.commit()
		cls.manager_a = frappe.db.get_value("Maison Associate", {"boutique": STORE_A, "role": "Manager", "enabled": 1}, "user")
		cls.manager_b = frappe.db.get_value("Maison Associate", {"boutique": STORE_B, "role": "Manager", "enabled": 1}, "user")

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		try:
			sh = frappe.get_doc("Maison Shipment", cls.shipment_b)
			for se_name in (sh.stock_entry_receive, sh.stock_entry_damaged, sh.stock_entry_ship):
				if se_name and frappe.db.exists("Stock Entry", se_name):
					se = frappe.get_doc("Stock Entry", se_name)
					if se.docstatus == 1:
						se.flags.ignore_permissions = True
						se.cancel()
					se.delete(ignore_permissions=True)
			frappe.db.delete("Maison Receiving Discrepancy", {"shipment": cls.shipment_b})
			sh.delete(ignore_permissions=True)
			req = frappe.get_doc("Maison Replenishment Request", cls.request_b)
			mr = req.material_request
			req.delete(ignore_permissions=True)
			if mr and frappe.db.exists("Material Request", mr):
				frappe.delete_doc("Material Request", mr, force=True, ignore_permissions=True)
			for dt, name in cls.created:
				if frappe.db.exists(dt, name):
					doc = frappe.get_doc(dt, name)
					if doc.docstatus == 1:
						doc.flags.ignore_permissions = True
						doc.cancel()
					doc.delete(ignore_permissions=True)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), "v0.6 scoping http cleanup")
		super().tearDownClass()

	def client(self, user: str) -> Client:
		return Client(self.base, frappe.local.site, user, PWD)

	# ------------------------------------------------------------------ tests
	def test_manager_a_cannot_read_store_b_request_or_shipment(self):
		a = self.client(self.manager_a)
		r = a.get("maison_pos.api.shipping.shipment", shipment=self.shipment_b)
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("maison_pos.api.shipping.request_detail", request=self.request_b)
		self.assertEqual(r.status_code, 403, r.text[:200])
		# frappe.client.get_doc honours has_permission; get_list the query conditions
		r = a.get("frappe.client.get", doctype="Maison Shipment", name=self.shipment_b)
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("frappe.client.get_list", doctype="Maison Shipment", fields='["name"]', limit_page_length=500)
		self.assertEqual(r.status_code, 200)
		self.assertNotIn(self.shipment_b, [x["name"] for x in r.json()["message"]])
		r = a.get("frappe.client.get_list", doctype="Maison Replenishment Request", fields='["name"]', limit_page_length=500)
		self.assertNotIn(self.request_b, [x["name"] for x in r.json()["message"]])
		# the in-transit Stock Entry of store B is invisible in the desk list as well
		se = frappe.db.get_value("Maison Shipment", self.shipment_b, "stock_entry_ship")
		r = a.get("frappe.client.get_list", doctype="Stock Entry", fields='["name"]', limit_page_length=1000)
		self.assertNotIn(se, [x["name"] for x in r.json()["message"]])
		r = a.get("frappe.client.get", doctype="Stock Entry", name=se)
		self.assertEqual(r.status_code, 403)
		# the inbound list of store A never mentions it
		r = a.get("maison_pos.api.inventory.inbound")
		self.assertEqual(r.status_code, 200)
		self.assertNotIn(self.shipment_b, [s["name"] for s in r.json()["message"]["shipments"]])
		r = a.get("maison_pos.api.inventory.inbound", boutique=STORE_B)
		self.assertEqual(r.status_code, 403)

	def test_manager_b_can_read_own_store_documents(self):
		b = self.client(self.manager_b)
		r = b.get("maison_pos.api.shipping.shipment", shipment=self.shipment_b)
		self.assertEqual(r.status_code, 200, r.text[:200])
		self.assertEqual(r.json()["message"]["boutique"], STORE_B)
		r = b.get("frappe.client.get_list", doctype="Maison Shipment", fields='["name"]', limit_page_length=500)
		self.assertIn(self.shipment_b, [x["name"] for x in r.json()["message"]])
		r = b.get("maison_pos.api.inventory.inbound")
		self.assertIn(self.shipment_b, [s["name"] for s in r.json()["message"]["shipments"]])

	def test_manager_cannot_approve_reject_or_use_the_wall(self):
		a = self.client(self.manager_a)
		for method, data in (("approve", {"request": self.request_b}), ("reject", {"request": self.request_b, "reason": "x"}), ("pick", {"shipment": self.shipment_b}), ("ship", {"shipment": self.shipment_b})):
			r = a.post(f"maison_pos.api.shipping.{method}", **data)
			self.assertEqual(r.status_code, 403, f"{method}: {r.status_code} {r.text[:200]}")
		self.assertEqual(a.get("maison_pos.api.shipping.wall").status_code, 403)
		self.assertEqual(a.get("maison_pos.api.shipping.warehouse_stock").status_code, 403)
		# even the store's own manager cannot approve their own request
		b = self.client(self.manager_b)
		self.assertEqual(b.post("maison_pos.api.shipping.approve", request=self.request_b).status_code, 403)
		self.assertEqual(frappe.db.get_value("Maison Replenishment Request", self.request_b, "status"), "Pending Approval")

	def test_manager_a_cannot_receive_store_b_shipment(self):
		a = self.client(self.manager_a)
		r = a.post("maison_pos.api.inventory.receive_shipment", shipment=self.shipment_b, lines=[{"item_code": ITEM, "received_qty": 2}])
		self.assertEqual(r.status_code, 403, r.text[:200])
		self.assertEqual(frappe.db.get_value("Maison Shipment", self.shipment_b, "status"), "Shipped")
		r = a.post("maison_pos.api.inventory.replenish", boutique=STORE_B, lines=[{"item_code": ITEM, "qty": 1}])
		self.assertEqual(r.status_code, 403)

	def test_warehouse_admin_sees_everything_but_cannot_sell(self):
		w = self.client(WH_ADMIN)
		r = w.get("maison_pos.api.shipping.wall")
		self.assertEqual(r.status_code, 200, r.text[:200])
		cols = r.json()["message"]["columns"]
		self.assertIn(self.request_b, [c["name"] for c in cols["pending_approval"]])
		r = w.get("maison_pos.api.shipping.shipment", shipment=self.shipment_b)
		self.assertEqual(r.json()["message"]["status"], "Shipped")
		payload = {"offline_uuid": "http-wh-sell-1", "boutique": STORE_A, "device_id": "HTTP-WH", "posting_datetime": frappe.utils.now_datetime().isoformat(), "items": [{"item_code": ITEM, "qty": 1, "rate": 160}], "payments": [{"mode_of_payment": "Cash", "amount": 200}]}
		r = w.post("maison_pos.api.sales.submit_batch", invoices=[payload])
		self.assertEqual(r.status_code, 403, r.text[:200])
		self.assertFalse(frappe.db.exists("Sales Invoice", {"maison_offline_uuid": "http-wh-sell-1"}))
		r = w.get("maison_pos.api.catalog.bootstrap", boutique=STORE_A)
		self.assertEqual(r.status_code, 403)
		self.assertTrue(w.get("maison_pos.api.shipping.me").json()["message"]["warehouse_admin"])

	def test_guest_gets_nothing(self):
		s = requests.Session()
		s.headers["Host"] = frappe.local.site
		for m in ("shipping.wall", "shipping.shipments", "inventory.inbound"):
			r = s.get(f"{self.base}/api/method/maison_pos.api.{m}", timeout=15)
			self.assertIn(r.status_code, (401, 403), m)
		r = s.get(f"{self.base}/warehouse-wall", timeout=15, allow_redirects=False)
		# frappe.Redirect answers 301 → /login?redirect-to=…
		self.assertIn(r.status_code, (301, 302, 303, 401, 403))
		if r.status_code in (301, 302, 303):
			self.assertIn("/login", r.headers.get("Location", ""))
