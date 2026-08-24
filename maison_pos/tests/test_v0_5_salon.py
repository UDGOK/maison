"""v0.5 K — AWANZ Salon: pairing (code TTL, single use), token auth, masking / sanitising,
identify / sign-up attaching the client, consent hand-off, questions → CRM timeline, feedback →
AWANZ Feedback, preferences → Client Profile, unpair / expiry, Guest list scoping."""

from __future__ import annotations

import json

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from maison_pos.api import salon
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice

CHI_ASSOCIATE = "chi.oak.a1@maison.example"
NYC_ASSOCIATE = "nyc.5av.a1@maison.example"


class SalonBase(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		frappe.flags.mute_emails = True

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("salon_test")
		frappe.local.request_ip = None

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="salon_test")

	# helpers -------------------------------------------------------------
	def pair(self, boutique: str = "CHI-OAK", pos_device: str = "TEST-POS", user: str = CHI_ASSOCIATE):
		frappe.set_user(user)
		code = salon.pairing_code(boutique, pos_device)["code"]
		frappe.set_user("Guest")
		session = salon.pair(code, "TEST-SALON")
		frappe.set_user("Administrator")
		return session

	def customer(self, name: str) -> str:
		return frappe.db.get_value("Customer", {"customer_name": name}, "name")


class TestMasking(SalonBase):
	def test_mask_phone_email_client_number(self):
		self.assertEqual(salon.mask_phone("+1 312 555 0105"), "•••• 0105")
		self.assertEqual(salon.mask_phone("123"), "••••")
		self.assertIsNone(salon.mask_phone(""))
		self.assertEqual(salon.mask_email("mei-lin.chen@example.com"), "m•••@example.com")
		self.assertIsNone(salon.mask_email("not-an-email"))
		self.assertEqual(salon.mask_client_number("MC595284"), "MC •• 284")
		self.assertEqual(salon.first_name("Mei-Lin Chen"), "Mei-Lin")

	def test_sanitize_state_strips_private_keys_recursively(self):
		state = salon.sanitize_state(
			{"client": {"customer_name": "Mei-Lin Chen", "mobile_no": "+1 312 555 0105", "email_id": "x@y.z", "client_number": "MC595284"}, "lines": [{"item_name": "Ring", "phone": "leak"}]}
		)
		self.assertNotIn("mobile_no", state["client"])
		self.assertNotIn("email_id", state["client"])
		self.assertEqual(state["client"]["first_name"], "Mei-Lin")
		self.assertEqual(state["client"]["client_number_masked"], "MC •• 284")
		self.assertNotIn("client_number", state["client"])
		self.assertNotIn("phone", state["lines"][0])

	def test_client_summary_never_carries_raw_contact(self):
		s = salon.client_summary(self.customer("Mei-Lin Chen"))
		self.assertEqual(s["first_name"], "Mei-Lin")
		self.assertEqual(s["phone_masked"], "•••• 0105")
		self.assertTrue(s["email_masked"].startswith("m•••@"))
		for key in ("mobile_no", "email_id", "phone", "email"):
			self.assertNotIn(key, s)


