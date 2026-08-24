"""CloudChaserz purchasing seed (v1.0 §H) — vendors, catalogue, reorder levels, order history.

Idempotent and self-contained, like the rest of ``setup/cloudchaserz``:

* **12 vendors** — five wholesale distributors and seven brand-direct suppliers — each with its
  own ``<Supplier> Buying`` price list, lead time, MOQ, order method and rep;
* an **``AWANZ Item Vendor`` row** on every catalogue item: most items carry two vendors at
  different costs (so moving average is visibly exercised), exactly one of them preferred;
* **reorder levels at HOU-WH** so the buying list has something to say on day one;
* a **handful of historical orders and receipts** at drifting costs (with freight on some), so
  ``AWANZ Purchase by Vendor`` and the cost-drift view have data;
* **two open orders**: one normal delivery to HOU-WH and one drop-ship to **OK-BA**.

Run on its own with
``bench --site <site> execute maison_pos.setup.cloudchaserz.purchasing.seed_purchasing``.
"""

from __future__ import annotations

import random
from typing import Any, Optional

import frappe
from frappe.utils import add_days, cint, flt, nowdate

from maison_pos.setup.cloudchaserz import COMPANY

#: name, kind, item groups it supplies, lead time (days), MOQ value, drop-ship?, order method
VENDORS: list[dict[str, Any]] = [
	{
		"name": "Midwest Distribution Co.",
		"kind": "Distributor",
		"groups": ["Disposables", "E-Liquid", "Devices & Mods", "Pods & Coils", "Accessories"],
		"lead_time_days": 3,
		"min_order_value": 750,
		"dropship": 1,
		"order_method": "Portal",
		"portal_url": "https://portal.midwestdistribution.example/cloudchaserz",
		"account_number": "MWD-88213",
		"rep": ("Dana Whitfield", "(630) 555-0143", "dana.whitfield@midwestdistribution.example"),
		"notes": "Primary vape distributor. Cut-off 14:00 CT for same-day dispatch.",
	},
	{
		"name": "Kingdom Vapor Wholesale",
		"kind": "Distributor",
		"groups": ["Disposables", "E-Liquid", "Pods & Coils", "Devices & Mods"],
		"lead_time_days": 5,
		"min_order_value": 500,
		"dropship": 1,
		"order_method": "Portal",
		"portal_url": "https://wholesale.kingdomvapor.example",
		"account_number": "KVW-4471",
		"rep": ("Marcus Bell", "(814) 555-0117", "marcus.bell@kingdomvapor.example"),
		"notes": "Second source for disposables; good on short-dated stock.",
	},
	{
		"name": "Empire Glass & Imports",
		"kind": "Distributor",
		"groups": ["Glass & Rigs", "Hookah & Shisha", "Accessories"],
		"lead_time_days": 8,
		"min_order_value": 1000,
		"dropship": 0,
		"order_method": "Email",
		"account_number": "EGI-2290",
		"rep": ("Yara Haddad", "(718) 555-0188", "yara.haddad@empireglass.example"),
		"notes": "Glass ships freight-collect; always confirm breakage policy on the PO.",
	},
	{
		"name": "Southern Smoke Wholesale",
		"kind": "Distributor",
		"groups": ["Rolling & Papers", "Accessories", "Kratom", "CBD & Hemp"],
		"lead_time_days": 4,
		"min_order_value": 400,
		"dropship": 1,
		"order_method": "Phone",
		"account_number": "SSW-7714",
		"rep": ("Cody Pruitt", "(918) 555-0166", "cody.pruitt@southernsmoke.example"),
		"notes": "Tulsa depot — will drop-ship to the Oklahoma stores same week.",
	},
	{
		"name": "Gulf Coast Smoke Supply",
		"kind": "Distributor",
		"groups": ["Disposables", "Glass & Rigs", "Hookah & Shisha", "Accessories", "Services"],
		"lead_time_days": 6,
		"min_order_value": 600,
		"dropship": 0,
		"order_method": "Email",
		"account_number": "GCS-5502",
		"rep": ("Renee Alvarado", "(713) 555-0129", "renee.alvarado@gulfcoastsmoke.example"),
		"notes": "Houston local — will hold a will-call order for the warehouse van.",
	},
	{
		"name": "Geek Bar USA",
		"kind": "Brand direct",
		"groups": ["Disposables"],
		"lead_time_days": 10,
		"min_order_value": 2500,
		"dropship": 0,
		"order_method": "Email",
		"account_number": "GB-CCZ-001",
		"rep": ("Iris Chen", "(626) 555-0110", "iris.chen@geekbarusa.example"),
		"notes": "Brand direct: best cost, longest lead time, full cases only.",
	},
	{
		"name": "EB Design Distribution",
		"kind": "Brand direct",
		"groups": ["Disposables"],
		"lead_time_days": 12,
		"min_order_value": 2000,
		"dropship": 0,
		"order_method": "Portal",
		"portal_url": "https://b2b.ebdesign.example",
		"account_number": "EBD-30188",
		"rep": ("Tom Nakamura", "(213) 555-0174", "tom.nakamura@ebdesign.example"),
		"notes": "Elf Bar / Lost Mary brand direct.",
	},
	{
		"name": "RAZ Vapor Direct",
		"kind": "Brand direct",
		"groups": ["Disposables"],
		"lead_time_days": 9,
		"min_order_value": 1500,
		"dropship": 1,
		"order_method": "Email",
		"account_number": "RAZ-CCZ-77",
		"rep": ("Priya Nair", "(469) 555-0132", "priya.nair@razvapor.example"),
		"notes": "Will drop-ship a store order when the warehouse is out.",
	},
	{
		"name": "Al Fakher North America",
		"kind": "Brand direct",
		"groups": ["Hookah & Shisha"],
		"lead_time_days": 14,
		"min_order_value": 1200,
		"dropship": 0,
		"order_method": "Email",
		"account_number": "AFNA-6621",
		"rep": ("Sami Rahal", "(305) 555-0155", "sami.rahal@alfakherna.example"),
		"notes": "Shisha lands by container; order a season ahead.",
	},
	{
		"name": "HBI International",
		"kind": "Brand direct",
		"groups": ["Rolling & Papers", "Accessories"],
		"lead_time_days": 7,
		"min_order_value": 800,
		"dropship": 0,
		"order_method": "Portal",
		"portal_url": "https://order.hbiinternational.example",
		"account_number": "HBI-CCZ-4",
		"rep": ("Grace Okafor", "(602) 555-0198", "grace.okafor@hbiinternational.example"),
		"notes": "RAW and Elements papers, brand direct.",
	},
	{
		"name": "Heartland Kratom Wholesale",
		"kind": "Brand direct",
		"groups": ["Kratom"],
		"lead_time_days": 6,
		"min_order_value": 900,
		"dropship": 1,
		"order_method": "Email",
		"account_number": "HKW-1204",
		"rep": ("Dean Farrow", "(816) 555-0107", "dean.farrow@heartlandkratom.example"),
		"notes": "Lab COA with every lot — file it with the receipt.",
	},
	{
		"name": "Green Roads Wholesale",
		"kind": "Brand direct",
		"groups": ["CBD & Hemp"],
		"lead_time_days": 8,
		"min_order_value": 700,
		"dropship": 1,
		"order_method": "Portal",
		"portal_url": "https://wholesale.greenroads.example",
		"account_number": "GRW-9080",
		"rep": ("Alicia Monroe", "(954) 555-0121", "alicia.monroe@greenroadswholesale.example"),
		"notes": "CBD only; COAs available in the portal.",
	},
]

