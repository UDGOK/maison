"""Demo data seed — ``bench --site maison.localhost execute maison_pos.setup.demo.seed``.

Creates (idempotently) the company "Maison", three boutiques with their
warehouse / cost center / POS profile / tax template, item groups, ~40 luxury
items (some serialized) with prices and opening stock, 20 customers, the
"Maison Collectors" loyalty program, Cash/Card modes of payment, and demo
users + associates with PINs.

Demo logins (password ``maison123``):

    hq@maison.example            Maison Head Office
    regional@maison.example      Maison Regional
    <code>.manager@maison.example   Maison Manager     PIN 1234
    <code>.a1@maison.example        Maison Associate   PIN 2580
    <code>.a2@maison.example        Maison Associate   PIN 1357
"""

from __future__ import annotations

import random
from typing import Any, Optional

import frappe
from frappe.utils import add_days, flt, nowdate

from maison_pos.setup.install import after_install

COMPANY = "Maison"
ABBR = "MSN"
CURRENCY = "USD"
COUNTRY = "United States"
PRICE_LIST = "Standard Selling"
DEMO_PASSWORD = "maison123"
WALK_IN = "Walk-in Client"

BOUTIQUES: list[dict[str, Any]] = [
	{
		"code": "NYC-5AV",
		"name": "Maison Fifth Avenue",
		"address_line": "745 Fifth Avenue",
		"city": "New York, NY 10151",
		"phone": "+1 212 555 0140",
		"email": "fifthavenue@maison.example",
		"tax_title": "NY Sales Tax",
		"tax_rate": 8.875,
		"printer_ip": "10.10.1.50",
	},
	{
		"code": "CHI-OAK",
		"name": "Maison Oak Street",
		"address_line": "106 East Oak Street",
		"city": "Chicago, IL 60611",
		"phone": "+1 312 555 0172",
		"email": "oakstreet@maison.example",
		"tax_title": "IL Sales Tax",
		"tax_rate": 10.25,
		"printer_ip": "10.10.2.50",
	},
	{
		"code": "MIA-DD",
		"name": "Maison Design District",
		"address_line": "140 NE 39th Street",
		"city": "Miami, FL 33137",
		"phone": "+1 305 555 0199",
		"email": "designdistrict@maison.example",
		"tax_title": "FL Sales Tax",
		"tax_rate": 7.0,
		"printer_ip": "10.10.3.50",
	},
]

ITEM_GROUPS = ["Timepieces", "High Jewellery", "Bridal", "Accessories", "Services"]

