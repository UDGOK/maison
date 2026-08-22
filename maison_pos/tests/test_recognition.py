"""v0.3 client recognition: match math + threshold, enrol / decline / revoke, retention purge, permissions."""

from __future__ import annotations

import json
import math
import random

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_months, now_datetime

from maison_pos import biometrics, tasks
from maison_pos.api import dashboard, recognition
from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import get_pos_settings
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice

NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_MANAGER = "nyc.5av.manager@maison.example"
CHI_ASSOCIATE = "chi.oak.a1@maison.example"
HQ = "hq@maison.example"
MODEL = "face-api/faceRecognitionNet@1"
DEVICE = "TEST-IPAD-1"


# Realistic synthetic face-api descriptors: NOT unit vectors. Every person shares a large "mean
# face" component (‖base‖ ≈ 1.45) plus a per-person deviation (‖dev‖ ≈ 0.55), so ‖d‖ ≈ 1.5,
# cross-person cosine ≈ 0.88 (what real face-api descriptors show) while the euclidean distance
# between two different people is ≈ 0.7 (> 0.6) and same-person jitter stays well below 0.6.
_BASE_RNG = random.Random(20260822)
_BASE = [_BASE_RNG.gauss(0, 1) for _ in range(512)]
_BASE_NORM = math.sqrt(sum(x * x for x in _BASE))


def vec(seed: int, dims: int = 128) -> list[float]:
	rng = random.Random(seed)
	dev = [rng.gauss(0, 1) for _ in range(dims)]
	dn = math.sqrt(sum(x * x for x in dev))
	base_norm = math.sqrt(sum(x * x for x in _BASE[:dims]))
	return [1.45 * b / base_norm + 0.55 * d / dn for b, d in zip(_BASE[:dims], dev)]


def jitter(v: list[float], amount: float, seed: int = 0) -> list[float]:
	rng = random.Random(seed)
	return [x + rng.uniform(-amount, amount) for x in v]


def consent(method: str = "Hold-to-agree", version: str | None = None) -> dict:
	return {"method": method, "text_version": version or get_pos_settings()["consent_text_version"]}


class RecognitionTestCase(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		# start from an empty gallery: e2e runs / desk enrolments leave consented clients with templates
		# behind, and the candidate / purge counts below assume only this class's enrolments exist
		# (everything happens inside the class transaction FrappeTestCase rolls back)
		frappe.db.delete("Maison Face Template")
		frappe.db.sql("update `tabMaison Biometric Consent` set status = 'Revoked' where status = 'Active'")
		frappe.db.sql("update `tabCustomer` set maison_face_consent = 0 where maison_face_consent = 1")
		frappe.db.set_single_value("Maison POS Settings", "face_recognition_enabled", 1)
		frappe.db.set_single_value("Maison POS Settings", "recognition_offline_cache", 1)
		frappe.db.set_single_value("Maison POS Settings", "match_threshold", biometrics.DEFAULT_DISTANCE_THRESHOLD)
		frappe.clear_cache(doctype="Maison POS Settings")

	def setUp(self):
		frappe.set_user("Administrator")
		recognition.invalidate_template_cache()
		self._sp = f"maison_rec_{id(self)}"
		frappe.db.savepoint(self._sp)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point=self._sp)
		recognition.invalidate_template_cache()

	def _phone(self, n: int) -> str:
		return f"+1 917 555 {n:04d}"

	def enrol(self, seed: int, n: int = 3, **kw):
		embeddings = [jitter(vec(seed), 0.02, i) for i in range(n)]
		return recognition.enroll(
			embeddings=embeddings,
			model=MODEL,
			boutique=kw.pop("boutique", "NYC-5AV"),
			device_id=DEVICE,
			consent=kw.pop("consent", consent()),
			quality=[0.9] * n,
			**kw,
		)


