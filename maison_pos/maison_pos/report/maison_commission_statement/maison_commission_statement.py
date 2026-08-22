"""Maison Commission Statement — totals per associate (or every entry with *detail*)."""

from __future__ import annotations

import frappe
from frappe import _

from maison_pos.api.hr import commission_statement


def execute(filters=None):
	filters = frappe._dict(filters or {})
	data = commission_statement(filters.get("from_date"), filters.get("to_date"), filters.get("boutique"), filters.get("associate"), filters.get("status"))
	if filters.get("detail"):
		columns = [
			{"label": _("Date"), "fieldname": "posting_date", "fieldtype": "Date", "width": 100},
			{"label": _("Invoice"), "fieldname": "sales_invoice", "fieldtype": "Link", "options": "Sales Invoice", "width": 170},
			{"label": _("Associate"), "fieldname": "associate_name", "fieldtype": "Data", "width": 150},
			{"label": _("Boutique"), "fieldname": "boutique", "fieldtype": "Link", "options": "Maison Boutique", "width": 100},
			{"label": _("Item"), "fieldname": "item_code", "fieldtype": "Link", "options": "Item", "width": 110},
			{"label": _("Rule"), "fieldname": "rule", "fieldtype": "Link", "options": "Maison Commission Rule", "width": 180},
			{"label": _("Base"), "fieldname": "base_amount", "fieldtype": "Currency", "width": 120},
			{"label": _("%"), "fieldname": "rate_percent", "fieldtype": "Percent", "width": 70},
			{"label": _("Commission"), "fieldname": "commission_amount", "fieldtype": "Currency", "width": 120},
			{"label": _("Reversal"), "fieldname": "is_reversal", "fieldtype": "Check", "width": 80},
			{"label": _("Status"), "fieldname": "status", "fieldtype": "Data", "width": 90},
		]
		return columns, data["entries"]
	columns = [
		{"label": _("Associate"), "fieldname": "associate", "fieldtype": "Link", "options": "Maison Associate", "width": 220},
		{"label": _("Name"), "fieldname": "associate_name", "fieldtype": "Data", "width": 160},
		{"label": _("Employee"), "fieldname": "employee", "fieldtype": "Link", "options": "Employee", "width": 120},
		{"label": _("Boutique"), "fieldname": "boutique", "fieldtype": "Link", "options": "Maison Boutique", "width": 100},
		{"label": _("Net sales (commissionable)"), "fieldname": "sales", "fieldtype": "Currency", "width": 180},
		{"label": _("Commission"), "fieldname": "commission", "fieldtype": "Currency", "width": 130},
		{"label": _("Entries"), "fieldname": "entries", "fieldtype": "Int", "width": 80},
		{"label": _("Reversals"), "fieldname": "reversals", "fieldtype": "Int", "width": 90},
	]
	return columns, data["associates"]
