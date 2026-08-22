"""v0.5 §M: attribution rules (direct / assisted / none, 14 / 30-day windows, item-level), webhook
signature verification + payload parsing, segment builder, employee_performance math, assign_call
permissions, nightly job + performance endpoint."""

from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import hmac
import json

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, get_datetime, now_datetime, nowdate

from maison_pos.api import campaigns as campaigns_api
from maison_pos.api import hr, insights, sales
from maison_pos.campaigns import attribution, segments, webhooks
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice

NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_ASSOCIATE_2 = "nyc.5av.a2@maison.example"
NYC_MANAGER = "nyc.5av.manager@maison.example"
CHI_ASSOCIATE = "chi.oak.a1@maison.example"
HQ = "hq@maison.example"

T0 = _dt.datetime(2026, 8, 20, 15, 0, 0)


def _customer(name: str) -> str:
	return frappe.db.get_value("Customer", {"customer_name": name}, "name")


def _inv(name="INV-1", customer="C1", ts=T0, items=None, net=None):
	items = items or [{"item_code": "AC-012", "net_amount": 160.0}]
	return {"name": name, "customer": customer, "posting_datetime": ts, "net_total": net if net is not None else sum(i["net_amount"] for i in items), "items": items}


def _touch(name, campaign, sent_days_before, **kw):
	t = {"name": name, "campaign": campaign, "sent_at": T0 - _dt.timedelta(days=sent_days_before), "opened_at": None, "clicked_at": None}
	t.update(kw)
	return t


META = {
	"A": {"direct_window_days": 14, "assisted_window_days": 30, "featured_items": set()},
	"B": {"direct_window_days": 14, "assisted_window_days": 30, "featured_items": set()},
	"F": {"direct_window_days": 14, "assisted_window_days": 30, "featured_items": {"TP-001"}},
}


# ---------------------------------------------------------------------------
# pure attribution rules
# ---------------------------------------------------------------------------
class TestAttributionRules(FrappeTestCase):
	def test_direct_last_touch_within_14_days(self):
		rows = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 3)], META)
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0]["type"], "Direct")
		self.assertEqual(rows[0]["amount"], 160.0)
		self.assertEqual(rows[0]["item_level"], 0)

	def test_assisted_between_14_and_30_days(self):
		rows = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 20)], META)
		self.assertEqual([r["type"] for r in rows], ["Assisted"])

	def test_none_beyond_30_days_or_after_sale(self):
		self.assertEqual(attribution.attribute_invoice(_inv(), [_touch("t1", "A", 31)], META), [])
		self.assertEqual(attribution.attribute_invoice(_inv(), [_touch("t1", "A", -1)], META), [])  # sent after the sale
		self.assertEqual(attribution.attribute_invoice(_inv(net=0), [_touch("t1", "A", 3)], META), [])

	def test_window_edges(self):
		exactly_14 = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 14)], META)
		self.assertEqual(exactly_14[0]["type"], "Direct")
		just_over_14 = attribution.attribute_invoice(_inv(), [{"name": "t1", "campaign": "A", "sent_at": T0 - _dt.timedelta(days=14, minutes=1)}], META)
		self.assertEqual(just_over_14[0]["type"], "Assisted")
		exactly_30 = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 30)], META)
		self.assertEqual(exactly_30[0]["type"], "Assisted")

	def test_most_recent_touch_is_direct_others_assisted(self):
		rows = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 10), _touch("t2", "B", 2)], META)
		by = {r["campaign"]: r for r in rows}
		self.assertEqual(by["B"]["type"], "Direct")
		self.assertEqual(by["A"]["type"], "Assisted")
		self.assertEqual(by["A"]["amount"], 160.0)

	def test_one_candidate_per_campaign_latest_touch(self):
		rows = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 25), _touch("t2", "A", 5)], META)
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0]["touch"], "t2")
		self.assertEqual(rows[0]["type"], "Direct")

	def test_click_counts_as_touch_time_but_not_after_sale(self):
		# sent 20 d ago (assisted) but clicked 2 d ago -> direct
		rows = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 20, clicked_at=T0 - _dt.timedelta(days=2))], META)
		self.assertEqual(rows[0]["type"], "Direct")
		# a click after the sale is ignored; the send 20 d ago still assists
		rows = attribution.attribute_invoice(_inv(), [_touch("t1", "A", 20, clicked_at=T0 + _dt.timedelta(hours=1))], META)
		self.assertEqual(rows[0]["type"], "Assisted")

	def test_item_level_featured_piece_wins_and_credits_only_its_lines(self):
		inv = _inv(items=[{"item_code": "TP-001", "net_amount": 6900.0}, {"item_code": "AC-012", "net_amount": 160.0}])
		rows = attribution.attribute_invoice(inv, [_touch("f", "F", 20), _touch("a", "A", 2)], META)
		by = {r["campaign"]: r for r in rows}
		self.assertEqual(by["F"]["type"], "Direct")
		self.assertEqual(by["F"]["item_level"], 1)
		self.assertEqual(by["F"]["amount"], 6900.0)
		self.assertEqual(by["F"]["item_codes"], "TP-001")
		self.assertEqual(by["A"]["type"], "Assisted")
		self.assertEqual(by["A"]["amount"], 7060.0)

	def test_featured_campaign_without_featured_item_in_basket_uses_normal_rule(self):
		rows = attribution.attribute_invoice(_inv(), [_touch("f", "F", 3)], META)
		self.assertEqual(rows[0]["type"], "Direct")
		self.assertEqual(rows[0]["item_level"], 0)
		self.assertEqual(rows[0]["amount"], 160.0)

	def test_unknown_campaign_ignored(self):
		self.assertEqual(attribution.attribute_invoice(_inv(), [_touch("t1", "ZZZ", 3)], META), [])