class TestMatchMath(RecognitionTestCase):
	def test_synthetic_vectors_are_realistic(self):
		a, b = vec(1), vec(2)
		self.assertGreater(math.sqrt(sum(x * x for x in a)), 1.3)  # not a unit vector
		self.assertLess(math.sqrt(sum(x * x for x in a)), 1.7)
		self.assertGreater(biometrics.cosine(a, b), 0.85)  # cosine compressed towards 1 …
		self.assertGreater(biometrics.euclidean(a, b), 0.6)  # … but clearly different people
		self.assertLess(biometrics.euclidean(a, jitter(a, 0.02, 5)), 0.3)  # same face, slight jitter

	def test_score_is_display_only(self):
		self.assertAlmostEqual(biometrics.distance_to_score(0.6), 0.5, places=6)
		self.assertAlmostEqual(biometrics.distance_to_score(0.0), 1.0, places=6)
		self.assertEqual(biometrics.distance_to_score(1.2), 0.0)
		self.assertEqual(biometrics.distance_to_score(5), 0.0)
		self.assertAlmostEqual(biometrics.score_to_distance(biometrics.distance_to_score(0.45)), 0.45, places=5)

	def test_euclidean_and_is_match(self):
		a = vec(1)
		self.assertEqual(biometrics.euclidean(a, a), 0.0)
		self.assertEqual(biometrics.euclidean(a, a[:64]), math.inf)
		self.assertEqual(biometrics.euclidean([], []), math.inf)
		self.assertAlmostEqual(biometrics.euclidean([0.0] * 128, [1.0] + [0.0] * 127), 1.0, places=9)
		self.assertTrue(biometrics.is_match(0.59))
		self.assertFalse(biometrics.is_match(0.6))
		self.assertFalse(biometrics.is_match(math.inf))
		self.assertTrue(biometrics.is_match(0.3, 0.4))
		self.assertFalse(biometrics.is_match(0.45, 0.4))
		# scaling a vector changes the distance (raw rule) — cosine would not notice
		self.assertGreater(biometrics.euclidean([x * 1.5 for x in a], a), 0.6)
		self.assertAlmostEqual(biometrics.cosine([x * 1.5 for x in a], a), 1.0, places=9)

	def test_cross_person_false_match_regression(self):
		"""Two different people with cosine ≈ 0.88 (as real face-api descriptors) must NOT match."""
		enrolled = self.enrol(201, phone=self._phone(201), name="Person One")
		other = vec(202)
		stored = [json.loads(t.embedding) for t in frappe.get_doc("Customer", enrolled["customer"]).maison_face_templates]
		cos = max(biometrics.cosine(other, t) for t in stored)
		dist = min(biometrics.euclidean(other, t) for t in stored)
		self.assertGreater(cos, 0.85, cos)  # the old cosine rule (threshold 0.849) would have matched
		self.assertLess(cos, 0.92, cos)
		self.assertGreater(dist, 0.6, dist)
		res = recognition.match(other, MODEL, "NYC-5AV", device_id=DEVICE)
		self.assertEqual(res["matches"], [])
		self.assertEqual(res["candidates"], 3)
		self.assertAlmostEqual(res["best_distance"], dist, places=5)
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", res["event"], "outcome"), "NoMatch")

	def test_settings_expose_distance_threshold(self):
		s = get_pos_settings("NYC-5AV")
		self.assertEqual(s["face_recognition_enabled"], 1)
		self.assertEqual(s["match_threshold"], 0.6)
		self.assertEqual(s["match_distance_threshold"], 0.6)
		self.assertEqual(s["recognition_model"], MODEL)
		self.assertEqual(s["consent_text_version"], "2026-08-1")
		self.assertIn("face template", s["consent_text"])
		self.assertEqual(s["biometric_retention_months"], 36)
		self.assertEqual(s["recognition_offline_cache"], 1)

	def test_boutique_override(self):
		frappe.db.set_value("Maison Boutique", "CHI-OAK", "face_recognition_enabled", "Off")
		self.assertEqual(get_pos_settings("CHI-OAK")["face_recognition_enabled"], 0)
		self.assertEqual(get_pos_settings("NYC-5AV")["face_recognition_enabled"], 1)
		with self.assertRaises(frappe.ValidationError):
			recognition.match(vec(1), MODEL, "CHI-OAK")
		frappe.db.set_single_value("Maison POS Settings", "face_recognition_enabled", 0)
		frappe.db.set_value("Maison Boutique", "CHI-OAK", "face_recognition_enabled", "On")
		self.assertEqual(get_pos_settings("CHI-OAK")["face_recognition_enabled"], 1)
		self.assertEqual(get_pos_settings("NYC-5AV")["face_recognition_enabled"], 0)
		frappe.db.set_single_value("Maison POS Settings", "face_recognition_enabled", 1)

	def test_match_and_threshold(self):
		enrolled = self.enrol(11, phone=self._phone(11), name="Ada Lovelace")
		self.enrol(12, phone=self._phone(12), name="Grace Hopper")
		customer = enrolled["customer"]

		# same face, slight jitter -> distance < 0.6 -> match
		res = recognition.match(json.dumps(jitter(vec(11), 0.05, 99)), MODEL, "NYC-5AV", device_id=DEVICE)
		self.assertEqual(res["threshold_distance"], 0.6)
		self.assertEqual(res["threshold"], 0.6)
		self.assertEqual(res["candidates"], 6)
		self.assertEqual(len(res["matches"]), 1)
		m = res["matches"][0]
		self.assertEqual(m["customer"], customer)
		self.assertEqual(m["customer_name"], "Ada Lovelace")
		self.assertTrue(m["client_number"].startswith("MC"))
		self.assertLess(m["distance"], res["threshold_distance"])
		self.assertAlmostEqual(m["score"], biometrics.distance_to_score(m["distance"]), places=6)
		self.assertAlmostEqual(res["best_distance"], m["distance"], places=6)
		self.assertAlmostEqual(res["best_score"], m["score"], places=6)
		self.assertIn("tier", m)
		self.assertIn("loyalty_points", m)
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", res["event"], "outcome"), "Matched")

		# unrelated face -> no match, best_distance above threshold, NoMatch logged
		res = recognition.match(vec(500), MODEL, "NYC-5AV")
		self.assertEqual(res["matches"], [])
		self.assertGreater(res["best_distance"], res["threshold_distance"])
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", res["event"], "outcome"), "NoMatch")

		# a stricter threshold (distance 0.05) rejects the jittered face
		frappe.db.set_single_value("Maison POS Settings", "match_threshold", 0.05)
		try:
			res = recognition.match(jitter(vec(11), 0.02, 7), MODEL, "NYC-5AV")
			self.assertEqual(res["threshold_distance"], 0.05)
			self.assertEqual(res["matches"], [])
			self.assertLess(res["best_distance"], 0.6)
		finally:
			frappe.db.set_single_value("Maison POS Settings", "match_threshold", 0.6)

		# an invalid stored threshold falls back to the default 0.6
		frappe.db.set_single_value("Maison POS Settings", "match_threshold", 0)
		try:
			self.assertEqual(get_pos_settings("NYC-5AV")["match_threshold"], 0.6)
			self.assertEqual(recognition.match(vec(11), MODEL, "NYC-5AV")["threshold_distance"], 0.6)
		finally:
			frappe.db.set_single_value("Maison POS Settings", "match_threshold", 0.6)

		# a different model never matches
		res = recognition.match(vec(11), "other-model@9", "NYC-5AV")
		self.assertEqual(res["candidates"], 0)
		self.assertEqual(res["matches"], [])

	def test_match_validates_embedding(self):
		with self.assertRaises(frappe.ValidationError):
			recognition.match([1, 2, 3], MODEL, "NYC-5AV")
		with self.assertRaises(frappe.ValidationError):
			recognition.match("not json", MODEL, "NYC-5AV")
		with self.assertRaises(frappe.ValidationError):
			recognition.match([float("nan")] * 128, MODEL, "NYC-5AV")

	def test_cache_invalidation_on_enrol_and_revoke(self):
		self.assertEqual(len(recognition.get_cached_templates(MODEL)), 0)
		out = self.enrol(21, phone=self._phone(21), name="Cache One")
		self.assertEqual(len(recognition.get_cached_templates(MODEL)), 3)
		recognition.revoke(out["customer"], "test")
		self.assertEqual(len(recognition.get_cached_templates(MODEL)), 0)


