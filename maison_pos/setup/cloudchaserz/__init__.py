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


def seed(commit: bool = True, history: bool = False) -> dict[str, Any]:
	"""Create all CloudChaserz demo data. Safe to run repeatedly."""
	from maison_pos.setup import demo
	from maison_pos.setup.cloudchaserz import catalog, rewards, stores, users
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
	}
	if history:
		from maison_pos.setup.cloudchaserz.history import seed_history

		summary["history"] = seed_history(months=2, commit=commit)
	print(frappe.as_json(summary))
	return summary
