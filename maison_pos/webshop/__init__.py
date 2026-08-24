"""v0.4 section G — glue between AWANZ POS and the official Frappe ``webshop`` app.

Everything in this package degrades gracefully when ``webshop`` / ``payments`` are not
installed on the site: ``is_webshop_installed()`` guards the seed, the hooks and the API.
"""

from __future__ import annotations

import frappe

WEB_MODES = ("Buy", "Enquire", "Reserve-with-deposit")
WEB_STATUSES = ("New", "Picking", "Ready", "Collected", "Cancelled")
FULFILMENTS = ("Click & Collect", "Ship")


def is_webshop_installed() -> bool:
	"""True when the ``webshop`` app is installed on the current site."""
	try:
		return "webshop" in frappe.get_installed_apps()
	except Exception:  # pragma: no cover - no db yet
		return False


def is_payments_installed() -> bool:
	try:
		return "payments" in frappe.get_installed_apps()
	except Exception:  # pragma: no cover
		return False