class TestEnrol(RecognitionTestCase):
	def test_enrol_by_phone_creates_customer(self):
		phone = self._phone(31)
		out = self.enrol(31, phone=phone, name="New Client")
		self.assertTrue(out["created"])
		self.assertEqual(out["customer_name"], "New Client")
		self.assertTrue(out["client_number"].startswith("MC"))
		self.assertEqual(len(out["templates"]), 3)
		self.assertEqual(out["template_count"], 3)
		self.assertEqual(out["consent_text_version"], "2026-08-1")
		cust = frappe.get_doc("Customer", out["customer"])
		self.assertEqual(cust.mobile_no, phone)
		self.assertEqual(cust.maison_face_consent, 1)
		self.assertIsNotNone(cust.maison_face_consent_at)
		self.assertEqual(cust.maison_face_consent_on, cust.maison_face_consent_at)
		self.assertEqual(len(cust.maison_face_templates), 3)
		t = cust.maison_face_templates[0]
		self.assertEqual(t.model, MODEL)
		self.assertEqual(t.dims, 128)
		self.assertEqual(t.consent, out["consent"])
		self.assertEqual(t.boutique, "NYC-5AV")
		self.assertEqual(len(json.loads(t.embedding)), 128)
		c = frappe.get_doc("Maison Biometric Consent", out["consent"])
		self.assertEqual(c.status, "Active")
		self.assertEqual(c.method, "Hold-to-agree")
		self.assertEqual(c.customer, out["customer"])
		self.assertIn("face template", c.consent_text)
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", out["event"], "outcome"), "Enrolled")

		# same phone (different formatting) enrols again -> links, supersedes consent, replaces templates
		again = self.enrol(31, phone=phone.replace(" ", "-"), n=2)
		self.assertFalse(again["created"])
		self.assertEqual(again["customer"], out["customer"])
		self.assertEqual(frappe.db.get_value("Maison Biometric Consent", out["consent"], "status"), "Superseded")
		self.assertEqual(frappe.db.count("Maison Face Template", {"parent": out["customer"]}), 2)

	def test_enrol_links_existing_customer_by_email(self):
		customer = frappe.db.get_value("Customer", {"customer_name": "Mei-Lin Chen"}, ["name", "email_id"], as_dict=True)
		self.assertTrue(customer.email_id)
		out = self.enrol(41, email=customer.email_id.upper(), name="Ignored Name")
		self.assertFalse(out["created"])
		self.assertEqual(out["customer"], customer.name)
		self.assertEqual(out["customer_name"], "Mei-Lin Chen")
		self.assertEqual(frappe.db.get_value("Customer", customer.name, "maison_face_consent"), 1)
		# explicit customer id also works
		out2 = self.enrol(41, customer=customer.name)
		self.assertEqual(out2["customer"], customer.name)

	def test_enrol_requires_consent_and_identity(self):
		with self.assertRaises(frappe.ValidationError):
			self.enrol(51, phone=self._phone(51), consent={})
		with self.assertRaises(frappe.ValidationError):
			self.enrol(51, phone=self._phone(51), consent={"method": "Hold-to-agree", "text_version": "1999-01-1"})
		with self.assertRaises(frappe.ValidationError):
			self.enrol(51, phone=self._phone(51), consent={"method": "Signature", "text_version": "2026-08-1"})
		with self.assertRaises(frappe.ValidationError):
			self.enrol(51)  # no customer / phone / email
		with self.assertRaises(frappe.ValidationError):
			recognition.enroll([], MODEL, "NYC-5AV", DEVICE, consent(), phone=self._phone(51))
		with self.assertRaises(frappe.ValidationError):
			recognition.enroll([vec(1), vec(2, 512)], MODEL, "NYC-5AV", DEVICE, consent(), phone=self._phone(51))
		self.assertFalse(frappe.db.exists("Customer", {"mobile_no": self._phone(51)}))

	def test_enrol_with_signature_and_offline_uuid(self):
		png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
		out = self.enrol(61, phone=self._phone(61), name="Sig Client", consent={"method": "Signature", "text_version": "2026-08-1", "signature_data_url": png}, offline_uuid="enrol-uuid-61")
		c = frappe.get_doc("Maison Biometric Consent", out["consent"])
		self.assertEqual(c.method, "Signature")
		self.assertTrue(c.signature and c.signature.startswith("/private/files/"))
		self.assertEqual(c.offline_uuid, "enrol-uuid-61")
		replay = self.enrol(61, phone=self._phone(61), name="Sig Client", consent={"method": "Signature", "text_version": "2026-08-1", "signature_data_url": png}, offline_uuid="enrol-uuid-61")
		self.assertTrue(replay["duplicate"])
		self.assertEqual(replay["consent"], out["consent"])
		self.assertEqual(frappe.db.count("Maison Biometric Consent", {"customer": out["customer"]}), 1)

	def test_decline_creates_customer_without_biometrics(self):
		out = recognition.decline("NYC-5AV", DEVICE, phone=self._phone(71), name="Declined Client")
		self.assertTrue(out["created"])
		self.assertEqual(out["customer_name"], "Declined Client")
		self.assertEqual(out["face_consent"], 0)
		self.assertEqual(frappe.db.count("Maison Face Template", {"parent": out["customer"]}), 0)
		self.assertEqual(frappe.db.count("Maison Biometric Consent", {"customer": out["customer"]}), 0)
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", out["event"], "outcome"), "Declined")
		# decline on an existing client just logs
		again = recognition.decline("NYC-5AV", DEVICE, phone=self._phone(71))
		self.assertFalse(again["created"])
		self.assertEqual(again["customer"], out["customer"])
		with self.assertRaises(frappe.ValidationError):
			recognition.decline("NYC-5AV", DEVICE)

	def test_templates_for_offline_cache(self):
		a = self.enrol(81, phone=self._phone(81), name="Cache A")
		res = recognition.templates("NYC-5AV")
		self.assertEqual(res["enabled"], 1)
		self.assertEqual(res["model"], MODEL)
		customers = {t["customer"] for t in res["templates"]}
		self.assertIn(a["customer"], customers)
		row = next(t for t in res["templates"] if t["customer"] == a["customer"])
		self.assertEqual(len(row["embedding"]), 128)
		# RAW descriptor, never unit-normalised (the device applies the same euclidean rule)
		self.assertGreater(math.sqrt(sum(x * x for x in row["embedding"])), 1.3)
		stored = json.loads(frappe.get_doc("Customer", a["customer"]).maison_face_templates[0].embedding)
		self.assertTrue(any(biometrics.euclidean(t["embedding"], stored) < 1e-6 for t in res["templates"] if t["customer"] == a["customer"]))
		self.assertEqual(res["threshold_distance"], 0.6)
		self.assertEqual(res["threshold"], 0.6)
		self.assertEqual(row["client_number"], a["client_number"])
		self.assertEqual(res["deleted"], [])

		since = now_datetime().isoformat()
		recognition.revoke(a["customer"], "left")
		delta = recognition.templates("NYC-5AV", since=since)
		self.assertEqual(delta["templates"], [])
		self.assertEqual(delta["deleted"], [a["customer"]])

		frappe.db.set_single_value("Maison POS Settings", "recognition_offline_cache", 0)
		try:
			off = recognition.templates("NYC-5AV")
			self.assertEqual(off["enabled"], 0)
			self.assertEqual(off["templates"], [])
		finally:
			frappe.db.set_single_value("Maison POS Settings", "recognition_offline_cache", 1)

	def test_customer_search_exposes_biometric_status(self):
		"""The POS Client screen reads maison_face_consent / maison_face_consent_at / face_templates from customers.search."""
		from maison_pos.api import customers

		a = self.enrol(92, phone=self._phone(92), name="Search Bio Client")
		row = next(r for r in customers.search(self._phone(92)) if r["name"] == a["customer"])
		self.assertEqual(row["maison_face_consent"], 1)
		self.assertTrue(row["maison_face_consent_at"])
		self.assertEqual(row["face_templates"], 3)
		self.assertEqual(customers.lookup(f"MC:{a['customer']}")["face_templates"], 3)
		recognition.revoke(a["customer"], "done")
		row = next(r for r in customers.search(self._phone(92)) if r["name"] == a["customer"])
		self.assertEqual(row["maison_face_consent"], 0)
		self.assertIsNone(row["maison_face_consent_at"])
		self.assertEqual(row["face_templates"], 0)

	def test_status_and_log_event(self):
		a = self.enrol(91, phone=self._phone(91), name="Status Client")
		s = recognition.status(a["customer"])
		self.assertEqual(s["face_consent"], 1)
		self.assertEqual(s["templates"], 3)
		self.assertEqual(s["consent"]["name"], a["consent"])
		ev = recognition.log_event("Undone", customer=a["customer"], score=0.93, boutique="NYC-5AV", device_id=DEVICE)
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", ev["event"], ["outcome", "score"]), ("Undone", 0.93))
		with self.assertRaises(frappe.ValidationError):
			recognition.log_event("Enrolled", customer=a["customer"], boutique="NYC-5AV")

	def test_dashboard_counts(self):
		self.enrol(95, phone=self._phone(95), name="Dash Client")
		recognition.match(jitter(vec(95), 0.02, 1), MODEL, "NYC-5AV")
		recognition.match(vec(999), MODEL, "NYC-5AV")
		rec = dashboard.live_summary()["recognition"]
		self.assertGreaterEqual(rec["enrolled_today"], 1)
		self.assertGreaterEqual(rec["matched_today"], 1)
		self.assertGreaterEqual(rec["nomatch_today"], 1)


