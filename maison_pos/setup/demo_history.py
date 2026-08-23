"""Six months of plausible historical POS sales — ``maison_pos.setup.demo_history.seed_history``.

``bench --site maison.localhost execute maison_pos.setup.demo_history.seed_history --kwargs '{"months": 6}'``

Why a separate function: the base demo seed (``maison_pos.setup.demo.seed``) runs in seconds;
posting ~1,500 submitted Sales Invoices (stock ledger, GL, loyalty points) takes minutes, so
history is opt-in and runs in committed chunks.

What it generates (deterministic — ``random.Random(HISTORY_SEED)``):

* ~1,500 POS Sales Invoices (``TARGET_INVOICES``, scaled with ``months``) across the three demo
  boutiques, with weekday / seasonal intensity (Valentine's, Mother's Day, wedding season,
  summer dip, holiday ramp), opening hours, associates, mixed Cash / Card tenders.
* ~120 additional "history" clients with personas: home boutique, visit cadence, department and
  metal preference, budget band, a lapsed subset (churn signals) and a VIP subset.
  ~60 % of invoices carry a client; repeat visits follow each client's cadence.
* Built-in co-purchase patterns (watch → strap, solitaire → band, chain → pendant, high
  jewellery → appraisal, …) so the affinity model has real lift to find.
* Back-dated Material Receipts (one per boutique, dated before the first sale) for every unit
  / serial the history sells, so serialized pieces are always available when sold and current
  bins never go negative. History serials are ``<item>-<city>-H###``.
* A few returns: via ``maison_pos.api.returns`` when that module exists (v0.4 E), else plain
  ERPNext credit notes through ``maison_pos.api.sales.void``.

Idempotent: every invoice carries ``maison_offline_uuid = hist-<seed>-<n>``; a completed run
stores a marker (``frappe.defaults`` key ``maison_history_seed``) and later calls return
immediately. An interrupted run resumes where it stopped (existing uuids are skipped).
Chunks of ``CHUNK_SIZE`` invoices are committed so a ``bench execute`` never holds one giant
transaction; ``seed_history_remote`` enqueues the same function on the long queue.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import random
import time
from typing import Any, Optional

import frappe
from frappe.utils import add_days, add_months, flt, getdate, nowdate

from maison_pos.setup import demo
from maison_pos.setup.demo import ABBR, BOUTIQUES, COMPANY, ITEMS, WALK_IN

HISTORY_SEED = 20260822
TARGET_INVOICES = 1500
CHUNK_SIZE = 50
MARKER_KEY = "maison_history_seed"
HISTORY_UUID_PREFIX = f"hist-{HISTORY_SEED}-"
HISTORY_STOCK_REMARK = "Maison demo history stock"
HISTORY_DEVICE = None  # no device heartbeat for historical sales
RETURN_SHARE = 0.05  # of the sales inside RETURN_WINDOW_DAYS -> ~12-15 returns
RETURN_WINDOW_DAYS = 35

# relative daily traffic per boutique (sums to ~1; scaled to TARGET_INVOICES)
BOUTIQUE_WEIGHT = {"NYC-5AV": 0.41, "CHI-OAK": 0.32, "MIA-DD": 0.27}
WEEKDAY_FACTOR = [0.75, 0.8, 0.9, 1.0, 1.25, 1.55, 0.55]  # Mon..Sun
OPENING_HOURS = (10, 19)  # 10:00 – 19:00

# (item_code, popularity weight, serialized cap per boutique over the whole history)
POPULARITY: dict[str, float] = {
	"TP-001": 3.0, "TP-002": 1.2, "TP-003": 0.8, "TP-004": 0.25, "TP-005": 2.2, "TP-006": 2.6, "TP-007": 0.1, "TP-008": 1.4,
	"HJ-001": 0.08, "HJ-002": 0.25, "HJ-003": 0.2, "HJ-004": 0.22, "HJ-005": 0.8, "HJ-006": 0.25, "HJ-007": 0.3, "HJ-008": 0.4,
	"BR-001": 2.4, "BR-002": 1.6, "BR-003": 0.5, "BR-004": 1.8, "BR-005": 0.9,
	"BR-006": 6.0, "BR-007": 5.0, "BR-008": 3.2, "BR-009": 1.2,
	"AC-001": 7.0, "AC-002": 4.0, "AC-003": 8.0, "AC-004": 3.5, "AC-005": 6.5, "AC-006": 2.5, "AC-007": 2.2,
	"AC-008": 9.0, "AC-009": 5.0, "AC-010": 4.5, "AC-011": 6.0, "AC-012": 9.5,
	"SV-001": 3.0, "SV-002": 4.0, "SV-003": 1.5, "SV-004": 2.0, "SV-005": 1.2,
}
SERIAL_CAP_PER_BOUTIQUE: dict[str, int] = {
	"TP-001": 7, "TP-002": 3, "TP-003": 2, "TP-004": 1, "TP-005": 5, "TP-006": 6, "TP-007": 1, "TP-008": 4,
	"HJ-001": 1, "HJ-002": 1, "HJ-003": 1, "HJ-004": 1, "HJ-005": 2, "HJ-006": 1, "HJ-007": 1, "HJ-008": 1,
	"BR-001": 6, "BR-002": 4, "BR-003": 2, "BR-004": 5, "BR-005": 3,
}
# boutique flavour: NYC sells more timepieces, CHI more bridal, MIA more accessories / high jewellery
BOUTIQUE_GROUP_BIAS: dict[str, dict[str, float]] = {
	"NYC-5AV": {"Timepieces": 1.5, "High Jewellery": 1.2, "Bridal": 0.9, "Accessories": 1.0, "Services": 1.0},
	"CHI-OAK": {"Timepieces": 0.8, "High Jewellery": 0.7, "Bridal": 1.6, "Accessories": 1.0, "Services": 1.1},
	"MIA-DD": {"Timepieces": 1.0, "High Jewellery": 1.3, "Bridal": 0.7, "Accessories": 1.3, "Services": 0.8},
}
# co-purchase patterns: trigger prefix -> [(companion item, probability)]
COMPANIONS: dict[str, list[tuple[str, float]]] = {
	"TP-": [("AC-010", 0.38), ("SV-002", 0.12)],
	"BR-001": [("BR-006", 0.55), ("SV-001", 0.25)],
	"BR-002": [("BR-006", 0.55), ("SV-001", 0.25)],
	"BR-003": [("BR-006", 0.5), ("SV-005", 0.3)],
	"BR-004": [("BR-007", 0.5), ("SV-001", 0.25)],
	"BR-005": [("BR-006", 0.45)],
	"BR-006": [("BR-007", 0.3)],
	"BR-007": [("BR-006", 0.25)],
	"AC-001": [("AC-003", 0.45), ("AC-004", 0.15)],
	"AC-002": [("AC-004", 0.4)],
	"AC-005": [("AC-003", 0.2), ("AC-011", 0.15)],
	"AC-006": [("AC-007", 0.15)],
	"HJ-": [("SV-005", 0.6), ("AC-011", 0.35)],
	"AC-009": [("AC-012", 0.4)],
	"AC-008": [("AC-012", 0.2)],
}

FIRST_NAMES = [
	"Ava", "Noah", "Camille", "Julien", "Sienna", "Mateo", "Ingrid", "Rafael", "Yuki", "Leon", "Aurora", "Tariq",
	"Beatrice", "Hugo", "Naomi", "Felix", "Zara", "Dmitri", "Leila", "Arjun", "Clara", "Santiago", "Harper", "Oscar",
	"Maya", "Elias", "Freya", "Idris", "Margot", "Kwame", "Thea", "Ren", "Imogen", "Luca", "Anya", "Caleb",
	"Esme", "Bruno", "Nadia", "Jasper", "Lior", "Paloma", "Desmond", "Seraphina", "Malik", "Ottilie", "Hiro", "Vivienne",
]
LAST_NAMES = [
	"Delacroix", "Ferreira", "Lindgren", "Nakashima", "Okafor", "Brennan", "Castellano", "Haddad", "Ivanova", "Kowalski",
	"Moreau", "Novak", "O'Connell", "Park", "Quintero", "Rahimi", "Sato", "Tremblay", "Varga", "Winslow", "Yamada",
	"Zimmermann", "Abernathy", "Bianchi", "Coetzee", "Dufresne", "Eriksen", "Fontaine", "Galloway", "Hoffmann",
]
AREA_CODES = {"NYC-5AV": ["212", "917", "646", "718"], "CHI-OAK": ["312", "773", "847"], "MIA-DD": ["305", "786", "954"]}
METALS = ["Platinum", "18k Yellow Gold", "18k Rose Gold", "18k White Gold"]


# ---------------------------------------------------------------------------
# small pure-python helpers (no numpy in the bench env)
# ---------------------------------------------------------------------------
def _poisson(rng: random.Random, lam: float) -> int:
	"""Knuth's algorithm; fine for lam < 30."""
	if lam <= 0:
		return 0
	limit = math.exp(-lam)
	k, p = 0, 1.0
	while True:
		p *= rng.random()
		if p <= limit:
			return k
		k += 1


