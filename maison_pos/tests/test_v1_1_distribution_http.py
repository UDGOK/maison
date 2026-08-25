"""v1.1 §A/§B — distribution and product creation proven over **HTTP** against the running bench.

Same shape as ``test_v1_0_purchasing_http``: real logins, real sessions, real ``/api/method``
calls, so the whitelist gates and the REST layer are exercised rather than the python functions.
Both directions are proved:

* a store manager is refused **every** distribution endpoint — including ``send`` for their *own*
  store, because pushing is Houston's act — and refused ``create_product`` / ``item_groups`` /
  ``vendor_catalogue``;
* a warehouse admin can plan, split, push (one shipment per store, named in the response) and
  create a product, and the over-allocation refusal still writes nothing when it comes over the
  wire rather than from a python call.

Skipped when the site is not being served (CI without ``bench start``).
"""

from __future__ import annotations

import re
import unittest

import frappe
import requests
from frappe.tests.utils import FrappeTestCase
from frappe.utils import nowdate, nowtime

from maison_pos import distribution as dist_lib
from maison_pos.purchasing import main_warehouse
from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v0_6_warehouse import WH_ADMIN, ensure_warehouse_admin
from maison_pos.tests.test_v1_0_purchasing import ensure_vendor

PWD = "maison123"
STORE = "NYC-5AV"
VENDOR = "AWANZ HTTP Push Distro"
ITEM = "V11-HTTP-1"
NEW_ITEM = "V11-HTTP-NEW-1"
#: units posted at HOU-WH for the push under test
STOCK = 90.0


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

	def get(self, endpoint: str, /, **params):
		return self.s.get(f"{self.base}/api/method/{endpoint}", params=params, timeout=30)

	def post(self, endpoint: str, /, **data):
		return self.s.post(f"{self.base}/api/method/{endpoint}", json=data, headers={"X-Frappe-CSRF-Token": self.csrf}, timeout=30)


