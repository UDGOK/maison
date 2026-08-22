"""v0.4 H — insights: affinity lift math, churn / cadence, rebalance rule, narrative template,
recommendation endpoints (owned items excluded), one-click transfer, permissions."""

from __future__ import annotations

import datetime as _dt

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, flt, getdate, nowdate

from maison_pos.api import insights as api
from maison_pos.insights import affinity, client_signals, narrative, product_performance as perf
from maison_pos.tests.helpers import ensure_demo_data, first_serial, pos_invoice

NYC_ASSOCIATE = "nyc.5av.a1@maison.example"
NYC_MANAGER = "nyc.5av.manager@maison.example"
CHI_MANAGER = "chi.oak.manager@maison.example"
HQ = "hq@maison.example"


# ---------------------------------------------------------------------------
# pure math — no site data needed
# ---------------------------------------------------------------------------
class TestAffinityMath(FrappeTestCase):
	def setUp(self):
		# 10 baskets: A+B together 4×, A alone 2×, B alone 1×, C with A once, D alone 2×
		self.m = affinity.AffinityModel.from_baskets(
			[{"A", "B"}, {"A", "B"}, {"A", "B"}, {"A", "B"}, {"A"}, {"A"}, {"B"}, {"A", "C"}, {"D"}, {"D"}]
		)

	def test_support_confidence_lift(self):
		m = self.m
		self.assertEqual(m.n_baskets, 10)
		self.assertAlmostEqual(m.support("A"), 0.7)
		self.assertAlmostEqual(m.support("B"), 0.5)
		self.assertAlmostEqual(m.support("A", "B"), 0.4)
		self.assertAlmostEqual(m.confidence("A", "B"), 4 / 7)
		self.assertAlmostEqual(m.confidence("B", "A"), 0.8)
		# lift = 0.4 / (0.7 * 0.5) = 1.1428
		self.assertAlmostEqual(m.lift("A", "B"), 0.4 / (0.7 * 0.5), places=4)
		self.assertAlmostEqual(m.lift("B", "A"), m.lift("A", "B"))
		# A and C: 0.1 / (0.7 * 0.1) = 1.428 — rarer but "stronger"; D never co-occurs
		self.assertAlmostEqual(m.lift("A", "C"), 1 / 0.7, places=4)
		self.assertEqual(m.lift("A", "D"), 0.0)
		self.assertEqual(m.lift("A", "A"), 0.0)

	def test_partners_and_scoring_prefer_supported_pairs(self):
		partners = self.m.partners("A")
		codes = [p["item_code"] for p in partners]
		self.assertEqual(set(codes), {"B", "C"})
		# B has 4 pairs (full credit), C has one pair (1/3 credit): B must rank first
		self.assertEqual(codes[0], "B")
		scores = self.m.score_candidates({"A"})
		self.assertGreater(scores["B"]["score"], scores["C"]["score"])
		self.assertEqual(scores["B"]["because"], "A")
		self.assertNotIn("A", scores)
		self.assertNotIn("D", scores)
		# excluded (owned) candidates never surface
		self.assertNotIn("B", self.m.score_candidates({"A"}, exclude={"B"}))

	def test_weighted_baskets(self):
		m = affinity.AffinityModel()
		m.add_basket(["X", "Y"], weight=0.5)
		m.add_basket(["X"], weight=1.0)
		self.assertAlmostEqual(m.n_baskets, 1.5)
		self.assertAlmostEqual(m.support("X", "Y"), 0.5 / 1.5)
		self.assertAlmostEqual(m.confidence("X", "Y"), 0.5 / 1.5)


