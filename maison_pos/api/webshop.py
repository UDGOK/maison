"""Web shop endpoints (``maison_pos.api.webshop.*``) — v0.4 section G.

Three audiences:

* **guest / shopper** (``allow_guest``): boutiques, availability, catalogue, enquiries,
  loyalty lookup by client number + e-mail;
* **signed-in shopper** (a Website User with a Contact → Customer, exactly as webshop
  does it): cart boutique, checkout → Sales Order with ``maison_boutique``, reserve
  with deposit, online payment through the ``payments`` app (or the simulated gateway);
* **boutique staff** (Maison roles, scoped by boutique): the POS "Web orders" queue —
  list, detail, pick / ready / cancel. Collection itself goes through
  ``sales.submit_batch`` with ``sales_order`` on the payload so the Sales Invoice gets the
  same receipt, points and commission as a counter sale.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, get_url, now_datetime, nowdate

from maison_pos.api.catalog import absolute_file_url
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, get_allowed_boutiques, is_unrestricted
from maison_pos.webshop import FULFILMENTS, core, is_payments_installed, is_webshop_installed
from maison_pos.webshop.setup import SIMULATED_GATEWAY


def _require_webshop() -> None:
	if not is_webshop_installed():
		frappe.throw(_("The webshop app is not installed on this site"), frappe.ValidationError)


def _parse(value: Any, default: Any) -> Any:
	if isinstance(value, str):
		try:
			return json.loads(value or "null") or default
		except ValueError:
			return default
	return value if value is not None else default


def _require_login() -> str:
	if frappe.session.user == "Guest":
		frappe.throw(_("Please sign in to continue"), frappe.PermissionError)
	return frappe.session.user


def _party():
	"""webshop's Customer-or-Lead for the signed-in web user."""
	from webshop.webshop.shopping_cart.cart import get_party

	return get_party()


def _customer_for_user(user: Optional[str] = None) -> Optional[str]:
	"""Customer linked to a web user through its Contact (webshop creates this on first cart)."""
	user = user or frappe.session.user
	if not user or user == "Guest":
		return None
	contact = frappe.db.get_value("Contact", {"user": user}, "name")
	if contact:
		customer = frappe.db.get_value(
			"Dynamic Link", {"parent": contact, "parenttype": "Contact", "link_doctype": "Customer"}, "link_name"
		)
		if customer:
			return customer
	email = frappe.db.get_value("User", user, "email") or user
	return frappe.db.get_value("Customer", {"email_id": email, "disabled": 0}, "name")


# ---------------------------------------------------------------------------
# v0.7 S4 — every public endpoint on this module gets a real limit (per client + global
# ceiling). Read-only storefront calls are generous: they must not break a busy shop, only
# stop a scraper. Anything that writes or answers "does this client exist" is strict.
# ---------------------------------------------------------------------------
def _guest_limit(endpoint: str, limit: int, seconds: int = 60) -> None:
	from maison_pos.ratelimit import guard

	guard(endpoint, limit, seconds, global_limit=limit * 30, global_seconds=seconds)


# ---------------------------------------------------------------------------
# guest: catalogue, availability, boutiques
# ---------------------------------------------------------------------------
@frappe.whitelist(allow_guest=True)
def boutiques() -> list[dict[str, Any]]:
	_guest_limit("webshop.boutiques", 120)
	return [
		{k: v for k, v in b.items() if k not in ("warehouse", "company")} for b in core.boutiques()
	]


@frappe.whitelist(allow_guest=True)
def availability(item_code: str) -> dict[str, Any]:
	"""``{item_code, web_mode, available_at, boutiques: [{boutique, boutique_name, city, qty}]}``."""
	_guest_limit("webshop.availability", 120)
	if not frappe.db.exists("Item", item_code):
		frappe.throw(_("Item {0} not found").format(item_code), frappe.DoesNotExistError)
	avail = core.availability(item_code)
	item = frappe.db.get_value(
		"Item", item_code, ["item_code", "has_serial_no", "is_stock_item", "maison_web_mode", "maison_age_restricted"], as_dict=True
	)
	chain = sum(flt(a["qty"]) for a in avail)
	return {
		"item_code": item_code,
		"web_mode": core.effective_web_mode(item, chain),
		"in_store_only": core.is_age_restricted_online_blocked(item),  # v0.6 N
		"chain_qty": chain,
		"available_at": core.city_label(avail),
		"boutiques": [{k: v for k, v in a.items() if k != "serials"} for a in avail],
	}


def _website_items(filters: dict[str, Any], start: int = 0, limit: int = 48, q: Optional[str] = None) -> list[dict[str, Any]]:
	f: list[Any] = [["Website Item", "published", "=", 1]]
	for k, v in filters.items():
		if v:
			f.append(["Website Item", k, "=", v])
	if q:
		f.append(["Website Item", "web_item_name", "like", f"%{q}%"])
	return frappe.get_all(
		"Website Item",
		filters=f,
		fields=["name", "item_code", "web_item_name", "item_group", "route", "website_image", "thumbnail", "short_description", "ranking"],
		order_by="ranking desc, web_item_name asc",
		start=cint(start),
		page_length=cint(limit) or 48,
	)


def _website_items_count(filters: dict[str, Any], q: Optional[str] = None) -> int:
	"""How many published Website Items match *filters* (v0.8 QA A4 — paging)."""
	f: dict[str, Any] = {"published": 1}
	for k, v in filters.items():
		if v:
			f[k] = v
	if q:
		f["web_item_name"] = ("like", f"%{q}%")
	return cint(frappe.db.count("Website Item", f))


