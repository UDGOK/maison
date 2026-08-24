"""Thin wrapper around the ``stripe`` SDK for Stripe Terminal.

Keys come from ``site_config.json``::

    "stripe_secret_key": "sk_test_...",
    "stripe_publishable_key": "pk_test_..."

When no secret key is configured every call returns a *simulated* response
(``{"simulated": true, ...}``) so the PWA can run with the simulated reader.
"""

from __future__ import annotations

import secrets
from typing import Any, Optional

import frappe

try:  # the SDK is a declared dependency but keep import failures non-fatal
	import stripe  # type: ignore
except Exception:  # pragma: no cover
	stripe = None  # type: ignore


def get_secret_key() -> Optional[str]:
	return frappe.conf.get("stripe_secret_key") or None


def get_publishable_key() -> Optional[str]:
	return frappe.conf.get("stripe_publishable_key") or None


def is_configured() -> bool:
	return bool(get_secret_key() and stripe is not None)


def _client():
	"""Return the configured ``stripe`` module (sets api_key)."""
	stripe.api_key = get_secret_key()
	stripe.api_version = frappe.conf.get("stripe_api_version") or "2024-06-20"
	return stripe


def _sim_id(prefix: str) -> str:
	return f"{prefix}_sim_{secrets.token_hex(8)}"


# ---------------------------------------------------------------------------
# operations
# ---------------------------------------------------------------------------
def connection_token(location: Optional[str] = None) -> dict[str, Any]:
	if not is_configured():
		return {"secret": _sim_id("pst"), "simulated": True}
	params: dict[str, Any] = {}
	if location:
		params["location"] = location
	token = _client().terminal.ConnectionToken.create(**params)
	return {"secret": token.secret, "simulated": False}


def create_payment_intent(
	amount_minor: int,
	currency: str,
	*,
	offline_uuid: str,
	boutique: Optional[str] = None,
	customer_name: Optional[str] = None,
	description: Optional[str] = None,
) -> dict[str, Any]:
	"""Create a card_present PaymentIntent with manual capture. Idempotent on offline_uuid."""
	metadata = {"offline_uuid": offline_uuid, "boutique": boutique or "", "customer": customer_name or ""}
	if not is_configured():
		pid = _sim_id("pi")
		return {
			"id": pid,
			"client_secret": f"{pid}_secret_{secrets.token_hex(6)}",
			"amount": amount_minor,
			"currency": currency.lower(),
			"status": "requires_payment_method",
			"simulated": True,
		}
	intent = _client().PaymentIntent.create(
		amount=amount_minor,
		currency=currency.lower(),
		payment_method_types=["card_present"],
		capture_method="manual",
		description=description or f"AWANZ {boutique or ''} {offline_uuid}",
		metadata=metadata,
		idempotency_key=f"awanz-pi-{offline_uuid}",
	)
	return {
		"id": intent.id,
		"client_secret": intent.client_secret,
		"amount": intent.amount,
		"currency": intent.currency,
		"status": intent.status,
		"simulated": False,
	}


def _card_details(intent: Any) -> dict[str, Any]:
	charge = None
	charges = getattr(intent, "charges", None)
	if charges and getattr(charges, "data", None):
		charge = charges.data[0]
	elif getattr(intent, "latest_charge", None):
		lc = intent.latest_charge
		charge = lc if not isinstance(lc, str) else _client().Charge.retrieve(lc)
	if not charge:
		return {"charge_id": None, "card_brand": None, "last4": None, "approval_code": None}
	pm = getattr(charge, "payment_method_details", None) or {}
	cp = pm.get("card_present") or pm.get("interac_present") or {}
	receipt = cp.get("receipt") or {}
	return {
		"charge_id": charge.id,
		"card_brand": (cp.get("brand") or "").title() or None,
		"last4": cp.get("last4"),
		"approval_code": receipt.get("authorization_code"),
		"receipt_url": getattr(charge, "receipt_url", None),
	}


def capture(payment_intent_id: str) -> dict[str, Any]:
	if not is_configured() or payment_intent_id.startswith("pi_sim_"):
		return {
			"id": payment_intent_id,
			"status": "succeeded",
			"charge_id": _sim_id("ch"),
			"card_brand": "Visa",
			"last4": "4242",
			"approval_code": secrets.token_hex(3).upper(),
			"simulated": True,
		}
	client = _client()
	intent = client.PaymentIntent.retrieve(payment_intent_id, expand=["latest_charge"])
	if intent.status == "requires_capture":
		intent = client.PaymentIntent.capture(payment_intent_id, expand=["latest_charge"])
	elif intent.status != "succeeded":
		frappe.throw(
			frappe._("PaymentIntent {0} cannot be captured (status {1})").format(payment_intent_id, intent.status),
			frappe.ValidationError,
		)
	return {"id": intent.id, "status": intent.status, "simulated": False, **_card_details(intent)}


def cancel(payment_intent_id: str) -> dict[str, Any]:
	if not is_configured() or payment_intent_id.startswith("pi_sim_"):
		return {"id": payment_intent_id, "status": "canceled", "simulated": True}
	intent = _client().PaymentIntent.cancel(payment_intent_id)
	return {"id": intent.id, "status": intent.status, "simulated": False}


def refund(payment_intent_id: str, amount_minor: Optional[int] = None, reason: Optional[str] = None) -> dict[str, Any]:
	if not is_configured() or payment_intent_id.startswith("pi_sim_"):
		return {"id": _sim_id("re"), "status": "succeeded", "simulated": True}
	params: dict[str, Any] = {"payment_intent": payment_intent_id}
	if amount_minor:
		params["amount"] = amount_minor
	if reason:
		params["metadata"] = {"reason": reason}
	r = _client().Refund.create(**params)
	return {"id": r.id, "status": r.status, "simulated": False}


# ---------------------------------------------------------------------------
# v0.4 — refunds (itemized returns)
# ---------------------------------------------------------------------------
def refund(payment_intent_id: str, amount_minor: int, *, reason: Optional[str] = None, idempotency_key: Optional[str] = None) -> dict[str, Any]:
	"""Refund *amount_minor* of a captured PaymentIntent (partial refunds allowed).

	Simulated (``re_sim_…``) when no key is configured or the intent itself was simulated.
	Stripe reason must be one of ``duplicate`` / ``fraudulent`` / ``requested_by_customer``.
	"""
	if amount_minor <= 0:
		frappe.throw(frappe._("Refund amount must be positive"), frappe.ValidationError)
	if not is_configured() or not payment_intent_id or payment_intent_id.startswith("pi_sim_") or not payment_intent_id.startswith("pi_"):
		return {"id": _sim_id("re"), "payment_intent": payment_intent_id, "amount": amount_minor, "status": "succeeded", "simulated": True}
	params: dict[str, Any] = {"payment_intent": payment_intent_id, "amount": amount_minor, "reason": "requested_by_customer"}
	if reason:
		params["metadata"] = {"awanz_reason": reason[:200]}
	if idempotency_key:
		params["idempotency_key"] = idempotency_key
	r = _client().Refund.create(**params)
	return {"id": r.id, "payment_intent": payment_intent_id, "amount": r.amount, "status": r.status, "simulated": False}
