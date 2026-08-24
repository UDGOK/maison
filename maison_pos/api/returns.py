"""Itemized returns & exchanges (v0.4 section E).

* ``lookup`` finds the original sale (invoice no, receipt QR token or client) and reports, per
  line, what is still returnable (qty and serial numbers not yet returned).
* ``return_items`` creates and submits a Sales Invoice credit note (``is_return=1``,
  ``update_stock=1``) for the selected lines only. Serialized pieces go back to the selling
  warehouse when *Sellable*, to the boutique's *Damaged* warehouse otherwise. The refund is
  posted through the original tender: ``card`` refunds the Stripe PaymentIntent stored in
  ``maison_terminal_ref`` (simulated when no key), ``cash`` pays out of the drawer,
  ``store_credit`` leaves the credit note unallocated (the customer's credit balance).
  ERPNext nets the loyalty points of the original sale (negative Loyalty Point Entry) and the
  commission is reversed through ``maison_pos.api.hr.reverse_commission`` when that module
  exists (feature-detected).
* ``exchange`` = one credit note + one new POS sale in a single call; the value of the returned
  lines is carried to the new sale through the ``Exchange Credit`` tender so only the
  difference moves as cash / card.
* A manager PIN is required above ``returns_manager_threshold`` and outside the policy window.
"""

from __future__ import annotations

import builtins
import json
import uuid
from typing import Any, Optional

import frappe
from frappe import _
from frappe.utils import cint, date_diff, flt, getdate, now_datetime, nowdate

from maison_pos.api.sales import (
	ERR_NOT_FOUND,
	ERR_PAYMENT,
	ERR_PERMISSION,
	ERR_VALIDATION,
	MaisonPOSError,
	_split_serials,
	_validate_payments_cover_total,
	build_sales_invoice,
	check_serials_available,
	get_invoice_by_token,
)
from maison_pos.identifiers import new_receipt_token
from maison_pos.maison_pos.doctype.maison_pos_settings.maison_pos_settings import get_operations_settings
from maison_pos.scoping import ALL_MAISON_ROLES, assert_boutique_access, assert_roles, get_associate, is_manager_or_above
from maison_pos.stripe_terminal import client as stripe_client
from maison_pos.utils import receipt_payload

REASONS = ("Change of mind", "Defect", "Sizing", "Gift return", "Other")
CONDITIONS = ("Sellable", "Damaged")
REFUND_METHODS = ("card", "cash", "store_credit", "exchange")
EXCHANGE_MOP = "Exchange Credit"
ERR_MANAGER_REQUIRED = "MANAGER_REQUIRED"


class ManagerRequiredError(MaisonPOSError):
	error_code = ERR_MANAGER_REQUIRED


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _serials_of_row(row) -> list[str]:
	if row.get("serial_no"):
		return _split_serials(row.serial_no)
	if row.get("serial_and_batch_bundle"):
		return [s for s in frappe.get_all("Serial and Batch Entry", filters={"parent": row.serial_and_batch_bundle}, pluck="serial_no") if s]
	return []


def _credit_notes(invoice: str) -> list[str]:
	return frappe.get_all("Sales Invoice", filters={"return_against": invoice, "docstatus": 1, "is_return": 1}, pluck="name", order_by="creation")


def _returned_by_row(invoice: str) -> dict[str, dict[str, Any]]:
	"""``{source row name: {qty, serials[]}}`` already returned through submitted credit notes."""
	out: dict[str, dict[str, Any]] = {}
	notes = _credit_notes(invoice)
	if not notes:
		return out
	for cn in notes:
		doc = frappe.get_doc("Sales Invoice", cn)
		for row in doc.items:
			key = row.get("sales_invoice_item") or row.item_code
			entry = out.setdefault(key, {"qty": 0.0, "serials": []})
			entry["qty"] += abs(flt(row.qty))
			entry["serials"].extend(_serials_of_row(row))
	return out