#: item group → (preferred vendor, alternative vendor). The alternative is a little dearer, which
#: is exactly what makes the moving average move when the warehouse buys from both.
GROUP_SOURCING: dict[str, tuple[str, Optional[str]]] = {
	"Disposables": ("Geek Bar USA", "Midwest Distribution Co."),
	"E-Liquid": ("Midwest Distribution Co.", "Kingdom Vapor Wholesale"),
	"Devices & Mods": ("Midwest Distribution Co.", "Kingdom Vapor Wholesale"),
	"Pods & Coils": ("Kingdom Vapor Wholesale", "Midwest Distribution Co."),
	"Glass & Rigs": ("Empire Glass & Imports", "Gulf Coast Smoke Supply"),
	"Hookah & Shisha": ("Al Fakher North America", "Empire Glass & Imports"),
	"Kratom": ("Heartland Kratom Wholesale", "Southern Smoke Wholesale"),
	"CBD & Hemp": ("Green Roads Wholesale", "Southern Smoke Wholesale"),
	"Rolling & Papers": ("HBI International", "Southern Smoke Wholesale"),
	"Accessories": ("Southern Smoke Wholesale", "Gulf Coast Smoke Supply"),
	"Services": ("Gulf Coast Smoke Supply", None),
}

#: brand → the brand-direct vendor that beats the distributor on price
BRAND_SOURCING: dict[str, str] = {
	"Geek Bar": "Geek Bar USA",
	"Elf Bar": "EB Design Distribution",
	"Lost Mary": "EB Design Distribution",
	"RAZ": "RAZ Vapor Direct",
	"Al Fakher": "Al Fakher North America",
	"RAW": "HBI International",
	"Elements": "HBI International",
}

