"""``Payment Request`` override: online payment → advance Payment Entry, even for portal users.

Chains on webshop's own override (which calls ``set_as_paid`` and redirects to ``/orders``).
Creating the Payment Entry needs accounting permissions the shopper does not have, so the
document action runs as Administrator; afterwards the Sales Order's ``maison_prepaid_amount``
is refreshed and the shopper is sent to the Maison order page.
"""

from __future__ import annotations

import frappe
from frappe.utils import get_url

try:  # pragma: no cover - import guard for sites without webshop
	from webshop.webshop.doctype.override_doctype.payment_request import PaymentRequest as _Base
except Exception:  # noqa: BLE001
	from erpnext.accounts.doctype.payment_request.payment_request import PaymentRequest as _Base  # type: ignore

from maison_pos.webshop import core


class MaisonPaymentRequest(_Base):
	def on_payment_authorized(self, status=None):
		if status not in ("Authorized", "Completed"):
			return super().on_payment_authorized(status)
		user = frappe.session.user
		try:
			frappe.set_user("Administrator")
			frappe.flags.ignore_permissions = True
			if self.status != "Paid":
				self.set_as_paid()
		finally:
			frappe.flags.ignore_permissions = False
			frappe.set_user(user)
		if self.reference_doctype == "Sales Order":
			core.refresh_prepaid(self.reference_name)
			if frappe.db.get_value("Sales Order", self.reference_name, "maison_web_order"):
				return get_url(f"/shop/order?name={self.reference_name}&paid=1")
		return get_url(f"/orders/{self.reference_name}")
