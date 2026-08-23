"""Collecting a web order at the counter.

The POS sends its usual POSInvoice payload with an extra ``sales_order``; ``build_sales_invoice``
links every line to the order and calls :func:`apply_web_order_advances` so the amount paid
online (advance Payment Entry created by the ``payments`` app or the simulated gateway) is
allocated on the invoice. What remains is taken at the counter as Cash / Card exactly like any
other sale — same receipt, same loyalty points, same commission.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import flt

from maison_pos.webshop.setup import WEB_MODE_OF_PAYMENT


def apply_web_order_advances(si, sales_order: str, payments: list[dict[str, Any]]) -> None:
	from erpnext.accounts.party import get_party_account
	from erpnext.controllers.accounts_controller import get_advance_payment_entries_for_regional

	so = frappe.db.get_value(
		"Sales Order",
		sales_order,
		["customer", "company", "maison_web_order", "maison_web_status", "maison_boutique", "status"],
		as_dict=True,
	)
	if not so or not so.maison_web_order:
		frappe.throw(_("{0} is not a web order").format(sales_order), frappe.ValidationError)
	if so.maison_web_status in ("Collected", "Cancelled"):
		frappe.throw(_("Web order {0} is already {1}").format(sales_order, so.maison_web_status), frappe.ValidationError)
	if so.customer != si.customer:
		frappe.throw(
			_("Web order {0} belongs to {1}; the sale must be for the same client").format(sales_order, so.customer),
			frappe.ValidationError,
		)
	if so.maison_boutique and si.maison_boutique != so.maison_boutique:
		frappe.throw(
			_("Web order {0} is to be collected at {1}").format(sales_order, so.maison_boutique), frappe.ValidationError
		)

	si.maison_sales_order = sales_order
	si.allocate_advances_automatically = 0

	party_account = get_party_account("Customer", so.customer, so.company)
	rows = get_advance_payment_entries_for_regional(
		"Customer", so.customer, [party_account], "Sales Order", [sales_order], None, False
	)
	si.set("advances", [])
	# The counter invoice can come out *below* what was paid online — an in-store promotion or a
	# manager discount applies to the collection, while the web order was priced when it was placed.
	# ERPNext refuses an invoice whose allocated advance exceeds its total ("Advance amount cannot be
	# greater than ..."), so allocate at most the invoice total here and leave the rest sitting on the
	# customer as an unallocated advance (store credit) rather than failing the collection.
	si.run_method("calculate_taxes_and_totals")
	remaining = flt(si.rounded_total or si.grand_total)
	for d in rows:
		if remaining <= 0:
			break
		allocated = min(flt(d.amount), remaining)
		remaining -= allocated
		advance = {
			"doctype": "Sales Invoice Advance",
			"reference_type": d.reference_type,
			"reference_name": d.reference_name,
			"reference_row": d.reference_row,
			"remarks": d.remarks,
			"advance_amount": flt(d.amount),
			"allocated_amount": allocated,
			"ref_exchange_rate": flt(d.exchange_rate) or 1,
			"difference_posting_date": si.posting_date,
		}
		if d.get("paid_from"):
			advance["account"] = d.paid_from
		si.append("advances", advance)

	# ERPNext insists on at least one payment row for a POS invoice: a zero "Web Payment" row
	# keeps a fully prepaid collection valid and shows "paid online" on the receipt.
	if not payments:
		from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

		account = (get_bank_cash_account(WEB_MODE_OF_PAYMENT, so.company) or {}).get("account")
		si.append("payments", {"mode_of_payment": WEB_MODE_OF_PAYMENT, "amount": 0, "account": account})
