"""CloudChaserz demo profile (v0.6 N/Q) — ``maison_pos.setup.demo.seed(profile="cloudchaserz")``.

A self-contained seed for the smoke-shop vertical: company **CloudChaserz** (abbr ``CCZ``),
the 11 real stores (Houston Montrose + 10 Oklahoma) and the ``HOU-WH`` main warehouse, a
~120-item catalogue with generated SVG art, demo users, the **CloudChaserz Rewards** program
(loyalty program + fixed reward tiers + promotion calendar + giveaway + events campaign) and
the adapted sales history (``maison_pos.setup.cloudchaserz.history``).

The jewellery seed (``maison_pos.setup.demo``, company *Maison*) stays callable as
``profile="maison"`` — the regression suites rely on it. The two profiles use different
companies so they can coexist on one site (tests seed the jewellery profile inside their own
transaction on a CloudChaserz site).

Sub-modules reuse the generic helpers of ``setup.demo`` under ``profile_globals()``, which
temporarily points that module's ``COMPANY`` / ``ABBR`` / ``LOYALTY_PROGRAM`` / ``BOUTIQUES`` /
``ITEMS`` at the CloudChaserz values.
"""

from __future__ import annotations

import contextlib
import random
from typing import Any, Iterator

import frappe

COMPANY = "CloudChaserz"
ABBR = "CCZ"
CURRENCY = "USD"
COUNTRY = "United States"
TIMEZONE = "America/Chicago"
PRICE_LIST = "Standard Selling"
DEMO_PASSWORD = "cloud123"
WALK_IN = "Walk-in Customer"
LOYALTY_PROGRAM = "CloudChaserz Rewards"
PROFILE = "cloudchaserz"
DEMO_STOCK_REMARK = "CloudChaserz demo opening stock"


@contextlib.contextmanager
def profile_globals() -> Iterator[None]:
	"""Run ``setup.demo`` helpers against the CloudChaserz company / abbreviation."""
	from maison_pos.setup import demo
	from maison_pos.setup.cloudchaserz import catalog, stores

	saved = {k: getattr(demo, k) for k in ("COMPANY", "ABBR", "LOYALTY_PROGRAM", "BOUTIQUES", "ITEMS", "DEMO_PASSWORD", "WALK_IN", "DEMO_STOCK_REMARK", "CUSTOMERS")}
	demo.COMPANY = COMPANY
	demo.ABBR = ABBR
	demo.LOYALTY_PROGRAM = LOYALTY_PROGRAM
	demo.BOUTIQUES = stores.demo_boutique_specs()
	demo.ITEMS = catalog.legacy_item_tuples()
	demo.DEMO_PASSWORD = DEMO_PASSWORD
	demo.WALK_IN = WALK_IN
	demo.DEMO_STOCK_REMARK = DEMO_STOCK_REMARK
	try:
		yield
	finally:
		for k, v in saved.items():
			setattr(demo, k, v)


def is_seeded() -> bool:
	return bool(frappe.db.exists("Maison Boutique", "HOU-MTR"))


@frappe.whitelist()
def seed_remote(history: int = 0) -> dict[str, Any]:
	"""Run the CloudChaserz seed over the API (System Manager only).

	Lets managed hosts such as Frappe Cloud be seeded without shell access:
	``POST /api/method/maison_pos.setup.cloudchaserz.seed_remote``. Pass ``history=1`` to chain a
	short back-dated history; the longer runs belong on
	``maison_pos.setup.cloudchaserz.seed_history_remote``.
	"""
	if "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may seed demo data", frappe.PermissionError)
	from frappe.utils import cint

	return seed(history=bool(cint(history)))


def seed_history(months: int = 6, commit: bool = True, force: bool = False) -> dict[str, Any]:
	"""Back-dated CloudChaserz sales across the 11 stores, adapted to the smoke-shop catalogue.

	``bench --site <site> execute maison_pos.setup.cloudchaserz.seed_history --kwargs '{"months":3}'``
	"""
	from maison_pos.setup.cloudchaserz.history import seed_history as _seed_history

	return _seed_history(months=months, commit=commit, force=force)


