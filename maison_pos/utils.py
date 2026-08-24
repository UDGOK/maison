"""Shared helpers: realtime summaries, receipt context, money formatting."""

from __future__ import annotations

import re
from typing import Any, Optional

import frappe
from frappe.utils import cint, flt, get_datetime, now_datetime

# Frappe's socket.io server only lets clients join the rooms it manages (site, user,
# doctype, doc, task). A custom room name would never have subscribers, so the dashboard
# listens on the Sales Invoice doctype room (client emits ``doctype_subscribe``).
DASHBOARD_ROOM = "doctype:Sales Invoice"
SIGNATURE_THRESHOLD = 10_000.0


def iso_with_tz(value: Any) -> Optional[str]:
	"""ISO-8601 with the site's UTC offset for naive site-local datetimes.

	Frappe stores naive datetimes in the system timezone; browsers parse a naive ISO
	string as *their* local time, so dashboard clients in another zone (or a UTC
	container) would show heartbeats hours old and mark boutiques offline.
	"""
	if not value:
		return None
	from zoneinfo import ZoneInfo

	from frappe.utils import get_system_timezone

	dt = get_datetime(value)
	if dt.tzinfo is None:
		dt = dt.replace(tzinfo=ZoneInfo(get_system_timezone()))
	return dt.isoformat()


_SYMBOL_GAP = re.compile(r"^([^\w\s]+)\s+(?=[\d\-\u2212])")


def tighten_currency_symbol(text: str) -> str:
	"""``$ 69.99`` → ``$69.99``.

	v0.6 R — ``frappe.utils.fmt_money`` puts a space after a symbol prefix, which reads as a typo on
	a price tag and showed up on every storefront and receipt surface. Only a *symbol* prefix is
	tightened; a currency written as a word or as a suffix ("6.900,00 €") is returned unchanged.
	"""
	return _SYMBOL_GAP.sub(r"\1", text or "")


def format_money(value: float, currency: Optional[str] = None) -> str:
	"""Format a number as a currency string for receipts (``$12,345.00``)."""
	from frappe.utils import fmt_money

	return tighten_currency_symbol(fmt_money(flt(value), currency=currency or frappe.defaults.get_global_default("currency") or "USD"))


def invoice_summary(doc) -> dict[str, Any]:
	"""Compact summary of a POS Sales Invoice for the live feed."""
	cash = card = 0.0
	card_meta: dict[str, Any] = {}
	for p in doc.get("payments") or []:
		if (p.mode_of_payment or "").lower() == "cash":
			cash += flt(p.amount)
		else:
			card += flt(p.amount)
	if doc.get("maison_card_brand") or doc.get("maison_card_last4"):
		card_meta = {"brand": doc.get("maison_card_brand"), "last4": doc.get("maison_card_last4")}

	return {
		"invoice": doc.name,
		"boutique": doc.get("maison_boutique"),
		"associate": doc.get("maison_associate"),
		"device_id": doc.get("maison_device_id"),
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"posting_datetime": iso_with_tz(f"{doc.posting_date} {doc.posting_time}"),
		"net_total": flt(doc.net_total),
		"grand_total": flt(doc.grand_total),
		"total_taxes": flt(doc.total_taxes_and_charges),
		"cash": cash,
		"card": card,
		"card_meta": card_meta,
		"items": [
			{"item_code": i.item_code, "item_name": i.item_name, "qty": flt(i.qty), "rate": flt(i.rate), "serial_no": i.get("serial_no")}
			for i in doc.items
		],
		"docstatus": doc.docstatus,
		"ts": iso_with_tz(now_datetime()),
		# --- v0.5 L: fields the Command wall needs without PII (boutique, amount, top item, tier) ---
		"amount": flt(doc.grand_total),
		"top_item": top_item_name(doc),
		"tier": customer_tier(doc.customer),
		"is_return": cint(doc.get("is_return")),
		# --- end v0.5 L ---
	}


# --- v0.5 L: helpers for the realtime payload -------------------------------------------
def top_item_name(doc) -> Optional[str]:
	"""Name of the highest-value line (what the live card shows: "Sold · Perpetual 41")."""
	best = None
	for i in doc.get("items") or []:
		amount = abs(flt(i.get("amount")) or flt(i.get("rate")) * flt(i.get("qty")))
		if best is None or amount > best[0]:
			best = (amount, i.item_name or i.item_code)
	return best[1] if best else None


