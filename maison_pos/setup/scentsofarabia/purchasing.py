"""Scents of Arabia purchasing (v1.3) — the one real vendor and the three invoices the client
handed over, received into Houston at cost on the v1.0 rails (Purchase Order → Purchase Receipt,
``maison_pos.purchasing``), so the buying reports, the cost drift and the Inbound screen all read
the same history the paper does.

    Invoice 99139 · 2026-08-04 · $3,277.25 · "Order 2" — 57 lines of bottles, gift sets, sprays
    Invoice 99464 · 2026-08-11 · $3,031.20 · "Order 3" — 12 × 144-vial oil displays + 720 oils (20 × 36-vial)
    Invoice 99595 · 2026-08-14 · $4,039.20 ·           — 22 × 144-vial oil displays

The vendor's running balance shows ~$11,995 bought **before** 99139 ("Order 1"); that invoice has
not been provided. Add it to ``INVOICES`` when it arrives and re-run the seed — invoices already
received (matched on ``maison_vendor_invoice_no``) are skipped.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe.utils import cint, flt

from maison_pos.setup.scentsofarabia import COMPANY

VENDOR: dict[str, Any] = {
	"name": "Sunshine Electronics & Perfumes",
	"kind": "Distributor",
	"lead_time_days": 2,
	"min_order_value": 0,
	"dropship": 0,
	"order_method": "Phone",
	"portal_url": "https://www.skycubeaudio.com",
	"account_number": "2628",  # our customer number on their invoices
	"rep": ("Maya", "(832) 716-5624", ""),
	"rep2": ("Roman", "(832) 860-5502", ""),
	"notes": "8000 Harwin Dr, Suite 540, Houston TX 77036 · (281) 888-4234 · fax (281) 251-9316. Terms: cash or debit. Second rep: Roman (832) 860-5502.",
	"address": {"line1": "8000 Harwin Dr, Suite 540", "city": "Houston", "state": "TX", "pincode": "77036", "phone": "(281) 888-4234", "fax": "(281) 251-9316"},
}

#: (vendor invoice no, invoice date, lines [(item_code, qty, unit cost)], free-of-charge lines)
INVOICES: list[dict[str, Any]] = [
	{
		"no": "99139",
		"date": "2026-08-04",
		"note": "Order 2 — 8 boxes marked 1/8 … 8/8",
		"lines": [
			("DSG-001", 1, 40.00), ("DSG-002", 1, 70.00), ("DSG-003", 1, 30.00), ("DSG-004", 1, 50.00),
			("GFT-001", 2, 23.00), ("DSG-005", 1, 33.00), ("DSG-006", 1, 35.00), ("DSG-007", 1, 36.00),
			("GFT-002", 2, 42.00), ("DSG-008", 1, 46.00), ("DSG-009", 1, 37.00), ("GFT-003", 2, 23.00),
			("DSG-010", 1, 70.00), ("DSG-011", 1, 89.00), ("DSG-012", 2, 17.00), ("DSG-013", 2, 5.50),
			("DSG-014", 2, 5.50), ("GFT-004", 2, 38.00), ("GFT-005", 2, 25.50), ("GFT-006", 1, 60.00),
			("DSG-015", 2, 5.50), ("GFT-007", 2, 30.00), ("GFT-008", 1, 25.00), ("GFT-009", 1, 28.00),
			("GFT-010", 1, 27.00), ("DSG-016", 1, 22.00), ("GFT-011", 1, 35.00), ("ARB-001", 2, 18.00),
			("ARB-002", 2, 28.00), ("ARB-003", 3, 30.00), ("ARB-004", 3, 33.00), ("ARB-005", 2, 18.00),
			("ARB-006", 2, 15.00), ("ARB-007", 3, 49.00), ("ARB-008", 3, 49.00), ("GFT-018", 2, 38.50),
			("ARB-009", 1, 42.00), ("GFT-019", 2, 32.50), ("GFT-020", 2, 40.50), ("GFT-021", 2, 32.50),
			("GFT-022", 2, 30.50), ("GFT-023", 2, 40.50), ("GFT-024", 2, 32.50), ("GFT-025", 2, 32.50),
			("GFT-026", 2, 30.50), ("DSG-017", 1, 34.00), ("GFT-012", 2, 31.00), ("DSG-018", 1, 46.50),
			("GFT-013", 1, 65.00), ("GFT-014", 1, 67.00), ("GFT-015", 1, 66.00), ("GFT-016", 1, 57.50),
			("GFT-017", 1, 44.00), ("BSP-001", 8, 3.00), ("ARB-010", 6, 2.50), ("BSP-002", 21, 2.25),
			("ARB-011", 120, 2.35),
		],
		"free": [],
		"total": 3277.25,
	},
	{
		"no": "99464",
		"date": "2026-08-11",
		"note": "Order 3 — 12 displays 144 ct + 20 displays 36 ct (oils $1.15, 144-ct display $18)",
		# 12 × 144 = 1,728 oils with 12 stands, plus 720 oils for the twenty 36-vial stands
		"lines": [("OIL-001", 1728 + 720, 1.15), ("FIX-001", 12, 18.00)],
		"free": [("FIX-002", 20)],  # the 36-vial stands were not charged
		"total": 3031.20,
	},
	{
		"no": "99595",
		"date": "2026-08-14",
		"note": "22 displays 144 ct (oils $1.15 + display $18)",
		"lines": [("OIL-001", 22 * 144, 1.15), ("FIX-001", 22, 18.00)],
		"free": [],
		"total": 4039.20,
	},
]


def check_totals() -> None:
	"""Every invoice's lines must add up to the figure printed on the paper — refuse to post otherwise."""
	for inv in INVOICES:
		total = round(sum(q * r for _c, q, r in inv["lines"]), 2)
		if abs(total - inv["total"]) >= 0.005:
			raise ValueError(f"invoice {inv['no']} lines add to {total}, paper says {inv['total']}")


