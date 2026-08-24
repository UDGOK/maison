"""v0.7 — the six holes the QA security audit found, each one reproduced and then refused.

``e2e/qa/security-ux-report.md`` is the source: every test below drives the *same* path the
audit used (HTTP, with a real session, wherever the exploit was HTTP) and asserts the exploit
now fails **and** that the legitimate use of the same endpoint still works — an unlock screen
that no longer unlocks would "pass" a security test and fail the shop.

* **S1 / S5** ``TestEscalationHTTP`` — a store manager promoting themselves to Head Office, or
  their staff to Manager, or moving their own record to another store.
* **S2** ``TestPinHashHTTP`` — chain-wide PIN-hash disclosure through the generic REST surface.
* **S3** ``TestGuestSignupHTTP`` — anonymous ``rewards.signup`` overwriting an existing client
  and handing back their client number.
* **S4** ``TestRateLimitHTTP`` — the public endpoints had no working limiter at all.
* **S6** ``TestClientBookHTTP`` — the whole chain's client PII readable from any shop floor.
* ``TestSecurityUnits`` — the pieces that are not HTTP: the role-sync rank guard, the manager
  staff-management API, client-IP resolution, and the migration patch.

Skipped when the site is not being served (``bench start``), like ``test_v0_6_scoping_http``.
"""

from __future__ import annotations

import json
import re
import unittest
from typing import Any, Optional

import frappe
import requests
from frappe.tests.utils import FrappeTestCase

from maison_pos.tests.helpers import ensure_demo_data

PWD = "maison123"
STORE_A, STORE_B = "NYC-5AV", "CHI-OAK"
TAG = "QA-V07"
PIN_A = "2580"
PIN_A2 = "1357"
VICTIM_EMAIL = "qa.v07.victim@example.test"
VICTIM_PHONE = "+1 212 555 0777"
FOREIGN_EMAIL = "qa.v07.elsewhere@example.test"


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
	"""Session client: optional login, then GET / POST ``/api/method/<m>`` with CSRF."""

	def __init__(self, base: str, site: str, user: Optional[str] = None, pwd: str = PWD, headers: Optional[dict] = None):
		self.s = requests.Session()
		self.s.headers["Host"] = site
		if headers:
			self.s.headers.update(headers)
		self.base = base
		self.csrf = ""
		if user:
			r = self.s.post(f"{base}/api/method/login", json={"usr": user, "pwd": pwd}, timeout=15)
			assert r.ok, f"login {user}: {r.status_code} {r.text[:200]}"
			page = self.s.get(f"{base}/pos", timeout=15).text
			m = re.search(r'window\.csrf_token = "([^"]*)"', page)
			self.csrf = m.group(1) if m else ""

	def get(self, method: str, **params):
		return self.s.get(f"{self.base}/api/method/{method}", params=params, timeout=30)

	def post(self, method: str, _headers: Optional[dict] = None, **data):
		headers = {"X-Frappe-CSRF-Token": self.csrf}
		headers.update(_headers or {})
		return self.s.post(f"{self.base}/api/method/{method}", json=data, headers=headers, timeout=30)

	def resource(self, path: str, **params):
		return self.s.get(f"{self.base}/api/resource/{path}", params=params, timeout=30)


def message(response) -> Any:
	try:
		return response.json().get("message")
	except Exception:  # pragma: no cover
		return None


def server_message(response) -> str:
	"""The human message Frappe puts in ``_server_messages`` (what the user actually reads)."""
	try:
		body = response.json()
	except Exception:  # pragma: no cover
		return response.text[:200]
	raw = body.get("_server_messages")
	if raw:
		try:
			return " ".join(json.loads(m).get("message", "") for m in json.loads(raw))
		except Exception:  # pragma: no cover
			return str(raw)
	return str(body.get("exception") or body.get("message") or "")