def _weighted_choice(rng: random.Random, weights: dict[str, float]) -> str:
	total = sum(w for w in weights.values() if w > 0)
	r = rng.random() * total
	acc = 0.0
	for key, w in weights.items():
		if w <= 0:
			continue
		acc += w
		if r <= acc:
			return key
	return next(iter(weights))


def season_factor(day: _dt.date) -> float:
	"""Jewellery retail seasonality (relative to 1.0)."""
	m, d = day.month, day.day
	if m == 2:
		return 1.35 if d <= 14 else 0.9
	if m == 3:
		return 0.85
	if m == 4:
		return 0.95
	if m == 5:
		return 1.3 if d <= 12 else 1.1  # Mother's Day, then wedding season starts
	if m == 6:
		return 1.15
	if m == 7:
		return 0.8
	if m == 8:
		return 0.85
	if m == 9:
		return 0.9
	if m == 10:
		return 1.0
	if m == 11:
		return 1.25 if d >= 20 else 1.05
	if m == 12:
		return 1.8 if d <= 24 else 0.9
	return 0.8  # January


def daily_intensity(day: _dt.date, boutique: str) -> float:
	return BOUTIQUE_WEIGHT[boutique] * WEEKDAY_FACTOR[day.weekday()] * season_factor(day)


# ---------------------------------------------------------------------------
# plan: clients + invoices (pure python, no DB)
# ---------------------------------------------------------------------------
ITEM_META = {
	code: {"name": name, "group": group, "dept": dept, "metal": metal, "rate": rate, "serialized": serialized}
	for code, name, group, dept, metal, _carat, _stones, rate, serialized, _qty in ITEMS
}


