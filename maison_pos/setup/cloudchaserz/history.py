"""Six months of smoke-shop sales history for the CloudChaserz profile (v0.6 N) —
``maison_pos.setup.cloudchaserz.history.seed_history`` (also what ``demo_history.seed_history``
runs when the site's vertical is *Smoke Shop*).

    bench --site <site> execute maison_pos.setup.cloudchaserz.history.seed_history --kwargs '{"months": 6}'

Plan (deterministic, ``random.Random(HISTORY_SEED)``): ~6,000 POS invoices over 6 months across
the 11 stores (traffic per ``stores.STORE_WEIGHT``, weekday + seasonal curve, each store's own
opening hours), 1–4 units per ticket, average ticket $25–80, ~55 % member sales with repeat
visits per client cadence, Cash / Card mix, a few returns in the last 35 days. Age checks are
skipped for history (``frappe.flags.in_history_seed``) — a masked ``Maison Age Check`` row is
written for a sample of restricted-item tickets instead so the log looks lived in.

Posting reuses ``demo_history`` (chunked commits, transient-error retries, resumable marker);
``months=1`` is what tests / e2e use (~1,000 invoices, a couple of minutes).
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import json
import math
import random
import time
from typing import Any, Iterator, Optional

import frappe
from frappe.utils import add_days, add_months, cint, flt, getdate, nowdate

from maison_pos.setup import demo_history as base
from maison_pos.setup.cloudchaserz import ABBR, COMPANY, WALK_IN, profile_globals
from maison_pos.setup.cloudchaserz import catalog as cat
from maison_pos.setup.cloudchaserz import stores

HISTORY_SEED = 20260823
TARGET_INVOICES = 6000  # for 6 months; scaled with `months`
MARKER_KEY = "maison_history_seed_cloudchaserz"
UUID_PREFIX = f"hist-cc{HISTORY_SEED}-"
STOCK_REMARK = "CloudChaserz demo history stock"
RETURN_SHARE = 0.012
RETURN_WINDOW_DAYS = 35
WEEKDAY_FACTOR = [0.85, 0.8, 0.85, 0.95, 1.25, 1.45, 1.0]  # Mon..Sun
DOMAIN = "cloudchaserz.example"

FIRST_NAMES = ["Jake", "Destiny", "Carlos", "Brittany", "Tyrese", "Megan", "Dakota", "Alyssa", "Kevin", "Shelby", "Marcus", "Lauren", "Andre", "Savannah", "Noah", "Kiara", "Ethan", "Gabriela", "Dylan", "Renee", "Hunter", "Jasmine", "Logan", "Tiffany", "Brandon", "Ashley", "Cody", "Maria", "Trevor", "Nicole", "Devin", "Amber", "Jordan", "Taylor", "Austin", "Kayla", "Zach", "Monica", "Ricky", "Tara"]
LAST_NAMES = ["Morrison", "Williams", "Mendoza", "Cole", "Johnson", "O'Neal", "Redcloud", "Tran", "Patel", "Hart", "Greene", "Kim", "Baptiste", "Ross", "Castillo", "Thompson", "Whitehorse", "Santos", "Foster", "Jackson", "Nguyen", "Garcia", "Harjo", "Bigpond", "Tiger", "Wolf", "Bear", "Lopez", "Smith", "Davis", "Miller", "Brown", "Lee", "Walker", "Hall", "Young", "King", "Wright", "Scott", "Hill"]
AREA_CODES = {"HOU-MTR": ["281", "713", "832", "346"]}
OK_AREA = ["918", "539", "405"]

# relative sales share per group (+ per-store bias: Houston sells more glass, Muskogee more kratom)
GROUP_SHARE = {"Disposables": 34, "E-Liquid": 10, "Devices & Mods": 5, "Pods & Coils": 8, "Glass & Rigs": 6, "Hookah & Shisha": 7, "Kratom": 8, "CBD & Hemp": 5, "Rolling & Papers": 9, "Accessories": 7, "Services": 1}
STORE_GROUP_BIAS = {"HOU-MTR": {"Glass & Rigs": 1.6, "Hookah & Shisha": 1.4, "CBD & Hemp": 1.3}, "OK-MUS": {"Kratom": 1.6, "Rolling & Papers": 1.3}, "OK-SAP": {"Kratom": 1.3}, "OK-BIX": {"Devices & Mods": 1.3}, "OK-JENKS": {"Devices & Mods": 1.2, "Glass & Rigs": 1.2}}
# companions: buy A → often buy B
COMPANIONS = {"DEV-": [("POD-", 0.45), ("ELQ-", 0.35)], "ELQ-": [("POD-", 0.25)], "HKA-00": [("HKA-01", 0.5)], "GLS-": [("ACC-", 0.4), ("ROL-", 0.2)], "ROL-": [("ACC-", 0.3)], "KRT-": [("CBD-", 0.12)]}


def _item_meta() -> dict[str, dict[str, Any]]:
	return {i["code"]: {"name": i["name"], "group": i["group"], "dept": i["department"], "metal": None, "rate": i["rate"], "serialized": i["code"] in cat.SERIALIZED, "age": i["age"]} for i in cat.ITEMS}


ITEM_META = _item_meta()


@contextlib.contextmanager
def _history_globals(plan_prefix: str) -> Iterator[None]:
	"""Point ``demo_history``'s module globals at the CloudChaserz world while posting."""
	saved = {k: getattr(base, k) for k in ("BOUTIQUES", "ABBR", "ITEM_META", "COMPANY", "WALK_IN", "HISTORY_STOCK_REMARK", "HISTORY_UUID_PREFIX", "MARKER_KEY", "CHUNK_SIZE")}
	base.BOUTIQUES = stores.demo_boutique_specs()
	base.ABBR = ABBR
	base.ITEM_META = ITEM_META
	base.COMPANY = COMPANY
	base.WALK_IN = WALK_IN
	base.HISTORY_STOCK_REMARK = STOCK_REMARK
	base.HISTORY_UUID_PREFIX = plan_prefix
	base.MARKER_KEY = MARKER_KEY
	base.CHUNK_SIZE = 100
	try:
		with profile_globals():
			yield
	finally:
		for k, v in saved.items():
			setattr(base, k, v)