@frappe.whitelist(allow_guest=True)
def catalogue(
	item_group: Optional[str] = None,
	department: Optional[str] = None,
	q: Optional[str] = None,
	mode: Optional[str] = None,
	start: int = 0,
	limit: int = 48,
) -> dict[str, Any]:
	"""Published website items with price, image, web mode and availability label (server-rendered listing)."""
	_guest_limit("webshop.catalogue", 120)
	_require_webshop()
	from erpnext.utilities.product import get_price
	from webshop.webshop.doctype.webshop_settings.webshop_settings import get_shopping_cart_settings

	settings = get_shopping_cart_settings()
	start, limit = max(0, cint(start)), max(1, cint(limit) or 48)
	rows = _website_items({"item_group": item_group}, start, limit, q)
	codes = [r.item_code for r in rows]
	items = {
		i.item_code: i
		for i in frappe.get_all(
			"Item",
			filters={"item_code": ("in", codes)} if codes else {"item_code": "__none__"},
			fields=["item_code", "has_serial_no", "is_stock_item", "maison_web_mode", "maison_metal", "maison_carat", "maison_stones", "maison_department", "maison_age_restricted", "maison_brand", "maison_flavor", "maison_nicotine_mg", "maison_puffs", "maison_volume_ml"],  # v0.6 N
		)
	}
	out = []
	for r in rows:
		item = items.get(r.item_code) or {}
		if department and item.get("maison_department") != department:
			continue
		avail = core.availability(r.item_code)
		chain = sum(flt(a["qty"]) for a in avail)
		web_mode = core.effective_web_mode(item, chain)
		if mode and web_mode != mode:
			continue
		price = {}
		if settings.enabled and settings.show_price:
			price = get_price(r.item_code, settings.price_list, settings.default_customer_group, settings.company) or {}
		out.append(
			{
				"name": r.name,
				"item_code": r.item_code,
				"item_name": r.web_item_name,
				"item_group": r.item_group,
				"route": "/" + r.route if r.route and not r.route.startswith("/") else r.route,
				"image": absolute_file_url(r.website_image or r.thumbnail),
				"short_description": r.short_description,
				"metal": item.get("maison_metal"),
				"carat": flt(item.get("maison_carat")),
				"stones": item.get("maison_stones"),
				"department": item.get("maison_department"),
				# v0.6 N — smoke-shop attributes + in-store-only flag
				"brand": item.get("maison_brand"),
				"flavor": item.get("maison_flavor"),
				"nicotine_mg": flt(item.get("maison_nicotine_mg")),
				"puffs": cint(item.get("maison_puffs")),
				"volume_ml": flt(item.get("maison_volume_ml")),
				"age_restricted": cint(item.get("maison_age_restricted")),
				"in_store_only": core.is_age_restricted_online_blocked(item),
				"web_mode": web_mode,
				"one_off": bool(item.get("has_serial_no")) and chain <= 1,
				"chain_qty": chain,
				"available_at": core.city_label(avail),
				"available_at_full": core.city_label_full(avail),  # v0.8 QA A2
				"rate": flt(price.get("price_list_rate")),
				"formatted_price": price.get("formatted_price") or "",
				"currency": price.get("currency") or settings.get("currency") or "USD",
			}
		)
	groups = frappe.get_all(
		"Item Group",
		filters={"show_in_website": 1, "is_group": 0},
		fields=["name", "route", "image", "description"],
		order_by="weightage desc, name asc",
	)
	# --- v0.8 QA A4 — the listing must be able to page ---
	# `/shop/collection` rendered one page of 96 and stopped: 59 of the 155 published products
	# were reachable only through a category chip or a search. Report how many rows the filters
	# match and whether another page exists so the template can draw Previous / Next.
	total = _website_items_count({"item_group": item_group}, q)
	return {
		"items": out,
		"item_groups": groups,
		"count": len(out),
		"total": total,
		"start": start,
		"limit": limit,
		"has_more": (start + len(rows)) < total,
	}
	# --- end v0.8 QA A4 ---


# ---------------------------------------------------------------------------
# guest: enquiries + loyalty
# ---------------------------------------------------------------------------
# --- v0.8 QA A1 — storefront registration that works on a site with no outgoing e-mail ----------
#
# Frappe's own `sign_up` creates the Website User with a *random* password and mails a
# verification link; on a deployment with no outgoing Email Account (which is how CloudChaserz
# ships) that mail is never sent, so the shopper is registered and still cannot sign in. The
# storefront therefore takes the registration itself: the shopper chooses their own password,
# gets the portal default role and is signed in on the spot, so the bag and `/shop/checkout`
# (both behind `require_login`) are reachable without any mail server.
#
# Guardrails: Website User only, only the Portal Settings default role, the platform password
# policy still applies, sign-up must be enabled, an existing address is never touched (and never
# has a password set on it), and the endpoint is rate limited like every other public write.
# -----------------------------------------------------------------------------------------------
MIN_PASSWORD_LENGTH = 8


def _ensure_portal_party(user: str, full_name: str) -> Optional[str]:
	"""The Customer + Contact a portal shopper needs before their first cart action.

	webshop creates these lazily on the first ``get_party`` — but Frappe has already created a
	*bare* Contact for the new User, webshop resolves the party through the **first** contact of
	the user, and ERPNext then refuses the cart Quotation with "Contact Person does not belong to
	<customer>". The Maison seed works around the same thing for its demo shopper
	(``setup/demo_v04_webshop.ensure_web_user``); a self-registered shopper needs it too.
	"""
	if not is_webshop_installed():
		return None
	from frappe.utils.nestedset import get_root_of

	customer = frappe.db.get_value("Portal User", {"user": user}, "parent")
	if not customer or not frappe.db.exists("Customer", customer):
		group = frappe.db.get_single_value("Webshop Settings", "default_customer_group") or frappe.db.get_value("Customer Group", {"is_group": 0}, "name")
		doc = frappe.get_doc(
			{
				"doctype": "Customer",
				# ERPNext appends " - n" when the name is taken, so this never adopts someone else's record
				"customer_name": full_name,
				"customer_type": "Individual",
				"customer_group": group,
				"territory": get_root_of("Territory"),
				"email_id": user,
				"portal_users": [{"user": user}],
			}
		)
		doc.flags.ignore_permissions = True
		doc.flags.ignore_mandatory = True
		doc.insert()
		customer = doc.name
	contacts = frappe.get_all("Contact", filters={"user": user}, pluck="name")
	if not contacts:
		contact = frappe.get_doc(
			{
				"doctype": "Contact",
				"first_name": full_name,
				"user": user,
				"email_ids": [{"email_id": user, "is_primary": 1}],
				"links": [{"link_doctype": "Customer", "link_name": customer}],
			}
		)
		contact.flags.ignore_permissions = True
		contact.flags.ignore_mandatory = True
		contact.insert()
	for name in contacts:
		contact = frappe.get_doc("Contact", name)
		if not any(link.link_doctype == "Customer" and link.link_name == customer for link in contact.links):
			contact.append("links", {"link_doctype": "Customer", "link_name": customer})
			contact.flags.ignore_permissions = True
			contact.flags.ignore_mandatory = True
			contact.save()
	return customer