DROPSHIP_STORE = "OK-BA"
CASE_PACKS = (5, 6, 10, 12, 20, 24)


def _supplier_group() -> str:
	for name in ("Distributor", "Local", "All Supplier Groups"):
		if frappe.db.exists("Supplier Group", name):
			return name
	return frappe.db.get_value("Supplier Group", {"is_group": 0}, "name")


def ensure_vendors() -> list[str]:
	"""Create / refresh the 12 vendors and their buying price lists. Idempotent."""
	from maison_pos.purchasing.vendors import ensure_price_list

	group = _supplier_group()
	out: list[str] = []
	for spec in VENDORS:
		name = spec["name"]
		if frappe.db.exists("Supplier", name):
			doc = frappe.get_doc("Supplier", name)
		else:
			doc = frappe.new_doc("Supplier")
			doc.supplier_name = name
			doc.supplier_group = group
			doc.supplier_type = "Company"
		rep_name, rep_phone, rep_email = spec["rep"]
		doc.update(
			{
				"maison_lead_time_days": spec["lead_time_days"],
				"maison_min_order_value": spec["min_order_value"],
				"maison_dropship_capable": cint(spec["dropship"]),
				"maison_order_method": spec["order_method"],
				"maison_portal_url": spec.get("portal_url"),
				"maison_account_number": spec["account_number"],
				"maison_rep_name": rep_name,
				"maison_rep_phone": rep_phone,
				"maison_rep_email": rep_email,
				"maison_notes": spec["notes"],
				"maison_active": 1,
			}
		)
		doc.disabled = 0
		doc.flags.ignore_permissions = True
		doc.save()
		ensure_price_list(doc.name)
		out.append(doc.name)
	return out