# ---------------------------------------------------------------------------
# pure plan
# ---------------------------------------------------------------------------
def season_factor(day: _dt.date) -> float:
	m, d = day.month, day.day
	f = 1.0
	if m == 12 and d >= 15:
		f = 1.25  # holidays
	elif m == 1 and d <= 7:
		f = 1.15
	elif m == 4 and 15 <= d <= 22:
		f = 1.35  # 4/20 week
	elif m == 7 and d <= 6:
		f = 1.15
	elif m in (2, 9):
		f = 0.92
	# pay-day bumps (1st / 15th)
	if d in (1, 2, 15, 16):
		f *= 1.12
	return f


def _hours(spec: dict[str, Any], day: _dt.date) -> tuple[float, float]:
	"""(open, close) in hours, close may exceed 24 for after-midnight stores."""
	h = spec.get("hours") or {}
	key = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][day.weekday()]
	raw = h.get(key) or h.get("default") or "9:00-22:00"
	if raw == "closed":
		return (0.0, 0.0)
	a, b = raw.split("-")
	o = int(a.split(":")[0]) + int(a.split(":")[1]) / 60
	c = int(b.split(":")[0]) + int(b.split(":")[1]) / 60
	if c <= o:
		c += 24
	return (o, c)


def daily_intensity(day: _dt.date, store: str) -> float:
	return stores.STORE_WEIGHT.get(store, 0.08) * WEEKDAY_FACTOR[day.weekday()] * season_factor(day)


def build_clients(rng: random.Random, n: int, start: _dt.date, end: _dt.date) -> list[dict[str, Any]]:
	clients: list[dict[str, Any]] = []
	used: set[str] = set()
	codes = stores.store_codes()
	for i in range(n):
		while True:
			name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
			if name not in used:
				used.add(name)
				break
		home = base._weighted_choice(rng, stores.STORE_WEIGHT)
		cadence = max(5, int(rng.lognormvariate(math.log(12), 0.6)))  # median ~12 days (disposables cadence)
		pref = base._weighted_choice(rng, {"Disposables": 5, "E-Liquid": 2, "Glass & Rigs": 1, "Hookah & Shisha": 1, "Kratom": 1.5, "CBD & Hemp": 0.8, "Rolling & Papers": 1.2})
		lapsed = rng.random() < 0.15
		active_until = add_days(end, -rng.randint(50, 120)) if lapsed else end
		joined = add_days(start, rng.randint(0, 40)) if rng.random() < 0.7 else add_days(start, rng.randint(40, max(41, (end - start).days - 15)))
		area = rng.choice(AREA_CODES.get(home, OK_AREA))
		slug = name.lower().replace(" ", ".").replace("'", "")
		birthday = _dt.date(rng.randint(1965, 2003), rng.randint(1, 12), rng.randint(1, 28))
		clients.append({"name": name, "mobile": f"+1 {area} 555 {2000 + i:04d}", "email": f"{slug}@example.com", "home": home, "cadence": cadence, "budget": "core", "dept": pref, "metal": None, "group": pref, "birthday": birthday, "joined": getdate(joined), "active_until": getdate(active_until), "last_visit": None, "visits": 0})
		assert home in codes
	return clients


