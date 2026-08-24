"""v0.6 O — store-manager scoping proven over **HTTP** against the running bench.

Unit tests (``test_v0_6_warehouse``) call the endpoints in-process; these go through the web
server with real sessions (login → cookie → ``/api/method/...``), so the permission hooks,
``permission_query_conditions`` and the REST layer are all exercised. The fixtures are committed
(the web workers cannot see an uncommitted test transaction) and removed again in ``tearDownClass``.
Skipped when the site is not being served (e.g. CI without ``bench start``).
"""

from __future__ import annotations

import json
import unittest

import frappe
import requests
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, nowdate, nowtime

from maison_pos.tests.helpers import ensure_demo_data, ensure_stock, pos_invoice
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

		wh_b = frappe.db.get_value("AWANZ Store", STORE_B, "warehouse")
		src = get_main_warehouse(exclude=wh_b, company=frappe.db.get_value("AWANZ Store", STORE_B, "company"))
		company = frappe.db.get_value("Warehouse", src, "company")
		se = frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "purpose": "Material Receipt", "company": company, "to_warehouse": src, "posting_date": nowdate(), "posting_time": nowtime(), "set_posting_time": 1, "items": [{"item_code": ITEM, "qty": 3, "t_warehouse": src, "basic_rate": 10}]})
		se.flags.ignore_permissions = True
		se.insert()
		se.submit()
		cls.created = [("Stock Entry", se.name)]
		# a pending request + a shipped consignment, both for store B
		req = shipping.create_request(STORE_B, [{"item_code": ITEM, "qty": 1}], reason="http scoping test")
		cls.request_b = req.name
		sh = frappe.get_doc({"doctype": "AWANZ Shipment", "boutique": STORE_B, "from_warehouse": src, "transit_warehouse": ensure_transit_warehouse(STORE_B), "to_warehouse": wh_b, "status": "Pending", "lines": [{"item_code": ITEM, "qty": 2}]})
		sh.flags.ignore_permissions = True
		sh.insert()
		cls.shipment_b = sh.name
		frappe.set_user(WH_ADMIN)
		shipping.ship(sh.name)
		frappe.set_user("Administrator")
		# --- v0.6 D3 — a sale and its **credit note** in store B. A credit note used to carry no
		# `set_warehouse` (erpnext blanks it), so the per-user Warehouse User Permission never
		# matched it and store A's manager could list every other store's returns.
		from maison_pos.api import returns as returns_api
		from maison_pos.api import sales as sales_api

		ensure_stock("AC-012", STORE_B, 4)
		payload = pos_invoice(boutique=STORE_B, items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		res = sales_api.submit_batch([payload])["results"][0]
		assert res["status"] == "ok", res
		cls.sale_b = res["invoice_name"]
		cls.credit_note_b = returns_api.return_items(
			cls.sale_b,
			[{"item_code": "AC-012", "qty": 1, "reason": "Change of mind", "condition": "Sellable"}],
			refund_method="cash",
			reason="Change of mind",
		)["credit_note"]
		# a second credit note with the warehouse stripped back off — exactly the shape of the rows
		# that already exist on a site seeded before the fix. It proves the new
		# `permission_query_conditions` entry closes the leak on its own, with no stamp to help.
		res2 = sales_api.submit_batch([pos_invoice(boutique=STORE_B, items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])])["results"][0]
		assert res2["status"] == "ok", res2
		cls.legacy_sale_b = res2["invoice_name"]
		cls.legacy_credit_note_b = returns_api.return_items(
			cls.legacy_sale_b,
			[{"item_code": "AC-012", "qty": 1, "reason": "Change of mind", "condition": "Sellable"}],
			refund_method="cash",
			reason="Change of mind",
		)["credit_note"]
		frappe.db.set_value("Sales Invoice", cls.legacy_credit_note_b, "set_warehouse", None, update_modified=False)
		cls.store_b_warehouse = frappe.db.get_value("AWANZ Store", STORE_B, "warehouse")
		frappe.db.commit()
		cls.manager_a = frappe.db.get_value("AWANZ Associate", {"boutique": STORE_A, "role": "Manager", "enabled": 1}, "user")
		cls.manager_b = frappe.db.get_value("AWANZ Associate", {"boutique": STORE_B, "role": "Manager", "enabled": 1}, "user")

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		try:
			for name in (cls.legacy_credit_note_b, cls.legacy_sale_b, cls.credit_note_b, cls.sale_b):
				if name and frappe.db.exists("Sales Invoice", name):
					si = frappe.get_doc("Sales Invoice", name)
					if si.docstatus == 1:
						si.flags.ignore_permissions = True
						si.cancel()
					si.delete(ignore_permissions=True)
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), "v0.6 scoping http invoice cleanup")
		try:
			sh = frappe.get_doc("AWANZ Shipment", cls.shipment_b)
			for se_name in (sh.stock_entry_receive, sh.stock_entry_damaged, sh.stock_entry_ship):
				if se_name and frappe.db.exists("Stock Entry", se_name):
					se = frappe.get_doc("Stock Entry", se_name)
					if se.docstatus == 1:
						se.flags.ignore_permissions = True
						se.cancel()
					se.delete(ignore_permissions=True)
			frappe.db.delete("AWANZ Receiving Discrepancy", {"shipment": cls.shipment_b})
			sh.delete(ignore_permissions=True)
			req = frappe.get_doc("AWANZ Replenishment Request", cls.request_b)
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
		r = a.get("frappe.client.get", doctype="AWANZ Shipment", name=self.shipment_b)
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("frappe.client.get_list", doctype="AWANZ Shipment", fields='["name"]', limit_page_length=500)
		self.assertEqual(r.status_code, 200)
		self.assertNotIn(self.shipment_b, [x["name"] for x in r.json()["message"]])
		r = a.get("frappe.client.get_list", doctype="AWANZ Replenishment Request", fields='["name"]', limit_page_length=500)
		self.assertNotIn(self.request_b, [x["name"] for x in r.json()["message"]])
		# the in-transit Stock Entry of store B is invisible in the desk list as well
		se = frappe.db.get_value("AWANZ Shipment", self.shipment_b, "stock_entry_ship")
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
		r = b.get("frappe.client.get_list", doctype="AWANZ Shipment", fields='["name"]', limit_page_length=500)
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
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", self.request_b, "status"), "Pending Approval")

	def test_manager_a_cannot_receive_store_b_shipment(self):
		a = self.client(self.manager_a)
		r = a.post("maison_pos.api.inventory.receive_shipment", shipment=self.shipment_b, lines=[{"item_code": ITEM, "received_qty": 2}])
		self.assertEqual(r.status_code, 403, r.text[:200])
		self.assertEqual(frappe.db.get_value("AWANZ Shipment", self.shipment_b, "status"), "Shipped")
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

	# ------------------------------------------------------- v0.6 D3: the REST list surface
	def _names(self, r) -> list[str]:
		self.assertEqual(r.status_code, 200, r.text[:300])
		return [x["name"] for x in r.json()["message"]]

	def test_returns_are_stamped_with_their_store_and_warehouse(self):
		"""The stamp itself: `make_sales_return` blanks `set_warehouse`, `stamp_store` puts it back."""
		cn = frappe.db.get_value("Sales Invoice", self.credit_note_b, ["maison_boutique", "set_warehouse", "is_return"], as_dict=True)
		self.assertEqual(cn.is_return, 1)
		self.assertEqual(cn.maison_boutique, STORE_B)
		self.assertEqual(cn.set_warehouse, self.store_b_warehouse)

	def test_manager_a_cannot_list_store_b_return_invoices(self):
		"""D3: the leak the cloud run found — 10 other stores' credit notes over `get_list`."""
		a = self.client(self.manager_a)
		# 1. plain list
		names = self._names(a.get("frappe.client.get_list", doctype="Sales Invoice", fields='["name"]', limit_page_length=2000))
		self.assertNotIn(self.credit_note_b, names)
		self.assertNotIn(self.sale_b, names)
		# 2. the exact probe from the cloud run: every invoice of another store
		r = a.get(
			"frappe.client.get_list",
			doctype="Sales Invoice",
			filters=f'[["maison_boutique", "!=", "{STORE_A}"]]',
			fields='["name", "maison_boutique", "is_return", "grand_total"]',
			limit_page_length=2000,
		)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual([row for row in r.json()["message"]], [], "another store's invoices are listable")
		# 3. returns only — the rows that carried no warehouse stamp
		r = a.get(
			"frappe.client.get_list",
			doctype="Sales Invoice",
			filters='[["is_return", "=", 1]]',
			fields='["name", "maison_boutique"]',
			limit_page_length=2000,
		)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual({row["maison_boutique"] for row in r.json()["message"]} - {STORE_A, None, ""}, set())
		# 4. the REST resource endpoint takes the same query conditions
		res = a.s.get(
			f"{self.base}/api/resource/Sales Invoice",
			params={"filters": '[["is_return", "=", 1]]', "fields": '["name","maison_boutique"]', "limit_page_length": 2000},
			timeout=30,
		)
		self.assertEqual(res.status_code, 200, res.text[:300])
		self.assertNotIn(self.credit_note_b, [row["name"] for row in res.json()["data"]])
		# 5. and the single-document read is refused
		self.assertEqual(a.get("frappe.client.get", doctype="Sales Invoice", name=self.credit_note_b).status_code, 403)
		self.assertEqual(a.s.get(f"{self.base}/api/resource/Sales Invoice/{self.credit_note_b}", timeout=30).status_code, 403)

	def test_an_unstamped_legacy_return_is_still_invisible(self):
		"""The query condition carries the leak on its own: no `set_warehouse`, still not listable.

		Without this the suite would pass on the *stamp* alone (the backfill patch gives every
		existing row a warehouse, which the User Permission then matches) and would not notice if
		the `permission_query_conditions` entry were dropped again.
		"""
		self.assertIsNone(frappe.db.get_value("Sales Invoice", self.legacy_credit_note_b, "set_warehouse"))
		a = self.client(self.manager_a)
		names = self._names(a.get("frappe.client.get_list", doctype="Sales Invoice", fields='["name"]', filters='[["is_return", "=", 1]]', limit_page_length=2000))
		self.assertNotIn(self.legacy_credit_note_b, names)
		res = a.s.get(
			f"{self.base}/api/resource/Sales Invoice",
			params={"filters": '[["is_return", "=", 1]]', "fields": '["name"]', "limit_page_length": 2000},
			timeout=30,
		)
		self.assertEqual(res.status_code, 200, res.text[:300])
		self.assertNotIn(self.legacy_credit_note_b, [row["name"] for row in res.json()["data"]])
		self.assertEqual(a.get("frappe.client.get", doctype="Sales Invoice", name=self.legacy_credit_note_b).status_code, 403)
		# store B's own manager still sees it
		b = self.client(self.manager_b)
		self.assertIn(self.legacy_credit_note_b, self._names(b.get("frappe.client.get_list", doctype="Sales Invoice", fields='["name"]', filters='[["is_return", "=", 1]]', limit_page_length=2000)))

	def test_manager_b_still_sees_their_own_sale_and_credit_note(self):
		b = self.client(self.manager_b)
		names = self._names(b.get("frappe.client.get_list", doctype="Sales Invoice", fields='["name"]', filters='[["is_return", "=", 1]]', limit_page_length=2000))
		self.assertIn(self.credit_note_b, names)
		r = b.get("frappe.client.get", doctype="Sales Invoice", name=self.credit_note_b)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual(r.json()["message"]["maison_boutique"], STORE_B)
		res = b.s.get(f"{self.base}/api/resource/Sales Invoice/{self.sale_b}", timeout=30)
		self.assertEqual(res.status_code, 200, res.text[:300])

	def test_head_office_is_unrestricted_on_every_scoped_doctype(self):
		"""Head Office keeps the chain-wide view the scoping is meant to leave alone."""
		hq = self.client("hq@maison.example")
		names = self._names(hq.get("frappe.client.get_list", doctype="Sales Invoice", fields='["name"]', filters='[["is_return", "=", 1]]', limit_page_length=2000))
		self.assertIn(self.credit_note_b, names)
		self.assertEqual(hq.get("frappe.client.get", doctype="Sales Invoice", name=self.credit_note_b).status_code, 200)

	def test_every_store_scoped_doctype_is_narrowed_over_rest(self):
		"""The full audit list: no scoped doctype leaks another store's rows to a store manager."""
		a = self.client(self.manager_a)
		own = frappe.db.get_value("AWANZ Store", STORE_A, "warehouse")
		other = frappe.db.get_value("AWANZ Store", STORE_B, "warehouse")
		# doctypes stamped with a `boutique` / `maison_boutique` field
		for doctype, field in (
			("Sales Invoice", "maison_boutique"),
			("Sales Order", "maison_boutique"),
			("AWANZ Shipment", "boutique"),
			("AWANZ Replenishment Request", "boutique"),
			("AWANZ Stock Alert", "boutique"),
			("AWANZ Cycle Count", "boutique"),
			("AWANZ Feedback", "boutique"),
			("AWANZ Age Check", "boutique"),
		):
			r = a.get("frappe.client.get_list", doctype=doctype, fields=f'["name", "{field}"]', limit_page_length=2000)
			self.assertEqual(r.status_code, 200, f"{doctype}: {r.status_code} {r.text[:200]}")
			foreign = {row[field] for row in r.json()["message"]} - {STORE_A, None, ""}
			self.assertEqual(foreign, set(), f"{doctype} leaked {foreign}")
		# stock documents are scoped by the store's own warehouses instead
		for doctype, fields in (
			("Delivery Note", ("set_warehouse",)),
			("Stock Entry", ("from_warehouse", "to_warehouse")),
			("Material Request", ("set_warehouse", "set_from_warehouse")),
			("Purchase Receipt", ("set_warehouse",)),
		):
			field_list = json.dumps(["name", *fields])
			r = a.get("frappe.client.get_list", doctype=doctype, fields=field_list, limit_page_length=2000)
			self.assertEqual(r.status_code, 200, f"{doctype}: {r.status_code} {r.text[:200]}")
			for row in r.json()["message"]:
				self.assertNotIn(other, [row.get(f) for f in fields], f"{doctype} {row['name']} touches {other}")
				self.assertTrue(any(row.get(f) == own for f in fields), f"{doctype} {row['name']} touches neither store")

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