# (item_code, item_name, group, department, metal, carat, stones, rate, serialized, stock_qty)
ITEMS: list[tuple] = [
	# Timepieces (serialized)
	("TP-001", "Meridian Automatic 40mm Steel", "Timepieces", "Timepieces", "Steel", 0, "", 6_900, True, 3),
	("TP-002", "Meridian Automatic 40mm Rose Gold", "Timepieces", "Timepieces", "18k Rose Gold", 0, "", 24_500, True, 2),
	("TP-003", "Nocturne Moonphase 38mm", "Timepieces", "Timepieces", "18k White Gold", 0, "", 38_000, True, 2),
	("TP-004", "Nocturne Moonphase Diamond Bezel", "Timepieces", "Timepieces", "Platinum", 2.10, "Diamond bezel, 48 brilliants", 92_000, True, 1),
	("TP-005", "Corsaire Chronograph Titanium", "Timepieces", "Timepieces", "Titanium", 0, "", 12_800, True, 3),
	("TP-006", "Corsaire Chronograph Steel Blue", "Timepieces", "Timepieces", "Steel", 0, "", 9_400, True, 3),
	("TP-007", "Atelier Tourbillon Platinum", "Timepieces", "Timepieces", "Platinum", 0, "", 185_000, True, 1),
	("TP-008", "Petite Lune 28mm Yellow Gold", "Timepieces", "Timepieces", "18k Yellow Gold", 0.45, "Diamond-set dial", 17_900, True, 2),
	# High Jewellery (serialized one-offs)
	("HJ-001", "Cascade Diamond Riviere Necklace", "High Jewellery", "High Jewellery", "Platinum", 18.40, "Diamonds D-F VVS", 245_000, True, 1),
	("HJ-002", "Solstice Emerald Pendant", "High Jewellery", "High Jewellery", "18k Yellow Gold", 4.12, "Colombian emerald, diamonds", 68_000, True, 1),
	("HJ-003", "Aurore Sapphire Drop Earrings", "High Jewellery", "High Jewellery", "Platinum", 6.80, "Ceylon sapphires, diamonds", 112_000, True, 1),
	("HJ-004", "Nocturne Ruby Cocktail Ring", "High Jewellery", "High Jewellery", "18k Rose Gold", 3.25, "Burmese ruby, diamonds", 84_000, True, 1),
	("HJ-005", "Lumiere Diamond Tennis Bracelet", "High Jewellery", "High Jewellery", "18k White Gold", 7.50, "Diamonds F-G VS", 42_000, True, 2),
	("HJ-006", "Ondine Pearl and Diamond Collar", "High Jewellery", "High Jewellery", "18k White Gold", 2.90, "South Sea pearls, diamonds", 56_000, True, 1),
	("HJ-007", "Etoile Diamond Cluster Brooch", "High Jewellery", "High Jewellery", "Platinum", 5.10, "Diamonds", 39_500, True, 1),
	("HJ-008", "Verdant Tsavorite Line Bracelet", "High Jewellery", "High Jewellery", "18k Yellow Gold", 9.20, "Tsavorite garnets", 28_000, True, 1),
	# Bridal (mix)
	("BR-001", "Eternal Solitaire 1.0ct Platinum", "Bridal", "Bridal", "Platinum", 1.02, "Round brilliant G VS1", 14_500, True, 2),
	("BR-002", "Eternal Solitaire 1.5ct Platinum", "Bridal", "Bridal", "Platinum", 1.51, "Round brilliant F VS1", 26_800, True, 2),
	("BR-003", "Eternal Solitaire 2.0ct Platinum", "Bridal", "Bridal", "Platinum", 2.03, "Round brilliant E VVS2", 58_000, True, 1),
	("BR-004", "Halo Cushion 1.2ct Rose Gold", "Bridal", "Bridal", "18k Rose Gold", 1.48, "Cushion G VS2, halo", 19_800, True, 2),
	("BR-005", "Trinity Three-Stone Oval", "Bridal", "Bridal", "Platinum", 1.90, "Oval + pear sides", 32_500, True, 1),
	("BR-006", "Classic Wedding Band 2mm Platinum", "Bridal", "Bridal", "Platinum", 0, "", 1_950, False, 12),
	("BR-007", "Classic Wedding Band 4mm Yellow Gold", "Bridal", "Bridal", "18k Yellow Gold", 0, "", 1_650, False, 12),
	("BR-008", "Half Eternity Band 0.5ct", "Bridal", "Bridal", "Platinum", 0.50, "Diamonds", 4_800, False, 8),
	("BR-009", "Full Eternity Band 1.5ct", "Bridal", "Bridal", "Platinum", 1.50, "Diamonds", 11_200, False, 4),
	# Accessories (qty)
	("AC-001", "Signature Gold Chain 45cm", "Accessories", "Accessories", "18k Yellow Gold", 0, "", 2_400, False, 15),
	("AC-002", "Signature Gold Chain 60cm", "Accessories", "Accessories", "18k Yellow Gold", 0, "", 3_100, False, 10),
	("AC-003", "Monogram Pendant Small", "Accessories", "Accessories", "18k Rose Gold", 0, "", 1_850, False, 20),
	("AC-004", "Monogram Pendant Pave", "Accessories", "Accessories", "18k White Gold", 0.35, "Diamond pave", 4_200, False, 10),
	("AC-005", "Diamond Stud Earrings 0.5ct", "Accessories", "Accessories", "18k White Gold", 0.50, "Diamonds G VS", 3_600, False, 12),
	("AC-006", "Diamond Stud Earrings 1.0ct", "Accessories", "Accessories", "Platinum", 1.00, "Diamonds F VS", 8_900, False, 8),
	("AC-007", "Pearl Strand 18 inch Akoya", "Accessories", "Accessories", "18k Yellow Gold", 0, "Akoya pearls 7-7.5mm", 5_400, False, 6),
	("AC-008", "Cuff Bracelet Hammered Silver", "Accessories", "Accessories", "Sterling Silver", 0, "", 690, False, 25),
	("AC-009", "Cufflinks Onyx and Gold", "Accessories", "Accessories", "18k Yellow Gold", 0, "Onyx", 1_450, False, 15),
	("AC-010", "Leather Watch Strap Alligator", "Accessories", "Accessories", "", 0, "", 420, False, 30),
	("AC-011", "Travel Jewellery Case", "Accessories", "Accessories", "", 0, "", 380, False, 30),
	("AC-012", "Silk Pocket Square", "Accessories", "Accessories", "", 0, "", 160, False, 40),
	# Services (non-stock)
	("SV-001", "Ring Resizing", "Services", "Services", "", 0, "", 150, False, 0),
	("SV-002", "Engraving", "Services", "Services", "", 0, "", 95, False, 0),
	("SV-003", "Watch Service Complete", "Services", "Services", "", 0, "", 850, False, 0),
	("SV-004", "Rhodium Replating", "Services", "Services", "", 0, "", 120, False, 0),
	("SV-005", "Appraisal Certificate", "Services", "Services", "", 0, "", 250, False, 0),
]