def _invoice_lookup_row(doc) -> dict[str, Any]:
	ops = get_operations_settings()
	returned = _returned_by_row(doc.name)
	days = date_diff(nowdate(), doc.posting_date)
	taxable = {r.name: cint(r.maison_taxable) for r in frappe.get_all("Item", filters={"name": ("in", [i.item_code for i in doc.items])}, fields=["name", "maison_taxable"])}
	lines = []
	for row in doc.items:
		sold_serials = _serials_of_row(row)
		ret = returned.get(row.name) or returned.get(row.item_code) or {"qty": 0.0, "serials": []}
		remaining_serials = [s for s in sold_serials if s not in ret["serials"]]
		lines.append(
			{
				"row": row.name,
				"item_code": row.item_code,
				"item_name": row.item_name,
				"qty": flt(row.qty),
				"rate": flt(row.rate),
				"amount": flt(row.amount),
				"discount_amount": flt(row.get("discount_amount")),
				"serials": sold_serials,
				"returned_qty": flt(ret["qty"]),
				"returned_serials": ret["serials"],
				"returnable_qty": max(flt(row.qty) - flt(ret["qty"]), 0.0),
				"returnable_serials": remaining_serials,
				"taxable": taxable.get(row.item_code, 1),
				"is_stock_item": cint(frappe.get_cached_value("Item", row.item_code, "is_stock_item")),
			}
		)
	payments = [{"mode_of_payment": p.mode_of_payment, "amount": flt(p.amount)} for p in doc.payments if flt(p.amount)]
	tax_rate = sum(flt(t.rate) for t in doc.taxes if t.charge_type == "On Net Total")
	return {
		"name": doc.name,
		"posting_date": str(doc.posting_date),
		"posting_datetime": f"{doc.posting_date}T{doc.posting_time}",
		"boutique": doc.get("maison_boutique"),
		"associate": doc.get("maison_associate"),
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"currency": doc.currency,
		"net_total": flt(doc.net_total),
		"total_taxes": flt(doc.total_taxes_and_charges),
		"tax_rate": tax_rate,
		"grand_total": flt(doc.rounded_total or doc.grand_total),
		"loyalty_amount": flt(doc.get("loyalty_amount")),
		"payments": payments,
		"terminal_ref": doc.get("maison_terminal_ref"),
		"card_brand": doc.get("maison_card_brand"),
		"card_last4": doc.get("maison_card_last4"),
		"receipt_token": doc.get("maison_receipt_token"),
		"days_since": days,
		"within_return_window": days <= ops["return_window_days"],
		"within_exchange_window": days <= ops["exchange_window_days"],
		"return_window_days": ops["return_window_days"],
		"exchange_window_days": ops["exchange_window_days"],
		"manager_threshold": ops["returns_manager_threshold"],
		"credit_notes": _credit_notes(doc.name),
		"fully_returned": all(l["returnable_qty"] <= 0 for l in lines),
		"lines": lines,
	}


def _normalize_lines(lines: Any) -> list[dict[str, Any]]:
	if isinstance(lines, str):
		lines = json.loads(lines or "[]")
	if not isinstance(lines, builtins.list) or not lines:
		raise MaisonPOSError(_("Select at least one line to return"))
	out = []
	for raw in lines:
		if not isinstance(raw, dict) or not raw.get("item_code"):
			raise MaisonPOSError(_("Each return line needs an item_code"))
		serials = _split_serials(raw.get("serial_no") or raw.get("serials"))
		qty = flt(raw.get("qty") or (len(serials) if serials else 1))
		if serials and len(serials) != cint(qty):
			raise MaisonPOSError(_("{0}: quantity {1} does not match {2} serial number(s)").format(raw["item_code"], qty, len(serials)))
		if qty <= 0:
			raise MaisonPOSError(_("{0}: return quantity must be positive").format(raw["item_code"]))
		reason = raw.get("reason") or "Other"
		if reason not in REASONS:
			raise MaisonPOSError(_("Unknown return reason {0}").format(reason))
		condition = raw.get("condition") or "Sellable"
		if condition not in CONDITIONS:
			raise MaisonPOSError(_("Unknown condition {0}").format(condition))
		out.append({"row": raw.get("row"), "item_code": raw["item_code"], "qty": qty, "serials": serials, "reason": reason, "condition": condition})
	return out


def _verify_manager(boutique: str, manager: Optional[str], manager_pin: Optional[str], amount: float, why: str) -> Optional[str]:
	"""Return the approving Maison Associate name, or raise ``ManagerRequiredError``.

	A caller who is already a manager (or unrestricted) approves implicitly.
	"""
	if is_manager_or_above():
		assoc = get_associate()
		return assoc["name"] if assoc else None
	if not manager or not manager_pin:
		raise ManagerRequiredError(_("Manager approval required: {0}").format(why), amount=amount, reason=why)
	row = frappe.db.get_value("Maison Associate", manager, ["name", "boutique", "role", "enabled"], as_dict=True)
	if not row or not row.enabled or row.role not in ("Manager", "Regional", "HeadOffice"):
		raise ManagerRequiredError(_("{0} is not a manager").format(manager), amount=amount, reason=why)
	if row.role == "Manager" and row.boutique != boutique:
		raise ManagerRequiredError(_("{0} manages another boutique").format(manager), amount=amount, reason=why)
	doc = frappe.get_doc("Maison Associate", manager)
	if not doc.verify_pin(str(manager_pin)):
		raise ManagerRequiredError(_("Manager PIN incorrect"), amount=amount, reason=why)
	return doc.name


def _damaged_warehouse(boutique: str, company: str) -> str:
	wh = frappe.db.get_value("Maison Boutique", boutique, "damaged_warehouse")
	if wh:
		return wh
	# lazily create "<code> Damaged" under All Warehouses
	abbr = frappe.get_cached_value("Company", company, "abbr")
	name = f"{boutique} Damaged - {abbr}"
	if not frappe.db.exists("Warehouse", name):
		doc = frappe.get_doc({"doctype": "Warehouse", "warehouse_name": f"{boutique} Damaged", "company": company, "parent_warehouse": f"All Warehouses - {abbr}"})
		doc.flags.ignore_permissions = True
		doc.insert(ignore_if_duplicate=True)
		name = doc.name
	frappe.db.set_value("Maison Boutique", boutique, "damaged_warehouse", name, update_modified=False)
	frappe.clear_document_cache("Maison Boutique", boutique)
	return name