class SecurityHTTPCase(FrappeTestCase):
	"""Shared plumbing: a served site, the demo store users, and clean rate-limit buckets."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.base = _base_url()
		if not _alive(cls.base):
			raise unittest.SkipTest("web server not running — the v0.7 security tests need `bench start`")
		ensure_demo_data()
		frappe.set_user("Administrator")
		frappe.db.commit()
		cls.manager_a = frappe.db.get_value("Maison Associate", {"boutique": STORE_A, "role": "Manager", "enabled": 1}, "name")
		floor_a = sorted(frappe.get_all("Maison Associate", filters={"boutique": STORE_A, "role": "Associate", "enabled": 1}, pluck="name"))
		cls.assoc_a, cls.assoc_a2 = floor_a[0], floor_a[1]
		cls.manager_b = frappe.db.get_value("Maison Associate", {"boutique": STORE_B, "role": "Manager", "enabled": 1}, "name")
		cls.assoc_b = frappe.db.get_value("Maison Associate", {"boutique": STORE_B, "role": "Associate", "enabled": 1}, "name")
		# the unlock tests need a known PIN and the web workers read committed data, so set it
		# here rather than trusting whatever the shared bench left behind
		set_pin(cls.assoc_a, PIN_A)
		frappe.db.commit()

	def setUp(self):
		super().setUp()
		frappe.set_user("Administrator")
		# the limiter is shared with the web workers through redis; start every test at zero
		frappe.cache().delete_keys("maison_rl")

	def refresh(self) -> None:
		"""End this connection's read snapshot so the web worker's committed writes are visible.

		MariaDB's REPEATABLE READ would otherwise show the test the *old* row and every
		"nothing changed" assertion below would pass without proving anything.
		"""
		frappe.db.rollback()

	def client(self, user: Optional[str] = None, headers: Optional[dict] = None) -> Client:
		return Client(self.base, frappe.local.site, user, headers=headers)


# ---------------------------------------------------------------------------
# S1 + S5 — privilege escalation through `Maison Associate`
# ---------------------------------------------------------------------------
class TestEscalationHTTP(SecurityHTTPCase):
	def test_manager_cannot_promote_themselves_to_head_office(self):
		"""S1: the audit's exact call — `set_value` on their own row, then read another store."""
		mgr = self.client(self.manager_a)
		before = frappe.db.get_value("Maison Associate", self.manager_a, "role")
		r = mgr.post("frappe.client.set_value", doctype="Maison Associate", name=self.manager_a, fieldname="role", value="HeadOffice")
		self.assertEqual(r.status_code, 403, r.text[:300])
		self.refresh()
		self.assertEqual(frappe.db.get_value("Maison Associate", self.manager_a, "role"), before)
		self.assertFalse(
			frappe.db.exists("Has Role", {"parent": self.manager_a, "role": "Maison Head Office", "parenttype": "User"}),
			"the role sync granted Maison Head Office",
		)
		# the proof the audit used: another store's catalogue is still closed
		self.assertEqual(mgr.get("maison_pos.api.catalog.bootstrap", boutique=STORE_B).status_code, 403)

	def test_manager_cannot_move_their_own_record_to_another_store(self):
		"""S5: `boutique` is what every scoped query keys on, so it is not self-service."""
		mgr = self.client(self.manager_a)
		r = mgr.post("frappe.client.set_value", doctype="Maison Associate", name=self.manager_a, fieldname="boutique", value=STORE_B)
		self.assertEqual(r.status_code, 403, r.text[:300])
		self.refresh()
		self.assertEqual(frappe.db.get_value("Maison Associate", self.manager_a, "boutique"), STORE_A)
		r = mgr.post(
			"frappe.client.set_value",
			doctype="Maison Associate",
			name=self.manager_a,
			fieldname="user",
			value=frappe.db.get_value("Maison Associate", self.assoc_a, "user"),
		)
		self.assertEqual(r.status_code, 403, r.text[:300])

	def test_manager_cannot_promote_their_own_staff(self):
		"""S5: `role = Manager` on an own-store associate used to grant the Frappe role."""
		mgr = self.client(self.manager_a)
		r = mgr.post("frappe.client.set_value", doctype="Maison Associate", name=self.assoc_a, fieldname="role", value="Manager")
		self.assertEqual(r.status_code, 403, r.text[:300])
		self.refresh()
		self.assertEqual(frappe.db.get_value("Maison Associate", self.assoc_a, "role"), "Associate")
		user = frappe.db.get_value("Maison Associate", self.assoc_a, "user")
		self.assertFalse(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Manager", "parenttype": "User"}))

	def test_manager_cannot_touch_another_stores_associate(self):
		mgr = self.client(self.manager_a)
		r = mgr.post("frappe.client.set_value", doctype="Maison Associate", name=self.assoc_b, fieldname="enabled", value=0)
		self.assertEqual(r.status_code, 403, r.text[:300])
		self.refresh()
		self.assertEqual(frappe.db.get_value("Maison Associate", self.assoc_b, "enabled"), 1)
		r = mgr.post(
			"frappe.client.insert",
			doc={"doctype": "Maison Associate", "user": "Administrator", "boutique": STORE_B, "role": "HeadOffice"},
		)
		self.assertEqual(r.status_code, 403, r.text[:300])

	def test_manager_still_runs_their_own_shop_floor(self):
		"""The fix must not cost a manager the job: own store, Associate level, still works."""
		mgr = self.client(self.manager_a)
		r = mgr.post("maison_pos.maison_pos.doctype.maison_associate.maison_associate.upsert", user=frappe.db.get_value("Maison Associate", self.assoc_a2, "user"), boutique=STORE_A, role="Associate", enabled=1)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual(message(r)["boutique"], STORE_A)
		# …including a PIN reset for their own staff
		r = mgr.post("maison_pos.maison_pos.doctype.maison_associate.maison_associate.reset_pin", associate=self.assoc_a2, pin="4321")
		self.assertEqual(r.status_code, 200, r.text[:300])
		r = mgr.post("maison_pos.maison_pos.doctype.maison_associate.maison_associate.verify_pin", associate=self.assoc_a2, pin="4321")
		self.assertTrue(message(r)["ok"])
		# but not for somebody else's staff
		r = mgr.post("maison_pos.maison_pos.doctype.maison_associate.maison_associate.reset_pin", associate=self.assoc_b, pin="4321")
		self.assertEqual(r.status_code, 403, r.text[:300])
		frappe.db.rollback()

	@classmethod
	def tearDownClass(cls):
		# the PIN reset above went through a web worker and is committed; put the demo PIN back
		frappe.set_user("Administrator")
		frappe.db.rollback()
		try:
			set_pin(cls.assoc_a2, PIN_A2)
			frappe.db.commit()
		except Exception:  # pragma: no cover
			frappe.db.rollback()
		super().tearDownClass()


# ---------------------------------------------------------------------------
# S2 — PIN hashes readable chain-wide
# ---------------------------------------------------------------------------
class TestPinHashHTTP(SecurityHTTPCase):
	FIELDS = '["name","user","full_name","boutique","role","pin_hash"]'

	def test_associate_cannot_list_pin_hashes_or_other_stores(self):
		"""S2: the audit's call returned 37 rows across 13 stores, every one with its hash."""
		a = self.client(self.assoc_a)
		r = a.get("frappe.client.get_list", doctype="Maison Associate", fields=self.FIELDS, limit_page_length=500)
		self.assertEqual(r.status_code, 200, r.text[:300])
		rows = message(r)
		self.assertTrue(rows, "an associate must still see their own shop floor")
		self.assertEqual({row["boutique"] for row in rows}, {STORE_A})
		for row in rows:
			self.assertNotIn("pin_hash", row)
		# the same through /api/resource
		r = a.resource("Maison Associate", fields=self.FIELDS, limit_page_length=500)
		self.assertEqual(r.status_code, 200, r.text[:300])
		for row in r.json()["data"]:
			self.assertNotIn("pin_hash", row)
			self.assertEqual(row["boutique"], STORE_A)

	def test_single_document_read_carries_no_hash_and_stops_at_the_store_line(self):
		a = self.client(self.assoc_a)
		r = a.get("frappe.client.get", doctype="Maison Associate", name=self.assoc_a)
		self.assertEqual(r.status_code, 200, r.text[:300])
		doc = message(r)
		self.assertFalse(doc.get("pin_hash"), f"pin_hash leaked: {doc.get('pin_hash')!r}")
		self.assertFalse(doc.get("pin_set_on"))
		# another store's associate is not readable at all any more
		self.assertEqual(a.get("frappe.client.get", doctype="Maison Associate", name=self.assoc_b).status_code, 403)
		self.assertEqual(a.resource(f"Maison Associate/{self.assoc_b}").status_code, 403)

	def test_the_hash_cannot_be_guessed_through_a_filter(self):
		"""Frappe does not permlevel-gate *filters*, so the hash must not be in the table at all."""
		a = self.client(self.assoc_a)
		r = a.get(
			"frappe.client.get_list",
			doctype="Maison Associate",
			filters=json.dumps([["pin_hash", "like", "pbkdf2_sha256%"]]),
			fields='["name"]',
			limit_page_length=500,
		)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual(message(r), [], "a `like` filter on pin_hash is still an oracle")
		self.assertTrue(
			frappe.db.get_value("Maison Associate", self.assoc_a, "pin_hash") in (None, "") or set(frappe.db.get_value("Maison Associate", self.assoc_a, "pin_hash")) == {"*"},
			"the doctype column still holds the real hash",
		)

	def test_the_unlock_screen_still_works(self):
		"""`session.associates` + `verify_pin` are the POS unlock: they must be untouched."""
		a = self.client(self.assoc_a)
		r = a.get("maison_pos.api.session.associates", boutique=STORE_A)
		self.assertEqual(r.status_code, 200, r.text[:300])
		names = [row["name"] for row in message(r)]
		self.assertIn(self.assoc_a, names)
		self.assertNotIn(self.assoc_b, names)
		r = a.post("maison_pos.maison_pos.doctype.maison_associate.maison_associate.verify_pin", associate=self.assoc_a, pin=PIN_A)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertTrue(message(r)["ok"])
		r = a.post("maison_pos.maison_pos.doctype.maison_associate.maison_associate.verify_pin", associate=self.assoc_a, pin="0000")
		self.assertFalse(message(r)["ok"])
		# and the bootstrap the POS actually calls still carries the shop floor
		r = a.get("maison_pos.api.catalog.bootstrap", boutique=STORE_A)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertTrue(message(r)["associates"])
		self.assertFalse(any(row.get("pin_hash") for row in message(r)["associates"]))

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.set_value("Maison Associate", self.assoc_a, "failed_pin_attempts", 0, update_modified=False)
		frappe.db.commit()
		super().tearDown()


# ---------------------------------------------------------------------------
# S3 — anonymous sign-up hijacking an existing client
# ---------------------------------------------------------------------------
class TestGuestSignupHTTP(SecurityHTTPCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		cls.victim = _ensure_customer(f"{TAG} Victim", VICTIM_EMAIL, VICTIM_PHONE)
		cls.victim_number = frappe.db.get_value("Customer", cls.victim, "maison_client_number")
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		_purge_test_customers()
		super().tearDownClass()

	def test_guest_signup_cannot_overwrite_or_reveal_an_existing_client(self):
		"""S3: the audit renamed a client ORIG→HIJACKED and got their client number back."""
		guest = self.client()
		r = guest.post(
			"maison_pos.api.rewards.signup",
			name=f"{TAG} HIJACKED",
			email=VICTIM_EMAIL,
			phone="+1 999 555 0000",
			consent=1,
			consent_email=1,
		)
		self.assertEqual(r.status_code, 200, r.text[:300])
		body = message(r)
		self.assertNotIn("client_number", body)
		self.assertNotIn(self.victim_number, json.dumps(body))
		self.refresh()
		row = frappe.db.get_value("Customer", self.victim, ["customer_name", "mobile_no", "email_id"], as_dict=True)
		self.assertEqual(row.customer_name, f"{TAG} Victim", "the guest sign-up rewrote an existing client")
		self.assertEqual(row.mobile_no, VICTIM_PHONE)
		self.assertEqual(frappe.db.get_value("Customer", self.victim, "maison_client_number"), self.victim_number)

	def test_the_answer_is_the_same_whether_the_client_exists_or_not(self):
		"""Otherwise the form is an oracle: "is this address one of your customers?"."""
		guest = self.client()
		existing = message(guest.post("maison_pos.api.rewards.signup", name=f"{TAG} A", email=VICTIM_EMAIL, consent=1))
		fresh_email = f"qa.v07.new.{frappe.generate_hash(length=8)}@example.test"
		created = message(guest.post("maison_pos.api.rewards.signup", name=f"{TAG} New Member", email=fresh_email, consent=1))
		self.assertEqual(existing, created)
		self.assertTrue(created["ok"])
		self.assertTrue(created["message"])
		# …and the genuine sign-up really did join the programme
		self.refresh()
		customer = frappe.db.get_value("Customer", {"email_id": fresh_email}, "name")
		self.assertTrue(customer, "a genuine new sign-up must still create the member")
		self.assertTrue(frappe.db.get_value("Customer", customer, "loyalty_program"))
		self.assertTrue(frappe.db.get_value("Customer", customer, "maison_client_number"))

	def test_signed_in_staff_may_still_link_a_client(self):
		"""Linking is a counter decision, so it stays — for an authenticated member of staff."""
		staff = self.client(self.manager_a)
		r = staff.post("maison_pos.api.rewards.signup", name=f"{TAG} Victim", email=VICTIM_EMAIL, phone=VICTIM_PHONE, consent=1)
		self.assertEqual(r.status_code, 200, r.text[:300])
		self.assertEqual(message(r)["client_number"], self.victim_number)


# ---------------------------------------------------------------------------
# S4 — rate limiting
# ---------------------------------------------------------------------------
class TestRateLimitHTTP(SecurityHTTPCase):
	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		_purge_test_customers()
		super().tearDownClass()

	def _signup(self, client: Client, headers: Optional[dict] = None):
		# no consent -> the payload is refused *after* the limiter, so no client is created
		return client.post("maison_pos.api.rewards.signup", _headers=headers, name=f"{TAG} Flood", email="qa.v07.flood@example.test")

	def test_anonymous_signup_is_throttled_with_a_clean_429(self):
		"""S4: the audit sent 12 rapid anonymous sign-ups and every one came back 200."""
		guest = self.client()
		codes = [self._signup(guest).status_code for _ in range(8)]
		self.assertIn(429, codes, f"no request was throttled: {codes}")
		self.assertLessEqual(codes.index(429), 6, f"throttled far too late: {codes}")
		blocked = self._signup(guest)
		self.assertEqual(blocked.status_code, 429)
		human = server_message(blocked)
		self.assertIn("Too many requests", human)
		self.assertNotIn("Traceback", blocked.text)

	def test_a_forged_forwarded_for_no_longer_buys_a_fresh_bucket(self):
		"""The framework keys on the *first* XFF hop — which the client writes. We do not."""
		codes = []
		for i in range(8):
			# an attacker prepending a random hop; the right-hand hop is what a proxy appended
			guest = self.client(headers={"X-Forwarded-For": f"9.9.9.{i}, 81.2.69.142"})
			codes.append(self._signup(guest).status_code)
		self.assertIn(429, codes, f"rotating X-Forwarded-For defeated the limiter: {codes}")

	def test_the_salon_pairing_endpoint_is_throttled(self):
		guest = self.client()
		codes = [guest.post("maison_pos.api.salon.pair", code="000000").status_code for _ in range(16)]
		self.assertIn(429, codes, f"salon.pair was never throttled: {codes}")

	def test_a_public_receipt_read_is_throttled_but_generous(self):
		guest = self.client()
		codes = [guest.get("maison_pos.api.sales.receipt", token="not-a-real-token").status_code for _ in range(12)]
		self.assertNotIn(429, codes, "a dozen receipt reads must not be throttled")
		self.assertEqual(set(codes), {404})


# ---------------------------------------------------------------------------
# S6 — the chain-wide client book
# ---------------------------------------------------------------------------
class TestClientBookHTTP(SecurityHTTPCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		cls.foreign = _ensure_customer(f"{TAG}Elsewhere Client", FOREIGN_EMAIL, "+1 312 555 0999")
		if frappe.db.exists("DocType", "Maison Client Profile"):
			if not frappe.db.exists("Maison Client Profile", cls.foreign):
				frappe.get_doc({"doctype": "Maison Client Profile", "customer": cls.foreign}).insert(ignore_permissions=True)
			frappe.db.set_value("Maison Client Profile", cls.foreign, "preferred_boutique", STORE_B, update_modified=False)
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		_purge_test_customers()
		super().tearDownClass()

	def test_a_store_user_can_no_longer_download_the_chains_client_book(self):
		"""S6: `get_list("Customer")` used to return every client of every store."""
		a = self.client(self.assoc_a)
		r = a.get(
			"frappe.client.get_list",
			doctype="Customer",
			fields='["name","customer_name","mobile_no","email_id","maison_client_number"]',
			limit_page_length=0,
		)
		self.assertEqual(r.status_code, 200, r.text[:300])
		names = [row["name"] for row in message(r)]
		self.refresh()
		total = frappe.db.count("Customer", {"disabled": 0})
		self.assertLess(len(names), total, "the whole client book is still listable")
		self.assertNotIn(self.foreign, names, "another store's client is still listed")
		# /api/resource is the same query
		r = a.resource("Customer", fields='["name"]', limit_page_length=0)
		self.assertNotIn(self.foreign, [row["name"] for row in r.json()["data"]])

	def test_service_still_works_for_a_client_from_another_store(self):
		"""A client may shop anywhere: an exact-ish search still finds them, capped and logged."""
		a = self.client(self.assoc_a)
		r = a.get("maison_pos.api.customers.search", q=f"{TAG}Elsewhere", limit=50)
		self.assertEqual(r.status_code, 200, r.text[:300])
		rows = message(r)
		self.assertIn(self.foreign, [row["name"] for row in rows])
		self.assertLessEqual(len(rows), 25, "the result cap is not applied")
		r = a.get("maison_pos.api.customers.lookup", code=FOREIGN_EMAIL)
		self.assertEqual(message(r)["name"], self.foreign)

	def test_an_empty_search_lists_this_stores_clients_only(self):
		a = self.client(self.assoc_a)
		rows = message(a.get("maison_pos.api.customers.search", q="", limit=50))
		self.assertNotIn(self.foreign, [row["name"] for row in rows])

	def test_a_one_letter_query_no_longer_walks_the_book(self):
		a = self.client(self.assoc_a)
		self.assertEqual(message(a.get("maison_pos.api.customers.search", q="a")), [])
		self.assertEqual(message(a.get("maison_pos.api.customers.search", q="e")), [])


# ---------------------------------------------------------------------------
# the parts that are not HTTP
# ---------------------------------------------------------------------------
class TestSecurityUnits(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		frappe.set_user("Administrator")
		cls.manager_a = frappe.db.get_value("Maison Associate", {"boutique": STORE_A, "role": "Manager", "enabled": 1}, "name")
		cls.assoc_a = frappe.db.get_value("Maison Associate", {"boutique": STORE_A, "role": "Associate", "enabled": 1}, "name", order_by="name")

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()

	# --- S1: the role sync ---------------------------------------------
	def test_role_sync_refuses_to_grant_a_rank_above_the_grantor(self):
		"""Even a server path that ignores permissions cannot hand out Head Office."""
		frappe.set_user(self.manager_a)
		doc = frappe.get_doc("Maison Associate", self.assoc_a)
		doc.role = "HeadOffice"
		with self.assertRaises(frappe.PermissionError):
			doc.save(ignore_permissions=True)
		frappe.db.rollback()
		user = frappe.db.get_value("Maison Associate", self.assoc_a, "user")
		self.assertFalse(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Head Office", "parenttype": "User"}))

	def test_a_demotion_takes_the_frappe_role_back(self):
		"""The sync used to be add-only: a demoted manager kept `Maison Manager` for ever."""
		frappe.set_user("Administrator")
		doc = frappe.get_doc("Maison Associate", self.assoc_a)
		user = doc.user
		doc.role = "Manager"
		doc.save(ignore_permissions=True)
		self.assertTrue(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Manager", "parenttype": "User"}))
		doc.reload()
		doc.role = "Associate"
		doc.save(ignore_permissions=True)
		self.assertFalse(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Manager", "parenttype": "User"}))
		self.assertTrue(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Associate", "parenttype": "User"}))
		frappe.db.rollback()

	def test_the_validate_guard_rejects_a_privileged_change_on_its_own(self):
		"""Third line of defence: no permlevel, no hook — just the controller."""
		frappe.set_user(self.manager_a)
		doc = frappe.get_doc("Maison Associate", self.assoc_a)
		doc.load_doc_before_save()
		doc.boutique = STORE_B
		with self.assertRaises(frappe.PermissionError):
			doc._guard_privileged_fields()
		doc.boutique = STORE_A
		doc.role = "Manager"
		with self.assertRaises(frappe.PermissionError):
			doc._guard_privileged_fields()
		frappe.db.rollback()

	# --- S1: the manager's own staff API --------------------------------
	def test_manager_upsert_is_bounded_to_their_own_store_and_level(self):
		from maison_pos.maison_pos.doctype.maison_associate.maison_associate import upsert

		frappe.set_user("Administrator")
		email = f"qa.v07.newhire.{frappe.generate_hash(length=6)}@example.test"
		frappe.get_doc({"doctype": "User", "email": email, "first_name": "QA", "last_name": "Newhire", "send_welcome_email": 0}).insert(
			ignore_permissions=True
		)
		frappe.set_user(self.manager_a)
		created = upsert(user=email, boutique=STORE_A, role="Associate", pin="4455")
		self.assertEqual(created["boutique"], STORE_A)
		self.assertEqual(created["role"], "Associate")
		self.assertTrue(frappe.db.exists("Has Role", {"parent": email, "role": "Maison Associate", "parenttype": "User"}))
		self.assertFalse(frappe.db.exists("Has Role", {"parent": email, "role": "Maison Manager", "parenttype": "User"}))
		with self.assertRaises(frappe.PermissionError):
			upsert(user=email, boutique=STORE_A, role="Manager")
		with self.assertRaises(frappe.PermissionError):
			upsert(user=email, boutique=STORE_B, role="Associate")
		frappe.set_user(self.assoc_a)
		with self.assertRaises(frappe.PermissionError):
			upsert(user=email, boutique=STORE_A, role="Associate")
		frappe.db.rollback()

	# --- S2: the PIN itself ---------------------------------------------
	def test_the_pin_hash_lives_outside_the_doctype_table(self):
		from maison_pos.maison_pos.doctype.maison_associate.maison_associate import PBKDF2_ITERATIONS, hash_pin, is_dummy

		frappe.set_user("Administrator")
		doc = frappe.get_doc("Maison Associate", self.assoc_a)
		doc.set_pin("2580")
		column = frappe.db.get_value("Maison Associate", self.assoc_a, "pin_hash")
		self.assertTrue(is_dummy(column), f"the hash is still in the column: {column!r}")
		real = frappe.get_doc("Maison Associate", self.assoc_a).get_pin_hash()
		self.assertTrue(real.startswith("pbkdf2_sha256$"))
		self.assertEqual(int(real.split("$")[1]), PBKDF2_ITERATIONS)
		self.assertNotEqual(hash_pin("2580"), real, "the salt is not random")
		frappe.db.rollback()

	def test_a_legacy_hash_still_verifies_and_is_upgraded(self):
		from maison_pos.maison_pos.doctype.maison_associate.maison_associate import PBKDF2_ITERATIONS, hash_pin

		frappe.set_user("Administrator")
		legacy = hash_pin("2580", iterations=1000)
		frappe.db.set_value("Maison Associate", self.assoc_a, "pin_hash", legacy, update_modified=False)
		doc = frappe.get_doc("Maison Associate", self.assoc_a)
		self.assertTrue(doc.verify_pin("2580"))
		doc.reload()
		self.assertEqual(int((doc.get_pin_hash() or "$0$").split("$")[1]), PBKDF2_ITERATIONS)
		frappe.db.rollback()

	def test_pin_lockout_after_five_failures(self):
		frappe.set_user("Administrator")
		doc = frappe.get_doc("Maison Associate", self.assoc_a)
		for _ in range(5):
			self.assertFalse(doc.verify_pin("0000"))
			doc.reload()
		with self.assertRaises(frappe.AuthenticationError):
			doc.verify_pin("2580")
		frappe.db.set_value("Maison Associate", self.assoc_a, "failed_pin_attempts", 0, update_modified=False)
		frappe.db.rollback()

	# --- S4: which address the limiter counts ---------------------------
	def test_client_ip_ignores_the_hops_the_client_wrote(self):
		from maison_pos.ratelimit import client_ip

		cases = [
			# (X-Forwarded-For, expected bucket)
			("81.2.69.142", "81.2.69.142"),
			# an attacker prepending junk: the hop our proxy appended still wins
			("9.9.9.9, 81.2.69.142", "81.2.69.142"),
			("not-an-ip, 81.2.69.142", "81.2.69.142"),
			("9.9.9.9, 8.8.8.8, 81.2.69.142", "81.2.69.142"),
			# our own load balancers are private and are skipped
			("81.2.69.142, 10.0.0.5, 127.0.0.1", "81.2.69.142"),
			# an all-private chain (docker / single host): the right-hand hop is still stable
			("10.0.0.5, 172.16.4.9", "172.16.4.9"),
			# one IPv6 customer cannot cycle addresses inside their /64
			("2a00:1450:4001:81f::200e", "2a00:1450:4001:81f::/64"),
		]
		for header, expected in cases:
			with _fake_request({"X-Forwarded-For": header}):
				self.assertEqual(client_ip(), expected, header)
		# an explicit hop count wins over the heuristic…
		with _fake_request({"X-Forwarded-For": "9.9.9.9, 81.2.69.142"}, conf={"maison_trusted_proxy_hops": 1}):
			self.assertEqual(client_ip(), "81.2.69.142")
		# …and a header the edge controls wins over both
		with _fake_request({"X-Forwarded-For": "9.9.9.9, 81.2.69.142", "X-Real-IP": "8.8.4.4"}, conf={"maison_client_ip_header": "X-Real-IP"}):
			self.assertEqual(client_ip(), "8.8.4.4")

	def test_the_limiter_counts_and_then_refuses(self):
		from maison_pos.ratelimit import guard

		frappe.cache().delete_keys("maison_rl")
		with _fake_request({"X-Forwarded-For": "81.2.69.150"}):
			for _ in range(3):
				guard("unit.test", 3, 60, global_limit=100)
			with self.assertRaises(frappe.RateLimitExceededError):
				guard("unit.test", 3, 60, global_limit=100)
		# a different client is unaffected…
		with _fake_request({"X-Forwarded-For": "81.2.69.151"}):
			guard("unit.test", 3, 60, global_limit=100)
		# …until the endpoint's global ceiling is reached
		with _fake_request({"X-Forwarded-For": "81.2.69.152"}):
			with self.assertRaises(frappe.RateLimitExceededError):
				guard("unit.test", 3, 60, global_limit=4)
		frappe.cache().delete_keys("maison_rl")

	# --- S6: the audit trail --------------------------------------------
	def test_a_cross_store_client_lookup_is_written_to_the_security_log(self):
		from maison_pos.api import customers

		frappe.set_user("Administrator")
		customer = _ensure_customer(f"{TAG}Audit Client", "qa.v07.audit@example.test", "+1 312 555 0888")
		frappe.set_user(self.assoc_a)
		rows = customers.search(q=f"{TAG}Audit")
		self.assertIn(customer, [r["name"] for r in rows])
		frappe.set_user("Administrator")
		self.assertIn("customers.search", _security_log_tail())
		frappe.db.rollback()

	# --- the migration patch ---------------------------------------------
	def test_the_patch_moves_a_legacy_hash_and_takes_back_a_stolen_role(self):
		from maison_pos.maison_pos.doctype.maison_associate.maison_associate import hash_pin
		from maison_pos.patches.v0_7.associate_hardening import migrate_pin_hashes, repair_role_grants

		frappe.set_user("Administrator")
		legacy = hash_pin("2580", iterations=1000)
		frappe.db.set_value("Maison Associate", self.assoc_a, "pin_hash", legacy, update_modified=False)
		user = frappe.db.get_value("Maison Associate", self.assoc_a, "user")
		stolen = frappe.get_doc("User", user)
		stolen.append("roles", {"role": "Maison Head Office"})
		stolen.flags.ignore_permissions = True
		stolen.save()
		self.assertTrue(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Head Office", "parenttype": "User"}))

		self.assertGreaterEqual(migrate_pin_hashes(), 1)
		column = frappe.db.get_value("Maison Associate", self.assoc_a, "pin_hash")
		self.assertEqual(set(column), {"*"})
		self.assertEqual(frappe.get_doc("Maison Associate", self.assoc_a).get_pin_hash(), legacy)

		repair_role_grants()
		self.assertFalse(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Head Office", "parenttype": "User"}))
		self.assertTrue(frappe.db.exists("Has Role", {"parent": user, "role": "Maison Associate", "parenttype": "User"}))
		frappe.db.rollback()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def set_pin(associate: str, pin: str) -> None:
	doc = frappe.get_doc("Maison Associate", associate)
	doc.set_pin(pin)
	frappe.db.set_value("Maison Associate", associate, "failed_pin_attempts", 0, update_modified=False)


def _ensure_customer(customer_name: str, email: str, phone: str) -> str:
	existing = frappe.db.get_value("Customer", {"email_id": email}, "name")
	if existing:
		frappe.db.set_value("Customer", existing, {"customer_name": customer_name, "mobile_no": phone}, update_modified=False)
		return existing
	from maison_pos.api.customers import _default, _default_customer_group

	doc = frappe.get_doc(
		{
			"doctype": "Customer",
			"customer_name": customer_name,
			"customer_type": "Individual",
			"customer_group": _default_customer_group(),
			"territory": frappe.db.get_single_value("Selling Settings", "territory") or _default("Territory"),
			"email_id": email,
			"mobile_no": phone,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def _purge_test_customers() -> None:
	"""Remove every Customer this suite created (name-tagged or on an ``example.test`` address)."""
	try:
		# the web workers committed these rows after this connection's snapshot began
		frappe.db.rollback()
		names = set(frappe.get_all("Customer", filters={"customer_name": ("like", f"{TAG}%")}, pluck="name"))
		names |= set(frappe.get_all("Customer", filters={"email_id": ("like", "qa.v07.%@example.test")}, pluck="name"))
		for name in names:
			for linked in ("Maison Client Profile", "Maison Campaign Touch", "Maison Client Interaction"):
				if frappe.db.exists("DocType", linked):
					frappe.db.delete(linked, {"customer": name})
			# contacts + addresses are ERPNext's own `Customer.on_trash` job — deleting the Contact
			# row by hand leaves a Dynamic Link pointing at nothing and the delete then fails
			frappe.delete_doc("Customer", name, force=True, ignore_permissions=True, delete_permanently=True)
		frappe.db.commit()
	except Exception:  # pragma: no cover — cleanup must never fail the suite
		frappe.db.rollback()
		frappe.log_error(frappe.get_traceback(), "v0.7 security test cleanup")


def _security_log_tail(lines: int = 40) -> str:
	import os

	from maison_pos.audit import logger

	for handler in logger().handlers:
		try:
			handler.flush()
		except Exception:  # pragma: no cover
			pass
	path = os.path.join(frappe.utils.get_bench_path(), "logs", "maison_security.log")
	if not os.path.exists(path):
		return ""
	with open(path, encoding="utf-8") as f:
		return "".join(f.readlines()[-lines:])


class _fake_request:
	"""Context manager giving ``frappe.local`` a request with the given headers."""

	def __init__(self, headers: dict, conf: Optional[dict] = None):
		self.headers = headers
		self.conf = conf or {}

	def __enter__(self):
		from werkzeug.test import EnvironBuilder
		from werkzeug.wrappers import Request

		self._request = getattr(frappe.local, "request", None)
		self._ip = getattr(frappe.local, "request_ip", None)
		frappe.local.request = Request(EnvironBuilder(headers=self.headers, environ_base={"REMOTE_ADDR": "127.0.0.1"}).get_environ())
		frappe.local.request_ip = (self.headers.get("X-Forwarded-For", "127.0.0.1").split(",")[0]).strip()
		self._conf_backup = {k: frappe.conf.get(k) for k in self.conf}
		frappe.conf.update(self.conf)
		return self

	def __exit__(self, *exc):
		for key, value in self._conf_backup.items():
			if value is None:
				frappe.conf.pop(key, None)
			else:
				frappe.conf[key] = value
		frappe.local.request = self._request
		frappe.local.request_ip = self._ip
		return False