class TestRevokeAndPurge(RecognitionTestCase):
	def test_revoke_purges(self):
		a = self.enrol(101, phone=self._phone(101), name="Revoke Me")
		out = recognition.revoke(a["customer"], "client asked")
		self.assertTrue(out["ok"])
		self.assertEqual(out["purged_templates"], 3)
		self.assertEqual(out["revoked_consents"], [a["consent"]])
		self.assertEqual(frappe.db.count("Maison Face Template", {"parent": a["customer"]}), 0)
		c = frappe.get_doc("Maison Biometric Consent", a["consent"])
		self.assertEqual(c.status, "Revoked")
		self.assertIsNotNone(c.revoked_at)
		self.assertEqual(c.revoked_by, "Administrator")
		self.assertEqual(c.revoke_reason, "client asked")
		cust = frappe.db.get_value("Customer", a["customer"], ["maison_face_consent", "maison_face_consent_at", "maison_face_consent_on"], as_dict=True)
		self.assertEqual(cust.maison_face_consent, 0)
		self.assertIsNone(cust.maison_face_consent_at)
		self.assertIsNone(cust.maison_face_consent_on)
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", out["event"], "outcome"), "Revoked")
		# revoked client never matches
		res = recognition.match(vec(101), MODEL, "NYC-5AV")
		self.assertEqual(res["matches"], [])
		# customer can be enrolled again afterwards (new consent)
		again = self.enrol(101, customer=a["customer"])
		self.assertNotEqual(again["consent"], a["consent"])
		self.assertEqual(frappe.db.get_value("Maison Biometric Consent", a["consent"], "status"), "Revoked")

	def test_unticking_consent_on_customer_purges(self):
		a = self.enrol(111, phone=self._phone(111), name="Desk Untick")
		cust = frappe.get_doc("Customer", a["customer"])
		cust.maison_face_consent = 0
		cust.save()
		self.assertEqual(frappe.db.count("Maison Face Template", {"parent": a["customer"]}), 0)
		self.assertEqual(frappe.db.get_value("Maison Biometric Consent", a["consent"], "status"), "Revoked")
		self.assertEqual(recognition.match(vec(111), MODEL, "NYC-5AV")["matches"], [])

	def test_retention_purge(self):
		stale = self.enrol(121, phone=self._phone(121), name="Stale Client")
		fresh = self.enrol(122, phone=self._phone(122), name="Fresh Client")
		never = self.enrol(123, phone=self._phone(123), name="Never Bought")
		old = add_months(now_datetime(), -40)
		# stale: visited 40 months ago; fresh: bought today; never: consented 40 months ago, no visits
		from maison_pos.api import sales

		# post both visits first, then back-date the stale one at DB level (the demo fiscal year only covers the
		# current year). Nothing may hit stock after the back-dating: a later submit of the same item/warehouse
		# would trigger an item-wise repost that regenerates this invoice's GL with the 2023 date and fail
		# ("not in any active Fiscal Year") — the original posting date is restored at the end of the test.
		res = sales.submit_batch([pos_invoice(customer=stale["customer"])])["results"][0]
		self.assertEqual(res["status"], "ok", res)
		stale_invoice = res["invoice_name"]
		res = sales.submit_batch([pos_invoice(customer=fresh["customer"])])["results"][0]
		self.assertEqual(res["status"], "ok", res)
		today = frappe.db.get_value("Sales Invoice", stale_invoice, "posting_date")
		frappe.db.set_value("Sales Invoice", stale_invoice, "posting_date", old.date(), update_modified=False)
		self.addCleanup(frappe.db.set_value, "Sales Invoice", stale_invoice, "posting_date", today, update_modified=False)
		frappe.db.set_value("Maison Biometric Consent", never["consent"], "captured_at", old)
		frappe.db.set_value("Maison Biometric Consent", stale["consent"], "captured_at", old)

		out = tasks.purge_expired_biometrics()
		self.assertEqual(out["checked"], 3)
		self.assertEqual(sorted(out["purged"]), sorted([stale["customer"], never["customer"]]))
		for e in (stale, never):
			self.assertEqual(frappe.db.count("Maison Face Template", {"parent": e["customer"]}), 0)
			self.assertEqual(frappe.db.get_value("Maison Biometric Consent", e["consent"], "status"), "Revoked")
			self.assertEqual(frappe.db.get_value("Customer", e["customer"], "maison_face_consent"), 0)
			self.assertTrue(frappe.db.exists("Maison Recognition Event", {"customer": e["customer"], "outcome": "Purged"}))
		self.assertEqual(frappe.db.count("Maison Face Template", {"parent": fresh["customer"]}), 3)
		self.assertEqual(frappe.db.get_value("Maison Biometric Consent", fresh["consent"], "status"), "Active")
		# idempotent
		self.assertEqual(tasks.purge_expired_biometrics()["purged"], [])
		# shorter retention catches the fresh one only when its last visit is older than the window
		self.assertEqual(tasks.purge_expired_biometrics(retention_months=1)["purged"], [])