@frappe.whitelist(allow_guest=True, methods=["POST"])
def register(email: str, full_name: str, password: str, redirect_to: Optional[str] = None) -> dict[str, Any]:
	"""Create a storefront account (Website User + portal role) and sign the shopper in."""
	from frappe.core.doctype.user.user import is_signup_disabled
	from frappe.utils import escape_html, validate_email_address

	_guest_limit("webshop.register", 5, 600)
	if frappe.session.user != "Guest":
		return {"ok": True, "user": frappe.session.user, "already_signed_in": True, "redirect_to": "/shop/account"}
	if is_signup_disabled():
		frappe.throw(_("Registration is closed — please ask in store"), frappe.ValidationError)
	email = (email or "").strip().lower()
	full_name = " ".join((full_name or "").split())
	if not validate_email_address(email):
		frappe.throw(_("Please enter a valid e-mail address"), frappe.ValidationError)
	if len(full_name) < 2:
		frappe.throw(_("Please tell us your name"), frappe.ValidationError)
	if not password or len(password) < MIN_PASSWORD_LENGTH:
		frappe.throw(_("Please choose a password of at least {0} characters").format(MIN_PASSWORD_LENGTH), frappe.ValidationError)
	if frappe.db.exists("User", email):
		# never touch an existing account (and never set a password on one)
		frappe.throw(_("There is already an account for {0} — please sign in instead").format(email), frappe.ValidationError)

	parts = full_name.split(" ", 1)
	user = frappe.get_doc(
		{
			"doctype": "User",
			"email": email,
			"first_name": escape_html(parts[0]),
			"last_name": escape_html(parts[1]) if len(parts) > 1 else "",
			"enabled": 1,
			"user_type": "Website User",
			"send_welcome_email": 0,
			"new_password": password,
		}
	)
	user.flags.ignore_permissions = True
	user.insert()
	role = frappe.db.get_single_value("Portal Settings", "default_role") or "Customer"
	if frappe.db.exists("Role", role):
		user.add_roles(role)
	_ensure_portal_party(user.name, user.full_name or full_name)
	# sign them straight in — the point of registering here is to get to the bag
	login_manager = getattr(frappe.local, "login_manager", None)
	if login_manager:
		login_manager.login_as(user.name)
	else:  # no HTTP session (tests / a console call): the account is still ready to sign in with
		frappe.set_user(user.name)
	frappe.local.response["type"] = "json"
	target = redirect_to if (redirect_to or "").startswith("/") and "//" not in (redirect_to or "") else "/shop/account"
	return {"ok": True, "user": user.name, "full_name": user.full_name, "redirect_to": target}
# --- end v0.8 QA A1 ---


@frappe.whitelist(allow_guest=True)
def enquire(
	item_code: str,
	name: str,
	email: Optional[str] = None,
	phone: Optional[str] = None,
	message: Optional[str] = None,
	boutique: Optional[str] = None,
	serial_no: Optional[str] = None,
) -> dict[str, Any]:
	"""Create a ``Maison Web Enquiry`` (+ an ERPNext Lead, best effort) for an Enquire-mode piece."""
	_guest_limit("webshop.enquire", 5, 600)
	if not frappe.db.exists("Item", item_code):
		frappe.throw(_("Item {0} not found").format(item_code), frappe.DoesNotExistError)
	name = (name or "").strip()
	if not name:
		frappe.throw(_("Please tell us your name"), frappe.ValidationError)
	if not (email or phone):
		frappe.throw(_("Please leave an e-mail address or a phone number"), frappe.ValidationError)
	if boutique and not frappe.db.exists("Maison Boutique", boutique):
		frappe.throw(_("Unknown boutique {0}").format(boutique), frappe.DoesNotExistError)
	if not boutique:
		# default: the boutique that holds the piece, else the first enabled one
		for a in core.availability(item_code):
			if flt(a["qty"]) > 0:
				boutique = a["boutique"]
				break
		if not boutique:
			bs = core.boutiques()
			boutique = bs[0]["name"] if bs else None

	customer = _customer_for_user() if frappe.session.user != "Guest" else None
	if not customer and email:
		customer = frappe.db.get_value("Customer", {"email_id": email, "disabled": 0}, "name")

	doc = frappe.get_doc(
		{
			"doctype": "Maison Web Enquiry",
			"item_code": item_code,
			"serial_no": serial_no,
			"boutique": boutique,
			"customer_name": name,
			"email": email,
			"phone": phone,
			"message": (message or "")[:2000],
			"customer": customer,
			"status": "New",
		}
	)
	doc.flags.ignore_permissions = True
	doc.insert()

	lead = None
	try:
		if not customer and frappe.db.exists("DocType", "Lead"):
			existing = frappe.db.get_value("Lead", {"email_id": email}, "name") if email else None
			if existing:
				lead = existing
			else:
				lead_doc = frappe.get_doc(
					{
						"doctype": "Lead",
						"lead_name": name,
						"email_id": email,
						"mobile_no": phone,
						"source": "Website",
						"notes": [{"note": f"Web enquiry {doc.name}: {frappe.db.get_value('Item', item_code, 'item_name')} ({item_code}). {message or ''}"}],
					}
				)
				lead_doc.flags.ignore_permissions = True
				lead_doc.flags.ignore_mandatory = True
				lead_doc.insert()
				lead = lead_doc.name
			doc.db_set("lead", lead, update_modified=False)
	except Exception:  # noqa: BLE001 - the enquiry itself is what matters
		frappe.log_error(frappe.get_traceback(), "maison web enquiry lead")

	try:
		frappe.publish_realtime("maison_web_enquiry", {"name": doc.name, "boutique": boutique, "item_code": item_code}, room="maison_dashboard")
	except Exception:  # noqa: BLE001
		pass
	return {"enquiry": doc.name, "boutique": boutique, "lead": lead}


