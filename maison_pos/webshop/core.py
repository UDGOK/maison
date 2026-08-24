"""Business rules for the web shop: web modes, availability per boutique, click-and-collect orders.

Pure helpers (no ``frappe.whitelist``) so they can be reused by the templates, the API and tests.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime

from maison_pos.webshop import FULFILMENTS, WEB_MODES, WEB_STATUSES

DEFAULT_DEPOSIT_PERCENT = 10.0

# status machine for the POS "Web orders" queue
STATUS_NEXT: dict[str, tuple[str, ...]] = {
	"New": ("Picking", "Cancelled"),
	"Picking": ("Ready", "Cancelled"),
	"Ready": ("Collected", "Picking", "Cancelled"),
	"Collected": (),
	"Cancelled": (),
}


# ---------------------------------------------------------------------------
# web mode rules
# ---------------------------------------------------------------------------
def effective_web_mode(item: dict[str, Any] | Any, available_qty: Optional[float] = None) -> str:
	"""Resolve the web mode of an item.

	Rules (spec G):
	* the explicit ``maison_web_mode`` on the Item wins;
	* a serialized item with at most one unit in the whole chain (a one-of-a-kind piece) is
	  never sold blind online: it falls back to ``Enquire`` even when marked ``Buy``;
	* non-stock items (services) are ``Enquire``;
	* anything else defaults to ``Buy``.
	"""
	get = item.get if isinstance(item, dict) else (lambda k, d=None: getattr(item, k, d))
	mode = get("maison_web_mode") or "Buy"
	if mode not in WEB_MODES:
		mode = "Buy"
	if not cint(get("is_stock_item", 1)):
		return "Enquire"
	# --- v0.6 N — age-restricted items are not sold online unless Head Office enables it (PACT Act / state law) ---
	if is_age_restricted_online_blocked(item):
		return "Enquire"
	# --- end v0.6 N ---
	if cint(get("has_serial_no")) and mode == "Buy":
		qty = available_qty if available_qty is not None else chain_stock(get("item_code") or get("name"))
		if flt(qty) <= 1:
			return "Enquire"
	return mode


def is_age_restricted_online_blocked(item: dict[str, Any] | Any) -> bool:
	"""v0.6 N — True when the item is 21+ and ``webshop_age_restricted_sales`` is off ("Available in store")."""
	get = item.get if isinstance(item, dict) else (lambda k, d=None: getattr(item, k, d))
	restricted = get("maison_age_restricted")
	if restricted is None:
		code = get("item_code") or get("name")
		restricted = frappe.db.get_value("Item", code, "maison_age_restricted") if code else 0
	if not cint(restricted):
		return False
	from maison_pos.brand import get_age_settings

	return not get_age_settings()["webshop_age_restricted_sales"]


def deposit_for(item_code: str, rate: float) -> float:
	pct = flt(frappe.db.get_value("Item", item_code, "maison_deposit_percent")) or DEFAULT_DEPOSIT_PERCENT
	return round(flt(rate) * pct / 100.0, 2)


# ---------------------------------------------------------------------------
# availability
# ---------------------------------------------------------------------------
def boutiques(enabled_only: bool = True) -> list[dict[str, Any]]:
	filters: dict[str, Any] = {"enabled": 1} if enabled_only else {}
	fields = ["name", "boutique_name", "city", "address_line", "phone", "email", "warehouse", "company"]
	# --- v0.6 N — the HOU-WH warehouse row is not a store: never a collection point ---
	meta = frappe.get_meta("Maison Boutique")
	extra = [f for f in ("is_warehouse", "boutique_type", "region", "hours", "timezone", "state", "zip") if meta.has_field(f)]
	rows = frappe.get_all("Maison Boutique", filters=filters, fields=fields + extra, order_by="boutique_name asc")
	out = []
	for r in rows:
		if cint(r.get("is_warehouse")) or r.get("boutique_type") == "Warehouse":
			continue
		if r.get("hours"):
			try:
				import json

				r["hours"] = json.loads(r["hours"]) if isinstance(r["hours"], str) else r["hours"]
			except Exception:
				r["hours"] = None
		out.append(r)
	return out
	# --- end v0.6 N ---


def chain_stock(item_code: str) -> float:
	"""Units across every boutique warehouse."""
	warehouses = [b["warehouse"] for b in boutiques() if b.get("warehouse")]
	if not warehouses:
		return 0.0
	rows = frappe.get_all(
		"Bin", filters={"item_code": item_code, "warehouse": ("in", warehouses)}, fields=["sum(actual_qty) as qty"]
	)
	return flt(rows[0].qty) if rows else 0.0


def availability(item_code: str) -> list[dict[str, Any]]:
	"""Per-boutique availability: ``[{boutique, boutique_name, city, qty, serials[]}]``."""
	out = []
	has_serial = cint(frappe.db.get_value("Item", item_code, "has_serial_no"))
	for b in boutiques():
		qty = flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": b["warehouse"]}, "actual_qty"))
		serials: list[str] = []
		if has_serial and qty > 0:
			serials = frappe.get_all(
				"Serial No",
				filters={"item_code": item_code, "warehouse": b["warehouse"], "status": "Active"},
				pluck="name",
				order_by="name asc",
			)
		out.append(
			{
				"boutique": b["name"],
				"boutique_name": b["boutique_name"],
				"city": b["city"],
				"qty": qty,
				"serials": serials,
			}
		)
	return out


def availability_for_items(item_codes: list[str]) -> dict[str, list[dict[str, Any]]]:
	return {code: availability(code) for code in item_codes}


# --- v0.8 QA A2 — the availability label has to fit a phone -------------------------------------
#
# `city_label` used to join *every* city that holds stock into one `white-space: nowrap` pill.
# On the three-boutique jewellery tenant that is "Chicago, New York, Beverly Hills" (31 chars);
# on an eleven-store one it became "Available at Tulsa, Broken Arrow, Jenks, Houston, Muskogee,
# Owasso, Sapulpa" — a 730 px min-content pill that pushed the product page 435 px sideways in a
# 390 px viewport. Past a couple of cities the useful summary is the count, and the per-store list
# under the pill (and the `<details>` the item page now renders) is the expansion.
# -----------------------------------------------------------------------------------------------
MAX_CITY_LABEL_CHARS = 34
MAX_CITIES_IN_LABEL = 3


def availability_summary(avail: list[dict[str, Any]]) -> dict[str, Any]:
	"""``{stores, cities, label, full}`` for the availability pill.

	*label* is what fits ("Chicago, New York" or "7 stores"); *full* is always the complete city
	list, for the expanded view / ``title``.
	"""
	cities: list[str] = []
	stores = 0
	for row in avail:
		if flt(row["qty"]) > 0:
			stores += 1
			city = (row.get("city") or row["boutique_name"] or "").split(",")[0].strip()
			if city and city not in cities:
				cities.append(city)
	full = ", ".join(cities)
	if not stores:
		label = ""
	elif len(cities) <= MAX_CITIES_IN_LABEL and len(full) <= MAX_CITY_LABEL_CHARS:
		label = full
	else:
		from maison_pos.brand import get_brand

		noun = str(get_brand()["store_noun"]).lower()
		label = f"{stores} {noun}" if stores == 1 else f"{stores} {noun}s"
	return {"stores": stores, "cities": cities, "label": label, "full": full}


def city_label(avail: list[dict[str, Any]]) -> str:
	"""``"Chicago, New York"`` / ``"7 stores"`` — the short availability label (see A2 above)."""
	return availability_summary(avail)["label"]


def city_label_full(avail: list[dict[str, Any]]) -> str:
	"""Every city that holds stock, always spelled out (the expansion behind the pill)."""
	return availability_summary(avail)["full"]
# --- end v0.8 QA A2 ---


# ---------------------------------------------------------------------------
# orders
# ---------------------------------------------------------------------------
def assert_status_transition(current: str, new: str) -> None:
	current = current or "New"
	if new not in WEB_STATUSES:
		frappe.throw(_("Unknown web order status {0}").format(new), frappe.ValidationError)
	if new not in STATUS_NEXT.get(current, ()):
		frappe.throw(_("Cannot move a web order from {0} to {1}").format(current, new), frappe.ValidationError)


def boutique_for_item_availability(item_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
	"""For the checkout boutique picker: per boutique, whether every line is in stock there."""
	out = []
	avail = {r["item_code"]: availability(r["item_code"]) for r in item_rows}
	for b in boutiques():
		missing = []
		for r in item_rows:
			per = next((a for a in avail[r["item_code"]] if a["boutique"] == b["name"]), None)
			if not per or flt(per["qty"]) < flt(r.get("qty") or 1):
				missing.append(r["item_code"])
		out.append(
			{
				"boutique": b["name"],
				"boutique_name": b["boutique_name"],
				"city": b["city"],
				"address_line": b["address_line"],
				"phone": b["phone"],
				"all_in_stock": not missing,
				"missing": missing,
			}
		)
	return out


def prepaid_amount(sales_order: str) -> float:
	"""Sum of advance Payment Entries referencing the Sales Order."""
	rows = frappe.get_all(
		"Payment Entry Reference",
		filters={"reference_doctype": "Sales Order", "reference_name": sales_order, "docstatus": 1},
		fields=["sum(allocated_amount) as amount"],
	)
	return flt(rows[0].amount) if rows else 0.0


def refresh_prepaid(sales_order: str) -> float:
	amount = prepaid_amount(sales_order)
	frappe.db.set_value("Sales Order", sales_order, "maison_prepaid_amount", amount, update_modified=False)
	return amount


def mark_collected(sales_order: str, sales_invoice: str) -> None:
	frappe.db.set_value(
		"Sales Order",
		sales_order,
		{
			"maison_web_status": "Collected",
			"maison_sales_invoice": sales_invoice,
			"maison_collected_at": now_datetime(),
		},
		update_modified=False,
	)


def unmark_collected(sales_order: str) -> None:
	frappe.db.set_value(
		"Sales Order",
		sales_order,
		{"maison_web_status": "Ready", "maison_sales_invoice": None, "maison_collected_at": None},
		update_modified=False,
	)


def fulfilment_or_default(value: Optional[str]) -> str:
	return value if value in FULFILMENTS else FULFILMENTS[0]
