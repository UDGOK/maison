"""Item affinity (co-purchase lift) and next-best-offer recommendations.

Model
-----
From every submitted, non-return POS Sales Invoice of the last ``lookback_days`` we take the
set of item codes in the basket. For a pair (a, b):

* ``support(a)``      = baskets containing a / baskets
* ``support(a, b)``   = baskets containing both / baskets
* ``confidence(a→b)`` = support(a, b) / support(a)
* ``lift(a, b)``      = support(a, b) / (support(a) · support(b))   (1 = independent, > 1 = affinity)

Baskets are small in luxury retail (most have one line), so a second signal is blended in:
*client co-ownership* — the union of everything one client bought, counted as one basket with
weight ``CLIENT_BASKET_WEIGHT``. This captures "people who own a Meridian also come back for a
strap / a service" even when those were separate visits.

Recommendation score for a candidate ``c`` given a context set ``S`` (basket lines or the
client's owned items)::

    score(c) = Σ_{s ∈ S} lift(s, c) · min(1, support(s, c) / MIN_PAIR_SUPPORT)

The support factor damps pairs seen only once or twice. Candidates already in ``S`` (and, for a
client, anything they already own) are excluded. When nothing co-occurs, the fallback ranks
items of the same item group by popularity so the tiles are never empty.

Everything here is pure python and works on plain dicts so it can be unit-tested without a site.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Iterable, Optional

import frappe
from frappe.utils import add_days, cint, flt, nowdate

LOOKBACK_DAYS = 365
CLIENT_BASKET_WEIGHT = 0.5
MIN_PAIR_SUPPORT = 3.0  # pairs seen at least this many (weighted) times get full credit
MIN_LIFT = 1.05


# ---------------------------------------------------------------------------
# pure math
# ---------------------------------------------------------------------------
class AffinityModel:
	"""Co-occurrence counts and the derived lift / confidence tables."""

	def __init__(self) -> None:
		self.n_baskets = 0.0
		self.item_count: dict[str, float] = defaultdict(float)
		self.pair_count: dict[tuple[str, str], float] = defaultdict(float)

	# -- building
	def add_basket(self, items: Iterable[str], weight: float = 1.0) -> None:
		codes = sorted({c for c in items if c})
		if not codes:
			return
		self.n_baskets += weight
		for c in codes:
			self.item_count[c] += weight
		for i, a in enumerate(codes):
			for b in codes[i + 1 :]:
				self.pair_count[(a, b)] += weight

	@classmethod
	def from_baskets(cls, baskets: Iterable[Iterable[str]], weight: float = 1.0) -> "AffinityModel":
		m = cls()
		for b in baskets:
			m.add_basket(b, weight)
		return m

	# -- queries
	def pair(self, a: str, b: str) -> float:
		if a == b:
			return 0.0
		return self.pair_count.get((a, b) if a < b else (b, a), 0.0)

	def support(self, a: str, b: Optional[str] = None) -> float:
		if not self.n_baskets:
			return 0.0
		if b is None:
			return self.item_count.get(a, 0.0) / self.n_baskets
		return self.pair(a, b) / self.n_baskets

	def confidence(self, a: str, b: str) -> float:
		"""P(b | a)."""
		ca = self.item_count.get(a, 0.0)
		return self.pair(a, b) / ca if ca else 0.0

	def lift(self, a: str, b: str) -> float:
		sa, sb, sab = self.support(a), self.support(b), self.support(a, b)
		if not sa or not sb or not sab:
			return 0.0
		return sab / (sa * sb)

	def partners(self, a: str, min_lift: float = MIN_LIFT) -> list[dict[str, Any]]:
		"""All items with lift > min_lift against *a*, strongest first."""
		out = []
		for (x, y), n in self.pair_count.items():
			if a not in (x, y) or n <= 0:
				continue
			b = y if x == a else x
			lift = self.lift(a, b)
			if lift >= min_lift:
				out.append({"item_code": b, "lift": round(lift, 3), "confidence": round(self.confidence(a, b), 3), "pairs": n})
		out.sort(key=lambda r: (-r["lift"] * min(1.0, r["pairs"] / MIN_PAIR_SUPPORT), -r["pairs"]))
		return out

	def score_candidates(self, context: Iterable[str], exclude: Iterable[str] = ()) -> dict[str, dict[str, Any]]:
		"""Aggregate lift of every candidate against the context set."""
		ctx = {c for c in context if c}
		skip = set(exclude) | ctx
		scores: dict[str, dict[str, Any]] = {}
		for s in ctx:
			for p in self.partners(s, min_lift=MIN_LIFT):
				c = p["item_code"]
				if c in skip:
					continue
				contrib = p["lift"] * min(1.0, p["pairs"] / MIN_PAIR_SUPPORT)
				row = scores.setdefault(c, {"item_code": c, "score": 0.0, "because": None, "best_lift": 0.0, "confidence": 0.0})
				row["score"] += contrib
				if contrib > row["best_lift"]:
					row["best_lift"] = contrib
					row["because"] = s
					row["confidence"] = p["confidence"]
		return scores


def rank(scores: dict[str, dict[str, Any]], n: int) -> list[dict[str, Any]]:
	return sorted(scores.values(), key=lambda r: (-r["score"], r["item_code"]))[: max(0, n)]


# ---------------------------------------------------------------------------
# loaders (frappe)
# ---------------------------------------------------------------------------
def load_baskets(lookback_days: int = LOOKBACK_DAYS, company: Optional[str] = None) -> tuple[list[set[str]], dict[str, set[str]]]:
	"""(invoice baskets, {customer: owned item codes}) from submitted non-return POS invoices."""
	since = add_days(nowdate(), -int(lookback_days))
	filters: dict[str, Any] = {"docstatus": 1, "is_pos": 1, "is_return": 0, "posting_date": (">=", since)}
	if company:
		filters["company"] = company
	invoices = frappe.get_all("Sales Invoice", filters=filters, fields=["name", "customer"])
	if not invoices:
		return [], {}
	walk_in = set(frappe.get_all("POS Profile", pluck="customer"))
	names = [i.name for i in invoices]
	by_invoice: dict[str, set[str]] = defaultdict(set)
	for r in frappe.get_all("Sales Invoice Item", filters={"parent": ("in", names)}, fields=["parent", "item_code"]):
		by_invoice[r.parent].add(r.item_code)
	baskets = [by_invoice[i.name] for i in invoices if by_invoice.get(i.name)]
	owned: dict[str, set[str]] = defaultdict(set)
	for i in invoices:
		if i.customer and i.customer not in walk_in:
			owned[i.customer] |= by_invoice.get(i.name, set())
	return baskets, dict(owned)


def build_model(lookback_days: int = LOOKBACK_DAYS) -> AffinityModel:
	baskets, owned = load_baskets(lookback_days)
	m = AffinityModel.from_baskets(baskets)
	for items in owned.values():
		if len(items) > 1:
			m.add_basket(items, CLIENT_BASKET_WEIGHT)
	return m


_CACHE_KEY = "maison_affinity_model"


def get_model(refresh: bool = False) -> AffinityModel:
	"""Process-level cache of the model (rebuilt by the weekly job or after an hour)."""
	cache = getattr(frappe.local, "_maison_affinity", None)
	if cache and not refresh:
		return cache
	m = build_model()
	frappe.local._maison_affinity = m
	return m


def item_meta(codes: Iterable[str]) -> dict[str, dict[str, Any]]:
	codes = [c for c in set(codes) if c]
	if not codes:
		return {}
	rows = frappe.get_all(
		"Item",
		filters={"name": ("in", codes)},
		fields=["name", "item_name", "item_group", "image", "has_serial_no", "is_stock_item", "maison_department", "maison_metal", "standard_rate", "disabled"],
	)
	return {r.name: r for r in rows}


def owned_items(customer: str) -> set[str]:
	"""Everything the client bought (net of full returns)."""
	rows = frappe.get_all(
		"Sales Invoice",
		filters={"customer": customer, "docstatus": 1, "is_pos": 1},
		fields=["name", "is_return", "return_against"],
	)
	if not rows:
		return set()
	returned = {r.return_against for r in rows if r.is_return and r.return_against}
	names = [r.name for r in rows if not r.is_return and r.name not in returned]
	if not names:
		return set()
	return {r.item_code for r in frappe.get_all("Sales Invoice Item", filters={"parent": ("in", names)}, fields=["item_code"])}


def popular_items(limit: int = 50, lookback_days: int = LOOKBACK_DAYS) -> list[dict[str, Any]]:
	since = add_days(nowdate(), -int(lookback_days))
	SII = frappe.qb.DocType("Sales Invoice Item")
	SI = frappe.qb.DocType("Sales Invoice")
	from frappe.query_builder.functions import Sum

	rows = (
		frappe.qb.from_(SII)
		.join(SI)
		.on(SII.parent == SI.name)
		.select(SII.item_code, Sum(SII.qty).as_("units"))
		.where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.is_return == 0) & (SI.posting_date >= since))
		.groupby(SII.item_code)
		.orderby(Sum(SII.qty), order=frappe.qb.desc)
		.limit(limit)
	).run(as_dict=True)
	return rows


def _stock_for(codes: Iterable[str], boutique: Optional[str]) -> dict[str, float]:
	if not boutique:
		return {}
	warehouse = frappe.db.get_value("Maison Boutique", boutique, "warehouse")
	if not warehouse:
		return {}
	rows = frappe.get_all("Bin", filters={"warehouse": warehouse, "item_code": ("in", list(codes))}, fields=["item_code", "actual_qty"])
	return {r.item_code: flt(r.actual_qty) for r in rows}


def _decorate(rows: list[dict[str, Any]], boutique: Optional[str], price_list: str = "Standard Selling") -> list[dict[str, Any]]:
	meta = item_meta([r["item_code"] for r in rows])
	stock = _stock_for(meta.keys(), boutique)
	prices = {
		p.item_code: flt(p.price_list_rate)
		for p in frappe.get_all("Item Price", filters={"item_code": ("in", list(meta.keys())), "price_list": price_list, "selling": 1}, fields=["item_code", "price_list_rate"])
	} if meta else {}
	out = []
	for r in rows:
		m = meta.get(r["item_code"])
		if not m or m.disabled:
			continue
		because_name = frappe.db.get_value("Item", r["because"], "item_name") if r.get("because") else None
		out.append(
			{
				"item_code": r["item_code"],
				"item_name": m.item_name,
				"item_group": m.item_group,
				"department": m.maison_department,
				"metal": m.maison_metal,
				"image": frappe.utils.get_url(m.image) if m.image else None,
				"has_serial_no": cint(m.has_serial_no),
				"is_stock_item": cint(m.is_stock_item),
				"rate": prices.get(r["item_code"], flt(m.standard_rate)),
				"score": round(flt(r.get("score")), 3),
				"lift": round(flt(r.get("best_lift")), 3),
				"confidence": round(flt(r.get("confidence")), 3),
				"because": r.get("because"),
				"because_name": because_name,
				"reason": r.get("reason") or (f"Bought with {because_name} in {round(flt(r.get('confidence')) * 100)}% of baskets" if because_name else "Popular in this department"),
				"in_stock": (stock.get(r["item_code"], 0) > 0) if boutique and cint(m.is_stock_item) else None,
			}
		)
	return out


def _fallback(context: Iterable[str], exclude: Iterable[str], n: int) -> list[dict[str, Any]]:
	"""Same-group popularity when the lift table has nothing to say."""
	ctx = [c for c in context if c]
	skip = set(exclude) | set(ctx)
	meta = item_meta(ctx)
	groups = {m.item_group for m in meta.values()}
	rows = []
	for p in popular_items(limit=80):
		if p.item_code in skip:
			continue
		g = frappe.db.get_value("Item", p.item_code, "item_group")
		bonus = 2.0 if g in groups else 1.0
		rows.append({"item_code": p.item_code, "score": round(math.log1p(flt(p.units)) * bonus * 0.1, 3), "because": None, "best_lift": 0.0, "confidence": 0.0, "reason": "Popular with clients like this" if g in groups else "Bestseller"})
	rows.sort(key=lambda r: -r["score"])
	return rows[:n]


# ---------------------------------------------------------------------------
# public API used by api/insights.py and jobs.py
# ---------------------------------------------------------------------------
def recommend_for_basket(items: Iterable[str], n: int = 3, boutique: Optional[str] = None, exclude: Iterable[str] = (), model: Optional[AffinityModel] = None) -> list[dict[str, Any]]:
	"""'Pairs well with' for the current basket."""
	items = [i for i in items if i]
	if not items:
		return []
	model = model or get_model()
	ranked = rank(model.score_candidates(items, exclude), n)
	if len(ranked) < n:
		have = {r["item_code"] for r in ranked}
		ranked += [r for r in _fallback(items, set(exclude) | have, n) if r["item_code"] not in have][: n - len(ranked)]
	return _decorate(ranked, boutique)


def recommend_for_client(customer: str, n: int = 3, boutique: Optional[str] = None, model: Optional[AffinityModel] = None, owned: Optional[set[str]] = None) -> list[dict[str, Any]]:
	"""'Suggested for this client' — never something they already own."""
	owned = owned if owned is not None else owned_items(customer)
	model = model or get_model()
	if owned:
		ranked = rank(model.score_candidates(owned, owned), n)
	else:
		ranked = []
	if len(ranked) < n:
		have = {r["item_code"] for r in ranked}
		ranked += [r for r in _fallback(owned, owned | have, n) if r["item_code"] not in have][: n - len(ranked)]
	rows = _decorate(ranked, boutique)
	# belt and braces: the cache / fallback must never surface an owned item
	return [r for r in rows if r["item_code"] not in owned][:n]


def compute_client_recommendations(n: int = 5, lookback_days: int = LOOKBACK_DAYS) -> dict[str, Any]:
	"""Weekly job: refresh ``Maison Client Recommendation`` for every client with a purchase."""
	baskets, owned = load_baskets(lookback_days)
	model = AffinityModel.from_baskets(baskets)
	for items in owned.values():
		if len(items) > 1:
			model.add_basket(items, CLIENT_BASKET_WEIGHT)
	frappe.local._maison_affinity = model

	customers = sorted(owned.keys())
	names = {r.name: r.customer_name for r in frappe.get_all("Customer", filters={"name": ("in", customers)}, fields=["name", "customer_name"])} if customers else {}
	boutique_of = preferred_boutiques(customers)
	computed_at = frappe.utils.now_datetime()
	written = 0
	frappe.db.delete("Maison Client Recommendation")
	for customer in customers:
		recs = recommend_for_client(customer, n=n, boutique=boutique_of.get(customer), model=model, owned=owned[customer])
		for i, r in enumerate(recs, start=1):
			frappe.get_doc(
				{
					"doctype": "Maison Client Recommendation",
					"customer": customer,
					"customer_name": names.get(customer),
					"boutique": boutique_of.get(customer),
					"item_code": r["item_code"],
					"item_name": r["item_name"],
					"item_group": r["item_group"],
					"rank": i,
					"score": r["score"],
					"lift": r["lift"],
					"confidence": r["confidence"],
					"because": r.get("because"),
					"reason": r["reason"],
					"computed_at": computed_at,
				}
			).insert(ignore_permissions=True)
			written += 1
	return {"customers": len(customers), "recommendations": written, "baskets": len(baskets), "pairs": len(model.pair_count)}


def cached_recommendations(customer: str, n: int = 3, boutique: Optional[str] = None, max_age_days: int = 8) -> Optional[list[dict[str, Any]]]:
	rows = frappe.get_all(
		"Maison Client Recommendation",
		filters={"customer": customer},
		fields=["item_code", "score", "lift", "confidence", "because", "reason", "computed_at"],
		order_by="rank asc",
		limit=max(n, 1),
	)
	if not rows:
		return None
	if rows[0].computed_at and frappe.utils.date_diff(nowdate(), rows[0].computed_at) > max_age_days:
		return None
	return _decorate([{"item_code": r.item_code, "score": r.score, "best_lift": r.lift, "confidence": r.confidence, "because": r.because, "reason": r.reason} for r in rows], boutique)


def preferred_boutiques(customers: list[str]) -> dict[str, str]:
	"""Most-visited boutique per client."""
	if not customers:
		return {}
	rows = frappe.get_all(
		"Sales Invoice",
		filters={"customer": ("in", customers), "docstatus": 1, "is_pos": 1, "is_return": 0},
		fields=["customer", "maison_boutique", "count(name) as n"],
		group_by="customer, maison_boutique",
	)
	best: dict[str, tuple[int, str]] = {}
	for r in rows:
		if not r.maison_boutique:
			continue
		if r.customer not in best or cint(r.n) > best[r.customer][0]:
			best[r.customer] = (cint(r.n), r.maison_boutique)
	return {c: b for c, (_n, b) in best.items()}
