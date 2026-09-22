"""Scents of Arabia tenant (v1.3) — ``maison_pos.setup.scentsofarabia.seed``.

The second real tenant of the platform, and the first on the **Perfume** vertical: a fragrance
retailer — designer houses, Arabian oud and attar oils, gift sets, body sprays — with head office
and the main warehouse in Houston (**Markhor Wholesale**, 5700 Hartsdale Dr) and two stores in the
Tulsa metro, **Owasso** and **East Tulsa (71st St)**. Same shape as CloudChaserz: Houston buys
from the vendors, marks the stock up, and sends it to the stores; the stores sell it.

This is **not a demo seed**. It carries no invented customers, no back-dated sales history and no
giveaway. What it seeds is real: the company, the three locations, the brand, the vendor the
client actually buys from, the catalogue exactly as it appears on the vendor's invoices, and those
invoices received into Houston at cost and pushed to Owasso — the stock the client holds today.

    bench --site <site> execute maison_pos.setup.scentsofarabia.seed
    POST /api/method/maison_pos.setup.scentsofarabia.seed_remote           (managed hosts)
    GET  /api/method/maison_pos.setup.scentsofarabia.status

Sub-modules reuse the generic helpers of ``setup.demo`` under ``profile_globals()``, exactly as the
CloudChaserz seed does (``COMPANY`` / ``ABBR`` / ``LOYALTY_PROGRAM`` / ``BOUTIQUES`` / ``ITEMS``
temporarily point at the Scents of Arabia values).

Pricing rule (the client's words, September 2026): *"big brands about 30 %, Arabic oud 80–100 %"*
markup on cost. The catalogue tags every item **Designer** or **Arabian**
(``Item.maison_fragrance_origin``) and ``catalog.retail_rate`` applies 30 % / 100 %. The same
figures go on the v1.2 wholesale price board (what Owasso owes Houston), because the client
described one markup — "Houston buys it, marks it up and sends it to Owasso". Both are one screen
to change: ``/warehouse → Prices``.
"""

from __future__ import annotations

import contextlib
from typing import Any, Iterator, Optional

import frappe

COMPANY = "Scents of Arabia"
ABBR = "SOA"
CURRENCY = "USD"
COUNTRY = "United States"
TIMEZONE = "America/Chicago"
PRICE_LIST = "Standard Selling"
WALK_IN = "Walk-in Customer"
LOYALTY_PROGRAM = "Scents of Arabia Rewards"
PROFILE = "scentsofarabia"
STOCK_REMARK = "Scents of Arabia opening stock"

#: placeholder staff logins live here until the client names real people (docs/scentsofarabia.md §5)
DOMAIN = "scentsofarabia.example"

#: markup on cost, by ``Item.maison_fragrance_origin`` — the client's rule
MARKUP_PCT: dict[str, float] = {"Designer": 30.0, "Arabian": 100.0, "Niche": 30.0, "House": 100.0}
DEFAULT_MARKUP_PCT = 30.0


@contextlib.contextmanager
def profile_globals(password: Optional[str] = None) -> Iterator[None]:
	"""Run ``setup.demo`` helpers against the Scents of Arabia company / abbreviation.

	*password* is what ``demo.ensure_user`` gives a login it **creates** (existing users are never
	touched); it is generated per run and never stored in the repository."""
	from maison_pos.setup import demo
	from maison_pos.setup.scentsofarabia import catalog, stores

	keys = ("COMPANY", "ABBR", "LOYALTY_PROGRAM", "BOUTIQUES", "ITEMS", "WALK_IN", "DEMO_STOCK_REMARK", "CUSTOMERS", "DEMO_PASSWORD")
	saved = {k: getattr(demo, k) for k in keys}
	demo.COMPANY = COMPANY
	demo.ABBR = ABBR
	demo.LOYALTY_PROGRAM = LOYALTY_PROGRAM
	demo.BOUTIQUES = stores.demo_boutique_specs()
	demo.ITEMS = catalog.legacy_item_tuples()
	demo.WALK_IN = WALK_IN
	demo.DEMO_STOCK_REMARK = STOCK_REMARK
	demo.CUSTOMERS = []
	demo.DEMO_PASSWORD = password or frappe.generate_hash(length=12)
	try:
		yield
	finally:
		for k, v in saved.items():
			setattr(demo, k, v)


def is_seeded() -> bool:
	return bool(frappe.db.exists("AWANZ Store", "OK-OWA")) and frappe.db.get_value("AWANZ Store", "OK-OWA", "company") == COMPANY


def _assert_system_manager() -> None:
	if frappe.session.user not in ("Administrator", "") and "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may seed the tenant", frappe.PermissionError)


SUMMARY_CACHE_KEY = "scentsofarabia_seed_summary"


@frappe.whitelist()
def seed_remote(password: Optional[str] = None, push: int = 1, background: int = 1) -> dict[str, Any]:
	"""Run the seed over the API (System Manager only) — for Frappe Cloud, which has no shell.

	``background=1`` (the default) enqueues it on the ``long`` queue, because 63 items with art,
	three receipts and a shipment take longer than a gateway allows a request; poll ``status()``
	for ``seed_summary``. ``background=0`` runs it inline and returns the summary directly.
	"""
	from frappe.utils import cint

	_assert_system_manager()
	if not cint(background):
		return seed(password=password or None, push=bool(cint(push)))
	frappe.cache().delete_value(SUMMARY_CACHE_KEY)
	job = frappe.enqueue(
		"maison_pos.setup.scentsofarabia._seed_job",
		queue="long",
		timeout=3600,
		job_name="scentsofarabia_seed",
		password=password or None,
		push=bool(cint(push)),
	)
	return {"enqueued": True, "job": getattr(job, "id", None) or str(job), "poll": "maison_pos.setup.scentsofarabia.status"}


