"""v1.0 §D — purchasing scoping proven over **HTTP** against the running bench.

Same shape as ``test_v0_6_scoping_http``: real logins, real sessions, real ``/api/method`` calls,
so the whitelist gates, ``permission_query_conditions`` and the REST layer are all exercised.
Both directions are proved:

* a store manager is refused **every** purchasing endpoint (and the buying reports, and the
  vendor / suggestion tables over the generic REST surface);
* the same manager *can* read the drop-ship Purchase Order addressed to their own store — which
  is what makes the store Receive screen work — and only that one.

Skipped when the site is not being served (CI without ``bench start``).
"""

from __future__ import annotations

import re
import unittest

import frappe
import requests
from frappe.tests.utils import FrappeTestCase
from frappe.utils import nowdate

from maison_pos.purchasing import orders as po_lib
from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v0_6_warehouse import WH_ADMIN, ensure_warehouse_admin
from maison_pos.tests.test_v1_0_purchasing import ensure_item, ensure_vendor

PWD = "maison123"
STORE_A, STORE_B = "NYC-5AV", "MIA-DD"
VENDOR = "AWANZ HTTP Distro"
ITEM = "V10-HTTP-1"


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

	# positional-only: one of the endpoints under test takes a `method` argument of its own
	def get(self, endpoint: str, /, **params):
		return self.s.get(f"{self.base}/api/method/{endpoint}", params=params, timeout=30)

	def post(self, endpoint: str, /, **data):
		return self.s.post(f"{self.base}/api/method/{endpoint}", json=data, headers={"X-Frappe-CSRF-Token": self.csrf}, timeout=30)


