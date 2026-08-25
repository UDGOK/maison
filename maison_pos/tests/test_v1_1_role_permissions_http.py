"""v1.1.1 — the store **Receive** screen for a regional, proven over **HTTP**.

The field report came from a browser, so the regression belongs in a browser-shaped test: real
logins, real sessions, real ``/api/method`` calls, so the whitelist gates, the ``has_permission``
hooks, the ``permission_query_conditions`` and the REST layer are all in the path — the same shape
as ``test_v0_6_scoping_http`` and ``test_v1_0_purchasing_http``.

Two directions, both of them:

* the regional whose Receive screen was blank can now load it — ``inventory.inbound``,
  ``inventory.replenishment_requests`` — and ask the warehouse for stock
  (``inventory.replenish``), holding **no** ERPNext stock or selling role;
* and has gained nothing else: the other region's documents are still unreadable, the ERPNext
  stock documents are still unwritable, the warehouse's own endpoints are still refused, and the
  negotiated vendor costs are still out of reach.

Skipped when the site is not being served (CI without ``bench start``).
"""

from __future__ import annotations

import json
import re
import unittest

import frappe
import requests
from frappe.tests.utils import FrappeTestCase

from maison_pos.api import shipping as shipping_api
from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v1_1_role_permissions import (
	ITEM,
	ITEM_READING_ERPNEXT_ROLES,
	REGION_A_STORE,
	REGION_B_STORE,
	fence_to_region,
	role_only_user,
)

PWD = "maison123"
REGIONAL_A = "v11.http.region.a@awanz.test"
#: the exact text the regional manager was shown, so the test fails loudly if it ever comes back
FIELD_REPORT = "does not have doctype access via role permission"


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
		m = re.search(r'window\.csrf_token = "([^"]*)"', page)
		self.csrf = m.group(1) if m else ""

	def get(self, method: str, /, **params):
		return self.s.get(f"{self.base}/api/method/{method}", params=params, timeout=30)

	def post(self, method: str, /, **data):
		return self.s.post(f"{self.base}/api/method/{method}", json=data, headers={"X-Frappe-CSRF-Token": self.csrf}, timeout=30)


def refresh() -> None:
	"""Start a new read snapshot.

	The web workers write on their own connections; this connection opened its transaction before
	they did, so under MariaDB's REPEATABLE READ it would keep reading the world as it was. The
	suite holds no pending writes of its own at this point — every fixture was committed in
	``setUpClass`` — so a commit here only moves the snapshot forward.
	"""
	frappe.db.commit()


def server_messages(response) -> list[str]:
	"""The ``_server_messages`` a response carries — where a refused permission check lands."""
	try:
		raw = response.json().get("_server_messages")
	except Exception:
		return []
	out: list[str] = []
	for entry in json.loads(raw) if raw else []:
		try:
			out.append(str(json.loads(entry).get("message")))
		except Exception:
			out.append(str(entry))
	return out


