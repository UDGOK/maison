"""v0.5 L — Command dashboard: trend math, precomputed trends, live_summary correctness with
returns, cache behaviour, realtime payload fields, scoping, and the performance budget
(live_summary < 150 ms, product_trends < 100 ms on the seeded 3-boutique site)."""

from __future__ import annotations

import time

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, flt, getdate, nowdate

from maison_pos.api import dashboard as api
from maison_pos.api.sales import submit_batch
from maison_pos.insights import trends
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice
from maison_pos.utils import invoice_summary

CHI_MANAGER = "chi.oak.manager@maison.example"
HQ = "hq@maison.example"


# ---------------------------------------------------------------------------
# pure math — no site data needed
# ---------------------------------------------------------------------------
class TestTrendMath(FrappeTestCase):
	def test_pct_change(self):
		self.assertEqual(trends.pct_change(10, 8), 25.0)
		self.assertEqual(trends.pct_change(4, 8), -50.0)
		self.assertIsNone(trends.pct_change(4, 0))

	def test_metrics_velocity_cover_and_sell_through(self):
		m = trends.trend_metrics(units=14, units_prev=7, units_4p=28, on_hand=10, days=7)
		self.assertEqual(m["velocity"], 14.0)  # 14 units in 7 days = 14 / week
		self.assertEqual(m["units_baseline"], 7.0)  # 28 over four 7-day windows
		self.assertEqual(m["delta_pct"], 100.0)
		self.assertEqual(m["baseline_delta_pct"], 100.0)
		self.assertEqual(m["days_on_hand"], 5.0)  # 10 on hand / 2 per day
		self.assertAlmostEqual(m["sell_through"], 14 / 24, places=4)
		self.assertEqual(m["badge"], "Trending up")

	def test_metrics_28d_period(self):
		m = trends.trend_metrics(units=8, units_prev=8, units_4p=40, on_hand=0, days=28)
		self.assertEqual(m["velocity"], 2.0)
		self.assertEqual(m["days_on_hand"], 0.0)  # selling, nothing on hand
		self.assertIsNone(trends.trend_metrics(0, 8, 40, 5, 28)["days_on_hand"])  # nothing selling → ∞
		self.assertEqual(m["delta_pct"], 0.0)
		self.assertEqual(m["badge"], "Steady")

	def test_badges(self):
		# new: this period only
		self.assertEqual(trends.badge_for(3, 0, 0.75, 0), "New")
		# sold before the previous period but not in it: not new, not trending without a previous period
		self.assertEqual(trends.badge_for(1, 0, 1.0, 3), "Steady")
		# ≥ 2 units, no previous period, well above baseline → trending
		self.assertEqual(trends.badge_for(4, 0, 1.25, 1), "Trending up")
		# up 25 % on the previous period AND the baseline
		self.assertEqual(trends.badge_for(5, 4, 4.0, 11), "Trending up")
		# up on the previous period but below baseline (a rebound, not a trend)
		self.assertEqual(trends.badge_for(5, 4, 8.0, 27), "Steady")
		# cooling: −25 % with a meaningful previous period
		self.assertEqual(trends.badge_for(3, 4, 4.0, 13), "Cooling")
		self.assertEqual(trends.badge_for(0, 4, 2.0, 8), "Cooling")
		# one-offs never trend
		self.assertEqual(trends.badge_for(1, 0, 0.5, 1), "Steady")
		self.assertEqual(trends.badge_for(0, 1, 0.25, 1), "Steady")

	def test_build_rows_ranks_shares_and_store_counts(self):
		sales = [
			{"item_code": "A", "boutique": "X", "u7": 4, "n7": 400, "u7p": 2, "n7p": 200, "u28": 10, "n28": 1000, "u28p": 8, "n28p": 800, "u112": 30},
			{"item_code": "A", "boutique": "Y", "u7": 1, "n7": 100, "u7p": 0, "n7p": 0, "u28": 1, "n28": 100, "u28p": 0, "n28p": 0, "u112": 1},
			{"item_code": "B", "boutique": "X", "u7": 1, "n7": 600, "u7p": 1, "n7p": 600, "u28": 2, "n28": 1200, "u28p": 3, "n28p": 1800, "u112": 9},
		]
		stock = {("A", "X"): 6.0, ("A", "Y"): 2.0, ("B", "X"): 1.0}
		meta = {"A": {"item_name": "Alpha", "item_group": "G1"}, "B": {"item_name": "Beta", "item_group": "G2"}}
		rows = trends.build_rows(sales, stock, meta, today="2026-08-22")
		by = {(r["item_code"], r["boutique"], r["period"]): r for r in rows}
		# per-boutique 7d ranks by net: B (600) before A (400) at X
		self.assertEqual(by[("B", "X", "7d")]["rank"], 1)
		self.assertEqual(by[("A", "X", "7d")]["rank"], 2)
		self.assertEqual(by[("A", "X", "7d")]["rank_units"], 1)
		self.assertEqual(by[("A", "X", "7d")]["share_pct"], 40.0)
		# chain-wide ALL row sums both boutiques and counts stores selling in the window
		a_all = by[("A", "ALL", "7d")]
		self.assertEqual(a_all["units"], 5.0)
		self.assertEqual(a_all["net"], 500.0)
		self.assertEqual(a_all["store_count"], 2)
		self.assertEqual(a_all["on_hand"], 8.0)
		self.assertEqual(by[("A", "ALL", "28d")]["store_count"], 2)
		self.assertEqual(by[("B", "ALL", "7d")]["store_count"], 1)
		# A at Y sold only this week → New
		self.assertEqual(by[("A", "Y", "7d")]["badge"], "New")
		self.assertEqual(str(a_all["period_from"]), "2026-08-16")
		# both periods emitted for every key
		self.assertEqual(len(rows), 2 * (3 + 2))