class TestPermissions(RecognitionTestCase):
	def test_associate_cannot_revoke(self):
		a = self.enrol(131, phone=self._phone(131), name="Perm Client")
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(frappe.PermissionError):
			recognition.revoke(a["customer"], "nope")
		frappe.set_user("Administrator")
		self.assertEqual(frappe.db.count("Maison Face Template", {"parent": a["customer"]}), 3)

	def test_manager_can_revoke(self):
		a = self.enrol(132, phone=self._phone(132), name="Perm Client 2")
		frappe.set_user(NYC_MANAGER)
		out = recognition.revoke(a["customer"], "manager")
		self.assertTrue(out["ok"])
		self.assertEqual(frappe.db.get_value("Maison Recognition Event", out["event"], "boutique"), "NYC-5AV")

	def test_associate_can_enrol_match_decline_own_boutique_only(self):
		frappe.set_user(NYC_ASSOCIATE)
		out = self.enrol(141, phone=self._phone(141), name="Assoc Enrol")
		self.assertEqual(out["created"], True)
		res = recognition.match(jitter(vec(141), 0.02, 3), MODEL, "NYC-5AV", device_id=DEVICE)
		self.assertEqual(res["matches"][0]["customer"], out["customer"])
		recognition.decline("NYC-5AV", DEVICE, phone=self._phone(142), name="Assoc Decline")
		self.assertTrue(recognition.templates("NYC-5AV")["enabled"])
		with self.assertRaises(frappe.PermissionError):
			self.enrol(143, boutique="CHI-OAK", phone=self._phone(143))
		with self.assertRaises(frappe.PermissionError):
			recognition.match(vec(1), MODEL, "CHI-OAK")
		with self.assertRaises(frappe.PermissionError):
			recognition.templates("CHI-OAK")
		with self.assertRaises(frappe.PermissionError):
			recognition.log_event("Undone", boutique="CHI-OAK")
		self.assertFalse(recognition.status(out["customer"])["can_revoke"])

	def test_guest_denied(self):
		frappe.set_user("Guest")
		with self.assertRaises((frappe.PermissionError, frappe.AuthenticationError)):
			recognition.match(vec(1), MODEL, "NYC-5AV")
		with self.assertRaises((frappe.PermissionError, frappe.AuthenticationError)):
			recognition.templates("NYC-5AV")

	def test_hq_sees_everything(self):
		frappe.set_user(HQ)
		out = self.enrol(151, boutique="CHI-OAK", phone=self._phone(151), name="HQ Enrol")
		self.assertTrue(recognition.revoke(out["customer"], "hq")["ok"])