def build_clients(rng: random.Random, n: int, start: _dt.date, end: _dt.date) -> list[dict[str, Any]]:
	"""Client personas: home boutique, cadence, preferences, budget, activity window."""
	clients: list[dict[str, Any]] = []
	used: set[str] = set()
	for i in range(n):
		while True:
			name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
			if name not in used:
				used.add(name)
				break
		home = _weighted_choice(rng, BOUTIQUE_WEIGHT)
		cadence = max(12, int(rng.lognormvariate(math.log(45), 0.55)))  # median ~45 days
		band = rng.random()
		budget = "vip" if band < 0.12 else "high" if band < 0.4 else "core"
		dept_pref = _weighted_choice(rng, {"Accessories": 4, "Bridal": 2.2, "Timepieces": 2.2, "High Jewellery": 0.7 if budget != "core" else 0.1})
		lapsed = rng.random() < 0.18
		active_until = add_days(end, -rng.randint(70, 140)) if lapsed else end
		joined = add_days(start, rng.randint(0, 50)) if rng.random() < 0.7 else add_days(start, rng.randint(50, max(51, (end - start).days - 20)))
		phone = f"+1 {rng.choice(AREA_CODES[home])} 555 {1000 + i:04d}"
		slug = name.lower().replace(" ", ".").replace("'", "")
		clients.append(
			{
				"name": name,
				"mobile": phone,
				"email": f"{slug}@example.com",
				"home": home,
				"cadence": cadence,
				"budget": budget,
				"dept": dept_pref,
				"metal": rng.choice(METALS),
				"joined": getdate(joined),
				"active_until": getdate(active_until),
				"last_visit": None,
				"visits": 0,
			}
		)
	return clients


def _item_weights(boutique: str, client: Optional[dict[str, Any]], serial_left: dict[tuple[str, str], int]) -> dict[str, float]:
	weights: dict[str, float] = {}
	for code, w in POPULARITY.items():
		meta = ITEM_META[code]
		w = w * BOUTIQUE_GROUP_BIAS[boutique].get(meta["group"], 1.0)
		if meta["serialized"] and serial_left.get((code, boutique), 0) <= 0:
			continue
		if client:
			if meta["dept"] == client["dept"]:
				w *= 2.2
			if meta["metal"] and meta["metal"] == client["metal"]:
				w *= 1.4
			if client["budget"] == "core" and meta["rate"] > 20_000:
				w *= 0.15
			elif client["budget"] == "high" and meta["rate"] > 60_000:
				w *= 0.3
			elif client["budget"] == "vip" and meta["rate"] > 20_000:
				w *= 2.5
		else:
			# walk-ins rarely buy six-figure pieces
			if meta["rate"] > 30_000:
				w *= 0.2
		weights[code] = w
	return weights


def _companions(rng: random.Random, code: str) -> list[str]:
	out: list[str] = []
	for prefix, pairs in COMPANIONS.items():
		if code.startswith(prefix):
			for companion, p in pairs:
				if rng.random() < p:
					out.append(companion)
	return out