def _group_weights(store: str, client: Optional[dict[str, Any]]) -> dict[str, float]:
	w = dict(GROUP_SHARE)
	for g, f in STORE_GROUP_BIAS.get(store, {}).items():
		w[g] = w.get(g, 1) * f
	if client:
		w[client["group"]] = w.get(client["group"], 1) * 2.5
	return w


def _pick_item(rng: random.Random, group: str, by_group: dict[str, list[str]]) -> Optional[str]:
	pool = by_group.get(group) or []
	if not pool:
		return None
	# first items of a group are the bestsellers (catalogue is ordered that way)
	weights = [1.0 / (1 + 0.12 * i) for i in range(len(pool))]
	return rng.choices(pool, weights=weights)[0]


def _companions(rng: random.Random, code: str, by_prefix: dict[str, list[str]]) -> list[str]:
	out: list[str] = []
	for prefix, pairs in COMPANIONS.items():
		if code.startswith(prefix):
			for cprefix, p in pairs:
				if rng.random() < p:
					pool = by_prefix.get(cprefix) or []
					if pool:
						out.append(rng.choice(pool))
	return out


def build_plan(months: int = 6, target: int = TARGET_INVOICES, seed: int = HISTORY_SEED, today: Optional[_dt.date] = None) -> dict[str, Any]:
	rng = random.Random(seed)
	today = today or getdate(nowdate())
	end = add_days(today, -1)
	start = getdate(add_months(end, -months))
	days = [getdate(add_days(start, i)) for i in range((end - start).days + 1)]
	codes = stores.store_codes()
	specs = {s["code"]: s for s in stores.STORES}
	target = int(target * months / 6)
	expected = sum(daily_intensity(d, b) for d in days for b in codes)
	scale = target / expected if expected else 0
	clients = build_clients(rng, max(60, int(400 * months / 6)), start, end)
	by_group: dict[str, list[str]] = {}
	by_prefix: dict[str, list[str]] = {}
	for i in cat.ITEMS:
		by_group.setdefault(i["group"], []).append(i["code"])
		for n in (4, 6):
			by_prefix.setdefault(i["code"][:n], []).append(i["code"])
	associates = {b: [f"{b.lower().replace('-', '.')}.a1@{DOMAIN}", f"{b.lower().replace('-', '.')}.a2@{DOMAIN}", f"{b.lower().replace('-', '.')}.manager@{DOMAIN}"] for b in codes}

	invoices: list[dict[str, Any]] = []
	for day in days:
		for store in codes:
			o, c = _hours(specs[store], day)
			if c <= o:
				continue
			n = base._poisson(rng, daily_intensity(day, store) * scale)
			for _ in range(n):
				hour = rng.triangular(o, c, min(c - 0.5, max(o + 1, 17.5)))
				h = int(hour) % 24
				ts_day = day if int(hour) < 24 else add_days(day, 1)
				ts = _dt.datetime.combine(getdate(ts_day), _dt.time(h, rng.randint(0, 59), rng.randint(0, 59)))
				client = None
				if rng.random() < 0.55:
					pool = []
					for cl in clients:
						if cl["joined"] > day or cl["active_until"] < day:
							continue
						if cl["home"] != store and rng.random() < 0.85:
							continue
						since = (day - cl["last_visit"]).days if cl["last_visit"] else cl["cadence"]
						due = since / cl["cadence"]
						pool.append((cl, max(0.02, min(3.0, due)) ** 2))
					if pool:
						total = sum(w for _, w in pool)
						r = rng.random() * total
						acc = 0.0
						for cl, w in pool:
							acc += w
							if r <= acc:
								client = cl
								break
						client = client or pool[-1][0]
				gw = _group_weights(store, client)
				main = _pick_item(rng, base._weighted_choice(rng, gw), by_group)
				if not main:
					continue
				codes_ = [main] + _companions(rng, main, by_prefix)
				if rng.random() < 0.18:
					extra = _pick_item(rng, base._weighted_choice(rng, gw), by_group)
					if extra:
						codes_.append(extra)
				lines: list[dict[str, Any]] = []
				seen: set[str] = set()
				units = 0
				for code in codes_:
					if code in seen or units >= 4:
						continue
					meta = ITEM_META[code]
					qty = 1
					if meta["group"] in ("Disposables", "Rolling & Papers", "Pods & Coils", "Hookah & Shisha") and rng.random() < 0.3 and units < 3:
						qty = 2
					seen.add(code)
					units += qty
					lines.append({"item_code": code, "qty": qty, "rate": meta["rate"]})
				if not lines:
					continue
				net = sum(l["qty"] * l["rate"] for l in lines)
				mode = "Cash" if rng.random() < (0.42 if net < 60 else 0.25) else "Card"
				if client:
					client["last_visit"] = day
					client["visits"] += 1
				invoices.append({"ts": ts, "boutique": store, "client": client["name"] if client else None, "associate": rng.choices(associates[store], weights=[4, 4, 1])[0], "lines": lines, "mode": mode, "card_last4": f"{rng.randint(0, 9999):04d}" if mode == "Card" else None, "card_brand": rng.choice(["Visa", "Visa", "Mastercard", "Discover"]) if mode == "Card" else None, "is_return_candidate": rng.random() < RETURN_SHARE and (end - day).days <= RETURN_WINDOW_DAYS and all(ITEM_META[l["item_code"]]["group"] != "Services" for l in lines), "restricted": any(ITEM_META[l["item_code"]]["age"] for l in lines)})
	invoices.sort(key=lambda i: i["ts"])
	for idx, inv in enumerate(invoices):
		inv["uuid"] = f"{UUID_PREFIX}{idx:05d}"
	needed: dict[str, dict[str, int]] = {b: {} for b in codes}
	for inv in invoices:
		for l in inv["lines"]:
			if ITEM_META[l["item_code"]]["group"] == "Services":
				continue
			needed[inv["boutique"]][l["item_code"]] = needed[inv["boutique"]].get(l["item_code"], 0) + int(l["qty"])
	return {"seed": seed, "months": months, "start": start, "end": end, "clients": clients, "invoices": invoices, "needed": needed, "serial_caps": {}, "tag": "H"}


