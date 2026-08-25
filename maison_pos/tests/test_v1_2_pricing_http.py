"""v1.2 §A / §C / §D / §E proven over **HTTP** against the running bench.

Same shape as ``test_v1_0_purchasing_http`` and ``test_v1_1_distribution_http``: real logins, real
sessions, real ``/api/method`` calls, so the whitelist gates and the REST layer are exercised
rather than the python functions.

Both directions, for both halves of the release:

* **the wholesale price and the statement** are warehouse-admin / head-office only. A store
  manager is refused every one of them — including the statement for their **own** store, because
  it carries what the warehouse paid, and including the Script Report behind it;
* **a retail price change** follows the workflow that has existed since v0.1: any AWANZ role may
  raise one for their own store and for no other, and only Head Office / Regional / System Manager
  may approve. Approving is what creates the store's Pricing Rule.

Skipped when the site is not being served (CI without ``bench start``).
"""

from __future__ import annotations

import json
import re
import unittest

import frappe
import requests
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, nowdate

from maison_pos import distribution as dist_lib
from maison_pos.awanz_pos.doctype.awanz_price_change_request.awanz_price_change_request import pricing_rule_title
from maison_pos.pricing import wholesale as wholesale_lib
from maison_pos.purchasing import main_warehouse
from maison_pos.tests.helpers import ensure_demo_data
from maison_pos.tests.test_v0_6_warehouse import WH_ADMIN, ensure_warehouse_admin, stock_main_warehouse
from maison_pos.tests.test_v1_0_purchasing import ensure_item
from maison_pos.tests.test_v1_1_role_permissions import role_only_user

PWD = "maison123"
ITEM = "V12-HTTP-1"
HEAD_OFFICE = "v12.http.headoffice@awanz.test"
STOCK = 60.0
SEED_COST = 10.0
REPORT = "AWANZ Store Statement"


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


def _messages(response) -> str:
	try:
		raw = response.json().get("_server_messages")
	except Exception:
		return response.text[:300]
	out = []
	for entry in json.loads(raw) if raw else []:
		try:
			out.append(str(json.loads(entry).get("message")))
		except Exception:
			out.append(str(entry))
	return " ".join(out) or response.text[:300]