class TestClientSignalMath(FrappeTestCase):
	def test_cadence(self):
		d = getdate("2026-01-01")
		self.assertEqual(client_signals.cadence_days([d], fallback=60), 60.0)
		self.assertEqual(client_signals.cadence_days([d, add_days(d, 30), add_days(d, 60)]), 30.0)
		# duplicate visit dates count once
		self.assertEqual(client_signals.cadence_days([d, d, add_days(d, 10)]), 10.0)

	def test_churn_score_monotone_and_bounded(self):
		s0 = client_signals.churn_score(0, 30)
		s_half = client_signals.churn_score(15, 30)
		s1 = client_signals.churn_score(30, 30)
		s3 = client_signals.churn_score(90, 30)
		s10 = client_signals.churn_score(300, 30)
		self.assertEqual(s0, 0.0)
		self.assertLess(s0, s_half)
		self.assertLess(s_half, s1)
		self.assertAlmostEqual(s1, 0.2, places=4)
		self.assertLess(s1, s3)
		self.assertGreater(s3, 0.85)
		self.assertLess(s3, s10)
		self.assertLessEqual(s10, 1.0)
		self.assertEqual(client_signals.churn_score(100, 0), 0.0)

	def test_spend_trend_and_days_until(self):
		self.assertEqual(client_signals.spend_trend(0, 0), 0.0)
		self.assertEqual(client_signals.spend_trend(100, 0), 1.0)
		self.assertEqual(client_signals.spend_trend(0, 100), -1.0)
		self.assertAlmostEqual(client_signals.spend_trend(50, 100), -0.5)
		today = getdate("2026-08-22")
		self.assertEqual(client_signals.days_until(getdate("1990-08-22"), today), 0)
		self.assertEqual(client_signals.days_until(getdate("1990-09-01"), today), 10)
		self.assertEqual(client_signals.days_until(getdate("1990-08-21"), today), 364)
		self.assertIsNone(client_signals.days_until(None, today))

	def test_classify_picks_most_urgent(self):
		today = getdate("2026-08-22")
		base = {"cadence_days": 30.0, "visits": 5, "lifetime_spend": 8_000.0, "spend_trend": 0.0, "spend_prev": 0.0}
		overdue = client_signals.classify({**base, "last_visit": add_days(today, -95)}, today)
		self.assertEqual(overdue["signal_type"], "Overdue visit")
		self.assertGreater(overdue["churn_risk"], 0.8)
		vip = client_signals.classify({**base, "lifetime_spend": 120_000.0, "last_visit": add_days(today, -95)}, today)
		self.assertEqual(vip["signal_type"], "VIP lapsing")
		self.assertGreater(vip["priority"], overdue["priority"])
		due = client_signals.classify({**base, "last_visit": add_days(today, -28)}, today)
		self.assertEqual(due["signal_type"], "Due this week")
		bday = client_signals.classify({**base, "last_visit": add_days(today, -5), "days_to_birthday": 3}, today)
		self.assertEqual(bday["signal_type"], "Birthday")
		# birthday beats an overdue visit
		both = client_signals.classify({**base, "last_visit": add_days(today, -95), "days_to_birthday": 3}, today)
		self.assertEqual(both["signal_type"], "Birthday")
		self.assertIsNone(client_signals.classify({**base, "last_visit": add_days(today, -3)}, today))


