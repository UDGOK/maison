"""v0.8 — regression tests for the POS defects QA found on the live deployment.

See ``e2e/qa/pos-report.md``. Each test here fails against the code as it was:

* **D1** the POS rounded tax per line while ERPNext applies the *On Net Total* row once, so the
  server refused the sale *after* the customer had paid (25.6 % of 2-line baskets, 54.9 % of
  8-line baskets). Covered by a fuzz that rings up many random baskets through the real
  ``submit_batch`` and demands the invoice ERPNext books equals the device total to the cent —
  plus the server-side safety net that books a rounding-sized gap instead of refusing.
* **D2** an offline sale of an age-restricted item could never sync (ISO ``Z`` timestamp into a
  Datetime column). 127 of 160 items in this catalogue are 21+.
* **D3** a $0.00 comp / 100 % discount sale was always rejected.
* **D4** "Email receipt" did nothing.
* **D7** card brand / last 4 / approval never reached the invoice.
* **D8** an exchange wrote a circular link, so neither invoice could ever be cancelled.
* **D10** there was no split tender (part cash, part card).
* **D11** the cash tendered and the change given were not recorded on the invoice.
* **D12** a partial return left the client one loyalty point too many.
"""

from __future__ import annotations

import random
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import cint, flt

from maison_pos.api import age, returns, sales
from maison_pos.tests.helpers import ensure_demo_data, ensure_stock, pos_invoice

NYC = "NYC-5AV"
TAX_RATE = 8.875
FUZZ_ITEMS = ["AC-012", "AC-011", "AC-010", "AC-009", "AC-008", "AC-007"]


def cents(value: float) -> float:
	"""Commercial Rounding to cents — the site's rounding method, and `utils/money.ts::round`."""
	sign = -1 if value < 0 else 1
	return sign * int(abs(value) * 100 + 0.5 + 1e-9) / 100


def device_line_net(line: dict) -> float:
	"""Mirror of ``frontend/src/utils/totals.ts::lineNet``: the discounted unit rate, to the cent."""
	amount = cents(line["qty"] * line["rate"])
	disc = min(cents(line.get("discount_amount") or 0.0), amount)
	if not disc:
		return amount
	return cents(max(0.0, cents(line["rate"] - disc / line["qty"])) * line["qty"])


def device_totals(lines: list[dict], tax_rate: float = TAX_RATE) -> dict[str, float]:
	"""Python mirror of ``frontend/src/utils/totals.ts::computeTotals`` after the D1 fix.

	One rate, applied **once** to the taxable net, rounded once — which is what ERPNext does with
	a single *On Net Total* row (it accumulates ``net_amount x rate`` unrounded across the item
	rows and rounds the tax row at the end).
	"""
	net_total = taxable = 0.0
	for line in lines:
		net = device_line_net(line)
		net_total = cents(net_total + net)
		taxable = cents(taxable + net)
	total_taxes = cents(taxable * tax_rate / 100)
	return {"net_total": net_total, "total_taxes": total_taxes, "grand_total": cents(net_total + total_taxes)}


def per_line_totals(lines: list[dict], tax_rate: float = TAX_RATE) -> float:
	"""The defect: each line's tax rounded before summing. Used to prove the fuzz has teeth."""
	tax = 0.0
	for line in lines:
		tax = cents(tax + cents(device_line_net(line) * tax_rate / 100))
	return tax


