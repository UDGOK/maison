"""v1.4 — **Stores from the warehouse desk**: list, add, edit, close and reopen a store without
a shell or the ERPNext desk. Head office / warehouse admin only (``scoping.assert_supply_admin``).

Until now a store was born in a seed (`setup.demo`, `setup.cloudchaserz`, `setup.scentsofarabia`)
or by hand on five desk forms in the right order. What a store *is*, to this platform, is one
``AWANZ Store`` row plus the ERPNext objects behind it — and every one of them is provisioned here,
in that order, from one form:

    Warehouse ``<code> - <abbr>``          stock on hand, fenced by User Permission
    Cost Center ``<code> - <abbr>``        every sale of the store lands on it
    Sales Taxes and Charges Template       the store's combined state + local rate
    POS Profile ``<code> POS``             cloned from the head-office store's, so the payments,
                                            the price list and the change account are the chain's
    AWANZ Store                            the row every screen reads
    ``<code> In Transit`` / ``<code> Damaged`` warehouses (v0.6 / v0.4 rails)

Rules, each one a rule rather than a preference:

* **A store is closed, never deleted.** Sales, receipts and shipments refer to it; a deleted row
  turns every one of those into a dangling name. ``close_store`` refuses while the store still
  holds stock — move it back to the warehouse first — and a closed store drops out of every list,
  the till, the shop's collection points and the wall. ``reopen_store`` brings it back.
* **The code is forever.** It names the warehouse, the cost centre and the POS profile; changing
  it would orphan all three. Everything else on the store is editable.
* **The tax rate is the client's number.** It is written as they typed it and shown back; nothing
  here looks rates up.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt

from maison_pos.scoping import assert_supply_admin

CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{1,11}$")

#: what ``create_store`` / ``update_store`` accept, and the AWANZ Store field each one lands on
EDITABLE = ("boutique_name", "address_line", "city", "state", "zip", "phone", "email", "region", "timezone", "printer_ip", "printer_model", "show_product_images")


def _abbr(company: str) -> str:
	return frappe.get_cached_value("Company", company, "abbr")


def _company() -> str:
	"""The chain's company: the head-office store's, else the first store's, else the default."""
	hq = frappe.db.get_single_value("AWANZ POS Settings", "head_office_boutique") if frappe.db.exists("DocType", "AWANZ POS Settings") else None
	if hq:
		company = frappe.db.get_value("AWANZ Store", hq, "company")
		if company:
			return company
	first = frappe.db.get_value("AWANZ Store", {"enabled": 1}, "company", order_by="creation asc")
	return first or frappe.defaults.get_global_default("company")


def _template_store(company: str) -> Optional[frappe._dict]:
	"""The store whose POS Profile and tax template are cloned for a new one: head office, else
	the oldest enabled store of the company."""
	hq = frappe.db.get_single_value("AWANZ POS Settings", "head_office_boutique")
	if hq and frappe.db.get_value("AWANZ Store", hq, "company") == company:
		return frappe.db.get_value("AWANZ Store", hq, ["name", "pos_profile", "tax_template", "warehouse", "cost_center"], as_dict=True)
	filters = {"company": company, "enabled": 1}
	meta = frappe.get_meta("AWANZ Store")
	if meta.has_field("is_warehouse"):
		filters["is_warehouse"] = 0
	return frappe.db.get_value("AWANZ Store", filters, ["name", "pos_profile", "tax_template", "warehouse", "cost_center"], as_dict=True, order_by="creation asc")


def _parse_hours(raw: Any) -> str:
	"""Opening hours as the store row stores them: a JSON object of ``day → "HH:MM-HH:MM"`` (or
	``"closed"``), with ``default`` for the days not listed."""
	if raw in (None, ""):
		return "{}"
	if isinstance(raw, str):
		try:
			raw = json.loads(raw)
		except Exception:
			frappe.throw(_("Opening hours must be JSON, e.g. {\"default\": \"10:00-21:00\", \"sun\": \"12:00-18:00\"}"), frappe.ValidationError)
	if not isinstance(raw, dict):
		frappe.throw(_("Opening hours must be an object of day → hours"), frappe.ValidationError)
	out: dict[str, str] = {}
	for k, v in raw.items():
		k = str(k).strip().lower()[:7]
		v = str(v or "").strip()
		if not v:
			continue
		if v.lower() != "closed" and not re.match(r"^\d{1,2}:\d{2}-\d{1,2}:\d{2}$", v):
			frappe.throw(_("Hours for {0} must look like 10:00-21:00 or closed").format(k), frappe.ValidationError)
		out[k] = v.lower() if v.lower() == "closed" else v
	return json.dumps(out)


