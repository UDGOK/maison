"""Catalog endpoints: full bootstrap and incremental delta for the offline PWA.

All methods are whitelisted under ``/api/method/maison_pos.api.catalog.*``.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe import _
from frappe.query_builder import DocType
from frappe.query_builder.functions import Sum
from frappe.utils import flt, get_datetime, get_system_timezone, get_url, now_datetime

from maison_pos.brand import get_brand  # v0.6 N
from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import get_pos_settings
from maison_pos.scoping import assert_boutique_access, is_manager_or_above
from maison_pos.utils import parse_datetime

ITEM_FIELDS = [
	"name",
	"item_code",
	"item_name",
	"item_group",
	"description",
	"stock_uom",
	"has_serial_no",
	"image",
	"disabled",
	"is_sales_item",
	"is_stock_item",
	"maison_department",
	"maison_metal",
	"maison_carat",
	"maison_stones",
	"maison_certificate_no",
	"maison_appraisal_value",
	"maison_taxable",
	"maison_barcode",
	# --- v0.6 N — vertical attributes (smoke shop) ---
	"maison_brand",
	"maison_flavor",
	"maison_nicotine_mg",
	"maison_volume_ml",
	"maison_puffs",
	"maison_age_restricted",
	"maison_msrp",
	# --- end v0.6 N ---
	"modified",
]

DEPARTMENTS = ["Timepieces", "High Jewellery", "Bridal", "Accessories", "Services"]
# v0.6 N — smoke-shop vertical departments (Item.maison_department Select gains these options)
SMOKE_SHOP_DEPARTMENTS = ["Vape", "Glass", "Hookah", "Kratom & CBD", "Accessories", "Services"]


def _departments(company: Optional[str] = None) -> list[str]:
	"""v0.6 N — departments actually used by sales items (vertical-neutral), else the legacy list."""
	foreign = _foreign_items(company)
	used: list[str] = []
	for r in frappe.get_all("Item", filters={"is_sales_item": 1, "disabled": 0, "maison_department": ("is", "set")}, fields=["name", "maison_department"]):
		if r.maison_department and r.name not in foreign and r.maison_department not in used:
			used.append(r.maison_department)
	if not used:
		return DEPARTMENTS
	ordered = [d for d in SMOKE_SHOP_DEPARTMENTS + DEPARTMENTS if d in used]
	out: list[str] = []
	for d in ordered + sorted(d for d in used if d not in ordered):
		if d not in out:
			out.append(d)
	return out


def _foreign_items(company: Optional[str]) -> set[str]:
	"""v0.6 N — items that belong to *another* company only (``Item Default`` rows), so two demo
	worlds (CloudChaserz / Maison jewellery) can share one site without mixing catalogues."""
	if not company:
		return set()
	key = f"maison_foreign_items::{company}"
	cached = getattr(frappe.local, key, None)
	if cached is not None:
		return cached
	rows = frappe.get_all("Item Default", fields=["parent", "company"], filters={"parenttype": "Item"})
	mine = {r.parent for r in rows if r.company == company}
	foreign = {r.parent for r in rows if r.company != company and r.parent not in mine}
	setattr(frappe.local, key, foreign)
	return foreign


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _boutique_dict(boutique: str) -> dict[str, Any]:
	doc = frappe.get_cached_doc("Maison Boutique", boutique)
	return {
		"name": doc.name,
		"boutique_code": doc.boutique_code,
		"boutique_name": doc.boutique_name,
		"company": doc.company,
		"warehouse": doc.warehouse,
		"cost_center": doc.cost_center,
		"pos_profile": doc.pos_profile,
		"tax_template": doc.get_tax_template(),
		"address_line": doc.address_line,
		"city": doc.city,
		"phone": doc.phone,
		"email": doc.email,
		"stripe_location_id": doc.stripe_location_id,
		"printer_ip": doc.printer_ip,
		"printer_model": doc.printer_model,
		"show_product_images": int(doc.get("show_product_images") or 0),
		# --- v0.6 N — store reality (custom fields, see setup/install_v06.py) ---
		"boutique_type": doc.get("boutique_type") or "Store",
		"is_warehouse": int(doc.get("is_warehouse") or 0),
		"region": doc.get("region"),
		# v0.6 R — every clock on the till renders in this zone; a store without its own zone falls
		# back to the *site* zone rather than a hard-coded American one.
		"timezone": doc.get("timezone") or get_system_timezone(),
		"hours": _parse_hours(doc.get("hours")),
		"state": doc.get("state"),
		"zip": doc.get("zip"),
		# --- end v0.6 N ---
		"currency": frappe.get_cached_value("Company", doc.company, "default_currency"),
		# v0.4 A — reader registry (Maison Boutique Reader) for the Settings reader picker / print route
		"readers": [
			{
				"name": r.name,
				"label": r.label,
				"stripe_reader_id": r.stripe_reader_id,
				"device_type": r.device_type,
				"has_printer": int(r.get("has_printer") or 0),
				"enabled": int(r.get("enabled") if r.get("enabled") is not None else 1),
				"serial_number": r.get("serial_number"),
			}
			for r in (doc.get("readers") or [])
		],
		"damaged_warehouse": doc.get("damaged_warehouse"),
	}


def _parse_hours(raw: Any) -> Optional[dict[str, str]]:
	"""v0.6 N — ``Maison Boutique.hours`` JSON → dict (None when unset / invalid)."""
	if not raw:
		return None
	if isinstance(raw, dict):
		return raw
	try:
		import json

		value = json.loads(raw)
		return value if isinstance(value, dict) else None
	except Exception:
		return None


def _pos_profile_dict(pos_profile: str) -> dict[str, Any]:
	doc = frappe.get_cached_doc("POS Profile", pos_profile)
	return {
		"name": doc.name,
		"company": doc.company,
		"currency": doc.currency,
		"warehouse": doc.warehouse,
		"selling_price_list": doc.selling_price_list,
		"taxes_and_charges": doc.taxes_and_charges,
		"cost_center": doc.cost_center,
		"customer": doc.customer,
		"write_off_account": doc.write_off_account,
		"payments": [
			{"mode_of_payment": p.mode_of_payment, "default": int(p.default or 0)} for p in doc.payments
		],
	}


def _taxes(template: Optional[str]) -> list[dict[str, Any]]:
	if not template:
		return []
	doc = frappe.get_cached_doc("Sales Taxes and Charges Template", template)
	return [
		{
			"charge_type": t.charge_type,
			"account_head": t.account_head,
			"description": t.description,
			"rate": flt(t.rate),
			"included_in_print_rate": int(t.included_in_print_rate or 0),
		}
		for t in doc.taxes
	]


def _modes_of_payment(pos_profile: dict[str, Any]) -> list[dict[str, Any]]:
	names = [p["mode_of_payment"] for p in pos_profile["payments"]] or ["Cash", "Card"]
	rows = frappe.get_all("Mode of Payment", filters={"name": ("in", names), "enabled": 1}, fields=["name", "type"])
	return [{"name": r.name, "type": r.type} for r in rows]


def _item_groups(company: Optional[str] = None) -> list[str]:
	"""Leaf Item Group names that actually hold sales items (the POS category rail).

	The PWA contract is ``item_groups: string[]``; returning the full ERPNext group list
	(Consumable, Raw Material, ...) as dicts rendered JSON blobs in the rail.
	"""
	foreign = _foreign_items(company)  # v0.6 N
	used = {
		r.item_group
		for r in frappe.get_all("Item", filters={"is_sales_item": 1, "disabled": 0}, fields=["name", "item_group"])
		if r.name not in foreign
	}
	rows = frappe.get_all("Item Group", filters={"is_group": 0, "name": ("in", list(used))}, fields=["name"], order_by="name")
	return [r.name for r in rows]


def absolute_file_url(url: Optional[str]) -> Optional[str]:
	"""Absolute URL for an Item image (``/files/..`` or ``/private/files/..``); ``None`` when unset."""
	if not url:
		return None
	url = str(url).strip()
	if url.startswith(("http://", "https://", "data:")):
		return url
	return get_url(url)


def _items(since: Optional[str] = None, company: Optional[str] = None) -> list[dict[str, Any]]:
	filters: dict[str, Any] = {"is_sales_item": 1}
	if since:
		filters["modified"] = (">=", since)
	else:
		filters["disabled"] = 0
	rows = frappe.get_all("Item", filters=filters, fields=ITEM_FIELDS, order_by="item_name")
	foreign = _foreign_items(company)  # v0.6 N
	rows = [r for r in rows if r["item_code"] not in foreign]
	for r in rows:
		r["image"] = absolute_file_url(r.get("image"))
	return rows


def _barcodes(items: list[dict[str, Any]], serials: dict[str, list[str]]) -> dict[str, str]:
	"""``{code: item_code}`` for every scannable code.

	Sources: ``Item.maison_barcode``, the standard ``Item Barcode`` child table and every
	serial number in *serials* (serial labels are Code-128 of the serial itself, so a scan
	of a serial resolves to ``item_code`` here and to the exact serial via ``serials``).
	"""
	out: dict[str, str] = {}
	codes = [r["item_code"] for r in items]
	for r in items:
		if r.get("maison_barcode"):
			out[str(r["maison_barcode"]).strip()] = r["item_code"]
	if codes:
		for row in frappe.get_all("Item Barcode", filters={"parent": ("in", codes)}, fields=["parent", "barcode"]):
			if row.barcode:
				out.setdefault(str(row.barcode).strip(), row.parent)
	for item_code, serial_list in serials.items():
		for serial in serial_list:
			out.setdefault(serial, item_code)
	return out


def _prices(price_list: str, since: Optional[str] = None) -> dict[str, float]:
	filters: dict[str, Any] = {"price_list": price_list, "selling": 1}
	if since:
		filters["modified"] = (">=", since)
	rows = frappe.get_all("Item Price", filters=filters, fields=["item_code", "price_list_rate"])
	return {r.item_code: flt(r.price_list_rate) for r in rows}


def _pricing_rules(warehouse: str, since: Optional[str] = None) -> list[dict[str, Any]]:
	PR = DocType("Pricing Rule")
	PRI = DocType("Pricing Rule Item Code")
	q = (
		frappe.qb.from_(PR)
		.join(PRI)
		.on(PRI.parent == PR.name)
		.select(PR.name, PRI.item_code, PR.rate, PR.valid_from, PR.valid_upto, PR.disable, PR.priority, PR.modified)
		.where((PR.warehouse == warehouse) & (PR.selling == 1) & (PR.rate_or_discount == "Rate"))
	)
	if since:
		q = q.where(PR.modified >= since)
	else:
		q = q.where(PR.disable == 0)
	return [
		{
			"name": r.name,
			"item_code": r.item_code,
			"rate": flt(r.rate),
			"valid_from": str(r.valid_from) if r.valid_from else None,
			"valid_upto": str(r.valid_upto) if r.valid_upto else None,
			"disabled": int(r.disable or 0),
			"priority": r.priority,
		}
		for r in q.run(as_dict=True)
	]


def _serials(warehouse: str, since: Optional[str] = None) -> dict[str, list[str]]:
	filters: dict[str, Any] = {"warehouse": warehouse, "status": "Active"}
	if since:
		filters["modified"] = (">=", since)
	rows = frappe.get_all("Serial No", filters=filters, fields=["item_code", "name"], order_by="name")
	out: dict[str, list[str]] = {}
	for r in rows:
		out.setdefault(r.item_code, []).append(r.name)
	return out


def _stock(warehouse: str, since: Optional[str] = None) -> dict[str, float]:
	Bin = DocType("Bin")
	q = frappe.qb.from_(Bin).select(Bin.item_code, Sum(Bin.actual_qty).as_("qty")).where(Bin.warehouse == warehouse).groupby(Bin.item_code)
	if since:
		q = q.where(Bin.modified >= since)
	return {r.item_code: flt(r.qty) for r in q.run(as_dict=True)}


def _loyalty_program(company: str) -> Optional[dict[str, Any]]:
	programs = frappe.get_all(
		"Loyalty Program",
		filters={"company": company},
		fields=["name", "loyalty_program_name", "loyalty_program_type", "conversion_factor", "expiry_duration", "auto_opt_in"],
		order_by="auto_opt_in desc, modified desc",
		limit=1,
	)
	if not programs:
		return None
	program = programs[0]
	tiers = frappe.get_all(
		"Loyalty Program Collection",
		filters={"parent": program.name},
		fields=["tier_name", "min_spent", "collection_factor"],
		order_by="min_spent asc",
	)
	program["tiers"] = tiers
	return program


def _deleted_since(doctype: str, since: str) -> list[str]:
	return frappe.get_all(
		"Deleted Document",
		filters={"deleted_doctype": doctype, "creation": (">=", since)},
		pluck="deleted_name",
	)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
@frappe.whitelist()
def _associates(boutique: str) -> list[dict[str, Any]]:
	"""Associates that may unlock the POS at *boutique*.

	No PIN hashes leave the server: the PWA verifies PINs online via
	``maison_associate.verify_pin`` and caches a device-local digest for offline unlock.
	"""
	rows = frappe.get_all(
		"Maison Associate",
		filters={"boutique": boutique, "enabled": 1},
		fields=["name", "user", "full_name", "boutique", "role"],
		order_by="full_name",
	)
	for r in rows:
		r["pin_hash"] = ""
	return rows


@frappe.whitelist()
def bootstrap(boutique: str) -> dict[str, Any]:
	"""Full catalog snapshot for *boutique* (items, prices, overrides, serials, stock, associates)."""
	boutique = assert_boutique_access(boutique)
	b = _boutique_dict(boutique)
	pos_profile = _pos_profile_dict(b["pos_profile"])
	price_list = pos_profile["selling_price_list"] or "Standard Selling"
	version = now_datetime()
	items = _items(company=b["company"])  # v0.6 N: company-scoped
	serials = _serials(b["warehouse"])

	return {
		"boutique": b,
		"associates": _associates(boutique),
		"pos_profile": pos_profile,
		"settings": get_pos_settings(boutique),
		"taxes": _taxes(b["tax_template"]),
		"modes_of_payment": _modes_of_payment(pos_profile),
		"item_groups": _item_groups(b["company"]),
		"departments": _departments(b["company"]),
		"items": items,
		"prices": _prices(price_list),
		"pricing_rules": _pricing_rules(b["warehouse"]),
		"serials": serials,
		"barcodes": _barcodes(items, serials),
		"stock": _stock(b["warehouse"]),
		"loyalty_program": _loyalty_program(b["company"]),
		# --- v0.6 N/Q — brand tokens + fixed reward tiers ---
		"brand": get_brand(),
		"reward_tiers": _reward_tiers(b["company"]),
		# --- end v0.6 N/Q ---
		"version": version.isoformat(),
	}


def _reward_tiers(company: str) -> list[dict[str, Any]]:
	"""v0.6 Q — ``Maison Reward Tier`` rows of the company's program (cheapest first)."""
	if not frappe.db.exists("DocType", "Maison Reward Tier"):
		return []
	from maison_pos.api.rewards import reward_tiers

	try:
		return reward_tiers(company=company)
	except Exception:
		return []