def customer_tier(customer: Optional[str]) -> Optional[str]:
	"""Loyalty tier name for *customer* (None for walk-ins / no programme). Never raises."""
	if not customer:
		return None
	try:
		from maison_pos.api.customers import _loyalty

		return _loyalty(customer)[1]
	except Exception:
		return None
# --- end v0.5 L ---


def publish_sale(doc, event: str = "maison_sale") -> None:
	"""Push a sale (or cancellation) to the head-office dashboard room."""
	payload = invoice_summary(doc)
	payload["event"] = event
	# v0.5 L — the 5 s live_summary cache must not serve stale totals right after a sale
	try:
		frappe.cache.delete_keys("maison_live_summary")
	except Exception:  # pragma: no cover - cache unavailable
		pass
	frappe.publish_realtime(event, payload, room=DASHBOARD_ROOM, after_commit=True)


def publish_heartbeat(payload: dict[str, Any]) -> None:
	frappe.publish_realtime("maison_heartbeat", payload, room=DASHBOARD_ROOM, after_commit=True)


def touch_last_seen(boutique: Optional[str], device_id: Optional[str]) -> None:
	"""Update (or create) the heartbeat row for a device when a sale lands."""
	if not boutique or not device_id:
		return
	name = frappe.db.get_value("Maison Device Heartbeat", {"boutique": boutique, "device_id": device_id}, "name")
	now = now_datetime()
	if name:
		frappe.db.set_value(
			"Maison Device Heartbeat",
			name,
			{"last_seen": now, "status": "Online"},
			update_modified=False,
		)
	else:
		hb = frappe.new_doc("Maison Device Heartbeat")
		hb.update({"boutique": boutique, "device_id": device_id, "last_seen": now, "queued": 0, "status": "Online"})
		hb.flags.ignore_permissions = True
		hb.insert()


def get_receipt_context(doc) -> dict[str, Any]:
	"""Jinja helper: everything the 80 mm receipt needs beyond the invoice itself."""
	boutique = None
	if doc.get("maison_boutique") and frappe.db.exists("Maison Boutique", doc.maison_boutique):
		boutique = frappe.get_doc("Maison Boutique", doc.maison_boutique)

	associate_name = None
	if doc.get("maison_associate") and frappe.db.exists("Maison Associate", doc.maison_associate):
		associate_name = frappe.db.get_value("Maison Associate", doc.maison_associate, "full_name")

	tier = None
	points_balance = 0.0
	loyalty_program = frappe.db.get_value("Customer", doc.customer, "loyalty_program") if doc.customer else None
	if doc.customer and loyalty_program:
		try:
			from erpnext.accounts.doctype.loyalty_program.loyalty_program import get_loyalty_program_details_with_points

			details = get_loyalty_program_details_with_points(
				doc.customer, loyalty_program=loyalty_program, company=doc.company, silent=True
			)
			if details:
				tier = details.get("tier_name")
				points_balance = flt(details.get("loyalty_points"))
		except Exception:  # pragma: no cover - loyalty is optional
			frappe.log_error(frappe.get_traceback(), "Maison receipt loyalty lookup")

	points_earned = 0.0
	if doc.docstatus == 1:
		points_earned = flt(
			frappe.db.get_value(
				"Loyalty Point Entry",
				{"invoice_type": "Sales Invoice", "invoice": doc.name, "redeem_against": ("is", "not set")},
				"loyalty_points",
			)
		)

	certificates = {}
	for row in doc.items:
		cert = frappe.db.get_value("Item", row.item_code, "maison_certificate_no")
		if cert:
			certificates[row.item_code] = cert

	client_number = frappe.db.get_value("Customer", doc.customer, "maison_client_number") if doc.customer else None
	token = doc.get("maison_receipt_token")

	# --- v0.6 N/Q — rewards extras (next reward, giveaway entries) + age gate ---
	rewards = None
	try:
		from maison_pos.api.rewards import receipt_extras

		rewards = receipt_extras(doc)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "Maison receipt rewards extras")
	from maison_pos.brand import get_age_settings

	# --- end v0.6 N/Q ---
	return {
		"rewards": rewards,
		"age_minimum": get_age_settings()["minimum_age"],
		"boutique": boutique,
		"associate_name": associate_name,
		"tier": tier,
		"client_number": client_number,
		"points_balance": points_balance,
		"points_earned": points_earned,
		"certificates": certificates,
		"requires_signature": flt(doc.grand_total) >= SIGNATURE_THRESHOLD,
		"printed_at": now_datetime(),
		"receipt_token": token,
		"receipt_url": receipt_url(token) if token else None,
		"qr_enabled": bool(token) and receipt_qr_enabled(),
	}


