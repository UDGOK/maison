"""Attribution rules + nightly job (SPEC v0.5 §M).

Rule (per campaign windows, defaults 14 / 30 days; see :class:`AWANZCampaign`):

1. Candidate touches for a sale = the customer's touches whose *touch time* (latest of
   ``clicked_at`` / ``opened_at`` / ``sent_at`` that is not after the sale) lies within the
   campaign's **assisted window** before the sale. One candidate per campaign (the latest touch).
2. **Direct** (last-touch) = the most recent candidate inside its campaign's **direct window**.
3. **Item-level rule**: a candidate whose campaign *featured* a piece that is in the basket
   beats rule 2 (most recent such candidate wins, anywhere inside the assisted window) and is
   credited only for the featured lines (``item_level = 1``, ``amount`` = net of those lines).
4. Every other candidate becomes **Assisted** with the full invoice net (or, when it featured a
   basket item, the featured lines).

Touches without a matching rule window produce nothing ("none"). Returns (credit notes) are
never attributed; a cancelled invoice loses its rows on the next run.

:func:`attribute_invoice` is pure (no database) so the rules are unit-testable;
:func:`run_attribution` / :func:`nightly` do the I/O.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Iterable, Optional

import frappe
from frappe.utils import add_days, flt, get_datetime, getdate, now_datetime, nowdate

from maison_pos.awanz_pos.doctype.awanz_campaign.awanz_campaign import DEFAULT_ASSISTED_WINDOW_DAYS, DEFAULT_DIRECT_WINDOW_DAYS

DIRECT = "Direct"
ASSISTED = "Assisted"


# ---------------------------------------------------------------------------
# pure rules
# ---------------------------------------------------------------------------
def touch_time(touch: dict[str, Any], not_after: Optional[_dt.datetime] = None) -> Optional[_dt.datetime]:
	"""Latest engagement timestamp of a touch (click > open > send) that is not after *not_after*."""
	best = None
	for key in ("clicked_at", "opened_at", "sent_at"):
		ts = touch.get(key)
		if not ts:
			continue
		ts = get_datetime(ts)
		if not_after and ts > not_after:
			continue
		if best is None or ts > best:
			best = ts
	return best


def _window(campaign: dict[str, Any], key: str, default: int) -> int:
	return int(campaign.get(key) or default)


def attribute_invoice(
	invoice: dict[str, Any],
	touches: Iterable[dict[str, Any]],
	campaigns: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
	"""Apply the attribution rule to one sale.

	*invoice*: ``{name, customer, posting_datetime, net_total, items: [{item_code, net_amount}]}``
	*touches*: rows with ``name, campaign, sent_at, opened_at, clicked_at`` (any customer filter
	already applied). *campaigns*: ``{campaign_name: {direct_window_days, assisted_window_days,
	featured_items: set()}}``. Returns attribution rows (dicts) — ``[]`` when nothing applies.
	"""
	sale_ts = get_datetime(invoice["posting_datetime"])
	net_total = flt(invoice.get("net_total"))
	if net_total <= 0:
		return []
	basket: dict[str, float] = {}
	for line in invoice.get("items") or []:
		basket[line["item_code"]] = basket.get(line["item_code"], 0.0) + flt(line.get("net_amount"))

	# one candidate per campaign: the latest touch inside the assisted window
	candidates: dict[str, dict[str, Any]] = {}
	for t in touches:
		camp = campaigns.get(t.get("campaign"))
		if not camp:
			continue
		ts = touch_time(t, not_after=sale_ts)
		if ts is None:
			continue
		age_days = (sale_ts - ts).total_seconds() / 86400.0
		if age_days > _window(camp, "assisted_window_days", DEFAULT_ASSISTED_WINDOW_DAYS):
			continue
		featured = set(camp.get("featured_items") or ())
		in_basket = sorted(code for code in featured if code in basket)
		cand = {
			"campaign": t["campaign"],
			"touch": t.get("name"),
			"touch_at": ts,
			"days_to_sale": round(age_days, 3),
			"in_direct_window": age_days <= _window(camp, "direct_window_days", DEFAULT_DIRECT_WINDOW_DAYS),
			"item_level": bool(in_basket),
			"item_codes": in_basket,
			"amount": flt(sum(basket[c] for c in in_basket), 2) if in_basket else flt(net_total, 2),
		}
		prev = candidates.get(t["campaign"])
		if prev is None or ts > prev["touch_at"]:
			candidates[t["campaign"]] = cand
	if not candidates:
		return []

	ordered = sorted(candidates.values(), key=lambda c: c["touch_at"], reverse=True)
	direct = next((c for c in ordered if c["item_level"]), None) or next((c for c in ordered if c["in_direct_window"]), None)
	rows: list[dict[str, Any]] = []
	for c in ordered:
		rows.append(
			{
				"sales_invoice": invoice["name"],
				"customer": invoice.get("customer"),
				"campaign": c["campaign"],
				"touch": c["touch"],
				"type": DIRECT if c is direct else ASSISTED,
				"amount": c["amount"],
				"invoice_total": flt(net_total, 2),
				"item_level": 1 if c["item_level"] else 0,
				"item_codes": ", ".join(c["item_codes"]) or None,
				"touch_at": c["touch_at"],
				"days_to_sale": c["days_to_sale"],
			}
		)
	return rows


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------
def campaign_meta(names: Optional[Iterable[str]] = None) -> dict[str, dict[str, Any]]:
	"""``{campaign: {direct_window_days, assisted_window_days, featured_items}}``."""
	filters: dict[str, Any] = {}
	if names is not None:
		filters["name"] = ("in", list(names))
	meta = {
		r.name: {"direct_window_days": r.direct_window_days, "assisted_window_days": r.assisted_window_days, "featured_items": set(), "channel": r.channel, "title": r.title}
		for r in frappe.get_all("AWANZ Campaign", filters=filters, fields=["name", "title", "channel", "direct_window_days", "assisted_window_days"])
	}
	if meta:
		for r in frappe.get_all("AWANZ Campaign Item", filters={"parent": ("in", list(meta))}, fields=["parent", "item_code"]):
			meta[r.parent]["featured_items"].add(r.item_code)
	return meta


def max_window_days(meta: dict[str, dict[str, Any]]) -> int:
	return max([_window(m, "assisted_window_days", DEFAULT_ASSISTED_WINDOW_DAYS) for m in meta.values()] + [DEFAULT_ASSISTED_WINDOW_DAYS])


def _walk_in_customers() -> set[str]:
	return {c for c in frappe.get_all("POS Profile", pluck="customer") if c}


def invoices_for_window(from_date, to_date, customers: Optional[set[str]] = None) -> list[dict[str, Any]]:
	filters: dict[str, Any] = {"docstatus": 1, "is_pos": 1, "is_return": 0, "posting_date": ("between", (from_date, to_date)), "customer": ("is", "set")}
	if customers is not None:
		if not customers:
			return []
		filters["customer"] = ("in", sorted(customers))
	rows = frappe.get_all(
		"Sales Invoice",
		filters=filters,
		fields=["name", "customer", "posting_date", "posting_time", "base_net_total", "maison_boutique", "maison_associate"],
		order_by="posting_date asc, posting_time asc",
	)
	walk_ins = _walk_in_customers()
	rows = [r for r in rows if r.customer not in walk_ins]
	if not rows:
		return []
	lines: dict[str, list[dict[str, Any]]] = {}
	for li in frappe.get_all("Sales Invoice Item", filters={"parent": ("in", [r.name for r in rows])}, fields=["parent", "item_code", "base_net_amount"]):
		lines.setdefault(li.parent, []).append({"item_code": li.item_code, "net_amount": flt(li.base_net_amount)})
	out = []
	for r in rows:
		out.append(
			{
				"name": r.name,
				"customer": r.customer,
				"posting_datetime": _dt.datetime.combine(getdate(r.posting_date), (r.posting_time if isinstance(r.posting_time, _dt.time) else get_datetime(f"{r.posting_date} {r.posting_time or '00:00:00'}").time())),
				"posting_date": r.posting_date,
				"net_total": flt(r.base_net_total),
				"boutique": r.maison_boutique,
				"associate": r.maison_associate,
				"items": lines.get(r.name, []),
			}
		)
	return out


def touches_for(customers: Iterable[str], campaigns: Optional[Iterable[str]] = None) -> dict[str, list[dict[str, Any]]]:
	customers = list(customers)
	if not customers:
		return {}
	filters: dict[str, Any] = {"customer": ("in", customers)}
	if campaigns is not None:
		filters["campaign"] = ("in", list(campaigns))
	out: dict[str, list[dict[str, Any]]] = {}
	for t in frappe.get_all("AWANZ Campaign Touch", filters=filters, fields=["name", "campaign", "customer", "sent_at", "opened_at", "clicked_at"]):
		out.setdefault(t.customer, []).append(t)
	return out


def run_attribution(from_date=None, to_date=None, campaign: Optional[str] = None, commit: bool = False) -> dict[str, Any]:
	"""(Re)compute ``AWANZ Campaign Attribution`` for the sales in the window (idempotent).

	Default window: today minus the longest assisted window (+1 day grace) … today. Existing rows
	for the invoices in the window (and for cancelled invoices) are replaced.
	"""
	meta = campaign_meta([campaign] if campaign else None)
	to_date = getdate(to_date or nowdate())
	from_date = getdate(from_date) if from_date else add_days(to_date, -(max_window_days(meta) + 1))
	computed_at = now_datetime()
	summary: dict[str, Any] = {"from_date": str(from_date), "to_date": str(to_date), "invoices": 0, "attributed_invoices": 0, "rows": 0, "direct": 0, "assisted": 0, "campaigns": {}}
	if not meta:
		return summary

	touched_customers = {t.customer for t in frappe.get_all("AWANZ Campaign Touch", filters={"campaign": ("in", list(meta))}, fields=["customer"], distinct=True)}
	invoices = invoices_for_window(from_date, to_date, touched_customers)
	summary["invoices"] = len(invoices)
	touches = touches_for({i["customer"] for i in invoices}, meta)

	# replace rows for the invoices in this window (+ drop rows of cancelled / deleted invoices)
	del_filters: dict[str, Any] = {"posting_date": ("between", (from_date, to_date))}
	if campaign:
		del_filters["campaign"] = campaign
	frappe.db.delete("AWANZ Campaign Attribution", del_filters)
	stale = frappe.db.sql(
		"""select a.name from `tabAWANZ Campaign Attribution` a
		   left join `tabSales Invoice` si on si.name = a.sales_invoice
		   where si.name is null or si.docstatus != 1""",
		pluck="name",
	)
	if stale:
		frappe.db.delete("AWANZ Campaign Attribution", {"name": ("in", stale)})

	for inv in invoices:
		rows = attribute_invoice(inv, touches.get(inv["customer"], []), meta)
		if not rows:
			continue
		summary["attributed_invoices"] += 1
		for row in rows:
			row.update({"doctype": "AWANZ Campaign Attribution", "posting_date": inv["posting_date"], "boutique": inv["boutique"], "associate": inv["associate"], "computed_at": computed_at})
			frappe.get_doc(row).insert(ignore_permissions=True)
			summary["rows"] += 1
			summary["direct" if row["type"] == DIRECT else "assisted"] += 1
			c = summary["campaigns"].setdefault(row["campaign"], {"direct": 0.0, "assisted": 0.0, "rows": 0})
			c["rows"] += 1
			c["direct" if row["type"] == DIRECT else "assisted"] = flt(c["direct" if row["type"] == DIRECT else "assisted"] + row["amount"], 2)

	refresh_campaign_stats(list(meta), computed_at)
	if commit:
		frappe.db.commit()
	return summary


def refresh_campaign_stats(campaigns: Iterable[str], computed_at=None) -> None:
	"""Denormalised counters on the campaign (sends / opens / clicks / attributed revenue / buyers)."""
	computed_at = computed_at or now_datetime()
	for name in campaigns:
		touches = frappe.db.sql(
			"""select count(*) as sends, sum(opened_at is not null) as opens, sum(clicked_at is not null) as clicks
			   from `tabAWANZ Campaign Touch` where campaign = %s""",
			name,
			as_dict=True,
		)[0]
		attr = frappe.db.sql(
			"""select sum(case when type='Direct' then amount else 0 end) as direct,
			          sum(case when type='Assisted' then amount else 0 end) as assisted,
			          count(distinct customer) as buyers
			   from `tabAWANZ Campaign Attribution` where campaign = %s""",
			name,
			as_dict=True,
		)[0]
		frappe.db.set_value(
			"AWANZ Campaign",
			name,
			{
				"sends": int(touches.sends or 0),
				"opens": int(touches.opens or 0),
				"clicks": int(touches.clicks or 0),
				"attributed_direct": flt(attr.direct, 2),
				"attributed_assisted": flt(attr.assisted, 2),
				"buyers": int(attr.buyers or 0),
				"last_attributed_at": computed_at,
			},
			update_modified=False,
		)


def nightly() -> dict[str, Any]:
	"""Scheduler entry point (daily): rolling window = longest assisted window + 1 day."""
	return run_attribution(commit=True)