def ensure_exchange_mode_of_payment(company: str) -> str:
	"""``Exchange Credit`` tender (type General) posting to a clearing liability account; nets to zero per exchange."""
	abbr = frappe.get_cached_value("Company", company, "abbr")
	account = f"Exchange Clearing - {abbr}"
	if not frappe.db.exists("Account", account):
		parent = frappe.db.get_value("Account", {"company": company, "account_type": "Current Liability", "is_group": 1}, "name") or frappe.db.get_value(
			"Account", {"company": company, "root_type": "Liability", "is_group": 1}, "name", order_by="lft"
		)
		acc = frappe.get_doc({"doctype": "Account", "account_name": "Exchange Clearing", "company": company, "parent_account": parent, "account_type": "Current Liability", "is_group": 0})
		acc.flags.ignore_permissions = True
		acc.insert(ignore_if_duplicate=True)
		account = acc.name
	if not frappe.db.exists("Mode of Payment", EXCHANGE_MOP):
		mop = frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": EXCHANGE_MOP, "type": "General", "enabled": 1, "accounts": [{"company": company, "default_account": account}]})
		mop.flags.ignore_permissions = True
		mop.insert(ignore_if_duplicate=True)
	elif not frappe.db.exists("Mode of Payment Account", {"parent": EXCHANGE_MOP, "company": company}):
		mop = frappe.get_doc("Mode of Payment", EXCHANGE_MOP)
		mop.append("accounts", {"company": company, "default_account": account})
		mop.flags.ignore_permissions = True
		mop.save()
	return EXCHANGE_MOP


def _reverse_commission(credit_note, original) -> Optional[dict[str, Any]]:
	"""Feature-detected hook into the HR module (section C): reverse the commission of the returned lines."""
	try:
		from maison_pos.api import hr  # type: ignore
	except Exception:
		return None
	fn = getattr(hr, "reverse_commission", None)
	if not callable(fn):
		return None
	try:
		return fn(original.name, credit_note=credit_note.name) if "credit_note" in fn.__code__.co_varnames else fn(original.name)
	except TypeError:
		return fn(original.name)
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"Maison commission reversal {credit_note.name}")
		return None


# --- v0.8 QA B3 — returning a sale whose points have already been spent -------------------------
#
# ERPNext refuses the credit note outright once any of the points the sale earned have been
# redeemed on a later sale ("Sales Invoice can't be cancelled since the Loyalty Points earned has
# been redeemed. First cancel the Sales Invoice No …"), so the counter could not refund the client
# at all and the message pointed at an unrelated invoice.
#
# The return is now taken in two steps: the credit note is submitted with no `loyalty_program` —
# the field ERPNext's rebuild branch reads — and the points the returned goods earned are clawed
# back explicitly against the client's live balance (`api/rewards.claw_back_points`). When the
# client has already spent them there is nothing to take back: that is a money decision, so it
# asks for a manager exactly like an over-threshold refund does, and the result says what happened.
# ------------------------------------------------------------------------------------------------
def _loyalty_context(src, cn) -> Optional[dict[str, Any]]:
	"""``{program, customer, company, points, shortfall}`` when this return needs the B3 path."""
	from maison_pos.api import rewards

	program = src.get("loyalty_program")
	if not program or not src.get("customer") or rewards.is_walk_in(src.customer):
		return None
	if not rewards.redemptions_against_sale(src.name):
		return None  # ERPNext can rebuild the accrual itself, as it always has
	accrual = rewards.accrual_entry(src.name)
	company = (accrual or {}).get("company") or src.company
	returned_net = sum(abs(flt(row.qty)) * flt(row.rate) for row in cn.get("items") or [])
	points = rewards.points_for_amount(program, returned_net)
	if accrual:
		# never claw back more than this sale ever granted, less what earlier returns took
		taken = abs(
			cint(
				frappe.db.get_value(
					"Loyalty Point Entry",
					{"redeem_against": accrual["name"], "invoice": ("in", _credit_notes(src.name) or ["__none__"])},
					"sum(loyalty_points)",
				)
				or 0
			)
		)
		points = min(points, max(0, cint(accrual["loyalty_points"]) - taken))
	balance = rewards.available_points(src.customer, program, company)
	return {
		"program": program,
		"customer": src.customer,
		"company": company,
		"points": cint(points),
		"shortfall": max(0, cint(points) - cint(balance)),
		"balance": cint(balance),
	}


def _settle_loyalty_after_return(cn, src, ctx: dict[str, Any]) -> dict[str, Any]:
	from maison_pos.api import rewards

	try:
		result = rewards.claw_back_points(
			ctx["customer"], ctx["program"], ctx["company"], ctx["points"], invoice=cn.name, posting_date=cn.posting_date
		)
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"Maison loyalty claw-back {cn.name}")
		return {"points_clawed_back": 0, "points_shortfall": ctx["points"], "error": True}
	return {
		"points_clawed_back": cint(result["clawed_back"]),
		"points_shortfall": cint(result["shortfall"]),
		"points_settled_manually": True,
	}
# --- end v0.8 QA B3 ---