class TestRebalanceMath(FrappeTestCase):
	def test_metrics(self):
		m = perf.metrics(units=18, on_hand=6, days=90)
		self.assertAlmostEqual(m["velocity"], 1.4)  # 18/90*7
		self.assertAlmostEqual(m["days_on_hand"], 30.0)
		self.assertAlmostEqual(m["sell_through"], 0.75)
		self.assertFalse(m["stock_out_risk"])  # 6 on hand covers 30 days > 21
		risky = perf.metrics(units=18, on_hand=2, days=90)
		self.assertTrue(risky["stock_out_risk"])
		dead = perf.metrics(units=0, on_hand=4, days=90)
		self.assertIsNone(dead["days_on_hand"])
		self.assertEqual(dead["velocity"], 0.0)

	def test_suggest_moves_from_slow_to_fast(self):
		rows = [
			{"item_code": "AC-001", "boutique": "NYC", "units": 27, "on_hand": 1, "rate": 2400},  # fast, nearly out
			{"item_code": "AC-001", "boutique": "CHI", "units": 0, "on_hand": 8, "rate": 2400},  # dead stock
			{"item_code": "AC-001", "boutique": "MIA", "units": 9, "on_hand": 6, "rate": 2400},  # healthy
			{"item_code": "AC-002", "boutique": "NYC", "units": 10, "on_hand": 10, "rate": 3100},  # fine everywhere
			{"item_code": "AC-002", "boutique": "CHI", "units": 10, "on_hand": 10, "rate": 3100},
		]
		out = perf.suggest_rebalances(rows, days=90)
		self.assertEqual(len(out), 1)
		s = out[0]
		self.assertEqual((s["item_code"], s["from_boutique"], s["to_boutique"]), ("AC-001", "CHI", "NYC"))
		# NYC sells 0.3/day → needs ceil(0.3*21*1.5)=10 minus 1 on hand = 9; CHI can spare all 8
		self.assertEqual(s["qty"], 8)
		self.assertEqual(s["value"], 8 * 2400)
		self.assertIn("no sales", s["reason"])

	def test_keeps_cover_at_the_slow_store_and_respects_min_value(self):
		rows = [
			{"item_code": "AC-012", "boutique": "NYC", "units": 60, "on_hand": 2, "rate": 160},
			{"item_code": "AC-012", "boutique": "CHI", "units": 1, "on_hand": 40, "rate": 160},  # ~3600 days of cover
		]
		out = perf.suggest_rebalances(rows, days=90)
		self.assertEqual(len(out), 1)
		# CHI keeps ceil(1/90*45)=1, NYC needs ceil(60/90*21*1.5)=21 - 2 = 19
		self.assertEqual(out[0]["qty"], 19)
		tiny = [
			{"item_code": "AC-012", "boutique": "NYC", "units": 3, "on_hand": 0, "rate": 160},
			{"item_code": "AC-012", "boutique": "CHI", "units": 0, "on_hand": 1, "rate": 160},
		]
		self.assertEqual(perf.suggest_rebalances(tiny, days=90), [])  # 1 × 160 < MIN_MOVE_VALUE


class TestNarrativeTemplate(FrappeTestCase):
	def test_template_mentions_every_block(self):
		numbers = {
			"currency": "USD",
			"period": {"from": "2026-08-10", "to": "2026-08-16", "days": 7},
			"chain": {"net": 250_000, "prev_net": 200_000, "change_pct": 25.0, "invoices": 40, "avg_ticket": 6_250, "card_share": 0.82, "returns": 1, "returns_value": 1_200},
			"boutiques": [
				{"boutique": "NYC-5AV", "name": "Maison Fifth Avenue", "net": 150_000, "invoices": 22, "change_pct": 40.0},
				{"boutique": "CHI-OAK", "name": "Maison Oak Street", "net": 100_000, "invoices": 18, "change_pct": -10.0},
			],
			"top_items": [{"item_name": "Meridian Automatic 40mm Steel", "units": 3, "revenue": 20_700}],
			"client_signals": {"Overdue visit": 4, "Birthday": 1},
			"rebalance": [frappe._dict(item_name="Silk Pocket Square", from_boutique="CHI-OAK", to_boutique="NYC-5AV", qty=6, value=960)],
			"new_clients": 2,
		}
		text = narrative.template_narrative(numbers)
		self.assertIn("250,000", text)
		self.assertIn("up strongly (+25%)", text)
		self.assertIn("Maison Fifth Avenue led the week", text)
		self.assertIn("down -10%", text)
		self.assertIn("Meridian Automatic", text)
		self.assertIn("5 clients to contact", text)
		self.assertIn("4 overdue visit", text)
		self.assertIn("6 × Silk Pocket Square from CHI-OAK to NYC-5AV", text)
		self.assertIn("2 new clients", text)
		self.assertIn("1 return was processed", text)
		self.assertNotIn("<", text)  # plain text, no markup

	def test_llm_config_only_with_key(self):
		saved = dict(frappe.conf)
		try:
			frappe.conf.pop("anthropic_api_key", None)
			self.assertIsNone(narrative.llm_config())
			frappe.conf["anthropic_api_key"] = "sk-test"
			self.assertEqual(narrative.llm_config()["model"], narrative.DEFAULT_MODEL)
			frappe.conf["anthropic_model"] = "claude-x"
			self.assertEqual(narrative.llm_config()["model"], "claude-x")
			frappe.conf["insights_narrative_llm"] = 0
			self.assertIsNone(narrative.llm_config())
		finally:
			frappe.conf.clear()
			frappe.conf.update(saved)


