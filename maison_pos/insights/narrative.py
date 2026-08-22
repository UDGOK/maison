"""Weekly narrative: aggregated numbers → plain English (template, or Anthropic when configured).

The LLM only ever sees :func:`build_numbers` output — chain / boutique totals, item names and
counts. No client names, contact details or invoice-level data leave the site. When
``anthropic_api_key`` is missing, the call fails, or ``insights_narrative_llm`` is set to 0 in
``site_config.json``, :func:`template_narrative` renders the same numbers deterministically.
"""

from __future__ import annotations

import datetime as _dt
import json
from typing import Any, Optional

import frappe
from frappe.utils import add_days, cint, date_diff, flt, fmt_money, getdate, nowdate

DEFAULT_MODEL = "claude-sonnet-4-5"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


# ---------------------------------------------------------------------------
# numbers
# ---------------------------------------------------------------------------
def _totals(from_date: str, to_date: str, boutiques: list[str]) -> dict[str, dict[str, Any]]:
	SI = frappe.qb.DocType("Sales Invoice")
	SIP = frappe.qb.DocType("Sales Invoice Payment")
	from frappe.query_builder.functions import Count, Sum

	base = (SI.docstatus == 1) & (SI.is_pos == 1) & (SI.posting_date >= from_date) & (SI.posting_date <= to_date)
	if boutiques:
		base &= SI.maison_boutique.isin(boutiques)
	rows = (
		frappe.qb.from_(SI)
		.select(SI.maison_boutique.as_("boutique"), SI.is_return, Count(SI.name).as_("n"), Sum(SI.grand_total).as_("net"))
		.where(base)
		.groupby(SI.maison_boutique, SI.is_return)
	).run(as_dict=True)
	pays = (
		frappe.qb.from_(SIP)
		.join(SI)
		.on(SIP.parent == SI.name)
		.select(SI.maison_boutique.as_("boutique"), SIP.mode_of_payment, Sum(SIP.amount).as_("amount"))
		.where(base)
		.groupby(SI.maison_boutique, SIP.mode_of_payment)
	).run(as_dict=True)
	out: dict[str, dict[str, Any]] = {b: {"net": 0.0, "invoices": 0, "returns": 0, "returns_value": 0.0, "cash": 0.0, "card": 0.0} for b in boutiques}
	for r in rows:
		b = out.setdefault(r.boutique or "-", {"net": 0.0, "invoices": 0, "returns": 0, "returns_value": 0.0, "cash": 0.0, "card": 0.0})
		b["net"] += flt(r.net)
		if cint(r.is_return):
			b["returns"] += cint(r.n)
			b["returns_value"] += abs(flt(r.net))
		else:
			b["invoices"] += cint(r.n)
	for p in pays:
		b = out.get(p.boutique)
		if not b:
			continue
		if (p.mode_of_payment or "").lower() == "cash":
			b["cash"] += flt(p.amount)
		else:
			b["card"] += flt(p.amount)
	for b in out.values():
		b["net"] = round(b["net"], 2)
		b["avg_ticket"] = round(b["net"] / b["invoices"], 2) if b["invoices"] else 0.0
		paid = b["cash"] + b["card"]
		b["card_share"] = round(b["card"] / paid, 3) if paid else 0.0
	return out


def _top_items(from_date: str, to_date: str, boutiques: list[str], limit: int = 5) -> list[dict[str, Any]]:
	SI = frappe.qb.DocType("Sales Invoice")
	SII = frappe.qb.DocType("Sales Invoice Item")
	from frappe.query_builder.functions import Sum

	q = (
		frappe.qb.from_(SII)
		.join(SI)
		.on(SII.parent == SI.name)
		.select(SII.item_code, SII.item_name, Sum(SII.qty).as_("units"), Sum(SII.amount).as_("revenue"))
		.where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.posting_date >= from_date) & (SI.posting_date <= to_date))
		.groupby(SII.item_code, SII.item_name)
		.orderby(Sum(SII.amount), order=frappe.qb.desc)
		.limit(limit)
	)
	if boutiques:
		q = q.where(SI.maison_boutique.isin(boutiques))
	return [{"item_code": r.item_code, "item_name": r.item_name, "units": flt(r.units), "revenue": round(flt(r.revenue), 2)} for r in q.run(as_dict=True)]