def _seed_job(password: Optional[str] = None, push: bool = True) -> None:
	"""The background body of :func:`seed_remote`: the summary (or the traceback) lands in the
	cache for an hour so ``status()`` can hand it back once."""
	try:
		summary = seed(commit=True, password=password, push=push)
		frappe.cache().set_value(SUMMARY_CACHE_KEY, frappe.as_json({"ok": True, "summary": summary}), expires_in_sec=3600)
	except Exception:
		frappe.db.rollback()
		frappe.cache().set_value(SUMMARY_CACHE_KEY, frappe.as_json({"ok": False, "traceback": frappe.get_traceback()}), expires_in_sec=3600)
		frappe.log_error(frappe.get_traceback(), "scentsofarabia seed")
		raise


@frappe.whitelist()
def status() -> dict[str, Any]:
	"""What the seed has produced on this site."""
	_assert_system_manager()
	from maison_pos.setup.scentsofarabia import catalog, purchasing, stores

	codes = [i["code"] for i in catalog.ITEMS]
	owasso = stores.warehouse_name("OK-OWA")
	houston = stores.warehouse_name(stores.WAREHOUSE_CODE)

	def on_hand(wh: str) -> float:
		return float(frappe.db.sql("select coalesce(sum(actual_qty),0) from tabBin where warehouse=%s", wh)[0][0] or 0)

	return {
		"seeded": is_seeded(),
		"company": COMPANY,
		"brand_name": frappe.db.get_single_value("AWANZ POS Settings", "brand_name"),
		"vertical": frappe.db.get_single_value("AWANZ POS Settings", "vertical"),
		"stores": frappe.get_all("AWANZ Store", filters={"company": COMPANY, "enabled": 1}, pluck="name"),
		"items": frappe.db.count("Item", {"item_code": ("in", codes)}),
		"vendor": purchasing.VENDOR["name"] if frappe.db.exists("Supplier", purchasing.VENDOR["name"]) else None,
		"purchase_orders": frappe.get_all("Purchase Order", filters={"company": COMPANY, "docstatus": 1}, fields=["name", "maison_vendor_invoice_no", "grand_total", "status"]),
		"receipts": frappe.db.count("Purchase Receipt", {"company": COMPANY, "docstatus": 1}),
		"on_hand": {"HOU-WH": on_hand(houston), "OK-OWA": on_hand(owasso), "OK-ETUL": on_hand(stores.warehouse_name("OK-ETUL"))},
		"shipments": frappe.get_all("AWANZ Shipment", filters={"boutique": "OK-OWA"}, fields=["name", "status"]) if frappe.db.exists("DocType", "AWANZ Shipment") else [],
		"seed_summary": frappe.parse_json(frappe.cache().get_value(SUMMARY_CACHE_KEY) or "null"),
	}


def seed(commit: bool = True, password: Optional[str] = None, push: bool = True) -> dict[str, Any]:
	"""Create everything. Safe to run repeatedly — every step is idempotent.

	*password* is the initial password for the placeholder staff logins; ``None`` generates one
	and returns it in the summary (printed once — it is never stored in this repository).
	*push* sends the received stock to Owasso; pass ``False`` to leave it in Houston.
	"""
	_assert_system_manager()
	from maison_pos.setup import demo
	from maison_pos.setup.install import after_install
	from maison_pos.setup.scentsofarabia import catalog, distribution, purchasing, rewards, stores, users

	frappe.flags.mute_emails = True
	initial_password = password or frappe.generate_hash(length=12)

	after_install()
	with profile_globals(initial_password):
		stores.ensure_erpnext_setup()
		demo.ensure_company()
		accounts = demo.ensure_accounts()
		demo.ensure_modes_of_payment(accounts)
		demo.ensure_price_list()
		catalog.ensure_item_groups()
		rewards.ensure_loyalty_program(accounts)
		walk_in = demo.ensure_customer(WALK_IN, None, None, loyalty=False)
		store_codes = stores.ensure_stores(accounts, walk_in)
		stores.ensure_brand_settings()
		summary_items = catalog.ensure_items()
		catalog.ensure_images()
		summary_rewards = rewards.ensure_tiers()
		summary_users = users.ensure_users()
		summary_web = catalog.seed_webshop()
		summary_purchasing = purchasing.seed_purchasing()
		summary_push = distribution.push_to_owasso() if push else {"skipped": "push=False"}

	if commit:
		frappe.db.commit()
	summary = {
		"profile": PROFILE,
		"company": COMPANY,
		"stores": store_codes,
		"items": summary_items,
		"rewards": summary_rewards,
		"users": summary_users,
		# the initial password of any login this run CREATED (existing users keep theirs)
		"initial_password": initial_password if summary_users.get("created") else None,
		"webshop": summary_web,
		"purchasing": summary_purchasing,
		"push": summary_push,
	}
	print(frappe.as_json(summary))
	return summary