# ---------------------------------------------------------------------------
# receipt QR
# ---------------------------------------------------------------------------
def receipt_qr_enabled() -> bool:
	"""``Maison POS Settings.receipt_qr_enabled`` (defaults to on when the single was never saved)."""
	from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import get_pos_settings

	return bool(get_pos_settings()["receipt_qr_enabled"])


def receipt_url(token: str) -> str:
	"""Public URL encoded in the receipt QR: ``<receipt_qr_base_url>/r/<token>``."""
	from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import get_receipt_qr_base_url

	return f"{get_receipt_qr_base_url()}/r/{token}"


def qr_svg_data_uri(content: str, scale: int = 4, dark: str = "#000000") -> str:
	"""Render *content* as an SVG QR code data URI (segno, pure python, error level M)."""
	import base64
	import io

	import segno

	buf = io.BytesIO()
	segno.make(content, error="m").save(buf, kind="svg", scale=scale, border=1, dark=dark, light=None, xmldecl=False, svgclass=None, lineclass=None)
	return "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def receipt_qr_svg(doc, scale: int = 4) -> str:
	"""Jinja helper: QR data URI for a Sales Invoice (empty string when disabled / no token)."""
	token = doc.get("maison_receipt_token") if hasattr(doc, "get") else None
	if not token or not receipt_qr_enabled():
		return ""
	return qr_svg_data_uri(receipt_url(token), scale=scale)


