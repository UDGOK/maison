"""Sales endpoints: idempotent offline batch submission, daily list (X report), void.

``submit_batch`` is the heart of offline-first sync:

* each POSInvoice carries a client-generated ``offline_uuid``; the server keeps a
  ``Maison Sync Log`` row per uuid and the uuid is also stored on the Sales
  Invoice (unique custom field), so replays return ``status: "duplicate"``;
* each invoice is wrapped in a DB savepoint so a failure (e.g. a serial number
  sold elsewhere while the device was offline) is reported with a structured
  ``error_code`` and does not roll back its siblings.
"""

from __future__ import annotations

import builtins
import json
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from maison_pos.maison_pos.doctype.maison_sync_log import maison_sync_log as synclog
from maison_pos.scoping import assert_boutique_access, assert_roles, is_manager_or_above, ALL_MAISON_ROLES
from maison_pos.scoping import assert_can_sell  # v0.6 O/P — warehouse admins / the warehouse row never sell
from maison_pos.utils import parse_datetime, receipt_payload

# ---------------------------------------------------------------------------
# structured errors
# ---------------------------------------------------------------------------
ERR_SERIAL_UNAVAILABLE = "SERIAL_UNAVAILABLE"
ERR_VALIDATION = "VALIDATION_ERROR"
ERR_PERMISSION = "PERMISSION_DENIED"
ERR_NOT_FOUND = "NOT_FOUND"
ERR_PAYMENT = "PAYMENT_MISMATCH"
ERR_STOCK = "INSUFFICIENT_STOCK"
ERR_SERVER = "SERVER_ERROR"


class MaisonPOSError(frappe.ValidationError):
	"""Validation error that carries a machine-readable ``error_code``."""

	error_code = ERR_VALIDATION

	def __init__(self, message: str, error_code: Optional[str] = None, **extra: Any):
		super().__init__(message)
		if error_code:
			self.error_code = error_code
		self.extra = extra


class SerialUnavailableError(MaisonPOSError):
	error_code = ERR_SERIAL_UNAVAILABLE


class PaymentMismatchError(MaisonPOSError):
	error_code = ERR_PAYMENT


def _error_code_for(exc: BaseException) -> str:
	if isinstance(exc, MaisonPOSError):
		return exc.error_code
	# --- v0.6 N/Q ---
	if getattr(exc, "error_code", None) in ("REWARD_INVALID",):
		return exc.error_code  # type: ignore[return-value]
	if exc.__class__.__name__ == "AgeVerificationError":
		return "AGE_VERIFICATION"
	# --- end v0.6 N/Q ---
	if isinstance(exc, frappe.PermissionError):
		return ERR_PERMISSION
	if isinstance(exc, frappe.DoesNotExistError):
		return ERR_NOT_FOUND
	if isinstance(exc, frappe.ValidationError):
		msg = str(exc).lower()
		if "serial" in msg:
			return ERR_SERIAL_UNAVAILABLE
		if "stock" in msg and ("negative" in msg or "insufficient" in msg or "not available" in msg):
			return ERR_STOCK
		return ERR_VALIDATION
	return ERR_SERVER


# ---------------------------------------------------------------------------
# serial checks
# ---------------------------------------------------------------------------
def _split_serials(value: Any) -> list[str]:
	if not value:
		return []
	if isinstance(value, (builtins.list, tuple)):
		return [str(s).strip() for s in value if str(s).strip()]
	return [s.strip() for s in str(value).replace(",", "\n").split("\n") if s.strip()]


def check_serials_available(items: list[dict[str, Any]], warehouse: str) -> None:
	"""Raise ``SerialUnavailableError`` if any requested serial is not Active in *warehouse*."""
	problems: list[dict[str, Any]] = []
	seen: set[str] = set()
	for row in items:
		serials = _split_serials(row.get("serial_no"))
		if not serials:
			continue
		if len(serials) != cint(row.get("qty") or 1):
			problems.append({"item_code": row.get("item_code"), "serial_no": serials, "reason": "qty_mismatch"})
			continue
		for serial in serials:
			if serial in seen:
				problems.append({"item_code": row.get("item_code"), "serial_no": serial, "reason": "duplicate_in_batch"})
				continue
			seen.add(serial)
			info = frappe.db.get_value("Serial No", serial, ["item_code", "warehouse", "status"], as_dict=True)
			if not info:
				problems.append({"item_code": row.get("item_code"), "serial_no": serial, "reason": "not_found"})
			elif info.item_code != row.get("item_code"):
				problems.append({"item_code": row.get("item_code"), "serial_no": serial, "reason": "wrong_item", "actual_item": info.item_code})
			elif info.warehouse != warehouse:
				problems.append({"item_code": row.get("item_code"), "serial_no": serial, "reason": "not_in_warehouse", "warehouse": info.warehouse})
			elif (info.status or "Active") != "Active":
				problems.append({"item_code": row.get("item_code"), "serial_no": serial, "reason": "status", "status": info.status})
	if problems:
		labels = ", ".join(f"{p['serial_no']} ({p['reason']})" for p in problems)
		raise SerialUnavailableError(_("Serial number(s) no longer available: {0}").format(labels), serials=problems)