def _rate_of(template: Optional[str]) -> Optional[float]:
	if not template or not frappe.db.exists("Sales Taxes and Charges Template", template):
		return None
	rows = frappe.get_all("Sales Taxes and Charges", filters={"parent": template, "parenttype": "Sales Taxes and Charges Template"}, fields=["rate"])
	return round(sum(flt(r.rate) for r in rows), 3) if rows else 0.0


def _row(store: frappe._dict, with_figures: bool = False) -> dict[str, Any]:
	hours = store.get("hours")
	if isinstance(hours, str):
		try:
			hours = json.loads(hours) if hours else {}
		except Exception:
			hours = {}
	out = {
		"code": store.name,
		"name": store.boutique_name,
		"enabled": cint(store.enabled),
		"is_warehouse": cint(store.get("is_warehouse")) or store.get("boutique_type") == "Warehouse",
		"company": store.company,
		"warehouse": store.warehouse,
		"cost_center": store.cost_center,
		"pos_profile": store.pos_profile,
		"tax_template": store.tax_template,
		"tax_rate": _rate_of(store.tax_template),
		"address_line": store.address_line,
		"city": store.city,
		"state": store.get("state"),
		"zip": store.get("zip"),
		"phone": store.phone,
		"email": store.email,
		"region": store.get("region"),
		"timezone": store.get("timezone"),
		"hours": hours or {},
		"printer_ip": store.printer_ip,
		"printer_model": store.printer_model,
		"show_product_images": cint(store.show_product_images),
		"transit_warehouse": store.get("transit_warehouse"),
		"damaged_warehouse": store.get("damaged_warehouse"),
	}
	if with_figures:
		out["on_hand_units"] = float(frappe.db.sql("select coalesce(sum(actual_qty),0) from tabBin where warehouse=%s", store.warehouse)[0][0] or 0) if store.warehouse else 0.0
		out["staff"] = frappe.db.count("AWANZ Associate", {"boutique": store.name, "enabled": 1}) if frappe.db.exists("DocType", "AWANZ Associate") else 0
		out["open_requests"] = frappe.db.count("AWANZ Replenishment Request", {"boutique": store.name, "status": ("in", ("Pending Approval", "Approved"))}) if frappe.db.exists("DocType", "AWANZ Replenishment Request") else 0
	return out


def _fields() -> list[str]:
	meta = frappe.get_meta("AWANZ Store")
	base = ["name", "boutique_name", "enabled", "company", "warehouse", "cost_center", "pos_profile", "tax_template", "address_line", "city", "phone", "email", "printer_ip", "printer_model", "show_product_images"]
	extra = [f for f in ("is_warehouse", "boutique_type", "region", "hours", "timezone", "state", "zip", "transit_warehouse", "damaged_warehouse") if meta.has_field(f)]
	return base + extra


def _regions() -> list[str]:
	meta = frappe.get_meta("AWANZ Store")
	df = meta.get_field("region")
	opts = [o.strip() for o in (df.options or "").split("\n") if o.strip()] if df else []
	used = [r for r in frappe.get_all("AWANZ Store", distinct=True, pluck="region") if r]
	return sorted(set(opts) | set(used))


def _ensure_region_option(region: str) -> None:
	"""``region`` is a Select on the store form; a region typed on the desk joins its options so
	the desk filter and the form keep agreeing with the API."""
	region = (region or "").strip()
	if not region:
		return
	name = frappe.db.get_value("Custom Field", {"dt": "AWANZ Store", "fieldname": "region"}, "name")
	if not name:
		return
	doc = frappe.get_doc("Custom Field", name)
	if doc.fieldtype != "Select":
		return
	opts = [o for o in (doc.options or "").split("\n")]
	if region in opts:
		return
	doc.options = "\n".join(opts + [region])
	doc.flags.ignore_permissions = True
	doc.save()
	frappe.clear_cache(doctype="AWANZ Store")


