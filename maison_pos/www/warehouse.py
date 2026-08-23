"""Serve the Warehouse Admin desk (v0.6 P) at ``/warehouse`` — same Vite bundle as ``/pos``.

Login required; role gating (Maison Warehouse Admin / Head Office / System Manager) happens in
the app through ``maison_pos.api.shipping.me`` and on every endpoint server-side.
"""

from __future__ import annotations

import os

import frappe
from frappe import _

from maison_pos.www.pos import _built_index_path, _extract_assets

no_cache = 1


def _context(context: dict, title: str, redirect: str) -> dict:
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = f"/login?redirect-to={redirect}"
		raise frappe.Redirect
	context.no_cache = 1
	context.no_breadcrumbs = 1
	context.title = title
	context.csrf_token = frappe.sessions.get_csrf_token()
	context.site_user = frappe.session.user
	context.socketio_port = frappe.conf.get("socketio_port") or 9000
	context.dev_server = 1 if frappe.conf.get("developer_mode") and not frappe.conf.get("restart_supervisor_on_update") else 0
	index_path = _built_index_path()
	if not os.path.exists(index_path):
		context.built = False
		context.head_tags = ""
		context.body_tags = ""
		context.build_hint = _("PWA not built. Run `cd frontend && npm i && npm run build` then `bench build --app maison_pos`.")
		return context
	with open(index_path, encoding="utf-8") as f:
		head, body = _extract_assets(f.read())
	context.built = True
	context.head_tags = head
	context.body_tags = body
	return context


def get_context(context: dict) -> dict:
	return _context(context, "Warehouse", "/warehouse")
