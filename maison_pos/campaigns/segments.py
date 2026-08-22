"""Segment builder (SPEC v0.5 §M): tier × boutique × item affinity × client signal → customers.

All criteria on a campaign are AND-ed; an empty criterion matches everyone. Walk-in customers
and clients who opted out of the campaign's channel (``do_not_email`` / ``do_not_sms`` on the
client profile) are always excluded. :func:`build_segment` returns rows ready for CSV export /
an Email Group / the outbound tool.
"""

from __future__ import annotations

from typing import Any, Optional

import frappe
from frappe.utils import add_months, cint, flt, nowdate

CHANNEL_OPT_OUT = {"Email": "do_not_email", "SMS": "do_not_sms", "Event": "do_not_phone", "Private viewing": "do_not_phone"}


def _walk_ins() -> set[str]:
	return {c for c in frappe.get_all("POS Profile", pluck="customer") if c}


def customer_tiers(customers: Optional[list[str]] = None) -> dict[str, Optional[str]]:
	"""Effective loyalty tier per customer in one grouped query (profile override wins)."""
	lp = frappe.get_all("Loyalty Program", fields=["name", "from_date"], limit=1)
	tiers: dict[str, Optional[str]] = {}
	if not lp:
		return tiers
	ladder = sorted(
		[(flt(r.min_spent), r.tier_name) for r in frappe.get_all("Loyalty Program Collection", filters={"parent": lp[0].name}, fields=["tier_name", "min_spent"])],
	)
	conds = ["docstatus = 1"]
	values: list[Any] = []
	if lp[0].from_date:
		conds.append("posting_date >= %s")
		values.append(lp[0].from_date)
	if customers is not None:
		if not customers:
			return tiers
		conds.append("customer in %s")
		values.append(tuple(customers))
	spent = frappe.db.sql(f"select customer, sum(base_grand_total) as spent from `tabSales Invoice` where {' and '.join(conds)} group by customer", values, as_dict=True)
	for r in spent:
		tier = None
		for min_spent, name in ladder:
			if flt(r.spent) >= min_spent:
				tier = name
		tiers[r.customer] = tier
	for r in frappe.get_all("Maison Client Profile", filters={"vip_tier_override": ("is", "set")}, fields=["name", "vip_tier_override"]):
		if customers is None or r.name in customers:
			tiers[r.name] = r.vip_tier_override
	return tiers


def last_boutique_map() -> dict[str, str]:
	"""customer -> boutique of the most recent POS sale."""
	rows = frappe.db.sql(
		"""select customer, maison_boutique from `tabSales Invoice`
		   where docstatus = 1 and is_pos = 1 and is_return = 0 and ifnull(maison_boutique, '') != ''
		   order by posting_date asc, posting_time asc""",
		as_dict=True,
	)
	return {r.customer: r.maison_boutique for r in rows}


def build_segment(campaign: Any, limit: Optional[int] = None) -> list[dict[str, Any]]:
	"""Customers matching the campaign's audience definition (see module doc)."""
	c = campaign if isinstance(campaign, dict) else frappe.get_doc("Maison Campaign", campaign).as_dict()
	walk_ins = _walk_ins()
	candidates: Optional[set[str]] = None

	def narrow(found: set[str]) -> None:
		nonlocal candidates
		candidates = found if candidates is None else candidates & found

	if c.get("segment_item") or c.get("segment_item_group"):
		conds = ["si.docstatus = 1", "si.is_return = 0", "si.posting_date >= %(since)s"]
		values: dict[str, Any] = {"since": add_months(nowdate(), -(cint(c.get("segment_months")) or 24))}
		if c.get("segment_item"):
			conds.append("sii.item_code = %(item)s")
			values["item"] = c["segment_item"]
		if c.get("segment_item_group"):
			conds.append("sii.item_group = %(group)s")
			values["group"] = c["segment_item_group"]
		narrow(
			set(
				frappe.db.sql(
					f"select distinct si.customer from `tabSales Invoice` si join `tabSales Invoice Item` sii on sii.parent = si.name where {' and '.join(conds)}",
					values,
					pluck="customer",
				)
			)
		)
	if c.get("segment_signal_type"):
		narrow(set(frappe.get_all("Maison Client Signal", filters={"signal_type": c["segment_signal_type"], "status": "Open"}, pluck="customer")))
	if c.get("segment_boutique"):
		preferred = set(frappe.get_all("Maison Client Profile", filters={"preferred_boutique": c["segment_boutique"]}, pluck="name"))
		last = {cust for cust, b in last_boutique_map().items() if b == c["segment_boutique"]}
		narrow(preferred | last)
	if c.get("segment_tier"):
		narrow({cust for cust, tier in customer_tiers(sorted(candidates) if candidates is not None else None).items() if tier == c["segment_tier"]})

	filters: dict[str, Any] = {"disabled": 0}
	if candidates is not None:
		if not candidates:
			return []
		filters["name"] = ("in", sorted(candidates))
	rows = frappe.get_all("Customer", filters=filters, fields=["name", "customer_name", "email_id", "mobile_no", "maison_client_number"], order_by="customer_name asc")
	rows = [r for r in rows if r.name not in walk_ins]

	opt_out_field = CHANNEL_OPT_OUT.get(c.get("channel") or "Email", "do_not_email")
	profiles = {p.name: p for p in frappe.get_all("Maison Client Profile", filters={"name": ("in", [r.name for r in rows])}, fields=["name", "preferred_boutique", "preferred_associate", opt_out_field])} if rows else {}
	tiers = customer_tiers([r.name for r in rows]) if rows else {}
	last = last_boutique_map()
	out = []
	for r in rows:
		p = profiles.get(r.name)
		if p and cint(p.get(opt_out_field)):
			continue
		if c.get("channel") == "Email" and not r.email_id:
			continue
		if c.get("channel") == "SMS" and not r.mobile_no:
			continue
		out.append(
			{
				"customer": r.name,
				"customer_name": r.customer_name,
				"email": r.email_id,
				"mobile": r.mobile_no,
				"client_number": r.maison_client_number,
				"tier": tiers.get(r.name),
				"boutique": (p.preferred_boutique if p and p.preferred_boutique else last.get(r.name)),
				"preferred_associate": p.preferred_associate if p else None,
			}
		)
	if limit:
		out = out[: cint(limit)]
	return out