# ---------------------------------------------------------------------------
# webhooks (pure)
# ---------------------------------------------------------------------------
class TestWebhookSignatures(FrappeTestCase):
	SECRET = "whsec_test"
	BODY = b'{"data":[{"attributes":{"metric":{"name":"Opened Email"},"profile":{"email":"a@b.c"}}}]}'

	def _sig(self, body=None, secret=None):
		return hmac.new((secret or self.SECRET).encode(), body or self.BODY, hashlib.sha256).digest()

	def test_hex_base64_and_v1_forms(self):
		d = self._sig()
		self.assertTrue(webhooks.verify_signature(self.SECRET, self.BODY, d.hex()))
		self.assertTrue(webhooks.verify_signature(self.SECRET, self.BODY, base64.b64encode(d).decode()))
		self.assertTrue(webhooks.verify_signature(self.SECRET, self.BODY, f"t=1700000000,v1={d.hex()}"))

	def test_rejects_bad_secret_body_or_missing(self):
		self.assertFalse(webhooks.verify_signature(self.SECRET, self.BODY, self._sig(secret="other").hex()))
		self.assertFalse(webhooks.verify_signature(self.SECRET, self.BODY + b" ", self._sig().hex()))
		self.assertFalse(webhooks.verify_signature(self.SECRET, self.BODY, None))
		self.assertFalse(webhooks.verify_signature(None, self.BODY, self._sig().hex()))
		self.assertFalse(webhooks.verify_signature(self.SECRET, self.BODY, "not-a-signature"))

	def test_timestamp_skew(self):
		sig = self._sig().hex()
		self.assertTrue(webhooks.verify_signature(self.SECRET, self.BODY, sig, timestamp="1000", now=1100))
		self.assertFalse(webhooks.verify_signature(self.SECRET, self.BODY, sig, timestamp="1000", now=2000))
		self.assertFalse(webhooks.verify_signature(self.SECRET, self.BODY, sig, timestamp="abc"))

	def test_shared_token(self):
		self.assertTrue(webhooks.verify_shared_token("tok", "tok"))
		self.assertFalse(webhooks.verify_shared_token("tok", "tok2"))
		self.assertFalse(webhooks.verify_shared_token(None, "tok"))

	def test_parse_klaviyo(self):
		payload = {"data": [
			{"id": "ev1", "attributes": {"metric": {"name": "Clicked Email"}, "profile": {"email": "A@B.c"}, "event_properties": {"utm_campaign": "X"}, "datetime": "2026-08-01T10:00:00Z"}},
			{"id": "ev2", "attributes": {"metric": {"name": "Unsubscribed"}, "profile": {"email": "a@b.c"}}},
		]}
		ev = webhooks.parse_klaviyo(payload)
		self.assertEqual(len(ev), 1)
		self.assertEqual(ev[0]["event"], "clicked")
		self.assertEqual(ev[0]["email"], "a@b.c")
		self.assertEqual(ev[0]["campaign_ref"], "X")
		self.assertEqual(ev[0]["external_id"], "ev1")

	def test_parse_brevo(self):
		ev = webhooks.parse_brevo([{"event": "opened", "email": "a@b.c", "camp_id": 77, "date": "2026-08-01 10:00:00", "message-id": "m1"}, {"event": "spam", "email": "x@y.z"}])
		self.assertEqual(len(ev), 1)
		self.assertEqual(ev[0]["event"], "opened")
		self.assertEqual(ev[0]["campaign_ref"], 77)


