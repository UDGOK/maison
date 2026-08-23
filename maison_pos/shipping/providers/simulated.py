"""Simulated carrier (default provider): realistic USPS / UPS / FedEx tiers by zone and weight.

No network, deterministic. The zone is derived from the great-circle distance between the
origin and destination *state* centroids (ZIP-3 is used to nudge within a state), mapped to the
USPS zone table (1–2 ≤ 150 mi … 8 > 1 800 mi). Prices follow the published 2025/26 commercial
tables closely enough for budgeting: USPS Ground Advantage and Priority Mail (commercial base),
UPS Ground, FedEx Home Delivery, plus express tiers so the "fastest" toggle has something to pick.
Tracking numbers are fake but carrier-shaped; ``track`` walks a plausible event timeline by age.
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta
from typing import Optional

from .base import BaseProvider, Label, Rate, ShippingError, Tracking, kg_to_lb, total_weight_kg

# (lat, lon) centroids — enough precision for zones
STATE_CENTROIDS: dict[str, tuple[float, float]] = {
	"AL": (32.8, -86.8), "AK": (64.2, -149.5), "AZ": (34.2, -111.7), "AR": (34.9, -92.4), "CA": (36.8, -119.4),
	"CO": (39.0, -105.5), "CT": (41.6, -72.7), "DE": (39.0, -75.5), "DC": (38.9, -77.0), "FL": (28.6, -82.4),
	"GA": (32.6, -83.4), "HI": (20.8, -156.3), "ID": (44.4, -114.6), "IL": (40.0, -89.2), "IN": (39.9, -86.3),
	"IA": (42.1, -93.5), "KS": (38.5, -98.4), "KY": (37.5, -85.3), "LA": (31.1, -91.9), "ME": (45.4, -69.2),
	"MD": (39.0, -76.8), "MA": (42.3, -71.8), "MI": (44.3, -85.4), "MN": (46.3, -94.3), "MS": (32.7, -89.7),
	"MO": (38.4, -92.5), "MT": (47.0, -109.6), "NE": (41.5, -99.8), "NV": (39.3, -116.6), "NH": (43.7, -71.6),
	"NJ": (40.1, -74.5), "NM": (34.4, -106.1), "NY": (42.9, -75.5), "NC": (35.6, -79.4), "ND": (47.5, -100.5),
	"OH": (40.3, -82.8), "OK": (35.6, -97.5), "OR": (43.9, -120.6), "PA": (40.9, -77.8), "RI": (41.7, -71.6),
	"SC": (33.9, -80.9), "SD": (44.4, -100.2), "TN": (35.9, -86.4), "TX": (31.5, -99.3), "UT": (39.3, -111.7),
	"VT": (44.1, -72.7), "VA": (37.5, -78.9), "WA": (47.4, -120.5), "WV": (38.6, -80.6), "WI": (44.6, -89.9),
	"WY": (43.0, -107.6),
}
# ZIP-3 → rough (lat, lon) for the client's cities so intra-state zones are right (Houston vs Tulsa metro etc.)
ZIP3_CENTROIDS: dict[str, tuple[float, float]] = {
	"770": (29.76, -95.37), "772": (29.7, -95.4), "773": (29.8, -95.5), "774": (29.6, -95.6), "775": (29.5, -94.9),
	"740": (36.0, -95.9), "741": (36.15, -95.99), "743": (35.75, -95.37), "744": (35.45, -97.5), "730": (35.47, -97.52),
	"731": (35.5, -97.5), "733": (33.9, -98.5),
}


def _coords(address: dict) -> Optional[tuple[float, float]]:
	zip3 = str(address.get("zip") or address.get("postal_code") or "")[:3]
	if zip3 in ZIP3_CENTROIDS:
		return ZIP3_CENTROIDS[zip3]
	state = str(address.get("state") or "").strip().upper()[:2]
	return STATE_CENTROIDS.get(state)


def distance_miles(a: dict, b: dict) -> float:
	ca, cb = _coords(a), _coords(b)
	if not ca or not cb:
		return 900.0  # unknown → zone 5, a fair national average
	lat1, lon1, lat2, lon2 = map(math.radians, (*ca, *cb))
	h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
	return 3958.8 * 2 * math.asin(math.sqrt(h))


def usps_zone(miles: float) -> int:
	for zone, limit in ((2, 150), (3, 300), (4, 600), (5, 1000), (6, 1400), (7, 1800)):
		if miles <= limit:
			return zone
	return 8


def billable_lb(parcels: list[dict]) -> float:
	"""Max of actual and dimensional weight (139 in³/lb, the carriers' ground divisor)."""
	actual = kg_to_lb(total_weight_kg(parcels))
	dim = 0.0
	for p in parcels:
		l, w, h = (float(p.get(k) or 0) / 2.54 for k in ("length", "width", "height"))
		dim += (l * w * h) / 139.0
	return max(1.0, math.ceil(max(actual, dim)))


# service → (base at 1 lb zone 2, per-lb increment, zone factor per zone step, business days by zone)
SERVICES = [
	("USPS", "Ground Advantage", 5.25, 0.62, 0.09, (2, 2, 3, 3, 4, 5, 5), ["tracking"]),
	("USPS", "Priority Mail", 8.15, 0.95, 0.11, (1, 2, 2, 2, 3, 3, 3), ["tracking", "insurance_100"]),
	("USPS", "Priority Mail Express", 28.5, 2.1, 0.12, (1, 1, 1, 2, 2, 2, 2), ["tracking", "insurance_100", "guaranteed"]),
	("UPS", "Ground", 9.4, 0.78, 0.1, (1, 2, 3, 3, 4, 5, 5), ["tracking", "signature_optional"]),
	("UPS", "2nd Day Air", 19.9, 1.9, 0.08, (2, 2, 2, 2, 2, 2, 2), ["tracking", "guaranteed"]),
	("UPS", "Next Day Air Saver", 39.0, 3.2, 0.09, (1, 1, 1, 1, 1, 1, 1), ["tracking", "guaranteed"]),
	("FedEx", "Home Delivery", 9.9, 0.8, 0.1, (1, 2, 3, 3, 4, 5, 5), ["tracking", "residential"]),
	("FedEx", "2Day", 20.5, 1.85, 0.08, (2, 2, 2, 2, 2, 2, 2), ["tracking", "guaranteed"]),
]
_ZONE_INDEX = {2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6}


def price(base: float, per_lb: float, zone_factor: float, lb: float, zone: int, parcels: int) -> float:
	zone_mult = 1 + zone_factor * (zone - 2)
	amount = (base + per_lb * (lb - 1)) * zone_mult
	if lb > 20:
		amount *= 1.12  # oversize handling
	return round(amount * max(1, parcels), 2)


class SimulatedProvider(BaseProvider):
	name = "simulated"
	test_mode = True

	def rates(self, from_address: dict, to_address: dict, parcels: list[dict]) -> list[Rate]:
		if not parcels:
			raise ShippingError("No parcels to quote")
		miles = distance_miles(from_address, to_address)
		zone = usps_zone(miles)
		lb = billable_lb(parcels)
		n = len(parcels)
		out: list[Rate] = []
		for carrier, service, base, per_lb, zf, days_by_zone, attrs in SERVICES:
			amount = price(base, per_lb, zf, lb, zone, n)
			days = days_by_zone[_ZONE_INDEX[zone]]
			rid = "sim_" + hashlib.sha1(f"{carrier}|{service}|{zone}|{lb}|{n}|{amount}".encode()).hexdigest()[:12]
			out.append(Rate(carrier=carrier, service=service, amount=amount, days=days, provider_rate_id=rid, provider=self.name, attributes=list(attrs) + [f"zone_{zone}", f"{lb:g}_lb"]))
		return sorted(out, key=lambda r: r.amount)

	def buy(self, rate: Rate | dict) -> Label:
		r = self.to_rate(rate)
		if not r.provider_rate_id.startswith("sim_"):
			raise ShippingError("Rate does not belong to the simulated provider")
		seed = hashlib.sha1(f"{r.provider_rate_id}|{datetime.utcnow().isoformat()}".encode()).hexdigest()
		digits = "".join(str(int(c, 16) % 10) for c in seed[:22])
		if r.carrier == "USPS":
			tracking = "9400" + digits[:18]
		elif r.carrier == "UPS":
			tracking = "1Z8" + seed[:5].upper() + digits[:10]
		else:
			tracking = digits[:12]
		return Label(
			label_url=f"/shipping-label/{tracking}",
			tracking_no=tracking,
			tracking_url=tracking_url(r.carrier, tracking),
			provider=self.name,
			carrier=r.carrier,
			service=r.service,
			amount=r.amount,
			provider_transaction_id="simtx_" + seed[:10],
		)

	def track(self, tracking_no: str, carrier: Optional[str] = None, shipped_at: Optional[datetime] = None, days: Optional[int] = None) -> Tracking:
		"""A plausible timeline: label → accepted after 2 h → in transit → out for delivery → delivered after ``days``."""
		now = datetime.utcnow()
		start = shipped_at or (now - timedelta(hours=1))
		age_h = (now - start).total_seconds() / 3600.0
		transit_h = max(12, (days or 3) * 24)
		timeline = [
			(0.0, "PRE_TRANSIT", "Shipping label created"),
			(2.0, "TRANSIT", "Accepted at origin facility"),
			(transit_h * 0.5, "TRANSIT", "In transit to destination"),
			(transit_h - 6, "OUT_FOR_DELIVERY", "Out for delivery"),
			(transit_h, "DELIVERED", "Delivered"),
		]
		events = [{"at": (start + timedelta(hours=h)).isoformat(), "status": s, "message": m} for h, s, m in timeline if h <= age_h]
		status = events[-1]["status"] if events else "PRE_TRANSIT"
		return Tracking(tracking_no=tracking_no, status=status, status_detail=events[-1]["message"] if events else None, eta=(start + timedelta(hours=transit_h)).isoformat(), events=events, tracking_url=tracking_url(carrier or "USPS", tracking_no))


def tracking_url(carrier: str, tracking_no: str) -> str:
	c = (carrier or "").upper()
	if c.startswith("UPS"):
		return f"https://www.ups.com/track?tracknum={tracking_no}"
	if c.startswith("FEDEX"):
		return f"https://www.fedex.com/fedextrack/?trknbr={tracking_no}"
	return f"https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking_no}"