CUSTOMERS: list[tuple[str, str, str]] = [
	("Isabella Marchetti", "+1 212 555 0101", "isabella.marchetti@example.com"),
	("Jonathan Whitfield", "+1 212 555 0102", "j.whitfield@example.com"),
	("Amara Okonkwo", "+1 917 555 0103", "amara.okonkwo@example.com"),
	("Sebastian Laurent", "+1 646 555 0104", "s.laurent@example.com"),
	("Mei-Lin Chen", "+1 312 555 0105", "meilin.chen@example.com"),
	("Alexander Petrov", "+1 312 555 0106", "a.petrov@example.com"),
	("Charlotte Beaumont", "+1 773 555 0107", "c.beaumont@example.com"),
	("Rafael Oliveira", "+1 305 555 0108", "rafael.oliveira@example.com"),
	("Sofia Andersson", "+1 305 555 0109", "sofia.andersson@example.com"),
	("Daniel Goldberg", "+1 786 555 0110", "d.goldberg@example.com"),
	("Priya Raghavan", "+1 212 555 0111", "priya.r@example.com"),
	("Lucas Dubois", "+1 917 555 0112", "lucas.dubois@example.com"),
	("Hannah Rosenthal", "+1 312 555 0113", "hannah.rosenthal@example.com"),
	("Omar Al-Farsi", "+1 305 555 0114", "omar.alfarsi@example.com"),
	("Victoria Sterling", "+1 646 555 0115", "v.sterling@example.com"),
	("Kenji Nakamura", "+1 312 555 0116", "kenji.nakamura@example.com"),
	("Gabriela Santos", "+1 786 555 0117", "gabriela.santos@example.com"),
	("William Ashcroft", "+1 212 555 0118", "w.ashcroft@example.com"),
	("Elena Volkova", "+1 773 555 0119", "elena.volkova@example.com"),
	("Marcus Thompson", "+1 305 555 0120", "marcus.thompson@example.com"),
]

LOYALTY_PROGRAM = "Maison Collectors"
LOYALTY_TIERS = [("Collector", 0, 1.0), ("Connoisseur", 50_000, 1.5), ("Patron", 250_000, 2.0)]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _exists(doctype: str, name: str) -> bool:
	return bool(frappe.db.exists(doctype, name))


def _insert(doc: dict[str, Any]):
	d = frappe.get_doc(doc)
	d.flags.ignore_permissions = True
	d.insert(ignore_if_duplicate=True)
	return d