# ---------------------------------------------------------------------------
@frappe.whitelist()
def stores(include_closed: int = 1) -> dict[str, Any]:
	"""Every store (the warehouse row too, flagged), with stock, staff and open requests."""
	assert_supply_admin()
	filters: dict[str, Any] = {} if cint(include_closed) else {"enabled": 1}
	rows = frappe.get_all("AWANZ Store", filters=filters, fields=_fields(), order_by="is_warehouse desc, boutique_name asc" if frappe.get_meta("AWANZ Store").has_field("is_warehouse") else "boutique_name asc")
	company = _company()
	template = _template_store(company)
	return {
		"stores": [_row(r, with_figures=True) for r in rows],
		"count": len(rows),
		"company": company,
		"abbr": _abbr(company) if company else None,
		"regions": _regions(),
		"timezone": frappe.db.get_single_value("System Settings", "time_zone") or "America/Chicago",
		"template_store": template.name if template else None,
		"template_tax_rate": _rate_of(template.tax_template) if template else None,
	}


@frappe.whitelist()
def store(code: str) -> dict[str, Any]:
	assert_supply_admin()
	if not frappe.db.exists("AWANZ Store", code):
		frappe.throw(_("Store {0} does not exist").format(code), frappe.DoesNotExistError)
	row = frappe.db.get_value("AWANZ Store", code, _fields(), as_dict=True)
	return _row(row, with_figures=True)


# ---------------------------------------------------------------------------
def _clean(payload: Any) -> dict[str, Any]:
	if isinstance(payload, str):
		payload = frappe.parse_json(payload)
	if not isinstance(payload, dict):
		frappe.throw(_("A store payload is required"), frappe.ValidationError)
	return payload


def _validate_common(p: dict[str, Any]) -> None:
	if not (p.get("boutique_name") or "").strip():
		frappe.throw(_("A store needs a name"), frappe.ValidationError)
	if "tax_rate" in p and p["tax_rate"] not in (None, ""):
		rate = flt(p["tax_rate"])
		if rate < 0 or rate > 30:
			frappe.throw(_("Sales tax rate must be between 0 and 30 %"), frappe.ValidationError)
	email = (p.get("email") or "").strip()
	if email and "@" not in email:
		frappe.throw(_("The store e-mail does not look like an address"), frappe.ValidationError)


