"""Rate-shopping adapter interface (v0.6 P).

Every provider speaks the same three verbs:

* ``rates(from_address, to_address, parcels) -> [Rate]``
* ``buy(rate) -> Label``
* ``track(tracking_no, carrier=None) -> Tracking``

Addresses are plain dicts ``{name, street1, street2, city, state, zip, country, phone, email}``;
parcels ``[{length, width, height (cm), weight (kg)}]``. Amounts are USD floats; ``days`` is the
carrier's estimated transit in business days. ``provider_rate_id`` is opaque and is what ``buy``
needs back (together with the provider name) — the API layer caches the last quote on the
shipment so the admin can override the auto-selection.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Optional


@dataclass
class Rate:
	carrier: str
	service: str
	amount: float
	days: Optional[int]
	provider_rate_id: str
	provider: str
	currency: str = "USD"
	attributes: list[str] = field(default_factory=list)
	estimated_delivery: Optional[str] = None

	def as_dict(self) -> dict[str, Any]:
		return asdict(self)


@dataclass
class Label:
	label_url: str
	tracking_no: str
	tracking_url: Optional[str]
	provider: str
	carrier: str
	service: str
	amount: float
	provider_transaction_id: Optional[str] = None
	label_format: str = "PDF"

	def as_dict(self) -> dict[str, Any]:
		return asdict(self)


@dataclass
class Tracking:
	tracking_no: str
	status: str
	status_detail: Optional[str] = None
	location: Optional[str] = None
	eta: Optional[str] = None
	events: list[dict[str, Any]] = field(default_factory=list)
	tracking_url: Optional[str] = None

	def as_dict(self) -> dict[str, Any]:
		return asdict(self)


class ShippingError(Exception):
	"""Raised for provider / configuration failures (shown to the admin as a message)."""


class BaseProvider:
	name = "base"
	test_mode = False

	def rates(self, from_address: dict, to_address: dict, parcels: list[dict]) -> list[Rate]:  # pragma: no cover - interface
		raise NotImplementedError

	def buy(self, rate: Rate | dict) -> Label:  # pragma: no cover - interface
		raise NotImplementedError

	def track(self, tracking_no: str, carrier: Optional[str] = None) -> Tracking:  # pragma: no cover - interface
		raise NotImplementedError

	# ------------------------------------------------------------------ helpers
	@staticmethod
	def to_rate(value: Rate | dict) -> Rate:
		if isinstance(value, Rate):
			return value
		known = {k: value.get(k) for k in ("carrier", "service", "amount", "days", "provider_rate_id", "provider", "currency", "attributes", "estimated_delivery") if k in value}
		known.setdefault("currency", "USD")
		known.setdefault("attributes", [])
		return Rate(**known)


def pick_rate(rates: list[Rate], prefer: str = "cheapest") -> Optional[Rate]:
	"""Auto-selection: ``cheapest`` (default) or ``fastest`` (fewest days, then cheapest)."""
	if not rates:
		return None
	if prefer == "fastest":
		return sorted(rates, key=lambda r: (r.days if r.days is not None else 99, r.amount))[0]
	return sorted(rates, key=lambda r: (r.amount, r.days if r.days is not None else 99))[0]


def total_weight_kg(parcels: list[dict]) -> float:
	return round(sum(float(p.get("weight") or 0) for p in parcels), 3)


def kg_to_lb(kg: float) -> float:
	return round(kg * 2.20462, 2)


def cm_to_in(cm: float) -> float:
	return round(cm / 2.54, 2)