@frappe.whitelist(allow_guest=True)
def loyalty_lookup(client_number: Optional[str] = None, email: Optional[str] = None) -> Optional[dict[str, Any]]:
	"""Loyalty sign-in for the web: client number **and** e-mail must match the same Customer.

	A signed-in shopper whose Contact is linked to a Customer may omit both.
	Returns ``{customer_name, client_number, tier, points, points_value, next_tier, ...}`` or ``None``.
	"""
	from maison_pos.api.customers import _loyalty

	customer = None
	client_number = (client_number or "").strip().upper().replace(" ", "")
	email = (email or "").strip().lower()
	if client_number or email:
		# v0.7 S4 — it takes *both* halves to match, but guessing must still cost something.
		# Only the guessable path is limited: the signed-in shopper's own card (no arguments)
		# is read on every account-page render and must not throttle.
		_guest_limit("webshop.loyalty_lookup", 15, 600)
		if not (client_number and email):
			frappe.throw(_("Enter both your client number and the e-mail we have on file"), frappe.ValidationError)
		row = frappe.db.get_value(
			"Customer", {"maison_client_number": client_number, "disabled": 0}, ["name", "email_id"], as_dict=True
		)
		if not row or (row.email_id or "").strip().lower() != email:
			# rate-limit friendly: identical message for both failure modes
			return None
		customer = row.name
	else:
		customer = _customer_for_user()
		if not customer:
			return None

	info = frappe.db.get_value(
		"Customer", customer, ["customer_name", "maison_client_number", "loyalty_program", "email_id"], as_dict=True
	)
	points, tier, value = _loyalty(customer)
	program = info.loyalty_program
	tiers: list[dict[str, Any]] = []
	next_tier = None
	if program:
		rows = frappe.get_all(
			"Loyalty Program Collection",
			filters={"parent": program},
			fields=["tier_name", "min_spent", "collection_factor"],
			order_by="min_spent asc",
		)
		tiers = [dict(r) for r in rows]
		spent = frappe.db.get_value(
			"Sales Invoice", {"customer": customer, "docstatus": 1, "is_return": 0}, "sum(base_grand_total)"
		)
		spent = flt(spent)
		for t in tiers:
			if flt(t["min_spent"]) > spent:
				next_tier = {"tier_name": t["tier_name"], "min_spent": flt(t["min_spent"]), "remaining": flt(t["min_spent"]) - spent}
				break
	recent = frappe.get_all(
		"Sales Invoice",
		filters={"customer": customer, "docstatus": 1},
		fields=["name", "posting_date", "grand_total", "maison_boutique", "is_return"],
		order_by="posting_date desc, creation desc",
		limit=5,
	)
	return {
		"customer": customer if frappe.session.user != "Guest" else None,
		"customer_name": info.customer_name,
		"client_number": info.maison_client_number,
		"email_masked": _mask_email(info.email_id),
		"tier": tier,
		"points": points,
		"points_value": value,
		"program": program,
		"tiers": tiers,
		"next_tier": next_tier,
		"recent": [dict(r) for r in recent],
	}


@frappe.whitelist(allow_guest=True)
def loyalty_card_html(client_number: Optional[str] = None, email: Optional[str] = None) -> str:
	"""Rendered loyalty card (the account page swaps it in after a successful lookup)."""
	data = loyalty_lookup(client_number, email)
	if not data:
		return ""
	return frappe.render_template("maison_pos/templates/webshop/loyalty_card.html", {"loyalty": frappe._dict(data)})


def _mask_email(email: Optional[str]) -> str:
	if not email or "@" not in email:
		return ""
	user, domain = email.split("@", 1)
	return f"{user[:1]}***@{domain}"


# ---------------------------------------------------------------------------
# signed-in shopper: cart boutique, checkout, reserve, payment
# ---------------------------------------------------------------------------
@frappe.whitelist()
def cart() -> dict[str, Any]:
	"""Cart summary: items, totals, chosen boutique, boutiques with per-line availability."""
	_require_webshop()
	_require_login()
	from webshop.webshop.shopping_cart.cart import _get_cart_quotation

	quotation = _get_cart_quotation()
	lines = []
	for it in quotation.get("items") or []:
		lines.append(
			{
				"item_code": it.item_code,
				"item_name": it.item_name,
				"qty": flt(it.qty),
				"rate": flt(it.rate),
				"amount": flt(it.amount),
				"image": absolute_file_url(it.image),
				"web_mode": core.effective_web_mode(frappe.db.get_value("Item", it.item_code, ["item_code", "has_serial_no", "is_stock_item", "maison_web_mode"], as_dict=True)),
			}
		)
	return {
		"quotation": quotation.name if not quotation.get("__islocal") else None,
		"items": lines,
		"net_total": flt(quotation.net_total),
		"total_taxes": flt(quotation.total_taxes_and_charges),
		"grand_total": flt(quotation.grand_total),
		"currency": quotation.currency,
		"boutique": quotation.get("maison_boutique"),
		"fulfilment": quotation.get("maison_fulfilment") or FULFILMENTS[0],
		"boutiques": core.boutique_for_item_availability([{"item_code": l["item_code"], "qty": l["qty"]} for l in lines]),
		"payment": _payment_mode_info(),
	}


def _payment_mode_info() -> dict[str, Any]:
	gateway_account = None
	if is_webshop_installed():
		gateway_account = frappe.db.get_single_value("Webshop Settings", "payment_gateway_account")
	gateway = frappe.db.get_value("Payment Gateway Account", gateway_account, "payment_gateway") if gateway_account else None
	return {
		"enabled": bool(gateway_account),
		"gateway": gateway,
		"simulated": gateway == SIMULATED_GATEWAY,
		"stripe": bool(gateway and gateway.startswith("Stripe")),
	}


# --- v0.8 QA A5 — refuse an item that cannot be bought online at *add* time ------------------
#
# `update_cart` had no web-mode guard, so an API caller (or a cart left over from before an item
# was made 21+) could put an "Available in store" product in the bag; `place_order` then refused
# the whole basket with a message about one line, leaving a bag the shopper had to repair by hand.
# The refusal belongs where the line is added, and it has to say what to do instead.
# ---------------------------------------------------------------------------------------------
def _assert_buyable_online(item_code: str) -> None:
	item = frappe.db.get_value(
		"Item",
		item_code,
		["item_code", "item_name", "has_serial_no", "is_stock_item", "maison_web_mode", "maison_age_restricted"],
		as_dict=True,
	)
	if not item:
		frappe.throw(_("Item {0} not found").format(item_code), frappe.DoesNotExistError)
	if core.effective_web_mode(item) == "Buy":
		return
	name = item.item_name or item.item_code
	if core.is_age_restricted_online_blocked(item):
		from maison_pos.brand import get_age_settings, get_brand

		frappe.throw(
			_("{0} is {1}+ and is sold in store only — bring a valid government ID to any {2}. It cannot be added to your bag.").format(
				name, get_age_settings()["minimum_age"], str(get_brand()["store_noun"]).lower()
			),
			frappe.ValidationError,
		)
	frappe.throw(
		_("{0} cannot be bought online — please enquire or reserve it instead").format(name),
		frappe.ValidationError,
	)
