"""v0.4 B/C/I: commissions on submit / return, coupon validation, feedback privacy, profile permissions,
clock-in/out (HRMS glue), payroll export, tier progress, wishlist alerts."""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, nowdate

from maison_pos.api import crm, feedback, hr, promotions, sales
from maison_pos.tests.helpers import ensure_demo_data, first_serial, pos_invoice

NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_ASSOCIATE_2 = "nyc.5av.a2@maison.example"
NYC_MANAGER = "nyc.5av.manager@maison.example"
CHI_ASSOCIATE = "chi.oak.a1@maison.example"
HQ = "hq@maison.example"


def _customer(name: str) -> str:
	return frappe.db.get_value("Customer", {"customer_name": name}, "name")


def _ensure_demo_data_tolerant() -> None:
	"""Seed the demo data; the other v0.4 seeds (webshop visuals etc.) are not needed here and must not block us."""
	try:
		import maison_pos.setup.demo_v04_webshop as webshop_seed

		original = webshop_seed.seed_webshop

		def tolerant(*args, **kwargs):
			frappe.db.savepoint("v04_webshop_seed")
			try:
				return original(*args, **kwargs)
			except Exception:
				frappe.db.rollback(save_point="v04_webshop_seed")
				frappe.clear_messages()
				return {"skipped": True, "reason": "webshop seed failed in test db"}

		webshop_seed.seed_webshop = tolerant
	except ImportError:
		pass
	ensure_demo_data()