def build_plan(months: int = 6, target: int = TARGET_INVOICES, seed: int = HISTORY_SEED, today: Optional[_dt.date] = None) -> dict[str, Any]:
	"""Deterministic plan: clients, invoices (date, boutique, client, lines, tender), receipts needed.

	Pure python so it can be unit-tested without a site; ``seed_history`` materialises it.
	"""
	rng = random.Random(seed)
	today = today or getdate(nowdate())
	end = add_days(today, -1)
	start = getdate(add_months(end, -months))
	days = [getdate(add_days(start, i)) for i in range((end - start).days + 1)]
	boutique_codes = [b["code"] for b in BOUTIQUES]

	# scale the intensity so the expected invoice count equals `target`
	expected = sum(daily_intensity(d, b) for d in days for b in boutique_codes)
	scale = target / expected if expected else 0

	clients = build_clients(rng, max(40, int(120 * months / 6)), start, end)
	serial_left = {(code, b): cap for code, cap in SERIAL_CAP_PER_BOUTIQUE.items() for b in boutique_codes}
	associates = {b: [f"{b.lower().replace('-', '.')}.a1@maison.example", f"{b.lower().replace('-', '.')}.a2@maison.example", f"{b.lower().replace('-', '.')}.manager@maison.example"] for b in boutique_codes}

	invoices: list[dict[str, Any]] = []
	for day in days:
		for boutique in boutique_codes:
			n = _poisson(rng, daily_intensity(day, boutique) * scale)
			for _ in range(n):
				hour = rng.triangular(OPENING_HOURS[0], OPENING_HOURS[1], 15.5)
				minute = rng.randint(0, 59)
				ts = _dt.datetime.combine(day, _dt.time(int(hour), minute, rng.randint(0, 59)))

				client = None
				if rng.random() < 0.6:
					pool = []
					for c in clients:
						if c["joined"] > day or c["active_until"] < day:
							continue
						if c["home"] != boutique and rng.random() < 0.8:
							continue
						since = (day - c["last_visit"]).days if c["last_visit"] else c["cadence"]
						due = since / c["cadence"]
						pool.append((c, max(0.02, min(3.0, due)) ** 2))
					if pool:
						total = sum(w for _, w in pool)
						r = rng.random() * total
						acc = 0.0
						for c, w in pool:
							acc += w
							if r <= acc:
								client = c
								break
						client = client or pool[-1][0]

				weights = _item_weights(boutique, client, serial_left)
				main = _weighted_choice(rng, weights)
				codes = [main] + _companions(rng, main)
				extra = rng.random()
				if extra < 0.12:
					codes.append(_weighted_choice(rng, {k: v for k, v in weights.items() if ITEM_META[k]["rate"] < 10_000} or weights))
				# dedupe, respect serial caps, build lines
				lines: list[dict[str, Any]] = []
				seen: set[str] = set()
				for code in codes:
					if code in seen:
						continue
					meta = ITEM_META[code]
					if meta["serialized"]:
						if serial_left.get((code, boutique), 0) <= 0:
							continue
						serial_left[(code, boutique)] -= 1
						qty = 1
					else:
						qty = 1
						if meta["rate"] < 500 and rng.random() < 0.25:
							qty = 2
					seen.add(code)
					lines.append({"item_code": code, "qty": qty, "rate": meta["rate"]})
				if not lines:
					continue
				net = sum(l["qty"] * l["rate"] for l in lines)
				if net < 600:
					mode = "Cash" if rng.random() < 0.45 else "Card"
				elif net < 5_000:
					mode = "Cash" if rng.random() < 0.15 else "Card"
				else:
					mode = "Card"
				if client:
					client["last_visit"] = day
					client["visits"] += 1
				invoices.append(
					{
						"ts": ts,
						"boutique": boutique,
						"client": client["name"] if client else None,
						"associate": rng.choices(associates[boutique], weights=[4, 4, 1])[0],
						"lines": lines,
						"mode": mode,
						"card_last4": f"{rng.randint(0, 9999):04d}" if mode == "Card" else None,
						"card_brand": rng.choice(["Visa", "Visa", "Mastercard", "Amex"]) if mode == "Card" else None,
						# returns go through the live returns API (dated today), so only recent sales qualify
					"is_return_candidate": rng.random() < RETURN_SHARE and (end - day).days <= RETURN_WINDOW_DAYS and all(ITEM_META[l["item_code"]]["group"] != "Services" for l in lines),
					}
				)
	invoices.sort(key=lambda i: i["ts"])
	for idx, inv in enumerate(invoices):
		inv["uuid"] = f"{HISTORY_UUID_PREFIX}{idx:05d}"

	# stock the history needs, per boutique (units for qty items, count for serialized)
	needed: dict[str, dict[str, int]] = {b: {} for b in boutique_codes}
	for inv in invoices:
		for l in inv["lines"]:
			if ITEM_META[l["item_code"]]["group"] == "Services":
				continue
			needed[inv["boutique"]][l["item_code"]] = needed[inv["boutique"]].get(l["item_code"], 0) + int(l["qty"])

	return {
		"seed": seed,
		"months": months,
		"start": start,
		"end": end,
		"clients": clients,
		"invoices": invoices,
		"needed": needed,
		"serial_caps": SERIAL_CAP_PER_BOUTIQUE,
	}


def history_serials(code: str, boutique: str, n: int, tag: str = "H") -> list[str]:
	short = boutique.split("-")[0]
	return [f"{code}-{short}-{tag}{i:03d}" for i in range(1, n + 1)]


# ---------------------------------------------------------------------------
# phase 2: recent serialized pieces
# ---------------------------------------------------------------------------
# The main plan caps serialized pieces per boutique over the whole period, so watches / solitaires
# / one-offs tend to sell out early. This second, smaller plan adds serialized sales (with their
# own back-dated receipt) spread over the last RECENT_DAYS so the 90-day performance window, the
# rebalance rule and the narrative see timepieces and bridal moving everywhere.
RECENT_DAYS = 100
RECENT_UUID_PREFIX = f"hist-r{HISTORY_SEED}-"
RECENT_PER_BOUTIQUE = {"NYC-5AV": 30, "CHI-OAK": 22, "MIA-DD": 18}
RECENT_ITEM_WEIGHTS = {
	"TP-001": 5, "TP-002": 2, "TP-003": 1.5, "TP-005": 3.5, "TP-006": 4, "TP-008": 2.5, "TP-004": 0.4,
	"BR-001": 4, "BR-002": 2.5, "BR-004": 3, "BR-005": 1.5, "BR-003": 0.8,
	"HJ-005": 1.2, "HJ-002": 0.5, "HJ-004": 0.5, "HJ-007": 0.5, "HJ-008": 0.6,
}