# ---------------------------------------------------------------------------
# credit note builder (shared by return_items / exchange)
# ---------------------------------------------------------------------------
def _build_credit_note(src, lines: list[dict[str, Any]], boutique: str, reason: Optional[str], condition_notes: str) -> tuple[Any, float]:
	"""Unsaved credit note limited to *lines*; returns ``(doc, credit_total_estimate)``.

	Sellable serialized pieces return to the selling warehouse, Damaged ones to the boutique's
	Damaged warehouse. Non-stock (service) lines are refunded without stock movement.
	"""
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_sales_return

	cn = make_sales_return(src.name)
	mapped = {row.get("sales_invoice_item"): row for row in cn.items}
	keep = []
	damaged_wh = None
	for sel in lines:
		src_row = None
		if sel.get("row") and sel["row"] in mapped:
			src_row = mapped[sel["row"]]
		else:
			for key, row in mapped.items():
				if row.item_code == sel["item_code"] and row not in keep and abs(flt(row.qty)) >= sel["qty"]:
					src_row = row
					break
		if src_row is None:
			raise MaisonPOSError(_("{0}: nothing left to return on {1}").format(sel["item_code"], src.name), ERR_NOT_FOUND)
		if src_row.item_code != sel["item_code"]:
			raise MaisonPOSError(_("Line {0} is {1}, not {2}").format(sel.get("row"), src_row.item_code, sel["item_code"]))
		returnable_qty = abs(flt(src_row.qty))
		if sel["qty"] > returnable_qty + 1e-9:
			raise MaisonPOSError(_("{0}: only {1} left to return").format(sel["item_code"], returnable_qty))
		available_serials = _split_serials(src_row.get("serial_no"))
		has_serial = cint(frappe.get_cached_value("Item", sel["item_code"], "has_serial_no"))
		if has_serial:
			if not sel["serials"]:
				if len(available_serials) == cint(sel["qty"]):
					sel["serials"] = available_serials
				else:
					raise MaisonPOSError(_("{0}: serial number(s) required").format(sel["item_code"]))
			bad = [s for s in sel["serials"] if s not in available_serials]
			if bad:
				raise MaisonPOSError(_("Serial {0} was not sold on {1} (or is already returned)").format(", ".join(bad), src.name), ERR_NOT_FOUND, serials=bad)
			src_row.use_serial_batch_fields = 1
			src_row.serial_no = "\n".join(sel["serials"])
		src_row.qty = -abs(flt(sel["qty"]))
		src_row.stock_qty = src_row.qty
		src_row.maison_return_reason = sel["reason"]
		src_row.maison_return_condition = sel["condition"]
		if sel["condition"] == "Damaged" and cint(frappe.get_cached_value("Item", sel["item_code"], "is_stock_item")):
			damaged_wh = damaged_wh or _damaged_warehouse(boutique, src.company)
			src_row.warehouse = damaged_wh
		keep.append(src_row)
	cn.items = []
	for i, row in enumerate(keep, start=1):
		row.idx = i
		cn.append("items", row)
	cn.set("payments", [])
	cn.update(
		{
			"update_stock": 1,
			# v0.6 D3 — `make_sales_return` blanks `set_warehouse`; a credit note with no warehouse
			# escapes the per-user Warehouse User Permission, which is how other stores' returns
			# became listable over `frappe.client.get_list`. Put the store's selling warehouse
			# back (a Damaged line still routes to the damaged warehouse on the row itself, and
			# ERPNext re-clears the header field when the rows disagree — `events.sales_invoice.
			# stamp_store` restores it in `before_submit`). `maison_pos.scoping.sales_invoice_query`
			# scopes the list independently of this stamp.
			"set_warehouse": frappe.db.get_value("Maison Boutique", boutique, "warehouse"),
			"pos_profile": src.pos_profile,
			"maison_boutique": boutique,
			"maison_associate": (get_associate() or {}).get("name"),
			"maison_notes": condition_notes,
			"maison_offline_uuid": None,
			"maison_receipt_token": None,
			"maison_terminal_ref": src.get("maison_terminal_ref"),
			"maison_card_brand": src.get("maison_card_brand"),
			"maison_card_last4": src.get("maison_card_last4"),
			"maison_return_reason": reason or (lines[0]["reason"] if lines else None),
			"set_posting_time": 1,
			"posting_date": nowdate(),
			"posting_time": now_datetime().strftime("%H:%M:%S"),
			"due_date": nowdate(),
		}
	)
	cn.flags.maison_pos = True
	cn.flags.ignore_permissions = True
	# estimate the credit (net of tax) before ERPNext computes it for real
	tax_rate = sum(flt(t.rate) for t in src.taxes if t.charge_type == "On Net Total")
	est = 0.0
	for row in keep:
		net = abs(flt(row.qty)) * flt(row.rate)
		taxable = cint(frappe.get_cached_value("Item", row.item_code, "maison_taxable"))
		est += net + (net * tax_rate / 100 if taxable else 0)
	return cn, round(est, 2)