class PricingHTTPCase(FrappeTestCase):
	"""These tests write for real (the HTTP calls commit), so they clean up after themselves."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.base = _base_url()
		if not _alive(cls.base):
			raise unittest.SkipTest("web server not running — HTTP scoping tests need `bench start`")
		ensure_demo_data()
		ensure_warehouse_admin()
		frappe.set_user("Administrator")
		cls.stores = [row["boutique"] for row in dist_lib.store_rows()]
		if len(cls.stores) < 2:
			raise unittest.SkipTest("this seed offers fewer than two pushable stores")
		cls.store, cls.other = cls.stores[0], cls.stores[1]
		cls.manager = frappe.db.get_value("AWANZ Associate", {"boutique": cls.store, "role": "Manager", "enabled": 1}, "user")
		if not cls.manager:
			raise unittest.SkipTest("demo manager missing for the store under test")
		cls.head_office = role_only_user(HEAD_OFFICE, "AWANZ Head Office")
		cls.warehouse = main_warehouse()
		cls.item = ensure_item(ITEM)
		stock_main_warehouse(cls.item, STOCK, cls.warehouse)
		cls.markup_before = wholesale_lib.markup_pct()
		wholesale_lib.set_markup_pct(50)
		cls.raised: list[str] = []
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		for name in cls.raised:
			if frappe.db.exists("AWANZ Price Change Request", name):
				rule = frappe.db.get_value("AWANZ Price Change Request", name, "pricing_rule")
				frappe.db.set_value("AWANZ Price Change Request", name, "docstatus", 2, update_modified=False)
				frappe.delete_doc("AWANZ Price Change Request", name, force=True, ignore_permissions=True)
				if rule and frappe.db.exists("Pricing Rule", rule):
					frappe.delete_doc("Pricing Rule", rule, force=True, ignore_permissions=True)
		wholesale_lib.set_markup_pct(cls.markup_before)
		wholesale_lib.set_override(cls.item, None)
		frappe.db.commit()
		super().tearDownClass()

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.commit()  # new read snapshot: the web workers write on their own connections

	def client(self, user: str) -> Client:
		return Client(self.base, frappe.local.site, user, PWD)


# ===========================================================================
# §A / §C — the wholesale price and the statement are head-office only
# ===========================================================================
class TestWholesaleScopingHTTP(PricingHTTPCase):
	#: (method, kind, params) — every v1.2 pricing endpoint
	ENDPOINTS = (
		("maison_pos.api.pricing.wholesale_settings", "get", {}),
		("maison_pos.api.pricing.wholesale", "get", {"item_codes": json.dumps([ITEM])}),
		("maison_pos.api.pricing.store_prices", "get", {"item_code": ITEM}),
		("maison_pos.api.pricing.statement", "get", {"from_date": nowdate(), "to_date": nowdate()}),
		("maison_pos.api.pricing.set_wholesale", "post", {"item_code": ITEM, "rate": 9.99}),
		("maison_pos.api.pricing.set_wholesale_markup", "post", {"pct": 80}),
	)

	def test_a_store_manager_is_refused_every_pricing_endpoint(self):
		c = self.client(self.manager)
		for method, kind, params in self.ENDPOINTS:
			r = c.get(method, **params) if kind == "get" else c.post(method, **params)
			self.assertEqual(r.status_code, 403, f"{method} answered {r.status_code}: {_messages(r)}")

	def test_a_store_manager_is_refused_the_statement_for_their_own_store(self):
		"""It shows what the warehouse paid — not a figure a partner's manager may read."""
		r = self.client(self.manager).get(
			"maison_pos.api.pricing.statement", from_date=nowdate(), to_date=nowdate(), boutique=self.store
		)
		self.assertEqual(r.status_code, 403, _messages(r))

	def test_a_store_manager_cannot_reach_the_statement_through_the_reports_api_either(self):
		c = self.client(self.manager)
		listed = c.get("maison_pos.api.reports.list_reports")
		self.assertTrue(listed.ok, _messages(listed))
		self.assertNotIn(REPORT, {r["name"] for r in listed.json()["message"]["reports"]})
		self.assertEqual(c.get("maison_pos.api.reports.run", report=REPORT).status_code, 403)
		self.assertEqual(c.get("maison_pos.api.reports.export", report=REPORT).status_code, 403)

	def test_a_warehouse_admin_reads_every_pricing_endpoint(self):
		c = self.client(WH_ADMIN)
		for method, kind, params in self.ENDPOINTS:
			if kind != "get":
				continue
			r = c.get(method, **params)
			self.assertTrue(r.ok, f"{method} answered {r.status_code}: {_messages(r)}")

	def test_a_warehouse_admin_sets_the_markup_and_an_override_over_the_wire(self):
		c = self.client(WH_ADMIN)
		r = c.post("maison_pos.api.pricing.set_wholesale_markup", pct=80)
		self.assertTrue(r.ok, _messages(r))
		self.assertEqual(r.json()["message"]["markup_pct"], 80.0)

		r = c.get("maison_pos.api.pricing.wholesale", item_codes=json.dumps([ITEM]))
		self.assertTrue(r.ok, _messages(r))
		row = r.json()["message"]["items"][0]
		self.assertEqual(row["cost"], SEED_COST)
		self.assertEqual(row["wholesale"], 18.0)
		self.assertEqual(row["source"], "markup")

		r = c.post("maison_pos.api.pricing.set_wholesale", item_code=ITEM, rate=13.5)
		self.assertTrue(r.ok, _messages(r))
		self.assertEqual(r.json()["message"]["item"]["wholesale"], 13.5)
		self.assertEqual(r.json()["message"]["item"]["source"], "override")

		r = c.post("maison_pos.api.pricing.set_wholesale", item_code=ITEM, rate=None)
		self.assertTrue(r.ok, _messages(r))
		self.assertEqual(r.json()["message"]["item"]["source"], "markup")
		self.assertEqual(r.json()["message"]["item"]["wholesale"], 18.0)

		c.post("maison_pos.api.pricing.set_wholesale_markup", pct=50)

	def test_the_statement_says_it_is_internal_over_the_wire(self):
		r = self.client(WH_ADMIN).get("maison_pos.api.pricing.statement", from_date=nowdate(), to_date=nowdate())
		self.assertTrue(r.ok, _messages(r))
		payload = r.json()["message"]
		self.assertTrue(payload["internal"])
		self.assertFalse(payload["is_invoice"])
		self.assertFalse(payload["creates_receivable"])
		self.assertIn("not an invoice", payload["notice"].lower())

	def test_the_csv_export_leads_with_the_internal_banner(self):
		r = self.client(WH_ADMIN).get("maison_pos.api.reports.export", report=REPORT, filters=json.dumps({"from_date": nowdate(), "to_date": nowdate()}))
		self.assertTrue(r.ok, r.status_code)
		first = r.text.splitlines()[0]
		self.assertIn("INTERNAL", first.upper())
		self.assertIn("not an invoice", first.lower())
		self.assertIn("Wholesale Value", r.text.splitlines()[1])


