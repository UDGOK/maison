"""/rewards — public CloudChaserz Rewards page (v0.6 Q): the client's exact program copy + sign-up form."""

from __future__ import annotations

import frappe

from maison_pos.api.rewards import program
from maison_pos.webshop import core
from maison_pos.www.shop._common import base_context

no_cache = 1
sitemap = 1


def get_context(context):
	data = program()
	base_context(context, nav="rewards", title=f"{data['program_name']} — {data['brand']['brand_name']}")
	context.program = data
	context.stores = core.boutiques() if frappe.db.exists("DocType", "AWANZ Store") else []
	context.csrf_token = frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
	return context
