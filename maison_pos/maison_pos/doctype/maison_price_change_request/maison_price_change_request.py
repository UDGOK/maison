"""Maison Price Change Request.

Workflow ``Maison Price Approval``:

    Draft --(Submit for Approval: Manager)--> Pending Approval
    Pending Approval --(Approve: Head Office / Regional)--> Approved
    Pending Approval --(Reject: Head Office / Regional)--> Rejected

When the state becomes *Approved*, a store-scoped ERPNext **Pricing Rule**
(``warehouse`` = the boutique's warehouse) is created or updated.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, getdate, now_datetime

from maison_pos.utils import DASHBOARD_ROOM

STATE_DRAFT = "Draft"
STATE_PENDING = "Pending Approval"
STATE_APPROVED = "Approved"
STATE_REJECTED = "Rejected"


def pricing_rule_title(boutique: str, item_code: str) -> str:
	return f"MAISON {boutique} {item_code}"


class MaisonPriceChangeRequest(Document):
	# -- lifecycle ----------------------------------------------------------
	def validate(self) -> None:
		if not self.requested_by:
			self.requested_by = frappe.session.user
		if not self.price_list:
			self.price_list = "Standard Selling"
		if not self.warehouse and self.boutique:
			self.warehouse = frappe.db.get_value("Maison Boutique", self.boutique, "warehouse")
		if not self.current_rate:
			self.current_rate = self._lookup_current_rate()
		self._validate_rates()
		self._validate_dates()
		self._validate_scope()
		if not self.workflow_state and self.docstatus == 0:
			self.workflow_state = STATE_DRAFT

	def before_submit(self) -> None:
		# Submitting outside the workflow (e.g. tests, scripts) lands in Pending Approval.
		if not self.workflow_state or self.workflow_state == STATE_DRAFT:
			self.workflow_state = STATE_PENDING

	def on_update_after_submit(self) -> None:
		"""Fires after each workflow transition on a submitted doc."""
		if self.workflow_state == STATE_APPROVED and not self.pricing_rule:
			self._validate_approver()
			self.apply_pricing_rule()
		elif self.workflow_state == STATE_REJECTED and not self.approved_by:
			self._validate_approver()
			self.db_set({"approved_by": frappe.session.user, "approved_on": now_datetime()}, update_modified=False)

	def on_cancel(self) -> None:
		self.disable_pricing_rule()

	# -- validation ---------------------------------------------------------
	def _validate_rates(self) -> None:
		if flt(self.proposed_rate) <= 0:
			frappe.throw(_("Proposed rate must be greater than zero"), frappe.ValidationError)
		if flt(self.proposed_rate) == flt(self.current_rate):
			frappe.throw(_("Proposed rate equals the current rate"), frappe.ValidationError)

	def _validate_dates(self) -> None:
		if self.valid_upto and getdate(self.valid_upto) < getdate(self.valid_from):
			frappe.throw(_("Valid Upto cannot be before Valid From"), frappe.ValidationError)

	def _validate_scope(self) -> None:
		from maison_pos.scoping import assert_boutique_access

		if self.flags.ignore_permissions or frappe.flags.in_install or frappe.flags.in_migrate:
			return
		assert_boutique_access(self.boutique)

	def _validate_approver(self) -> None:
		from maison_pos.scoping import APPROVER_ROLES

		if self.flags.ignore_permissions:
			return
		user = frappe.session.user
		if user != "Administrator" and not (APPROVER_ROLES & set(frappe.get_roles(user))):
			frappe.throw(_("Only Head Office or Regional users may approve price changes"), frappe.PermissionError)

	def _lookup_current_rate(self) -> float:
		"""Store override (active Pricing Rule) if any, else the price list rate."""
		existing = frappe.db.get_value(
			"Pricing Rule",
			{"title": pricing_rule_title(self.boutique, self.item_code), "disable": 0},
			"rate",
		)
		if existing:
			return flt(existing)
		return flt(
			frappe.db.get_value(
				"Item Price",
				{"item_code": self.item_code, "price_list": self.price_list or "Standard Selling", "selling": 1},
				"price_list_rate",
			)
		)

	# -- pricing rule -------------------------------------------------------
	def apply_pricing_rule(self) -> str:
		"""Create or update the boutique-scoped Pricing Rule and return its name."""
		title = pricing_rule_title(self.boutique, self.item_code)
		company = frappe.db.get_value("Maison Boutique", self.boutique, "company")
		name = frappe.db.get_value("Pricing Rule", {"title": title}, "name")

		if name:
			rule = frappe.get_doc("Pricing Rule", name)
		else:
			rule = frappe.new_doc("Pricing Rule")
			rule.title = title

		rule.update(
			{
				"apply_on": "Item Code",
				"price_or_product_discount": "Price",
				"selling": 1,
				"buying": 0,
				"rate_or_discount": "Rate",
				"rate": flt(self.proposed_rate),
				"currency": frappe.get_cached_value("Company", company, "default_currency"),
				"company": company,
				"warehouse": self.warehouse,
				"for_price_list": self.price_list,
				"valid_from": self.valid_from,
				"valid_upto": self.valid_upto,
				"priority": "10",
				"disable": 0,
				"apply_multiple_pricing_rules": 0,
			}
		)
		rule.set("items", [])
		rule.append("items", {"item_code": self.item_code, "uom": frappe.db.get_value("Item", self.item_code, "stock_uom")})
		rule.flags.ignore_permissions = True
		rule.save()

		self.db_set(
			{
				"pricing_rule": rule.name,
				"approved_by": frappe.session.user,
				"approved_on": now_datetime(),
			},
			update_modified=False,
		)
		frappe.publish_realtime(
			"maison_price_approved",
			{"request": self.name, "boutique": self.boutique, "item_code": self.item_code, "rate": flt(self.proposed_rate)},
			room=DASHBOARD_ROOM,
			after_commit=True,
		)
		return rule.name

	def disable_pricing_rule(self) -> None:
		if self.pricing_rule and frappe.db.exists("Pricing Rule", self.pricing_rule):
			frappe.db.set_value("Pricing Rule", self.pricing_rule, "disable", 1)


def count_pending(boutique: str | None = None) -> int:
	filters: dict = {"workflow_state": STATE_PENDING, "docstatus": 1}
	if boutique:
		filters["boutique"] = boutique
	return frappe.db.count("Maison Price Change Request", filters)
