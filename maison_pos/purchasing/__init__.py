"""Purchasing (v1.0 "Procurement") — buying is centralised at the Houston warehouse.

Layout::

    purchasing/__init__.py   company / warehouse / freight-account helpers, Moving Average
    purchasing/vendors.py    Supplier profile, `<Supplier> Buying` price list, AWANZ Item Vendor
    purchasing/orders.py     Purchase Order glue: freight row, drop-ship, send, print context
    purchasing/receiving.py  one Purchase Receipt path shared by the warehouse and the stores
    purchasing/demand.py     what to buy: low stock + unfillable store demand + trending

The API surface lives in ``maison_pos.api.purchasing``; the install glue (custom fields, roles,
Moving Average, print format) in ``maison_pos.setup.install_v10_purchasing``.

**Costing is Moving Average** (client decision, SPEC_v1.0 §"Client decisions" 1). ERPNext v15
keeps the site-wide default on ``Stock Settings.valuation_method`` — there is no
``Company.default_valuation_method`` field — so :func:`ensure_moving_average` pins the Stock
Setting *and* every stock ``Item.valuation_method`` and is re-run on every migrate.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt

MOVING_AVERAGE = "Moving Average"
#: the freight row we maintain on every Purchase Order / Purchase Receipt
FREIGHT_DESCRIPTION = "Freight (AWANZ)"
FREIGHT_ACCOUNT_NAME = "Freight & Valuation Charges"
ORDER_METHODS = ("Email", "Portal", "Phone", "EDI")
SUGGESTION_SOURCES = ("Low stock", "Store demand", "Trending")


def _meta_has(doctype: str, fieldname: str) -> bool:
	try:
		return frappe.get_meta(doctype).has_field(fieldname)
	except Exception:  # pragma: no cover — doctype missing on an old site
		return False


# ---------------------------------------------------------------------------
# company / warehouse
# ---------------------------------------------------------------------------
def main_warehouse(company: Optional[str] = None) -> str:
	"""HOU-WH (or whatever ``AWANZ POS Settings.main_warehouse`` points at)."""
	from maison_pos.shipping import get_main_warehouse

	return get_main_warehouse(company=company)


def default_company() -> str:
	"""Company of the main warehouse — every purchase document belongs to it."""
	wh = main_warehouse()
	company = frappe.db.get_value("Warehouse", wh, "company") if wh else None
	return company or frappe.defaults.get_global_default("company") or frappe.db.get_value("Company", {}, "name")


def store_for_warehouse(warehouse: Optional[str]) -> Optional[str]:
	if not warehouse:
		return None
	return frappe.db.get_value("AWANZ Store", {"warehouse": warehouse}, "name")


def store_warehouse(store: str) -> Optional[str]:
	return frappe.db.get_value("AWANZ Store", store, "warehouse")


def damaged_warehouse_for(warehouse: Optional[str]) -> Optional[str]:
	"""``<code> Damaged`` of the store/warehouse row that owns *warehouse* (v0.4 D/E)."""
	store = store_for_warehouse(warehouse)
	if store:
		name = frappe.db.get_value("AWANZ Store", store, "damaged_warehouse")
		if name and frappe.db.exists("Warehouse", name):
			return name
		try:
			from maison_pos.setup.install_v04_inventory import ensure_damaged_warehouse

			return ensure_damaged_warehouse(store)
		except Exception:  # pragma: no cover
			return None
	return None


# ---------------------------------------------------------------------------
# Moving Average (client decision 1)
# ---------------------------------------------------------------------------
def ensure_moving_average(commit: bool = False) -> dict[str, Any]:
	"""Pin Moving Average site-wide and on every stock Item. Idempotent — safe on every migrate.

	ERPNext resolves an item's valuation with ``Item.valuation_method or
	Stock Settings.valuation_method or "FIFO"`` (``erpnext.stock.utils.get_valuation_method``).
	There is no ``Company.default_valuation_method`` field in v15, so "pinned on the company"
	is implemented as the site-wide Stock Setting plus an explicit per-item value: a new item
	created by hand in the desk inherits the setting, and every existing item says
	*Moving Average* on its own form.
	"""
	changed = {"stock_settings": False, "items": 0}
	try:
		if frappe.db.get_single_value("Stock Settings", "valuation_method") != MOVING_AVERAGE:
			frappe.db.set_single_value("Stock Settings", "valuation_method", MOVING_AVERAGE)
			frappe.clear_cache(doctype="Stock Settings")
			changed["stock_settings"] = True
	except Exception:  # pragma: no cover — Stock Settings missing (erpnext not installed)
		return changed
	names = frappe.get_all(
		"Item",
		filters={"is_stock_item": 1, "valuation_method": ("!=", MOVING_AVERAGE)},
		pluck="name",
		limit=100000,
	)
	for name in names:
		# db-level: `Item.validate` refuses to change the valuation method once the item has
		# stock ledger entries, and this is a policy decision taken for the whole chain.
		frappe.db.set_value("Item", name, "valuation_method", MOVING_AVERAGE, update_modified=False)
		frappe.clear_document_cache("Item", name)
	changed["items"] = len(names)
	if commit and (changed["stock_settings"] or changed["items"]):
		frappe.db.commit()
	return changed


# ---------------------------------------------------------------------------
# the freight / valuation account
# ---------------------------------------------------------------------------
def freight_account(company: Optional[str] = None) -> Optional[str]:
	"""The account the maintained freight row posts to, for *company*.

	Order of preference (documented in ``docs/purchasing.md``):

    1. ``Company.expenses_included_in_valuation`` — the account ERPNext itself created for
       exactly this purpose and the one its Landed Cost Voucher uses (account type
       *Expenses Included In Valuation*). Under perpetual inventory a Valuation charge is
       debited to stock and credited here, which nets to zero over the life of the goods.
    2. any account of that type belonging to the company;
    3. failing both, a ``Freight & Valuation Charges`` leaf created under *Stock Expenses*
       (or Indirect Expenses) with the same account type, and pinned on the company when the
       company field was empty.

	*Freight and Forwarding Charges* (an Indirect Expense in the standard chart) is deliberately
	**not** used: it is a P&L expense head for freight that is *not* capitalised, and this freight
	is capitalised into moving-average stock value.
	"""
	company = company or default_company()
	if not company:
		return None
	account = frappe.db.get_value("Company", company, "expenses_included_in_valuation")
	if account and frappe.db.exists("Account", account):
		return account
	account = frappe.db.get_value(
		"Account", {"company": company, "account_type": "Expenses Included In Valuation", "is_group": 0}, "name"
	)
	if account:
		_pin_company_account(company, account)
		return account
	return _create_freight_account(company)


def _pin_company_account(company: str, account: str) -> None:
	if not frappe.db.get_value("Company", company, "expenses_included_in_valuation"):
		frappe.db.set_value("Company", company, "expenses_included_in_valuation", account, update_modified=False)
		frappe.clear_document_cache("Company", company)


def _create_freight_account(company: str) -> Optional[str]:
	abbr = frappe.get_cached_value("Company", company, "abbr")
	name = f"{FREIGHT_ACCOUNT_NAME} - {abbr}"
	if frappe.db.exists("Account", name):
		_pin_company_account(company, name)
		return name
	parent = None
	for candidate in (
		{"company": company, "account_name": "Stock Expenses", "is_group": 1},
		{"company": company, "account_name": "Indirect Expenses", "is_group": 1},
		{"company": company, "root_type": "Expense", "is_group": 1},
	):
		parent = frappe.db.get_value("Account", candidate, "name")
		if parent:
			break
	if not parent:
		return None
	doc = frappe.get_doc(
		{
			"doctype": "Account",
			"account_name": FREIGHT_ACCOUNT_NAME,
			"company": company,
			"parent_account": parent,
			"root_type": "Expense",
			"report_type": "Profit and Loss",
			"account_type": "Expenses Included In Valuation",
			"is_group": 0,
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_if_duplicate=True)
	_pin_company_account(company, doc.name)
	return doc.name


# ---------------------------------------------------------------------------
# small shared helpers
# ---------------------------------------------------------------------------
def round_up_to_case_pack(qty: float, case_pack: int = 1, moq: int = 0) -> float:
	"""Round *qty* **up** to a whole case, then lift it to the vendor's minimum order quantity.

	Pure function so the suggestion maths can be unit-tested without a database
	(``test_v1_0_purchasing.TestDemand``).
	"""
	qty = max(0.0, flt(qty))
	pack = max(1, cint(case_pack))
	if qty > 0:
		cases = int(qty // pack) + (1 if qty % pack else 0)
		qty = cases * pack
	moq = max(0, cint(moq))
	if moq and qty and qty < moq:
		# the minimum is itself rounded up to a whole case
		cases = int(moq // pack) + (1 if moq % pack else 0)
		qty = cases * pack
	return float(qty)


def item_name_of(item_code: str) -> str:
	return frappe.db.get_value("Item", item_code, "item_name") or item_code


def assert_item(item_code: str) -> str:
	if not item_code or not frappe.db.exists("Item", item_code):
		frappe.throw(_("Item {0} does not exist").format(item_code), frappe.DoesNotExistError)
	return item_code