# ---------------------------------------------------------------------------
# site-level tests (demo data)
# ---------------------------------------------------------------------------
class V05Base(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		frappe.flags.mute_emails = True

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v05_test")

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="v05_test")

	def _campaign(self, code, **values):
		if frappe.db.exists("Maison Campaign", code):
			frappe.delete_doc("Maison Campaign", code, force=True, ignore_permissions=True)
		doc = frappe.get_doc({"doctype": "Maison Campaign", "campaign_code": code, "title": code, "channel": "Email", "status": "Sent", "send_date": add_days(nowdate(), -5), **values})
		doc.insert(ignore_permissions=True)
		return doc

	def _sale(self, customer, boutique="NYC-5AV", items=None, **extra):
		res = sales.submit_batch([pos_invoice(boutique=boutique, customer=customer, items=items, **extra)])
		self.assertEqual(res["results"][0]["status"], "ok", res)
		return res["results"][0]["invoice_name"]


class TestCampaignValidation(V05Base):
	def test_windows_validated(self):
		c = self._campaign("TEST-WIN", direct_window_days=0, assisted_window_days=0)
		self.assertEqual((c.direct_window_days, c.assisted_window_days), (14, 30))
		c.assisted_window_days = 7
		self.assertRaises(frappe.ValidationError, c.save)
		self.assertRaises(frappe.ValidationError, lambda: self._campaign("BAD CODE"))