class TestPurchasingScopingHTTP(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.base = _base_url()
		if not _alive(cls.base):
			raise unittest.SkipTest("web server not running — HTTP scoping tests need `bench start`")
		ensure_demo_data()
		ensure_warehouse_admin()
		frappe.set_user("Administrator")
		cls.manager_a = frappe.db.get_value("AWANZ Associate", {"boutique": STORE_A, "role": "Manager", "enabled": 1}, "user")
		cls.manager_b = frappe.db.get_value("AWANZ Associate", {"boutique": STORE_B, "role": "Manager", "enabled": 1}, "user")
		if not (cls.manager_a and cls.manager_b):
			raise unittest.SkipTest("demo managers missing for the two stores")
		ensure_vendor(VENDOR)
		ensure_item(ITEM)
		from maison_pos.api import purchasing as purchasing_api

		purchasing_api.save_item_vendor(ITEM, {"supplier": VENDOR, "cost": 5.0, "case_pack": 4, "is_preferred": 1})
		company = frappe.db.get_value("AWANZ Store", STORE_B, "company")
		cls.dropship_po = po_lib.submit_order(
			po_lib.create_order(VENDOR, [{"item_code": ITEM, "qty": 4, "rate": 5.0}], dropship_store=STORE_B, company=company).name
		).name
		cls.warehouse_po = po_lib.submit_order(
			po_lib.create_order(VENDOR, [{"item_code": ITEM, "qty": 4, "rate": 5.0}], company=company).name
		).name
		cls.draft_po = po_lib.create_order(VENDOR, [{"item_code": ITEM, "qty": 2, "rate": 5.0}], company=company).name
		cls.extra: list[str] = []  # orders raised over HTTP by a test, cleaned up with the rest
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		try:
			for name in (cls.draft_po, cls.warehouse_po, cls.dropship_po, *getattr(cls, "extra", [])):
				if name and frappe.db.exists("Purchase Order", name):
					doc = frappe.get_doc("Purchase Order", name)
					if doc.docstatus == 1:
						doc.flags.ignore_permissions = True
						doc.cancel()
					doc.delete(ignore_permissions=True)
			frappe.db.delete("AWANZ Purchase Suggestion", {"item_code": ITEM})
			frappe.db.delete("AWANZ Item Vendor", {"parent": ITEM, "parenttype": "Item"})
			frappe.db.delete("Item Price", {"item_code": ITEM})
			frappe.clear_document_cache("Item", ITEM)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), "v1.0 purchasing http cleanup")
		super().tearDownClass()

	def client(self, user: str) -> Client:
		return Client(self.base, frappe.local.site, user, PWD)

	# ------------------------------------------------------------------ refused
	def test_a_store_manager_is_refused_every_purchasing_endpoint(self):
		a = self.client(self.manager_a)
		for method, params in (
			("maison_pos.api.purchasing.vendors", {}),
			("maison_pos.api.purchasing.vendor", {"name": VENDOR}),
			("maison_pos.api.purchasing.item_vendors", {"item_code": ITEM}),
			("maison_pos.api.purchasing.suggestions", {}),
			("maison_pos.api.purchasing.orders", {}),
			("maison_pos.api.purchasing.inbound", {}),
			("maison_pos.api.purchasing.stock", {}),
		):
			r = a.get(method, **params)
			self.assertEqual(r.status_code, 403, f"GET {method}: {r.status_code} {r.text[:200]}")
		for method, data in (
			("maison_pos.api.purchasing.save_vendor", {"payload": {"supplier_name": "HTTP Sneaky Vendor"}}),
			("maison_pos.api.purchasing.set_vendor_active", {"name": VENDOR, "active": 0}),
			("maison_pos.api.purchasing.save_item_vendor", {"item_code": ITEM, "row": {"supplier": VENDOR, "cost": 1}}),
			("maison_pos.api.purchasing.set_preferred_vendor", {"item_code": ITEM, "supplier": VENDOR}),
			("maison_pos.api.purchasing.create_orders", {"lines": [{"item_code": ITEM, "qty": 1, "supplier": VENDOR}]}),
			("maison_pos.api.purchasing.create_order", {"supplier": VENDOR, "lines": [{"item_code": ITEM, "qty": 1}]}),
			("maison_pos.api.purchasing.update_order", {"name": self.draft_po, "freight": 10}),
			# …including re-addressing the order to their own store, and binning it altogether
			("maison_pos.api.purchasing.update_order", {"name": self.draft_po, "dropship_store": STORE_A}),
			("maison_pos.api.purchasing.delete_order", {"name": self.draft_po, "reason": "nope"}),
			("maison_pos.api.purchasing.submit_order", {"name": self.draft_po}),
			("maison_pos.api.purchasing.send_order", {"name": self.warehouse_po, "method": "Email"}),
			("maison_pos.api.purchasing.close_order", {"name": self.warehouse_po, "reason": "nope"}),
			("maison_pos.api.purchasing.receive", {"po": self.warehouse_po, "lines": [{"item_code": ITEM, "qty": 1}]}),
		):
			r = a.post(method, **data)
			self.assertEqual(r.status_code, 403, f"POST {method}: {r.status_code} {r.text[:200]}")
		self.assertFalse(frappe.db.exists("Supplier", "HTTP Sneaky Vendor"))
		self.assertTrue(frappe.db.exists("Purchase Order", self.draft_po))
		self.assertEqual(frappe.db.get_value("Purchase Order", self.draft_po, "docstatus"), 0)
		self.assertFalse(frappe.db.get_value("Purchase Order", self.draft_po, "maison_dropship_store"))
		self.assertTrue(frappe.db.get_value("Supplier", VENDOR, "maison_active"))

	def test_a_store_manager_cannot_enumerate_the_negotiated_costs(self):
		"""Vendor *names* stay visible (ERPNext gives every Stock User read on Supplier, and the
		store reads the vendor off the drop-ship order it receives). What v1.0 keeps out of reach
		is what we *pay*: the buying price list, the item ↔ vendor catalogue and the buying list."""
		a = self.client(self.manager_a)
		r = a.get("frappe.client.get_list", doctype="Item Price", filters='[["buying","=",1]]', fields='["name","price_list_rate"]', limit_page_length=200)
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("frappe.client.get_list", doctype="AWANZ Purchase Suggestion", fields='["name"]', limit_page_length=200)
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("frappe.client.get_list", doctype="AWANZ Item Vendor", parent="Item", fields='["name","supplier","cost"]', limit_page_length=200)
		self.assertTrue(r.status_code == 403 or r.json()["message"] == [], r.text[:200])
		# the warehouse admin does see them
		w = self.client(WH_ADMIN)
		r = w.get("frappe.client.get_list", doctype="AWANZ Item Vendor", parent="Item", fields='["name","supplier","cost"]', limit_page_length=200)
		self.assertEqual(r.status_code, 200, r.text[:200])
		self.assertTrue(any(row["supplier"] == VENDOR for row in r.json()["message"]), r.text[:300])

	def test_a_store_manager_cannot_run_or_export_a_buying_report(self):
		a = self.client(self.manager_a)
		r = a.get("maison_pos.api.reports.run", report="AWANZ Purchase by Vendor", filters="{}")
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("maison_pos.api.reports.export", report="AWANZ Item Purchase History")
		self.assertEqual(r.status_code, 403, r.text[:200])
		listed = [x["name"] for x in a.get("maison_pos.api.reports.list_reports").json()["message"]["reports"]]
		self.assertNotIn("AWANZ Purchase by Vendor", listed)
		self.assertIn("AWANZ Daily Sales", listed)

	# ------------------------------------------------------------------ allowed
	def test_the_addressed_store_may_read_its_own_order_and_no_other(self):
		b = self.client(self.manager_b)
		r = b.get("maison_pos.api.purchasing.order", name=self.dropship_po)
		self.assertEqual(r.status_code, 200, r.text[:300])
		payload = r.json()["message"]
		self.assertEqual(payload["name"], self.dropship_po)
		self.assertEqual(payload["dropship_store"], STORE_B)
		# … but nothing else in purchasing, not even the order list
		self.assertEqual(b.get("maison_pos.api.purchasing.orders").status_code, 403)
		self.assertEqual(b.get("maison_pos.api.purchasing.order", name=self.warehouse_po).status_code, 403)
		# and the other store's manager cannot read it at all
		a = self.client(self.manager_a)
		self.assertEqual(a.get("maison_pos.api.purchasing.order", name=self.dropship_po).status_code, 403)
		r = a.get("frappe.client.get", doctype="Purchase Order", name=self.dropship_po)
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("frappe.client.get_list", doctype="Purchase Order", fields='["name"]', limit_page_length=500)
		self.assertEqual(r.status_code, 200)
		self.assertNotIn(self.dropship_po, [x["name"] for x in r.json()["message"]])

	def test_the_addressed_store_sees_the_order_on_its_receive_screen(self):
		b = self.client(self.manager_b)
		r = b.get("maison_pos.api.inventory.inbound")
		self.assertEqual(r.status_code, 200, r.text[:200])
		self.assertIn(self.dropship_po, [p["name"] for p in r.json()["message"]["purchase_orders"]])
		a = self.client(self.manager_a)
		r = a.get("maison_pos.api.inventory.inbound")
		self.assertNotIn(self.dropship_po, [p["name"] for p in r.json()["message"]["purchase_orders"]])
		r = a.post("maison_pos.api.inventory.receive_po", po=self.dropship_po, lines=[{"item_code": ITEM, "qty": 1}], boutique=STORE_B)
		self.assertEqual(r.status_code, 403, r.text[:200])

	def test_the_warehouse_admin_may_buy(self):
		w = self.client(WH_ADMIN)
		r = w.get("maison_pos.api.purchasing.vendors")
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertIn(VENDOR, [v["name"] for v in r.json()["message"]["vendors"]])
		r = w.get("maison_pos.api.purchasing.orders", status="all")
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertIn(self.dropship_po, [o["name"] for o in r.json()["message"]["orders"]])
		r = w.get("maison_pos.api.purchasing.order", name=self.warehouse_po)
		self.assertEqual(r.status_code, 200)
		r = w.get("maison_pos.api.purchasing.inbound")
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertIn(self.warehouse_po, [p["name"] for p in r.json()["message"]["purchase_orders"]])
		r = w.get("maison_pos.api.purchasing.stock")
		self.assertEqual(r.status_code, 200)
		r = w.get("maison_pos.api.reports.run", report="AWANZ Open Purchase Orders", filters="{}")
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertIn(self.warehouse_po, [x["name"] for x in r.json()["message"]["rows"]])
		r = w.get("maison_pos.api.reports.export", report="AWANZ Purchase by Vendor", filters='{"from_date": "%s", "to_date": "%s"}' % (nowdate(), nowdate()))
		self.assertEqual(r.status_code, 200, r.text[:200])
		self.assertIn("Vendor", r.text.splitlines()[0])

	def test_the_warehouse_admin_re_addresses_and_bins_a_draft_over_http(self):
		"""The order list's units, the drop-ship control and Delete, over the wire the screens use."""
		w = self.client(WH_ADMIN)
		store_warehouse = frappe.db.get_value("AWANZ Store", STORE_B, "warehouse")

		r = w.post("maison_pos.api.purchasing.create_order", supplier=VENDOR, lines=[{"item_code": ITEM, "qty": 8, "rate": 5.0}])
		self.assertEqual(r.status_code, 200, r.text[:300])
		draft = r.json()["message"]["name"]
		type(self).extra.append(draft)

		# 1 — the order *list* carries units, so the screen prints a number rather than an em dash
		listed = next(o for o in w.get("maison_pos.api.purchasing.orders", status="Draft").json()["message"]["orders"] if o["name"] == draft)
		self.assertNotIn("items", listed)
		self.assertEqual(listed["units"], 8)

		# 2 — "Drop-ship to store" on a draft: set, then cleared back to Houston
		r = w.post("maison_pos.api.purchasing.update_order", name=draft, dropship_store=STORE_B)
		self.assertEqual(r.status_code, 200, r.text[:300])
		payload = r.json()["message"]
		self.assertEqual(payload["dropship_store"], STORE_B)
		self.assertEqual(payload["set_warehouse"], store_warehouse)
		self.assertEqual({line["warehouse"] for line in payload["items"]}, {store_warehouse})
		r = w.post("maison_pos.api.purchasing.update_order", name=draft, dropship_store=None)
		self.assertEqual(r.status_code, 200, r.text[:300])
		payload = r.json()["message"]
		self.assertFalse(payload["dropship_store"])
		self.assertNotEqual(payload["set_warehouse"], store_warehouse)
		# a submitted order's destination is fixed
		r = w.post("maison_pos.api.purchasing.update_order", name=self.warehouse_po, dropship_store=STORE_B)
		self.assertEqual(r.status_code, 417, r.text[:300])

		# 3 — the vendor catalogue hands the screen the row name `remove_item_vendor` takes
		catalogue = w.get("maison_pos.api.purchasing.vendor", name=VENDOR).json()["message"]["catalogue"]
		row = next(c for c in catalogue if c["item_code"] == ITEM)
		self.assertTrue(row["name"], row)

		# 4 — a draft the buyer no longer wants can be binned; a submitted one is closed instead
		r = w.post("maison_pos.api.purchasing.delete_order", name=self.warehouse_po, reason="nope")
		self.assertEqual(r.status_code, 417, r.text[:300])
		r = w.post("maison_pos.api.purchasing.delete_order", name=draft, reason="ordered by phone instead")
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual(r.json()["message"]["deleted"], draft)
		type(self).extra.remove(draft)
		# gone for good — asked over the same transport, so no stale snapshot can answer for it
		self.assertEqual(w.get("maison_pos.api.purchasing.order", name=draft).status_code, 404)
		self.assertNotIn(draft, [o["name"] for o in w.get("maison_pos.api.purchasing.orders", status="all").json()["message"]["orders"]])
