"""v0.4 G — demo seed for the web shop (called from ``maison_pos.setup.demo.seed``; no-op without ``webshop``).

``bench --site maison.localhost execute maison_pos.setup.demo_v04_webshop.seed_webshop``

Creates, idempotently: Webshop Settings (checkout on, Standard Selling, company AWANZ),
the simulated payment gateway (or Stripe when ``stripe_secret_key`` is in site_config),
published item groups, one Website Item per sellable demo item with a generated visual and
its ``maison_web_mode``, a demo web shopper (``client@maison.example`` → Isabella Marchetti),
two sample click-and-collect orders + one enquiry for the Oak Street POS queue.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe.utils import flt, nowdate

from maison_pos.webshop import core, is_payments_installed, is_webshop_installed
from maison_pos.webshop.art import product_svg
from maison_pos.webshop.setup import SIMULATED_GATEWAY, WEB_MODE_OF_PAYMENT, create_web_mode_of_payment, create_webshop_custom_fields

COMPANY = "AWANZ"
ABBR = "MSN"
PRICE_LIST = "Standard Selling"
WEB_USER = "client@maison.example"
WEB_USER_CUSTOMER = "Isabella Marchetti"
DEMO_PASSWORD = "maison123"
DEMO_NOTE = "[demo web order]"

# item_code prefix -> default web mode (the rules in core.effective_web_mode still apply:
# a serialized one-off is Enquire regardless)
GROUP_MODES = {
	"Timepieces": "Reserve-with-deposit",
	"High Jewellery": "Enquire",
	"Bridal": "Buy",
	"Accessories": "Buy",
	"Services": "Enquire",
}
RESERVE_ITEMS = {"BR-001", "BR-002", "BR-004"}  # serialized solitaires with several units: reserve
FEATURED = ["TP-002", "HJ-001", "BR-002", "AC-006", "TP-003", "HJ-003", "AC-007", "BR-009"]

SHORT_DESCRIPTIONS = {
	"Timepieces": "Swiss automatic movement, sapphire crystal, five-year AWANZ guarantee.",
	"High Jewellery": "A unique piece from the AWANZ atelier, accompanied by its certificate.",
	"Bridal": "Hand-set in the AWANZ workshop. Complimentary resizing and engraving.",
	"Accessories": "Everyday AWANZ signatures, presented in the house case.",
	"Services": "Performed in the boutique by AWANZ artisans.",
}


def _warehouse_root() -> str:
	return frappe.db.get_value("Warehouse", {"company": COMPANY, "is_group": 1, "parent_warehouse": ("in", ("", None))}, "name") or f"All Warehouses - {ABBR}"


# ---------------------------------------------------------------------------
# settings + gateway
# ---------------------------------------------------------------------------
def ensure_payment_gateway() -> Optional[str]:
	"""Payment Gateway Account for web checkout: Stripe when keys are configured, else simulated."""
	if not is_payments_installed():
		return None
	company = COMPANY
	bank_account = frappe.db.get_value("Account", {"account_name": "Card Clearing", "company": company}, "name") or frappe.get_cached_value(
		"Company", company, "default_bank_account"
	)
	if not bank_account:
		return None

	gateway = SIMULATED_GATEWAY
	secret = frappe.conf.get("stripe_secret_key")
	publishable = frappe.conf.get("stripe_publishable_key")
	if secret and publishable:
		if not frappe.db.exists("Stripe Settings", "AWANZ"):
			doc = frappe.get_doc(
				{"doctype": "Stripe Settings", "gateway_name": "AWANZ", "publishable_key": publishable, "secret_key": secret}
			)
			doc.flags.ignore_permissions = True
			doc.insert()
		gateway = "Stripe-AWANZ"
	if not frappe.db.exists("Payment Gateway", gateway):
		frappe.get_doc({"doctype": "Payment Gateway", "gateway": gateway}).insert(ignore_permissions=True)

	account = frappe.db.get_value("Payment Gateway Account", {"payment_gateway": gateway, "company": company}, "name")
	if not account:
		doc = frappe.get_doc(
			{
				"doctype": "Payment Gateway Account",
				"payment_gateway": gateway,
				"payment_account": bank_account,
				"company": company,
				"is_default": 1,
				"payment_channel": "Email",
				"message": "Thank you — complete your AWANZ payment below.",
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert()
		account = doc.name
	return account


def ensure_webshop_settings(gateway_account: Optional[str]) -> None:
	settings = frappe.get_doc("Webshop Settings")
	quotation_series = (frappe.get_meta("Quotation").get_field("naming_series").options or "SAL-QTN-.YYYY.-").split("\n")[0]
	customer_group = "Individual" if frappe.db.exists("Customer Group", "Individual") else frappe.db.get_value("Customer Group", {"is_group": 0}, "name")
	settings.update(
		{
			"enabled": 1,
			"company": COMPANY,
			"price_list": PRICE_LIST,
			"default_customer_group": customer_group,
			"quotation_series": quotation_series,
			"enable_checkout": 1,
			"show_price": 1,
			"show_stock_availability": 1,
			"show_quantity_in_website": 0,
			"allow_items_not_in_stock": 0,
			"show_contact_us_button": 0,
			"enable_wishlist": 0,
			"enable_reviews": 0,
			"enable_recommendations": 0,
			"enable_variants": 0,
			"hide_price_for_guest": 0,
			"products_per_page": 24,
			"payment_success_url": "Orders",
			"save_quotations_as_draft": 0,
			"payment_gateway_account": gateway_account,
		}
	)
	settings.flags.ignore_permissions = True
	settings.save()


def ensure_web_mode_of_payment_account() -> None:
	create_web_mode_of_payment()
	account = frappe.db.get_value("Account", {"account_name": "Card Clearing", "company": COMPANY}, "name")
	if not account:
		return
	doc = frappe.get_doc("Mode of Payment", WEB_MODE_OF_PAYMENT)
	if not any(r.company == COMPANY for r in doc.accounts):
		doc.append("accounts", {"company": COMPANY, "default_account": account})
		doc.flags.ignore_permissions = True
		doc.save()
	# the POS profiles must list the tender for prepaid collections
	for pos_profile in frappe.get_all("POS Profile", filters={"company": COMPANY}, pluck="name"):
		prof = frappe.get_doc("POS Profile", pos_profile)
		if not any(p.mode_of_payment == WEB_MODE_OF_PAYMENT for p in prof.payments):
			prof.append("payments", {"mode_of_payment": WEB_MODE_OF_PAYMENT, "default": 0})
			prof.flags.ignore_permissions = True
			prof.save()


# ---------------------------------------------------------------------------
# catalogue
# ---------------------------------------------------------------------------
def ensure_item_groups_published() -> None:
	for group in ("Timepieces", "High Jewellery", "Bridal", "Accessories"):
		if not frappe.db.exists("Item Group", group):
			continue
		doc = frappe.get_doc("Item Group", group)
		if not doc.show_in_website:
			doc.show_in_website = 1
			doc.flags.ignore_permissions = True
			doc.save()


def _attach_visual(item) -> Optional[str]:
	"""Generated SVG → public File on the Item; returns the file url."""
	file_name = f"awanz-{item.item_code.lower()}.svg"
	existing = frappe.db.get_value("File", {"attached_to_doctype": "Item", "attached_to_name": item.item_code, "file_name": file_name}, "file_url")
	if existing:
		return existing
	svg = product_svg(item.item_code, item.item_name, item.item_group, item.get("maison_metal"), flt(item.get("maison_carat")), item.get("maison_stones"))
	f = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": file_name,
			"attached_to_doctype": "Item",
			"attached_to_name": item.item_code,
			"attached_to_field": "image",
			"is_private": 0,
			"content": svg,
		}
	)
	f.flags.ignore_permissions = True
	f.insert()
	return f.file_url


def ensure_web_modes() -> dict[str, str]:
	"""Item.maison_web_mode per demo item; returns {item_code: mode}."""
	out = {}
	items = frappe.get_all("Item", filters={"item_group": ("in", list(GROUP_MODES))}, fields=["name", "item_group", "has_serial_no", "maison_web_mode"])
	for it in items:
		mode = GROUP_MODES.get(it.item_group, "Buy")
		if it.name in RESERVE_ITEMS:
			mode = "Reserve-with-deposit"
		if it.maison_web_mode != mode:
			frappe.db.set_value("Item", it.name, "maison_web_mode", mode, update_modified=False)
		if not flt(frappe.db.get_value("Item", it.name, "maison_deposit_percent")):
			frappe.db.set_value("Item", it.name, "maison_deposit_percent", 10, update_modified=False)
		out[it.name] = mode
	return out


def ensure_website_items() -> int:
	from webshop.webshop.doctype.website_item.website_item import make_website_item

	root = _warehouse_root()
	count = 0
	items = frappe.get_all(
		"Item",
		filters={"item_group": ("in", ("Timepieces", "High Jewellery", "Bridal", "Accessories")), "disabled": 0},
		fields=["name", "item_code", "item_name", "item_group", "image", "description", "maison_metal", "maison_carat", "maison_stones"],
		order_by="item_code asc",
	)
	for it in items:
		item = frappe.get_doc("Item", it.name)
		image = item.image or _attach_visual(item)
		if image and item.image != image:
			frappe.db.set_value("Item", item.name, "image", image, update_modified=False)
			item.image = image

		name = frappe.db.get_value("Website Item", {"item_code": item.item_code}, "name")
		if not name:
			wi = make_website_item(item.as_dict(), save=False)
			wi.website_warehouse = root
			wi.published = 1
			wi.website_image = image
			wi.short_description = SHORT_DESCRIPTIONS.get(item.item_group, "")
			wi.ranking = (len(FEATURED) - FEATURED.index(item.item_code)) * 10 if item.item_code in FEATURED else 0
			wi.flags.ignore_permissions = True
			wi.insert()
			name = wi.name
		else:
			wi = frappe.get_doc("Website Item", name)
			changed = False
			for field, value in (
				("website_warehouse", root),
				("published", 1),
				("website_image", wi.website_image or image),
				("short_description", wi.short_description or SHORT_DESCRIPTIONS.get(item.item_group, "")),
			):
				if wi.get(field) != value:
					wi.set(field, value)
					changed = True
			if changed:
				wi.flags.ignore_permissions = True
				wi.save()
		count += 1
	return count


# ---------------------------------------------------------------------------
# demo shopper + sample orders
# ---------------------------------------------------------------------------
def ensure_web_user() -> str:
	# v0.8 QA A1 — the shopper's name comes from the Customer this profile links, so the
	# CloudChaserz seed does not sign in as the jewellery tenant's client
	first, _, last = str(WEB_USER_CUSTOMER).partition(" ")
	if not frappe.db.exists("User", WEB_USER):
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": WEB_USER,
				"first_name": first or "Web",
				"last_name": last or "Shopper",
				"send_welcome_email": 0,
				"user_type": "Website User",
				"new_password": DEMO_PASSWORD,
			}
		)
		user.flags.ignore_permissions = True
		user.flags.ignore_password_policy = True
		user.insert()
	# portal users need the Customer role (Item / Quotation read) — same as the ERPNext signup flow
	user = frappe.get_doc("User", WEB_USER)
	if "Customer" not in [r.role for r in user.roles]:
		user.append("roles", {"role": "Customer"})
		user.flags.ignore_permissions = True
		user.save()
	# v0.8 QA A1 — portal sign-up + default role live in the webshop glue now, so a site that
	# never runs a demo seed (and the CloudChaserz one) gets them too
	from maison_pos.webshop.setup import ensure_portal_signup

	ensure_portal_signup()
	if frappe.db.exists("Customer", WEB_USER_CUSTOMER):
		contact = frappe.db.get_value("Contact", {"user": WEB_USER}, "name")
		if not contact:
			contact = frappe.db.get_value(
				"Dynamic Link", {"link_doctype": "Customer", "link_name": WEB_USER_CUSTOMER, "parenttype": "Contact"}, "parent"
			)
			if contact:
				frappe.db.set_value("Contact", contact, "user", WEB_USER, update_modified=False)
			else:
				doc = frappe.get_doc(
					{
						"doctype": "Contact",
						"first_name": first or "Web",
						"last_name": last or "Shopper",
						"user": WEB_USER,
						"email_ids": [{"email_id": WEB_USER, "is_primary": 1}],
						"links": [{"link_doctype": "Customer", "link_name": WEB_USER_CUSTOMER}],
					}
				)
				doc.flags.ignore_permissions = True
				doc.insert()
		# Frappe creates a bare Contact for every new User; webshop resolves the party through the
		# FIRST contact of the user, so every one of them must carry the Customer link
		for name in frappe.get_all("Contact", filters={"user": WEB_USER}, pluck="name"):
			c = frappe.get_doc("Contact", name)
			if not any(l.link_doctype == "Customer" and l.link_name == WEB_USER_CUSTOMER for l in c.links):
				c.append("links", {"link_doctype": "Customer", "link_name": WEB_USER_CUSTOMER})
				c.flags.ignore_permissions = True
				c.save()
		# webshop's portal utils expect the customer's e-mail to be the web user's
		if frappe.db.get_value("Customer", WEB_USER_CUSTOMER, "email_id") != WEB_USER:
			frappe.db.set_value("Customer", WEB_USER_CUSTOMER, "email_id", WEB_USER, update_modified=False)
	return WEB_USER


def _sample_order(customer: str, boutique: str, lines: list[tuple[str, int]], status: str, mode: str = "Buy", note: str = "") -> Optional[str]:
	marker = f"{DEMO_NOTE} {boutique} {status} {mode}"
	existing = frappe.db.get_value("Sales Order", {"maison_web_order": 1, "maison_web_note": marker, "docstatus": 1}, "name")
	if existing:
		return existing
	# prices must exist (ERPNext's before_tests wipes Item Price; a $0 demo order would look broken)
	if any(not flt(frappe.db.get_value("Item Price", {"item_code": code, "price_list": PRICE_LIST}, "price_list_rate")) for code, _ in lines):
		return None
	b = frappe.get_cached_doc("AWANZ Store", boutique)
	so = frappe.new_doc("Sales Order")
	so.update(
		{
			"company": COMPANY,
			"customer": customer,
			"order_type": "Sales",
			"transaction_date": nowdate(),
			"delivery_date": nowdate(),
			"selling_price_list": PRICE_LIST,
			"set_warehouse": b.warehouse,
			"cost_center": b.cost_center,
			"taxes_and_charges": b.get_tax_template(),
			"maison_web_order": 1,
			"maison_boutique": boutique,
			"maison_fulfilment": "Click & Collect",
			"maison_web_mode": mode,
			"maison_web_status": status,
			"maison_web_note": marker,
		}
	)
	for code, qty in lines:
		so.append("items", {"item_code": code, "qty": qty, "warehouse": b.warehouse, "delivery_date": nowdate()})
	if so.taxes_and_charges:
		from erpnext.controllers.accounts_controller import get_taxes_and_charges

		so.set("taxes", get_taxes_and_charges("Sales Taxes and Charges Template", so.taxes_and_charges))
	if mode == "Reserve-with-deposit":
		so.maison_deposit_amount = core.deposit_for(lines[0][0], flt(frappe.db.get_value("Item Price", {"item_code": lines[0][0], "price_list": PRICE_LIST}, "price_list_rate")))
	so.flags.ignore_permissions = True
	so.insert()
	so.submit()
	return so.name


def ensure_sample_orders() -> list[str]:
	out = []
	customers = [c for c in ("Mei-Lin Chen", "Alexander Petrov", "Hannah Rosenthal") if frappe.db.exists("Customer", c)]
	if len(customers) < 3 or not frappe.db.exists("AWANZ Store", "CHI-OAK"):
		return out
	try:
		out.append(_sample_order(customers[0], "CHI-OAK", [("AC-001", 1), ("AC-012", 2)], "New"))
		out.append(_sample_order(customers[1], "CHI-OAK", [("BR-007", 1)], "Ready"))
		out.append(_sample_order(customers[2], "CHI-OAK", [("BR-001", 1)], "New", mode="Reserve-with-deposit"))
	except Exception:  # noqa: BLE001 - sample orders are decoration
		frappe.log_error(frappe.get_traceback(), "awanz demo web orders")
	return [o for o in out if o]


def ensure_sample_enquiry() -> Optional[str]:
	if not frappe.db.exists("Item", "HJ-002") or not frappe.db.exists("AWANZ Store", "CHI-OAK"):
		return None
	existing = frappe.db.get_value("AWANZ Web Enquiry", {"item_code": "HJ-002", "email": "v.sterling@example.com"}, "name")
	if existing:
		return existing
	doc = frappe.get_doc(
		{
			"doctype": "AWANZ Web Enquiry",
			"item_code": "HJ-002",
			"boutique": "CHI-OAK",
			"customer_name": "Victoria Sterling",
			"email": "v.sterling@example.com",
			"phone": "+1 646 555 0115",
			"message": "Could I see the Solstice pendant in the boutique on Saturday? Is a matching ring possible?",
			"customer": "Victoria Sterling" if frappe.db.exists("Customer", "Victoria Sterling") else None,
			"status": "New",
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def ensure_website_home() -> None:
	"""Guests landing on the site root see the storefront (the POS and desk keep their own routes)."""
	ws = frappe.get_doc("Website Settings")
	changed = False
	if ws.home_page != "shop":
		ws.home_page = "shop"
		changed = True
	if ws.app_name != "AWANZ":
		ws.app_name = "AWANZ"
		changed = True
	if changed:
		ws.flags.ignore_permissions = True
		ws.save()


def seed_webshop(commit: bool = False) -> dict[str, Any]:
	"""Idempotent webshop seed. Safe to call when webshop is absent (returns ``{"skipped": True}``)."""
	if not is_webshop_installed():
		return {"skipped": True, "reason": "webshop not installed"}
	if not frappe.db.exists("Company", COMPANY):
		return {"skipped": True, "reason": "run maison_pos.setup.demo.seed first"}

	create_webshop_custom_fields()
	ensure_web_mode_of_payment_account()
	gateway_account = ensure_payment_gateway()
	ensure_webshop_settings(gateway_account)
	ensure_item_groups_published()
	modes = ensure_web_modes()
	published = ensure_website_items()
	ensure_web_user()
	orders = ensure_sample_orders()
	enquiry = ensure_sample_enquiry()
	ensure_website_home()
	frappe.clear_cache(doctype="Webshop Settings")

	if commit:
		frappe.db.commit()
	summary = {
		"published": published,
		"web_modes": {m: sum(1 for v in modes.values() if v == m) for m in set(modes.values())},
		"gateway_account": gateway_account,
		"web_user": WEB_USER,
		"sample_orders": orders,
		"sample_enquiry": enquiry,
	}
	if commit:
		print(frappe.as_json(summary))
	return summary