class TestSegmentBuilder(V05Base):
	def test_item_group_affinity_and_channel_opt_out(self):
		isabella = _customer("Isabella Marchetti")
		self._sale(isabella, items=[{"item_code": "AC-012", "qty": 1, "rate": 160}])
		c = self._campaign("TEST-SEG", segment_item="AC-012", segment_months=1)
		names = {r["customer"] for r in segments.build_segment(c.name)}
		self.assertIn(isabella, names)
		self.assertNotIn("Walk-in Client", names)
		# SMS channel honours do_not_sms
		frappe.get_doc({"doctype": "Maison Client Profile", "customer": isabella, "do_not_sms": 1}).insert(ignore_permissions=True) if not frappe.db.exists("Maison Client Profile", isabella) else frappe.db.set_value("Maison Client Profile", isabella, "do_not_sms", 1)
		c.channel = "SMS"
		c.save()
		self.assertNotIn(isabella, {r["customer"] for r in segments.build_segment(c.name)})

	def test_boutique_and_tier_and_signal_narrow(self):
		isabella = _customer("Isabella Marchetti")
		self._sale(isabella, boutique="NYC-5AV")
		c = self._campaign("TEST-SEG2", segment_boutique="NYC-5AV")
		self.assertIn(isabella, {r["customer"] for r in segments.build_segment(c.name)})
		c.segment_boutique = "MIA-DD"
		c.save()
		rows = segments.build_segment(c.name)
		self.assertTrue(all(r["boutique"] == "MIA-DD" for r in rows))
		# signal type: nobody has a "Birthday" signal for a fresh test customer -> empty intersection
		c.segment_boutique = None
		c.segment_signal_type = "Birthday"
		c.save()
		sig_customers = set(frappe.get_all("Maison Client Signal", filters={"signal_type": "Birthday", "status": "Open"}, pluck="customer"))
		self.assertTrue({r["customer"] for r in segments.build_segment(c.name)} <= sig_customers)
		# tier override wins
		c.segment_signal_type = None
		c.segment_tier = "Patron"
		c.save()
		if frappe.db.exists("Maison Client Profile", isabella):
			frappe.db.set_value("Maison Client Profile", isabella, "vip_tier_override", "Patron")
		else:
			frappe.get_doc({"doctype": "Maison Client Profile", "customer": isabella, "vip_tier_override": "Patron"}).insert(ignore_permissions=True)
		self.assertIn(isabella, {r["customer"] for r in segments.build_segment(c.name)})

	def test_export_segment_email_group_and_csv(self):
		c = self._campaign("TEST-EXP")
		frappe.set_user(HQ)
		res = campaigns_api.export_segment(c.name, format="email_group")
		self.assertEqual(res["email_group"], "Campaign TEST-EXP")
		self.assertGreater(res["members"], 0)
		campaigns_api.export_segment(c.name, format="csv")
		self.assertIn("utm_campaign", frappe.response["filecontent"])
		self.assertTrue(frappe.response["filename"].endswith("segment.csv"))
		frappe.set_user(NYC_MANAGER)
		self.assertRaises(frappe.PermissionError, campaigns_api.export_segment, c.name)


class TestAttributionJob(V05Base):
	def test_nightly_writes_rows_and_performance_reports_revenue(self):
		isabella = _customer("Isabella Marchetti")
		c = self._campaign("TEST-ATTR", cost=100)
		webhooks.record_touch(c.name, isabella, "sent", add_days(now_datetime(), -3), source="Manual")
		inv = self._sale(isabella, items=[{"item_code": "AC-012", "qty": 2, "rate": 160}])
		summary = attribution.run_attribution(campaign=c.name)
		self.assertGreaterEqual(summary["attributed_invoices"], 1)
		row = frappe.db.get_value("Maison Campaign Attribution", {"sales_invoice": inv, "campaign": c.name}, ["type", "amount", "boutique"], as_dict=True)
		self.assertEqual(row.type, "Direct")
		self.assertEqual(row.amount, 320.0)
		self.assertEqual(row.boutique, "NYC-5AV")
		perf = campaigns_api.performance(campaign=c.name)
		self.assertEqual(perf["campaigns"][0]["sends"], 1)
		# the demo client may have other (history) sales inside the window -> at least this one
		direct = perf["campaigns"][0]["attributed_direct"]
		self.assertGreaterEqual(direct, 320.0)
		self.assertEqual(direct, frappe.db.get_value("Maison Campaign Attribution", {"campaign": c.name, "type": "Direct"}, "sum(amount)"))
		self.assertAlmostEqual(perf["campaigns"][0]["roi"], (direct - 100) / 100, places=3)
		self.assertEqual(perf["totals"]["attributed_direct"], direct)
		# idempotent: a second run does not duplicate rows
		attribution.run_attribution(campaign=c.name)
		self.assertEqual(frappe.db.count("Maison Campaign Attribution", {"sales_invoice": inv}), 1)
		# a manager of another boutique sees no attributed revenue from NYC
		frappe.set_user(CHI_ASSOCIATE.replace("a1", "manager"))
		perf = campaigns_api.performance(campaign=c.name)
		self.assertEqual(perf["boutique"], "CHI-OAK")
		chi_only = frappe.db.get_value("Maison Campaign Attribution", {"campaign": c.name, "type": "Direct", "boutique": "CHI-OAK"}, "sum(amount)") or 0.0
		self.assertEqual(perf["campaigns"][0]["attributed_direct"], chi_only)
		self.assertLess(chi_only, direct)  # the NYC sale is not in the Oak Street view

	def test_returns_are_not_attributed(self):
		isabella = _customer("Isabella Marchetti")
		c = self._campaign("TEST-RET")
		webhooks.record_touch(c.name, isabella, "sent", add_days(now_datetime(), -1))
		inv = self._sale(isabella)
		credit = sales.void(inv, "test")["credit_note"]
		attribution.run_attribution(campaign=c.name)
		self.assertEqual(frappe.db.count("Maison Campaign Attribution", {"sales_invoice": credit}), 0)

	def test_record_touch_upserts_and_backfills(self):
		isabella = _customer("Isabella Marchetti")
		c = self._campaign("TEST-TOUCH")
		t1 = webhooks.record_touch(c.name, isabella, "clicked", "2026-08-10 10:00:00")
		t2 = webhooks.record_touch(c.name, isabella, "sent", "2026-08-09 09:00:00")
		self.assertEqual(t1, t2)
		d = frappe.db.get_value("Maison Campaign Touch", t1, ["sent_at", "opened_at", "clicked_at"], as_dict=True)
		self.assertEqual(str(d.sent_at), "2026-08-09 09:00:00")
		self.assertEqual(str(d.opened_at), "2026-08-10 10:00:00")
		self.assertEqual(str(d.clicked_at), "2026-08-10 10:00:00")