def _new_clients(from_date: str, to_date: str) -> int:
	"""Clients whose first POS purchase falls in the period (not Customer.creation — seeds create in bulk)."""
	SI = frappe.qb.DocType("Sales Invoice")
	from frappe.query_builder.functions import Min

	walk_in = set(frappe.get_all("POS Profile", pluck="customer"))
	rows = (
		frappe.qb.from_(SI)
		.select(SI.customer, Min(SI.posting_date).as_("first"))
		.where((SI.docstatus == 1) & (SI.is_pos == 1) & (SI.is_return == 0))
		.groupby(SI.customer)
	).run(as_dict=True)
	return sum(1 for r in rows if r.customer and r.customer not in walk_in and str(from_date) <= str(r.first) <= str(to_date))


def _pct(cur: float, prev: float) -> Optional[float]:
	if not prev:
		return None
	return round((cur - prev) / abs(prev) * 100, 1)


def build_numbers(period_end: Optional[_dt.date] = None, days: int = 7) -> dict[str, Any]:
	"""Aggregates for the narrative: this period vs the previous one, per boutique + chain."""
	end = getdate(period_end or add_days(nowdate(), -1))
	start = add_days(end, -days + 1)
	prev_end = add_days(start, -1)
	prev_start = add_days(prev_end, -days + 1)
	boutiques = frappe.get_all("Maison Boutique", filters={"enabled": 1}, fields=["name", "boutique_name", "city"], order_by="name")
	codes = [b.name for b in boutiques]
	cur = _totals(str(start), str(end), codes)
	prev = _totals(str(prev_start), str(prev_end), codes)

	def chain(t: dict[str, dict[str, Any]]) -> dict[str, Any]:
		net = sum(v["net"] for v in t.values())
		inv = sum(v["invoices"] for v in t.values())
		cash = sum(v["cash"] for v in t.values())
		card = sum(v["card"] for v in t.values())
		return {
			"net": round(net, 2),
			"invoices": inv,
			"returns": sum(v["returns"] for v in t.values()),
			"returns_value": round(sum(v["returns_value"] for v in t.values()), 2),
			"avg_ticket": round(net / inv, 2) if inv else 0.0,
			"card_share": round(card / (cash + card), 3) if (cash + card) else 0.0,
		}

	c_cur, c_prev = chain(cur), chain(prev)
	per_b = []
	for b in boutiques:
		a, p = cur.get(b.name, {}), prev.get(b.name, {})
		per_b.append(
			{
				"boutique": b.name,
				"name": b.boutique_name,
				"city": b.city,
				"net": a.get("net", 0.0),
				"prev_net": p.get("net", 0.0),
				"change_pct": _pct(a.get("net", 0.0), p.get("net", 0.0)),
				"invoices": a.get("invoices", 0),
				"prev_invoices": p.get("invoices", 0),
				"avg_ticket": a.get("avg_ticket", 0.0),
				"returns": a.get("returns", 0),
				"card_share": a.get("card_share", 0.0),
			}
		)
	per_b.sort(key=lambda r: -r["net"])
	signals = frappe.get_all("Maison Client Signal", filters={"status": "Open"}, fields=["signal_type", "count(name) as n"], group_by="signal_type")
	rebalance = frappe.get_all("Maison Rebalance Suggestion", filters={"status": "Open"}, fields=["item_name", "from_boutique", "to_boutique", "qty", "value"], order_by="value desc", limit=5)
	new_clients = _new_clients(str(start), str(end))
	return {
		"period": {"from": str(start), "to": str(end), "days": days, "prev_from": str(prev_start), "prev_to": str(prev_end)},
		"chain": {**c_cur, "prev_net": c_prev["net"], "change_pct": _pct(c_cur["net"], c_prev["net"]), "prev_invoices": c_prev["invoices"], "prev_avg_ticket": c_prev["avg_ticket"]},
		"boutiques": per_b,
		"top_items": _top_items(str(start), str(end), codes),
		"client_signals": {r.signal_type: cint(r.n) for r in signals},
		"rebalance": rebalance,
		"new_clients": new_clients,
		"currency": frappe.get_cached_value("Company", frappe.defaults.get_global_default("company"), "default_currency") if frappe.defaults.get_global_default("company") else "USD",
	}