class TestPairing(SalonBase):
	def test_pairing_code_is_six_digits_with_ttl_and_single_use(self):
		frappe.set_user(CHI_ASSOCIATE)
		pc = salon.pairing_code("CHI-OAK", "TEST-POS")
		self.assertRegex(pc["code"], r"^\d{6}$")
		self.assertEqual(pc["ttl_seconds"], 600)
		self.assertEqual(pc["qr"], f"MS:{pc['code']}")
		frappe.set_user("Guest")
		session = salon.pair(pc["qr"], "TEST-SALON")
		self.assertEqual(session["status"], "Paired")
		self.assertEqual(len(session["token"]), 32)
		self.assertEqual(session["boutique_name"], "AWANZ Oak Street")
		self.assertEqual(session["state"]["screen"], "idle")
		self.assertTrue(session["playlist"], "demo playlist should be delivered at pairing")
		self.assertIn("consent_text", session["settings"])
		# second use of the same code fails
		with self.assertRaises(frappe.ValidationError):
			salon.pair(pc["code"], "TEST-SALON-2")

	def test_expired_or_unknown_code_is_refused(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			salon.pair("000000")
		with self.assertRaises(frappe.ValidationError):
			salon.pair("12")

	def test_associate_cannot_issue_code_for_another_boutique(self):
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(frappe.PermissionError):
			salon.pairing_code("CHI-OAK", "TEST-POS")

	def test_new_pairing_ends_previous_session_of_the_pos(self):
		first = self.pair()
		second = self.pair()
		self.assertEqual(frappe.db.get_value(salon.DOCTYPE, first["token"], "status"), "Unpaired")
		self.assertEqual(frappe.db.get_value(salon.DOCTYPE, second["token"], "status"), "Paired")
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			salon.state(first["token"])

	def test_session_expires_after_12_hours(self):
		s = self.pair()
		self.assertAlmostEqual((frappe.utils.get_datetime(s["expires_at"]) - frappe.utils.get_datetime(s["paired_at"])).total_seconds() / 3600, 12, places=1)
		frappe.db.set_value(salon.DOCTYPE, s["token"], "expires_at", add_to_date(now_datetime(), minutes=-1), update_modified=False)
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			salon.state(s["token"])
		self.assertEqual(frappe.db.get_value(salon.DOCTYPE, s["token"], "status"), "Expired")
		frappe.set_user("Administrator")
		frappe.db.set_value(salon.DOCTYPE, s["token"], {"status": "Paired", "expires_at": add_to_date(now_datetime(), minutes=-1)}, update_modified=False)
		self.assertGreaterEqual(salon.expire_sessions()["expired"], 1)

	def test_guest_cannot_list_sessions_but_can_read_its_own(self):
		s = self.pair()
		frappe.set_user("Guest")
		self.assertEqual(frappe.get_list(salon.DOCTYPE, pluck="name"), [])
		self.assertTrue(frappe.has_permission(salon.DOCTYPE, "read", doc=s["token"]))
		self.assertFalse(frappe.has_permission(salon.DOCTYPE, "write", doc=s["token"]))

	def test_pos_status_and_unpair(self):
		s = self.pair()
		frappe.set_user(CHI_ASSOCIATE)
		st = salon.pos_status("CHI-OAK", "TEST-POS")
		self.assertTrue(st["paired"])
		self.assertEqual(st["session"]["token"], s["token"])
		self.assertTrue(salon.unpair_pos(session=s["token"])["unpaired"])
		self.assertFalse(salon.pos_status("CHI-OAK", "TEST-POS")["paired"])
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			salon.state(s["token"])


class TestMirror(SalonBase):
	def test_publish_sanitises_and_attaches_client_summary(self):
		s = self.pair()
		mei = self.customer("Mei-Lin Chen")
		frappe.set_user(CHI_ASSOCIATE)
		r = salon.publish(s["token"], "basket", {"customer": mei, "lines": [{"item_code": "TP-001", "item_name": "Meridian", "qty": 1, "rate": 6900}], "totals": {"grand_total": 7607.25}, "mobile_no": "leak", "email_id": "leak@x.y"})
		self.assertEqual(r["screen"], "basket")
		frappe.set_user("Guest")
		st = salon.state(s["token"], since=0)
		self.assertTrue(st["changed"])
		state = st["state"]
		self.assertEqual(state["screen"], "basket")
		self.assertEqual(state["client"]["first_name"], "Mei-Lin")
		self.assertEqual(state["client"]["phone_masked"], "•••• 0105")
		self.assertNotIn("mobile_no", state)
		self.assertNotIn("email_id", state)
		self.assertNotIn("customer", state)  # raw customer id never leaves via state
		self.assertEqual(state["lines"][0]["item_code"], "TP-001")
		# unchanged poll is cheap
		again = salon.state(s["token"], since=st["seq"])
		self.assertFalse(again["changed"])
		self.assertNotIn("state", again)

	def test_publish_rejects_unknown_screen_and_foreign_boutique(self):
		s = self.pair()
		frappe.set_user(CHI_ASSOCIATE)
		with self.assertRaises(frappe.ValidationError):
			salon.publish(s["token"], "bogus", {})
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(frappe.PermissionError):
			salon.publish(s["token"], "idle", {})

	def test_idle_clears_customer_and_invoice(self):
		s = self.pair()
		frappe.set_user(CHI_ASSOCIATE)
		salon.publish(s["token"], "client", {"customer": self.customer("Mei-Lin Chen")})
		self.assertTrue(frappe.db.get_value(salon.DOCTYPE, s["token"], "customer"))
		salon.publish(s["token"], "idle", {})
		self.assertFalse(frappe.db.get_value(salon.DOCTYPE, s["token"], "customer"))


class TestIdentifyAndSignup(SalonBase):
	def test_identify_by_phone_email_client_number_and_unknown(self):
		s = self.pair()
		mei = self.customer("Mei-Lin Chen")
		number = frappe.db.get_value("Customer", mei, "maison_client_number")
		frappe.set_user("Guest")
		r = salon.identify(s["token"], "312 555 0105")
		self.assertTrue(r["found"])
		self.assertEqual(r["client"]["customer"], mei)
		self.assertEqual(r["client"]["first_name"], "Mei-Lin")
		self.assertTrue(salon.identify(s["token"], number)["found"])
		self.assertTrue(salon.identify(s["token"], f"MC:{mei}")["found"])
		self.assertEqual(salon.identify(s["token"], "+1 999 000 0000"), {"found": False})
		# the POS receives the attach message
		frappe.set_user(CHI_ASSOCIATE)
		poll = salon.pos_poll(s["token"], since=0)
		kinds = [m["type"] for m in poll["messages"]]
		self.assertIn("client_attached", kinds)
		self.assertEqual(poll["messages"][0]["customer"], mei)
		self.assertEqual(poll["messages"][0]["how"], "identify")
		# messages are incremental
		self.assertEqual(salon.pos_poll(s["token"], since=poll["inbox_seq"])["messages"], [])
		# the mirror flipped to the client screen
		self.assertEqual(frappe.db.get_value(salon.DOCTYPE, s["token"], "screen"), "client")

	def test_signup_creates_customer_with_marketing_prefs_and_attaches(self):
		s = self.pair()
		frappe.set_user("Guest")
		r = salon.signup(s["token"], name="Salon Newcomer", phone="+1 312 555 0777", birthday="1990-05-04", marketing_email=1, marketing_sms=0)
		self.assertTrue(r["created"])
		cust = r["client"]["customer"]
		self.assertEqual(frappe.db.get_value("Customer", cust, "customer_name"), "Salon Newcomer")
		self.assertTrue(frappe.db.get_value("Customer", cust, "maison_client_number"))
		prof = frappe.db.get_value("AWANZ Client Profile", cust, ["do_not_email", "do_not_sms", "birthday"], as_dict=True)
		self.assertEqual(prof.do_not_email, 0)
		self.assertEqual(prof.do_not_sms, 1)
		self.assertEqual(str(prof.birthday), "1990-05-04")
		self.assertTrue(frappe.db.exists("AWANZ Client Interaction", {"customer": cust, "type": "Visit"}))
		# second sign-up with the same phone links instead of duplicating
		r2 = salon.signup(s["token"], name="Salon Newcomer", phone="312-555-0777")
		self.assertFalse(r2["created"])
		self.assertEqual(r2["client"]["customer"], cust)
		frappe.set_user(CHI_ASSOCIATE)
		msgs = salon.pos_poll(s["token"], since=0)["messages"]
		self.assertEqual([m["how"] for m in msgs if m["type"] == "client_attached"], ["signup", "signup"])

	def test_signup_validation(self):
		s = self.pair()
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			salon.signup(s["token"], name="X", phone="+1 312 555 0778")
		with self.assertRaises(frappe.ValidationError):
			salon.signup(s["token"], name="No Contact")

	def test_consent_handoff_to_pos_and_decline(self):
		s = self.pair()
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			salon.consent(s["token"], "Hold-to-agree")  # nobody attached yet
		r = salon.signup(s["token"], name="Consent Client", email="consent.client@example.com")
		cust = r["client"]["customer"]
		c = salon.consent(s["token"], "Signature", signature_data_url="data:image/png;base64,iVBORw0KGgo=")
		self.assertTrue(c["ok"])
		frappe.set_user(CHI_ASSOCIATE)
		msgs = salon.pos_poll(s["token"], since=0)["messages"]
		agreed = [m for m in msgs if m["type"] == "consent_agreed"][0]
		self.assertEqual(agreed["customer"], cust)
		self.assertEqual(agreed["consent"]["method"], "Signature")
		self.assertTrue(agreed["has_signature"])
		self.assertNotIn("signature_data_url", agreed["consent"])
		pending = salon.pending_consent(s["token"])["consent"]
		self.assertTrue(pending["signature_data_url"].startswith("data:image/png"))
		self.assertIsNone(salon.pending_consent(s["token"])["consent"])  # cleared once fetched
		# no biometrics were stored by the Salon itself
		self.assertEqual(frappe.db.get_value("Customer", cust, "maison_face_consent"), 0)
		frappe.set_user("Guest")
		self.assertTrue(salon.consent_decline(s["token"])["ok"])
		self.assertTrue(frappe.db.exists("AWANZ Recognition Event", {"customer": cust, "outcome": "Declined"}))


class TestClientelingAndFeedback(SalonBase):
	def test_ask_logs_interaction_and_question_message(self):
		s = self.pair()
		mei = self.customer("Mei-Lin Chen")
		frappe.set_user("Guest")
		salon.identify(s["token"], "312 555 0105")
		r = salon.ask(s["token"], "Is the bezel ceramic?", item_code="TP-001")
		self.assertTrue(r["interaction"])
		row = frappe.db.get_value("AWANZ Client Interaction", r["interaction"], ["customer", "type", "note", "boutique"], as_dict=True)
		self.assertEqual(row.customer, mei)
		self.assertEqual(row.type, "Note")
		self.assertIn("Meridian Automatic 40mm Steel", row.note)
		self.assertIn("ceramic", row.note)
		self.assertEqual(row.boutique, "CHI-OAK")
		frappe.set_user(CHI_ASSOCIATE)
		q = [m for m in salon.pos_poll(s["token"], since=0)["messages"] if m["type"] == "question"][0]
		self.assertEqual(q["item_name"], "Meridian Automatic 40mm Steel")
		with self.assertRaises(frappe.ValidationError):
			frappe.set_user("Guest")
			salon.ask(s["token"], "   ")

	def test_preferences_write_into_client_profile(self):
		s = self.pair()
		mei = self.customer("Mei-Lin Chen")
		frappe.set_user("Guest")
		salon.identify(s["token"], "312 555 0105")
		r = salon.preferences(s["token"], {"ring_size": "6.5", "wrist_size": "16 cm", "metal_preference": "Rose Gold", "styles": ["Minimal", "Heritage", "Bogus"], "occasions": ["Anniversary", "Wedding"], "anniversary": "2020-09-12"})
		self.assertEqual(r["styles"], ["Minimal", "Heritage"])
		prof = frappe.db.get_value("AWANZ Client Profile", mei, ["ring_size", "wrist_size", "metal_preference", "style_notes", "anniversary"], as_dict=True)
		self.assertEqual(prof.ring_size, "6.5")
		self.assertEqual(prof.wrist_size, "16 cm")
		self.assertEqual(prof.metal_preference, "Rose Gold")
		self.assertIn("Style: Minimal, Heritage", prof.style_notes)
		self.assertIn("Occasions: Anniversary, Wedding", prof.style_notes)
		self.assertEqual(str(prof.anniversary), "2020-09-12")
		# invalid metal is dropped, never raises
		salon.preferences(s["token"], {"metal_preference": "Brass"})
		self.assertEqual(frappe.db.get_value("AWANZ Client Profile", mei, "metal_preference"), "Rose Gold")

	def test_invite_sets_profile_flag(self):
		s = self.pair()
		mei = self.customer("Mei-Lin Chen")
		frappe.set_user("Guest")
		salon.identify(s["token"], "312 555 0105")
		self.assertEqual(salon.invite(s["token"], 1)["wants_invitation"], 1)
		flag = frappe.db.get_value("AWANZ Client Profile", mei, ["private_viewing_invite", "private_viewing_invite_on"], as_dict=True)
		self.assertEqual(flag.private_viewing_invite, 1)
		self.assertTrue(flag.private_viewing_invite_on)
		salon.invite(s["token"], 0)
		self.assertEqual(frappe.db.get_value("AWANZ Client Profile", mei, "private_viewing_invite"), 0)

	def test_feedback_reaches_awanz_feedback_via_receipt_token(self):
		from maison_pos.api.sales import submit_batch

		s = self.pair()
		mei = self.customer("Mei-Lin Chen")
		frappe.set_user(CHI_ASSOCIATE)
		res = submit_batch([pos_invoice("CHI-OAK", customer=mei, payments=[{"mode_of_payment": "Cash", "amount": 176.4}])])["results"][0]
		self.assertEqual(res["status"], "ok", res)
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			salon.feedback(s["token"], 5)  # no receipt mirrored yet
		frappe.set_user(CHI_ASSOCIATE)
		salon.publish(s["token"], "receipt", {"customer": mei, "receipt_token": res["receipt_token"], "points_earned": 12})
		frappe.set_user("Guest")
		with self.assertRaises(frappe.ValidationError):
			salon.feedback(s["token"], 9)
		r = salon.feedback(s["token"], 2, "Lovely, but the wait was long")
		fb = frappe.get_doc("AWANZ Feedback", r["feedback"])
		self.assertEqual(fb.sales_invoice, res["invoice_name"])
		self.assertEqual(fb.rating, 2)
		self.assertEqual(fb.boutique, "CHI-OAK")
		self.assertEqual(fb.customer, mei)
		self.assertEqual(fb.alerted, 1)  # ≤ threshold → manager alert
		self.assertTrue(salon.feedback(s["token"], 4)["duplicate"])
		# HQ summary sees it
		frappe.set_user("Administrator")
		from maison_pos.api.feedback import summary

		self.assertGreaterEqual(summary(1)["low_count"], 1)

	def test_email_receipt_uses_email_on_file_and_masks(self):
		from maison_pos.api.sales import submit_batch

		s = self.pair()
		mei = self.customer("Mei-Lin Chen")
		frappe.set_user(CHI_ASSOCIATE)
		res = submit_batch([pos_invoice("CHI-OAK", customer=mei, payments=[{"mode_of_payment": "Cash", "amount": 176.4}])])["results"][0]
		salon.publish(s["token"], "receipt", {"customer": mei, "receipt_token": res["receipt_token"]})
		frappe.set_user("Guest")
		r = salon.email_receipt(s["token"])
		self.assertTrue(r["email_masked"].startswith("m•••@"))
		self.assertTrue(r["queued"])
		with self.assertRaises(frappe.ValidationError):
			salon.email_receipt(s["token"], "nope")

	def test_guest_token_is_required_everywhere(self):
		frappe.set_user("Guest")
		for fn, args in (
			(salon.state, ("nope",)),
			(salon.identify, ("nope", "x")),
			(salon.ask, ("nope", "q")),
			(salon.feedback, ("nope", 5)),
			(salon.preferences, ("nope", {})),
		):
			with self.assertRaises(frappe.PermissionError):
				fn(*args)
		self.assertEqual(json.loads(json.dumps(salon.unpair("nope"))), {"ok": True, "unpaired": False})
