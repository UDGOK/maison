"""Shippo adapter (https://goshippo.com — REST API v2018-02-08, ``requests``).

* API key: ``site_config.json`` → ``shippo_api_key`` (``shippo_test_…`` keys run in test mode and
  produce test labels; ``shippo_live_…`` keys buy real postage). Optional ``shippo_api_url`` for a
  proxy / sandbox.
* ``rates``: POST ``/shipments`` with ``async=false`` returns the shipment with its ``rates`` array.
* ``buy``: POST ``/transactions`` with ``rate`` (object id) + ``label_file_type`` → ``label_url``,
  ``tracking_number``, ``tracking_url_provider``. Shippo answers ``QUEUED`` for a moment; we poll
  ``GET /transactions/{id}`` a few times before giving up with the messages it returned.
* ``track``: GET ``/tracks/{carrier}/{tracking_number}``.

Every HTTP call goes through :func:`ShippoProvider._request` so tests can mock one seam.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import requests

from .base import BaseProvider, Label, Rate, ShippingError, Tracking, cm_to_in, kg_to_lb

DEFAULT_API_URL = "https://api.goshippo.com"
CARRIER_TOKENS = {"usps": "USPS", "ups": "UPS", "fedex": "FedEx", "dhl_express": "DHL Express"}


class ShippoProvider(BaseProvider):
	name = "shippo"

	def __init__(self, api_key: Optional[str] = None, api_url: Optional[str] = None, timeout: float = 20.0) -> None:
		if api_key is None:
			try:
				import frappe

				api_key = frappe.conf.get("shippo_api_key")
				api_url = api_url or frappe.conf.get("shippo_api_url")
			except Exception:  # pragma: no cover - outside frappe
				api_key = None
		if not api_key:
			raise ShippingError("Shippo is not configured: set `shippo_api_key` in site_config.json")
		self.api_key = api_key
		self.api_url = (api_url or DEFAULT_API_URL).rstrip("/")
		self.timeout = timeout
		self.test_mode = api_key.startswith("shippo_test")

	# ------------------------------------------------------------------ HTTP seam
	def _request(self, method: str, path: str, json: Optional[dict] = None) -> dict[str, Any]:
		headers = {"Authorization": f"ShippoToken {self.api_key}", "Content-Type": "application/json", "Shippo-API-Version": "2018-02-08"}
		try:
			res = requests.request(method, f"{self.api_url}{path}", json=json, headers=headers, timeout=self.timeout)
		except requests.RequestException as e:
			raise ShippingError(f"Shippo unreachable: {e}") from e
		if res.status_code >= 400:
			detail = ""
			try:
				detail = str(res.json())[:300]
			except ValueError:
				detail = res.text[:300]
			raise ShippingError(f"Shippo {res.status_code}: {detail}")
		try:
			return res.json()
		except ValueError as e:
			raise ShippingError("Shippo returned a non-JSON body") from e

	# ------------------------------------------------------------------ mapping
	@staticmethod
	def address(a: dict) -> dict[str, Any]:
		return {
			"name": a.get("name") or "",
			"company": a.get("company") or "",
			"street1": a.get("street1") or a.get("address_line") or "",
			"street2": a.get("street2") or "",
			"city": a.get("city") or "",
			"state": a.get("state") or "",
			"zip": str(a.get("zip") or a.get("postal_code") or ""),
			"country": a.get("country") or "US",
			"phone": a.get("phone") or "",
			"email": a.get("email") or "",
		}

	@staticmethod
	def parcel(p: dict) -> dict[str, Any]:
		return {
			"length": str(cm_to_in(float(p.get("length") or 30))),
			"width": str(cm_to_in(float(p.get("width") or 20))),
			"height": str(cm_to_in(float(p.get("height") or 15))),
			"distance_unit": "in",
			"weight": str(kg_to_lb(float(p.get("weight") or 0.5))),
			"mass_unit": "lb",
		}

	def rates(self, from_address: dict, to_address: dict, parcels: list[dict]) -> list[Rate]:
		if not parcels:
			raise ShippingError("No parcels to quote")
		payload = {
			"address_from": self.address(from_address),
			"address_to": self.address(to_address),
			"parcels": [self.parcel(p) for p in parcels],
			"async": False,
		}
		data = self._request("POST", "/shipments", payload)
		if data.get("status") not in (None, "SUCCESS") and not data.get("rates"):
			msgs = "; ".join(m.get("text", "") for m in data.get("messages", []))
			raise ShippingError(f"Shippo could not rate the shipment: {msgs or data.get('status')}")
		out: list[Rate] = []
		for r in data.get("rates", []):
			try:
				amount = float(r.get("amount"))
			except (TypeError, ValueError):
				continue
			carrier = CARRIER_TOKENS.get(str(r.get("provider", "")).lower(), r.get("provider") or "")
			service = (r.get("servicelevel") or {}).get("name") or r.get("servicelevel_name") or ""
			out.append(
				Rate(
					carrier=carrier,
					service=service,
					amount=amount,
					days=r.get("estimated_days"),
					provider_rate_id=r.get("object_id"),
					provider=self.name,
					currency=r.get("currency") or "USD",
					attributes=list(r.get("attributes") or []),
					estimated_delivery=r.get("arrives_by"),
				)
			)
		return sorted(out, key=lambda x: x.amount)

	def buy(self, rate: Rate | dict, label_file_type: str = "PDF_4x6", poll: int = 5, wait: float = 1.0) -> Label:
		r = self.to_rate(rate)
		tx = self._request("POST", "/transactions", {"rate": r.provider_rate_id, "label_file_type": label_file_type, "async": False})
		tries = 0
		while tx.get("status") == "QUEUED" and tries < poll:
			tries += 1
			time.sleep(wait)
			tx = self._request("GET", f"/transactions/{tx.get('object_id')}")
		if tx.get("status") != "SUCCESS":
			msgs = "; ".join(m.get("text", "") for m in tx.get("messages", []))
			raise ShippingError(f"Shippo label purchase failed: {msgs or tx.get('status')}")
		return Label(
			label_url=tx.get("label_url") or "",
			tracking_no=tx.get("tracking_number") or "",
			tracking_url=tx.get("tracking_url_provider"),
			provider=self.name,
			carrier=r.carrier,
			service=r.service,
			amount=r.amount,
			provider_transaction_id=tx.get("object_id"),
			label_format=label_file_type,
		)

	def track(self, tracking_no: str, carrier: Optional[str] = None) -> Tracking:
		token = {v.lower(): k for k, v in CARRIER_TOKENS.items()}.get((carrier or "usps").lower(), (carrier or "usps").lower())
		data = self._request("GET", f"/tracks/{token}/{tracking_no}")
		status = data.get("tracking_status") or {}
		events = [
			{"at": h.get("status_date"), "status": h.get("status"), "message": h.get("status_details"), "location": _loc(h.get("location"))}
			for h in data.get("tracking_history", [])
		]
		return Tracking(
			tracking_no=tracking_no,
			status=status.get("status") or "UNKNOWN",
			status_detail=status.get("status_details"),
			location=_loc(status.get("location")),
			eta=data.get("eta"),
			events=events,
			tracking_url=None,
		)


def _loc(location: Optional[dict]) -> Optional[str]:
	if not location:
		return None
	return ", ".join(p for p in (location.get("city"), location.get("state")) if p) or None