# --- end v0.8 QA A5 ---


@frappe.whitelist()
def update_cart(item_code: str, qty: float) -> dict[str, Any]:
	"""Quantity change / removal. Wraps webshop's ``update_cart``; removing the last line deletes the
	cart Quotation cleanly (webshop's own call fails on ``set_cart_count(None)``)."""
	_require_webshop()
	_require_login()
	from webshop.webshop.shopping_cart.cart import _get_cart_quotation, update_cart as _update_cart

	qty = flt(qty)
	if qty > 0:
		_assert_buyable_online(item_code)  # v0.8 QA A5
		_update_cart(item_code, qty)
		return cart()
	quotation = _get_cart_quotation()
	remaining = [it for it in quotation.get("items") or [] if it.item_code != item_code]
	if remaining:
		_update_cart(item_code, 0)
	elif not quotation.get("__islocal"):
		quotation.flags.ignore_permissions = True
		quotation.delete()
		if hasattr(frappe.local, "cookie_manager"):
			frappe.local.cookie_manager.set_cookie("cart_count", "0")
	return cart()


@frappe.whitelist()
def set_boutique(boutique: str, fulfilment: Optional[str] = None) -> dict[str, Any]:
	"""Remember the click-and-collect boutique on the cart (Quotation)."""
	_require_webshop()
	_require_login()
	from webshop.webshop.shopping_cart.cart import _get_cart_quotation

	if not frappe.db.exists("Maison Boutique", {"name": boutique, "enabled": 1}):
		frappe.throw(_("Unknown boutique {0}").format(boutique), frappe.DoesNotExistError)
	quotation = _get_cart_quotation()
	quotation.maison_boutique = boutique
	quotation.maison_fulfilment = core.fulfilment_or_default(fulfilment)
	quotation.flags.ignore_permissions = True
	quotation.save()
	return {"boutique": boutique, "fulfilment": quotation.maison_fulfilment}


def _ensure_cart_address(quotation) -> None:
	"""Click-and-collect needs no shipping address; give the party a billing address = the boutique."""
	if quotation.customer_address or quotation.shipping_address_name:
		return
	party_type = quotation.quotation_to
	party = quotation.party_name
	existing = frappe.db.get_value(
		"Dynamic Link", {"link_doctype": party_type, "link_name": party, "parenttype": "Address"}, "parent"
	)
	if not existing:
		b = frappe.get_cached_doc("Maison Boutique", quotation.maison_boutique)
		addr = frappe.get_doc(
			{
				"doctype": "Address",
				"address_title": f"{party} · collect at {b.boutique_name}",
				"address_type": "Billing",
				"address_line1": b.address_line or b.boutique_name,
				"city": (b.city or "").split(",")[0].strip() or b.boutique_name,
				"country": frappe.db.get_single_value("System Settings", "country") or frappe.get_cached_value("Company", b.company, "country") or "United States",
				"is_primary_address": 1,
				"links": [{"link_doctype": party_type, "link_name": party}],
			}
		)
		addr.flags.ignore_permissions = True
		addr.insert()
		existing = addr.name
	quotation.customer_address = existing


@frappe.whitelist()
def place_order(boutique: Optional[str] = None, fulfilment: Optional[str] = None, pay_now: int = 1) -> dict[str, Any]:
	"""Checkout: cart → submitted Sales Order carrying ``maison_boutique`` (+ Payment Request when paying online).

	Mirrors ``webshop.shopping_cart.cart.place_order`` but: no shipping address for click-and-collect,
	stock is checked in the **chosen boutique** for serialized pieces (a one-off cannot be sold twice),
	and the order lands in the boutique's POS queue as ``New``.
	"""
	_require_webshop()
	_require_login()
	from erpnext.selling.doctype.quotation.quotation import _make_sales_order
	from webshop.webshop.shopping_cart.cart import _get_cart_quotation

	cart_settings = frappe.get_cached_doc("Webshop Settings")
	quotation = _get_cart_quotation()
	if not quotation.get("items"):
		frappe.throw(_("Your cart is empty"), frappe.ValidationError)

	boutique = boutique or quotation.get("maison_boutique")
	if not boutique or not frappe.db.exists("Maison Boutique", {"name": boutique, "enabled": 1}):
		frappe.throw(_("Please choose the boutique where you will collect your order"), frappe.ValidationError)
	b = frappe.get_cached_doc("Maison Boutique", boutique)

	for it in quotation.items:
		item = frappe.db.get_value("Item", it.item_code, ["item_code", "has_serial_no", "is_stock_item", "maison_web_mode"], as_dict=True)
		mode = core.effective_web_mode(item)
		if mode != "Buy":
			frappe.throw(
				_("{0} cannot be bought online — please enquire or reserve it instead").format(it.item_name),
				frappe.ValidationError,
			)
		if cint(item.has_serial_no):
			here = flt(frappe.db.get_value("Bin", {"item_code": it.item_code, "warehouse": b.warehouse}, "actual_qty"))
			if here < flt(it.qty):
				frappe.throw(
					_("{0} is not available at {1} — choose another boutique").format(it.item_name, b.boutique_name),
					frappe.ValidationError,
				)

	quotation.company = cart_settings.company
	quotation.maison_boutique = boutique
	quotation.maison_fulfilment = core.fulfilment_or_default(fulfilment or quotation.get("maison_fulfilment"))
	_ensure_cart_address(quotation)
	quotation.flags.ignore_permissions = True
	quotation.save()
	quotation.submit()

	if quotation.quotation_to == "Lead" and quotation.party_name:
		frappe.defaults.set_user_default("company", quotation.company)

	so = frappe.get_doc(_make_sales_order(quotation.name, ignore_permissions=True))
	so.payment_schedule = []
	so.delivery_date = so.delivery_date or nowdate()
	so.set_warehouse = b.warehouse
	for row in so.items:
		row.warehouse = b.warehouse
		row.delivery_date = row.delivery_date or so.delivery_date
	so.update(
		{
			# NOT "Shopping Cart": ERPNext auto-invoices Shopping Cart orders when a Payment Request is
			# paid; a Maison web order is invoiced at the counter on collection (stock, receipt, points).
			"order_type": "Sales",
			"maison_web_order": 1,
			"maison_boutique": boutique,
			"maison_fulfilment": quotation.maison_fulfilment,
			"maison_web_mode": "Buy",
			"maison_web_status": "New",
			"cost_center": b.cost_center,
			# taxes of the boutique of collection (the cart shows them as "at collection")
			"taxes_and_charges": b.get_tax_template(),
		}
	)
	if so.taxes_and_charges:
		from erpnext.controllers.accounts_controller import get_taxes_and_charges

		so.set("taxes", get_taxes_and_charges("Sales Taxes and Charges Template", so.taxes_and_charges))
	so.flags.ignore_permissions = True
	so.insert()
	so.submit()

	if hasattr(frappe.local, "cookie_manager"):
		frappe.local.cookie_manager.delete_cookie("cart_count")

	out: dict[str, Any] = {"sales_order": so.name, "boutique": boutique, "grand_total": flt(so.grand_total), "payment_url": None, "amount": 0.0}
	if cint(pay_now) and _payment_mode_info()["enabled"]:
		pr = _payment_request(so, flt(so.rounded_total or so.grand_total))
		out.update({"payment_request": pr.name, "payment_url": _payment_url(pr), "amount": flt(pr.grand_total)})
	_notify_boutique(so)
	return out


