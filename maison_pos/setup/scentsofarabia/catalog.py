"""Scents of Arabia catalogue (v1.3) — every product on the vendor's invoices 99139 / 99464 /
99595 (Sunshine Electronics & Perfumes, August 2026), exactly as bought: the manufacturer's
UPC / EAN as the scannable barcode, the invoice cost, and the client's markup rule for retail.

Item groups: Designer Fragrances · Arabian & Oud · Gift Sets · Body Sprays & Mists · Perfume
Oils · Displays & Fixtures · Accessories · Services. Departments (the POS top bar) are coarser:
Fragrance · Oud & Oils · Gift Sets · Body Sprays · Fixtures · Services.

Nothing here is age-restricted. Display stands are stock items that are **not for sale**
(``is_sales_item = 0``) — they move to the store with the oils but never appear on the till.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe.utils import cint, flt

from maison_pos.identifiers import ean13_for
from maison_pos.setup.scentsofarabia import ABBR, COMPANY, CURRENCY, MARKUP_PCT, PRICE_LIST

ITEM_GROUPS: list[str] = [
	"Designer Fragrances",
	"Arabian & Oud",
	"Gift Sets",
	"Body Sprays & Mists",
	"Perfume Oils",
	"Displays & Fixtures",
	"Accessories",
	"Services",
]

GROUP_DEPARTMENT: dict[str, str] = {
	"Designer Fragrances": "Fragrance",
	"Arabian & Oud": "Fragrance",
	"Gift Sets": "Gift Sets",
	"Body Sprays & Mists": "Body Sprays",
	"Perfume Oils": "Oud & Oils",
	"Displays & Fixtures": "Fixtures",
	"Accessories": "Accessories",
	"Services": "Services",
}

#: item groups that go on the shop / the till
SALE_GROUPS = ("Designer Fragrances", "Arabian & Oud", "Gift Sets", "Body Sprays & Mists", "Perfume Oils", "Accessories", "Services")

SERIALIZED: set[str] = set()


def _i(
	code: str,
	name: str,
	group: str,
	brand: str,
	cost: float,
	*,
	barcode: Optional[str] = None,
	origin: str = "Designer",
	conc: str = "EDP",
	size: str = "",
	gender: str = "",
	family: str = "",
	notes: str = "",
	tester: bool = False,
	sale: Optional[bool] = None,
	msrp: Optional[float] = None,
) -> dict[str, Any]:
	return {
		"code": code,
		"name": name,
		"group": group,
		"department": GROUP_DEPARTMENT[group],
		"brand": brand,
		"cost": flt(cost),
		"barcode": barcode,
		"origin": origin,
		"concentration": conc,
		"size": size,
		"gender": gender,
		"family": family,
		"notes": notes,
		"tester": tester,
		"sale": (group in SALE_GROUPS) if sale is None else sale,
		"msrp": msrp,
	}


# fmt: off
ITEMS: list[dict[str, Any]] = [
	# ---- Designer Fragrances (DSG) — invoice 99139 ------------------------------------------
	_i("DSG-001", "Juicy Couture Viva La Juicy EDP 3.4 oz", "Designer Fragrances", "Juicy Couture", 40.00, barcode="098691047718", size="3.4 oz", gender="Women", family="Floral Gourmand"),
	_i("DSG-002", "Viktor & Rolf Flowerbomb EDP 3.4 oz", "Designer Fragrances", "Viktor & Rolf", 70.00, barcode="3360374000059", size="3.4 oz", gender="Women", family="Floral Oriental"),
	_i("DSG-003", "Coach New York EDP 1.7 oz", "Designer Fragrances", "Coach", 30.00, barcode="3386460078313", size="1.7 oz", gender="Women", family="Floral Fruity"),
	_i("DSG-004", "Jimmy Choo I Want Choo EDP 2.0 oz", "Designer Fragrances", "Jimmy Choo", 50.00, barcode="3386460119269", size="2.0 oz", gender="Women", family="Floral"),
	_i("DSG-005", "Coach Dreams Sunset EDP 3.0 oz (Tester)", "Designer Fragrances", "Coach", 33.00, barcode="3386460123587", size="3.0 oz", gender="Women", family="Floral Fruity", tester=True),
	_i("DSG-006", "Coach Wild Rose EDP 1.7 oz", "Designer Fragrances", "Coach", 35.00, barcode="3386460126588", size="1.7 oz", gender="Women", family="Floral"),
	_i("DSG-007", "Jimmy Choo I Want Choo Forever EDP 1.3 oz", "Designer Fragrances", "Jimmy Choo", 36.00, barcode="3386460129893", size="1.3 oz", gender="Women", family="Floral"),
	_i("DSG-008", "Jimmy Choo I Want Choo Le Parfum 1.3 oz", "Designer Fragrances", "Jimmy Choo", 46.00, barcode="3386460142021", conc="Parfum", size="1.3 oz", gender="Women", family="Floral Oriental"),
	_i("DSG-009", "Coach Love EDP 1.7 oz", "Designer Fragrances", "Coach", 37.00, barcode="3386460142182", size="1.7 oz", gender="Women", family="Floral"),
	_i("DSG-010", "Jimmy Choo I Want Choo With Love EDP 2.0 oz", "Designer Fragrances", "Jimmy Choo", 70.00, barcode="3386460160834", size="2.0 oz", gender="Women", family="Floral Fruity"),
	_i("DSG-011", "Coach New York Cherry Parfum 1.7 oz", "Designer Fragrances", "Coach", 89.00, barcode="3386460171519", conc="Parfum", size="1.7 oz", gender="Women", family="Fruity Gourmand"),
	_i("DSG-012", "Katy Perry Meow EDP 3.3 oz", "Designer Fragrances", "Katy Perry", 17.00, barcode="3607343191005", size="3.3 oz", gender="Women", family="Floral Fruity"),
	_i("DSG-013", "Adidas Ice Dive EDT 3.3 oz", "Designer Fragrances", "Adidas", 5.50, barcode="3616303321932", conc="EDT", size="3.3 oz", gender="Men", family="Aquatic Fresh"),
	_i("DSG-014", "Adidas Dynamic Pulse EDT 3.3 oz", "Designer Fragrances", "Adidas", 5.50, barcode="3616303321987", conc="EDT", size="3.3 oz", gender="Men", family="Citrus Fresh"),
	_i("DSG-015", "Adidas Champions League Goal EDT 3.4 oz", "Designer Fragrances", "Adidas", 5.50, barcode="3616305265784", conc="EDT", size="3.4 oz", gender="Men", family="Fresh Aromatic"),
	_i("DSG-016", "Paris Hilton Can Can EDP 3.4 oz", "Designer Fragrances", "Paris Hilton", 22.00, barcode="608940533369", size="3.4 oz", gender="Women", family="Floral Fruity"),
	_i("DSG-017", "Juicy Couture Viva La Juicy Gold Couture EDP 3.4 oz", "Designer Fragrances", "Juicy Couture", 34.00, barcode="719346186551", size="3.4 oz", gender="Women", family="Floral Gourmand"),
	_i("DSG-018", "Versace Dylan Turquoise EDT 3.4 oz (Tester)", "Designer Fragrances", "Versace", 46.50, barcode="8011003858569", conc="EDT", size="3.4 oz", gender="Women", family="Citrus Aquatic", tester=True),
	# ---- Arabian & Oud (ARB) — invoice 99139 ------------------------------------------------
	_i("ARB-001", "Arabiyat Prestige Nyla EDP 2.7 oz", "Arabian & Oud", "Arabiyat Prestige", 18.00, barcode="6290102040149", origin="Arabian", size="2.7 oz", gender="Women", family="Floral Fruity"),
	_i("ARB-002", "Lattafa His Confession EDP 3.4 oz", "Arabian & Oud", "Lattafa", 28.00, barcode="6290360599113", origin="Arabian", size="3.4 oz", gender="Men", family="Woody Spicy"),
	_i("ARB-003", "Arabiyat Prestige Safa EDP 3.4 oz", "Arabian & Oud", "Arabiyat Prestige", 30.00, barcode="6290361912331", origin="Arabian", size="3.4 oz", gender="Women", family="Floral Oriental"),
	_i("ARB-004", "Arabiyat Prestige Marwa EDP 3.4 oz", "Arabian & Oud", "Arabiyat Prestige", 33.00, barcode="6290361912348", origin="Arabian", size="3.4 oz", gender="Unisex", family="Oriental"),
	_i("ARB-005", "Arabiyat Prestige Nyla Sherbet EDP 3.4 oz", "Arabian & Oud", "Arabiyat Prestige", 18.00, barcode="6290361915912", origin="Arabian", size="3.4 oz", gender="Women", family="Fruity Gourmand"),
	_i("ARB-006", "Lattafa Ana Abiyedh Coral EDP 2.04 oz", "Arabian & Oud", "Lattafa", 15.00, barcode="6290362341826", origin="Arabian", size="2.04 oz", gender="Unisex", family="Floral Musky"),
	_i("ARB-007", "Swiss Arabian Essence of Casablanca Extrait 3.4 oz", "Arabian & Oud", "Swiss Arabian", 49.00, barcode="6295124042768", origin="Arabian", conc="Extrait de Parfum", size="3.4 oz", gender="Unisex", family="Oriental Woody"),
	_i("ARB-008", "Swiss Arabian Soul of Bali Extrait 3.4 oz", "Arabian & Oud", "Swiss Arabian", 49.00, barcode="6295124048494", origin="Arabian", conc="Extrait de Parfum", size="3.4 oz", gender="Unisex", family="Floral Oriental"),
	_i("ARB-009", "Armaf Ombre Fresh Parfum 3.4 oz", "Arabian & Oud", "Armaf", 42.00, barcode="6295199814147", origin="Arabian", conc="Parfum", size="3.4 oz", gender="Men", family="Fresh Woody"),
	_i("ARB-010", "EBC Mini Heel EDP 1.2 oz", "Arabian & Oud", "EBC", 2.50, origin="House", size="1.2 oz", gender="Women", family="Floral"),
	_i("ARB-011", "Secret Plus Perfume 3.4 oz", "Arabian & Oud", "Secret Plus", 2.35, origin="House", size="3.4 oz", gender="Unisex", family="Oriental"),
	# ---- Gift Sets (GFT) — invoice 99139 ----------------------------------------------------
	_i("GFT-001", "Coach Poppy Gift Set — EDP 1.0 oz + Body Lotion 3.3 oz", "Gift Sets", "Coach", 23.00, barcode="3386460122610", conc="Gift Set", size="1.0 oz + 3.3 oz", gender="Women", family="Floral Fruity"),
	_i("GFT-002", "Mont Blanc Explorer Ultra Blue Gift Set — EDP 3.3 oz + 0.25 oz + Shower Gel 3.3 oz", "Gift Sets", "Mont Blanc", 42.00, barcode="3386460139359", conc="Gift Set", size="3.3 oz + 0.25 oz + 3.3 oz", gender="Men", family="Aquatic Woody"),
	_i("GFT-003", "Coach Poppy Crush Gift Set — EDP 1.0 oz + Body Lotion 3.3 oz", "Gift Sets", "Coach", 23.00, barcode="3386460144858", conc="Gift Set", size="1.0 oz + 3.3 oz", gender="Women", family="Floral Fruity"),
	_i("GFT-004", "Calvin Klein Eternity Gift Set — EDP 1.6 oz + Body Lotion 3.3 oz + Shower Gel 3.3 oz", "Gift Sets", "Calvin Klein", 38.00, barcode="3616303455156", conc="Gift Set", size="1.6 oz + 3.3 oz + 3.3 oz", gender="Women", family="Floral"),
	_i("GFT-005", "Davidoff Cool Water Gift Set — EDT 2.5 oz + After Shave Balm + Shower Gel + After Shave 2.5 oz", "Gift Sets", "Davidoff", 25.50, barcode="3616304154133", conc="Gift Set", size="4 × 2.5 oz", gender="Men", family="Aquatic Fresh"),
	_i("GFT-006", "Burberry Hero Gift Set — EDT 3.3 oz + 0.33 oz + Shower Gel 2.5 oz", "Gift Sets", "Burberry", 60.00, barcode="3616304960963", conc="Gift Set", size="3.3 oz + 0.33 oz + 2.5 oz", gender="Men", family="Woody Aromatic"),
	_i("GFT-007", "Calvin Klein Euphoria Gift Set — EDP 1.6 oz + Body Lotion 3.3 oz", "Gift Sets", "Calvin Klein", 30.00, barcode="3616305433855", conc="Gift Set", size="1.6 oz + 3.3 oz", gender="Women", family="Floral Oriental"),
	_i("GFT-008", "CR7 Cristiano Ronaldo Gift Set — EDT 3.4 oz + Body Spray 4.1 oz + Shower Gel 5.1 oz", "Gift Sets", "CR7", 25.00, barcode="5060524511739", conc="Gift Set", size="3.4 oz + 4.1 oz + 5.1 oz", gender="Men", family="Woody Aromatic"),
	_i("GFT-009", "CR7 Play It Cool Gift Set — EDT 3.4 oz + Body Spray 4.1 oz + Shower Gel 5.1 oz", "Gift Sets", "CR7", 28.00, barcode="5060524511746", conc="Gift Set", size="3.4 oz + 4.1 oz + 5.1 oz", gender="Men", family="Fresh Aromatic"),
	_i("GFT-010", "CR7 Game On Gift Set — EDT 3.4 oz + Body Spray 4.1 oz + Shower Gel 5.1 oz", "Gift Sets", "CR7", 27.00, barcode="5060524511753", conc="Gift Set", size="3.4 oz + 4.1 oz + 5.1 oz", gender="Men", family="Fresh Aromatic"),
	_i("GFT-011", "Azzaro Chrome Gift Set — EDT 3.38 oz + 2 × Shampoo 2.53 oz", "Gift Sets", "Azzaro", 35.00, barcode="608940589144", conc="Gift Set", size="3.38 oz + 2 × 2.53 oz", gender="Men", family="Citrus Aquatic"),
	_i("GFT-012", "Elizabeth Taylor White Diamonds Gift Set — EDT 3.3 oz + 0.33 oz + Lotion 3.3 oz + Body Wash 3.3 oz", "Gift Sets", "Elizabeth Taylor", 31.00, barcode="719346297011", conc="Gift Set", size="3.3 oz + 0.33 oz + 3.3 oz + 3.3 oz", gender="Women", family="Floral Aldehyde"),
	_i("GFT-013", "Versace Dylan Turquoise Gift Set — EDT 3.4 oz + Body Gel + Shower Gel 3.4 oz + Make-up Case", "Gift Sets", "Versace", 65.00, barcode="8011003885008", conc="Gift Set", size="3.4 oz + 3.4 oz + 3.4 oz", gender="Women", family="Citrus Aquatic"),
	_i("GFT-014", "Versace Dylan Purple Gift Set — EDP 3.4 oz + 0.17 oz + Shower Gel + Body Lotion 3.4 oz", "Gift Sets", "Versace", 67.00, barcode="8011003889150", conc="Gift Set", size="3.4 oz + 0.17 oz + 3.4 oz + 3.4 oz", gender="Women", family="Fruity Floral"),
	_i("GFT-015", "Versace Eros Pour Femme Gift Set — EDP 3.4 oz + 0.17 oz + Shower Gel + Body Lotion 3.4 oz", "Gift Sets", "Versace", 66.00, barcode="8011003899876", conc="Gift Set", size="3.4 oz + 0.17 oz + 3.4 oz + 3.4 oz", gender="Women", family="Floral Woody"),
	_i("GFT-016", "Dolce & Gabbana Light Blue Gift Set — EDT 3.3 oz + 0.33 oz + Body Cream 1.7 oz", "Gift Sets", "Dolce & Gabbana", 57.50, barcode="8054754400670", conc="Gift Set", size="3.3 oz + 0.33 oz + 1.7 oz", gender="Women", family="Citrus Floral"),
	_i("GFT-017", "Dolce & Gabbana Devotion Gift Set — EDP 3.3 oz + Shower Gel + Body Lotion 1.69 oz", "Gift Sets", "Dolce & Gabbana", 44.00, barcode="8056669922179", conc="Gift Set", size="3.3 oz + 1.69 oz + 1.69 oz", gender="Women", family="Gourmand"),
	_i("GFT-018", "Armaf Club de Nuit Maleka Gift Set — EDP 3.4 oz + Body Spray 1.7 oz + Body Lotion 3.4 oz + Body Mist 8.4 oz", "Gift Sets", "Armaf", 38.50, barcode="6295199810804", origin="Arabian", conc="Gift Set", size="3.4 oz + 1.7 oz + 3.4 oz + 8.4 oz", gender="Women", family="Floral Oriental"),
	_i("GFT-019", "Armaf Club de Nuit Intense Gift Set — EDP 3.4 oz + 0.34 oz + Shower Gel 3.4 oz + Body Spray 6.8 oz", "Gift Sets", "Armaf", 32.50, barcode="6295199814840", origin="Arabian", conc="Gift Set", size="3.4 oz + 0.34 oz + 3.4 oz + 6.8 oz", gender="Men", family="Woody Citrus"),
	_i("GFT-020", "Armaf Club de Nuit Iconic Gift Set — EDP 3.4 oz + Travel Spray 0.34 oz + Shower Gel 3.4 oz + Body Spray 6.8 oz", "Gift Sets", "Armaf", 40.50, barcode="6295199814871", origin="Arabian", conc="Gift Set", size="3.4 oz + 0.34 oz + 3.4 oz + 6.8 oz", gender="Men", family="Fresh Woody"),
	_i("GFT-021", "Armaf Club de Nuit Urban Man Elixir Gift Set — EDP 3.4 oz + Travel Spray 0.34 oz + Shower Gel 3.4 oz + Body Spray 6.8 oz", "Gift Sets", "Armaf", 32.50, barcode="6295199814888", origin="Arabian", conc="Gift Set", size="3.4 oz + 0.34 oz + 3.4 oz + 6.8 oz", gender="Men", family="Oriental Spicy"),
	_i("GFT-022", "Armaf Club de Nuit Woman (Pink) Gift Set — EDP 3.6 oz + 0.34 oz + Body Lotion 3.4 oz + Body Mist 8.4 oz", "Gift Sets", "Armaf", 30.50, barcode="6295199814895", origin="Arabian", conc="Gift Set", size="3.6 oz + 0.34 oz + 3.4 oz + 8.4 oz", gender="Women", family="Floral Fruity"),
	_i("GFT-023", "Armaf Club de Nuit Untold Gift Set — EDP 3.4 oz + Travel Spray 0.34 oz + Shower Gel 3.4 oz + Body Spray 6.8 oz", "Gift Sets", "Armaf", 40.50, barcode="6295199814918", origin="Arabian", conc="Gift Set", size="3.4 oz + 0.34 oz + 3.4 oz + 6.8 oz", gender="Men", family="Fruity Woody"),
	_i("GFT-024", "Armaf Odyssey Aqua Gift Set — EDP 3.4 oz + Travel Spray 0.34 oz + Shower Gel 3.4 oz + Body Spray 6.8 oz", "Gift Sets", "Armaf", 32.50, barcode="6295199815090", origin="Arabian", conc="Gift Set", size="3.4 oz + 0.34 oz + 3.4 oz + 6.8 oz", gender="Men", family="Aquatic Fresh"),
	_i("GFT-025", "Armaf Odyssey Mandarin Sky Limited Gift Set — EDP 3.4 oz + 0.34 oz + Shower Gel 3.4 oz + Body Spray 6.8 oz", "Gift Sets", "Armaf", 32.50, barcode="6295199815151", origin="Arabian", conc="Gift Set", size="3.4 oz + 0.34 oz + 3.4 oz + 6.8 oz", gender="Men", family="Citrus Woody"),
	_i("GFT-026", "Armaf Odyssey Mega Gift Set — EDP 3.4 oz + Travel Spray 0.34 oz + Shower Gel 3.4 oz + Body Spray 6.8 oz", "Gift Sets", "Armaf", 30.50, barcode="6295199815168", origin="Arabian", conc="Gift Set", size="3.4 oz + 0.34 oz + 3.4 oz + 6.8 oz", gender="Men", family="Woody Spicy"),
	# ---- Body Sprays & Mists (BSP) — invoice 99139 ------------------------------------------
	_i("BSP-001", "Armaf Odyssey Body Spray", "Body Sprays & Mists", "Armaf", 3.00, origin="Arabian", conc="Body Spray", size="6.8 oz", gender="Men", family="Fresh"),
	_i("BSP-002", "Lattafa Body Spray 6.67 oz", "Body Sprays & Mists", "Lattafa", 2.25, origin="Arabian", conc="Body Spray", size="6.67 oz", gender="Unisex", family="Oriental"),
	# ---- Perfume Oils (OIL) — invoices 99464 / 99595 ----------------------------------------
	_i("OIL-001", "Arabian Perfume Oil — Assorted Roll-On", "Perfume Oils", "Scents of Arabia", 1.15, origin="Arabian", conc="Perfume Oil", size="Roll-on vial", gender="Unisex", family="Oud / Attar", notes="Assorted scents from the 36- and 144-vial counter displays"),
	# ---- Displays & Fixtures (FIX) — not for sale ------------------------------------------
	_i("FIX-001", "Perfume Oil Counter Display — 144 vials", "Displays & Fixtures", "Scents of Arabia", 18.00, origin="House", conc="Other", size="144 ct"),
	_i("FIX-002", "Perfume Oil Counter Display — 36 vials", "Displays & Fixtures", "Scents of Arabia", 0.00, origin="House", conc="Other", size="36 ct"),
	# ---- Services / Gift Card (SVC) ----------------------------------------------------------
	_i("SVC-001", "Gift Card $25", "Services", "Scents of Arabia", 0, origin="House", conc="Other", msrp=25.0),
	_i("SVC-002", "Gift Card $50", "Services", "Scents of Arabia", 0, origin="House", conc="Other", msrp=50.0),
	_i("SVC-003", "Gift Card $100", "Services", "Scents of Arabia", 0, origin="House", conc="Other", msrp=100.0),
]
# fmt: on

ITEM_META: dict[str, dict[str, Any]] = {i["code"]: i for i in ITEMS}


# ---------------------------------------------------------------------------
# the price rule
# ---------------------------------------------------------------------------
def markup_for(item: dict[str, Any]) -> float:
	return MARKUP_PCT.get(item.get("origin") or "", MARKUP_PCT["Designer"])


def retail_rate(item: dict[str, Any]) -> float:
	"""Retail = cost × (1 + markup); gift cards sell at face value."""
	if item["group"] == "Services":
		return flt(item.get("msrp") or 0)
	return flt(flt(item["cost"]) * (1.0 + markup_for(item) / 100.0), 2)


def barcode_for(item: dict[str, Any]) -> tuple[str, Optional[str]]:
	"""(barcode, Item Barcode type). Manufacturer codes as printed on the box; an internal
	EAN-13 (``200`` prefix) for bulk lines that have none."""
	code = item.get("barcode")
	if code:
		return code, ("EAN" if len(code) == 13 else "UPC-A" if len(code) == 12 else None)
	return ean13_for(item["code"]), "EAN"


def legacy_item_tuples() -> list[tuple]:
	"""Shape of ``setup.demo.ITEMS`` (``restore_demo_prices`` and a few helpers read it)."""
	return [(i["code"], i["name"], i["group"], i["department"], i["brand"], 0, None, retail_rate(i), i["code"] in SERIALIZED, 0) for i in ITEMS]


# ---------------------------------------------------------------------------
def ensure_item_groups() -> None:
	root = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ("in", ("", None))}, "name") or "All Item Groups"
	for g in ITEM_GROUPS:
		if not frappe.db.exists("Item Group", g):
			frappe.get_doc({"doctype": "Item Group", "item_group_name": g, "parent_item_group": root, "is_group": 0}).insert(ignore_permissions=True)


def _item_values(i: dict[str, Any]) -> dict[str, Any]:
	return {
		"maison_department": i["department"],
		"maison_brand": i["brand"],
		"maison_age_restricted": 0,
		"maison_msrp": flt(i["msrp"]) if i.get("msrp") is not None else retail_rate(i),
		"maison_taxable": 1,
		"maison_concentration": i["concentration"],
		"maison_size": i["size"],
		"maison_gender": i["gender"],
		"maison_fragrance_origin": i["origin"],
		"maison_fragrance_family": i["family"],
		"maison_notes": i["notes"],
		"maison_tester": 1 if i["tester"] else 0,
	}


def _ensure_price(code: str, rate: float) -> None:
	name = frappe.db.get_value("Item Price", {"item_code": code, "price_list": PRICE_LIST, "selling": 1}, "name")
	if not name:
		frappe.get_doc({"doctype": "Item Price", "item_code": code, "price_list": PRICE_LIST, "price_list_rate": rate, "selling": 1, "currency": CURRENCY}).insert(ignore_permissions=True)


def ensure_items() -> dict[str, int]:
	"""Create the catalogue (idempotent). Existing items keep their attributes current and their
	prices untouched — a price the client changed on the board is theirs."""
	from maison_pos.setup.scentsofarabia import stores

	created = 0
	default_wh = stores.warehouse_name(stores.WAREHOUSE_CODE)
	meta = frappe.get_meta("Item")
	for i in ITEMS:
		code = i["code"]
		is_stock = i["group"] != "Services"
		barcode, btype = barcode_for(i)
		values = {k: v for k, v in _item_values(i).items() if meta.has_field(k)}
		if not frappe.db.exists("Item", code):
			doc = frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": code,
					"item_name": i["name"],
					"item_group": i["group"],
					"stock_uom": "Nos",
					"is_stock_item": 1 if is_stock else 0,
					"is_sales_item": 1 if i["sale"] else 0,
					"has_serial_no": 0,
					"include_item_in_manufacturing": 0,
					"description": i["name"],
					"standard_rate": retail_rate(i),
					"valuation_rate": i["cost"] if is_stock else 0,
					"maison_barcode": barcode,
					"barcodes": [{"barcode": barcode, "barcode_type": btype}] if btype else [{"barcode": barcode}],
					"item_defaults": [{"company": COMPANY, "default_warehouse": default_wh}],
					"weight_per_unit": 0.45 if i["group"] in ("Designer Fragrances", "Arabian & Oud", "Body Sprays & Mists") else 0.9 if i["group"] == "Gift Sets" else 0.03 if i["group"] == "Perfume Oils" else 2.5 if i["group"] == "Displays & Fixtures" else 0,
					"weight_uom": "Kg" if frappe.db.exists("UOM", "Kg") else None,
					**values,
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_if_duplicate=True)
			created += 1
		else:
			current = frappe.db.get_value("Item", code, list(values), as_dict=True) or {}
			diff = {k: v for k, v in values.items() if (current.get(k) or "") != (v or "") and (current.get(k) or 0) != (v or 0)}
			if diff:
				frappe.db.set_value("Item", code, diff, update_modified=False)
		if i["sale"]:
			_ensure_price(code, retail_rate(i))
	ensure_wholesale_overrides()
	frappe.clear_cache(doctype="Item")
	return {"created": created, "total": len(ITEMS)}


def ensure_wholesale_overrides() -> int:
	"""v1.2 price board: the chain markup is 30 % (Designer); every Arabian line carries an
	override at cost × 2, so *what Owasso owes Houston* follows the client's two-tier rule."""
	from maison_pos.pricing.wholesale import OVERRIDE_FIELD, apply_markup, markup_pct

	if not frappe.get_meta("Item").has_field(OVERRIDE_FIELD):
		return 0
	chain = markup_pct()
	n = 0
	for i in ITEMS:
		if i["group"] == "Services" or not frappe.db.exists("Item", i["code"]):
			continue
		pct = markup_for(i)
		if abs(pct - chain) < 0.01:
			continue  # the rule already gives this answer
		want = apply_markup(i["cost"], pct)
		if want <= 0:
			continue
		if flt(frappe.db.get_value("Item", i["code"], OVERRIDE_FIELD)) == 0:
			frappe.db.set_value("Item", i["code"], OVERRIDE_FIELD, want, update_modified=False)
			n += 1
	return n