def _account(name: str) -> str:
	return f"{name} - {ABBR}"


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------
def ensure_erpnext_setup() -> None:
	"""Run the ERPNext setup wizard headlessly on a fresh site.

	``bench new-site`` + ``install-app erpnext`` leaves the site without the
	setup-wizard fixtures (Warehouse Types, UOMs, Item Groups, Customer Groups,
	Territories, Fiscal Year ...). When no Company exists yet we run the ERPNext
	setup stages with the Maison company details, then flag the wizard complete
	so the desk does not redirect to it.
	"""
	if frappe.db.sql("select name from tabCompany limit 1"):
		return

	from erpnext.setup.setup_wizard.setup_wizard import setup_complete as erpnext_setup_complete
	from frappe.utils import getdate

	today = getdate(nowdate())
	args = frappe._dict(
		{
			"language": "English",
			"country": COUNTRY,
			"currency": CURRENCY,
			"timezone": "America/New_York",
			"time_zone": "America/New_York",
			"company_name": COMPANY,
			"company_abbr": ABBR,
			"chart_of_accounts": "Standard",
			"fy_start_date": f"{today.year}-01-01",
			"fy_end_date": f"{today.year}-12-31",
			"full_name": "Administrator",
			"email": "admin@maison.example",
			"bank_account": "Main Bank",
			"setup_demo": 0,
		}
	)
	frappe.flags.in_setup_wizard = True
	try:
		erpnext_setup_complete(args)
	finally:
		frappe.flags.in_setup_wizard = False

	for app in ("frappe", "erpnext", "maison_pos"):
		if frappe.db.exists("Installed Application", {"app_name": app}):
			frappe.db.set_value("Installed Application", {"app_name": app}, "is_setup_complete", 1)
	frappe.db.set_single_value("System Settings", "setup_complete", 1)
	frappe.db.set_single_value("System Settings", "country", COUNTRY)
	frappe.db.set_single_value("System Settings", "currency", CURRENCY)
	frappe.clear_cache()


def ensure_company() -> str:
	if not _exists("Company", COMPANY):
		_insert(
			{
				"doctype": "Company",
				"company_name": COMPANY,
				"abbr": ABBR,
				"default_currency": CURRENCY,
				"country": COUNTRY,
				"chart_of_accounts": "Standard",
				"enable_perpetual_inventory": 1,
			}
		)
	company = frappe.get_doc("Company", COMPANY)
	if not company.stock_adjustment_account or not company.default_cash_account or not company.default_income_account:
		# headless setup leaves the default ledgers empty; map them from the standard chart
		company.update_default_account = 1
		company.set_default_accounts()
		company.reload()
	changed = False
	if not company.write_off_account and _exists("Account", _account("Write Off")):
		company.write_off_account = _account("Write Off")
		changed = True
	if not company.default_cash_account and _exists("Account", _account("Cash")):
		company.default_cash_account = _account("Cash")
		changed = True
	if changed:
		company.flags.ignore_permissions = True
		company.save()
	frappe.defaults.set_global_default("company", COMPANY)
	frappe.defaults.set_global_default("currency", CURRENCY)
	return COMPANY


def ensure_accounts() -> dict[str, str]:
	"""Sales tax liability, card clearing and loyalty expense ledgers."""
	defs = [
		("Sales Tax", "Duties and Taxes", "Tax"),
		("Card Clearing", "Bank Accounts", "Bank"),
		("Loyalty Redemption", "Indirect Expenses", ""),
	]
	out = {}
	for name, parent, acc_type in defs:
		acc = _account(name)
		if not _exists("Account", acc):
			_insert(
				{
					"doctype": "Account",
					"account_name": name,
					"parent_account": _account(parent),
					"company": COMPANY,
					"account_type": acc_type or None,
					"is_group": 0,
				}
			)
		out[name] = acc
	return out


def ensure_modes_of_payment(accounts: dict[str, str]) -> None:
	mapping = {"Cash": _account("Cash"), "Card": accounts["Card Clearing"]}
	for mop, account in mapping.items():
		doc = frappe.get_doc("Mode of Payment", mop)
		if not any(r.company == COMPANY for r in doc.accounts):
			doc.append("accounts", {"company": COMPANY, "default_account": account})
			doc.flags.ignore_permissions = True
			doc.save()


def ensure_price_list() -> None:
	if not _exists("Price List", PRICE_LIST):
		_insert({"doctype": "Price List", "price_list_name": PRICE_LIST, "selling": 1, "currency": CURRENCY, "enabled": 1})


def ensure_item_groups() -> None:
	root = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ("in", ("", None))}, "name") or "All Item Groups"
	for g in ITEM_GROUPS:
		if not _exists("Item Group", g):
			_insert({"doctype": "Item Group", "item_group_name": g, "parent_item_group": root, "is_group": 0})


def ensure_walk_in_customer() -> str:
	return ensure_customer(WALK_IN, None, None, loyalty=False)