def _refund_payments(cn, src, method: str, amount: float) -> dict[str, Any]:
	"""Append the negative tender rows and perform the Stripe refund for card."""
	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	amount = abs(flt(amount))
	info: dict[str, Any] = {"method": method, "amount": amount}
	if method == "store_credit":
		# unallocated credit note: no tender rows, outstanding stays as the client's credit
		cn.is_pos = 0
		cn.maison_refund_method = "Store Credit"
		return info
	if method == "card":
		pi = src.get("maison_terminal_ref")
		if not pi:
			raise MaisonPOSError(_("{0} was not paid by card on this terminal; refund in cash or as store credit").format(src.name), ERR_PAYMENT)
		card_paid = sum(flt(p.amount) for p in src.payments if (p.mode_of_payment or "").lower() != "cash")
		already = sum(
			abs(flt(p.amount))
			for cn_name in _credit_notes(src.name)
			for p in frappe.get_doc("Sales Invoice", cn_name).payments
			if (p.mode_of_payment or "").lower() == "card"
		)
		if amount > card_paid - already + 0.005:
			raise MaisonPOSError(_("Card refund {0} exceeds the amount charged to the card ({1} left)").format(amount, round(card_paid - already, 2)), ERR_PAYMENT)
		mop = "Card"
	else:
		mop = "Cash"
	account = (get_bank_cash_account(mop, cn.company) or {}).get("account")
	cn.is_pos = 1
	cn.append("payments", {"mode_of_payment": mop, "account": account, "amount": -amount})
	cn.maison_refund_method = mop
	return info


def _do_card_refund(cn, src, amount: float, reason: Optional[str]) -> None:
	from maison_pos.api.stripe_terminal import to_minor

	res = stripe_client.refund(src.get("maison_terminal_ref"), to_minor(amount, cn.currency), reason=reason, idempotency_key=f"maison-refund-{cn.name}")
	cn.db_set("maison_refund_id", res.get("id"), update_modified=False)


def _finalize_credit_note(cn, src, approver: Optional[str], refund_method: str, refund_amount: float, reason: Optional[str], loyalty: Optional[dict[str, Any]] = None) -> dict[str, Any]:
	"""Validate tenders, submit, refund the card, reverse commission, log on the original sale.

	Returns the loyalty outcome (v0.8 QA B3) so the caller can report it.
	"""
	if cn.is_pos:
		_validate_return_payments(cn)
	cn.maison_manager_approved_by = approver
	cn.maison_receipt_token = new_receipt_token()
	if loyalty:
		# v0.8 QA B3: ERPNext skips its (impossible) rebuild when the credit note carries no
		# programme; the points are settled explicitly below. `loyalty_program` is `fetch_from`
		# the customer, and Frappe does not re-fetch a submitted document's fields, so clearing
		# it here sticks through `submit()`.
		cn.loyalty_program = None
	cn.submit()
	outcome: dict[str, Any] = {}
	if loyalty:
		outcome = _settle_loyalty_after_return(cn, src, loyalty)
	if refund_method == "card" and refund_amount > 0:
		_do_card_refund(cn, src, refund_amount, reason)
	_reverse_commission(cn, src)
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Info",
			"reference_doctype": "Sales Invoice",
			"reference_name": src.name,
			"content": _("Return {0} ({1}) via POS by {2}: {3}").format(cn.name, refund_method, frappe.session.user, reason or "")
			+ (
				_(" · {0} loyalty point(s) taken back, {1} could not be recovered (already spent)").format(outcome.get("points_clawed_back"), outcome["points_shortfall"])
				if outcome.get("points_shortfall")
				else (_(" · {0} loyalty point(s) taken back").format(outcome["points_clawed_back"]) if outcome.get("points_clawed_back") else "")
			),
		}
	).insert(ignore_permissions=True)
	return outcome


def _validate_return_payments(cn) -> None:
	total = abs(flt(cn.rounded_total or cn.grand_total))
	paid = abs(sum(flt(p.amount) for p in cn.payments))
	if abs(paid - total) > 0.01:
		raise MaisonPOSError(_("Refund tenders ({0}) do not match the credit note total ({1})").format(paid, total), ERR_PAYMENT, paid=paid, total=total)