# ---------------------------------------------------------------------------
# product art (generated SVG, no photography yet)
# ---------------------------------------------------------------------------
def _item_svg(item) -> str:
	from maison_pos.setup.scentsofarabia.art import product_svg

	meta = ITEM_META.get(item.item_code, {})
	return product_svg(item.item_code, item.item_name, item.item_group, meta.get("brand"), meta.get("concentration"), meta.get("gender"), meta.get("family"), meta.get("origin"))


def _attach_visual(item) -> Optional[str]:
	file_name = f"scentsofarabia-{item.item_code.lower()}.svg"
	existing = frappe.db.get_value("File", {"attached_to_doctype": "Item", "attached_to_name": item.item_code, "file_name": file_name}, "file_url")
	if existing:
		return existing
	f = frappe.get_doc({"doctype": "File", "file_name": file_name, "attached_to_doctype": "Item", "attached_to_name": item.item_code, "attached_to_field": "image", "is_private": 0, "content": _item_svg(item)})
	f.flags.ignore_permissions = True
	f.insert()
	return f.file_url


def ensure_images(redraw: bool = False) -> int:
	from maison_pos.setup.cloudchaserz.catalog import _redraw_visuals

	n = 0
	for i in ITEMS:
		if not frappe.db.exists("Item", i["code"]):
			continue
		item = frappe.get_doc("Item", i["code"])
		if item.image:
			if redraw and _redraw_visuals(item, _item_svg(item)):
				n += 1
			continue
		url = _attach_visual(item)
		if url:
			frappe.db.set_value("Item", item.name, "image", url, update_modified=False)
			n += 1
	return n