def ensure_customer(name: str, mobile: Optional[str], email: Optional[str], loyalty: bool = True) -> str:
	existing = frappe.db.get_value("Customer", {"customer_name": name}, "name")
	if existing:
		return existing
	doc = _insert(
		{
			"doctype": "Customer",
			"customer_name": name,
			"customer_type": "Individual",
			"customer_group": "Individual" if _exists("Customer Group", "Individual") else frappe.db.get_value("Customer Group", {"is_group": 0}, "name"),
			"territory": frappe.db.get_value("Territory", {"is_group": 0}, "name") or "All Territories",
			"mobile_no": mobile,
			"email_id": email,
			"loyalty_program": LOYALTY_PROGRAM if loyalty and _exists("Loyalty Program", LOYALTY_PROGRAM) else None,
		}
	)
	return doc.name


def ensure_loyalty_program(accounts: dict[str, str]) -> str:
	if _exists("Loyalty Program", LOYALTY_PROGRAM):
		return LOYALTY_PROGRAM
	_insert(
		{
			"doctype": "Loyalty Program",
			"loyalty_program_name": LOYALTY_PROGRAM,
			"loyalty_program_type": "Multiple Tier Program",
			"company": COMPANY,
			"from_date": add_days(nowdate(), -365),
			"conversion_factor": 1.0,  # 1 point = 1 USD on redemption
			"expiry_duration": 730,
			"expense_account": accounts["Loyalty Redemption"],
			"cost_center": _account("Main"),
			"auto_opt_in": 1,
			"customer_group": frappe.db.get_value("Customer Group", {"is_group": 1, "parent_customer_group": ("in", ("", None))}, "name"),
			"customer_territory": frappe.db.get_value("Territory", {"is_group": 1, "parent_territory": ("in", ("", None))}, "name"),
			"collection_rules": [
				{"tier_name": t, "min_spent": m, "collection_factor": f} for t, m, f in LOYALTY_TIERS
			],
		}
	)
	return LOYALTY_PROGRAM


def ensure_tax_template(title: str, rate: float, tax_account: str) -> str:
	name = frappe.db.get_value("Sales Taxes and Charges Template", {"title": title, "company": COMPANY}, "name")
	if name:
		return name
	doc = _insert(
		{
			"doctype": "Sales Taxes and Charges Template",
			"title": title,
			"company": COMPANY,
			"taxes": [
				{
					"charge_type": "On Net Total",
					"account_head": tax_account,
					"description": f"{title} {rate:g}%",
					"rate": rate,
					"cost_center": _account("Main"),
				}
			],
		}
	)
	return doc.name