def build_recent_plan(seed: int = HISTORY_SEED + 7, today: Optional[_dt.date] = None, clients: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
	rng = random.Random(seed)
	today = today or getdate(nowdate())
	end = add_days(today, -1)
	start = getdate(add_days(end, -RECENT_DAYS + 1))
	boutique_codes = [b["code"] for b in BOUTIQUES]
	associates = {b: [f"{b.lower().replace('-', '.')}.a1@maison.example", f"{b.lower().replace('-', '.')}.a2@maison.example"] for b in boutique_codes}
	active = [c for c in (clients or []) if getdate(c["active_until"]) >= end]
	invoices: list[dict[str, Any]] = []
	needed: dict[str, dict[str, int]] = {b: {} for b in boutique_codes}
	for boutique in boutique_codes:
		weights = {k: v * BOUTIQUE_GROUP_BIAS[boutique].get(ITEM_META[k]["group"], 1.0) for k, v in RECENT_ITEM_WEIGHTS.items()}
		for _ in range(RECENT_PER_BOUTIQUE[boutique]):
			day = getdate(add_days(start, rng.randint(0, RECENT_DAYS - 1)))
			if day.weekday() == 6 and rng.random() < 0.5:
				day = getdate(add_days(day, -1))
			ts = _dt.datetime.combine(day, _dt.time(int(rng.triangular(OPENING_HOURS[0], OPENING_HOURS[1], 15)), rng.randint(0, 59), rng.randint(0, 59)))
			main = _weighted_choice(rng, weights)
			codes = [main] + _companions(rng, main)
			lines = []
			seen: set[str] = set()
			for code in codes:
				if code in seen:
					continue
				seen.add(code)
				lines.append({"item_code": code, "qty": 1, "rate": ITEM_META[code]["rate"]})
			client = None
			if active and rng.random() < 0.5:
				home = [c for c in active if c["home"] == boutique] or active
				client = rng.choice(home)["name"]
			net = sum(l["qty"] * l["rate"] for l in lines)
			invoices.append(
				{
					"ts": ts,
					"boutique": boutique,
					"client": client,
					"associate": rng.choice(associates[boutique]),
					"lines": lines,
					"mode": "Card" if net >= 5_000 or rng.random() < 0.8 else "Cash",
					"card_last4": f"{rng.randint(0, 9999):04d}",
					"card_brand": rng.choice(["Visa", "Visa", "Mastercard", "Amex"]),
					"is_return_candidate": rng.random() < 0.04 and (end - day).days <= RETURN_WINDOW_DAYS,
				}
			)
			for l in lines:
				if ITEM_META[l["item_code"]]["group"] != "Services":
					needed[boutique][l["item_code"]] = needed[boutique].get(l["item_code"], 0) + 1
	invoices.sort(key=lambda i: i["ts"])
	for idx, inv in enumerate(invoices):
		inv["uuid"] = f"{RECENT_UUID_PREFIX}{idx:04d}"
	return {"seed": seed, "start": start, "end": end, "invoices": invoices, "needed": needed, "tag": "R"}


# ---------------------------------------------------------------------------
# materialise
# ---------------------------------------------------------------------------
def get_marker() -> Optional[dict[str, Any]]:
	raw = frappe.db.get_default(MARKER_KEY)
	if not raw:
		return None
	try:
		return json.loads(raw)
	except Exception:
		return None


def set_marker(value: Optional[dict[str, Any]]) -> None:
	if value is None:
		frappe.db.set_default(MARKER_KEY, "")
	else:
		frappe.db.set_default(MARKER_KEY, json.dumps(value, default=str))


def ensure_history_clients(clients: list[dict[str, Any]]) -> int:
	created = 0
	for c in clients:
		if not frappe.db.exists("Customer", {"customer_name": c["name"]}):
			demo.ensure_customer(c["name"], c["mobile"], c["email"])
			created += 1
	demo.ensure_client_numbers()
	return created


def ensure_history_stock(plan: dict[str, Any]) -> list[str]:
	"""One back-dated Material Receipt per boutique covering everything the plan sells (+ a small buffer)."""
	posting_date = add_days(plan["start"], -3)
	tag = plan.get("tag", "H")
	remark_suffix = "" if tag == "H" else f" {tag}"
	entries: list[str] = []
	for spec in BOUTIQUES:
		code = spec["code"]
		warehouse = f"{code} - {ABBR}"
		existing = frappe.db.get_value(
			"Stock Entry", {"remarks": f"{HISTORY_STOCK_REMARK}{remark_suffix} {code}", "docstatus": 1, "to_warehouse": warehouse}, "name"
		)
		if existing:
			entries.append(existing)
			continue
		rows: list[dict[str, Any]] = []
		for item_code, qty in sorted(plan["needed"][code].items()):
			meta = ITEM_META[item_code]
			row: dict[str, Any] = {
				"item_code": item_code,
				"qty": qty,
				"t_warehouse": warehouse,
				"basic_rate": round(meta["rate"] * 0.45, 2),
				"allow_zero_valuation_rate": 0,
			}
			if meta["serialized"]:
				# one spare per serialized item so a few pieces stay on hand for the reports
				serials = [s for s in history_serials(item_code, code, qty + (1 if tag == "H" else 0), tag) if not frappe.db.exists("Serial No", s)]
				if not serials:
					continue
				row["qty"] = len(serials)
				row["use_serial_batch_fields"] = 1
				row["serial_no"] = "\n".join(serials)
			else:
				row["qty"] = qty + (2 if meta["rate"] > 1_000 else 4)
			rows.append(row)
		if not rows:
			continue
		se = demo._stock_entry_doc(warehouse, rows, str(posting_date), "09:00:00")
		se.remarks = f"{HISTORY_STOCK_REMARK}{remark_suffix} {code}"
		se.insert()
		se.submit()
		entries.append(se.name)
	return entries


def _next_history_serial(item_code: str, boutique: str, warehouse: str, used: set[str], tag: str = "H") -> Optional[str]:
	short = boutique.split("-")[0]
	rows = frappe.get_all(
		"Serial No",
		filters={"item_code": item_code, "warehouse": warehouse, "status": "Active", "name": ("like", f"{item_code}-{short}-{tag}%")},
		pluck="name",
		order_by="name",
	)
	for s in rows:
		if s not in used:
			used.add(s)
			return s
	return None


def _payload(inv: dict[str, Any], customer_names: dict[str, str], serial_used: set[str], tag: str = "H") -> Optional[dict[str, Any]]:
	boutique = inv["boutique"]
	warehouse = f"{boutique} - {ABBR}"
	tax_rate = next(b["tax_rate"] for b in BOUTIQUES if b["code"] == boutique)
	items = []
	for l in inv["lines"]:
		row = {"item_code": l["item_code"], "qty": l["qty"], "rate": l["rate"]}
		if ITEM_META[l["item_code"]]["serialized"]:
			serial = _next_history_serial(l["item_code"], boutique, warehouse, serial_used, tag)
			if not serial:
				continue
			row["serial_no"] = serial
		items.append(row)
	if not items:
		return None
	net = sum(r["qty"] * r["rate"] for r in items)
	tax = flt(net * tax_rate / 100, 2)
	grand = flt(net + tax, 2)
	payment: dict[str, Any] = {"mode_of_payment": inv["mode"], "amount": grand}
	if inv["mode"] == "Card":
		payment.update(
			{
				"stripe_payment_intent": f"pi_hist_{inv['uuid'][-5:]}",
				"card_brand": inv["card_brand"],
				"last4": inv["card_last4"],
				"approval_code": f"{random.Random(inv['uuid']).randint(0, 999999):06d}",
			}
		)
	return {
		"offline_uuid": inv["uuid"],
		"boutique": boutique,
		"associate": inv["associate"],
		"device_id": HISTORY_DEVICE,
		"customer": customer_names.get(inv["client"]) if inv["client"] else None,
		"posting_datetime": inv["ts"].isoformat(),
		"items": items,
		"payments": [payment],
	}


def _post_invoice(payload: dict[str, Any]) -> str:
	"""Insert + submit one history invoice through the same builder the POS uses."""
	from maison_pos.api.sales import build_sales_invoice

	si = build_sales_invoice(payload, payload["boutique"])
	si.flags.ignore_permissions = True
	si.insert()
	due = flt(si.rounded_total or si.grand_total, 2)
	if abs(flt(si.payments[0].amount) - due) > 0.004:
		si.payments[0].amount = due
		si.save()
	si.submit()
	return si.name


def _make_return(invoice_name: str, rng: random.Random) -> Optional[str]:
	"""A return through the v0.4 returns API when present, else a plain credit note (void)."""
	try:
		from maison_pos.api import returns as returns_api  # type: ignore
	except Exception:
		returns_api = None
	reason = rng.choice(["Change of mind", "Sizing", "Gift return"])
	if returns_api is not None and hasattr(returns_api, "return_items"):
		frappe.db.savepoint("maison_hist_return")
		try:
			si = frappe.get_doc("Sales Invoice", invoice_name)
			reasons = getattr(returns_api, "REASONS", None) or ("Change of mind", "Sizing", "Gift return")
			reason = reason if reason in reasons else reasons[0]
			lines = [{"item_code": r.item_code, "qty": r.qty, "serial_no": r.serial_no, "reason": reason, "condition": "Sellable"} for r in si.items]
			method = "card" if any((p.mode_of_payment or "").lower() != "cash" for p in si.payments) else "cash"
			res = returns_api.return_items(invoice=invoice_name, lines=lines, reason=reason, refund_method=method)
			frappe.db.release_savepoint("maison_hist_return")
			if isinstance(res, dict):
				return res.get("credit_note") or res.get("name") or str(res)
			return str(res)
		except Exception:
			frappe.db.rollback(save_point="maison_hist_return")
			frappe.clear_messages()
	from maison_pos.api.sales import void

	try:
		return void(invoice_name, f"History demo return: {reason}")["credit_note"]
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"Maison history return failed for {invoice_name}")
		frappe.clear_messages()
		return None


