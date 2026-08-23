"""Idempotent repairs for an already-seeded site (System Manager only).

Two operations that the v0.6 cloud verification asked for, both callable over the API so a
managed host such as Frappe Cloud can be fixed without shell access:

* :func:`reset_walk_in_loyalty` — clears the rewards state that a loyalty programme flagged
  ``auto_opt_in`` accreted on the POS-Profile default customer (defect D5).
* :func:`set_site_timezone` — moves a seeded site to another time zone *safely*: set the zone,
  re-base the opening stock, then prove that nothing is left dated in the future.

::

    bench --site cloudchaserz.frappe.cloud execute maison_pos.setup.repair.reset_walk_in_loyalty
    bench --site cloudchaserz.frappe.cloud execute maison_pos.setup.repair.set_site_timezone \\
        --kwargs "{'tz': 'America/Chicago'}"
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

import frappe
from frappe.utils import cint, get_time, getdate, now_datetime


def _assert_system_manager() -> None:
	if "System Manager" not in frappe.get_roles():
		frappe.throw("Only System Managers may run repairs", frappe.PermissionError)


# ---------------------------------------------------------------------------
# D5 — the walk-in placeholder is not a rewards member
# ---------------------------------------------------------------------------
def walk_in_customers() -> list[str]:
	"""Every placeholder client: the default customer of any POS Profile + "Walk-in *" names."""
	names = {c for c in frappe.get_all("POS Profile", pluck="customer") if c}
	names.update(frappe.get_all("Customer", filters={"customer_name": ("like", "Walk-in%")}, pluck="name"))
	return sorted(names)


@frappe.whitelist()
def reset_walk_in_loyalty(commit: int = 1) -> dict[str, Any]:
	"""Strip the rewards state from every walk-in placeholder client. Idempotent.

	ERPNext enrols any customer that appears on an invoice into a loyalty programme flagged
	``auto_opt_in``, so the POS-Profile default customer became a member and accrued a point per
	dollar on every anonymous basket (61,045 points ≈ $3,052 redeemable on the seeded
	CloudChaserz site). The code path is now guarded (``maison_pos.events.customer``,
	``maison_pos.events.sales_invoice``, ``maison_pos.api.rewards``); this repairs the rows that
	already exist:

    * ``Customer.loyalty_program`` / ``.loyalty_program_tier`` / ``.maison_client_number`` cleared;
    * every ``Loyalty Point Entry`` of the placeholder deleted (accruals and redemptions);
    * ``Sales Invoice.loyalty_program`` unstamped on its invoices, so a later credit note cannot
      make ERPNext re-create the accrual.

	Returns ``{customers, points_before, entries_deleted, invoices_unstamped}``.
	"""
	_assert_system_manager()
	names = walk_in_customers()
	out: dict[str, Any] = {"customers": names, "points_before": 0, "entries_deleted": 0, "invoices_unstamped": 0, "programs_cleared": 0}
	if not names:
		return out

	out["points_before"] = int(
		frappe.db.sql(
			"select coalesce(sum(loyalty_points), 0) from `tabLoyalty Point Entry` where customer in %(n)s",
			{"n": tuple(names)},
		)[0][0]
		or 0
	)
	out["entries_deleted"] = frappe.db.count("Loyalty Point Entry", {"customer": ("in", names)})
	frappe.db.delete("Loyalty Point Entry", {"customer": ("in", names)})

	invoices = frappe.get_all(
		"Sales Invoice",
		filters={"customer": ("in", names), "loyalty_program": ("is", "set")},
		pluck="name",
		limit_page_length=0,
	)
	for invoice in invoices:
		frappe.db.set_value(
			"Sales Invoice",
			invoice,
			{"loyalty_program": None, "loyalty_points": 0, "loyalty_amount": 0, "redeem_loyalty_points": 0},
			update_modified=False,
		)
	out["invoices_unstamped"] = len(invoices)

	for name in names:
		row = frappe.db.get_value("Customer", name, ["loyalty_program", "maison_client_number"], as_dict=True) or {}
		if row.get("loyalty_program") or row.get("maison_client_number"):
			out["programs_cleared"] += 1
		frappe.db.set_value(
			"Customer",
			name,
			{"loyalty_program": None, "loyalty_program_tier": None, "maison_client_number": None},
			update_modified=False,
		)

	if cint(commit):
		frappe.db.commit()
	return out


# ---------------------------------------------------------------------------
# Time zone — moving a seeded site without breaking it
# ---------------------------------------------------------------------------
def _known_timezones() -> set[str]:
	try:
		from zoneinfo import available_timezones

		return available_timezones()
	except Exception:  # pragma: no cover — very old Python / no tzdata
		import pytz

		return set(pytz.all_timezones)


def _future_documents(now: _dt.datetime) -> dict[str, list[str]]:
	"""Submitted stock / sales documents dated after *now* (site time)."""
	day, clock = now.date(), now.strftime("%H:%M:%S")
	out: dict[str, list[str]] = {}
	for doctype in ("Stock Entry", "Sales Invoice"):
		out[doctype] = frappe.db.sql_list(
			f"""select name from `tab{doctype}`
			where docstatus = 1 and (posting_date > %(d)s or (posting_date = %(d)s and posting_time > %(t)s))""",
			{"d": day, "t": clock},
		)
	out["Stock Ledger Entry"] = frappe.db.sql_list(
		"""select name from `tabStock Ledger Entry`
		where is_cancelled = 0 and (posting_date > %(d)s or (posting_date = %(d)s and posting_time > %(t)s))""",
		{"d": day, "t": clock},
	)
	return out


def _future_vouchers(now: _dt.datetime) -> list[tuple[str, str]]:
	"""Every submitted document that is dated after *now*, plus whatever wrote a future ledger row."""
	future = _future_documents(now)
	targets: list[tuple[str, str]] = []
	seen: set[tuple[str, str]] = set()
	for doctype in ("Stock Entry", "Sales Invoice"):
		for name in future[doctype]:
			if (doctype, name) not in seen:
				seen.add((doctype, name))
				targets.append((doctype, name))
	day, clock = now.date(), now.strftime("%H:%M:%S")
	rows = frappe.db.sql(
		"""select distinct voucher_type, voucher_no from `tabStock Ledger Entry`
		where is_cancelled = 0 and (posting_date > %(d)s or (posting_date = %(d)s and posting_time > %(t)s))""",
		{"d": day, "t": clock},
	)
	for voucher_type, voucher_no in rows:
		if (voucher_type, voucher_no) not in seen:
			seen.add((voucher_type, voucher_no))
			targets.append((voucher_type, voucher_no))
	return targets


def _clamp_document(doctype: str, name: str, target: _dt.datetime) -> bool:
	"""Move a submitted document (and its ledgers) back to *target*; repost valuation from there.

	Used for Stock Entries and Sales Invoices — the two things a time-zone move leaves in the
	future — but written generically so any posting-dated voucher that wrote a Stock Ledger Entry
	is repaired. Moving a document *earlier* never invalidates a later one, and the repost runs
	with ``allow_negative_stock`` so the intermediate window cannot throw.
	"""
	from erpnext.accounts.utils import get_fiscal_year
	from erpnext.stock.stock_ledger import update_entries_after

	meta = frappe.get_meta(doctype)
	if not (meta.has_field("posting_date") and meta.has_field("posting_time")):
		return False
	doc = frappe.get_doc(doctype, name)
	old = _dt.datetime.combine(getdate(doc.posting_date), get_time(doc.posting_time))
	posting_date, posting_time = target.strftime("%Y-%m-%d"), target.strftime("%H:%M:%S")
	values: dict[str, Any] = {"posting_date": posting_date, "posting_time": posting_time}
	if meta.has_field("set_posting_time"):
		values["set_posting_time"] = 1
	frappe.db.set_value(doctype, name, values, update_modified=False)

	frappe.db.sql(
		"""update `tabStock Ledger Entry` set posting_date=%s, posting_time=%s, posting_datetime=%s
		where voucher_type=%s and voucher_no=%s""",
		(posting_date, posting_time, target, doctype, name),
	)
	frappe.db.sql(
		"update `tabSerial and Batch Bundle` set posting_datetime=%s where voucher_type=%s and voucher_no=%s",
		(target, doctype, name),
	)
	try:
		fiscal_year = get_fiscal_year(posting_date, company=doc.get("company"))[0]
		frappe.db.sql(
			"update `tabGL Entry` set posting_date=%s, fiscal_year=%s where voucher_type=%s and voucher_no=%s",
			(posting_date, fiscal_year, doctype, name),
		)
	except Exception:
		frappe.clear_messages()
	if frappe.db.table_exists("Payment Ledger Entry"):
		frappe.db.sql(
			"update `tabPayment Ledger Entry` set posting_date=%s where voucher_type=%s and voucher_no=%s",
			(posting_date, doctype, name),
		)

	repost_from = min(old, target)
	pairs = set()
	for row in doc.get("items") or []:
		for field in ("t_warehouse", "s_warehouse", "warehouse"):
			if row.get(field):
				pairs.add((row.get("item_code"), row.get(field)))
	for item_code, warehouse in pairs:
		update_entries_after(
			{
				"item_code": item_code,
				"warehouse": warehouse,
				"posting_date": repost_from.strftime("%Y-%m-%d"),
				"posting_time": repost_from.strftime("%H:%M:%S"),
			},
			allow_negative_stock=True,
		)
	return True


@frappe.whitelist()
def set_site_timezone(tz: str, rebase: int = 1, commit: int = 1) -> dict[str, Any]:
	"""Move a seeded site to *tz* safely (System Manager only). Idempotent.

	Re-timezoning a site **after** the stock and the history were seeded is what broke the first
	cloud run: the seed posts the opening-stock receipts at "now", and moving the site west (say
	``Asia/Kolkata`` → ``America/Chicago``, −11:30) leaves those receipts dated in the *future*,
	after which every POS sale is refused with ``NegativeStockError`` /
	``SerialNoExistsInFutureTransactionError``. Do all three steps in one go:

	1. set ``System Settings.time_zone`` (validated against the tz database) and clear the cache;
	2. run the existing :func:`maison_pos.setup.demo.rebase_stock`, which back-dates the demo
	   opening stock (against the CloudChaserz globals when that seed is present);
	3. clamp anything still dated after the new wall clock back to it, and **verify**: the
	   returned ``future`` block must be empty, otherwise ``ok`` is ``False`` and the names of
	   the offending documents are listed.

	Returns ``{time_zone, previous, rebase, clamped, future, ok}``.
	"""
	_assert_system_manager()
	tz = (tz or "").strip()
	if tz not in _known_timezones():
		frappe.throw(f"Unknown time zone {tz!r}", frappe.ValidationError)

	previous = frappe.db.get_single_value("System Settings", "time_zone")
	frappe.db.set_single_value("System Settings", "time_zone", tz)
	frappe.clear_cache()
	frappe.local.conf.time_zone = tz  # the current request keeps its own cached copy

	out: dict[str, Any] = {"time_zone": tz, "previous": previous, "rebase": None, "clamped": [], "future": {}, "ok": True}

	if cint(rebase):
		from maison_pos.setup import demo

		try:
			from maison_pos.setup import cloudchaserz

			seeded = cloudchaserz.is_seeded()
		except Exception:
			cloudchaserz, seeded = None, False
		if seeded and cloudchaserz is not None:
			with cloudchaserz.profile_globals():
				out["rebase"] = demo.rebase_stock(commit=False)
		else:
			out["rebase"] = demo.rebase_stock(commit=False)

	# Anything that is still ahead of the new wall clock is pulled back to it. Two passes: the
	# first moves the vouchers, the second catches a ledger row whose voucher had already been
	# clamped (a return against an invoice moved in the same pass, for instance).
	for _pass in range(2):
		now = now_datetime()
		targets = _future_vouchers(now)
		if not targets:
			break
		clamp_to = now - _dt.timedelta(minutes=1)
		for doctype, name in targets:
			if _clamp_document(doctype, name, clamp_to):
				out["clamped"].append(f"{doctype} {name}")

	out["future"] = {k: v for k, v in _future_documents(now_datetime()).items() if v}
	out["ok"] = not out["future"]
	if cint(commit):
		frappe.db.commit()
	return out


@frappe.whitelist()
def site_timezone_status() -> dict[str, Any]:
	"""``{time_zone, now, future}`` — a read-only check an operator can run before/after a move."""
	_assert_system_manager()
	now = now_datetime()
	return {
		"time_zone": frappe.db.get_single_value("System Settings", "time_zone"),
		"now": str(now),
		"future": {k: len(v) for k, v in _future_documents(now).items()},
	}


@frappe.whitelist()
def redraw_catalog_art(commit: int = 1) -> dict[str, Any]:
	"""Regenerate the placeholder product art in place (System Manager only). Idempotent.

	The v0.6 polish pass stopped burning the brand / name / group into the generated
	SVGs so the storefront hero overlay is the only caption. Existing sites keep their
	file URLs — the SVG bytes are rewritten, nothing is re-attached.
	"""
	_assert_system_manager()
	from maison_pos.setup.cloudchaserz import catalog

	count = catalog.ensure_images(redraw=True)
	if cint(commit):
		frappe.db.commit()
	return {"redrawn": count}
