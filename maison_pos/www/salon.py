"""Serve the Maison Salon (client-facing screen, v0.5 K) at ``/salon``.

Same Vite bundle as ``/pos`` (``public/pos/index.html``); the router switches to the Salon
child app when the page is opened under ``/salon``. Unlike ``/pos`` the page is **public**:
the Salon iPad is a guest and authenticates with the pairing code / session token only.
"""

from __future__ import annotations

import os

import frappe
from frappe import _

from maison_pos.www.pos import _built_index_path, _extract_assets

no_cache = 1


def get_context(context: dict) -> dict:
    context.no_cache = 1
    context.no_breadcrumbs = 1
    from maison_pos.brand import brand_name, get_brand  # v0.6 N

    context.brand = get_brand()
    context.brand_name = brand_name()
    context.title = f"{brand_name()} Salon"
    context.csrf_token = frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
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