def _result(cn, src, extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
	cn = frappe.get_doc("Sales Invoice", cn.name)
	out = {
		"credit_note": cn.name,
		"return_against": src.name,
		"grand_total": flt(cn.rounded_total or cn.grand_total),
		"net_total": flt(cn.net_total),
		"total_taxes": flt(cn.total_taxes_and_charges),
		"refund_method": cn.get("maison_refund_method"),
		"refund_id": cn.get("maison_refund_id"),
		"receipt_token": cn.get("maison_receipt_token"),
		"payments": [{"mode_of_payment": p.mode_of_payment, "amount": flt(p.amount)} for p in cn.payments],
		"lines": [
			{"item_code": r.item_code, "item_name": r.item_name, "qty": flt(r.qty), "rate": flt(r.rate), "amount": flt(r.amount), "serials": _serials_of_row(r), "warehouse": r.warehouse, "reason": r.get("maison_return_reason"), "condition": r.get("maison_return_condition")}
			for r in cn.items
		],
		"loyalty_points_reversed": _points_reversed(src.name),
		"receipt": receipt_payload(cn),
	}
	out.update(extra or {})
	return out


def _points_reversed(invoice: str) -> float:
	"""Points the original sale now yields less than before (ERPNext recomputes the entry net of returns)."""
	return flt(frappe.db.get_value("Loyalty Point Entry", {"invoice": invoice, "redeem_against": ("is", "not set")}, "loyalty_points"))


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
@frappe.whitelist()
def lookup(invoice: Optional[str] = None, token: Optional[str] = None, customer: Optional[str] = None, q: Optional[str] = None, limit: int = 10) -> dict[str, Any]:
	"""Find returnable sales: by invoice name, receipt QR token (``/r/<token>`` URL accepted) or client.

	Returns ``{invoices: [...]}``; each entry lists lines with ``returnable_qty`` / ``returnable_serials``.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	docs = []
	if token:
		t = token.strip()
		if "/r/" in t:
			t = t.rsplit("/r/", 1)[1].split("?")[0].strip("/")
		doc = get_invoice_by_token(t)
		docs = [doc]
	elif invoice:
		name = invoice.strip()
		if not frappe.db.exists("Sales Invoice", name):
			name = frappe.db.get_value("Sales Invoice", {"name": ("like", f"%{name}%"), "docstatus": 1, "is_pos": 1, "is_return": 0}, "name", order_by="creation desc")
		if not name:
			frappe.throw(_("Invoice {0} not found").format(invoice), frappe.DoesNotExistError)
		docs = [frappe.get_doc("Sales Invoice", name)]
	elif customer or q:
		filters: dict[str, Any] = {"docstatus": 1, "is_pos": 1, "is_return": 0}
		if customer:
			filters["customer"] = customer
		else:
			from maison_pos.api.customers import search as customer_search

			hits = customer_search(q, limit=5)
			names = [h["name"] for h in hits]
			if not names:
				return {"invoices": []}
			filters["customer"] = ("in", names)
		rows = frappe.get_all("Sales Invoice", filters=filters, pluck="name", order_by="posting_date desc, posting_time desc", limit=cint(limit) or 10)
		docs = [frappe.get_doc("Sales Invoice", n) for n in rows]
	else:
		frappe.throw(_("Pass invoice, token or customer"), frappe.ValidationError)

	out = []
	for doc in docs:
		if doc.docstatus != 1 or not doc.get("is_pos") or doc.get("is_return"):
			continue
		try:
			assert_boutique_access(doc.get("maison_boutique"))
		except frappe.PermissionError:
			if invoice or token:
				raise
			continue
		out.append(_invoice_lookup_row(doc))
	return {"invoices": out}


@frappe.whitelist()
def return_items(
	invoice: str,
	lines: Any,
	refund_method: str = "cash",
	reason: Optional[str] = None,
	manager: Optional[str] = None,
	manager_pin: Optional[str] = None,
	device_id: Optional[str] = None,
	notes: Optional[str] = None,
) -> dict[str, Any]:
	"""Create + submit a credit note for *lines* of *invoice* and refund through *refund_method*.

	``lines``: ``[{item_code, qty, serial_no?, row?, reason, condition}]``. ``refund_method`` ∈
	``card`` / ``cash`` / ``store_credit``. Raises ``ManagerRequiredError`` (``MANAGER_REQUIRED``)
	when the refund exceeds the manager threshold or the policy window and no valid manager PIN
	was supplied.
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if refund_method not in ("card", "cash", "store_credit"):
		raise MaisonPOSError(_("refund_method must be card, cash or store_credit"))
	src = frappe.get_doc("Sales Invoice", invoice)
	if src.docstatus != 1 or not src.get("is_pos") or src.get("is_return"):
		raise MaisonPOSError(_("{0} is not a submitted POS sale").format(invoice), ERR_NOT_FOUND)
	boutique = assert_boutique_access(src.get("maison_boutique"))
	sel = _normalize_lines(lines)
	ops = get_operations_settings()

	cn, estimate = _build_credit_note(src, sel, boutique, reason, notes or _("Return: {0}").format(reason or sel[0]["reason"]))
	days = date_diff(nowdate(), src.posting_date)
	why = None
	if days > ops["return_window_days"]:
		why = _("sale is {0} days old (policy {1})").format(days, ops["return_window_days"])
	elif estimate > flt(ops["returns_manager_threshold"]):
		why = _("refund {0} is above the manager threshold {1}").format(estimate, ops["returns_manager_threshold"])
	# --- v0.8 QA B3 — points already spent are a write-off, so a manager signs for them ---
	loyalty = _loyalty_context(src, cn)
	if not why and loyalty and loyalty["shortfall"]:
		why = _("the client has already spent {0} of the {1} points this sale earned — the refund goes through, the points cannot be taken back").format(
			loyalty["shortfall"], loyalty["points"]
		)
	# --- end v0.8 QA B3 ---
	approver = _verify_manager(boutique, manager, manager_pin, estimate, why) if why else ((get_associate() or {}).get("name") if is_manager_or_above() else None)

	# ERPNext computes totals on insert; the tender row needs the final total, so insert first.
	cn.is_pos = 1 if refund_method != "store_credit" else 0
	cn.insert()
	refund_amount = abs(flt(cn.rounded_total or cn.grand_total))
	cn.set("payments", [])
	_refund_payments(cn, src, refund_method, refund_amount)
	cn.maison_device_id = device_id
	cn.save()
	outcome = _finalize_credit_note(cn, src, approver, refund_method, refund_amount, reason, loyalty)
	return _result(cn, src, {"manager_approved_by": approver, "simulated_refund": not stripe_client.is_configured(), **outcome})


@frappe.whitelist()
def exchange(
	invoice: str,
	lines: Any,
	new_items: Any,
	payments: Any = None,
	refund_method: str = "cash",
	reason: Optional[str] = None,
	manager: Optional[str] = None,
	manager_pin: Optional[str] = None,
	offline_uuid: Optional[str] = None,
	device_id: Optional[str] = None,
	customer: Optional[str] = None,
	notes: Optional[str] = None,
) -> dict[str, Any]:
	"""Return *lines* of *invoice* and sell *new_items* in one transaction.

	The credit (value of the returned lines) is carried into the new sale as the
	``Exchange Credit`` tender. If the new sale costs more, *payments* (``[{mode_of_payment,
	amount, stripe_payment_intent?}]``) must cover the difference; if it costs less, the
	remainder is refunded through *refund_method* (``cash`` / ``card`` / ``store_credit``).
	Returns the credit note, the new invoice and the settled ``difference`` (> 0 = client paid).
	"""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	if isinstance(new_items, str):
		new_items = json.loads(new_items or "[]")
	if isinstance(payments, str):
		payments = json.loads(payments or "[]")
	payments = payments or []
	if not new_items:
		raise MaisonPOSError(_("An exchange needs at least one new item"))
	src = frappe.get_doc("Sales Invoice", invoice)
	if src.docstatus != 1 or not src.get("is_pos") or src.get("is_return"):
		raise MaisonPOSError(_("{0} is not a submitted POS sale").format(invoice), ERR_NOT_FOUND)
	boutique = assert_boutique_access(src.get("maison_boutique"))
	b = frappe.get_cached_doc("Maison Boutique", boutique)
	sel = _normalize_lines(lines)
	ops = get_operations_settings()
	ensure_exchange_mode_of_payment(src.company)

	cn, estimate = _build_credit_note(src, sel, boutique, reason, notes or _("Exchange: {0}").format(reason or sel[0]["reason"]))
	days = date_diff(nowdate(), src.posting_date)
	why = None
	if days > ops["exchange_window_days"]:
		why = _("sale is {0} days old (exchange policy {1})").format(days, ops["exchange_window_days"])
	elif estimate > flt(ops["returns_manager_threshold"]):
		why = _("exchange credit {0} is above the manager threshold {1}").format(estimate, ops["returns_manager_threshold"])
	# --- v0.8 QA B3 — same pre-check as a return: an exchange also cancels the earned points ---
	loyalty = _loyalty_context(src, cn)
	if not why and loyalty and loyalty["shortfall"]:
		why = _("the client has already spent {0} of the {1} points this sale earned — the exchange goes through, the points cannot be taken back").format(
			loyalty["shortfall"], loyalty["points"]
		)
	# --- end v0.8 QA B3 ---
	approver = _verify_manager(boutique, manager, manager_pin, estimate, why) if why else ((get_associate() or {}).get("name") if is_manager_or_above() else None)

	# 1) credit note (inserted to learn the exact credit)
	cn.is_pos = 1
	cn.insert()
	credit = abs(flt(cn.rounded_total or cn.grand_total))

	# 2) new sale: build through the regular POS path so taxes / serials / loyalty behave identically
	check_serials_available(new_items, b.warehouse)
	uuid_ = offline_uuid or f"xchg-{uuid.uuid4()}"
	payload = {
		"offline_uuid": uuid_,
		"boutique": boutique,
		"associate": (get_associate() or {}).get("name"),
		"device_id": device_id,
		"customer": customer or src.customer,
		"posting_datetime": now_datetime().isoformat(),
		"items": new_items,
		"payments": [{"mode_of_payment": EXCHANGE_MOP, "amount": 1}],  # placeholder, replaced below
		# v0.8 POS D8 — the pair is recorded here rather than in a second Link field (see below)
		"notes": _("Exchange against {0} · credit note {1}").format(src.name, cn.name),
	}
	new_si = build_sales_invoice(payload, boutique)
	new_si.flags.ignore_permissions = True
	new_si.set("payments", [])
	new_si.insert()  # totals computed
	new_total = flt(new_si.rounded_total or new_si.grand_total)
	applied = round(min(credit, new_total), 2)
	difference = round(new_total - credit, 2)

	from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

	xacct = (get_bank_cash_account(EXCHANGE_MOP, src.company) or {}).get("account")
	new_si.set("payments", [])
	if applied > 0:
		new_si.append("payments", {"mode_of_payment": EXCHANGE_MOP, "account": xacct, "amount": applied})
	if difference > 0.005:
		paid = sum(flt(p.get("amount")) for p in payments)
		if paid + 0.005 < difference:
			raise MaisonPOSError(_("Payments ({0}) do not cover the exchange difference ({1})").format(paid, difference), ERR_PAYMENT, paid=paid, due=difference)
		for p in payments:
			mop = p.get("mode_of_payment")
			if not mop or not frappe.db.exists("Mode of Payment", mop):
				raise MaisonPOSError(_("Unknown mode of payment {0}").format(mop), ERR_PAYMENT)
			new_si.append("payments", {"mode_of_payment": mop, "account": (get_bank_cash_account(mop, src.company) or {}).get("account"), "amount": flt(p.get("amount"))})
			if p.get("stripe_payment_intent"):
				new_si.maison_terminal_ref = p.get("stripe_payment_intent")
				new_si.maison_card_brand = p.get("card_brand")
				new_si.maison_card_last4 = p.get("last4")
				new_si.maison_approval_code = p.get("approval_code")
	new_si.save()
	_validate_payments_cover_total(new_si)
	# --- v0.8 POS D8 — the exchange link is one-directional ---
	# Writing `maison_exchange_invoice` on *both* documents made them point at each other, and
	# Frappe then refused to cancel either one (`LinkExistsError`, each naming the other): an
	# exchange booked in error could only be neutralised by voiding, which adds a third document.
	# The credit note keeps the pointer (it is the row the Returns history lists and the return
	# receipt prints); the new sale records the pair in its notes instead of in a Link field.
	# `events.sales_invoice.unlink_exchange_pair` additionally clears a surviving pointer when the
	# document it names is cancelled, so either half can be cancelled first.
	# --- end v0.8 POS D8 ---
	new_si.submit()

	# 3) credit note tenders: exchange credit applied + remainder refunded
	cn.set("payments", [])
	cn.is_pos = 1
	if applied > 0:
		cn.append("payments", {"mode_of_payment": EXCHANGE_MOP, "account": xacct, "amount": -applied})
	remainder = round(credit - applied, 2)
	refund_info = None
	if remainder > 0.005 and refund_method != "store_credit":
		refund_info = _refund_payments(cn, src, refund_method, remainder)
	# store_credit remainder: the unpaid part of the credit note stays outstanding (client credit)
	cn.maison_refund_method = "Exchange" if not refund_info else cn.maison_refund_method
	cn.maison_device_id = device_id
	cn.maison_exchange_invoice = new_si.name
	cn.save()
	if refund_info or remainder <= 0.005:
		_validate_return_payments(cn)
	cn.maison_manager_approved_by = approver
	cn.maison_receipt_token = new_receipt_token()
	if loyalty:
		cn.loyalty_program = None  # v0.8 QA B3 (see `_finalize_credit_note`)
	cn.submit()
	loyalty_outcome = _settle_loyalty_after_return(cn, src, loyalty) if loyalty else {}
	if refund_info and refund_method == "card" and remainder > 0:
		_do_card_refund(cn, src, remainder, reason)
	_reverse_commission(cn, src)
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Info",
			"reference_doctype": "Sales Invoice",
			"reference_name": src.name,
			"content": _("Exchange via POS by {0}: credit note {1}, new sale {2}, difference {3}").format(frappe.session.user, cn.name, new_si.name, difference),
		}
	).insert(ignore_permissions=True)
	new_si = frappe.get_doc("Sales Invoice", new_si.name)
	return _result(
		cn,
		src,
		{
			"new_invoice": new_si.name,
			"new_grand_total": new_total,
			"credit": credit,
			"applied": applied,
			"difference": difference,
			"refund_remainder": remainder,
			"new_receipt_token": new_si.get("maison_receipt_token"),
			**loyalty_outcome,
			"new_receipt": receipt_payload(new_si),
			"new_payments": [{"mode_of_payment": p.mode_of_payment, "amount": flt(p.amount)} for p in new_si.payments],
			"manager_approved_by": approver,
			"simulated_refund": not stripe_client.is_configured(),
		},
	)


