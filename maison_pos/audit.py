"""v0.7 — a single, boring place to record security-relevant events.

Everything lands in ``logs/maison_security.log`` on the site as one JSON object per line, so it
can be shipped somewhere and grepped without a schema migration. Three rules:

* it never raises — an audit line must not be able to fail a sale;
* it never contains a secret (no PINs, no hashes, no tokens) and no more PII than the identifier
  the event is *about* (a customer id, never their phone number);
* it is called on the paths the QA audit found interesting: cross-store client lookups
  (v0.7 S6), guest sign-ups that landed on an existing client (S3), and refused privilege
  changes on ``Maison Associate`` (S1/S5).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import frappe

LOGGER = "maison_security"


def logger() -> "logging.Logger":
	"""``logs/maison_security.log``, pinned to INFO.

	``frappe.logger`` inherits the bench log level, which is WARNING on a dev server and ERROR
	in production — an audit trail that is dropped by default is not an audit trail.
	"""
	log_ = frappe.logger(LOGGER, allow_site=True)
	if log_.level > logging.INFO:
		log_.setLevel(logging.INFO)
	return log_


def log(event: str, **fields: Any) -> None:
	"""Write one ``{"event": ..., "user": ..., ...}`` line to the security log."""
	try:
		payload = {"event": event, "user": getattr(frappe.session, "user", None)}
		payload.update({k: v for k, v in fields.items() if v is not None})
		logger().info(json.dumps(payload, default=str))
	except Exception:  # pragma: no cover — auditing must never break the request
		pass
