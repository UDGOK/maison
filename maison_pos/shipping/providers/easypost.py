"""EasyPost adapter — stub (v0.6 P).

EasyPost (https://www.easypost.com) is the alternative to Shippo with the same shape:
``POST /v2/shipments`` (to/from address + parcel → ``rates``), ``POST /v2/shipments/{id}/buy``
(``rate.id`` → ``postage_label.label_url`` + ``tracking_code``), ``GET /v2/trackers``.
Key in ``site_config.json`` → ``easypost_api_key`` (``EZTK…`` test keys, ``EZAK…`` production).

The class below validates configuration and documents the mapping; the HTTP calls are left as
``NotImplementedError`` on purpose — the client chose Shippo (see docs/shipping.md). Implementing
it is a ~100-line job mirroring ``shippo.py`` (same ``_request`` seam for tests).
"""

from __future__ import annotations

from typing import Optional

from .base import BaseProvider, Label, Rate, ShippingError, Tracking

DEFAULT_API_URL = "https://api.easypost.com/v2"


class EasyPostProvider(BaseProvider):
	name = "easypost"

	def __init__(self, api_key: Optional[str] = None, api_url: Optional[str] = None) -> None:
		if api_key is None:
			try:
				import frappe

				api_key = frappe.conf.get("easypost_api_key")
			except Exception:  # pragma: no cover
				api_key = None
		if not api_key:
			raise ShippingError("EasyPost is not configured: set `easypost_api_key` in site_config.json")
		self.api_key = api_key
		self.api_url = (api_url or DEFAULT_API_URL).rstrip("/")
		self.test_mode = api_key.startswith("EZTK")

	def rates(self, from_address: dict, to_address: dict, parcels: list[dict]) -> list[Rate]:
		raise NotImplementedError("EasyPost adapter is a stub — see docs/shipping.md")

	def buy(self, rate: Rate | dict) -> Label:
		raise NotImplementedError("EasyPost adapter is a stub — see docs/shipping.md")

	def track(self, tracking_no: str, carrier: Optional[str] = None) -> Tracking:
		raise NotImplementedError("EasyPost adapter is a stub — see docs/shipping.md")
