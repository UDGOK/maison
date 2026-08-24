"""v0.8 — regression tests for the defects QA found on the live deployment.

Reports: ``e2e/qa/warehouse-report.md``, ``dashboard-report.md``,
``shop-rewards-salon-report.md``, ``security-ux-report.md`` (UX half).

Each test below fails against the code as it was:

**Web shop** — A1 a new customer could not register (sign-up disabled, no portal role, and
Frappe's own sign-up needs an outgoing mail account the site does not have) · A2 the availability
pill listed every city in a `nowrap` span and pushed the product page 435 px sideways ·
A4 `/shop/collection` showed 96 of 155 products with no pagination · A5 an age-restricted item
could be added to the bag and only checkout refused it.

**Rewards** — B3 a sale whose points had been redeemed could never be returned (ERPNext refuses to
rebuild the accrual).

**Salon** — C1 the digits-only keypad could not enter a client number · C2 the CloudChaserz seed
created no playlist, so the ambient screen was bare.

**Warehouse** — W-D1 a request raised from a low-stock alert could never be rejected ·
W-D3 the low-stock digest failed outright and one bad recipient killed every store's ·
W-D4 `shipping.buy` silently orphaned an already-purchased label · W-D5 the cycle-count
reconciliation was owned by Administrator · W-D6 `first_seen` / `last_seen` never reached any
client · W-N1 cancelling a shipment stranded its request · W-N2 only the first leg of a multi-leg
receipt was linked · W-N4 the simulated tracker mixed UTC with the site clock.

**Dashboard** — D-2 `avg_ticket_vs_boutique` compared a gross average with a net one ·
D-3 the Hourly Heatmap clamped out-of-hours trade into the edge columns · D-4 "avg ticket" divided
net-of-returns by a sales-only count · D-5 the tier chips were hard-coded · D-6 three reports were
unreachable · D-7 "net sales" meant two different things · D-9 `share_pct` used a different
denominator from the total printed beside it · D-12 every non-cash tender was reported as card ·
D-14 the Serial Ledger had no scoping and no filter validation.
"""

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, cint, flt, nowdate

from maison_pos.api import dashboard as dashboard_api
from maison_pos.api import hr, inventory, returns, rewards, salon, sales, shipping
from maison_pos.api import reports as reports_api
from maison_pos.api import webshop as webshop_api
from maison_pos.identifiers import coerce_client_number
from maison_pos.tests.helpers import ensure_demo_data, ensure_stock, pos_invoice
from maison_pos.tests.test_v0_6_warehouse import (
	ITEM,
	STORE,
	WH_ADMIN,
	_manager,
	_source_warehouse,
	ensure_warehouse_admin,
	stock_main_warehouse,
)
from maison_pos.webshop import core as web_core

NYC = STORE


class QABase(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")
		self.sp = f"awanz_qa_{frappe.generate_hash(length=6)}"
		frappe.db.savepoint(self.sp)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point=self.sp)