class TestRegionalReceiveScreenHTTP(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.base = _base_url()
		if not _alive(cls.base):
			raise unittest.SkipTest("web server not running — HTTP role tests need `bench start`")
		ensure_demo_data()
		frappe.set_user("Administrator")
		from maison_pos.setup import install

		install.create_role_permissions({key: value for key, value in install.ROLE_DOCPERMS.items() if key[0] == "Item"})
		cls.regional = role_only_user(REGIONAL_A, "AWANZ Regional")
		fence_to_region(cls.regional, REGION_A_STORE)
		# one request in each region — the web workers cannot see an uncommitted transaction
		cls.request_a = shipping_api.create_request(REGION_A_STORE, [{"item_code": ITEM, "qty": 1}], reason="v1.1.1 http region A").name
		cls.request_b = shipping_api.create_request(REGION_B_STORE, [{"item_code": ITEM, "qty": 1}], reason="v1.1.1 http region B").name
		frappe.clear_cache()
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		"""Leave nothing behind — a stray fixture here poisons another suite.

		A replenishment request into region A pulls from region B's warehouse on the demo world
		(`get_main_warehouse` picks the next store's warehouse when the company has no dedicated
		one), so its draft **Material Request touches both stores**. Left lying about, that is
		exactly the row ``test_v0_6_scoping_http`` audits for. So the sweep is by *author* rather
		than by a list this class collected: whatever the regional raised over the wire goes,
		including anything a failing test raised before it stopped.
		"""
		frappe.set_user("Administrator")
		try:
			frappe.db.commit()  # the web workers wrote on their own connections — see `refresh`
			raised = frappe.get_all("AWANZ Replenishment Request", filters={"requested_by": REGIONAL_A}, pluck="name")
			for name in raised + [cls.request_b, cls.request_a]:
				if not name or not frappe.db.exists("AWANZ Replenishment Request", name):
					continue
				material_request = frappe.db.get_value("AWANZ Replenishment Request", name, "material_request")
				frappe.delete_doc("AWANZ Replenishment Request", name, force=True, ignore_permissions=True)
				if material_request and frappe.db.exists("Material Request", material_request):
					frappe.delete_doc("Material Request", material_request, force=True, ignore_permissions=True)
			frappe.db.delete("User Permission", {"user": REGIONAL_A})
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), "v1.1.1 role permissions http cleanup")
		super().tearDownClass()

	def client(self, user: str) -> Client:
		return Client(self.base, frappe.local.site, user, PWD)

	# ------------------------------------------------------------------ the regression
	def test_the_regional_holds_no_erpnext_role_that_reads_item(self):
		"""Guard the fixture: borrowing the permission again would make every test below a lie."""
		held = set(frappe.get_roles(self.regional))
		self.assertEqual(held & set(ITEM_READING_ERPNEXT_ROLES), set())
		self.assertIn("AWANZ Regional", held)

	def test_the_receive_screen_loads_for_a_regional(self):
		a = self.client(self.regional)
		r = a.get("maison_pos.api.inventory.inbound", boutique=REGION_A_STORE)
		self.assertEqual(r.status_code, 200, r.text[:300])
		payload = r.json()["message"]
		self.assertEqual(payload["boutique"], REGION_A_STORE)
		for key in ("shipments", "preparing", "purchase_orders", "recent"):
			self.assertIsInstance(payload[key], list, key)
		r = a.get("maison_pos.api.inventory.replenishment_requests", boutique=REGION_A_STORE, status="all", limit=30)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertIn(self.request_a, [row["name"] for row in r.json()["message"]["requests"]])

	def test_a_regional_can_ask_the_warehouse_for_stock(self):
		"""``replenish`` is the call that failed in the field, with the Item message in red."""
		a = self.client(self.regional)
		r = a.post("maison_pos.api.inventory.replenish", boutique=REGION_A_STORE, lines=[{"item_code": ITEM, "qty": 3}], reason="v1.1.1 http regression")
		self.assertEqual(r.status_code, 200, r.text[:400])
		self.assertNotIn(FIELD_REPORT, r.text, "the reported permission error came back")
		name = r.json()["message"]["name"]
		refresh()
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", name, "boutique"), REGION_A_STORE)
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", name, "requested_by"), self.regional)
		self.assertTrue(frappe.db.get_value("AWANZ Replenishment Request", name, "material_request"))
		# `tearDownClass` sweeps by author, so nothing this raised outlives the class

	def test_no_call_the_screen_makes_reports_a_missing_doctype_permission(self):
		a = self.client(self.regional)
		for method, params in (
			("maison_pos.api.inventory.inbound", {"boutique": REGION_A_STORE}),
			("maison_pos.api.inventory.replenishment_requests", {"boutique": REGION_A_STORE, "status": "all"}),
			("maison_pos.api.shipping.request_detail", {"request": self.request_a}),
		):
			r = a.get(method, **params)
			self.assertEqual(r.status_code, 200, f"{method}: {r.text[:300]}")
			for message in server_messages(r):
				self.assertNotIn(FIELD_REPORT, message, f"{method}: {message}")

	# ------------------------------------------------------------------ and nothing more
	def test_a_regional_cannot_read_the_other_regions_documents(self):
		"""The fence is User Permissions; opening a doctype for the role must not lift it."""
		a = self.client(self.regional)
		listed = a.get("frappe.client.get_list", doctype="AWANZ Replenishment Request", fields='["name"]', limit_page_length=0)
		self.assertEqual(listed.status_code, 200, listed.text[:300])
		names = [row["name"] for row in listed.json()["message"]]
		self.assertIn(self.request_a, names)
		self.assertNotIn(self.request_b, names, "another region's request must not be listable")
		self.assertEqual(a.get("frappe.client.get", doctype="AWANZ Replenishment Request", name=self.request_b).status_code, 403)
		self.assertEqual(a.get("frappe.client.get", doctype="AWANZ Store", name=REGION_B_STORE).status_code, 403)
		self.assertEqual(a.get("frappe.client.get", doctype="AWANZ Store", name=REGION_A_STORE).status_code, 200)
		stores = a.get("frappe.client.get_list", doctype="AWANZ Store", fields='["name"]', limit_page_length=0)
		self.assertNotIn(REGION_B_STORE, [row["name"] for row in stores.json()["message"]])

	def test_a_regional_cannot_write_stock_documents(self):
		warehouse = frappe.db.get_value("AWANZ Store", REGION_A_STORE, ["warehouse", "company"], as_dict=True)
		a = self.client(self.regional)
		entry = {
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Receipt",
			"purpose": "Material Receipt",
			"company": warehouse.company,
			"to_warehouse": warehouse.warehouse,
			"items": [{"item_code": ITEM, "qty": 1, "t_warehouse": warehouse.warehouse, "basic_rate": 1, "allow_zero_valuation_rate": 1}],
		}
		entry["remarks"] = "v1.1.1 http tamper"
		r = a.post("frappe.client.insert", doc=entry)
		self.assertEqual(r.status_code, 403, r.text[:300])
		refresh()
		self.assertFalse(frappe.db.exists("Stock Entry", {"remarks": "v1.1.1 http tamper"}))
		# the draft Material Request behind their own store's request is read-only to them too
		material_request = frappe.db.get_value("AWANZ Replenishment Request", self.request_a, "material_request")
		title = frappe.db.get_value("Material Request", material_request, "title")
		r = a.post("frappe.client.set_value", doctype="Material Request", name=material_request, fieldname="title", value="tampered")
		self.assertEqual(r.status_code, 403, r.text[:300])
		r = a.post("frappe.client.delete", doctype="Material Request", name=material_request)
		self.assertEqual(r.status_code, 403, r.text[:300])
		refresh()
		self.assertEqual(frappe.db.get_value("Material Request", material_request, "title"), title)
		self.assertEqual(frappe.db.get_value("Material Request", material_request, "docstatus"), 0)

	def test_a_regional_cannot_edit_the_catalogue_they_can_now_read(self):
		a = self.client(self.regional)
		self.assertEqual(a.get("frappe.client.get", doctype="Item", name=ITEM).status_code, 200)
		r = a.post("frappe.client.set_value", doctype="Item", name=ITEM, fieldname="item_name", value="tampered")
		self.assertEqual(r.status_code, 403, r.text[:300])
		r = a.post("frappe.client.insert", doc={"doctype": "Item", "item_code": "V11-TAMPER-1", "item_group": frappe.db.get_value("Item", ITEM, "item_group"), "stock_uom": "Nos"})
		self.assertEqual(r.status_code, 403, r.text[:300])
		refresh()
		self.assertNotEqual(frappe.db.get_value("Item", ITEM, "item_name"), "tampered")
		self.assertFalse(frappe.db.exists("Item", "V11-TAMPER-1"))

	def test_a_regional_still_cannot_decide_their_own_request(self):
		"""Raising a request is not approving one — the workflow keeps that with the warehouse.

		(A regional does read the warehouse board: ``scoping.is_supply_unrestricted`` has counted
		them as unrestricted since v0.6, and that is unchanged here. What they must not do is move
		the request themselves, which is what this pins.)
		"""
		a = self.client(self.regional)
		for method, data in (
			("maison_pos.api.shipping.approve", {"request": self.request_a}),
			("maison_pos.api.shipping.reject", {"request": self.request_a, "reason": "no"}),
		):
			r = a.post(method, **data)
			self.assertEqual(r.status_code, 403, f"{method}: {r.status_code} {r.text[:200]}")
		refresh()
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", self.request_a, "status"), "Pending Approval")

	def test_reading_item_did_not_open_the_negotiated_costs(self):
		a = self.client(self.regional)
		items = a.get("frappe.client.get_list", doctype="Item", fields='["name"]', limit_page_length=5)
		self.assertEqual(items.status_code, 200, items.text[:300])
		self.assertTrue(items.json()["message"], "the catalogue must be readable — that is the fix")
		r = a.get("frappe.client.get_list", doctype="AWANZ Item Vendor", parent="Item", fields='["name","supplier","cost"]', limit_page_length=0)
		self.assertTrue(r.status_code == 403 or r.json()["message"] == [], r.text[:300])
		r = a.get("frappe.client.get_list", doctype="Item Price", filters='[["buying","=",1]]', fields='["name","price_list_rate"]', limit_page_length=200)
		self.assertEqual(r.status_code, 403, r.text[:300])
		r = a.get("frappe.client.get_list", doctype="AWANZ Purchase Suggestion", fields='["name"]', limit_page_length=200)
		self.assertTrue(r.status_code == 403 or r.json()["message"] == [], r.text[:300])