class _FakeRequest:
	def __init__(self, body: bytes, headers: dict[str, str]):
		self._body = body
		self.headers = headers
		self.method = "POST"

	def get_data(self):
		return self._body


class TestWebhookEndpoints(V05Base):
	def _with_request(self, body, headers):
		frappe.local.request = _FakeRequest(body, headers)

	def tearDown(self):
		frappe.local.request = None
		frappe.local.conf.pop("klaviyo_webhook_secret", None)
		frappe.local.conf.pop("brevo_webhook_secret", None)
		super().tearDown()

	def test_klaviyo_signed_event_creates_touch_and_bad_signature_is_rejected(self):
		c = self._campaign("TEST-KLV", klaviyo_campaign_id="klv-123")
		frappe.local.conf["klaviyo_webhook_secret"] = "s3cret"
		body = json.dumps({"data": [{"id": "e1", "attributes": {"metric": {"name": "Opened Email"}, "profile": {"email": "isabella.marchetti@example.com"}, "event_properties": {"campaign_id": "klv-123"}, "datetime": "2026-08-20 10:00:00"}}]}).encode()
		sig = hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
		frappe.set_user("Guest")
		self._with_request(body, {"Klaviyo-Signature": sig})
		res = campaigns_api.webhook_klaviyo()
		self.assertEqual(res["recorded"], 1)
		touch = frappe.db.get_value("Maison Campaign Touch", {"campaign": c.name, "customer": _customer("Isabella Marchetti")}, ["source", "opened_at", "sent_at"], as_dict=True)
		self.assertEqual(touch.source, "Klaviyo")
		self.assertIsNotNone(touch.opened_at)
		self.assertIsNotNone(touch.sent_at)
		frappe.set_user("Guest")
		self._with_request(body, {"Klaviyo-Signature": "deadbeef" * 8})
		self.assertRaises(frappe.PermissionError, campaigns_api.webhook_klaviyo)

	def test_webhook_refuses_without_configured_secret(self):
		frappe.set_user("Guest")
		self._with_request(b"{}", {"X-Brevo-Token": "anything"})
		self.assertRaises(frappe.PermissionError, campaigns_api.webhook_brevo)

	def test_brevo_token_and_unmatched_report(self):
		c = self._campaign("TEST-BRV", brevo_campaign_id="901")
		frappe.local.conf["brevo_webhook_secret"] = "brevo-tok"
		body = json.dumps([{"event": "click", "email": "isabella.marchetti@example.com", "camp_id": 901, "date": "2026-08-20 10:00:00"}, {"event": "delivered", "email": "nobody@example.com", "camp_id": 901}]).encode()
		frappe.set_user("Guest")
		self._with_request(body, {"X-Brevo-Token": "brevo-tok"})
		res = campaigns_api.webhook_brevo()
		self.assertEqual(res["recorded"], 1)
		self.assertEqual(res["unmatched"][0]["reason"], "customer")
		self.assertTrue(frappe.db.exists("Maison Campaign Touch", {"campaign": c.name, "source": "Brevo"}))