@frappe.whitelist()
def delta(boutique: str, since: str) -> dict[str, Any]:
	"""Rows changed since *since* (ISO timestamp) plus ``deleted`` item codes."""
	if not since:
		frappe.throw(_("'since' is required; call bootstrap for a full snapshot"), frappe.ValidationError)
	boutique = assert_boutique_access(boutique)
	since_dt = parse_datetime(since)
	since_s = get_datetime(since_dt).strftime("%Y-%m-%d %H:%M:%S")
	b = _boutique_dict(boutique)
	pos_profile = _pos_profile_dict(b["pos_profile"])
	price_list = pos_profile["selling_price_list"] or "Standard Selling"
	version = now_datetime()

	# Serial numbers: also report those that left the warehouse / were consumed so the client can drop them.
	sold_serials = frappe.get_all(
		"Serial No",
		filters={"modified": (">=", since_s), "item_code": ("is", "set")},
		or_filters=[["warehouse", "!=", b["warehouse"]], ["status", "!=", "Active"]],
		fields=["item_code", "name"],
	)
	removed: dict[str, list[str]] = {}
	for r in sold_serials:
		removed.setdefault(r.item_code, []).append(r.name)

	items = _items(since_s, company=b["company"])  # v0.6 N
	serials = _serials(b["warehouse"], since_s)

	return {
		"boutique": b,
		"pos_profile": pos_profile,
		"settings": get_pos_settings(boutique),
		"taxes": _taxes(b["tax_template"]),
		"modes_of_payment": _modes_of_payment(pos_profile),
		"item_groups": _item_groups(b["company"]),
		"departments": _departments(b["company"]),
		"items": items,
		"prices": _prices(price_list, since_s),
		"pricing_rules": _pricing_rules(b["warehouse"], since_s),
		"serials": serials,
		"barcodes": _barcodes(items, serials),
		"serials_removed": removed,
		"stock": _stock(b["warehouse"], since_s),
		"loyalty_program": _loyalty_program(b["company"]),
		"deleted": _deleted_since("Item", since_s),
		"since": since_s,
		"version": version.isoformat(),
	}