class V04Base(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		_ensure_demo_data_tolerant()
		frappe.flags.mute_emails = True

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v04_test")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="v04_test")

	def _submit(self, **kw):
		result = sales.submit_batch([pos_invoice(**kw)])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		return frappe.get_doc("Sales Invoice", result["invoice_name"])


# ---------------------------------------------------------------------------
# C — commissions
# ---------------------------------------------------------------------------
class TestCommissions(V04Base):
	def test_entries_created_on_submit_with_best_rule(self):
		# AC-012 (Accessories) → base 2 %; NYC associate bridal band BR-006 → "NYC associates bridal push 3.5%"
		si = self._submit(boutique="NYC-5AV", items=[{"item_code": "AC-012", "qty": 2, "rate": 160}, {"item_code": "BR-006", "qty": 1, "rate": 1950}])
		rows = frappe.get_all("AWANZ Commission Entry", filters={"sales_invoice": si.name}, fields=["item_code", "rate_percent", "commission_amount", "rule", "associate", "employee", "is_reversal"])
		by_item = {r.item_code: r for r in rows}
		self.assertEqual(set(by_item), {"AC-012", "BR-006"})
		self.assertEqual(by_item["AC-012"].rate_percent, 2.0)
		self.assertAlmostEqual(by_item["AC-012"].commission_amount, 320 * 0.02, places=2)
		self.assertEqual(by_item["BR-006"].rule, "NYC associates bridal push 3.5%")
		self.assertAlmostEqual(by_item["BR-006"].commission_amount, 1950 * 0.035, places=2)
		self.assertEqual(by_item["AC-012"].associate, si.maison_associate)
		self.assertTrue(by_item["AC-012"].employee, "employee should be linked from the seed")
		self.assertFalse(by_item["AC-012"].is_reversal)
		# idempotent
		self.assertEqual(hr.create_commission_entries(si), [])

	def test_manager_role_does_not_get_associate_only_rule(self):
		si = self._submit(boutique="NYC-5AV", associate=NYC_MANAGER, items=[{"item_code": "BR-006", "qty": 1, "rate": 1950}])
		row = frappe.get_value("AWANZ Commission Entry", {"sales_invoice": si.name}, ["rule", "rate_percent"], as_dict=True)
		self.assertEqual(row.rule, "Bridal 2.5%")

	def test_return_reverses_commission(self):
		serial = first_serial("TP-001", "NYC-5AV")
		si = self._submit(boutique="NYC-5AV", items=[{"item_code": "TP-001", "qty": 1, "rate": 6900, "serial_no": serial}])
		original = frappe.get_value("AWANZ Commission Entry", {"sales_invoice": si.name}, ["commission_amount", "associate"], as_dict=True)
		self.assertAlmostEqual(original.commission_amount, 6900 * 0.03, places=2)
		frappe.set_user(NYC_MANAGER)
		cn = sales.void(si.name, "test return")["credit_note"]
		frappe.set_user("Administrator")
		rev = frappe.get_value("AWANZ Commission Entry", {"sales_invoice": cn}, ["commission_amount", "is_reversal", "associate"], as_dict=True)
		self.assertTrue(rev.is_reversal)
		self.assertAlmostEqual(rev.commission_amount, -original.commission_amount, places=2)
		# the reversal hits the original seller, not the manager who voided
		self.assertEqual(rev.associate, original.associate)
		stmt = hr.commission_statement(nowdate(), nowdate(), boutique="NYC-5AV", associate=original.associate)
		net = sum(e["commission_amount"] for e in stmt["entries"] if e["sales_invoice"] in (si.name, cn))
		self.assertAlmostEqual(net, 0.0, places=2)

	def test_cancel_creates_mirror_reversal(self):
		si = self._submit(boutique="NYC-5AV", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		si.reload()
		si.cancel()
		rows = frappe.get_all("AWANZ Commission Entry", filters={"sales_invoice": si.name}, fields=["commission_amount", "is_reversal", "reversal_of"])
		self.assertEqual(len(rows), 2)
		self.assertAlmostEqual(sum(r.commission_amount for r in rows), 0.0, places=2)
		self.assertTrue(any(r.reversal_of for r in rows))

	def test_statement_scoping(self):
		self._submit(boutique="NYC-5AV", associate=NYC_ASSOCIATE, items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		self._submit(boutique="CHI-OAK", associate=CHI_ASSOCIATE, items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		frappe.set_user(NYC_ASSOCIATE)
		stmt = hr.commission_statement(nowdate(), nowdate())
		self.assertTrue(stmt["entries"])
		self.assertEqual({e["associate"] for e in stmt["entries"]}, {NYC_ASSOCIATE})
		frappe.set_user(NYC_MANAGER)
		stmt = hr.commission_statement(nowdate(), nowdate())
		self.assertEqual({e["boutique"] for e in stmt["entries"]}, {"NYC-5AV"})
		self.assertRaises(frappe.PermissionError, hr.commission_statement, nowdate(), nowdate(), boutique="CHI-OAK")
		frappe.set_user(HQ)
		stmt = hr.commission_statement(nowdate(), nowdate())
		self.assertTrue({"NYC-5AV", "CHI-OAK"} <= {e["boutique"] for e in stmt["entries"]})

	def test_payroll_export_formats_and_marking(self):
		self._submit(boutique="NYC-5AV", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		frappe.set_user(NYC_ASSOCIATE)
		self.assertRaises(frappe.PermissionError, hr.payroll_export, nowdate(), nowdate(), "gusto")
		frappe.set_user(HQ)
		for fmt, header in (("gusto", "Last name,First name,Employee ID,Commission"), ("adp", "Co Code,Batch ID,File #"), ("quickbooks", "Employee,Pay Item,Amount")):
			res = hr.payroll_export(nowdate(), nowdate(), fmt)
			self.assertTrue(res["csv"].startswith(header), res["csv"][:80])
			self.assertTrue(res["rows"])
			self.assertGreater(res["total"], 0)
		self.assertRaises(frappe.ValidationError, hr.payroll_export, nowdate(), nowdate(), "paychex")
		res = hr.payroll_export(nowdate(), nowdate(), "gusto", mark_exported=1)
		self.assertGreater(res["marked"], 0)
		self.assertFalse(hr.build_payroll_rows(nowdate(), nowdate()), "exported entries must not be exported twice")

	def test_hrms_additional_salary_export(self):
		if not hr.hrms_installed():
			self.skipTest("hrms not installed")
		self._submit(boutique="NYC-5AV", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		frappe.set_user(HQ)
		res = hr.payroll_export(nowdate(), nowdate(), "hrms", boutique="NYC-5AV")
		self.assertTrue(res["rows"])
		if not res["additional_salaries"]:
			# no Salary Structure Assignment on this site → rows are reported as skipped, never silently lost
			self.assertTrue(all(r["skipped"] for r in res["rows"]), res["rows"])
			self.skipTest("no salary structure assigned to the demo employees")
		doc = frappe.get_doc("Additional Salary", res["additional_salaries"][0])
		self.assertEqual(doc.salary_component, hr.COMMISSION_COMPONENT)
		self.assertGreater(doc.amount, 0)


# ---------------------------------------------------------------------------
# C — clock-in / out
# ---------------------------------------------------------------------------
class TestShifts(V04Base):
	def test_clock_in_out_and_hrms_checkins(self):
		frappe.set_user(NYC_ASSOCIATE)
		res = hr.clock_in(NYC_ASSOCIATE, "NYC-5AV", device_id="IPAD-1")
		self.assertTrue(res["on_shift"] and res["created"])
		again = hr.clock_in(NYC_ASSOCIATE, "NYC-5AV")
		self.assertFalse(again["created"])
		self.assertEqual(again["shift"]["name"], res["shift"]["name"])
		status = hr.shift_status()
		self.assertTrue(status["on_shift"])
		if hr.hrms_installed():
			self.assertTrue(frappe.db.get_value("AWANZ Shift", res["shift"]["name"], "checkin_in"), "Employee Checkin IN expected")
		brk = hr.toggle_break(NYC_ASSOCIATE)
		self.assertEqual(brk["shift"]["status"], "On break")
		hr.toggle_break(NYC_ASSOCIATE)
		frappe.set_user(NYC_MANAGER)
		self.assertIn(NYC_ASSOCIATE, [s["associate"] for s in hr.on_shift("NYC-5AV")])
		frappe.set_user(NYC_ASSOCIATE)
		out = hr.clock_out(NYC_ASSOCIATE)
		self.assertTrue(out["closed"])
		self.assertEqual(frappe.db.get_value("AWANZ Shift", res["shift"]["name"], "status"), "Off shift")
		if hr.hrms_installed():
			self.assertEqual(frappe.db.count("Employee Checkin", {"employee": frappe.db.get_value("AWANZ Associate", NYC_ASSOCIATE, "employee"), "device_id": ("like", "NYC-5AV:%")}), 2)
		self.assertFalse(hr.shift_status()["on_shift"])

	def test_associate_cannot_clock_others_or_other_boutique(self):
		frappe.set_user(NYC_ASSOCIATE)
		self.assertRaises(frappe.PermissionError, hr.clock_in, NYC_ASSOCIATE_2, "NYC-5AV")
		self.assertRaises(frappe.PermissionError, hr.clock_in, NYC_ASSOCIATE, "CHI-OAK")
		self.assertRaises(frappe.PermissionError, hr.on_shift, "CHI-OAK")
		frappe.set_user(NYC_MANAGER)
		res = hr.clock_in(NYC_ASSOCIATE_2, "NYC-5AV")
		self.assertTrue(res["on_shift"])
		hr.clock_out(NYC_ASSOCIATE_2)


# ---------------------------------------------------------------------------
# I — coupons & promotions
# ---------------------------------------------------------------------------
class TestCoupons(V04Base):
	def test_validate_rules(self):
		lines = [{"item_code": "AC-012", "qty": 2, "rate": 160}, {"item_code": "BR-006", "qty": 1, "rate": 1950}]
		info = promotions.validate_coupon("welcome10", lines, "NYC-5AV")
		self.assertEqual(info["code"], "WELCOME10")
		self.assertAlmostEqual(info["discount"], (320 + 1950) * 0.10, places=2)
		self.assertAlmostEqual(sum(info["per_line"]), info["discount"], places=2)
		# scoped to Bridal, min basket 5000 → too small
		with self.assertRaises(promotions.CouponError) as ctx:
			promotions.validate_coupon("BRIDAL500", lines, "NYC-5AV")
		self.assertEqual(ctx.exception.reason, "min_basket")
		bridal = [{"item_code": "BR-008", "qty": 1, "rate": 4800}, {"item_code": "AC-012", "qty": 1, "rate": 160}]
		with self.assertRaises(promotions.CouponError) as ctx:
			promotions.validate_coupon("BRIDAL500", bridal, "NYC-5AV")
		self.assertEqual(ctx.exception.reason, "min_basket")
		bridal = [{"item_code": "BR-009", "qty": 1, "rate": 11200}, {"item_code": "AC-012", "qty": 1, "rate": 160}]
		info = promotions.validate_coupon("BRIDAL500", bridal, "NYC-5AV")
		self.assertEqual(info["discount"], 500.0)
		self.assertEqual(info["per_line"], [500.0, 0.0])  # only the bridal line
		# client-bound
		with self.assertRaises(promotions.CouponError) as ctx:
			promotions.validate_coupon("VIP-ISABELLA", lines, "NYC-5AV", customer=_customer("Mei-Lin Chen"))
		self.assertEqual(ctx.exception.reason, "wrong_customer")
		self.assertTrue(promotions.validate_coupon("VIP-ISABELLA", lines, "NYC-5AV", customer=_customer("Isabella Marchetti")))
		with self.assertRaises(promotions.CouponError) as ctx:
			promotions.validate_coupon("NOPE", lines)
		self.assertEqual(ctx.exception.reason, "unknown")
		# expired / disabled
		frappe.get_doc({"doctype": "AWANZ Coupon", "code": "old", "title": "Old", "discount_type": "Percent", "value": 5, "valid_upto": add_days(nowdate(), -1)}).insert()
		with self.assertRaises(promotions.CouponError) as ctx:
			promotions.validate_coupon("OLD", lines)
		self.assertEqual(ctx.exception.reason, "expired")
		frappe.db.set_value("AWANZ Coupon", "OLD", {"valid_upto": None, "enabled": 0})
		with self.assertRaises(promotions.CouponError) as ctx:
			promotions.validate_coupon("OLD", lines)
		self.assertEqual(ctx.exception.reason, "disabled")
		# preview endpoint never raises for a bad code
		frappe.set_user(NYC_ASSOCIATE)
		res = promotions.check_coupon("nope", lines, "NYC-5AV")
		self.assertFalse(res["valid"])
		self.assertEqual(res["reason"], "unknown")
		self.assertTrue(promotions.check_coupon("WELCOME10", lines, "NYC-5AV")["valid"])

	def test_coupon_applied_on_submit_and_single_use_exhausted(self):
		isabella = _customer("Isabella Marchetti")
		items = [{"item_code": "AC-012", "qty": 2, "rate": 160, "coupon_discount": 48.0}]
		net = 320 - 48
		total = round(net * 1.08875, 2)
		si = self._submit(boutique="NYC-5AV", customer=isabella, items=items, payments=[{"mode_of_payment": "Card", "amount": total}], coupon_code="vip-isabella")
		self.assertEqual(si.maison_coupon, "VIP-ISABELLA")
		self.assertAlmostEqual(si.maison_coupon_discount, 48.0, places=2)
		self.assertAlmostEqual(si.net_total, net, places=2)
		self.assertAlmostEqual(si.grand_total, total, places=2)
		self.assertEqual(frappe.db.get_value("AWANZ Coupon", "VIP-ISABELLA", "used_count"), 1)
		self.assertTrue(frappe.db.exists("AWANZ Coupon Redemption", {"sales_invoice": si.name}))
		# second use → structured error
		res = sales.submit_batch([pos_invoice(boutique="NYC-5AV", customer=isabella, items=items, payments=[{"mode_of_payment": "Card", "amount": total}], coupon_code="VIP-ISABELLA")])["results"][0]
		self.assertEqual(res["status"], "error")
		self.assertEqual(res["error_code"], promotions.ERR_COUPON_INVALID, res)
		self.assertEqual(res["details"]["reason"], "exhausted")
		# cancel gives the use back
		si.reload()
		si.cancel()
		self.assertEqual(frappe.db.get_value("AWANZ Coupon", "VIP-ISABELLA", "used_count"), 0)

	def test_device_mismatch_rejected(self):
		items = [{"item_code": "AC-012", "qty": 2, "rate": 160, "coupon_discount": 100.0}]
		res = sales.submit_batch([pos_invoice(boutique="NYC-5AV", items=items, payments=[{"mode_of_payment": "Cash", "amount": 400}], coupon_code="WELCOME10")])["results"][0]
		self.assertEqual(res["status"], "error")
		self.assertEqual(res["details"]["reason"], "mismatch")

	def test_active_promotions_shape(self):
		frappe.set_user(CHI_ASSOCIATE)
		res = promotions.active("CHI-OAK")
		titles = {p["title"] for p in res["promotions"]}
		self.assertIn("Accessories week −15%", titles)
		acc = next(p for p in res["promotions"] if p["title"].startswith("Accessories"))
		self.assertEqual(acc["kind"], "percent")
		self.assertEqual(acc["targets"], ["Accessories"])
		patron = next(p for p in res["promotions"] if p["title"].startswith("Patron"))
		self.assertEqual(patron["tier"], "Patron")
		self.assertRaises(frappe.PermissionError, promotions.active, "NYC-5AV")

	def test_tier_progress(self):
		mei = _customer("Mei-Lin Chen")
		frappe.set_user(CHI_ASSOCIATE)
		lp = promotions.loyalty(mei)
		self.assertEqual([t["tier"] for t in lp["tiers"]], ["Collector", "Connoisseur", "Patron"])
		self.assertIn(lp["tier"], ("Collector", "Connoisseur", "Patron"))
		self.assertTrue(0 <= lp["progress"] <= 1)
		if lp["next_tier"]:
			self.assertGreater(lp["to_next_tier"], 0)
		# override from profile wins
		frappe.set_user("Administrator")
		crm.update_profile(mei, {"vip_tier_override": "Patron"})
		self.assertEqual(promotions.tier_progress(mei)["tier"], "Patron")

	def test_birthday_bonus(self):
		mei = _customer("Mei-Lin Chen")
		frappe.db.set_single_value("AWANZ POS Settings", "birthday_bonus_points", 250)
		crm.update_profile(mei, {"birthday": "1987-08-30"})
		res = promotions.birthday_bonus("2026-08-30")
		self.assertIn(mei, res["credited"])
		self.assertEqual(frappe.db.get_value("Loyalty Point Entry", {"customer": mei, "posting_date": "2026-08-30", "purchase_amount": 0}, "loyalty_points"), 250)
		again = promotions.birthday_bonus("2026-08-30")
		self.assertNotIn(mei, again["credited"])
		frappe.db.set_single_value("AWANZ POS Settings", "birthday_bonus_points", 0)


# ---------------------------------------------------------------------------
# I — private feedback
# ---------------------------------------------------------------------------
class TestFeedbackPrivacy(V04Base):
	def test_guest_can_post_once_with_valid_token_but_never_read(self):
		si = self._submit(boutique="CHI-OAK", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		token = si.maison_receipt_token
		frappe.set_user("Guest")
		try:
			self.assertEqual(feedback.status(token), {"enabled": True, "valid": True, "submitted": False})
			res = feedback.submit(token, 2, "Felt rushed")
			self.assertTrue(res["ok"])
			self.assertNotIn("rating", res)
			self.assertNotIn("name", res)
			self.assertTrue(feedback.status(token)["submitted"])
			dup = feedback.submit(token, 5, "changed my mind")
			self.assertTrue(dup.get("duplicate"))
			# reads are role-gated
			self.assertRaises(frappe.PermissionError, feedback.list)
			self.assertRaises(frappe.PermissionError, feedback.summary)
			# the doctype has no Guest permission: desk/REST reads fail too
			self.assertFalse(frappe.has_permission("AWANZ Feedback", "read"))
			self.assertRaises(frappe.PermissionError, frappe.get_list, "AWANZ Feedback")
			# bad token / rating
			self.assertRaises(frappe.DoesNotExistError, feedback.submit, "nope-token", 5)
			self.assertEqual(feedback.status("nope-token")["valid"], False)
		finally:
			frappe.set_user("Administrator")
		row = frappe.get_doc("AWANZ Feedback", {"sales_invoice": si.name})
		self.assertEqual(row.rating, 2)  # first submission wins
		self.assertEqual(row.comment, "Felt rushed")
		self.assertEqual(row.boutique, "CHI-OAK")
		self.assertTrue(row.alerted, "rating ≤ 2 must alert")
		self.assertTrue(frappe.db.exists("Notification Log", {"document_type": "AWANZ Feedback", "document_name": row.name, "for_user": "chi.oak.manager@maison.example"}))

	def test_rating_bounds_and_disabled(self):
		si = self._submit(boutique="CHI-OAK", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		frappe.set_user("Guest")
		try:
			self.assertRaises(frappe.ValidationError, feedback.submit, si.maison_receipt_token, 0)
			self.assertRaises(frappe.ValidationError, feedback.submit, si.maison_receipt_token, 6)
		finally:
			frappe.set_user("Administrator")
		frappe.db.set_single_value("AWANZ POS Settings", "feedback_enabled", 0)
		try:
			frappe.set_user("Guest")
			self.assertEqual(feedback.status(si.maison_receipt_token)["enabled"], False)
			self.assertRaises(frappe.ValidationError, feedback.submit, si.maison_receipt_token, 4)
		finally:
			frappe.set_user("Administrator")
			frappe.db.set_single_value("AWANZ POS Settings", "feedback_enabled", 1)

	def test_manager_sees_own_boutique_only(self):
		a = self._submit(boutique="CHI-OAK", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		b = self._submit(boutique="NYC-5AV", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		frappe.set_user("Guest")
		feedback.submit(a.maison_receipt_token, 5, "great")
		feedback.submit(b.maison_receipt_token, 4, "good")
		frappe.set_user(NYC_MANAGER)
		rows = feedback.list()
		self.assertTrue(rows)
		self.assertEqual({r["boutique"] for r in rows}, {"NYC-5AV"})
		self.assertTrue(all("customer" not in r for r in rows))
		self.assertRaises(frappe.PermissionError, feedback.list, boutique="CHI-OAK")
		frappe.set_user(NYC_ASSOCIATE)
		self.assertRaises(frappe.PermissionError, feedback.list)
		frappe.set_user(HQ)
		s = feedback.summary()
		self.assertGreaterEqual(s["count"], 2)
		self.assertTrue({"CHI-OAK", "NYC-5AV"} <= {x["boutique"] for x in s["by_boutique"]})
		name = frappe.db.get_value("AWANZ Feedback", {"sales_invoice": a.name}, "name")
		self.assertEqual(feedback.respond(name, "Called the client, apologised")["status"], "Responded")


# ---------------------------------------------------------------------------
# B — client profiles
# ---------------------------------------------------------------------------
class TestClientProfile(V04Base):
	def test_profile_permissions(self):
		mei = _customer("Mei-Lin Chen")
		frappe.set_user("Guest")
		self.assertRaises(frappe.PermissionError, crm.profile, mei)
		frappe.set_user("Administrator")
		frappe.get_doc({"doctype": "User", "email": "plain.user@example.com", "first_name": "Plain", "send_welcome_email": 0}).insert(ignore_if_duplicate=True)
		frappe.set_user("plain.user@example.com")
		self.assertRaises(frappe.PermissionError, crm.profile, mei)
		self.assertRaises(frappe.PermissionError, crm.wishlist_add, mei, "AC-001")
		frappe.set_user(CHI_ASSOCIATE)
		p = crm.profile(mei)
		self.assertEqual(p["profile"]["ring_size"], "5.5")
		self.assertEqual(p["customer"]["client_number"][:2], "MC")
		self.assertTrue(p["wishlist"])
		self.assertIn("loyalty", p)
		self.assertFalse(p["can_edit_tier"])
		self.assertTrue(crm.update_profile(mei, {"ring_size": "6", "do_not_sms": 1})["profile"]["do_not_sms"])
		self.assertEqual(frappe.db.get_value("AWANZ Client Profile", mei, "ring_size"), "6")
		self.assertRaises(frappe.PermissionError, crm.update_profile, mei, {"vip_tier_override": "Patron"})
		self.assertRaises(frappe.ValidationError, crm.update_profile, mei, {"bogus": 1})
		frappe.set_user("chi.oak.manager@maison.example")
		self.assertEqual(crm.update_profile(mei, {"vip_tier_override": "Patron"})["profile"]["vip_tier_override"], "Patron")
		self.assertTrue(crm.profile(mei)["can_edit_tier"])

	def test_profile_created_on_first_access_and_contact_linked(self):
		cust = _customer("Marcus Thompson")
		self.assertFalse(frappe.db.exists("AWANZ Client Profile", cust))
		frappe.set_user(NYC_ASSOCIATE)
		p = crm.profile(cust)
		self.assertTrue(frappe.db.exists("AWANZ Client Profile", cust))
		self.assertEqual(p["wishlist"], [])
		self.assertTrue(p["crm"]["contact"], "a Contact should be linked for Frappe CRM")
		self.assertTrue(frappe.db.exists("Dynamic Link", {"parent": p["crm"]["contact"], "link_doctype": "Customer", "link_name": cust}))

	def test_wishlist_add_remove_fulfil_and_owned_pieces(self):
		cust = _customer("Jonathan Whitfield")
		frappe.set_user(NYC_ASSOCIATE)
		res = crm.wishlist_add(cust, "AC-012", "for the office")
		self.assertIn("AC-012", [w["item_code"] for w in res["wishlist"]])
		self.assertRaises(frappe.DoesNotExistError, crm.wishlist_add, cust, "NOPE-1")
		res = crm.wishlist_remove(cust, item_code="TP-001")
		self.assertNotIn("TP-001", [w["item_code"] for w in res["wishlist"]])
		serial = first_serial("TP-002", "NYC-5AV")
		rate = frappe.db.get_value("Item Price", {"item_code": "TP-002", "price_list": "Standard Selling"}, "price_list_rate")
		frappe.set_user("Administrator")
		si = self._submit(boutique="NYC-5AV", customer=cust, items=[{"item_code": "AC-012", "qty": 1, "rate": 160}, {"item_code": "TP-002", "qty": 1, "rate": rate, "serial_no": serial}])
		frappe.set_user(NYC_ASSOCIATE)
		p = crm.profile(cust)
		w = next(x for x in p["wishlist"] if x["item_code"] == "AC-012")
		self.assertEqual(w["fulfilled"], 1)
		self.assertEqual(w["fulfilled_invoice"], si.name)
		self.assertIn(serial, [o["serial_no"] for o in p["owned_pieces"]])

	def test_follow_ups_and_crm_task_mirror(self):
		cust = _customer("Amara Okonkwo")
		frappe.set_user(NYC_ASSOCIATE)
		row = crm.log_interaction(cust, "Follow-up", "Show the Solstice pendant", follow_up_date=add_days(nowdate(), 3))
		self.assertEqual(row["status"], "Open")
		self.assertEqual(row["boutique"], "NYC-5AV")
		self.assertIn(row["name"], [t["name"] for t in crm.tasks(cust)])
		self.assertIn(row["name"], [t["name"] for t in crm.tasks()])  # own assignments
		if crm.crm_installed():
			self.assertTrue(row["crm_task"])
			self.assertEqual(frappe.db.get_value("CRM Task", row["crm_task"], "status"), "Todo")
		done = crm.complete_task(row["name"])
		self.assertEqual(done["status"], "Done")
		if crm.crm_installed():
			self.assertEqual(frappe.db.get_value("CRM Task", row["crm_task"], "status"), "Done")
		self.assertNotIn(row["name"], [t["name"] for t in crm.tasks(cust)])
		self.assertRaises(frappe.ValidationError, crm.log_interaction, cust, "Telepathy", "x")
		note = crm.log_interaction(cust, "Note", "Prefers Saturday mornings")
		self.assertEqual(note["status"], "Done")
		self.assertTrue(frappe.db.exists("Comment", {"reference_doctype": "Customer", "reference_name": cust, "content": ("like", "%Saturday%")}))
		# CHI associate cannot see NYC follow-ups without naming the customer
		frappe.set_user(CHI_ASSOCIATE)
		self.assertNotIn(row["name"], [t["name"] for t in crm.tasks(include_done=1)])

	def test_wishlist_alert_on_stock_arrival(self):
		cust = _customer("Alexander Petrov")  # wishes TP-003, preferred CHI-OAK / associate
		frappe.set_user("Administrator")
		warehouse = frappe.db.get_value("AWANZ Store", "CHI-OAK", "warehouse")
		# other suites may have received TP-003 already (Stock Entry hook) → reset the cooldown
		for row in frappe.get_all("AWANZ Wishlist Item", filters={"parent": cust, "item_code": "TP-003"}, pluck="name"):
			frappe.db.set_value("AWANZ Wishlist Item", row, "alerted_on", None, update_modified=False)
		alerts = crm.wishlist_matches_for("TP-003", warehouse, "TP-003-NEW-001")
		self.assertTrue(any(a["customer"] == cust for a in alerts))
		alert = next(a for a in alerts if a["customer"] == cust)
		assoc = frappe.db.get_value("AWANZ Client Profile", cust, "preferred_associate")
		self.assertEqual(alert["users"], [assoc])
		self.assertTrue(frappe.db.exists("Notification Log", {"for_user": assoc, "document_name": cust}))
		self.assertEqual(frappe.db.get_value("AWANZ Client Interaction", alert["interaction"], "type"), "Wishlist match")
		# cooldown: no second alert within 30 days
		self.assertFalse(any(a["customer"] == cust for a in crm.wishlist_matches_for("TP-003", warehouse)))
		frappe.set_user("chi.oak.manager@maison.example")
		self.assertGreaterEqual(crm.wishlist_matches("CHI-OAK")["count"], 1)

	def test_upcoming_dates(self):
		frappe.set_user(HQ)
		rows = crm.upcoming_dates(days=400)
		self.assertTrue(any(r["kind"] == "birthday" for r in rows))
		self.assertTrue(all(0 <= r["in_days"] <= 400 for r in rows))
		frappe.set_user(CHI_ASSOCIATE)
		self.assertTrue(all(r["preferred_boutique"] == "CHI-OAK" for r in crm.upcoming_dates(days=400)))