def _tax_template(company: str, code: str, title: Optional[str], rate: Optional[float], template_store: Optional[frappe._dict]) -> Optional[str]:
	"""A Sales Taxes and Charges Template at ``rate`` for this store — the account head comes
	from the chain's existing template, so a new store taxes into the same ledger."""
	if rate is None:
		return template_store.tax_template if template_store else None
	title = (title or "").strip() or f"Sales Tax ({code})"
	existing = frappe.db.get_value("Sales Taxes and Charges Template", {"title": title, "company": company}, "name")
	account = None
	cost_center = None
	if template_store and template_store.tax_template and frappe.db.exists("Sales Taxes and Charges Template", template_store.tax_template):
		row = frappe.get_all("Sales Taxes and Charges", filters={"parent": template_store.tax_template}, fields=["account_head", "cost_center"], limit=1)
		if row:
			account, cost_center = row[0].account_head, row[0].cost_center
	if not account:
		account = frappe.db.get_value("Account", {"company": company, "account_type": "Tax", "is_group": 0}, "name")
	if not account:
		frappe.throw(_("No sales-tax ledger found for {0}; create the first store's tax template on the desk").format(company), frappe.ValidationError)
	if existing:
		doc = frappe.get_doc("Sales Taxes and Charges Template", existing)
		if doc.taxes and abs(flt(doc.taxes[0].rate) - flt(rate)) > 0.0005:
			doc.taxes[0].rate = flt(rate)
			doc.taxes[0].description = f"{title} {flt(rate):g}%"
			doc.flags.ignore_permissions = True
			doc.save()
		return doc.name
	doc = frappe.get_doc(
		{
			"doctype": "Sales Taxes and Charges Template",
			"title": title,
			"company": company,
			"taxes": [{"charge_type": "On Net Total", "account_head": account, "description": f"{title} {flt(rate):g}%", "rate": flt(rate), "cost_center": cost_center}],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def _pos_profile(company: str, code: str, warehouse: str, cost_center: str, tax_template: Optional[str], template_store: Optional[frappe._dict]) -> str:
	name = f"{code} POS"
	if frappe.db.exists("POS Profile", name):
		return name
	base = frappe.get_doc("POS Profile", template_store.pos_profile) if template_store and template_store.pos_profile and frappe.db.exists("POS Profile", template_store.pos_profile) else None
	doc = frappe.get_doc(
		{
			"doctype": "POS Profile",
			"name": name,
			"company": company,
			"customer": base.customer if base else frappe.db.get_value("Customer", {"customer_name": "Walk-in Customer"}, "name"),
			"warehouse": warehouse,
			"cost_center": cost_center,
			"currency": base.currency if base else frappe.get_cached_value("Company", company, "default_currency"),
			"selling_price_list": base.selling_price_list if base else frappe.db.get_value("Price List", {"selling": 1, "enabled": 1}, "name"),
			"taxes_and_charges": tax_template,
			"write_off_account": base.write_off_account if base else frappe.get_cached_value("Company", company, "write_off_account"),
			"write_off_cost_center": cost_center,
			"account_for_change_amount": base.account_for_change_amount if base else frappe.get_cached_value("Company", company, "default_cash_account"),
			"update_stock": 1,
			"payments": [{"mode_of_payment": p.mode_of_payment, "default": p.default} for p in base.payments] if base else [{"mode_of_payment": "Card", "default": 1}, {"mode_of_payment": "Cash", "default": 0}],
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_if_duplicate=True)
	return doc.name


@frappe.whitelist()
def create_store(payload: Any) -> dict[str, Any]:
	"""Provision a store from one form. ``payload``: ``code`` (2–12 chars, A–Z 0–9 and dashes),
	``boutique_name``, ``address_line``, ``city``, ``state``, ``zip``, ``phone``, ``email``,
	``region``, ``timezone``, ``tax_rate`` (percent), ``tax_title``, ``hours`` (object)."""
	assert_supply_admin()
	p = _clean(payload)
	code = (p.get("code") or "").strip().upper()
	if not CODE_RE.match(code):
		frappe.throw(_("The store code is 2–12 characters: letters, digits and dashes, e.g. OK-BIX"), frappe.ValidationError)
	if frappe.db.exists("AWANZ Store", code):
		frappe.throw(_("Store {0} already exists").format(code), frappe.DuplicateEntryError)
	_validate_common(p)
	company = _company()
	if not company:
		frappe.throw(_("No company on this site yet"), frappe.ValidationError)
	abbr = _abbr(company)
	template_store = _template_store(company)
	hours = _parse_hours(p.get("hours"))
	tax_rate = flt(p["tax_rate"]) if p.get("tax_rate") not in (None, "") else None

	warehouse = f"{code} - {abbr}"
	if not frappe.db.exists("Warehouse", warehouse):
		wt = frappe.db.get_value("Warehouse Type", "Stores", "name")
		doc = frappe.get_doc({"doctype": "Warehouse", "warehouse_name": code, "company": company, "parent_warehouse": f"All Warehouses - {abbr}", "warehouse_type": wt})
		doc.flags.ignore_permissions = True
		doc.insert()
		warehouse = doc.name
	cost_center = f"{code} - {abbr}"
	if not frappe.db.exists("Cost Center", cost_center):
		parent = frappe.db.get_value("Cost Center", {"company": company, "is_group": 1, "parent_cost_center": ("in", ("", None))}, "name") or f"{company} - {abbr}"
		doc = frappe.get_doc({"doctype": "Cost Center", "cost_center_name": code, "company": company, "parent_cost_center": parent, "is_group": 0})
		doc.flags.ignore_permissions = True
		doc.insert()
		cost_center = doc.name
	tax_template = _tax_template(company, code, p.get("tax_title"), tax_rate, template_store)
	pos_profile = _pos_profile(company, code, warehouse, cost_center, tax_template, template_store)

	_ensure_region_option(p.get("region") or "")
	meta = frappe.get_meta("AWANZ Store")
	values: dict[str, Any] = {
		"doctype": "AWANZ Store",
		"boutique_code": code,
		"boutique_name": p["boutique_name"].strip(),
		"company": company,
		"warehouse": warehouse,
		"cost_center": cost_center,
		"pos_profile": pos_profile,
		"tax_template": tax_template,
		"address_line": (p.get("address_line") or "").strip(),
		"city": (p.get("city") or "").strip(),
		"phone": (p.get("phone") or "").strip(),
		"email": (p.get("email") or "").strip() or None,
		"printer_model": (p.get("printer_model") or "TM-m30III").strip(),
		"printer_ip": (p.get("printer_ip") or "").strip() or None,
		"show_product_images": 1 if p.get("show_product_images", 1) else 0,
		"enabled": 1,
	}
	for k, v in {
		"state": (p.get("state") or "").strip().upper()[:12],
		"zip": (p.get("zip") or "").strip(),
		"region": (p.get("region") or "").strip(),
		"timezone": (p.get("timezone") or "").strip() or (frappe.db.get_single_value("System Settings", "time_zone") or "America/Chicago"),
		"hours": hours,
		"boutique_type": "Store",
		"is_warehouse": 0,
	}.items():
		if meta.has_field(k):
			values[k] = v
	doc = frappe.get_doc(values)
	doc.flags.ignore_permissions = True
	doc.insert()

	created: dict[str, Any] = {"warehouse": warehouse, "cost_center": cost_center, "pos_profile": pos_profile, "tax_template": tax_template}
	try:
		from maison_pos.shipping import ensure_transit_warehouse

		created["transit_warehouse"] = ensure_transit_warehouse(code)
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"awanz store transit {code}")
	try:
		from maison_pos.setup.install_v04_inventory import ensure_damaged_warehouse

		created["damaged_warehouse"] = ensure_damaged_warehouse(code)
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"awanz store damaged {code}")
	frappe.flags.pop("warehouse_account_map", None)
	frappe.clear_cache(doctype="AWANZ Store")
	return {"store": store(code), "created": created}


@frappe.whitelist()
def update_store(code: str, payload: Any) -> dict[str, Any]:
	"""Edit anything but the code. ``tax_rate`` rewrites the store's own tax template (a template
	shared with another store is copied first, so the other store keeps its rate)."""
	assert_supply_admin()
	if not frappe.db.exists("AWANZ Store", code):
		frappe.throw(_("Store {0} does not exist").format(code), frappe.DoesNotExistError)
	p = _clean(payload)
	if "boutique_name" in p:
		_validate_common({**p, "boutique_name": p.get("boutique_name")})
	else:
		_validate_common({**p, "boutique_name": frappe.db.get_value("AWANZ Store", code, "boutique_name")})
	doc = frappe.get_doc("AWANZ Store", code)
	changed: list[str] = []
	for k in EDITABLE:
		if k not in p or not doc.meta.has_field(k):
			continue
		v = p[k]
		if k == "show_product_images":
			v = 1 if v else 0
		elif k == "state":
			v = (v or "").strip().upper()[:12]
		else:
			v = (v or "").strip() if isinstance(v, str) else v
			if v == "" and k in ("email", "printer_ip"):
				v = None
		if doc.get(k) != v:
			if k == "region":
				_ensure_region_option(v or "")
			doc.set(k, v)
			changed.append(k)
	if "hours" in p and doc.meta.has_field("hours"):
		hours = _parse_hours(p["hours"])
		if (doc.get("hours") or "{}") != hours:
			doc.set("hours", hours)
			changed.append("hours")
	if "tax_rate" in p and p["tax_rate"] not in (None, ""):
		rate = flt(p["tax_rate"])
		current = _rate_of(doc.tax_template)
		if current is None or abs(current - rate) > 0.0005:
			shared = doc.tax_template and frappe.db.count("AWANZ Store", {"tax_template": doc.tax_template, "name": ("!=", code)}) > 0
			template_store = frappe._dict(tax_template=doc.tax_template) if doc.tax_template else _template_store(doc.company)
			title = (p.get("tax_title") or "").strip() or (frappe.db.get_value("Sales Taxes and Charges Template", doc.tax_template, "title") if doc.tax_template and not shared else f"Sales Tax ({code})")
			if shared and title == frappe.db.get_value("Sales Taxes and Charges Template", doc.tax_template, "title"):
				title = f"{title} — {code}"
			doc.tax_template = _tax_template(doc.company, code, title, rate, template_store)
			if doc.pos_profile and frappe.db.exists("POS Profile", doc.pos_profile):
				frappe.db.set_value("POS Profile", doc.pos_profile, "taxes_and_charges", doc.tax_template, update_modified=False)
			changed.append("tax_rate")
	if changed:
		doc.flags.ignore_permissions = True
		doc.save()
		frappe.clear_cache(doctype="AWANZ Store")
	return {"store": store(code), "changed": changed}


@frappe.whitelist()
def close_store(code: str, reason: Optional[str] = None) -> dict[str, Any]:
	"""Close a store: it leaves every list, the till, the shop and the wall. Refused while it
	holds stock — send it back to the warehouse first — or while a shipment to it is in transit.
	Nothing is deleted; ``reopen_store`` undoes it."""
	assert_supply_admin()
	if not frappe.db.exists("AWANZ Store", code):
		frappe.throw(_("Store {0} does not exist").format(code), frappe.DoesNotExistError)
	row = frappe.db.get_value("AWANZ Store", code, ["warehouse", "enabled", "boutique_name"], as_dict=True)
	hq = frappe.db.get_single_value("AWANZ POS Settings", "head_office_boutique")
	if hq == code:
		frappe.throw(_("{0} is the head-office store; choose another head office in Settings before closing it").format(code), frappe.ValidationError)
	units = float(frappe.db.sql("select coalesce(sum(actual_qty),0) from tabBin where warehouse=%s and actual_qty > 0", row.warehouse)[0][0] or 0) if row.warehouse else 0.0
	if units > 0:
		frappe.throw(_("{0} still holds {1:g} units — send them back to the warehouse before closing it").format(row.boutique_name, units), frappe.ValidationError)
	if frappe.db.exists("DocType", "AWANZ Shipment") and frappe.db.exists("AWANZ Shipment", {"boutique": code, "status": ("in", ("Pending", "Approved", "Picking", "Packed", "Ready", "Shipped"))}):
		frappe.throw(_("A shipment to {0} is still open — receive or cancel it first").format(row.boutique_name), frappe.ValidationError)
	if not cint(row.enabled):
		return {"store": store(code), "closed": False, "already": True}
	doc = frappe.get_doc("AWANZ Store", code)
	doc.enabled = 0
	doc.flags.ignore_permissions = True
	doc.save()
	if doc.pos_profile and frappe.db.exists("POS Profile", doc.pos_profile):
		frappe.db.set_value("POS Profile", doc.pos_profile, "disabled", 1, update_modified=False)
	doc.add_comment("Comment", _("Closed from the warehouse desk by {0}{1}").format(frappe.session.user, f": {reason.strip()}" if reason and reason.strip() else ""))
	frappe.clear_cache(doctype="AWANZ Store")
	return {"store": store(code), "closed": True}


@frappe.whitelist()
def reopen_store(code: str) -> dict[str, Any]:
	assert_supply_admin()
	if not frappe.db.exists("AWANZ Store", code):
		frappe.throw(_("Store {0} does not exist").format(code), frappe.DoesNotExistError)
	doc = frappe.get_doc("AWANZ Store", code)
	if not cint(doc.enabled):
		doc.enabled = 1
		doc.flags.ignore_permissions = True
		doc.save()
		if doc.pos_profile and frappe.db.exists("POS Profile", doc.pos_profile):
			frappe.db.set_value("POS Profile", doc.pos_profile, "disabled", 0, update_modified=False)
		doc.add_comment("Comment", _("Reopened from the warehouse desk by {0}").format(frappe.session.user))
		frappe.clear_cache(doctype="AWANZ Store")
	return {"store": store(code), "reopened": True}