# ---------------------------------------------------------------------------
# site-backed
# ---------------------------------------------------------------------------
class TestTrendsAndLive(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		frappe.set_user("Administrator")

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.cache.delete_keys(api.LIVE_CACHE_PREFIX)
		trends.clear_cache()

	def tearDown(self):
		frappe.set_user("Administrator")

	# --- precomputed trends ----------------------------------------------------------------
	def test_compute_trends_matches_invoice_lines(self):
		out = trends.compute_trends(commit=False)
		self.assertGreater(out["rows"], 0)
		today = getdate(nowdate())
		row = frappe.get_all("Maison Product Trend", filters={"boutique": "ALL", "period": "28d"}, fields=["item_code", "units", "net", "store_count"], order_by="net desc", limit=1)[0]
		expected = frappe.db.sql(
			"""select sum(sii.qty), sum(sii.amount), count(distinct si.maison_boutique) from `tabSales Invoice Item` sii
			join `tabSales Invoice` si on si.name = sii.parent
			where si.docstatus = 1 and si.is_pos = 1 and sii.item_code = %s and si.posting_date between %s and %s and sii.qty <> 0""",
			(row.item_code, add_days(today, -27), today),
		)[0]
		self.assertAlmostEqual(flt(row.units), flt(expected[0]), places=3)
		self.assertAlmostEqual(flt(row.net), flt(expected[1]), places=2)
		# ranks are dense per (boutique, period)
		ranks = sorted(frappe.get_all("Maison Product Trend", filters={"boutique": "ALL", "period": "28d"}, pluck="rank"))
		self.assertEqual(ranks, list(range(1, len(ranks) + 1)))

	def test_product_trends_and_top_products_read_precomputed_rows(self):
		trends.compute_trends(commit=False)
		res = api.product_trends(period="7d", limit=10)
		self.assertEqual(res["boutique"], "ALL")
		self.assertLessEqual(len(res["rows"]), 10)
		self.assertIn("badges", res)
		# rows with a previous period come first, sorted by delta
		deltas = [r["delta_pct"] for r in res["rows"] if r["delta_pct"] is not None]
		self.assertEqual(deltas, sorted(deltas, reverse=True))
		# group filter
		g = res["groups"][0]
		self.assertTrue(all(r["item_group"] == g for r in api.product_trends(period="7d", group=g)["rows"]))
		top = api.top_products(boutique="all", by="net", period="28d", n=5)
		self.assertEqual(set(top["top"]), set(top["boutiques"]))
		for code, rows in top["top"].items():
			self.assertLessEqual(len(rows), 5)
			self.assertEqual([r["rank"] for r in rows], list(range(1, len(rows) + 1)))
			self.assertTrue(all(r["boutique"] == code for r in rows))
		self.assertTrue(top["matrix"])
		self.assertIn("item_group", top["matrix"][0])
		by_units = api.top_products(boutique="CHI-OAK", by="units", period="28d", n=3)
		self.assertEqual([r["rank_units"] for r in by_units["top"]["CHI-OAK"]], list(range(1, len(by_units["top"]["CHI-OAK"]) + 1)))
		with self.assertRaises(frappe.ValidationError):
			api.product_trends(period="3d")

	def test_scoped_manager_only_sees_own_boutique(self):
		trends.compute_trends(commit=False)
		frappe.set_user(CHI_MANAGER)
		res = api.product_trends(period="7d")
		self.assertEqual(res["boutique"], "CHI-OAK")
		with self.assertRaises(frappe.PermissionError):
			api.product_trends(scope="boutique", boutique="NYC-5AV", period="7d")
		top = api.top_products(boutique="all", period="7d")
		self.assertEqual(top["boutiques"], ["CHI-OAK"])
		live = api.live_summary(nocache=1)
		self.assertEqual([b["boutique"] for b in live["by_boutique"]], ["CHI-OAK"])
		with self.assertRaises(frappe.PermissionError):
			api.boutique_detail("NYC-5AV")

	# --- live summary -------------------------------------------------------------------------
	def test_live_summary_nets_returns_and_reports_last_sale(self):
		before = api.live_summary(nocache=1)
		chi_before = next(b for b in before["by_boutique"] if b["boutique"] == "CHI-OAK")
		res = submit_batch([pos_invoice("CHI-OAK", items=[{"item_code": "AC-012", "qty": 2, "rate": 160}], payments=[{"mode_of_payment": "Cash", "amount": 352.80}])])
		self.assertEqual(res["results"][0]["status"], "ok")
		inv = res["results"][0]["invoice_name"]
		gt = flt(frappe.db.get_value("Sales Invoice", inv, "grand_total"))
		mid = api.live_summary(nocache=1)
		chi = next(b for b in mid["by_boutique"] if b["boutique"] == "CHI-OAK")
		self.assertEqual(chi["invoices"], chi_before["invoices"] + 1)
		self.assertAlmostEqual(chi["net"], chi_before["net"] + gt, places=2)
		self.assertAlmostEqual(chi["cash"], chi_before["cash"] + 352.80, places=2)
		self.assertEqual(chi["last_sale"]["invoice"], inv)
		self.assertEqual(chi["last_sale"]["item"], "Silk Pocket Square")
		self.assertAlmostEqual(chi["last_sale"]["amount"], gt, places=2)
		self.assertIn("vs_last_week_pct", chi)
		self.assertIn("region", chi)
		self.assertEqual(len(chi["by_hour"]), 24)
		self.assertAlmostEqual(sum(chi["by_hour"]), chi["net"], places=2)
		# return one unit → net drops, invoices unchanged, returns +1
		from maison_pos.api.returns import return_items

		frappe.set_user("Administrator")
		ret = return_items(inv, [{"item_code": "AC-012", "qty": 1, "reason": "Change of mind", "condition": "Sellable"}], refund_method="cash")
		credit = ret.get("credit_note") or ret.get("return_invoice") or ret.get("name")
		credit_total = flt(frappe.db.get_value("Sales Invoice", credit, "grand_total"))
		self.assertLess(credit_total, 0)
		after = api.live_summary(nocache=1)
		chi_after = next(b for b in after["by_boutique"] if b["boutique"] == "CHI-OAK")
		self.assertEqual(chi_after["invoices"], chi["invoices"])
		self.assertEqual(chi_after["returns"], chi["returns"] + 1)
		self.assertAlmostEqual(chi_after["net"], chi["net"] + credit_total, places=2)
		self.assertAlmostEqual(chi_after["returns_value"], chi["returns_value"] + abs(credit_total), places=2)
		self.assertAlmostEqual(after["totals"]["net"], sum(b["net"] for b in after["by_boutique"]), places=2)
		self.assertEqual(after["totals"]["returns"], sum(b["returns"] for b in after["by_boutique"]))
		# the credit note is now the boutique's last sale (flagged as a return)
		self.assertEqual(chi_after["last_sale"]["invoice"], credit)
		self.assertEqual(chi_after["last_sale"]["is_return"], 1)

	def test_live_summary_is_cached_and_invalidated_by_a_sale(self):
		first = api.live_summary()
		self.assertFalse(first["cached"])
		second = api.live_summary()
		self.assertTrue(second["cached"])
		self.assertEqual(second["generated_at"], first["generated_at"])
		submit_batch([pos_invoice("CHI-OAK")])
		third = api.live_summary()
		self.assertFalse(third["cached"])  # publish_sale cleared the key
		chi_first = next(b for b in first["by_boutique"] if b["boutique"] == "CHI-OAK")
		chi_third = next(b for b in third["by_boutique"] if b["boutique"] == "CHI-OAK")
		self.assertEqual(chi_third["invoices"], chi_first["invoices"] + 1)

	def test_realtime_payload_has_command_fields(self):
		customer = frappe.get_all("Customer", filters={"loyalty_program": ("is", "set")}, pluck="name", limit=1)
		res = submit_batch([pos_invoice("CHI-OAK", items=[{"item_code": "AC-012", "qty": 1, "rate": 160}, {"item_code": "AC-011", "qty": 1, "rate": 380}], customer=customer[0] if customer else None)])
		doc = frappe.get_doc("Sales Invoice", res["results"][0]["invoice_name"])
		p = invoice_summary(doc)
		self.assertEqual(p["boutique"], "CHI-OAK")
		self.assertAlmostEqual(p["amount"], flt(doc.grand_total), places=2)
		self.assertEqual(p["top_item"], "Travel Jewellery Case")
		self.assertIn("tier", p)
		self.assertEqual(p["is_return"], 0)
		for pii in ("mobile_no", "email_id", "phone", "address"):
			self.assertNotIn(pii, p)

	def test_boutiques_table_and_detail(self):
		table = api.boutiques_table()
		self.assertEqual(len(table["rows"]), 3)
		row = table["rows"][0]
		for k in ("net", "wtd_net", "mtd_net", "wtd_vs_lw_pct", "mtd_avg_ticket", "mtd_conversion", "returns_pct", "stock_value", "low_stock", "on_shift", "status", "sparkline"):
			self.assertIn(k, row)
		self.assertEqual(len(row["sparkline"]), 14)
		self.assertGreaterEqual(row["mtd_net"], row["wtd_net"] - 0.01)
		detail = api.boutique_detail("CHI-OAK", days=28)
		self.assertEqual(detail["row"]["boutique"], "CHI-OAK")
		self.assertEqual(len(detail["by_hour"]), 24)
		self.assertTrue(detail["top_items"])
		self.assertTrue(detail["associates"])
		self.assertIn("alerts", detail)
		self.assertIn("feedback", detail)

	def test_ticker_and_feed_have_no_pii(self):
		rows = api.ticker(limit=5)
		self.assertLessEqual(len(rows), 5)
		if rows:
			self.assertEqual(set(rows[0]), {"invoice", "boutique", "amount", "top_item", "items", "tier", "ts", "is_return"})
		feed = api.boutique_feed("CHI-OAK", limit=5)
		self.assertEqual(len(feed["by_hour"]), 24)
		self.assertLessEqual(len(feed["sales"]), 5)

	def test_clients_overview_degrades_gracefully(self):
		res = api.clients_overview(limit=5)
		for k in ("churn", "upcoming", "follow_ups", "performance", "campaigns", "recognition"):
			self.assertIn(k, res)
		self.assertLessEqual(len(res["churn"]), 5)
		filtered = api.clients_overview(tiers="Patron,Collector", limit=5)
		self.assertTrue(all((r["tier"] or "") in ("Patron", "Collector") for r in filtered["churn"]))


class TestPerformanceBudget(FrappeTestCase):
	"""Benchmarks on the seeded site (3 boutiques, ~1,700 invoices over 6 months)."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		frappe.set_user("Administrator")
		trends.compute_trends(commit=False)

	@staticmethod
	def _best_of(fn, n=5) -> float:
		best = 1e9
		for _ in range(n):
			t0 = time.perf_counter()
			fn()
			best = min(best, (time.perf_counter() - t0) * 1000.0)
		return best

	def test_live_summary_under_150ms_uncached(self):
		api.live_summary(nocache=1)  # warm metas / query cache
		ms = self._best_of(lambda: api.live_summary(nocache=1))
		print(f"\n[bench] live_summary (uncached, best of 5): {ms:.1f} ms")
		self.assertLess(ms, 150.0)

	def test_live_summary_cached_under_20ms(self):
		frappe.cache.delete_keys(api.LIVE_CACHE_PREFIX)
		api.live_summary()
		ms = self._best_of(lambda: api.live_summary())
		print(f"[bench] live_summary (cached): {ms:.1f} ms")
		self.assertLess(ms, 20.0)

	def test_product_trends_under_100ms(self):
		trends.clear_cache()
		api.product_trends(period="7d")
		trends.clear_cache()
		ms = self._best_of(lambda: (trends.clear_cache(), api.product_trends(period="7d", limit=60)))
		print(f"[bench] product_trends (uncached): {ms:.1f} ms")
		self.assertLess(ms, 100.0)
		trends.clear_cache()
		ms2 = self._best_of(lambda: (trends.clear_cache(), api.top_products(boutique="all", by="net", period="7d")))
		print(f"[bench] top_products (uncached): {ms2:.1f} ms")
		self.assertLess(ms2, 100.0)