def history_status() -> dict[str, Any]:
	"""Marker + posted-invoice count for the CloudChaserz history seed."""
	from maison_pos.setup.cloudchaserz.history import history_status as _status

	return _status()


@frappe.whitelist()
def seed_history_remote(months: int = 3, sync: int = 0) -> dict[str, Any]:
	"""Back-dated CloudChaserz sales over the API — enqueued on the ``long`` queue by default."""
	from maison_pos.setup.cloudchaserz.history import seed_history_remote as _remote

	return _remote(months=months, sync=sync)


@frappe.whitelist()
def status() -> dict[str, Any]:
	"""What the CloudChaserz seed has produced on this site (operators / e2e)."""
	if "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may read the seed status", frappe.PermissionError)
	from maison_pos.setup.cloudchaserz import catalog
	from maison_pos.setup.cloudchaserz.history import history_status

	return {
		"seeded": is_seeded(),
		"company": COMPANY,
		"brand_name": frappe.db.get_single_value("Maison POS Settings", "brand_name"),
		"stores": frappe.get_all("Maison Boutique", filters={"company": COMPANY, "enabled": 1}, pluck="name"),
		"items": frappe.db.count("Item", {"item_code": ("in", [i["code"] for i in catalog.ITEMS])}),
		"loyalty_program": LOYALTY_PROGRAM,
		"history": history_status(),
	}


@frappe.whitelist()
def seed(commit: bool = True, history: bool = False) -> dict[str, Any]:
	"""Create all CloudChaserz demo data. Safe to run repeatedly.

	The single documented path to the demo:
	``bench --site <site> execute maison_pos.setup.cloudchaserz.seed`` (or
	``POST /api/method/maison_pos.setup.cloudchaserz.seed`` / ``.seed_remote`` on a managed host).
	"""
	# whitelisted for managed hosts — seeding rewrites company-wide data, so never below System Manager
	if frappe.session.user not in ("Administrator", "") and "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may seed demo data", frappe.PermissionError)
	from maison_pos.setup import demo
	from maison_pos.setup.cloudchaserz import catalog, rewards, salon, stores, users
	from maison_pos.setup.install import after_install

	random.seed(606)
	frappe.flags.mute_emails = True
	frappe.flags.in_demo_seed = True

	after_install()
	with profile_globals():
		stores.ensure_erpnext_setup()
		demo.ensure_company()
		accounts = demo.ensure_accounts()
		demo.ensure_modes_of_payment(accounts)
		demo.ensure_price_list()
		catalog.ensure_item_groups()
		rewards.ensure_loyalty_program(accounts)
		walk_in = demo.ensure_customer(WALK_IN, None, None, loyalty=False)
		store_codes = stores.ensure_stores(accounts, walk_in)
		catalog.ensure_items()
		catalog.ensure_stock()
		users.ensure_customers()
		users.ensure_users()
		stores.ensure_brand_settings()
		summary_rewards = rewards.seed_rewards()
		summary_ops = users.seed_operations()
		summary_web = catalog.seed_webshop()
		summary_salon = salon.seed_salon()  # v0.8 QA C2 — the ambient screen had nothing to show

	if commit:
		frappe.db.commit()
	summary = {
		"profile": PROFILE,
		"company": COMPANY,
		"stores": store_codes,
		"items": frappe.db.count("Item", {"item_code": ("in", [i["code"] for i in catalog.ITEMS])}),
		"customers": frappe.db.count("Customer", {"customer_name": ("in", [c[0] for c in users.CUSTOMERS])}),
		"associates": frappe.db.count("Maison Associate"),
		"loyalty_program": LOYALTY_PROGRAM,
		"password": DEMO_PASSWORD,
		"rewards": summary_rewards,
		"operations": summary_ops,
		"webshop": summary_web,
		"salon": summary_salon,
	}
	if history:
		from maison_pos.setup.cloudchaserz.history import seed_history

		summary["history"] = seed_history(months=2, commit=commit)
	print(frappe.as_json(summary))
	return summary