def receipt_payload(doc) -> dict[str, Any]:
	"""Receipt as JSON for the public ``/r/<token>`` page and ``sales.receipt``.

	No PII beyond what is printed: customer first name is omitted entirely; only the
	client number's last 3 digits and the loyalty points are shown.
	"""
	ctx = get_receipt_context(doc)
	boutique = ctx["boutique"]
	lines = []
	for row in doc.items:
		serials: list[str] = []
		if row.get("serial_no"):
			serials = [s.strip() for s in str(row.serial_no).splitlines() if s.strip()]
		elif row.get("serial_and_batch_bundle"):
			serials = [
				e for e in frappe.get_all("Serial and Batch Entry", filters={"parent": row.serial_and_batch_bundle}, pluck="serial_no") if e
			]
		lines.append(
			{
				"item_code": row.item_code,
				"item_name": row.item_name,
				"qty": flt(row.qty),
				"rate": flt(row.rate),
				"amount": flt(row.amount),
				"discount_amount": flt(row.get("discount_amount")),
				"serials": serials,
				"certificate_no": ctx["certificates"].get(row.item_code),
			}
		)
	payments = []
	# v0.8 POS D11 — a cash row now carries what was *tendered*; the receipt shows the tender, the
	# change handed back and the amount that actually paid for the sale, so the rows still add up
	# to the total. Only one cash row can carry change (ERPNext keeps it on the invoice header).
	change_left = flt(doc.get("change_amount"))
	for p in doc.payments:
		if not flt(p.amount):
			continue
		entry: dict[str, Any] = {"mode_of_payment": p.mode_of_payment, "amount": flt(p.amount)}
		if (p.mode_of_payment or "").lower() != "cash":
			entry["card_brand"] = doc.get("maison_card_brand")
			entry["last4"] = doc.get("maison_card_last4")
			entry["approval_code"] = doc.get("maison_approval_code")
		elif change_left:
			given = min(change_left, flt(p.amount))
			change_left = flt(change_left - given)
			entry["tendered"] = flt(p.amount)
			entry["change"] = given
			entry["amount"] = flt(flt(p.amount) - given, 2)
		payments.append(entry)
	client_number = ctx["client_number"]
	return {
		"token": doc.get("maison_receipt_token"),
		"invoice": doc.name,
		"status": "cancelled" if doc.docstatus == 2 else "return" if doc.get("is_return") else "paid",
		"company": doc.company,
		"currency": doc.currency,
		"boutique": {
			"code": boutique.name if boutique else None,
			"name": boutique.boutique_name if boutique else doc.company,
			"address_line": boutique.address_line if boutique else None,
			"city": boutique.city if boutique else None,
			"phone": boutique.phone if boutique else None,
			"email": boutique.email if boutique else None,
		},
		"posting_datetime": iso_with_tz(f"{doc.posting_date} {doc.posting_time}"),
		"associate_name": ctx["associate_name"],
		"client": {
			"present": bool(doc.customer),
			"client_number_masked": (f"MC•••{client_number[-3:]}" if client_number else None),
			"tier": ctx["tier"],
			"points_earned": flt(ctx["points_earned"]),
			"points_balance": flt(ctx["points_balance"]),
			# v0.6 Q
			"next_reward": (ctx.get("rewards") or {}).get("next_reward"),
			"giveaway_entries": (ctx.get("rewards") or {}).get("giveaway_entries") or 0,
			"giveaway": (ctx.get("rewards") or {}).get("giveaway"),
			"reward_tier": (ctx.get("rewards") or {}).get("reward_tier"),
		},
		# v0.6 N/Q — brand + age
		"brand": get_brand_context(),
		"age_verified": int(doc.get("maison_age_verified") or 0),
		"lines": lines,
		"totals": {
			"net_total": flt(doc.net_total),
			"taxes": [{"description": t.description, "amount": flt(t.tax_amount)} for t in doc.taxes],
			"total_taxes": flt(doc.total_taxes_and_charges),
			"discount_amount": flt(doc.discount_amount),
			"loyalty_amount": flt(doc.get("loyalty_amount")),
			"loyalty_points": flt(doc.get("loyalty_points")),
			"rounding_adjustment": flt(doc.rounding_adjustment),
			"grand_total": flt(doc.rounded_total or doc.grand_total),
			"change_amount": flt(doc.get("change_amount")),
		},
		"payments": payments,
		"notes": doc.get("maison_notes"),
		"url": receipt_url(doc.maison_receipt_token) if doc.get("maison_receipt_token") else None,
		# v0.4 E — credit notes / exchanges
		"return_against": doc.get("return_against"),
		"refund_method": doc.get("maison_refund_method"),
		"refund_id": doc.get("maison_refund_id"),
		"return_reason": doc.get("maison_return_reason"),
		"exchange_invoice": doc.get("maison_exchange_invoice"),
		"store_credit": abs(flt(doc.outstanding_amount)) if doc.get("is_return") and flt(doc.outstanding_amount) < 0 else 0.0,
	}


def parse_datetime(value: Any):
	"""Tolerant datetime parser (ISO strings with ``T`` / ``Z`` accepted)."""
	if not value:
		return now_datetime()
	if isinstance(value, str):
		raw = value.strip()
		# Timezone-aware ISO strings (the PWA sends ``Date.toISOString()``: UTC with ``Z``):
		# convert to the site's timezone instead of dropping the offset, otherwise the
		# posting time lands N hours off and sales fall into the wrong day/hour bucket.
		try:
			from datetime import datetime
			from zoneinfo import ZoneInfo

			from frappe.utils import get_system_timezone

			parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
			if parsed.tzinfo is not None:
				return parsed.astimezone(ZoneInfo(get_system_timezone())).replace(tzinfo=None)
		except (ValueError, TypeError):
			pass
		value = raw.replace("T", " ")
		if "+" in value[10:]:
			value = value[: value.index("+", 10)]
	return get_datetime(value)


# ---------------------------------------------------------------------------
# v0.6 N — brand tokens for templates (receipt header / footer, e-mails, shop)
# ---------------------------------------------------------------------------
def get_brand_context() -> dict[str, Any]:
	"""Jinja helper: ``brand`` dict + receipt header/footer lines."""
	from maison_pos.brand import get_brand, get_rewards_settings

	b = dict(get_brand())
	b["receipt_header"] = b["brand_name"]
	b["rewards_program_name"] = get_rewards_settings()["rewards_program_name"]
	if b.get("vertical") == "Jewellery":
		b["receipt_footer"] = "Exchanges within 30 days with receipt. Bespoke and engraved pieces are final sale."
	else:
		b["receipt_footer"] = "Exchanges within 30 days with receipt on unopened items. Opened vape, e-liquid and kratom products are final sale. Must be 21+ to purchase."
	return b