class TestEmployeePerformance(V05Base):
	def test_math(self):
		isabella = _customer("Isabella Marchetti")
		inv_client = self._sale(isabella, items=[{"item_code": "AC-012", "qty": 1, "rate": 300}], associate=NYC_ASSOCIATE)
		self._sale(None, items=[{"item_code": "AC-012", "qty": 1, "rate": 100}], associate=NYC_ASSOCIATE)
		self._sale(None, items=[{"item_code": "AC-012", "qty": 1, "rate": 600}], associate=NYC_ASSOCIATE_2)
		sales.void(inv_client, "test")
		# follow-ups: +2 assigned to a1 (one done) on top of whatever the demo seed created
		base = {r["associate"]: r for r in hr.employee_performance(boutique="NYC-5AV", from_date=nowdate(), to_date=nowdate())}[NYC_ASSOCIATE]
		frappe.get_doc({"doctype": "Maison Client Interaction", "customer": isabella, "type": "Follow-up", "associate": NYC_ASSOCIATE, "boutique": "NYC-5AV", "ts": now_datetime(), "follow_up_date": nowdate(), "status": "Done", "done_on": now_datetime()}).insert(ignore_permissions=True)
		frappe.get_doc({"doctype": "Maison Client Interaction", "customer": isabella, "type": "Follow-up", "associate": NYC_ASSOCIATE, "boutique": "NYC-5AV", "ts": now_datetime(), "follow_up_date": nowdate(), "status": "Open"}).insert(ignore_permissions=True)
		frappe.get_doc({"doctype": "Maison Biometric Consent", "customer": isabella, "status": "Active", "boutique": "NYC-5AV", "associate": NYC_ASSOCIATE, "captured_at": now_datetime(), "consent_text_version": "t", "method": "Hold-to-agree"}).insert(ignore_permissions=True)
		rows = {r["associate"]: r for r in hr.employee_performance(boutique="NYC-5AV", from_date=nowdate(), to_date=nowdate())}
		a1, a2 = rows[NYC_ASSOCIATE], rows[NYC_ASSOCIATE_2]
		self.assertEqual(a1["tickets"], 2)
		self.assertEqual(a1["with_client"], 1)
		self.assertEqual(a1["clients_identified_per_sale"], 0.5)
		self.assertEqual(a1["returns"], 1)
		self.assertEqual(a1["returns_rate"], 0.5)
		self.assertEqual(a1["returns_amount"], 300.0)
		self.assertEqual(a1["avg_ticket"], 200.0)  # gross (300 + 100) / 2
		self.assertEqual(a1["sales"], 100.0)  # net of the return
		# boutique avg ticket = net (returns netted) / tickets over every NYC POS invoice of the day (the dev site may hold others)
		net = frappe.db.get_value("Sales Invoice", {"docstatus": 1, "is_pos": 1, "maison_boutique": "NYC-5AV", "posting_date": nowdate()}, "sum(base_net_total)")
		tickets = frappe.db.count("Sales Invoice", {"docstatus": 1, "is_pos": 1, "is_return": 0, "maison_boutique": "NYC-5AV", "posting_date": nowdate()})
		self.assertAlmostEqual(a1["boutique_avg_ticket"], round(net / tickets, 2), places=2)
		self.assertAlmostEqual(a1["avg_ticket_vs_boutique"], round(200 / (net / tickets), 3), places=3)
		self.assertEqual(a1["follow_ups_assigned"], base["follow_ups_assigned"] + 2)
		self.assertEqual(a1["follow_ups_done"], base["follow_ups_done"] + 1)
		self.assertEqual(a1["follow_up_rate"], round(a1["follow_ups_done"] / a1["follow_ups_assigned"], 3))
		self.assertEqual(a1["recognition_enrolments"], base["recognition_enrolments"] + 1)
		self.assertEqual(a2["follow_up_rate"], None if not a2["follow_ups_assigned"] else round(a2["follow_ups_done"] / a2["follow_ups_assigned"], 3))
		self.assertEqual(a2["avg_ticket"], 600.0)

	def test_associate_cannot_call(self):
		frappe.set_user(NYC_ASSOCIATE)
		self.assertRaises(frappe.PermissionError, hr.employee_performance)