def plan_stats(plan: dict[str, Any]) -> dict[str, Any]:
	inv = plan["invoices"]
	if not inv:
		return {"invoices": 0}
	units = [sum(l["qty"] for l in i["lines"]) for i in inv]
	tickets = [sum(l["qty"] * l["rate"] for l in i["lines"]) for i in inv]
	return {"invoices": len(inv), "units_min": min(units), "units_max": max(units), "avg_units": round(sum(units) / len(units), 2), "avg_ticket": round(sum(tickets) / len(tickets), 2), "stores": len({i["boutique"] for i in inv}), "members": round(sum(1 for i in inv if i["client"]) / len(inv), 2)}


# ---------------------------------------------------------------------------
# posting
# ---------------------------------------------------------------------------
def ensure_history_clients(clients: list[dict[str, Any]]) -> int:
	from maison_pos.setup import demo
	from maison_pos.setup.cloudchaserz import LOYALTY_PROGRAM, users

	created = 0
	for c in clients:
		existing = frappe.db.get_value("Customer", {"customer_name": c["name"]}, "name")
		if not existing:
			existing = demo.ensure_customer(c["name"], c["mobile"], c["email"])
			created += 1
		if frappe.db.exists("Loyalty Program", LOYALTY_PROGRAM) and frappe.db.get_value("Customer", existing, "loyalty_program") != LOYALTY_PROGRAM:
			frappe.db.set_value("Customer", existing, "loyalty_program", LOYALTY_PROGRAM, update_modified=False)
		users.ensure_profile(existing, str(c["birthday"]), c["home"])
	demo.ensure_client_numbers()
	return created