def _post_plan(plan: dict[str, Any], customer_names: dict[str, str], summary: dict[str, Any], months: int, commit: bool) -> None:
	"""Post every invoice of *plan* that is not there yet, in committed chunks, surviving transient DB errors."""
	prefix = plan["invoices"][0]["uuid"].rsplit("-", 1)[0] + "-" if plan["invoices"] else HISTORY_UUID_PREFIX
	tag = plan.get("tag", "H")
	existing_uuids = set(
		frappe.get_all("Sales Invoice", filters={"maison_offline_uuid": ("like", f"{prefix}%"), "docstatus": ("<", 2)}, pluck="maison_offline_uuid")
	)
	serial_used: set[str] = set()
	queue = [inv for inv in plan["invoices"] if inv["uuid"] not in existing_uuids]
	summary["existing"] += len(plan["invoices"]) - len(queue)
	chunk: list[dict[str, Any]] = []  # posted since the last commit (re-queued after a hard rollback)
	attempts: dict[str, int] = {}
	i = 0
	while i < len(queue):
		inv = queue[i]
		i += 1
		payload = _payload(inv, customer_names, serial_used, tag)
		if not payload:
			summary["failed"] += 1
			continue
		savepoint = "maison_hist"
		hard_failure = False
		try:
			frappe.db.savepoint(savepoint)
			name = _post_invoice(payload)
			frappe.db.release_savepoint(savepoint)
			summary["posted"] += 1
			chunk.append(inv)
		except Exception as exc:
			try:
				frappe.db.rollback(save_point=savepoint)
			except Exception:
				# the transaction itself is gone (deadlock / "table definition has changed" while another
				# process migrated): drop the uncommitted chunk and post it again
				hard_failure = True
				frappe.db.rollback()
			attempts[inv["uuid"]] = attempts.get(inv["uuid"], 0) + 1
			frappe.clear_messages()
			if hard_failure or _is_transient(exc):
				if hard_failure:
					redo = [c for c in chunk if c["uuid"] not in existing_uuids]
					chunk = []
					serial_used.clear()  # the DB is the truth again: committed sales took their serials out of the warehouse
					queue[i:i] = redo
				if attempts[inv["uuid"]] <= 3:
					queue.insert(i, inv)
					time.sleep(0.5 * attempts[inv["uuid"]])
					continue
			frappe.log_error(frappe.get_traceback(), f"Maison history invoice {inv['uuid']} failed")
			summary["failed"] += 1
			continue
		if commit and len(chunk) >= CHUNK_SIZE:
			_drop_realtime_log()
			frappe.db.commit()
			existing_uuids |= {c["uuid"] for c in chunk}
			chunk = []
			serial_used.clear()
			set_marker({"months": months, "completed": False, "posted_so_far": summary["posted"], "updated": str(frappe.utils.now_datetime())})
	if commit:
		_drop_realtime_log()
		frappe.db.commit()
		existing_uuids |= {c["uuid"] for c in chunk}
		chunk = []