@frappe.whitelist()
def reserve(item_code: str, boutique: str, serial_no: Optional[str] = None, note: Optional[str] = None) -> dict[str, Any]:
	"""Reserve-with-deposit: Sales Order for the piece (full price) + Payment Request for the deposit."""
	_require_webshop()
	_require_login()
	from webshop.webshop.shopping_cart.cart import get_party

	item = frappe.db.get_value(
		"Item", item_code, ["item_code", "item_name", "has_serial_no", "is_stock_item", "maison_web_mode"], as_dict=True
	)
	if not item:
		frappe.throw(_("Item {0} not found").format(item_code), frappe.DoesNotExistError)
	if core.effective_web_mode(item) != "Reserve-with-deposit":
		frappe.throw(_("{0} cannot be reserved online").format(item.item_name), frappe.ValidationError)
	if not frappe.db.exists("Maison Boutique", {"name": boutique, "enabled": 1}):
		frappe.throw(_("Unknown boutique {0}").format(boutique), frappe.DoesNotExistError)
	b = frappe.get_cached_doc("Maison Boutique", boutique)
	per = next((a for a in core.availability(item_code) if a["boutique"] == boutique), None)
	if not per or flt(per["qty"]) < 1:
		frappe.throw(_("{0} is not available at {1}").format(item.item_name, b.boutique_name), frappe.ValidationError)
	if serial_no and serial_no not in per["serials"]:
		frappe.throw(_("Serial {0} is not at {1}").format(serial_no, b.boutique_name), frappe.ValidationError)

	party = get_party()
	if party.doctype != "Customer":
		# webshop creates Customers lazily; make sure the shopper has one
		from webshop.webshop.shopping_cart.cart import _get_cart_quotation

		_get_cart_quotation()
		party = get_party()
	if party.doctype != "Customer":
		frappe.throw(_("Could not create a customer account for {0}").format(frappe.session.user), frappe.ValidationError)

	settings = frappe.get_cached_doc("Webshop Settings")
	from erpnext.utilities.product import get_price

	price = get_price(item_code, settings.price_list, settings.default_customer_group, settings.company, party=party) or {}
	rate = flt(price.get("price_list_rate"))
	if rate <= 0:
		frappe.throw(_("{0} has no web price").format(item.item_name), frappe.ValidationError)
	deposit = core.deposit_for(item_code, rate)

	so = frappe.new_doc("Sales Order")
	so.update(
		{
			"company": settings.company,
			"customer": party.name,
			"order_type": "Sales",  # see place_order: "Shopping Cart" orders are auto-invoiced on payment
			"transaction_date": nowdate(),
			"delivery_date": nowdate(),
			"selling_price_list": settings.price_list,
			"set_warehouse": b.warehouse,
			"cost_center": b.cost_center,
			"taxes_and_charges": b.get_tax_template(),
			"maison_web_order": 1,
			"maison_boutique": boutique,
			"maison_fulfilment": FULFILMENTS[0],
			"maison_web_mode": "Reserve-with-deposit",
			"maison_web_status": "New",
			"maison_deposit_amount": deposit,
			"maison_web_note": (f"Reserved serial {serial_no}. " if serial_no else "") + (note or ""),
		}
	)
	so.append("items", {"item_code": item_code, "qty": 1, "rate": rate, "warehouse": b.warehouse, "delivery_date": nowdate()})
	if so.taxes_and_charges:
		from erpnext.controllers.accounts_controller import get_taxes_and_charges

		so.set("taxes", get_taxes_and_charges("Sales Taxes and Charges Template", so.taxes_and_charges))
	so.flags.ignore_permissions = True
	so.insert()
	so.submit()

	out: dict[str, Any] = {
		"sales_order": so.name,
		"boutique": boutique,
		"deposit": deposit,
		"grand_total": flt(so.grand_total),
		"payment_url": None,
		"amount": 0.0,
	}
	if _payment_mode_info()["enabled"]:
		pr = _payment_request(so, deposit)
		out.update({"payment_request": pr.name, "payment_url": _payment_url(pr), "amount": deposit})
	_notify_boutique(so)
	return out