# ===========================================================================
# §D — a retail price change follows the existing workflow, over the wire
# ===========================================================================
class TestPriceChangeScopingHTTP(PricingHTTPCase):
	def _raise_for(self, user: str, boutique: str, rate: float = 41.0):
		return self.client(user).post(
			"maison_pos.api.purchasing.request_price_change",
			item_code=ITEM,
			boutique=boutique,
			proposed_rate=rate,
			reason="v1.2 HTTP price board test",
		)

	def test_a_store_manager_may_raise_a_price_change_for_their_own_store(self):
		r = self._raise_for(self.manager, self.store, 41.0)
		self.assertTrue(r.ok, _messages(r))
		out = r.json()["message"]
		self.__class__.raised.append(out["name"])
		self.assertEqual(out["boutique"], self.store)
		self.assertEqual(out["workflow_state"], "Pending Approval")

	def test_a_store_manager_may_not_raise_a_price_change_for_another_store(self):
		r = self._raise_for(self.manager, self.other, 42.0)
		self.assertEqual(r.status_code, 403, _messages(r))
		frappe.db.commit()
		self.assertFalse(
			frappe.db.exists("AWANZ Price Change Request", {"item_code": ITEM, "boutique": self.other, "proposed_rate": 42.0})
		)

	def test_a_store_manager_may_not_approve(self):
		r = self._raise_for(self.manager, self.store, 43.0)
		self.assertTrue(r.ok, _messages(r))
		name = r.json()["message"]["name"]
		self.__class__.raised.append(name)
		refused = self.client(self.manager).post("maison_pos.api.purchasing.approve_price_change", name=name, action="Approve")
		self.assertGreaterEqual(refused.status_code, 400, refused.text[:200])
		frappe.db.commit()
		self.assertNotEqual(frappe.db.get_value("AWANZ Price Change Request", name, "workflow_state"), "Approved")
		self.assertFalse(frappe.db.get_value("AWANZ Price Change Request", name, "pricing_rule"))

	def test_head_office_approves_and_that_is_what_creates_the_pricing_rule(self):
		r = self._raise_for(self.manager, self.store, 44.5)
		self.assertTrue(r.ok, _messages(r))
		name = r.json()["message"]["name"]
		self.__class__.raised.append(name)
		frappe.db.commit()
		self.assertFalse(frappe.db.exists("Pricing Rule", {"title": pricing_rule_title(self.store, ITEM), "disable": 0}))

		approved = self.client(self.head_office).post("maison_pos.api.purchasing.approve_price_change", name=name, action="Approve")
		self.assertTrue(approved.ok, _messages(approved))
		out = approved.json()["message"]
		self.assertEqual(out["workflow_state"], "Approved")
		self.assertTrue(out["pricing_rule"])
		frappe.db.commit()
		self.assertEqual(flt(frappe.db.get_value("Pricing Rule", out["pricing_rule"], "rate")), 44.5)

		# and the price board reads it back as this store's own price
		board = self.client(WH_ADMIN).get("maison_pos.api.pricing.store_prices", item_code=ITEM)
		self.assertTrue(board.ok, _messages(board))
		row = next(x for x in board.json()["message"]["stores"] if x["boutique"] == self.store)
		self.assertEqual(row["rate"], 44.5)
		self.assertEqual(row["source"], "Store override")

	def test_head_office_rejects_with_a_reason_and_no_rule_is_made(self):
		r = self._raise_for(self.manager, self.store, 46.0)
		self.assertTrue(r.ok, _messages(r))
		name = r.json()["message"]["name"]
		self.__class__.raised.append(name)
		rejected = self.client(self.head_office).post(
			"maison_pos.api.purchasing.approve_price_change", name=name, action="Reject", reason="Margin too thin"
		)
		self.assertTrue(rejected.ok, _messages(rejected))
		self.assertEqual(rejected.json()["message"]["workflow_state"], "Rejected")
		self.assertFalse(rejected.json()["message"]["pricing_rule"])
		frappe.db.commit()
		self.assertIn("Margin too thin", frappe.db.get_value("AWANZ Price Change Request", name, "reason"))

	def test_the_approvals_queue_carries_the_margin_for_head_office_and_not_for_a_store(self):
		r = self._raise_for(self.manager, self.store, 47.0)
		self.assertTrue(r.ok, _messages(r))
		self.__class__.raised.append(r.json()["message"]["name"])

		queue = self.client(self.head_office).get("maison_pos.api.purchasing.price_change_requests", item_code=ITEM)
		self.assertTrue(queue.ok, _messages(queue))
		rows = queue.json()["message"]["requests"]
		self.assertTrue(rows)
		self.assertIn("wholesale", rows[0])
		self.assertIn("margin_proposed", rows[0])

		own = self.client(self.manager).get("maison_pos.api.purchasing.price_change_requests", item_code=ITEM)
		self.assertTrue(own.ok, _messages(own))
		for row in own.json()["message"]["requests"]:
			self.assertNotIn("wholesale", row, "what we pay for the stock is not shop-floor information")
			self.assertNotIn("margin_proposed", row)


# ===========================================================================
# §E — adding a vendor from the Buying / Vendors screens
# ===========================================================================
class TestVendorCatalogueScopingHTTP(PricingHTTPCase):
	def test_a_store_manager_is_refused_the_catalogue_endpoints(self):
		c = self.client(self.manager)
		supplier = frappe.db.get_value("Supplier", {"disabled": 0}, "name")
		if not supplier:
			raise unittest.SkipTest("no vendor on this seed")
		self.assertEqual(c.get("maison_pos.api.purchasing.vendor_catalogue_candidates", supplier=supplier).status_code, 403)
		self.assertEqual(
			c.post("maison_pos.api.purchasing.add_vendor_items", supplier=supplier, lines=[{"item_code": ITEM, "cost": 1}]).status_code,
			403,
		)

	def test_a_warehouse_admin_reads_the_candidate_list(self):
		supplier = frappe.db.get_value("Supplier", {"disabled": 0}, "name")
		if not supplier:
			raise unittest.SkipTest("no vendor on this seed")
		r = self.client(WH_ADMIN).get("maison_pos.api.purchasing.vendor_catalogue_candidates", supplier=supplier, search="V12-HTTP")
		self.assertTrue(r.ok, _messages(r))
		self.assertIn("items", r.json()["message"])