def _is_transient(exc: BaseException) -> bool:
	msg = str(exc).lower()
	return "deadlock" in msg or "lock wait timeout" in msg or "table definition has changed" in msg or "try restarting transaction" in msg


def _drop_realtime_log() -> None:
	# 1,500 `maison_sale` events would otherwise be flushed to the live wall on every commit
	if hasattr(frappe.local, "realtime_log"):
		frappe.local.realtime_log = []


def seed_history(months: int = 6, target: int = TARGET_INVOICES, commit: bool = True, force: bool = False, run_reposts: bool = True) -> dict[str, Any]:
	"""Generate *months* of history (see module docstring). Safe to re-run; resumes if interrupted."""
	# --- v0.6 N — Smoke Shop sites get the CloudChaserz history (11 stores, smoke-shop tickets) ---
	if demo.resolve_vertical() == "Smoke Shop" and not frappe.db.exists("Maison Boutique", BOUTIQUES[0]["code"]):
		from maison_pos.setup.cloudchaserz.history import seed_history as cc_seed_history

		return cc_seed_history(months=int(months), commit=commit, force=force, run_reposts=run_reposts)
	# --- end v0.6 N ---
	months = int(months)
	target = int(target)
	started = time.time()
	marker = get_marker()
	if marker and marker.get("completed") and marker.get("months") == months and not force:
		marker["skipped"] = True
		return marker

	frappe.flags.mute_emails = True
	frappe.flags.in_demo_seed = True
	frappe.flags.in_history_seed = True
	if not frappe.db.exists("Maison Boutique", BOUTIQUES[0]["code"]):
		demo.seed(commit=commit)

	plan = build_plan(months=months, target=target)
	summary: dict[str, Any] = {
		"months": months,
		"start": str(plan["start"]),
		"end": str(plan["end"]),
		"planned": len(plan["invoices"]),
		"clients_created": 0,
		"stock_entries": [],
		"posted": 0,
		"existing": 0,
		"failed": 0,
		"returns": [],
	}

	# Item-wise reposting dedupes the Repost Item Valuation queue created by back-dated
	# transactions (every history invoice precedes the regular demo opening stock).
	reposting = frappe.db.get_single_value("Stock Reposting Settings", "item_based_reposting")
	frappe.db.set_single_value("Stock Reposting Settings", "item_based_reposting", 1)
	frappe.clear_cache(doctype="Stock Reposting Settings")

	try:
		summary["clients_created"] = ensure_history_clients(plan["clients"])
		summary["stock_entries"] = ensure_history_stock(plan)
		if commit:
			_drop_realtime_log()
			frappe.db.commit()

		customer_names = {
			r.customer_name: r.name
			for r in frappe.get_all("Customer", filters={"customer_name": ("in", [c["name"] for c in plan["clients"]])}, fields=["name", "customer_name"])
		}
		rng = random.Random(HISTORY_SEED + 1)
		_post_plan(plan, customer_names, summary, months, commit)

		# phase 2: recent serialized pieces (own receipt, own uuid prefix)
		recent = build_recent_plan(clients=plan["clients"])
		summary["recent_planned"] = len(recent["invoices"])
		summary["stock_entries"] += ensure_history_stock(recent)
		if commit:
			_drop_realtime_log()
			frappe.db.commit()
		_post_plan(recent, customer_names, summary, months, commit)

		# a few returns (idempotent: an invoice that already has a credit note is left alone)
		for inv in plan["invoices"] + recent["invoices"]:
			if not inv["is_return_candidate"]:
				continue
			name = frappe.db.get_value("Sales Invoice", {"maison_offline_uuid": inv["uuid"], "docstatus": 1, "is_return": 0}, "name")
			if not name or frappe.db.exists("Sales Invoice", {"return_against": name, "docstatus": 1}):
				continue
			cn = _make_return(name, rng)
			if cn:
				summary["returns"].append(cn)
		if commit:
			_drop_realtime_log()
			frappe.db.commit()
	finally:
		frappe.db.set_single_value("Stock Reposting Settings", "item_based_reposting", reposting or 0)
		frappe.clear_cache(doctype="Stock Reposting Settings")
		frappe.flags.in_history_seed = False

	if run_reposts and summary["posted"]:
		summary["reposts"] = process_reposts()
	if commit:
		frappe.db.commit()

	summary["invoices_total"] = frappe.db.count("Sales Invoice", {"maison_offline_uuid": ("like", f"{HISTORY_UUID_PREFIX}%"), "docstatus": 1})
	summary["recent_total"] = frappe.db.count("Sales Invoice", {"maison_offline_uuid": ("like", f"{RECENT_UUID_PREFIX}%"), "docstatus": 1})
	summary["seconds"] = round(time.time() - started, 1)
	# complete = (almost) the whole plan is in; a run cut short by failures stays resumable
	summary["completed"] = summary["invoices_total"] >= int(summary["planned"] * 0.98) and summary["recent_total"] >= int(summary["recent_planned"] * 0.98)
	summary["completed_at"] = str(frappe.utils.now_datetime()) if summary["completed"] else None
	set_marker({k: v for k, v in summary.items() if k not in ("returns", "stock_entries")})
	if commit:
		frappe.db.commit()
	print(frappe.as_json(summary))
	return summary