# ---------------------------------------------------------------------------
# template narrative
# ---------------------------------------------------------------------------
def _money(v: float, currency: str) -> str:
	symbol = (frappe.db.get_value("Currency", currency, "symbol", cache=True) if currency else "") or currency or ""
	return f"{symbol}{fmt_money(v, precision=0)}"


def _trend_word(pct: Optional[float]) -> str:
	if pct is None:
		return "with no prior-week comparison"
	if pct >= 15:
		return f"up strongly ({pct:+.0f}%)"
	if pct >= 3:
		return f"up {pct:+.0f}%"
	if pct > -3:
		return "flat week on week"
	if pct > -15:
		return f"down {pct:.0f}%"
	return f"down sharply ({pct:.0f}%)"


def template_narrative(numbers: dict[str, Any]) -> str:
	"""Deterministic plain-English summary of :func:`build_numbers`."""
	cur = numbers["currency"]
	c = numbers["chain"]
	p = numbers["period"]
	paras: list[str] = []
	paras.append(
		f"Week {p['from']} to {p['to']}: the chain took {_money(c['net'], cur)} across {c['invoices']} tickets, "
		f"{_trend_word(c['change_pct'])} against {_money(c['prev_net'], cur)} the week before. "
		f"Average ticket was {_money(c['avg_ticket'], cur)} and {round(c['card_share'] * 100)}% of tender went on card."
		+ (f" {c['returns']} return{'s were' if c['returns'] != 1 else ' was'} processed ({_money(c['returns_value'], cur)})." if c["returns"] else " No returns were processed.")
	)
	if numbers["boutiques"]:
		parts = []
		for b in numbers["boutiques"]:
			parts.append(f"{b['name']} ({b['boutique']}) {_money(b['net'], cur)} on {b['invoices']} tickets, {_trend_word(b['change_pct'])}")
		best = numbers["boutiques"][0]
		paras.append("By boutique: " + "; ".join(parts) + f". {best['name']} led the week.")
	if numbers["top_items"]:
		items = ", ".join(f"{t['item_name']} ({int(t['units'])} sold, {_money(t['revenue'], cur)})" for t in numbers["top_items"][:3])
		paras.append(f"Best sellers by revenue: {items}.")
	sig = numbers.get("client_signals") or {}
	if sig:
		total = sum(sig.values())
		detail = ", ".join(f"{n} {k.lower()}" for k, n in sorted(sig.items(), key=lambda kv: -kv[1]))
		paras.append(f"Clienteling: {total} client{'s' if total != 1 else ''} to contact this week — {detail}.")
	else:
		paras.append("Clienteling: no clients are flagged for contact this week.")
	reb = numbers.get("rebalance") or []
	if reb:
		moves = "; ".join(f"{int(r.qty)} × {r.item_name} from {r.from_boutique} to {r.to_boutique}" for r in reb[:3])
		paras.append(f"Stock: {len(reb)} rebalance suggestion{'s are' if len(reb) != 1 else ' is'} open, e.g. {moves}.")
	if numbers.get("new_clients"):
		paras.append(f"{numbers['new_clients']} new client{'s' if numbers['new_clients'] != 1 else ''} joined the book this week.")
	return "\n\n".join(paras)


# ---------------------------------------------------------------------------
# Anthropic narrative (optional)
# ---------------------------------------------------------------------------
def llm_config() -> Optional[dict[str, str]]:
	key = frappe.conf.get("anthropic_api_key")
	if not key or cint(frappe.conf.get("insights_narrative_llm", 1)) == 0:
		return None
	return {"api_key": key, "model": frappe.conf.get("anthropic_model") or DEFAULT_MODEL}


PROMPT = (
	"You are the retail analyst of Maison, a luxury jewellery house. Write the Monday morning summary for "
	"the head-office team from the JSON numbers below: 3 to 5 short paragraphs of plain English, no headings, "
	"no bullet points, no markdown. Lead with the chain result versus the previous week, then boutique "
	"differences worth a conversation, the best sellers, the clienteling list, and open stock rebalance "
	"suggestions. Be concrete with numbers (round them), be candid about declines, and never invent facts that "
	"are not in the data.\n\n"
)


