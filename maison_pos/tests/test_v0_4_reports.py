"""v0.4 F — Script Reports: tax summary totals vs invoices, daily sales nets returns, period comparison, CSV export."""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, nowdate

from maison_pos.api import reports, returns, sales
from maison_pos.tests.helpers import ensure_demo_data, pos_invoice

NYC = "NYC-5AV"
NYC_ASSOCIATE = "nyc.5av.a1@maison.example"


def _run(name, **filters):
	filters.setdefault("from_date", nowdate())
	filters.setdefault("to_date", nowdate())
	return reports.run(name, filters)


class TestReports(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v04_rep")
		# a cash sale (2 x AC-012), a card sale (AC-001) and a return of one AC-012
		r1 = sales.submit_batch([pos_invoice(items=[{"item_code": "AC-012", "qty": 2, "rate": 160}], payments=[{"mode_of_payment": "Cash", "amount": 400}], customer="Priya Raghavan")])["results"][0]
		r2 = sales.submit_batch([pos_invoice(items=[{"item_code": "AC-001", "qty": 1, "rate": 2400}], payments=[{"mode_of_payment": "Card", "amount": round(2400 * 1.08875, 2)}])])["results"][0]
		assert r1["status"] == "ok" and r2["status"] == "ok", (r1, r2)
		self.sale1, self.sale2 = r1["invoice_name"], r2["invoice_name"]
		self.credit = returns.return_items(self.sale1, [{"item_code": "AC-012", "qty": 1, "reason": "Sizing"}], refund_method="cash")["credit_note"]

	def tearDown(self):
		frappe.db.rollback(save_point="v04_rep")
		frappe.set_user("Administrator")

	def _invoices_today(self):
		return frappe.get_all("Sales Invoice", filters={"maison_boutique": NYC, "posting_date": nowdate(), "docstatus": 1, "is_pos": 1}, fields=["name", "is_return", "net_total", "total_taxes_and_charges", "grand_total", "rounded_total"])

	def test_tax_summary_matches_invoices(self):
		res = _run("Maison Sales Tax Summary", boutique=NYC)
		rows = res["rows"]
		self.assertEqual(len(rows), 1)
		row = rows[0]
		inv = self._invoices_today()
		self.assertAlmostEqual(row["tax_collected"], sum(flt(i.total_taxes_and_charges) for i in inv), places=1)
		self.assertAlmostEqual(row["net_sales"], sum(flt(i.net_total) for i in inv), places=2)
		self.assertAlmostEqual(row["taxable_sales"] + row["non_taxable_sales"], row["net_sales"], places=2)
		self.assertEqual(row["returns"], sum(1 for i in inv if i.is_return))
		self.assertEqual(row["tickets"], sum(1 for i in inv if not i.is_return))
		self.assertAlmostEqual(row["returns_value"], sum(abs(flt(i.net_total)) for i in inv if i.is_return), places=1)
		self.assertGreaterEqual(row["returns_value"], 160)
		self.assertEqual(row["tax_rate"], 8.875)
		self.assertEqual(row["tax_template"], frappe.db.get_value("Maison Boutique", NYC, "tax_template"))

	def test_daily_sales_nets_returns(self):
		res = _run("Maison Daily Sales", boutique=NYC)
		row = next(r for r in res["rows"] if r["boutique"] == NYC)
		inv = self._invoices_today()
		self.assertAlmostEqual(row["net"], sum(flt(i.net_total) for i in inv), places=2)
		self.assertAlmostEqual(row["total"], sum(flt(i.rounded_total or i.grand_total) for i in inv), places=2)
		self.assertEqual(row["returns"], sum(1 for i in inv if i.is_return))
		self.assertAlmostEqual(row["returns_value"], sum(abs(flt(i.net_total)) for i in inv if i.is_return), places=1)
		self.assertGreaterEqual(row["returns_value"], 160)
		self.assertAlmostEqual(row["cash"] + row["card"] + row["other"], row["total"], places=1)
		# X/Z report (sales.list) nets the return too
		z = sales.list(NYC, nowdate())
		self.assertAlmostEqual(z["totals"]["grand_total"], row["total"], places=2)
		self.assertGreaterEqual(z["totals"]["returns"], 1)

	def test_item_associate_returns_reports(self):
		by_item = _run("Maison Sales by Item", boutique=NYC, group_by="Item")["rows"]
		ac012 = next(r for r in by_item if r["key"] == "AC-012")
		self.assertGreaterEqual(ac012["units_sold"], 2)
		self.assertGreaterEqual(ac012["units_returned"], 1)
		self.assertAlmostEqual(ac012["net_sales"], (ac012["units_sold"] - ac012["units_returned"]) * 160, places=2)
		by_dept = _run("Maison Sales by Item", boutique=NYC, group_by="Department")["rows"]
		self.assertTrue(any(r["key"] == "Accessories" for r in by_dept))
		assoc = _run("Maison Sales by Associate", boutique=NYC)["rows"]
		self.assertEqual(sum(r["tickets"] for r in assoc), sum(1 for i in self._invoices_today() if not i.is_return))
		ret = _run("Maison Returns", boutique=NYC, group_by="Reason")["rows"]
		sizing = next(r for r in ret if r["key"] == "Sizing")
		self.assertGreaterEqual(sizing["units"], 1)
		self.assertGreaterEqual(sizing["credit_notes"], 1)
		detail = _run("Maison Returns", boutique=NYC, group_by="Detail")["rows"]
		mine = next(d for d in detail if d["invoice"] == self.credit)
		self.assertEqual(mine["reason"], "Sizing")
		self.assertEqual(mine["qty"], 1)
		self.assertAlmostEqual(mine["value"], 160, places=2)
		heat = _run("Maison Hourly Sales Heatmap", boutique=NYC)
		self.assertTrue(heat["rows"] and heat["chart"])
		clients = _run("Maison Client Purchases", boutique=NYC)["rows"]
		priya = next(r for r in clients if r["customer"] == "Priya Raghavan")
		self.assertGreaterEqual(priya["frequency"], 1)
		self.assertGreaterEqual(priya["returns"], 1)
		self.assertEqual(priya["recency"], 0)
		ledger = reports.run("Maison Serial Ledger", {"item_code": "TP-001"})["rows"]
		self.assertTrue(ledger and all(r["status"] in ("In stock", "Sold", "Returned", "Damaged", "Transferred") for r in ledger))

	def test_period_comparison_and_scoping(self):
		pc = reports.period_comparison()
		self.assertIn("today_vs_same_weekday", pc["periods"])
		today = pc["periods"]["today_vs_same_weekday"]["current"]
		self.assertGreaterEqual(today["tickets"], 2)
		self.assertGreaterEqual(today["returns"], 1)
		self.assertEqual(pc["periods"]["mtd"]["range"]["to"], nowdate())
		frappe.set_user(NYC_ASSOCIATE)
		scoped = reports.period_comparison()
		self.assertEqual(scoped["boutiques"], [NYC])
		with self.assertRaises(frappe.PermissionError):
			reports.run("Maison Daily Sales", {"boutique": "CHI-OAK", "from_date": nowdate(), "to_date": nowdate()})
		other = reports.run("Maison Daily Sales", {"from_date": nowdate(), "to_date": nowdate()})
		self.assertTrue(all(r["boutique"] == NYC for r in other["rows"]))

	def test_csv_export(self):
		reports.export("Maison Sales Tax Summary", {"boutique": NYC, "from_date": nowdate(), "to_date": nowdate()})
		self.assertEqual(frappe.response["type"], "download")
		self.assertTrue(frappe.response["filename"].endswith(".csv"))
		lines = frappe.response["filecontent"].splitlines()
		self.assertTrue(lines[0].startswith("Boutique,"))
		self.assertGreaterEqual(len(lines), 2)
		self.assertTrue(all(NYC in l for l in lines[1:]))
		listed = reports.list_reports()["reports"]
		# v0.8 QA D-6: Commission Statement / Promotion Performance / Campaign Performance were
		# missing from `REPORTS`, so head office could neither open nor export them
		self.assertEqual(len(listed), 11)
		self.assertLessEqual(
			{"Maison Commission Statement", "Maison Promotion Performance", "Maison Campaign Performance"},
			{r["name"] for r in listed},
		)
		self.assertTrue(all(r["installed"] for r in listed))
		reports.export("Maison Commission Statement", {"boutique": NYC, "from_date": nowdate(), "to_date": nowdate()})
		self.assertEqual(frappe.response["type"], "download")