def process_reposts(max_seconds: int = 240) -> dict[str, Any]:
	"""Run the queued Repost Item Valuation entries now (the hourly scheduler does this otherwise)."""
	from erpnext.stock.doctype.repost_item_valuation.repost_item_valuation import repost

	started = time.time()
	done = 0
	queued = frappe.get_all("Repost Item Valuation", filters={"status": ("in", ("Queued", "In Progress"))}, pluck="name", order_by="posting_date, posting_time, creation")
	for name in queued:
		if time.time() - started > max_seconds:
			break
		doc = frappe.get_doc("Repost Item Valuation", name)
		try:
			doc.deduplicate_similar_repost()
			doc.reload()
			if doc.status in ("Queued", "In Progress"):
				repost(doc)
			done += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"Maison history repost {name} failed")
			frappe.clear_messages()
		frappe.db.commit()
	remaining = frappe.db.count("Repost Item Valuation", {"status": ("in", ("Queued", "In Progress"))})
	return {"queued": len(queued), "processed": done, "remaining": remaining, "seconds": round(time.time() - started, 1)}


@frappe.whitelist()
def seed_history_remote(months: int = 6, sync: int = 0) -> dict[str, Any]:
	"""Run ``seed_history`` over the API (System Manager only).

	By default the work is enqueued on the ``long`` queue (it takes minutes — longer than a web
	request may run); pass ``sync=1`` to run inline (only sensible from ``bench execute``).
	"""
	if "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may seed history", frappe.PermissionError)
	months = int(months)
	if int(sync or 0):
		return seed_history(months=months)
	marker = get_marker()
	if marker and marker.get("completed") and marker.get("months") == months:
		marker["skipped"] = True
		return marker
	job = frappe.enqueue(
		"maison_pos.setup.demo_history.seed_history",
		queue="long",
		timeout=3600,
		job_name="maison_seed_history",
		months=months,
	)
	return {"enqueued": True, "job": getattr(job, "id", None) or str(job), "months": months}


@frappe.whitelist()
def history_status() -> dict[str, Any]:
	"""Marker + live count, for the dashboard / operators."""
	if "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may read the history marker", frappe.PermissionError)
	return {
		"marker": get_marker(),
		"invoices": frappe.db.count("Sales Invoice", {"maison_offline_uuid": ("like", f"{HISTORY_UUID_PREFIX}%"), "docstatus": 1}),
		"recent_invoices": frappe.db.count("Sales Invoice", {"maison_offline_uuid": ("like", f"{RECENT_UUID_PREFIX}%"), "docstatus": 1}),
	}