def _sample_age_checks(plan: dict[str, Any], rng: random.Random) -> int:
	"""Masked audit rows for ~8 % of restricted-item tickets (history skips the live gate)."""
	if not frappe.db.exists("DocType", "Maison Age Check"):
		return 0
	if frappe.db.exists("Maison Age Check", {"offline_uuid": ("like", f"{UUID_PREFIX}%")}):
		return 0
	n = 0
	for inv in plan["invoices"]:
		if not inv["restricted"] or rng.random() > 0.08:
			continue
		outcome = rng.choices(["Verified", "Verified", "Verified", "Underage", "Expired"], weights=[10, 10, 10, 1, 1])[0]
		age = rng.randint(21, 58) if outcome != "Underage" else rng.randint(17, 20)
		si = frappe.db.get_value("Sales Invoice", {"maison_offline_uuid": inv["uuid"]}, "name")
		frappe.get_doc({"doctype": "Maison Age Check", "boutique": inv["boutique"], "associate": frappe.db.get_value("Maison Associate", {"user": inv["associate"]}, "name"), "method": "Scan" if rng.random() < 0.8 else "Manual", "outcome": outcome, "ts": inv["ts"], "age_years": age, "dob_year_ok": 1 if age >= 21 else 0, "minimum_age": 21, "initials": rng.choice(FIRST_NAMES)[0] + rng.choice(LAST_NAMES)[0], "id_expired": 1 if outcome == "Expired" else 0, "issuer": "TX" if inv["boutique"].startswith("HOU") else "OK", "dob_year": inv["ts"].year - age, "offline_uuid": inv["uuid"], "sales_invoice": si if outcome == "Verified" else None}).insert(ignore_permissions=True)
		n += 1
	return n


def seed_history(months: int = 6, target: int = TARGET_INVOICES, commit: bool = True, force: bool = False, run_reposts: bool = True) -> dict[str, Any]:
	"""Generate *months* of CloudChaserz history. Idempotent / resumable (marker ``MARKER_KEY``)."""
	from maison_pos.setup import cloudchaserz

	months = int(months)
	target = int(target)
	started = time.time()
	marker = _get_marker()
	if marker and marker.get("completed") and marker.get("months") == months and not force:
		marker["skipped"] = True
		return marker
	frappe.flags.mute_emails = True
	frappe.flags.in_demo_seed = True
	frappe.flags.in_history_seed = True
	if not cloudchaserz.is_seeded():
		cloudchaserz.seed(commit=commit)

	plan = build_plan(months=months, target=target)
	summary: dict[str, Any] = {"profile": "cloudchaserz", "months": months, "start": str(plan["start"]), "end": str(plan["end"]), "planned": len(plan["invoices"]), "stats": plan_stats(plan), "clients_created": 0, "stock_entries": [], "posted": 0, "existing": 0, "failed": 0, "returns": [], "age_checks": 0}
	reposting = frappe.db.get_single_value("Stock Reposting Settings", "item_based_reposting")
	frappe.db.set_single_value("Stock Reposting Settings", "item_based_reposting", 1)
	frappe.clear_cache(doctype="Stock Reposting Settings")
	try:
		with _history_globals(UUID_PREFIX):
			summary["clients_created"] = ensure_history_clients(plan["clients"])
			summary["stock_entries"] = base.ensure_history_stock(plan)
			if commit:
				base._drop_realtime_log()
				frappe.db.commit()
			customer_names = {r.customer_name: r.name for r in frappe.get_all("Customer", filters={"customer_name": ("in", [c["name"] for c in plan["clients"]])}, fields=["name", "customer_name"])}
			rng = random.Random(HISTORY_SEED + 1)
			base._post_plan(plan, customer_names, summary, months, commit)
			for inv in plan["invoices"]:
				if not inv["is_return_candidate"]:
					continue
				name = frappe.db.get_value("Sales Invoice", {"maison_offline_uuid": inv["uuid"], "docstatus": 1, "is_return": 0}, "name")
				if not name or frappe.db.exists("Sales Invoice", {"return_against": name, "docstatus": 1}):
					continue
				cn = base._make_return(name, rng)
				if cn:
					summary["returns"].append(cn)
			try:
				summary["age_checks"] = _sample_age_checks(plan, rng)
			except Exception:
				frappe.log_error(frappe.get_traceback(), "cloudchaserz history age checks")
			if commit:
				base._drop_realtime_log()
				frappe.db.commit()
	finally:
		frappe.db.set_single_value("Stock Reposting Settings", "item_based_reposting", reposting or 0)
		frappe.clear_cache(doctype="Stock Reposting Settings")
		frappe.flags.in_history_seed = False
	if run_reposts and summary["posted"]:
		summary["reposts"] = base.process_reposts()
	if commit:
		frappe.db.commit()
	summary["invoices_total"] = frappe.db.count("Sales Invoice", {"maison_offline_uuid": ("like", f"{UUID_PREFIX}%"), "docstatus": 1})
	summary["seconds"] = round(time.time() - started, 1)
	summary["completed"] = summary["invoices_total"] >= int(summary["planned"] * 0.98)
	summary["completed_at"] = str(frappe.utils.now_datetime()) if summary["completed"] else None
	_set_marker({k: v for k, v in summary.items() if k not in ("returns", "stock_entries")})
	if commit:
		frappe.db.commit()
	print(frappe.as_json(summary))
	return summary