# ---------------------------------------------------------------------------
# item image upload (Manager+)
# ---------------------------------------------------------------------------
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


@frappe.whitelist(methods=["POST"])
def upload_item_image(item_code: str, file: Any = None) -> dict[str, Any]:
	"""Attach an image to *item_code* and set ``Item.image``. Multipart field ``file``.

	Maison Manager / Head Office / System Manager only. Returns
	``{"item_code", "image", "file_url", "file_name"}`` where ``image`` is absolute.
	"""
	if not is_manager_or_above():
		frappe.throw(_("Only Maison Managers may change product images"), frappe.PermissionError)
	item_code = (item_code or "").strip()
	if not item_code or not frappe.db.exists("Item", item_code):
		frappe.throw(_("Item {0} not found").format(item_code), frappe.DoesNotExistError)

	upload = None
	if getattr(frappe, "request", None) is not None and frappe.request.files:
		upload = frappe.request.files.get("file") or next(iter(frappe.request.files.values()), None)
	if upload is None:
		frappe.throw(_("No file uploaded (multipart field 'file')"), frappe.ValidationError)

	content = upload.stream.read()
	if not content:
		frappe.throw(_("Uploaded file is empty"), frappe.ValidationError)
	if len(content) > MAX_IMAGE_BYTES:
		frappe.throw(_("Image larger than 5 MB"), frappe.ValidationError)

	import mimetypes

	content_type = (upload.content_type or "").split(";")[0].strip().lower() or (mimetypes.guess_type(upload.filename or "")[0] or "")
	if content_type not in IMAGE_TYPES:
		frappe.throw(_("Only JPEG, PNG or WebP images are accepted"), frappe.ValidationError)

	safe_code = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in item_code)
	file_name = f"{safe_code}-{frappe.generate_hash(length=6)}{IMAGE_TYPES[content_type]}"
	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": file_name,
			"attached_to_doctype": "Item",
			"attached_to_name": item_code,
			"attached_to_field": "image",
			"is_private": 0,
			"content": content,
		}
	)
	file_doc.flags.ignore_permissions = True
	file_doc.save()

	frappe.db.set_value("Item", item_code, "image", file_doc.file_url)
	frappe.clear_document_cache("Item", item_code)
	return {
		"item_code": item_code,
		"image": absolute_file_url(file_doc.file_url),
		"file_url": file_doc.file_url,
		"file_name": file_doc.file_name,
	}