class TestDistributionScopingHTTP(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.base = _base_url()
		if not _alive(cls.base):
			raise unittest.SkipTest("web server not running — HTTP scoping tests need `bench start`")
		ensure_demo_data()
		ensure_warehouse_admin()
		frappe.set_user("Administrator")
		cls.manager = frappe.db.get_value("AWANZ Associate", {"boutique": STORE, "role": "Manager", "enabled": 1}, "user")
		if not cls.manager:
			raise unittest.SkipTest("demo manager missing for the store under test")
		cls.warehouse = main_warehouse()
		cls.stores = [row["boutique"] for row in dist_lib.store_rows()]
		if len(cls.stores) < 2:
			raise unittest.SkipTest("this seed offers fewer than two pushable stores")
		ensure_vendor(VENDOR)
		cls.created: list[str] = []  # shipments raised over HTTP, unwound with the rest
		# these tests write for real (the HTTP calls commit), so start from a clean slate whatever
		# a previous run left behind, and finish by putting it back
		cls._purge()
		cls._stock(ITEM, STOCK)
		cls.available = dist_lib.availability([ITEM])[ITEM]["available"]
		frappe.db.commit()

	# ------------------------------------------------------------------ fixture plumbing
	@classmethod
	def _step(cls, fn) -> None:
		"""Run one cleanup step and commit it; a step that cannot complete must not undo the rest."""
		try:
			fn()
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), "v1.1 distribution http cleanup")

	@classmethod
	def _purge(cls) -> None:
		"""Unwind everything this suite creates: shipments, requests, material requests, stock, items.

		Leaving any of it behind is not a private problem: a stray replenishment Material Request
		for a store is exactly what ``test_v0_6_scoping_http`` audits, so a half-cleaned run fails
		a neighbouring suite on the next pass.
		"""
		frappe.set_user("Administrator")
		# the HTTP calls commit from the *server's* connection; end this one's transaction so the
		# reads below see what was actually written rather than a snapshot taken before it
		frappe.db.commit()
		for item in (NEW_ITEM, ITEM):
			for shipment in frappe.get_all("AWANZ Shipment Line", filters={"item_code": item}, pluck="parent", limit=200):
				cls._step(lambda name=shipment: frappe.delete_doc("AWANZ Shipment", name, force=True, ignore_permissions=True))
			for request in frappe.get_all("AWANZ Replenishment Line", filters={"item_code": item}, pluck="parent", limit=200):
				if not frappe.db.exists("AWANZ Replenishment Request", request):
					continue
				material_request = frappe.db.get_value("AWANZ Replenishment Request", request, "material_request")
				cls._step(lambda name=request: frappe.db.set_value("AWANZ Replenishment Request", name, {"shipment": None, "material_request": None}, update_modified=False))
				cls._step(lambda name=request: frappe.delete_doc("AWANZ Replenishment Request", name, force=True, ignore_permissions=True))
				if material_request and frappe.db.exists("Material Request", material_request):
					cls._step(lambda name=material_request: cls._cancel_and_delete("Material Request", name))
			# … and any material request whose request row has already gone
			for material_request in frappe.get_all("Material Request Item", filters={"item_code": item}, pluck="parent", limit=200):
				if frappe.db.exists("Material Request", material_request):
					cls._step(lambda name=material_request: cls._cancel_and_delete("Material Request", name))
			# the stock this suite posted goes back where it came from (cancel, never delete —
			# a submitted Stock Entry keeps its GL entries and refuses deletion)
			for entry in frappe.get_all(
				"Stock Entry Detail", filters={"item_code": item}, pluck="parent", limit=200, distinct=True
			):
				if frappe.db.get_value("Stock Entry", entry, "docstatus") != 1:
					continue
				cls._step(lambda name=entry: frappe.get_doc("Stock Entry", name).cancel())
			# the demo seed publishes anything with a price, so a leftover item may have picked up a
			# Website Item; an orphan of those makes the next insert of the same code blow up inside
			# webshop's own on_update hook (`doc_before_save` is None on an insert)
			for web_item in frappe.get_all("Website Item", filters={"item_code": item}, pluck="name", limit=50):
				cls._step(lambda name=web_item: frappe.delete_doc("Website Item", name, force=True, ignore_permissions=True))
			cls._step(lambda code=item: frappe.db.delete("AWANZ Item Vendor", {"parent": code, "parenttype": "Item"}))
			cls._step(lambda code=item: frappe.db.delete("Item Price", {"item_code": code}))
			cls._step(lambda code=item: frappe.db.delete("Item Reorder", {"parent": code, "parenttype": "Item"}))
			cls._step(lambda code=item: frappe.db.delete("Item Barcode", {"parent": code, "parenttype": "Item"}))
			if frappe.db.exists("Item", item):
				cls._step(lambda code=item: frappe.delete_doc("Item", code, force=True, ignore_permissions=True))
			frappe.clear_document_cache("Item", item)
		frappe.db.commit()

	@classmethod
	def _cancel_and_delete(cls, doctype: str, name: str) -> None:
		doc = frappe.get_doc(doctype, name)
		doc.flags.ignore_permissions = True
		if doc.docstatus == 1:
			doc.cancel()
		doc.delete(ignore_permissions=True)

	@classmethod
	def _stock(cls, item: str, qty: float) -> str:
		"""A committed test item with committed stock at HOU-WH (the HTTP calls are real writes)."""
		if not frappe.db.exists("Item", item):
			doc = frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": item,
					"item_name": item,
					"item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
					"stock_uom": "Nos",
					"is_stock_item": 1,
					"valuation_method": "Moving Average",
					"include_item_in_manufacturing": 0,
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert()
		company = frappe.db.get_value("Warehouse", cls.warehouse, "company")
		se = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"purpose": "Material Receipt",
				"company": company,
				"to_warehouse": cls.warehouse,
				"posting_date": nowdate(),
				"posting_time": nowtime(),
				"set_posting_time": 1,
				"items": [{"item_code": item, "qty": qty, "t_warehouse": cls.warehouse, "basic_rate": 10}],
			}
		)
		se.flags.ignore_permissions = True
		se.insert()
		se.submit()
		return se.name

	@classmethod
	def tearDownClass(cls):
		cls._purge()
		super().tearDownClass()

	def client(self, user: str) -> Client:
		return Client(self.base, frappe.local.site, user, PWD)

	# ------------------------------------------------------------------ refused
	def test_a_store_manager_is_refused_every_distribution_endpoint(self):
		"""Client decision 1 — pushing is Houston's, even into the manager's own store."""
		a = self.client(self.manager)
		for method, params in (
			("maison_pos.api.distribution.stores", {}),
			("maison_pos.api.distribution.plan", {"item_codes": ITEM}),
			("maison_pos.api.distribution.suggest_split", {"item_code": ITEM, "qty": 6, "mode": "even"}),
		):
			r = a.get(method, **params)
			self.assertEqual(r.status_code, 403, f"GET {method}: {r.status_code} {r.text[:200]}")
		for method, data in (
			("maison_pos.api.distribution.send", {"lines": [{"boutique": STORE, "item_code": ITEM, "qty": 2}]}),
			("maison_pos.api.distribution.suggest_split", {"item_code": ITEM, "qty": 6, "mode": "velocity"}),
		):
			r = a.post(method, **data)
			self.assertEqual(r.status_code, 403, f"POST {method}: {r.status_code} {r.text[:200]}")
		# … and the refusal wrote nothing: no request, no shipment, no material request
		self.assertEqual(frappe.get_all("AWANZ Replenishment Line", filters={"item_code": ITEM}, limit=1), [])
		self.assertEqual(frappe.get_all("AWANZ Shipment Line", filters={"item_code": ITEM}, limit=1), [])
		self.assertEqual(frappe.get_all("Material Request Item", filters={"item_code": ITEM}, limit=1), [])

	def test_a_store_manager_is_refused_the_new_product_and_catalogue_endpoints(self):
		"""Client decision 5 — creating a product is a purchasing-admin act."""
		a = self.client(self.manager)
		r = a.get("maison_pos.api.purchasing.item_groups")
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.get("maison_pos.api.purchasing.vendor_catalogue", supplier=VENDOR)
		self.assertEqual(r.status_code, 403, r.text[:200])
		r = a.post(
			"maison_pos.api.purchasing.create_product",
			payload={"item_code": "V11-HTTP-SNEAKY", "item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name")},
		)
		self.assertEqual(r.status_code, 403, r.text[:200])
		self.assertFalse(frappe.db.exists("Item", "V11-HTTP-SNEAKY"))

	# ------------------------------------------------------------------ allowed
	def test_the_warehouse_admin_may_plan_split_and_push(self):
		w = self.client(WH_ADMIN)

		r = w.get("maison_pos.api.distribution.stores")
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual(sorted(s["boutique"] for s in r.json()["message"]["stores"]), sorted(self.stores))

		r = w.get("maison_pos.api.distribution.plan", item_codes=ITEM)
		self.assertEqual(r.status_code, 200, r.text[:300])
		row = r.json()["message"]["items"][0]
		self.assertEqual(row["item_code"], ITEM)
		self.assertEqual(row["available"], self.available)
		self.assertEqual(sorted(s["boutique"] for s in row["stores"]), sorted(self.stores))

		r = w.get("maison_pos.api.distribution.suggest_split", item_code=ITEM, qty=3 * len(self.stores), mode="even")
		self.assertEqual(r.status_code, 200, r.text[:300])
		split = r.json()["message"]
		self.assertEqual(split["allocated"], 3 * len(self.stores))
		lines = [{"boutique": line["boutique"], "item_code": ITEM, "qty": line["qty"]} for line in split["lines"] if line["qty"]]

		# a state-changing endpoint is POST only: the same admin gets 403 on a GET, so a crafted
		# link cannot ship stock (Frappe only checks CSRF on non-GET requests)
		self.assertEqual(w.get("maison_pos.api.distribution.send", lines="[]").status_code, 403)

		r = w.post("maison_pos.api.distribution.send", lines=lines, reason="v1.1 HTTP push")
		self.assertEqual(r.status_code, 200, r.text[:300])
		out = r.json()["message"]
		type(self).created.extend(s["name"] for s in out["shipments"])
		self.assertEqual(out["stores"], len(self.stores))
		self.assertEqual(out["units"], 3.0 * len(self.stores))
		self.assertEqual(len(out["shipments"]), len(self.stores))
		for shipment in out["shipments"]:
			# the confirmation names them, and each is a normal Pending shipment on the wall
			self.assertTrue(shipment["name"])
			self.assertEqual(shipment["status"], "Pending")
			self.assertTrue(shipment["warehouse_push"])

		# the wall the floor watches picked them up — a pushed shipment is an ordinary card on it
		r = w.get("maison_pos.api.shipping.wall")
		self.assertEqual(r.status_code, 200, r.text[:200])
		to_pick = {card["name"]: card for card in r.json()["message"]["columns"]["to_pick"]}
		for shipment in out["shipments"]:
			self.assertIn(shipment["name"], to_pick, r.text[:300])
			self.assertTrue(to_pick[shipment["name"]]["warehouse_push"])

	def test_an_over_allocation_over_http_is_refused_and_writes_nothing(self):
		w = self.client(WH_ADMIN)
		before = frappe.db.count("AWANZ Shipment")
		r = w.post(
			"maison_pos.api.distribution.send",
			lines=[{"boutique": b, "item_code": ITEM, "qty": 10000} for b in self.stores],
		)
		self.assertEqual(r.status_code, 417, r.text[:300])
		self.assertIn(ITEM, r.text)
		self.assertIn("short", r.text)
		self.assertEqual(frappe.db.count("AWANZ Shipment"), before)

	def test_the_warehouse_admin_may_create_a_product_and_order_it(self):
		w = self.client(WH_ADMIN)
		r = w.get("maison_pos.api.purchasing.item_groups")
		self.assertEqual(r.status_code, 200, r.text[:300])
		groups = r.json()["message"]["groups"]
		self.assertTrue(groups)

		r = w.post(
			"maison_pos.api.purchasing.create_product",
			payload={
				"item_code": NEW_ITEM,
				"item_name": "AWANZ HTTP Test Product",
				"item_group": groups[0]["name"],
				"barcode": "V11HTTPBARCODE1",
				"selling_rate": 19.5,
				"vendor": {"supplier": VENDOR, "vendor_sku": "HTTP-SKU-1", "cost": 7.25, "case_pack": 12, "moq": 24},
				"reorder": {"level": 36, "qty": 72},
			},
		)
		self.assertEqual(r.status_code, 200, r.text[:400])
		item = r.json()["message"]["item"]
		self.assertEqual(item["item_code"], NEW_ITEM)
		self.assertEqual(item["preferred"], VENDOR)
		self.assertEqual(item["selling_rate"], 19.5)
		self.assertEqual(item["reorder"]["level"], 36.0)
		self.assertEqual(item["barcode"], "V11HTTPBARCODE1")
		self.assertIn("V11HTTPBARCODE1", item["barcodes"], "the scanner reads the standard table too")

		# the vendor's catalogue now finds it by *their* SKU, ready to be ordered from scratch
		r = w.get("maison_pos.api.purchasing.vendor_catalogue", supplier=VENDOR, search="HTTP-SKU-1")
		self.assertEqual(r.status_code, 200, r.text[:300])
		found = r.json()["message"]["items"]
		self.assertEqual([row["item_code"] for row in found], [NEW_ITEM])
		self.assertEqual(found[0]["default_qty"], 12)
		self.assertEqual(found[0]["rate"], 7.25)

		# the same barcode on a second product is refused over the wire too
		r = w.post(
			"maison_pos.api.purchasing.create_product",
			payload={"item_code": "V11-HTTP-DUPE", "item_group": groups[0]["name"], "barcode": "V11HTTPBARCODE1"},
		)
		self.assertEqual(r.status_code, 417, r.text[:300])
		self.assertIn(NEW_ITEM, r.text)
		self.assertFalse(frappe.db.exists("Item", "V11-HTTP-DUPE"))