class TestPosDefectsV08(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()
		for item in FUZZ_ITEMS:
			ensure_stock(item, NYC, 600)
		ensure_stock("AC-001", NYC, 60)

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("v08_pos")

	def tearDown(self):
		frappe.db.rollback(save_point="v08_pos")
		frappe.set_user("Administrator")

	# ------------------------------------------------------------------
	# D1 — the number on the screen is the number the server books
	# ------------------------------------------------------------------
	def test_d1_device_total_equals_server_total_for_random_baskets(self):
		rnd = random.Random(20260823)
		checked = 0
		would_have_failed = 0
		for line_count in (2, 3, 4, 5, 6, 8):
			for _ in range(8):
				lines = []
				for _i in range(line_count):
					item = rnd.choice(FUZZ_ITEMS)
					rate = cents(0.99 + rnd.random() * 120)
					qty = rnd.randint(1, 3)
					row = {"item_code": item, "qty": qty, "rate": rate}
					roll = rnd.random()
					if roll < 0.25:
						row["discount_amount"] = cents(qty * rate * (0.05 + rnd.random() * 0.4))
					elif roll < 0.35:
						row["discount_amount"] = cents(rnd.random() * 5)
					lines.append(row)

				device = device_totals(lines)
				if per_line_totals(lines) != device["total_taxes"]:
					would_have_failed += 1

				payload = pos_invoice(
					boutique=NYC,
					items=lines,
					payments=[{"mode_of_payment": "Cash", "amount": device["grand_total"]}],
				)
				result = sales.submit_batch([payload])["results"][0]
				self.assertEqual(result["status"], "ok", f"{result} for {lines}")
				# the device paid exactly what was due: no safety net was needed
				self.assertIsNone(result.get("rounding_adjustment"), f"{lines}")

				si = frappe.get_doc("Sales Invoice", result["invoice_name"])
				self.assertEqual(flt(si.net_total, 2), device["net_total"], f"net for {lines}")
				self.assertEqual(flt(si.total_taxes_and_charges, 2), device["total_taxes"], f"tax for {lines}")
				self.assertEqual(flt(si.rounded_total or si.grand_total, 2), device["grand_total"], f"total for {lines}")
				self.assertEqual(flt(si.outstanding_amount, 2), 0.0)
				checked += 1
		self.assertEqual(checked, 48)
		# guards the fuzz itself: the old per-line model really does disagree on these baskets
		self.assertGreater(would_have_failed, 5, "the generator stopped producing divergent baskets")

	def test_d1_reproduces_the_two_baskets_qa_rang_up(self):
		"""HKA-012 + 2 x HKA-013 (cash, client under) and HKA-017 + ACC-002 (card, client over)."""
		under = device_totals([{"qty": 1, "rate": 12.99}, {"qty": 2, "rate": 16.99}], 8.25)
		self.assertEqual(under["total_taxes"], 3.88)  # the POS used to show 3.87
		self.assertEqual(under["grand_total"], 50.85)  # ... and take 50.84, which the server refused

		over = device_totals([{"qty": 1, "rate": 6.99}, {"qty": 1, "rate": 1.79}], 8.25)
		self.assertEqual(over["total_taxes"], 0.72)  # the POS used to show 0.73
		self.assertEqual(over["grand_total"], 9.50)  # ... and charge 9.51 to the card

	def test_d1_a_cent_short_is_written_off_not_refused(self):
		"""An older till (or any other client) must not be able to lose a completed sale."""
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 12.99}, {"item_code": "AC-011", "qty": 2, "rate": 16.99}]
		due = device_totals(lines)["grand_total"]
		payload = pos_invoice(
			boutique=NYC, items=lines, payments=[{"mode_of_payment": "Cash", "amount": cents(due - 0.01)}]
		)
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)

		adjustment = result["rounding_adjustment"]
		self.assertIsNotNone(adjustment, "the cent must be booked, not lost")
		self.assertEqual(adjustment["amount"], 0.01)
		self.assertTrue(adjustment["account"])

		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(flt(si.write_off_amount, 2), 0.01)
		self.assertEqual(si.write_off_account, adjustment["account"])
		self.assertEqual(flt(si.outstanding_amount, 2), 0.0)
		# never silently: it is on the document and in a Comment
		self.assertIn("Rounding difference", si.maison_notes or "")
		self.assertTrue(
			frappe.db.exists(
				"Comment", {"reference_doctype": "Sales Invoice", "reference_name": si.name, "content": ("like", "%Rounding difference%")}
			)
		)
		# and the books still balance
		gl = frappe.get_all("GL Entry", filters={"voucher_no": si.name, "is_cancelled": 0}, fields=["debit", "credit"])
		self.assertAlmostEqual(sum(flt(r.debit) for r in gl), sum(flt(r.credit) for r in gl), places=2)

	def test_d1_a_cent_over_on_a_card_is_written_off_not_refused(self):
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 6.99}, {"item_code": "AC-011", "qty": 1, "rate": 1.79}]
		due = device_totals(lines)["grand_total"]
		payload = pos_invoice(
			boutique=NYC,
			items=lines,
			payments=[{"mode_of_payment": "Card", "amount": cents(due + 0.01), "stripe_payment_intent": "pi_sim_over"}],
		)
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		self.assertEqual(result["rounding_adjustment"]["amount"], -0.01)
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(flt(si.write_off_amount, 2), -0.01)
		self.assertEqual(flt(si.outstanding_amount, 2), 0.0)

	def test_d1_a_real_mismatch_is_still_refused(self):
		"""The tolerance is one cent — a basket that is genuinely underpaid still fails loudly."""
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 100}]
		due = device_totals(lines)["grand_total"]
		payload = pos_invoice(boutique=NYC, items=lines, payments=[{"mode_of_payment": "Cash", "amount": cents(due - 5)}])
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "error")
		self.assertEqual(result["error_code"], sales.ERR_PAYMENT)
		self.assertIn("do not cover", result["error"])

	# ------------------------------------------------------------------
	# D2 — an offline sale of an age-restricted item syncs
	# ------------------------------------------------------------------
	def test_d2_offline_age_verified_sale_replays(self):
		# the jewellery seed carries no 21+ lines; make one of the stocked items restricted
		# (rolled back with the test) so this exercises the same gate the smoke-shop catalogue hits
		item = FUZZ_ITEMS[0]
		frappe.db.set_value("Item", item, "maison_age_restricted", 1)
		frappe.db.set_single_value("AWANZ POS Settings", "age_verification_required", 1)
		frappe.clear_cache(doctype="AWANZ POS Settings")

		lines = [{"item_code": item, "qty": 1, "rate": 24.99}]
		due = device_totals(lines)["grand_total"]
		payload = pos_invoice(
			boutique=NYC,
			items=lines,
			payments=[{"mode_of_payment": "Cash", "amount": due}],
			# exactly what `api/v06.ts::decideOffline` used to send: Date.toISOString()
			age_check={"verified": 1, "method": "Manual", "offline": 1, "dob_year_ok": 1, "age": 36, "checked_at": "2026-08-23T19:39:08.269Z"},
		)
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)  # used to be "Incorrect datetime value"

		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(cint(si.maison_age_verified), 1)
		self.assertTrue(si.maison_age_checked_at)
		# stored naive, in the site's zone, and the audit row was created on submit
		self.assertEqual(str(si.maison_age_checked_at)[:10], "2026-08-23")
		self.assertNotIn("Z", str(si.maison_age_checked_at))
		self.assertTrue(frappe.db.exists("AWANZ Age Check", {"sales_invoice": si.name}))

	def test_d2_checked_at_normalisation(self):
		"""Every shape a till might send lands as a naive datetime; garbage falls back to now."""
		self.assertEqual(str(age._checked_at("2026-08-23 14:39:08")), "2026-08-23 14:39:08")
		self.assertTrue(age._checked_at("2026-08-23T19:39:08.269Z"))
		self.assertNotIn("Z", str(age._checked_at("2026-08-23T19:39:08.269Z")))
		self.assertTrue(age._checked_at(None))
		self.assertTrue(age._checked_at("not a datetime at all"))

	# ------------------------------------------------------------------
	# D3 — a $0.00 comp is a real sale
	# ------------------------------------------------------------------
	def test_d3_zero_total_sale_is_booked(self):
		payload = pos_invoice(
			boutique=NYC,
			items=[{"item_code": "AC-012", "qty": 1, "rate": 40, "discount_amount": 40}],
			payments=[],
		)
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "ok", result)  # used to be "Invoice has no payments"
		si = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(flt(si.grand_total, 2), 0.0)
		self.assertEqual(si.payments, [])
		self.assertEqual(si.docstatus, 1)
		self.assertEqual(flt(si.outstanding_amount, 2), 0.0)

	def test_d3_a_basket_worth_money_still_needs_a_tender(self):
		payload = pos_invoice(boutique=NYC, items=[{"item_code": "AC-012", "qty": 1, "rate": 40}], payments=[])
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "error")
		self.assertEqual(result["error_code"], sales.ERR_PAYMENT)

	# ------------------------------------------------------------------
	# D4 — "Email receipt" sends something
	# ------------------------------------------------------------------
	def _sold(self, **extra):
		lines = extra.pop("items", [{"item_code": "AC-012", "qty": 1, "rate": 40}])
		payments = extra.pop("payments", None)
		if payments is None:
			payments = [{"mode_of_payment": "Cash", "amount": device_totals(lines)["grand_total"]}]
		result = sales.submit_batch([pos_invoice(boutique=NYC, items=lines, payments=payments, **extra)])["results"][0]
		self.assertEqual(result["status"], "ok", result)
		return frappe.get_doc("Sales Invoice", result["invoice_name"])

	def test_d4_email_receipt_actually_sends(self):
		si = self._sold()
		with patch("frappe.sendmail") as sendmail:
			out = sales.email_receipt(si.name, "QA1.Receipt@Example.com")
		self.assertTrue(out["ok"])
		self.assertTrue(out["queued"])
		sendmail.assert_called_once()
		kwargs = sendmail.call_args.kwargs
		self.assertEqual(kwargs["recipients"], ["qa1.receipt@example.com"])
		self.assertIn(si.maison_receipt_token, kwargs["message"])
		self.assertEqual(kwargs["reference_name"], si.name)
		# and it is on the record, so "did the client get it?" has an answer
		self.assertTrue(
			frappe.db.exists("Comment", {"reference_doctype": "Sales Invoice", "reference_name": si.name, "content": ("like", "%e-mailed%")})
		)

	def test_d4_the_public_receipt_token_works_too(self):
		si = self._sold()
		with patch("frappe.sendmail") as sendmail:
			out = sales.email_receipt(si.maison_receipt_token, "client@example.com")
		self.assertEqual(out["invoice"], si.name)
		sendmail.assert_called_once()

	def test_d4_fails_visibly_when_no_outgoing_account_is_configured(self):
		si = self._sold()
		with patch("frappe.sendmail", side_effect=frappe.OutgoingEmailError("no account")):
			with self.assertRaises(frappe.ValidationError) as ctx:
				sales.email_receipt(si.name, "client@example.com")
		message = str(ctx.exception)
		self.assertIn("outgoing e-mail account", message)
		self.assertNotIn("maison_pos", message)

	def test_d4_rejects_a_bad_address_and_an_unknown_receipt(self):
		si = self._sold()
		with self.assertRaises(frappe.ValidationError):
			sales.email_receipt(si.name, "not-an-email")
		with self.assertRaises((frappe.DoesNotExistError, frappe.ValidationError)):
			sales.email_receipt("nope-not-a-token", "client@example.com")

	# ------------------------------------------------------------------
	# D7 / D11 — what the invoice remembers about the tender
	# ------------------------------------------------------------------
	def test_d7_card_brand_last4_and_approval_reach_the_invoice(self):
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 40}]
		si = self._sold(
			items=lines,
			payments=[
				{
					"mode_of_payment": "Card",
					"amount": device_totals(lines)["grand_total"],
					"stripe_payment_intent": "pi_sim_d7",
					"card_brand": "Visa",
					"last4": "4242",
					"approval_code": "54DD0D",
				}
			],
		)
		self.assertEqual(si.maison_card_brand, "Visa")
		self.assertEqual(si.maison_card_last4, "4242")
		self.assertEqual(si.maison_approval_code, "54DD0D")
		# and Returns can now name the card it is about to refund
		found = returns.lookup(invoice=si.name)["invoices"][0]
		self.assertEqual(found["card_brand"], "Visa")
		self.assertEqual(found["card_last4"], "4242")
		# ... as can the receipt
		from maison_pos.utils import receipt_payload

		card = [p for p in receipt_payload(si)["payments"] if p["mode_of_payment"] == "Card"][0]
		self.assertEqual(card["last4"], "4242")
		self.assertEqual(card["approval_code"], "54DD0D")

	def test_d11_cash_tendered_and_change_are_recorded(self):
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 1.79}]
		due = device_totals(lines)["grand_total"]
		si = self._sold(items=lines, payments=[{"mode_of_payment": "Cash", "amount": 20.00}])
		self.assertEqual(flt(si.paid_amount, 2), 20.00)  # was `due`, so the drawer never reconciled
		self.assertEqual(flt(si.change_amount, 2), cents(20.00 - due))
		self.assertEqual(flt(si.outstanding_amount, 2), 0.0)
		gl = frappe.get_all("GL Entry", filters={"voucher_no": si.name, "is_cancelled": 0}, fields=["debit", "credit"])
		self.assertAlmostEqual(sum(flt(r.debit) for r in gl), sum(flt(r.credit) for r in gl), places=2)

		# the public receipt tells the client the same story, and its rows still add up
		from maison_pos.utils import receipt_payload

		payload = receipt_payload(si)
		cash = payload["payments"][0]
		self.assertEqual(cash["tendered"], 20.00)
		self.assertEqual(cash["change"], cents(20.00 - due))
		self.assertAlmostEqual(sum(flt(p["amount"]) for p in payload["payments"]), due, places=2)

	def test_d11_the_x_report_counts_the_drawer_not_the_tender(self):
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 1.79}]
		due = device_totals(lines)["grand_total"]
		today = frappe.utils.nowdate()
		before = flt(sales.list(NYC, today)["by_mode_of_payment"].get("Cash"))
		self._sold(items=lines, payments=[{"mode_of_payment": "Cash", "amount": 20.00}])
		after = flt(sales.list(NYC, today)["by_mode_of_payment"].get("Cash"))
		# what stays in the drawer is the sale, not the $20 note that was handed over
		self.assertAlmostEqual(after - before, due, places=2)

	# ------------------------------------------------------------------
	# D10 — split tender
	# ------------------------------------------------------------------
	def test_d10_part_cash_part_card_is_booked_as_two_tenders(self):
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 100}]
		due = device_totals(lines)["grand_total"]
		card_part = cents(due - 40)
		si = self._sold(
			items=lines,
			payments=[
				{"mode_of_payment": "Cash", "amount": 40.00},
				{"mode_of_payment": "Card", "amount": card_part, "stripe_payment_intent": "pi_sim_split", "card_brand": "Mastercard", "last4": "5454", "approval_code": "AB12CD"},
			],
		)
		self.assertEqual({p.mode_of_payment: flt(p.amount, 2) for p in si.payments}, {"Cash": 40.00, "Card": card_part})
		self.assertEqual(flt(si.paid_amount, 2), due)
		self.assertEqual(flt(si.change_amount, 2), 0.0)
		self.assertEqual(flt(si.outstanding_amount, 2), 0.0)
		self.assertEqual(si.maison_card_last4, "5454")

	def test_d10_a_split_that_does_not_add_up_is_refused(self):
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 100}]
		payload = pos_invoice(
			boutique=NYC,
			items=lines,
			payments=[{"mode_of_payment": "Cash", "amount": 40.00}, {"mode_of_payment": "Card", "amount": 20.00}],
		)
		result = sales.submit_batch([payload])["results"][0]
		self.assertEqual(result["status"], "error")
		self.assertEqual(result["error_code"], sales.ERR_PAYMENT)

	# ------------------------------------------------------------------
	# D8 — an exchanged pair can be cancelled
	# ------------------------------------------------------------------
	def _exchange_pair(self):
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 40}]
		si = self._sold(items=lines)
		new_lines = [{"item_code": "AC-011", "qty": 1, "rate": 60}]
		difference = cents(device_totals(new_lines)["grand_total"] - device_totals(lines)["grand_total"])
		out = returns.exchange(
			si.name,
			[{"item_code": "AC-012", "qty": 1, "reason": "Sizing"}],
			new_lines,
			payments=[{"mode_of_payment": "Cash", "amount": difference}],
		)
		return si, frappe.get_doc("Sales Invoice", out["credit_note"]), frappe.get_doc("Sales Invoice", out["new_invoice"])

	def test_d8_exchange_link_is_one_directional(self):
		_src, cn, new = self._exchange_pair()
		self.assertEqual(cn.maison_exchange_invoice, new.name)
		self.assertFalse(new.maison_exchange_invoice, "the second link deadlocked the pair")
		# the pair is still recorded, just not through a blocking Link field
		self.assertIn(cn.name, new.maison_notes or "")

	def test_d8_an_exchanged_pair_can_be_cancelled(self):
		_src, cn, new = self._exchange_pair()
		# cancelling the new sale first used to raise LinkExistsError naming the credit note
		new.reload()
		new.cancel()
		self.assertEqual(frappe.db.get_value("Sales Invoice", new.name, "docstatus"), 2)
		self.assertIsNone(frappe.db.get_value("Sales Invoice", cn.name, "maison_exchange_invoice"))
		cn.reload()
		cn.cancel()
		self.assertEqual(frappe.db.get_value("Sales Invoice", cn.name, "docstatus"), 2)

	def test_d8_the_credit_note_can_also_be_cancelled_first(self):
		_src, cn, new = self._exchange_pair()
		cn.reload()
		cn.cancel()
		new.reload()
		new.cancel()
		self.assertEqual(frappe.db.get_value("Sales Invoice", new.name, "docstatus"), 2)

	# ------------------------------------------------------------------
	# D12 — a partial return leaves the right number of points
	# ------------------------------------------------------------------
	def test_d12_partial_return_leaves_the_points_the_remaining_goods_earn(self):
		customer = frappe.db.get_value("Customer", {"loyalty_program": ("is", "set")}, "name")
		self.assertTrue(customer, "the demo seed should enrol at least one client")

		# two lines so a partial return leaves a whole item behind: $8.99 + $6.99 net
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 8.99}, {"item_code": "AC-011", "qty": 1, "rate": 6.99}]
		si = self._sold(items=lines, customer=customer)

		def points_on(invoice: str) -> int:
			return cint(
				frappe.db.get_value(
					"Loyalty Point Entry",
					{"invoice": invoice, "invoice_type": "Sales Invoice", "redeem_against": ("is", "not set")},
					"loyalty_points",
				)
			)

		collection = flt(
			frappe.db.get_value("Loyalty Program Collection", {"parent": frappe.db.get_value("Customer", customer, "loyalty_program")}, "collection_factor")
		) or 1.0
		self.assertEqual(points_on(si.name), int(cents(15.98) / collection))  # net, not grand total

		returns.return_items(si.name, [{"item_code": "AC-011", "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		# the $8.99 item is still the client's: it must be worth what it is worth on its own
		self.assertEqual(points_on(si.name), int(8.99 / collection))

		# and a full return still clears them
		returns.return_items(si.name, [{"item_code": "AC-012", "qty": 1, "reason": "Change of mind"}], refund_method="cash")
		self.assertEqual(points_on(si.name), 0)

	def test_d12_undoing_a_return_puts_the_points_back(self):
		customer = frappe.db.get_value("Customer", {"loyalty_program": ("is", "set")}, "name")
		lines = [{"item_code": "AC-012", "qty": 1, "rate": 8.99}, {"item_code": "AC-011", "qty": 1, "rate": 6.99}]
		si = self._sold(items=lines, customer=customer)
		out = returns.return_items(si.name, [{"item_code": "AC-011", "qty": 1, "reason": "Change of mind"}], refund_method="cash")

		cn = frappe.get_doc("Sales Invoice", out["credit_note"])
		cn.cancel()
		collection = flt(
			frappe.db.get_value(
				"Loyalty Program Collection",
				{"parent": frappe.db.get_value("Customer", customer, "loyalty_program")},
				"collection_factor",
			)
		) or 1.0
		points = cint(
			frappe.db.get_value(
				"Loyalty Point Entry",
				{"invoice": si.name, "invoice_type": "Sales Invoice", "redeem_against": ("is", "not set")},
				"loyalty_points",
			)
		)
		self.assertEqual(points, int(cents(15.98) / collection))


class TestPayloadNetV08(FrappeTestCase):
	"""`_payload_net` decides whether an empty `payments` array is a comp or a mistake (D3)."""

	def test_zero_only_for_a_genuinely_zero_basket(self):
		self.assertEqual(sales._payload_net({"items": [{"qty": 1, "rate": 40, "discount_amount": 40}]}), 0.0)
		self.assertEqual(sales._payload_net({"items": [{"qty": 2, "rate": 10}]}), 20.0)
		self.assertEqual(sales._payload_net({"items": []}), 0.0)
		# a discount larger than the line never turns into a credit
		self.assertEqual(sales._payload_net({"items": [{"qty": 1, "rate": 5, "discount_amount": 50}]}), 0.0)