# ---------------------------------------------------------------------------
# web shop
# ---------------------------------------------------------------------------
WEB_GROUPS = ("Designer Fragrances", "Arabian & Oud", "Gift Sets", "Body Sprays & Mists", "Perfume Oils")
FEATURED = ["ARB-007", "DSG-002", "GFT-020", "DSG-011", "ARB-004", "GFT-014", "ARB-002", "DSG-010"]
SHORT_DESCRIPTIONS = {
	"Designer Fragrances": "Designer houses, factory-sealed. Testers at the counter.",
	"Arabian & Oud": "Oud, amber and attar from the Arabian houses we carry.",
	"Gift Sets": "Boxed sets — fragrance plus lotion, shower gel or body spray.",
	"Body Sprays & Mists": "Everyday body sprays and mists.",
	"Perfume Oils": "Concentrated roll-on oils, alcohol-free, from the counter display.",
}


def seed_webshop() -> dict[str, Any]:
	"""Publish the catalogue on the Frappe Webshop (no-op when the app is missing). No demo
	shopper: real customers register on ``/shop/register``."""
	from maison_pos.webshop import is_webshop_installed

	if not is_webshop_installed():
		return {"skipped": "webshop not installed"}
	from maison_pos.setup import demo_v04_webshop as web

	saved = (web.COMPANY, web.ABBR)
	web.COMPANY, web.ABBR = COMPANY, ABBR
	gateway_account = None
	try:
		web.create_webshop_custom_fields()
		web.ensure_web_mode_of_payment_account()
		gateway_account = web.ensure_payment_gateway()
		web.ensure_webshop_settings(gateway_account)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "scentsofarabia webshop settings")
	try:
		from maison_pos.webshop.setup import ensure_portal_signup

		ensure_portal_signup()
	except Exception:
		frappe.log_error(frappe.get_traceback(), "scentsofarabia webshop signup")
	finally:
		web.COMPANY, web.ABBR = saved
	for group in WEB_GROUPS:
		if frappe.db.exists("Item Group", group):
			doc = frappe.get_doc("Item Group", group)
			if not doc.show_in_website:
				doc.show_in_website = 1
				doc.flags.ignore_permissions = True
				doc.save()
	published = 0
	try:
		from webshop.webshop.doctype.website_item.website_item import make_website_item

		root = frappe.db.get_value("Warehouse", {"company": COMPANY, "is_group": 1, "parent_warehouse": ("in", ("", None))}, "name")
		for i in ITEMS:
			if i["group"] not in WEB_GROUPS or not i["sale"] or not frappe.db.exists("Item", i["code"]):
				continue
			item = frappe.get_doc("Item", i["code"])
			if frappe.db.get_value("Item", item.name, "maison_web_mode") != "Buy":
				frappe.db.set_value("Item", item.name, "maison_web_mode", "Buy", update_modified=False)
			if not frappe.db.get_value("Website Item", {"item_code": item.item_code}, "name"):
				wi = make_website_item(item.as_dict(), save=False)
				wi.website_warehouse = root
				wi.published = 1
				wi.website_image = item.image
				wi.short_description = SHORT_DESCRIPTIONS.get(item.item_group, "")
				wi.ranking = (len(FEATURED) - FEATURED.index(item.item_code)) * 10 if item.item_code in FEATURED else 0
				wi.flags.ignore_permissions = True
				wi.insert()
			published += 1
		try:
			ws = frappe.get_doc("Website Settings")
			changed = False
			if ws.home_page != "shop":
				ws.home_page = "shop"
				changed = True
			if ws.app_name != COMPANY:
				ws.app_name = COMPANY
				changed = True
			if changed:
				ws.flags.ignore_permissions = True
				ws.save()
		except Exception:
			frappe.log_error(frappe.get_traceback(), "scentsofarabia website settings")
	except Exception:
		frappe.log_error(frappe.get_traceback(), "scentsofarabia website items")
	frappe.clear_cache(doctype="Webshop Settings")
	return {"published": published, "gateway_account": gateway_account, "signup_enabled": not cint(frappe.db.get_single_value("Website Settings", "disable_signup"))}