# ---------------------------------------------------------------------------
# invoice builder
# ---------------------------------------------------------------------------
def _loyalty_details(customer: str, company: str) -> Optional[dict[str, Any]]:
	program = frappe.db.get_value("Customer", customer, "loyalty_program")
	if not program:
		return None
	row = frappe.db.get_value(
		"Loyalty Program",
		program,
		["name", "conversion_factor", "expense_account", "cost_center", "company"],
		as_dict=True,
	)
	if not row or (row.company and row.company != company):
		return None
	return row


def build_sales_invoice(payload: dict[str, Any], boutique: str):
	"""Construct (but do not insert) a POS Sales Invoice from a POSInvoice payload."""
	b = frappe.get_cached_doc("Maison Boutique", boutique)
	pos_profile = frappe.get_cached_doc("POS Profile", b.pos_profile)
	company = b.company

	customer = payload.get("customer") or pos_profile.customer
	if not customer:
		raise MaisonPOSError(_("No customer on the invoice and the POS Profile has no default customer"))
	if not frappe.db.exists("Customer", customer):
		raise MaisonPOSError(_("Customer {0} does not exist").format(customer), ERR_NOT_FOUND)

	items = payload.get("items") or []
	if not items:
		raise MaisonPOSError(_("Invoice has no items"))
	payments = payload.get("payments") or []
	# --- v0.4 G (webshop): collecting a web order — the online payment is an advance on the Sales Order ---
	sales_order = payload.get("sales_order")
	if sales_order and not frappe.db.exists("Sales Order", {"name": sales_order, "docstatus": 1}):
		raise MaisonPOSError(_("Sales Order {0} does not exist").format(sales_order), ERR_NOT_FOUND)
	# --- end v0.4 G ---
	if not payments and not sales_order:
		raise PaymentMismatchError(_("Invoice has no payments"))

	posting = parse_datetime(payload.get("posting_datetime"))

	si = frappe.new_doc("Sales Invoice")
	si.update(
		{
			"company": company,
			"customer": customer,
			"is_pos": 1,
			"pos_profile": pos_profile.name,
			"update_stock": 1,
			"set_warehouse": b.warehouse,
			"cost_center": b.cost_center,
			"set_posting_time": 1,
			"posting_date": posting.date(),
			"posting_time": posting.time().strftime("%H:%M:%S"),
			"due_date": posting.date(),
			"currency": pos_profile.currency or frappe.get_cached_value("Company", company, "default_currency"),
			"selling_price_list": pos_profile.selling_price_list,
			"taxes_and_charges": b.get_tax_template(),
			"ignore_pricing_rule": 1,  # client already applied store overrides; keep the rates it sent
			"maison_boutique": boutique,
			"maison_associate": payload.get("associate"),
			"maison_device_id": payload.get("device_id"),
			"maison_offline_uuid": payload["offline_uuid"],
			"maison_notes": payload.get("notes"),
		}
	)
	si.flags.maison_pos = True

	for row in items:
		item_code = row.get("item_code")
		if not item_code or not frappe.db.exists("Item", item_code):
			raise MaisonPOSError(_("Item {0} does not exist").format(item_code), ERR_NOT_FOUND)
		qty = flt(row.get("qty") or 1)
		if qty <= 0:
			raise MaisonPOSError(_("Quantity must be positive for {0}").format(item_code))
		# POSInvoice semantics (SPEC.md): `rate` = unit list rate shown on the tile, `discount_amount` =
		# manual + promotion discount for the WHOLE line (the device computes its total as
		# qty * rate - discount_amount). ERPNext's Sales Invoice Item keeps `discount_amount` per unit and
		# derives `amount` from `rate`, so the net unit rate is what lands in `rate`.
		rate = flt(row.get("rate"))
		discount = min(flt(row.get("discount_amount")), flt(qty * rate))
		unit_discount = flt(discount / qty, 4) if discount else 0.0
		line = {
			"item_code": item_code,
			"qty": qty,
			"warehouse": b.warehouse,
			"cost_center": b.cost_center,
			"price_list_rate": rate,
			"discount_amount": unit_discount,
			"rate": flt(rate - unit_discount, 4),
		}
		serials = _split_serials(row.get("serial_no"))
		if serials:
			line["use_serial_batch_fields"] = 1
			line["serial_no"] = "\n".join(serials)
		# --- v0.4 G (webshop): link the line to the web order so ERPNext marks it delivered + billed ---
		if sales_order:
			line["sales_order"] = sales_order
			line["so_detail"] = row.get("so_detail") or frappe.db.get_value(
				"Sales Order Item", {"parent": sales_order, "item_code": item_code}, "name"
			)
		# --- end v0.4 G ---
		si.append("items", line)

	# taxes from the boutique template (server recomputes amounts)
	template = b.get_tax_template()
	if template:
		from erpnext.controllers.accounts_controller import get_taxes_and_charges

		si.set("taxes", get_taxes_and_charges("Sales Taxes and Charges Template", template))

	# v0.4 I — coupon (validated server-side; folds into line discounts before taxes)
	from maison_pos.api.promotions import apply_coupon_to_invoice

	apply_coupon_to_invoice(si, payload)

	# --- v0.6 N/Q — age gate for restricted items; fixed reward tiers -> loyalty redemption ---
	from maison_pos.api.age import apply_to_invoice as apply_age_check
	from maison_pos.api.rewards import apply_to_invoice as apply_reward_tier

	apply_age_check(si, payload)
	apply_reward_tier(si, payload)
	# --- end v0.6 N/Q ---

	# loyalty redemption
	points = flt(payload.get("loyalty_points_redeemed"))
	if points > 0 and not si.get("maison_reward_tier"):
		lp = _loyalty_details(customer, company)
		if not lp:
			raise MaisonPOSError(_("Customer {0} is not enrolled in a loyalty program").format(customer))
		si.update(
			{
				"redeem_loyalty_points": 1,
				"loyalty_program": lp.name,
				"loyalty_points": points,
				"loyalty_amount": flt(points * flt(lp.conversion_factor)),
				"loyalty_redemption_account": lp.expense_account,
				"loyalty_redemption_cost_center": lp.cost_center or b.cost_center,
			}
		)

	# payments
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	for p in payments:
		mop = p.get("mode_of_payment")
		if not mop or not frappe.db.exists("Mode of Payment", mop):
			raise PaymentMismatchError(_("Unknown mode of payment {0}").format(mop))
		amount = flt(p.get("amount"))
		if amount <= 0:
			raise PaymentMismatchError(_("Payment amount must be positive for {0}").format(mop))
		account = (get_bank_cash_account(mop, company) or {}).get("account")
		si.append("payments", {"mode_of_payment": mop, "amount": amount, "account": account})
		if p.get("stripe_payment_intent"):
			si.maison_terminal_ref = p.get("stripe_payment_intent")
			si.maison_card_brand = p.get("card_brand")
			si.maison_card_last4 = p.get("last4")
			si.maison_approval_code = p.get("approval_code")

	change_account = pos_profile.get("account_for_change_amount") or frappe.get_cached_value("Company", company, "default_cash_account")
	si.account_for_change_amount = change_account
	# --- v0.4 G (webshop): allocate the online payment (advance Payment Entry against the Sales Order) ---
	if sales_order:
		from maison_pos.webshop.collect import apply_web_order_advances

		apply_web_order_advances(si, sales_order, payments)
	# --- end v0.4 G ---
	return si


