"""Scheduled insight jobs (hooks.scheduler_events).

* ``compute_weekly``   Monday 05:00 site time — affinity cache (Maison Client Recommendation),
                        client signals, rebalance suggestions.
* ``weekly_narrative`` Monday 06:00 — narrative report for the previous Mon–Sun, e-mailed to
                        the Maison Head Office role.

Both are idempotent and can be run by hand (``bench --site X execute
maison_pos.insights.jobs.compute_weekly``) or through ``maison_pos.api.insights.compute``.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import frappe
from frappe.utils import add_days, getdate, nowdate

from maison_pos.insights import affinity, client_signals, narrative, product_performance

LAST_RUN_KEY = "maison_insights_last_run"


def compute_weekly(commit: bool = True) -> dict[str, Any]:
	started = time.time()
	out: dict[str, Any] = {}
	out["affinity"] = affinity.compute_client_recommendations()
	if commit and not frappe.flags.in_test:
		frappe.db.commit()
	out["signals"] = client_signals.compute_client_signals()
	if commit and not frappe.flags.in_test:
		frappe.db.commit()
	out["rebalance"] = product_performance.compute_rebalance_suggestions()
	out["seconds"] = round(time.time() - started, 1)
	out["computed_at"] = str(frappe.utils.now_datetime())
	frappe.db.set_default(LAST_RUN_KEY, frappe.as_json(out))
	if commit and not frappe.flags.in_test:
		frappe.db.commit()
	return out


def weekly_narrative(period_end: Optional[str] = None, send: bool = True, commit: bool = True) -> dict[str, Any]:
	"""Narrative for the last full Monday–Sunday week (or the 7 days ending *period_end*)."""
	if period_end:
		end = getdate(period_end)
	else:
		today = getdate(nowdate())
		end = add_days(today, -(today.weekday() + 1))  # last Sunday
	doc = narrative.generate_report(end, days=7)
	recipients = narrative.email_report(doc) if send and not frappe.flags.in_test else []
	if commit and not frappe.flags.in_test:
		frappe.db.commit()
	return {"report": doc.name, "title": doc.title, "generator": doc.generator, "model": doc.model, "emailed_to": recipients, "error": doc.error}


def last_run() -> Optional[dict[str, Any]]:
	raw = frappe.db.get_default(LAST_RUN_KEY)
	if not raw:
		return None
	try:
		return frappe.parse_json(raw)
	except Exception:
		return None