def llm_narrative(numbers: dict[str, Any], config: dict[str, str]) -> str:
	import requests

	payload = {
		"model": config["model"],
		"max_tokens": 700,
		"messages": [{"role": "user", "content": PROMPT + json.dumps(numbers, default=str)}],
	}
	res = requests.post(
		ANTHROPIC_URL,
		headers={"x-api-key": config["api_key"], "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json"},
		json=payload,
		timeout=60,
	)
	res.raise_for_status()
	data = res.json()
	text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text").strip()
	if not text:
		raise ValueError("Empty narrative from the model")
	return text


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------
def generate_report(period_end: Optional[_dt.date] = None, days: int = 7, use_llm: Optional[bool] = None) -> "frappe.model.document.Document":
	"""Build numbers, write the narrative and store a ``Maison Insight Report`` (one per period)."""
	numbers = build_numbers(period_end, days)
	generator, model, error = "Template", None, None
	text = None
	cfg = llm_config() if use_llm is not False else None
	if cfg:
		try:
			text = llm_narrative(numbers, cfg)
			generator, model = "Anthropic", cfg["model"]
		except Exception as exc:  # fall back to the template; keep the error for the operator
			error = f"{type(exc).__name__}: {str(exc)[:300]}"
			frappe.log_error(frappe.get_traceback(), "Maison insights: Anthropic narrative failed")
	if not text:
		text = template_narrative(numbers)
	p = numbers["period"]
	existing = frappe.db.get_value("Maison Insight Report", {"period_start": p["from"], "period_end": p["to"], "kind": "Weekly"}, "name")
	doc = frappe.get_doc("Maison Insight Report", existing) if existing else frappe.new_doc("Maison Insight Report")
	doc.update(
		{
			"kind": "Weekly",
			"title": f"Week {p['from']} – {p['to']}",
			"period_start": p["from"],
			"period_end": p["to"],
			"narrative": text,
			"numbers": json.dumps(numbers, default=str, indent=1),
			"generator": generator,
			"model": model,
			"error": error,
			"net": numbers["chain"]["net"],
			"invoices": numbers["chain"]["invoices"],
			"change_pct": numbers["chain"]["change_pct"],
			"generated_at": frappe.utils.now_datetime(),
		}
	)
	doc.flags.ignore_permissions = True
	doc.save()
	return doc


def email_report(doc, recipients: Optional[list[str]] = None) -> list[str]:
	"""Send the narrative to every enabled user holding Maison Head Office."""
	if recipients is None:
		recipients = [
			r.parent
			for r in frappe.get_all("Has Role", filters={"role": "Maison Head Office", "parenttype": "User"}, fields=["parent"])
			if r.parent not in ("Administrator", "Guest") and frappe.db.get_value("User", r.parent, "enabled")
		]
	recipients = sorted(set(recipients))
	if not recipients:
		return []
	body = "".join(f"<p>{frappe.utils.escape_html(par)}</p>" for par in (doc.narrative or "").split("\n\n"))
	try:
		_send(doc, recipients, body)
	except Exception as exc:  # no outgoing account on a dev site, SMTP down, ...
		frappe.log_error(frappe.get_traceback(), "Maison insights: weekly e-mail failed")
		doc.db_set("error", ((doc.error + "\n") if doc.error else "") + f"E-mail not sent: {type(exc).__name__}: {str(exc)[:200]}", update_modified=False)
		return []
	doc.db_set("emailed_to", ", ".join(recipients), update_modified=False)
	doc.db_set("emailed_at", frappe.utils.now_datetime(), update_modified=False)
	return recipients


def _send(doc, recipients: list[str], body: str) -> None:
	frappe.sendmail(
		recipients=recipients,
		subject=f"Maison weekly insights — {doc.title}",
		message=f"<div style='font-family:Jost,Helvetica,Arial,sans-serif;max-width:640px'>{body}<p style='color:#7d7668;font-size:12px'>Generated by {doc.generator}{' · ' + doc.model if doc.model else ''} on {doc.generated_at}.</p></div>",
		reference_doctype="Maison Insight Report",
		reference_name=doc.name,
		delayed=False,
	)