def _validate_payments_cover_total(si) -> None:
	paid = sum(flt(p.amount) for p in si.payments)
	# loyalty_amount is deducted from what the client owes (ERPNext posts it to the redemption account)
	due = flt(si.rounded_total or si.grand_total)
	if si.redeem_loyalty_points:
		due -= flt(si.loyalty_amount)
	# --- v0.4 G (webshop): advances (online payment of a web order) reduce what is due at the counter ---
	due -= flt(si.get("total_advance"))
	# --- end v0.4 G ---
	if paid + 0.005 < due:
		raise PaymentMismatchError(
			_("Payments ({0}) do not cover the invoice total ({1})").format(paid, due), paid=paid, due=due
		)
	# overpayment is only allowed for cash (change given)
	non_cash = sum(flt(p.amount) for p in si.payments if (p.mode_of_payment or "").lower() != "cash")
	if non_cash - 0.005 > due:
		raise PaymentMismatchError(_("Card payments exceed the invoice total"), paid=non_cash, due=due)


def _existing_invoice_for_uuid(offline_uuid: str) -> Optional[str]:
	return frappe.db.get_value(
		"Sales Invoice", {"maison_offline_uuid": offline_uuid, "docstatus": ("<", 2)}, "name"
	)


def _duplicate_result(offline_uuid: str, invoice_name: str) -> dict[str, Any]:
	"""Replay result: the device may have missed the first response, so return the token too."""
	return {
		"offline_uuid": offline_uuid,
		"status": "duplicate",
		"invoice_name": invoice_name,
		"receipt_token": frappe.db.get_value("Sales Invoice", invoice_name, "maison_receipt_token"),
	}


