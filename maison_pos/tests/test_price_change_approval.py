"""Price change approval creates / updates a warehouse-scoped Pricing Rule."""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import nowdate

from maison_pos.maison_pos.doctype.maison_price_change_request.maison_price_change_request import (
	STATE_APPROVED,
	STATE_PENDING,
	STATE_REJECTED,
	pricing_rule_title,
)
from maison_pos.tests.helpers import ensure_demo_data


def _approve(doc, action: str = "Approve"):
	"""Drive the workflow when installed, otherwise emulate the state change."""
	if frappe.db.exists("Workflow", "Maison Price Approval"):
		from frappe.model.workflow import apply_workflow

		return apply_workflow(doc, action)
	doc.workflow_state = STATE_APPROVED if action == "Approve" else STATE_REJECTED
	doc.save()
	return doc


class TestPriceChangeApproval(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_demo_data()

	def setUp(self):
		# each test starts from the pristine seed: no Pricing Rule overrides from earlier tests
		frappe.set_user("Administrator")
		frappe.db.savepoint("price_change_test")

	def tearDown(self):
		frappe.db.rollback(save_point="price_change_test")
		frappe.set_user("Administrator")

	def _request(self, item_code="AC-001", boutique="CHI-OAK", rate=2_200, **kw):
		doc = frappe.get_doc(
			{
				"doctype": "Maison Price Change Request",
				"item_code": item_code,
				"boutique": boutique,
				"proposed_rate": rate,
				"reason": "Regional promotion",
				"valid_from": nowdate(),
				**kw,
			}
		)
		doc.insert()
		return doc

	def test_draft_captures_current_rate_and_warehouse(self):
		doc = self._request()
		self.assertEqual(doc.current_rate, 2_400)
		self.assertEqual(doc.warehouse, frappe.db.get_value("Maison Boutique", "CHI-OAK", "warehouse"))
		self.assertEqual(doc.workflow_state, "Draft")

	def test_submit_moves_to_pending(self):
		doc = self._request()
		doc.submit()
		doc.reload()
		self.assertEqual(doc.workflow_state, STATE_PENDING)
		self.assertFalse(doc.pricing_rule)

	def test_approval_creates_scoped_pricing_rule(self):
		doc = self._request()
		doc.submit()
		doc.reload()
		doc = _approve(doc)
		doc.reload()
		self.assertEqual(doc.workflow_state, STATE_APPROVED)
		self.assertTrue(doc.pricing_rule)

		rule = frappe.get_doc("Pricing Rule", doc.pricing_rule)
		self.assertEqual(rule.title, pricing_rule_title("CHI-OAK", "AC-001"))
		self.assertEqual(rule.warehouse, doc.warehouse)
		self.assertEqual(rule.rate, 2_200)
		self.assertEqual(rule.selling, 1)
		self.assertEqual(rule.rate_or_discount, "Rate")
		self.assertEqual(rule.disable, 0)
		self.assertEqual([i.item_code for i in rule.items], ["AC-001"])

	def test_second_approval_updates_same_rule(self):
		first = self._request()
		first.submit()
		first.reload()
		first = _approve(first)
		first.reload()

		second = self._request(rate=2_050)
		self.assertEqual(second.current_rate, 2_200)  # sees the active override
		second.submit()
		second.reload()
		second = _approve(second)
		second.reload()
		self.assertEqual(second.pricing_rule, first.pricing_rule)
		self.assertEqual(frappe.db.get_value("Pricing Rule", first.pricing_rule, "rate"), 2_050)

	def test_rejection_creates_no_rule(self):
		doc = self._request(item_code="AC-003", rate=1_700)
		doc.submit()
		doc.reload()
		doc = _approve(doc, "Reject")
		doc.reload()
		self.assertEqual(doc.workflow_state, STATE_REJECTED)
		self.assertFalse(doc.pricing_rule)
		self.assertFalse(frappe.db.exists("Pricing Rule", {"title": pricing_rule_title("CHI-OAK", "AC-003")}))

	def test_invalid_rates_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			self._request(rate=0)
		with self.assertRaises(frappe.ValidationError):
			self._request(rate=2_400)  # equals current

	def test_pricing_rule_visible_in_catalog(self):
		from maison_pos.api import catalog

		doc = self._request(item_code="AC-002", rate=2_900)
		doc.submit()
		doc.reload()
		_approve(doc)
		data = catalog.bootstrap("CHI-OAK")
		rules = {r["item_code"]: r["rate"] for r in data["pricing_rules"]}
		self.assertEqual(rules.get("AC-002"), 2_900)
		other = catalog.bootstrap("NYC-5AV")
		self.assertNotIn("AC-002", {r["item_code"] for r in other["pricing_rules"]})