def _sourcing_for(item: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
	"""(preferred, alternative) vendor for a catalogue item — brand direct wins when there is one."""
	preferred, alternative = GROUP_SOURCING.get(item["group"], (None, None))
	brand_direct = BRAND_SOURCING.get(item.get("brand") or "")
	if brand_direct:
		if brand_direct == alternative:
			alternative = preferred
		preferred = brand_direct
	if alternative == preferred:
		alternative = None
	return preferred, alternative


def ensure_item_vendors(rng: Optional[random.Random] = None) -> dict[str, int]:
	"""One or two ``AWANZ Item Vendor`` rows per catalogue item, at different costs."""
	from maison_pos.setup.cloudchaserz import catalog

	rng = rng or random.Random(1010)
	items = 0
	rows = 0
	for spec in catalog.ITEMS:
		code = spec["code"]
		if not frappe.db.exists("Item", code):
			continue
		preferred, alternative = _sourcing_for(spec)
		if not preferred or not frappe.db.exists("Supplier", preferred):
			continue
		base = flt(spec["cost"])
		case_pack = rng.choice(CASE_PACKS)
		plan = [
			{
				"supplier": preferred,
				"cost": round(base, 2),
				"case_pack": case_pack,
				"moq": case_pack * rng.choice((1, 2, 4)),
				"lead_time_days": cint(frappe.db.get_value("Supplier", preferred, "maison_lead_time_days")),
				"vendor_sku": f"{code.replace('-', '')}-{frappe.scrub(preferred)[:3].upper()}",
				"is_preferred": 1,
			}
		]
		# ~85 % of the catalogue is dual-sourced, the second vendor 4–12 % dearer
		if alternative and frappe.db.exists("Supplier", alternative) and rng.random() < 0.85:
			alt_pack = rng.choice(CASE_PACKS)
			plan.append(
				{
					"supplier": alternative,
					"cost": round(base * (1 + rng.uniform(0.04, 0.12)), 2),
					"case_pack": alt_pack,
					"moq": alt_pack,
					"lead_time_days": cint(frappe.db.get_value("Supplier", alternative, "maison_lead_time_days")),
					"vendor_sku": f"{code.replace('-', '')}-{frappe.scrub(alternative)[:3].upper()}",
					"is_preferred": 0,
				}
			)
		item = frappe.get_doc("Item", code)
		existing = {r.supplier: r for r in item.get("maison_vendors") or []}
		changed = False
		for row in plan:
			target = existing.get(row["supplier"])
			if target is None:
				target = item.append("maison_vendors", {})
				changed = True
			for field, value in row.items():
				if target.get(field) != value:
					target.set(field, value)
					changed = True
		if changed:
			item._awanz_preferred_supplier = preferred
			item.flags.ignore_permissions = True
			item.save()
			items += 1
		rows += len(plan)
	return {"items": items, "rows": rows}


def ensure_reorder_levels(warehouse: str, rng: Optional[random.Random] = None) -> int:
	"""Reorder level / quantity at HOU-WH from the catalogue's opening warehouse quantity."""
	from maison_pos.setup.cloudchaserz import catalog

	rng = rng or random.Random(2020)
	touched = 0
	for spec in catalog.ITEMS:
		code = spec["code"]
		if not frappe.db.exists("Item", code) or not cint(frappe.db.get_value("Item", code, "is_stock_item")):
			continue
		wh_qty = cint(spec.get("wh")) or 60
		level = max(6, int(wh_qty * rng.uniform(0.25, 0.4)))
		qty = max(12, int(wh_qty * 0.5))
		item = frappe.get_doc("Item", code)
		row = next((r for r in item.get("reorder_levels") or [] if r.warehouse == warehouse), None)
		if row and cint(row.warehouse_reorder_level) == level and cint(row.warehouse_reorder_qty) == qty:
			continue
		if row is None:
			row = item.append("reorder_levels", {"warehouse": warehouse, "material_request_type": "Purchase"})
		row.warehouse_reorder_level = level
		row.warehouse_reorder_qty = qty
		row.material_request_type = "Purchase"
		item.flags.ignore_permissions = True
		item.save()
		touched += 1
	return touched


def _catalogue_items(per_group: int = 3) -> list[dict[str, Any]]:
	"""A spread of real stock items — up to *per_group* per item group, so the order history
	covers disposables, liquid, coils and glass rather than the first page of the catalogue."""
	from maison_pos.setup.cloudchaserz import catalog

	by_group: dict[str, list[dict[str, Any]]] = {}
	for spec in catalog.ITEMS:
		if not frappe.db.exists("Item", spec["code"]) or not cint(frappe.db.get_value("Item", spec["code"], "is_stock_item")):
			continue
		bucket = by_group.setdefault(spec["group"], [])
		if len(bucket) < per_group:
			bucket.append(spec)
	out: list[dict[str, Any]] = []
	for group in sorted(by_group):
		out.extend(by_group[group])
	return out


def _order(supplier: str, lines: list[dict[str, Any]], warehouse: str, days_ago: int, freight: float = 0, dropship_store: Optional[str] = None):
	from maison_pos.purchasing import orders as po_lib

	po = po_lib.create_order(
		supplier,
		lines,
		dropship_store=dropship_store,
		freight=freight,
		company=COMPANY,
	)
	if days_ago:
		po.transaction_date = add_days(nowdate(), -days_ago)
		po.schedule_date = add_days(nowdate(), -days_ago + 5)
		for row in po.items:
			row.schedule_date = po.schedule_date
		po.flags.ignore_permissions = True
		po.save()
	if not dropship_store:
		po.set_warehouse = warehouse
		for row in po.items:
			row.warehouse = warehouse
		po.flags.ignore_permissions = True
		po.save()
	po.flags.ignore_permissions = True
	po.submit()
	return po


def seed_orders(warehouse: str, rng: Optional[random.Random] = None) -> dict[str, Any]:
	"""Eight received orders at drifting costs + two open orders (one drop-ship to OK-BA).

	Only runs when the company has no purchase orders yet, so the seed never duplicates them.
	"""
	from maison_pos.purchasing.receiving import receive_purchase_order

	if frappe.db.count("Purchase Order", {"company": COMPANY}):
		return {"skipped": "purchase orders already exist"}
	rng = rng or random.Random(3030)
	items = _catalogue_items()
	if not items:
		return {"skipped": "no catalogue items"}
	history: list[str] = []
	receipts: list[str] = []
	# three vendors × two dates, the cost drifting a few percent each time
	pairs = [
		("Geek Bar USA", [i for i in items if i["group"] == "Disposables"][:3]),
		("Midwest Distribution Co.", [i for i in items if i["group"] in ("E-Liquid", "Devices & Mods")][:4]),
		("Kingdom Vapor Wholesale", [i for i in items if i["group"] in ("Pods & Coils", "E-Liquid")][:4]),
		("Empire Glass & Imports", [i for i in items if i["group"] in ("Glass & Rigs", "Hookah & Shisha")][:4]),
	]
	for supplier, group_items in pairs:
		if not group_items:
			continue
		for n, days_ago in enumerate((75, 30)):
			drift = 1 + (0.03 * n) + rng.uniform(-0.02, 0.05)
			lines = [
				{"item_code": i["code"], "qty": rng.choice((24, 36, 48, 60)), "rate": round(flt(i["cost"]) * drift, 2)}
				for i in group_items
			]
			freight = round(rng.uniform(35, 140), 2) if rng.random() < 0.7 else 0
			po = _order(supplier, lines, warehouse, days_ago=days_ago, freight=freight)
			history.append(po.name)
			# arrive a day early or a couple of days late, so on-time % is a real number
			arrived = add_days(po.schedule_date, rng.choice((-1, 0, 0, 1, 3)))
			out = receive_purchase_order(
				po.name,
				[{"item_code": row["item_code"], "qty": row["qty"]} for row in lines],
				warehouse=warehouse,
				final=1,
				posting_date=arrived,
			)
			if out.get("purchase_receipt"):
				receipts.append(out["purchase_receipt"])
	# one normal open order …
	open_items = [i for i in items if i["group"] in ("Rolling & Papers", "Accessories", "Kratom", "CBD & Hemp")][:5] or items[:5]
	normal = _order(
		"Southern Smoke Wholesale",
		[{"item_code": i["code"], "qty": 36, "rate": round(flt(i["cost"]) * 1.02, 2)} for i in open_items],
		warehouse,
		days_ago=3,
		freight=64.0,
	)
	# … and one drop-ship straight to Broken Arrow
	dropship = None
	if cint(frappe.db.get_value("AWANZ Store", DROPSHIP_STORE, "enabled")):
		dropship = _order(
			"RAZ Vapor Direct",
			[{"item_code": i["code"], "qty": 12, "rate": round(flt(i["cost"]) * 1.05, 2)} for i in [x for x in items if x["group"] == "Disposables"][:3]],
			warehouse,
			days_ago=1,
			dropship_store=DROPSHIP_STORE,
		).name
	return {
		"received_orders": history,
		"receipts": receipts,
		"open_order": normal.name,
		"dropship_order": dropship,
	}


def seed_purchasing(commit: bool = False) -> dict[str, Any]:
	"""Everything in §H, idempotent. Called from ``setup.cloudchaserz.seed``."""
	from maison_pos.setup.cloudchaserz.stores import WAREHOUSE_CODE, warehouse_name

	if not frappe.db.exists("Company", COMPANY):
		return {"skipped": f"company {COMPANY} is not seeded"}
	warehouse = warehouse_name(WAREHOUSE_CODE)
	if not frappe.db.exists("Warehouse", warehouse):
		return {"skipped": f"warehouse {warehouse} is not seeded"}
	rng = random.Random(1010)
	summary: dict[str, Any] = {"warehouse": warehouse}
	summary["vendors"] = len(ensure_vendors())
	summary["catalogue"] = ensure_item_vendors(rng)
	summary["reorder_levels"] = ensure_reorder_levels(warehouse, rng)
	summary["orders"] = seed_orders(warehouse, rng)
	if commit:
		frappe.db.commit()
	return summary
