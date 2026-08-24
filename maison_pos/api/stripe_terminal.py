"""Stripe Terminal endpoints (connection token, PaymentIntent create/capture).

Amounts are accepted in **major units** (e.g. ``12500.00`` USD) and converted
to the minor unit Stripe expects. When ``stripe_secret_key`` is absent from
``site_config.json`` the responses carry ``simulated: true``.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt

from maison_pos.scoping import assert_boutique_access, assert_roles, get_user_boutique, is_unrestricted, ALL_AWANZ_ROLES
from maison_pos.stripe_terminal import client as stripe_client

ZERO_DECIMAL = {"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"}


def to_minor(amount: float, currency: str) -> int:
	if currency.lower() in ZERO_DECIMAL:
		return cint(round(flt(amount)))
	return cint(round(flt(amount) * 100))


@frappe.whitelist()
def connection_token(boutique: Optional[str] = None) -> dict[str, Any]:
	"""``{secret, simulated, location?}`` for the Terminal JS SDK."""
	boutique = assert_boutique_access(boutique or get_user_boutique())
	location = frappe.db.get_value("AWANZ Store", boutique, "stripe_location_id")
	result = stripe_client.connection_token(location)
	result["location"] = location
	result["publishable_key"] = stripe_client.get_publishable_key()
	return result


@frappe.whitelist()
def create_payment_intent(
	amount: float,
	currency: str,
	offline_uuid: str,
	customer: Optional[str] = None,
	boutique: Optional[str] = None,
) -> dict[str, Any]:
	"""Create a manual-capture ``card_present`` PaymentIntent (idempotent on offline_uuid)."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	if flt(amount) <= 0:
		frappe.throw(_("amount must be positive"), frappe.ValidationError)
	if not offline_uuid:
		frappe.throw(_("offline_uuid is required"), frappe.ValidationError)
	if not currency or len(currency) != 3:
		frappe.throw(_("currency must be a 3-letter ISO code"), frappe.ValidationError)
	boutique = boutique or get_user_boutique()
	if boutique:
		boutique = assert_boutique_access(boutique)
	elif not is_unrestricted():
		frappe.throw(_("Boutique is required"), frappe.ValidationError)

	customer_name = frappe.db.get_value("Customer", customer, "customer_name") if customer else None
	return stripe_client.create_payment_intent(
		to_minor(amount, currency),
		currency,
		offline_uuid=offline_uuid,
		boutique=boutique,
		customer_name=customer_name,
	)


@frappe.whitelist()
def capture(payment_intent_id: str) -> dict[str, Any]:
	"""Capture an authorised PaymentIntent. ``{status, charge_id, card_brand, last4, approval_code}``."""
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	if not payment_intent_id:
		frappe.throw(_("payment_intent_id is required"), frappe.ValidationError)
	return stripe_client.capture(payment_intent_id)


@frappe.whitelist()
def cancel(payment_intent_id: str) -> dict[str, Any]:
	assert_roles(*ALL_AWANZ_ROLES, "System Manager")
	return stripe_client.cancel(payment_intent_id)


@frappe.whitelist()
def status() -> dict[str, Any]:
	"""Whether live keys are configured (never returns the secret)."""
	return {
		"configured": stripe_client.is_configured(),
		"publishable_key": stripe_client.get_publishable_key(),
		"simulated": not stripe_client.is_configured(),
	}