def _payment_request(so, amount: float):
	"""Payment Request against the Sales Order for ``amount`` (full total or deposit), submitted, mail muted."""
	from erpnext.accounts.doctype.payment_request.payment_request import get_gateway_details
	from erpnext.accounts.party import get_party_account
	from erpnext.accounts.doctype.payment_request.payment_request import get_dummy_message

	settings = frappe.get_cached_doc("Webshop Settings")
	gateway_account = get_gateway_details(frappe._dict(order_type="Shopping Cart", payment_gateway_account=settings.payment_gateway_account, company=so.company))
	if not gateway_account:
		frappe.throw(_("No payment gateway account is configured for the web shop"), frappe.ValidationError)

	existing = frappe.db.get_value(
		"Payment Request",
		{"reference_doctype": "Sales Order", "reference_name": so.name, "docstatus": 1, "status": ("in", ("Initiated", "Requested", "Draft"))},
		"name",
	)
	if existing:
		return frappe.get_doc("Payment Request", existing)

	party_account = get_party_account("Customer", so.customer, so.company)
	pr = frappe.new_doc("Payment Request")
	pr.update(
		{
			"payment_gateway_account": gateway_account.get("name"),
			"payment_gateway": gateway_account.get("payment_gateway"),
			"payment_account": gateway_account.get("payment_account"),
			"payment_request_type": "Inward",
			"currency": so.currency,
			"party_account_currency": frappe.get_cached_value("Account", party_account, "account_currency") if party_account else so.currency,
			"grand_total": flt(amount),
			"email_to": frappe.session.user,
			"subject": _("Payment for {0}").format(so.name),
			"message": gateway_account.get("message") or get_dummy_message(so),
			"reference_doctype": "Sales Order",
			"reference_name": so.name,
			"company": so.company,
			"party_type": "Customer",
			"party": so.customer,
			"party_name": so.customer_name,
			"cost_center": so.get("cost_center"),
		}
	)
	pr.flags.mute_email = True
	pr.flags.ignore_permissions = True
	pr.insert()
	pr.submit()
	return pr


def _payment_url(pr) -> str:
	if pr.payment_gateway == SIMULATED_GATEWAY:
		return get_url(f"/shop/pay?pr={pr.name}")
	return pr.get_payment_url()


@frappe.whitelist()
def simulate_payment(payment_request: str) -> dict[str, Any]:
	"""Simulated gateway (no Stripe key): mark the Payment Request paid → advance Payment Entry on the order."""
	_require_login()
	pr = frappe.get_doc("Payment Request", payment_request)
	if pr.payment_gateway != SIMULATED_GATEWAY:
		frappe.throw(_("This payment request is not on the simulated gateway"), frappe.ValidationError)
	so_owner_customer = frappe.db.get_value("Sales Order", pr.reference_name, "customer")
	if not is_unrestricted() and _customer_for_user() != so_owner_customer:
		frappe.throw(_("This order belongs to another client"), frappe.PermissionError)
	if pr.status == "Paid":
		return {"status": "Paid", "sales_order": pr.reference_name, "redirect_to": f"/shop/order?name={pr.reference_name}"}
	# same path as a real gateway callback: Payment Request.on_payment_authorized → advance Payment Entry.
	# Creating the Payment Entry needs accounting rights the shopper lacks → run it as Administrator
	# (MaisonPaymentRequest does the same for real gateways when it is the active override).
	user = frappe.session.user
	try:
		frappe.set_user("Administrator")
		redirect_to = pr.run_method("on_payment_authorized", "Completed")
	finally:
		frappe.set_user(user)
	core.refresh_prepaid(pr.reference_name)
	redirect_to = f"/shop/order?name={pr.reference_name}"
	pe = frappe.db.get_value(
		"Payment Entry Reference",
		{"reference_doctype": "Sales Order", "reference_name": pr.reference_name, "docstatus": 1},
		"parent",
	)
	return {
		"status": "Paid",
		"payment_entry": pe,
		"sales_order": pr.reference_name,
		"redirect_to": redirect_to,
	}


@frappe.whitelist()
def my_orders() -> list[dict[str, Any]]:
	_require_login()
	customer = _customer_for_user()
	if not customer:
		return []
	rows = frappe.get_all(
		"Sales Order",
		filters={"customer": customer, "docstatus": 1, "maison_web_order": 1},
		fields=["name", "transaction_date", "grand_total", "currency", "maison_boutique", "maison_web_status", "maison_web_mode", "maison_prepaid_amount", "maison_deposit_amount", "status"],
		order_by="creation desc",
		limit=50,
	)
	names = {b["name"]: b for b in core.boutiques(enabled_only=False)}
	for r in rows:
		b = names.get(r.maison_boutique) or {}
		r["boutique_name"] = b.get("boutique_name")
		r["city"] = b.get("city")
	return rows


@frappe.whitelist()
def order(name: str) -> dict[str, Any]:
	"""Order detail for the shopper (own orders) or staff (scoped)."""
	_require_login()
	so = frappe.get_doc("Sales Order", name)
	if not (is_unrestricted() or so.maison_boutique in get_allowed_boutiques() or _customer_for_user() == so.customer):
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	return _order_dict(so, with_customer=False)


# ---------------------------------------------------------------------------
# boutique staff: POS "Web orders" queue
# ---------------------------------------------------------------------------
def _order_dict(so, with_customer: bool = True) -> dict[str, Any]:
	b = frappe.db.get_value("Maison Boutique", so.maison_boutique, ["boutique_name", "city", "warehouse"], as_dict=True) or frappe._dict()
	prepaid = flt(so.get("maison_prepaid_amount"))
	lines = []
	for it in so.items:
		avail_here = flt(frappe.db.get_value("Bin", {"item_code": it.item_code, "warehouse": b.get("warehouse")}, "actual_qty")) if b.get("warehouse") else 0
		serials: list[str] = []
		if cint(frappe.db.get_value("Item", it.item_code, "has_serial_no")) and b.get("warehouse"):
			serials = frappe.get_all(
				"Serial No", filters={"item_code": it.item_code, "warehouse": b.warehouse, "status": "Active"}, pluck="name", order_by="name asc"
			)
		lines.append(
			{
				"row": it.name,
				"item_code": it.item_code,
				"item_name": it.item_name,
				"qty": flt(it.qty),
				"rate": flt(it.rate),
				"amount": flt(it.amount),
				"image": absolute_file_url(it.image),
				"available_here": avail_here,
				"serials_here": serials,
				"delivered_qty": flt(it.delivered_qty),
			}
		)
	out = {
		"name": so.name,
		"boutique": so.maison_boutique,
		"boutique_name": b.get("boutique_name"),
		"customer": so.customer,
		"customer_name": so.customer_name,
		"contact_email": so.get("contact_email"),
		"contact_mobile": so.get("contact_mobile"),
		"transaction_date": str(so.transaction_date),
		"creation": str(so.creation),
		"status": so.maison_web_status or "New",
		"erp_status": so.status,
		"web_mode": so.maison_web_mode or "Buy",
		"fulfilment": so.maison_fulfilment or FULFILMENTS[0],
		"deposit_amount": flt(so.maison_deposit_amount),
		"prepaid_amount": prepaid,
		"net_total": flt(so.net_total),
		"total_taxes": flt(so.total_taxes_and_charges),
		"grand_total": flt(so.grand_total),
		"rounded_total": flt(so.rounded_total or so.grand_total),
		"balance_due": max(0.0, flt(so.rounded_total or so.grand_total) - prepaid),
		"currency": so.currency,
		"note": so.maison_web_note,
		"sales_invoice": so.maison_sales_invoice,
		"receipt_token": frappe.db.get_value("Sales Invoice", so.maison_sales_invoice, "maison_receipt_token") if so.maison_sales_invoice else None,
		"collected_at": str(so.maison_collected_at) if so.maison_collected_at else None,
		"items": lines,
	}
	if with_customer:
		try:
			from maison_pos.api.customers import get as _get_customer

			out["customer_doc"] = _get_customer(so.customer)
		except Exception:  # noqa: BLE001 - Guest / missing loyalty must not break the queue
			out["customer_doc"] = None
	return out