class TestAssignCall(V05Base):
	def _signal(self, boutique="NYC-5AV", preferred=NYC_ASSOCIATE):
		isabella = _customer("Isabella Marchetti")
		return frappe.get_doc({"doctype": "Maison Client Signal", "customer": isabella, "customer_name": "Isabella Marchetti", "boutique": boutique, "preferred_associate": preferred, "signal_type": "VIP lapsing", "priority": 80, "status": "Open", "week": "2026-W34", "reason": "test"}).insert(ignore_permissions=True)

	def test_hq_assigns_to_preferred_associate_and_creates_task(self):
		sig = self._signal()
		frappe.set_user(HQ)
		res = insights.assign_call(sig.name)
		self.assertEqual(res["associate"], NYC_ASSOCIATE)
		task = frappe.get_doc("Maison Client Interaction", res["task"])
		self.assertEqual((task.type, task.status, task.associate), ("Call", "Open", NYC_ASSOCIATE))
		sig.reload()
		self.assertEqual(sig.assigned_associate, NYC_ASSOCIATE)
		self.assertEqual(sig.call_task, task.name)
		if frappe.db.exists("DocType", "CRM Task"):
			self.assertTrue(res["crm_task"])
			self.assertEqual(frappe.db.get_value("CRM Task", res["crm_task"], "assigned_to"), NYC_ASSOCIATE)
		# re-assign to a2 cancels the first call
		res2 = insights.assign_call(sig.name, associate=NYC_ASSOCIATE_2)
		self.assertEqual(frappe.db.get_value("Maison Client Interaction", task.name, "status"), "Cancelled")
		self.assertEqual(frappe.db.get_value("Maison Client Interaction", res2["task"], "associate"), NYC_ASSOCIATE_2)
		# appears in the signal list payload
		row = next(r for r in insights.client_signals(boutique="NYC-5AV", limit=500)["signals"] if r["name"] == sig.name)
		self.assertEqual(row["assigned_associate"], NYC_ASSOCIATE_2)

	def test_scoping(self):
		sig = self._signal()
		frappe.set_user(CHI_ASSOCIATE)
		self.assertRaises(frappe.PermissionError, insights.assign_call, sig.name)
		frappe.set_user(NYC_ASSOCIATE_2)
		self.assertRaises(frappe.PermissionError, insights.assign_call, sig.name)  # may only assign to self
		self.assertEqual(insights.assign_call(sig.name, associate=NYC_ASSOCIATE_2)["associate"], NYC_ASSOCIATE_2)
		frappe.set_user(NYC_MANAGER)
		self.assertEqual(insights.assign_call(sig.name, associate=NYC_ASSOCIATE)["associate"], NYC_ASSOCIATE)
		self.assertRaises(frappe.PermissionError, insights.assign_call, sig.name, CHI_ASSOCIATE)

	def test_vip_lapsing_without_preferred_associate_falls_back_to_manager(self):
		from maison_pos.insights.client_signals import signal_owner

		self.assertEqual(signal_owner(None, "NYC-5AV", "VIP lapsing"), NYC_MANAGER)
		self.assertIsNone(signal_owner(None, "NYC-5AV", "Birthday"))
		sig = self._signal(preferred=None)
		frappe.set_user(HQ)
		self.assertEqual(insights.assign_call(sig.name)["associate"], NYC_MANAGER)
