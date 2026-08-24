"""AWANZ Purchase Suggestion (v1.0 §C) — one cached line of a buying run.

Built by ``maison_pos.purchasing.demand`` (daily 06:00 and on demand) so a buyer can work the
list across a session: ``Open`` → ``Ordered`` (a draft PO was raised) or ``Dismissed``.
"""

from frappe.model.document import Document


class AWANZPurchaseSuggestion(Document):
	pass