# ---------------------------------------------------------------------------
def _supplier_group() -> str:
	for name in ("Distributor", "Local", "All Supplier Groups"):
		if frappe.db.exists("Supplier Group", name):
			return name
	return frappe.db.get_value("Supplier Group", {"is_group": 0}, "name")


def ensure_vendor() -> str:
	from maison_pos.purchasing.vendors import ensure_price_list

	spec = VENDOR
	name = spec["name"]
	if frappe.db.exists("Supplier", name):
		doc = frappe.get_doc("Supplier", name)
	else:
		doc = frappe.new_doc("Supplier")
		doc.supplier_name = name
		doc.supplier_group = _supplier_group()
		doc.supplier_type = "Company"
	rep_name, rep_phone, rep_email = spec["rep"]
	values = {
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
	doc.update({k: v for k, v in values.items() if doc.meta.has_field(k)})
	doc.disabled = 0
	doc.flags.ignore_permissions = True
	doc.save()
	ensure_price_list(doc.name)
	_ensure_address(doc.name, spec["address"])
	return doc.name


def _ensure_address(supplier: str, a: dict[str, str]) -> None:
	if frappe.db.exists("Address", {"address_title": supplier, "address_type": "Billing"}):
		return
	doc = frappe.get_doc(
		{
			"doctype": "Address",
			"address_title": supplier,
			"address_type": "Billing",
			"address_line1": a["line1"],
			"city": a["city"],
			"state": a["state"],
			"pincode": a["pincode"],
			"country": "United States",
			"phone": a.get("phone"),
			"fax": a.get("fax"),
			"is_primary_address": 1,
			"links": [{"link_doctype": "Supplier", "link_name": supplier}],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_if_duplicate=True)


def ensure_item_vendors(supplier: str) -> int:
	"""One ``AWANZ Item Vendor`` row per catalogue item at the invoice cost, preferred."""
	from maison_pos.setup.scentsofarabia import catalog

	n = 0
	for spec in catalog.ITEMS:
		code = spec["code"]
		if spec["group"] == "Services" or not frappe.db.exists("Item", code):
			continue
		item = frappe.get_doc("Item", code)
		row = next((r for r in item.get("maison_vendors") or [] if r.supplier == supplier), None)
		want = {"supplier": supplier, "cost": flt(spec["cost"]), "case_pack": 1, "moq": 1, "lead_time_days": VENDOR["lead_time_days"], "vendor_sku": spec.get("barcode") or code, "is_preferred": 1}
		if row is None:
			row = item.append("maison_vendors", {})
			changed = True
		else:
			changed = any(row.get(k) != v for k, v in want.items())
		if changed:
			for k, v in want.items():
				row.set(k, v)
			item._awanz_preferred_supplier = supplier
			item.flags.ignore_permissions = True
			item.save()
			n += 1
	return n


def _received_invoices() -> set[str]:
	rows = frappe.get_all("Purchase Order", filters={"company": COMPANY, "docstatus": 1, "maison_vendor_invoice_no": ("!=", "")}, pluck="maison_vendor_invoice_no")
	return {str(r) for r in rows}


def receive_invoice(inv: dict[str, Any], supplier: str, warehouse: str) -> dict[str, Any]:
	"""One vendor invoice → submitted Purchase Order (dated as the paper) → Purchase Receipt at
	HOU-WH on the same date, every line at the invoice cost."""
	from maison_pos.purchasing import orders as po_lib
	from maison_pos.purchasing.receiving import receive_purchase_order

	lines = [{"item_code": c, "qty": q, "rate": r} for c, q, r in inv["lines"]]
	po = po_lib.create_order(supplier, lines, company=COMPANY)
	po.transaction_date = inv["date"]
	po.schedule_date = inv["date"]
	po.set_warehouse = warehouse
	po.maison_vendor_invoice_no = inv["no"]
	for row in po.items:
		row.schedule_date = inv["date"]
		row.warehouse = warehouse
	po.flags.ignore_permissions = True
	po.save()
	po.submit()
	out = receive_purchase_order(
		po.name,
		[{"item_code": c, "qty": q, "rate": r} for c, q, r in inv["lines"]],
		warehouse=warehouse,
		final=1,
		posting_date=inv["date"],
		notes=inv.get("note"),
	)
	if out.get("purchase_receipt"):
		frappe.db.set_value("Purchase Receipt", out["purchase_receipt"], "maison_vendor_invoice_no", inv["no"], update_modified=False)
	free = [_free_receipt(c, q, warehouse, inv) for c, q in inv.get("free") or []]
	return {"invoice": inv["no"], "purchase_order": po.name, "purchase_receipt": out.get("purchase_receipt"), "grand_total": flt(po.grand_total), "free": [f for f in free if f]}


def _free_receipt(item_code: str, qty: float, warehouse: str, inv: dict[str, Any]) -> str | None:
	"""Units the vendor did not charge for (the 36-vial stands) come in on a zero-value Material
	Receipt — a Purchase Receipt refuses a stock line at rate 0."""
	remark = f"Free of charge with vendor invoice {inv['no']} ({VENDOR['name']})"
	if frappe.db.exists("Stock Entry", {"docstatus": 1, "remarks": remark, "purpose": "Material Receipt"}):
		return None
	se = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"purpose": "Material Receipt",
			"stock_entry_type": "Material Receipt",
			"company": COMPANY,
			"posting_date": inv["date"],
			"posting_time": "12:00:00",
			"set_posting_time": 1,
			"to_warehouse": warehouse,
			"remarks": remark,
			"items": [{"item_code": item_code, "qty": qty, "t_warehouse": warehouse, "basic_rate": 0, "allow_zero_valuation_rate": 1}],
		}
	)
	se.flags.ignore_permissions = True
	se.insert()
	se.submit()
	return se.name


def seed_purchasing() -> dict[str, Any]:
	"""Vendor, catalogue costs, and every invoice not yet received. Idempotent."""
	from maison_pos.setup.scentsofarabia.stores import WAREHOUSE_CODE, warehouse_name

	if not frappe.db.exists("Company", COMPANY):
		return {"skipped": f"company {COMPANY} is not seeded"}
	warehouse = warehouse_name(WAREHOUSE_CODE)
	if not frappe.db.exists("Warehouse", warehouse):
		return {"skipped": f"warehouse {warehouse} is not seeded"}
	check_totals()
	summary: dict[str, Any] = {"warehouse": warehouse}
	supplier = ensure_vendor()
	summary["vendor"] = supplier
	summary["catalogue_rows"] = ensure_item_vendors(supplier)
	done = _received_invoices()
	received = []
	for inv in INVOICES:
		if inv["no"] in done:
			received.append({"invoice": inv["no"], "skipped": "already received"})
			continue
		received.append(receive_invoice(inv, supplier, warehouse))
	summary["invoices"] = received
	return summary