def _get_marker() -> Optional[dict[str, Any]]:
	raw = frappe.db.get_default(MARKER_KEY)
	if not raw:
		return None
	try:
		return json.loads(raw)
	except Exception:
		return None


def _set_marker(value: Optional[dict[str, Any]]) -> None:
	frappe.db.set_default(MARKER_KEY, "" if value is None else json.dumps(value, default=str))


def history_status() -> dict[str, Any]:
	return {"marker": _get_marker(), "invoices": frappe.db.count("Sales Invoice", {"maison_offline_uuid": ("like", f"{UUID_PREFIX}%"), "docstatus": 1})}


@frappe.whitelist()
def seed_history_remote(months: int = 3, sync: int = 0) -> dict[str, Any]:
	"""Run ``seed_history`` over the API (System Manager only).

	Enqueued on the ``long`` queue by default — a few thousand back-dated invoices take minutes,
	longer than a web request may run. Pass ``sync=1`` to run inline (``bench execute`` only).
	Poll ``maison_pos.setup.cloudchaserz.history.history_status`` for progress.
	"""
	if "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may seed history", frappe.PermissionError)
	months = cint(months)
	if cint(sync or 0):
		return seed_history(months=months)
	marker = _get_marker()
	if marker and marker.get("completed") and marker.get("months") == months:
		marker["skipped"] = True
		return marker
	job = frappe.enqueue(
		"maison_pos.setup.cloudchaserz.history.seed_history",
		queue="long",
		timeout=7200,
		job_name="cloudchaserz_seed_history",
		months=months,
	)
	return {"enqueued": True, "job": getattr(job, "id", None) or str(job), "months": months}


def profile_post(n: int = 15, months: int = 1) -> dict[str, Any]:
	"""Dev utility: cProfile *n* history invoices (rolled back) to see where the posting time goes."""
	import cProfile
	import io
	import pstats

	frappe.flags.mute_emails = True
	frappe.flags.in_demo_seed = True
	frappe.flags.in_history_seed = True
	plan = build_plan(months=months, target=TARGET_INVOICES, seed=HISTORY_SEED + 99)
	customer_names = {r.customer_name: r.name for r in frappe.get_all("Customer", fields=["name", "customer_name"], limit=5000)}
	pr = cProfile.Profile()
	started = time.time()
	with _history_globals(f"hist-prof{int(started)}-"):
		plan["invoices"] = plan["invoices"][:n]
		plan["needed"] = {b: {} for b in stores.store_codes()}
		for inv in plan["invoices"]:
			for l in inv["lines"]:
				if ITEM_META[l["item_code"]]["group"] != "Services":
					plan["needed"][inv["boutique"]][l["item_code"]] = plan["needed"][inv["boutique"]].get(l["item_code"], 0) + int(l["qty"])
		plan["tag"] = "P"
		base.ensure_history_stock(plan)
		pr.enable()
		posted = 0
		for inv in plan["invoices"][:n]:
			inv["uuid"] = f"hist-prof{int(started)}-{posted:05d}"
			payload = base._payload(inv, customer_names, set(), "H")
			if payload:
				base._post_invoice(payload)
				posted += 1
		pr.disable()
	frappe.db.rollback()
	s = io.StringIO()
	pstats.Stats(pr, stream=s).sort_stats("cumulative").print_stats(45)
	print(s.getvalue())
	return {"posted": posted, "seconds": round(time.time() - started, 1), "per_invoice": round((time.time() - started) / max(1, posted), 3)}