# --- v0.6 Q ---
def _rewards_extras(si) -> Optional[dict[str, Any]]:
	try:
		from maison_pos.api.rewards import receipt_extras

		return receipt_extras(si)
	except Exception:
		return None
# --- end v0.6 Q ---


def _process_one(payload: dict[str, Any], idx: int) -> dict[str, Any]:
	"""Process a single POSInvoice inside its own savepoint. Never raises."""
	offline_uuid = (payload.get("offline_uuid") or "").strip()
	if not offline_uuid:
		return {"offline_uuid": None, "status": "error", "error": _("offline_uuid is required"), "error_code": ERR_VALIDATION}

	# idempotency: already landed?
	existing = _existing_invoice_for_uuid(offline_uuid)
	if existing:
		synclog.record(offline_uuid, "Duplicate", invoice=existing, boutique=payload.get("boutique"), device_id=payload.get("device_id"))
		return _duplicate_result(offline_uuid, existing)
	log = synclog.get_log(offline_uuid)
	if log and log["status"] == "Success" and log["invoice"] and frappe.db.exists("Sales Invoice", log["invoice"]):
		return _duplicate_result(offline_uuid, log["invoice"])

	savepoint = f"maison_batch_{idx}"
	frappe.db.savepoint(savepoint)
	try:
		boutique = assert_can_sell(payload.get("boutique"))  # v0.6 O/P
		warehouse = frappe.get_cached_value("Maison Boutique", boutique, "warehouse")
		check_serials_available(payload.get("items") or [], warehouse)

		si = build_sales_invoice(payload, boutique)
		si.flags.ignore_permissions = True
		si.insert()
		_validate_payments_cover_total(si)
		si.submit()

		synclog.record(
			offline_uuid,
			"Success",
			boutique=boutique,
			device_id=payload.get("device_id"),
			invoice=si.name,
			payload=payload,
		)
		frappe.db.release_savepoint(savepoint)
		return {
			"offline_uuid": offline_uuid,
			"status": "ok",
			"invoice_name": si.name,
			"grand_total": flt(si.grand_total),
			"rounded_total": flt(si.rounded_total),
			"change_amount": flt(si.change_amount),
			"receipt_token": si.get("maison_receipt_token"),
			# --- v0.6 Q — points earned / balance / next reward / giveaway entries for the POS receipt + Salon ---
			"rewards": _rewards_extras(si),
			# --- end v0.6 Q ---
		}
	except Exception as exc:  # noqa: BLE001 - we translate every failure into a result row
		frappe.db.rollback(save_point=savepoint)
		code = _error_code_for(exc)
		message = str(exc) or exc.__class__.__name__
		frappe.log_error(frappe.get_traceback(), f"Maison submit_batch {offline_uuid} [{code}]")
		frappe.clear_messages()
		try:
			synclog.record(
				offline_uuid,
				"Error",
				boutique=payload.get("boutique"),
				device_id=payload.get("device_id"),
				payload=payload,
				error=message,
				error_code=code,
			)
		except Exception:  # pragma: no cover - logging must never break the batch
			frappe.log_error(frappe.get_traceback(), "Maison sync log write failed")
		result = {"offline_uuid": offline_uuid, "status": "error", "error": message, "error_code": code}
		extra = getattr(exc, "extra", None)
		if extra:
			result["details"] = extra
		return result


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
@frappe.whitelist()
def submit_batch(invoices: Any) -> dict[str, Any]:
	"""Submit a batch of POSInvoice payloads. Returns ``{results: [...]}`` (one per input, same order)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if isinstance(invoices, str):
		invoices = json.loads(invoices or "[]")
	if not isinstance(invoices, builtins.list):  # `list` is shadowed by the endpoint below
		frappe.throw(_("invoices must be a list"), frappe.ValidationError)
	if len(invoices) > 200:
		frappe.throw(_("Batch too large (max 200)"), frappe.ValidationError)

	results = [_process_one(payload or {}, i) for i, payload in enumerate(invoices)]
	return {"results": results}


@frappe.whitelist()
def list(boutique: str, date: Optional[str] = None) -> dict[str, Any]:  # noqa: A001 - name fixed by API contract
	"""Day summary for the X / Z report of *boutique* on *date* (default today)."""
	boutique = assert_boutique_access(boutique)
	date = getdate(date or nowdate())

	invoices = frappe.get_all(
		"Sales Invoice",
		filters={"maison_boutique": boutique, "posting_date": date, "docstatus": 1, "is_pos": 1},
		fields=[
			"name",
			"posting_time",
			"customer",
			"customer_name",
			"net_total",
			"total_taxes_and_charges",
			"grand_total",
			"rounded_total",
			"change_amount",
			"loyalty_amount",
			"is_return",
			"maison_associate",
			"maison_device_id",
			"maison_offline_uuid",
		],
		order_by="posting_time asc",
	)
	names = [i.name for i in invoices]
	payments = (
		frappe.get_all("Sales Invoice Payment", filters={"parent": ("in", names)}, fields=["parent", "mode_of_payment", "amount"])
		if names
		else []
	)
	item_counts = (
		frappe.get_all(
			"Sales Invoice Item",
			filters={"parent": ("in", names)},
			fields=["parent", "sum(qty) as qty"],
			group_by="parent",
		)
		if names
		else []
	)
	qty_by_inv = {r.parent: flt(r.qty) for r in item_counts}

	by_mode: dict[str, float] = {}
	pay_by_inv: dict[str, dict[str, float]] = {}
	for p in payments:
		by_mode[p.mode_of_payment] = by_mode.get(p.mode_of_payment, 0.0) + flt(p.amount)
		pay_by_inv.setdefault(p.parent, {})[p.mode_of_payment] = pay_by_inv.get(p.parent, {}).get(p.mode_of_payment, 0.0) + flt(p.amount)

	# cash in drawer = cash tendered - change given
	change_total = sum(flt(i.change_amount) for i in invoices)
	by_mode["Cash"] = by_mode.get("Cash", 0.0) - change_total

	by_associate: dict[str, dict[str, Any]] = {}
	sales = [i for i in invoices if not i.is_return]
	returns = [i for i in invoices if i.is_return]
	for i in invoices:
		a = by_associate.setdefault(i.maison_associate or "-", {"associate": i.maison_associate, "invoices": 0, "net": 0.0})
		a["invoices"] += 1
		a["net"] += flt(i.grand_total)

	net = sum(flt(i.grand_total) for i in invoices)
	return {
		"boutique": boutique,
		"date": str(date),
		"totals": {
			"invoices": len(sales),
			"returns": len(returns),
			"net_total": sum(flt(i.net_total) for i in invoices),
			"tax_total": sum(flt(i.total_taxes_and_charges) for i in invoices),
			"grand_total": net,
			"loyalty_redeemed": sum(flt(i.loyalty_amount) for i in invoices),
			"units": sum(qty_by_inv.get(i.name, 0.0) for i in invoices),
			"avg_ticket": (net / len(sales)) if sales else 0.0,
		},
		"by_mode_of_payment": by_mode,
		"by_associate": sorted(by_associate.values(), key=lambda a: -a["net"]),
		"invoices": [
			{
				"name": i.name,
				"time": str(i.posting_time),
				"customer": i.customer,
				"customer_name": i.customer_name,
				"grand_total": flt(i.grand_total),
				"is_return": int(i.is_return or 0),
				"associate": i.maison_associate,
				"device_id": i.maison_device_id,
				"offline_uuid": i.maison_offline_uuid,
				"payments": pay_by_inv.get(i.name, {}),
				"units": qty_by_inv.get(i.name, 0.0),
			}
			for i in invoices
		],
	}


@frappe.whitelist()
def void(invoice: str, reason: str) -> dict[str, Any]:
	"""Manager+: create and submit a POS Sales Return (credit note) against *invoice*."""
	if not is_manager_or_above():
		frappe.throw(_("Only managers may void invoices"), frappe.PermissionError)
	if not (reason or "").strip():
		frappe.throw(_("A reason is required to void an invoice"), frappe.ValidationError)

	src = frappe.get_doc("Sales Invoice", invoice)
	if src.docstatus != 1:
		frappe.throw(_("Only submitted invoices can be voided"), frappe.ValidationError)
	if src.is_return:
		frappe.throw(_("{0} is already a credit note").format(invoice), frappe.ValidationError)
	assert_boutique_access(src.get("maison_boutique"))

	existing = frappe.db.get_value("Sales Invoice", {"return_against": invoice, "docstatus": 1}, "name")
	if existing:
		return {"credit_note": existing, "already_voided": True}

	from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_sales_return

	cn = make_sales_return(invoice)
	cn.update(
		{
			"is_pos": 1,
			"update_stock": 1,
			"pos_profile": src.pos_profile,
			"maison_boutique": src.get("maison_boutique"),
			# v0.6 D3 — see events.sales_invoice.stamp_store: a return with no `set_warehouse`
			# slips past the per-user Warehouse User Permission
			"set_warehouse": src.get("set_warehouse") or frappe.db.get_value("Maison Boutique", src.get("maison_boutique"), "warehouse"),
			"maison_associate": frappe.db.get_value("Maison Associate", {"user": frappe.session.user}, "name"),
			"maison_notes": _("VOID: {0}").format(reason),
			"maison_offline_uuid": None,
			"maison_terminal_ref": src.get("maison_terminal_ref"),
		}
	)
	# refund through the same tenders, negative amounts
	if not cn.get("payments"):
		for p in src.payments:
			cn.append("payments", {"mode_of_payment": p.mode_of_payment, "account": p.account, "amount": -abs(flt(p.amount))})
	for p in cn.payments:
		p.amount = -abs(flt(p.amount))
	cn.flags.ignore_permissions = True
	cn.insert()
	cn.submit()
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Info",
			"reference_doctype": "Sales Invoice",
			"reference_name": invoice,
			"content": _("Voided via POS by {0}: {1} (credit note {2})").format(frappe.session.user, reason, cn.name),
		}
	).insert(ignore_permissions=True)
	return {"credit_note": cn.name}


@frappe.whitelist()
def get(invoice: str) -> dict[str, Any]:
	"""Return a submitted invoice (for reprint) if the caller may see its boutique."""
	doc = frappe.get_doc("Sales Invoice", invoice)
	assert_boutique_access(doc.get("maison_boutique"))
	return doc.as_dict()


# ---------------------------------------------------------------------------
# public receipt (QR on the printed receipt)
# ---------------------------------------------------------------------------
def get_invoice_by_token(token: str):
	"""Submitted (or cancelled) POS Sales Invoice for a receipt *token*; raises DoesNotExistError."""
	token = (token or "").strip()
	if not token or len(token) > 32:
		frappe.throw(_("Receipt not found"), frappe.DoesNotExistError)
	name = frappe.db.get_value("Sales Invoice", {"maison_receipt_token": token, "docstatus": ("in", (1, 2))}, "name")
	if not name:
		frappe.throw(_("Receipt not found"), frappe.DoesNotExistError)
	return frappe.get_doc("Sales Invoice", name)


@frappe.whitelist(allow_guest=True, methods=["GET"])
def receipt(token: str) -> dict[str, Any]:
	"""Guest endpoint: JSON receipt for the token printed in the receipt QR.

	Only data already on the paper receipt is returned (boutique, datetime, lines, totals,
	payment last4, masked client number and points) — never the customer's name or contact.
	"""
	doc = get_invoice_by_token(token)
	if not doc.get("is_pos"):
		frappe.throw(_("Receipt not found"), frappe.DoesNotExistError)
	return receipt_payload(doc)