# =================================================================================================
# Web shop
# =================================================================================================
class TestWebshopQAV08(QABase):
	def _avail(self, cities: list[str], qty: float = 3) -> list[dict]:
		return [{"boutique": f"B{i}", "boutique_name": f"Store {i}", "city": c, "qty": qty} for i, c in enumerate(cities)]

	def test_a2_the_availability_label_summarises_instead_of_listing_every_city(self):
		"""The pill has to fit a 390 px phone; the full list stays available for the disclosure."""
		many = ["Tulsa", "Broken Arrow", "Jenks", "Houston", "Muskogee", "Owasso", "Sapulpa"]
		summary = web_core.availability_summary(self._avail(many))
		self.assertEqual(summary["stores"], 7)
		self.assertEqual(summary["cities"], many)
		# the label a nowrap pill has to hold is short and countable, never the 65-char join
		self.assertNotIn("Muskogee", summary["label"])
		self.assertIn("7", summary["label"])
		self.assertLessEqual(len(summary["label"]), web_core.MAX_CITY_LABEL_CHARS)
		self.assertEqual(web_core.city_label(self._avail(many)), summary["label"])
		# the expansion still names every city
		self.assertEqual(web_core.city_label_full(self._avail(many)), ", ".join(many))

	def test_a2_a_short_list_is_still_spelled_out(self):
		three = ["Chicago", "New York", "Beverly Hills"]
		self.assertEqual(web_core.city_label(self._avail(three)), "Chicago, New York, Beverly Hills")
		# out-of-stock stores are not "available at"
		self.assertEqual(web_core.city_label(self._avail(three, qty=0)), "")

	def test_a4_the_catalogue_reports_the_total_and_whether_another_page_exists(self):
		if not frappe.db.exists("DocType", "Website Item"):
			self.skipTest("webshop not installed")
		total = frappe.db.count("Website Item", {"published": 1})
		if total < 2:
			self.skipTest("no published website items on this site")
		first = webshop_api.catalogue(limit=1)
		self.assertEqual(first["total"], total)
		self.assertEqual(first["start"], 0)
		self.assertTrue(first["has_more"])  # 59 products used to be unreachable by browsing
		last = webshop_api.catalogue(start=total - 1, limit=1)
		self.assertFalse(last["has_more"])
		self.assertNotEqual(first["items"][0]["item_code"], last["items"][0]["item_code"])

	def test_a5_an_item_that_cannot_be_bought_online_is_refused_at_add_time(self):
		"""`update_cart` had no web-mode guard, so only `place_order` refused — after the bag was stuck."""
		item = frappe.get_doc("Item", ITEM)
		item.db_set("maison_web_mode", "Enquire", update_modified=False)
		frappe.clear_document_cache("Item", item.name)
		with self.assertRaises(frappe.ValidationError) as caught:
			webshop_api._assert_buyable_online(ITEM)
		self.assertIn("enquire", str(caught.exception).lower())

	def test_a5_an_age_restricted_item_says_it_is_sold_in_store(self):
		item = frappe.get_doc("Item", ITEM)
		item.db_set("maison_age_restricted", 1, update_modified=False)
		frappe.clear_document_cache("Item", item.name)
		with patch("maison_pos.brand.get_age_settings", return_value={"webshop_age_restricted_sales": 0, "minimum_age": 21, "age_verification_required": 1, "id_scan_enabled": 1}):
			with self.assertRaises(frappe.ValidationError) as caught:
				webshop_api._assert_buyable_online(ITEM)
		message = str(caught.exception).lower()
		self.assertIn("21", message)
		self.assertIn("store only", message)

	def test_a1_portal_signup_is_on_with_the_customer_role(self):
		"""Both settings are part of the shop working at all, so the glue asserts them."""
		from maison_pos.webshop.setup import PORTAL_DEFAULT_ROLE, ensure_portal_signup

		frappe.db.set_single_value("Website Settings", "disable_signup", 1)
		if frappe.db.exists("DocType", "Portal Settings"):
			frappe.db.set_single_value("Portal Settings", "default_role", "")
		changed = ensure_portal_signup()
		self.assertEqual(cint(frappe.db.get_single_value("Website Settings", "disable_signup")), 0)
		if frappe.db.exists("DocType", "Portal Settings"):
			self.assertEqual(frappe.db.get_single_value("Portal Settings", "default_role"), PORTAL_DEFAULT_ROLE)
		self.assertTrue(changed)

	def test_a1_a_guest_can_register_and_gets_a_usable_portal_account(self):
		"""Frappe's own sign-up mails a random password; with no outgoing account nobody can get in."""
		if not frappe.db.exists("DocType", "Website Item"):
			self.skipTest("webshop not installed")
		from maison_pos.webshop.setup import ensure_portal_signup

		ensure_portal_signup()
		email = f"qa.v08.{frappe.generate_hash(length=6)}@example.com"
		frappe.set_user("Guest")
		out = webshop_api.register(email=email, full_name="Jamie Rivers", password="Str0ng-Passw0rd-9x", redirect_to="/cart")
		frappe.set_user("Administrator")
		self.assertTrue(out["ok"])
		self.assertEqual(out["redirect_to"], "/cart")
		user = frappe.get_doc("User", email)
		self.assertEqual(user.user_type, "Website User")
		self.assertIn("Customer", [r.role for r in user.roles])
		# webshop resolves the party through the user's *first* contact: every one of them has to
		# carry the Customer link, or ERPNext refuses the cart Quotation
		customer = frappe.db.get_value("Portal User", {"user": email}, "parent")
		self.assertTrue(customer)
		contacts = frappe.get_all("Contact", filters={"user": email}, pluck="name")
		self.assertTrue(contacts)
		for name in contacts:
			links = frappe.get_all("Dynamic Link", filters={"parent": name, "parenttype": "Contact", "link_doctype": "Customer"}, pluck="link_name")
			self.assertIn(customer, links)

	def test_a1_registration_never_touches_an_existing_account(self):
		email = frappe.db.get_value("User", {"enabled": 1, "name": ("not in", ("Guest", "Administrator"))}, "name")
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			webshop_api.register(email=email, full_name="Someone Else", password="Str0ng-Passw0rd-9x")
		frappe.set_user("Administrator")

	def test_a1_registration_refuses_a_weak_password(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			webshop_api.register(email=f"qa.weak.{frappe.generate_hash(length=6)}@example.com", full_name="Weak Password", password="short")
		frappe.set_user("Administrator")


# =================================================================================================
# Rewards — B3
# =================================================================================================
class TestReturnAfterPointsRedeemedV08(QABase):
	"""B3 — ERPNext refuses to rebuild a sale's loyalty accrual once its points have been spent."""

	def setUp(self):
		super().setUp()
		enrolled = frappe.db.get_value("Customer", {"loyalty_program": ("is", "set"), "disabled": 0}, "name")
		self.assertTrue(enrolled, "the demo seed should enrol at least one client")
		self.program = frappe.db.get_value("Customer", enrolled, "loyalty_program")
		# a client with no history: the demo customers carry six months of points, and ERPNext
		# redeems oldest-entry-first, so a redemption would never touch the sale under test
		template = frappe.get_doc("Customer", enrolled)
		self.customer = frappe.get_doc(
			{
				"doctype": "Customer",
				"customer_name": f"QA B3 {frappe.generate_hash(length=6)}",
				"customer_type": "Individual",
				"customer_group": template.customer_group,
				"territory": template.territory,
				"loyalty_program": self.program,
			}
		).insert(ignore_permissions=True).name
		self.conversion = flt(frappe.db.get_value("Loyalty Program", self.program, "conversion_factor")) or 1.0
		ensure_stock(ITEM, NYC, 20)

	def _sell(self, rate: float, redeem: int = 0):
		items = [{"item_code": ITEM, "qty": 1, "rate": rate}]
		due = round(rate * 1.08875, 2) - round(redeem * self.conversion, 2)
		extra = {"loyalty_points_redeemed": redeem} if redeem else {}
		payload = pos_invoice(boutique=NYC, items=items, payments=[{"mode_of_payment": "Cash", "amount": max(0.0, round(due, 2))}], customer=self.customer, **extra)
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		return frappe.get_doc("Sales Invoice", result["invoice_name"])

	def _balance(self) -> int:
		return cint(rewards.points_balance(self.customer, self.program))

	def test_b3_a_sale_can_be_returned_after_its_points_were_redeemed(self):
		first = self._sell(120)
		self.assertGreater(self._balance(), 0)
		earned = cint(rewards.accrual_entry(first.name)["loyalty_points"])
		# a later sale spends some of those points (ERPNext caps the discount at the bill)
		spend = max(1, min(earned, self._balance(), int(40 / self.conversion)))
		second = self._sell(90, redeem=spend)
		self.assertTrue(frappe.db.exists("Loyalty Point Entry", {"invoice": second.name, "loyalty_points": ("<", 0)}))
		self.assertTrue(rewards.redemptions_against_sale(first.name), "the second sale should draw on the first sale's points")

		balance_before = self._balance()
		out = returns.return_items(first.name, [{"item_code": ITEM, "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		self.assertLessEqual(cint(out["points_clawed_back"]), balance_before)

		# the refund happened (this used to raise "…can't be cancelled since the Loyalty Points
		# earned has been redeemed. First cancel the Sales Invoice No …")
		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		self.assertEqual(cn.docstatus, 1)
		self.assertEqual(cn.is_return, 1)
		self.assertTrue(out.get("points_settled_manually"))
		# and the points the returned goods earned came off the balance, never below zero
		self.assertEqual(self._balance(), balance_before - cint(out["points_clawed_back"]))
		self.assertGreaterEqual(self._balance(), 0)
		self.assertEqual(cint(out["points_clawed_back"]) + cint(out["points_shortfall"]), earned)

	def test_b3_the_shortfall_asks_for_a_manager_rather_than_failing(self):
		"""Points already spent are a write-off — the associate gets an actionable message."""
		first = self._sell(200)
		earned = cint(rewards.accrual_entry(first.name)["loyalty_points"])
		self.assertGreater(earned, 0)
		# the whole balance goes on a basket worth the same: that sale earns nothing back
		# (points are earned on what is actually paid), so almost nothing is left to claw back
		self._sell(round(earned * self.conversion, 2), redeem=self._balance())
		self.assertLess(self._balance(), earned)
		frappe.set_user(frappe.db.get_value("AWANZ Associate", {"boutique": NYC, "role": "Associate", "enabled": 1}, "user"))
		with self.assertRaises(returns.ManagerRequiredError) as caught:
			returns.return_items(first.name, [{"item_code": ITEM, "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		self.assertIn("already spent", str(caught.exception))
		frappe.set_user("Administrator")
		# a manager (or anyone manager-and-above) can put it through
		out = returns.return_items(first.name, [{"item_code": ITEM, "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		self.assertEqual(frappe.db.get_value("Sales Invoice", out["credit_note"], "docstatus"), 1)
		self.assertGreater(cint(out["points_shortfall"]), 0)
		self.assertEqual(cint(out["points_clawed_back"]) + cint(out["points_shortfall"]), earned)
		self.assertEqual(self._balance(), 0)

	def test_b3_an_ordinary_return_still_goes_through_erpnexts_own_path(self):
		si = self._sell(60)
		out = returns.return_items(si.name, [{"item_code": ITEM, "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		self.assertFalse(out.get("points_settled_manually"))
		self.assertEqual(frappe.db.get_value("Sales Invoice", out["credit_note"], "loyalty_program"), self.program)
		self.assertEqual(cint(rewards.points_balance(self.customer, self.program)), 0)


# =================================================================================================
# Salon
# =================================================================================================
class TestSalonQAV08(QABase):
	def test_c1_a_bare_six_digit_number_is_a_client_number(self):
		self.assertEqual(coerce_client_number("123456"), "MC123456")
		self.assertEqual(coerce_client_number("MC123456"), "MC123456")
		self.assertEqual(coerce_client_number("mc123456"), "MC123456")
		# seven digits is a phone number, not a client number
		self.assertIsNone(coerce_client_number("1234567"))
		self.assertIsNone(coerce_client_number("12345"))
		self.assertIsNone(coerce_client_number(""))

	def test_c1_the_salon_identifies_a_client_from_the_digits_on_their_card(self):
		customer = frappe.db.get_value("Customer", {"maison_client_number": ("is", "set"), "disabled": 0}, "name")
		self.assertTrue(customer, "the demo seed should hand out client numbers")
		number = frappe.db.get_value("Customer", customer, "maison_client_number")
		self.assertEqual(salon._resolve_code(number), customer)
		self.assertEqual(salon._resolve_code(number[2:]), customer)  # the keypad can only type digits

	def test_c2_the_cloudchaserz_seed_has_a_salon_playlist_step(self):
		if not frappe.db.exists("DocType", "AWANZ Salon Playlist"):
			self.skipTest("salon not installed")
		from maison_pos.setup.cloudchaserz import salon as cc_salon

		out = cc_salon.seed_salon()
		self.assertTrue(out.get("playlists"), out)
		self.assertTrue(frappe.db.exists("AWANZ Salon Playlist", cc_salon.GLOBAL_PLAYLIST["title"]))
		doc = frappe.get_doc("AWANZ Salon Playlist", cc_salon.GLOBAL_PLAYLIST["title"])
		self.assertTrue(doc.enabled)
		self.assertTrue(doc.welcome_line)


# =================================================================================================
# Warehouse
# =================================================================================================
class TestWarehouseQAV08(QABase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_warehouse_admin()

	def _alert(self, item: str = ITEM, qty: float = 1) -> str:
		warehouse = frappe.db.get_value("AWANZ Store", STORE, "warehouse")
		return frappe.get_doc(
			{
				"doctype": "AWANZ Stock Alert",
				"item_code": item,
				"warehouse": warehouse,
				"boutique": STORE,
				"status": "Open",
				"qty": qty,
				"reorder_level": 3,
				"reorder_qty": 5,
				"last_seen": frappe.utils.now_datetime(),
			}
		).insert(ignore_permissions=True).name

	def _request_from_alert(self) -> dict:
		alert = self._alert()
		frappe.set_user(_manager(STORE))
		out = inventory.replenish(item=ITEM, alert=alert)
		frappe.set_user("Administrator")
		return {"request": out["request"], "alert": alert}

	def test_wd1_a_request_raised_from_a_low_stock_alert_can_be_rejected(self):
		"""The alert's link to the draft Material Request used to make the whole call roll back."""
		raised = self._request_from_alert()
		req, alert = raised["request"], raised["alert"]
		self.assertEqual(frappe.db.get_value("AWANZ Stock Alert", alert, "material_request"), req["material_request"])
		frappe.set_user(WH_ADMIN)
		out = shipping.reject(req["name"], "Not stocked at HQ")
		frappe.set_user("Administrator")
		self.assertEqual(out["request"]["status"], "Rejected")
		self.assertFalse(frappe.db.exists("Material Request", req["material_request"]))
		self.assertIsNone(frappe.db.get_value("AWANZ Stock Alert", alert, "material_request"))

	def test_wd2_the_server_reports_the_age_of_a_request(self):
		"""The desk used to age a request from a zone-less string parsed in the browser's zone."""
		req = self._request_from_alert()["request"]
		self.assertIn("age_seconds", req)
		self.assertGreaterEqual(req["age_seconds"], 0)
		self.assertLess(req["age_seconds"], 300)
		frappe.set_user(WH_ADMIN)
		wall = shipping.wall()
		frappe.set_user("Administrator")
		card = next(c for c in wall["columns"]["pending_approval"] if c["name"] == req["name"])
		self.assertLess(card["age_seconds"], 300)

	def test_wd3_the_digest_degrades_when_the_site_cannot_send_email(self):
		self._alert()
		with patch("maison_pos.api.inventory._has_outgoing_email", return_value=False):
			out = inventory.low_stock_digest()
		self.assertEqual(out["sent"], 0)
		self.assertEqual(out["skipped"], "no outgoing email account")

	def test_wd3_one_failing_recipient_does_not_kill_the_other_digests(self):
		self._alert()
		calls: list[str] = []

		def flaky(recipients, rows, subject, *args, **kwargs):
			calls.append(subject)
			if len(calls) == 1:
				raise frappe.OutgoingEmailError("Please setup default outgoing Email Account")

		with patch("maison_pos.api.inventory._has_outgoing_email", return_value=True), patch("maison_pos.api.inventory._send_digest", side_effect=flaky):
			out = inventory.low_stock_digest()
		self.assertGreaterEqual(len(calls), 2, "the store digests must still be attempted")
		self.assertIn("failed", out)
		self.assertGreater(out["sent"], 0)

	def test_wd4_a_second_label_purchase_is_refused_unless_it_is_explicit(self):
		stock_main_warehouse(ITEM, 20, _source_warehouse(exclude=frappe.db.get_value("AWANZ Store", STORE, "warehouse")))
		frappe.set_user(_manager(STORE))
		req = inventory.replenish(STORE, lines=[{"item_code": ITEM, "qty": 2}])["request"]
		frappe.set_user(WH_ADMIN)
		sh = shipping.approve(req["name"])["shipment"]
		shipping.pack(sh["name"], parcels=[{"length": 40, "width": 30, "height": 25, "weight": 1.2}])
		quote = shipping.rates(sh["name"])
		first = shipping.buy(sh["name"], quote["rates"][0]["provider_rate_id"])
		self.assertTrue(first["tracking_no"])
		with self.assertRaises(frappe.ValidationError) as caught:
			shipping.buy(sh["name"], quote["rates"][-1]["provider_rate_id"])
		self.assertIn("already has", str(caught.exception))
		self.assertEqual(frappe.db.get_value("AWANZ Shipment", sh["name"], "tracking_no"), first["tracking_no"])
		# an explicit replacement is allowed and records what it voided
		again = shipping.buy(sh["name"], quote["rates"][-1]["provider_rate_id"], replace=1)
		frappe.set_user("Administrator")
		self.assertNotEqual(again["tracking_no"], first["tracking_no"])
		self.assertEqual(again["voided_label"]["tracking_no"], first["tracking_no"])
		self.assertIn(first["tracking_no"], frappe.db.get_value("AWANZ Shipment", sh["name"], "notes") or "")

	def test_wd5_the_cycle_count_draft_belongs_to_the_counter(self):
		warehouse = frappe.db.get_value("AWANZ Store", STORE, "warehouse")
		ensure_stock(ITEM, STORE, 5)
		on_hand = flt(frappe.db.get_value("Bin", {"item_code": ITEM, "warehouse": warehouse}, "actual_qty"))
		manager = _manager(STORE)
		frappe.set_user(manager)
		out = inventory.submit_cycle_count(STORE, qty={ITEM: on_hand - 1})
		frappe.set_user("Administrator")
		self.assertTrue(out["stock_reconciliation"], out)
		sr = frappe.get_doc("Stock Reconciliation", out["stock_reconciliation"])
		self.assertEqual(sr.owner, manager)
		self.assertTrue(
			frappe.db.exists("Comment", {"reference_doctype": "Stock Reconciliation", "reference_name": sr.name, "content": ("like", f"%{manager}%")}),
			"the reviewing manager should see who counted",
		)

	def test_wd6_first_seen_and_last_seen_reach_the_client(self):
		"""`frappe.get_all` drops every field whose name contains `_seen` (an optional column)."""
		name = self._alert()
		frappe.set_user(_manager(STORE))
		rows = inventory.alerts(STORE)["alerts"]
		frappe.set_user("Administrator")
		row = next(r for r in rows if r["name"] == name)
		self.assertIsNotNone(row.get("first_seen"))
		self.assertIsNotNone(row.get("last_seen"))
		# and the plain framework call still does not — this is why the query builder is used
		dropped = frappe.get_all("AWANZ Stock Alert", filters={"name": name}, fields=["name", "first_seen"])
		self.assertNotIn("first_seen", dropped[0])

	def test_wn1_cancelling_a_shipment_puts_its_request_back_on_the_wall(self):
		stock_main_warehouse(ITEM, 20, _source_warehouse(exclude=frappe.db.get_value("AWANZ Store", STORE, "warehouse")))
		frappe.set_user(_manager(STORE))
		req = inventory.replenish(STORE, lines=[{"item_code": ITEM, "qty": 2}])["request"]
		frappe.set_user(WH_ADMIN)
		sh = shipping.approve(req["name"])["shipment"]
		self.assertEqual(frappe.db.get_value("AWANZ Replenishment Request", req["name"], "status"), "Approved")
		out = shipping.mark(sh["name"], "Cancelled", reason="Damaged in the aisle")
		frappe.set_user("Administrator")
		self.assertEqual(out["status"], "Cancelled")
		self.assertEqual(out["request_reopened"], req["name"])
		row = frappe.db.get_value("AWANZ Replenishment Request", req["name"], ["status", "shipment", "material_request"], as_dict=True)
		self.assertEqual(row.status, "Pending Approval")
		self.assertIsNone(row.shipment)
		if req["material_request"] and frappe.db.exists("Material Request", req["material_request"]):
			self.assertEqual(frappe.db.get_value("Material Request", req["material_request"], "docstatus"), 2)
		notes = frappe.get_all("Notification Log", filters={"document_name": req["name"]}, pluck="subject")
		self.assertTrue(any("cancelled" in (n or "").lower() for n in notes), notes)

	def test_wn2_every_leg_of_a_multi_leg_receipt_is_linked(self):
		stock_main_warehouse(ITEM, 20, _source_warehouse(exclude=frappe.db.get_value("AWANZ Store", STORE, "warehouse")))
		frappe.set_user(_manager(STORE))
		req = inventory.replenish(STORE, lines=[{"item_code": ITEM, "qty": 4}])["request"]
		frappe.set_user(WH_ADMIN)
		sh = shipping.approve(req["name"])["shipment"]
		shipping.pack(sh["name"], parcels=[{"length": 40, "width": 30, "height": 25, "weight": 1.2}])
		shipping.ship(sh["name"])
		frappe.set_user(_manager(STORE))
		partial = inventory.receive_shipment(sh["name"], lines=[{"item_code": ITEM, "qty": 2}], final=0)
		final = inventory.receive_shipment(sh["name"], lines=[{"item_code": ITEM, "qty": 2}], final=1)
		frappe.set_user("Administrator")
		self.assertEqual(len(final["receipt_entries"]), 2, final["receipt_entries"])
		self.assertIn(partial["stock_entry_receive"], final["receipt_entries"])
		self.assertIn(final["stock_entry_receive"], final["receipt_entries"])
		# the Link field still holds the first leg, as every existing caller expects
		self.assertEqual(frappe.db.get_value("AWANZ Shipment", sh["name"], "stock_entry_receive"), partial["stock_entry_receive"])

	def test_wn4_a_label_bought_seconds_ago_is_not_already_in_transit(self):
		"""The simulated tracker ran on UTC while `shipped_at` is site-local, so it ran ahead."""
		from maison_pos.shipping.providers.simulated import SimulatedProvider

		tracking = SimulatedProvider().track("9400123456789012345678", "USPS", shipped_at=frappe.utils.now_datetime(), days=3)
		self.assertEqual(tracking.status, "PRE_TRANSIT")
		self.assertEqual(len(tracking.events), 1)
		# ... and three hours later it has been accepted
		later = SimulatedProvider().track("9400123456789012345678", "USPS", shipped_at=frappe.utils.add_to_date(frappe.utils.now_datetime(), hours=-3), days=3)
		self.assertEqual(later.status, "TRANSIT")


# =================================================================================================
# Dashboard
# =================================================================================================
class TestDashboardQAV08(QABase):
	def test_d2_avg_ticket_vs_boutique_compares_like_with_like(self):
		"""The associate's average was gross, the store's was net of returns: every ratio +5 %."""
		ensure_stock(ITEM, NYC, 20)
		associate = frappe.db.get_value("AWANZ Associate", {"boutique": NYC, "role": "Associate", "enabled": 1}, "name")
		sold = sales.submit_batch([pos_invoice(boutique=NYC, items=[{"item_code": ITEM, "qty": 1, "rate": 100}], payments=[{"mode_of_payment": "Cash", "amount": 108.88}], associate=associate)])["results"][0]
		self.assertEqual(sold["status"], "ok", sold)
		returns.return_items(sold["invoice_name"], [{"item_code": ITEM, "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		from_date = str(add_days(nowdate(), -1))
		rows = hr.employee_performance(boutique=NYC, from_date=from_date, to_date=nowdate())
		row = next((r for r in rows if r["associate"] == associate), None)
		self.assertTrue(row, rows)
		# recompute the store's average on the same basis the associate's uses: sales only
		invoices = frappe.get_all(
			"Sales Invoice",
			filters={"docstatus": 1, "is_pos": 1, "maison_boutique": NYC, "posting_date": ("between", (from_date, nowdate())), "is_return": 0},
			fields=["base_net_total"],
		)
		expected = sum(flt(i.base_net_total) for i in invoices) / len(invoices)
		self.assertAlmostEqual(row["boutique_avg_ticket"], round(expected, 2), places=2)
		self.assertAlmostEqual(row["avg_ticket_vs_boutique"], round(row["avg_ticket"] / row["boutique_avg_ticket"], 3), places=3)
		self.assertEqual(row["avg_ticket_basis"], "sale (net of tax, returns excluded)")

	def test_d3_the_heatmap_never_moves_a_sale_into_a_different_hour(self):
		from maison_pos.awanz_pos.report.awanz_hourly_sales_heatmap import awanz_hourly_sales_heatmap as heatmap

		ensure_stock(ITEM, NYC, 20)
		sold = sales.submit_batch([pos_invoice(boutique=NYC, items=[{"item_code": ITEM, "qty": 1, "rate": 50}], payments=[{"mode_of_payment": "Cash", "amount": 54.44}])])["results"][0]
		frappe.db.set_value("Sales Invoice", sold["invoice_name"], "posting_time", "04:36:00", update_modified=False)
		columns, data = heatmap.execute({"from_date": nowdate(), "to_date": nowdate(), "boutique": NYC})[:2]
		fieldnames = {c["fieldname"] for c in columns}
		self.assertIn("h04", fieldnames)  # its own column, not folded into 08:00
		row = next(r for r in data if r["boutique"] == NYC)
		self.assertGreater(row["h04"], 0)
		self.assertEqual(row.get("h08", 0), 0)

	def test_d4_avg_ticket_is_the_average_sale(self):
		"""Net-of-returns over a sales-only count is not an average of anything."""
		ensure_stock(ITEM, NYC, 20)
		first = sales.submit_batch([pos_invoice(boutique=NYC, items=[{"item_code": ITEM, "qty": 1, "rate": 100}], payments=[{"mode_of_payment": "Cash", "amount": 108.88}])])["results"][0]
		sales.submit_batch([pos_invoice(boutique=NYC, items=[{"item_code": ITEM, "qty": 1, "rate": 50}], payments=[{"mode_of_payment": "Cash", "amount": 54.44}])])
		returns.return_items(first["invoice_name"], [{"item_code": ITEM, "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		summary = dashboard_api.live_summary(nocache=1)
		row = next(r for r in summary["by_boutique"] if r["boutique"] == NYC)
		self.assertEqual(row["invoices"], 2)
		self.assertAlmostEqual(row["gross"], row["net"] + row["returns_value"], places=2)
		self.assertAlmostEqual(row["avg_ticket"], row["gross"] / 2, places=2)
		# the old definition is still available, under a name that says what it is
		self.assertAlmostEqual(row["net_per_ticket"], row["net"] / 2, places=2)
		self.assertGreater(row["avg_ticket"], row["net_per_ticket"])

	def test_d12_non_card_tender_is_not_reported_as_card(self):
		ensure_stock(ITEM, NYC, 20)
		mop = "Exchange Credit"
		from maison_pos.api.returns import ensure_exchange_mode_of_payment

		ensure_exchange_mode_of_payment(frappe.db.get_value("AWANZ Store", NYC, "company"))
		payload = pos_invoice(boutique=NYC, items=[{"item_code": ITEM, "qty": 1, "rate": 40}], payments=[{"mode_of_payment": mop, "amount": 43.55}])
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		summary = dashboard_api.live_summary(nocache=1)
		row = next(r for r in summary["by_boutique"] if r["boutique"] == NYC)
		self.assertAlmostEqual(row["other_tender"], 43.55, places=2)
		self.assertAlmostEqual(row["card"], 0.0, places=2)
		self.assertAlmostEqual(summary["totals"]["other_tender"], 43.55, places=2)

	def test_d5_the_tier_chips_come_from_the_loyalty_programme(self):
		tiers = dashboard_api.loyalty_tiers()
		self.assertTrue(tiers, "the demo loyalty programme should define at least one tier")
		expected = {r.tier_name for r in frappe.get_all("Loyalty Program Collection", fields=["tier_name"])}
		self.assertEqual(set(tiers), expected)
		overview = dashboard_api.clients_overview(limit=1)
		self.assertEqual(overview["available_tiers"], tiers)

	def test_d6_every_listed_report_can_be_run_and_exported(self):
		names = {r["name"] for r in reports_api.REPORTS}
		for missing in ("AWANZ Commission Statement", "AWANZ Promotion Performance", "AWANZ Campaign Performance"):
			self.assertIn(missing, names)
		listed = {r["name"] for r in reports_api.list_reports()["reports"]}
		self.assertEqual(listed, names)
		for name in ("AWANZ Commission Statement", "AWANZ Promotion Performance", "AWANZ Campaign Performance"):
			if not frappe.db.exists("Report", name):
				continue
			out = reports_api.run(name, filters={"from_date": nowdate(), "to_date": nowdate()})
			self.assertEqual(out["report"], name)
			self.assertIsInstance(out["rows"], list)

	def test_d7_net_sales_means_the_same_thing_on_both_tabs(self):
		ensure_stock(ITEM, NYC, 20)
		sales.submit_batch([pos_invoice(boutique=NYC, items=[{"item_code": ITEM, "qty": 1, "rate": 100}], payments=[{"mode_of_payment": "Cash", "amount": 108.88}])])
		live = dashboard_api.live_summary(nocache=1)
		row = next(r for r in live["by_boutique"] if r["boutique"] == NYC)
		comparison = reports_api.period_comparison(boutique=NYC)
		today = comparison["periods"]["today_vs_same_weekday"]["current"]
		self.assertAlmostEqual(today["net"], row["net"], places=2)
		# the pre-tax figure is still reported, under its own name
		self.assertLess(today["net_of_tax"], today["net"])

	def test_d9_share_pct_reconciles_with_the_store_total_printed_beside_it(self):
		from maison_pos.insights.trends import rank_rows

		rows = [
			{"boutique": "B", "period": "7d", "item_code": "A", "net": 800.0, "units": 5},
			{"boutique": "B", "period": "7d", "item_code": "B", "net": 300.0, "units": 3},
			{"boutique": "B", "period": "7d", "item_code": "C", "net": -100.0, "units": -1},
		]
		rank_rows(rows)
		boutique_net = sum(r["net"] for r in rows)  # what `top_products.boutique_net` prints
		self.assertAlmostEqual(rows[0]["share_pct"], 800.0 / boutique_net * 100.0, places=2)
		self.assertAlmostEqual(sum(r["share_pct"] for r in rows), 100.0, places=2)

	def test_d14_the_serial_ledger_is_scoped_and_validates_its_filters(self):
		from maison_pos.awanz_pos.report.awanz_serial_ledger import awanz_serial_ledger as ledger

		with self.assertRaises(frappe.ValidationError):
			ledger.execute({"from_date": nowdate(), "to_date": add_days(nowdate(), -3)})
		manager = _manager(STORE)
		frappe.set_user(manager)
		columns, data = ledger.execute({"from_date": add_days(nowdate(), -30), "to_date": nowdate()})[:2]
		frappe.set_user("Administrator")
		self.assertTrue(columns)
		for row in data:
			if row.get("boutique"):
				self.assertEqual(row["boutique"], STORE)