@frappe.whitelist()
def web_orders(boutique: str, status: Optional[str] = None, include_done: int = 0) -> dict[str, Any]:
	"""Queue for one boutique: open web orders (+ open enquiries)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	filters: dict[str, Any] = {"maison_web_order": 1, "maison_boutique": boutique, "docstatus": 1}
	if status:
		filters["maison_web_status"] = status
	elif not cint(include_done):
		filters["maison_web_status"] = ("in", ("New", "Picking", "Ready"))
	names = frappe.get_all("Sales Order", filters=filters, pluck="name", order_by="creation asc", limit=200)
	orders = [_order_dict(frappe.get_doc("Sales Order", n), with_customer=False) for n in names]
	enquiries = frappe.get_all(
		"Maison Web Enquiry",
		filters={"boutique": boutique, "status": ("in", ("New", "Contacted") if not cint(include_done) else ("New", "Contacted", "Closed"))},
		fields=["name", "status", "enquiry_date", "item_code", "item_name", "serial_no", "customer_name", "email", "phone", "message", "customer", "response"],
		order_by="enquiry_date desc",
		limit=100,
	)
	counts = {s: 0 for s in ("New", "Picking", "Ready", "Collected")}
	for r in frappe.get_all(
		"Sales Order",
		filters={"maison_web_order": 1, "maison_boutique": boutique, "docstatus": 1},
		fields=["maison_web_status as s", "count(name) as n"],
		group_by="maison_web_status",
	):
		if r.s in counts:
			counts[r.s] = cint(r.n)
	return {"boutique": boutique, "orders": orders, "enquiries": enquiries, "counts": counts, "server_time": str(now_datetime())}


@frappe.whitelist()
def web_order(name: str) -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	so = frappe.get_doc("Sales Order", name)
	if not so.maison_web_order:
		frappe.throw(_("{0} is not a web order").format(name), frappe.ValidationError)
	assert_boutique_access(so.maison_boutique)
	return _order_dict(so)


@frappe.whitelist()
def set_web_order_status(name: str, status: str, note: Optional[str] = None) -> dict[str, Any]:
	"""Pick / Ready / Cancel from the POS queue. ``Collected`` is set by the Sales Invoice submit hook."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	so = frappe.get_doc("Sales Order", name)
	if not so.maison_web_order:
		frappe.throw(_("{0} is not a web order").format(name), frappe.ValidationError)
	assert_boutique_access(so.maison_boutique)
	if status == "Collected":
		frappe.throw(_("Collect the order through the POS sale (it becomes a Sales Invoice)"), frappe.ValidationError)
	core.assert_status_transition(so.maison_web_status or "New", status)
	values: dict[str, Any] = {"maison_web_status": status}
	if note is not None:
		values["maison_web_note"] = note
	frappe.db.set_value("Sales Order", name, values, update_modified=False)
	if status == "Cancelled":
		so.reload()
		so.flags.ignore_permissions = True
		try:
			so.update_status("Closed")
		except Exception:  # noqa: BLE001 - closing is cosmetic; the queue status is what the POS reads
			frappe.log_error(frappe.get_traceback(), "maison web order close")
	try:
		frappe.publish_realtime("maison_web_order", {"name": name, "boutique": so.maison_boutique, "status": status}, room="maison_dashboard")
	except Exception:  # noqa: BLE001
		pass
	return {"name": name, "status": status}


@frappe.whitelist()
def update_enquiry(name: str, status: str, response: Optional[str] = None) -> dict[str, Any]:
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	doc = frappe.get_doc("Maison Web Enquiry", name)
	assert_boutique_access(doc.boutique)
	if status not in ("New", "Contacted", "Closed"):
		frappe.throw(_("Unknown status {0}").format(status), frappe.ValidationError)
	doc.status = status
	if response is not None:
		doc.response = response
	doc.flags.ignore_permissions = True
	doc.save()
	return {"name": name, "status": status}


def _notify_boutique(so) -> None:
	try:
		frappe.publish_realtime(
			"maison_web_order",
			{"name": so.name, "boutique": so.maison_boutique, "status": so.maison_web_status, "grand_total": flt(so.grand_total)},
			room="maison_dashboard",
		)
	except Exception:  # noqa: BLE001
		pass


# ---------------------------------------------------------------------------
# misc
# ---------------------------------------------------------------------------
@frappe.whitelist(allow_guest=True)
def status() -> dict[str, Any]:
	"""Feature flags for the storefront JS."""
	_guest_limit("webshop.status", 240)
	enabled = False
	if is_webshop_installed():
		enabled = bool(frappe.db.get_single_value("Webshop Settings", "enabled"))
	return {
		"webshop": is_webshop_installed(),
		"payments": is_payments_installed(),
		"enabled": enabled,
		"signed_in": frappe.session.user != "Guest",
		"payment": _payment_mode_info() if enabled else {"enabled": False},
	}