def ensure_boutique(spec: dict[str, Any], accounts: dict[str, str], walk_in: str) -> str:
	code = spec["code"]
	warehouse = f"{code} - {ABBR}"
	if not _exists("Warehouse", warehouse):
		_insert({"doctype": "Warehouse", "warehouse_name": code, "company": COMPANY, "parent_warehouse": _account("All Warehouses")})
	cost_center = f"{code} - {ABBR}"
	if not _exists("Cost Center", cost_center):
		_insert({"doctype": "Cost Center", "cost_center_name": code, "company": COMPANY, "parent_cost_center": _account(COMPANY), "is_group": 0})
	tax_template = ensure_tax_template(spec["tax_title"], spec["tax_rate"], accounts["Sales Tax"])

	pos_profile = f"{code} POS"
	if not _exists("POS Profile", pos_profile):
		doc = frappe.get_doc(
			{
				"doctype": "POS Profile",
				"name": pos_profile,
				"company": COMPANY,
				"customer": walk_in,
				"warehouse": warehouse,
				"cost_center": cost_center,
				"currency": CURRENCY,
				"selling_price_list": PRICE_LIST,
				"taxes_and_charges": tax_template,
				"write_off_account": _account("Write Off"),
				"write_off_cost_center": cost_center,
				"account_for_change_amount": _account("Cash"),
				"update_stock": 1,
				"payments": [
					{"mode_of_payment": "Card", "default": 1},
					{"mode_of_payment": "Cash", "default": 0},
				],
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert(ignore_if_duplicate=True)
		pos_profile = doc.name

	if not _exists("Maison Boutique", code):
		_insert(
			{
				"doctype": "Maison Boutique",
				"boutique_code": code,
				"boutique_name": spec["name"],
				"company": COMPANY,
				"warehouse": warehouse,
				"cost_center": cost_center,
				"pos_profile": pos_profile,
				"tax_template": tax_template,
				"address_line": spec["address_line"],
				"city": spec["city"],
				"phone": spec["phone"],
				"email": spec["email"],
				"printer_ip": spec.get("printer_ip"),
				"printer_model": "TM-m30III",
				"enabled": 1,
			}
		)
	return code


def ensure_items() -> None:
	for code, name, group, dept, metal, carat, stones, rate, serialized, _qty in ITEMS:
		if not _exists("Item", code):
			is_stock = group != "Services"
			_insert(
				{
					"doctype": "Item",
					"item_code": code,
					"item_name": name,
					"item_group": group,
					"stock_uom": "Nos",
					"is_stock_item": 1 if is_stock else 0,
					"is_sales_item": 1,
					"has_serial_no": 1 if serialized else 0,
					"include_item_in_manufacturing": 0,
					"description": name,
					"standard_rate": rate,
					"valuation_rate": round(rate * 0.45, 2) if is_stock else 0,
					"maison_department": dept,
					"maison_metal": metal or None,
					"maison_carat": carat or 0,
					"maison_stones": stones or None,
					"maison_certificate_no": f"GIA-{random.randint(1_000_000, 9_999_999)}" if carat else None,
					"maison_appraisal_value": round(rate * 1.25, 2) if carat else 0,
					"maison_taxable": 1,
					"maison_image_url": f"/assets/maison_pos/pos/img/{code}.jpg",
					"item_defaults": [{"company": COMPANY, "default_warehouse": f"{BOUTIQUES[0]['code']} - {ABBR}"}],
				}
			)
		if not frappe.db.exists("Item Price", {"item_code": code, "price_list": PRICE_LIST, "selling": 1}):
			_insert({"doctype": "Item Price", "item_code": code, "price_list": PRICE_LIST, "price_list_rate": rate, "selling": 1, "currency": CURRENCY})


def _serials_for(code: str, boutique: str, n: int) -> list[str]:
	short = boutique.split("-")[0]
	return [f"{code}-{short}-{i:03d}" for i in range(1, n + 1)]


def ensure_stock() -> None:
	"""Opening stock per boutique via Material Receipt (skipped when the bin already holds qty)."""
	for spec in BOUTIQUES:
		warehouse = f"{spec['code']} - {ABBR}"
		rows = []
		for code, _name, group, _d, _m, _c, _s, rate, serialized, qty in ITEMS:
			if group == "Services" or qty <= 0:
				continue
			if flt(frappe.db.get_value("Bin", {"item_code": code, "warehouse": warehouse}, "actual_qty")) > 0:
				continue
			row: dict[str, Any] = {
				"item_code": code,
				"qty": qty,
				"t_warehouse": warehouse,
				"basic_rate": round(rate * 0.45, 2),
				"allow_zero_valuation_rate": 0,
			}
			if serialized:
				serials = [s for s in _serials_for(code, spec["code"], qty) if not _exists("Serial No", s)]
				if not serials:
					continue
				row["qty"] = len(serials)
				row["use_serial_batch_fields"] = 1
				row["serial_no"] = "\n".join(serials)
			rows.append(row)
		if not rows:
			continue
		se = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"stock_entry_type": "Material Receipt",
				"purpose": "Material Receipt",
				"company": COMPANY,
				"to_warehouse": warehouse,
				"items": rows,
			}
		)
		se.flags.ignore_permissions = True
		se.insert()
		se.submit()


def ensure_customers() -> None:
	for name, mobile, email in CUSTOMERS:
		ensure_customer(name, mobile, email)


def ensure_user(email: str, first: str, last: str, roles: list[str]) -> str:
	if not _exists("User", email):
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": email,
				"first_name": first,
				"last_name": last,
				"send_welcome_email": 0,
				"enabled": 1,
				"new_password": DEMO_PASSWORD,
				"user_type": "System User",
			}
		)
		user.flags.ignore_permissions = True
		user.flags.no_welcome_mail = True
		user.flags.ignore_password_policy = True  # demo password is intentionally simple
		user.insert()
	user = frappe.get_doc("User", email)
	have = {r.role for r in user.roles}
	missing = [r for r in roles if r not in have and _exists("Role", r)]
	if missing:
		for r in missing:
			user.append("roles", {"role": r})
		user.flags.ignore_permissions = True
		user.save()
	return email