@frappe.whitelist()
def policy(boutique: Optional[str] = None) -> dict[str, Any]:
	"""Return / exchange policy (windows, manager threshold, reasons, conditions) for the POS."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	ops = get_operations_settings()
	return {**ops, "reasons": list(REASONS), "conditions": list(CONDITIONS), "refund_methods": list(REFUND_METHODS), "stripe_configured": stripe_client.is_configured()}


@frappe.whitelist()
def recent(boutique: Optional[str] = None, limit: int = 20) -> dict[str, Any]:
	"""Latest credit notes of the boutique (Returns screen history)."""
	assert_roles(*ALL_MAISON_ROLES, "System Manager")
	boutique = assert_boutique_access(boutique)
	rows = frappe.get_all(
		"Sales Invoice",
		filters={"maison_boutique": boutique, "is_return": 1, "docstatus": 1},
		fields=["name", "posting_date", "posting_time", "return_against", "customer_name", "grand_total", "maison_refund_method", "maison_return_reason", "maison_exchange_invoice", "maison_receipt_token"],
		order_by="posting_date desc, posting_time desc",
		limit=cint(limit) or 20,
	)
	for r in rows:
		r["grand_total"] = flt(r.grand_total)
		r["posting_time"] = str(r.posting_time)
	return {"boutique": boutique, "returns": rows}