# ---------------------------------------------------------------------------
# with demo data
# ---------------------------------------------------------------------------
class InsightsTestCase(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.local._maison_affinity = None

	def tearDown(self):
		frappe.set_user("Administrator")

	def _receive(self, item_code, boutique, qty, days_ago=220, serial=None):
		"""Back-dated opening stock so back-dated test sales never drive a bin negative."""
		from maison_pos.setup.demo import _stock_entry_doc

		warehouse = frappe.db.get_value("Maison Boutique", boutique, "warehouse")
		row = {"item_code": item_code, "qty": qty, "t_warehouse": warehouse, "basic_rate": 100}
		if serial:
			row.update({"use_serial_batch_fields": 1, "serial_no": serial})
		se = _stock_entry_doc(warehouse, [row], add_days(nowdate(), -days_ago), "08:00:00")
		se.insert()
		se.submit()
		return se.name

	def _sell(self, customer, items, boutique="NYC-5AV", days_ago=0):
		from maison_pos.api.sales import submit_batch

		# cash tender, rounded up: the server accepts cash overpayment (change), card must match to the cent
		net = sum(flt(i["rate"]) * flt(i.get("qty", 1)) for i in items)
		payload = pos_invoice(boutique=boutique, items=items, customer=customer, payments=[{"mode_of_payment": "Cash", "amount": round(net * 1.11 + 1, 2)}])
		payload["posting_datetime"] = (frappe.utils.now_datetime() - _dt.timedelta(days=days_ago)).isoformat()
		res = submit_batch([payload])["results"][0]
		self.assertEqual(res["status"], "ok", res)
		return res["invoice_name"]


class TestRecommendations(InsightsTestCase):
	def test_client_recommendations_exclude_owned_items(self):
		from maison_pos.setup.demo import ensure_customer

		# a dedicated client: the demo clients carry real purchase history on seeded sites (seed_history),
		# so "owns exactly these two items" must not depend on the site's state
		customer = ensure_customer("Insights Owned Test", "+1 212 555 0199", "insights.owned@test.example", loyalty=False)
		# the commit-free test transaction is rolled back by FrappeTestCase; invoices from earlier runs are impossible
		self.assertEqual(affinity.owned_items(customer), set())
		# chains are bought with pendants (4 baskets); Isabella owns the chain
		for other in ("Jonathan Whitfield", "Amara Okonkwo", "Sebastian Laurent", "Priya Raghavan"):
			self._sell(other, [{"item_code": "AC-001", "qty": 1, "rate": 2400}, {"item_code": "AC-003", "qty": 1, "rate": 1850}])
		self._sell(customer, [{"item_code": "AC-001", "qty": 1, "rate": 2400}])
		self._sell(customer, [{"item_code": "AC-012", "qty": 2, "rate": 160}])

		owned = affinity.owned_items(customer)
		self.assertEqual(owned, {"AC-001", "AC-012"})

		frappe.set_user(NYC_ASSOCIATE)
		out = api.recommend_for_client(customer, n=3)
		codes = [r["item_code"] for r in out["items"]]
		self.assertTrue(codes, out)
		self.assertNotIn("AC-001", codes)
		self.assertNotIn("AC-012", codes)
		self.assertEqual(codes[0], "AC-003", out)  # strongest lift partner of the chain
		self.assertEqual(out["items"][0]["because"], "AC-001")
		self.assertIn("in_stock", out["items"][0])
		self.assertTrue(all(c in out["owned"] for c in ("AC-001", "AC-012")))

	def test_basket_recommendations(self):
		for other in ("Jonathan Whitfield", "Amara Okonkwo", "Sebastian Laurent"):
			self._sell(other, [{"item_code": "AC-005", "qty": 1, "rate": 3600}, {"item_code": "AC-011", "qty": 1, "rate": 380}])
		frappe.set_user(NYC_ASSOCIATE)
		out = api.recommend_for_basket(["AC-005"], n=3, boutique="NYC-5AV")
		codes = [r["item_code"] for r in out["items"]]
		self.assertNotIn("AC-005", codes)
		self.assertEqual(codes[0], "AC-011")
		self.assertEqual(api.recommend_for_basket([], n=3)["items"], [])
		# a client's owned items are not proposed as pairings either
		self._sell("Mei-Lin Chen", [{"item_code": "AC-011", "qty": 1, "rate": 380}])
		frappe.set_user(NYC_ASSOCIATE)
		out = api.recommend_for_basket(["AC-005"], n=3, customer="Mei-Lin Chen")
		self.assertNotIn("AC-011", [r["item_code"] for r in out["items"]])

	def test_weekly_cache_is_used_and_never_contains_owned_items(self):
		customer = "Lucas Dubois"
		for other in ("Jonathan Whitfield", "Amara Okonkwo", "Sebastian Laurent"):
			self._sell(other, [{"item_code": "TP-001", "qty": 1, "rate": 6900, "serial_no": first_serial("TP-001", "NYC-5AV")}, {"item_code": "AC-010", "qty": 1, "rate": 420}])
		self._sell(customer, [{"item_code": "TP-001", "qty": 1, "rate": 6900, "serial_no": first_serial("TP-001", "NYC-5AV")}])
		res = affinity.compute_client_recommendations(n=3)
		self.assertGreater(res["recommendations"], 0)
		rows = frappe.get_all("Maison Client Recommendation", filters={"customer": customer}, fields=["item_code", "rank"], order_by="rank")
		self.assertTrue(rows)
		self.assertNotIn("TP-001", [r.item_code for r in rows])
		self.assertEqual(rows[0].item_code, "AC-010")
		out = api.recommend_for_client(customer, n=3)
		self.assertEqual(out["source"], "cache")
		self.assertEqual(out["items"][0]["item_code"], "AC-010")


class TestSignalsAndJobs(InsightsTestCase):
	def test_signals_for_lapsed_client_and_scoping(self):
		customer = "Hannah Rosenthal"  # CHI client in the seed
		self._receive("AC-008", "CHI-OAK", 10)
		for days in (200, 170, 140, 110):
			self._sell(customer, [{"item_code": "AC-008", "qty": 1, "rate": 690}], boutique="CHI-OAK", days_ago=days)
		stats = client_signals.client_stats()
		s = stats[customer]
		self.assertEqual(s["visits"], 4)
		self.assertAlmostEqual(s["cadence_days"], 30.0)
		self.assertEqual(s["preferred_boutique"], "CHI-OAK")
		self.assertEqual(s["preferred_department"], "Accessories")
		res = client_signals.compute_client_signals()
		self.assertGreaterEqual(res["signals"], 1)
		row = frappe.get_value("Maison Client Signal", {"customer": customer}, ["signal_type", "boutique", "churn_risk", "status"], as_dict=True)
		self.assertIsNotNone(row)
		self.assertEqual(row.signal_type, "Overdue visit")
		self.assertEqual(row.boutique, "CHI-OAK")
		self.assertGreater(row.churn_risk, 0.8)

		# CHI manager sees it, NYC associate does not (boutique scoping)
		frappe.set_user(CHI_MANAGER)
		mine = api.client_signals()
		self.assertIn(customer, [r.customer for r in mine["signals"]])
		frappe.set_user(NYC_ASSOCIATE)
		theirs = api.client_signals()
		self.assertNotIn(customer, [r.customer for r in theirs["signals"]])
		with self.assertRaises(frappe.PermissionError):
			api.client_signals(boutique="CHI-OAK")

		# mark contacted, then a recompute keeps it out of the open list
		frappe.set_user(CHI_MANAGER)
		name = mine["signals"][0].name if mine["signals"][0].customer == customer else next(r.name for r in mine["signals"] if r.customer == customer)
		api.mark_signal(name, "Contacted", note="Called about the new collar")
		self.assertEqual(frappe.db.get_value("Maison Client Signal", name, "contacted_by"), CHI_MANAGER)
		frappe.set_user("Administrator")
		client_signals.compute_client_signals()
		self.assertFalse(frappe.db.exists("Maison Client Signal", {"customer": customer, "status": "Open"}))

	def test_compute_and_narrative_report(self):
		self._sell("Isabella Marchetti", [{"item_code": "AC-008", "qty": 1, "rate": 690}], days_ago=3)
		frappe.set_user(HQ)
		out = api.compute(narrative=1)
		self.assertIn("affinity", out)
		self.assertIn("signals", out)
		self.assertIn("rebalance", out)
		self.assertEqual(out["narrative"]["generator"], "Template")
		doc = frappe.get_doc("Maison Insight Report", out["narrative"]["report"])
		self.assertIn("the chain took", doc.narrative)
		self.assertTrue(doc.numbers)
		latest = api.narrative()
		self.assertEqual(latest["name"], doc.name)
		# rerun for the same period updates in place (one report per period)
		again = api.compute(narrative=1)
		self.assertEqual(again["narrative"]["report"], doc.name)
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(frappe.PermissionError):
			api.compute()


class TestRebalance(InsightsTestCase):
	def test_performance_and_one_click_transfer(self):
		# NYC sells lots of AC-012 (runs low), CHI sells none: expect CHI -> NYC
		nyc_wh = frappe.db.get_value("Maison Boutique", "NYC-5AV", "warehouse")
		chi_wh = frappe.db.get_value("Maison Boutique", "CHI-OAK", "warehouse")
		self._receive("AC-012", "NYC-5AV", 40)
		self._receive("AC-012", "CHI-OAK", 120)  # Chicago sits on a pile it will not sell for months
		start_nyc = flt(frappe.db.get_value("Bin", {"item_code": "AC-012", "warehouse": nyc_wh}, "actual_qty"))
		for i in range(12):
			self._sell(None, [{"item_code": "AC-012", "qty": 3, "rate": 160}], days_ago=i * 5)
		# ... and New York sells down to its last two squares today
		left = flt(frappe.db.get_value("Bin", {"item_code": "AC-012", "warehouse": nyc_wh}, "actual_qty"))
		if left > 2:
			self._sell(None, [{"item_code": "AC-012", "qty": int(left - 2), "rate": 160}])
		data = perf.product_performance(90, ["NYC-5AV", "CHI-OAK", "MIA-DD"])
		row = next(r for r in data["items"] if r["item_code"] == "AC-012" and r["boutique"] == "NYC-5AV")
		self.assertGreaterEqual(row["units"], start_nyc - 2)
		self.assertAlmostEqual(row["on_hand"], 2)
		self.assertTrue(row["stock_out_risk"])
		chi = next(r for r in data["items"] if r["item_code"] == "AC-012" and r["boutique"] == "CHI-OAK")
		self.assertTrue(chi["days_on_hand"] is None or chi["days_on_hand"] >= perf.SLOW_DOH)
		self.assertTrue(any(h["item_group"] == "Accessories" and h["boutique"] == "NYC-5AV" and h["revenue"] > 0 for h in data["heatmap"]))
		top = data["top_movers"]["NYC-5AV"]
		self.assertTrue(top)
		self.assertEqual([r["revenue"] for r in top], sorted([r["revenue"] for r in top], reverse=True))
		self.assertTrue(all(r["units"] > 0 for r in top))
		move = next((s for s in data["rebalance"] if s["item_code"] == "AC-012" and s["to_boutique"] == "NYC-5AV"), None)
		self.assertIsNotNone(move, data["rebalance"])
		self.assertIn(move["from_boutique"], ("CHI-OAK", "MIA-DD"))
		self.assertGreater(move["qty"], 0)
		self.assertTrue(any(s["from_boutique"] == "CHI-OAK" for s in data["rebalance"] if s["item_code"] == "AC-012"))

		res = perf.compute_rebalance_suggestions(90)
		self.assertGreater(res["suggestions"], 0)
		name = frappe.db.get_value("Maison Rebalance Suggestion", {"item_code": "AC-012", "to_boutique": "NYC-5AV", "status": "Open"}, "name")
		self.assertTrue(name)
		sug = frappe.get_doc("Maison Rebalance Suggestion", name)

		# associates cannot, a manager of an unrelated boutique cannot, the destination manager can
		frappe.set_user(NYC_ASSOCIATE)
		with self.assertRaises(frappe.PermissionError):
			api.product_performance(90)
		with self.assertRaises(frappe.PermissionError):
			api.create_transfer(name)
		other = "mia.dd.manager@maison.example" if sug.from_boutique == "CHI-OAK" else CHI_MANAGER
		frappe.set_user(other)
		with self.assertRaises(frappe.PermissionError):
			api.create_transfer(name)
		frappe.set_user(NYC_MANAGER)
		listed = api.rebalance_suggestions()
		self.assertTrue(any(s.name == name and s.can_transfer for s in listed["suggestions"]))
		from_wh = chi_wh if sug.from_boutique == "CHI-OAK" else frappe.db.get_value("Maison Boutique", "MIA-DD", "warehouse")
		before_from = flt(frappe.db.get_value("Bin", {"item_code": "AC-012", "warehouse": from_wh}, "actual_qty"))
		before_to = flt(frappe.db.get_value("Bin", {"item_code": "AC-012", "warehouse": nyc_wh}, "actual_qty"))
		out = api.create_transfer(name)
		self.assertTrue(out["ok"])
		se = frappe.get_doc("Stock Entry", out["stock_entry"])
		self.assertEqual(se.docstatus, 1)
		self.assertEqual(se.purpose, "Material Transfer")
		self.assertEqual(flt(frappe.db.get_value("Bin", {"item_code": "AC-012", "warehouse": from_wh}, "actual_qty")), before_from - sug.qty)
		self.assertEqual(flt(frappe.db.get_value("Bin", {"item_code": "AC-012", "warehouse": nyc_wh}, "actual_qty")), before_to + sug.qty)
		self.assertEqual(frappe.db.get_value("Maison Rebalance Suggestion", name, "status"), "Transferred")
		with self.assertRaises(frappe.ValidationError):
			api.create_transfer(name)  # already transferred

	def test_serialized_transfer_moves_a_serial(self):
		sn = first_serial("TP-005", "CHI-OAK")
		if not sn:
			# e2e runs sell the demo one-offs through on a shared site: receive a fresh piece (rolled back)
			self._receive("TP-005", "CHI-OAK", 1, days_ago=1, serial=f"TP-005-CHI-T{frappe.generate_hash(length=4).upper()}")
			sn = first_serial("TP-005", "CHI-OAK")
		self.assertTrue(sn)
		sug = frappe.get_doc(
			{
				"doctype": "Maison Rebalance Suggestion",
				"item_code": "TP-005",
				"item_name": "Corsaire Chronograph Titanium",
				"has_serial_no": 1,
				"from_boutique": "CHI-OAK",
				"to_boutique": "NYC-5AV",
				"qty": 1,
				"value": 12800,
				"status": "Open",
				"reason": "test",
			}
		).insert()
		frappe.set_user(HQ)
		out = api.create_transfer(sug.name)
		self.assertEqual(len(out["serial_nos"]), 1)
		nyc_wh = frappe.db.get_value("Maison Boutique", "NYC-5AV", "warehouse")
		self.assertEqual(frappe.db.get_value("Serial No", out["serial_nos"][0], "warehouse"), nyc_wh)

	def test_dismiss(self):
		# (a dismissed pair is remembered by the weekly job — keep this one distinct from the transfer test)
		sug = frappe.get_doc({"doctype": "Maison Rebalance Suggestion", "item_code": "AC-011", "item_name": "Travel Jewellery Case", "from_boutique": "MIA-DD", "to_boutique": "CHI-OAK", "qty": 2, "value": 760, "status": "Open", "reason": "test"}).insert()
		frappe.set_user(CHI_MANAGER)
		self.assertEqual(api.dismiss_suggestion(sug.name, "keeping for the trunk show")["status"], "Dismissed")
		self.assertIn("trunk show", frappe.db.get_value("Maison Rebalance Suggestion", sug.name, "reason"))