def ensure_associate(email: str, boutique: Optional[str], role: str, pin: str) -> str:
	if _exists("Maison Associate", email):
		doc = frappe.get_doc("Maison Associate", email)
		if not doc.pin_hash:
			doc.set_pin(pin)
		return doc.name
	doc = frappe.get_doc({"doctype": "Maison Associate", "user": email, "boutique": boutique, "role": role, "enabled": 1, "pin": pin})
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def ensure_user_permission(user: str, warehouse: str) -> None:
	if not frappe.db.exists("User Permission", {"user": user, "allow": "Warehouse", "for_value": warehouse}):
		_insert({"doctype": "User Permission", "user": user, "allow": "Warehouse", "for_value": warehouse, "apply_to_all_doctypes": 1})


def ensure_users() -> None:
	ensure_user("hq@maison.example", "Helene", "Quarry", ["Maison Head Office", "Sales Manager", "Accounts Manager", "Stock Manager"])
	ensure_associate("hq@maison.example", None, "HeadOffice", "0000")
	ensure_user("regional@maison.example", "Renaud", "Giraud", ["Maison Regional", "Sales Manager"])
	ensure_associate("regional@maison.example", None, "Regional", "0000")

	names = {
		"NYC-5AV": [("Mgr", "Olivia", "Hartmann"), ("A1", "Theo", "Lindqvist"), ("A2", "Nadia", "Rahman")],
		"CHI-OAK": [("Mgr", "Marcus", "Ellery"), ("A1", "Ines", "Calder"), ("A2", "Jonah", "Price")],
		"MIA-DD": [("Mgr", "Valentina", "Cruz"), ("A1", "Andre", "Baptiste"), ("A2", "Lila", "Moreau")],
	}
	for spec in BOUTIQUES:
		code = spec["code"]
		prefix = code.lower().replace("-", ".")
		warehouse = f"{code} - {ABBR}"
		for kind, first, last in names[code]:
			if kind == "Mgr":
				email = f"{prefix}.manager@maison.example"
				ensure_user(email, first, last, ["Maison Manager", "Sales User", "Stock User"])
				ensure_associate(email, code, "Manager", "1234")
			else:
				email = f"{prefix}.{kind.lower()}@maison.example"
				ensure_user(email, first, last, ["Maison Associate", "Sales User"])
				ensure_associate(email, code, "Associate", "2580" if kind == "A1" else "1357")
			ensure_user_permission(email, warehouse)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
@frappe.whitelist()
def seed_remote() -> dict[str, Any]:
	"""Run the demo seed over the API (System Manager only).

	Lets managed hosts such as Frappe Cloud be seeded without shell access:
	POST /api/method/maison_pos.setup.demo.seed_remote
	"""
	if "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may seed demo data", frappe.PermissionError)
	return seed()


def seed(commit: bool = True) -> dict[str, Any]:
	"""Create all demo data. Safe to run repeatedly."""
	random.seed(42)
	frappe.flags.mute_emails = True
	frappe.flags.in_demo_seed = True

	after_install()
	ensure_erpnext_setup()
	ensure_company()
	accounts = ensure_accounts()
	ensure_modes_of_payment(accounts)
	ensure_price_list()
	ensure_item_groups()
	ensure_loyalty_program(accounts)
	walk_in = ensure_walk_in_customer()
	for spec in BOUTIQUES:
		ensure_boutique(spec, accounts, walk_in)
	ensure_items()
	ensure_stock()
	ensure_customers()
	ensure_users()

	if commit:
		frappe.db.commit()

	summary = {
		"company": COMPANY,
		"boutiques": [b["code"] for b in BOUTIQUES],
		"items": frappe.db.count("Item", {"item_code": ("in", [i[0] for i in ITEMS])}),
		"serials": frappe.db.count("Serial No", {"item_code": ("in", [i[0] for i in ITEMS])}),
		"customers": frappe.db.count("Customer", {"customer_name": ("in", [c[0] for c in CUSTOMERS])}),
		"associates": frappe.db.count("Maison Associate"),
		"loyalty_program": LOYALTY_PROGRAM,
		"password": DEMO_PASSWORD,
	}
	print(frappe.as_json(summary))
	return summary
